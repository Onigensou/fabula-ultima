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
 * The single apply_ae row uses the dynamic `ae_template_ref: "status_value"`,
 * which the apply_ae handler resolves to the card-picked status name from
 * `ar.statusValue` at fire time, pulling the canonical debuff AE from the
 * "Debuff" world container (resolveAeTemplate fallback #3). `replace_same_status`
 * folds the bespoke same-status dedup. Success-gating + fail/fumble Miss VFX
 * stay in the thin Hinder RESOLVE wrapper (only successes call resolveAction).
 *
 * `check_mode: difficulty` + `check_difficulty_level: 10` document the roll for
 * the COMPUTE-unification step; COMPUTE still computes the Check today.
 *
 * effect_table:
 *   hinder_apply → apply_ae (status_value → action_targets, replace_same_status)
 *
 * Resolved at runtime by `flags["fabula-ultima-companion"].coreAction = "hinder"`.
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill } from "./_action-skill-author.js";

export const key = "2026-06-05-common-hinder-author";
export const description =
  "Author Battle Director/Common/Hinder action-skill Item (apply_ae status_value row, " +
  "replace_same_status dedup) for the resolveAction-unified Hinder path.";

const SPEC = {
  coreAction: "hinder",
  name: "Hinder",
  img: "icons/svg/net.svg",
  props: {
    skill_type: "Active",
    action_command: "hinder",
    check_mode: "difficulty",
    check_difficulty_level: 10,
    isCheck: true,
    isReaction: false,
    picker: "attribute_pair",
    skill_target: "One Enemy",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "hinder_apply",
    description:
      "<p>Make an attribute Check against a creature. On a success, it suffers " +
      "a status of your choice (Dazed, Shaken, Slow, or Weak).</p>",
    effect_table: {
      "0": { effect_label: "hinder_apply", effect_kind: "apply_ae",
             ae_template_ref: "status_value", target_ref: "action_targets",
             ae_duplicate_mode: "replace_same_status" },
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
