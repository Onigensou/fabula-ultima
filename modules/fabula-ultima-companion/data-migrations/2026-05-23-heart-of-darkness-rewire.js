/**
 * Migration: 2026-05-23-heart-of-darkness-rewire
 * ---------------------------------------------------------------------------
 * Fix Heart of Darkness, which silently stopped working after the Phase F
 * unified-targeting refactor (2026-05-20). Three regressions:
 *
 *   (1) reaction_effect_ref on the master's `conflict_start` trigger row was
 *       wiped to "" at some point. With no effect_ref the passive matches but
 *       fires nothing — the Ready AE never lands, so the creature_enter_crisis
 *       offer never appears.
 *
 *   (2) The Ready AE's *nested* `reactionConfig.reaction_effect_table` was
 *       NOT migrated by 2026-05-20-skills-to-unified-targeting (that migration
 *       only walks `system.props.effect_table` on items). The nested
 *       `hod_consume` row still carries legacy `grant_target: "self"` with no
 *       `target_ref`. Post-refactor, applyConsumeChargeEffect requires
 *       `target_ref` and returns `{ ok: false, reason: "missing_target_ref" }`,
 *       which aborts the chain — Bond of Hatred never applies.
 *
 *   (3) Both reaction_config_table rows carry `reaction_ownership: "self"`,
 *       which is not a valid ownership value (only `"own_summon"` is).
 *       reactionOwnershipMatchesRow rejects every row with an unknown value
 *       UNLESS the trigger has `subjectFrom: null` (early bypass). conflict_start
 *       has subjectFrom=null so the conflict_start row is unaffected; but
 *       creature_enter_crisis uses SUBJECT_STATE_CHANGED, so the Ready AE's
 *       row enters the matcher and silently rejects — HoD never appears in
 *       the Crisis reaction window. Strip `reaction_ownership` everywhere.
 *
 * This migration:
 *   - Restores `reaction_effect_ref: "hod_arm"` on master + every actor copy.
 *   - Strips `reaction_ownership` from every HoD reaction_config_table row.
 *   - Rewrites the master's Ready AE `reactionConfig` flag with the unified-
 *     targeting shape AND reverses the chain to `hod_bond,hod_consume` so a
 *     cancelled picker doesn't burn the charge (per consume-last-in-chain).
 *   - Also rewrites the same flag on every actor-borne "Heart of Darkness
 *     Ready" AE that was already armed from a prior conflict_start (those
 *     carry a stamped copy of the broken config via aeReactionBridge.js).
 *
 * IDEMPOTENT: deep-compares every write target against the desired shape.
 */

export const key = "2026-05-23-heart-of-darkness-rewire";
export const description =
  "Rewire Heart of Darkness: restore reaction_effect_ref + migrate Ready AE's " +
  "nested reactionConfig to unified targeting + reverse chain order to " +
  "consume-last. Master + actor copies + stale actor-borne Ready AEs.";

const ITEM_NAME         = "Heart of Darkness";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const MODULE_ID         = "fabula-ultima-companion";
const READY_AE_NAME     = "Heart of Darkness Ready";
const BOND_AE_NAME      = "Bond of Hatred";
const CHARGE_KEY        = "hod_ready";

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

// Desired nested reactionConfig shape for the Ready AE. `bondAeUuid` is the
// master Bond-of-Hatred AE template UUID; the apply_ae handler's prompt path
// reads this UUID to clone + stamp the picked target's name into the AE.
function makeReadyReactionConfig(bondAeUuid) {
  return {
    name: "Heart of Darkness",
    reaction_config_table: {
      "0": {
        $deleted:            false,
        reaction_trigger:    "creature_enter_crisis",
        reaction_source:     "self",
        // No `reaction_ownership`: "self" is invalid (only "own_summon" is
        // a valid value). On a trigger whose subjectFrom is non-null
        // (creature_enter_crisis = SUBJECT_STATE_CHANGED), unknown ownership
        // values cause reactionOwnershipMatchesRow to reject the row.
        reaction_isPassive:  false,
        reaction_effect_ref: "hod_fire"
      }
    },
    reaction_effect_table: {
      "0": {
        $deleted:     false,
        effect_label: "hod_fire",
        effect_kind:  "chain",
        // consume-last: if the picker (hod_bond) is cancelled or finds no
        // valid creature, the chain stops before hod_consume burns the
        // charge.
        chain_steps:  "hod_bond,hod_consume"
      },
      "1": {
        $deleted:               false,
        effect_label:           "hod_bond",
        effect_kind:            "apply_ae",
        ae_template_ref:        bondAeUuid,
        ae_duplicate_mode:      "stack",
        // target_prompt path: handler always lands the AE on the reactor;
        // the picked creature's name is stamped into the AE's bondAE flag.
        // No `target_ref` needed in this branch (and grant_target/legacy
        // fields are stripped).
        target_prompt:          "visible",
        target_prompt_filter:   "no_existing_bond",
        target_prompt_title:    "Heart of Darkness",
        target_prompt_message:  "Choose a creature you can see — you will form a Bond of Hatred toward them."
      },
      "2": {
        $deleted:     false,
        effect_label: "hod_consume",
        effect_kind:  "consume_charge",
        charge_key:   CHARGE_KEY,
        // Unified targeting: points at the `hod_ready_self` targeting row
        // below. Resolver pool is just the reactor.
        target_ref:   "hod_ready_self",
        on_empty:     "abort",
        count:        "1"
      },
      "3": {
        $deleted:                  false,
        effect_label:              "hod_ready_self",
        effect_kind:               "targeting",
        candidate_source:          "self",
        category:                  "",
        mode:                      "exact",
        count:                     1,
        exclude_self:              false,
        auto_confirm_when_obvious: true,
        skip_when_passive:         true,
        iteration_mode:            "together"
      }
    }
  };
}

// Restore reaction_effect_ref="hod_arm" on the conflict_start trigger row,
// and strip the bogus `reaction_ownership: "self"` value while we're at it
// (the conflict_start row no-ops on it today, but the field is misleading).
// Returns true if anything changed.
async function ensureTriggerEffectRef(item, label, log) {
  const tbl = item?.system?.props?.reaction_config_table;
  if (!tbl || typeof tbl !== "object") return false;
  const clone = foundry.utils.duplicate(tbl);
  let changed = false;
  const patch = { "system.props.reaction_config_table": clone };
  for (const k of Object.keys(clone)) {
    const row = clone[k];
    if (!row || row.$deleted) continue;
    if (String(row.reaction_trigger ?? "") !== "conflict_start") continue;
    if (String(row.reaction_effect_ref ?? "") !== "hod_arm") {
      row.reaction_effect_ref = "hod_arm";
      changed = true;
    }
    // Strip ownership at the field level — deep-merge won't remove keys, so
    // we use the explicit `-=` removal path against the row's original key.
    if (Object.prototype.hasOwnProperty.call(row, "reaction_ownership")) {
      delete row.reaction_ownership;
      patch[`system.props.reaction_config_table.${k}.-=reaction_ownership`] = null;
      changed = true;
    }
  }
  if (!changed) return false;
  await item.update(patch);
  log(`${label}: restored reaction_effect_ref=hod_arm + stripped reaction_ownership`);
  return true;
}

// Replace the AE's reactionConfig flag wholesale (after unsetFlag to clear
// any legacy fields nested-merge would otherwise preserve). Returns true if
// the write happened.
async function ensureReactionConfig(ae, bondAeUuid, label, log) {
  const desired = makeReadyReactionConfig(bondAeUuid);
  const current = ae?.flags?.[MODULE_ID]?.reactionConfig ?? null;
  if (current && deepEqual(current, desired)) {
    log(`${label}: reactionConfig up-to-date`);
    return false;
  }
  await ae.unsetFlag(MODULE_ID, "reactionConfig");
  await ae.setFlag(MODULE_ID, "reactionConfig", desired);
  log(`${label}: reactionConfig rewritten`);
  return true;
}

export async function migrate(game, log) {
  let touched = 0;

  // 1. Master item(s).
  const masters = (game.items?.contents ?? [])
    .filter(it => it.name === ITEM_NAME && templateMatches(it));
  if (!masters.length) {
    log(`no master "${ITEM_NAME}" item; nothing to do`);
    return { applied: true, summary: "no master item present" };
  }

  let masterBondAeUuid = null;
  for (const master of masters) {
    log(`master "${master.name}" [${master.id}]:`);
    const bondAe  = master.effects?.contents?.find(e => e.name === BOND_AE_NAME) ?? null;
    const readyAe = master.effects?.contents?.find(e => e.name === READY_AE_NAME) ?? null;
    if (!bondAe || !readyAe) {
      log(`  missing AEs (bond=${!!bondAe} ready=${!!readyAe}) — skipping master`);
      continue;
    }
    masterBondAeUuid ??= bondAe.uuid;

    if (await ensureTriggerEffectRef(master, `  master`, log)) touched++;
    if (await ensureReactionConfig(readyAe, bondAe.uuid, `  master Ready AE`, log)) touched++;
  }

  if (!masterBondAeUuid) {
    log("no master Bond AE found — cannot rewire actor-borne Ready AEs");
    return { applied: true, summary: `${touched} fixes (master-only; no bond ae found)` };
  }

  // 2. Actor copies — item-level trigger row + any stale Ready AE on the actor.
  for (const actor of (game.actors?.contents ?? [])) {
    // 2a. Item-level reaction_effect_ref restore.
    for (const item of (actor.items?.contents ?? [])) {
      if (item.name !== ITEM_NAME) continue;
      if (!templateMatches(item)) continue;
      const label = `actor "${actor.name}" item "${item.name}" [${item.id}]`;
      if (await ensureTriggerEffectRef(item, label, log)) touched++;
    }
    // 2b. Stale armed Ready AE on the actor — overwrite its reactionConfig.
    const staleReady = (actor.effects?.contents ?? [])
      .filter(e => e?.name === READY_AE_NAME
                || e?.flags?.[MODULE_ID]?.chargeKey === CHARGE_KEY);
    for (const ae of staleReady) {
      const label = `actor "${actor.name}" Ready AE [${ae.id}]`;
      if (await ensureReactionConfig(ae, masterBondAeUuid, label, log)) touched++;
    }
  }

  return {
    applied: true,
    summary: `${touched} write${touched === 1 ? "" : "s"} applied`
  };
}
