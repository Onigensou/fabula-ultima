// ============================================================================
// Battle Director — food buffs that grant Shield at conflict start
//
// Most cooking dishes are static modifiers and ride as plain AE changes (+HP,
// +damage, a condition immunity). Shield can't work that way: `shield_value` is
// a consumable pool that damage eats, not a derived stat, so an AE change would
// be re-applied every prepareData and make the buffer unspendable.
//
// So the dish stamps `flags.<ns>.conflictStartShield = N` on its food AE (see
// cooking-api.js applyDish) and this sweep grants the pool once per battle, at
// conflict_start. The meal lasts until the next rest, so the shield comes back
// fresh for every conflict in that stretch — which is exactly the point, and
// exactly why its number is tuned well below the one-shot salty dishes.
//
// RAISE-ONLY, never additive: Fabula Ultima's Shield rule is keep-highest, and
// the same rule already governs `set_resource` in the effect pipeline. A party
// that ate Golem Stew and then cast a bigger Shield keeps the bigger one; the
// meal never stacks on top of it.
// ============================================================================
const FLAG_NS = "fabula-ultima-companion";
const TAG = "[FUCompanion][BD][food]";

// Grant each combatant's conflict-start food shield. Idempotent: re-running
// (cold resume, a rewound Battle Start) can only ever raise the pool to the
// same target, never stack it.
export async function sweepFoodConflictStart(director) {
  const combatants = director?.dCombat?.combatants ?? director?.dCombat?.turns ?? [];
  const seen = new Set();

  for (const c of combatants) {
    const actor = c?.actor ?? (c?.actorUuid ? await fromUuid(c.actorUuid).catch(() => null) : null);
    if (!actor?.uuid || seen.has(actor.uuid)) continue;   // one actor, many tokens
    seen.add(actor.uuid);

    // Highest single grant wins — two food AEs shouldn't be possible (applyDish
    // clears the old one), but keep-highest is the safe read either way.
    let grant = 0;
    for (const eff of actor.effects ?? []) {
      if (eff.disabled) continue;
      const n = Number(eff.getFlag?.(FLAG_NS, "conflictStartShield") ?? 0) || 0;
      if (n > grant) grant = n;
    }
    if (grant <= 0) continue;

    const cur = Number(actor.system?.props?.shield_value) || 0;
    if (cur >= grant) continue;                            // keep-highest
    try {
      await actor.update({ "system.props.shield_value": grant });
      console.debug(TAG, `conflict-start shield ${cur} → ${grant} on ${actor.name}`);
    } catch (e) {
      console.warn(TAG, `failed to grant conflict-start shield to ${actor.name}`, e);
    }
  }
}
