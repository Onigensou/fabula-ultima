/**
 * Migration: 2026-08-31-objective-common-author  (Objective action, Phase 2)
 * ---------------------------------------------------------------------------
 * Author the seeded **Objective** options under `Battle Director / Common`.
 *
 * An Objective option is an ordinary CSB skill Item identified by the stable
 * flag `flags["fabula-ultima-companion"].coreAction = "objective:<id>"`. The
 * "objective:" prefix is what keeps `getCoreActionSkill()` from ever matching
 * one — it looks for a bare command name.
 *
 * Scope + availability ride FLAGS, not system.props:
 *
 *   objectiveScope       all | pc | npc | none   ("none" = grant-only)
 *   objectiveGate        formula; falsy dims the row
 *   objectiveGateReason  the dim label
 *
 * They have no column on the shared `_Skill Template`, and a props key with no
 * column can be dropped by a template re-stamp. See objectives.js.
 *
 * ── Run Away ───────────────────────────────────────────────────────────────
 * The whole party rolls a DEX + INS Group Check with the runner as leader; each
 * helper success grants the leader +1. On a pass the party escapes: the conflict
 * is stamped `escaped` and every party member leaves. No rewards.
 *
 * DL is a ladder over the level gap (GAP = enemy average − party average):
 *
 *     7 + 3*(GAP >= 1) + 3*(GAP >= 10)     →   ≤0 : 7 Easy
 *                                              1–9 : 10 Standard
 *                                              ≥10 : 13 Hard
 *
 * The formula language has no ternary, but comparisons return 1/0, so the ladder
 * is plain arithmetic.
 *
 * 🪤 ROW ORDER IS LOAD-BEARING. `set_battle_outcome` must run BEFORE the
 * `leave_combat` that empties the party side: removeCombatant calls
 * checkSideWipe synchronously, and an emptied party side otherwise falls through
 * detectOutcome to "victory" — handing a fleeing party the full reward prompt.
 *
 * 🪤 gc_timeout is NOT optional here. Without it a Group Check driven from
 * automation waits forever on a participant whose owner is offline, and that is
 * the normal case (party actors are resolved from the combat, not from who is
 * logged in). 20s matches CONFIRM_TIMEOUT_MS in the clock system.
 *
 * Bosses block escape via `objectiveGate: ENEMY_BOSS_COUNT == 0`. A battle plan
 * can override either way with objectiveAllow / objectiveDeny.
 *
 * ── Custom Objective ───────────────────────────────────────────────────────
 * RAW Core p.72: the GM decides the Attributes and DL from the player's
 * description. `check_mode: "open"` with no authored pair leaves COMPUTE to ask.
 * This retires macros/Command Buttons/[Macro] Objective.js, which was exactly
 * that dialog and nothing else.
 *
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill } from "./_action-skill-author.js";

export const key = "2026-08-31-objective-common-author";
export const description =
  "Author Battle Director/Common Objective options: Run Away (DEX+INS Group Check, " +
  "level-gap DL ladder, escaped outcome), Custom Objective (RAW p.72 open check), " +
  "and Clock Interaction (dynamic clock menu, roll-mode advance).";

const SK_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/";

// GAP = ENEMY_AVG_LEVEL - PARTY_AVG_LEVEL. See the header for the tier table.
const RUN_DL_LADDER =
  "7 + 3*((ENEMY_AVG_LEVEL - PARTY_AVG_LEVEL) >= 1) + 3*((ENEMY_AVG_LEVEL - PARTY_AVG_LEVEL) >= 10)";

const RUN_AWAY = {
  coreAction: "objective:run",
  name: "Run Away",
  img: SK_ICON + "09_NIN/shade_shift.png",
  flags: {
    objectiveScope: "pc",
    objectiveGate: "ENEMY_BOSS_COUNT == 0",
    objectiveGateReason: "There's no escaping this one",
  },
  props: {
    skill_type: "Active",
    isCheck: false,          // the Group Check IS the roll; no second action check
    isReaction: false,
    skill_target: "Self",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "run_root",
    description:
      "<p>The whole party attempts to flee. Everyone rolls a <strong>【DEX + INS】</strong> " +
      "Group Check with you as the leader — each ally who succeeds grants you +1. " +
      "On a success the party escapes the conflict.</p>" +
      "<p>The Difficulty Level rises with how far the enemy outclasses you. " +
      "<em>You gain no experience, no Zenit and no spoils from a battle you ran from.</em></p>",
    effect_table: {
      // The entry point. Only a `chain` row sequences other rows — a non-chain
      // root fires exactly once (applyEffectByLabel → applyEffectRow), so the
      // steps must be listed here.
      //
      // `run_party_pool` is deliberately NOT a step: a targeting row is resolved
      // lazily by whoever names it in `target_ref`, and the result is memoized on
      // the chain ctx, so the pool is built once and both consumers see the same
      // tokens.
      "0": {
        effect_label: "run_root",
        effect_kind: "chain",
        chain_steps: "run_check, run_mark_escaped, run_leave",
      },
      // Who takes part — the whole party INCLUDING the runner, who leads.
      // `exclude_self` MUST stay false or `gc_leader: "self"` cannot resolve to a
      // participant and the engine silently re-leaders to the best roller.
      "1": {
        effect_label: "run_party_pool",
        effect_kind: "targeting",
        candidate_source: "combat",
        category: "ally",
        mode: "all",
        exclude_self: false,
      },
      // The Group Check. Leader = the runner; each helper success gives +1.
      "2": {
        effect_label: "run_check",
        effect_kind: "group_check",
        target_ref: "run_party_pool",
        gc_attr1: "dex",
        gc_attr2: "ins",
        gc_leader: "self",
        gc_dl: RUN_DL_LADDER,
        gc_helper_bonus: "1",
        gc_timeout: "20000",
        gc_on_error: "fail",
        gc_var: "ESCAPE",
      },
      // Stamp the outcome BEFORE anyone leaves. See the header trap note.
      "3": {
        effect_label: "run_mark_escaped",
        effect_kind: "set_battle_outcome",
        outcome_value: "escaped",
        condition_formula: "VAR_ESCAPE == 1",
      },
      // The party withdraws.
      "4": {
        effect_label: "run_leave",
        effect_kind: "leave_combat",
        target_ref: "run_party_pool",
        condition_formula: "VAR_ESCAPE == 1",
      },
    },
  },
  activeEffects: [],
};

const CUSTOM_OBJECTIVE = {
  coreAction: "objective:custom",
  name: "Custom Objective",
  img: "icons/svg/target.svg",
  flags: {
    objectiveScope: "all",
  },
  props: {
    skill_type: "Active",
    action_command: "",
    check_mode: "open",
    isCheck: true,
    isReaction: false,
    // Deliberately no rolled_atr1/2: RAW p.72 has the GM choose the pair from
    // the player's description, which is what the attribute-pair picker is for.
    skill_target: "Self",
    cost: "",
    max_level: "1",
    check_difficulty_level: "10",
    description:
      "<p>Attempt something the battlefield allows but no other action covers — " +
      "work a mechanism, shove a boulder, wrench a door open, reach a vantage point.</p>" +
      "<p>The Game Master picks the Attributes and the Difficulty Level from what you describe.</p>",
    effect_table: {},
  },
  activeEffects: [],
};

// ── Clock Interaction ──────────────────────────────────────────────────────
// One option per live clock the creature may push, generated at pick time from
// the Clock System registry (`menu_dynamic_source: "clock"`) — the clock list is
// runtime state and could never be authored as refs.
//
// Only clocks flagged `requiresAction` are offered. An unflagged clock is still
// freely clickable on its own panel, so spending a turn action on one would be
// strictly worse than doing nothing special.
//
// The roll is the ACTION's own check, made at COMPUTE and shown on the action
// card; `clock_advance` in "roll" mode commits it through the clock's RAW margin
// rules against that clock's OWN DL. So the difficulty is per-clock while the
// attribute pair is fixed here — a dungeon that wants a different pair authors
// its own Objective option rather than reusing this one.
const CLOCK_INTERACTION = {
  coreAction: "objective:clock",
  name: "Clock Interaction",
  img: "icons/svg/clockwork.svg",
  flags: {
    objectiveScope: "all",
    objectiveGate: "ACTIONABLE_CLOCK_COUNT > 0",
    objectiveGateReason: "Nothing here to work on",
  },
  props: {
    skill_type: "Active",
    isCheck: true,
    isReaction: false,
    check_mode: "open",
    rolled_atr1: "DEX",
    rolled_atr2: "INS",
    skill_target: "Self",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "clock_pick",
    description:
      "<p>Work on something the battlefield is keeping track of. Make an " +
      "<strong>【DEX + INS】</strong> check and push a clock — the better the result, " +
      "the more ground you cover.</p>",
    effect_table: {
      "0": {
        effect_label: "clock_pick",
        effect_kind: "open_action_menu",
        menu_dynamic_source: "clock",
        clock_mode: "roll",
        menu_title: "Which clock?",
        menu_subtitle: "Your check result decides how far it moves.",
      },
    },
  },
  activeEffects: [],
};

// ── Reveal (Hidden removal) ────────────────────────────────────────────────
// The Hidden status has always said "You can use an Objective Action to remove
// the Hidden status from target creature." Until the Objective action existed
// there was nothing to carry that sentence.
//
// Hidden blocks single-target actions, so the target picker would refuse the
// hidden creature under a single-target spec. `skill_target: "All Enemy"` sweeps
// instead: you sweep the area, and the remove_ae simply finds nothing when
// nobody is hidden. That is also why this is not a Check — you are not beating
// the hider, you are flushing the space.
const REVEAL = {
  coreAction: "objective:reveal",
  name: "Reveal",
  img: "icons/svg/eye.svg",
  flags: { objectiveScope: "all" },
  props: {
    skill_type: "Active",
    isCheck: false,
    isReaction: false,
    skill_target: "All Enemy",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "reveal_strip",
    description:
      "<p>Sweep the area and drag whoever is skulking in it into the open — " +
      "every <strong>Hidden</strong> enemy loses the status.</p>",
    effect_table: {
      "0": {
        effect_label: "reveal_strip",
        effect_kind: "remove_ae",
        target_ref: "action_targets",
        ae_template_ref: "Hidden",
        count: "all",
      },
    },
  },
  activeEffects: [],
};

// ── Break Free (Grappled re-attempt) ───────────────────────────────────────
// The Grappled rules text promises this: "the grappled unit may choose to use
// the Objective action in their turn to reattempt the check if they do not break
// free at the start of their turn." state-handlers deferred it in a comment
// ("until the Objective action ships") — this is that ship.
//
// RAW wants any pair containing at least one MIG or DEX die; DEX+MIG satisfies
// that and needs no picker. The turn-start attempt is still free and unchanged;
// this is the paid second bite.
//
// `break_free`, not `remove_ae`: grappling is a reciprocal pair and the
// grappler's Grappling AE has to be re-synced. See the effect's own note.
const BREAK_FREE = {
  coreAction: "objective:break_free",
  name: "Break Free",
  img: "icons/svg/net.svg",
  flags: {
    objectiveScope: "all",
    objectiveGate: "HAS_STATUS_GRAPPLED",
    objectiveGateReason: "You aren't being held",
  },
  props: {
    skill_type: "Active",
    isCheck: true,
    check_mode: "open",
    rolled_atr1: "DEX",
    rolled_atr2: "MIG",
    check_difficulty_level: "10",
    isReaction: false,
    skill_target: "Self",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "break_free_try",
    description:
      "<p>Spend your action wrenching yourself loose. <strong>【DEX + MIG】</strong> " +
      "vs <strong>DL 10</strong> — on a success you are no longer <strong>Grappled</strong>.</p>" +
      "<p><em>The free attempt at the start of your turn still happens; this is a second try.</em></p>",
    effect_table: {
      "0": {
        effect_label: "break_free_try",
        effect_kind: "break_free",
        target_ref: "self",
        condition_formula: "TOTAL >= 10",
      },
    },
  },
  activeEffects: [],
};

export async function migrate(game, log) {
  const results = [];
  for (const spec of [RUN_AWAY, CUSTOM_OBJECTIVE, CLOCK_INTERACTION, REVEAL, BREAK_FREE]) {
    const { item, created, touched } = await ensureCoreActionSkill(game, spec, log);
    results.push(`${spec.name} ${created ? "created" : touched ? "updated" : "already current"} (${item?.uuid ?? "?"})`);
  }
  return { applied: true, summary: `Common Objectives — ${results.join("; ")}` };
}
