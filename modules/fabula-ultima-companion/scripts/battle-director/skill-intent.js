// Action intent classifier — director-native equivalent of the legacy
// ADC `meta.actionIntent` inference. Priority order from the schema doc
// (docs/reaction-config-schema.md §"actionIntent inference"):
//
//   1. Explicit override:        skill.system.props.action_intent
//                                  ("harmful" | "aid" | "neutral"; blank = auto)
//   2. Weapon attacks            → "harmful" (handled by Attack flow, not here)
//   3. skill_type === "Attack"   → "harmful"
//   4. isOffensiveSpell          → "harmful"
//   4b. isOffensive              → "harmful"  (non-spell offensive Checks
//                                  like Soul Steal — opposed Check vs
//                                  defense without dealing damage)
//   5. declares healing (HP/MP)  → "aid"
//   6. has damage + !healing     → "harmful"
//   7. skill_type === "Spell"    → "aid"
//   8. skill_type === "Active"
//      without damage            → "aid"
//   9. Passive / Item / Other    → "neutral"
//
// "neutral" deliberately fails the `reaction_action_intent` filters
// `harmful` and `aid` — reactions opt in. Authors of edge-case skills
// pin the classification via `action_intent` override.

import { warn } from "./logger.js";

const VALID_INTENTS = new Set(["harmful", "aid", "neutral"]);

// Damage-type strings that mean "this restores a resource" rather than
// inflicting harm. Healing / hp / mp variants cover the wild — the CSB
// template's `type_damage` dropdown isn't strict, so authors mix forms.
const HEALING_TYPES = new Set([
  "healing", "heal",
  "hp_heal", "mp_heal",
  "hp", "mp",  // bare resource names sometimes used for recovery skills
  "recovery",
]);

// Damage-type strings that mean "no damage at all" — skill has the field
// set to something semantic that isn't a real element.
const NONDAMAGING_TYPES = new Set(["", "none", "n/a", "-", "any", "no", "support"]);

function readBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

// Public — classify a skill item. Returns "harmful" | "aid" | "neutral".
// Pass the skill Item; reads only from `system.props.*`.
export function classifyActionIntent(skill) {
  if (!skill) return "neutral";
  const p = skill.system?.props ?? {};

  // 1. Explicit override.
  const override = String(p.action_intent ?? "").trim().toLowerCase();
  if (VALID_INTENTS.has(override)) return override;

  const skillType = String(p.skill_type ?? "").trim().toLowerCase();
  const damageType = String(p.type_damage ?? "").trim().toLowerCase();

  // 3. skill_type Attack.
  if (skillType === "attack") return "harmful";

  // 4. Offensive spell.
  if (readBool(p.isOffensiveSpell)) return "harmful";

  // 4b. Generic offensive flag — for non-spell Checks that target an
  //     enemy's defense without dealing direct damage (Soul Steal:
  //     DEX+WLP vs MDEF, grants caster IP on hit). Without this,
  //     classifyActionIntent's downstream steps see "Active skill, no
  //     damage" and classify as "aid", routing composeAction to the
  //     ally list. Authors set isOffensive=true on such skills.
  if (readBool(p.isOffensive)) return "harmful";

  // 5. Declares healing.
  const declaresHealing = HEALING_TYPES.has(damageType) || hasAidGrant(skill);
  if (declaresHealing) return "aid";

  // 6. Has a damage section (typed damage that isn't healing/none) → harmful.
  //    Also covers MP-burn style skills (type_damage="mp" without grant_target
  //    handled via explicit override — same as legacy).
  const hasDamage = damageType && !NONDAMAGING_TYPES.has(damageType);
  if (hasDamage) return "harmful";

  // 6b. No damage, but targets enemies and applies an ActiveEffect → harmful.
  //     This is the durable replacement for hand-set `action_intent: "harmful"`
  //     on no-damage debuff skills (Fafnir Dreadwyrm Descent / Torment): they
  //     inflict Frightened/Paralyzed/Silence via apply_ae with no damage prop.
  //     `skill_target` is a real template FIELD and `effect_table` is
  //     dynamic-table DATA — both survive templateSystem.reloadTemplate(),
  //     unlike the non-template `action_intent` prop (which reload strips).
  const targetsEnemies = /enemy/i.test(String(p.skill_target ?? ""));
  if (targetsEnemies && hasApplyAe(skill)) return "harmful";

  // 7. Non-offensive spell → aid.
  if (skillType === "spell") return "aid";

  // 8. Active without damage → aid.
  if (skillType === "active") return "aid";

  // 9. Everything else (Passive / Item / Other / blank) → neutral.
  return "neutral";
}

// Look at the skill's effect_table for a grant row that restores HP or
// MP — used by step 5 to detect "declares healing" even when type_damage
// isn't set (some healing skills carry no damage prop and rely on
// effect_table to surface the heal).
//
// Returns true iff a grant row exists with grant_resource in {hp, mp}
// and grant_amount > 0 (literal). Formula amounts can't be statically
// classified — author should set `action_intent: "aid"` for those.
function hasAidGrant(skill) {
  const table = skill?.system?.props?.effect_table
            ?? skill?.system?.props?.reaction_effect_table  // legacy alias
            ?? null;
  if (!table) return false;
  // Tables are CSB-keyed objects ({ "0": {...}, "1": {...}, ... }) with
  // a `$deleted: true` marker on dead rows.
  for (const key of Object.keys(table)) {
    const row = table[key];
    if (!row || row.$deleted) continue;
    if (row.effect_kind !== "grant") continue;
    const resource = String(row.grant_resource ?? "").toLowerCase();
    if (resource !== "hp" && resource !== "mp") continue;
    // Treat literal positive numbers as aid. Formula amounts are too
    // varied to classify statically (could be `-CUR_HP`, etc.).
    const amt = row.grant_amount;
    if (typeof amt === "number" && amt > 0) return true;
    if (typeof amt === "string") {
      const n = Number(amt);
      if (Number.isFinite(n) && n > 0) return true;
    }
  }
  return false;
}

// Look at the skill's effect_table for an apply_ae row — used by step 6b to
// detect "inflicts a status/effect" on no-damage skills. Mirrors hasAidGrant:
// walks the CSB-keyed table, skips $deleted rows, matches effect_kind apply_ae.
// (reaction_effect_table is the legacy alias for the same table.)
function hasApplyAe(skill) {
  const table = skill?.system?.props?.effect_table
            ?? skill?.system?.props?.reaction_effect_table  // legacy alias
            ?? null;
  if (!table) return false;
  for (const key of Object.keys(table)) {
    const row = table[key];
    if (!row || row.$deleted) continue;
    if (row.effect_kind === "apply_ae") return true;
  }
  return false;
}
