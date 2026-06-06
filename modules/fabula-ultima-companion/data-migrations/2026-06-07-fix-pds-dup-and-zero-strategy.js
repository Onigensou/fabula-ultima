/**
 * Migration: 2026-06-07-fix-pds-dup-and-zero-strategy
 * ---------------------------------------------------------------------------
 * Fixes the two genuine reaction-lint errors surfaced by the 2026-06-07 BD
 * skill verification (the rest were stale-lint false positives):
 *
 *  1. Prophetic Defender Style — effect_table carried a DUPLICATE
 *     effect_label "pds_reaction" (a stripped row with no target_ref /
 *     destination_ref). Only the first row is reachable, so the dup is dead.
 *     Fix: drop any "pds_reaction" row lacking a target_ref, re-index.
 *
 *  2. Zero Trigger: Strategy — used the LEGACY inline grant pattern
 *     (reaction_grant_* on the reaction row + a bogus reaction_effect_ref
 *     "effect-1" that resolves to nothing) with an EMPTY effect_table.
 *     Fix: author the canonical Zero Trigger shape (mirrors Foresight /
 *     Motivation): a `grant zero_power` row + a `targeting self` row, and
 *     point reaction_effect_ref at the grant. The turn_end trigger + the
 *     "2+ debuffed enemies" condition (reaction_debuff_count_*) are kept.
 *
 * Applies to world masters AND actor copies (matched by name / signature).
 * Delete-then-set on tables (Foundry merges objects by key otherwise).
 * IDEMPOTENT: re-runs no-op once fixed.
 */

export const key = "2026-06-07-fix-pds-dup-and-zero-strategy";
export const description =
  "Dedup Prophetic Defender Style's pds_reaction row + re-author Zero Trigger: " +
  "Strategy to the canonical grant/targeting + reaction_effect_ref pattern.";

const PDS_NAMES = ["Prophetic Defender Style", "PROPHETIC DEFENDER STYLE"];
const STRATEGY_NAME = "Zero Trigger: Strategy";

// Canonical Strategy tables (mirror Zero Trigger: Foresight's shape).
const STRATEGY_EFFECT_TABLE = {
  "0": {
    effect_kind: "grant", effect_label: "ZP Strategy",
    grant_resource: "zero_power", grant_amount: "1", target_ref: "zts_self",
  },
  "1": {
    effect_kind: "targeting", effect_label: "zts_self", candidate_source: "self",
    category: "", mode: "exact", count: 1, exclude_self: false,
    auto_confirm_when_obvious: true, skip_when_passive: true, iteration_mode: "together",
  },
};
const STRATEGY_REACTION_TABLE = {
  "0": {
    reaction_isPassive: true, reaction_trigger: "turn_end", reaction_source: "self",
    reaction_damage_type: "", reaction_damage_amount: "",
    reaction_debuff_count_target: "enemy", reaction_debuff_count_min: "2",
    reaction_effect_ref: "ZP Strategy", reaction_passive_target: "self",
  },
};

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const eq = (a, b) => stableStringify(a) === stableStringify(b);

async function replaceTable(item, field, table) {
  await item.update({ [`system.props.-=${field}`]: null });
  await item.update({ [`system.props.${field}`]: foundry.utils.deepClone(table) });
}

async function fixPdsDup(item, log) {
  const et = item.system?.props?.effect_table ?? {};
  const rows = Object.values(et);
  const dups = rows.filter((r) => r?.effect_label === "pds_reaction");
  if (dups.length < 2) return false;
  // Keep pds_reaction rows that carry a target_ref (the complete chain); drop
  // the rest. Then drop only the EXTRA pds_reaction rows, preserving order.
  let keptReaction = false;
  const out = [];
  for (const r of rows) {
    if (r?.effect_label === "pds_reaction") {
      const complete = !!String(r.target_ref ?? "").trim();
      if (!keptReaction && complete) { out.push(r); keptReaction = true; continue; }
      if (!keptReaction && !complete) { /* hold: maybe a complete one comes later */ }
      // skip duplicates / incomplete
      continue;
    }
    out.push(r);
  }
  // Safety: if none were "complete", keep the first pds_reaction so behavior survives.
  if (!keptReaction) {
    const first = rows.find((r) => r?.effect_label === "pds_reaction");
    if (first) out.splice(Math.min(out.length, 5), 0, first);
  }
  const reindexed = {};
  out.forEach((r, i) => { reindexed[String(i)] = r; });
  await replaceTable(item, "effect_table", reindexed);
  log(`  ${item.parent?.name ?? "[world]"} / ${item.name}: removed ${dups.length - 1} duplicate pds_reaction row(s)`);
  return true;
}

async function fixStrategy(item, log) {
  const p = item.system?.props ?? {};
  const needET = !eq(p.effect_table ?? {}, STRATEGY_EFFECT_TABLE);
  const needRT = !eq(p.reaction_config_table ?? {}, STRATEGY_REACTION_TABLE);
  if (!needET && !needRT) return false;
  if (needET) await replaceTable(item, "effect_table", STRATEGY_EFFECT_TABLE);
  if (needRT) await replaceTable(item, "reaction_config_table", STRATEGY_REACTION_TABLE);
  log(`  ${item.parent?.name ?? "[world]"} / ${item.name}: re-authored to canonical Zero Trigger pattern`);
  return true;
}

export async function migrate(game, log = () => {}) {
  let pds = 0, strat = 0;
  const all = [
    ...game.items.contents,
    ...game.actors.contents.flatMap((a) => a.items.contents),
  ];
  for (const item of all) {
    try {
      if (PDS_NAMES.includes(item.name)) { if (await fixPdsDup(item, log)) pds++; }
      else if (item.name === STRATEGY_NAME) { if (await fixStrategy(item, log)) strat++; }
      // also dedup any item that happens to carry the pds_reaction dup signature
      else if (Object.values(item.system?.props?.effect_table ?? {}).filter((r) => r?.effect_label === "pds_reaction").length >= 2) {
        if (await fixPdsDup(item, log)) pds++;
      }
    } catch (e) { log(`  ${item.name}: FAILED ${e?.message ?? e}`); }
  }
  return { applied: true, summary: `fixed ${pds} PDS dup + ${strat} Zero Trigger: Strategy` };
}
