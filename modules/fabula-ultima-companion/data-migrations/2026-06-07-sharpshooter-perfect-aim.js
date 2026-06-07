/**
 * Migration: 2026-06-07-sharpshooter-perfect-aim
 * ---------------------------------------------------------------------------
 * Author the Battle Director master for Perfect Aim (Sharpshooter Heroic Skill)
 * and equip it on the BD test dummy ("BD Test — Sharpshooter").
 *
 * RAW: "When you hit one or more creatures with a ranged attack and choose to
 * deal no damage in order to gain the benefits of the Warning Shot Skill, you
 * may choose two options instead of one."
 * Requirements: mastered Sharpshooter + acquired Warning Shot.
 *
 * DECLARATIVE — Perfect Aim is a pure MARKER skill: it carries NO reaction
 * config of its own. Its mechanical effect lives entirely in Warning Shot's
 * menu, whose `menu_pick_count` formula is "1 + HAS_SKILL_PERFECT_AIM" — the
 * dynamic cross-skill presence gate. So owning a skill item named "Perfect Aim"
 * is what widens Warning Shot's choice from one option to two. No engine edit,
 * no hardcoded skill name in the runtime. See the warning-shot migration +
 * [[feedback_skill_no_hardcode_test]].
 *
 * This migration upgrades the prior empty Perfect Aim stub: real RAW
 * description + isHeroic flag. The folder stays BD/Sharpshooter/Skill (where the
 * stub already lives) to avoid breaking the dev-tool's class-skill collector.
 *
 * IDEMPOTENT: create-if-missing + drift-correct on the master; create-if-absent
 * copy on the dummy.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-07-sharpshooter-perfect-aim";
export const description =
  "Author the Battle Director Perfect Aim Heroic Skill (marker that widens " +
  "Warning Shot to two options) + equip it on the BD Test — Sharpshooter dummy.";

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

const BASE_PROPS = {
  rolled_atr1: "-", rolled_atr2: "-", isCheck: false, isReaction: false,
  isFacet: false, isHeroic: true, isZeroPower: false, isOffensiveSpell: false,
  ignore_hr: false, class: CLASS_NAME, cost: "", skill_target: "-", skill_range: "",
  type_damage: "", damage_bonus: "0", check_bonus: "0", defense_target_type: "def",
  duration: "-", on_activate_effect_ref: "", post_damage_effect_ref: "",
  reaction_config_table: {},
  effect_table: {},
  active_effect_config_table: {},
};

const SPEC = {
  name: "Perfect Aim",
  props: {
    skill_type: "Passive", level: "1", max_level: "1",
    description:
      "<p>When you hit one or more creatures with a <strong>ranged attack</strong> " +
      "and choose to deal no damage in order to gain the benefits of the " +
      "<strong>Warning Shot</strong> Skill, you may choose <strong>two options " +
      "instead of one</strong> (for instance, you could inflict both shaken and " +
      "slow on each creature, or inflict a status effect on each creature while " +
      "also lowering their Mind Points).</p>" +
      "<p><em>Requirements: you must have mastered the Sharpshooter Class, and " +
      "must have acquired the Warning Shot Skill.</em></p>",
  },
};

function allInFolder(game, folder, name) {
  return (game.items?.contents ?? []).filter((i) => i.name === name && i.folder?.id === folder.id);
}
function findInFolder(game, folder, name) {
  return allInFolder(game, folder, name)[0] ?? null;
}

async function ensureMaster(game, folder, log) {
  const wantProps = { ...BASE_PROPS, ...SPEC.props, name: SPEC.name };
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
      name: SPEC.name, type: "equippableItem", folder: folder.id,
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
    for (const k of ["isHeroic", "isReaction"]) {
      if (existing.system?.props?.[k] !== BASE_PROPS[k]) updates[`system.props.${k}`] = BASE_PROPS[k];
    }
    if (!deepEqual(existing.system?.props?.description, SPEC.props.description)) {
      updates["system.props.description"] = SPEC.props.description;
    }
    if (Object.keys(updates).length) { await existing.update(updates); log(`  synced dummy copy`); }
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

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, SKILL_SUBFOLDER], { log });
  if (!folder) return { applied: false, summary: "BD Sharpshooter/Skill folder missing" };
  await ensureMaster(game, folder, log);
  const master = findInFolder(game, folder, SPEC.name);
  const equipped = await ensureOnDummy(game, master, log);
  return { applied: true, summary: `Perfect Aim BD master ensured; dummy equipped: ${equipped}` };
}
