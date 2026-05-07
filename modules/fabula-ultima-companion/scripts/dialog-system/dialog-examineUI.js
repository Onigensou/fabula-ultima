/**
 * ONI Examine + Dialog UI (Module) — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * GOAL (your requested behavior):
 * 1) When DB_Actor token ENTER the MAT tile:
 *      -> ALL clients (GM + players) show the "!" icon above that token.
 * 2) If ANY client clicks the icon:
 *      -> Show the dialog bubble for EVERY client (mirrored).
 * 3) When EXIT:
 *      -> Remove the icon for EVERY client.
 *
 * IMPORTANT NOTE ABOUT SOCKET ECHO:
 * - In some Foundry setups, a client might NOT receive its own socket message echo.
 * - So this module:
 *     (A) LISTENS for socket messages (to affect other clients)
 *     (B) EXPOSES a local handler you can call directly on the same client after emit
 *         globalThis.ONI_EXAMINE_UI.handleMessage({ type, payload })
 *
 * Channel:
 * - module.fabula-ultima-companion
 *
 * Messages:
 * - "ONI_EXAMINE_ICON_V1"
 *     payload: { sceneId, tokenId, tileId, mode:"enter"|"exit", speakerName, text, bubbleMode, speed, iconOffsetY, iconAnchor }
 *
 * - "ONI_EXAMINE_DIALOG_V1"
 *     payload: { sceneId, tokenId, tileId, speakerName, text, bubbleMode, speed }
 */

Hooks.once("ready", () => {
  (async () => {
    // =========================================================================
    // TOP CONFIG (EDIT ME)
    // =========================================================================
    const DEBUG = true;

    const CHANNEL = "module.fabula-ultima-companion";

    // If true: clicking the icon will temporarily hide the icon on all clients while the bubble is up
    const HIDE_ICON_WHILE_TALKING = true;

    // =========================================================================
    // CONSTANTS
    // =========================================================================
    const MSG_ICON   = "ONI_EXAMINE_ICON_V1";
    const MSG_DIALOG = "ONI_EXAMINE_DIALOG_V1";
    const MSG_PING   = "ONI_EXAMINE_UI_PING_V1";

    const TAG = "[ONI][ExamineUI]";
    const log  = (...a) => DEBUG && console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);
    const err  = (...a) => console.error(TAG, ...a);

    // =========================================================================
    // STORE
    // =========================================================================
    const STORE_KEY = "__ONI_EXAMINE_UI_STORE__";
    const store = (globalThis[STORE_KEY] ??= {
      installed: false,
      handler: null,

      // icon handles per token+tile
      byToken: {},

      // current bubble per token+tile (so we can close/restore icon)
      bubbleByToken: {},
    });

    // =========================================================================
    // HELPERS
    // =========================================================================
    function htmlEscape(v) {
      const d = document.createElement("div");
      d.textContent = (v ?? "").toString();
      return d.innerHTML;
    }

    function isMyScene(sceneId) {
      const mySceneId = canvas?.scene?.id;
      return !!mySceneId && String(mySceneId) === String(sceneId);
    }

    function getCanvasToken(tokenId) {
      return canvas?.tokens?.get?.(tokenId) ??
        canvas?.tokens?.placeables?.find?.(t => t?.document?.id === tokenId || t?.id === tokenId) ??
        null;
    }

    function ensureSlot(tokenId, tileId) {
      store.byToken[tokenId] ??= {};
      store.bubbleByToken[tokenId] ??= {};
      store.byToken[tokenId][tileId] ??= { handle: null };
      store.bubbleByToken[tokenId][tileId] ??= { bubble: null };
      return {
        iconSlot: store.byToken[tokenId][tileId],
        bubbleSlot: store.bubbleByToken[tokenId][tileId],
      };
    }

    // =========================================================================
    // UI STYLES — (copied from your FIRST VERSION script style)
    // =========================================================================
    const BTN_STYLE_ID = "oni-examine-style-run-code";
    const BTN_LAYER_ID = "oni-examine-layer-run-code";

    const STYLE_ID = "fft-speech-style-v35";
    const LAYER_ID = "fft-speech-layer";

    function ensureIconCSSAndLayer() {
      if (!document.getElementById(BTN_STYLE_ID)) {
        const css = document.createElement("style");
        css.id = BTN_STYLE_ID;
        css.textContent = `
#${BTN_LAYER_ID}{ position: fixed; inset: 0; pointer-events: none; z-index: 100001; }
.oni-examine-btn{
  position: absolute; pointer-events: auto;
  width: 34px; height: 34px; display: grid; place-items: center;
  background: rgba(255,255,255,0.95);
  border: 2px solid rgba(0,0,0,0.75);
  border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35);
  cursor: pointer; user-select: none;
  transform-origin: 50% 100%;
}
.oni-examine-btn .mark{
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight: 900; font-size: 20px; line-height: 1;
  color: rgba(20,16,10,0.95);
  transform: translateY(-1px);
}
.oni-examine-enter{ animation: oni-examine-in .16s ease-out both; }
@keyframes oni-examine-in{ from{ transform: scale(0.75); opacity: 0; } to{ transform: scale(1.00); opacity: 1; } }
.oni-examine-exit{ animation: oni-examine-out .14s ease-in both; }
@keyframes oni-examine-out{ from{ transform: scale(1.00); opacity: 1; } to{ transform: scale(0.78); opacity: 0; } }
.oni-examine-hidden{ opacity: 0 !important; transform: scale(0.92) !important; pointer-events: none !important; }
        `;
        document.head.appendChild(css);
        log("Icon CSS injected", BTN_STYLE_ID);
      }

      let layer = document.getElementById(BTN_LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = BTN_LAYER_ID;
        document.body.appendChild(layer);
        log("Icon layer created", BTN_LAYER_ID);
      }
      return layer;
    }

    // =========================================================================
    // DIALOG BUBBLE — (copied behavior from your first version: portrait + typing sound)
    // =========================================================================
    async function fftSpeak({ tokenObj, name, text, speed = 28, mode = "normal", onClose = null }) {
      // ---- Original constants
      const DEFAULT_CPS = 28;
      const HOLD_AFTER_TYPING_MS = 1600;
      const OFFSET_Y = 28;
      const BUBBLE_ANCHOR = 0.62;
      const MAX_BUBBLE_WIDTH = 420;
      const MIN_BUBBLE_WIDTH = 420;
      const PORTRAIT_SIZE = 128;
      const PORTRAIT_PULL = -8;

      const CURSOR_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Cursor1.ogg";
      const SOUND_VOLUME = 0.55;
      const BEEP_GAP_MS  = 55;
      const SKIP_WHITESPACE = true;

      let cps = Math.max(1, Number(speed) || DEFAULT_CPS);

      async function playOneShot(url, volume=1.0) {
        try {
          if (window.AudioHelper?.play) {
            await AudioHelper.play({ src: url, volume, autoplay: true, loop: false }, true);
            return;
          }
        } catch (_) {}
        try {
          const a = new Audio(url);
          a.volume = volume;
          a.addEventListener("ended", ()=>a.remove());
          await a.play().catch(()=>{});
        } catch (_) {}
      }

      const portraitSrc =
        tokenObj.actor?.img ||
        tokenObj.document?.texture?.src ||
        tokenObj.document?.texture?.img ||
        tokenObj.texture?.src ||
        "icons/svg/mystery-man.svg";

      // ---- Original CSS
      if (!document.getElementById(STYLE_ID)) {
        const css = document.createElement("style");
        css.id = STYLE_ID;
        css.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif; }
.fft-bubble { position: absolute; pointer-events: auto; display: flex; align-items: stretch;
  max-width: min(${MAX_BUBBLE_WIDTH}px, 92vw); min-width: ${MIN_BUBBLE_WIDTH}px; }
.fft-enter { animation: fft-grow .18s ease-out both; }
.fft-exit  { animation: fft-shrink .15s ease-in both; }
@keyframes fft-grow   { from { transform: scale(.72); opacity: 0 } to { transform: scale(1); opacity: 1 } }
@keyframes fft-shrink { from { transform: scale(1);   opacity: 1 } to { transform: scale(.72); opacity: 0 } }
.fft-left { border-radius: 18px 0 0 18px; padding: 6px; margin-right: ${PORTRAIT_PULL}px;
  display: flex; align-items: center; justify-content: center; }
.fft-left img { width: ${PORTRAIT_SIZE}px; height: ${PORTRAIT_SIZE}px; object-fit: contain; border-radius: 14px; }
.fft-paper { position: relative; flex: 1; background: #e8e0cf; color: #2b261f;
  border-radius: 0 18px 18px 18px; overflow: hidden; box-shadow: 0 6px 10px rgba(0,0,0,.45); }
.fft-paper::before {
  content:""; position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(1200px 600px at 0% 0%, rgba(255,255,255,.35), transparent 70%),
    radial-gradient(800px 400px at 100% 0%, rgba(255,255,255,.25), transparent 70%),
    radial-gradient(1000px 800px at 50% 120%, rgba(0,0,0,.06), transparent 60%);
  mix-blend-mode: multiply; opacity:.6;
}
.fft-name { font-weight:700; font-size:1.05rem; margin:12px 16px 6px; }
.fft-text { font-size:1.05rem; line-height:1.5; margin:0 16px 14px; white-space: pre-wrap; min-height:2.7em; }
.fft-tail { position:absolute; bottom:-16px; left:44px; width:0; height:0;
  border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf; }
        `;
        document.head.appendChild(css);
        log("Dialog CSS injected", STYLE_ID);
      }

      let layer = document.getElementById(LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = LAYER_ID;
        document.body.appendChild(layer);
        log("Dialog layer created", LAYER_ID);
      }

      // ---- Build bubble DOM
      const box = document.createElement("div");
      box.className = "fft-bubble fft-enter";
      box.innerHTML = `
<div class="fft-left"><img alt="portrait" src="${htmlEscape(portraitSrc)}"/></div>
<div class="fft-paper">
  <div class="fft-name">${htmlEscape(name)}</div>
  <div class="fft-text"><span class="fft-typed"></span></div>
  <div class="fft-tail"></div>
</div>
      `;
      layer.appendChild(box);

      // ---- Placement (original)
      function getScreenXY() {
        const gp = tokenObj.mesh.getGlobalPosition();
        const h  = tokenObj.mesh.height ?? (tokenObj.w ?? 100);
        return { x: gp.x, y: gp.y - h * BUBBLE_ANCHOR - OFFSET_Y };
      }
      function place() {
        if (!box.isConnected) return;
        const { x, y } = getScreenXY();
        const rect = box.getBoundingClientRect();
        box.style.left = `${x - Math.min(160, rect.width * 0.25)}px`;
        box.style.top  = `${y - rect.height}px`;
      }

      const onPan = () => place();
      const onResize = () => place();
      const onMove = () => place();
      Hooks.on("canvasPan", onPan);
      window.addEventListener("resize", onResize);
      Hooks.on("updateToken", onMove);
      Hooks.on("controlToken", onMove);
      canvas.app.ticker.add(place, undefined, PIXI.UPDATE_PRIORITY.LOW);
      place();

      // ---- Typewriter
      const typed = box.querySelector(".fft-typed");
      const full  = String(text ?? "");
      const STEP  = Math.max(1, Math.round(60 / cps));
      let i = 0, f = 0, done = false, fastForward = false;
      let autoTimer = null;
      let lastBeep = 0;

      function blipMaybe(char) {
        if (SKIP_WHITESPACE && /^\s$/.test(char)) return;
        const now = performance.now();
        if (now - lastBeep < BEEP_GAP_MS) return;
        lastBeep = now;
        playOneShot(CURSOR_URL, SOUND_VOLUME);
      }

      function scheduleAutoClose() {
        const typeMs = Math.ceil((full.length / cps) * 1000);
        const totalMs = Math.max(1200, typeMs + HOLD_AFTER_TYPING_MS);
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => closeBubble(), totalMs);
      }

      function typeTick() {
        if (!box.isConnected) return;
        if (fastForward) { typed.textContent = full; done = true; scheduleAutoClose(); return; }
        f++;
        if (f >= STEP) {
          f = 0;
          const nextI = Math.min(full.length, i + 1);
          const ch = full.slice(i, nextI);
          i = nextI;
          typed.textContent = full.slice(0, i);
          blipMaybe(ch);
          if (i >= full.length) { done = true; scheduleAutoClose(); return; }
        }
        requestAnimationFrame(typeTick);
      }
      requestAnimationFrame(typeTick);

      function cleanup() {
        try {
          if (autoTimer) clearTimeout(autoTimer);
          Hooks.off("canvasPan", onPan); window.removeEventListener("resize", onResize);
          Hooks.off("updateToken", onMove); Hooks.off("controlToken", onMove);
          canvas.app.ticker.remove(place);
          box.remove();
          const lyr = document.getElementById(LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}
        try { onClose?.(); } catch (_) {}
      }

      function closeBubble() {
        if (!done) { fastForward = true; typed.textContent = full; done = true; }
        box.classList.remove("fft-enter"); box.classList.add("fft-exit");
        box.addEventListener("animationend", cleanup, { once: true });
        setTimeout(cleanup, 250);
      }

      box.addEventListener("click", () => (!done ? (fastForward = true) : closeBubble()));
      return { close: closeBubble };
    }

    // =========================================================================
    // ICON CREATE / REMOVE
    // =========================================================================
    async function createIcon({ sceneId, tokenId, tileId, iconOffsetY = 10, iconAnchor = 1.05, dialogPayload }) {
      if (!isMyScene(sceneId)) return;

      const tokenObj = getCanvasToken(tokenId);
      if (!tokenObj) { warn("createIcon: token not found on this client", { tokenId }); return; }

      const { iconSlot, bubbleSlot } = ensureSlot(tokenId, tileId);
      if (iconSlot.handle?.btn?.isConnected) {
        log("createIcon: already exists -> skip", { tokenId, tileId });
        return;
      }

      const iconLayer = ensureIconCSSAndLayer();

      const btn = document.createElement("div");
      btn.className = "oni-examine-btn oni-examine-enter";
      btn.title = "Examine";
      btn.innerHTML = `<div class="mark">!</div>`;
      iconLayer.appendChild(btn);

      const hideIcon = () => btn.isConnected && btn.classList.add("oni-examine-hidden");
      const showIcon = () => btn.isConnected && btn.classList.remove("oni-examine-hidden");

      function getScreenXY() {
        const gp = tokenObj.mesh.getGlobalPosition();
        const h = tokenObj.mesh.height ?? (tokenObj.w ?? 100);
        return { x: gp.x, y: gp.y - h * Number(iconAnchor) - Number(iconOffsetY) };
      }

      function placeBtn() {
        if (!btn.isConnected) return;
        const { x, y } = getScreenXY();
        const rect = btn.getBoundingClientRect();
        btn.style.left = `${x - rect.width / 2}px`;
        btn.style.top  = `${y - rect.height}px`;
      }

      const onPan = () => placeBtn();
      const onResize = () => placeBtn();
      const onMove = () => placeBtn();
      Hooks.on("canvasPan", onPan);
      window.addEventListener("resize", onResize);
      Hooks.on("updateToken", onMove);
      Hooks.on("controlToken", onMove);
      canvas.app.ticker.add(placeBtn, undefined, PIXI.UPDATE_PRIORITY.LOW);
      placeBtn();

      // CLICK: broadcast dialog to everyone
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        log("ICON CLICK (local)", { tokenId, tileId, user: game.user.name });

        if (HIDE_ICON_WHILE_TALKING) hideIcon();

        const payload = {
          sceneId,
          tokenId,
          tileId,
          speakerName: dialogPayload?.speakerName ?? tokenObj.document?.name ?? tokenObj.name ?? "Speaker",
          text: dialogPayload?.text ?? "…",
          bubbleMode: dialogPayload?.bubbleMode ?? "normal",
          speed: dialogPayload?.speed ?? 28,
        };

        // Emit to other clients...
        try {
          game.socket.emit(CHANNEL, { type: MSG_DIALOG, payload });
          log("ICON CLICK emit -> MSG_DIALOG", payload);
        } catch (e) {
          err("ICON CLICK emit failed", e);
        }

        // ...and ALSO handle locally (in case socket doesn't echo to sender)
        await handleMessage({ type: MSG_DIALOG, payload }, { localCall: true });
      });

      async function cleanup(animateOut = true) {
        // close bubble if still open
        try { bubbleSlot.bubble?.close?.(); } catch (_) {}
        bubbleSlot.bubble = null;

        try {
          Hooks.off("canvasPan", onPan);
          window.removeEventListener("resize", onResize);
          Hooks.off("updateToken", onMove);
          Hooks.off("controlToken", onMove);
          canvas.app.ticker.remove(placeBtn);
        } catch (_) {}

        if (!btn.isConnected) return;

        if (!animateOut) {
          try { btn.remove(); } catch (_) {}
          return;
        }

        btn.classList.remove("oni-examine-enter");
        btn.classList.add("oni-examine-exit");
        await new Promise(r => setTimeout(r, 180));
        try { btn.remove(); } catch (_) {}

        try {
          const lyr = document.getElementById(BTN_LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}
      }

      iconSlot.handle = { btn, cleanup, showIcon, hideIcon };
      log("Icon created", { tokenId, tileId });
    }

    async function removeIcon({ sceneId, tokenId, tileId }) {
      if (!isMyScene(sceneId)) return;
      const { iconSlot, bubbleSlot } = ensureSlot(tokenId, tileId);

      // close bubble if open
      try { bubbleSlot.bubble?.close?.(); } catch (_) {}
      bubbleSlot.bubble = null;

      if (!iconSlot.handle) {
        log("removeIcon: no handle", { tokenId, tileId });
        return;
      }
      await iconSlot.handle.cleanup(true);
      iconSlot.handle = null;
      log("Icon removed", { tokenId, tileId });
    }

    // =========================================================================
    // SHOW DIALOG FOR EVERYONE
    // =========================================================================
    async function showDialogForEveryone(payload) {
      if (!isMyScene(payload.sceneId)) return;

      const tokenObj = getCanvasToken(payload.tokenId);
      if (!tokenObj) { warn("showDialog: token not found on this client", { tokenId: payload.tokenId }); return; }

      const { iconSlot, bubbleSlot } = ensureSlot(payload.tokenId, payload.tileId);

      // hide icon while talking
      if (HIDE_ICON_WHILE_TALKING && iconSlot.handle?.hideIcon) iconSlot.handle.hideIcon();

      // close any previous
      try { bubbleSlot.bubble?.close?.(); } catch (_) {}
      bubbleSlot.bubble = null;

      const name = payload.speakerName ?? tokenObj.document?.name ?? tokenObj.name ?? "Speaker";
      const text = payload.text ?? "…";
      const speed = payload.speed ?? 28;
      const mode = payload.bubbleMode ?? "normal";

      log("showDialogForEveryone START", { tokenId: payload.tokenId, tileId: payload.tileId, name, mode, speed });

      bubbleSlot.bubble = await fftSpeak({
        tokenObj,
        name,
        text,
        speed,
        mode,
        onClose: () => {
          bubbleSlot.bubble = null;
          if (HIDE_ICON_WHILE_TALKING && iconSlot.handle?.showIcon) iconSlot.handle.showIcon();
        }
      });
    }

    // =========================================================================
    // MAIN MESSAGE HANDLER (socket + local)
    // =========================================================================
    async function handleMessage(data, { localCall = false } = {}) {
      try {
        if (!data || typeof data !== "object") return;
        const { type, payload } = data;

        log(localCall ? "LOCAL handleMessage" : "SOCKET RECEIVE", { type, payload });

        if (type === MSG_PING) {
          log("PING received", payload);
          return;
        }

        if (!canvas?.ready) {
          // wait briefly for canvas
          const start = Date.now();
          while (!canvas?.ready && (Date.now() - start) < 4000) {
            await new Promise(r => setTimeout(r, 50));
          }
        }

        if (type === MSG_ICON) {
          if (!payload) return;
          if (!isMyScene(payload.sceneId)) return;

          const mode = String(payload.mode ?? "").toLowerCase();
          const dialogPayload = {
            speakerName: payload.speakerName,
            text: payload.text,
            bubbleMode: payload.bubbleMode ?? "normal",
            speed: payload.speed ?? 28,
          };

          if (mode === "enter") {
            await createIcon({
              sceneId: payload.sceneId,
              tokenId: payload.tokenId,
              tileId: payload.tileId,
              iconOffsetY: payload.iconOffsetY ?? 10,
              iconAnchor: payload.iconAnchor ?? 1.05,
              dialogPayload
            });
            return;
          }

          if (mode === "exit") {
            await removeIcon({ sceneId: payload.sceneId, tokenId: payload.tokenId, tileId: payload.tileId });
            return;
          }

          warn("MSG_ICON unknown mode", payload);
          return;
        }

        if (type === MSG_DIALOG) {
          if (!payload) return;
          if (!isMyScene(payload.sceneId)) return;
          await showDialogForEveryone(payload);
          return;
        }
      } catch (e) {
        err("handleMessage ERROR", e);
      }
    }

    // =========================================================================
    // SOCKET LISTENER INSTALL
    // =========================================================================
    function installSocketListener() {
      log("installSocketListener begin", {
        alreadyInstalled: store.installed,
        user: { id: game.user.id, name: game.user.name, isGM: game.user.isGM },
        channel: CHANNEL
      });

      if (!game?.socket?.on) {
        err("game.socket.on missing; cannot install");
        return;
      }

      if (store.installed && store.handler) {
        try { game.socket.off(CHANNEL, store.handler); } catch (_) {}
        store.installed = false;
        store.handler = null;
        log("Previous handler removed");
      }

      store.handler = async (data) => {
        await handleMessage(data, { localCall: false });
      };

      game.socket.on(CHANNEL, store.handler);
      store.installed = true;

      log("Socket listener installed ✅", { channel: CHANNEL, types: [MSG_ICON, MSG_DIALOG, MSG_PING] });
    }

    // =========================================================================
    // EXPOSE DEBUG API
    // =========================================================================
    globalThis.ONI_EXAMINE_UI = {
      CHANNEL,
      MSG_ICON,
      MSG_DIALOG,
      MSG_PING,
      handleMessage,
      installSocketListener,
      _store: store,
    };

    installSocketListener();

    // self ping
    if (DEBUG) {
      try {
        game.socket.emit(CHANNEL, { type: MSG_PING, payload: { from: game.user.id, name: game.user.name, at: Date.now() } });
      } catch (_) {}
    }
  })();
});
