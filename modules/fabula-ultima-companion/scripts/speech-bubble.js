// scripts/features/speech-bubble.js
// === FU Companion — JRPG Speech Bubble (Normal / Shout) =====================
// • Player users: auto-detect the user's linked Actor, find their token on the
//   current scene, and run the bubble for that token. If none → do nothing.
// • GM users: run for currently selected token(s) (if none selected → warn).
// • Typewriter SFX pulls from cached Howl (preloaded at startup in main.js).
// ============================================================================
export async function runJRPGSpeechBubble() {
  const MODULE_ID = "fabula-ultima-companion";

  // ------------- Player / GM token resolution -------------------------------
  // Returns a single Token object or null.
  function resolveTargetToken() {
    // GM path: controlled token(s)
    if (game.user.isGM) {
      const tok = canvas?.tokens?.controlled?.[0] ?? null;
      if (!tok) {
        ui.notifications?.warn("GM: Select a token first.");
        return null;
      }
      return tok;
    }

    // Player path: user-linked actor on this scene
    const linkedActor = game.user?.character ?? null; // Foundry's linked Actor
    if (!linkedActor) {
      // No linked actor configured for this user → quietly ignore
      return null;
    }
    const scene = canvas?.scene;
    if (!scene) return null;

    // Find a token in the current scene whose actorId matches the linked actor
    const match = canvas.tokens.placeables.find(t => t?.document?.actorId === linkedActor.id) ?? null;
    return match ?? null;
  }

  // ---- Config (unchanged) ---------------------------------------------------
  const CPS = 28;
  const HOLD_AFTER_TYPING_MS = 1600;
  const OFFSET_Y = 28;
  const BUBBLE_ANCHOR = 0.62;
  const MAX_BUBBLE_WIDTH = 420;
  const MIN_BUBBLE_WIDTH = 420;
  const PORTRAIT_SIZE = 128;
  const PORTRAIT_PULL = -8;

  // ---- Sound (use cached Howl if available) ---------------------------------
  const SOUND_VOLUME = 0.55;
  const BEEP_GAP_MS  = 55;
  const SKIP_WHITESPACE = true;

  // `main.js` stores a Howl at: game.modules.get(MODULE_ID).api?.sfx?.cursor
  function playCursorBeepCached(volume = SOUND_VOLUME) {
    try {
      const howl = game.modules.get(MODULE_ID)?.api?.sfx?.cursor;
      if (howl) { howl.volume(volume); howl.play(); return; }
    } catch (_) {}
    // Fallback safety: do nothing if cache missing.
  }

  // ------------- Helpers -----------------------------------------------------
  const htmlEscape = (v) => { const d = document.createElement("div"); d.textContent = (v ?? "").toString(); return d.innerHTML; };

  // Resolve target token by role logic
  const token = resolveTargetToken();
  if (!token) {
    // GM is warned above when no selection; Players fail silently if no token.
    return;
  }

  // Gather portrait/name
  const defaultName = token.document?.name ?? token.name ?? "Speaker";
  const portraitSrc =
    token.actor?.img ||
    token.document?.texture?.src ||
    token.document?.texture?.img ||
    token.texture?.src ||
    "icons/svg/mystery-man.svg";

  // ---- Prompt for Name / Mode / Line ---------------------------------------
  const line = await new Promise((resolve) => {
    new Dialog({
      title: "Speak",
      content: `
        <div style="margin-top:4px">
          <div class="form-group">
            <label>Speaker Name</label>
            <input type="text" id="fft-name" value="${htmlEscape(defaultName)}"/>
          </div>
          <div class="form-group">
            <label>Mode</label>
            <div style="display:flex; gap:16px; margin-top:4px;">
              <label style="display:flex; align-items:center; gap:6px;">
                <input type="radio" name="fft-mode" value="normal" checked/> Normal
              </label>
              <label style="display:flex; align-items:center; gap:6px;">
                <input type="radio" name="fft-mode" value="shout"/> Shout
              </label>
            </div>
          </div>
          <div class="form-group">
            <label>Line</label>
            <textarea id="fft-line" rows="4" placeholder="Type something dramatic…"></textarea>
          </div>
          <p style="font-size:0.9em;opacity:.8;margin:6px 0 0">
            Click bubble to fast-forward; click again to close early.
          </p>
        </div>
      `,
      buttons: {
        speak: { label: "Speak", callback: (html) => {
          const name = html.find("#fft-name").val()?.trim() || defaultName;
          const text = html.find("#fft-line").val()?.trim() || "";
          const mode = html.find('input[name="fft-mode"]:checked').val() || "normal";
          resolve({ name, text, mode });
        }},
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "speak",
      render: (html) => html.find("#fft-line").focus(),
      close: () => resolve(null)
    }).render(true);
  });
  if (!line || !line.text) return;

  // ---- Styles / Layer -------------------------------------------------------
  const STYLE_ID = "fft-speech-style-v34";
  const LAYER_ID = "fft-speech-layer";
  if (!document.getElementById(STYLE_ID)) {
    const css = document.createElement("style");
    css.id = STYLE_ID;
    css.textContent = `
      #${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
        font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif; }

      .fft-bubble { position: absolute; pointer-events: auto; display: flex; align-items: stretch;
        max-width: min(${MAX_BUBBLE_WIDTH}px, 92vw); min-width: ${MIN_BUBBLE_WIDTH}px;
        transform-origin: var(--tail-x, 48px) calc(100% + 14px); }
      .fft-enter { animation: fft-grow .18s ease-out both; }
      .fft-exit  { animation: fft-shrink .15s ease-in both; }
      @keyframes fft-grow   { from { transform: scale(.72); opacity: 0 } to { transform: scale(1); opacity: 1 } }
      @keyframes fft-shrink { from { transform: scale(1);   opacity: 1 } to { transform: scale(.72); opacity: 0 } }

      .fft-left { border-radius: 18px 0 0 18px; padding: 6px; margin-right: ${PORTRAIT_PULL}px;
        display: flex; align-items: center; justify-content: center; background: transparent; }
      .fft-left img { width: ${PORTRAIT_SIZE}px; height: ${PORTRAIT_SIZE}px; object-fit: contain; background: transparent;
        border-radius: 14px; box-shadow: none !important; border: 0 !important; outline: 0 !important; filter: none !important; }

      /* ===== Normal (parchment) ============================================ */
      .fft-paper { position: relative; flex: 1; background: #e8e0cf; color: #2b261f;
        border-radius: 0 18px 18px 18px; overflow: hidden; box-shadow: 0 6px 10px rgba(0,0,0,.45); }
      .fft-bubble:not(.mode-shout) .fft-paper::before {
        content:""; position:absolute; inset:0; pointer-events:none;
        background:
          radial-gradient(1200px 600px at 0% 0%, rgba(255,255,255,.35), transparent 70%),
          radial-gradient(800px 400px at 100% 0%, rgba(255,255,255,.25), transparent 70%),
          radial-gradient(1000px 800px at 50% 120%, rgba(0,0,0,.06), transparent 60%);
        mix-blend-mode: multiply; opacity:.6;
      }
      .fft-name { font-weight:700; font-size:1.05rem; letter-spacing:.02em; color:#2a1c0f;
                  text-shadow:0 1px 0 rgba(255,255,255,.6); margin:12px 16px 6px; }
      .fft-text { font-size:1.05rem; line-height:1.5; min-height:2.7em; margin:0 16px 14px; }
      .fft-tail { position:absolute; bottom:-16px; left:44px; width:0; height:0;
        border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf;
        filter: drop-shadow(0 -2px 0 rgba(0,0,0,.08)); }

      /* ===== SHOUT (jagged burst, NO TAIL) ================================= */
      .mode-shout .fft-paper { background: transparent; border-radius:0; box-shadow:none; overflow:visible; }
      .mode-shout .fft-name  { margin:12px 16px 6px; font-weight:700; color:#16120c; text-shadow:none; }
      .mode-shout .fft-text  { margin:0 16px 14px; font-weight:700; letter-spacing:.02em; }
      .mode-shout .fft-paper { position: relative; }
      .mode-shout .fft-paper::before {
        content:""; position:absolute; inset:-8px; z-index:-1; background:#fffdf6;
        clip-path: polygon(
          3% 15%, 8% 5%, 16% 12%, 25% 4%, 33% 12%, 43% 5%, 52% 13%, 62% 6%,
          69% 14%, 78% 8%, 84% 16%, 92% 12%, 96% 22%, 92% 34%, 98% 41%,
          92% 49%, 97% 58%, 90% 66%, 96% 74%, 88% 82%, 92% 90%, 82% 94%,
          75% 88%, 66% 96%, 58% 88%, 49% 96%, 41% 88%, 33% 94%, 26% 86%,
          18% 92%, 12% 84%, 8% 74%, 5% 66%, 8% 57%, 3% 48%, 8% 40%, 2% 30%
        );
        box-shadow: 0 0 0 3px #15110a, 0 10px 16px rgba(0,0,0,.35);
        mix-blend-mode: normal !important;
        opacity: 1 !important;
        pointer-events: none;
      }
      .mode-shout .fft-tail { display:none !important; }
    `;
    document.head.appendChild(css);
  }
  let layer = document.getElementById(LAYER_ID);
  if (!layer) { layer = document.createElement("div"); layer.id = LAYER_ID; document.body.appendChild(layer); }

  // ---- Create bubble --------------------------------------------------------
  const id = `fft-bubble-${randomID(8)}`;
  const box = document.createElement("div");
  box.className = "fft-bubble fft-enter";
  const isShout = (line.mode || "normal") === "shout";
  if (isShout) box.classList.add("mode-shout");
  box.id = id;
  box.innerHTML = `
    <div class="fft-left"><img alt="portrait" src="${htmlEscape(portraitSrc)}"/></div>
    <div class="fft-paper">
      <div class="fft-name">${htmlEscape(line.name)}</div>
      <div class="fft-text"><span class="fft-typed"></span></div>
      <div class="fft-tail"></div>
    </div>
  `;
  layer.appendChild(box);

  // ---- Positioning (unchanged) ---------------------------------------------
  function getScreenXY() {
    const gp = token.mesh.getGlobalPosition();
    const h  = token.mesh.height ?? (token.w ?? 100);
    return { x: gp.x, y: gp.y - h * BUBBLE_ANCHOR - OFFSET_Y };
  }
  function place() {
    if (!box.isConnected) return;
    const { x, y } = getScreenXY();
    const rect = box.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x - Math.min(160, rect.width * 0.25);
    let top  = y - rect.height;
    left = Math.max(6, Math.min(left, vw - rect.width - 24));
    top  = Math.max(6, Math.min(top, vh - rect.height - 6));
    box.style.left = `${left}px`;
    box.style.top  = `${top}px`;
    const leftRect = box.querySelector(".fft-left")?.getBoundingClientRect();
    const leftW = leftRect ? leftRect.width : 0;
    const tailX = 44 + leftW;
    box.style.setProperty("--tail-x", `${tailX}px`);
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

  // ---- Blip throttle (cached SFX) ------------------------------------------
  let lastBeep = 0;
  function blipMaybe(char) {
    if (SKIP_WHITESPACE && /^\s$/.test(char)) return;
    const now = performance.now();
    if (now - lastBeep < BEEP_GAP_MS) return;
    lastBeep = now;
    playCursorBeepCached(SOUND_VOLUME);
  }

  // ---- Typewriter + auto-dismiss -------------------------------------------
  const typed = box.querySelector(".fft-typed");
  const full  = line.text;
  const STEP  = Math.max(1, Math.round(60 / CPS));
  let i = 0, f = 0, done = false, fastForward = false;
  let autoTimer = null;

  function scheduleAutoClose() {
    const typeMs = Math.ceil((full.length / CPS) * 1000);
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

  // ---- Close & cleanup ------------------------------------------------------
  function closeBubble() {
    if (!done) { fastForward = true; typed.textContent = full; done = true; }
    box.classList.remove("fft-enter"); box.classList.add("fft-exit");
    const finish = () => { box.removeEventListener("animationend", finish); cleanup(); };
    box.addEventListener("animationend", finish);
  }
  function handleClick() { (!done) ? (fastForward = true) : closeBubble(); }
  box.addEventListener("click", handleClick);

  const onDelete = (doc) => { if (doc.id === token.document.id) closeBubble(); };
  Hooks.on("preDeleteToken", onDelete);

  function cleanup() {
    try {
      if (autoTimer) clearTimeout(autoTimer);
      box.removeEventListener("click", handleClick);
      Hooks.off("canvasPan", onPan); window.removeEventListener("resize", onResize);
      Hooks.off("updateToken", onMove); Hooks.off("controlToken", onMove);
      Hooks.off("preDeleteToken", onDelete);
      canvas.app.ticker.remove(place);
      box?.remove();
      const layer = document.getElementById(LAYER_ID);
      if (layer && !layer.children.length) layer.remove();
    } catch (e) {}
  }

  // Utility
  function randomID(n=8){const s="abcdefghijklmnopqrstuvwxyz0123456789";let r="";while(r.length<n)r+=s[(Math.random()*s.length)|0];return r;}
}
