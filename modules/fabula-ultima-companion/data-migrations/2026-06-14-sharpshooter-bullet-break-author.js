/**
 * Migration: 2026-06-14-sharpshooter-bullet-break-author
 * ---------------------------------------------------------------------------
 * Author Bullet Break (Atlas High Fantasy / Sharpshooter Heroic Skill):
 *
 *   "After you negate a ranged attack with the Crossfire Skill, if the Result
 *    of the Accuracy Check was an even number, you may perform a free attack
 *    against the attacker with a ranged firearm weapon you have equipped. This
 *    attack must have that enemy as its only target; treat your High Roll (HR)
 *    as 0 when calculating damage dealt by it."
 *
 * DECLARATIVE — keys off a SPECIFIC named skill (Crossfire) via the generic
 * `creature_completes_skill` trigger + `reaction_source_skill` name filter. The
 * engine never branches on "Crossfire"; the row carries the name. When Crossfire
 * resolves during an action card's reaction window, the reactive re-derive injects
 * Bullet Break into the same pill list (see action-card recomputeTargetPreviews).
 *
 * ENGINE MAPPING:
 *   reaction_config_table[0]
 *     reaction_trigger      = creature_completes_skill  (a named skill resolved)
 *     reaction_source       = self        (I am the one who used Crossfire —
 *                             matched via payload.sourceActorUuid)
 *     reaction_source_skill = Crossfire   (only Crossfire's completion fires this)
 *     reaction_passive_mode = ask         ("you may" → clickable pill)
 *     reaction_effect_ref   = bullet_break_do
 *     condition_formula     = ATTACK_IS_RANGED == 1        (the negated attack
 *                             was ranged — reads forwarded payload.weaponRange)
 *                          && ATTACK_CHECK_RESULT % 2 == 0 (the attacker's
 *                             Accuracy Result was even — payload.checkTotal)
 *                          && HAS_FIREARM                  (I have a firearm
 *                             equipped — RAW gate)
 *
 *   effect_table
 *     bullet_break_do  free_action: a single free Attack, HR treated as 0,
 *                      locked to the original attacker as its only target.
 *       action_ref       = Attack            (compose an Attack with the
 *                          equipped weapon — gated to firearm by HAS_FIREARM;
 *                          Option 1 enforcement, see skill design notes)
 *       target_ref       = trigger_attacker  (the original attacker; "only target")
 *       free_hr_as_zero  = true              ("treat HR as 0 for damage")
 *       (chain unset → default false → a REAL free attack, so a "no Free
 *        Attacks" debuff can still prevent it, per RAW intent.)
 *
 * Folder: `Battle Director / Sharpshooter / Heroic Skill`. Also equipped on the
 * "BD Test — Sharpshooter" dummy for harness testing.
 *
 * IDEMPOTENT.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-14-sharpshooter-bullet-break-author";
export const description =
  "Author the Battle Director Bullet Break master (Sharpshooter Heroic; " +
  "creature_completes_skill→Crossfire follow-up free firearm attack) + equip on dummy.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Sharpshooter";
const HEROIC_SUBFOLDER = "Heroic Skill";
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
    reaction_trigger: "creature_completes_skill",
    reaction_source: "self",
    reaction_source_skill: "Crossfire",
    reaction_passive_mode: "ask",
    reaction_effect_ref: "bullet_break_do",
    condition_formula:
      "ATTACK_IS_RANGED == 1 && ATTACK_CHECK_RESULT % 2 == 0 && HAS_FIREARM",
  },
};

const EFFECT_TABLE = {
  "0": {
    effect_label: "bullet_break_do",
    effect_kind: "free_action",
    action_ref: "Attack",
    target_ref: "trigger_attacker",
    free_hr_as_zero: "true",
    menu_label: "Bullet Break",
    menu_description: "Free firearm attack against the attacker (treat HR as 0 for damage).",
  },
};

const BASE_PROPS = {
  rolled_atr1: "-", rolled_atr2: "-", isCheck: false, isReaction: true,
  isFacet: false, isHeroic: true, isZeroPower: false, isOffensiveSpell: false,
  ignore_hr: false, class: CLASS_NAME, cost: "Special", skill_target: "-", skill_range: "",
  type_damage: "", damage_bonus: "0", check_bonus: "0", defense_target_type: "def",
  duration: "-", on_activate_effect_ref: "", post_damage_effect_ref: "",
  reaction_config_table: REACTION_CONFIG_TABLE,
  effect_table: EFFECT_TABLE,
  active_effect_config_table: {},
};

const SPEC = {
  name: "Bullet Break",
  img: "icons/skills/ranged/cannon-barrel-firing-yellow.webp",
  props: {
    skill_type: "Passive", level: "1", max_level: "1",
    heroic_requirement: "You must have learned the Crossfire Skill, and have mastered one or more Classes among Commander and Sharpshooter.",
    description:
      "<p>After you negate a <strong>ranged attack</strong> with the <strong>Crossfire</strong> " +
      "Skill, if the Result of the Accuracy Check was an <strong>even number</strong>, you may " +
      "perform a <strong>free attack</strong> against the attacker with a <strong>ranged firearm</strong> " +
      "weapon you have equipped.</p>" +
      "<p>This attack must have that enemy as its <strong>only target</strong>; treat your " +
      "<strong>High Roll (HR) as 0</strong> when calculating damage dealt by it.</p>",
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
    await Item.deleteDocuments(dups.slice(1).map((i) => i.id));
    log(`  removed ${dups.length - 1} duplicate BD master(s)`);
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
  const allCopies = dummy.items.filter((i) => i.name === SPEC.name);
  if (allCopies.length > 1) {
    await dummy.deleteEmbeddedDocuments("Item", allCopies.slice(1).map((i) => i.id));
    log(`  removed ${allCopies.length - 1} duplicate copy/copies on dummy`);
  }
  const existing = allCopies[0] ?? null;
  if (existing) {
    const updates = {};
    for (const k of ["reaction_config_table", "effect_table", "isReaction", "isHeroic"]) {
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

// Foundry deep-MERGES object updates, so force a clean replace (null then set).
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

async function syncAllActorCopies(game, log) {
  let synced = 0;
  for (const actor of game.actors?.contents ?? []) {
    const copy = actor.items?.find?.((i) => i.name === SPEC.name);
    if (!copy) continue;
    await forceSetTables(copy, log, `${actor.name} copy`);
    if (copy.system?.props?.reaction_config_table?.["0"]?.reaction_trigger === "creature_completes_skill") synced++;
  }
  log(`  ${synced} actor copy/copies now on the declarative Bullet Break`);
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, HEROIC_SUBFOLDER], { log });
  if (!folder) return { applied: false, summary: `BD ${CLASS_NAME}/${HEROIC_SUBFOLDER} folder missing` };
  await ensureMaster(game, folder, log);
  const master = findInFolder(game, folder, SPEC.name);
  const equipped = await ensureOnDummy(game, master, log);
  await forceSetTables(master, log, "BD master");
  await syncAllActorCopies(game, log);
  return { applied: true, summary: `Bullet Break BD master ensured; dummy equipped: ${equipped}; actor copies swept` };
}
