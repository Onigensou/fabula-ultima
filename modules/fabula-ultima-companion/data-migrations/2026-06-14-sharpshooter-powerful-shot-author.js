/**
 * Migration: 2026-06-14-sharpshooter-powerful-shot-author
 * ---------------------------------------------------------------------------
 * Author Powerful Shot (Core Rulebook / Sharpshooter Heroic Skill):
 *
 *   "When you hit one or more creatures with a ranged attack, that attack
 *    deals 5 extra damage to each creature. The amount of extra damage
 *    increases to 10 if you are level 40 or higher."
 *
 * BD-native design — true bearer-resident always-on passive (Skill-authoring
 * canon decision-tree rule #5). The bonus is "always available", so there is
 * NO reaction_config_table / effect_table: the skill embeds one transfer:true
 * AE that bumps the existing ranged-damage stat the engine already applies to
 * every ranged attack.
 *
 *   changes: [{ key: "extra_damage_mod_ranged", value: <5|10>, mode: ADD }]
 *
 * `extra_damage_mod_ranged` is the canonical "Damage (Ranged)" prop read by
 * resolveOutgoingDamageParts (skill-formulas.js) for ranged-weapon attacks —
 * so the +N flows automatically through BOTH the Action Card preview and the
 * RESOLVE commit with no dispatch, pill, or per-skill engine code.
 *
 * The level-40 step uses the GENERIC AEF helper `propAtLeast` (added to
 * active-effect-syntax-extender.js):
 *   value: 'propAtLeast("level", 40, 10, 5)'
 * → substitutes to "5" while character level < 40, "10" at/above. "level" is
 * the bearer's character level (actor.system.props.level — the same field
 * CHAR_LEVEL reads). Generic by design: every Fabula Ultima "value increases
 * at level 40" upgrade is now authorable as data alone, no engine edit.
 *
 * No statuses[] per [[always-active-passive-no-token-icon]] — an always-on
 * passive must not clutter the token-icon ring (reserved for transient state).
 *
 * Folder: `Battle Director / Sharpshooter / Heroic Skill` (class-bound).
 * Also equipped on the "BD Test — Sharpshooter" dummy for harness testing,
 * mirroring the Crossfire / Barrage author migrations.
 *
 * IDEMPOTENT.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-14-sharpshooter-powerful-shot-author";
export const description =
  "Author Powerful Shot (Core / Sharpshooter Heroic): true bearer-resident " +
  "passive granting +5 ranged damage (10 at level 40+) via extra_damage_mod_ranged. " +
  "Uses the generic propAtLeast AEF helper.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Sharpshooter";
const HEROIC_SUBFOLDER = "Heroic Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const DUMMY_NAME = "BD Test — Sharpshooter";

const POWERFUL_SHOT_ICON =
  "icons/skills/ranged/arrow-strike-glowing-blue.webp";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

// ── DATA ─────────────────────────────────────────────────────────────────────

const PS_DESCRIPTION =
  "<p>When you hit one or more creatures with a <strong>ranged attack</strong>, " +
  "that attack deals <strong>5 extra damage</strong> to each creature.</p>" +
  "<p>The amount of extra damage increases to <strong>10</strong> if you are " +
  "<strong>level 40</strong> or higher.</p>";

const PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  skill_range:            "-",
  cost:                   "",
  isCheck:                false,
  isReaction:             false,
  isHeroic:               true,
  on_activate_effect_ref: "",
  class:                  CLASS_NAME,
  max_level:              "1",
  description:            PS_DESCRIPTION,
  heroic_requirement:     "You must have learned all the Skills offered by the Sharpshooter Class.",
};

// ── EMBEDDED AE ──────────────────────────────────────────────────────────────

const PS_AE_DESCRIPTION =
  "<p><em>Powerful Shot:</em> ranged attacks deal +5 damage (10 at level 40+).</p>";

// True bearer-resident passive per [[ae-template-no-transfer]]: transfer:true
// so Foundry auto-derives it onto the bearer the moment the skill is added.
// No statuses[] per [[always-active-passive-no-token-icon]].
function makePowerfulShotAeTemplate(iconUrl) {
  return {
    name: "Powerful Shot",
    icon: iconUrl ?? POWERFUL_SHOT_ICON,
    description: PS_AE_DESCRIPTION,
    transfer: true,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: [],
    changes: [
      {
        // +5 ranged damage, stepping to +10 at character level 40+.
        // extra_damage_mod_ranged is auto-prefixed to system.props.* by CSB.
        // propAtLeast reads the bearer's character level (system.props.level).
        key: "extra_damage_mod_ranged",
        value: 'propAtLeast("level", 40, 10, 5)',
        mode: 2,
        priority: 20,
      },
    ],
    flags: {
      [MODULE_ID]: { category: "buff" },
    },
    system: { tags: ["buff"] },
  };
}

// ── PATCH FUNCTIONS ──────────────────────────────────────────────────────────

async function ensureAeTemplate(item, log, ownerLabel) {
  const want = makePowerfulShotAeTemplate(item.img);
  const existing = item.effects?.contents?.find((e) => e.name === "Powerful Shot");
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want]);
    log(`  ${ownerLabel} Powerful Shot: AE template created`);
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
  log(`  ${ownerLabel} Powerful Shot: AE template normalised`);
  return true;
}

async function patchPowerfulShotItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Powerful Shot: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. Clear any leftover reaction_config_table / effect_table — pure passive.
  if (p.reaction_config_table && Object.keys(p.reaction_config_table).length) {
    await item.update({ "system.props.reaction_config_table": {} });
    log(`  ${ownerLabel} Powerful Shot: cleared reaction_config_table`);
    touched = true;
  }
  if (p.effect_table && Object.keys(p.effect_table).length) {
    await item.update({ "system.props.effect_table": {} });
    log(`  ${ownerLabel} Powerful Shot: cleared effect_table`);
    touched = true;
  }

  // 3. Embedded AE template.
  if (await ensureAeTemplate(item, log, ownerLabel)) touched = true;

  // 4. CSB template version stamp + reload per [[csb-template-version-sync]].
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Powerful Shot: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Powerful Shot: CSB templateSystem.reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Powerful Shot: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }

  return touched;
}

// Equip a copy on the BD Test — Sharpshooter dummy for harness testing.
async function ensureOnDummy(master, log) {
  const dummy = game.actors?.getName?.(DUMMY_NAME);
  if (!dummy) { log(`  dummy "${DUMMY_NAME}" not found — skipped equip`); return false; }
  const allCopies = dummy.items.filter((i) => i.name === "Powerful Shot" && templateMatches(i));
  if (allCopies.length > 1) {
    await dummy.deleteEmbeddedDocuments("Item", allCopies.slice(1).map((i) => i.id));
    log(`  removed ${allCopies.length - 1} duplicate copy/copies on dummy`);
  }
  if (allCopies[0]) {
    await patchPowerfulShotItem(allCopies[0], log, `dummy`);
    return false;
  }
  const data = master.toObject(false);
  delete data._id;
  data.system = data.system ?? {};
  data.system.uniqueId = master.system?.uniqueId ?? master.id;
  await dummy.createEmbeddedDocuments("Item", [data]);
  log(`  equipped "Powerful Shot" on dummy "${DUMMY_NAME}"`);
  return true;
}

export async function migrate(game, log = () => {}) {
  const { folder } = await ensureFolderPath(
    game, [BD_ROOT_NAME, CLASS_NAME, HEROIC_SUBFOLDER], { log });
  if (!folder) {
    return { applied: false, summary: `Powerful Shot: missing folder "${BD_ROOT_NAME}/${CLASS_NAME}/${HEROIC_SUBFOLDER}"` };
  }

  let master = game.items?.contents?.find?.((i) =>
    i.name === "Powerful Shot" && i.folder?.id === folder.id && templateMatches(i));

  if (!master) {
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    master = await Item.create({
      name: "Powerful Shot",
      type: "equippableItem",
      img: POWERFUL_SHOT_ICON,
      folder: folder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: { skill_type: "Passive", isHeroic: true, level: 1, max_level: 1 },
      },
    });
    log(`  Powerful Shot: master created in ${BD_ROOT_NAME}/${CLASS_NAME}/${HEROIC_SUBFOLDER}` +
        (versionStamp !== undefined ? ` (stamp ${versionStamp})` : " (no template stamp)"));
  }

  let masters = 0, copies = 0;
  if (await patchPowerfulShotItem(master, log, "master")) masters += 1;

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Powerful Shot") continue;
      if (!templateMatches(item)) continue;
      if (await patchPowerfulShotItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  const equipped = await ensureOnDummy(master, log);

  return {
    applied: true,
    summary: `Powerful Shot authored: ${masters} master, ${copies} actor copy(s); dummy equipped: ${equipped}`,
  };
}
