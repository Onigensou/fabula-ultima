/**
 * Migration: 2026-05-17-drain-spirit-declarative
 * ---------------------------------------------------------------------------
 * Phase D authoring: Drain Spirit's "you recover half the MP loss they
 * suffered" mechanic now ships as a declarative `post_damage_effect_ref`
 * + `effect_table` pair on the skill, with `grant_amount: "MP_DEALT / 2"`.
 *
 * The post_damage hook in Create Damage Card fires this effect per affected
 * target after the MP burn resolves, with the per-target payload in hand —
 * so the formula evaluator's MP_DEALT identifier reads each target's actual
 * MP loss (post-affinity, post-reductions).
 *
 * MATCHING POLICY: by item name "Drain Spirit". UUIDs differ across worlds.
 *
 * IDEMPOTENT: compares both `post_damage_effect_ref` and the relevant
 * effect_table row to the canonical target via deep-equal before writing.
 *
 * SCOPE: only touches `system.props.post_damage_effect_ref` and
 * `system.props.effect_table`. Does NOT modify the existing damage-side
 * fields (`type_damage`, `damage_bonus`, etc.) — those continue to drive
 * the MP burn through the standard pipeline.
 */

export const key = "2026-05-17-drain-spirit-declarative";
export const description =
  "Author Drain Spirit's MP recovery declaratively (Phase D: " +
  "post_damage_effect_ref + effect_table with MP_DEALT / 2).";

const ITEM_NAME = "Drain Spirit";
const TARGET_REF = "drain_recover";

const TARGET_EFFECT_ROW = Object.freeze({
  $deleted: false,
  effect_label: "drain_recover",
  effect_kind: "grant",
  grant_resource: "mp",
  grant_amount: "MP_DEALT / 2",
  grant_target: "self"
});

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function findDrainRecoverRow(table) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && r.effect_label === "drain_recover") return { key: k, row: r };
  }
  return null;
}

export async function migrate(game, log) {
  const actors = game.actors?.contents ?? [];
  if (!actors.length) {
    return { applied: true, summary: "no actors present; nothing to migrate" };
  }

  let updated = 0;
  let already = 0;

  for (const actor of actors) {
    const items = actor.items?.contents ?? [];
    for (const item of items) {
      if (item.name !== ITEM_NAME) continue;

      const props = item.system?.props ?? {};
      const currentRef = String(props.post_damage_effect_ref ?? "").trim();
      // Phase D back-compat: prefer effect_table.
      const currentTable = props.effect_table ?? props.reaction_effect_table ?? {};
      const existing = findDrainRecoverRow(currentTable);

      const refMatches = currentRef === TARGET_REF;
      const rowMatches = !!existing && deepEqual(existing.row, TARGET_EFFECT_ROW);

      if (refMatches && rowMatches) {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}]: already authored`);
        already++;
        continue;
      }

      // Build the new effect_table:
      // - Keep any unrelated rows (none expected on Drain Spirit today, but
      //   safe for forks that may have added their own).
      // - Add/replace the drain_recover row.
      const newTable = foundry.utils.duplicate(
        // Always write the new canonical key going forward (effect_table).
        (typeof currentTable === "object" && currentTable) ? currentTable : {}
      );
      if (existing) {
        newTable[existing.key] = { ...TARGET_EFFECT_ROW };
      } else {
        // Pick a fresh row key (numeric, smallest unused).
        let i = 0;
        while (Object.prototype.hasOwnProperty.call(newTable, String(i))) i++;
        newTable[String(i)] = { ...TARGET_EFFECT_ROW };
      }

      const update = {
        "system.props.post_damage_effect_ref": TARGET_REF,
        "system.props.effect_table": newTable
      };
      await item.update(update);
      log(`actor "${actor.name}" item "${item.name}" [${item.id}]: authored post_damage_effect_ref + effect_table.drain_recover`);
      updated++;
    }
  }

  return {
    applied: true,
    summary: `${updated} updated, ${already} already-authored`
  };
}
