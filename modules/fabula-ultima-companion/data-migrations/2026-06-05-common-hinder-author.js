/**
 * Migration: 2026-06-05-common-hinder-author  (resolveAction-unification, Phase 3)
 * ---------------------------------------------------------------------------
 * Author the canonical **Hinder** action-skill Item under `Battle Director /
 * Common`, so the Hinder turn-action resolves through `resolveAction()`.
 *
 * RAW Core p.71 — Hinder is an attribute Check vs a Difficulty Level (default
 * 10). On success the target suffers one chosen status (Dazed / Shaken / Slow /
 * Weak). Distinct statuses coexist; re-applying the same status replaces it.
 *
 * The status choice is a standard `open_action_menu` (identical shape to Warning
 * Shot / Reinforce), NOT a bespoke card grid: on a success the menu prompts for
 * one of Dazed / Shaken / Slow / Weak, each backed by its own `apply_ae` option
 * row (canonical debuff AE by name from the "Debuff" world container,
 * resolveAeTemplate fallback #3; `replace_same_status` folds the same-status
 * dedup). The menu carries per-option icons + colors via the generic
 * `menu_option_icons` / `menu_option_colors` columns, so the picker renders with
 * the old status flair through shared infrastructure. Success-gating + fail/fumble
 * Miss VFX stay in the thin Hinder RESOLVE wrapper (only successes call
 * resolveAction → the menu only fires on success).
 *
 * `check_mode: difficulty` + `check_difficulty_level: 10` + `rolled_atr1/2`
 * (DEX+INS) drive the roll: COMPUTE (`computeHinder`) reads the attribute pair,
 * DL, and mode FROM this item — the live GM attribute-picker result (if any)
 * overrides the authored defaults. No hardcoded check config remains in COMPUTE.
 *
 * effect_table:
 *   hinder_menu  → open_action_menu (refs the 4 status rows; icons + colors)
 *   hinder_<s>   → apply_ae (Dazed/Shaken/Slow/Weak → action_targets, replace_same_status)
 *
 * Resolved at runtime by `flags["fabula-ultima-companion"].coreAction = "hinder"`.
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill } from "./_action-skill-author.js";

export const key = "2026-06-05-common-hinder-author";
export const description =
  "Author Battle Director/Common/Hinder action-skill Item (open_action_menu of 4 " +
  "apply_ae status rows w/ icons+colors, replace_same_status dedup) for the " +
  "resolveAction-unified Hinder path.";

const SPEC = {
  coreAction: "hinder",
  name: "Hinder",
  img: "icons/svg/net.svg",
  props: {
    skill_type: "Active",
    action_command: "hinder",
    check_mode: "difficulty",
    check_difficulty_level: 10,
    rolled_atr1: "DEX",
    rolled_atr2: "INS",
    isCheck: true,
    isReaction: false,
    picker: "attribute_pair",
    skill_target: "One Enemy",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "hinder_menu",
    description:
      "<p>Make an attribute Check against a creature. On a success, it suffers " +
      "a status of your choice (Dazed, Shaken, Slow, or Weak).</p>",
    effect_table: {
      // The pick is a standard open_action_menu (rendered by the shared option
      // picker with per-option icons/colors), not a bespoke card grid.
      "0": { effect_label: "hinder_menu", effect_kind: "open_action_menu",
             menu_title: "Hinder", menu_subtitle: "Choose a status to inflict.",
             menu_option_refs: "hinder_dazed,hinder_shaken,hinder_slow,hinder_weak",
             menu_option_labels: "Dazed|Shaken|Slow|Weak",
             menu_option_descriptions: "Lowers Insight|Lowers Willpower|Lowers Dexterity|Lowers Might",
             menu_option_icons: "icons/svg/daze.svg|icons/svg/terror.svg|icons/svg/clockwork.svg|icons/svg/degen.svg",
             menu_option_colors: "#9b59b6|#5a6a85|#8b5e3c|#c44a2a",
             menu_pick_count: 1 },
      "1": { effect_label: "hinder_dazed",  effect_kind: "apply_ae", ae_template_ref: "Dazed",
             target_ref: "action_targets", ae_duplicate_mode: "replace_same_status" },
      "2": { effect_label: "hinder_shaken", effect_kind: "apply_ae", ae_template_ref: "Shaken",
             target_ref: "action_targets", ae_duplicate_mode: "replace_same_status" },
      "3": { effect_label: "hinder_slow",   effect_kind: "apply_ae", ae_template_ref: "Slow",
             target_ref: "action_targets", ae_duplicate_mode: "replace_same_status" },
      "4": { effect_label: "hinder_weak",   effect_kind: "apply_ae", ae_template_ref: "Weak",
             target_ref: "action_targets", ae_duplicate_mode: "replace_same_status" },
    },
  },
  activeEffects: [],
};

export async function migrate(game, log) {
  const { item, created, touched } = await ensureCoreActionSkill(game, SPEC, log);
  return {
    applied: true,
    summary: `Common/Hinder ${created ? "created" : touched ? "updated" : "already current"} (${item?.uuid ?? "?"})`,
  };
}
