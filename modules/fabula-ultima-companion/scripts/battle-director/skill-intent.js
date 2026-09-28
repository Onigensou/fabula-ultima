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
// Target refs that resolve to the CASTER'S side of the action, never to the
// creatures the action is aimed at.
const SELF_ONLY_REFS = new Set(["self", "own_summons", "own_phantasms", "own_persistent_summons", "own_minions", "own_numen", "last_summoned", "field"]);
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
    // A grant the action's TARGETS never receive says nothing about how the
    // action treats them. "On hit, the caster gains 20 MP" (Element Gorge,
    // Soul Steal's IP) is a rider on a hostile check, not aid — classifying
    // it as aid routes the compose picker to the ALLY list and hides the bite
    // from every `reaction_action_intent: "harmful"` defender reaction.
    if (SELF_ONLY_REFS.has(String(row.target_ref ?? "").trim().toLowerCase())) continue;
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

// ── Action tags that APPLY to one action (scoped skill_tags) ─────────────────
// `skill_tags` tokens are plain ("potion") or SCOPED to a pre_activate path
// ("potion@alc_mix"): a scoped tag applies only when the captured pre-card
// choices REACHED that effect row — a menu row that was opened, or an option row
// that was picked (plus the chain steps under it). This lets one menu-parent
// skill (Tinkerer Gadgets) carry per-branch identity: its Alchemy branch is a
// potion and an Inventory action, its Magitech Override branch is neither.
// Readers that do not know about scoping (SKILL_HAS_TAG_* on a raw prop) never
// match a scoped token, so an unreached tag fails CLOSED.
//
// The reserved tag INVENTORY_ACTION_TAG ("inventory") is the "counts as an
// Inventory action too" knob (user ruling 2026-09-28, Tinkerer Alchemy: "a skill
// that counts as Inventory action — both skill blocking AND inventory blocking
// effects block it"). State-handlers stamps `ar.countsAsItem` from it; the
// Item-action seams (Item-block refusal, creature_uses_item /
// creature_completes_item, item restore bonus, item damage bonus) read that flag.
export const INVENTORY_ACTION_TAG = "inventory";

const _splitTags = (raw) => String(raw ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);

// Tag names a skill CAN carry, scope stripped (picker allow-lists: a skill with
// "inventory@alc_mix" qualifies for a `tag:inventory` free action; which branch
// is then legal is re-checked at COMPUTE against resolveActionTags).
export function skillTagNames(skillOrProps) {
  const p = skillOrProps?.system?.props ?? skillOrProps ?? {};
  return [...new Set(_splitTags(p.skill_tags).map((t) => t.split("@")[0]).filter(Boolean))];
}

// Effect labels the captured pre_activate choices reached. `menuPicks` is
// ar.preActivateMenuPicks ({ <menu effect_label>: [picked option label, …] }).
export function reachedPreActivateLabels(effectTable, menuPicks) {
  const reached = new Set();
  if (!menuPicks || typeof menuPicks !== "object") return reached;
  const byLabel = new Map();
  for (const r of Object.values(effectTable ?? {})) {
    if (!r || r.$deleted) continue;
    const l = String(r.effect_label ?? "").trim();
    if (l) byLabel.set(l, r);
  }
  const splitRefs = (raw) => String(raw ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const walkChain = (lbl, depth = 0) => {
    if (!lbl || depth > 20) return;
    reached.add(lbl);
    const row = byLabel.get(lbl);
    if (row && String(row.effect_kind ?? "").trim().toLowerCase() === "chain") {
      for (const s of splitRefs(row.chain_steps)) if (!reached.has(s)) walkChain(s, depth + 1);
    }
  };
  // Option row of `menu` whose label (authored |-list label, menu_label,
  // effect_label or ref) matches `pick` (lower-cased).
  const optionFor = (menu, pick) => {
    const refs = splitRefs(menu?.menu_option_refs);
    const labels = String(menu?.menu_option_labels ?? "").split("|").map((s) => s.trim().toLowerCase());
    for (let i = 0; i < refs.length; i++) {
      const orow = byLabel.get(refs[i]);
      const cands = [labels[i], orow?.menu_label, orow?.effect_label, refs[i]]
        .map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean);
      if (cands.includes(pick)) return refs[i];
    }
    return null;
  };
  // A nested menu's picks are recorded under the SYNTHETIC key the dispatcher
  // gives an option row — "<parent menu label>:<picked option label>" (possibly
  // several levels deep). Resolve such a key back to the real row.
  const resolveKey = (key) => {
    if (byLabel.has(key)) return key;
    const parts = String(key).split(":");
    let cur = parts[0];
    for (let i = 1; i < parts.length && cur; i++) cur = optionFor(byLabel.get(cur), parts[i].trim().toLowerCase());
    return cur && byLabel.has(cur) ? cur : null;
  };
  for (const [menuKey, picks] of Object.entries(menuPicks)) {
    const menuLabel = resolveKey(menuKey);
    reached.add(menuKey);
    if (!menuLabel) continue;
    reached.add(menuLabel);
    const menu = byLabel.get(menuLabel);
    if (!menu) continue;
    const want = new Set((Array.isArray(picks) ? picks : []).map((p) => String(p).trim().toLowerCase()));
    const refs = splitRefs(menu.menu_option_refs);
    const labels = String(menu.menu_option_labels ?? "").split("|").map((s) => s.trim().toLowerCase());
    refs.forEach((oref, i) => {
      const orow = byLabel.get(oref);
      const cands = [orow?.menu_label, orow?.effect_label, oref, labels[i]]
        .map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean);
      if (cands.some((c) => want.has(c))) walkChain(oref);
    });
  }
  return reached;
}

// The tags that apply to THIS action: every plain tag, plus each scoped tag
// whose scope row was reached. Lower-cased, de-duplicated.
export function resolveActionTags(skill, { effectTable = null, menuPicks = null } = {}) {
  const p = skill?.system?.props ?? {};
  const tokens = _splitTags(p.skill_tags);
  if (!tokens.some((t) => t.includes("@"))) return [...new Set(tokens)];
  const reached = reachedPreActivateLabels(effectTable ?? p.effect_table ?? {}, menuPicks);
  const reachedLc = new Set([...reached].map((l) => l.toLowerCase()));
  const out = new Set();
  for (const t of tokens) {
    const at = t.indexOf("@");
    if (at < 0) { out.add(t); continue; }
    const tag = t.slice(0, at);
    const scope = t.slice(at + 1);
    if (tag && reachedLc.has(scope)) out.add(tag);
  }
  return [...out];
}
