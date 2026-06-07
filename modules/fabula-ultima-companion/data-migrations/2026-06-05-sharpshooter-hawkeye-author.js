/**
 * Migration: 2026-06-05-sharpshooter-hawkeye-author
 * ---------------------------------------------------------------------------
 * Promote Sharpshooter **Hawkeye** from the B.1 stub to full BD-native
 * mechanics. Core RAW (max SL 5):
 *
 *   "When you perform the Guard action, if you choose NOT to provide cover
 *    to another creature, you may choose one option:
 *      (a) the next ranged attack you perform before the end of the current
 *          scene will deal SL × 2 extra damage; OR
 *      (b) you may immediately perform a free attack with a bow or firearm
 *          you have equipped, treating your High Roll (HR) as 0 when
 *          calculating damage dealt by this attack."
 *
 * Declarative wiring (all canon, no per-skill JS):
 *   • SKILL reaction row — trigger `creature_guards`, `reaction_source: self`,
 *     gated `DID_COVER_ALLY == 0` (the guarded-without-cover clause). It is a
 *     RAW "may", so `reaction_isPassive: false` → the player picks Hawkeye
 *     from the post-resolve reaction menu (creature_guards is post-resolve).
 *   • The reaction fires `open_action_menu` with two options:
 *       (a) apply_ae the "Hawkeye" buff AE to self;
 *       (b) open_action_menu free_mode (Attack only) → a free attack.
 *   • The "Hawkeye" buff AE carries its OWN reactionConfig:
 *       trigger `creature_will_deal_damage`, `reaction_source: self`,
 *       gated `ATTACK_IS_RANGED == 1` (the new in-flight-weapon-class gate —
 *       so the buff is spent only on a RANGED attack, surviving melee swings),
 *       firing chain [adjust_damage outgoing/add "SL*2", consume_charge]. One charge → fires
 *       once then self-deletes. `directorPermanent` skips turn-ticking so it
 *       lasts until consumed OR the scene-end sweep ("before the end of the
 *       current scene").
 *
 * Engine prerequisites shipped alongside this migration:
 *   • `ATTACK_IS_RANGED` / `ATTACK_IS_MELEE` / `ATTACK_IS_ARCANE` formula
 *     identifiers (skill-formulas.js) reading the in-flight `payload.weaponType`.
 *   • `weaponType` threaded onto both creature_deals_damage payloads
 *     (state-handlers.js) so post-resolve reactions can gate on it too.
 *   • apply_ae now bakes `damage_amount`/`grant_amount` formulas in a cloned
 *     AE's reactionConfig at apply-time (skill-effects.js) — so "SL*2" records
 *     Hawkeye's SL at the moment of the Guard, not the AE's (level-less) self.
 *
 * Option (b)'s "treat HR as 0 for damage" is implemented via the declarative
 * `free_hr_as_zero: true` on the hawkeye_opt_attack row → threaded to the
 * free-action grant (skill-effects free_mode → freeActions grant → Attack
 * COMPUTE `ignoreHR`). Any free_mode row can opt in the same way.
 *
 * IDEMPOTENT — patches the BD-tree master + every actor copy; wholesale-
 * replaces reaction_config_table / effect_table; ensures the embedded buff AE.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const key = "2026-06-05-sharpshooter-hawkeye-author";
export const description =
  "Sharpshooter Hawkeye: full creature_guards (no-cover) reaction → menu " +
  "(take aim: +SL×2 next ranged attack via add_damage buff AE / free attack).";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Sharpshooter";
const SKILL_SUBFOLDER = "Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const SKILL_NAME = "Hawkeye";
const HAWKEYE_ICON = "icons/skills/ranged/target-eye-orange.webp";

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

// Walk folder ancestry to confirm the item lives under the top-level
// "Battle Director" folder (subfolder naming may vary — Skill vs class root).
function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

// ── DATA ────────────────────────────────────────────────────────────────────

const DESCRIPTION =
  "<p>When you perform the <strong>Guard</strong> action, if you choose " +
  "<strong>not</strong> to provide cover to another creature, you may choose " +
  "one option:</p>" +
  "<ul>" +
  "<li>the next <strong>ranged attack</strong> you perform before the end of " +
  "the current scene will deal <strong>【SL】× 2</strong> extra damage; or</li>" +
  "<li>you may immediately perform a <strong>free attack</strong> with a bow " +
  "or firearm you have equipped, treating your <strong>High Roll (HR)</strong> " +
  "as <strong>0</strong> when calculating damage dealt by this attack.</li>" +
  "</ul>";

const PROP_PATCH = {
  skill_type:   "Passive",
  isReaction:   true,
  isCheck:      false,
  isHeroic:     false,
  level:        "1",
  max_level:    "5",
  cost:         "",
  description:  DESCRIPTION,
  on_activate_effect_ref: "",
};

// Skill-borne reaction: fires on the bearer's own no-cover Guard.
const REACTION_CONFIG_TABLE = {
  "0": {
    reaction_trigger:    "creature_guards",
    reaction_source:     "self",
    condition_formula:   "DID_COVER_ALLY == 0",
    reaction_effect_ref: "hawkeye_choose",
    reaction_passive_mode: "ask",
  },
};

const EFFECT_TABLE = {
  "0": {
    effect_label:     "hawkeye_choose",
    effect_kind:      "open_action_menu",
    menu_title:       "Hawkeye",
    menu_subtitle:    "You guarded without providing cover — choose:",
    menu_option_refs: "hawkeye_opt_aim, hawkeye_opt_attack",
  },
  "1": {
    effect_label:      "hawkeye_opt_aim",
    effect_kind:       "apply_ae",
    ae_template_ref:   SKILL_NAME,
    target_ref:        "hawkeye_self_skill",
    ae_duplicate_mode: "replace",
    menu_label:        "Take aim — your next ranged attack deals +SL×2 extra damage",
    menu_description:  "Lasts until you make a ranged attack, or the scene ends.",
  },
  "2": {
    effect_label:    "hawkeye_opt_attack",
    effect_kind:     "open_action_menu",
    free_mode:       true,
    allowed_types:   "Attack",
    free_hr_as_zero: true,   // RAW: "treating your High Roll (HR) as 0" for damage
    menu_label:      "Free attack — bow or firearm (High Roll treated as 0)",
    menu_description: "Immediately perform a free bow/firearm attack.",
  },
  "3": {
    effect_label:     "hawkeye_self_skill",
    effect_kind:      "targeting",
    candidate_source: "self",
  },
};

// ── EMBEDDED BUFF AE ────────────────────────────────────────────────────────

const BUFF_AE_DESCRIPTION =
  "<p><em>Hawkeye:</em> your next ranged attack this scene deals extra damage.</p>";

function makeHawkeyeBuffAe() {
  return {
    name: SKILL_NAME,
    icon: HAWKEYE_ICON,
    description: BUFF_AE_DESCRIPTION,
    transfer: false,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: ["fud-hawkeye-aim"],
    changes: [],
    flags: {
      [MODULE_ID]: {
        category: "buff",
        // Scene-duration: skip the per-turn tick. The scene-end sweep still
        // removes it (it's director-applied + buff-tagged), and the
        // consume_charge below removes it the moment it fires — matching
        // "before the end of the current scene" + "the next ranged attack".
        directorPermanent: true,
        // One-shot charge — consumed by the reaction's chain on first ranged hit.
        charges: 1,
        chargesMax: 1,
        chargeKey: "hawkeye_aim",
        reactionConfig: {
          reaction_config_table: {
            "0": {
              reaction_trigger:      "creature_will_deal_damage",
              reaction_source:       "self",
              condition_formula:     "ATTACK_IS_RANGED == 1",
              reaction_effect_ref:   "hawkeye_fire",
              reaction_passive_target: "self",
              reaction_passive_mode: "on",
            },
          },
          effect_table: {
            "0": { effect_label: "hawkeye_fire", effect_kind: "chain", chain_steps: "hawkeye_add, hawkeye_consume" },
            // SL*2 — baked to Hawkeye's SL at apply-time by apply_ae's
            // reactionConfig formula bake (the carrier AE has no level).
            // Unified `adjust_damage` shape (outgoing/add) — the former
            // `add_damage` kind was folded into adjust_damage by
            // 2026-06-07-unify-adjust-damage. Keep this in sync so an
            // idempotent re-run doesn't revert the live data to the dead kind.
            "1": { effect_label: "hawkeye_add", effect_kind: "adjust_damage", damage_operation: "add", damage_stage: "outgoing", damage_amount: "SL * 2" },
            "2": { effect_label: "hawkeye_consume", effect_kind: "consume_charge", charge_key: "hawkeye_aim", on_empty: "skip", count: 1, target_ref: "hawkeye_self_ae" },
            "3": { effect_label: "hawkeye_self_ae", effect_kind: "targeting", candidate_source: "self" },
          },
        },
      },
    },
    system: { tags: ["buff"] },
  };
}

// ── PATCH ────────────────────────────────────────────────────────────────────

async function ensureBuffAe(item, log, ownerLabel) {
  const want = makeHawkeyeBuffAe();
  const existing = item.effects?.contents?.find((e) => e.name === SKILL_NAME);
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want]);
    log(`  ${ownerLabel} Hawkeye: buff AE created`);
    return true;
  }
  const needs =
    !deepEqual(existing.changes ?? [], want.changes)
    || !deepEqual(Array.from(existing.statuses ?? []), want.statuses)
    || !deepEqual(existing.flags?.[MODULE_ID] ?? {}, want.flags[MODULE_ID])
    || existing.transfer !== want.transfer
    || (want.description && existing.description !== want.description)
    || (want.icon && existing.icon !== want.icon);
  if (!needs) return false;
  await existing.update({
    transfer: want.transfer,
    duration: want.duration,
    changes: want.changes,
    statuses: want.statuses,
    flags: want.flags,
    system: want.system,
    description: want.description,
    icon: want.icon,
  });
  log(`  ${ownerLabel} Hawkeye: buff AE normalised`);
  return true;
}

async function patchHawkeye(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (!deepEqual(p[k], v)) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Hawkeye: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  if (!deepEqual(p.reaction_config_table ?? {}, REACTION_CONFIG_TABLE)) {
    await item.update({ "system.props.-=reaction_config_table": null });
    await item.update({ "system.props.reaction_config_table": REACTION_CONFIG_TABLE });
    log(`  ${ownerLabel} Hawkeye: reaction_config_table written`);
    touched = true;
  }

  if (!deepEqual(p.effect_table ?? {}, EFFECT_TABLE)) {
    await item.update({ "system.props.-=effect_table": null });
    await item.update({ "system.props.effect_table": EFFECT_TABLE });
    log(`  ${ownerLabel} Hawkeye: effect_table written`);
    touched = true;
  }

  if (await ensureBuffAe(item, log, ownerLabel)) touched = true;

  // CSB template version sync + reload (mandatory — see [[csb-template-version-sync]]).
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Hawkeye: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Hawkeye: CSB reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Hawkeye: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }
  return touched;
}

export async function migrate(game, log) {
  // Ensure the BD-tree master exists (create if missing — this world's BD
  // skills were reverted, so only the legacy `💥 Skill / …` copy may exist).
  let bdMaster = game.items?.contents?.find?.((i) =>
    i.name === SKILL_NAME && templateMatches(i) && isInBattleDirectorTree(i));
  if (!bdMaster) {
    const { folder } = await ensureFolderPath(
      game, [BD_ROOT_NAME, CLASS_NAME, SKILL_SUBFOLDER], { log }).catch(() => ({ folder: null }));
    if (folder) {
      const tpl = game.items.get(SKILL_TEMPLATE_ID);
      const versionStamp = tpl?.system?.templateSystemUniqueVersion;
      bdMaster = await Item.create({
        name: SKILL_NAME,
        type: "equippableItem",
        img: HAWKEYE_ICON,
        folder: folder.id,
        system: {
          template: SKILL_TEMPLATE_ID,
          ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
          props: { skill_type: "Passive", isReaction: true, level: 1, max_level: 5 },
        },
      });
      log(`  Hawkeye: BD-tree master created in ${BD_ROOT_NAME}/${CLASS_NAME}/${SKILL_SUBFOLDER}`);
    } else {
      log("  Hawkeye: could not ensure BD folder; will still patch legacy + actor copies");
    }
  }

  // Patch the BD master (if any) + the legacy master + every actor copy.
  // Hawkeye is an unambiguous name (no legacy collision), so patch by
  // name + skill template wherever it lives.
  let masters = 0;
  let copies = 0;
  if (bdMaster && await patchHawkeye(bdMaster, log, "BD master")) masters += 1;

  for (const item of game.items?.contents ?? []) {
    if (item === bdMaster) continue;
    if (item.name !== SKILL_NAME || !templateMatches(item)) continue;
    if (await patchHawkeye(item, log, `world master "${item.folder?.name ?? "?"}"`)) masters += 1;
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== SKILL_NAME || !templateMatches(item)) continue;
      if (await patchHawkeye(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }
  return {
    applied: true,
    summary: `Hawkeye authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
