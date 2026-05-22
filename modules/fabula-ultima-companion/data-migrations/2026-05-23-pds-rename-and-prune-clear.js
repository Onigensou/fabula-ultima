/**
 * Migration: 2026-05-23-pds-rename-and-prune-clear
 * ---------------------------------------------------------------------------
 * Two changes to Prophetic Defender Style:
 *
 *   1. Rename item from upper-case "PROPHETIC DEFENDER STYLE" to title-case
 *      "Prophetic Defender Style" on the world master AND every actor copy.
 *      The old uppercase name was a leftover from v4/v5 author migrations.
 *
 *   2. Remove the `conflict_end -> pds_clear` reaction row. The Prophecy Point
 *      AE is already wiped at battle end by `[Macro] [BattleEnd_ Cleanup]`
 *      Step 0, which deletes every ActiveEffect from party + enemy + summon
 *      actors as part of the BattleEnd Manager pipeline. The dedicated
 *      conflict_end reaction was duplicate housekeeping.
 *
 *      The now-unused `pds_clear` row in `effect_table` is also pruned (it
 *      was only referenced by the reaction we're removing).
 *
 * Matching: case-insensitive on item.name == "prophetic defender style".
 * Black & White is never inspected (see notes on prior PDS migrations).
 *
 * Caveat for future readers: `conflict_end` fires on `preDeleteCombat`, which
 * also covers the case where combat is ended by deleting the tracker without
 * going through the BattleEnd pipeline. In that path, PP would now persist
 * until the next BattleEnd Manager run wipes it. The user accepted that
 * trade-off because the standard battle-end flow always goes through the
 * pipeline.
 *
 * IDEMPOTENT — every step is gated on observable state.
 */

export const key = "2026-05-23-pds-rename-and-prune-clear";
export const description =
  "Rename PDS to title case ('Prophetic Defender Style') and remove the " +
  "redundant conflict_end -> pds_clear reaction row + the unused pds_clear " +
  "effect_table row.";

const CANONICAL_NAME = "Prophetic Defender Style";
const PDS_NAME_LOWER = "prophetic defender style";

function isPdsNamed(item) {
  return String(item?.name ?? "").trim().toLowerCase() === PDS_NAME_LOWER;
}

function* iterateAllPdsItems(game) {
  for (const item of game.items?.contents ?? []) {
    if (isPdsNamed(item)) yield item;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (isPdsNamed(item)) yield item;
    }
  }
}

function pruneClearFromReactionConfig(table) {
  if (!table || typeof table !== "object") return { next: table, changed: false };

  const entries = Array.isArray(table)
    ? table.map((row, i) => [String(i), row])
    : Object.entries(table);

  let changed = false;
  const kept = [];
  for (const [, row] of entries) {
    if (!row || typeof row !== "object") { kept.push(row); continue; }
    const trig = String(row.reaction_trigger ?? "").trim();
    const eff  = String(row.reaction_effect_ref ?? "").trim();
    if (trig === "conflict_end" && eff === "pds_clear") {
      changed = true;
      continue;
    }
    kept.push(row);
  }
  if (!changed) return { next: table, changed: false };

  // Re-key sequentially so the resulting object stays compact (CSB's
  // compactDynamicTable reads object keys "0", "1", "2", ...).
  const next = {};
  kept.forEach((row, i) => { next[String(i)] = row; });
  return { next, changed: true };
}

function pruneClearFromEffectTable(table) {
  if (!table || typeof table !== "object") return { next: table, changed: false };

  const entries = Array.isArray(table)
    ? table.map((row, i) => [String(i), row])
    : Object.entries(table);

  let changed = false;
  const kept = [];
  for (const [, row] of entries) {
    if (!row || typeof row !== "object") { kept.push(row); continue; }
    if (String(row.effect_label ?? "") === "pds_clear") {
      changed = true;
      continue;
    }
    kept.push(row);
  }
  if (!changed) return { next: table, changed: false };

  const next = {};
  kept.forEach((row, i) => { next[String(i)] = row; });
  return { next, changed: true };
}

async function migrateOne(item, log) {
  const patch = {};

  if (item.name !== CANONICAL_NAME) {
    patch.name = CANONICAL_NAME;
  }

  const cfg = pruneClearFromReactionConfig(item.system?.props?.reaction_config_table ?? {});
  if (cfg.changed) patch["system.props.reaction_config_table"] = cfg.next;

  const eff = pruneClearFromEffectTable(item.system?.props?.effect_table ?? {});
  if (eff.changed) patch["system.props.effect_table"] = eff.next;

  if (Object.keys(patch).length === 0) return false;

  await item.update(patch);
  const bits = [];
  if (patch.name) bits.push(`renamed -> "${CANONICAL_NAME}"`);
  if (cfg.changed) bits.push("dropped conflict_end pds_clear row");
  if (eff.changed) bits.push("dropped pds_clear effect_table row");
  log(`item ${item.id} (parent="${item.parent?.name ?? "world"}"): ${bits.join("; ")}`);
  return true;
}

export async function migrate(game, log) {
  let touched = 0;
  for (const item of iterateAllPdsItems(game)) {
    try {
      if (await migrateOne(item, log)) touched++;
    } catch (e) {
      log(`item ${item.id} (parent="${item.parent?.name ?? "world"}") failed: ${e?.message ?? e}`);
    }
  }
  return {
    applied: true,
    summary: `${touched} PDS-named item${touched === 1 ? "" : "s"} updated (rename + prune)`
  };
}
