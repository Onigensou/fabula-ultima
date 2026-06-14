/**
 * Migration: 2026-06-14-zarg-zero-trigger-strategy-author
 * ---------------------------------------------------------------------------
 * Author "Zero Trigger: Strategy" (Zarg / Zero Power, Passive):
 *
 *   At the end of your turn, if two or more distinct debuffs are present among
 *   the enemies, gain 1 Zero Power.
 *
 * BD-native canonical Zero-Power pattern (mirrors Zero Trigger: Foresight):
 * a `force`-mode turn_end reaction, gated by the `ENEMY_DISTINCT_STATUS_COUNT`
 * formula, pointing at a `grant zero_power` effect row that targets self via a
 * `targeting` row.
 *
 *   reaction_config_table:
 *     turn_end / self / force / ENEMY_DISTINCT_STATUS_COUNT >= 2 → "ZP Strategy"
 *   effect_table:
 *     ZP Strategy  grant     → zero_power 1, target zts_self
 *     zts_self     targeting → self, exact, passive-skip, auto-confirm
 *
 * Requires committed engine support (8f68c7d): the `ENEMY_DISTINCT_STATUS_COUNT`
 * formula identifier in skill-formulas.js.
 *
 * Folder: `Battle Director / Zero Power / Zarg` — each character's folder under
 * Zero Power holds their Zero Trigger + Zero Power skills.
 *
 * uniqueId is FIXED to `L83ohIXfHrcEpDMI` — DISTINCT from the legacy
 * `💥 Skill / Zero Trigger` copy's `dkCavl0YcUWMPkRj` (avoids the CSB
 * double-instantiation collision).
 *
 * SEED-ONLY (world data authoritative): if the master already exists, leave it
 * (and actor copies) untouched.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-14-zarg-zero-trigger-strategy-author";
export const description =
  "Author Zero Trigger: Strategy (Zarg / Zero Power): force turn_end gain 1 " +
  "zero_power when ENEMY_DISTINCT_STATUS_COUNT >= 2. Seed-only; distinct uniqueId.";

const BD_ROOT_NAME = "Battle Director";
const ZERO_POWER_FOLDER = "Zero Power";
const CHAR_NAME = "Zarg";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const SKILL_NAME = "Zero Trigger: Strategy";
const STRATEGY_UID = "L83ohIXfHrcEpDMI";

const STRATEGY_ICON =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Eve/CodeElectraSkill1.png";

const STRATEGY_DESCRIPTION =
  "<p>At the <strong>end of your turn</strong>, if there are <strong>two or " +
  "more distinct debuffs</strong> present among your enemies, you gain " +
  "<strong>1 Zero Power</strong>.</p>";

const EFFECT_TABLE = {
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

const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger: "turn_end",
    reaction_source: "self",
    reaction_passive_mode: "force",
    reaction_effect_ref: "ZP Strategy",
    condition_formula: "ENEMY_DISTINCT_STATUS_COUNT >= 2",
    reaction_passive_target: "self",
  },
};

const PROP_PATCH = {
  skill_type: "Passive",
  skill_target: "-",
  skill_range: "-",
  cost: "-",
  isCheck: false,
  isReaction: false,
  isHeroic: false,
  on_activate_effect_ref: "",
  class: "NPC",
  max_level: "1",
  description: STRATEGY_DESCRIPTION,
};

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);
const templateMatches = (item) => String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;

async function replaceTable(item, field, table) {
  await item.update({ [`system.props.-=${field}`]: null });
  await item.update({ [`system.props.${field}`]: foundry.utils.deepClone(table) });
}

async function patchMaster(item, log) {
  let touched = false;
  const p = item.system?.props ?? {};

  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  Strategy: props patched (${Object.keys(propUpdates).map((k) => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await replaceTable(item, "effect_table", EFFECT_TABLE);
    log("  Strategy: effect_table set");
    touched = true;
  }
  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) {
    await replaceTable(item, "reaction_config_table", REACTION_CONFIG_TABLE);
    log("  Strategy: reaction_config_table set");
    touched = true;
  }

  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try { await item.templateSystem.reloadTemplate(); }
    catch (e) { log(`  Strategy: reloadTemplate threw — ${e?.message ?? e}`); }
  }
  return touched;
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(
    game, [BD_ROOT_NAME, ZERO_POWER_FOLDER, CHAR_NAME], { log });
  if (!folder) {
    return { applied: false, summary: `Strategy: missing folder "${BD_ROOT_NAME}/${ZERO_POWER_FOLDER}/${CHAR_NAME}"` };
  }

  const existing = game.items?.contents?.find?.((i) =>
    i.name === SKILL_NAME && i.folder?.id === folder.id && templateMatches(i));

  if (existing) {
    log("  Strategy already present — seed-only; leaving world data untouched");
    return { applied: true, summary: "Zero Trigger: Strategy already present; left untouched (seed-only)" };
  }

  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const versionStamp = tpl?.system?.templateSystemUniqueVersion;
  const master = await Item.create({
    name: SKILL_NAME,
    type: "equippableItem",
    img: STRATEGY_ICON,
    folder: folder.id,
    system: {
      template: SKILL_TEMPLATE_ID,
      uniqueId: STRATEGY_UID,
      unique: true,
      ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
      props: { skill_type: "Passive", level: 1, max_level: "1" },
    },
  });
  log(`  Strategy: master created in ${BD_ROOT_NAME}/${ZERO_POWER_FOLDER}/${CHAR_NAME} (uid ${STRATEGY_UID})`);

  await patchMaster(master, log);

  return { applied: true, summary: "Zero Trigger: Strategy seeded: master created" };
}
