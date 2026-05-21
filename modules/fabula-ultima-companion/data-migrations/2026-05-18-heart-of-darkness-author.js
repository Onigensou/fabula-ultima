/**
 * Migration: 2026-05-18-heart-of-darkness-author
 * ---------------------------------------------------------------------------
 * Authors Heart of Darkness (Darkblade) declaratively.
 *
 * Rule (Core, Darkblade section):
 *   "Once per scene upon entering Crisis, you may choose a specific creature
 *    you can see that you don't have a Bond towards. If you do, create a
 *    Bond of hatred towards that creature."
 *
 * Wiring (Phase G):
 *
 *   On the master item only — two AE templates:
 *     • "Heart of Darkness Ready"
 *         flags.fabula-ultima-companion.chargeKey       = "hod_ready"
 *         flags.fabula-ultima-companion.charges         = 1
 *         flags.fabula-ultima-companion.chargesMax      = 1
 *         flags.fabula-ultima-companion.sceneExpiry     = true
 *         flags.fabula-ultima-companion.reactionConfig  = creature_enter_crisis
 *                                                          → chain(consume_charge, apply_ae[bond])
 *     • "Bond of Hatred" (template)
 *         flags.fabula-ultima-companion.bondAE          = {
 *           bond_name: "{target}",      // patched at apply time
 *           emotion_1: "", emotion_2: "", emotion_3: "hatred"
 *         }
 *         flags.fabula-ultima-companion.sceneExpiry     = true
 *
 *   On master + every actor copy — skill's reaction_config_table + effect_table:
 *     reaction_config_table[hod_arm] = {
 *       reaction_trigger:    "conflict_start",
 *       reaction_ownership:  "self",
 *       reaction_isPassive:  true,
 *       reaction_effect_ref: "hod_arm"
 *     }
 *     effect_table[hod_arm] = {
 *       effect_kind:        "apply_ae",
 *       ae_template_ref:    "Item.<master>.ActiveEffect.<ready-id>",
 *       grant_target:       "self",
 *       ae_duplicate_mode:  "replace"
 *     }
 *
 * The AE-borne reactionConfig on the Ready AE has its OWN effect_table
 * with consume_charge + apply_ae(bond) — see READY_REACTION_CONFIG below.
 *
 * IDEMPOTENT: matches AE templates by name, skill rows by effect_label,
 * deep-compares before writing.
 */

export const key = "2026-05-18-heart-of-darkness-author";
export const description =
  "Author Heart of Darkness: AE templates (Ready + Bond) on the master item, " +
  "and conflict_start passive arming on master + actor copies.";

const ITEM_NAME            = "Heart of Darkness";
const SKILL_TEMPLATE_ID    = "j0F5Msw5RZ8aIB3j";
const MODULE_ID            = "fabula-ultima-companion";

const READY_AE_NAME        = "Heart of Darkness Ready";
const BOND_AE_NAME         = "Bond of Hatred";

const CHARGE_KEY           = "hod_ready";

// Skill-level rows (the conflict_start arming passive) — written to the
// item's props on master + actor copies.
const SKILL_TRIGGER_ROW = Object.freeze({
  $deleted:            false,
  reaction_trigger:    "conflict_start",
  reaction_ownership:  "self",
  reaction_isPassive:  true,
  reaction_effect_ref: "hod_arm"
});

// The skill effect row needs the Ready AE's UUID — built dynamically once
// the AE exists. Below is the static field set; `ae_template_ref` is filled
// in per-item at migration time.
function makeSkillEffectRow(readyAeUuid) {
  return Object.freeze({
    $deleted:           false,
    effect_label:       "hod_arm",
    effect_kind:        "apply_ae",
    ae_template_ref:    readyAeUuid,
    grant_target:       "self",
    ae_duplicate_mode:  "replace"
  });
}

// The Ready AE's own reactionConfig — the manual fire path. Built once the
// Bond AE UUID is known.
function makeReadyReactionConfig(bondAeUuid) {
  return {
    name: "Heart of Darkness",
    reaction_config_table: {
      "0": {
        $deleted:            false,
        reaction_trigger:    "creature_enter_crisis",
        reaction_source:     "self",
        reaction_ownership:  "self",
        reaction_isPassive:  false,
        reaction_effect_ref: "hod_fire"
      }
    },
    reaction_effect_table: {
      "0": {
        $deleted:        false,
        effect_label:    "hod_fire",
        effect_kind:     "chain",
        chain_steps:     "hod_consume,hod_bond"
      },
      "1": {
        $deleted:        false,
        effect_label:    "hod_consume",
        effect_kind:     "consume_charge",
        charge_key:      CHARGE_KEY,
        grant_target:    "self",
        on_empty:        "abort",
        count:           "1"
      },
      "2": {
        $deleted:               false,
        effect_label:           "hod_bond",
        effect_kind:            "apply_ae",
        ae_template_ref:        bondAeUuid,
        grant_target:           "self",
        ae_duplicate_mode:      "stack",
        target_prompt:          "visible",
        target_prompt_filter:   "no_existing_bond",
        target_prompt_title:    "Heart of Darkness",
        target_prompt_message:  "Choose a creature you can see — you will form a Bond of Hatred toward them."
      }
    }
  };
}

const READY_AE_FLAGS_BASE = Object.freeze({
  chargeKey:    CHARGE_KEY,
  charges:      1,
  chargesMax:   1,
  sceneExpiry:  true
});

const BOND_AE_FLAGS = Object.freeze({
  sceneExpiry: true,
  bondAE: {
    bond_name:  "{target}",
    emotion_1:  "",
    emotion_2:  "",
    emotion_3:  "hatred",
    relationship: "Heart of Darkness"
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const subset = (row, keys) => Object.fromEntries(keys.map(k => [k, row?.[k]]));
const deepEqualSubset = (a, b, keys) =>
  stableStringify(subset(a, keys)) === stableStringify(subset(b, keys));

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

function findAEByName(item, name) {
  const all = item?.effects?.contents ?? [];
  return all.find(e => (e?.name ?? "") === name) ?? null;
}

async function ensureReadyAE(item, bondAeUuid, log) {
  const existing = findAEByName(item, READY_AE_NAME);
  const desiredReactionConfig = makeReadyReactionConfig(bondAeUuid);
  const desiredFlags = { ...READY_AE_FLAGS_BASE, reactionConfig: desiredReactionConfig };

  if (existing) {
    const currentFlags = existing.flags?.[MODULE_ID] ?? {};
    const compareKeys = ["chargeKey", "chargesMax", "sceneExpiry", "reactionConfig"];
    const same = compareKeys.every(k => deepEqual(currentFlags[k], desiredFlags[k]));
    if (same) {
      log(`  Ready AE [${existing.id}]: up-to-date`);
      return existing;
    }
    // Unset reactionConfig first so nested merge doesn't keep legacy fields.
    await existing.unsetFlag(MODULE_ID, "reactionConfig");
    const update = {};
    for (const k of Object.keys(desiredFlags)) {
      update[`flags.${MODULE_ID}.${k}`] = desiredFlags[k];
    }
    // Don't overwrite running charges if the AE happens to be mid-scene.
    delete update[`flags.${MODULE_ID}.charges`];
    await existing.update(update);
    log(`  Ready AE [${existing.id}]: flags updated`);
    return existing;
  }

  const created = await item.createEmbeddedDocuments("ActiveEffect", [{
    name: READY_AE_NAME,
    icon: "icons/svg/aura.svg",
    img:  "icons/svg/aura.svg",
    transfer: false,
    disabled: false,
    duration: { seconds: 999999 },
    description: "<p>Heart of Darkness is armed for this scene. Consumed when you create a Bond of Hatred upon entering Crisis.</p>",
    system: { tags: [] },
    changes: [],
    flags: {
      [MODULE_ID]: desiredFlags
    }
  }]);
  const newEff = created?.[0];
  log(`  Ready AE [${newEff?.id}]: created`);
  return newEff;
}

async function ensureBondAE(item, log) {
  const existing = findAEByName(item, BOND_AE_NAME);
  if (existing) {
    const currentFlags = existing.flags?.[MODULE_ID] ?? {};
    const same = ["sceneExpiry", "bondAE"].every(k => deepEqual(currentFlags[k], BOND_AE_FLAGS[k]));
    if (same) {
      log(`  Bond AE [${existing.id}]: up-to-date`);
      return existing;
    }
    const update = {};
    for (const k of Object.keys(BOND_AE_FLAGS)) {
      update[`flags.${MODULE_ID}.${k}`] = BOND_AE_FLAGS[k];
    }
    await existing.update(update);
    log(`  Bond AE [${existing.id}]: flags updated`);
    return existing;
  }

  const created = await item.createEmbeddedDocuments("ActiveEffect", [{
    name: BOND_AE_NAME,
    icon: "icons/svg/terror.svg",
    img:  "icons/svg/terror.svg",
    transfer: false,
    disabled: false,
    duration: { seconds: 999999 },
    description: "<p>A scene-duration Bond of Hatred, created by Heart of Darkness.</p>",
    system: { tags: [] },
    changes: [],
    flags: {
      [MODULE_ID]: BOND_AE_FLAGS
    }
  }]);
  const newEff = created?.[0];
  log(`  Bond AE [${newEff?.id}]: created`);
  return newEff;
}

function findRowByKeyish(table, predicate) {
  if (!table || typeof table !== "object") return null;
  for (const k of Object.keys(table)) {
    const r = table[k];
    if (r && !r.$deleted && predicate(r)) return { key: k, row: r };
  }
  return null;
}

async function ensureSkillRows(item, readyAeUuid, label, log) {
  const props = item.system?.props ?? {};
  const triggerTable = props.reaction_config_table ?? {};
  const effectTable  = props.effect_table ?? {};

  const trigKeys = Object.keys(SKILL_TRIGGER_ROW).filter(k => k !== "$deleted");
  const desiredEffect = makeSkillEffectRow(readyAeUuid);
  const effKeys = Object.keys(desiredEffect).filter(k => k !== "$deleted");

  const existingTrig = findRowByKeyish(triggerTable, r => r.reaction_effect_ref === "hod_arm");
  const existingEff  = findRowByKeyish(effectTable,  r => r.effect_label        === "hod_arm");

  const trigOk = !!existingTrig && deepEqualSubset(existingTrig.row, SKILL_TRIGGER_ROW, trigKeys);
  const effOk  = !!existingEff  && deepEqualSubset(existingEff.row,  desiredEffect,     effKeys);
  const isReactionOk = props.isReaction === true;

  if (isReactionOk && trigOk && effOk) {
    log(`${label}: already wired`);
    return false;
  }

  const newTrigTable = foundry.utils.duplicate(typeof triggerTable === "object" && triggerTable ? triggerTable : {});
  if (existingTrig) newTrigTable[existingTrig.key] = { ...SKILL_TRIGGER_ROW };
  else {
    let i = 0; while (Object.prototype.hasOwnProperty.call(newTrigTable, String(i))) i++;
    newTrigTable[String(i)] = { ...SKILL_TRIGGER_ROW };
  }

  const newEffTable = foundry.utils.duplicate(typeof effectTable === "object" && effectTable ? effectTable : {});
  if (existingEff) newEffTable[existingEff.key] = { ...desiredEffect };
  else {
    let i = 0; while (Object.prototype.hasOwnProperty.call(newEffTable, String(i))) i++;
    newEffTable[String(i)] = { ...desiredEffect };
  }

  await item.update({
    "system.props.isReaction":             true,
    "system.props.reaction_config_table":  newTrigTable,
    "system.props.effect_table":           newEffTable
  });
  log(`${label}: wired (${[
    !isReactionOk && "isReaction",
    !trigOk       && "trigger row",
    !effOk        && "effect row"
  ].filter(Boolean).join(", ")})`);
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Entry
// ──────────────────────────────────────────────────────────────────────────

export async function migrate(game, log) {
  let mastersAuthored = 0;
  let copiesAuthored  = 0;
  let aesAuthored     = 0;

  // Authoritative master: pick the first world item named "Heart of Darkness"
  // matching the skill template. AEs live on this master only.
  const masters = (game.items?.contents ?? []).filter(it => it.name === ITEM_NAME && templateMatches(it));
  if (!masters.length) {
    log(`no master "${ITEM_NAME}" item in this world — nothing to do`);
    return { applied: true, summary: "no master item present" };
  }

  // For each master: ensure both AE templates, then wire the skill rows.
  // The Ready AE's reactionConfig references the Bond AE by UUID, so the
  // bond AE must exist first.
  const masterInfos = []; // { master, readyUuid }
  for (const master of masters) {
    log(`master "${master.name}" [${master.id}]:`);
    const beforeAeCount = master.effects?.contents?.length ?? 0;
    const bondAe  = await ensureBondAE(master, log);
    const bondUuid = bondAe?.uuid ?? `Item.${master.id}.ActiveEffect.${bondAe?.id}`;
    const readyAe = await ensureReadyAE(master, bondUuid, log);
    const readyUuid = readyAe?.uuid ?? `Item.${master.id}.ActiveEffect.${readyAe?.id}`;
    const afterAeCount = master.effects?.contents?.length ?? beforeAeCount;
    if (afterAeCount > beforeAeCount) aesAuthored += (afterAeCount - beforeAeCount);
    masterInfos.push({ master, readyUuid });

    if (await ensureSkillRows(master, readyUuid, `  skill rows`, log)) mastersAuthored++;
  }

  // Actor copies: wire skill rows referencing the FIRST master's Ready AE UUID.
  // Copies don't need their own AEs — apply_ae resolves the master's UUID at fire time.
  const primaryReadyUuid = masterInfos[0]?.readyUuid;
  if (primaryReadyUuid) {
    for (const actor of game.actors?.contents ?? []) {
      for (const item of actor.items?.contents ?? []) {
        if (item.name !== ITEM_NAME) continue;
        if (!templateMatches(item)) continue;
        const label = `actor "${actor.name}" item "${item.name}" [${item.id}]`;
        if (await ensureSkillRows(item, primaryReadyUuid, label, log)) copiesAuthored++;
      }
    }
  }

  return {
    applied: true,
    summary:
      `${mastersAuthored} master${mastersAuthored === 1 ? "" : "s"} wired, ` +
      `${copiesAuthored} actor copies wired, ` +
      `${aesAuthored} AE template${aesAuthored === 1 ? "" : "s"} authored`
  };
}
