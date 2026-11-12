// ============================================================================
// Dungeon Healing tile — pure rules (no Foundry, no DOM). 2026-11-12, mockup
// https://claude.ai/artifact/Hzuo1CwmWMRzdqDzW5JWrk.
//
//   heal = max(HEAL_MIN, floor(member's max HP × HEAL_FRACTION))
//
// Goal (user, 2026-11-12): heal a healthy amount, but the tile is not meant to
// bring anyone to full. A share of each member's own max HP scales with level
// on its own and treats the small-HP members the same as the tanks. A member
// at 0 HP is skipped (same as the Trap). The tile's own "Amount" field is
// ignored on a Healing tile, the way a Trap ignores it.
// This file owns the numbers; the engine owns the writes; dp-trap-fx.js owns
// what the players see.
// ============================================================================

export const HEAL_FRACTION = 0.35;
export const HEAL_MIN = 10;

export function healAmount(maxHp) {
  const m = Math.max(0, Math.floor(Number(maxHp) || 0));
  return Math.max(HEAL_MIN, Math.floor(m * HEAL_FRACTION));
}

// One member's on-screen row.
//   before / max : the member's HP and max HP before the heal
//   rec          : optional dry-run applyDamage record ({ hp:{from,to} }); when
//                  given, its result wins (healing modifiers, caps)
export function describeHeal(before, max, rec = null) {
  const b = Math.max(0, Math.floor(Number(before) || 0));
  const maxHp = Math.max(1, Math.floor(Number(max) || 1));
  if (b <= 0) return { before: 0, after: 0, max: maxHp, gain: 0, ko: true, full: false, cleared: false };
  let after = rec?.hp ? Math.floor(Number(rec.hp.to) || 0) : b + healAmount(maxHp);
  after = Math.min(maxHp, Math.max(b, after));
  return {
    before: b,
    after,
    max: maxHp,
    gain: after - b,
    ko: false,
    full: after >= maxHp,
    cleared: b <= maxHp / 2 && after > maxHp / 2,
  };
}

globalThis.DungeonPathing ??= {};
globalThis.DungeonPathing.HealRules = Object.freeze({ HEAL_FRACTION, HEAL_MIN, healAmount, describeHeal });
