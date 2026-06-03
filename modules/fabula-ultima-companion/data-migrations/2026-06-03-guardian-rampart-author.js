/**
 * Migration: 2026-06-03-guardian-rampart-author
 * ---------------------------------------------------------------------------
 * Author Rampart (Guardian / Heroic Skill) per the Dec 5, 2024 (carried
 * unchanged in Jan 23, 2025) playtest rewrite:
 *
 *   "Once per conflict scene, at the beginning of a round, if you have a
 *    martial armor or a shield equipped, you may spend 20 Mind Points.
 *    If you do, you and every ally present on the scene have Resistance
 *    to all damage types and cannot suffer status effects until the end
 *    of the round (this does not let you recover from preexisting status
 *    effects)."
 *
 * Authoring shape:
 *
 *   reaction_config_table:
 *     0: conflict_start (Force) → rampart_arm  — apply "Rampart Ready"
 *                                                 charge AE (1/1) to self
 *     1: round_start (Ask)      → rampart_fire — chain
 *
 *   effect_table:
 *     rampart_arm           → apply_ae "Rampart Ready" to self
 *     rampart_fire          → chain (consume_charge + consume_resource +
 *                              apply_ae)
 *     rampart_consume_charge → consume_charge key="rampart" (Ready AE)
 *     rampart_consume_mp    → consume_resource resource="mp" amount=20
 *     rampart_apply_buff    → apply_ae "Rampart" → rampart_target_allies
 *     rampart_target_allies → targeting combat / ally / mode=all
 *
 *   embedded AEs:
 *     "Rampart Ready"  — charge carrier (transfer:false, 1/1 charges,
 *                        chargeKey="rampart", crossScene=true so it
 *                        survives mid-conflict reloads); refilled by
 *                        conflict_start row
 *     "Rampart"        — the buff. transfer:false; statuses ["fud-rampart"];
 *                        9 affinity_floor("RS") + 37 condition_floor("IM")
 *                        changes; lifetimeMode:"round_end" so the global
 *                        round-end sweep removes it. Icon = skill.img.
 *
 *   condition_formula on round_start row:
 *     "HAS_MARTIAL_ARMOR == 1 || HAS_SHIELD == 1"
 *
 * Touches: BD-tree master Rampart + any actor copy (template + name match).
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-guardian-rampart-author";
export const description =
  "Author Rampart per Dec 2024 / Jan 2025 playtest: once-per-conflict round_start " +
  "Ask reaction; 20 MP; equip gate; RS-to-all + status-IM-to-all on self + scene allies " +
  "until round_end (uses new round-end expiry mechanism).";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

// Full set of named statuses on the v3 PC + v.2 NPC templates. Matches
// the field list converted to label-type in
// 2026-06-03-condition-fields-label-type. Each becomes a condition_<name>
// = aeAffinityFloor("IM") change on the Rampart AE template.
const ALL_STATUSES = [
  "slow", "dazed", "weak", "shaken", "poisoned", "enraged",
  "silence", "stagger", "frightened", "paralyzed", "confused", "panic",
  "grappled", "envenomed", "burn", "blind", "zombie", "wither",
  "bleed", "obscure", "fatigue", "charm", "berserk", "despair",
  "doom", "bane", "curse", "wet", "oil", "petrify",
  "hypothermia", "turbulence", "delayed", "isolate", "suppress",
  "disarmed", "anomaly",
];

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
  cost:                   "20 MP",
  isCheck:                false,
  isReaction:             true,
  on_activate_effect_ref: "",
  max_level:              "1",
};

// reaction_source intentionally empty (NOT "self") on lifecycle triggers.
// buildStandalonePayload sets payload.sourceActorUuid to null for
// conflict_start / round_start / etc. (only turn_start/turn_end carry the
// acting actor as the subject). With wantSource="self" the matcher's
// subjectMatchesSource(null, reactor.uuid) returns false and the row is
// silently filtered out before reaching the autoFire loop. Match the
// established Protect pattern (empty source = no filter) — see
// [[reaction-source-empty-on-lifecycle-triggers]].
const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger:      "conflict_start",
    reaction_source:       "",
    reaction_isPassive:    true,
    reaction_passive_mode: "force",
    condition_formula:     "",
    reaction_effect_ref:   "rampart_arm",
  },
  "1": {
    reaction_trigger:      "round_start",
    reaction_source:       "",
    reaction_isPassive:    true,
    reaction_passive_mode: "ask",
    condition_formula:     "HAS_MARTIAL_ARMOR == 1 || HAS_SHIELD == 1",
    reaction_effect_ref:   "rampart_fire",
  },
};

const EFFECT_TABLE = {
  "0": {
    effect_label:      "rampart_arm",
    effect_kind:       "apply_ae",
    ae_template_ref:   "Rampart Ready",
    target_ref:        "self",
    ae_duplicate_mode: "replace",
  },
  "1": {
    effect_label:  "rampart_fire",
    effect_kind:   "chain",
    chain_steps:   "rampart_consume_charge,rampart_consume_mp,rampart_apply_buff",
  },
  "2": {
    effect_label: "rampart_consume_charge",
    effect_kind:  "consume_charge",
    target_ref:   "self",
    charge_key:   "rampart",
    count:        "1",
    on_empty:     "abort",
  },
  "3": {
    effect_label:     "rampart_consume_mp",
    effect_kind:      "consume_resource",
    target_ref:       "self",
    // Field names are `consume_resource` + `consume_amount` — NOT the
    // intuitive `resource` + `amount`. The handler reads
    // `row.consume_resource ?? row.grant_resource` and
    // `row.consume_amount ?? row.grant_amount`; using the wrong field
    // names yields empty resource → unknown-resource → abort:true,
    // silently killing the chain. Cost from RAW: 20 Mind Points.
    consume_resource: "mp",
    consume_amount:   "20",
  },
  "4": {
    effect_label:      "rampart_apply_buff",
    effect_kind:       "apply_ae",
    ae_template_ref:   "Rampart",
    target_ref:        "rampart_target_allies",
    ae_duplicate_mode: "replace_per_caster",
  },
  "5": {
    effect_label:              "rampart_target_allies",
    effect_kind:               "targeting",
    candidate_source:          "combat",
    category:                  "ally",
    mode:                      "all",
    count:                     1,
    exclude_self:              false,
    auto_confirm_when_obvious: true,
    skip_when_passive:         true,
    iteration_mode:            "together",
  },
};

// ── EMBEDDED AE TEMPLATES ──────────────────────────────────────────────────

// One-sentence AE description — rendered in the small token-hover tooltip.
// Charge-carrier "Ready" AEs surface the skill's frequency (Once per
// conflict / round / etc.) rather than the raw "(1/1)" charge count
// per [[ae-description-brevity]] — the count is implementation detail;
// the player wants to know the cadence.
const READY_AE_DESCRIPTION =
  "<p><em>Rampart:</em> Once per conflict. Spend 20 MP at round start to fire.</p>";

function makeReadyAeTemplate(iconUrl) {
  return {
    name: "Rampart Ready",
    icon: iconUrl ?? null,
    description: READY_AE_DESCRIPTION,
    transfer: false,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: ["fud-rampart-ready"],
    changes: [],
    flags: {
      [MODULE_ID]: {
        charges:    1,
        chargesMax: 1,
        chargeKey:  "rampart",
        category:   "buff",
        // Cross-scene so the charge persists if the GM splits a conflict
        // across scene changes (party retreats mid-fight, re-engages on a
        // new scene). Refilled by conflict_start anyway so the
        // crossScene flag is belt + suspenders.
        crossScene: true,
        directorPermanent: true,
      },
    },
    system: { tags: ["buff"] },
  };
}

function makeBuffAeChanges() {
  const changes = [];
  // 9 elemental affinities — RS floor (preserves IM/AB).
  for (let i = 1; i <= 9; i++) {
    changes.push({
      key:      `affinity_${i}`,
      value:    'aeAffinityFloor("RS")',
      mode:     5,
      priority: 20,
    });
  }
  // Status immunity — IM floor on every named condition prop.
  for (const status of ALL_STATUSES) {
    changes.push({
      key:      `condition_${status}`,
      value:    'aeAffinityFloor("IM")',
      mode:     5,
      priority: 20,
    });
  }
  return changes;
}

const BUFF_AE_DESCRIPTION =
  "<p><em>Rampart:</em> Resistance to all damage + status immunity until end of round.</p>";

function makeBuffAeTemplate(iconUrl) {
  return {
    name: "Rampart",
    icon: iconUrl ?? null,
    description: BUFF_AE_DESCRIPTION,
    transfer: false,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: ["fud-rampart"],
    changes: makeBuffAeChanges(),
    flags: {
      [MODULE_ID]: {
        category: "buff",
        crossScene: false,
        directorPermanent: false,
        // Round-end expiry — `tickDirectorAEsAtRoundEnd` sweeps AEs
        // whose `directorAppliedBy.lifetimeMode === "round_end"` at
        // ROUND_END.onEnter. apply_ae forwards this template flag onto
        // the stamped directorAppliedBy.
        lifetimeMode: "round_end",
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
    log(`  ${ownerLabel} Rampart: AE template "${name}" created`);
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
  log(`  ${ownerLabel} Rampart: AE template "${name}" normalised`);
  return true;
}

async function patchRampartItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Rampart: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. reaction_config_table — wholesale replace.
  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": REACTION_CONFIG_TABLE });
    log(`  ${ownerLabel} Rampart: reaction_config_table written`);
    touched = true;
  }

  // 3. effect_table — wholesale replace.
  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": EFFECT_TABLE });
    log(`  ${ownerLabel} Rampart: effect_table written`);
    touched = true;
  }

  // 4. Embedded AE templates — both pass the skill's img as the icon
  //    so the token-icon ring renders the skill image (per
  //    [[ae-needs-statuses-for-token-icon]] + the user's "use skill
  //    icon" convention for buff / charge AEs).
  if (await ensureAeTemplate(item, "Rampart Ready", makeReadyAeTemplate, log, ownerLabel)) touched = true;
  if (await ensureAeTemplate(item, "Rampart",       makeBuffAeTemplate,  log, ownerLabel)) touched = true;

  return touched;
}

export async function migrate(game, log) {
  let masters = 0;
  let copies = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Rampart") continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchRampartItem(item, log, "master")) masters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Rampart") continue;
      if (!templateMatches(item)) continue;
      if (await patchRampartItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Rampart authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
