/**
 * Migration: 2026-06-03-guardian-b1-author
 * ---------------------------------------------------------------------------
 * Phase B.1 wiring for three Guardian (Core) skills sitting in the BD tree
 * as scaffolded stubs:
 *
 *   - Bodyguard         — Active. apply_ae chain landing a "Bodyguard" AE on
 *                          one ally within Melee range that grants 50%
 *                          incoming damage reduction (Resistance-like).
 *   - Defensive Mastery — Passive. Already had an `aeEquippedWhen` AE; this
 *                          brings it to the canonical Dodge pattern
 *                          (statuses, tags, priority 20). Mechanic preserved.
 *   - Fortress          — Passive. Already had `max_hp += level*5`; same
 *                          canonical-pattern hygiene applied. Mechanic
 *                          preserved.
 *
 * Why a single migration: same author session, parallel structure, and one
 * audit log line for the Guardian B.1 batch.
 *
 * Scope discipline: only patches BD-tree masters (folder `Battle Director /
 * Guardian / Skill`) and actor copies whose `system.template` matches the
 * BD-tree skill template AND whose name matches. The legacy
 * `Class Skill / Guardian / *` masters are explicitly left alone — they
 * share the template id but live outside the BD root.
 *
 * IDEMPOTENT: each patch step deep-equals against a desired shape before
 * writing.
 */

export const key = "2026-06-03-guardian-b1-author";
export const description =
  "Phase B.1 author for Guardian: full Bodyguard wiring (apply_ae 50% " +
  "damage reduction to one ally) + Defensive Mastery / Fortress hygiene " +
  "(statuses, tags, priority).";

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
  skill_type:               "Active",
  skill_target:             "One Ally",
  skill_range:              "Melee",
  cost:                     "",
  isCheck:                  false,
  on_activate_effect_ref:   "bodyguard_apply",
};

const BODYGUARD_EFFECT_TABLE = {
  "0": {
    effect_label:       "bodyguard_apply",
    effect_kind:        "apply_ae",
    ae_template_ref:    "Bodyguard",
    target_ref:         "action_targets",
    ae_duplicate_mode:  "replace_per_caster",
  },
};

// Embedded AE template for Bodyguard. `transfer: false` — this is a template
// the apply_ae handler clones onto the target (see [[ae-template-no-transfer]]).
// Director default duration (3 turns / start-of-applier ticking) per
// [[ae-default-3-turn-duration]] — no per-skill override.
// One-sentence AE descriptions — rendered in the small token-hover
// tooltip per the user's "keep it short" convention. Source + key effect,
// no extra mechanic detail. The first-pass Bodyguard AE in this migration
// has the 50% reduction shape which raw-fix later replaces; the
// description here is overridden by raw-fix's canonical version.
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
    // 50% incoming-damage reduction across the board. mode 2 (ADD) so this
    // stacks with any other percent-reduction the ally already carries.
    // Engine column is `damage_receiving_percentage_all` — value is
    // interpreted as "reduce by X%" (apply-damage-core.js multiplies by
    // 1 − X/100). See [[csb-ae-bare-key]] for the bare-key convention.
    { key: "damage_receiving_percentage_all", value: "50", mode: 2, priority: 20 },
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

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(BODYGUARD_PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Bodyguard: props normalised (${Object.keys(propUpdates).join(", ")})`);
    touched = true;
  }

  // 2. effect_table. Replace wholesale to drop any stale rows.
  const currentEt = p.effect_table ?? {};
  if (!deepEqual(currentEt, BODYGUARD_EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": BODYGUARD_EFFECT_TABLE });
    log(`  ${ownerLabel} Bodyguard: effect_table written`);
    touched = true;
  }

  // 3. Embedded AE template — exactly one named "Bodyguard" with the desired
  //    shape. Self-heal: drop any stray older Bodyguard AE first.
  const existing = item.effects?.contents?.find((e) => e.name === "Bodyguard");
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [BODYGUARD_AE_TEMPLATE]);
    log(`  ${ownerLabel} Bodyguard: AE template created`);
    touched = true;
  } else {
    const needs =
      existing.transfer !== false
      || !deepEqual(existing.changes ?? [], BODYGUARD_AE_TEMPLATE.changes)
      || !deepEqual(Array.from(existing.statuses ?? []), BODYGUARD_AE_TEMPLATE.statuses)
      || !deepEqual(existing.system?.tags ?? null, BODYGUARD_AE_TEMPLATE.system.tags);
    if (needs) {
      await existing.update({
        transfer: BODYGUARD_AE_TEMPLATE.transfer,
        duration: BODYGUARD_AE_TEMPLATE.duration,
        changes:  BODYGUARD_AE_TEMPLATE.changes,
        statuses: BODYGUARD_AE_TEMPLATE.statuses,
        system:   BODYGUARD_AE_TEMPLATE.system,
        flags:    BODYGUARD_AE_TEMPLATE.flags,
      });
      log(`  ${ownerLabel} Bodyguard: AE template normalised`);
      touched = true;
    }
  }

  return touched;
}

// ── DEFENSIVE MASTERY (hygiene) ─────────────────────────────────────────────

// Existing AE already encodes the mechanic
// (damage_receiving_mod_all += SL when shield or martial armor equipped).
// Hygiene-only patch: add statuses + system.tags + priority 20.
const DEFENSIVE_MASTERY_AE_DESCRIPTION =
  "<p><em>Defensive Mastery:</em> −SL damage while a shield or martial armor is equipped.</p>";

const DEFENSIVE_MASTERY_AE_PATCH = {
  description: DEFENSIVE_MASTERY_AE_DESCRIPTION,
  changes: [
    {
      key:      "damage_receiving_mod_all",
      value:    'aeEquippedWhen("shield,martial_armor", "${level}$")',
      mode:     2,
      priority: 20,
    },
  ],
  statuses: ["fud-defensive-mastery"],
  system: { tags: ["buff"] },
  flags: {
    [MODULE_ID]: {
      directorPermanent: false,
      crossScene: false,
    },
  },
};

async function patchDefensiveMasteryItem(item, log, ownerLabel) {
  const existing = item.effects?.contents?.find((e) => e.name === "Defensive Mastery");
  if (!existing) {
    log(`  ${ownerLabel} Defensive Mastery: no AE present — skipping (stub state unexpected)`);
    return false;
  }
  const wantChanges  = DEFENSIVE_MASTERY_AE_PATCH.changes;
  const wantStatuses = DEFENSIVE_MASTERY_AE_PATCH.statuses;
  const wantTags     = DEFENSIVE_MASTERY_AE_PATCH.system.tags;
  const wantDesc     = DEFENSIVE_MASTERY_AE_PATCH.description;
  const needs =
    !deepEqual(existing.changes ?? [], wantChanges)
    || !deepEqual(Array.from(existing.statuses ?? []), wantStatuses)
    || !deepEqual(existing.system?.tags ?? null, wantTags)
    || existing.description !== wantDesc;
  if (!needs) return false;
  await existing.update({
    transfer:    true,
    changes:     wantChanges,
    statuses:    wantStatuses,
    system:      DEFENSIVE_MASTERY_AE_PATCH.system,
    flags:       DEFENSIVE_MASTERY_AE_PATCH.flags,
    description: wantDesc,
  });
  log(`  ${ownerLabel} Defensive Mastery: AE hygiene applied`);
  return true;
}

// ── FORTRESS (hygiene) ──────────────────────────────────────────────────────

// Existing AE already encodes the mechanic (max_hp += level*5). Hygiene-only.
const FORTRESS_AE_DESCRIPTION =
  "<p><em>Fortress:</em> Max HP +5×SL.</p>";

const FORTRESS_AE_PATCH = {
  description: FORTRESS_AE_DESCRIPTION,
  changes: [
    {
      key:      "max_hp",
      value:    "${level * 5}$",
      mode:     2,
      priority: 20,
    },
  ],
  statuses: ["fud-fortress"],
  system: { tags: ["buff"] },
  flags: {
    [MODULE_ID]: {
      directorPermanent: false,
      crossScene: false,
    },
  },
};

async function patchFortressItem(item, log, ownerLabel) {
  const existing = item.effects?.contents?.find((e) => e.name === "Fortress");
  if (!existing) {
    log(`  ${ownerLabel} Fortress: no AE present — skipping (stub state unexpected)`);
    return false;
  }
  const wantChanges  = FORTRESS_AE_PATCH.changes;
  const wantStatuses = FORTRESS_AE_PATCH.statuses;
  const wantTags     = FORTRESS_AE_PATCH.system.tags;
  const wantDesc     = FORTRESS_AE_PATCH.description;
  const needs =
    !deepEqual(existing.changes ?? [], wantChanges)
    || !deepEqual(Array.from(existing.statuses ?? []), wantStatuses)
    || !deepEqual(existing.system?.tags ?? null, wantTags)
    || existing.description !== wantDesc;
  if (!needs) return false;
  await existing.update({
    transfer:    true,
    changes:     wantChanges,
    statuses:    wantStatuses,
    system:      FORTRESS_AE_PATCH.system,
    flags:       FORTRESS_AE_PATCH.flags,
    description: wantDesc,
  });
  log(`  ${ownerLabel} Fortress: AE hygiene applied`);
  return true;
}

// ── DRIVER ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  "Bodyguard":         patchBodyguardItem,
  "Defensive Mastery": patchDefensiveMasteryItem,
  "Fortress":          patchFortressItem,
};

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  // 1. BD-tree masters.
  for (const item of game.items?.contents ?? []) {
    if (!HANDLERS[item.name]) continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    const touched = await HANDLERS[item.name](item, log, "master");
    if (touched) masters += 1;
  }

  // 2. Actor copies (matched by name + template; legacy copies share the
  //    template id so this WILL also touch them — that's intentional, the
  //    BD shape is the canonical one going forward).
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
    summary: `Guardian B.1 wired: ${masters} master patch(es), ${copies} actor copy patch(es)`,
  };
}
