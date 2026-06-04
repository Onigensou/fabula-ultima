/**
 * Migration: 2026-06-04-guardian-dual-shieldbearer-author
 * ---------------------------------------------------------------------------
 * Author Dual Shieldbearer (Guardian / Skill) per FU Core p.???
 *
 *   "You may now equip a shield in your main hand slot. As long as you
 *    have two shields equipped, you gain the benefits of both items and
 *    may treat them as the following combined two-handed melee
 *    brawling weapon — Twin Shields, MIG+MIG, HR+5 physical, Deals
 *    extra damage equal to your SL in Defensive Mastery."
 *
 * BD-native design: declarative virtual-attack exposure.
 *
 *   Skill is a true passive (no reaction_config_table — DSB has no
 *   trigger; the rule is "always-on while owned"). The skill embeds a
 *   transfer:true AE that carries:
 *     flags.fabula-ultima-companion.exposedVirtualAttack = {
 *       profile: { name: "Twin Shields", A1: MIG, A2: MIG,
 *                  damageBonus: "5 + SL_DEFENSIVE_MASTERY",
 *                  damageType: Physical, range: Melee,
 *                  weaponType: Brawling },
 *       condition_formula: "EQUIPPED_SHIELD_COUNT >= 2"
 *     }
 *
 *   At snapshot time (snapshot.js / resolveVirtualAttacks), the engine:
 *     1. Walks actor.effects for AEs carrying exposedVirtualAttack
 *     2. Evaluates condition_formula via buildSkillResolver
 *     3. Resolves damageBonus / checkBonus formula strings against the
 *        same resolver (SL_DEFENSIVE_MASTERY reads owned-skill SL)
 *     4. Adds the resolved profile to snap.virtualAttacks
 *
 *   At TARGET time, the weapon-mode picker offers Twin Shields alongside
 *   any equipped real weapons. Player picks; COMPUTE uses the virtual
 *   profile as the single-pass weapon.
 *
 *   "Benefits of both shields" — each equipped shield's bonus_defense /
 *   bonus_mdef / affinity_* changes already apply via the existing
 *   AE/sheet derivation system (shields are just equippable items with
 *   their own changes). DSB doesn't need to do anything for that; it
 *   only adds the new attack option.
 *
 *   "Shield in main hand slot" — the equipment system already permits
 *   shield-in-main-hand per the user. No additional gating needed.
 *
 * Reads:
 *   - EQUIPPED_SHIELD_COUNT (new) — see skill-formulas.js
 *   - SL_DEFENSIVE_MASTERY  (new, via dynamic SL_<NAME>) — see skill-formulas.js
 *
 * Touches: BD-tree master Dual Shieldbearer + matching actor copies
 * (template + name + master-folder-in-BD-tree).
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-04-guardian-dual-shieldbearer-author";
export const description =
  "Author Dual Shieldbearer per FU Core: always-on passive AE exposing a " +
  "Twin Shields virtual attack (MIG+MIG, HR+5 physical, brawling, +SL_DM) " +
  "when EQUIPPED_SHIELD_COUNT >= 2.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

// ── DATA ────────────────────────────────────────────────────────────────────

const DSB_DESCRIPTION =
  "<p>You may now equip a <strong>shield</strong> in your <strong>main hand</strong> slot. " +
  "As long as you have two shields equipped, you gain the benefits of both items and may " +
  "treat them as the following combined two-handed melee brawling weapon:</p>" +
  "<blockquote>" +
  "<p><strong>Twin Shields</strong> — Accuracy: <strong>【MIG + MIG】</strong> — " +
  "Damage: <strong>【HR + 5】 physical</strong></p>" +
  "<p>Deals extra damage equal to your <strong>SL</strong> in " +
  "<em>Defensive Mastery</em>.</p>" +
  "</blockquote>";

const PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  skill_range:            "-",
  cost:                   "",
  isCheck:                false,
  isReaction:             false,
  isHeroic:               false,
  on_activate_effect_ref: "",
  max_level:              "1",
  description:            DSB_DESCRIPTION,
};

// ── EMBEDDED AE ────────────────────────────────────────────────────────────

// One-sentence AE description per [[ae-description-brevity]]. AE itself
// is bearer-resident always-on (transfer:true), no statuses (per
// [[always-active-passive-no-token-icon]] — DSB is always-on, no
// transient state).
const DSB_AE_DESCRIPTION =
  "<p><em>Dual Shieldbearer:</em> Two shields equipped: gain Twin Shields attack (MIG+MIG, HR+5 physical, +SL Defensive Mastery damage).</p>";

const TWIN_SHIELDS_PROFILE = {
  name:        "Twin Shields",
  A1:          "MIG",
  A2:          "MIG",
  checkBonus:  0,
  damageBonus: "5 + SL_DEFENSIVE_MASTERY",
  damageType:  "Physical",
  range:       "Melee",
  weaponType:  "Brawling",
  // Use the existing Twin Shield item image so the picker UI matches
  // the legacy world's iconography.
  imageUrl:    "icons/equipment/shield/heater-steel-gray.webp",
};

const DSB_EXPOSED_VIRTUAL_ATTACK = {
  profile:            TWIN_SHIELDS_PROFILE,
  condition_formula:  "EQUIPPED_SHIELD_COUNT >= 2",
};

function makeDsbAeTemplate(iconUrl) {
  return {
    name: "Dual Shieldbearer",
    icon: iconUrl ?? null,
    description: DSB_AE_DESCRIPTION,
    // True passive — bearer-resident always-on. Per
    // [[ae-template-no-transfer]]: transfer:true is RESERVED for true
    // passives. DSB qualifies (always-on rule, no apply_ae dispatch).
    transfer: true,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    // No statuses[] — per [[always-active-passive-no-token-icon]],
    // always-on passives don't claim a token-icon slot. The "two
    // shields equipped" state is visible from the equipment itself.
    statuses: [],
    changes: [],
    flags: {
      [MODULE_ID]: {
        category:                "buff",
        exposedVirtualAttack:    DSB_EXPOSED_VIRTUAL_ATTACK,
      },
    },
    system: { tags: ["buff"] },
  };
}

// ── PATCH FUNCTIONS ────────────────────────────────────────────────────────

async function ensureAeTemplate(item, name, makeFn, log, ownerLabel) {
  const want = makeFn(item.img);
  const existing = item.effects?.contents?.find((e) => e.name === name);
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want]);
    log(`  ${ownerLabel} Dual Shieldbearer: AE template "${name}" created`);
    return true;
  }
  const wantChanges  = want.changes;
  const wantStatuses = want.statuses;
  const wantFlags    = want.flags;
  const wantDesc     = want.description;
  const wantTransfer = want.transfer;
  const needs =
    !deepEqual(existing.changes ?? [], wantChanges)
    || !deepEqual(Array.from(existing.statuses ?? []), wantStatuses)
    || !deepEqual(existing.flags?.[MODULE_ID] ?? {}, wantFlags[MODULE_ID])
    || (want.icon && existing.icon !== want.icon)
    || (wantDesc && existing.description !== wantDesc)
    || existing.transfer !== wantTransfer;
  if (!needs) return false;
  await existing.update({
    transfer:    wantTransfer,
    duration:    want.duration,
    changes:     wantChanges,
    statuses:    wantStatuses,
    flags:       wantFlags,
    system:      want.system,
    ...(want.icon ? { icon: want.icon } : {}),
    ...(wantDesc ? { description: wantDesc } : {}),
  });
  log(`  ${ownerLabel} Dual Shieldbearer: AE template "${name}" normalised`);
  return true;
}

async function patchDsbItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Dual Shieldbearer: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. Strip any leftover reaction_config_table / effect_table (DSB is
  //    a true passive — no reaction rows, no effect rows).
  if (p.reaction_config_table && Object.keys(p.reaction_config_table).length) {
    await item.update({ "system.props.reaction_config_table": {} });
    log(`  ${ownerLabel} Dual Shieldbearer: cleared reaction_config_table`);
    touched = true;
  }
  if (p.effect_table && Object.keys(p.effect_table).length) {
    await item.update({ "system.props.effect_table": {} });
    log(`  ${ownerLabel} Dual Shieldbearer: cleared effect_table`);
    touched = true;
  }

  // 3. Embedded AE template.
  if (await ensureAeTemplate(item, "Dual Shieldbearer", makeDsbAeTemplate, log, ownerLabel)) touched = true;

  // 4. Sync CSB template version stamp. See [[csb-template-version-sync]].
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Dual Shieldbearer: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }

  // 5. Force CSB template reload so the sheet's cached field schema
  //    rebuilds. See [[csb-template-version-sync]].
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Dual Shieldbearer: CSB templateSystem.reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Dual Shieldbearer: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }

  return touched;
}

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Dual Shieldbearer") continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchDsbItem(item, log, "master")) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Dual Shieldbearer") continue;
      if (!templateMatches(item)) continue;
      if (await patchDsbItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Dual Shieldbearer authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
