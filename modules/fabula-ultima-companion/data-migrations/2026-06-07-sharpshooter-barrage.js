/**
 * Migration: 2026-06-07-sharpshooter-barrage
 * ---------------------------------------------------------------------------
 * Author the Battle Director master for Barrage (Sharpshooter) and equip it on
 * the BD test dummy ("BD Test — Sharpshooter").
 *
 * RAW: "When you perform a ranged attack, you may spend 10 Mind Points to have
 * the attack target one additional creature."
 *
 * DECLARATIVE — pre-roll reaction, NO hardcoded skill name in the engine.
 * Barrage is the first consumer of the two-phase Action Card's PRE-ROLL window
 * (rollPhase "pre", trigger creature_performs_action). The pre-roll window
 * fires before the attack roll, so the 10 MP is a true pre-commit (paid before
 * the result is known) and nothing leaks the verdict. A sibling skill (e.g.
 * "Twin Shot", different numbers/resource) is authorable as DATA alone via the
 * same primitives — no engine edit. See [[feedback_skill_no_hardcode_test]].
 *
 * ENGINE MAPPING:
 *   reaction_config_table[0]
 *     reaction_trigger      = creature_performs_action  (fires in the pre-roll
 *                             window, BEFORE the dice — rollPhase "pre")
 *     reaction_source       = self        (my own action)
 *     reaction_isPassive    = true
 *     reaction_passive_mode = ask         (clickable blade in the pre-roll menu;
 *                             the affordability walker auto-disables it "Low MP"
 *                             when the attacker can't pay the 10 MP)
 *     reaction_effect_ref   = barrage_do
 *     condition_formula     = ATTACK_IS_RANGED == 1  (the attack weapon's range
 *                             is ranged — NOT HAS_RANGED_WEAPON, which checks
 *                             for an *equipped* ranged weapon and mis-gates when
 *                             attacking with a non-isEquipped weapon)
 *
 *   effect_table
 *     barrage_do    chain → [barrage_add, barrage_cost]   (cost LAST so a
 *                   cancelled pick costs nothing — [[consume-last-in-chain]])
 *     barrage_add   add_target → barrage_pick   (queues the extra target onto
 *                   the pre-roll side-channel; COMPUTE splices it into the
 *                   target list before rolling. Cancel/empty → abort, no cost)
 *     barrage_cost  consume_resource mp = 10 from self
 *     barrage_pick  targeting: one enemy NOT already targeted (interactive even
 *                   in the passive chain via skip_when_passive:false)
 *
 * IDEMPOTENT: create-if-missing + drift-correct on the master; create-if-absent
 * copy on the dummy; force-replace tables to defeat Foundry's deep-merge.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-07-sharpshooter-barrage";
export const description =
  "Author the Battle Director Barrage master (declarative pre-roll target " +
  "augment) + equip it on the BD Test — Sharpshooter dummy.";

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
    reaction_trigger: "creature_performs_action",
    reaction_source: "self",
    reaction_isPassive: true,
    reaction_passive_mode: "ask",
    reaction_effect_ref: "barrage_do",
    // Gate on the RANGE of the weapon being attacked WITH (ATTACK_IS_RANGED),
    // not HAS_RANGED_WEAPON — the latter checks for an *equipped* ranged weapon
    // (system.props.isEquipped), but a BD attack can be performed with a weapon
    // whose isEquipped flag is false, so HAS_RANGED_WEAPON wrongly gated Barrage
    // out. ATTACK_IS_RANGED reads payload.weaponRange (the attack weapon's range).
    condition_formula: "ATTACK_IS_RANGED == 1",
  },
};

const EFFECT_TABLE = {
  "0": { effect_label: "barrage_do", effect_kind: "chain", chain_steps: "barrage_add,barrage_cost" },
  "1": {
    effect_label: "barrage_add", effect_kind: "add_target",
    target_ref: "barrage_pick",
    menu_label: "Barrage", menu_description: "Spend 10 MP to target one additional creature.",
  },
  "2": {
    effect_label: "barrage_cost", effect_kind: "consume_resource",
    consume_resource: "mp", consume_amount: "10", target_ref: "self", on_empty: "abort",
  },
  "3": {
    effect_label: "barrage_pick", effect_kind: "targeting",
    candidate_source: "combat", category: "enemy",
    exclude_action_targets: true,
    mode: "exact", count: 1,
    skip_when_passive: false,            // prompt even inside the passive chain
    auto_confirm_when_obvious: false,    // always show the picker (lets the player cancel → no cost)
  },
};

const BASE_PROPS = {
  rolled_atr1: "-", rolled_atr2: "-", isCheck: false, isReaction: true,
  isFacet: false, isHeroic: false, isZeroPower: false, isOffensiveSpell: false,
  ignore_hr: false, class: CLASS_NAME, cost: "10 MP", skill_target: "-", skill_range: "",
  type_damage: "", damage_bonus: "0", check_bonus: "0", defense_target_type: "def",
  duration: "-", on_activate_effect_ref: "", post_damage_effect_ref: "",
  reaction_config_table: REACTION_CONFIG_TABLE,
  effect_table: EFFECT_TABLE,
  active_effect_config_table: {},
};

const SPEC = {
  name: "Barrage",
  img: "icons/skills/ranged/arrow-strike-glowing-orange.webp",
  props: {
    skill_type: "Passive", level: "1", max_level: "1",
    description:
      "<p>When you perform a <strong>ranged attack</strong>, you may spend " +
      "<strong>10 Mind Points</strong> to have the attack target one additional " +
      "creature. Loose a hail of shots!</p>",
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
  const existing = dummy.items.find((i) => i.name === SPEC.name);
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

// Sync EVERY actor copy of Barrage to the new declarative config. Master
// updates don't propagate to actor copies (CSB syncs only some props), so a
// PC who learned the old Barrage — or a dev-tool-spawned PC — keeps the stale
// version (no creature_performs_action row → never surfaces in the pre-roll
// window). Sweep all actors and clean-replace the drifted tables.
async function syncAllActorCopies(game, log) {
  let synced = 0;
  for (const actor of game.actors?.contents ?? []) {
    const copy = actor.items?.find?.((i) => i.name === SPEC.name);
    if (!copy) continue;
    const before = copy.system?.props?.reaction_config_table?.["0"]?.reaction_trigger ?? "(none)";
    await forceSetTables(copy, log, `${actor.name} copy (was trigger=${before})`);
    if (copy.system?.props?.reaction_config_table?.["0"]?.reaction_trigger === "creature_performs_action") synced++;
  }
  log(`  ${synced} actor copy/copies now on the declarative pre-roll Barrage`);
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, CLASS_NAME, SKILL_SUBFOLDER], { log });
  if (!folder) return { applied: false, summary: "BD Sharpshooter/Skill folder missing" };
  await ensureMaster(game, folder, log);
  const master = findInFolder(game, folder, SPEC.name);
  const equipped = await ensureOnDummy(game, master, log);
  await forceSetTables(master, log, "BD master");
  // Sweep ALL actor copies (dummy + PCs + dev-tool-spawned actors) so none keep
  // the stale pre-declarative Barrage.
  await syncAllActorCopies(game, log);
  return { applied: true, summary: `Barrage BD master ensured; dummy equipped: ${equipped}; actor copies swept` };
}
