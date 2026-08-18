/**
 * [ONI] Opportunity System — Manager v2
 *
 * Core API: globalThis.ONI.OpportunitySystem
 *
 * Trigger paths:
 *   - Action pipeline:  opportunity-action-hook.js → offer() on attacker-owner client
 *   - CheckRequester:   cr-api.js → processCheckCrits() on GM (awaited before reactions)
 *   - Check Roller:     CheckRoller pipeline step (after "render") → offer() locally
 *
 * Two-phase flow:
 *   PROMPT PHASE  — all user decisions (picker + effect pre handler)
 *   RESOLUTION    — banner animation + effect post handler + chat card
 *                   No user interaction occurs after the prompt phase.
 *
 * Socket messages (OPP_ prefix, module.fabula-ultima-companion channel):
 *   OPP_OFFER     GM → all (targetUserId filter) — send picker to a specific player
 *   OPP_PICKED    player → all (GM processes)    — player confirmed a choice
 *   OPP_CANCELLED player → all (GM processes)    — player declined
 *   OPP_DRAMATIC  GM → all                       — trigger dramatic text animation on all clients
 */
(() => {
  const TAG       = "[ONI][OpportunitySystem]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_OPPORTUNITY_MANAGER__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  const MSG_OFFER     = "OPP_OFFER";
  const MSG_PICKED    = "OPP_PICKED";
  const MSG_CANCELLED = "OPP_CANCELLED";
  const MSG_DRAMATIC   = "OPP_DRAMATIC";
  const MSG_LOG_BANNER = "OPP_LOG_BANNER";
  // Spectator mirror — pure UI, carries no authority over the outcome.
  const MSG_SPEC_OPEN  = "OPP_SPEC_OPEN";
  const MSG_SPEC_SEL   = "OPP_SPEC_SEL";
  const MSG_SPEC_CLOSE = "OPP_SPEC_CLOSE";
  // GM take-control hand-over (request / ack / final result)
  const MSG_TAKEOVER     = "OPP_TAKEOVER";
  const MSG_TAKEOVER_ACK = "OPP_TAKEOVER_ACK";
  const MSG_RESOLVED     = "OPP_RESOLVED";

  const DRAMATIC_DURATION = 2800; // ms — must match the CSS animation duration

  // Log banner timing + position — all `let` so the tuner can change them live
  let _bannerEnterMs  = 750;
  let _bannerLingerMs = 2500;
  let _bannerExitMs   = 410;
  let _bannerTopPx    = 100;  // px from top of viewport (inline on element)
  let _bannerWidthPx  = 300;  // 0 = auto (content-driven); >0 = fixed px width
  let _bannerHeightPx = 0;    // 0 = auto; >0 = fixed px height
  // Computed total used in applyAndAnnounce — always reads live vars
  const bannerTotalMs = () => _bannerEnterMs + _bannerLingerMs + _bannerExitMs;
  const SFX_DRAMATIC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Metal_Shing.mp3";
  const SFX_BANNER   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_menu.wav";
  const SFX_CONFIRM  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_confirmed.wav";

  function playSound(url, vol = 0.65) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── Dependency shortcuts ────────────────────────────────────────────────────
  const getConfig   = () => window["oni.OpportunityConfig"];
  const getDialog   = () => window["oni.OpportunityDialog"];
  const getChatCard = () => window["oni.OpportunityChatCard"];
  const getEffects  = () => window["oni.OpportunityEffects"];

  // ── Stagger delay ───────────────────────────────────────────────────────────
  // ms to wait before the picker appears after a crit is detected.
  // Gives players time to register their roll result before the menu interrupts.
  // Readable/writable via ONI.OpportunitySystem.staggerMs at runtime.
  let _staggerMs = 800;   // delay BEFORE the "Opportunity!" animation fires

  // ── In-flight offer tracking ────────────────────────────────────────────────
  const _pending = new Map(); // offerKey → { resolve, actorUuid }

  // A monotonic suffix keeps chained offers distinct even inside one millisecond
  // (A Million Possibility fires three pickers off the same action card). The key
  // is now an identity the mirror, the hand-over and the resolution guard all
  // key off — collisions there would cross-wire two separate opportunities.
  let _offerSeq = 0;
  function makeOfferKey(actorUuid, actionCardId) {
    return `${actionCardId ?? actorUuid}-${Date.now()}-${++_offerSeq}`;
  }

  // ── Spectator mirror ────────────────────────────────────────────────────────
  // Whoever runs the picker broadcasts open/select/close; every OTHER client
  // renders a read-only wheel so the table can watch the pick instead of sitting
  // through a silent pause.
  //
  // The picker client broadcasts directly — this is NOT relayed through the GM.
  // A player client already emits OPP_DRAMATIC the same way, and the mirror has
  // to work outside combat (CheckRoller / CheckRequester) where BD's GM-owned
  // intent channel doesn't exist.
  let _specOfferKey = null;   // offerKey of the mirror currently up on THIS client

  // Only the fields the wheel actually renders — keeps the broadcast small.
  const specOptions = options => (options ?? []).map(o => ({
    id:          o.id,
    label:       o.label,
    description: o.description,
    icon:        o.icon,
    color:       o.color,
    hasPrePhase: !!o.hasPrePhase,
  }));

  // ── GM take-control hand-over ───────────────────────────────────────────────
  // When the owner can't operate their own menu, a GM claims the wheel. Exactly
  // one client drives at any moment, enforced by an explicit request → ack
  // handshake rather than by letting both wheels run and racing the confirm:
  //
  //   GM  OPP_TAKEOVER ──▶ picker client aborts its wheel
  //   GM ◀── OPP_TAKEOVER_ACK  granted + the offer's context
  //   GM  opens its own wheel under the SAME offerKey (everyone re-mirrors)
  //   GM  OPP_RESOLVED ──▶ releases whoever was awaiting the offer
  //
  // A granted ack is the ONLY thing that lets the GM open a wheel, so an owner
  // who confirms first simply answers granted:false and keeps their pick.
  const TAKEOVER_ACK_MS  = 4_000;    // how long the GM waits for the owner's ack
  const TAKEOVER_WAIT_MS = 180_000;  // how long a handed-over caller awaits the result

  let _liveOffer   = null;  // this client's own in-flight prompt phase
  let _takeoverReq = null;  // { offerKey, timer } — this GM's outstanding request

  const _awaitingTakeover = new Map(); // offerKey → { resolve, timer }

  // One resolution per offer, ever. The hand-over path can in principle reach
  // applyAndAnnounce from two directions (the GM that claimed the wheel, and an
  // owner whose confirm landed in the same tick as the abort).
  const _resolvedKeys = new Set();
  function claimResolution(offerKey) {
    if (!offerKey) return true;                    // keyless local calls (test helpers)
    if (_resolvedKeys.has(offerKey)) return false;
    _resolvedKeys.add(offerKey);
    if (_resolvedKeys.size > 200) {                // bounded — one key per crit
      const it = _resolvedKeys.values();
      for (let i = 0; i < 50; i++) _resolvedKeys.delete(it.next().value);
    }
    return true;
  }

  // Keep a handed-over caller's await alive until the GM reports back, so the
  // pipeline that asked for this opportunity still sees the real result.
  function waitForTakeover(offerKey) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        _awaitingTakeover.delete(offerKey);
        console.warn(TAG, `take-over never reported back for key=${offerKey}`);
        resolve({ cancelled: true });
      }, TAKEOVER_WAIT_MS);
      _awaitingTakeover.set(offerKey, { resolve, timer });
    });
  }

  function requestTakeover(offerKey) {
    if (!offerKey || !game.user?.isGM || _takeoverReq) return;
    const timer = setTimeout(() => {
      _takeoverReq = null;
      ui.notifications?.warn("[Opportunity] No answer from the picker's client — take-control cancelled.");
      getDialog()?.setSpectatorTakeControl?.({ enabled: true });
    }, TAKEOVER_ACK_MS);
    _takeoverReq = { offerKey, timer };
    game.socket.emit(SOCKET_CH, {
      type:    MSG_TAKEOVER,
      payload: { offerKey, gmUserId: game.user.id, gmName: game.user.name },
    });
  }

  // Release every promise waiting on this offer — the local one (if this GM
  // routed it) and any remote one (the ex-owner, or the other GM).
  function announceResolved({ offerKey, optionId = null, cancelled = false }) {
    const result  = cancelled ? { cancelled: true } : { optionId };
    const pending = _pending.get(offerKey);
    if (pending) { _pending.delete(offerKey); pending.resolve(result); }
    game.socket.emit(SOCKET_CH, { type: MSG_RESOLVED, payload: { offerKey, optionId, cancelled } });
  }

  // Runs on the GM once the owner has granted the wheel.
  async function runTakeover({ offerKey, actorUuid, actorName, context = {}, excludeIds = [], title = null }) {
    const picked = await runPromptPhase({ actorName, actorUuid, context, excludeIds, title, offerKey })
      .catch(e => { console.error(TAG, "Take-over prompt phase error:", e); return { cancelled: true }; });

    if (picked.takenOver) return;   // the other GM took it off us — it's theirs now

    if (picked.cancelled) {
      announceResolved({ offerKey, cancelled: true });
      return;
    }

    await applyAndAnnounce({ actorUuid, actorName, optionId: picked.optionId, context, preResult: picked.preResult, offerKey })
      .catch(e => console.error(TAG, "applyAndAnnounce error (take-over):", e));
    announceResolved({ offerKey, optionId: picked.optionId });
  }

  // Live-selection echo. Leading edge fires immediately so the mirrored cursor
  // feels attached to the owner's input; further moves inside the window
  // collapse into one trailing emit, so spinning the wheel can't flood the
  // socket (a fast scroll is already throttled to ~5/s client-side, but the
  // keyboard isn't).
  function makeSelectionEmitter(offerKey) {
    if (!offerKey) return null;
    const MIN_GAP = 120;
    let lastAt = 0, timer = null, queued = null;

    const send = sel => {
      lastAt = Date.now();
      game.socket.emit(SOCKET_CH, { type: MSG_SPEC_SEL, payload: { offerKey, sel } });
    };

    return sel => {
      queued = sel;
      if (timer) return;
      const wait = MIN_GAP - (Date.now() - lastAt);
      if (wait <= 0) { send(queued); queued = null; return; }
      timer = setTimeout(() => {
        timer = null;
        if (queued !== null) { send(queued); queued = null; }
      }, wait);
    };
  }

  // ── Actor portrait resolution ───────────────────────────────────────────────
  async function resolvePortrait(actorUuid) {
    if (!actorUuid) return "icons/svg/mystery-man.svg";
    try {
      const doc   = await fromUuid(actorUuid);
      const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
      if (!actor) return "icons/svg/mystery-man.svg";
      const std   = String(actor.system?.props?.sprite_standard ?? "").trim();
      const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
      const proto = String(actor.prototypeToken?.texture?.src ?? "").trim();
      return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
    } catch (_) {
      return "icons/svg/mystery-man.svg";
    }
  }

  // ── Actor owner resolution ──────────────────────────────────────────────────
  function resolveOwnerUserId(actorUuid) {
    if (!actorUuid) return null;
    const shortId = String(actorUuid).replace(/^Actor\./, "").replace(/^.*\.Actor\./, "");

    const worldActor = game.actors?.get(shortId);
    if (worldActor) {
      for (const [userId, level] of Object.entries(worldActor.ownership ?? {})) {
        if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
          const user = game.users?.get(userId);
          if (user && !user.isGM) return userId;
        }
      }
      return null;
    }

    for (const t of (canvas?.tokens?.placeables ?? [])) {
      if (t.actor?.uuid === actorUuid || t.document?.actorId === shortId) {
        const actor = t.actor;
        if (!actor) continue;
        for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
          if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
            const user = game.users?.get(userId);
            if (user && !user.isGM) return userId;
          }
        }
        return null;
      }
    }
    return null;
  }

  // ── Multi-GM host gate (dedupe) ─────────────────────────────────────────────
  // The game normally runs two GM clients (main GM + Co-DM). Foundry delivers
  // every socket broadcast to BOTH, so any GM-side resolution handler runs twice
  // unless it's gated to a single "host" GM. This returns true only on the
  // primary active GM (core's game.users.activeGM, i.e. the lowest-id active GM),
  // with an id-sort fallback for core versions that lack activeGM.
  // See the GM Host / Anti-Dedupe pattern (Idiom A).
  function isPrimaryGM() {
    if (!game.user?.isGM) return false;
    const active = game.users?.activeGM ?? null;
    if (active) return active.id === game.user.id;
    const firstGM = game.users
      ?.filter?.(u => u.isGM && u.active)
      ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0];
    return firstGM ? firstGM.id === game.user.id : true;
  }

  // ── Dramatic animation (plays locally on every client) ──────────────────────
  // Injects a one-shot CSS animation: bold option name flies left→center (slow)→right.
  const DRAMATIC_STYLE_ID = "oni-opp-dramatic-css";

  function ensureDramaticStyles() {
    if (document.getElementById(DRAMATIC_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = DRAMATIC_STYLE_ID;
    // Keyframe breakdown (linear timing):
    //   0 → 22%  : covers ~104 vw from left  → fast entry
    //   22 → 78% : covers ~12 vw at center   → dramatic 21× slowdown
    //   78 → 100%: covers ~104 vw to right   → fast exit
    s.textContent = `
      @keyframes oni-opp-dramatic-fly {
        0%   { transform: translate(-50%,-50%) translateX(-110vw) scale(0.88); opacity: 0; }
        6%   { opacity: 1; }
        22%  { transform: translate(-50%,-50%) translateX(-6vw)   scale(1.0); }
        50%  { transform: translate(-50%,-50%) translateX(0)       scale(1.06); }
        78%  { transform: translate(-50%,-50%) translateX(6vw)    scale(1.0); }
        94%  { opacity: 1; }
        100% { transform: translate(-50%,-50%) translateX(110vw)  scale(0.88); opacity: 0; }
      }
      @keyframes oni-opp-dramatic-bg {
        0%   { opacity: 0; }
        15%  { opacity: 0.55; }
        85%  { opacity: 0.55; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(s);
  }

  function playDramaticAnimation({ optionLabel, color }) {
    ensureDramaticStyles();

    // Sound
    try {
      (foundry.audio.AudioHelper ?? AudioHelper).play({ src: SFX_DRAMATIC, volume: 0.85, autoplay: true }, false);
    } catch (_) {}

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0",
      zIndex: "100030",
      pointerEvents: "none",
      overflow: "hidden",
    });

    // Extra darkening that fades in/out with the text
    const bg = document.createElement("div");
    Object.assign(bg.style, {
      position: "absolute", inset: "0",
      background: "rgba(0,0,0,.55)",
      animation: `oni-opp-dramatic-bg ${DRAMATIC_DURATION}ms linear both`,
    });
    overlay.appendChild(bg);

    // Flying text
    const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const text = document.createElement("div");
    Object.assign(text.style, {
      position:   "absolute",
      left:       "50%",
      top:        "50%",
      fontFamily: "'Palatino Linotype', Palatino, serif",
      fontSize:   "clamp(2.8rem, 7vw, 5.5rem)",
      fontWeight: "900",
      letterSpacing: ".14em",
      color:      color ?? "#fcd470",
      textTransform: "uppercase",
      whiteSpace: "nowrap",
      textShadow: [
        `0 0 40px ${color ?? "#fcd470"}`,
        `0 0 80px ${color ?? "#fcd470"}88`,
        "4px 4px 0 rgba(0,0,0,.65)",
        "0 2px 12px rgba(0,0,0,.9)",
      ].join(", "),
      animation:  `oni-opp-dramatic-fly ${DRAMATIC_DURATION}ms linear both`,
    });
    text.textContent = optionLabel ?? "";
    overlay.appendChild(text);

    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), DRAMATIC_DURATION + 150);
  }

  // ── JRPG log banner (confirmation panel at top of screen) ──────────────────
  const BANNER_STYLE_ID = "oni-opp-banner-css";

  function ensureBannerStyles() {
    if (document.getElementById(BANNER_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = BANNER_STYLE_ID;
    // Parchment panel floating near the top — NOT edge-anchored.
    // transform/opacity are driven entirely by JS for the horizontal slide + fade.
    s.textContent = `
      .oni-opp-log-banner {
        position: fixed;
        /* top is set inline by playLogBanner() so the tuner can adjust it */
        left: 50%;       /* centred; JS encodes x-offset into translateX */
        z-index: 100035;
        pointer-events: none;
        /* Warm parchment — matches wheel slot buttons */
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.40) 0%,
            rgba(255,255,255,.12) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.82);
        border-radius: 10px;
        box-shadow: 0 6px 22px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,248,232,.7);
        padding: 10px 22px;
        display: flex; align-items: center; justify-content: center; gap: 11px;
        white-space: nowrap;
      }
      .oni-opp-log-banner-icon  { font-size: 1.4rem; line-height: 1; flex-shrink: 0; }
      .oni-opp-log-banner-label {
        font-family: 'Signika', sans-serif;
        font-size: 1.0rem; font-weight: 900;
        letter-spacing: .06em; color: #3b2a19;
      }
    `;
    document.head.appendChild(s);
  }

  /**
   * Play a floating JRPG action-name panel near the top of the screen.
   * Slides in from the left + fades in, lingers, slides out to the right + fades out.
   * Fire-and-forget — caller awaits LOG_BANNER_TOTAL_MS separately.
   */
  function playLogBanner({ optionLabel, optionIcon, color }) {
    ensureBannerStyles();
    const escStr = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const col = escStr(color ?? "#fcd470");

    const banner = document.createElement("div");
    banner.className = "oni-opp-log-banner";
    // Position + dimensions driven by tunable vars (0 = auto for width/height)
    banner.style.top = `${_bannerTopPx}px`;
    if (_bannerWidthPx  > 0) banner.style.width  = `${_bannerWidthPx}px`;
    if (_bannerHeightPx > 0) banner.style.height = `${_bannerHeightPx}px`;
    // Thick left border strip in option accent colour
    banner.style.borderLeftColor = col;
    banner.style.borderLeftWidth = "5px";
    // Initial state: offset left + invisible
    banner.style.transform = "translateX(calc(-50% - 100px))";
    banner.style.opacity   = "0";

    banner.innerHTML = `
      <span class="oni-opp-log-banner-icon" style="color:${col}">
        <i class="fas ${escStr(optionIcon ?? "fa-star")}"></i>
      </span>
      <span class="oni-opp-log-banner-label">${escStr(optionLabel)}</span>`;
    document.body.appendChild(banner);
    playSound(SFX_BANNER, 0.75);

    // Enter: slide right into centre + fade in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      banner.style.transition = [
        `transform ${_bannerEnterMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        `opacity   ${Math.round(_bannerEnterMs * 0.7)}ms ease-out`,
      ].join(", ");
      banner.style.transform = "translateX(-50%)";
      banner.style.opacity   = "1";
    }));

    // Exit: slide right out + fade out
    setTimeout(() => {
      banner.style.transition = [
        `transform ${_bannerExitMs}ms cubic-bezier(0.55, 0, 1, 0.45)`,
        `opacity   ${Math.round(_bannerExitMs * 0.7)}ms ease-in`,
      ].join(", ");
      banner.style.transform = "translateX(calc(-50% + 100px))";
      banner.style.opacity   = "0";
      setTimeout(() => banner.remove(), _bannerExitMs + 60);
    }, _bannerEnterMs + _bannerLingerMs);
  }

  // ── Local dialog flow ───────────────────────────────────────────────────────
  async function showDialogLocally({ actorName, actorUuid, excludeIds = [], title = null, offerKey = null }) {
    const cfg = getConfig();
    if (!cfg) { console.error(TAG, "OpportunityConfig not loaded"); return { cancelled: true }; }
    const dialog = getDialog();
    if (!dialog) { console.error(TAG, "OpportunityDialog not loaded"); return { cancelled: true }; }

    const portrait = await resolvePortrait(actorUuid);

    // Resolve the acting actor so equipment-gated options can be filtered
    // per-wearer. An option with `requiresFlag` is only offered when the actor
    // carries a truthy flags["fabula-ultima-companion"].<flag> (e.g. Bunny Tail's
    // equip-toggled `opp_lucky`). Options without requiresFlag are always offered.
    let flagActor = null;
    if (actorUuid) {
      try {
        const doc = await fromUuid(actorUuid);
        flagActor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
      } catch (_) { /* unresolved actor → gated options simply won't appear */ }
    }
    const hasOptionFlag = f => !!flagActor?.getFlag?.("fabula-ultima-companion", f);

    // excludeIds removes already-chosen options (A Million Possibility: "the same
    // Opportunity cannot be chosen twice") — a filtered list is equivalent to
    // greying them out, since an absent option can't be picked.
    const ex = new Set(excludeIds ?? []);
    const options = (cfg.OPTIONS ?? [])
      .filter(o => !ex.has(o.id) && (!o.requiresFlag || hasOptionFlag(o.requiresFlag)));

    // Open the read-only mirror on every other client. Broadcast the ALREADY
    // FILTERED option list (post excludeIds + requiresFlag) — a mirror built
    // from the unfiltered list would have different wheel geometry — and the
    // resolved portrait URL, so a spectator without read access to the actor
    // still sees the right sprite.
    if (offerKey) {
      game.socket.emit(SOCKET_CH, {
        type:    MSG_SPEC_OPEN,
        payload: { offerKey, actorName, actorPortrait: portrait, options: specOptions(options), title, sel: 0 },
      });
    }

    const result = await dialog.showPicker({
      actorName,
      actorPortrait: portrait,
      options,
      canDecline:    true,
      title,
      onSelectionChange: makeSelectionEmitter(offerKey),
    });

    // Tear the mirror down the instant our own wheel closes.
    //
    // A hand-over is the one case that must NOT broadcast a close: the GM
    // re-opens under the SAME offerKey, and a close arriving after that open
    // would kill the GM's fresh mirror. Superseding does the teardown instead —
    // buildWheel() clears any live mirror before spawning the new wheel.
    if (offerKey && !result?.takenOver) {
      game.socket.emit(SOCKET_CH, {
        type:    MSG_SPEC_CLOSE,
        payload: { offerKey, optionId: result?.optionId ?? null, cancelled: !!result?.cancelled },
      });
    }

    return result;
  }

  // ── Prompt phase: picker + pre handler ─────────────────────────────────────
  // All user decisions happen here — picker choice and any targeting/input from
  // the effect's pre handler. Returns { optionId, preResult } on success or
  // { cancelled: true } if the player declined or the pre handler cancelled.
  // Shared between the local owner path and the socket OPP_OFFER handler.
  async function runPromptPhase({ actorName, actorUuid, context = {}, excludeIds = [], title = null, offerKey = null }) {
    // Published so a GM's OPP_TAKEOVER can find (and abort) this wheel, and so
    // the ack can hand the GM the context it needs to finish the job. Cleared in
    // `finally` — while it points at a prompt phase whose wheel has already
    // closed (the pre phase), abortPicker() fails and the hand-over is refused.
    _liveOffer = offerKey ? { offerKey, actorUuid, actorName, context, excludeIds, title } : null;
    try {
      const result = await showDialogLocally({ actorName, actorUuid, excludeIds, title, offerKey });
      // A GM took the wheel off us — the pick, and its resolution, are theirs.
      if (result?.takenOver) return { takenOver: true };
      if (result?.cancelled || !result?.optionId) return { cancelled: true };

      const handler = getEffects()?.[result.optionId];
      if (handler?.pre) {
        const option    = getConfig()?.OPTIONS?.find(o => o.id === result.optionId);
        const preResult = await handler.pre({ actorUuid, actorName, optionId: result.optionId, option, context })
          .catch(e => { console.error(TAG, "Pre phase error:", e); return null; });
        if (preResult === null) return { cancelled: true };
        playSound(SFX_CONFIRM, 0.8);
        return { optionId: result.optionId, preResult };
      }

      playSound(SFX_CONFIRM, 0.8);
      return { optionId: result.optionId, preResult: undefined };
    } finally {
      if (_liveOffer?.offerKey === offerKey) _liveOffer = null;
    }
  }

  // ── Resolution phase: banner + post handler + chat card ────────────────────
  // No user interaction — purely resolves the result of the prompt phase.
  // preResult: undefined if no pre handler; serialized object if pre ran.
  async function applyAndAnnounce({ actorUuid, actorName, optionId, context, preResult, offerKey = null }) {
    const cfg      = getConfig();
    const effects  = getEffects();
    const chatCard = getChatCard();

    // Real mutations live below (AEs, clocks, chat cards) — never twice for one
    // offer, whichever client ends up driving it.
    if (!claimResolution(offerKey)) {
      console.debug(TAG, `applyAndAnnounce skipped — already resolved (key=${offerKey})`);
      return;
    }

    const option = cfg?.OPTIONS?.find(o => o.id === optionId);
    if (!option) { console.warn(TAG, `Unknown option id: ${optionId}`); return; }

    const handler = effects?.[optionId];

    // 1. Broadcast JRPG log banner to ALL clients
    const bannerPayload = { optionLabel: option.label, optionIcon: option.icon, color: option.color ?? "#fcd470" };
    game.socket.emit(SOCKET_CH, { type: MSG_LOG_BANNER, payload: bannerPayload });
    playLogBanner(bannerPayload);

    // 2. Wait for the banner to finish
    await new Promise(r => setTimeout(r, bannerTotalMs()));

    // 3. Post-banner phase
    if (handler?.post) {
      const postResult = await handler.post({ actorUuid, actorName, optionId, option, context }, preResult)
        .catch(e => { console.error(TAG, `Effect post error (${optionId}):`, e); return null; });
      // An effect may return { resultSummary: <html> } to surface its mechanical
      // outcome (e.g. Lucky's rolled Zenit) ON the generic result card below — so
      // the final card the player reads shows the actual result, not just the
      // option's description. Generic + opt-in: effects that post their own rich
      // card just return nothing.
      if (postResult?.resultSummary) context.resultSummary = postResult.resultSummary;
    }

    // 4. Post result chat card
    if (chatCard?.postOpportunityCard) {
      await chatCard.postOpportunityCard({ actorUuid, actorName, optionId, option, context });
    }
  }

  // ── Core offer() API ────────────────────────────────────────────────────────
  /**
   * Present the opportunity picker to the correct client for the given actor.
   *
   * @param {object}  opts
   * @param {string}  opts.actorUuid      UUID of the actor who scored the crit
   * @param {string}  opts.actorName      Display name
   * @param {string}  [opts.source]       "action" | "check" | "check_roller"
   * @param {string}  [opts.actionCardId] Used for offer dedup key
   * @param {object}  [opts.context]      Caller metadata
   * @returns {Promise<{optionId:string}|{cancelled:boolean}>}
   */
  async function offer({ actorUuid, actorName, source, actionCardId, context = {}, excludeIds = [], announce = true, title = null }) {
    const ownerUserId = resolveOwnerUserId(actorUuid);
    const amGM        = game.user?.isGM ?? false;

    // If the owning player isn't connected, the GM can't route the picker to
    // them — OPP_OFFER would go unanswered and the FSM would wedge for the full
    // 120 s safety timeout (a soft-lock during solo/test play). In that case the
    // GM runs the picker locally instead. A connected owner still gets it routed.
    const ownerActive = ownerUserId ? !!game.users?.get(ownerUserId)?.active : false;
    const amOwner     = !ownerUserId || game.user.id === ownerUserId || (amGM && !ownerActive);

    // Case 1: I am the owner (or GM-owned / disconnected-owner actor) — run full
    // prompt phase locally
    if (amOwner) {
      // Step 1 — stagger pause: player reads their roll result
      if (_staggerMs > 0 && announce) await new Promise(r => setTimeout(r, _staggerMs));

      // Step 2 — broadcast "Opportunity!" fly-text to all, then wait for it to finish.
      // Suppressed when announce===false (A Million Possibility shows the intro ONCE,
      // then chains its 2nd + 3rd pickers straight in).
      if (announce) {
        const annPayload = { optionLabel: "Opportunity!", color: "#fcd470" };
        game.socket.emit(SOCKET_CH, { type: MSG_DRAMATIC, payload: annPayload });
        playDramaticAnimation(annPayload);
        await new Promise(r => setTimeout(r, DRAMATIC_DURATION));
      }

      // Step 3 — prompt phase: picker + pre handler (all user decisions happen here)
      const offerKey = makeOfferKey(actorUuid, actionCardId);
      const picked   = await runPromptPhase({ actorName, actorUuid, context, excludeIds, title, offerKey });

      // A GM claimed the wheel mid-decision. They resolve the offer; we keep our
      // caller's await alive until their OPP_RESOLVED lands, so a pipeline that
      // asked for this opportunity still gets the real answer.
      if (picked.takenOver) return await waitForTakeover(offerKey);

      if (picked.cancelled) {
        if (!amGM) game.socket.emit(SOCKET_CH, { type: MSG_CANCELLED, payload: { offerKey, actorUuid } });
        return { cancelled: true };
      }

      // Step 4 — resolution phase (GM runs directly; player sends to GM via socket)
      if (amGM) {
        await applyAndAnnounce({ actorUuid, actorName, optionId: picked.optionId, context, preResult: picked.preResult, offerKey });
      } else {
        game.socket.emit(SOCKET_CH, {
          type:    MSG_PICKED,
          payload: { offerKey, actorUuid, actorName, optionId: picked.optionId, context, preResult: picked.preResult },
        });
      }

      return { optionId: picked.optionId };
    }

    // Case 2: GM, player-owned actor — stagger + animation run GM-side, then send offer to player
    if (amGM) {
      // Step 1 — stagger pause
      if (_staggerMs > 0 && announce) await new Promise(r => setTimeout(r, _staggerMs));

      // Step 2 — broadcast "Opportunity!" and wait; player receives it via MSG_DRAMATIC
      if (announce) {
        const annPayload = { optionLabel: "Opportunity!", color: "#fcd470" };
        game.socket.emit(SOCKET_CH, { type: MSG_DRAMATIC, payload: annPayload });
        playDramaticAnimation(annPayload);
        await new Promise(r => setTimeout(r, DRAMATIC_DURATION));
      }

      // Step 3 — send offer; player runs prompt phase (picker + pre), sends back OPP_PICKED
      return new Promise(resolve => {
        const offerKey = makeOfferKey(actorUuid, actionCardId);
        _pending.set(offerKey, { resolve, actorUuid });

        game.socket.emit(SOCKET_CH, {
          type:    MSG_OFFER,
          payload: { offerKey, actorUuid, actorName, context, targetUserId: ownerUserId, excludeIds, title },
        });

        // Safety timeout: give up after 120 s
        setTimeout(() => {
          if (!_pending.has(offerKey)) return;
          _pending.delete(offerKey);
          console.warn(TAG, `offer() timed out for key=${offerKey}`);
          resolve({ cancelled: true });
        }, 120_000);
      });
    }

    // Case 3: non-owner player — nothing to do
    return { cancelled: true };
  }

  // ── processCheckCrits() — CR path ──────────────────────────────────────────
  /**
   * Called by cr-api.js (GM side) between postGroupedChatCard and emitCheckReactions.
   * Processes crit actors serially so pickers don't overlap.
   * Awaited by the caller, which blocks reactions until all pickers resolve.
   */
  async function processCheckCrits(critPayloads) {
    if (!game.user?.isGM) return;
    if (!Array.isArray(critPayloads) || !critPayloads.length) return;

    for (const cp of critPayloads) {
      await offer({
        actorUuid: cp.actorUuid,
        actorName: cp.actorName,
        source:    "check",
        context:   { checkResult: cp },
      }).catch(e => console.error(TAG, "processCheckCrits offer error:", e));
    }
  }

  // ── Socket listener ─────────────────────────────────────────────────────────
  function setupSocket() {
    if (window["__ONI_OPP_SOCKET__"]) return;
    window["__ONI_OPP_SOCKET__"] = true;

    game.socket.on(SOCKET_CH, async msg => {
      if (!msg?.type?.startsWith("OPP_")) return;

      // OPP_OFFER — targeted player runs full prompt phase (picker + pre), then sends MSG_PICKED
      if (msg.type === MSG_OFFER) {
        const { offerKey, actorUuid, actorName, context, targetUserId, excludeIds, title } = msg.payload ?? {};
        if (game.user.id !== targetUserId) return;

        const picked = await runPromptPhase({ actorName, actorUuid, context, excludeIds, title, offerKey })
          .catch(e => { console.error(TAG, "Socket prompt phase error:", e); return { cancelled: true }; });

        // A GM claimed the wheel — they own the resolution and the GM that
        // routed this offer still holds its _pending entry, so say nothing.
        if (picked.takenOver) return;

        if (picked.cancelled) {
          game.socket.emit(SOCKET_CH, { type: MSG_CANCELLED, payload: { offerKey, actorUuid } });
          return;
        }

        game.socket.emit(SOCKET_CH, {
          type:    MSG_PICKED,
          // gmInitiated: this pick answers a GM-routed OPP_OFFER, so exactly one
          // GM (the initiator) owns the matching _pending entry and must run the
          // resolution. Distinguishes it from a player-initiated local pick.
          payload: { offerKey, actorUuid, actorName, optionId: picked.optionId, context, preResult: picked.preResult, gmInitiated: true },
        });
        return;
      }

      // OPP_PICKED — GM plays banner + runs post phase + chat card
      //              preResult (if any) was already run on the player's client
      if (msg.type === MSG_PICKED && game.user?.isGM) {
        const { offerKey, actorUuid, actorName, optionId, context, preResult, gmInitiated } = msg.payload ?? {};

        // Multi-GM dedupe: applyAndAnnounce broadcasts the banner, runs the
        // effect's post handler (real mutations — AEs, chat cards, clocks) and
        // posts the result card. It must run on exactly ONE GM client.
        //  - GM-initiated offer: only the GM that owns the matching _pending
        //    entry resolves (preserves the original "resolve after await"
        //    ordering even when the Co-DM GM was the initiator).
        //  - Player-initiated offer (action pipeline): no GM holds _pending, so
        //    the primary GM resolves and the second GM bails.
        const pending = _pending.get(offerKey);
        if (gmInitiated ? !pending : !isPrimaryGM()) return;

        await applyAndAnnounce({ actorUuid, actorName, optionId, context, preResult, offerKey })
          .catch(e => console.error(TAG, "applyAndAnnounce error:", e));

        if (pending) { _pending.delete(offerKey); pending.resolve({ optionId }); }
        return;
      }

      // OPP_CANCELLED — GM resolves the pending offer as cancelled
      if (msg.type === MSG_CANCELLED && game.user?.isGM) {
        const { offerKey } = msg.payload ?? {};
        const pending = _pending.get(offerKey);
        if (pending) { _pending.delete(offerKey); pending.resolve({ cancelled: true }); }
        return;
      }

      // OPP_DRAMATIC — every client plays the "Opportunity!" fly-text locally
      if (msg.type === MSG_DRAMATIC) {
        playDramaticAnimation(msg.payload ?? {});
        return;
      }

      // OPP_LOG_BANNER — every client plays the confirmation banner locally
      if (msg.type === MSG_LOG_BANNER) {
        playLogBanner(msg.payload ?? {});
        return;
      }

      // ── Spectator mirror ────────────────────────────────────────────────
      // Read-only. Nothing here can influence the outcome; the picker client
      // remains the only one that resolves the offer.

      // OPP_SPEC_OPEN — open the mirror of somebody else's wheel
      if (msg.type === MSG_SPEC_OPEN) {
        const p = msg.payload ?? {};
        if (!p.options?.length) return;
        const opened = getDialog()?.showSpectator({
          actorName:     p.actorName,
          actorPortrait: p.actorPortrait,
          options:       p.options,
          title:         p.title ?? null,
          sel:           p.sel ?? 0,
          // The one deliberate control on this panel, GM only: claim the wheel
          // when the owner can't work their own menu.
          onTakeControl: (game.user?.isGM && p.offerKey) ? () => requestTakeover(p.offerKey) : null,
        });
        // showSpectator returns null when this client is itself running a
        // picker (stray broadcast) — don't claim a key we didn't render.
        _specOfferKey = opened ? (p.offerKey ?? null) : null;
        return;
      }

      // OPP_SPEC_SEL — the owner moved their cursor; follow it
      if (msg.type === MSG_SPEC_SEL) {
        const p = msg.payload ?? {};
        if (p.offerKey && _specOfferKey && p.offerKey !== _specOfferKey) return;  // stale
        getDialog()?.applySpectatorSelection({ sel: p.sel ?? 0 });
        return;
      }

      // OPP_SPEC_CLOSE — the owner committed, declined, or handed over
      if (msg.type === MSG_SPEC_CLOSE) {
        const p = msg.payload ?? {};
        if (p.offerKey && _specOfferKey && p.offerKey !== _specOfferKey) return;  // superseded
        _specOfferKey = null;
        getDialog()?.dismissSpectator({
          optionId:  p.optionId ?? null,
          cancelled: !!p.cancelled,
          silent:    !!p.silent,
        });
        return;
      }

      // ── GM take-control hand-over ───────────────────────────────────────

      // OPP_TAKEOVER — a GM wants our wheel. Only the client actually running
      // that offer's prompt phase answers.
      if (msg.type === MSG_TAKEOVER) {
        const p = msg.payload ?? {};
        if (!_liveOffer || _liveOffer.offerKey !== p.offerKey) return;

        // Refused once the wheel is gone (we're mid pre-phase or already
        // committed) — the choice is made and it stays ours.
        if (!(getDialog()?.abortPicker?.() ?? false)) {
          game.socket.emit(SOCKET_CH, {
            type:    MSG_TAKEOVER_ACK,
            payload: { offerKey: p.offerKey, gmUserId: p.gmUserId, granted: false },
          });
          return;
        }

        ui.notifications?.info(`[Opportunity] ${p.gmName ?? "The GM"} is taking over this Opportunity.`);
        game.socket.emit(SOCKET_CH, {
          type:    MSG_TAKEOVER_ACK,
          payload: {
            offerKey:   p.offerKey,
            gmUserId:   p.gmUserId,
            granted:    true,
            actorUuid:  _liveOffer.actorUuid,
            actorName:  _liveOffer.actorName,
            context:    _liveOffer.context,
            excludeIds: _liveOffer.excludeIds,
            title:      _liveOffer.title,
          },
        });
        return;
      }

      // OPP_TAKEOVER_ACK — only the requesting GM acts on it. A granted ack is
      // the sole authority to open a replacement wheel, so two GMs asking at
      // once can't both end up driving: the second gets granted:false.
      if (msg.type === MSG_TAKEOVER_ACK) {
        const p = msg.payload ?? {};
        if (p.gmUserId !== game.user?.id) return;
        const req = _takeoverReq;
        if (!req || req.offerKey !== p.offerKey) return;
        clearTimeout(req.timer);
        _takeoverReq = null;

        if (!p.granted) {
          ui.notifications?.warn("[Opportunity] Too late — that choice has already been made.");
          getDialog()?.setSpectatorTakeControl?.({ enabled: true });
          return;
        }
        runTakeover(p).catch(e => console.error(TAG, "runTakeover error:", e));
        return;
      }

      // OPP_RESOLVED — a handed-over offer finished; release anyone still
      // awaiting it (the ex-owner's caller, or the GM that routed the offer).
      if (msg.type === MSG_RESOLVED) {
        const { offerKey, optionId = null, cancelled = false } = msg.payload ?? {};
        const result  = cancelled ? { cancelled: true } : { optionId };

        const waiting = _awaitingTakeover.get(offerKey);
        if (waiting) { _awaitingTakeover.delete(offerKey); clearTimeout(waiting.timer); waiting.resolve(result); }

        const pending = _pending.get(offerKey);
        if (pending) { _pending.delete(offerKey); pending.resolve(result); }
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  const api = {
    offer,
    processCheckCrits,
    isPrimaryGM,
    get OPTIONS()       { return getConfig()?.OPTIONS ?? []; },
    get staggerMs()     { return _staggerMs; },
    set staggerMs(v)    { _staggerMs     = Math.max(0,   Number(v) || 0); },
    get bannerEnterMs() { return _bannerEnterMs; },
    set bannerEnterMs(v){ _bannerEnterMs  = Math.max(50,  Number(v) || 380); },
    get bannerLingerMs(){ return _bannerLingerMs; },
    set bannerLingerMs(v){ _bannerLingerMs = Math.max(100, Number(v) || 3000); },
    get bannerExitMs()  { return _bannerExitMs; },
    set bannerExitMs(v) { _bannerExitMs   = Math.max(50,  Number(v) || 360); },
    get bannerTopPx()    { return _bannerTopPx; },
    set bannerTopPx(v)   { _bannerTopPx    = Math.max(0, Number(v) || 0); },
    get bannerWidthPx()  { return _bannerWidthPx; },
    set bannerWidthPx(v) { _bannerWidthPx  = Math.max(0, Number(v) || 0); },
    get bannerHeightPx() { return _bannerHeightPx; },
    set bannerHeightPx(v){ _bannerHeightPx = Math.max(0, Number(v) || 0); },

    // Test helper: fire the log banner without triggering a full opportunity flow
    testBanner(optionId = "advantage") {
      const opt = getConfig()?.OPTIONS?.find(o => o.id === optionId)
                  ?? { label: optionId, icon: "fa-star", color: "#fcd470" };
      playLogBanner({ optionLabel: opt.label, optionIcon: opt.icon, color: opt.color ?? "#fcd470" });
    },

    // Test helper: run the full prompt phase then resolution, same as a live offer
    testPicker(actorName = "Test") {
      runPromptPhase({ actorName, actorUuid: null, context: {} })
        .then(picked => {
          console.log(`${TAG} testPicker prompt result:`, picked);
          if (!picked.cancelled) {
            applyAndAnnounce({ actorUuid: null, actorName, optionId: picked.optionId, context: {}, preResult: picked.preResult });
          }
        })
        .catch(console.error);
    },
  };

  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.OpportunitySystem = api;

  Hooks.once("ready", () => {
    setupSocket();
    console.log(`${TAG} Ready v2.`);
  });
})();
