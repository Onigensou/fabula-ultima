// ============================================================================
// Fabula Ultima Companion · Turn UI Manager (Foundry VTT v12)
// Spawns JRPG command buttons for the *local* owner of the turn owner token.
// Everyone else sees a turn-owner indicator (speech bubble / red "!" burst).
//
// • Friendly PC turn  -> Spawn buttons *for that PC's owner* (linked character).
// • Monster/Neutral   -> Spawn buttons *for GM only*; others get the indicator.
// • On turn change    -> Despawn old buttons/indicators, repeat for the new turn.
// • On combat start   -> Preload UI SFX for snappy navigation.
// • On combat end     -> Despawn everything and unload SFX.
//
// Buttons are now WIRED to your existing Macro scripts by name.
// - Attack      -> "Attack"
// - Guard       -> "Guard"
// - Skill       -> "Skill"
// - Spell       -> "Spell"
// - Item        -> (not wired yet; shows a friendly notice)
// - Equipment   -> "Equipment"
// - Study       -> "Study"
// - Hinder      -> "Hinder"
// - Objective   -> "Objective"
// - Switch      -> "Party Swap"
//
// Oni safe-guard: installs once, cleans up safely, no cross-client duplication.
// ============================================================================

(() => {
  const NSKEY = "FU_TurnUI";
  if (window[NSKEY]?.installed) return; // already loaded

  const TurnUI = (window[NSKEY] = window[NSKEY] || {});
  TurnUI.installed = true;

  // Expose on globalThis so other scripts (like ActionAnimationHandler) can see it
  // as globalThis.TurnUI.
  globalThis.TurnUI = TurnUI;
  console.log("[Turn UI Manager] Initialized. Global TurnUI exposed on globalThis.");

  // --- Config --------------------------------------------------------------
    const SFX_URL = {
    open: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/switch_mode.wav",
    move: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav"
  };
  const SFX_VOL = 0.6;
  const STYLE_ID = "fu-turnui-style";
  const INDICATOR_STYLE_ID = "fu-turn-indicator-style";

  // Socket channel for cross-client hide/show during animation
  const MODULE_ID      = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  // Map button label -> Macro name
  const MACRO_NAME = {
    "Attack":    "Attack",
    "Guard":     "Guard",
    "Skill":     "Skill",
    "Spell":     "Spell",
    "Item":      "Item",
    "Equipment": "Equipment",
    "Study":     "Study",
    "Hinder":    "Hinder",
    "Objective": "Objective",
    "Switch":    "Party Swap"
  };

     // --- State ---------------------------------------------------------------
  TurnUI.state = {
    currentTokenId: null,      // which token these buttons were spawned for
    buttons: null,             // command UI record (root, cleanup, items, etc.)
    indicator: null,           // indicator record { el, ticker, hookId }
    sfx: null,                 // { open: Howl|Audio, move: Howl|Audio }
    hidePromise: null,         // Promise that resolves when buttons finish hiding
    hideResolve: null,         // resolver for hidePromise
  };

  // === Utilities ===========================================================

  function isFriendly(tokenDoc) {
    const d = tokenDoc?.disposition ?? 0;
    return d === 1;
  }

  function isLinkedToLocalUser(actor) {
    // Per spec, use the “character linked with the user”
    const myCharId = game.user?.character?.id ?? null;
    if (myCharId && actor?.id === myCharId) return true;

    // Failsafe: also allow explicit OWNER permission (handy in testing)
    try { return actor?.testUserPermission?.(game.user, "OWNER") || false; }
    catch { return false; }
  }

  function byIdOnCanvas(tokenId) {
    if (!tokenId) return null;
    return canvas?.tokens?.get(tokenId) ?? null;
  }

  function ensureBaseStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = document.createElement("style");
    css.id = STYLE_ID;
    css.textContent = `
      /* Root for the Octopath-like list */
     #oni-octopath{
  position:fixed; left:0; top:0;
  /* Use the var if present; otherwise fall back to 0 (below HUD=1) */
  z-index:var(--z-index-canvas, 0);
  pointer-events:none;
}
      #oni-octopath .pivot{ position:absolute; width:0; height:0; pointer-events:none }
      #oni-octopath .item{ position:absolute; transform-origin:left center; pointer-events:auto }
      :root {
        --bd-parchment-top:#f6f1e6; --bd-parchment-bot:#ebe3d0;
        --bd-ink:#3a3228; --bd-ink-soft:#4b4338;
        --bd-gold-1:#d5b67a; --bd-gold-2:#b7935a;
        --bd-stroke:#7a6a55; --bd-shadow:rgba(41,33,24,.55);
        --bd-highlight:rgba(255,255,255,.7);
      }
      #oni-octopath .blade{
        position:relative; display:inline-flex; align-items:center; gap:9px;
        padding:10px 16px 10px 22px;
        color:var(--bd-ink);
        font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
        font-weight:800; letter-spacing:.32px; text-transform:uppercase; white-space:nowrap;
        user-select:none; cursor:pointer; transform-origin:left center; opacity:0;
        font-size:13.5px;
        background:linear-gradient(180deg,var(--bd-parchment-top),var(--bd-parchment-bot));
        border:2px solid var(--bd-stroke);
        border-radius:12px;
        box-shadow:0 4px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
        text-shadow:0 1px 0 var(--bd-highlight);
        transition: margin-left .12s ease-out, filter .12s ease, box-shadow .12s ease;
        will-change: margin-left, filter, box-shadow;
      }
      #oni-octopath .blade:hover{
        margin-left:-6px; filter:brightness(1.04);
        box-shadow:0 6px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
      }
      #oni-octopath .blade::before{
        content:""; position:absolute; left:-12px; top:50%; transform:translateY(-50%);
        width:12px; height:76%;
        background:linear-gradient(180deg,var(--bd-gold-1),var(--bd-gold-2));
        border:2px solid var(--bd-stroke); border-right:none; border-radius:10px 0 0 10px;
        box-shadow:0 0 0 1px var(--bd-highlight) inset;
      }
      #oni-octopath .pager{
        position:absolute; display:flex; align-items:center; gap:8px; pointer-events:auto;
        font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
        color:var(--bd-ink-soft); font-weight:800; letter-spacing:.32px; text-transform:uppercase;
        z-index:2;
      }
      #oni-octopath .pager .title{
        padding:6px 10px; border-radius:10px;
        background:linear-gradient(180deg,var(--bd-parchment-top),var(--bd-parchment-bot));
        border:2px solid var(--bd-stroke);
        box-shadow:0 3px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
        font-size:12.5px;
      }
      #oni-octopath .pager .arrow{
        width:24px; height:24px; border-radius:7px; display:grid; place-items:center;
        background:linear-gradient(180deg,var(--bd-gold-1),var(--bd-gold-2));
        border:2px solid var(--bd-stroke); cursor:pointer; user-select:none;
        box-shadow:0 2px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
        color:#221b14; font-weight:900; font-size:13px;
        transition:transform .1s ease, filter .1s ease;
      }
      #oni-octopath .pager .arrow:hover{ transform:translateY(-1px); filter:brightness(1.05) }
      #oni-octopath .pager .arrow:active{ transform:translateY(0) scale(.98) }
    `;
    document.head.appendChild(css);
  }

  function ensureIndicatorStyles() {
    if (document.getElementById(INDICATOR_STYLE_ID)) return;
    const css = document.createElement("style");
    css.id = INDICATOR_STYLE_ID;
    css.textContent = `
      .fu-turn-ind-wrap{position:absolute;pointer-events:none;z-index:30;transform-origin:center bottom;--s:1}
      .fu-turn-ind-wrap.friendly{transform:translate(-50%,-100%) scale(var(--s))}
      .fu-turn-ind-wrap.friendly .bubble{
        display:inline-flex;gap:5px;padding:6px 10px;border-radius:12px;
        background:linear-gradient(180deg,rgba(249,244,232,.98) 0%,rgba(243,236,222,.98) 48%,rgba(237,229,212,.98) 100%);
        border:2px solid rgba(86,62,38,.85);
        box-shadow:0 2px 10px rgba(56,41,28,.35), inset 0 1px 0 rgba(255,255,255,.6);
        outline:2px solid rgba(0,0,0,.06);
        font-family:"Signika","Segoe UI",sans-serif;
      }
      .fu-turn-ind-wrap.friendly .dot{font-weight:800;opacity:.15;animation:blink 1.1s steps(1) infinite}
      .fu-turn-ind-wrap.friendly .dot:nth-child(2){animation-delay:.18s}
      .fu-turn-ind-wrap.friendly .dot:nth-child(3){animation-delay:.36s}
      @keyframes blink{0%{opacity:.15}20%{opacity:1}40%{opacity:.15}100%{opacity:.15}}

      .fu-turn-ind-wrap.hostile{transform:translate(-50%,-100%) scale(var(--s))}
      .fu-turn-ind-wrap.hostile .burst{
        position:relative;width:52px;height:40px;
        background:radial-gradient(circle at 50% 52%, #ff5252 0%, #d51d1d 60%, #8b0000 100%);
        clip-path:polygon(
          50% 2%, 62% 12%, 84% 6%, 74% 26%, 96% 34%, 74% 42%,
          84% 62%, 62% 56%, 50% 68%, 38% 56%, 16% 62%, 26% 42%,
          4% 34%, 26% 26%, 16% 6%, 38% 12%
        );
        box-shadow:0 0 0 2px #2b0000, 0 2px 6px rgba(0,0,0,.45);
        animation:glow 900ms ease-in-out infinite;
      }
      .fu-turn-ind-wrap.hostile .mark{
        position:absolute;left:50%;top:48%;transform:translate(-50%,-50%);
        font-family:"Cinzel","Segoe UI",sans-serif;font-weight:900;font-size:26px;color:#fff;
        text-shadow:0 0 6px rgba(255,255,255,.85),0 2px 0 #7a0000,0 0 12px rgba(255,70,70,.65);
        -webkit-text-stroke:1px rgba(50,0,0,.6);
        animation:bounce 700ms ease-in-out infinite;
      }
      @keyframes glow{0%,100%{box-shadow:0 0 0 2px #2b0000,0 2px 6px rgba(0,0,0,.45)}50%{box-shadow:0 0 0 2px #2b0000,0 3px 10px rgba(0,0,0,.55)}}
      @keyframes bounce{0%,100%{transform:translate(-50%,-50%) translateY(0) scale(1)}50%{transform:translate(-50%,-50%) translateY(-6px) scale(1.08)}}
    `;
    document.head.appendChild(css);
  }

  function worldToClientXY(x, y) {
    const wt = canvas.stage.worldTransform;
    const out = new PIXI.Point();
    wt.apply({ x, y }, out);
    return out;
  }

  // === SFX cache (combat lifecycle) =======================================
  function cacheSFX() {
    if (TurnUI.state.sfx) return;
    try {
      const useHowler = !!window.Howl;
      if (useHowler) {
        TurnUI.state.sfx = {
          open: new Howl({ src: [SFX_URL.open], volume: SFX_VOL }),
          move: new Howl({ src: [SFX_URL.move], volume: SFX_VOL })
        };
      } else {
        // Fallback: lazy-play via AudioHelper each time
        TurnUI.state.sfx = { open: SFX_URL.open, move: SFX_URL.move, fallback: true };
      }
    } catch {
      TurnUI.state.sfx = { open: SFX_URL.open, move: SFX_URL.move, fallback: true };
    }
  }
  function uncacheSFX() {
    try {
      const s = TurnUI.state.sfx;
      if (!s) return;
      if (s.open?.unload) s.open.unload();
      if (s.move?.unload) s.move.unload();
    } catch {}
    TurnUI.state.sfx = null;
  }
  function playSfxOpen() {
    const s = TurnUI.state.sfx;
    if (!s) return;
    try {
      if (s.fallback) {
        AudioHelper.play({ src: s.open, volume: SFX_VOL, autoplay: true, loop: false }, true);
      } else s.open.play();
    } catch {}
  }
  function bindHoverSound(el) {
    const s = TurnUI.state.sfx;
    let last = 0;
    el.addEventListener("mouseenter", () => {
      const now = performance.now();
      if (now - last < 120) return;
      try {
        if (s?.fallback) {
          AudioHelper.play({ src: s.move, volume: SFX_VOL, autoplay: true, loop: false }, true);
        } else s?.move?.play();
      } catch {}
      last = now;
    });
  }

  // === Indicator (for non-owners) =========================================
  function showIndicatorForToken(token) {
    removeIndicator(); // singleton per client
    ensureIndicatorStyles();

    const wrap = document.createElement("div");
    const friendly = isFriendly(token.document);
    wrap.className = `fu-turn-ind-wrap ${friendly ? "friendly" : "hostile"}`;
    if (friendly) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.innerHTML = `<span class="dot">•</span><span class="dot">•</span><span class="dot">•</span>`;
      wrap.appendChild(bubble);
    } else {
      const burst = document.createElement("div"); burst.className = "burst";
      const mark  = document.createElement("div"); mark.className  = "mark"; mark.textContent = "!";
      wrap.append(burst, mark);
    }
    document.body.appendChild(wrap);

    // follow token
    const ticker = new PIXI.Ticker(); ticker.maxFPS = 30;
    const update = () => {
      if (!token?.document || token.destroyed) return;
      const c = token.getCenter ? token.getCenter() : token.center;
      const p = worldToClientXY(c.x, c.y);
      const sc = canvas.stage.scale?.x ?? 1;
      const grid = canvas.grid?.size ?? 100;
      const cellPx = grid * sc;
      const w = (token.bounds?.width ?? token.w ?? (token.document?.width ?? 1) * grid) * sc;
      const h = (token.bounds?.height ?? token.h ?? (token.document?.height ?? 1) * grid) * sc;

      if (friendly) {
        wrap.style.setProperty("--s", 0.85);
        const top = p.y - (h * 0.90) - 40;
        const left = p.x;
        wrap.style.top = `${top}px`; wrap.style.left = `${left}px`;
      } else {
        const dyn = Math.max(0.9, Math.min(1.6, w / cellPx));
        wrap.style.setProperty("--s", (1.10 * dyn).toFixed(3));
        const left = p.x - (w * 0.5) + (w * 0.009);
        const top  = p.y - (h * 0.5) - (h * 0.18);
        wrap.style.top = `${top}px`; wrap.style.left = `${left}px`;
      }
    };
    ticker.add(update); ticker.start();

    const hookId = Hooks.on("preDeleteToken", (scene, doc) => {
      if (doc.id === token.id) removeIndicator();
    });

    TurnUI.state.indicator = { el: wrap, ticker, hookId };
  }

  function removeIndicator() {
    const rec = TurnUI.state.indicator;
    if (!rec) return;
    try { rec.ticker.stop(); } catch {}
    try { Hooks.off("preDeleteToken", rec.hookId); } catch {}
    try { rec.el.remove(); } catch {}
    TurnUI.state.indicator = null;
  }

  // === Command buttons UI (owner-only) ====================================

  // Helper to run a Macro by name mapped from button label
  async function runByButtonLabel(label) {
    const macroName = MACRO_NAME[label] ?? null;

    if (!macroName) {
      ui.notifications.info(`"${label}" isn’t wired yet. (Item system pending)`);
      return;
    }

    const macro = game.macros.getName(macroName);
    if (!macro) {
      ui.notifications.error(`Macro "${macroName}" not found or no permission.`);
      return;
    }

    try {
      await macro.execute();
    } catch (err) {
      console.error(`[Turn UI] Failed executing "${macroName}"`, err);
      ui.notifications.error(`Error running "${macroName}". See console.`);
    }
  }

  function spawnButtonsForToken(token) {
    removeButtons();
    ensureBaseStyles();
    playSfxOpen();

    const PAGES = [
      { name: "Actions", cmds: ["Attack","Guard","Skill","Spell","Item"] },
      { name: "System",  cmds: ["Equipment","Study","Hinder","Objective","Switch"] }
    ];
    let pageIndex = 0;

    const root  = document.createElement("div");
    root.id     = "oni-octopath";
    const pivot = document.createElement("div");
    pivot.className = "pivot";
    root.appendChild(pivot);

    // Pager
    const pager = document.createElement("div"); pager.className = "pager";
    const leftA  = document.createElement("div"); leftA.className = "arrow"; leftA.textContent = "◀";
    const title  = document.createElement("div"); title.className = "title"; title.textContent = PAGES[pageIndex].name;
    const rightA = document.createElement("div"); rightA.className = "arrow"; rightA.textContent = "▶";
    pager.append(leftA, title, rightA);
    root.appendChild(pager);
    document.body.appendChild(root);

    const DURATION_MS = 360, STAGGER_MS = 30, SPIN_DEG = 360, SCALE_MIN = 0.93;
    const EDGE_PAD_X = 12, EDGE_PAD_Y = 50, GAP_PX = 6, PAGER_LIFT = 1.25;
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const easeOutQuint = t => 1 - Math.pow(1 - t, 5);
    const easeOutBack  = (t, s = 0.90) => 1 + ((t = t - 1) * ((s + 1) * t + s) * t);

    const items = [];
    let startClock = performance.now();

    function worldAnchor() {
      const c = token.center ?? token.getCenter?.() ?? { x: token.x + token.w/2, y: token.y + token.h/2 };
      return { x: c.x + token.w * 0.52, y: c.y - token.h * 0.10 };
    }

    function worldToClient(x, y) {
      const wt = canvas.stage.worldTransform; const out = new PIXI.Point();
      wt.apply({ x, y }, out);
      const rect = canvas.app.view.getBoundingClientRect();
      return { x: rect.left + out.x, y: rect.top + out.y };
    }

    function buildPage() {
      // remove old DOM rows
      for (const it of items.splice(0)) it.wrap.remove();

      const COMMANDS = PAGES[pageIndex].cmds;
      for (let i = 0; i < COMMANDS.length; i++) {
        const label = COMMANDS[i];
        const wrap = document.createElement("div"); wrap.className = "item";
        const btn = document.createElement("div"); btn.className = "blade";
        btn.innerHTML = `<span class="label">${label}</span>`;
        btn.style.pointerEvents = "none";

        wrap.appendChild(btn); root.appendChild(wrap);
        items.push({ wrap, btn, tStart: 0, slotX: 0, slotY: 0, bound: false, label });
      }
      title.textContent = PAGES[pageIndex].name;
      startClock = performance.now();
    }

    function computeSlots() {
      if (!items.length) return;
      const a = worldAnchor();
      const ctr = worldToClient(a.x, a.y);
      const hProbe = items[0]?.btn?.getBoundingClientRect()?.height || 18;
      const rowH = hProbe + GAP_PX;
      const totalRise = rowH * (items.length - 1);

      for (let i = 0; i < items.length; i++) {
        items[i].slotX = ctr.x + EDGE_PAD_X;
        items[i].slotY = (ctr.y - totalRise) + EDGE_PAD_Y + i * rowH;
      }
      pivot.style.left = `${ctr.x}px`; pivot.style.top = `${ctr.y}px`;
      const first = items[0];
      if (first) {
        pager.style.left = `${first.slotX}px`;
        pager.style.top  = `${first.slotY - (rowH * PAGER_LIFT)}px`;
      }
    }

    function render() {
      if (!document.body.contains(root)) return;
      if (items.length === 0) buildPage();
      computeSlots();

      const now = performance.now();
      const ax = parseFloat(pivot.style.left);
      const ay = parseFloat(pivot.style.top);

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.tStart) it.tStart = startClock + i * STAGGER_MS;
        const p = clamp01((now - it.tStart) / DURATION_MS);
        const t = easeOutBack(p, 0.90);
        const x = ax + (it.slotX - ax) * t;
        const y = ay + (it.slotY - ay) * t;

        const angleDeg = 0 - (1 - easeOutQuint(p)) * SPIN_DEG;
        const opacity  = Math.pow(p, 0.8);
        const scale    = SCALE_MIN + (1 - SCALE_MIN) * easeOutQuint(p);

        it.wrap.style.left = `${x}px`;
        it.wrap.style.top  = `${y}px`;
        it.wrap.style.transform = `translate(0,-50%) rotate(${angleDeg}deg) scale(${scale})`;
        it.btn.style.transform  = `rotate(${-angleDeg}deg)`;
        it.btn.style.opacity    = opacity.toFixed(3);

        if (!it.bound && p >= 1) {
          bindHoverSound(it.btn);

          // === WIRED: call your macro by button label ======================
          it.btn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            await runByButtonLabel(it.label);
          });
          // =================================================================

          it.btn.style.pointerEvents = "auto";
          it.bound = true;
        }
      }
    }

    // follow token + pan
    const ticker = PIXI.Ticker.shared;
    const tickFn = () => render();
    ticker.add(tickFn);
    const h1 = Hooks.on("updateToken", (doc) => { if (doc.id === token.document.id) render(); });
    const h2 = Hooks.on("canvasPan", render);

    // flip pages (reuse open SFX for flip)
    function flipPage(dir) {
      pageIndex = (pageIndex + dir + PAGES.length) % PAGES.length;
      playSfxOpen(); buildPage(); render();
    }
    leftA.addEventListener("click", (e) => { e.stopPropagation(); flipPage(-1); });
    rightA.addEventListener("click", (e) => { e.stopPropagation(); flipPage(+1); });

    // keyboard arrows to flip
    const keyListener = (e) => {
      if (e.key === "ArrowLeft")  flipPage(-1);
      if (e.key === "ArrowRight") flipPage(+1);
        };
    window.addEventListener("keydown", keyListener, true);

    function cleanup() {
      ticker.remove(tickFn);
      Hooks.off("updateToken", h1);
      Hooks.off("canvasPan", h2);
      window.removeEventListener("keydown", keyListener, true);
      try { root.remove(); } catch {}
    }

    // Store everything we need for later animated hide
    TurnUI.state.buttons = {
      root,
      cleanup,
      items,
      ticker,
      tickFn,
      h1,
      h2,
      keyListener,
      isHiding: false,
      hideRaf: null
    };
  }

        function removeButtons(options = {}) {
    const { clearToken = false, animate = false } = options;
    const b = TurnUI.state.buttons;
    if (!b) {
      if (clearToken) TurnUI.state.currentTokenId = null;
      return;
    }

    if (b.hideRaf) {
      try { cancelAnimationFrame(b.hideRaf); } catch {}
      b.hideRaf = null;
    }

    if (!animate) {
      try { b.cleanup(); } catch {}
      TurnUI.state.buttons = null;
      if (clearToken) TurnUI.state.currentTokenId = null;

      if (TurnUI.state.hideResolve) {
        TurnUI.state.hideResolve();
        TurnUI.state.hideResolve = null;
        TurnUI.state.hidePromise = null;
      }
      return;
    }

    if (b.isHiding) return;
    b.isHiding = true;

    try {
      if (b.ticker && b.tickFn) b.ticker.remove(b.tickFn);
    } catch {}
    try {
      if (b.h1 != null) Hooks.off("updateToken", b.h1);
    } catch {}
    try {
      if (b.h2 != null) Hooks.off("canvasPan", b.h2);
    } catch {}
    try {
      if (b.keyListener) window.removeEventListener("keydown", b.keyListener, true);
    } catch {}

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) {
      try { b.cleanup(); } catch {}
      TurnUI.state.buttons = null;
      if (clearToken) TurnUI.state.currentTokenId = null;
      b.isHiding = false;

      if (TurnUI.state.hideResolve) {
        TurnUI.state.hideResolve();
        TurnUI.state.hideResolve = null;
        TurnUI.state.hidePromise = null;
      }
      return;
    }

    const EXIT_DURATION = 220;
    const EXIT_STAGGER  = 40;
    const EXIT_SHIFT_PX = 18;

    const init = items.map((it) => {
      const left = parseFloat(it.wrap.style.left) || 0;
      const opacity = parseFloat(it.btn.style.opacity) || 1;
      return { left, opacity };
    });

    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      let allDone = true;

      for (let i = 0; i < items.length; i++) {
        const it    = items[i];
        const base  = init[i];
        const delay = EXIT_STAGGER * i;
        const tLocal = elapsed - delay;

        if (tLocal <= 0) {
          allDone = false;
          continue;
        }

        const p = Math.min(1, tLocal / EXIT_DURATION);
        if (p < 1) allDone = false;

        const newLeft    = base.left + EXIT_SHIFT_PX * p;
        const newOpacity = base.opacity * (1 - p);

        it.wrap.style.left   = `${newLeft}px`;
        it.btn.style.opacity = newOpacity.toFixed(3);
        it.btn.style.pointerEvents = "none";
      }

      if (!allDone) {
        b.hideRaf = requestAnimationFrame(step);
      } else {
        b.hideRaf = null;
        b.isHiding = false;

        try { b.cleanup(); } catch {}
        TurnUI.state.buttons = null;
        if (clearToken) TurnUI.state.currentTokenId = null;

        if (TurnUI.state.hideResolve) {
          TurnUI.state.hideResolve();
          TurnUI.state.hideResolve = null;
          TurnUI.state.hidePromise = null;
        }
      }
    }

    b.hideRaf = requestAnimationFrame(step);
  }

  // Prepare a Promise that resolves when the current buttons finish hiding.
  function prepareHidePromise() {
    if (!TurnUI.state.buttons) {
      TurnUI.state.hidePromise = null;
      TurnUI.state.hideResolve = null;
      return null;
    }
    if (!TurnUI.state.hidePromise) {
      TurnUI.state.hidePromise = new Promise((resolve) => {
        TurnUI.state.hideResolve = resolve;
      });
    }
    return TurnUI.state.hidePromise;
  }

  // Public helper for macros: wait until buttons are fully gone.
  TurnUI.waitForButtonsHidden = function(timeoutMs = 800) {
    const p = TurnUI.state.hidePromise;
    if (!p) return Promise.resolve();
    if (!timeoutMs) return p;
    return Promise.race([
      p,
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  };

  // === Orchestration per turn =============================================
  function forLocalClient_spawnWhat(token) {

    // We will either spawn buttons (owner) OR indicator (non-owner).
    const friendly = isFriendly(token.document);
    const actor = token.actor;

    const ownerIsLocal = friendly
      ? isLinkedToLocalUser(actor)           // PCs -> only that player
      : game.user?.isGM;                     // Monsters/Neutral -> GM only

    if (ownerIsLocal) {
      removeIndicator();
      spawnButtonsForToken(token);
    } else {
      removeButtons();
      showIndicatorForToken(token);
    }
  }

  async function handleTurnChange(combat) {
    const cmbt = combat?.combatant;
    if (!cmbt) { clearAllUI(); return; }

    const tokenId = cmbt.tokenId ?? cmbt.token?.id;
    const token = byIdOnCanvas(tokenId);

    // If token isn't on this scene/canvas, just clear
    if (!token) { clearAllUI(); return; }

    // If we're already showing UI for this token, skip re-spawn
    if (TurnUI.state.currentTokenId === token.id) return;

    // Swap to new turn owner
    clearAllUI();
    TurnUI.state.currentTokenId = token.id;
    forLocalClient_spawnWhat(token);
  }

    function clearAllUI() {
    TurnUI.state.currentTokenId = null;
    removeButtons();
    removeIndicator();
  }

    // === Animation helpers (hide/show UI around a skill animation) ===========
  // These functions are the single place that know how to hide/show:
  // - Owner command buttons (this client only)
  // - Non-owner turn indicator icon (this client only)
  //
  // They will be called from a controller script (ActionAnimationHandler) using
  // the callback pattern via TurnUI.withAnimationHideShow(...).
     function hideUIForAnimation(payload) {
    try {
      const currentTokenId = TurnUI.state.currentTokenId;
      const hasButtons     = !!TurnUI.state.buttons;
      const hasIndicator   = !!TurnUI.state.indicator;

      console.log("[Turn UI Manager] hideUIForAnimation called on user",
        game.user?.id, {
          payload,
          currentTokenId,
          hasButtons,
          hasIndicator
        }
      );

      // NEW: if we literally have no Turn UI at all, there is nothing to hide.
      if (!hasButtons && !hasIndicator) {
        console.log("[Turn UI Manager] hideUIForAnimation: no buttons/indicator present, nothing to hide.");
        return;
      }

      // Optional: sourceTokenId only matters for deciding whether
      // to hide the *command buttons*. For the indicator we will ALWAYS hide
      // if it exists, regardless of currentTokenId or srcId.
      let srcId = null;
      if (payload && typeof payload === "object" && "sourceTokenId" in payload) {
        srcId = payload.sourceTokenId;
      }

      // Decide if we should affect the command buttons on this client.
      // We require:
      //   - buttons exist, AND
      //   - either no srcId was given, OR srcId matches this client's currentTokenId.
      let shouldHideButtons = false;
      if (hasButtons) {
        if (!srcId) {
          shouldHideButtons = true;
        } else if (currentTokenId && srcId === currentTokenId) {
          shouldHideButtons = true;
        } else {
          console.log("[Turn UI Manager] hideUIForAnimation: buttons present but sourceTokenId mismatch; not hiding buttons.", {
            srcId,
            currentTokenId
          });
        }
      }

      // 1) Hide command buttons (owner) WITH easing, if applicable.
      if (shouldHideButtons) {
        console.log("[Turn UI Manager] hideUIForAnimation: Hiding command buttons with animation.");
        if (typeof prepareHidePromise === "function") {
          prepareHidePromise();
        }
        // Fade/slide out but keep currentTokenId so we can respawn after the animation.
        removeButtons({ clearToken: false, animate: true });
      }

      // 2) ALWAYS hide the turn-indicator icon if it exists on this client.
      //    This is the crucial bit: we no longer depend on currentTokenId.
      if (hasIndicator) {
        console.log("[Turn UI Manager] hideUIForAnimation: Hiding turn-indicator icon instantly.");
        // As per your request: no easing needed for the thinking / ! icon.
        removeIndicator();
      }
    } catch (err) {
      console.error("[Turn UI Manager] hideUIForAnimation error:", err);
    }
  }
  
      function showUIAfterAnimation(payload) {
    try {
      const currentTokenId = TurnUI.state.currentTokenId;
      const hasButtons     = !!TurnUI.state.buttons;
      const hasIndicator   = !!TurnUI.state.indicator;

      console.log("[Turn UI Manager] showUIAfterAnimation called on user",
        game.user?.id, {
          payload,
          currentTokenId,
          hasButtons,
          hasIndicator
        }
      );

      if (!currentTokenId) {
        console.log("[Turn UI Manager] showUIAfterAnimation: no currentTokenId, abort (no notion of whose turn this is).");
        return;
      }

      // Optional: respect sourceTokenId if provided (mainly important for buttons).
      let srcId = null;
      if (payload && typeof payload === "object" && "sourceTokenId" in payload) {
        srcId = payload.sourceTokenId;
      }
      if (srcId && srcId !== currentTokenId) {
        console.log("[Turn UI Manager] showUIAfterAnimation: sourceTokenId mismatch; ignoring.", {
          srcId,
          currentTokenId
        });
        return;
      }

      // If something is already visible (buttons or indicator), don't double-spawn.
      if (hasButtons || hasIndicator) {
        console.log("[Turn UI Manager] showUIAfterAnimation: UI already visible, skipping respawn.");
        return;
      }

      const token = byIdOnCanvas(currentTokenId);
      if (!token) {
        console.log("[Turn UI Manager] showUIAfterAnimation: token not on this canvas, abort.");
        return;
      }

      console.log("[Turn UI Manager] showUIAfterAnimation: respawning UI via forLocalClient_spawnWhat.");
      // Re-evaluate what this client should see:
      // - If this client owns the token → spawn command buttons.
      // - Otherwise → spawn the turn-indicator icon.
      forLocalClient_spawnWhat(token);
    } catch (err) {
      console.error("[Turn UI Manager] showUIAfterAnimation error:", err);
    }
  }

  // Expose helpers on the TurnUI namespace so other scripts (e.g. ActionAnimationHandler)
  // can call them directly using the callback pattern.
  TurnUI.hideUIForAnimation   = hideUIForAnimation;
  TurnUI.showUIAfterAnimation = showUIAfterAnimation;

  // Convenience: callback-style helper for your controller script (LOCAL ONLY).
  TurnUI.withAnimationHideShow = async function(payload, workerFn) {
    if (typeof workerFn !== "function") return;
    try {
      hideUIForAnimation(payload);

      // Allow the worker to be sync or async. If it returns a Promise, await it.
      const result = workerFn(payload);
      if (result && typeof result.then === "function") {
        const awaited = await result;
        showUIAfterAnimation(payload);
        return awaited;
      }

      showUIAfterAnimation(payload);
      return result;
    } catch (err) {
      console.error("[Turn UI Manager] withAnimationHideShow worker error:", err);
      // Still make sure the UI comes back even if the worker throws.
      showUIAfterAnimation(payload);
      throw err;
    }
  };

  // Public wrappers for socket packets (so other scripts can call these too)
  TurnUI.handleHideForAnimationPacket = function(packetPayload = {}) {
    hideUIForAnimation(packetPayload);
  };

  TurnUI.handleShowAfterAnimationPacket = function(packetPayload = {}) {
    showUIAfterAnimation(packetPayload);
  };

    // === Hooks ==============================================================

  // 1) On combat start: warm up SFX cache
  Hooks.on("combatStart", () => { cacheSFX(); });

  // 2) On combat end / delete / active=false: clear UI + uncache
  Hooks.on("combatEnd", () => { clearAllUI(); uncacheSFX(); });
  Hooks.on("deleteCombat", () => { clearAllUI(); uncacheSFX(); });
  Hooks.on("updateCombat", (combat, changed) => {
    // If combat was deactivated, treat as end
    if (Object.prototype.hasOwnProperty.call(changed, "active") && changed.active === false) {
      clearAllUI(); uncacheSFX(); return;
    }

    // Only act when turn or round actually changes
    if (!("turn" in changed || "round" in changed)) return;
    handleTurnChange(combat);
  });

      // === Hooks ==============================================================

  // 1) On combat start: warm up SFX cache
  Hooks.on("combatStart", () => { cacheSFX(); });

  // 2) On combat end / delete / active=false: clear UI + uncache
  Hooks.on("combatEnd", () => { clearAllUI(); uncacheSFX(); });
  Hooks.on("deleteCombat", () => { clearAllUI(); uncacheSFX(); });
  Hooks.on("updateCombat", (combat, changed) => {
    // If combat was deactivated, treat as end
    if (Object.prototype.hasOwnProperty.call(changed, "active") && changed.active === false) {
      clearAllUI(); uncacheSFX(); return;
    }

    // Only act when turn or round actually changes
    if (!("turn" in changed || "round" in changed)) return;
    handleTurnChange(combat);
  });

  // 3) On ready: initialize + install socket listeners
  Hooks.once("ready", () => {
    cacheSFX();
    const c = game.combats?.active;
    if (c && (c.started || (c.round ?? 0) > 0)) {
      // Fire once to match current state
      handleTurnChange(c);
    }

    // === Socket listeners (installed AFTER ready, on every client) ========
    if (!game.socket) {
      console.warn("[Turn UI Manager] game.socket is not available on user", game.user?.id);
    } else {
      console.log("[Turn UI Manager] Installing socket listeners on user", game.user?.id, {
        moduleChannel: SOCKET_CHANNEL,
        world: true
      });

      // Listen on module.<id> (primary channel)
      game.socket.on(SOCKET_CHANNEL, (data) => {
        if (!data || !data.type) return;

        console.log("[Turn UI Manager] Socket message received on user", game.user?.id, data);

        if (data.type === "ONI_TURNUI_HIDE_FOR_ANIMATION") {
          console.log("[Turn UI Manager] -> handling HIDE_FOR_ANIMATION (module channel)");
          TurnUI.handleHideForAnimationPacket(data.payload || {});
        } else if (data.type === "ONI_TURNUI_SHOW_AFTER_ANIMATION") {
          console.log("[Turn UI Manager] -> handling SHOW_AFTER_ANIMATION (module channel)");
          TurnUI.handleShowAfterAnimationPacket(data.payload || {});
        }
      });

      // ALSO listen on 'world' with a tagged payload, similar to your TurnIndPing demo.
      game.socket.on("world", (data) => {
        if (!data || data._oniTurnUI == null) return;

        console.log("[Turn UI Manager] WORLD socket message on user", game.user?.id, { data });

        if (data._oniTurnUI === "HIDE_FOR_ANIMATION") {
          console.log("[Turn UI Manager] -> handling HIDE_FOR_ANIMATION (world channel)");
          TurnUI.handleHideForAnimationPacket(data.payload || {});
        } else if (data._oniTurnUI === "SHOW_AFTER_ANIMATION") {
          console.log("[Turn UI Manager] -> handling SHOW_AFTER_ANIMATION (world channel)");
          TurnUI.handleShowAfterAnimationPacket(data.payload || {});
        }
      });
    }
  });

  console.log("[Turn UI Manager] Installed.");
})();
