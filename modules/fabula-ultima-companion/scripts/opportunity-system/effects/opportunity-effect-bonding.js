// ============================================================================
// Opportunity Effect — Bonding
//
// Effect: Create a Bond towards someone or add an emotion to an existing Bond.
//
// Flow:
//   GM-side effect handler runs → resolves who owns the actor →
//   If owner is on this client: show OppBondUI directly (awaited so the
//   opportunity chat card posts after the editor closes).
//   If owner is a different player: emit OPP_BOND_EDIT to their client
//   (fire-and-show; chat card posts immediately after on the GM side).
//
// Socket:
//   OPP_BOND_EDIT  GM → target player  { actorUuid, actorName, targetUserId }
//   (one-way — player saves directly via BondUpdater.writeBonds, no reply needed)
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
      if (game.user.id !== targetUserId) return;

      const doc   = await fromUuid(actorUuid).catch(() => null);
      const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
      if (!actor) { console.warn(TAG, "Could not resolve actor for bond edit:", actorUuid); return; }

      // Use world actor so writes persist (linked tokens share it; unlinked own it)
      const worldActor = actor.isToken ? (game.actors?.get(actor.id) ?? actor) : actor;
      await window["oni.OppBondUI"]?.show(worldActor);
    });

    // ── Effect handler — runs on GM's client ─────────────────────────────────────
    window["oni.OppEffectRegistry"]?.register("bonding", async (ctx) => {
      const { resolveActor, resolveOwnerUserId } = utils;
      if (!resolveActor || !resolveOwnerUserId) {
        console.error(TAG, "OppEffectUtils not loaded."); return;
      }

      const actor       = await resolveActor(ctx.actorUuid);
      if (!actor) { console.warn(TAG, "Could not resolve actor", ctx.actorUuid); return; }

      const ownerUserId = resolveOwnerUserId(ctx.actorUuid);
      const amOwner     = !ownerUserId || game.user.id === ownerUserId;

      if (amOwner) {
        // GM owns the actor (or no non-GM owner found) — show UI directly and await
        await window["oni.OppBondUI"]?.show(actor);
      } else {
        // Delegate to the owning player's client; handler returns immediately
        game.socket.emit(SOCKET_CH, {
          type:    MSG_EDIT,
          payload: { actorUuid: ctx.actorUuid, actorName: ctx.actorName, targetUserId: ownerUserId },
        });
      }
    });

    console.debug(TAG, "Bonding effect + socket listener registered.");
  });
})();
