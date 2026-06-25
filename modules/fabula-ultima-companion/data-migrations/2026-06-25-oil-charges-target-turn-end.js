/**
 * Migration: 2026-06-25-oil-charges-target-turn-end
 * ---------------------------------------------------------------------------
 * Redefine the "Oil" status: it now applies as a 3-CHARGE debuff that ticks
 * down at the END of the inflicted creature's turn (3 → 2 → 1 → gone), instead
 * of the old applier-turn-tied 3-turn duration. The Fire-vulnerability itself
 * (affinity_6 = VU) is unchanged and persists for as long as Oil is on the
 * bearer; the charge IS the visible lifetime.
 *
 * Mechanism (already in the engine, shared with Bleed): a charge-bearing AE
 * with `flags.fabula-ultima-companion.lifetimeMode = "target_turn_end"` is
 * decremented by `tickDirectorAEsForBearerTurnEnd` (called at TURN_END for the
 * actor whose turn just ended) — the VISIBLE charge is the countdown, deleted
 * at 0. Re-application with ae_duplicate_mode "replace" (Spitblaze, Mustard
 * Bomb) resets to 3. The statuscounter module badge stays hidden (BD
 * convention); the count surfaces via the director status HUD.
 *
 * Scope: ALL "Oil" AEs — the world Debuff hub (the canonical template that
 * Spitblaze references by name) AND the embedded copies that shadow it for
 * their own skills (Centimare/Sting, Dryad/Mustard Bomb) — so Oil behaves
 * uniformly everywhere. Sting's embedded Oil also shipped with EMPTY changes
 * (no affinity_6 = VU → mechanically inert); this restores the Fire-vuln change
 * to match the canonical template.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits; the patch logic is still drift-safe if re-run (skips already-set
 * fields). Oil lives on co-dev world data; sharing is via WORLD-DATA PUSH, not
 * the migration (feedback_world_data_sharing_hazard).
 */

export const key = "2026-06-25-oil-charges-target-turn-end";
export const description =
  "Oil status → 3-charge target_turn_end debuff (ticks at end of inflicted " +
  "creature's turn, 3→2→1→gone); restores affinity_6=VU on Sting's empty Oil. " +
  "Patches the Debuff hub + all embedded Oil copies.";

const NS = "fabula-ultima-companion";
const FIRE_VU_CHANGE = { key: "affinity_6", value: "VU", mode: 0, priority: 1 };

async function patchOilAe(ae, where, log) {
  const fu = ae.flags?.[NS] ?? {};
  const changes = Array.isArray(ae.changes) ? foundry.utils.deepClone(ae.changes) : [];
  const needsVu = !changes.some((c) => c.key === "affinity_6");
  const needsFlags =
    fu.lifetimeMode !== "target_turn_end" ||
    fu.chargeKey !== "oil" ||
    Number(fu.charges) !== 3 ||
    Number(fu.chargesMax) !== 3;
  if (!needsVu && !needsFlags) return 0;
  if (needsVu) changes.push({ ...FIRE_VU_CHANGE });
  await ae.update({
    changes,
    [`flags.${NS}.lifetimeMode`]: "target_turn_end",
    [`flags.${NS}.chargeKey`]: "oil",
    [`flags.${NS}.charges`]: 3,
    [`flags.${NS}.chargesMax`]: 3,
    "duration.rounds": 3,
    "duration.type": "turns",
  });
  log(`  [${where}] Oil → 3-charge target_turn_end${needsVu ? " (+restored affinity_6=VU)" : ""}`);
  return 1;
}

export async function migrate(game, log = () => {}) {
  let changed = 0;
  for (const it of (game.items?.contents ?? []))
    for (const ae of it.effects)
      if (ae.name === "Oil") changed += await patchOilAe(ae, `world/${it.name}`, log);
  for (const actor of (game.actors?.contents ?? []))
    for (const it of actor.items)
      for (const ae of it.effects)
        if (ae.name === "Oil") changed += await patchOilAe(ae, `${actor.name}/${it.name}`, log);
  return { applied: true, summary: `Oil status patched (charge target_turn_end): ${changed} AE(s)` };
}
