// ============================================================================
// Dungeon Pathing System — Active Effect Lifecycle
//
// Ticks down per-turn AEs on the moving actor each dungeon turn.
// Mirrors the battle director's tickDirectorAEsForApplier logic but works
// bearer-side: AEs tick when the character who *carries* them takes a step,
// not when the applier acts (there is no applier turn in dungeon mode).
//
// Two AE categories handled:
//   Director-stamped  — has `directorAppliedBy` with `turnsRemaining`.
//                       We decrement that same field so the AE stays
//                       consistent if the character re-enters battle.
//   Non-stamped       — no `directorAppliedBy` (manually applied, camp
//                       activities, tile effects). We lazy-init
//                       `flags.<MODULE>.dungeonTurnsRemaining` from
//                       `duration.rounds`, falling back to DEFAULT_DURATION.
//
// Skip conditions (same as battle director):
//   directorPermanent === true  — permanent; never auto-expires
//   lifetimeMode "on_activation"— charge-governed; expires by consume_charge
//   lifetimeMode "round_end"   — group-round mechanic; not per-character-turn
//
// Only the GM client executes writes; all other clients return early.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const FLAG_NS   = MODULE_ID;
  const TAG       = "[DungeonPathing][AELifecycle]";
  const DEFAULT_DURATION = 3;

  // ── Core tick function ─────────────────────────────────────────────────────

  async function tickAEsOnActor(actor) {
    if (!actor) return { ticked: 0, expired: [] };

    const toDelete = [];
    const toUpdate = [];
    const expired  = [];
    let   ticked   = 0;

    for (const eff of actor.effects ?? []) {
      const flags = eff.flags?.[FLAG_NS] ?? {};

      // Skip permanent / non-per-turn AEs
      if (flags.directorPermanent === true) continue;
      const mode = String(flags.lifetimeMode ?? "").trim().toLowerCase();
      if (mode === "on_activation" || mode === "round_end") continue;

      const stamp = flags.directorAppliedBy;
      let turnsRemaining;
      let updatePath;

      if (stamp && stamp.turnsRemaining != null) {
        // Director-stamped: reuse the existing counter so battle + dungeon
        // remain consistent if the actor transitions between modes.
        turnsRemaining = Number(stamp.turnsRemaining);
        updatePath = `flags.${FLAG_NS}.directorAppliedBy.turnsRemaining`;
      } else {
        // Non-stamped: lazy-init our dungeon-specific counter.
        if (flags.dungeonTurnsRemaining != null) {
          turnsRemaining = Number(flags.dungeonTurnsRemaining);
        } else {
          const explicit = Number(eff.duration?.rounds);
          turnsRemaining = (Number.isFinite(explicit) && explicit > 0)
            ? explicit
            : DEFAULT_DURATION;
        }
        updatePath = `flags.${FLAG_NS}.dungeonTurnsRemaining`;
      }

      ticked++;
      const next = turnsRemaining - 1;

      if (next <= 0) {
        toDelete.push(eff.id);
        expired.push(eff.name);
      } else {
        toUpdate.push({ _id: eff.id, [updatePath]: next });
      }
    }

    if (toUpdate.length) {
      try { await actor.updateEmbeddedDocuments("ActiveEffect", toUpdate); }
      catch (e) { console.warn(TAG, "update failed for", actor.name, e); }
    }
    if (toDelete.length) {
      try { await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete); }
      catch (e) { console.warn(TAG, "delete failed for", actor.name, e); }
    }

    if (ticked) {
      console.log(TAG, `ticked ${ticked} AE(s) on "${actor.name}"; expired: [${expired.join(", ")}]`);
    }
    return { ticked, expired };
  }

  // ── Hook registration ──────────────────────────────────────────────────────

  Hooks.on(DP.HOOKS.TURN_END, async ({ tokenDoc }) => {
    if (!game.user?.isGM) return;   // only GM writes; Hooks.callAll fires on all clients

    const actor = tokenDoc?.actor;
    if (!actor) return;

    await tickAEsOnActor(actor);
  });

  // Expose for manual testing via evalGM / test bridge
  DP.AELifecycle = { tickAEsOnActor };

  console.debug(TAG, "Installed; listening on", DP.HOOKS.TURN_END);
})();
