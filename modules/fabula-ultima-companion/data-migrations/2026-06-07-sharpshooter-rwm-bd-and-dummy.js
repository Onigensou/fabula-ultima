/**
 * Migration: 2026-06-07-sharpshooter-rwm-bd-and-dummy
 * ---------------------------------------------------------------------------
 * Ranged Weapon Mastery lost its Battle Director master (the 2026-06-03
 * sharpshooter-b1-author created one, but it's absent from the current world —
 * only the legacy `💥 Skill / Class Skill / Sharpshooter` copy survives, and
 * b1-author is ledgered so it never re-creates it). Its 4 siblings (Hawkeye,
 * Warning Shot, Barrage, Crossfire) DO have BD masters.
 *
 * This re-authors the BD-tree RWM master (idempotent create-if-missing in
 * `Battle Director / Sharpshooter / Skill`) with its canonical passive AE
 * (+SL to ranged Accuracy), and ALSO equips it on the BD test dummy
 * ("BD Test — Sharpshooter") so it can be harness-tested alongside the rest.
 *
 * IDEMPOTENT: re-runs no-op once the master + dummy copy exist & match.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-07-sharpshooter-rwm-bd-and-dummy";
export const description =
  "Re-author the Battle Director Ranged Weapon Mastery master + equip it on " +
  "the BD Test — Sharpshooter dummy.";

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
  isFacet: false, isHeroic: false, isZeroPower: false, isOffensiveSpell: false,
  ignore_hr: false, class: CLASS_NAME, cost: "", skill_target: "-", skill_range: "",
  type_damage: "", damage_bonus: "0", check_bonus: "0", defense_target_type: "def",
  duration: "-", on_activate_effect_ref: "", reaction_config_table: {},
  effect_table: {}, active_effect_config_table: {},
};

const RWM_SPEC = {
  name: "Ranged Weapon Mastery",
  img: "icons/skills/ranged/target-bullseye-arrow-glowing.webp",
  props: {
    skill_type: "Passive", level: "1", max_level: "4",
    description:
      "<p>You gain a bonus equal to <strong>【SL】</strong> to all Accuracy " +
      "Checks with <strong>ranged</strong> weapons.</p>",
  },
  effects: [{
    name: "Ranged Weapon Mastery",
    transfer: true,
    disabled: false,
    duration: { startTime: null, seconds: null, rounds: null, turns: null, startRound: null, startTurn: null, type: "none", duration: null },
    statuses: [],
    changes: [{ key: "attack_accuracy_mod_ranged", value: "${level}$", mode: 2, priority: 1 }],
    flags: { [MODULE_ID]: { directorPermanent: false, crossScene: false } },
    system: { tags: ["buff"] },
  }],
};

function allInFolder(game, folder, name) {
  return (game.items?.contents ?? []).filter((i) => i.name === name && i.folder?.id === folder.id);
}
function findInFolder(game, folder, name) {
  return allInFolder(game, folder, name)[0] ?? null;
}

async function ensureMaster(folder, log) {
  const wantProps = { ...BASE_PROPS, ...RWM_SPEC.props, name: RWM_SPEC.name, img: RWM_SPEC.img };
  // Dedup any duplicates a prior partial run may have created.
  const dups = allInFolder(game, folder, RWM_SPEC.name);
  if (dups.length > 1) {
    const extra = dups.slice(1);
    await Item.deleteDocuments(extra.map((i) => i.id));
    log(`  removed ${extra.length} duplicate BD master(s)`);
  }
  let item = dups[0] ?? null;
  if (!item) {
    // CSB skills are type "equippableItem" — NOT "skill" (the latter silently
    // fails to materialize; that's why the b1-author's BD masters never stuck).
    // Mirror the working Hawkeye-author pattern: Item.create + version stamp.
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    await Item.create({
      name: RWM_SPEC.name, img: RWM_SPEC.img, type: "equippableItem", folder: folder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: wantProps,
      },
      effects: RWM_SPEC.effects,
    });
    item = findInFolder(game, folder, RWM_SPEC.name);
    log(`  created BD master "${RWM_SPEC.name}" (id=${item?.id ?? "??"})`);
    return item;
  }
  // Update drifted props / AE.
  const updates = {};
  for (const [k, v] of Object.entries(wantProps)) {
    if (!deepEqual(item.system?.props?.[k], v)) updates[`system.props.${k}`] = v;
  }
  if (Object.keys(updates).length) { await item.update(updates); log(`  updated BD master props`); }
  const aeSpec = RWM_SPEC.effects[0];
  const ae = item.effects?.contents?.find((e) => e.name === aeSpec.name);
  if (!ae) { await item.createEmbeddedDocuments("ActiveEffect", [aeSpec]); log(`  created AE on BD master`); }
  else if (!deepEqual(ae.changes ?? [], aeSpec.changes) || ae.transfer !== aeSpec.transfer) {
    await ae.update({ transfer: aeSpec.transfer, changes: aeSpec.changes, statuses: aeSpec.statuses, flags: aeSpec.flags, system: aeSpec.system });
    log(`  normalised AE on BD master`);
  }
  return item;
}

async function ensureOnDummy(master, log) {
  if (!master) { log(`  no master to equip — skipped dummy`); return false; }
  const dummy = game.actors?.getName?.(DUMMY_NAME);
  if (!dummy) { log(`  dummy "${DUMMY_NAME}" not found — skipped equip`); return false; }
  if (dummy.items.some((i) => i.name === RWM_SPEC.name)) { log(`  dummy already has "${RWM_SPEC.name}"`); return false; }
  const data = master.toObject(false);
  delete data._id;
  // Link the copy to the master so future syncs / lookups resolve.
  data.system = data.system ?? {};
  data.system.uniqueId = master.system?.uniqueId ?? master.id;
  await dummy.createEmbeddedDocuments("Item", [data]);
  log(`  equipped "${RWM_SPEC.name}" on dummy "${DUMMY_NAME}"`);
  return true;
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, SKILL_SUBFOLDER], { log });
  if (!folder) return { applied: false, summary: "BD Sharpshooter/Skill folder missing" };
  await ensureMaster(folder, log);
  // Re-resolve from the folder so the dummy step never depends on a flaky
  // create/return value.
  const master = findInFolder(game, folder, RWM_SPEC.name);
  const equipped = await ensureOnDummy(master, log);
  return { applied: true, summary: `RWM BD master ensured; dummy equipped: ${equipped}` };
}
