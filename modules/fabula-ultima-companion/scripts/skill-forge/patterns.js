// [ONI] Skill Forge — pattern library.
// ---------------------------------------------------------------------------
// STAGE 2. The piece that actually makes a non-programmer productive.
//
// A pattern is a named shape with a handful of blanks. Pick "deal damage to one
// enemy", fill three fields, and it expands to the canonical multi-row
// `effect_table` the engine expects — with the canon's decision tree already
// resolved, so the author never has to answer "does this go in a reaction row,
// an effect row, a legacy field, or an AE?".
//
// WHY PATTERNS BEAT A ROW EDITOR FOR MOST WORK
//   The corpus is heavily skewed: apply_ae 232 rows, chain 131, grant 79,
//   targeting 57, open_action_menu 41 — and a long tail in single digits. The
//   same half-dozen shapes account for most authored content, so ~15 recipes
//   cover most of what anyone wants to make. Falling off a pattern into the raw
//   graph stays the expert path, not the default one.
//
// ⚠ EXPANSION HAPPENS AT AUTHOR TIME, NOT ACTION TIME.
//   `skill-recipes.js` (B.1) took the other approach: it stores 3-4 slim props
//   and synthesises the rows during dispatch. That keeps the document small but
//   makes it INVISIBLE — the lint, skill-claims, world-export and this
//   project's own validator all read `system.props`, so a recipe-shaped skill
//   reads as empty to every one of them. Patterns here emit REAL rows, so every
//   downstream tool sees exactly what the engine will run. The cost is a larger
//   document; the benefit is that nothing downstream goes blind.
//
// CONTRACT
//   expand(values) returns a `system.props` FRAGMENT — plain data, no writes.
//   Every pattern's output must pass the skill validator with zero findings.
//   That is the suite's job, and it is what lets a pattern be trusted without
//   opening the game.

// ── helpers ─────────────────────────────────────────────────────────────────

/** CSB dynamic tables are objects keyed "0", "1", … — not arrays. */
function table(rows) {
  const out = {};
  rows.forEach((r, i) => { out[String(i)] = r; });
  return out;
}

/**
 * A targeting row — the thing every other row points `target_ref` at.
 *
 * `candidate_source: "combat"` + a category is the standard "pick from the
 * battlefield" shape. `mode: "all"` ignores `count`.
 */
function targeting(label, { category = "enemy", mode = "exact", count = 1, excludeSelf = false } = {}) {
  const row = {
    effect_kind: "targeting", effect_label: label,
    candidate_source: "combat", category, mode,
    auto_confirm_when_obvious: true,
  };
  if (mode !== "all") row.count = String(count);
  if (excludeSelf) row.exclude_self = true;
  return row;
}

/** A self-targeting row. Used by anything that acts on the performer. */
function selfTarget(label) {
  return {
    effect_kind: "targeting", effect_label: label,
    candidate_source: "self", mode: "exact", count: "1",
    auto_confirm_when_obvious: true, skip_when_passive: true,
  };
}

/** The chain that `on_activate_effect_ref` points at. */
function chain(label, steps) {
  return { effect_kind: "chain", effect_label: label, chain_steps: steps.join(", ") };
}

const ELEMENTS = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];
const RESOURCES = ["hp", "mp", "ip"];

// Field kinds the UI renders. `element` and `resource` are closed lists, so a
// pattern cannot produce an element the damage pipeline does not know.
const F = {
  text:     (key, label, opts = {}) => ({ key, label, kind: "text", ...opts }),
  number:   (key, label, opts = {}) => ({ key, label, kind: "number", ...opts }),
  element:  (key, label, opts = {}) => ({ key, label, kind: "choice", options: ELEMENTS, ...opts }),
  resource: (key, label, opts = {}) => ({ key, label, kind: "choice", options: RESOURCES, ...opts }),
  choice:   (key, label, options, opts = {}) => ({ key, label, kind: "choice", options, ...opts }),
  bool:     (key, label, opts = {}) => ({ key, label, kind: "boolean", ...opts }),
};

// ── the patterns ────────────────────────────────────────────────────────────
//
// `command` is the turn-menu blade this pattern belongs under. It is recorded
// now even though `action_command` is not yet a declared template field (see
// docs/action-command-taxonomy-proposal.md) — the pattern list is indexed BY
// command, which is precisely why that taxonomy blocks this stage from being
// finished properly. Patterns emit it; it becomes load-bearing once declared.

export const PATTERNS = [
  {
    id: "damage_one_enemy",
    label: "Deal damage to one enemy",
    blurb: "A single-target damaging skill. The player picks one enemy.",
    command: "skill",
    fields: [
      F.number("amount", "Damage", { default: 10 }),
      F.element("element", "Damage type", { default: "physical" }),
      F.text("cost", "Cost (e.g. “10 MP”)", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "One Enemy",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "enemy" }),
        { effect_kind: "deal_damage", effect_label: "hit", target_ref: "tgt",
          damage_amount: String(v.amount), damage_element: v.element },
        chain("root", ["hit"]),
      ]),
    }),
  },
  {
    id: "damage_all_enemies",
    label: "Deal damage to every enemy",
    blurb: "An area attack. No target picking — it hits the whole enemy side.",
    command: "skill",
    fields: [
      F.number("amount", "Damage", { default: 10 }),
      F.element("element", "Damage type", { default: "fire" }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "All Enemy",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "enemy", mode: "all" }),
        { effect_kind: "deal_damage", effect_label: "hit", target_ref: "tgt",
          damage_amount: String(v.amount), damage_element: v.element },
        chain("root", ["hit"]),
      ]),
    }),
  },
  {
    id: "heal_ally",
    label: "Heal one ally",
    blurb: "Restore a resource to a chosen ally.",
    command: "skill",
    fields: [
      F.resource("resource", "Restore", { default: "hp" }),
      F.number("amount", "Amount", { default: 30 }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "One Ally",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "ally" }),
        { effect_kind: "grant", effect_label: "heal", target_ref: "tgt",
          grant_resource: v.resource, grant_amount: String(v.amount) },
        chain("root", ["heal"]),
      ]),
    }),
  },
  {
    id: "restore_self",
    label: "Restore a resource to myself",
    blurb: "Acts on the performer. No target picking.",
    command: "skill",
    fields: [
      F.resource("resource", "Restore", { default: "mp" }),
      F.number("amount", "Amount", { default: 20 }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "Self",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        selfTarget("me"),
        { effect_kind: "grant", effect_label: "gain", target_ref: "me",
          grant_resource: v.resource, grant_amount: String(v.amount) },
        chain("root", ["gain"]),
      ]),
    }),
  },
  {
    id: "status_to_enemy",
    label: "Inflict a status on one enemy",
    blurb: "Applies a named status effect from the status hub.",
    command: "skill",
    fields: [
      F.text("status", "Status name (e.g. “Poisoned”)", { default: "Poisoned" }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "One Enemy",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "enemy" }),
        { effect_kind: "apply_ae", effect_label: "inflict", target_ref: "tgt",
          ae_template_ref: v.status },
        chain("root", ["inflict"]),
      ]),
    }),
  },
  {
    id: "buff_self",
    label: "Apply a temporary effect to myself",
    blurb: "A self-buff that lasts a number of rounds.",
    command: "skill",
    fields: [
      F.text("effect", "Effect name", { default: "" }),
      F.number("rounds", "Lasts (rounds)", { default: 3 }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "Self",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        selfTarget("me"),
        { effect_kind: "apply_ae", effect_label: "buff", target_ref: "me",
          ae_template_ref: v.effect, ae_duration_rounds: String(v.rounds) },
        chain("root", ["buff"]),
      ]),
    }),
  },
  {
    id: "buff_ally",
    label: "Apply a temporary effect to one ally",
    blurb: "Same as the self-buff, but the player picks who gets it.",
    command: "skill",
    fields: [
      F.text("effect", "Effect name", { default: "" }),
      F.number("rounds", "Lasts (rounds)", { default: 3 }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "One Ally",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "ally" }),
        { effect_kind: "apply_ae", effect_label: "buff", target_ref: "tgt",
          ae_template_ref: v.effect, ae_duration_rounds: String(v.rounds) },
        chain("root", ["buff"]),
      ]),
    }),
  },
  {
    id: "cleanse_ally",
    label: "Remove status effects from one ally",
    blurb: "Clears effects carrying a tag — the Cleanse shape.",
    command: "skill",
    fields: [
      F.choice("tag", "Remove effects tagged", ["debuff", "buff"], { default: "debuff" }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "One Ally",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "ally" }),
        { effect_kind: "remove_ae", effect_label: "clear", target_ref: "tgt",
          filter_tag: v.tag },
        chain("root", ["clear"]),
      ]),
    }),
  },
  {
    id: "pay_then_free_action",
    label: "Pay a cost, then take a free action",
    blurb: "Spend a resource to act again — the High Speed shape.",
    command: "skill",
    fields: [
      F.resource("resource", "Spend", { default: "mp" }),
      F.number("amount", "Amount", { default: 10 }),
      F.text("allowed", "Limit the free action to (blank = any)", { default: "Attack", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "Self",
      on_activate_effect_ref: "root",
      effect_table: table([
        selfTarget("me"),
        { effect_kind: "consume_resource", effect_label: "pay", target_ref: "me",
          consume_resource: v.resource, consume_amount: String(v.amount), on_empty: "abort" },
        { effect_kind: "free_action", effect_label: "act", free_mode: true,
          allowed_types: v.allowed ?? "" },
        chain("root", ["pay", "act"]),
      ]),
    }),
  },
  {
    id: "choice_of_two",
    label: "Offer the player a choice of two effects",
    blurb: "Opens a menu; the player picks one option.",
    command: "skill",
    fields: [
      F.text("labelA", "First option label", { default: "Option A" }),
      F.text("effectA", "First option: status to apply", { default: "" }),
      F.text("labelB", "Second option label", { default: "Option B" }),
      F.text("effectB", "Second option: status to apply", { default: "" }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "One Enemy",
      on_activate_effect_ref: "root",
      effect_table: table([
        targeting("tgt", { category: "enemy" }),
        { effect_kind: "apply_ae", effect_label: "optA", target_ref: "tgt", ae_template_ref: v.effectA },
        { effect_kind: "apply_ae", effect_label: "optB", target_ref: "tgt", ae_template_ref: v.effectB },
        { effect_kind: "open_action_menu", effect_label: "pick",
          menu_title: "Choose one", menu_option_refs: "optA, optB",
          menu_option_labels: `${v.labelA}|${v.labelB}`, menu_pick_count: "1" },
        chain("root", ["pick"]),
      ]),
    }),
  },
  {
    id: "summon_creature",
    label: "Summon a creature",
    blurb: "Spawns an actor that acts on its own turns.",
    command: "skill",
    fields: [
      F.text("actor", "Actor name to summon", { default: "" }),
      F.number("count", "How many", { default: 1 }),
      F.text("cost", "Cost", { default: "", optional: true }),
    ],
    expand: (v) => ({
      skill_type: "Active",
      skill_target: "Self",
      cost: v.cost ?? "",
      on_activate_effect_ref: "root",
      effect_table: table([
        selfTarget("me"),
        { effect_kind: "summon", effect_label: "call", target_ref: "me",
          summon_actor: v.actor, summon_count: String(v.count) },
        chain("root", ["call"]),
      ]),
    }),
  },

  // ── reaction-shaped patterns ────────────────────────────────────────────
  // These carry `isReaction: true` plus a reaction_config_table row. Per the
  // canon, cost on a reaction is DISPLAY ONLY — the chain does the debit — so
  // these patterns never put a cost string on a reaction.
  {
    id: "react_when_hit",
    label: "React when I am hit: reduce the damage",
    blurb: "A defensive rider. Fires on the action card before damage lands.",
    command: "skill",
    fields: [
      F.number("amount", "Reduce damage by", { default: 5 }),
      F.choice("mode", "How the player decides", ["ask", "on"], { default: "ask" }),
    ],
    expand: (v) => ({
      skill_type: "Passive",
      skill_target: "Self",
      isReaction: true,
      effect_table: table([
        { effect_kind: "adjust_damage", effect_label: "soak",
          damage_amount: String(v.amount), damage_operation: "subtract" },
      ]),
      reaction_config_table: table([
        { reaction_trigger: "creature_targeted_by_action", reaction_effect_ref: "soak",
          reaction_passive_mode: v.mode, reaction_passive_target: "self", reaction_source: "" },
      ]),
    }),
  },
  {
    id: "react_when_i_deal_damage",
    label: "React when I deal damage: add more",
    blurb: "An offensive rider folded into the card before it resolves.",
    command: "skill",
    fields: [
      F.number("amount", "Extra damage", { default: 5 }),
      F.choice("mode", "How the player decides", ["ask", "on"], { default: "on" }),
    ],
    expand: (v) => ({
      skill_type: "Passive",
      skill_target: "Self",
      isReaction: true,
      effect_table: table([
        { effect_kind: "adjust_damage", effect_label: "rider",
          damage_amount: String(v.amount), damage_operation: "add" },
      ]),
      reaction_config_table: table([
        { reaction_trigger: "creature_will_deal_damage", reaction_effect_ref: "rider",
          reaction_passive_mode: v.mode, reaction_passive_target: "self", reaction_source: "self" },
      ]),
    }),
  },
  {
    id: "at_conflict_start",
    label: "Do something when the battle starts",
    blurb: "Fires once at conflict start, before the first round.",
    command: "skill",
    fields: [
      F.text("effect", "Effect to apply to myself", { default: "" }),
      F.choice("mode", "How the player decides", ["ask", "on", "force"], { default: "ask" }),
    ],
    expand: (v) => ({
      skill_type: "Passive",
      skill_target: "Self",
      isReaction: true,
      effect_table: table([
        selfTarget("me"),
        { effect_kind: "apply_ae", effect_label: "boon", target_ref: "me",
          ae_template_ref: v.effect },
        chain("start", ["boon"]),
      ]),
      reaction_config_table: table([
        { reaction_trigger: "conflict_start", reaction_effect_ref: "start",
          reaction_passive_mode: v.mode, reaction_passive_target: "self", reaction_source: "" },
      ]),
    }),
  },
  {
    id: "passive_bonus",
    label: "A permanent bonus while I know this skill",
    blurb:
      "A TRUE passive — no trigger, no cost, always on. Carried by an Active " +
      "Effect on the skill itself, which Foundry applies to the bearer.",
    command: "passive",
    fields: [
      F.text("stat", "Bonus to (CSB column, e.g. “bonus_defense”)", { default: "bonus_defense" }),
      F.text("value", "Amount (a number, or ${level}$ to scale with skill level)", { default: "${level}$" }),
    ],
    // Canon rule 5: a true passive is a transfer:true AE with no duration and
    // NO reaction_config_table — wiring a turn_start trigger to apply a self-AE
    // wastes a dispatch on something that should just BE.
    expand: (v) => ({
      skill_type: "Passive",
      skill_target: "Self",
      __effects: [{
        name: "__SKILL_NAME__",
        transfer: true,
        disabled: false,
        duration: {},
        changes: [{ key: v.stat, value: String(v.value), mode: 2, priority: 20 }],
        system: { tags: ["buff"] },
      }],
    }),
  },
];

export const PATTERNS_BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

/** Patterns grouped by the turn-menu command they belong to. */
export function patternsByCommand() {
  const out = new Map();
  for (const p of PATTERNS) {
    if (!out.has(p.command)) out.set(p.command, []);
    out.get(p.command).push(p);
  }
  return out;
}

/** Defaults for a pattern's fields — what the UI opens with. */
export function defaultsFor(patternId) {
  const p = PATTERNS_BY_ID.get(patternId);
  if (!p) return null;
  const v = {};
  for (const f of p.fields) v[f.key] = f.default ?? (f.kind === "number" ? 0 : "");
  return v;
}

/**
 * Expand a pattern to a `system.props` fragment (+ optional `__effects`).
 *
 * Returns `{ props, effects, missing }`. `missing` names any non-optional field
 * left blank — the UI blocks on it rather than emitting a row the engine will
 * silently refuse (a `grant` with no resource, an `apply_ae` with no template).
 */
export function expand(patternId, values = {}) {
  const p = PATTERNS_BY_ID.get(patternId);
  if (!p) return { props: null, effects: [], missing: [], error: `unknown pattern "${patternId}"` };

  const v = { ...defaultsFor(patternId), ...values };
  const missing = p.fields
    .filter((f) => !f.optional)
    .filter((f) => v[f.key] === undefined || String(v[f.key]).trim() === "")
    .map((f) => f.label);

  const raw = p.expand(v);
  const effects = raw.__effects ?? [];
  const props = { ...raw };
  delete props.__effects;
  // Always set these; leaving them to the template default is how a skill ends
  // up at max_level 1 when it has a real progression (canon: set explicitly).
  props.level = props.level ?? 1;
  props.max_level = props.max_level ?? 1;
  return { props, effects, missing, command: p.command };
}
