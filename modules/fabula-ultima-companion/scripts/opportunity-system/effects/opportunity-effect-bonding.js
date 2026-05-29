// ============================================================================
// Opportunity Effect — Bonding
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Bonding]";
  const SOCKET_CH = "module.fabula-ultima-companion";
  const MSG_EDIT  = "OPP_BOND_EDIT";

  Hooks.once("ready", () => {
    const utils = window["oni.OppEffectUtils"] ?? {};

    // ── Socket listener — shows bond editor on the target player's client ────────
    game.socket.on(SOCKET_CH, async msg => {
      if (msg?.type !== MSG_EDIT) return;
      const { actorUuid, targetUserId } = msg.payload ?? {};
      console.debug(TAG, "[socket] OPP_BOND_EDIT received", { actorUuid, targetUserId, amTarget: game.user.id === targetUserId });
      if (game.user.id !== targetUserId) return;

      console.debug(TAG, "[socket] resolving actor:", actorUuid);
      const doc   = await fromUuid(actorUuid).catch(() => null);
      const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
      console.debug(TAG, "[socket] actor resolved:", actor ? `${actor.name} (isToken=${actor.isToken})` : "NULL");
      if (!actor) { console.warn(TAG, "[socket] could not resolve actor:", actorUuid); return; }

      const worldActor = actor.isToken ? (game.actors?.get(actor.id) ?? actor) : actor;
      console.debug(TAG, "[socket] showing bond UI for:", worldActor.name);
      await window["oni.OppBondUI"]?.show(worldActor);
      console.debug(TAG, "[socket] bond UI closed");
    });

    // ── Effect handler ────────────────────────────────────────────────────────────
    window["oni.OppEffectRegistry"]?.register("bonding", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { resolveActor, resolveOwnerUserId } = utils;
      if (!resolveActor || !resolveOwnerUserId) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      console.debug(TAG, "[step 1] resolving actor:", ctx.actorUuid);
      const actor = await resolveActor(ctx.actorUuid);
      console.debug(TAG, "[step 1] actor:", actor ? `${actor.name} (id=${actor.id})` : "NULL");
      if (!actor) { console.warn(TAG, "[exit] could not resolve actor"); return; }

      console.debug(TAG, "[step 2] resolving owner userId for:", ctx.actorUuid);
      const ownerUserId = resolveOwnerUserId(ctx.actorUuid);
      const amOwner     = !ownerUserId || game.user.id === ownerUserId;
      console.debug(TAG, "[step 2]", { ownerUserId, myUserId: game.user.id, amOwner });

      if (amOwner) {
        console.debug(TAG, "[step 3] GM is owner — showing bond UI directly (awaited)");
        const ui = window["oni.OppBondUI"];
        console.debug(TAG, "[step 3] OppBondUI available:", !!ui);
        await ui?.show(actor);
        console.debug(TAG, "[done] bond UI closed");
      } else {
        console.debug(TAG, "[step 3] emitting OPP_BOND_EDIT to player:", ownerUserId);
        game.socket.emit(SOCKET_CH, {
          type:    MSG_EDIT,
          payload: { actorUuid: ctx.actorUuid, actorName: ctx.actorName, targetUserId: ownerUserId },
        });
        console.debug(TAG, "[done] socket emitted — UI will open on player's client");
      }
    });

    console.debug(TAG, "Bonding effect + socket listener registered.");
  });
})();
