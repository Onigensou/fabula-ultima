// ============================================================================
// Opportunity Effect — Bonding
//
// Flow (pre/post):
//   pre  — opens the bond editor on the owning client.
//          For GM-owned actors: awaits the editor close before returning.
//          For player-owned actors: dispatches via socket (fire-and-forget) and
//          returns immediately — the player edits while the banner plays.
//   post — no-op; all meaningful action happened in pre.
//
// Socket: OPP_BOND_EDIT  GM → targeted player  (bond editor opens on their screen)
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Bonding]";
  const SOCKET_CH = "module.fabula-ultima-companion";
  const MSG_EDIT  = "OPP_BOND_EDIT";

  Hooks.once("ready", () => {
    const utils = window["oni.OppEffectUtils"] ?? {};

    // ── Socket listener — shows bond editor on the target player's client ────
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

    // ── Effect handler ───────────────────────────────────────────────────────
    window["oni.OppEffectRegistry"]?.register("bonding", {

      // ── Pre phase: open bond editor (prompt phase — all user interaction) ──
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { resolveActor, resolveOwnerUserId } = utils;
        if (!resolveActor || !resolveOwnerUserId) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        console.debug(TAG, "[pre] resolving actor:", ctx.actorUuid);
        const actor = await resolveActor(ctx.actorUuid);
        console.debug(TAG, "[pre] actor:", actor ? `${actor.name} (id=${actor.id})` : "NULL");
        if (!actor) { console.warn(TAG, "[pre] could not resolve actor"); return null; }

        const ownerUserId = resolveOwnerUserId(ctx.actorUuid);
        const amOwner     = !ownerUserId || game.user.id === ownerUserId;
        console.debug(TAG, "[pre]", { ownerUserId, myUserId: game.user.id, amOwner });

        if (amOwner) {
          // GM-owned actor: open bond editor locally and await close before returning.
          // Banner plays only after the GM finishes editing — clean sequential flow.
          console.debug(TAG, "[pre] owner — showing bond UI directly (awaited)");
          await window["oni.OppBondUI"]?.show(actor);
          console.debug(TAG, "[pre] bond UI closed");
        } else {
          // Player-owned actor: dispatch to player via socket; return immediately.
          // Banner plays concurrently — the player edits bonds while the banner is shown.
          console.debug(TAG, "[pre] dispatching OPP_BOND_EDIT to player:", ownerUserId);
          game.socket.emit(SOCKET_CH, {
            type:    MSG_EDIT,
            payload: { actorUuid: ctx.actorUuid, actorName: ctx.actorName, targetUserId: ownerUserId },
          });
          console.debug(TAG, "[pre] socket emitted — UI will open on player client");
        }

        return { bonded: true };
      },

      // ── Post phase: no-op ─────────────────────────────────────────────────
      async post(_ctx, _preResult) {},
    });

    console.debug(TAG, "Bonding effect + socket listener registered.");
  });
})();
