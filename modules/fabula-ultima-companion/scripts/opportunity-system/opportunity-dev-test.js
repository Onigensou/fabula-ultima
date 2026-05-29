/**
 * [ONI] Opportunity System — Developer Test Utility
 *
 * Lets the GM run the full opportunity flow with a real actor UUID so every
 * effect handler behaves exactly as it would for a player.
 *
 * NOTE: This file is dev-only. Remove from module.json before shipping.
 *
 * API:  window["oni.OppDevTest"]
 *
 *   .run(actorUuid?)
 *     Full simulation: portrait resolve → picker → pre phase → banner → post phase → chat card.
 *
 *   .runOption(optionId, actorUuid?)
 *     Skip the picker — jump straight to a specific option (still runs pre + post).
 *
 *   .simulateBondEdit(actorUuid?)
 *     Emit OPP_BOND_EDIT with targetUserId = game.user.id so the bond editor
 *     opens on this client exactly as it would on a player's screen.
 *
 *   .setActor(uuid)
 *     Override the default actor UUID for this session.
 *
 * Quick start (browser console):
 *   oni.OppDevTest.run()                        // full flow, default actor
 *   oni.OppDevTest.runOption("scan")             // jump to scan directly
 *   oni.OppDevTest.runOption("advantage")
 *   oni.OppDevTest.runOption("affliction")
 *   oni.OppDevTest.runOption("bonding")          // bond editor opens GM-side
 *   oni.OppDevTest.simulateBondEdit()            // bond editor opens as if on player client
 *   oni.OppDevTest.setActor("Actor.xxx")         // change default actor
 */
(() => {
  const TAG       = "[ONI][OppDevTest]";
  const SOCKET_CH = "module.fabula-ultima-companion";
  const GUARD     = "__ONI_OPP_DEV_TEST__";

  if (window[GUARD]) { console.debug(TAG, "Already installed — replacing."); }
  window[GUARD] = true;

  // ── Default actor (overridable with .setActor()) ──────────────────────────
  let _defaultActorUuid = "Actor.dafTLBUscCDNgq8H";

  const SFX_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_confirmed.wav";

  // ── Helpers ───────────────────────────────────────────────────────────────
  async function resolveActorInfo(uuid) {
    const doc   = await fromUuid(uuid).catch(() => null);
    const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
    if (!actor) return null;
    const world    = actor.isToken ? (game.actors?.get(actor.id) ?? actor) : actor;
    const props    = world.system?.props ?? {};
    const portrait = String(props.sprite_standard ?? "").trim()
      || String(world.prototypeToken?.texture?.src ?? "").trim()
      || world.img
      || "icons/svg/mystery-man.svg";
    return { actor: world, actorName: world.name, portrait };
  }

  function playConfirm() {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: SFX_CONFIRM, volume: 0.8, autoplay: true }, false); } catch(_) {}
  }

  /**
   * Run the pre phase for an effect (if it has one) and return the preResult.
   * Returns null if pre cancelled; undefined if no pre phase.
   */
  async function runPrePhase(actorUuid, actorName, optionId, context) {
    const effects = window["oni.OpportunityEffects"];
    const cfg     = window["oni.OpportunityConfig"];
    const handler = effects?.[optionId];
    if (!handler?.pre) return undefined;

    const option    = cfg?.OPTIONS?.find(o => o.id === optionId);
    const ctx       = { actorUuid, actorName, optionId, option, context };
    const preResult = await handler.pre(ctx).catch(e => { console.error(TAG, `Pre phase error (${optionId}):`, e); return null; });
    if (preResult === null) { console.log(TAG, "Pre phase cancelled."); return null; }
    playConfirm();
    return preResult;
  }

  /** Pure resolution phase: banner + post + chat card. No user interaction. */
  async function runResolutionPhase(actorUuid, actorName, optionId, context, preResult) {
    const sys      = globalThis.ONI?.OpportunitySystem;
    const effects  = window["oni.OpportunityEffects"];
    const chatCard = window["oni.OpportunityChatCard"];
    const cfg      = window["oni.OpportunityConfig"];

    const option = cfg?.OPTIONS?.find(o => o.id === optionId);
    if (!option) { console.error(TAG, "Unknown optionId:", optionId); return; }

    const handler = effects?.[optionId];
    const ctx     = { actorUuid, actorName, optionId, option, context };

    // Banner — broadcast to all + play locally (socket.emit doesn't echo to sender)
    const bannerPayload = { optionLabel: option.label, optionIcon: option.icon, color: option.color ?? "#fcd470" };
    game.socket.emit(SOCKET_CH, { type: "OPP_LOG_BANNER", payload: bannerPayload });
    sys?.testBanner(optionId);

    const bannerMs = (sys?.bannerEnterMs ?? 750) + (sys?.bannerLingerMs ?? 2500) + (sys?.bannerExitMs ?? 410);
    await new Promise(r => setTimeout(r, bannerMs));

    // Post phase
    if (handler?.post) {
      console.debug(TAG, `Running post phase: ${optionId}`);
      await handler.post(ctx, preResult).catch(e => console.error(TAG, `Post phase error (${optionId}):`, e));
    }

    // Opportunity chat card
    await chatCard?.postOpportunityCard({ actorUuid, actorName, optionId, option, context })
      .catch(e => console.error(TAG, "postOpportunityCard failed:", e));
  }

  // ── Public API ────────────────────────────────────────────────────────────
  const api = {
    /** Override the default actor UUID for the current session. */
    setActor(uuid) {
      _defaultActorUuid = uuid;
      console.log(TAG, "Default actor set to:", uuid);
    },

    /**
     * Full simulation: picker → pre phase → resolution phase.
     * Identical to what the player sees, with a real actorUuid.
     */
    async run(actorUuid) {
      const uuid = actorUuid ?? _defaultActorUuid;
      console.log(TAG, "run()", { actorUuid: uuid });

      const info = await resolveActorInfo(uuid);
      if (!info) { console.error(TAG, "Could not resolve actor:", uuid); return; }
      console.debug(TAG, "Actor resolved:", info.actorName);

      const cfg    = window["oni.OpportunityConfig"];
      const dialog = window["oni.OpportunityDialog"];
      if (!cfg || !dialog) { console.error(TAG, "Config or Dialog not loaded"); return; }

      // Prompt phase: picker
      const result = await dialog.showPicker({
        actorName:     info.actorName,
        actorPortrait: info.portrait,
        options:       cfg.OPTIONS,
        canDecline:    true,
      });
      console.debug(TAG, "Picker result:", result);
      if (result?.cancelled || !result?.optionId) { console.log(TAG, "Picker cancelled."); return; }

      // Prompt phase: pre handler
      const preResult = await runPrePhase(uuid, info.actorName, result.optionId, {});
      if (preResult === null) return; // pre cancelled

      if (preResult === undefined) playConfirm(); // no pre phase — still play confirm sound

      // Resolution phase
      await runResolutionPhase(uuid, info.actorName, result.optionId, {}, preResult);
    },

    /**
     * Skip the picker — run a specific option directly (pre + resolution).
     * Useful when you already know which option to test.
     */
    async runOption(optionId, actorUuid) {
      const uuid = actorUuid ?? _defaultActorUuid;
      console.log(TAG, "runOption()", { optionId, actorUuid: uuid });

      const info = await resolveActorInfo(uuid);
      if (!info) { console.error(TAG, "Could not resolve actor:", uuid); return; }

      const preResult = await runPrePhase(uuid, info.actorName, optionId, {});
      if (preResult === null) return; // pre cancelled

      if (preResult === undefined) playConfirm();

      await runResolutionPhase(uuid, info.actorName, optionId, {}, preResult);
    },

    /**
     * Simulate the player receiving OPP_BOND_EDIT:
     * emits the socket message with targetUserId = game.user.id so the bond
     * editor opens on this client exactly as it would on the player's screen.
     */
    async simulateBondEdit(actorUuid) {
      const uuid = actorUuid ?? _defaultActorUuid;
      console.log(TAG, "simulateBondEdit()", { actorUuid: uuid });

      const info = await resolveActorInfo(uuid);
      if (!info) { console.error(TAG, "Could not resolve actor:", uuid); return; }

      game.socket.emit(SOCKET_CH, {
        type: "OPP_BOND_EDIT",
        payload: {
          actorUuid:    uuid,
          actorName:    info.actorName,
          targetUserId: game.user.id,
        },
      });
      console.debug(TAG, "OPP_BOND_EDIT emitted to self (targetUserId =", game.user.id, ")");
    },
  };

  // Expose as both window["oni.OppDevTest"] and oni.OppDevTest shorthand
  window["oni.OppDevTest"] = api;
  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.OppDevTest = api;

  console.log(
    `%c[ONI] Opportunity Dev Test loaded.`,
    "color:#fcd470;font-weight:bold;",
  );
  console.log(
    `%cUsage:
  ONI.OppDevTest.run()                   — full flow (picker → pre → banner → post → card)
  ONI.OppDevTest.runOption("scan")        — skip picker, run scan pre + post directly
  ONI.OppDevTest.runOption("advantage")
  ONI.OppDevTest.runOption("affliction")
  ONI.OppDevTest.runOption("bonding")     — bond editor opens GM-side
  ONI.OppDevTest.simulateBondEdit()       — bond editor opens as if on player client
  ONI.OppDevTest.setActor("Actor.xxx")   — change default actor`,
    "color:#aaa;",
  );
})();
