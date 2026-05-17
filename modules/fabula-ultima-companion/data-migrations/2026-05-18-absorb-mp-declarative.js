/**
 * Migration: 2026-05-18-absorb-mp-declarative
 * ---------------------------------------------------------------------------
 * Author Absorb MP declaratively. The skill currently has an isReaction
 * config row that fires passively on creature_takes_damage but no
 * `reaction_effect_ref` and no skill body — so the auto-passive runner
 * processes an empty Passive skill through ADC, which classifies it as
 * an attack and rolls a Miss card.
 *
 * Per Core p. 234:
 *   "After you suffer damage, you may immediately recover SL × 2 Mind Points."
 *
 * Declarative wiring:
 *   reaction_config_table row 0 (existing): set reaction_effect_ref =
 *     "absorb_mp_recover"
 *   effect_table row 0 (new): grant SL*2 MP to self
 *
 * Idempotent.
 */

export const key = "2026-05-18-absorb-mp-declarative";
export const description =
  "Author Absorb MP declaratively (grant SL*2 MP on creature_takes_damage).";

const ITEM_NAME = "Absorb MP";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const TARGET_REF = "absorb_mp_recover";

const TARGET_EFFECT_ROW = Object.freeze({
  $deleted: false,
  effect_label:   "absorb_mp_recover",
  effect_kind:    "grant",
  grant_resource: "mp",
  grant_amount:   "SL * 2",
  grant_target:   "self"
});

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

function findReactionRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.reaction_trigger === "creature_takes_damage") {
      return { key: k, row: r };
    }
  }
  return null;
}

function findEffectRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.effect_label === TARGET_REF) return { key: k, row: r };
  }
  return null;
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const subset = (row, keys) => Object.fromEntries(keys.map(k => [k, row?.[k]]));
const deepEqualSubset = (a, b, keys) =>
  stableStringify(subset(a, keys)) === stableStringify(subset(b, keys));

async function authorOnItem(item, label, log) {
  const props = item.system?.props ?? {};
  const rct = props.reaction_config_table ?? {};
  const eft = props.effect_table ?? {};

  const trigRow = findReactionRow(rct);
  if (!trigRow) {
    log(`${label}: no creature_takes_damage row found; skipping`);
    return false;
  }

  const effRow = findEffectRow(eft);
  const effKeys = Object.keys(TARGET_EFFECT_ROW).filter(k => k !== "$deleted");
  const effOk = !!effRow && deepEqualSubset(effRow.row, TARGET_EFFECT_ROW, effKeys);
  const refOk = String(trigRow.row.reaction_effect_ref ?? "") === TARGET_REF;

  if (effOk && refOk) {
    log(`${label}: already authored`);
    return false;
  }

  // Update trigger row's reaction_effect_ref.
  const newRct = foundry.utils.duplicate(rct);
  newRct[trigRow.key] = { ...trigRow.row, reaction_effect_ref: TARGET_REF };

  // Insert or update effect row.
  const newEft = foundry.utils.duplicate(eft);
  if (effRow) {
    newEft[effRow.key] = { ...TARGET_EFFECT_ROW };
  } else {
    let i = 0;
    while (Object.prototype.hasOwnProperty.call(newEft, String(i))) i++;
    newEft[String(i)] = { ...TARGET_EFFECT_ROW };
  }

  await item.update({
    "system.props.reaction_config_table": newRct,
    "system.props.effect_table": newEft
  });
  log(
    `${label}: authored (` +
    [!refOk && "reaction_effect_ref", !effOk && "effect_table row"].filter(Boolean).join(", ") +
    ")"
  );
  return true;
}

export async function migrate(game, log) {
  let mastersAuthored = 0;
  let copiesAuthored = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (!templateMatches(item)) continue;
    if (await authorOnItem(item, `world master "${item.name}" [${item.id}]`, log)) mastersAuthored++;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (!templateMatches(item)) continue;
      if (await authorOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) copiesAuthored++;
    }
  }

  return {
    applied: true,
    summary: `${mastersAuthored} master(s) + ${copiesAuthored} copies authored`
  };
}
