/**
 * Migration: 2026-06-03-guardian-b1-raw-fix
 * ---------------------------------------------------------------------------
 * Fix for two RAW-drift bugs in the same-day `2026-06-03-guardian-b1-author`
 * migration:
 *
 *   1. Bodyguard was authored as a standalone Active skill applying 50%
 *      damage reduction. CORE RAW p.197 (and skills.json) say:
 *
 *        "If you perform the Guard action and choose to provide cover to
 *         another creature, that creature gains Resistance to all damage
 *         types until the start of your next turn."
 *
 *      So it's a PASSIVE reaction hooking the Guard action's cover-ally
 *      option. Strip the wrong shape; author the reaction-config row
 *      pointing at the new `creature_guards` trigger (gated on
 *      `DID_COVER_ALLY == 1`) and a new AE template granting RS to all
 *      nine elemental affinities via the new `aeAffinityFloor("RS")`
 *      gate helper (preserves the ally's pre-existing IM/AB).
 *
 *   2. Fortress's `max_level` prop should be 4 per the latest playtest
 *      (Jan 23, 2025: "Skill's maximum Skill Level is now 4"). The HP
 *      formula `${level * 5}$` is already correct per the same playtest
 *      and stays put.
 *
 * Scope: BD-tree masters (Battle Director / Guardian / Skill) + actor
 * copies matched by name + template id (legacy `Class Skill / Guardian /
 * *` masters are NOT touched).
 *
 * Stale Bodyguard AEs on actors from the prior author run (e.g. an AE
 * applied to Test Target Ally during harness verification) are NOT
 * swept by this migration — director-tick will retire them within the
 * default 3-turn window. Future Bodyguard fires use `replace_per_caster`
 * so they overwrite cleanly.
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-guardian-b1-raw-fix";
export const description =
  "Re-author Bodyguard as a passive `creature_guards` reaction granting " +
  "RS-to-all-affinities to the covered ally (via aeAffinityFloor); fix " +
  "Fortress max_level 5→4 per Jan 2025 playtest.";

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

// ── BODYGUARD ───────────────────────────────────────────────────────────────

const BODYGUARD_PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  skill_range:            "Melee",
  cost:                   "",
  isCheck:                false,
  isReaction:             true,
  on_activate_effect_ref: "",
  max_level:              "1",
};

const BODYGUARD_REACTION_TABLE = {
  "0": {
    reaction_trigger:     "creature_guards",
    reaction_source:      "self",
    reaction_isPassive:   true,
    // "on" — auto-fires when the gate passes, surfaces the AE icon on
    // the covered ally so the player sees the RS landed (per
    // force-mode-canonical-rows: data-driven trigger + player-meaningful
    // effect → stay On, not Force).
    reaction_passive_mode: "on",
    condition_formula:    "DID_COVER_ALLY == 1",
    reaction_effect_ref:  "bodyguard_apply",
  },
};

const BODYGUARD_EFFECT_TABLE = {
  "0": {
    effect_label:      "bodyguard_apply",
    effect_kind:       "apply_ae",
    ae_template_ref:   "Bodyguard",
    target_ref:        "action_targets",
    ae_duplicate_mode: "replace_per_caster",
  },
};

// Embedded AE template: writes "RS" to all 9 elemental affinities via
// the `aeAffinityFloor` single-arg gate helper, which preserves the
// covered ally's current value if it's already IM or AB. Mode 5 =
// OVERRIDE — the gate computes the final value; CSB writes it as-is.
//
// Director default duration (3 turns / start-of-applier ticking). RAW
// expires "at the start of your next turn" (the guarder's). The 3-turn
// default overshoots slightly; tying Bodyguard's AE to the Covered AE's
// lifecycle (dCombat.activeGuards) is a future polish.
function makeAffinityFloorChange(affinityKey) {
  return {
    key:      affinityKey,
    value:    'aeAffinityFloor("RS")',
    mode:     5,
    priority: 20,
  };
}

// One-sentence AE description — rendered in the small token-hover tooltip.
// Just source + key effect; IM/AB preservation and expiry detail belong in
// the skill description, not the AE chip.
const BODYGUARD_AE_DESCRIPTION =
  "<p><em>Bodyguard:</em> Resistance to all damage.</p>";

const BODYGUARD_AE_TEMPLATE = {
  name: "Bodyguard",
  description: BODYGUARD_AE_DESCRIPTION,
  transfer: false,
  disabled: false,
  duration: {
    startTime:  null,
    seconds:    null,
    rounds:     null,
    turns:      null,
    startRound: null,
    startTurn:  null,
    type:       "none",
    duration:   null,
  },
  statuses: ["fud-bodyguard"],
  changes: [
    makeAffinityFloorChange("affinity_1"),  // physical
    makeAffinityFloorChange("affinity_2"),  // air
    makeAffinityFloorChange("affinity_3"),  // bolt
    makeAffinityFloorChange("affinity_4"),  // dark
    makeAffinityFloorChange("affinity_5"),  // earth
    makeAffinityFloorChange("affinity_6"),  // fire
    makeAffinityFloorChange("affinity_7"),  // ice
    makeAffinityFloorChange("affinity_8"),  // light
    makeAffinityFloorChange("affinity_9"),  // poison
  ],
  flags: {
    [MODULE_ID]: {
      category: "buff",
      crossScene: false,
      directorPermanent: false,
    },
  },
  system: { tags: ["buff"] },
};

async function patchBodyguardItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props — set to Passive shape; drop any leftover Active
  //    activation hook from the prior author run.
  const propUpdates = {};
  for (const [k, v] of Object.entries(BODYGUARD_PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Bodyguard: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. reaction_config_table — wholesale replace.
  const currentRct = p.reaction_config_table ?? {};
  if (!deepEqual(currentRct, BODYGUARD_REACTION_TABLE)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": BODYGUARD_REACTION_TABLE });
    log(`  ${ownerLabel} Bodyguard: reaction_config_table written`);
    touched = true;
  }

  // 3. effect_table — wholesale replace.
  const currentEt = p.effect_table ?? {};
  if (!deepEqual(currentEt, BODYGUARD_EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": BODYGUARD_EFFECT_TABLE });
    log(`  ${ownerLabel} Bodyguard: effect_table written`);
    touched = true;
  }

  // 4. Embedded AE template — exactly one named "Bodyguard" with the
  //    new 9-affinity-floor shape. Drop the prior author run's
  //    damage_receiving_percentage_all change before creating fresh.
  const existing = item.effects?.contents?.find((e) => e.name === "Bodyguard");
  const wantChanges = BODYGUARD_AE_TEMPLATE.changes;
  const wantDesc    = BODYGUARD_AE_TEMPLATE.description;
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [BODYGUARD_AE_TEMPLATE]);
    log(`  ${ownerLabel} Bodyguard: AE template created (9 affinity rows)`);
    touched = true;
  } else if (
    !deepEqual(existing.changes ?? [], wantChanges)
    || existing.description !== wantDesc
  ) {
    await existing.update({
      transfer:    BODYGUARD_AE_TEMPLATE.transfer,
      duration:    BODYGUARD_AE_TEMPLATE.duration,
      changes:     wantChanges,
      statuses:    BODYGUARD_AE_TEMPLATE.statuses,
      system:      BODYGUARD_AE_TEMPLATE.system,
      flags:       BODYGUARD_AE_TEMPLATE.flags,
      description: wantDesc,
    });
    log(`  ${ownerLabel} Bodyguard: AE template normalised (changes + description)`);
    touched = true;
  }

  return touched;
}

// ── FORTRESS (max_level fix) ────────────────────────────────────────────────

async function patchFortressItem(item, log, ownerLabel) {
  const p = item.system?.props ?? {};
  // CSB stores max_level as a string in some templates and a number in
  // others. Normalise to "4" (string) for parity with what CreateSkillFromSpec
  // writes; compare loosely so the migration doesn't churn on type drift.
  if (String(p.max_level ?? "") === "4") return false;
  await item.update({ "system.props.max_level": "4" });
  log(`  ${ownerLabel} Fortress: max_level → 4 (was "${p.max_level ?? ""}")`);
  return true;
}

// ── DRIVER ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  "Bodyguard": patchBodyguardItem,
  "Fortress":  patchFortressItem,
};

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  for (const item of game.items?.contents ?? []) {
    if (!HANDLERS[item.name]) continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    const touched = await HANDLERS[item.name](item, log, "master");
    if (touched) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (!HANDLERS[item.name]) continue;
      if (!templateMatches(item)) continue;
      const touched = await HANDLERS[item.name](item, log, `actor "${actor.name}"`);
      if (touched) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Guardian B.1 RAW fix: ${masters} master patch(es), ${copies} actor copy patch(es)`,
  };
}
