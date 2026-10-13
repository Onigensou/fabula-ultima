/**
 * [ONI] Event System — Sound and screen actions
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-media.js
 *
 * What this does:
 * - Registers three event actions:
 *     Play Sound       a one-shot sound effect on every client
 *     Screen Effect    fade out / fade in / flash / shake / tint / clear
 *     Play Animation   an image or video, fullscreen or at a point on the map
 *
 * How it fits together:
 * - The row runs on the GM, which tells every client to play it
 *   (event-client.js) and times any "wait for completion" itself, so a
 *   hidden or slow client cannot hold the event up.
 * - Screen effects and fullscreen animations sit above the map and tokens
 *   and below dialogue bubbles and the interface, so a line can still be
 *   read over a black screen.
 * - A fade or tint stays until a later row lifts it or the event ends.
 * - Shake moves the canvas element, not the camera, so it cannot fight the
 *   follow camera.
 * - A hidden tab draws nothing: one-shots (flash, shake, animations) are
 *   dropped there, lasting states (fade, tint) are applied at once, so the
 *   screen is right when the player comes back.
 * - The GM is not shown screen effects or fullscreen animations (see
 *   event-client.js); the status chip says "screen faded" instead. Sounds
 *   and animations on the map play for the GM too: they block nothing.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsMedia]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsMedia?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_SOUND = "sound.play";
  const KIND_SCREEN = "screen.effect";
  const KIND_ANIMATION = "screen.animation";

  const STYLE_ID = "oni-event-screen-style";
  const SCREEN_LAYER_ID = "oni-event-screen-layer";
  const WORLD_LAYER_ID = "oni-event-world-layer";

  const SOUND_WAIT_CAP_MS = 15000;
  const ANIMATION_CAP_MS = 30000;
  const IMAGE_DEFAULT_MS = 2000;
  const METADATA_TIMEOUT_MS = 4000;
  const END_FADE_MS = 400;

  const flow = () => window.oni.EventSystem.Flow;

  function hiddenTab() {
    return globalThis.FUCompanion?.api?.vfxSuppressed?.() === true;
  }

  function clampNumber(raw, low, high, fallback) {
    return Math.min(high, Math.max(low, Logic.toNumber(raw, fallback)));
  }

  function isVideo(src) {
    return /\.(webm|mp4|m4v|ogv)(\?.*)?$/i.test(String(src || ""));
  }

  // ------------------------------------------------------------
  // Sound: fetch + decode, on Foundry's interface audio context
  // ------------------------------------------------------------
  // Not Foundry's own player: it loads through an <audio> element, which
  // refuses some of the WAV files in the asset library that decode fine
  // (measured: Sound/switch_mode.wav, "Failed to load audio element"). The
  // battle SFX play this way for the same reason (director-sfx.js).
  const audioBuffers = new Map();   // src -> Promise<AudioBuffer>
  let ownContext = null;

  function audioContext() {
    const shared = game.audio?.interface;
    if (shared && typeof shared.decodeAudioData === "function") return shared;
    ownContext ??= new (window.AudioContext || window.webkitAudioContext)();
    return ownContext;
  }

  function loadSound(src) {
    if (!audioBuffers.has(src)) {
      const loading = fetch(src)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((bytes) => audioContext().decodeAudioData(bytes));

      // A failed load is not remembered: the file may be fixed and tried again.
      loading.catch(() => audioBuffers.delete(src));
      audioBuffers.set(src, loading);
    }
    return audioBuffers.get(src);
  }

  // Each player's own Interface volume slider still applies.
  function interfaceVolume() {
    try {
      const v = Number(game.settings.get("core", "globalInterfaceVolume"));
      return Number.isFinite(v) ? v : 1;
    } catch (_) {
      return 1;
    }
  }

  async function playSound(src, volume = 0.6) {
    const ctx = audioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const buffer = await loadSound(src);
    const node = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = clampNumber(volume, 0, 1, 0.6) * interfaceVolume();
    node.buffer = buffer;
    node.connect(gain).connect(ctx.destination);
    node.onended = () => { try { node.disconnect(); gain.disconnect(); } catch (_) {} };
    node.start(0);
    return buffer.duration * 1000;
  }

  async function soundDurationMs(src) {
    try {
      return (await loadSound(src)).duration * 1000;
    } catch (_) {
      return 0;
    }
  }

  // How long a video runs, in ms; 0 when it cannot be told in time.
  function mediaDurationMs(src, tag) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ms) => {
        if (settled) return;
        settled = true;
        resolve(Number.isFinite(ms) && ms > 0 ? ms : 0);
      };

      try {
        const el = document.createElement(tag);
        el.preload = "metadata";
        el.addEventListener("loadedmetadata", () => finish(el.duration * 1000), { once: true });
        el.addEventListener("error", () => finish(0), { once: true });
        el.src = src;
      } catch (_) {
        finish(0);
      }

      setTimeout(() => finish(0), METADATA_TIMEOUT_MS);
    });
  }

  // ------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    // Above the canvas and the token HUD, below Foundry's interface, our
    // overhead buttons and the dialogue bubbles.
    style.textContent = `
      #${SCREEN_LAYER_ID}, #${WORLD_LAYER_ID} {
        position: fixed;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      #${WORLD_LAYER_ID} { z-index: 24; }
      #${SCREEN_LAYER_ID} { z-index: 25; }

      #${SCREEN_LAYER_ID} > .oni-event-screen-fill {
        position: absolute;
        inset: 0;
        opacity: 0;
      }

      #${SCREEN_LAYER_ID} > .oni-event-screen-media,
      #${WORLD_LAYER_ID} > .oni-event-world-media {
        position: absolute;
        border: 0;
        outline: 0;
        background: none;
        opacity: 0;
      }

      #${SCREEN_LAYER_ID} > .oni-event-screen-media {
        inset: 0;
        width: 100%;
        height: 100%;
      }

      #${WORLD_LAYER_ID} > .oni-event-world-media {
        left: 0;
        top: 0;
        transform-origin: 0 0;
      }
    `;
    document.head.appendChild(style);
  }

  function layer(id) {
    ensureStyle();
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
    return el;
  }

  // Opacity to a value over ms; then() once it is there. On a hidden tab, or
  // with no time given, it is simply set.
  function fadeTo(el, opacity, ms, then = null) {
    if (!el) return;
    const from = Number(getComputedStyle(el).opacity) || 0;
    el.style.opacity = String(opacity);

    if (ms <= 0 || hiddenTab()) {
      then?.();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      then?.();
    };

    try {
      const anim = el.animate([{ opacity: from }, { opacity }], { duration: ms, easing: "ease-in-out" });
      anim.finished.then(finish, finish);
    } catch (_) { /* the style above already holds the end state */ }

    // An animation on a tab that gets hidden midway never reports back.
    setTimeout(finish, ms + 300);
  }

  // ------------------------------------------------------------
  // Play Sound
  // ------------------------------------------------------------
  Client.register(KIND_SOUND, (data) => {
    const src = String(data.src || "").trim();
    if (!src) return;

    playSound(src, data.volume).catch((e) => {
      console.warn(INSTALL_TAG, `Play Sound could not play "${src}".`, e);
    });
  });

  EventRegistry.register({
    type: "playSound",
    label: "Play Sound",
    category: "Audio",
    defaultData: { type: "playSound", src: "", volume: 0.6, wait: false },
    summary: (row) => String(row?.src ?? "").split("/").pop(),
    execute: async (row, context) => {
      const src = String(row?.src || "").trim();
      if (!src) return { ok: false, reason: "noSoundFile" };

      Client.run(context?.tileId, KIND_SOUND, { src, volume: clampNumber(row?.volume, 0, 1, 0.6) });

      if (row?.wait === true) {
        const ms = Math.min(SOUND_WAIT_CAP_MS, await soundDurationMs(src));
        if (ms > 0) await flow()?.wait?.(context?.tileId, ms);
      }

      return { ok: true, type: "playSound" };
    },
    buildFields: (row, kit) => kit.fields(
      kit.field("Sound file", kit.fileInput("oni-event-row-sound-src", row.src, "audio", "Path or URL of a sound")),
      kit.field(
        "Volume",
        kit.numberInput("oni-event-row-sound-volume", clampNumber(row.volume, 0, 1, 0.6), { min: 0, max: 1, step: 0.05 }),
        "0 to 1. Each player's own Interface volume slider still applies."
      ),
      kit.waitField(row, false, "On: the next event waits until the sound has finished (15 s at most). Off: it starts straight away.")
    ),
    collectFields: (rowEl, kit) => ({
      src: kit.readText(rowEl, ".oni-event-row-sound-src", "").trim(),
      volume: clampNumber(kit.readNumber(rowEl, ".oni-event-row-sound-volume", 0.6), 0, 1, 0.6),
      wait: kit.readWait(rowEl, false)
    })
  });

  // ------------------------------------------------------------
  // Screen Effect
  // ------------------------------------------------------------
  const EFFECTS = [
    ["fadeOut", "Fade out"],
    ["fadeIn", "Fade in"],
    ["flash", "Flash"],
    ["shake", "Shake"],
    ["dim", "Dim"],
    ["tint", "Tint"],
    ["clear", "Clear fade, dim and tint"]
  ];

  const EFFECT_DEFAULT_COLOR = { fadeOut: "#000000", flash: "#ffffff", tint: "#000000" };
  const TINT_DEFAULT_STRENGTH = 0.35;
  // Dim is Tint in black: one way of darkening the screen, under two names,
  // so that "dim the screen behind the text" can be found in the list.
  const DIM_COLOR = "#000000";
  const DIM_DEFAULT_STRENGTH = 0.5;
  const SHAKE_DEFAULT_STRENGTH = 8;

  // The lasting fills on this client: { fade, tint } elements, or null.
  const fills = { fade: null, tint: null };

  function fillElement(key, color) {
    if (!fills[key]) {
      fills[key] = document.createElement("div");
      fills[key].className = "oni-event-screen-fill";
      // The fade covers the tint, as a curtain over a colour grade.
      if (key === "tint") layer(SCREEN_LAYER_ID).prepend(fills[key]);
      else layer(SCREEN_LAYER_ID).appendChild(fills[key]);
    }
    if (color) fills[key].style.background = color;
    return fills[key];
  }

  function dropFill(key, ms) {
    const el = fills[key];
    if (!el) return;
    fills[key] = null;
    fadeTo(el, 0, ms, () => el.remove());
  }

  function flash(color, ms) {
    if (hiddenTab()) return;
    const el = document.createElement("div");
    el.className = "oni-event-screen-fill";
    el.style.background = color;
    layer(SCREEN_LAYER_ID).appendChild(el);

    // Up fast, down over the rest.
    const upMs = Math.min(120, ms * 0.25);
    fadeTo(el, 1, upMs, () => fadeTo(el, 0, Math.max(0, ms - upMs), () => el.remove()));
  }

  function shake(strengthPx, ms) {
    if (hiddenTab()) return;
    const board = document.getElementById("board");
    if (!board?.animate) return;

    const steps = Math.max(6, Math.round(ms / 45));
    const frames = [{ transform: "translate(0px, 0px)" }];
    for (let i = 1; i < steps; i += 1) {
      const fall = 1 - (i / steps);
      const x = (Math.random() * 2 - 1) * strengthPx * fall;
      const y = (Math.random() * 2 - 1) * strengthPx * fall;
      frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` });
    }
    frames.push({ transform: "translate(0px, 0px)" });

    try { board.animate(frames, { duration: ms, easing: "linear" }); } catch (_) {}
  }

  function clearScreen(ms) {
    dropFill("fade", ms);
    dropFill("tint", ms);
  }

  Client.register(KIND_SCREEN, (data, info) => {
    const effect = String(data.effect || "");
    const ms = Math.max(0, Logic.toNumber(data.durationMs, 800));
    const color = String(data.color || EFFECT_DEFAULT_COLOR[effect] || "#000000");

    // What the GM status chip says in place of the effect.
    if (effect === "fadeOut") Client.setMarker(info.sourceId, "fade", "screen faded");
    if (effect === "tint") Client.setMarker(info.sourceId, "tint", "screen tinted");
    if (effect === "dim") Client.setMarker(info.sourceId, "tint", "screen dimmed");
    if (effect === "fadeIn" || effect === "clear") Client.setMarker(info.sourceId, "fade", null);
    if (effect === "clear") Client.setMarker(info.sourceId, "tint", null);

    if (!info.presents) return;

    switch (effect) {
      case "fadeOut":
        fadeTo(fillElement("fade", color), 1, ms);
        break;
      case "fadeIn":
        dropFill("fade", ms);
        break;
      case "tint":
        fadeTo(fillElement("tint", color), clampNumber(data.strength, 0, 1, TINT_DEFAULT_STRENGTH), ms);
        break;
      case "dim":
        fadeTo(fillElement("tint", DIM_COLOR), clampNumber(data.strength, 0, 1, DIM_DEFAULT_STRENGTH), ms);
        break;
      case "clear":
        clearScreen(ms);
        break;
      case "flash":
        flash(color, ms);
        break;
      case "shake":
        shake(clampNumber(data.strength, 1, 60, SHAKE_DEFAULT_STRENGTH), ms);
        break;
      default:
        return;
    }

    if (effect === "fadeOut" || effect === "tint" || effect === "dim") {
      Client.addCleanup(info.sourceId, "screen", ({ sceneGone } = {}) => clearScreen(sceneGone ? 0 : END_FADE_MS));
    }
  });

  EventRegistry.register({
    type: "screenEffect",
    label: "Screen Effect",
    category: "Screen",
    defaultData: { type: "screenEffect", effect: "fadeOut", color: "#000000", strength: 0, seconds: 0.8, wait: true },
    summary: (row) => (EFFECTS.find(([value]) => value === row?.effect)?.[1] ?? ""),
    execute: async (row, context) => {
      const effect = EFFECTS.some(([value]) => value === row?.effect) ? row.effect : "fadeOut";
      const durationMs = clampNumber(row?.seconds, 0, 20, 0.8) * 1000;

      Client.run(context?.tileId, KIND_SCREEN, {
        effect,
        color: String(row?.color || ""),
        strength: Logic.toNumber(row?.strength, 0) > 0 ? Logic.toNumber(row.strength, 0) : undefined,
        durationMs
      });

      if (row?.wait !== false) await flow()?.wait?.(context?.tileId, durationMs);
      return { ok: true, type: "screenEffect", effect };
    },
    buildFields: (row, kit) => {
      const effect = EFFECTS.some(([value]) => value === row.effect) ? row.effect : "fadeOut";

      const body = kit.fields(
        kit.field(
          "Effect",
          `<select class="oni-event-row-fx-effect">${kit.options(EFFECTS, effect)}</select>`,
          `A fade, dim or tint stays until a later row lifts it, or the event ends. The GM is not shown screen effects.`
        ),
        `<div class="oni-event-row-fx-color-wrap">${kit.field(
          "Colour",
          `<input type="color" class="oni-event-row-fx-color" value="${kit.escapeHTML(row.color || EFFECT_DEFAULT_COLOR[effect] || "#000000")}" />`
        )}</div>`,
        `<div class="oni-event-row-fx-strength-wrap">${kit.field(
          "Strength",
          kit.numberInput("oni-event-row-fx-strength", Logic.toNumber(row.strength, 0) > 0 ? row.strength : "", { min: 0, step: 0.05, placeholder: "default" }),
          `Dim and Tint: how strong, 0 to 1 (default ${DIM_DEFAULT_STRENGTH} and ${TINT_DEFAULT_STRENGTH}). Shake: how far, in pixels (default ${SHAKE_DEFAULT_STRENGTH}).`
        )}</div>`,
        kit.field(
          "Duration (s)",
          kit.numberInput("oni-event-row-fx-seconds", clampNumber(row.seconds, 0, 20, 0.8), { min: 0, max: 20, step: 0.1 })
        ),
        kit.waitField(row, true)
      );

      const effectEl = body.querySelector(".oni-event-row-fx-effect");
      const colorEl = body.querySelector(".oni-event-row-fx-color");
      const sync = () => {
        const value = effectEl.value;
        body.querySelector(".oni-event-row-fx-color-wrap").hidden = !(value in EFFECT_DEFAULT_COLOR);
        body.querySelector(".oni-event-row-fx-strength-wrap").hidden = !(value === "tint" || value === "dim" || value === "shake");
      };
      effectEl.addEventListener("change", () => {
        // A flash starts white and a fade black; either can be recoloured after.
        if (effectEl.value in EFFECT_DEFAULT_COLOR) colorEl.value = EFFECT_DEFAULT_COLOR[effectEl.value];
        sync();
      });
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      effect: kit.readText(rowEl, ".oni-event-row-fx-effect", "fadeOut"),
      color: kit.readText(rowEl, ".oni-event-row-fx-color", "#000000"),
      strength: Math.max(0, kit.readNumber(rowEl, ".oni-event-row-fx-strength", 0)),
      seconds: clampNumber(kit.readNumber(rowEl, ".oni-event-row-fx-seconds", 0.8), 0, 20, 0.8),
      wait: kit.readWait(rowEl, true)
    })
  });

  // ------------------------------------------------------------
  // Play Animation
  // ------------------------------------------------------------
  const PLACES = [
    ["screen", "Fullscreen"],
    ["source", "On this event's tile / token"],
    ["token", "On a named token"],
    ["party", "On the party"]
  ];

  // Animations playing on this client: sourceId -> Set of stop functions.
  const playing = new Map();

  function trackAnimation(sourceId, stop) {
    if (!playing.has(sourceId)) playing.set(sourceId, new Set());
    playing.get(sourceId).add(stop);
    Client.addCleanup(sourceId, "animations", ({ sceneGone } = {}) => {
      for (const fn of [...(playing.get(sourceId) ?? [])]) fn(sceneGone ? 0 : 200);
      playing.delete(sourceId);
    });
  }

  function makeMedia(src, className) {
    const el = document.createElement(isVideo(src) ? "video" : "img");
    el.className = className;
    if (el.tagName === "VIDEO") {
      el.muted = true;
      el.autoplay = true;
      el.playsInline = true;
    }
    el.src = src;
    return el;
  }

  function worldToScreen(x, y) {
    const wt = canvas?.app?.stage?.worldTransform;
    if (!wt) return { x, y, scale: 1 };
    return { x: (x * wt.a) + wt.tx, y: (y * wt.d) + wt.ty, scale: wt.a };
  }

  function anchorFor(data, sourceId) {
    if (data.where === "token") {
      const wanted = String(data.name ?? "").trim().toLowerCase();
      const token = (canvas.tokens?.placeables ?? []).find(t =>
        String(t.name ?? "").trim().toLowerCase() === wanted
        || String(t.actor?.name ?? "").trim().toLowerCase() === wanted);
      return token ? () => token.center : null;
    }

    const tokenId = data.where === "party" ? data.partyTokenId : sourceId;
    const token = canvas.tokens?.get(tokenId);
    // token.center follows the drawn token while it walks.
    if (token) return () => token.center;

    const tile = canvas.scene?.tiles?.get(sourceId);
    if (data.where === "source" && tile) {
      const point = { x: tile.x + (tile.width / 2), y: tile.y + (tile.height / 2) };
      return () => point;
    }

    return null;
  }

  Client.register(KIND_ANIMATION, (data, info) => {
    const src = String(data.src || "").trim();
    if (!src || !canvas?.ready) return;
    if (hiddenTab()) return;

    const fullscreen = data.where === "screen";
    if (fullscreen && !info.presents) return;

    const opacity = clampNumber(data.opacity, 0, 1, 1);
    const scale = clampNumber(data.scalePct, 1, 1000, 100) / 100;
    const el = makeMedia(src, fullscreen ? "oni-event-screen-media" : "oni-event-world-media");

    let ticker = null;
    let stopped = false;
    let endTimer = null;

    const stop = (fadeMs = 200) => {
      if (stopped) return;
      stopped = true;
      if (endTimer) clearTimeout(endTimer);
      if (ticker) { try { canvas.app.ticker.remove(ticker); } catch (_) {} }
      playing.get(info.sourceId)?.delete(stop);
      fadeTo(el, 0, fadeMs, () => el.remove());
    };

    if (fullscreen) {
      el.style.objectFit = data.fit === "cover" ? "cover" : "contain";
      layer(SCREEN_LAYER_ID).appendChild(el);
    } else {
      const anchor = anchorFor(data, info.sourceId);
      if (!anchor) {
        console.warn(INSTALL_TAG, "Play Animation: nothing to play it on, on this scene.", data);
        return;
      }

      layer(WORLD_LAYER_ID).appendChild(el);

      // Rides the map like a token effect: placed again every frame.
      ticker = () => {
        if (!canvas?.ready) return;
        const point = anchor();
        const at = worldToScreen(point.x, point.y);
        const w = (el.videoWidth || el.naturalWidth || 0) * scale * at.scale;
        const h = (el.videoHeight || el.naturalHeight || 0) * scale * at.scale;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.transform = `translate(${at.x - (w / 2)}px, ${at.y - (h / 2)}px)`;
      };
      canvas.app.ticker.add(ticker);
    }

    trackAnimation(info.sourceId, stop);
    fadeTo(el, opacity, 200);

    const fixedMs = Math.max(0, Logic.toNumber(data.durationMs, 0));
    if (el.tagName === "VIDEO" && fixedMs <= 0) {
      el.addEventListener("ended", () => stop(200), { once: true });
      el.addEventListener("error", () => stop(0), { once: true });
      endTimer = setTimeout(() => stop(200), ANIMATION_CAP_MS);
    } else {
      endTimer = setTimeout(() => stop(200), Math.min(ANIMATION_CAP_MS, fixedMs || IMAGE_DEFAULT_MS));
    }
  });

  EventRegistry.register({
    type: "playAnimation",
    label: "Play Animation",
    category: "Screen",
    defaultData: {
      type: "playAnimation",
      src: "",
      where: "screen",
      name: "",
      fit: "contain",
      scalePct: 100,
      opacity: 1,
      seconds: 0,
      wait: true
    },
    summary: (row) => String(row?.src ?? "").split("/").pop(),
    execute: async (row, context) => {
      const src = String(row?.src || "").trim();
      if (!src) return { ok: false, reason: "noAnimationFile" };

      const durationMs = clampNumber(row?.seconds, 0, ANIMATION_CAP_MS / 1000, 0) * 1000;

      Client.run(context?.tileId, KIND_ANIMATION, {
        src,
        where: PLACES.some(([value]) => value === row?.where) ? row.where : "screen",
        name: String(row?.name ?? ""),
        partyTokenId: context?.tokenId ?? null,
        fit: row?.fit === "cover" ? "cover" : "contain",
        scalePct: clampNumber(row?.scalePct, 1, 1000, 100),
        opacity: clampNumber(row?.opacity, 0, 1, 1),
        durationMs
      });

      if (row?.wait !== false) {
        let ms = durationMs;
        if (ms <= 0) ms = isVideo(src) ? await mediaDurationMs(src, "video") : IMAGE_DEFAULT_MS;
        if (ms > 0) await flow()?.wait?.(context?.tileId, Math.min(ANIMATION_CAP_MS, ms));
      }

      return { ok: true, type: "playAnimation" };
    },
    buildFields: (row, kit) => {
      const where = PLACES.some(([value]) => value === row.where) ? row.where : "screen";

      const body = kit.fields(
        kit.field("Image / video", kit.fileInput("oni-event-row-anim-src", row.src, "imagevideo", "Path or URL (webm, png, gif...)")),
        kit.field(
          "Where",
          `<select class="oni-event-row-anim-where">${kit.options(PLACES, where)}</select>`,
          "Fullscreen is not shown to the GM. On the map it plays for everyone."
        ),
        `<div class="oni-event-row-anim-name-wrap">${kit.field(
          "Token name",
          `<input type="text" class="oni-event-row-anim-name" value="${kit.escapeHTML(row.name ?? "")}" placeholder="Name of a token on this scene" />`
        )}</div>`,
        `<div class="oni-event-row-anim-fit-wrap">${kit.field(
          "Fit",
          `<select class="oni-event-row-anim-fit">${kit.options([["contain", "Whole picture"], ["cover", "Fill the screen"]], row.fit === "cover" ? "cover" : "contain")}</select>`
        )}</div>`,
        `<div class="oni-event-row-anim-scale-wrap">${kit.field(
          "Size (%)",
          kit.numberInput("oni-event-row-anim-scale", clampNumber(row.scalePct, 1, 1000, 100), { min: 1, max: 1000, step: 5 }),
          "100 = the file's own size on the map."
        )}</div>`,
        kit.field(
          "Opacity",
          kit.numberInput("oni-event-row-anim-opacity", clampNumber(row.opacity, 0, 1, 1), { min: 0, max: 1, step: 0.05 })
        ),
        kit.field(
          "Duration (s)",
          kit.numberInput("oni-event-row-anim-seconds", Logic.toNumber(row.seconds, 0) > 0 ? row.seconds : "", { min: 0, max: ANIMATION_CAP_MS / 1000, step: 0.1, placeholder: "auto" }),
          `Empty: a video plays to its end, a still image shows for ${IMAGE_DEFAULT_MS / 1000} s.`
        ),
        kit.waitField(row, true)
      );

      const whereEl = body.querySelector(".oni-event-row-anim-where");
      const sync = () => {
        const fullscreen = whereEl.value === "screen";
        body.querySelector(".oni-event-row-anim-name-wrap").hidden = whereEl.value !== "token";
        body.querySelector(".oni-event-row-anim-fit-wrap").hidden = !fullscreen;
        body.querySelector(".oni-event-row-anim-scale-wrap").hidden = fullscreen;
      };
      whereEl.addEventListener("change", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      src: kit.readText(rowEl, ".oni-event-row-anim-src", "").trim(),
      where: kit.readText(rowEl, ".oni-event-row-anim-where", "screen"),
      name: kit.readText(rowEl, ".oni-event-row-anim-name", "").trim(),
      fit: kit.readText(rowEl, ".oni-event-row-anim-fit", "contain"),
      scalePct: clampNumber(kit.readNumber(rowEl, ".oni-event-row-anim-scale", 100), 1, 1000, 100),
      opacity: clampNumber(kit.readNumber(rowEl, ".oni-event-row-anim-opacity", 1), 0, 1, 1),
      seconds: Math.max(0, kit.readNumber(rowEl, ".oni-event-row-anim-seconds", 0)),
      wait: kit.readWait(rowEl, true)
    })
  });

  window.oni.EventSystem.RowsMedia = {
    installed: true,
    // Also used by the config window's preview button.
    playSound
  };

  console.debug(INSTALL_TAG, "Installed.");
})();
