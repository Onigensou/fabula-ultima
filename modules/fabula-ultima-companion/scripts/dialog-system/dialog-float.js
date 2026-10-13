// ============================================================================
// FabulaUltimaCompanion - Dialog System (Floating text)
// File: scripts/dialog-system/dialog-float.js
//
// A line of text with no box, no portrait and no speaker: white lettering
// straight on the screen. For a narrator, a voice in the head, a voice from
// a thing on the map.
//
// It is the same line as a speech bubble underneath: typed by the shared
// typewriter in dialog-ui.js (runLine), so it types at the same pace, plays
// the same blip, and takes "complete" and "close" the same way. Only where
// the text is drawn differs, and what happens when the line closes: a
// floating line STAYS on screen when it closes, so the next line can join it.
//
// Where lines go ("anchors"):
//   screen   one of nine places on the screen (top / middle / bottom by
//            left / centre / right). The text holds its place whatever the
//            camera does. Lines on one anchor stack: downward from a top
//            anchor, upward from a bottom one (newest at the bottom, like
//            subtitles), evenly both ways from the middle.
//   map      beside a token, a tile or a point of the map. The text rides
//            the map, and picks the side of its target that has more room.
//
// Lines on different anchors can be on screen together. A stack that is full
// fades and starts again. Everything fades together on FU.DialogUI
// .clearFloating(), when an event ends, and when the scene changes.
//
// All of it stays inside the part of the window the player can see (not
// under the chat sidebar, the scene controls or the hotbar).
//
// API (added to FU.DialogUI):
//   renderFloat(payload, { remote })   called by dialog-ui.js for mode "float"
//   clearFloating({ broadcast, sceneId, fadeMs })
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TYPE_FLOAT_CLEAR = "FU_DIALOG_FLOAT_CLEAR_V1";

  const STYLE_ID = "fu-dialog-float-style";
  const LAYER_ID = "fu-dialog-float-layer";

  // Kept clear of Foundry's own interface: scene navigation (top), scene
  // controls (left), hotbar and player list (bottom). The chat sidebar on the
  // right is measured, as it can be resized or collapsed.
  const MARGIN = { top: 84, left: 132, bottom: 128, right: 28 };

  // A stack starts again when the next line would take it past this.
  const MAX_LINES_PER_STACK = 5;
  const MAX_STACK_HEIGHT_FRACTION = 0.6;

  const MAX_LINE_WIDTH_PX = 780;
  const MAX_LINE_WIDTH_FRACTION = 0.7;

  const FADE_IN_MS = 260;
  const FADE_OUT_MS = 380;

  // How far from its target a map-anchored line sits.
  const MAP_GAP_PX = 28;

  const SCREEN_ANCHORS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];
  const DEFAULT_ANCHOR = "tc";

  // key -> { el, key, kind, anchor, target, nudge, ticker }
  const stacks = new Map();

  const dialogUI = () => globalThis.FU?.DialogUI;

  function ensureLayerAndStyles() {
    if (!document.getElementById(STYLE_ID)) {
      const css = document.createElement("style");
      css.id = STYLE_ID;
      // Above the map, tokens and screen effects (a dim), below the overhead
      // event buttons and the speech bubbles.
      css.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 60; overflow: hidden;
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; }

.fu-float-stack { position: absolute; display: flex; flex-direction: column; gap: 14px; }
.fu-float-stack.align-left   { align-items: flex-start; text-align: left; }
.fu-float-stack.align-center { align-items: center;     text-align: center; }
.fu-float-stack.align-right  { align-items: flex-end;   text-align: right; }

.fu-float-line { position: relative; pointer-events: auto; cursor: default;
  font-size: 30px; font-weight: 400; line-height: 1.35; letter-spacing: .05em; word-spacing: .22em;
  color: #ffffff; white-space: pre-wrap; overflow-wrap: anywhere;
  /* A dark outline and a soft drop, so the text reads on any map, dimmed or not. */
  text-shadow:
    -2px -2px 0 #111, 2px -2px 0 #111, -2px 2px 0 #111, 2px 2px 0 #111,
    0 -2px 0 #111, 0 2px 0 #111, -2px 0 0 #111, 2px 0 0 #111,
    0 3px 6px rgba(0,0,0,.75);
  opacity: 0; transition: opacity ${FADE_IN_MS}ms ease-out; }
.fu-float-line.is-in  { opacity: 1; }
.fu-float-line.is-settled { pointer-events: none; }
.fu-float-line.is-out { opacity: 0; transition: opacity ${FADE_OUT_MS}ms ease-in; }

/* A hint in floating text is light, to read on a dark screen. */
.fu-float-line .fu-hint { font-weight: 700; color: #ffd76a; }

.fu-float-next { display: inline-block; margin-left: .5em; font-size: .5em; vertical-align: middle; opacity: 0; }
.fu-float-line.fu-awaiting .fu-float-next { animation: fu-float-next-bob 900ms ease-in-out infinite; }
@keyframes fu-float-next-bob {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(3px); }
}
      `;
      document.head.appendChild(css);
    }

    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = LAYER_ID;
      document.body.appendChild(layer);
    }
    return layer;
  }

  // The part of the window a line may be drawn in.
  function visibleRegion() {
    let insets = { top: 0, right: 0, bottom: 0, left: 0 };
    try {
      insets = globalThis.FUCompanion?.api?.camera?.viewportOf?.()?.insets ?? insets;
    } catch (_) {}

    const left = MARGIN.left + (insets.left || 0);
    const top = MARGIN.top + (insets.top || 0);
    const right = window.innerWidth - MARGIN.right - (insets.right || 0);
    const bottom = window.innerHeight - MARGIN.bottom - (insets.bottom || 0);

    return {
      left, top, right, bottom,
      width: Math.max(200, right - left),
      height: Math.max(120, bottom - top)
    };
  }

  function worldToScreen(x, y) {
    const wt = canvas?.app?.stage?.worldTransform;
    if (!wt) return { x, y };
    return { x: (x * wt.a) + wt.tx, y: (y * wt.d) + wt.ty };
  }

  // The map point a line is attached to, and how much room to leave around it.
  function targetPoint(target) {
    if (!target || !canvas?.ready) return null;

    if (target.kind === "token") {
      const token = canvas.tokens?.get(target.id);
      // token.center follows the drawn token while it walks.
      return token ? { x: token.center.x, y: token.center.y, half: (token.w ?? 100) / 2 } : null;
    }
    if (target.kind === "tile") {
      const tile = canvas.scene?.tiles?.get(target.id);
      return tile ? { x: tile.x + (tile.width / 2), y: tile.y + (tile.height / 2), half: tile.width / 2 } : null;
    }
    if (target.kind === "point") return { x: Number(target.x) || 0, y: Number(target.y) || 0, half: 0 };
    return null;
  }

  // ------------------------------------------------------------
  // Placing a stack
  // ------------------------------------------------------------
  function placeScreenStack(stack) {
    const region = visibleRegion();
    const [row, col] = stack.anchor;   // "t" | "m" | "b",  "l" | "c" | "r"
    const el = stack.el;
    const nudgeX = Number(stack.nudge?.x) || 0;
    const nudgeY = Number(stack.nudge?.y) || 0;

    el.style.maxWidth = `${Math.min(MAX_LINE_WIDTH_PX, region.width * MAX_LINE_WIDTH_FRACTION)}px`;
    el.classList.toggle("align-left", col === "l");
    el.classList.toggle("align-center", col === "c");
    el.classList.toggle("align-right", col === "r");

    // Horizontal: the edge, or the centre, of the visible region.
    const x = col === "l" ? region.left : col === "r" ? region.right : region.left + (region.width / 2);
    const tx = col === "l" ? "0" : col === "r" ? "-100%" : "-50%";

    // Vertical: a top anchor hangs down from the upper third, a bottom anchor
    // stands on the lower edge, the middle is centred.
    const y = row === "t" ? region.top + (region.height * 0.12)
      : row === "b" ? region.bottom - (region.height * 0.06)
      : region.top + (region.height / 2);
    const ty = row === "t" ? "0" : row === "b" ? "-100%" : "-50%";

    el.style.left = `${x + nudgeX}px`;
    el.style.top = `${y + nudgeY}px`;
    el.style.transform = `translate(${tx}, ${ty})`;
  }

  function placeMapStack(stack) {
    const point = targetPoint(stack.target);
    if (!point) return;

    const region = visibleRegion();
    const el = stack.el;
    const scale = canvas?.stage?.scale?.x ?? 1;
    const at = worldToScreen(point.x, point.y);
    const reach = (point.half * scale) + MAP_GAP_PX;

    el.style.maxWidth = `${Math.min(MAX_LINE_WIDTH_PX * 0.7, region.width * 0.45)}px`;
    const rect = el.getBoundingClientRect();

    // The side with more room, so the text does not cover what it belongs to.
    const roomRight = region.right - (at.x + reach);
    const roomLeft = (at.x - reach) - region.left;
    const onRight = roomRight >= rect.width || roomRight >= roomLeft;

    el.classList.toggle("align-left", onRight);
    el.classList.toggle("align-right", !onRight);
    el.classList.remove("align-center");

    let left = onRight ? at.x + reach : at.x - reach - rect.width;
    let top = at.y - (rect.height / 2);

    // Kept on screen even when its target is at the edge, or off it.
    left = Math.max(region.left, Math.min(left, region.right - rect.width));
    top = Math.max(region.top, Math.min(top, region.bottom - rect.height));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transform = "none";
  }

  function place(stack) {
    if (!stack.el.isConnected) return;
    if (stack.kind === "map") placeMapStack(stack);
    else placeScreenStack(stack);
  }

  // ------------------------------------------------------------
  // Stacks
  // ------------------------------------------------------------
  function stackKey(payload) {
    const target = payload.float?.target;
    if (target?.kind === "token" || target?.kind === "tile") return `map:${target.kind}:${target.id}`;
    if (target?.kind === "point") return `map:point:${Math.round(target.x)},${Math.round(target.y)}`;

    const anchor = SCREEN_ANCHORS.includes(payload.float?.anchor) ? payload.float.anchor : DEFAULT_ANCHOR;
    const nudge = payload.float?.nudge;
    // A nudged line is its own place: two lines nudged apart do not stack.
    return `screen:${anchor}:${Math.round(Number(nudge?.x) || 0)},${Math.round(Number(nudge?.y) || 0)}`;
  }

  function getStack(payload) {
    const key = stackKey(payload);
    let stack = stacks.get(key);
    if (stack) return stack;

    const el = document.createElement("div");
    el.className = "fu-float-stack";
    ensureLayerAndStyles().appendChild(el);

    const target = payload.float?.target ?? null;
    const isMap = !!target && !!targetPoint(target);

    stack = {
      key,
      el,
      kind: isMap ? "map" : "screen",
      anchor: SCREEN_ANCHORS.includes(payload.float?.anchor) ? payload.float.anchor : DEFAULT_ANCHOR,
      target: isMap ? target : null,
      nudge: payload.float?.nudge ?? null,
      ticker: null
    };

    // A map stack follows its target and the camera; a screen stack only
    // moves when the window or the sidebar changes size.
    stack.ticker = () => place(stack);
    try { canvas.app.ticker.add(stack.ticker, undefined, PIXI.UPDATE_PRIORITY.LOW); } catch (_) {}

    stacks.set(key, stack);
    return stack;
  }

  function dropStack(stack, fadeMs = FADE_OUT_MS) {
    if (stacks.get(stack.key) === stack) stacks.delete(stack.key);
    for (const line of stack.el.querySelectorAll(".fu-float-line")) {
      line.classList.remove("is-in");
      line.classList.add("is-out");
    }

    const remove = () => {
      try { canvas.app.ticker.remove(stack.ticker); } catch (_) {}
      stack.el.remove();
      const layer = document.getElementById(LAYER_ID);
      if (layer && !layer.children.length) layer.remove();
    };
    if (fadeMs <= 0 || document.visibilityState === "hidden") remove();
    else setTimeout(remove, fadeMs + 40);
  }

  // Would one more line take this stack past what fits?
  function isFull(stack) {
    const lines = stack.el.querySelectorAll(".fu-float-line").length;
    if (lines >= MAX_LINES_PER_STACK) return true;
    if (!lines) return false;
    const limit = visibleRegion().height * MAX_STACK_HEIGHT_FRACTION;
    // Room for one more line of about the same height as the last.
    const last = stack.el.lastElementChild?.getBoundingClientRect?.().height ?? 40;
    return (stack.el.getBoundingClientRect().height + last) > limit;
  }

  // Fade everything that is floating on this client.
  function clearLocal(fadeMs = FADE_OUT_MS) {
    for (const stack of [...stacks.values()]) dropStack(stack, fadeMs);
  }

  // ------------------------------------------------------------
  // One line
  // ------------------------------------------------------------
  async function renderFloat(payload, { remote = false } = {}) {
    const ui = dialogUI();
    if (!ui?.runLine) return null;
    ensureLayerAndStyles();

    // A fresh start: whatever was on screen goes first.
    if (payload.float?.startFresh) clearLocal(FADE_OUT_MS);

    let stack = getStack(payload);
    if (isFull(stack)) {
      dropStack(stack, FADE_OUT_MS);
      stack = getStack(payload);
    }

    const id = payload.bubbleId || `fu-float-${ui.randomID(8)}`;
    const line = document.createElement("div");
    line.className = "fu-float-line";
    line.id = id;
    line.innerHTML = `<span class="fu-typed"></span><span class="fu-float-next">&#9660;</span>`;
    stack.el.appendChild(line);
    place(stack);

    // Two frames so the starting (transparent) state is painted before the fade.
    requestAnimationFrame(() => requestAnimationFrame(() => line.classList.add("is-in")));
    // A hidden window draws no frames: show the line without the fade.
    if (document.visibilityState === "hidden") line.classList.add("is-in");

    let run = null;
    run = ui.runLine({
      box: line,
      typed: line.querySelector(".fu-typed"),
      payload,
      remote,
      id,
      // A floating line stays where it is when it closes. It is taken off the
      // list of showing lines, so the next press goes to the next line, and it
      // stops taking clicks. (Deferred: a "close" that was waiting for this
      // line runs before runLine has returned.)
      leave: () => {
        line.classList.add("is-settled");
        queueMicrotask(() => run?.dispose());
      }
    });

    // Wrapped: a bare promise would be awaited by the caller, which needs to
    // go on (and learn the line id) while the line is still typing.
    return { finished: run.finished };
  }

  // Fade every floating line, here and (by default) on every other client.
  function clearFloating({ broadcast = true, sceneId = canvas?.scene?.id ?? null, fadeMs = FADE_OUT_MS } = {}) {
    clearLocal(fadeMs);

    if (broadcast) {
      try {
        game.socket.emit(SOCKET_CHANNEL, { type: MSG_TYPE_FLOAT_CLEAR, payload: { sceneId, fadeMs } });
      } catch (e) {
        console.warn("[FU Dialog:Float] clear broadcast failed", e);
      }
    }
  }

  globalThis.FU = globalThis.FU ?? {};
  globalThis.FU.DialogUI = globalThis.FU.DialogUI ?? {};
  Object.assign(globalThis.FU.DialogUI, {
    MSG_TYPE_FLOAT_CLEAR,
    FLOAT_FADE_OUT_MS: FADE_OUT_MS,
    FLOAT_SCREEN_ANCHORS: SCREEN_ANCHORS,
    renderFloat,
    clearFloating,
    isFloating: () => stacks.size > 0
  });

  // Text must not outlive what it belonged to.
  Hooks.on("oniEventExecuteDone", () => clearLocal(FADE_OUT_MS));
  Hooks.on("canvasTearDown", () => clearLocal(0));
  window.addEventListener("resize", () => { for (const stack of stacks.values()) place(stack); });

  Hooks.once("ready", () => {
    try {
      game.socket.on(SOCKET_CHANNEL, (data) => {
        if (data?.type !== MSG_TYPE_FLOAT_CLEAR) return;
        const sceneId = data.payload?.sceneId ?? null;
        if (sceneId && canvas?.scene?.id !== sceneId) return;
        clearLocal(Number(data.payload?.fadeMs) >= 0 ? Number(data.payload.fadeMs) : FADE_OUT_MS);
      });
    } catch (e) {
      console.error("[FU Dialog:Float] failed to install the socket listener", e);
    }
  });

  console.debug("%c[FU Dialog:Float][BOOT] dialog-float.js loaded", "color:#7dd3fc");
})();
