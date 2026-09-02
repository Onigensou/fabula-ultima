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
  console.debug("[Turn UI Manager] Initialized. Global TurnUI exposed on globalThis.");

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
                               // — singleton for the turn-action menu only.
    indicator: null,           // indicator record { el, ticker, hookId }
    sfx: null,                 // { open: Howl|Audio, move: Howl|Audio }
    hidePromise: null,         // Promise that resolves when buttons finish hiding
    hideResolve: null,         // resolver for hidePromise

    // Additional named menus (e.g. one per reactor in an AoE reaction
    // exchange). Keyed by `opts.menuId`. The turn-action menu still uses
    // the singleton `.buttons` slot above; everything else lives here so
    // multiple can coexist on the same client.
    menus: new Map(),          // Map<menuId, record>
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
     .oni-octopath{
  position:fixed; left:0; top:0;
  /* Use the var if present; otherwise fall back to 0 (below HUD=1) */
  z-index:var(--z-index-canvas, 0);
  pointer-events:none;
}
      .oni-octopath .pivot{ position:absolute; width:0; height:0; pointer-events:none }
      .oni-octopath .item{ position:absolute; transform-origin:left center; pointer-events:auto }
      :root {
        --bd-parchment-top:#f6f1e6; --bd-parchment-bot:#ebe3d0;
        --bd-ink:#3a3228; --bd-ink-soft:#4b4338;
        --bd-gold-1:#d5b67a; --bd-gold-2:#b7935a;
        --bd-stroke:#7a6a55; --bd-shadow:rgba(41,33,24,.55);
        --bd-highlight:rgba(255,255,255,.7);
      }
      .oni-octopath .blade{
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
      .oni-octopath .blade:hover{
        margin-left:-6px; filter:brightness(1.04);
        box-shadow:0 6px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
      }
      /* free-action filter: button label not in the enabledLabels set */
      .oni-octopath .blade.fu-free-action-disabled{
        cursor:not-allowed;
        filter:grayscale(0.6) brightness(0.85);
        opacity:0.55;
      }
      .oni-octopath .blade.fu-free-action-disabled:hover{
        margin-left:0; filter:grayscale(0.6) brightness(0.85);
        box-shadow:0 4px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
      }
      .oni-octopath .blade .icon{
        width:16px; height:16px;
        border-radius:4px;
        border:1px solid rgba(122,106,85,.6);
        background:rgba(255,255,255,.35);
        object-fit:cover;
        flex:0 0 auto;
      }
      /* Reaction menu modifier — applied via opts.menuClass when spawning.
         Reaction skill names tend to be longer than the turn-action label
         set ("Attack","Guard","Skill",...), so the blade needs more right
         padding to breathe. */
      .oni-octopath.is-reaction-menu .blade{
        padding-right:28px;
      }

      /* "Used" stamp — applied to blades whose spec.usedReason was set
         (e.g. once-per-conflict reactions whose charge AE has already
         been consumed). The base blade keeps its disabled grey-out via
         .fu-free-action-disabled; this rule layers a red rubber-stamp
         overlay across the blade so the player can tell at a glance
         that the option exists but has been spent. */
      .oni-octopath .blade.is-used{
        position:relative;
        overflow:visible;
      }
      .oni-octopath .blade.is-used::after{
        content: attr(data-used-reason);
        position:absolute;
        top:50%; left:50%;
        transform: translate(-50%, -50%) rotate(-8deg);
        font-family:"Cinzel","Georgia",serif;
        font-weight:900;
        font-size:13px;
        letter-spacing:1.5px;
        text-transform:uppercase;
        color: rgba(200,16,16,1);
        text-shadow:
          0 1px 0 rgba(255,255,255,.7),
          0 0 1px rgba(120,0,0,.9);
        padding: 2px 10px;
        border: 2px solid rgba(200,16,16,.95);
        border-radius: 4px;
        background: rgba(255,238,228,.55);
        pointer-events: none;
        white-space: nowrap;
        z-index: 1;
      }
      .oni-octopath .blade::before{
        content:""; position:absolute; left:-12px; top:50%; transform:translateY(-50%);
        width:12px; height:76%;
        background:linear-gradient(180deg,var(--bd-gold-1),var(--bd-gold-2));
        border:2px solid var(--bd-stroke); border-right:none; border-radius:10px 0 0 10px;
        box-shadow:0 0 0 1px var(--bd-highlight) inset;
      }
      .oni-octopath .pager{
        position:absolute; display:flex; align-items:center; justify-content:space-between;
        gap:8px; pointer-events:auto;
        font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
        color:var(--bd-ink-soft); font-weight:800; letter-spacing:.32px; text-transform:uppercase;
        z-index:2;
      }
      .oni-octopath .pager .title{
        padding:6px 10px; border-radius:10px;
        background:linear-gradient(180deg,var(--bd-parchment-top),var(--bd-parchment-bot));
        border:2px solid var(--bd-stroke);
        box-shadow:0 3px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
        font-size:12.5px;
      }
      .oni-octopath .pager .arrow{
        width:24px; height:24px; border-radius:7px; display:grid; place-items:center;
        background:linear-gradient(180deg,var(--bd-gold-1),var(--bd-gold-2));
        border:2px solid var(--bd-stroke); cursor:pointer; user-select:none;
        box-shadow:0 2px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
        color:#221b14; font-weight:900; font-size:13px;
        transition:transform .1s ease, filter .1s ease;
      }
      .oni-octopath .pager .arrow:hover{ transform:translateY(-1px); filter:brightness(1.05) }
      .oni-octopath .pager .arrow:active{ transform:translateY(0) scale(.98) }

      /* Budget label (Phase 2a): same parchment+gold language as .pager .title,
         smaller and with a coloured pip on the left to signal action kind.
         Width is matched to the pager's full span via JS so the box aligns
         with the left arrow on the left and the right arrow on the right. */
      .oni-octopath .budget-label{
        position:absolute; display:flex; align-items:center; gap:8px;
        padding:5px 12px 5px 12px;
        border-radius:10px;
        box-sizing:border-box;
        font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
        color:var(--bd-ink-soft);
        font-weight:800; letter-spacing:.32px; text-transform:uppercase;
        font-size:11px;
        background:linear-gradient(180deg,var(--bd-parchment-top),var(--bd-parchment-bot));
        border:2px solid var(--bd-stroke);
        box-shadow:0 3px 0 var(--bd-shadow), 0 0 0 1px var(--bd-highlight) inset;
        text-shadow:0 1px 0 var(--bd-highlight);
        white-space:nowrap;
        pointer-events:none;
        z-index:2;
        opacity:0;
        transition:opacity 200ms ease-out, filter 150ms ease, color 150ms ease;
      }
      .oni-octopath .budget-label::before{
        content:""; width:8px; height:8px; border-radius:50%;
        background:linear-gradient(180deg,var(--bd-gold-1),var(--bd-gold-2));
        border:1.5px solid var(--bd-stroke);
        box-shadow:0 0 0 1px var(--bd-highlight) inset;
        flex-shrink:0;
      }
      .oni-octopath .budget-label .uses{
        margin-left:auto; padding-left:8px;
        opacity:.75; font-weight:700; letter-spacing:.2px; text-transform:none;
      }
      .oni-octopath .budget-label.is-grant::before{
        background:linear-gradient(180deg,#cba7e8,#9c6cc7);
      }
      .oni-octopath .budget-label.is-empty{
        filter:saturate(.45) brightness(.94);
        color:#8a7466;
      }
      .oni-octopath .budget-label.is-empty::before{
        background:linear-gradient(180deg,#b1a89a,#8a7d68);
      }
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
        // Foundry v12 namespaced AudioHelper under foundry.audio.
        // Prefer the namespaced version when available; fall back to
        // the global only when running on older cores.
        const A = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
        A?.play({ src: s.open, volume: SFX_VOL, autoplay: true, loop: false }, true);
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

  // Helper to run a Macro by name mapped from button label.
  // `spawnToken` is the token the menu was spawned for — passing it lets us
  // ensure the GM's selection matches the menu owner before the macro runs.
  // The downstream Command Button macros (Attack, Skill, Spell, …) all
  // re-resolve attacker from canvas.tokens.controlled[0], so a stale or
  // mismatched selection would either fire the wrong actor or hard-block at
  // the ADF turn gate. Auto-selecting on click eliminates that drift without
  // having to plumb an attacker payload through every command macro.
  async function runByButtonLabel(label, spawnToken) {
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

    if (spawnToken && !spawnToken.destroyed && !spawnToken.controlled) {
      try { spawnToken.control({ releaseOthers: true }); }
      catch (e) { console.warn("[Turn UI] Failed to auto-select spawning token", e); }
    }

    try {
      await macro.execute();
    } catch (err) {
      console.error(`[Turn UI] Failed executing "${macroName}"`, err);
      ui.notifications.error(`Error running "${macroName}". See console.`);
    }
  }

  function spawnButtonsForToken(token, opts = {}) {
    // Multi-instance: when `opts.menuId` is set (and ≠ "turn-action"),
    // this is an additional named menu (e.g. a reactor's reaction menu).
    // It is stored in `state.menus` so it coexists with the turn-action
    // singleton and with other named menus. The legacy turn-action menu
    // (no menuId or menuId === "turn-action") keeps using `state.buttons`.
    const menuId = String(opts.menuId ?? "turn-action");
    const isNamedMenu = menuId !== "turn-action";

    if (isNamedMenu) {
      // Replace any prior instance of this same menuId (refresh-in-place).
      removeButtons({ menuId });
    } else {
      removeButtons();
    }
    ensureBaseStyles();
    playSfxOpen();

    // Data-driven items support. When `opts.pages` is provided, use those
    // pages verbatim; each item may be a string (legacy turn-action shape
    // for back-compat) or an object `{ label, icon?, tooltip?, onPick?,
    // enabled?, isSkip? }`. When `opts.pages` is absent, fall back to the
    // hardcoded turn-action pages.
    const LEGACY_PAGES = [
      { name: "Actions", items: ["Attack","Guard","Skill","Spell","Item"] },
      { name: "System",  items: ["Equipment","Study","Hinder","Objective","Switch"] }
    ];
    const PAGES = (Array.isArray(opts.pages) && opts.pages.length ? opts.pages : LEGACY_PAGES)
      .map(p => ({
        name: p?.name ?? "",
        items: (Array.isArray(p?.items) ? p.items : Array.isArray(p?.cmds) ? p.cmds : [])
          .map(it => typeof it === "string" ? { label: it } : (it ?? { label: "" }))
      }));
    let pageIndex = 0;

    // Free-action filter: when an `enabledLabels` set is provided,
    // every button whose label isn't in the set renders disabled
    // (grayed out + click-blocked). Used by the Acceleration reaction's
    // `open_action_menu` effect to gate the menu to "Attack" + "Spell".
    const enabledLabels = Array.isArray(opts.enabledLabels) && opts.enabledLabels.length
      ? new Set(opts.enabledLabels.map(s => String(s)))
      : null;
    const isLabelEnabled = (label) => !enabledLabels || enabledLabels.has(label);
    const freeMode = !!opts.freeMode;

    // Budget-label override: when the caller knows what label this menu
    // represents (e.g. "Acceleration" for a free-action menu spawned by
    // reaction-grant), it's passed in here as the single source of truth
    // for the menu's lifetime. updateBudgetLabel renders it verbatim with
    // is-grant styling and skips all dynamic budget computation. When
    // absent, the label is derived dynamically from turn state.
    const budgetLabelOverride = (typeof opts.budgetLabel === "string" && opts.budgetLabel.trim())
      ? opts.budgetLabel.trim()
      : null;

    const root  = document.createElement("div");
    // CSS is class-scoped (`.oni-octopath ...`) so multiple menus can
    // coexist on the same page. Each menu still gets a unique id for
    // ergonomic debugging (`oni-octopath` for the turn-action singleton,
    // `oni-octopath--<menuId>` for named menus).
    root.className = "oni-octopath";
    // Caller-supplied modifier classes — used by reaction menus to pull
    // in extra padding via `.oni-octopath.is-reaction-menu .blade`, and
    // available to any future menu variant that wants its own styling.
    const extraClasses = Array.isArray(opts.menuClass)
      ? opts.menuClass.filter(Boolean).map(String)
      : (typeof opts.menuClass === "string" && opts.menuClass.trim() ? [opts.menuClass.trim()] : []);
    for (const cls of extraClasses) root.classList.add(cls);
    root.id        = isNamedMenu
      ? "oni-octopath--" + menuId.replace(/[^A-Za-z0-9_-]/g, "_")
      : "oni-octopath";
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

    // Budget label (Phase 2a): shows what kind of action the next button click
    // will consume — base turn action, a named bonus grant (e.g. Acceleration),
    // or "No Action Left" when the budget is exhausted. Uses the same parchment
    // + gold-pip styling as .pager .title; pip switches colour/state via the
    // `.is-grant` / `.is-empty` modifier classes set in updateBudgetLabel().
    const budgetLabel = document.createElement("div");
    budgetLabel.className = "budget-label";
    const budgetMain = document.createElement("span");
    const budgetUses = document.createElement("span");
    budgetUses.className = "uses";
    budgetLabel.append(budgetMain, budgetUses);
    root.appendChild(budgetLabel);

    // Pager / budget label visibility — data-driven menus can opt out.
    // Pager auto-hides when there's nothing to flip between.
    const hidePager = !!opts.hidePager || PAGES.length <= 1;
    if (hidePager) pager.style.display = "none";
    if (opts.hideBudgetLabel) budgetLabel.style.display = "none";

    document.body.appendChild(root);

    const DURATION_MS = 360, STAGGER_MS = 30, SPIN_DEG = 360, SCALE_MIN = 0.93;
    // Phase 2a: budget label sits between pager and the first button (Attack).
    // Vertical position is computed from each element's actual offsetHeight
    // (not from rowH multiples) so the gaps are honest visible whitespace
    // regardless of font metrics, padding tweaks, or DPI.
    //   Attack top edge ─ LABEL_TO_ATTACK_GAP ─ label bottom
    //   label top edge  ─ PAGER_TO_LABEL_GAP  ─ pager bottom
    const EDGE_PAD_X = 12, EDGE_PAD_Y = 50, GAP_PX = 6;
    const LABEL_TO_ATTACK_GAP = 10;  // visible px between label box and Attack box
    const PAGER_TO_LABEL_GAP  = 8;   // visible px between pager box and label box
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

      const ITEMS = PAGES[pageIndex].items;
      for (let i = 0; i < ITEMS.length; i++) {
        const spec = ITEMS[i];
        const label = String(spec.label ?? "");
        const wrap = document.createElement("div"); wrap.className = "item";
        const btn = document.createElement("div"); btn.className = "blade";
        if (spec.isSkip) btn.classList.add("is-skip");
        const iconHTML = spec.icon
          ? `<img class="icon" src="${spec.icon}" alt="" draggable="false">`
          : "";
        btn.innerHTML = `${iconHTML}<span class="label">${label}</span>`;
        btn.style.pointerEvents = "none";
        if (spec.tooltip) btn.title = String(spec.tooltip);

        // Two distinct disable paths:
        //   - `spec.enabled === false` — item-level disable (e.g. a
        //     reaction whose cost check fizzled). Click is dead.
        //   - `isLabelEnabled(label) === false` — free-action filter
        //     (Acceleration whose enabledLabels gate only "Attack" + "Spell").
        const enabled = (spec.enabled !== false) && isLabelEnabled(label);
        if (!enabled) {
          btn.classList.add("fu-free-action-disabled");
          // Caller-supplied disable reason — e.g. reactions whose charge
          // AE has been consumed pass `usedReason: "Used"` so we render
          // a stamp-style overlay rather than the generic grey-out.
          if (spec.usedReason) {
            btn.classList.add("is-used");
            btn.setAttribute("data-used-reason", String(spec.usedReason));
          }
          if (!spec.tooltip) {
            btn.title = spec.usedReason
              ? String(spec.usedReason)
              : (freeMode && enabledLabels
                  ? "Free action available only for: " + Array.from(enabledLabels).join(", ")
                  : "Disabled");
          }
        }

        wrap.appendChild(btn); root.appendChild(wrap);
        items.push({ wrap, btn, tStart: 0, slotX: 0, slotY: 0, bound: false, label, enabled, spec });
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
        // Reset widths so we measure natural content widths first; page
        // flips (Actions ↔ System) can shrink/grow the pager title.
        pager.style.width = "";
        budgetLabel.style.width = "";

        // Build the stack bottom-up from the Attack button's top edge,
        // using each container's real offsetHeight so the visible gaps
        // match the constants above (not approximate row-height fractions).
        // Items use transform:translate(0,-50%) so item.slotY is their
        // CENTRE — Attack's top edge is slotY - (itemHeight / 2).
        const itemH = hProbe;
        const pagerH = pager.offsetHeight || 28;
        const labelH = budgetLabel.offsetHeight || 24;

        const attackTopY  = first.slotY - itemH / 2;
        const labelBotY   = attackTopY - LABEL_TO_ATTACK_GAP;
        const labelTopY   = labelBotY - labelH;
        const pagerBotY   = labelTopY - PAGER_TO_LABEL_GAP;
        const pagerTopY   = pagerBotY - pagerH;

        pager.style.left       = `${first.slotX}px`;
        pager.style.top        = `${pagerTopY}px`;
        budgetLabel.style.left = `${first.slotX}px`;
        budgetLabel.style.top  = `${labelTopY}px`;

        // Match left/right edges by stretching both to whichever is wider.
        const pw = pager.offsetWidth;
        const lw = budgetLabel.offsetWidth;
        const maxW = Math.max(pw, lw);
        if (maxW > 0) {
          pager.style.width = `${maxW}px`;
          budgetLabel.style.width = `${maxW}px`;
        }
      }
    }

    function updateBudgetLabel() {
      const actor = token?.actor ?? null;
      const emitterApi = globalThis.FUCompanion?.api?.fabulaInitiativeTurnEmitter ?? null;
      const bonusApi = globalThis.FUCompanion?.api?.bonusActions ?? null;

      const ts = emitterApi?.getTurnState?.() ?? null;
      const used = Number(ts?.actionsUsedThisTurn ?? 0) || 0;
      const base = Number(ts?.baseActionsPerTurn ?? 1) || 1;

      // Reset modifier classes; default state is "base/turn action" (gold pip).
      budgetLabel.classList.remove("is-grant", "is-empty");

      // Caller-supplied budget label (e.g. Acceleration's free-action menu
      // passes "Acceleration"). When present, render it verbatim and skip
      // dynamic budget computation — the menu's label is the caller's
      // responsibility for the menu's whole lifetime, not a derived value
      // that races with store updates / AE lookups / turn-state writes.
      if (budgetLabelOverride) {
        budgetMain.textContent = budgetLabelOverride;
        budgetUses.textContent = "";
        budgetLabel.classList.add("is-grant");
        return;
      }

      if (used < base) {
        budgetMain.textContent = "Turn Action";
        budgetUses.textContent = "";
      } else {
        const grants = (actor && bonusApi)
          ? (bonusApi.findApplicable(actor, { condition: "in_turn" }) ?? [])
          : [];
        if (grants.length) {
          const g = grants[0];
          const label = g.spec?.sourceLabel ?? "Bonus";
          budgetMain.textContent = label;
          budgetUses.textContent = "";
          budgetLabel.classList.add("is-grant");
        } else {
          budgetMain.textContent = "No Action Left";
          budgetUses.textContent = "";
          budgetLabel.classList.add("is-empty");
        }
      }
    }

    // Initial state + reveal
    updateBudgetLabel();
    requestAnimationFrame(() => { budgetLabel.style.opacity = "1"; });

    // Refresh hooks: turnState changes via combat flag write, plus grant
    // AE lifecycle on the current actor.
    const currentActorUuid = token?.actor?.uuid ?? null;
    const matchesActor = (effect) => {
      const aUuid = effect?.parent?.uuid ?? null;
      return !!aUuid && aUuid === currentActorUuid;
    };
    const h3 = Hooks.on("updateCombat", (combat, changed) => {
      if (!combat || combat.id !== game.combat?.id) return;
      if (!changed || !("flags" in changed)) return;
      updateBudgetLabel();
    });
    const h4 = Hooks.on("createActiveEffect", (effect) => {
      if (!matchesActor(effect)) return;
      updateBudgetLabel();
    });
    const h5 = Hooks.on("updateActiveEffect", (effect) => {
      if (!matchesActor(effect)) return;
      updateBudgetLabel();
    });
    const h6 = Hooks.on("deleteActiveEffect", (effect) => {
      if (!matchesActor(effect)) return;
      updateBudgetLabel();
    });

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

          if (it.enabled === false) {
            // Disabled (filter-blocked) buttons stay click-dead.
            it.btn.style.pointerEvents = "none";
          } else {
            // Click priority:
            //   1) `spec.onPick(spec, token)` — per-item callback (used by
            //      data-driven menus, e.g. reactions wiring each item to
            //      a specific reaction skill UUID).
            //   2) `opts.onPick(spec, token)` — caller-level fallback.
            //   3) Legacy: macro lookup by button label (turn-action).
            it.btn.addEventListener("click", async (ev) => {
              ev.stopPropagation();
              try {
                if (typeof it.spec?.onPick === "function") {
                  await it.spec.onPick(it.spec, token);
                } else if (typeof opts.onPick === "function") {
                  await opts.onPick(it.spec, token);
                } else {
                  await runByButtonLabel(it.label, token);
                }
              } catch (err) {
                console.error("[Turn UI Manager] menu item click handler threw:", err);
              }
            });
            it.btn.style.pointerEvents = "auto";
          }
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
      Hooks.off("updateCombat", h3);
      Hooks.off("createActiveEffect", h4);
      Hooks.off("updateActiveEffect", h5);
      Hooks.off("deleteActiveEffect", h6);
      window.removeEventListener("keydown", keyListener, true);
      try { root.remove(); } catch {}
    }

    // Store everything we need for later animated hide.
    const rec = {
      root,
      cleanup,
      items,
      ticker,
      tickFn,
      h1,
      h2,
      keyListener,
      menuId,
      isNamedMenu,
      isHiding: false,
      hideRaf: null
    };
    if (isNamedMenu) {
      TurnUI.state.menus.set(menuId, rec);
    } else {
      TurnUI.state.buttons = rec;
    }
  }

        function removeButtons(options = {}) {
    const { clearToken = false, animate = false, menuId = null } = options;

    // Named-menu removal: lookup by menuId in the multi-instance map.
    // No animation pipeline, no turn-ui lifecycle side-effects — just
    // run the menu's own cleanup and forget it.
    if (menuId && menuId !== "turn-action") {
      const namedRec = TurnUI.state.menus.get(menuId);
      if (!namedRec) return;
      try { namedRec.cleanup(); } catch {}
      TurnUI.state.menus.delete(menuId);
      return;
    }

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
    // Turn-handoff branches must preserve named menus so in-flight
    // reaction menus (which belong to the reaction-window lifecycle,
    // not the turn lifecycle) survive whose-turn-is-it changes.
    if (!cmbt) { clearAllUI({ preserveNamedMenus: true }); return; }

    const tokenId = cmbt.tokenId ?? cmbt.token?.id;
    const token = byIdOnCanvas(tokenId);

    // If token isn't on this scene/canvas, just clear
    if (!token) { clearAllUI({ preserveNamedMenus: true }); return; }

    // If we're already showing UI for this token AND it's actually visible,
    // skip re-spawn. The buttons/indicator check catches the case where
    // hideUIForAnimation hid the UI and showUIAfterAnimation never arrived
    // (Alt-Tab mid-animation, dropped socket packet, etc.) — without this
    // guard the next turn change wouldn't recover because currentTokenId
    // would still match.
    if (
      TurnUI.state.currentTokenId === token.id &&
      (TurnUI.state.buttons || TurnUI.state.indicator)
    ) return;

    // Swap to new turn owner. Keep named menus (reaction menus,
    // ally-indicator rows) — they're tied to in-flight reaction
    // sub-windows whose lifetime is independent of whose turn it is.
    // Bandit's attack against Hina can spawn an HoD reaction menu on
    // Hina that needs to outlive the moment Bandit's turn ends.
    clearAllUI({ preserveNamedMenus: true });
    TurnUI.state.currentTokenId = token.id;
    const ourTokenId = token.id;

    // Defer the turn-action menu spawn until any start-of-turn reaction
    // prompts have settled — otherwise the action menu and the reaction
    // menu (e.g. Heart of Darkness on a crisis turn-owner, or an
    // Aggressive Stance pill) compete for input at the same instant.
    //
    // Why: this script's updateCombat listener is registered BEFORE
    // reaction-phaseHandler's (load order in module.json), so when the
    // hook fires, we run first and reach this point synchronously,
    // before the phase handler has had a chance to call
    // emitPhaseSequential. A `setTimeout(0)` lets the rest of the hook
    // loop and the reaction system's sync setup finish, after which
    // `_phaseChain` reflects the in-flight lifecycle promise (GM-side
    // only — non-GM clients never chain, so their wait is a no-op).
    await awaitReactionsSettled(ourTokenId);
    if (TurnUI.state.currentTokenId !== ourTokenId) return;

    const stillToken = byIdOnCanvas(ourTokenId);
    if (!stillToken) return;
    forLocalClient_spawnWhat(stillToken);
  }

  // Block until any in-flight reaction lifecycle phase (and any reaction
  // menus this client has open) finishes — so the turn-action menu doesn't
  // spawn on top of a still-open reaction prompt. `ourTokenId` is the
  // currentTokenId we captured before yielding; we abort the wait if a
  // subsequent turn change supersedes us mid-await.
  async function awaitReactionsSettled(ourTokenId, opts = {}) {
    const totalTimeoutMs = Number.isFinite(opts.totalTimeoutMs) ? opts.totalTimeoutMs : 30000;
    const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 100;

    // Yield a full task so reaction-phaseHandler's updateCombat listener
    // runs and the reaction-window's `_phaseChain` is updated to the new
    // lifecycle promise. After this, `waitForIdle` is meaningful.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (TurnUI.state.currentTokenId !== ourTokenId) return;

    const deadline = Date.now() + totalTimeoutMs;
    try {
      const rs = globalThis.FUCompanion?.api?.reactionSystem;
      if (rs?.waitForIdle) {
        const remaining = Math.max(0, deadline - Date.now());
        if (remaining > 0) await rs.waitForIdle({ timeoutMs: remaining });
      }
    } catch (e) {
      console.warn("[Turn UI Manager] waitForIdle threw — proceeding to spawn.", e);
    }
    if (TurnUI.state.currentTokenId !== ourTokenId) return;

    // Defensive drain for non-GM clients (whose `_phaseChain` is always
    // idle): if a reaction pill / picker arrived via socket and is still
    // open, hold the turn-action menu back until it closes. Bounded by
    // the shared deadline so a stuck pill can't deadlock the turn UI.
    while (TurnUI.state.menus.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (TurnUI.state.currentTokenId !== ourTokenId) return;
    }
  }

    function clearAllUI({ preserveNamedMenus = false } = {}) {
    TurnUI.state.currentTokenId = null;
    removeButtons();
    // Tear down any named menus too (reaction menus, etc.) — these
    // outlive the turn-action menu on their own schedule but must not
    // survive combat end / scene change. On a normal turn handoff,
    // skip this loop so reaction menus mid-flight survive.
    if (!preserveNamedMenus) {
      for (const namedId of Array.from(TurnUI.state.menus.keys())) {
        try { removeButtons({ menuId: namedId }); } catch (_) {}
      }
    }
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

      // Budget gate: if this token is the active combatant AND their action
      // budget is exhausted AND no in-turn grants remain, don't respawn the
      // action menu. The consume hook in action-execution-core also ends the
      // Lancer activation in this state — that triggers handleTurnChange to
      // clear UI fully — but checking here preempts a brief visual flash
      // between respawn and turn-change clear.
      try {
        const turnEmitter = globalThis.FUCompanion?.api?.fabulaInitiativeTurnEmitter ?? null;
        const bonusApi    = globalThis.FUCompanion?.api?.bonusActions ?? null;
        const actor       = token?.actor ?? null;
        const currentCombatantActorUuid = game.combat?.combatant?.actor?.uuid ?? null;
        if (actor && currentCombatantActorUuid && actor.uuid === currentCombatantActorUuid) {
          const ts = turnEmitter?.getTurnState?.() ?? null;
          const used = Number(ts?.actionsUsedThisTurn ?? 0) || 0;
          const base = Number(ts?.baseActionsPerTurn ?? 1) || 1;
          if (used >= base) {
            const grants = bonusApi?.findApplicable?.(actor, { condition: "in_turn" }) ?? [];
            if (!grants.length) {
              console.log("[Turn UI Manager] showUIAfterAnimation: budget exhausted + no grants — skipping menu respawn.");
              return;
            }
          }
        }
      } catch (gateErr) {
        console.warn("[Turn UI Manager] showUIAfterAnimation budget-gate failed (non-fatal); respawning anyway.", gateErr);
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
  // Exposed so the reaction system's `open_action_menu` effect_kind
  // (Acceleration's free action) can spawn the Octopath menu over an
  // arbitrary token with a button filter.
  TurnUI.spawnButtonsForToken = spawnButtonsForToken;
  // Exposed so macros that consume a free-action grant outside the ADF
  // pipeline (e.g. Study) can close the menu after the user's pick. The
  // ADF-driven actions get this for free via the post-action cleanup; the
  // out-of-pipeline cases need to call this directly.
  TurnUI.removeButtons = removeButtons;

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

  // 3a) On canvasReady: re-sync UI to current combat state.
  //     This is the recovery path for "after page refresh, no buttons":
  //     when Hooks.once("ready") fires, canvas tokens may not yet be on the
  //     scene — handleTurnChange's byIdOnCanvas returns null, clearAllUI
  //     wipes state, and nothing else triggers a retry. canvasReady fires
  //     once the canvas (and its tokens) are actually drawn, so we replay
  //     the current-combatant check from a fresh state.
  //
  //     We force-reset currentTokenId so the dedup in handleTurnChange
  //     doesn't short-circuit when the UI is missing but state thinks it
  //     should be visible.
  Hooks.on("canvasReady", () => {
    const c = game.combats?.active ?? game.combat ?? null;
    if (!c?.combatant) {
      if (TurnUI.state.currentTokenId || TurnUI.state.buttons || TurnUI.state.indicator) {
        clearAllUI();
      }
      return;
    }
    TurnUI.state.currentTokenId = null;
    handleTurnChange(c);
  });

  // 3b) On ready: initialize + install socket listeners
  Hooks.once("ready", () => {
    cacheSFX();
    const c = game.combats?.active;
    if (c && (c.started || (c.round ?? 0) > 0)) {
      // Fire once to match current state. If canvas isn't ready yet, this
      // will no-op (byIdOnCanvas returns null) and the canvasReady hook
      // above will retry.
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

      // NOTE: the legacy `game.socket.on("world", ...)` listener was removed.
      // "world" is Foundry's reserved core event (triggers host world
      // re-serialization); the sender now broadcasts ONI_TURNUI_* on the module
      // channel above. See reaction-phaseHandler.js for the full rationale.
    }
  });

  console.debug("[Turn UI Manager] Installed.");
})();
