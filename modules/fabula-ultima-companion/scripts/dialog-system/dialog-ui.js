// ============================================================================
// FabulaUltimaCompanion - Dialog System (UI + Listener) - v1
// File: scripts/dialog-system/dialog-ui.js
// - Installs a socket listener on startup (multi-client)
// - Injects CSS once
// - Renders the JRPG speech bubble UI (normal/shout/think)
// - Adds loud console logs so we can verify it loads on every client
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  // Primary message type
  const MSG_TYPE_SHOW = "FU_DIALOG_SHOW_V1";

  // Optional debug ping (like our test macro)
  const MSG_TYPE_PING = "FU_DIALOG_PING_V1";

  // --- Debug switches ---
  const BOOT_LOG_ALWAYS = true; // always log that this file loaded
  const STORE_KEY = "__FU_DIALOG_UI__";

  // --- UI defaults ---
  const DEFAULT_CPS = 28;
  const HOLD_AFTER_TYPING_MS = 1600;
  const OFFSET_Y = 28;
  const BUBBLE_ANCHOR = 0.62;
  const MAX_BUBBLE_WIDTH = 420;
  const MIN_BUBBLE_WIDTH = 420;
  const PORTRAIT_SIZE = 128;
  const PORTRAIT_PULL = -8;

  // Typewriter blip SFX
  const CURSOR_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Cursor1.ogg";
  const SOUND_VOLUME = 0.55;
  const BEEP_GAP_MS = 55;
  const SKIP_WHITESPACE = true;

  // Remote clients playing sound is usually annoying
  const REMOTE_PLAYS_SOUND = false;

  const STYLE_ID = "fu-dialog-speech-style";
  const LAYER_ID = "fu-dialog-speech-layer";

  const store = (globalThis[STORE_KEY] ??= {
    installed: false,
    handler: null,
    seen: new Set(),
  });

  const boot = (...args) => {
    if (BOOT_LOG_ALWAYS) console.log("%c[FU Dialog:UI][BOOT]", "color:#7dd3fc", ...args);
  };
  const debug = (...args) => {
    const d = globalThis?.FU?.Dialog?.DEBUG;
    if (d) console.log("%c[FU Dialog:UI]", "color:#7dd3fc", ...args);
  };
  const warn = (...args) => console.warn("%c[FU Dialog:UI]", "color:#fbbf24", ...args);
  const err  = (...args) => console.error("%c[FU Dialog:UI]", "color:#fb7185", ...args);

  boot("dialog-ui.js loaded", {
    moduleId: MODULE_ID,
    channel: SOCKET_CHANNEL,
    user: game?.user?.name,
    userId: game?.user?.id
  });

  const htmlEscape = (v) => {
    const d = document.createElement("div");
    d.textContent = (v ?? "").toString();
    return d.innerHTML;
  };

  function randomID(n = 10) {
    const s = "abcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    while (r.length < n) r += s[(Math.random() * s.length) | 0];
    return r;
  }

  async function waitCanvasReady(timeoutMs = 3000) {
    const start = Date.now();
    while (!canvas?.ready) {
      await new Promise((r) => setTimeout(r, 50));
      if (Date.now() - start > timeoutMs) break;
    }
    return !!canvas?.ready;
  }

  function getTokenOnCanvas(tokenId) {
    return canvas?.tokens?.get?.(tokenId) ?? canvas?.tokens?.placeables?.find?.(t => t?.document?.id === tokenId);
  }

  async function playOneShot(url, volume = 1.0) {
    try {
      if (window.AudioHelper?.play) {
        await AudioHelper.play({ src: url, volume, autoplay: true, loop: false }, true);
        return;
      }
    } catch (_) {}

    try {
      const a = new Audio(url);
      a.volume = volume;
      a.addEventListener("ended", () => a.remove());
      await a.play().catch(() => {});
    } catch (_) {}
  }

  function ensureLayerAndStyles() {
    if (!document.getElementById(STYLE_ID)) {
      const css = document.createElement("style");
      css.id = STYLE_ID;
      css.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif; }

.fu-bubble { position: absolute; pointer-events: auto; display: flex; align-items: stretch;
  max-width: min(${MAX_BUBBLE_WIDTH}px, 92vw); min-width: ${MIN_BUBBLE_WIDTH}px;
  transform-origin: var(--tail-x, 48px) calc(100% + 14px); }
.fu-enter { animation: fu-grow .18s ease-out both; }
.fu-exit  { animation: fu-shrink .15s ease-in both; }
@keyframes fu-grow   { from { transform: scale(.72); opacity: 0 } to { transform: scale(1); opacity: 1 } }
@keyframes fu-shrink { from { transform: scale(1);   opacity: 1 } to { transform: scale(.72); opacity: 0 } }

/* Portrait column */
.fu-left { border-radius: 18px 0 0 18px; padding: 6px; margin-right: ${PORTRAIT_PULL}px;
  display: flex; align-items: center; justify-content: center; background: transparent; }
.fu-left img { width: ${PORTRAIT_SIZE}px; height: ${PORTRAIT_SIZE}px; object-fit: contain; background: transparent;
  border-radius: 14px; box-shadow: none !important; border: 0 !important; outline: 0 !important; filter: none !important; }

/* ===== Normal (FFT parchment) ======================================= */
.fu-paper { position: relative; flex: 1; background: #e8e0cf; color: #2b261f;
  border-radius: 0 18px 18px 18px; overflow: hidden; box-shadow: 0 6px 10px rgba(0,0,0,.45); }
.fu-bubble:not(.mode-shout):not(.mode-think) .fu-paper::before {
  content:""; position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(1200px 600px at 0% 0%, rgba(255,255,255,.35), transparent 70%),
    radial-gradient(800px 400px at 100% 0%, rgba(255,255,255,.25), transparent 70%),
    radial-gradient(1000px 800px at 50% 120%, rgba(0,0,0,.06), transparent 60%);
  mix-blend-mode: multiply; opacity:.6;
}
.fu-name { font-weight:700; font-size:1.05rem; letter-spacing:.02em; color:#2a1c0f;
  text-shadow:0 1px 0 rgba(255,255,255,.6); margin:12px 16px 6px; }
.fu-text { font-size:1.05rem; line-height:1.5; min-height:2.7em; margin:0 16px 14px; }
.fu-tail { position:absolute; bottom:-16px; left:44px; width:0; height:0;
  border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf;
  filter: drop-shadow(0 -2px 0 rgba(0,0,0,.08)); }

/* ===== SHOUT (jagged box, NO TAIL) ================================== */
.mode-shout .fu-paper { background: transparent; border-radius:0; box-shadow:none; overflow:visible; }
.mode-shout .fu-name  { margin:12px 16px 6px; font-weight:700; color:#16120c; text-shadow:none; }
.mode-shout .fu-text  { margin:0 16px 14px; font-weight:700; letter-spacing:.02em; }

.mode-shout .fu-paper { position: relative; }
.mode-shout .fu-paper::before {
  content:""; position:absolute; inset:-8px; z-index:-1; background:#fffdf6;
  clip-path: polygon(
    3% 15%, 8% 5%, 16% 12%, 25% 4%, 33% 12%, 43% 5%, 52% 13%, 62% 6%,
    69% 14%, 78% 8%, 84% 16%, 92% 12%, 96% 22%, 92% 34%, 98% 41%,
    92% 49%, 97% 58%, 90% 66%, 96% 74%, 88% 82%, 92% 90%, 82% 94%,
    75% 88%, 66% 96%, 58% 88%, 49% 96%, 41% 88%, 33% 94%, 26% 86%,
    18% 92%, 12% 84%, 8% 74%, 5% 66%, 8% 57%, 3% 48%, 8% 40%, 2% 30%
  );
  box-shadow: 0 0 0 3px #15110a, 0 10px 16px rgba(0,0,0,.35);
  opacity: 1 !important;
  pointer-events: none;
}
.mode-shout .fu-tail { display:none !important; }

/* ===== THINK (cloud + dotted tail) ================================== */
.mode-think .fu-paper {
  background:#fffdf6; color:#16120c;
  border-radius: 28px; overflow: visible;
  box-shadow: 0 0 0 3px #15110a, 0 8px 14px rgba(0,0,0,.28);
}
.mode-think .fu-name { margin:12px 16px 6px; font-weight:700; color:#16120c; text-shadow:none; }
.mode-think .fu-text { margin:0 16px 14px; }
.mode-think .fu-tail { display:none !important; }

.fu-think-tail { position:absolute; bottom:-40px; left:0; width: 0; height: 0; pointer-events:none; }
.mode-think .fu-think-tail { display:block; }
.fu-think-tail .dot {
  position:absolute; border-radius:50%;
  background:#fffdf6; box-shadow: 0 0 0 3px #15110a, 0 4px 6px rgba(0,0,0,.2);
}
.fu-think-tail .dot.d1 { width:22px; height:22px; }
.fu-think-tail .dot.d2 { width:16px; height:16px; }
.fu-think-tail .dot.d3 { width:10px; height:10px; }
      `;
      document.head.appendChild(css);
      debug("CSS injected", STYLE_ID);
    }

    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = LAYER_ID;
      document.body.appendChild(layer);
      debug("Layer created", LAYER_ID);
    }
    return layer;
  }

  async function renderBubble(token, payload, { remote = false } = {}) {
    const layer = ensureLayerAndStyles();

    const mode = (payload.mode || "normal");
    const isShout = mode === "shout";
    const isThink = mode === "think";
    const cps = Math.max(1, Number(payload.speed) || DEFAULT_CPS);

    const portraitSrc =
      payload.portraitSrc ||
      token.actor?.img ||
      token.document?.texture?.src ||
      token.texture?.src ||
      "icons/svg/mystery-man.svg";

    const id = payload.bubbleId || `fu-bubble-${randomID(8)}`;

    const box = document.createElement("div");
    box.className = "fu-bubble fu-enter";
    if (isShout) box.classList.add("mode-shout");
    if (isThink) box.classList.add("mode-think");
    box.id = id;

    box.innerHTML = `
      <div class="fu-left"><img alt="portrait" src="${htmlEscape(portraitSrc)}"/></div>
      <div class="fu-paper">
        <div class="fu-name">${htmlEscape(payload.name || token.document?.name || "Speaker")}</div>
        <div class="fu-text"><span class="fu-typed"></span></div>
        <div class="fu-tail"></div>
        <div class="fu-think-tail" style="display:${isThink ? "block" : "none"};">
          <div class="dot d1"></div>
          <div class="dot d2"></div>
          <div class="dot d3"></div>
        </div>
      </div>
    `;
    layer.appendChild(box);

    function getScreenXY() {
      const gp = token.mesh.getGlobalPosition();
      const h = token.mesh.height ?? (token.w ?? 100);
      return { x: gp.x, y: gp.y - h * BUBBLE_ANCHOR - OFFSET_Y };
    }

    function place() {
      if (!box.isConnected) return;
      const { x, y } = getScreenXY();
      const rect = box.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;

      let left = x - Math.min(160, rect.width * 0.25);
      let top = y - rect.height;

      left = Math.max(6, Math.min(left, vw - rect.width - 24));
      top = Math.max(6, Math.min(top, vh - rect.height - 6));

      box.style.left = `${left}px`;
      box.style.top = `${top}px`;

      const leftRect = box.querySelector(".fu-left")?.getBoundingClientRect();
      const leftW = leftRect ? leftRect.width : 0;
      const tailX = 44 + leftW;
      box.style.setProperty("--tail-x", `${tailX}px`);

      if (isThink) {
        const paper = box.querySelector(".fu-paper");
        const paperRect = paper.getBoundingClientRect();
        const px = tailX;

        const tail = paper.querySelector(".fu-think-tail");
        const d1 = tail.querySelector(".d1");
        const d2 = tail.querySelector(".d2");
        const d3 = tail.querySelector(".d3");

        d1.style.left = `${Math.max(12, px - paperRect.left - 12)}px`;
        d1.style.top = `-8px`;
        d2.style.left = `${Math.max(6, px - paperRect.left - 26)}px`;
        d2.style.top = `10px`;
        d3.style.left = `${Math.max(0, px - paperRect.left - 34)}px`;
        d3.style.top = `26px`;
      }
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

    let lastBeep = 0;
    function blipMaybe(char) {
      if (SKIP_WHITESPACE && /^\s$/.test(char)) return;
      const now = performance.now();
      if (now - lastBeep < BEEP_GAP_MS) return;
      lastBeep = now;

      if (!remote || REMOTE_PLAYS_SOUND) playOneShot(CURSOR_URL, SOUND_VOLUME);
    }

    const typed = box.querySelector(".fu-typed");
    const full = String(payload.text ?? "");
    const STEP = Math.max(1, Math.round(60 / cps));
    let i = 0, f = 0, done = false, fastForward = false;
    let autoTimer = null;

    function scheduleAutoClose() {
      const typeMs = Math.ceil((full.length / cps) * 1000);
      const totalMs = Math.max(1200, typeMs + HOLD_AFTER_TYPING_MS);
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(() => closeBubble(), totalMs);
    }

    function typeTick() {
      if (!box.isConnected) return;

      if (fastForward) {
        typed.textContent = full;
        done = true;
        scheduleAutoClose();
        return;
      }

      f++;
      if (f >= STEP) {
        f = 0;
        const nextI = Math.min(full.length, i + 1);
        const ch = full.slice(i, nextI);
        i = nextI;
        typed.textContent = full.slice(0, i);
        blipMaybe(ch);

        if (i >= full.length) {
          done = true;
          scheduleAutoClose();
          return;
        }
      }
      requestAnimationFrame(typeTick);
    }
    requestAnimationFrame(typeTick);

    function closeBubble() {
      if (!done) {
        fastForward = true;
        typed.textContent = full;
        done = true;
      }
      box.classList.remove("fu-enter");
      box.classList.add("fu-exit");

      const finish = () => {
        box.removeEventListener("animationend", finish);
        cleanup();
      };
      box.addEventListener("animationend", finish);
    }

    function handleClick() {
      (!done) ? (fastForward = true) : closeBubble();
    }
    box.addEventListener("click", handleClick);

    const onDelete = (doc) => { if (doc.id === token.document.id) closeBubble(); };
    Hooks.on("preDeleteToken", onDelete);

    function cleanup() {
      try {
        if (autoTimer) clearTimeout(autoTimer);
        box.removeEventListener("click", handleClick);

        Hooks.off("canvasPan", onPan);
        window.removeEventListener("resize", onResize);
        Hooks.off("updateToken", onMove);
        Hooks.off("controlToken", onMove);
        Hooks.off("preDeleteToken", onDelete);

        canvas.app.ticker.remove(place);
        box.remove();

        const layer = document.getElementById(LAYER_ID);
        if (layer && !layer.children.length) layer.remove();
      } catch (_) {}
    }
  }

  function installListener() {
    boot("installListener called", { installed: store.installed, channel: SOCKET_CHANNEL });

    if (!game?.socket?.on) {
      err("game.socket.on missing — cannot install listener");
      return;
    }

    // if rerun somehow, remove old handler
    if (store.installed && store.handler) {
      try { game.socket.off(SOCKET_CHANNEL, store.handler); } catch (_) {}
      store.installed = false;
      store.handler = null;
      boot("old handler removed");
    }

    store.handler = async (data) => {
      try {
        debug("SOCKET RECEIVE raw", data);

        if (!data || typeof data !== "object") return;

        // Optional ping debug
        if (data.type === MSG_TYPE_PING) {
          boot("PING received ✅", data.payload);
          return;
        }

        if (data.type !== MSG_TYPE_SHOW) return;

        const payload = data.payload;
        if (!payload) return;

        if (payload.bubbleId && store.seen.has(payload.bubbleId)) return;
        if (payload.bubbleId) store.seen.add(payload.bubbleId);

        if (!canvas?.ready) await waitCanvasReady(3000);

        if (!canvas?.scene?.id || canvas.scene.id !== payload.sceneId) return;

        const token = getTokenOnCanvas(payload.tokenId);
        if (!token) return;

        debug("receive SHOW", payload);
        await renderBubble(token, payload, { remote: true });
      } catch (e) {
        warn("socket handler error", e);
      }
    };

    game.socket.on(SOCKET_CHANNEL, store.handler);
    store.installed = true;

    boot("listener installed ✅", { channel: SOCKET_CHANNEL, showType: MSG_TYPE_SHOW, pingType: MSG_TYPE_PING });
  }

  // ✅ Overwrite-proof assignment (prevents other scripts from clobbering this object)
  globalThis.FU = globalThis.FU ?? {};
  globalThis.FU.DialogUI = globalThis.FU.DialogUI ?? {};
  Object.assign(globalThis.FU.DialogUI, {
    MSG_TYPE_SHOW,
    MSG_TYPE_PING,
    SOCKET_CHANNEL,
    installListener,
    renderFromPayload: async (payload, { remote = false } = {}) => {
      if (!canvas?.ready) await waitCanvasReady(3000);
      if (!payload?.tokenId) return;

      if (!canvas?.scene?.id || canvas.scene.id !== payload.sceneId) return;
      const token = getTokenOnCanvas(payload.tokenId);
      if (!token) return;

      return renderBubble(token, payload, { remote });
    }
  });

  // Auto-install listener on startup (like our test macro installer)
  Hooks.once("ready", () => {
    boot("Hooks.ready fired → installing listener");
    installListener();
  });

})();
