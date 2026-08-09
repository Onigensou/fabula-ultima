// Can this actor actually PAY for that action?
//
// ActionReader's feasibility check (parseActionCost) only understands mp / ip /
// zenit. Everything else — Adoration, Brainwave, Grave, Zero Power, Fabula Points
// — parses to an unrecognized resource and is waved through as affordable. In real
// play that never mattered: a human can see the empty gauge and doesn't click the
// skill. An AI can't, so Blanche spent the whole first profiled fight casting
// Muleta with 0 of the 1 Adoration it costs — the animation played and the action
// dealt nothing.
//
// Custom resources are AE-backed clocks (`flags[MODULE].charges` / `chargesMax` /
// `chargeKey`), granted at battle start and swept at scene end — see
// [[project_hud_custom_resource_gauge]]. The legacy `clock_*` actor props are dead
// data; do NOT read them. skill-charges.findOnActor is the canonical reader.
//
// Deliberately CONSERVATIVE: a cost we cannot price is treated as unaffordable and
// logged. A sim that skips a usable skill loses a little damage; a sim that spams
// an unpayable one burns the whole turn and quietly poisons the numbers.

import { log } from "../logger.js";
import { findOnActor } from "../skill-charges.js";
import { findCostSubstitution, canSubstituteForShortfall } from "../skill-cost.js";

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// "1 Adoration" → { amount: 1, resource: "adoration" }
// "10 x T MP"   → { amount: 10, resource: "mp" }   (per-target multiplier stripped)
// "-" / "" / "X MP" → free (no fixed price we can check up front)
export function parseCost(costText) {
  const raw = String(costText ?? "").trim();
  if (!raw || raw === "-" || raw === "0") return { free: true, amount: 0, resource: "" };

  const m = raw.match(/\d+/);
  const amount = m ? Number(m[0]) : 0;

  const resource = norm(
    raw
      .replace(/\d+/g, " ")
      .replace(/\bx\s*t\b/gi, " ")   // "x T" per-target multiplier
      .replace(/[^a-z ]/gi, " ")
  );

  if (amount <= 0) return { free: true, amount: 0, resource };
  return { free: false, amount, resource };
}

// → { ok, have, need, res, unknown? }
export function canAfford(actor, costText) {
  const c = parseCost(costText);
  if (c.free) return { ok: true, free: true };

  const p = actor?.system?.props ?? {};
  const r = c.resource;
  const need = c.amount;

  // Zero Power's CURRENT value lives in `zero_power_value` (verified live: Hina 4,
  // Blanche 6). There is no `current_zp` on the actor — that name only exists on
  // the party DB actor's mirrored `member_currentzp_N`.
  const core = {
    mp: num(p.current_mp),
    ip: num(p.current_ip),
    zenit: num(p.zenit),
    zero_power: num(p.zero_power_value),
    zp: num(p.zero_power_value),
  };

  if (r in core) {
    const have = core[r] ?? 0;
    return { ok: have >= need, have, need, res: r };
  }

  // The sim does not spend Fabula Points (a table-level narrative resource, not a
  // combat one) — so anything priced in them is off the menu, on purpose.
  if (r.includes("fabula")) return { ok: false, have: 0, need, res: "fabula point" };

  // AE-backed custom resource. Match on chargeKey first (adoration/brainwave/…),
  // then fall back to the effect's name.
  const byKey = findOnActor(actor, { key: r });
  const hit = byKey.length
    ? byKey[0]
    : findOnActor(actor).find((x) => norm(x.effect?.name) === r || norm(x.effect?.name).includes(r));

  if (!hit) {
    // No gauge on the actor at all. Between battles that is the correct resting
    // state for a persistent counter, and mid-battle it means the grant never
    // landed — either way there is nothing to spend.
    log(`[SIM] cost: ${actor?.name} has no "${r}" resource — treating "${costText}" as unaffordable`);
    return { ok: false, have: 0, need, res: r, unknown: true };
  }

  return { ok: hit.charges >= need, have: hit.charges, need, res: r };
}

// Convenience: can this actor pay for this item right now?
//
// "Afford" must mean the same thing everywhere, so this asks the SAME question
// the real gates ask — including whether a cost SUBSTITUTION covers the
// shortfall (Vismagus: pay 2× the MP in HP instead). Without that, an MP-short
// spell reads unaffordable here, so the brain never proposes it and a scripted
// directive silently falls through to the brain — meaning the sim could never
// exercise Vismagus at all, and any balance run under-counted the caster.
//
// This is the same blind spot skill-picker had before 56ff06a4, in a second
// place; both now route through skill-cost's findCostSubstitution /
// canSubstituteForShortfall, which mirror the live gate's arithmetic including
// `min_remaining` (so we never call "affordable" a swap that would drop the
// caster to 0 and be refused).
export function canAffordItem(actor, item) {
  const direct = canAfford(actor, item?.system?.props?.cost);
  if (direct.ok || direct.unknown) return direct;
  // Only an MP shortfall on a Spell is substitutable — same gate as the picker.
  const missing = [{ resource: direct.res, label: direct.res, has: direct.have, need: direct.need }];
  const skillType = item?.system?.props?.skill_type;
  if (!canSubstituteForShortfall(missing, skillType)) return direct;
  const swap = findCostSubstitution(actor, new Map([[direct.res, direct.need]]));
  if (!swap) return direct;
  log(`[SIM] canAffordItem: "${item?.name}" unaffordable in ${direct.res} `
    + `(${direct.have}/${direct.need}) but covered by ${swap.sourceName ?? "a cost substitution"} `
    + `— treating as affordable`);
  return { ...direct, ok: true, viaSubstitution: swap };
}
