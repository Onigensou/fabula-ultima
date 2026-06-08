/**
 * Migration: 2026-06-09-guard-affinity-rs
 * ---------------------------------------------------------------------------
 * Make the Guard action's "Guard" AE the SINGLE SOURCE OF TRUTH for Guard's
 * "Resistance to all" — by having it OVERRIDE every element affinity to "RS"
 * while active, instead of being a bare status marker that each damage path
 * has to special-case.
 *
 * Before: the "Guard" AE carried `statuses: ["guard"]` but NO changes. So Guard
 * did nothing on its own — the attack path hard-coded `conditions.includes
 * ("Guard") → RS`, and the deal_damage path (applyToActor) didn't check Guard
 * at all (Pounce ignored a Guarding target's Resistance — the bug that surfaced
 * this).
 *
 * After: the "Guard" AE overrides `affinity_1..9` (the 9 element-affinity props:
 * physical, air, bolt, dark, earth, fire, ice, light, poison) to "RS" (mode
 * OVERRIDE). Every damage path already reads `actor.system.props.affinity_<n>`,
 * so all of them — attacks, deal_damage effects, status ticks — honor Guard
 * automatically. The override is non-destructive: removing the Guard AE restores
 * the actor's native affinities. The per-path `"Guard"` special-cases are then
 * removed (see action-profile computeAffinity + apply-damage-core applyToActor).
 *
 * Matches the Guard AE by NAME ("Guard") + `statuses` containing "guard" across
 * world items, so it self-heals on a co-dev's world. IDEMPOTENT: re-runs no-op
 * once the 9 changes are present. Tagged "idempotent": true.
 *
 * NOTE: existing already-applied Guard AEs (transient, ~1 turn) keep their old
 * empty changes until they expire; the NEXT Guard gets the override. New Guards
 * work immediately.
 */

export const key = "2026-06-09-guard-affinity-rs";
export const description =
  "Guard's AE overrides all element affinities to RS (single source of truth), " +
  "replacing per-damage-path Guard special-casing.";

const NS = "fabula-ultima-companion";
// affinity_1..9 = the 9 element affinities; OVERRIDE (mode 5).
//
// The VALUE must be `aeAffinityFloor("RS")`, NOT the bare literal "RS". CSB's
// ActiveEffect applier (syntaxExtender-conditionalChangeGate) evaluates change
// values as FORMULA expressions — a bare `RS` is an undefined identifier and
// resolves to 0 (which is why a literal "RS" silently applied 0). The
// `aeAffinityFloor` gate helper returns the string "RS" while preserving the
// target's current value if it's already IM/AB (so Guard can't downgrade an
// Immune/Absorb element). This mirrors the Rampart + Bodyguard AEs verbatim.
const RS_CHANGES = Array.from({ length: 9 }, (_, i) => ({
  key: `affinity_${i + 1}`, mode: 5, value: 'aeAffinityFloor("RS")', priority: 20,
}));

const sameChanges = (a, b) => {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const norm = (c) => `${c.key}|${c.mode}|${c.value}`;
  const sa = a.map(norm).sort(), sb = b.map(norm).sort();
  return sa.every((x, i) => x === sb[i]);
};

function isGuardAe(ae) {
  const n = String(ae?.name ?? "").trim().toLowerCase();
  const statuses = Array.from(ae?.statuses ?? []);
  return n === "guard" && statuses.some((s) => String(s).toLowerCase() === "guard");
}

export async function migrate(game, log = () => {}) {
  let updated = 0;
  for (const item of game.items?.contents ?? []) {
    for (const ae of (item.effects?.contents ?? [])) {
      if (!isGuardAe(ae)) continue;
      if (sameChanges(ae.changes ?? [], RS_CHANGES)) {
        log(`  "${item.name}"/Guard AE: affinity RS changes already present`);
        continue;
      }
      await ae.update({ changes: RS_CHANGES });
      updated++;
      log(`  "${item.name}"/Guard AE: set ${RS_CHANGES.length} affinity→RS override changes`);
    }
  }
  return { applied: true, summary: `Guard AE affinity-RS override ensured (AEs updated: ${updated})` };
}
