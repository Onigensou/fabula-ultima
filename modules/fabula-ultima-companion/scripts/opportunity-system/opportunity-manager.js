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
 * Confirmation sequence (after player picks):
 *   1. Screen flash + confirm sound (inside dialog)
 *   2. Dramatic animation broadcast → all clients see bold text fly across screen
 *   3. Await animation duration
 *   4. Placeholder effect handler runs
 *   5. Opportunity chat card posted
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
  const MSG_DRAMATIC  = "OPP_DRAMATIC";

  const DRAMATIC_DURATION = 2800; // ms — must match the CSS animation duration
  const SFX_DRAMATIC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/EXSkill.ogg";

  // ── Dependency shortcuts ────────────────────────────────────────────────────
  const getConfig   = () => window["oni.OpportunityConfig"];
  const getDialog   = () => window["oni.OpportunityDialog"];
  const getChatCard = () => window["oni.OpportunityChatCard"];
  const getEffects  = () => window["oni.OpportunityEffects"];

  // ── In-flight offer tracking ────────────────────────────────────────────────
  const _pending = new Map(); // offerKey → { resolve, actorUuid }

  function makeOfferKey(actorUuid, actionCardId) {
    return `${actionCardId ?? actorUuid}-${Date.now()}`;
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

  // ── Local dialog flow ───────────────────────────────────────────────────────
  async function showDialogLocally({ actorName, actorUuid, offerKey }) {
    const cfg = getConfig();
    if (!cfg) { console.error(TAG, "OpportunityConfig not loaded"); return { cancelled: true }; }
    const dialog = getDialog();
    if (!dialog) { console.error(TAG, "OpportunityDialog not loaded"); return { cancelled: true }; }

    const portrait = await resolvePortrait(actorUuid);

    return dialog.showPicker({
      actorName,
      actorPortrait: portrait,
      options:       cfg.OPTIONS,
      canDecline:    true,
    });
  }

  // ── Apply effect + dramatic sequence + chat card ────────────────────────────
  async function applyAndAnnounce({ actorUuid, actorName, optionId, context }) {
    const cfg      = getConfig();
    const effects  = getEffects();
    const chatCard = getChatCard();

    const option = cfg?.OPTIONS?.find(o => o.id === optionId);
    if (!option) { console.warn(TAG, `Unknown option id: ${optionId}`); return; }

    // 1. Broadcast dramatic animation to ALL clients (GM plays locally, others via socket)
    const dramaticPayload = { optionLabel: option.label, color: option.color ?? "#fcd470", optionId };
    game.socket.emit(SOCKET_CH, { type: MSG_DRAMATIC, payload: dramaticPayload });
    playDramaticAnimation(dramaticPayload); // GM plays its own copy immediately

    // 2. Wait for the animation to finish before posting the card
    await new Promise(r => setTimeout(r, DRAMATIC_DURATION + 100));

    // 3. Placeholder effect handler
    const handler = effects?.[optionId];
    if (typeof handler === "function") {
      await handler({ actorUuid, actorName, optionId, option, context })
        .catch(e => console.error(TAG, `Effect handler error (${optionId}):`, e));
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
  async function offer({ actorUuid, actorName, source, actionCardId, context = {} }) {
    const ownerUserId = resolveOwnerUserId(actorUuid);
    const amOwner     = !ownerUserId || game.user.id === ownerUserId;
    const amGM        = game.user?.isGM ?? false;

    // Case 1: I am the owner (or GM-owned actor) — show dialog directly
    if (amOwner) {
      const offerKey = makeOfferKey(actorUuid, actionCardId);
      const result   = await showDialogLocally({ actorName, actorUuid, offerKey });

      if (!result?.cancelled && result?.optionId) {
        if (amGM) {
          await applyAndAnnounce({ actorUuid, actorName, optionId: result.optionId, context });
        } else {
          // Player: send choice to GM for the dramatic sequence + chat card
          game.socket.emit(SOCKET_CH, {
            type:    MSG_PICKED,
            payload: { offerKey, actorUuid, actorName, optionId: result.optionId, context },
          });
        }
      } else if (!amGM) {
        game.socket.emit(SOCKET_CH, {
          type:    MSG_CANCELLED,
          payload: { offerKey, actorUuid },
        });
      }

      return result ?? { cancelled: true };
    }

    // Case 2: GM, actor is owned by a player — send picker via socket, await response
    if (amGM) {
      return new Promise(resolve => {
        const offerKey = makeOfferKey(actorUuid, actionCardId);
        _pending.set(offerKey, { resolve, actorUuid });

        game.socket.emit(SOCKET_CH, {
          type:    MSG_OFFER,
          payload: { offerKey, actorUuid, actorName, context, targetUserId: ownerUserId },
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

      // OPP_OFFER — targeted player shows picker, sends result back
      if (msg.type === MSG_OFFER) {
        const { offerKey, actorUuid, actorName, context, targetUserId } = msg.payload ?? {};
        if (game.user.id !== targetUserId) return;

        const result = await showDialogLocally({ actorName, actorUuid, offerKey })
          .catch(e => { console.error(TAG, "Socket offer dialog error:", e); return { cancelled: true }; });

        if (!result?.cancelled && result?.optionId) {
          game.socket.emit(SOCKET_CH, {
            type:    MSG_PICKED,
            payload: { offerKey, actorUuid, actorName, optionId: result.optionId, context },
          });
        } else {
          game.socket.emit(SOCKET_CH, {
            type:    MSG_CANCELLED,
            payload: { offerKey, actorUuid },
          });
        }
        return;
      }

      // OPP_PICKED — GM applies effect + dramatic sequence
      if (msg.type === MSG_PICKED && game.user?.isGM) {
        const { offerKey, actorUuid, actorName, optionId, context } = msg.payload ?? {};
        await applyAndAnnounce({ actorUuid, actorName, optionId, context })
          .catch(e => console.error(TAG, "applyAndAnnounce error:", e));

        const pending = _pending.get(offerKey);
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

      // OPP_DRAMATIC — every client plays the animation locally
      if (msg.type === MSG_DRAMATIC) {
        playDramaticAnimation(msg.payload ?? {});
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  const api = {
    offer,
    processCheckCrits,
    get OPTIONS() { return getConfig()?.OPTIONS ?? []; },
  };

  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.OpportunitySystem = api;

  Hooks.once("ready", () => {
    setupSocket();
    console.log(`${TAG} Ready v2.`);
  });
})();
