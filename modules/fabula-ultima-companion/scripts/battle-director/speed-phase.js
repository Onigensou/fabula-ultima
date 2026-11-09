// speed-phase.js — Quicken / Delay → the phase a creature acts in.
//
// A round runs in three phases (user ruling, 2026-11-09):
//   QUICKEN (+1) → NORMAL (0) → DELAY (-1)
// Inside a phase the sides alternate as before, and the alternation carries
// straight across a phase border (no double turn at a phase change).
//
//   • Quicken only        → +1
//   • Delay only          → -1
//   • both, or neither    →  0   (both statuses stay on the creature; dispel one
//                                 and the other takes effect at the next pick)
//
// Pure: no Foundry globals. director-combat.js, the round tracker and the
// summon free-action hold all read the tier through here so they agree.

import { slugsOf } from "./status-classifier.js";

export const TIER = Object.freeze({ QUICKEN: 1, NORMAL: 0, DELAY: -1 });

// Phases in the order a round plays them.
export const PHASE_ORDER = Object.freeze([TIER.QUICKEN, TIER.NORMAL, TIER.DELAY]);

const QUICKEN_SLUGS = new Set(["quicken", "quickened"]);
// status-classifier aliases "delay" → "delayed"; both listed for safety.
const DELAY_SLUGS = new Set(["delayed", "delay"]);

// Gear carriers count only while equipped (same rule as prevent_ambush in
// director-combat.js and snapshot.js's raw rule keys).
const GEAR_TYPES = new Set(["accessory", "armor", "weapon", "shield"]);

function liveEffects(actor) {
  const effs = actor?.appliedEffects ?? actor?.effects?.contents ?? actor?.effects ?? [];
  const out = [];
  for (const ae of effs) {
    if (!ae || ae.disabled) continue;
    const item = ae?.parent?.documentName === "Item" ? ae.parent : null;
    const itemType = String(item?.system?.props?.item_type ?? "").toLowerCase();
    if (GEAR_TYPES.has(itemType) && item?.system?.props?.isEquipped !== true) continue;
    out.push(ae);
  }
  return out;
}

/** { quicken, delay } — which of the two statuses the actor carries right now. */
export function speedStatusesOf(actor) {
  let quicken = false, delay = false;
  for (const ae of liveEffects(actor)) {
    for (const s of slugsOf(ae, globalThis.CONFIG?.statusEffects ?? [])) {
      if (QUICKEN_SLUGS.has(s)) quicken = true;
      else if (DELAY_SLUGS.has(s)) delay = true;
    }
  }
  return { quicken, delay };
}

/** The live phase tier for an actor: +1 Quicken, -1 Delay, 0 otherwise. */
export function speedTierOf(actor) {
  const { quicken, delay } = speedStatusesOf(actor);
  return (quicken ? 1 : 0) - (delay ? 1 : 0);
}

/** "Quicken" / "Normal" / "Delay" — for logs. */
export function tierName(tier) {
  return tier === TIER.QUICKEN ? "Quicken" : tier === TIER.DELAY ? "Delay" : "Normal";
}
