/**
 * Migration: 2026-05-17-drain-spirit-master-author
 * ---------------------------------------------------------------------------
 * Authors Drain Spirit's declarative MP recovery on the **world-level master
 * item** (game.items) so the change rides the CSB content-master link to all
 * actor copies via uniqueId. The earlier `2026-05-17-drain-spirit-declarative`
 * migration wrote to actor-embedded copies — wrong by both policy (master is
 * the source of truth) and effect (CSB stripped the writes anyway, since the
 * template didn't declare the columns yet).
 *
 * Runs AFTER `2026-05-17-skill-template-fire-points` so the template now
 * declares `effect_table` and `post_damage_effect_ref` as columns. With those
 * in place, writes persist.
 *
 * Authoring target (on the master Drain Spirit item):
 *   system.props.post_damage_effect_ref = "drain_recover"
 *   system.props.effect_table = {
 *     "0": { effect_label: "drain_recover", effect_kind: "grant",
 *            grant_resource: "mp", grant_amount: "ceil(MP_DEALT / 2)",
 *            grant_target: "self" }
 *   }
 *
 * Also walks all actor-embedded copies of Drain Spirit and writes the same
 * shape on each. This avoids depending on a manual "refresh from master"
 * step the GM would otherwise have to run.
 *
 * IDEMPOTENT: deep-equal check on the canonical row + ref before writing.
 *
 * MATCHING POLICY: by item name "Drain Spirit". Multiple masters not expected
 * (one master per name); if found, all are authored.
 */

export const key = "2026-05-17-drain-spirit-master-author";
export const description =
  "Author Drain Spirit declaratively on world master + actor copies " +
  "(post-template-surgery so writes persist).";

const ITEM_NAME = "Drain Spirit";
const TARGET_REF = "drain_recover";

const TARGET_EFFECT_ROW = Object.freeze({
  $deleted: false,
  effect_label: "drain_recover",
  effect_kind: "grant",
  grant_resource: "mp",
  grant_amount: "ceil(MP_DEALT / 2)",
  grant_target: "self"
});

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function findDrainRecoverRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.effect_label === "drain_recover") return { key: k, row: r };
  }
  return null;
}

async function authorOnItem(item, label, log) {
  const props = item.system?.props ?? {};
  const currentRef = String(props.post_damage_effect_ref ?? "").trim();
  const currentTable = props.effect_table ?? props.reaction_effect_table ?? {};
  const existing = findDrainRecoverRow(currentTable);

  const refOk = currentRef === TARGET_REF;
  const rowOk = !!existing && deepEqual(existing.row, TARGET_EFFECT_ROW);

  if (refOk && rowOk) {
    log(`${label}: already authored`);
    return false;
  }

  const newTable = foundry.utils.duplicate(
    typeof currentTable === "object" && currentTable ? currentTable : {}
  );
  if (existing) {
    newTable[existing.key] = { ...TARGET_EFFECT_ROW };
  } else {
    let i = 0;
    while (Object.prototype.hasOwnProperty.call(newTable, String(i))) i++;
    newTable[String(i)] = { ...TARGET_EFFECT_ROW };
  }

  await item.update({
    "system.props.post_damage_effect_ref": TARGET_REF,
    "system.props.effect_table": newTable
  });
  log(`${label}: authored post_damage_effect_ref + effect_table.drain_recover`);
  return true;
}

export async function migrate(game, log) {
  let mastersAuthored = 0;
  let copiesAuthored = 0;

  // Phase 1: master items in the world Items directory.
  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (await authorOnItem(item, `world master "${item.name}" [${item.id}]`, log)) {
      mastersAuthored++;
    }
  }

  // Phase 2: actor-embedded copies. CSB doesn't auto-sync from master, so
  // we author each copy explicitly. (Future skill-refresh tooling could
  // make this step unnecessary.)
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (await authorOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) {
        copiesAuthored++;
      }
    }
  }

  return {
    applied: true,
    summary: `${mastersAuthored} master${mastersAuthored === 1 ? "" : "s"} + ${copiesAuthored} copies authored`
  };
}
