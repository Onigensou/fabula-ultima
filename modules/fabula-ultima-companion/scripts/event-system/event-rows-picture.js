/**
 * [ONI] Event System — Picture actions (story CG stills)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-picture.js
 *
 * What this does:
 * - Registers RPG Maker style picture actions, for story stills such as a
 *   full-screen flashback illustration that dialogue plays over:
 *     Show Picture    an image (or looping webm) into a numbered slot, 1-20;
 *                     a higher slot draws on top. Showing into a slot that
 *                     holds a picture dissolves the new one over the old.
 *     Move Picture    position, size, opacity, rotation over time, eased
 *     Tint Picture    a colour grade (Faded memory, grey, night, dark,
 *                     custom), dark edges and film grain
 *     Erase Picture   one slot or all of them, with a fade
 *
 * How it fits together:
 * - The row runs on the GM, which keeps the picture state of each scene
 *   (the authority) and tells every client on the scene to draw it
 *   (event-client.js). Waits are timed on the GM, like Screen Effect.
 * - Pictures sit above the map and tokens and BELOW the Screen Effect fade,
 *   flash and tint, the letterbox bars, Floating Text, dialogue and the
 *   interface: a fade to black covers a picture, a line of text reads over it.
 * - Unlike screen effects, the GM sees pictures too.
 * - Pictures end with the event that showed them (a short fade), unless
 *   that Show Picture row has "keep after the event" on. A kept picture
 *   stays on its scene until an Erase Picture row (any event) takes it off.
 * - A client that reloads, joins late or comes back to the scene asks the
 *   GMs for the scene's pictures and draws them at their end state.
 * - A hidden tab jumps straight to the end state of every change.
 * - Screen Effect "shake" moves #board; the pictures follow that shake.
 *
 * Exposes API to:
 *   window.oni.EventSystem.PictureLogic   plain helpers (also for tests)
 *   window.oni.EventSystem.Pictures       { anyShown(), state() }
 *   Hooks.callAll("oniEventPicturesChanged", state) on every change here
 *
 * Requires:
 * - event-constants.js, event-logic.js, event-eventRegistry.js,
 *   event-client.js, event-flow.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsPicture]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Pictures?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  // ------------------------------------------------------------
  // Plain helpers (no game needed)
  // ------------------------------------------------------------
  const SLOT_MIN = 1;
  const SLOT_MAX = 20;
  const MAX_SECONDS = 60;

  const FITS = [
    ["cover", "Fill the screen"],
    ["contain", "Whole picture"],
    ["native", "Own size"]
  ];
  const FIT_SHORT = { cover: "fill", contain: "whole", native: "own size" };

  const BLENDS = [
    ["normal", "Normal"],
    ["add", "Add (screen)"],
    ["multiply", "Multiply"]
  ];
  const BLEND_CSS = { normal: "normal", add: "screen", multiply: "multiply" };

  const EASINGS = [
    ["linear", "Linear"],
    ["easeIn", "Ease in"],
    ["easeOut", "Ease out"],
    ["easeInOut", "Ease in-out"]
  ];
  const EASING_CSS = { linear: "linear", easeIn: "ease-in", easeOut: "ease-out", easeInOut: "ease-in-out" };

  const TINTS = [
    ["normal", "Normal"],
    ["memory", "Faded memory"],
    ["gray", "Grey"],
    ["night", "Night"],
    ["dark", "Dark"],
    ["custom", "Custom"]
  ];
  // Every preset is the same list of filters, so one grade glides into another.
  const TINT_VALUES = {
    normal: { sepia: 0, grayscale: 0, brightness: 1, saturate: 1, hue: 0 },
    memory: { sepia: 0.45, grayscale: 0.15, brightness: 0.92, saturate: 1, hue: 0 },
    gray: { sepia: 0, grayscale: 0.85, brightness: 0.9, saturate: 1, hue: 0 },
    night: { sepia: 0.35, grayscale: 0, brightness: 0.6, saturate: 1.2, hue: 185 },
    dark: { sepia: 0, grayscale: 0, brightness: 0.35, saturate: 1, hue: 0 }
  };
  const CUSTOM_RANGE = { sepia: [0, 1, 0], grayscale: [0, 1, 0], brightness: [0, 3, 1], saturate: [0, 3, 1] };

  const MEDIA_RE = /\.(png|jpe?g|webp|gif|avif|apng|svg|bmp|webm|mp4|m4v)$/i;
  const VIDEO_RE = /\.(webm|mp4|m4v)$/i;

  const pick = (pairs, value, fallback) => (pairs.some(([key]) => key === value) ? value : fallback);

  function toNum(raw, fallback) {
    if (raw === null || raw === undefined || typeof raw === "boolean") return fallback;
    if (typeof raw === "string" && raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(raw, low, high, fallback) {
    return Math.min(high, Math.max(low, toNum(raw, fallback)));
  }

  // Blank stays blank (null): "keep what it is".
  function clampOrKeep(raw, low, high) {
    const n = toNum(raw, null);
    return n === null ? null : Math.min(high, Math.max(low, n));
  }

  // 1-20, or "all" where allowed; anything else is null.
  function normSlot(raw, allowAll = false) {
    if (allowAll && String(raw ?? "").trim().toLowerCase() === "all") return "all";
    const n = toNum(raw, null);
    if (n === null) return null;
    const slot = Math.round(n);
    return slot >= SLOT_MIN && slot <= SLOT_MAX ? slot : null;
  }

  function pathOf(src) {
    return String(src ?? "").trim().split(/[?#]/)[0];
  }

  // A usable picture path, or "" (empty, or not an image / video file).
  function normSrc(raw) {
    const src = String(raw ?? "").trim();
    return src && MEDIA_RE.test(pathOf(src)) ? src : "";
  }

  const isVideoSrc = (src) => VIDEO_RE.test(pathOf(src));

  function fileName(src) {
    const name = pathOf(src).split("/").pop() || "";
    try { return decodeURIComponent(name); } catch (_) { return name; }
  }

  function normTint(raw) {
    const preset = pick(TINTS, raw?.tint ?? raw?.preset, "normal");
    const out = { preset };
    for (const [key, [low, high, fallback]] of Object.entries(CUSTOM_RANGE)) out[key] = clamp(raw?.[key], low, high, fallback);
    return out;
  }

  function tintValues(tint) {
    const t = tint && typeof tint === "object" ? tint : { preset: String(tint ?? "normal") };
    if (t.preset === "custom") {
      const c = normTint({ ...t, tint: "custom" });
      return { sepia: c.sepia, grayscale: c.grayscale, brightness: c.brightness, saturate: c.saturate, hue: 0 };
    }
    return TINT_VALUES[t.preset] ?? TINT_VALUES.normal;
  }

  const fmt = (n) => String(Math.round(n * 1000) / 1000);

  // The CSS filter of a grade. Normal is "none" (no filter pass at all).
  function tintFilter(tint) {
    const v = tintValues(tint);
    const n = TINT_VALUES.normal;
    if (v.sepia === n.sepia && v.grayscale === n.grayscale && v.brightness === n.brightness && v.saturate === n.saturate && v.hue === n.hue) return "none";
    return `sepia(${fmt(v.sepia)}) grayscale(${fmt(v.grayscale)}) brightness(${fmt(v.brightness)}) saturate(${fmt(v.saturate)}) hue-rotate(${fmt(v.hue)}deg)`;
  }

  function tintLabel(tint) {
    const preset = (tint && typeof tint === "object") ? tint.preset : tint;
    if (!preset || preset === "normal") return "";
    if (preset === "custom") return "Custom tint";
    return TINTS.find(([key]) => key === preset)?.[1] ?? "";
  }

  const easingCss = (name) => EASING_CSS[name] ?? "ease-in-out";
  const blendCss = (name) => BLEND_CSS[name] ?? "normal";

  function normShow(row) {
    return {
      slot: normSlot(row?.slot) ?? 1,
      src: normSrc(row?.src),
      fit: pick(FITS, row?.fit, "cover"),
      x: clamp(row?.x, -100, 200, 50),
      y: clamp(row?.y, -100, 200, 50),
      scale: clamp(row?.scale, 1, 1000, 100),
      opacity: clamp(row?.opacity, 0, 100, 100),
      rotation: clamp(row?.rotation, -3600, 3600, 0),
      blend: pick(BLENDS, row?.blend, "normal"),
      fadeSeconds: clamp(row?.fadeSeconds, 0, MAX_SECONDS, 0),
      tint: normTint(row),
      vignette: row?.vignette === true,
      grain: row?.grain === true,
      keep: row?.keep === true,
      wait: row?.wait !== false
    };
  }

  function normMove(row) {
    return {
      slot: normSlot(row?.slot) ?? 1,
      x: clampOrKeep(row?.x, -100, 200),
      y: clampOrKeep(row?.y, -100, 200),
      scale: clampOrKeep(row?.scale, 1, 1000),
      opacity: clampOrKeep(row?.opacity, 0, 100),
      rotation: clampOrKeep(row?.rotation, -3600, 3600),
      seconds: clamp(row?.seconds, 0, MAX_SECONDS, 1),
      easing: pick(EASINGS, row?.easing, "easeInOut"),
      wait: row?.wait === true
    };
  }

  function normTintRow(row) {
    return {
      slot: normSlot(row?.slot, true) ?? 1,
      tint: normTint(row),
      vignette: row?.vignette === true,
      grain: row?.grain === true,
      seconds: clamp(row?.seconds, 0, MAX_SECONDS, 1),
      wait: row?.wait === true
    };
  }

  function normErase(row) {
    return {
      slot: normSlot(row?.slot, true) ?? 1,
      fadeSeconds: clamp(row?.fadeSeconds, 0, MAX_SECONDS, 0),
      wait: row?.wait !== false
    };
  }

  const MOVE_KEYS = ["x", "y", "scale", "opacity", "rotation"];

  // ---- the picture state: { pictures: { [slot]: picture } } ----------------
  // A picture: { slot, src, video, fit, x, y, scale, opacity, rotation, blend,
  //   tint, vignette, grain, owner, keep, rev }. rev: when it last changed
  //   (on the GM that changed it), so merging two answers keeps the newer.
  function pictureFrom(show, owner, rev = 0) {
    return {
      slot: show.slot,
      src: show.src,
      video: isVideoSrc(show.src),
      fit: show.fit,
      x: show.x,
      y: show.y,
      scale: show.scale,
      opacity: show.opacity,
      rotation: show.rotation,
      blend: show.blend,
      tint: { ...show.tint },
      vignette: !!show.vignette,
      grain: !!show.grain,
      owner: String(owner ?? ""),
      keep: !!show.keep,
      rev: toNum(rev, 0)
    };
  }

  // A picture from outside (a sync answer): checked like a row, or null.
  function cleanPicture(raw) {
    const show = normShow({ ...raw, ...(raw?.tint && typeof raw.tint === "object" ? raw.tint : {}), tint: raw?.tint?.preset ?? raw?.tint });
    if (!show.src || normSlot(raw?.slot) === null) return null;
    return pictureFrom(show, raw?.owner, raw?.rev);
  }

  function slotsOf(pictures, slot) {
    if (slot === "all") return Object.keys(pictures).map(Number).sort((a, b) => a - b);
    const n = normSlot(slot);
    return n !== null && pictures[n] ? [n] : [];
  }

  function reduce(state, action) {
    const pictures = { ...(state?.pictures ?? {}) };
    const rev = toNum(action?.rev, 0);

    switch (action?.type) {
      case "show": {
        const p = cleanPicture({ ...action.picture, owner: action.owner ?? action.picture?.owner, rev: rev || action.picture?.rev });
        if (p) pictures[p.slot] = p;
        break;
      }
      case "move": {
        for (const slot of slotsOf(pictures, action.slot)) {
          const next = { ...pictures[slot], rev: rev || pictures[slot].rev };
          for (const key of MOVE_KEYS) if (action[key] !== null && action[key] !== undefined) next[key] = action[key];
          pictures[slot] = next;
        }
        break;
      }
      case "tint": {
        for (const slot of slotsOf(pictures, action.slot)) {
          pictures[slot] = {
            ...pictures[slot],
            tint: normTint({ ...(action.tint ?? {}), tint: action.tint?.preset }),
            vignette: !!action.vignette,
            grain: !!action.grain,
            rev: rev || pictures[slot].rev
          };
        }
        break;
      }
      case "erase":
        for (const slot of slotsOf(pictures, action.slot)) delete pictures[slot];
        break;
      case "endEvent": {
        const owner = String(action.owner ?? "");
        for (const slot of Object.keys(pictures)) {
          if (pictures[slot].owner === owner && !pictures[slot].keep) delete pictures[slot];
        }
        break;
      }
      case "clear":
        return { pictures: {} };
      case "sync": {
        // Merged slot by slot: two GMs may each hold some of a scene's pictures.
        for (const raw of Object.values(action.pictures ?? {})) {
          const p = cleanPicture(raw);
          if (!p) continue;
          if (!pictures[p.slot] || p.rev > pictures[p.slot].rev) pictures[p.slot] = p;
        }
        break;
      }
      default:
        break;
    }

    return { pictures };
  }

  function visibleCount(state) {
    return Object.values(state?.pictures ?? {}).filter(p => p.opacity > 0).length;
  }

  // ---- summaries -----------------------------------------------------------
  const slotText = (slot) => (slot === "all" ? "all" : `#${slot}`);
  const secondsText = (s) => `${fmt(s)} s`;

  function summaryShow(row) {
    const s = normShow(row);
    const parts = [`#${s.slot} ${fileName(row?.src) || "(no picture)"}`, FIT_SHORT[s.fit]];
    const tint = tintLabel(s.tint);
    if (tint) parts.push(tint);
    if (s.vignette) parts.push("dark edges");
    if (s.grain) parts.push("grain");
    if (s.fadeSeconds > 0) parts.push(`fade ${secondsText(s.fadeSeconds)}`);
    if (s.keep) parts.push("kept");
    return parts.join(" · ");
  }

  function summaryMove(row) {
    const s = normMove(row);
    const label = { x: "x", y: "y", scale: "size", opacity: "opacity", rotation: "turn" };
    const unit = { x: "%", y: "%", scale: "%", opacity: "%", rotation: "°" };
    const changes = MOVE_KEYS.filter(k => s[k] !== null).map(k => `${label[k]} ${fmt(s[k])}${unit[k]}`);
    const ease = EASINGS.find(([key]) => key === s.easing)?.[1]?.toLowerCase() ?? "";
    return [`#${s.slot}`, changes.length ? changes.join(", ") : "nothing to change", `${secondsText(s.seconds)} ${ease}`].join(" · ");
  }

  function summaryTint(row) {
    const s = normTintRow(row);
    const parts = [slotText(s.slot), tintLabel(s.tint) || "Normal"];
    if (s.vignette) parts.push("dark edges");
    if (s.grain) parts.push("grain");
    if (s.seconds > 0) parts.push(secondsText(s.seconds));
    return parts.join(" · ");
  }

  function summaryErase(row) {
    const s = normErase(row);
    const parts = [s.slot === "all" ? "all pictures" : `#${s.slot}`];
    if (s.fadeSeconds > 0) parts.push(`fade ${secondsText(s.fadeSeconds)}`);
    return parts.join(" · ");
  }

  const PictureLogic = {
    SLOT_MIN, SLOT_MAX, FITS, BLENDS, EASINGS, TINTS, TINT_VALUES,
    toNum, clamp, clampOrKeep, normSlot, normSrc, isVideoSrc, fileName,
    normTint, tintValues, tintFilter, tintLabel, easingCss, blendCss,
    normShow, normMove, normTintRow, normErase,
    pictureFrom, cleanPicture, reduce, visibleCount,
    summaryShow, summaryMove, summaryTint, summaryErase
  };
  window.oni.EventSystem.PictureLogic = PictureLogic;

  // ------------------------------------------------------------
  // In the game
  // ------------------------------------------------------------
  const C = window.oni.EventSystem.Constants;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing EventRegistry or Client. Check load order.");
    return;
  }

  const MODULE_ID = C?.MODULE_ID || "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_SYNC_REQ = "ONI_EVENT_PICTURE_SYNC_REQ_V1";
  const MSG_SYNC = "ONI_EVENT_PICTURE_SYNC_V1";
  const KIND_PICTURE = "screen.picture";

  const STYLE_ID = "oni-event-picture-style";
  const LAYER_ID = "oni-event-picture-layer";
  // event-rows-media.js: the fade / flash / tint layer, z-index 25.
  const SCREEN_LAYER_ID = "oni-event-screen-layer";

  const END_FADE_MS = 400;
  const PROBE_TIMEOUT_MS = 2500;
  const GRAIN_TILE = 128;

  const flow = () => window.oni.EventSystem.Flow;

  function hiddenTab() {
    return globalThis.FUCompanion?.api?.vfxSuppressed?.() === true;
  }

  // ------------------------------------------------------------
  // Layer
  // ------------------------------------------------------------
  // The layer itself is NOT a stacking context (absolute, z-index auto), so
  // each picture frame (fixed, z-index 25) stacks in the page's own context:
  // above the world-anchored animation layer (24), and below the Screen
  // Effect layer (also 25) because the picture layer always sits before it in
  // the page. That also lets "Add" and "Multiply" blend with the map.
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${LAYER_ID} {
        position: absolute;
        left: 0;
        top: 0;
        width: 0;
        height: 0;
        overflow: visible;
        pointer-events: none;
      }
      #${LAYER_ID} > .oni-event-picture {
        position: fixed;
        inset: 0;
        z-index: 25;
        overflow: hidden;
        pointer-events: none;
        opacity: 0;
      }
      #${LAYER_ID} .oni-event-picture-box {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 100%;
        height: 100%;
        transform-origin: 50% 50%;
        will-change: transform;
        backface-visibility: hidden;
      }
      #${LAYER_ID} .oni-event-picture.native .oni-event-picture-box {
        width: auto;
        height: auto;
      }
      #${LAYER_ID} .oni-event-picture-media {
        display: block;
        width: 100%;
        height: 100%;
        max-width: none;
        max-height: none;
        border: 0;
        outline: 0;
        background: none;
      }
      #${LAYER_ID} .oni-event-picture.native .oni-event-picture-media {
        width: auto;
        height: auto;
      }
      #${LAYER_ID} .oni-event-picture-vignette,
      #${LAYER_ID} .oni-event-picture-grain {
        position: absolute;
        inset: 0;
        opacity: 0;
        pointer-events: none;
      }
      #${LAYER_ID} .oni-event-picture-vignette {
        background: radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,.7) 100%);
      }
      #${LAYER_ID} .oni-event-picture-grain {
        mix-blend-mode: overlay;
        background-repeat: repeat;
        background-size: ${GRAIN_TILE}px ${GRAIN_TILE}px;
        animation: oni-event-picture-grain 0.9s steps(1, end) infinite;
      }
      @keyframes oni-event-picture-grain {
        0%   { background-position: 0 0; }
        17%  { background-position: -37px 21px; }
        33%  { background-position: 53px -11px; }
        50%  { background-position: -19px -47px; }
        67%  { background-position: 29px 61px; }
        83%  { background-position: -61px 7px; }
      }
    `;
    document.head.appendChild(style);
  }

  function getLayer() {
    ensureStyle();
    let el = document.getElementById(LAYER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = LAYER_ID;
    }
    // Before the Screen Effect layer, whichever of the two was made first.
    const screen = document.getElementById(SCREEN_LAYER_ID);
    if (screen?.parentNode) {
      const before = el.isConnected && (el.compareDocumentPosition(screen) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!before) screen.parentNode.insertBefore(el, screen);
    } else if (!el.parentNode) {
      document.body.appendChild(el);
    }
    return el;
  }

  let grainUrl = null;
  function grainImage() {
    if (grainUrl) return grainUrl;
    try {
      const cvs = document.createElement("canvas");
      cvs.width = GRAIN_TILE;
      cvs.height = GRAIN_TILE;
      const ctx = cvs.getContext("2d");
      const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.floor(Math.random() * 256);
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      grainUrl = cvs.toDataURL("image/png");
    } catch (_) {
      grainUrl = "none";
    }
    return grainUrl;
  }

  // ------------------------------------------------------------
  // Drawing, on this client
  // ------------------------------------------------------------
  let local = { pictures: {} };
  const views = new Map();        // slot -> view { frame, box, media, vignette, grain }
  const leaving = new Set();      // frames fading out (dissolved or erased)

  function announce() {
    try { Hooks.callAll("oniEventPicturesChanged", publicState()); } catch (_) {}
  }

  function publicState() {
    return {
      sceneId: (typeof canvas !== "undefined" && canvas?.scene?.id) || null,
      pictures: Object.values(local.pictures).map(p => ({ ...p, tint: { ...p.tint } })).sort((a, b) => a.slot - b.slot)
    };
  }

  // Each property to its value over ms. Starts from where it is now, even
  // mid-way through an earlier change.
  function animateTo(el, to, ms, easing = "ease-in-out") {
    if (!el) return Promise.resolve();
    const now = getComputedStyle(el);
    const from = {};
    for (const key of Object.keys(to)) from[key] = now[key];
    for (const anim of el.getAnimations?.() ?? []) { try { anim.cancel(); } catch (_) {} }
    Object.assign(el.style, to);

    if (ms <= 0 || hiddenTab()) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        el.animate([from, to], { duration: ms, easing }).finished.then(finish, finish);
      } catch (_) { finish(); }
      // An animation on a tab hidden midway never reports back.
      setTimeout(finish, ms + 300);
    });
  }

  // Position, rotation and scale all live in ONE transform; left/top stay
  // fixed at 50%. Animating left/top (layout) over a slow 30-40 s push-in
  // snapped to whole pixels each frame and the picture visibly jittered
  // (user, 2026-11-18). A transform moves in sub-pixels on its own layer.
  // The frame fills the viewport, so x/y % of the frame = vw/vh.
  const boxTransform = (p) =>
    `translate(calc(-50% + ${p.x - 50}vw), calc(-50% + ${p.y - 50}vh)) rotate(${p.rotation}deg) scale(${p.scale / 100})`;

  function makeView(p) {
    const frame = document.createElement("div");
    frame.className = `oni-event-picture ${p.fit}`;
    frame.dataset.slot = String(p.slot);
    frame.style.mixBlendMode = blendCss(p.blend);

    const box = document.createElement("div");
    box.className = "oni-event-picture-box";

    const media = document.createElement(p.video ? "video" : "img");
    media.className = "oni-event-picture-media";
    if (p.video) {
      media.muted = true;
      media.loop = true;
      media.autoplay = true;
      media.playsInline = true;
    } else {
      media.decoding = "async";
      media.alt = "";
    }
    media.addEventListener("error", () => warnOnce(`load:${p.src}`, () => console.warn(INSTALL_TAG, `Picture could not load "${p.src}".`)), { once: true });
    media.src = p.src;
    if (p.fit !== "native") media.style.objectFit = p.fit;

    const vignette = document.createElement("div");
    vignette.className = "oni-event-picture-vignette";
    const grain = document.createElement("div");
    grain.className = "oni-event-picture-grain";

    box.append(media, vignette, grain);
    frame.appendChild(box);
    const view = { frame, box, media, vignette, grain };
    setLook(view, p, 0, "linear");
    return view;
  }

  // Place a frame among the others by slot; a new one after an old one of
  // the same slot (it dissolves in over it).
  function insertFrame(frame, slot) {
    const host = getLayer();
    const after = [...host.children].find(el => Number(el.dataset.slot) > slot);
    host.insertBefore(frame, after ?? null);
  }

  function setPlace(view, p, ms, easing) {
    return animateTo(view.box, { transform: boxTransform(p) }, ms, easing);
  }

  function setLook(view, p, ms, easing) {
    if (p.grain && !view.grain.style.backgroundImage) view.grain.style.backgroundImage = `url("${grainImage()}")`;
    return Promise.all([
      animateTo(view.media, { filter: tintFilter(p.tint) }, ms, easing),
      animateTo(view.vignette, { opacity: p.vignette ? "1" : "0" }, ms, easing),
      animateTo(view.grain, { opacity: p.grain ? "0.07" : "0" }, ms, easing)
    ]);
  }

  function dropFrame(frame, ms) {
    if (!frame) return;
    leaving.add(frame);
    const gone = () => { leaving.delete(frame); frame.remove(); stopFollowIfIdle(); };
    if (ms <= 0 || hiddenTab()) { gone(); return; }
    animateTo(frame, { opacity: "0" }, ms, "ease-in-out").then(gone);
  }

  function dropSlot(slot, ms) {
    const view = views.get(slot);
    if (!view) return;
    views.delete(slot);
    dropFrame(view.frame, ms);
  }

  function dropAll(ms) {
    for (const slot of [...views.keys()]) dropSlot(slot, ms);
    if (ms <= 0) for (const frame of [...leaving]) { leaving.delete(frame); frame.remove(); }
  }

  function drawShow(p, ms) {
    const old = views.get(p.slot);
    const view = makeView(p);
    setPlace(view, p, 0, "linear");
    insertFrame(view.frame, p.slot);
    views.set(p.slot, view);
    startFollow();

    // The new one comes up over the old, which goes once it is covered.
    const fadeMs = hiddenTab() ? 0 : ms;
    if (old) leaving.add(old.frame);
    animateTo(view.frame, { opacity: String(p.opacity / 100) }, fadeMs, "ease-in-out").then(() => {
      if (old) { leaving.delete(old.frame); old.frame.remove(); stopFollowIfIdle(); }
    });
  }

  // One change, on this client: the state first, then the screen.
  function apply(action, ms = 0, easing = "ease-in-out") {
    const before = local;
    local = reduce(local, action);
    const time = hiddenTab() ? 0 : Math.max(0, toNum(ms, 0));

    switch (action?.type) {
      case "show": {
        const slot = normSlot(action.picture?.slot);
        const p = slot !== null ? local.pictures[slot] : null;
        if (p) drawShow(p, time);
        break;
      }
      case "move":
        for (const slot of slotsOf(local.pictures, action.slot)) {
          const view = views.get(slot);
          const p = local.pictures[slot];
          if (!view || !p) continue;
          // Only what the row changes, so a fade in still running is not cut.
          if (["x", "y", "scale", "rotation"].some(k => action[k] !== null && action[k] !== undefined)) setPlace(view, p, time, easing);
          if (action.opacity !== null && action.opacity !== undefined) {
            animateTo(view.frame, { opacity: String(p.opacity / 100) }, time, easing);
          }
        }
        break;
      case "tint":
        for (const slot of slotsOf(local.pictures, action.slot)) {
          const view = views.get(slot);
          if (view) setLook(view, local.pictures[slot], time, easing);
        }
        break;
      case "erase":
      case "endEvent":
      case "clear":
        for (const slot of Object.keys(before.pictures).map(Number)) {
          if (!local.pictures[slot]) dropSlot(slot, time);
        }
        break;
      case "sync":
        for (const p of Object.values(local.pictures)) {
          if (before.pictures[p.slot]?.rev === p.rev && views.has(p.slot)) continue;
          drawShow(p, 0);
        }
        break;
      default:
        return;
    }
    announce();
  }

  function resetLocal() {
    dropAll(0);
    const had = Object.keys(local.pictures).length > 0;
    local = { pictures: {} };
    stopFollow();
    if (had) announce();
  }

  // ------------------------------------------------------------
  // Following Screen Effect "shake" (it animates #board)
  // ------------------------------------------------------------
  let followFrame = null;
  let shaken = false;

  function followTick() {
    followFrame = null;
    if (!views.size && !leaving.size) return;
    const board = document.getElementById("board");
    let dx = 0;
    let dy = 0;
    if (board?.getAnimations?.().length) {
      const m = String(getComputedStyle(board).transform || "").match(/^matrix\(([^)]+)\)$/);
      if (m) {
        const parts = m[1].split(",").map(Number);
        dx = parts[4] || 0;
        dy = parts[5] || 0;
      }
    }
    if (dx || dy || shaken) {
      shaken = !!(dx || dy);
      const value = shaken ? `${dx}px ${dy}px` : "";
      for (const view of views.values()) view.frame.style.translate = value;
      for (const frame of leaving) frame.style.translate = value;
    }
    followFrame = requestAnimationFrame(followTick);
  }

  function startFollow() {
    if (followFrame === null && typeof requestAnimationFrame === "function") followFrame = requestAnimationFrame(followTick);
  }

  function stopFollow() {
    if (followFrame !== null) { try { cancelAnimationFrame(followFrame); } catch (_) {} }
    followFrame = null;
    shaken = false;
  }

  function stopFollowIfIdle() {
    if (!views.size && !leaving.size) stopFollow();
  }

  // ------------------------------------------------------------
  // The authority: what each scene shows, kept by the GMs
  // ------------------------------------------------------------
  // The GM running the event gets every change first (Client.run plays on
  // the sender too); other GMs on the scene track it as well. Unlike a
  // client's own drawing, it outlives a scene change, so kept pictures come
  // back with their scene and a reloading player gets them.
  const authority = new Map();   // sceneId -> state

  Client.register(KIND_PICTURE, (data, info) => {
    const sceneId = String(info?.sceneId || "");
    if (game.user?.isGM && sceneId) {
      const next = reduce(authority.get(sceneId), data?.action);
      if (Object.keys(next.pictures).length) authority.set(sceneId, next);
      else authority.delete(sceneId);
    }
    // Shown to the GM as well: no info.presents check.
    apply(data?.action, data?.ms, easingCss(data?.easing));
  });

  function commit(sourceId, action, ms = 0, easing = "easeInOut") {
    Client.run(sourceId, KIND_PICTURE, { action, ms, easing });
  }

  function emit(type, payload) {
    try { game.socket.emit(SOCKET_CHANNEL, { type, payload }); } catch (e) {
      console.warn(INSTALL_TAG, "Could not send a picture message.", e);
    }
  }

  function requestSync() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    // A GM's own pictures need no round trip.
    const own = authority.get(sceneId);
    if (own && Object.keys(own.pictures).length) apply({ type: "sync", pictures: own.pictures });
    emit(MSG_SYNC_REQ, { sceneId, userId: game.user?.id ?? null });
  }

  function onSocket(msg) {
    try {
      if (msg?.type === MSG_SYNC_REQ) {
        if (!game.user?.isGM) return;
        const { sceneId, userId } = msg.payload ?? {};
        const state = authority.get(String(sceneId || ""));
        if (!state || !Object.keys(state.pictures).length) return;
        emit(MSG_SYNC, { sceneId, userId, pictures: state.pictures });
        return;
      }
      if (msg?.type === MSG_SYNC) {
        const { sceneId, userId, pictures } = msg.payload ?? {};
        if (userId !== game.user?.id || !canvas?.scene || sceneId !== canvas.scene.id) return;
        if (game.user?.isGM) authority.set(sceneId, reduce(authority.get(sceneId), { type: "sync", pictures }));
        apply({ type: "sync", pictures });
      }
    } catch (e) {
      console.warn(INSTALL_TAG, "Picture socket handler error.", e);
    }
  }

  // ------------------------------------------------------------
  // Checking a file before showing it (GM)
  // ------------------------------------------------------------
  const warned = new Set();
  function warnOnce(key, fn) {
    if (warned.has(key)) return;
    warned.add(key);
    try { fn(); } catch (_) {}
  }

  // "ok", "bad" (it failed to load) or "slow" (no answer in time: shown anyway).
  function probe(src) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        if (isVideoSrc(src)) {
          const el = document.createElement("video");
          el.preload = "metadata";
          el.muted = true;
          el.addEventListener("loadedmetadata", () => finish("ok"), { once: true });
          el.addEventListener("error", () => finish("bad"), { once: true });
          el.src = src;
        } else {
          const img = new Image();
          img.onload = () => finish("ok");
          img.onerror = () => finish("bad");
          img.src = src;
        }
      } catch (_) {
        finish("slow");
      }
      setTimeout(() => finish("slow"), PROBE_TIMEOUT_MS);
    });
  }

  function skipRow(key, message) {
    warnOnce(key, () => ui.notifications?.warn?.(message));
    console.warn(INSTALL_TAG, message);
  }

  // ------------------------------------------------------------
  // Shared fields
  // ------------------------------------------------------------
  const SLOT_OPTIONS = Array.from({ length: SLOT_MAX }, (_, i) => [String(i + 1), String(i + 1)]);
  const SLOT_OPTIONS_ALL = [["all", "All"], ...SLOT_OPTIONS];

  function slotField(kit, row, allowAll, note) {
    const slot = normSlot(row.slot, allowAll) ?? 1;
    return kit.field(
      "Picture number",
      `<select class="oni-event-row-pic-slot">${kit.options(allowAll ? SLOT_OPTIONS_ALL : SLOT_OPTIONS, String(slot))}</select>`,
      note
    );
  }

  const readSlot = (rowEl, kit, allowAll) => normSlot(kit.readText(rowEl, ".oni-event-row-pic-slot", "1"), allowAll) ?? 1;

  function tintFields(kit, row) {
    const t = normTint(row);
    return [
      kit.field(
        "Tint",
        `<select class="oni-event-row-pic-tint">${kit.options(TINTS, t.preset)}</select>`,
        "Faded memory: a soft sepia, for flashbacks."
      ),
      `<div class="oni-event-row-pic-custom-wrap">${kit.field(
        "Custom",
        `sepia ${kit.numberInput("oni-event-row-pic-sepia", t.sepia, { min: 0, max: 1, step: 0.05 })}
         grey ${kit.numberInput("oni-event-row-pic-grayscale", t.grayscale, { min: 0, max: 1, step: 0.05 })}
         brightness ${kit.numberInput("oni-event-row-pic-brightness", t.brightness, { min: 0, max: 3, step: 0.05 })}
         saturation ${kit.numberInput("oni-event-row-pic-saturate", t.saturate, { min: 0, max: 3, step: 0.05 })}`,
        "Sepia and grey 0 to 1; brightness and saturation 1 = unchanged."
      )}</div>`,
      kit.field(
        "",
        `<label><input type="checkbox" class="oni-event-row-pic-vignette" ${row.vignette === true ? "checked" : ""} /> dark edges</label>
         <label><input type="checkbox" class="oni-event-row-pic-grain" ${row.grain === true ? "checked" : ""} /> film grain</label>`
      )
    ];
  }

  function wireTint(body) {
    const tintEl = body.querySelector(".oni-event-row-pic-tint");
    const wrap = body.querySelector(".oni-event-row-pic-custom-wrap");
    if (!tintEl || !wrap) return;
    const sync = () => { wrap.hidden = tintEl.value !== "custom"; };
    tintEl.addEventListener("change", sync);
    sync();
  }

  function readTint(rowEl, kit) {
    return {
      tint: pick(TINTS, kit.readText(rowEl, ".oni-event-row-pic-tint", "normal"), "normal"),
      sepia: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-sepia", 0), 0, 1, 0),
      grayscale: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-grayscale", 0), 0, 1, 0),
      brightness: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-brightness", 1), 0, 3, 1),
      saturate: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-saturate", 1), 0, 3, 1),
      vignette: !!kit.own(rowEl, ".oni-event-row-pic-vignette")?.checked,
      grain: !!kit.own(rowEl, ".oni-event-row-pic-grain")?.checked
    };
  }

  const tintData = (t) => ({ tint: t.preset, sepia: t.sepia, grayscale: t.grayscale, brightness: t.brightness, saturate: t.saturate });

  // ------------------------------------------------------------
  // Show Picture
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "showPicture",
    label: "Show Picture",
    category: "Screen",
    defaultData: {
      type: "showPicture",
      slot: 1,
      src: "",
      fit: "cover",
      x: 50,
      y: 50,
      scale: 100,
      opacity: 100,
      rotation: 0,
      blend: "normal",
      fadeSeconds: 0,
      tint: "normal",
      sepia: 0,
      grayscale: 0,
      brightness: 1,
      saturate: 1,
      vignette: false,
      grain: false,
      keep: false,
      wait: true
    },
    summary: summaryShow,
    mediaOf: (row) => [normSrc(row?.src)].filter(Boolean),
    execute: async (row, context) => {
      const show = normShow(row);
      const raw = String(row?.src ?? "").trim();
      if (!raw) {
        skipRow(`empty:${context?.tileId}`, "Event: Show Picture has no picture. That row was skipped.");
        return { ok: false, type: "showPicture", reason: "noPictureFile" };
      }
      if (!show.src) {
        skipRow(`type:${raw}`, `Event: Show Picture "${fileName(raw)}" is not an image or video file. That row was skipped.`);
        return { ok: false, type: "showPicture", reason: "badPictureFile" };
      }
      if (await probe(show.src) === "bad") {
        skipRow(`load:${show.src}`, `Event: Show Picture could not load "${fileName(show.src)}". That row was skipped.`);
        return { ok: false, type: "showPicture", reason: "pictureNotFound" };
      }

      const tileId = String(context?.tileId ?? "");
      const fadeMs = show.fadeSeconds * 1000;
      commit(tileId, { type: "show", owner: tileId, rev: Date.now(), picture: pictureFrom(show, tileId) }, fadeMs);

      if (show.wait && fadeMs > 0) await flow()?.wait?.(tileId, fadeMs);
      return { ok: true, type: "showPicture", slot: show.slot };
    },
    buildFields: (row, kit) => {
      const s = normShow(row);
      const body = kit.fields(
        slotField(kit, row, false, "1 to 20. A higher number draws on top. Showing into a number that already has a picture dissolves the new one over it."),
        kit.field("Image / video", kit.fileInput("oni-event-row-pic-src", row.src, "imagevideo", "Path (webp, png, jpg, or a webm that loops)")),
        kit.field(
          "Fit",
          `<select class="oni-event-row-pic-fit">${kit.options(FITS, s.fit)}</select>`,
          "Pictures sit over the map and under screen fades, letterbox bars and dialogue. The GM sees them too."
        ),
        kit.field(
          "Place",
          `x ${kit.numberInput("oni-event-row-pic-x", s.x, { min: -100, max: 200, step: 1 })} %
           y ${kit.numberInput("oni-event-row-pic-y", s.y, { min: -100, max: 200, step: 1 })} %`,
          "Where the picture's centre is, in % of the screen. 50 / 50 = the middle."
        ),
        kit.field(
          "Look",
          `size ${kit.numberInput("oni-event-row-pic-scale", s.scale, { min: 1, max: 1000, step: 5 })} %
           opacity ${kit.numberInput("oni-event-row-pic-opacity", s.opacity, { min: 0, max: 100, step: 5 })} %
           turn ${kit.numberInput("oni-event-row-pic-rotation", s.rotation, { min: -3600, max: 3600, step: 5 })} °`
        ),
        kit.field("Blend", `<select class="oni-event-row-pic-blend">${kit.options(BLENDS, s.blend)}</select>`),
        ...tintFields(kit, row),
        kit.field(
          "Fade in (s)",
          kit.numberInput("oni-event-row-pic-fade", s.fadeSeconds, { min: 0, max: MAX_SECONDS, step: 0.1 })
        ),
        kit.field(
          "",
          `<label><input type="checkbox" class="oni-event-row-pic-keep" ${s.keep ? "checked" : ""} /> keep after the event</label>`,
          "Off: the picture goes when this event ends. On: it stays on this scene until an Erase Picture row takes it off."
        ),
        kit.waitField(row, true, "On: the next event waits until the fade in has finished.")
      );
      wireTint(body);
      return body;
    },
    collectFields: (rowEl, kit) => {
      const t = readTint(rowEl, kit);
      return {
        slot: readSlot(rowEl, kit, false),
        src: kit.readText(rowEl, ".oni-event-row-pic-src", "").trim(),
        fit: pick(FITS, kit.readText(rowEl, ".oni-event-row-pic-fit", "cover"), "cover"),
        x: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-x", 50), -100, 200, 50),
        y: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-y", 50), -100, 200, 50),
        scale: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-scale", 100), 1, 1000, 100),
        opacity: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-opacity", 100), 0, 100, 100),
        rotation: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-rotation", 0), -3600, 3600, 0),
        blend: pick(BLENDS, kit.readText(rowEl, ".oni-event-row-pic-blend", "normal"), "normal"),
        fadeSeconds: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-fade", 0), 0, MAX_SECONDS, 0),
        ...t,
        keep: !!kit.own(rowEl, ".oni-event-row-pic-keep")?.checked,
        wait: kit.readWait(rowEl, true)
      };
    }
  });

  // ------------------------------------------------------------
  // Move Picture
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "movePicture",
    label: "Move Picture",
    category: "Screen",
    defaultData: { type: "movePicture", slot: 1, x: "", y: "", scale: "", opacity: "", rotation: "", seconds: 1, easing: "easeInOut", wait: false },
    summary: summaryMove,
    execute: async (row, context) => {
      const move = normMove(row);
      const tileId = String(context?.tileId ?? "");
      const ms = move.seconds * 1000;
      const action = { type: "move", slot: move.slot, rev: Date.now() };
      for (const key of MOVE_KEYS) action[key] = move[key];
      commit(tileId, action, ms, move.easing);

      if (move.wait && ms > 0) await flow()?.wait?.(tileId, ms);
      return { ok: true, type: "movePicture", slot: move.slot };
    },
    buildFields: (row, kit) => {
      const s = normMove(row);
      const num = (cls, v, opts) => kit.numberInput(cls, v === null ? "" : v, { ...opts, placeholder: "keep" });
      return kit.fields(
        slotField(kit, row, false),
        kit.field(
          "Place",
          `x ${num("oni-event-row-pic-x", s.x, { min: -100, max: 200, step: 1 })} %
           y ${num("oni-event-row-pic-y", s.y, { min: -100, max: 200, step: 1 })} %`,
          "Empty: stays as it is."
        ),
        kit.field(
          "Look",
          `size ${num("oni-event-row-pic-scale", s.scale, { min: 1, max: 1000, step: 5 })} %
           opacity ${num("oni-event-row-pic-opacity", s.opacity, { min: 0, max: 100, step: 5 })} %
           turn ${num("oni-event-row-pic-rotation", s.rotation, { min: -3600, max: 3600, step: 5 })} °`
        ),
        kit.field("Duration (s)", kit.numberInput("oni-event-row-pic-seconds", s.seconds, { min: 0, max: MAX_SECONDS, step: 0.1 })),
        kit.field("Easing", `<select class="oni-event-row-pic-easing">${kit.options(EASINGS, s.easing)}</select>`),
        kit.waitField(row, false)
      );
    },
    collectFields: (rowEl, kit) => {
      const keepable = (cls, low, high) => {
        const v = clampOrKeep(kit.readText(rowEl, cls, ""), low, high);
        return v === null ? "" : v;
      };
      return {
        slot: readSlot(rowEl, kit, false),
        x: keepable(".oni-event-row-pic-x", -100, 200),
        y: keepable(".oni-event-row-pic-y", -100, 200),
        scale: keepable(".oni-event-row-pic-scale", 1, 1000),
        opacity: keepable(".oni-event-row-pic-opacity", 0, 100),
        rotation: keepable(".oni-event-row-pic-rotation", -3600, 3600),
        seconds: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-seconds", 1), 0, MAX_SECONDS, 1),
        easing: pick(EASINGS, kit.readText(rowEl, ".oni-event-row-pic-easing", "easeInOut"), "easeInOut"),
        wait: kit.readWait(rowEl, false)
      };
    }
  });

  // ------------------------------------------------------------
  // Tint Picture
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "tintPicture",
    label: "Tint Picture",
    category: "Screen",
    defaultData: {
      type: "tintPicture", slot: 1, tint: "memory", sepia: 0, grayscale: 0, brightness: 1, saturate: 1,
      vignette: false, grain: false, seconds: 1, wait: false
    },
    summary: summaryTint,
    execute: async (row, context) => {
      const t = normTintRow(row);
      const tileId = String(context?.tileId ?? "");
      const ms = t.seconds * 1000;
      commit(tileId, { type: "tint", slot: t.slot, tint: t.tint, vignette: t.vignette, grain: t.grain, rev: Date.now() }, ms, "easeInOut");

      if (t.wait && ms > 0) await flow()?.wait?.(tileId, ms);
      return { ok: true, type: "tintPicture", slot: t.slot };
    },
    buildFields: (row, kit) => {
      const s = normTintRow(row);
      const body = kit.fields(
        slotField(kit, row, true, "All: every picture on the screen now."),
        ...tintFields(kit, { ...tintData(s.tint), vignette: s.vignette, grain: s.grain }),
        kit.field("Duration (s)", kit.numberInput("oni-event-row-pic-seconds", s.seconds, { min: 0, max: MAX_SECONDS, step: 0.1 })),
        kit.waitField(row, false)
      );
      wireTint(body);
      return body;
    },
    collectFields: (rowEl, kit) => ({
      slot: readSlot(rowEl, kit, true),
      ...readTint(rowEl, kit),
      seconds: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-seconds", 1), 0, MAX_SECONDS, 1),
      wait: kit.readWait(rowEl, false)
    })
  });

  // ------------------------------------------------------------
  // Erase Picture
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "erasePicture",
    label: "Erase Picture",
    category: "Screen",
    defaultData: { type: "erasePicture", slot: 1, fadeSeconds: 0, wait: true },
    summary: summaryErase,
    execute: async (row, context) => {
      const e = normErase(row);
      const tileId = String(context?.tileId ?? "");
      const ms = e.fadeSeconds * 1000;
      commit(tileId, { type: "erase", slot: e.slot }, ms);

      if (e.wait && ms > 0) await flow()?.wait?.(tileId, ms);
      return { ok: true, type: "erasePicture", slot: e.slot };
    },
    buildFields: (row, kit) => {
      const s = normErase(row);
      return kit.fields(
        slotField(kit, row, true, "All: every picture on this scene, kept ones included."),
        kit.field("Fade out (s)", kit.numberInput("oni-event-row-pic-fade", s.fadeSeconds, { min: 0, max: MAX_SECONDS, step: 0.1 })),
        kit.waitField(row, true, "On: the next event waits until the fade out has finished.")
      );
    },
    collectFields: (rowEl, kit) => ({
      slot: readSlot(rowEl, kit, true),
      fadeSeconds: clamp(kit.readNumber(rowEl, ".oni-event-row-pic-fade", 0), 0, MAX_SECONDS, 0),
      wait: kit.readWait(rowEl, true)
    })
  });

  // ------------------------------------------------------------
  // Event end, scene change, reload
  // ------------------------------------------------------------
  // Every client hears the end of every event (event-executeCore.js), so
  // each one lifts that event's pictures itself; the GM also forgets them.
  Hooks.on("oniEventExecuteDone", ({ sourceId } = {}) => {
    const owner = String(sourceId || "");
    if (!owner) return;
    for (const [sceneId, state] of authority) {
      const next = reduce(state, { type: "endEvent", owner });
      if (Object.keys(next.pictures).length) authority.set(sceneId, next);
      else authority.delete(sceneId);
    }
    if (Object.values(local.pictures).some(p => p.owner === owner && !p.keep)) {
      apply({ type: "endEvent", owner }, END_FADE_MS);
    }
  });

  // Kept pictures stay in the authority and come back with the scene.
  Hooks.on("canvasTearDown", resetLocal);

  let socketReady = false;
  Hooks.once("ready", () => {
    try {
      game.socket.on(SOCKET_CHANNEL, onSocket);
      socketReady = true;
    } catch (e) {
      console.error(INSTALL_TAG, "Failed to install the socket listener.", e);
    }
    requestSync();
  });
  Hooks.on("canvasReady", () => { if (socketReady) requestSync(); });

  window.oni.EventSystem.Pictures = {
    installed: true,
    // At least one picture showing on THIS client (opacity above 0).
    anyShown: () => visibleCount(local) > 0,
    state: publicState,
    // For the console and tests.
    authorityOf: (sceneId) => authority.get(String(sceneId || "")) ?? null,
    clearLocal: resetLocal
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.Pictures");
})();
