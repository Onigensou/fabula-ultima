/**
 * Migration: 2026-06-04-guardian-unbreakable-author
 * ---------------------------------------------------------------------------
 * Author Unbreakable (Guardian / Heroic Skill) per FU Core p. 240:
 *
 *   "Once per scene when you are about to be reduced to 0 Hit Points, you
 *    may instead choose to withstand the pain and be reduced to exactly
 *    1 Hit Point."
 *
 * Authoring shape (Mercy-style — AE carries the reaction):
 *
 *   skill.reaction_config_table:
 *     0: conflict_start (Force) → unbreakable_arm
 *          — apply "Unbreakable Ready" AE to self (replace)
 *
 *   skill.effect_table:
 *     unbreakable_arm → apply_ae "Unbreakable Ready" → self (replace)
 *
 *   embedded AE "Unbreakable Ready":
 *     transfer:false, statuses:["fud-unbreakable-ready"], skill.img icon,
 *     crossScene:true (survives mid-conflict scene swaps),
 *     directorPermanent:true (engine sweep keeps it across rounds),
 *     reactionConfig:
 *       reaction_config_table[0]:
 *         trigger=creature_takes_damage, source=self,
 *         damage_outcome=would_reduce_to_zero,
 *         reaction_isPassive=true, passive_mode="ask",
 *         effect_ref="unbreakable_clamp"
 *       effect_table[0]:
 *         effect_label=unbreakable_clamp,
 *         effect_kind=modify_damage_taken,
 *         modify_mode=set_hp_floor, modify_value=1,
 *         consume_self=true
 *
 * RAW "you may choose" → auto-fire today (Mercy parity). Player-choice
 * gate on modify_damage_taken is a Phase F engine extension; when it
 * lands, this row already carries passive_mode="ask" for forward-compat.
 *
 * Touches: BD-tree master Unbreakable + matching actor copies (template +
 * name + master-folder-in-BD-tree).
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-04-guardian-unbreakable-author";
export const description =
  "Author Unbreakable per FU Core: once-per-scene HP-floor=1 clamp on fatal " +
  "damage. conflict_start Force row arms the 'Unbreakable Ready' AE; AE " +
  "carries the modify_damage_taken / set_hp_floor=1 / consume_self chain.";

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

const PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  cost:                   "",
  isCheck:                false,
  isReaction:             true,
  isHeroic:               true,
  on_activate_effect_ref: "",
  max_level:              "1",
};

// reaction_source intentionally empty (NOT "self") on the lifecycle
// trigger. buildStandalonePayload sets payload.sourceActorUuid to null
// for conflict_start; with wantSource="self" the matcher's
// subjectMatchesSource(null, reactor.uuid) returns false and the row is
// silently filtered out. Match the Protect/Rampart pattern.
const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger:      "conflict_start",
    reaction_source:       "",
    reaction_isPassive:    true,
    reaction_passive_mode: "force",
    condition_formula:     "",
    reaction_effect_ref:   "unbreakable_arm",
  },
};

const EFFECT_TABLE = {
  "0": {
    effect_label:      "unbreakable_arm",
    effect_kind:       "apply_ae",
    ae_template_ref:   "Unbreakable Ready",
    target_ref:        "self",
    ae_duplicate_mode: "replace",
  },
};

// ── EMBEDDED AE ────────────────────────────────────────────────────────────

// Charge-carrier AE description per [[ae-description-brevity]] — surfaces
// the cadence, not the implementation. consume_self handles the
// once-per-scene gate; no chargeKey needed.
const READY_AE_DESCRIPTION =
  "<p><em>Unbreakable:</em> Once per scene. Survive a fatal hit at 1 HP.</p>";

// AE-borne reaction. resolveDamageReactions in skill-effects.js walks
// target.effects looking for this exact shape:
//   reactionConfig.reaction_config_table → trigger=creature_takes_damage
//                                          + damage_outcome filter
//   reactionConfig.effect_table          → effect_kind=modify_damage_taken
const AE_REACTION_CONFIG = {
  name: "Unbreakable",
  reaction_config_table: {
    "0": {
      reaction_trigger:        "creature_takes_damage",
      reaction_source:         "self",
      reaction_damage_outcome: "would_reduce_to_zero",
      reaction_isPassive:      true,
      // Authored as "ask" so when Phase F adds player-choice gating to
      // modify_damage_taken, the row is already in the right mode. Today
      // resolveDamageReactions doesn't read passive_mode for AE-borne
      // damage clamps — it auto-fires.
      reaction_passive_mode:   "ask",
      reaction_effect_ref:     "unbreakable_clamp",
    },
  },
  effect_table: {
    "0": {
      effect_label: "unbreakable_clamp",
      effect_kind:  "modify_damage_taken",
      modify_mode:  "set_hp_floor",
      modify_value: 1,
      consume_self: true,
    },
  },
};

function makeReadyAeTemplate(iconUrl) {
  return {
    name: "Unbreakable Ready",
    icon: iconUrl ?? null,
    description: READY_AE_DESCRIPTION,
    transfer: false,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: ["fud-unbreakable-ready"],
    changes: [],
    flags: {
      [MODULE_ID]: {
        category:          "buff",
        // Per-conflict scope: clear on scene-end sweep so a scene swap
        // doesn't carry a stale Ready AE into an unrelated scene. The
        // next conflict's conflict_start row re-arms it via the apply_ae
        // Force chain. (Set to true earlier as belt-suspenders; user
        // requested the cleaner semantics 2026-06-04.)
        crossScene:        false,
        // Skip the per-turn AE ticker — the AE has no duration and is
        // consumed by the modify_damage_taken row's consume_self.
        directorPermanent: true,
        reactionConfig:    AE_REACTION_CONFIG,
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
    log(`  ${ownerLabel} Unbreakable: AE template "${name}" created`);
    return true;
  }
  const wantChanges  = want.changes;
  const wantStatuses = want.statuses;
  const wantFlags    = want.flags;
  const wantDesc     = want.description;
  const needs =
    !deepEqual(existing.changes ?? [], wantChanges)
    || !deepEqual(Array.from(existing.statuses ?? []), wantStatuses)
    || !deepEqual(existing.flags?.[MODULE_ID] ?? {}, wantFlags[MODULE_ID])
    || (want.icon && existing.icon !== want.icon)
    || (wantDesc && existing.description !== wantDesc);
  if (!needs) return false;
  await existing.update({
    transfer:    want.transfer,
    duration:    want.duration,
    changes:     wantChanges,
    statuses:    wantStatuses,
    flags:       wantFlags,
    system:      want.system,
    ...(want.icon ? { icon: want.icon } : {}),
    ...(wantDesc ? { description: wantDesc } : {}),
  });
  log(`  ${ownerLabel} Unbreakable: AE template "${name}" normalised`);
  return true;
}

// Names of pre-canon scaffold AEs that should be removed in favor of the
// canonical "Unbreakable Ready" written by step 4. The previous
// hand-authored scaffold was just named "Unbreakable" with
// transfer:true — both wrong (canonical name is "Unbreakable Ready"
// per [[ae-naming-uses-skill-name]] for Ready variants, and the AE
// must be transfer:false per [[ae-template-no-transfer]] because it's
// charge-carrier applied by the conflict_start row, not bearer-resident).
const STALE_AE_NAMES = ["Unbreakable"];

async function deleteStaleAes(item, log, ownerLabel) {
  let removed = 0;
  for (const ae of (item.effects?.contents ?? [])) {
    if (!STALE_AE_NAMES.includes(ae.name)) continue;
    try {
      await ae.delete();
      log(`  ${ownerLabel} Unbreakable: removed stale AE "${ae.name}" (replaced by "Unbreakable Ready")`);
      removed += 1;
    } catch (e) {
      log(`  ${ownerLabel} Unbreakable: failed to delete stale AE "${ae.name}": ${e?.message ?? e}`);
    }
  }
  return removed > 0;
}

async function patchUnbreakableItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Unbreakable: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. reaction_config_table — wholesale replace.
  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": REACTION_CONFIG_TABLE });
    log(`  ${ownerLabel} Unbreakable: reaction_config_table written`);
    touched = true;
  }

  // 3. effect_table — wholesale replace.
  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": EFFECT_TABLE });
    log(`  ${ownerLabel} Unbreakable: effect_table written`);
    touched = true;
  }

  // 4a. Remove stale-name scaffold AEs (e.g. previous "Unbreakable" AE
  //     with transfer:true — replaced by canonical "Unbreakable Ready"
  //     with transfer:false).
  if (await deleteStaleAes(item, log, ownerLabel)) touched = true;

  // 4b. Embedded AE template — canonical name.
  if (await ensureAeTemplate(item, "Unbreakable Ready", makeReadyAeTemplate, log, ownerLabel)) touched = true;

  // 5. Sync the CSB template version stamp so the sheet renders against
  //    the current template body. See [[csb-template-version-sync]].
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Unbreakable: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }

  // 6. Force CSB template reload — stamp sync alone doesn't rebuild
  //    the sheet's cached field schema. See [[csb-template-version-sync]].
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Unbreakable: CSB templateSystem.reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Unbreakable: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }

  return touched;
}

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Unbreakable") continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchUnbreakableItem(item, log, "master")) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Unbreakable") continue;
      if (!templateMatches(item)) continue;
      if (await patchUnbreakableItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Unbreakable authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
