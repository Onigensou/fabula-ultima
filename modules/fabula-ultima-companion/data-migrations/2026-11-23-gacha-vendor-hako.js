/**
 * Migration: 2026-11-23-gacha-vendor-hako  (walk-up Gachapon at Hako)
 * ---------------------------------------------------------------------------
 * User 2026-11-23 (11-21 session to-do): players should reach the gacha from
 * Hako like any other NPC interaction, instead of the GM moving the table to
 * the Gacha Scene. The Gachapon button appears over any NPC whose actor carries
 * flags.fabula-ultima-companion.gachaVendor (scripts/gacha-system/gacha-entrance.js).
 *
 * Hako is one shop actor (srAH3OHOoK0tvFih) shared by every map she stands on
 * (Underground Camp, Hideout, Wyrmwood, Valley), so one actor flag covers all
 * of them; unlinked tokens read it from the base actor.
 *
 * SEED-ONLY: if the flag is already set (true OR false — a GM may have turned
 * Hako's machine off on purpose), it is left alone.
 */

export const key = "2026-11-23-gacha-vendor-hako";
export const description = "Hako: show the Gachapon button (walk-up gacha access).";

const M = "fabula-ultima-companion";
const FLAG = "gachaVendor";
const HAKO = "srAH3OHOoK0tvFih";

export async function migrate(game, log = () => {}) {
  const hako = game.actors.get(HAKO);
  if (!hako) { log("Hako actor missing, skipped"); return { applied: false, summary: "no Hako" }; }
  const cur = hako.flags?.[M]?.[FLAG];
  if (cur !== undefined) { log(`Hako gachaVendor already ${cur}`); return { applied: true, summary: "already set" }; }
  await hako.update({ [`flags.${M}.${FLAG}`]: true });
  log("Hako is now a gacha vendor");
  return { applied: true, summary: "Hako gachaVendor = true" };
}
