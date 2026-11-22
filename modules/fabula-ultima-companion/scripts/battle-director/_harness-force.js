// Pure force-dice sizing for the director test harness (no Foundry globals, so
// Node tests can import it). DEF vs MDEF follows the move's defense_target_type
// via the SAME selector COMPUTE uses (snapshot.js resolvesVsMagicDefense), with
// the action kind as the fallback when blank/"default".
// Expand semantic force shorthands (`hit`, `miss`, `crit`, `fumble`) into
// concrete dice values that produce the requested outcome. Raw `{rA, rB}`
// values in `force` are preserved and override semantic flags.
//
// Decision rules (in order):
//   crit:   rA = rB = max die (8 / 10 / 12 etc.) — paired top dice. Author
//           intent: "show me what happens on crit". Caller may want a
//           specific paired non-max via raw rA/rB.
//   fumble: rA = rB = 1 (always satisfies fumbleThreshold ≥ 1)
//   hit:    pick the SMALLEST (rA, rB) where rA + rB + checkBonus
//           >= min(target.defense | magic_defense). If even max dice can't
//           hit, falls back to max + max (caller gets to see the miss).
//   miss:   pick the LARGEST (rA, rB) where rA + rB + checkBonus < target's
//           defense. Avoids fumble (both ≤ threshold) and crit (rA === rB
//           ≥ 6). Falls back to (1, 2) if no valid combo (target is too
//           weak — caller's request is impossible without fumbling).
export function expandForceSemantics(force, { dA, dB, fumbleThreshold, checkBonus, vsMdef, isSpell, targetSnaps }) {
  if (!force) return null;
  const out = { ...force };
  if (Number.isFinite(out.rA) && Number.isFinite(out.rB)) return out;

  const useMdef = (vsMdef ?? !!isSpell);
  const defs = (targetSnaps ?? []).map((t) => useMdef ? (t.magicDefense ?? 0) : (t.defense ?? 0));
  const minDef = defs.length ? Math.min(...defs) : 0;
  // force.hit must hit EVERY target (one shared roll): size it to the HIGHEST defense.
  // Sizing it to the lowest hit only the weakest target on a multi-target spell (toolkit T3, 2026-11-22).
  const maxDef = defs.length ? Math.max(...defs) : 0;

  // A crit is a matching pair, so it must fit on the SMALLER die. (This used to
  // force dA on both dice; the old uniform override then drew an impossible 10
  // on a d8. Faces are now forced exactly and clamped to the die.)
  if (force.crit) { const v = Math.min(dA, dB); out.rA = v; out.rB = v; return out; }
  if (force.fumble) { out.rA = 1; out.rB = 1; return out; }
  if (force.hit) {
    // Greedy: cheapest hit on ALL targets. Iterate (a, b) where a+b+checkBonus >= maxDef.
    for (let a = 1; a <= dA; a++) {
      for (let b = 1; b <= dB; b++) {
        if (a === b && a >= 6) continue;  // skip crit
        if (a <= fumbleThreshold && b <= fumbleThreshold) continue;  // skip fumble
        if (a + b + checkBonus >= maxDef) { out.rA = a; out.rB = b; return out; }
      }
    }
    out.rA = dA; out.rB = dB;  // even max can't hit — caller sees the miss
    return out;
  }
  if (force.miss) {
    for (let a = dA; a >= 1; a--) {
      for (let b = dB; b >= 1; b--) {
        if (a === b && a >= 6) continue;
        if (a <= fumbleThreshold && b <= fumbleThreshold) continue;
        if (a + b + checkBonus < minDef) { out.rA = a; out.rB = b; return out; }
      }
    }
    out.rA = 1; out.rB = 2;  // no valid combo — caller sees a fumble-ish result
    return out;
  }
  return out;
}
