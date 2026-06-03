/**
 * Migration: 2026-06-03-sharpshooter-b1-author
 * ---------------------------------------------------------------------------
 * First-cut Sharpshooter (Core) authoring in the Battle Director tree.
 *
 * Authors 5 Sharpshooter Core skills into `Battle Director / Sharpshooter /
 * Skill`. Items don't yet exist in the BD tree (only legacy `💥 Skill /
 * Class Skill / Sharpshooter` copies); this migration creates fresh
 * BD-tree masters.
 *
 *   1. Ranged Weapon Mastery  ★ FULL — passive AE; +SL to ranged accuracy
 *   2. Barrage                  STUB — needs engine extension (modify
 *                                       attack's multi-attack property)
 *   3. Crossfire                STUB — needs `creature_performs_ranged_attack`
 *                                       trigger + `force_miss` effect_kind +
 *                                       variable cost-from-formula
 *   4. Hawkeye                  STUB — needs Guard-tied "next-attack
 *                                       buff" AE OR a free-attack grant
 *                                       (open_action_menu pattern)
 *   5. Warning Shot             STUB — needs damage-replace + status-apply
 *                                       on a ranged attack
 *
 * Stubs are real items (correct folder, template, name, description,
 * max_level) so they show in the BD tree and Class Lookups; they just
 * don't fire any mechanical effects yet. Each stub carries a clear
 * `// TODO` in its description so the GM knows it's WIP.
 *
 * Engine extension backlog (separate work — not in this migration):
 *   - effect_kind `modify_action_card_multi`     (Barrage)
 *   - trigger `creature_performs_ranged_attack`  (Crossfire)
 *   - effect_kind `force_miss`                   (Crossfire)
 *   - condition_formula access to a peer's roll  (Crossfire cost calc)
 *   - effect_kind `replace_damage_with_status`   (Warning Shot)
 *   - "next ranged attack" buff AE convention    (Hawkeye)
 *
 * IDEMPOTENT — checks for existing items by (name + BD folder) before
 * creating; updates props deep-equal style for re-runs.
 */

export const key = "2026-06-03-sharpshooter-b1-author";
export const description =
  "Sharpshooter B.1: full Ranged Weapon Mastery + stubs for Barrage, " +
  "Crossfire, Hawkeye, Warning Shot in the BD tree.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Sharpshooter";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const SKILL_SUBFOLDER = "Skill";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function findSkillSubfolder(game) {
  for (const f of game.folders?.contents ?? []) {
    if (f.name !== SKILL_SUBFOLDER) continue;
    const parent = f.folder;
    if (parent?.name !== CLASS_NAME) continue;
    const grand = parent.folder;
    if (grand?.name !== BD_ROOT_NAME) continue;
    if (grand.folder?.id ?? grand.folder) continue; // BD_ROOT must be top
    return f;
  }
  return null;
}

function findExistingInFolder(game, folder, name) {
  for (const item of game.items?.contents ?? []) {
    if (item.name !== name) continue;
    if (item.folder?.id !== folder.id) continue;
    return item;
  }
  return null;
}

// ── DATA ────────────────────────────────────────────────────────────────────

// Shared base props for every Sharpshooter skill — picks up the
// _Skill Template + class + the standard "Passive" defaults. Each
// per-skill author block overrides the fields it cares about.
const BASE_PROPS = {
  rolled_atr1: "-",
  rolled_atr2: "-",
  isCheck: false,
  isReaction: false,
  isFacet: false,
  isHeroic: false,
  isZeroPower: false,
  isOffensiveSpell: false,
  ignore_hr: false,
  class: CLASS_NAME,
  cost: "",
  skill_target: "-",
  skill_range: "",
  type_damage: "",
  damage_bonus: "0",
  check_bonus: "0",
  defense_target_type: "def",
  duration: "-",
  on_activate_effect_ref: "",
  reaction_config_table: {},
  effect_table: {},
  active_effect_config_table: {},
};

const SKILLS = [
  // ── 1. Ranged Weapon Mastery — FULL author ────────────────────────────
  {
    name: "Ranged Weapon Mastery",
    img: "icons/skills/ranged/target-bullseye-arrow-glowing.webp",
    props: {
      skill_type: "Passive",
      level: "1",
      max_level: "4",
      description:
        "<p>You gain a bonus equal to <strong>【SL】</strong> to all " +
        "Accuracy Checks with <strong>ranged</strong> weapons.</p>",
    },
    effects: [{
      name: "Ranged Weapon Mastery",
      transfer: true,
      disabled: false,
      duration: { startTime: null, seconds: null, rounds: null, turns: null, startRound: null, startTurn: null, type: "none", duration: null },
      statuses: [],
      changes: [
        {
          // `attack_accuracy_mod_ranged` is the CSB-derived prop the
          // engine routes through ranged attacks specifically (auto-
          // skipped on melee). Single global mod = level.
          key: "attack_accuracy_mod_ranged",
          value: "${level}$",
          mode: 2,
          priority: 1,
        },
      ],
      flags: {
        [MODULE_ID]: { directorPermanent: false, crossScene: false },
      },
      system: { tags: ["buff"] },
    }],
  },

  // ── 2. Barrage — STUB ──────────────────────────────────────────────────
  {
    name: "Barrage",
    img: "icons/skills/ranged/arrows-flying-salvo-blue.webp",
    props: {
      skill_type: "Active",
      level: "1",
      max_level: "1",
      cost: "10 MP",
      description:
        "<p>When you perform a <strong>ranged attack</strong>, you may " +
        "spend <strong>10 Mind Points</strong> to choose one option: " +
        "the attack gains <em>multi (2)</em>; or you increase the attack's " +
        "<em>multi</em> property by one, up to a maximum of <em>multi (3)</em>.</p>" +
        "<p><em>TODO (engine): needs an `modify_action_card_multi` effect_kind " +
        "to mutate the in-flight attack card's multi-pass count.</em></p>",
    },
    effects: [],
  },

  // ── 3. Crossfire — STUB ────────────────────────────────────────────────
  {
    name: "Crossfire",
    img: "icons/skills/ranged/arrows-volley-crossing-gray.webp",
    props: {
      skill_type: "Passive",
      isReaction: true,
      level: "1",
      max_level: "1",
      cost: "Variable MP",
      description:
        "<p>After a creature you can see performs a <strong>ranged attack</strong>, " +
        "you may spend an amount of Mind Points equal to the total Result " +
        "of their Accuracy Check in order to have the attack <strong>fail " +
        "automatically</strong> against all targets. You can only use this " +
        "Skill if you have a <strong>ranged weapon</strong> equipped, and " +
        "it has no effect if the Accuracy Check was a critical success.</p>" +
        "<p><em>TODO (engine): needs `creature_performs_ranged_attack` " +
        "trigger, `force_miss` effect_kind, and variable-cost-from-roll-result.</em></p>",
    },
    effects: [],
  },

  // ── 4. Hawkeye — STUB ──────────────────────────────────────────────────
  {
    name: "Hawkeye",
    img: "icons/skills/ranged/target-eye-orange.webp",
    props: {
      skill_type: "Passive",
      isReaction: true,
      level: "1",
      max_level: "5",
      description:
        "<p>When you perform the <strong>Guard</strong> action, if you choose " +
        "<strong>not</strong> to provide cover to another creature, you may " +
        "choose one option: the next <strong>ranged attack</strong> you " +
        "perform before the end of the current scene will deal <strong>" +
        "SL × 2 extra damage</strong>; or you may immediately perform a " +
        "<strong>free attack</strong> with a bow or firearm you have " +
        "equipped, treating your High Roll (HR) as 0 when calculating " +
        "damage dealt by this attack.</p>" +
        "<p><em>TODO (engine): uses creature_guards trigger with " +
        "DID_COVER_ALLY == 0 filter; needs `next_ranged_attack_bonus` " +
        "AE convention OR a free-attack grant via open_action_menu.</em></p>",
    },
    effects: [],
  },

  // ── 5. Warning Shot — STUB ─────────────────────────────────────────────
  {
    name: "Warning Shot",
    img: "icons/skills/ranged/arrow-strike-blue.webp",
    props: {
      skill_type: "Passive",
      isReaction: true,
      level: "1",
      max_level: "4",
      description:
        "<p>When you hit one or more targets with a <strong>ranged attack</strong> " +
        "that would deal damage, you may have the attack deal <strong>no " +
        "damage</strong>. If you do, choose one option: inflict <em>shaken</em> " +
        "on each target hit by the attack; or inflict <em>slow</em> on each " +
        "target hit by the attack; or each target hit by the attack loses " +
        "<strong>SL × 10 Mind Points</strong>. Describe your maneuver!</p>" +
        "<p><em>TODO (engine): needs `replace_damage_with_effects` card-mutation " +
        "kind (the in-flight attack's perTargetResults damage values get " +
        "zeroed and a status/MP-drain row is added per target).</em></p>",
    },
    effects: [],
  },
];

// ── DRIVER ──────────────────────────────────────────────────────────────────

async function ensureSkillItem(folder, spec, log) {
  const existing = findExistingInFolder(game, folder, spec.name);
  const wantProps = { ...BASE_PROPS, ...spec.props, name: spec.name, img: spec.img };

  if (!existing) {
    const data = {
      name: spec.name,
      img: spec.img,
      type: "skill",
      folder: folder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        props: wantProps,
      },
      effects: spec.effects ?? [],
    };
    const [created] = await Item.createDocuments([data]);
    log(`  created "${spec.name}" (id=${created?.id})`);
    return { item: created, created: true, propsTouched: true, effectsTouched: true };
  }

  // Update props if drifted
  const updates = {};
  for (const [k, v] of Object.entries(wantProps)) {
    if (!deepEqual(existing.system?.props?.[k], v)) {
      updates[`system.props.${k}`] = v;
    }
  }
  let propsTouched = false;
  if (Object.keys(updates).length) {
    await existing.update(updates);
    propsTouched = true;
    log(`  updated "${spec.name}" props (${Object.keys(updates).map(k => k.replace("system.props.", "")).join(", ")})`);
  }

  // Update embedded AEs (Ranged Weapon Mastery only)
  let effectsTouched = false;
  for (const aeSpec of spec.effects ?? []) {
    const ae = existing.effects?.contents?.find((e) => e.name === aeSpec.name);
    if (!ae) {
      await existing.createEmbeddedDocuments("ActiveEffect", [aeSpec]);
      effectsTouched = true;
      log(`  created AE "${aeSpec.name}" on "${spec.name}"`);
      continue;
    }
    const needs =
      !deepEqual(ae.changes ?? [], aeSpec.changes ?? []) ||
      !deepEqual(Array.from(ae.statuses ?? []), aeSpec.statuses ?? []) ||
      ae.transfer !== aeSpec.transfer ||
      !deepEqual(ae.flags?.[MODULE_ID] ?? {}, aeSpec.flags?.[MODULE_ID] ?? {});
    if (needs) {
      await ae.update({
        transfer: aeSpec.transfer,
        duration: aeSpec.duration,
        changes: aeSpec.changes,
        statuses: aeSpec.statuses,
        flags: aeSpec.flags,
        system: aeSpec.system,
      });
      effectsTouched = true;
      log(`  normalised AE "${aeSpec.name}" on "${spec.name}"`);
    }
  }

  return { item: existing, created: false, propsTouched, effectsTouched };
}

export async function migrate(game, log) {
  const folder = findSkillSubfolder(game);
  if (!folder) {
    log("  Sharpshooter / Skill subfolder not found in BD tree — skipping author");
    return { applied: false, summary: "BD Sharpshooter folder missing" };
  }
  let created = 0;
  let updated = 0;
  for (const spec of SKILLS) {
    const r = await ensureSkillItem(folder, spec, log);
    if (r.created) created += 1;
    else if (r.propsTouched || r.effectsTouched) updated += 1;
  }
  return {
    applied: true,
    summary: `Sharpshooter B.1: ${created} created, ${updated} updated`,
  };
}
