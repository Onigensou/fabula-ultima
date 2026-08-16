/**
 * Migration: 2026-06-04-guardian-quaking-titan-author
 * ---------------------------------------------------------------------------
 * Author Quaking Titan (Feb 8 / May 4 2026 playtest — Hybrid Heroic Skill /
 * Guardian or Pilot) per the May 4 2026 RAW:
 *
 *   Requirements: Guardian and/or Pilot.
 *   "As long as your personal vehicle has a steed frame, it may have up to
 *    2 active weapon modules (instead of 1).
 *
 *    During a conflict, if you have a martial armor or martial armor module
 *    equipped, you may use an action and spend 30 Mind Points to choose
 *    earth or physical. If you do, you deal 20 damage of the chosen type
 *    to every enemy you can see, and enemies that lose Hit Points this way
 *    cannot perform free attacks until the start of their next turn.
 *    This effect deals 10 extra damage if you are driving a personal
 *    vehicle with a mech frame and/or have two shields equipped, and also
 *    deals 10 extra damage if you are level 30 or higher."
 *
 * BD-native v1 — ships:
 *   - Active skill, 30 MP cost, martial-armor gate, fixed 20 physical damage
 *     to every visible enemy
 *   - Bonus damage formula: +10 when EQUIPPED_SHIELD_COUNT >= 2 (the new
 *     formula identifier from Dual Shieldbearer work); +10 when
 *     CHAR_LEVEL >= 30. Encoded as `20 + (gate)*10` per the skill-formulas
 *     grammar (no ternary; comparisons return 1/0; multiplied for the
 *     conditional bonus).
 *   - Apply "No Free Attack" AE to each visible enemy via apply_ae, mode
 *     "replace_per_caster". The AE carries the fud-no-free-attack status
 *     icon + a flag readable by the engine's free-action gate (see
 *     deferred work below). Lifetime: round-end sweep (close
 *     approximation for "until start of their next turn"; engine
 *     extension for per-subject-turn expiry deferred).
 *
 * Deferred for follow-up:
 *   - Element picker (earth/physical) — open_action_menu hook exists for
 *     skills (Reinforce/Cleanse) but the active-skill element-override
 *     plumbing isn't yet wired. v1 ships physical only; description
 *     notes the RAW choice.
 *   - Vehicle / mech-frame clause — no vehicle system in BD; out of
 *     scope until that subsystem lands.
 *   - "No Free Attack" ENFORCEMENT — AE applies + token icon shows, but
 *     the actual gating of free-action grants based on this flag needs a
 *     small extension to freeActions.set/get. Migration ships the AE as
 *     a marker; the gate read lands in a separate engine commit.
 *   - "Until start of their next turn" precision — AE expires at
 *     round_end (existing infrastructure). Per-target turn-start expiry
 *     would need a new lifetimeMode; close approximation suffices for v1.
 *
 * IDEMPOTENT.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-04-guardian-quaking-titan-author";
export const description =
  "Author Quaking Titan v1 per May 4 2026 playtest: Active, 30 MP, " +
  "martial-armor gate, 20 + 10*(2 shields) + 10*(level >= 30) physical " +
  "damage to all visible enemies, applies No Free Attack AE (marker, " +
  "enforcement deferred).";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const HYBRID_HEROIC_FOLDER = "Hybrid Heroic Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const QT_DEFAULT_ICON =
  "icons/skills/melee/strike-hammer-fire-orange.webp";

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

// Self-healing: ensure Battle Director / Hybrid Heroic Skill exists, creating
// it (and the root) on demand. See `_folder-tree.js`.
async function ensureHybridHeroicFolder(game, log) {
  const { folder } = await ensureFolderPath(
    game, [BD_ROOT_NAME, HYBRID_HEROIC_FOLDER], { log });
  return folder ?? null;
}

// ── DATA ────────────────────────────────────────────────────────────────────

const QT_DESCRIPTION =
  "<p>As long as your personal vehicle has a steed frame, it may have up to " +
  "2 active weapon modules (instead of 1).</p>" +
  "<p>During a conflict, if you have a <strong>martial armor</strong> or " +
  "<strong>martial armor module</strong> equipped, you may use an action " +
  "and spend <strong>30 Mind Points</strong> to choose earth or physical. " +
  "If you do, you deal <strong>20 damage</strong> of the chosen type to every " +
  "enemy you can see, and enemies that lose Hit Points this way cannot perform " +
  "<strong>free attacks</strong> until the start of their next turn.</p>" +
  "<p>This effect deals <strong>+10 damage</strong> if you are driving a " +
  "personal vehicle with a mech frame and/or have <strong>two shields equipped</strong>, " +
  "and also deals <strong>+10 damage</strong> if you are <strong>level 30 or higher</strong>.</p>";

const PROP_PATCH = {
  skill_type:             "Active",
  skill_target:           "Each enemy you can see",
  skill_range:            "Scene",
  cost:                   "30 MP",
  isCheck:                false,
  isReaction:             false,
  isHeroic:               true,
  isOffensiveSpell:       false,
  // Bonus-rider formula uses (gate)*amount because the skill-formulas
  // evaluator has no ternary. Comparisons return 1/0, multiplied by 10
  // for the bonus, summed with the base 20.
  damage_bonus:           "20 + (EQUIPPED_SHIELD_COUNT >= 2) * 10 + (CHAR_LEVEL >= 30) * 10",
  // RAW: "spend 30 Mind Points to choose earth or physical". VAR_ELEMENT is the
  // sentinel resolved from the element the player picks; it ONLY resolves from a
  // prompt captured by the PRE_ACTIVATE hook (state-handlers.js:4104 reads just
  // fire_points.pre_activate_effect_ref, and action-profile.js:181-190 falls back
  // to the literal otherwise). Same shape as Elemental Shard / Detonate Phantasm.
  type_damage:            "VAR_ELEMENT",
  pre_activate_effect_ref: "qt_gate",
  // Gate the activation on martial armor presence per RAW. condition_formula
  // on on_activate_effect_ref's chain enforces this.
  on_activate_effect_ref: "qt_activate",
  max_level:              "1",
  description:            QT_DESCRIPTION,
  heroic_requirement:     "You must have mastered one or more Classes among Guardian and Pilot.",
};

const REACTION_CONFIG_TABLE = {};

const EFFECT_TABLE = {
  "0": {
    effect_label:      "qt_activate",
    effect_kind:       "chain",
    chain_steps:       "qt_apply_status",
    condition_formula: "HAS_MARTIAL_ARMOR == 1",
  },
  "1": {
    // RAW's "choose earth or physical". This was an EMPTY chain row until
    // 2026-08-16 — authored, chained, and doing nothing, so the skill always
    // dealt its default type. It fires from pre_activate (NOT from the
    // qt_activate chain) because that is the only hook whose picks reach
    // ctx.chainVars in time for the damage type to resolve.
    effect_label:      "qt_gate",
    effect_kind:       "prompt_element",
    prompt_var:        "element",
    element_options:   "earth|physical",
    menu_title:        "Quaking Titan — choose a damage type",
  },
  "2": {
    effect_label:      "qt_apply_status",
    effect_kind:       "apply_ae",
    ae_template_ref:   "No Free Attack",
    target_ref:        "qt_visible_enemies",
    ae_duplicate_mode: "replace_per_caster",
  },
  "3": {
    effect_label:              "qt_visible_enemies",
    effect_kind:               "targeting",
    candidate_source:          "combat",
    category:                  "enemy",
    mode:                      "all",
    count:                     1,
    exclude_self:              true,
    auto_confirm_when_obvious: true,
    skip_when_passive:         false,
    iteration_mode:            "together",
  },
};

// ── EMBEDDED AE ────────────────────────────────────────────────────────────

const NO_FREE_ATTACK_AE_DESCRIPTION =
  "<p><em>Quaking Titan:</em> Cannot perform free attacks until start of next turn.</p>";

function makeNoFreeAttackAeTemplate(iconUrl) {
  return {
    name: "No Free Attack",
    icon: iconUrl ?? null,
    description: NO_FREE_ATTACK_AE_DESCRIPTION,
    transfer: false,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: ["fud-no-free-attack"],
    changes: [],
    flags: {
      [MODULE_ID]: {
        category: "debuff",
        // Marker flag — engine gate that REFUSES to register/respect
        // free-action grants on actors carrying this AE lands in a
        // follow-up commit. For v1 the AE applies + the icon surfaces
        // so the GM sees who's affected; mechanical enforcement is
        // a quick freeActions.js extension.
        preventFreeAttack: true,
        // Round-end expiry — closest existing primitive to "until start
        // of subject's next turn". Per-subject turn-start expiry would
        // need a new lifetimeMode; deferred.
        lifetimeMode: "round_end",
      },
    },
    system: { tags: ["debuff"] },
  };
}

// ── PATCH FUNCTIONS ────────────────────────────────────────────────────────

async function ensureAeTemplate(item, name, makeFn, log, ownerLabel) {
  const want = makeFn(item.img);
  const existing = item.effects?.contents?.find((e) => e.name === name);
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want]);
    log(`  ${ownerLabel} Quaking Titan: AE template "${name}" created`);
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
  log(`  ${ownerLabel} Quaking Titan: AE template "${name}" normalised`);
  return true;
}

async function patchQuakingTitanItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Quaking Titan: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. reaction_config_table — wholesale replace.
  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": REACTION_CONFIG_TABLE });
    log(`  ${ownerLabel} Quaking Titan: reaction_config_table cleared`);
    touched = true;
  }

  // 3. effect_table — wholesale replace.
  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": EFFECT_TABLE });
    log(`  ${ownerLabel} Quaking Titan: effect_table written`);
    touched = true;
  }

  // 4. Embedded AE template.
  if (await ensureAeTemplate(item, "No Free Attack", makeNoFreeAttackAeTemplate, log, ownerLabel)) touched = true;

  // 5. Sync CSB template version stamp.
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Quaking Titan: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }

  // 6. Force CSB template reload — the stamp set above tells the system
  //    "this item is up to date" but the sheet's cached field schema for
  //    THIS item isn't rebuilt until `templateSystem.reloadTemplate()` is
  //    called (the same backend call the user-facing "Refresh from
  //    Template" context menu fires). Without it, newly-added template
  //    fields (skill_target, isHeroic, on_activate_effect_ref, etc.) stay
  //    hidden on the sheet until manual refresh. See
  //    [[csb-template-version-sync]] — this step is the canonical
  //    follow-up to the stamp sync.
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Quaking Titan: CSB templateSystem.reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Quaking Titan: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }

  return touched;
}

export async function migrate(game, log) {
  const hybridFolder = await ensureHybridHeroicFolder(game, log);
  if (!hybridFolder) {
    log(`  ERROR: could not ensure "${HYBRID_HEROIC_FOLDER}" folder under "${BD_ROOT_NAME}".`);
    return { applied: false, summary: `Quaking Titan: missing folder "${BD_ROOT_NAME}/${HYBRID_HEROIC_FOLDER}"` };
  }

  let master = game.items?.contents?.find?.((i) =>
    i.name === "Quaking Titan"
    && i.folder?.id === hybridFolder.id
    && templateMatches(i));

  if (!master) {
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    const created = await Item.create({
      name: "Quaking Titan",
      type: "equippableItem",
      img: QT_DEFAULT_ICON,
      folder: hybridFolder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: { skill_type: "Active", isHeroic: true, level: 1, max_level: 1 },
      },
    });
    master = created;
    log(`  Quaking Titan: master created in ${BD_ROOT_NAME}/${HYBRID_HEROIC_FOLDER}` +
        (versionStamp !== undefined ? ` (stamp ${versionStamp})` : " (no template stamp)"));
  }

  let masters = 0;
  let copies = 0;
  if (await patchQuakingTitanItem(master, log, "master")) masters += 1;

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Quaking Titan") continue;
      if (!templateMatches(item)) continue;
      if (await patchQuakingTitanItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Quaking Titan authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
