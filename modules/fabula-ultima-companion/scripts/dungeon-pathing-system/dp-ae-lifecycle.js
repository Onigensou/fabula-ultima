// ============================================================================
// Dungeon Pathing System — Active Effect Lifecycle
//
// Ticks down per-turn AEs on every party member each dungeon turn.
//
// Why party-wide: the party moves as a single token representing all members.
// One step = one turn for everyone in the party, so all members' AEs advance
// together. Individual actors can still be ticked via tickAEsOnActor().
//
// Party resolution: CampSystem.Party.resolve() reads member_id_1..4 from the
// DB actor, the same source used by the camp and rest systems.
//
// Two AE categories handled:
//   Director-stamped  — has `directorAppliedBy` with `turnsRemaining`.
//                       Decrement that field so the AE stays consistent
//                       if the member re-enters battle.
//   Non-stamped       — no `directorAppliedBy` (manual, camp, tile effects).
//                       `flags.<MODULE>.dungeonTurnsRemaining` is pre-stamped
//                       by dp-tile-effect-engine.buildEffectRefs() so the HUD
//                       counter is correct from the moment the AE lands.
//                       tickAEsOnActor falls back to lazy-init only for AEs
//                       applied outside the tile engine (camp events, macros).
//
// Skip conditions (matching battle director behaviour):
//   directorPermanent === true   — permanent; never auto-expires
//   lifetimeMode "on_activation" — charge-governed; expires via consume_charge
//   lifetimeMode "round_end"     — group-round mechanic, not per-character-step
//
// Only the GM client executes writes. Because Hooks.callAll is local-only,
// the TURN_END hook fires on the player's client; dp-socket tickPartyAEs()
// routes the write to the GM via raw game.socket (same pattern as markVisited).
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const FLAG_NS   = MODULE_ID;
  const TAG       = "[DungeonPathing][AELifecycle]";
  const DEFAULT_DURATION = 3;

  // ── Single-actor tick ──────────────────────────────────────────────────────
  // Can also be called manually for testing or custom scenarios.

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
      try { await actor.updateEmbeddedDocuments("ActiveEffect", toUpdate, { render: false }); }
      catch (e) { console.warn(TAG, "update failed for", actor.name, e); }
    }
    if (toDelete.length) {
      try { await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete, { render: false }); }
      catch (e) { console.warn(TAG, "delete failed for", actor.name, e); }
    }

    if (ticked) {
      console.log(TAG, `ticked ${ticked} AE(s) on "${actor.name}"; expired: [${expired.join(", ")}]`);
    }
    return { ticked, expired };
  }

  // ── Party-wide tick ────────────────────────────────────────────────────────
  // Default entry point: resolves all party members and ticks each in parallel.

  async function tickPartyAEs() {
    let members;
    try {
      members = await CampSystem?.Party?.resolve?.() ?? [];
    } catch (e) {
      console.warn(TAG, "party resolve failed", e);
      members = [];
    }

    if (!members.length) {
      console.warn(TAG, "no party members found — skipping AE tick");
      return;
    }

    // Short-circuit: if no actor has a tickable AE, skip all DB roundtrips.
    // This is the common case when walking through dungeon without active debuffs.
    const anyTickable = members.some(({ actor }) =>
      (actor?.effects ?? []).some(eff => {
        const f = eff.flags?.[FLAG_NS] ?? {};
        if (f.directorPermanent === true) return false;
        const mode = String(f.lifetimeMode ?? "").trim().toLowerCase();
        return mode !== "on_activation" && mode !== "round_end";
      })
    );
    if (!anyTickable) return;

    const results = await Promise.all(members.map(({ actor }) => tickAEsOnActor(actor)));
    const totals = results.reduce(
      (acc, r) => { acc.ticked += r.ticked; acc.expired.push(...r.expired); return acc; },
      { ticked: 0, expired: [] }
    );

    if (totals.ticked) {
      console.log(TAG, `dungeon turn: ticked ${totals.ticked} AE(s) across ${members.length} member(s); expired: [${totals.expired.join(", ")}]`);
    }
    return totals;
  }

  // ── Hook registration ──────────────────────────────────────────────────────
  // Hooks.callAll is LOCAL — turnEnd only fires on the client running the turn
  // loop (the player who owns the dungeon UI, not the GM). We must not guard
  // with isGM here; instead, delegate to DP.Socket.tickPartyAEs() which calls
  // directly if GM and emits a raw socket message to the GM if not.

  Hooks.on(DP.HOOKS.TURN_END, async () => {
    await DP.Socket.tickPartyAEs();
  });

  // Expose for manual testing via evalGM / test bridge
  DP.AELifecycle = { tickAEsOnActor, tickPartyAEs };

  console.debug(TAG, "Installed; listening on", DP.HOOKS.TURN_END);
})();
