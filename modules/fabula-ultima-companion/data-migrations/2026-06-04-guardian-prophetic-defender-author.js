/**
 * Migration: 2026-06-04-guardian-prophetic-defender-author
 * ---------------------------------------------------------------------------
 * Author Prophetic Defender (Hybrid Heroic Skill — Entropist or Guardian)
 * per the May 4, 2026 playtest RAW. The "Style" suffix from the old
 * Heroic Style Skills concept was dropped in Feb 2026; the new name is
 * just "Prophetic Defender".
 *
 *   RAW (May 4, 2026):
 *     Requirements: You must have mastered Entropist or Guardian.
 *
 *     Your maximum Hit Points are permanently increased by an amount
 *     equal to your base Insight die size (update your maximum HP if
 *     this size changes).
 *
 *     When a conflict scene begins, if you have learned the Divination
 *     spell, you gain 1 Prophecy Point. You also gain 1 Prophecy Point
 *     at the start of each even-numbered round (regardless of whether
 *     you have learned Divination). You lose all Prophecy Points at the
 *     end of each scene.
 *
 *     When one or more allies are threatened by a single attack, spell,
 *     or other danger, you may spend 1 Prophecy Point to take the place
 *     of all those allies (any Checks that are part of the danger will
 *     be performed against you; you may declare the use of this Skill
 *     before or after the Checks have been made). The danger will
 *     affect you once for each creature it was threatening (including
 *     yourself, if you were among those creatures). Resolve each of
 *     these instances separately.
 *
 * Authoring shape:
 *
 *   Bonus HP — always-on transfer:true AE with a single change:
 *     max_hp += ${ins_base}$
 *   CSB formula reads the bearer's base Insight die size; the change
 *   re-applies on each prepareData, so a die-size upgrade naturally
 *   bumps max HP.
 *
 *   Prophecy Point AE — charge carrier (chargeKey: "prophecy"). One
 *   instance per gain; stack mode lets the bearer accumulate multiple
 *   PPs. Cleared by the scene-end transient sweep (default behavior
 *   for non-crossScene, non-directorPermanent AEs).
 *
 *   reaction_config_table:
 *     0: conflict_start (Force) → pds_gain, gated by HAS_SKILL_DIVINATION
 *     1: round_start (Force) → pds_gain, gated by ROUND % 2 == 0 && ROUND > 0
 *     2: creature_performs_action (Ask) → pds_reaction
 *          source: enemy, intent: harmful, condition: ACTION_TARGET_COUNT >= 1
 *          (May 4 RAW dropped the 2+ threshold; single-ally protection works)
 *
 *   effect_table:
 *     pds_self     — targeting candidate_source: self
 *     pds_threatened — targeting candidate_source: action_targets, mode: all
 *     pds_gain     — apply_ae "Prophecy Point" → pds_self, stack mode
 *     pds_consume  — consume_charge prophecy 1, on_empty: abort
 *     pds_redirect — redirect_target pds_threatened → pds_self
 *     pds_reaction — chain consume + redirect
 *
 * Reads:
 *   - INS_BASE_DIE      (new — skill-formulas.js)
 *   - HAS_SKILL_DIVINATION (existing dynamic identifier)
 *   - ACTION_TARGET_COUNT (existing)
 *   - ROUND             (existing)
 *
 * Multi-target redirect: the redirect_target effect_kind currently
 * supports single-target swap (Protect). Multi-target swap (PDS-style
 * "take the place of all targets") is a card-mutations.js extension
 * tracked in the project memory; the data here is authored against the
 * canonical shape so the engine extension can land without re-authoring.
 *
 * Scope: BD-tree only. The legacy `💥 Skill / Heroic Skill /
 * Prophetic Defender Style` master is left untouched (legacy world
 * reference). Actor copies on `Hina` etc. link to the legacy master via
 * `system.uniqueId = "propheticDefStyle"`; they continue to point at the
 * legacy item and are not migrated by this script. Re-add from the new
 * BD master if BD-native behavior is wanted on a PC.
 *
 * IDEMPOTENT.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-04-guardian-prophetic-defender-author";
export const description =
  "Author Prophetic Defender per May 4 2026 playtest in Battle Director / " +
  "Hybrid Heroic Skill. New BD-tree master replaces the legacy 'Style' " +
  "naming + updates conflict-start gate / round-start timing / single-ally " +
  "threshold per the May 4 RAW.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const HYBRID_HEROIC_FOLDER = "Hybrid Heroic Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

// Reuse the legacy "Prophetic Defender Style" icon for visual continuity
// — the FFXIV Astrologian "Nocturnal Sect" Forge asset. AE icons inherit
// via `item.img`, so both the Bonus HP and Prophecy Point AEs render with
// the same image without needing per-AE icon constants.
const PD_DEFAULT_ICON =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/06_AST/nocturnal_sect.png";

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

const PD_DESCRIPTION =
  "<p>Your maximum Hit Points are permanently increased by an amount equal " +
  "to your base <strong>Insight</strong> die size (update your maximum HP " +
  "if this size changes).</p>" +
  "<p>When a conflict scene begins, if you have learned the <strong>Divination</strong> " +
  "spell, you gain <strong>1 Prophecy Point</strong>. You also gain " +
  "<strong>1 Prophecy Point</strong> at the start of each even-numbered round " +
  "(regardless of whether you have learned Divination). You lose all Prophecy " +
  "Points at the end of each scene.</p>" +
  "<p>When <strong>one or more allies</strong> are threatened by a single " +
  "attack, spell, or other danger, you may spend <strong>1 Prophecy Point</strong> " +
  "to take the place of all those allies (any Checks that are part of the " +
  "danger will be performed against you; you may declare the use of this Skill " +
  "before or after the Checks have been made). The danger will affect you " +
  "once for each creature it was threatening (including yourself, if you " +
  "were among those creatures). Resolve each of these instances separately.</p>";

const PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  skill_range:            "-",
  cost:                   "",
  isCheck:                false,
  isReaction:             true,
  isHeroic:               true,
  on_activate_effect_ref: "",
  max_level:              "1",
  description:            PD_DESCRIPTION,
  heroic_requirement:     "You must have mastered one or more Classes among Entropist and Guardian.",
};

const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger:      "conflict_start",
    reaction_source:       "",
    reaction_isPassive:    true,
    reaction_passive_mode: "force",
    condition_formula:     "HAS_SKILL_DIVINATION == 1",
    reaction_effect_ref:   "pds_gain",
  },
  "1": {
    reaction_trigger:      "round_start",
    reaction_source:       "",
    reaction_isPassive:    true,
    reaction_passive_mode: "force",
    condition_formula:     "ROUND % 2 == 0 && ROUND > 0",
    reaction_effect_ref:   "pds_gain",
  },
  "2": {
    // Same trigger Protect uses, so PD surfaces on the action card via
    // the same third-party reaction pill path (state-handlers.js
    // CONFIRM-stage scan). The scan fires per-target but dedups by
    // (rowKey, carrierUuid, reactorUuid), so for a multi-target enemy
    // action the reactor sees a single pill, not N pills.
    reaction_trigger:        "creature_targeted_by_action",
    reaction_source:         "ally",
    reaction_action_intent:  "harmful",
    reaction_isPassive:      false,
    condition_formula:       "",
    reaction_effect_ref:     "pds_reaction",
  },
};

const EFFECT_TABLE = {
  "0": {
    effect_label:              "pds_self",
    effect_kind:               "targeting",
    candidate_source:          "self",
    mode:                      "exact",
    count:                     "1",
    exclude_self:              false,
    auto_confirm_when_obvious: true,
    skip_when_passive:         true,
    iteration_mode:            "together",
  },
  "1": {
    effect_label:              "pds_threatened",
    effect_kind:               "targeting",
    candidate_source:          "action_targets",
    mode:                      "all",
    exclude_self:              false,
    auto_confirm_when_obvious: true,
    skip_when_passive:         true,
    iteration_mode:            "together",
  },
  "2": {
    effect_label:      "pds_gain",
    effect_kind:       "apply_ae",
    ae_template_ref:   "Prophecy Point",
    target_ref:        "pds_self",
    ae_duplicate_mode: "stack",
  },
  "3": {
    effect_label: "pds_consume",
    effect_kind:  "consume_charge",
    target_ref:   "pds_self",
    charge_key:   "prophecy",
    count:        "1",
    on_empty:     "abort",
  },
  "4": {
    effect_label:     "pds_redirect",
    effect_kind:      "redirect_target",
    target_ref:       "pds_threatened",
    destination_ref:  "pds_self",
    rebuild_card:     true,
  },
  "5": {
    effect_label: "pds_reaction",
    effect_kind:  "chain",
    chain_steps:  "pds_consume,pds_redirect",
  },
};

// ── EMBEDDED AEs ───────────────────────────────────────────────────────────

const PROPHECY_POINT_AE_DESCRIPTION =
  "<p><em>Prophetic Defender:</em> Spend to take the place of allies threatened by a danger.</p>";

function makeProphecyPointAeTemplate(iconUrl) {
  return {
    name: "Prophecy Point",
    icon: iconUrl ?? null,
    description: PROPHECY_POINT_AE_DESCRIPTION,
    transfer: false,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: ["fud-prophecy-point"],
    changes: [],
    flags: {
      [MODULE_ID]: {
        category:   "buff",
        chargeKey:  "prophecy",
        charges:    1,
        chargesMax: 1,
        // Skip the per-turn AE ticker — PP is a resource pool, not a
        // status effect. It accumulates across the conflict and only
        // clears at scene-end (the default sweep since crossScene
        // remains false). Per RAW: "You lose all Prophecy Points at
        // the end of each scene."
        directorPermanent: true,
      },
      // Stack visual — same flag the legacy "Prophetic Defender Style"
      // AE carries. The status-counter module reads this to render a
      // small number badge on the token icon, making accumulated PP
      // visible to the GM and player.
      statuscounter: {
        config: { multiplyEffect: true, type: "default" },
        value: 1,
        visible: false,
      },
    },
    system: { tags: ["buff"] },
  };
}

const BONUS_HP_AE_DESCRIPTION =
  "<p><em>Prophetic Defender:</em> Permanent +base Insight die size to maximum HP.</p>";

function makeBonusHpAeTemplate(iconUrl) {
  return {
    name: "Prophetic Defender",
    icon: iconUrl ?? null,
    description: BONUS_HP_AE_DESCRIPTION,
    transfer: true,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: [],
    changes: [
      {
        key:      "bonus_hp",
        // CSB AE-formula reading parent actor MUST use `fetchFromParent`
        // per [[csb-ae-actor-data-access]]; bare `${ins_base}$` silently
        // resolves to 0 in item-owned AEs. Legacy "Prophetic Defender
        // Style (Bonus HP)" uses the same helper (with `ins_current` —
        // legacy bug; RAW specifies "base Insight die size", so the BD
        // version uses `ins_base`).
        value:    "${fetchFromParent('ins_base')}$",
        mode:     2,
        priority: 20,
      },
    ],
    flags: {
      [MODULE_ID]: {
        category: "buff",
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
    log(`  ${ownerLabel} Prophetic Defender: AE "${name}" created`);
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
  log(`  ${ownerLabel} Prophetic Defender: AE "${name}" normalised`);
  return true;
}

async function patchProphecticDefenderItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Prophetic Defender: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. reaction_config_table — wholesale replace.
  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": REACTION_CONFIG_TABLE });
    log(`  ${ownerLabel} Prophetic Defender: reaction_config_table written`);
    touched = true;
  }

  // 3. effect_table — wholesale replace.
  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": EFFECT_TABLE });
    log(`  ${ownerLabel} Prophetic Defender: effect_table written`);
    touched = true;
  }

  // 4. Embedded AEs.
  if (await ensureAeTemplate(item, "Prophecy Point",       makeProphecyPointAeTemplate, log, ownerLabel)) touched = true;
  if (await ensureAeTemplate(item, "Prophetic Defender",   makeBonusHpAeTemplate,       log, ownerLabel)) touched = true;

  // 5. Sync CSB template version stamp + reload template view.
  // See [[csb-template-version-sync]] — both steps required.
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Prophetic Defender: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Prophetic Defender: CSB templateSystem.reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Prophetic Defender: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }

  return touched;
}

export async function migrate(game, log) {
  const hybridFolder = await ensureHybridHeroicFolder(game, log);
  if (!hybridFolder) {
    log(`  ERROR: could not ensure "${HYBRID_HEROIC_FOLDER}" folder under "${BD_ROOT_NAME}".`);
    return { applied: false, summary: `Prophetic Defender: missing folder` };
  }

  let master = game.items?.contents?.find?.((i) =>
    i.name === "Prophetic Defender"
    && i.folder?.id === hybridFolder.id
    && templateMatches(i));

  if (!master) {
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    const created = await Item.create({
      name: "Prophetic Defender",
      type: "equippableItem",
      img: PD_DEFAULT_ICON,
      folder: hybridFolder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: { skill_type: "Passive", isHeroic: true, isReaction: true, level: 1, max_level: 1 },
      },
    });
    master = created;
    log(`  Prophetic Defender: master created in ${BD_ROOT_NAME}/${HYBRID_HEROIC_FOLDER}` +
        (versionStamp !== undefined ? ` (stamp ${versionStamp})` : " (no template stamp)"));
  }

  let masters = 0;
  let copies = 0;
  if (await patchProphecticDefenderItem(master, log, "master")) masters += 1;

  // Actor copies — only patch those linked to the BD master via
  // system.uniqueId. Copies linked to the legacy "Prophetic Defender
  // Style" master (uniqueId "propheticDefStyle") are intentionally
  // left alone; users who want the BD-native behavior re-add from the
  // new BD master.
  const bdMasterUniqueId = String(master.system?.uniqueId ?? "").trim();
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Prophetic Defender") continue;
      if (!templateMatches(item)) continue;
      const itemUid = String(item.system?.uniqueId ?? "").trim();
      if (bdMasterUniqueId && itemUid !== bdMasterUniqueId) continue;
      if (await patchProphecticDefenderItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Prophetic Defender authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
