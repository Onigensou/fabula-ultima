/**
 * [ONI] Event System — Boss Banner
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-banner.js
 *
 * What this does:
 * - Registers the "Boss Banner" event action: a name card across the upper
 *   part of every screen. A dark see-through band, a small line above
 *   ("SEEKER OF STRENGTH", in the row's colour) and the big name ("ASURA").
 *   The two lines slide in from opposite sides over the first fifth and the
 *   card fades out over the last fifth.
 * - Optional: while the card is up, the camera pushes in on a named token's
 *   face (2.2 s), then pulls back to where it was (0.6 s) once the card is gone.
 *
 * How it fits together:
 * - Every client draws the card itself (Client.run). The GM sees the card too;
 *   it is a title, not a screen fade.
 * - The camera follows Camera Pan's rules (event-rows-camera.js): the GM's
 *   camera is not moved (the GM chip says "camera push-in" instead), the
 *   exploration follow camera is held while the push runs and handed back
 *   after, the chat sidebar shift is the one Camera Pan uses, and every move
 *   goes through canvas.pan, so the Camera Authority's play-area clamp holds.
 * - The push is relative: each client zooms in from its own zoom by the row's
 *   factor and returns to its own view, so screens with different zooms or
 *   sidebars each end up where they started.
 * - "Wait for completion" holds the event until the card is gone (and the
 *   camera is back), so a Show Text after it opens on a clear screen. Timed on
 *   the GM, not by any one screen.
 * - Ending the event mid-card takes the card down and sends the camera back.
 * - A reduced-motion player gets the card without the slide and without the push.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 * - scripts/map-system/movementControl-cameraRuntime.js (the follow camera)
 * - scripts/battle-director/director-camera.js (FUCompanion.api.camera)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsBanner]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsBanner?.installed) {
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

  const KIND_BANNER = "banner.show";
  const HOLD_ID = "event-banner";
  const LAYER_ID = "oni-event-banner-layer";
  const STYLE_ID = "oni-event-banner-style";

  const DEFAULT_SECONDS = 2.6;
  const MIN_SECONDS = 0.5;
  const MAX_SECONDS = 20;
  const DEFAULT_COLOR = "#e58c6a";
  const DEFAULT_ZOOM = 1.45;
  const DEFAULT_FACE = 0.64;

  // The camera: in over PUSH_MS (cut short by a shorter card), back over RETURN_MS.
  const PUSH_MS = 2200;
  const RETURN_MS = 600;

  // The card, as drawn on a 1027 px tall window (everything scales with the
  // window's height): the band's top at 16% of the height, 120 tall; the slide
  // is 140; the lines' left edges and baselines are measured from the band.
  const BAND_TOP = 0.16;
  const SLIDE_PX = 140;
  const FADE_IN = 0.15;
  const SLIDE_IN = 0.2;
  const FADE_OUT = 0.2;

  const flow = () => window.oni.EventSystem.Flow;
  const followRuntime = () => globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__ ?? null;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const reducedMotion = () => {
    try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
  };

  // ------------------------------------------------------------
  // Plain calculation (tested in check-text-banner.test.mjs)
  // ------------------------------------------------------------
  // u: 0..1 through the card -> { alpha, slide } (slide in px on a 1027 px window).
  function bannerFrame(u) {
    const t = clamp01(Number(u) || 0);
    const alpha = t < FADE_IN ? t / FADE_IN : t > 1 - FADE_OUT ? (1 - t) / FADE_OUT : 1;
    const slide = (1 - easeOutCubic(clamp01(t / SLIDE_IN))) * SLIDE_PX;
    return { alpha: clamp01(alpha), slide };
  }

  // The point to aim at on a sprite: faceFrac of the way up from its feet,
  // i.e. its top + (1 - faceFrac) of its height. rect: { x, top, height }.
  function faceAim(rect, faceFrac = DEFAULT_FACE) {
    const f = clamp01(Logic.toNumber(faceFrac, DEFAULT_FACE));
    return { x: Number(rect?.x) || 0, y: (Number(rect?.top) || 0) + ((1 - f) * (Number(rect?.height) || 0)) };
  }

  // The view to push in to: the face point (plus the sidebar shift), at this
  // client's own zoom times the factor.
  function pushTarget(from, aim, zoomFactor, shift = { x: 0, y: 0 }) {
    const factor = Math.max(0.1, Logic.toNumber(zoomFactor, DEFAULT_ZOOM));
    return { x: aim.x + (shift?.x ?? 0), y: aim.y + (shift?.y ?? 0), scale: from.scale * factor };
  }

  // -> { bannerMs, pushMs, returnMs, waitMs, camera }
  function timing(row) {
    const bannerMs = Math.round(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Logic.toNumber(row?.seconds, DEFAULT_SECONDS))) * 1000);
    const camera = !!String(row?.token ?? "").trim();
    const pushMs = camera ? Math.min(PUSH_MS, bannerMs) : 0;
    const returnMs = camera ? RETURN_MS : 0;
    return { bannerMs, pushMs, returnMs, waitMs: bannerMs + returnMs, camera };
  }

  const isColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? ""));

  function prepare(row) {
    row.kicker = String(row.kicker ?? "");
    row.name = String(row.name ?? "");
    row.color = isColor(row.color) ? row.color : DEFAULT_COLOR;
    row.seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Logic.toNumber(row.seconds, DEFAULT_SECONDS)));
    row.token = String(row.token ?? "").trim();
    row.zoomFactor = Math.min(4, Math.max(1, Logic.toNumber(row.zoomFactor, DEFAULT_ZOOM)));
    row.faceFrac = clamp01(Logic.toNumber(row.faceFrac, DEFAULT_FACE));
    row.wait = row.wait !== false;
  }

  // ------------------------------------------------------------
  // The card
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // --u: one pixel of the 1027 px tall window the card was drawn on.
    // Below floating text (60), the GM chip (95) and the dialogue boxes.
    style.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 55; overflow: hidden; --u: calc(100vh / 1027); }
#${LAYER_ID} .oni-banner-band { position: absolute; left: 0; right: 0; top: ${BAND_TOP * 100}vh;
  height: calc(var(--u) * 120); background: rgba(8, 6, 14, 0.55); opacity: 0; will-change: opacity; }
#${LAYER_ID} .oni-banner-kicker, #${LAYER_ID} .oni-banner-name { position: absolute; white-space: nowrap; line-height: 1; will-change: transform; }
#${LAYER_ID} .oni-banner-kicker { left: calc(var(--u) * 150); top: calc(var(--u) * 21);
  font: 600 calc(var(--u) * 30) "IBM Plex Mono", ui-monospace, Consolas, monospace; letter-spacing: 0.02em; }
#${LAYER_ID} .oni-banner-name { left: calc(var(--u) * 146); top: calc(var(--u) * 52);
  font: 700 calc(var(--u) * 64) Signika, sans-serif; color: #fff; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); }
`;
    document.head.appendChild(style);
  }

  function ensureLayer() {
    ensureStyle();
    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = LAYER_ID;
      document.body.appendChild(layer);
    }
    return layer;
  }

  // One card on screen at a time: a new one replaces the last.
  let card = null;

  function removeCard() {
    if (!card) return;
    const gone = card;
    card = null;
    if (gone.frame) cancelAnimationFrame(gone.frame);
    if (gone.timer) clearTimeout(gone.timer);
    gone.el?.remove();
    const layer = document.getElementById(LAYER_ID);
    if (layer && !layer.children.length) layer.remove();
  }

  function showCard(data, onGone) {
    removeCard();

    const el = document.createElement("div");
    el.className = "oni-banner-band";
    const kicker = document.createElement("div");
    kicker.className = "oni-banner-kicker";
    kicker.style.color = isColor(data.color) ? data.color : DEFAULT_COLOR;
    kicker.textContent = String(data.kicker ?? "");
    const name = document.createElement("div");
    name.className = "oni-banner-name";
    name.textContent = String(data.name ?? "").toUpperCase();
    el.append(kicker, name);
    ensureLayer().appendChild(el);

    const durationMs = Math.max(1, Number(data.bannerMs) || DEFAULT_SECONDS * 1000);
    const still = reducedMotion();
    const startedAt = performance.now();
    const mine = { el, frame: 0, timer: 0 };
    card = mine;

    const draw = () => {
      if (card !== mine) return;
      const { alpha, slide } = bannerFrame((performance.now() - startedAt) / durationMs);
      const px = still ? 0 : slide;
      el.style.opacity = String(alpha);
      kicker.style.transform = `translateX(calc(var(--u) * ${-px}))`;
      name.style.transform = `translateX(calc(var(--u) * ${px * 0.5}))`;
      mine.frame = requestAnimationFrame(draw);
    };
    draw();

    // The clock takes the card down, not the frames: a hidden window still
    // ends on time.
    mine.timer = setTimeout(() => {
      if (card !== mine) return;
      removeCard();
      onGone?.();
    }, durationMs);
  }

  // ------------------------------------------------------------
  // The camera push (this client)
  // ------------------------------------------------------------
  // { home, ticker } while a banner has the camera.
  let push = null;

  function currentView() {
    return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
  }

  // Half the chat sidebar, in world units (as Camera Pan does).
  function visibleShift(scale) {
    try {
      const cam = globalThis.FUCompanion?.api?.camera;
      if (!cam?.viewportOf || !cam?.pivotShift) return { x: 0, y: 0 };
      return cam.pivotShift(cam.viewportOf().insets ?? null, scale || 1);
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  function findTokenByName(name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return null;
    return (canvas.tokens?.placeables ?? []).find(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    ) ?? null;
  }

  // The drawn sprite in map units: { x (centre), top, height }. The art can be
  // taller than the token's square (and anchored anywhere), so the mesh's
  // drawn bounds are read back into map units when there is one; the token's
  // own box otherwise (as Camera Pan's two-shot does).
  function spriteRect(token) {
    const x = token.center.x;
    try {
      const mesh = token.mesh;
      const wt = canvas.stage.worldTransform;
      const b = mesh && !mesh.destroyed ? mesh.getBounds() : null;
      if (b && b.height > 0 && wt?.d) return { x, top: (b.y - wt.ty) / wt.d, height: b.height / wt.d };
    } catch (_) { /* the token's box below */ }
    return { x, top: Number(token.y ?? 0), height: Number(token.h ?? 0) };
  }

  function applyView(v) {
    try { canvas.pan({ x: v.x, y: v.y, scale: v.scale }); } catch (_) {}
  }

  function stopTicker() {
    if (push?.ticker) {
      try { canvas.app.ticker.remove(push.ticker); } catch (_) {}
      push.ticker = null;
    }
  }

  function glide(from, to, durationMs, onDone) {
    stopTicker();
    if (!push) return;
    const startedAt = performance.now();
    if (durationMs <= 0 || document.visibilityState === "hidden") {
      applyView(to);
      onDone?.();
      return;
    }
    push.ticker = () => {
      try {
        if (!canvas?.ready || !push) return;
        const at = Logic.glideAt(from, to, startedAt, durationMs, performance.now(), "smooth");
        applyView(at);
        if (at.done) { stopTicker(); onDone?.(); }
      } catch (e) {
        // A throw here would stop PIXI's whole frame loop.
        console.warn(INSTALL_TAG, "A camera frame failed; dropping the push.", e);
        stopTicker();
      }
    };
    canvas.app.ticker.add(push.ticker);
  }

  // Back to where this client's camera was, then the follow carries on.
  function pullBack({ sceneGone = false, durationMs = RETURN_MS } = {}) {
    if (!push) return;
    const finish = () => {
      stopTicker();
      push = null;
      followRuntime()?.releaseCamera?.(HOLD_ID);
    };
    if (sceneGone || !canvas?.ready) return finish();
    glide(currentView(), push.home, durationMs, finish);
  }

  function pushIn(data) {
    if (!canvas?.ready || reducedMotion() || document.visibilityState === "hidden") return false;
    const token = findTokenByName(data.token);
    if (!token) {
      console.warn(INSTALL_TAG, "Boss Banner: token not found on this scene; the camera stays.", data.token);
      return false;
    }

    // A push still running (two banners in a row) goes home from its own start.
    const home = push?.home ?? currentView();
    if (!push) {
      push = { home, ticker: null };
      followRuntime()?.holdCamera?.(HOLD_ID);
    }

    const target = pushTarget(home, faceAim(spriteRect(token), data.faceFrac), data.zoomFactor, visibleShift(home.scale * (Number(data.zoomFactor) || DEFAULT_ZOOM)));
    glide(currentView(), target, Number(data.pushMs) || PUSH_MS, null);
    return true;
  }

  // ------------------------------------------------------------
  // On every client
  // ------------------------------------------------------------
  Client.register(KIND_BANNER, (data, info) => {
    if (typeof document === "undefined") return;
    const sourceId = info.sourceId;
    const camera = !!data.token;

    if (camera && info.presents) pushIn(data);
    // The GM keeps their camera; the chip says what the players' is doing.
    if (camera && !info.presents) Client.setMarker(sourceId, "banner", "camera push-in");

    let done = false;
    const finish = ({ sceneGone = false } = {}) => {
      if (done) return;
      done = true;
      Client.removeCleanup(sourceId, KIND_BANNER);
      removeCard();
      // Also a push left by a card this one replaced.
      if (push) pullBack({ sceneGone });
      if (!info.presents) {
        // Cleared once the players' camera is back.
        const clear = () => Client.setMarker(sourceId, "banner", null);
        sceneGone || !camera ? clear() : setTimeout(clear, RETURN_MS);
      }
    };

    // Ending the event mid-card: down at once, camera home.
    Client.addCleanup(sourceId, KIND_BANNER, finish);
    showCard(data, () => finish());
  });

  // The scene is going away: drop the card and the camera hold at once.
  Hooks.on("canvasTearDown", () => {
    removeCard();
    pullBack({ sceneGone: true });
  });

  // ------------------------------------------------------------
  // The action
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "bossBanner",
    label: "Boss Banner",
    category: "Screen",
    defaultData: {
      type: "bossBanner",
      kicker: "",
      name: "",
      color: DEFAULT_COLOR,
      seconds: DEFAULT_SECONDS,
      token: "",
      zoomFactor: DEFAULT_ZOOM,
      faceFrac: DEFAULT_FACE,
      wait: true
    },
    prepare,
    summary: (row) => {
      const title = [row?.kicker, row?.name].map(s => String(s ?? "").trim()).filter(Boolean).join(" / ") || "(no name)";
      return `${title}${String(row?.token ?? "").trim() ? ` · push in on ${row.token}` : ""}`.slice(0, 60);
    },
    execute: async (row, context) => {
      const name = String(row?.name ?? "").trim();
      const kicker = String(row?.kicker ?? "").trim();
      if (!name && !kicker) return { ok: true, type: "bossBanner", skipped: true };

      const t = timing(row);
      Client.run(context?.tileId, KIND_BANNER, {
        kicker,
        name,
        color: isColor(row?.color) ? row.color : DEFAULT_COLOR,
        bannerMs: t.bannerMs,
        token: t.camera ? String(row.token).trim() : "",
        zoomFactor: Math.min(4, Math.max(1, Logic.toNumber(row?.zoomFactor, DEFAULT_ZOOM))),
        faceFrac: clamp01(Logic.toNumber(row?.faceFrac, DEFAULT_FACE)),
        pushMs: t.pushMs
      });

      // Timed here, not by any one screen: a hidden or slow client cannot
      // hold the event up. Until the card is gone and the camera is back.
      if (row?.wait !== false) await flow()?.wait?.(context?.tileId, t.waitMs);

      return { ok: true, type: "bossBanner" };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Name",
          `<input type="text" class="oni-banner-name-input oni-grow" value="${kit.escapeHTML(row.name ?? "")}" placeholder="e.g. Asura (shown in capitals)" />`
        ),
        kit.field(
          "Title line",
          `<div class="oni-event-inline-row">
             <input type="text" class="oni-banner-kicker-input oni-grow" value="${kit.escapeHTML(row.kicker ?? "")}" placeholder="e.g. SEEKER OF STRENGTH" />
             <input type="color" class="oni-banner-color" value="${kit.escapeHTML(isColor(row.color) ? row.color : DEFAULT_COLOR)}" title="Colour of the title line" />
           </div>`,
          "The small line above the name, in its own colour."
        ),
        kit.field(
          "Duration (s)",
          kit.numberInput("oni-banner-seconds", Logic.toNumber(row.seconds, DEFAULT_SECONDS), { min: MIN_SECONDS, max: MAX_SECONDS, step: 0.1 }),
          "The card slides in over the first fifth and fades out over the last fifth."
        ),
        kit.field(
          "Push in on token",
          `<input type="text" class="oni-banner-token oni-grow" value="${kit.escapeHTML(row.token ?? "")}" placeholder="Token name (empty: the camera stays)" />`,
          `Optional. The camera moves in on that token's face while the card is up (${PUSH_MS / 1000} s),
           then goes back to where it was (${RETURN_MS / 1000} s) once the card is gone. The GM's camera is not moved.`
        ),
        `<div class="oni-banner-camera">${kit.field(
          "Zoom / face",
          `<div class="oni-event-inline-row">
             <span>×</span>${kit.numberInput("oni-banner-zoom", Logic.toNumber(row.zoomFactor, DEFAULT_ZOOM), { min: 1, max: 4, step: 0.05 })}
             <span>face at</span>${kit.numberInput("oni-banner-face", Logic.toNumber(row.faceFrac, DEFAULT_FACE), { min: 0, max: 1, step: 0.01 })}
           </div>`,
          "Zoom: times the current zoom. Face at: how far up the sprite to aim, from its feet (0) to the top of its head (1)."
        )}</div>`,
        kit.waitField(row, true, "On: the next event waits until the card is gone (and the camera is back). Off: it starts straight away.")
      );

      const tokenEl = body.querySelector(".oni-banner-token");
      const sync = () => { body.querySelector(".oni-banner-camera").hidden = !tokenEl.value.trim(); };
      tokenEl.addEventListener("input", sync);
      sync();

      return body;
    },
    collectFields: (rowEl, kit) => ({
      name: kit.readText(rowEl, ".oni-banner-name-input", "").trim(),
      kicker: kit.readText(rowEl, ".oni-banner-kicker-input", "").trim(),
      color: kit.readText(rowEl, ".oni-banner-color", DEFAULT_COLOR),
      seconds: Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, kit.readNumber(rowEl, ".oni-banner-seconds", DEFAULT_SECONDS))),
      token: kit.readText(rowEl, ".oni-banner-token", "").trim(),
      zoomFactor: Math.min(4, Math.max(1, kit.readNumber(rowEl, ".oni-banner-zoom", DEFAULT_ZOOM))),
      faceFrac: clamp01(kit.readNumber(rowEl, ".oni-banner-face", DEFAULT_FACE)),
      wait: kit.readWait(rowEl, true)
    })
  });

  window.oni.EventSystem.RowsBanner = {
    installed: true,
    // For tests and the console.
    bannerFrame,
    faceAim,
    pushTarget,
    timing,
    prepare,
    isPushing: () => !!push
  };

  console.debug(INSTALL_TAG, "Installed.");
})();
