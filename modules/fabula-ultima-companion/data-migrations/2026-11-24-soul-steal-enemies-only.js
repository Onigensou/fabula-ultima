/**
 * Migration: 2026-11-24-soul-steal-enemies-only
 * ---------------------------------------------------------------------------
 * Soul Steal targets ENEMIES only (user ruling 2026-11-24, to-do #16). Its
 * target text said "creatures", which the picker reads as "any side", so a
 * party member could pick an ally. Together with the steal lock this means a
 * field where every enemy is stolen from has nothing to pick at all.
 *
 * Only `skill_target` changes: "... creatures" -> "... enemies", on the world
 * items and every actor copy. The description (core-book text) is left alone.
 *
 * Exact-value replace: a copy whose target text is not the old value is
 * reported and left alone, so a re-run, or a later hand edit, is never touched.
 */

export const key = "2026-11-24-soul-steal-enemies-only";
export const description = "Soul Steal: target text 'Up to (1 + 98 * HAS_SKILL_PILLAGE) creatures' -> '... enemies' (world items + every actor copy).";

const NAME = "Soul Steal";
const FROM = "Up to (1 + 98 * HAS_SKILL_PILLAGE) creatures";
const TO = "Up to (1 + 98 * HAS_SKILL_PILLAGE) enemies";

const label = (doc) => `${doc.parent?.name ? doc.parent.name + ": " : ""}${doc.name}`;

async function fix(doc, out) {
  if (String(doc.name ?? "").trim() !== NAME) return;
  const cur = String(doc.system?.props?.skill_target ?? "").trim();
  if (cur === TO) { out.push(`= ${label(doc)} already enemies`); return; }
  if (cur !== FROM) { out.push(`! ${label(doc)} target text "${cur}" not the expected one, left alone`); return; }
  await doc.update({ "system.props.skill_target": TO });
  out.push(`~ ${label(doc)}`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const it of game.items) {
    try { await fix(it, out); } catch (e) { out.push(`! ${label(it)}: ${e?.message ?? e}`); }
  }
  for (const a of game.actors) {
    for (const it of a.items) {
      try { await fix(it, out); } catch (e) { out.push(`! ${label(it)}: ${e?.message ?? e}`); }
    }
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") || "no Soul Steal found" };
}
