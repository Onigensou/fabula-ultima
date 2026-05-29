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
 *     Full simulation: portrait resolve → picker → banner → effect → chat card.
 *     Matches applyAndAnnounce() exactly, using the real actorUuid.
 *
 *   .runOption(optionId, actorUuid?)
 *     Skip the picker — jump straight to a specific option.
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
 *   oni.OppDevTest.simulateBondEdit()            // open bond editor only
 */
(() => {
  const TAG       = "[ONI][OppDevTest]";
  const SOCKET_CH = "module.fabula-ultima-companion";
  const GUARD     = "__ONI_OPP_DEV_TEST__";

  if (window[GUARD]) { console.debug(TAG, "Already installed — replacing."); }
  window[GUARD] = true;

  // ── Default actor (overridable with .setActor()) ──────────────────────────────
  let _defaultActorUuid = "Actor.dafTLBUscCDNgq8H";

  // ── Helpers ───────────────────────────────────────────────────────────────────
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

  const SFX_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_confirmed.wav";

  /** Replicate applyAndAnnounce() using only public APIs. Mirrors manager pre/post phase logic. */
  async function applyAndAnnounce(actorUuid, actorName, optionId, context = {}) {
    const sys      = globalThis.ONI?.OpportunitySystem;
    const effects  = window["oni.OpportunityEffects"];
    const chatCard = window["oni.OpportunityChatCard"];
    const cfg      = window["oni.OpportunityConfig"];

    const option = cfg?.OPTIONS?.find(o => o.id === optionId);
    if (!option) { console.error(TAG, "Unknown optionId:", optionId); return; }

    const handler = effects?.[optionId];
    const ctx     = { actorUuid, actorName, optionId, option, context };

    // 1. Pre-banner phase (targeting etc.) — mirrors manager applyAndAnnounce
    let preResult;
    if (handler?.pre) {
      console.debug(TAG, `Running pre phase: ${optionId}`);
      preResult = await handler.pre(ctx).catch(e => { console.error(TAG, `Pre phase error (${optionId}):`, e); return null; });
      if (preResult === null) { console.log(TAG, "Pre phase cancelled."); return; }
      try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: SFX_CONFIRM, volume: 0.8, autoplay: true }, false); } catch(_) {}
    }

    // 2. Banner (broadcast to all via socket + play locally)
    const bannerPayload = { optionLabel: option.label, optionIcon: option.icon, color: option.color ?? "#fcd470" };
    game.socket.emit(SOCKET_CH, { type: "OPP_LOG_BANNER", payload: bannerPayload });
    sys?.testBanner(optionId); // plays locally (socket.emit doesn't echo to sender)

    const bannerMs = (sys?.bannerEnterMs ?? 750) + (sys?.bannerLingerMs ?? 2500) + (sys?.bannerExitMs ?? 410);
    await new Promise(r => setTimeout(r, bannerMs));

    // 3. Post-banner phase (or legacy single handler)
    if (handler?.post) {
      console.debug(TAG, `Running post phase: ${optionId}`);
      await handler.post(ctx, preResult).catch(e => console.error(TAG, `Post phase error (${optionId}):`, e));
    } else if (typeof handler === "function") {
      console.debug(TAG, `Running effect handler: ${optionId}`);
      await handler(ctx).catch(e => console.error(TAG, `Effect handler error (${optionId}):`, e));
    } else {
      console.warn(TAG, `No handler registered for optionId: ${optionId}`);
    }

    // 4. Opportunity chat card
    await chatCard?.postOpportunityCard({ actorUuid, actorName, optionId, option, context })
      .catch(e => console.error(TAG, "postOpportunityCard failed:", e));
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  const api = {
    /** Override the default actor UUID for the current session. */
    setActor(uuid) {
      _defaultActorUuid = uuid;
      console.log(TAG, "Default actor set to:", uuid);
    },

    /**
     * Full simulation: resolves actor → shows picker → runs applyAndAnnounce.
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

      const result = await dialog.showPicker({
        actorName:    info.actorName,
        actorPortrait: info.portrait,
        options:      cfg.OPTIONS,
        canDecline:   true,
      });

      console.debug(TAG, "Picker result:", result);
      if (result?.cancelled || !result?.optionId) {
        console.log(TAG, "Picker cancelled.");
        return;
      }

      await applyAndAnnounce(uuid, info.actorName, result.optionId);
    },

    /**
     * Skip the picker — run a specific option directly.
     * Useful when you already know which option to test.
     */
    async runOption(optionId, actorUuid) {
      const uuid = actorUuid ?? _defaultActorUuid;
      console.log(TAG, "runOption()", { optionId, actorUuid: uuid });

      const info = await resolveActorInfo(uuid);
      if (!info) { console.error(TAG, "Could not resolve actor:", uuid); return; }

      await applyAndAnnounce(uuid, info.actorName, optionId);
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

      // Emit with targetUserId = our own ID so our socket listener picks it up
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
  ONI.OppDevTest.run()                   — full flow (picker → effect → card)
  ONI.OppDevTest.runOption("scan")        — skip picker, run scan directly
  ONI.OppDevTest.runOption("advantage")
  ONI.OppDevTest.runOption("affliction")
  ONI.OppDevTest.runOption("bonding")     — bond editor opens GM-side
  ONI.OppDevTest.simulateBondEdit()       — bond editor opens as if on player client
  ONI.OppDevTest.setActor("Actor.xxx")   — change default actor`,
    "color:#aaa;",
  );
})();
