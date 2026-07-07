// Skill charges — AE-backed counters for once-per-X mechanics + Protect/
// Counterattack-style limited reactions.
//
// Charges live on Active Effects via flags
// (`flags["fabula-ultima-companion"].charges` / `chargesMax` / `chargeKey`),
// same data shape the legacy AEM charges API writes. This file is a
// from-scratch reader/writer; no import from
// `scripts/active-effect-manager/`. The shared schema means a charge AE
// applied by legacy infrastructure is readable here and vice versa.
//
// Director is GM-only in v1 — direct embedded-doc updates, no GMExecutor
// hop. If the director ever runs player-side, this file is the right
// place to add the cross-permission shim.

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

// Read the charges block off a single AE. Returns null when the AE
// doesn't carry a charges flag at all (so callers can short-circuit).
export function readCharges(effect) {
  if (!effect) return null;
  const f = effect.flags?.[FLAG_NS] ?? {};
  // Foundry stores undefined-vs-missing the same way — be permissive.
  if (f.charges == null && f.chargesMax == null && f.chargeKey == null) return null;
  return {
    charges: Number(f.charges ?? 0) || 0,
    max:     f.chargesMax != null ? Number(f.chargesMax) : null,
    key:     f.chargeKey ?? null,
  };
}

// A "persistent counter" AE (a clock / points pool — Brainwave, Grave,
// Adoration) treats 0 as a valid resting state: it must stay on the actor
// (badge showing 0/max) until the scene-end sweep clears it, NOT vanish the
// instant it empties. It opts out via the existing `lifetimeMode` field —
// no new flag. Every other charge AE (once-per-X "ready" gates, active
// cooldowns) still deletes at 0 so the next refresh re-grants a fresh one.
export function isPersistentCounter(effect) {
  const f = effect?.flags?.[FLAG_NS] ?? {};
  const mode = f.lifetimeMode ?? f.directorAppliedBy?.lifetimeMode ?? "";
  return String(mode).toLowerCase() === "persistent_counter";
}

// Find all charge-bearing AEs on an actor, optionally filtered by key.
// `includeDisabled` defaults to false — disabled AEs don't gate anything.
export function findOnActor(actor, { key = null, includeDisabled = false } = {}) {
  if (!actor?.effects) return [];
  const out = [];
  for (const eff of actor.effects) {
    if (!includeDisabled && eff.disabled) continue;
    const c = readCharges(eff);
    if (!c) continue;
    if (key != null && c.key !== key) continue;
    out.push({ effect: eff, ...c });
  }
  return out;
}

// Add a statuscounter-badge sync to a charge update — but ONLY when the AE's
// author opted into a VISIBLE badge (`flags.statuscounter.visible === true`).
//
// The 3rd-party "statuscounter" module renders a number badge from
// `flags.statuscounter.value`. BD's convention is to author charge AEs with
// `statuscounter.visible: false` (the count, when surfaced at all, shows via the
// director status HUD — NOT the module badge). The old code FORCE-wrote
// `visible: true` on every charge tick, which stamped an unwanted blue number on
// the token (e.g. Acceleration ticking 2→1). Honor the authored visibility
// instead: sync `value` for AEs that asked to show a badge, leave everything else
// untouched (no badge created, none forced visible).
function withBadgeSync(effect, update, value) {
  const sc = effect?.flags?.statuscounter;
  if (sc && sc.visible === true) update["flags.statuscounter.value"] = value;
  return update;
}

// Consume `count` charges from a single AE. When charges reach 0 AND
// `deleteWhenEmpty` is true (the default), the AE is deleted —
// once-per-X "ready" AEs vanish on use; the next refresh re-applies a
// fresh ready AE. Returns `{ ok, consumed, remaining, deleted }`.
//
// Caller is responsible for finding the right AE first (typically via
// `findOnActor(actor, { key })` and picking one with `charges > 0`).
export async function consume(effect, { count = 1, deleteWhenEmpty = true } = {}) {
  if (!effect) return { ok: false, reason: "no-effect" };
  const c = readCharges(effect);
  if (!c) return { ok: false, reason: "no-charges-flag" };

  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return { ok: true, consumed: 0, remaining: c.charges, deleted: false };
  if (c.charges < n) {
    return { ok: false, reason: "insufficient", consumed: 0, remaining: c.charges, deleted: false };
  }

  const remaining = c.charges - n;
  try {
    if (remaining === 0 && deleteWhenEmpty && !isPersistentCounter(effect)) {
      await effect.delete();
      log(`charges.consume: ${effect.name} drained (${n}/${c.charges}) → deleted`);
      return { ok: true, consumed: n, remaining: 0, deleted: true };
    }
    await effect.update(withBadgeSync(effect, { [`flags.${FLAG_NS}.charges`]: remaining }, remaining));
    log(`charges.consume: ${effect.name} ${c.charges} → ${remaining} (consumed ${n})`);
    return { ok: true, consumed: n, remaining, deleted: false };
  } catch (e) {
    warn("charges.consume: write failed", e);
    return { ok: false, reason: "write-failed", consumed: 0, remaining: c.charges, deleted: false, error: e };
  }
}

// Set the absolute charge count on an AE. Used for refreshes (start of
// scene / round). Same delete-when-empty semantics as consume().
export async function set(effect, value, { deleteWhenEmpty = true } = {}) {
  if (!effect) return { ok: false, reason: "no-effect" };
  const c = readCharges(effect);
  if (!c) return { ok: false, reason: "no-charges-flag" };
  const next = Math.max(0, Math.floor(Number(value) || 0));
  try {
    if (next === 0 && deleteWhenEmpty && !isPersistentCounter(effect)) {
      await effect.delete();
      return { ok: true, newValue: 0, deleted: true };
    }
    await effect.update(withBadgeSync(effect, { [`flags.${FLAG_NS}.charges`]: next }, next));
    return { ok: true, newValue: next, deleted: false };
  } catch (e) {
    warn("charges.set: write failed", e);
    return { ok: false, reason: "write-failed", deleted: false, error: e };
  }
}

// Convenience — find + consume in one call. Used by the
// `consume_charge` effect_kind dispatcher. Returns the same shape as
// consume() plus `{ effect }` indicating which AE was hit. Picks the
// first matching enabled charge AE; if multiple exist for the same key,
// the AEs' own ordering wins (rare — usually one per key).
export async function findAndConsume(actor, key, { count = 1, deleteWhenEmpty = true } = {}) {
  const hits = findOnActor(actor, { key });
  const usable = hits.find((h) => h.charges >= count);
  if (!usable) {
    return { ok: false, reason: "no-matching-charge", effect: null, consumed: 0, remaining: 0, deleted: false };
  }
  const r = await consume(usable.effect, { count, deleteWhenEmpty });
  return { ...r, effect: usable.effect };
}
