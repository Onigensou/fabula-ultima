/**
 * Migration: 2026-06-27-burn-emit-status-trigger
 * ---------------------------------------------------------------------------
 * Make the Burn status announce when it TRIGGERS, so reactions fire off a Burn
 * tick regardless of whether it dealt damage, healed (absorb), or did nothing
 * (immune) — and so a skill that "triggers Burn" via the trigger_status
 * effect_kind announces the SAME signal. Adds two generic fields to the Burn
 * AE's carried `deal_damage` DoT row(s):
 *
 *   emit_trigger: "creature_status_triggered"  — the generic "a status produced
 *                  its effect" event (registry: reaction-triggers.config,
 *                  observer-aware: instance-settle LEDGER_FAMILY). Emitted by
 *                  dealDamageApply DECOUPLED from the HP delta (pre-affinity
 *                  amount>0), so absorb/immune ticks still count.
 *   emit_status:  "Burn"                         — names which status, carried in
 *                  payload.status so a listener scopes with reaction_status_filter.
 *
 * Consumed by the Wandering Flame's "Zero Trigger: Ignition" (+10 MP +1 Zero
 * Power whenever a creature's Burn triggers). The trigger_status effect_kind
 * reads THIS same tick row's formula, so Flame Claw / Meteor inherit the emit for
 * free. Poison/Bleed/etc. can reuse the trigger by setting their own emit_status.
 *
 * SUPERSEDES the reaction_origin_filter approach for "Burn triggered": that keyed
 * off the HP-LOSS ledger event and missed absorb/heal + immune ticks (the
 * decoupled event fixes both). reaction_origin_filter remains a general
 * "react to damage from source X" filter; Ignition no longer uses it.
 *
 * Drift-safe + idempotent (mirrors 2026-06-25-burn-dot-ceil): walks every Burn AE,
 * clones reactionConfig, stamps the fields on each deal_damage row that lacks
 * them, skips an AE already wired. Touches the world Debuff hub + any embedded
 * copy carrying its own DoT row. IDEMPOTENT.
 */

export const key = "2026-06-27-burn-emit-status-trigger";
export const description =
  "Burn DoT rows announce creature_status_triggered (emit_status \"Burn\"), " +
  "decoupled from the HP delta, so reactions (Ignition) fire on every Burn tick " +
  "incl. absorb/immune. Generic — any status reuses it. Patches Burn AE + copies.";

const NS = "fabula-ultima-companion";
const EMIT_TRIGGER = "creature_status_triggered";
const EMIT_STATUS = "Burn";

async function patchBurnAe(ae, where, log) {
  const rc = foundry.utils.deepClone(ae.flags?.[NS]?.reactionConfig ?? {});
  const et = rc.effect_table ?? rc.reaction_effect_table;
  if (!et || typeof et !== "object") return 0;
  let changed = false;
  for (const r of Object.values(et)) {
    if (!r || r.effect_kind !== "deal_damage") continue;
    if (r.emit_trigger === EMIT_TRIGGER && r.emit_status === EMIT_STATUS) continue;
    r.emit_trigger = EMIT_TRIGGER;
    r.emit_status = EMIT_STATUS;
    changed = true;
  }
  if (!changed) return 0;
  await ae.update({ [`flags.${NS}.-=reactionConfig`]: null });
  await ae.update({ [`flags.${NS}.reactionConfig`]: rc });
  log(`  [${where}] Burn DoT -> emit ${EMIT_TRIGGER} (${EMIT_STATUS})`);
  return 1;
}

export async function migrate(game, log = () => {}) {
  let changed = 0;
  for (const it of (game.items?.contents ?? []))
    for (const ae of it.effects)
      if (ae.name === "Burn") changed += await patchBurnAe(ae, `world/${it.name}`, log);
  for (const actor of (game.actors?.contents ?? []))
    for (const it of actor.items)
      for (const ae of it.effects)
        if (ae.name === "Burn") changed += await patchBurnAe(ae, `${actor.name}/${it.name}`, log);
  return { applied: true, summary: `Burn emit_trigger wired: ${changed} AE(s)` };
}
