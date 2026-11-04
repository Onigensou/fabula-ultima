// ============================================================================
// Gain-number coalescing (pure). User rule, 2026-11-04: a number must tell the
// player how much was gained, not give false information.
//
// Three Lightning Charges in one Bolt spell used to float three "+5" MP numbers
// 120 ms apart from the same spot — read as "+5" while the Kirin gained 15.
// Gains of the SAME resource on the SAME creature inside `windowMs` now float
// as ONE total, with one impact and one sound.
//
// Scope, on purpose: GAINS only (HP / MP / shield / IP …). Damage numbers and
// "Miss" texts keep one float per event — a multi-hit or a Prophetic Defender
// redirect that misses five times is more satisfying as five numbers. Anything
// carrying a Chain strike index (`cascade`) is never merged either.
// ============================================================================

export const GAIN_COALESCE_MS = 150;

// emit({ tokenUuid, resource, amount, count }) is called once per merged group.
export function createGainCoalescer({ windowMs = GAIN_COALESCE_MS, emit, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const pending = new Map();
  // noMerge: the move opted out (flags.<NS>.separateNumbers) — one float per gain, at once.
  return function push({ tokenUuid, resource = "hp", amount = 0, cascade = 0, noMerge = false } = {}) {
    const n = Number(amount) || 0;
    if (!(n > 0) || !tokenUuid) return;
    if (cascade || noMerge) { emit({ tokenUuid, resource, amount: n, count: 1 }); return; }
    const key = `${tokenUuid}|${String(resource).toLowerCase()}`;
    const open = pending.get(key);
    if (open) { open.amount += n; open.count += 1; return; }
    const group = { tokenUuid, resource, amount: n, count: 1 };
    pending.set(key, group);
    setTimer(() => { pending.delete(key); emit(group); }, windowMs);
  };
}
