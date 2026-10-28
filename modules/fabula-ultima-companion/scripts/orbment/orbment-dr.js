// scripts/orbment/orbment-dr.js
//
// Orbment DAMAGE REDUCTION — the house armor Orbments (Guard / Guard: Physical /
// Ward / Ward: Physical / Bastion / Aegis). They write their OWN AE-scanned keys
// rather than the sheet's damage_receiving_* columns, so this module can cap the
// Orbment share per character while refinement's shield DR (which writes the
// sheet column damage_receiving_mod_physical) stays outside the cap:
//
//   orbment_dr_flat_<element> / orbment_dr_flat_all   → at most CAP.flat off a hit
//   orbment_dr_pct_<element>  / orbment_dr_pct_all    → at most CAP.pct % off a hit
//
// Read by BOTH damage paths so they can never disagree:
//   • Battle Director — skill-formulas resolveIncomingReduction imports this.
//   • apply-damage-core (a classic script, can't import) — reads the global
//     registered at the bottom, at call time.
// The keys have no template column, so they are summed off the actor's applied
// AE changes (same technique as skill-formulas sumAeChangeKey). Equip-gating
// comes from the compiler's `disabled: !isEquipped` on the Orbment AE.

export const ORBMENT_DR_CAP = Object.freeze({ flat: 5, pct: 20 });

const TYPED = new Set(["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"]);

function sumAeKey(actor, key) {
  if (!actor) return 0;
  let total = 0;
  const effects = actor.appliedEffects ?? actor.effects?.contents ?? actor.effects ?? [];
  for (const e of effects) {
    if (e?.disabled) continue;
    for (const c of (e.changes ?? [])) {
      if (c?.key === key) total += Number(c.value) || 0;
    }
  }
  return total;
}

// The Orbment reduction a hit of `element` takes on `actor`, already capped.
// Returns { flat, pct, flatRaw, pctRaw } — raw totals are for tooltips/debugging.
export function orbmentReduction(actor, element) {
  if (!actor) return { flat: 0, pct: 0, flatRaw: 0, pctRaw: 0 };
  const el = String(element ?? "").trim().toLowerCase();
  const typed = TYPED.has(el);
  const flatRaw = sumAeKey(actor, "orbment_dr_flat_all") + (typed ? sumAeKey(actor, `orbment_dr_flat_${el}`) : 0);
  const pctRaw = sumAeKey(actor, "orbment_dr_pct_all") + (typed ? sumAeKey(actor, `orbment_dr_pct_${el}`) : 0);
  return {
    flat: Math.max(0, Math.min(flatRaw, ORBMENT_DR_CAP.flat)),
    pct: Math.max(0, Math.min(pctRaw, ORBMENT_DR_CAP.pct)),
    flatRaw, pctRaw,
  };
}

globalThis.FUOrbment = Object.assign(globalThis.FUOrbment ?? {}, { orbmentReduction, ORBMENT_DR_CAP });
