/**
 * Migration: 2026-06-07-sharpshooter-crossfire
 * ---------------------------------------------------------------------------
 * Author the Battle Director master for Crossfire (Sharpshooter) and equip it
 * on the BD test dummy ("BD Test — Sharpshooter").
 *
 * RAW: "After a creature you can see performs a ranged attack, you may spend an
 * amount of Mind Points equal to the total Result of their Accuracy Check in
 * order to have the attack fail automatically against all targets. You can only
 * use this Skill if you have a ranged weapon equipped, and it has no effect if
 * the Accuracy Check was a critical success."
 *
 * DECLARATIVE — third-party, POST-ROLL reaction, NO hardcoded skill name in the
 * engine. Crossfire is a bystander reaction to someone else's attack: it fires
 * AFTER the dice (the MP cost equals the attacker's Accuracy Result and the
 * crit-exclusion both require the roll outcome — rollPhase "post"). It rides the
 * existing CONFIRM third-party scan (`creature_targeted_by_action`, the same
 * path Protect/Cover use) and the card-mutations pipeline.
 *
 * NEW DECLARATIVE PRIMITIVE introduced for this skill (no per-skill JS):
 *   effect_kind "adjust_accuracy" — overrides the in-flight Accuracy total, then
 *   recomputes hit/miss for every target. The accuracy analogue of
 *   "adjust_damage". Crossfire `set`s it to 0 so the attack fails against all
 *   targets. A sibling skill (different cost / partial penalty) is authorable as
 *   DATA alone. See [[feedback_skill_no_hardcode_test]].
 *
 * ENGINE MAPPING:
 *   reaction_config_table[0]
 *     reaction_trigger        = creature_targeted_by_action  (CONFIRM third-party
 *                               scan; post-roll, so the roll Result is known)
 *     reaction_source         = all      (any target — RAW reacts to any visible
 *                               ranged attack, including one aimed at an ally or
 *                               at yourself; the scan already excludes the
 *                               attacker as a reactor)
 *     reaction_action_intent  = harmful  (only attacks/dangers, not ally buffs)
 *     reaction_isPassive      = false    ("may" → a clickable pill for the
 *                               bystander reactor)
 *     reaction_effect_ref     = crossfire_do
 *     condition_formula       = ATTACK_IS_RANGED == 1   (the incoming attack is
 *                               ranged — reads payload.weaponRange)
 *                            && HAS_RANGED_WEAPON        (reactor has a ranged
 *                               weapon equipped — RAW gate)
 *                            && ATTACK_IS_CRIT == 0      ("no effect if the
 *                               Accuracy Check was a critical success")
 *                            && CUR_MP >= ATTACK_CHECK_RESULT   (affordability —
 *                               the cost fires at RESOLVE in a different phase
 *                               than the CONFIRM accuracy override, so gate
 *                               surfacing on affordability up front rather than
 *                               aborting the cost after the attack is already
 *                               blocked)
 *
 *   effect_table
 *     crossfire_do     chain → [crossfire_block, crossfire_cost]   (cost LAST —
 *                      [[consume-last-in-chain]])
 *     crossfire_block  adjust_accuracy: set the action's Accuracy total to 0 →
 *                      every target misses ("the attack fails automatically
 *                      against all targets"). Applied in card-mutations.js at the
 *                      CONFIRM write site; data-only at chain-fire time.
 *     crossfire_cost   consume_resource mp = ATTACK_CHECK_RESULT (the attacker's
 *                      Accuracy Result) from self
 *
 * IDEMPOTENT: create-if-missing + drift-correct on the master; create-if-absent
 * copy on the dummy; force-replace tables to defeat Foundry's deep-merge; sweep
 * all actor copies.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-07-sharpshooter-crossfire";
export const description =
  "Author the Battle Director Crossfire master (declarative post-roll bystander " +
  "accuracy-override) + equip it on the BD Test — Sharpshooter dummy.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Sharpshooter";
const SKILL_SUBFOLDER = "Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const DUMMY_NAME = "BD Test — Sharpshooter";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger: "creature_targeted_by_action",
    reaction_source: "all",
    reaction_action_intent: "harmful",
    reaction_isPassive: false,
    reaction_effect_ref: "crossfire_do",
    // Post-roll bystander gate. ATTACK_IS_RANGED reads the *incoming* attack
    // weapon's range (payload.weaponRange); HAS_RANGED_WEAPON checks the
    // REACTOR's own equipped loadout (RAW: "if you have a ranged weapon
    // equipped"); ATTACK_IS_CRIT == 0 enforces "no effect on a critical
    // success"; CUR_MP >= ATTACK_CHECK_RESULT gates on affordability (the MP
    // cost equals the attacker's Accuracy Result).
    condition_formula:
      "ATTACK_IS_RANGED == 1 && HAS_RANGED_WEAPON && ATTACK_IS_CRIT == 0 && CUR_MP >= ATTACK_CHECK_RESULT",
  },
};

const EFFECT_TABLE = {
  "0": { effect_label: "crossfire_do", effect_kind: "chain", chain_steps: "crossfire_block,crossfire_cost" },
  "1": {
    effect_label: "crossfire_block", effect_kind: "adjust_accuracy",
    accuracy_operation: "set", accuracy_amount: "0",
    menu_label: "Crossfire",
    menu_description: "Spend MP equal to the attacker's Accuracy Result to make the attack fail against all targets.",
  },
  "2": {
    effect_label: "crossfire_cost", effect_kind: "consume_resource",
    consume_resource: "mp", consume_amount: "ATTACK_CHECK_RESULT", target_ref: "self", on_empty: "abort",
  },
};

const BASE_PROPS = {
  rolled_atr1: "-", rolled_atr2: "-", isCheck: false, isReaction: true,
  isFacet: false, isHeroic: false, isZeroPower: false, isOffensiveSpell: false,
  ignore_hr: false, class: CLASS_NAME, cost: "Special", skill_target: "-", skill_range: "",
  type_damage: "", damage_bonus: "0", check_bonus: "0", defense_target_type: "def",
  duration: "-", on_activate_effect_ref: "", post_damage_effect_ref: "",
  reaction_config_table: REACTION_CONFIG_TABLE,
  effect_table: EFFECT_TABLE,
  active_effect_config_table: {},
};

const SPEC = {
  name: "Crossfire",
  img: "icons/skills/ranged/arrow-strike-glowing-teal.webp",
  props: {
    skill_type: "Passive", level: "1", max_level: "1",
    description:
      "<p>After a creature you can see performs a <strong>ranged attack</strong>, " +
      "you may spend an amount of <strong>Mind Points</strong> equal to the total " +
      "Result of their Accuracy Check in order to have the attack <strong>fail " +
      "automatically</strong> against all targets.</p>" +
      "<p>You can only use this Skill if you have a ranged weapon equipped, and it " +
      "has no effect if the Accuracy Check was a critical success.</p>",
  },
};

function allInFolder(game, folder, name) {
  return (game.items?.contents ?? []).filter((i) => i.name === name && i.folder?.id === folder.id);
}
function findInFolder(game, folder, name) {
  return allInFolder(game, folder, name)[0] ?? null;
}

async function ensureMaster(game, folder, log) {
  const wantProps = { ...BASE_PROPS, ...SPEC.props, name: SPEC.name, img: SPEC.img };
  const dups = allInFolder(game, folder, SPEC.name);
  if (dups.length > 1) {
    const extra = dups.slice(1);
    await Item.deleteDocuments(extra.map((i) => i.id));
    log(`  removed ${extra.length} duplicate BD master(s)`);
  }
  let item = dups[0] ?? null;
  if (!item) {
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    await Item.create({
      name: SPEC.name, img: SPEC.img, type: "equippableItem", folder: folder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: wantProps,
      },
    });
    item = findInFolder(game, folder, SPEC.name);
    log(`  created BD master "${SPEC.name}" (id=${item?.id ?? "??"})`);
    return item;
  }
  const updates = {};
  for (const [k, v] of Object.entries(wantProps)) {
    if (!deepEqual(item.system?.props?.[k], v)) updates[`system.props.${k}`] = v;
  }
  if (Object.keys(updates).length) { await item.update(updates); log(`  updated BD master props (${Object.keys(updates).length})`); }
  return item;
}

async function ensureOnDummy(game, master, log) {
  if (!master) { log(`  no master to equip — skipped dummy`); return false; }
  const dummy = game.actors?.getName?.(DUMMY_NAME);
  if (!dummy) { log(`  dummy "${DUMMY_NAME}" not found — skipped equip`); return false; }
  // Drop any duplicate copies — keep the first, delete the rest. The dummy can
  // accrue dups across re-runs / dev-tool spawns; the CONFIRM scan dedups by
  // (rowKey, carrier, reactor) so dups don't double-fire, but keep it tidy.
  const allCopies = dummy.items.filter((i) => i.name === SPEC.name);
  if (allCopies.length > 1) {
    await dummy.deleteEmbeddedDocuments("Item", allCopies.slice(1).map((i) => i.id));
    log(`  removed ${allCopies.length - 1} duplicate copy/copies on dummy`);
  }
  const existing = allCopies[0] ?? null;
  if (existing) {
    const updates = {};
    for (const k of ["reaction_config_table", "effect_table", "isReaction"]) {
      if (!deepEqual(existing.system?.props?.[k], BASE_PROPS[k])) updates[`system.props.${k}`] = BASE_PROPS[k];
    }
    if (Object.keys(updates).length) { await existing.update(updates); log(`  synced dummy copy tables`); }
    else log(`  dummy already has "${SPEC.name}"`);
    return false;
  }
  const data = master.toObject(false);
  delete data._id;
  data.system = data.system ?? {};
  data.system.uniqueId = master.system?.uniqueId ?? master.id;
  await dummy.createEmbeddedDocuments("Item", [data]);
  log(`  equipped "${SPEC.name}" on dummy "${DUMMY_NAME}"`);
  return true;
}

// Foundry deep-MERGES object updates, so a table that dropped a key would
// silently retain the stale key. Force a clean replace (null then set).
async function forceSetTables(item, log, label) {
  if (!item) return;
  const needsClean =
    !deepEqual(item.system?.props?.reaction_config_table, REACTION_CONFIG_TABLE)
    || !deepEqual(item.system?.props?.effect_table, EFFECT_TABLE)
    || item.system?.props?.isReaction !== true;
  if (!needsClean) return;
  await item.update({ "system.props.reaction_config_table": null, "system.props.effect_table": null });
  await item.update({
    "system.props.reaction_config_table": REACTION_CONFIG_TABLE,
    "system.props.effect_table": EFFECT_TABLE,
    "system.props.isReaction": true,
  });
  log(`  force-replaced tables on ${label}`);
}

// Sync EVERY actor copy of Crossfire to the declarative config. Master updates
// don't propagate to actor copies, so any PC (or dev-tool-spawned PC) keeps a
// stale copy. Sweep all actors and clean-replace the drifted tables.
async function syncAllActorCopies(game, log) {
  let synced = 0;
  for (const actor of game.actors?.contents ?? []) {
    const copy = actor.items?.find?.((i) => i.name === SPEC.name);
    if (!copy) continue;
    await forceSetTables(copy, log, `${actor.name} copy`);
    if (copy.system?.props?.reaction_config_table?.["0"]?.reaction_trigger === "creature_targeted_by_action") synced++;
  }
  log(`  ${synced} actor copy/copies now on the declarative Crossfire`);
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, SKILL_SUBFOLDER], { log });
  if (!folder) return { applied: false, summary: "BD Sharpshooter/Skill folder missing" };
  await ensureMaster(game, folder, log);
  const master = findInFolder(game, folder, SPEC.name);
  const equipped = await ensureOnDummy(game, master, log);
  await forceSetTables(master, log, "BD master");
  await syncAllActorCopies(game, log);
  return { applied: true, summary: `Crossfire BD master ensured; dummy equipped: ${equipped}; actor copies swept` };
}
