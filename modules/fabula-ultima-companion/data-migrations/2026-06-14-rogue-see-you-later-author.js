/**
 * Migration: 2026-06-14-rogue-see-you-later-author
 * ---------------------------------------------------------------------------
 * Author "See you later" (Rogue / Active Skill):
 *
 *   "Spend 1 Fabula Point to leave the conflict — you slip away from this
 *    scene and reappear in a later one."
 *
 * BD-native design — an Active skill whose on-activate chain pops a styled
 * confirmation (the reusable `confirm` effect_kind), then pays 1 Fabula Point
 * (`consume_resource fp`, abort-on-empty) and removes the caster from combat
 * (`leave_combat`, via the director removeCombatant API). Cancelling the
 * confirm aborts the chain BEFORE the cost row, so a cancel is free.
 *
 *   effect_table:
 *     syl_root    chain            → syl_confirm, syl_cost, syl_leave
 *     syl_confirm confirm          → "See you later?" / red "See you later!" / "Stay"
 *     syl_cost    consume_resource  → fp 1, target self, on_empty abort
 *     syl_leave   leave_combat      → target self
 *
 * Requires committed engine support (8f68c7d): the `confirm` + `leave_combat`
 * effect_kinds in skill-effects.js. The picker derives the "1 FP" cost badge
 * from the in-chain consume row (config-derived cost).
 *
 * Folder: `Battle Director / Rogue / Skill` (class-bound; the Test-Battle dev
 * tool only discovers class skills under this exact path).
 *
 * uniqueId is FIXED to `QFKY6F0DkIwVRAdq` — DISTINCT from the legacy
 * `💥 Skill / Class Skill / Rogue` copy's `pN90SZleopmB3PM1`. A shared uid
 * makes CSB double-instantiate the skill on actors (the dummy got two copies);
 * the BD master MUST carry its own identity.
 *
 * SEED-ONLY (world data is authoritative): if the master already exists this
 * migration leaves it — and every actor copy — untouched, so a co-dev's manual
 * edits are never overridden. It only SEEDS a world that lacks the skill.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-14-rogue-see-you-later-author";
export const description =
  "Author See you later (Rogue / Active): confirm → spend 1 FP → leave_combat. " +
  "Seed-only; distinct uniqueId to avoid the legacy-copy collision.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Rogue";
const SUBFOLDER = "Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const SKILL_NAME = "See you later";
const SEE_YOU_LATER_UID = "QFKY6F0DkIwVRAdq";

const SYL_ICON =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/09_NIN/dream_within_a_dream.png";

const SYL_DESCRIPTION =
  "<p>Spend <strong>1 Fabula Point</strong> to leave the current conflict. " +
  "You slip away from this scene and play resumes without you — you reappear " +
  "in a later scene, as the story dictates.</p>";

const EFFECT_TABLE = {
  "0": {
    effect_label: "syl_root",
    effect_kind: "chain",
    chain_steps: "syl_confirm,syl_cost,syl_leave",
  },
  "1": {
    effect_label: "syl_confirm",
    effect_kind: "confirm",
    confirm_title: "See you later?",
    confirm_message:
      "Leave the battle for 1 Fabula Point? You'll slip away from this scene and reappear in a later one.",
    confirm_ok_label: "See you later!",
    confirm_ok_style: "danger",
    confirm_cancel_label: "Stay",
    confirm_cancel_style: "default",
  },
  "2": {
    effect_label: "syl_cost",
    effect_kind: "consume_resource",
    consume_resource: "fp",
    consume_amount: "1",
    target_ref: "self",
    on_empty: "abort",
  },
  "3": {
    effect_label: "syl_leave",
    effect_kind: "leave_combat",
    target_ref: "self",
  },
};

const PROP_PATCH = {
  skill_type: "Active",
  skill_target: "Self",
  skill_range: "-",
  cost: "",
  isCheck: false,
  isReaction: false,
  isHeroic: false,
  on_activate_effect_ref: "syl_root",
  class: CLASS_NAME,
  max_level: "1",
  description: SYL_DESCRIPTION,
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
    log(`  See you later: props patched (${Object.keys(propUpdates).map((k) => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await replaceTable(item, "effect_table", EFFECT_TABLE);
    log("  See you later: effect_table set");
    touched = true;
  }
  if (p.reaction_config_table && Object.keys(p.reaction_config_table).length) {
    await replaceTable(item, "reaction_config_table", {});
    log("  See you later: cleared reaction_config_table");
    touched = true;
  }

  // CSB template version stamp + reload.
  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try { await item.templateSystem.reloadTemplate(); }
    catch (e) { log(`  See you later: reloadTemplate threw — ${e?.message ?? e}`); }
  }
  return touched;
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(
    game, [BD_ROOT_NAME, CLASS_NAME, SUBFOLDER], { log });
  if (!folder) {
    return { applied: false, summary: `See you later: missing folder "${BD_ROOT_NAME}/${CLASS_NAME}/${SUBFOLDER}"` };
  }

  const existing = game.items?.contents?.find?.((i) =>
    i.name === SKILL_NAME && i.folder?.id === folder.id && templateMatches(i));

  if (existing) {
    log("  See you later already present — seed-only; leaving world data untouched");
    return { applied: true, summary: "See you later already present; left untouched (seed-only)" };
  }

  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const versionStamp = tpl?.system?.templateSystemUniqueVersion;
  const master = await Item.create({
    name: SKILL_NAME,
    type: "equippableItem",
    img: SYL_ICON,
    folder: folder.id,
    system: {
      template: SKILL_TEMPLATE_ID,
      uniqueId: SEE_YOU_LATER_UID,
      unique: true,
      ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
      props: { skill_type: "Active", level: 1, max_level: "1" },
    },
  });
  log(`  See you later: master created in ${BD_ROOT_NAME}/${CLASS_NAME}/${SUBFOLDER} (uid ${SEE_YOU_LATER_UID})`);

  await patchMaster(master, log);

  return { applied: true, summary: "See you later seeded: master created" };
}
