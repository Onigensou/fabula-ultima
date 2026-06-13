/**
 * Migration: 2026-06-14-sharpshooter-double-arrow-author
 * ---------------------------------------------------------------------------
 * Author Double Arrow (Atlas High Fantasy / Hybrid Heroic Skill — Commander
 * or Sharpshooter):
 *
 *   "When you perform the Attack action with a ranged weapon that belongs to
 *    the bow Category, if you have no other weapon equipped, you may perform
 *    two separate attacks instead of one (against the same target or against
 *    different targets). If you do, both attacks follow the rules for
 *    two-weapon fighting: each attack loses the multi property and cannot gain
 *    it, and you treat the High Roll (HR) of each Accuracy Check as 0 when
 *    determining damage."
 *
 * BD-native design — true bearer-resident passive (canon rule #5). It is NOT a
 * free attack (a "no Free Attacks" debuff must not block it) and NOT Barrage
 * (separate rolls, not one shared roll). It rides the EXISTING two-weapon
 * fighting path: the two separate attacks, the FSM re-entering TARGET for the
 * 2nd pass, and HR-as-0 for damage are all already implemented for two-weapon
 * mode. Double Arrow only needs to make the engine treat a LONE BOW as
 * two-weapon-eligible.
 *
 *   The skill embeds one transfer:true AE carrying a DATA grant:
 *     flags."fabula-ultima-companion".twoWeaponGrant = { soloWeapon: true, category: "bow" }
 *   snapshot.actorTwoWeaponGrants() collects it; evaluateTwoWeaponRules() then
 *   makes canTwoWeaponFight true when the bearer wields a bow and NOTHING in
 *   the off-hand (a two-handed weapon also has an empty off-hand, but only a
 *   soloWeapon grant whose category matches opts it in — the base rule never
 *   does, so other lone weapons stay single-attack). The 2nd attack uses the
 *   same bow (off = the main weapon). The engine never branches on "bow" or
 *   "Double Arrow"; both live in the AE data → a future "Twin Spears"-style
 *   skill is authorable as data alone.
 *
 * No `changes` (pure capability flag), no statuses[] (always-on passive, no
 * token-icon clutter — [[always-active-passive-no-token-icon]]), transfer:true
 * ([[ae-template-no-transfer]] reserves transfer for true bearer passives).
 *
 * "loses the multi property" is a no-op today — the BD engine doesn't model the
 * weapon `multi` property yet; when it lands, two-weapon mode should suppress it.
 *
 * Folder: `Battle Director / Hybrid Heroic Skill` (shared Commander/Sharpshooter,
 * sibling of the per-class Heroic Skill folders). Also equipped on the
 * "BD Test — Sharpshooter" dummy for harness testing.
 *
 * IDEMPOTENT.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-14-sharpshooter-double-arrow-author";
export const description =
  "Author Double Arrow (Atlas HF / Hybrid Heroic): lone-bow two-weapon fighting " +
  "via a data twoWeaponGrant on a transfer:true passive AE.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const HYBRID_HEROIC_FOLDER = "Hybrid Heroic Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const DUMMY_NAME = "BD Test — Sharpshooter";

const DOUBLE_ARROW_ICON = "icons/weapons/ranged/bow-recurve-yellow.webp";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

// ── DATA ─────────────────────────────────────────────────────────────────────

const DA_DESCRIPTION =
  "<p>When you perform the <strong>Attack</strong> action with a ranged weapon that belongs " +
  "to the <strong>bow</strong> Category, if you have <strong>no other weapon equipped</strong>, " +
  "you may perform <strong>two separate attacks</strong> instead of one (against the same target " +
  "or against different targets).</p>" +
  "<p>If you do, both attacks follow the rules for <strong>two-weapon fighting</strong>: each attack " +
  "loses the <strong>multi</strong> property and cannot gain it, and you treat the <strong>High Roll " +
  "(HR)</strong> of each Accuracy Check as 0 when determining damage dealt by it.</p>" +
  "<p><em>This Heroic Skill does not stack with a custom weapon's quick customization.</em></p>";

const PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  skill_range:            "-",
  cost:                   "",
  isCheck:                false,
  isReaction:             false,
  isHeroic:               true,
  on_activate_effect_ref: "",
  max_level:              "1",
  description:            DA_DESCRIPTION,
  heroic_requirement:     "You must have mastered one or more Classes among Commander and Sharpshooter.",
};

// ── EMBEDDED AE ──────────────────────────────────────────────────────────────

const DA_AE_DESCRIPTION =
  "<p><em>Double Arrow:</em> attack twice with a lone bow (two-weapon fighting; HR as 0).</p>";

function makeDoubleArrowAeTemplate(iconUrl) {
  return {
    name: "Double Arrow",
    icon: iconUrl ?? DOUBLE_ARROW_ICON,
    description: DA_AE_DESCRIPTION,
    transfer: true,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: [],
    changes: [],   // pure capability flag — no stat changes
    flags: {
      [MODULE_ID]: {
        // Lone-bow two-weapon grant. snapshot.actorTwoWeaponGrants reads this.
        twoWeaponGrant: { soloWeapon: true, category: "bow" },
      },
    },
    system: { tags: [] },
  };
}

// ── PATCH FUNCTIONS ──────────────────────────────────────────────────────────

async function ensureAeTemplate(item, log, ownerLabel) {
  const want = makeDoubleArrowAeTemplate(item.img);
  const existing = item.effects?.contents?.find((e) => e.name === "Double Arrow");
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want]);
    log(`  ${ownerLabel} Double Arrow: AE template created`);
    return true;
  }
  const needs =
    !deepEqual(existing.changes ?? [], want.changes)
    || !deepEqual(Array.from(existing.statuses ?? []), want.statuses)
    || !deepEqual(existing.flags?.[MODULE_ID] ?? {}, want.flags[MODULE_ID])
    || (want.icon && existing.icon !== want.icon)
    || (want.description && existing.description !== want.description)
    || existing.transfer !== want.transfer;
  if (!needs) return false;
  await existing.update({
    transfer:    want.transfer,
    duration:    want.duration,
    changes:     want.changes,
    statuses:    want.statuses,
    flags:       want.flags,
    system:      want.system,
    ...(want.icon ? { icon: want.icon } : {}),
    ...(want.description ? { description: want.description } : {}),
  });
  log(`  ${ownerLabel} Double Arrow: AE template normalised`);
  return true;
}

async function patchDoubleArrowItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Double Arrow: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // Pure passive — clear any leftover reaction/effect tables.
  if (p.reaction_config_table && Object.keys(p.reaction_config_table).length) {
    await item.update({ "system.props.reaction_config_table": {} });
    log(`  ${ownerLabel} Double Arrow: cleared reaction_config_table`);
    touched = true;
  }
  if (p.effect_table && Object.keys(p.effect_table).length) {
    await item.update({ "system.props.effect_table": {} });
    log(`  ${ownerLabel} Double Arrow: cleared effect_table`);
    touched = true;
  }

  if (await ensureAeTemplate(item, log, ownerLabel)) touched = true;

  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Double Arrow: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try { await item.templateSystem.reloadTemplate(); }
    catch (e) { log(`  ${ownerLabel} Double Arrow: reloadTemplate threw — ${e?.message ?? e}`); }
  }
  return touched;
}

async function ensureOnDummy(master, log) {
  const dummy = game.actors?.getName?.(DUMMY_NAME);
  if (!dummy) { log(`  dummy "${DUMMY_NAME}" not found — skipped equip`); return false; }
  const allCopies = dummy.items.filter((i) => i.name === "Double Arrow" && templateMatches(i));
  if (allCopies.length > 1) {
    await dummy.deleteEmbeddedDocuments("Item", allCopies.slice(1).map((i) => i.id));
    log(`  removed ${allCopies.length - 1} duplicate copy/copies on dummy`);
  }
  if (allCopies[0]) { await patchDoubleArrowItem(allCopies[0], log, "dummy"); return false; }
  const data = master.toObject(false);
  delete data._id;
  data.system = data.system ?? {};
  data.system.uniqueId = master.system?.uniqueId ?? master.id;
  await dummy.createEmbeddedDocuments("Item", [data]);
  log(`  equipped "Double Arrow" on dummy "${DUMMY_NAME}"`);
  return true;
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(game, [BD_ROOT_NAME, HYBRID_HEROIC_FOLDER], { log });
  if (!folder) return { applied: false, summary: `BD ${HYBRID_HEROIC_FOLDER} folder missing` };

  const existing = game.items?.contents?.find?.((i) =>
    i.name === "Double Arrow" && i.folder?.id === folder.id && templateMatches(i));

  // SEED-ONLY (world data is authoritative): if the master already exists, leave
  // it — and every actor copy — untouched, so a co-dev's manual edits are never
  // overridden. This migration only SEEDS a world that lacks the skill entirely.
  if (existing) {
    log("  Double Arrow already present — seed-only; leaving world data untouched");
    return { applied: true, summary: "Double Arrow already present; left untouched (seed-only)" };
  }

  const tpl = game.items.get(SKILL_TEMPLATE_ID);
  const versionStamp = tpl?.system?.templateSystemUniqueVersion;
  const master = await Item.create({
    name: "Double Arrow",
    type: "equippableItem",
    img: DOUBLE_ARROW_ICON,
    folder: folder.id,
    system: {
      template: SKILL_TEMPLATE_ID,
      ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
      props: { skill_type: "Passive", isHeroic: true, level: 1, max_level: 1 },
    },
  });
  log(`  Double Arrow: master created in ${BD_ROOT_NAME}/${HYBRID_HEROIC_FOLDER}` +
      (versionStamp !== undefined ? ` (stamp ${versionStamp})` : " (no template stamp)"));

  await patchDoubleArrowItem(master, log, "master");
  const equipped = await ensureOnDummy(master, log);

  return {
    applied: true,
    summary: `Double Arrow seeded: master created; dummy equipped: ${equipped}`,
  };
}
