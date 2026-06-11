/**
 * Migration: 2026-06-05-common-study-author  (resolveAction-unification, Phase 5)
 * ---------------------------------------------------------------------------
 * Author the canonical **Study** action-skill Item under `Battle Director /
 * Common`, so the Study turn-action resolves through `resolveAction()`.
 *
 * RAW Core p.74 — Study is an Open Check (default INS + INS) against a chosen
 * creature; the total reveals tiers on the Monster Encyclopedia (Identity ≥ 7,
 * Stats ≥ 8, Details ≥ 13). A Fumble reveals nothing.
 *
 * The single `encyclopedia_record` effect row wraps `encApi.recordResult` (the
 * exact call the bespoke RESOLVE branch makes), reading the studied target +
 * roll from the action result. Token VFX + opening the encyclopedia sheet stay
 * in the thin Study RESOLVE wrapper (presentation, not data).
 *
 * `check_mode: open` + `rolled_atr1/2` (INS+INS) drive the roll: COMPUTE
 * (`computeStudy`) reads the attribute pair FROM this item. The tier
 * classification (Identity/Stats/Details) is NOT authored here — it is canonical
 * to the Encyclopedia subsystem (encyclopedia-core `classifyStudyTotal`, crit-
 * aware), which COMPUTE calls so the card's tier always matches what
 * `recordResult` stores. No hardcoded check/tier logic remains in COMPUTE.
 *
 * effect_table:
 *   study_record → encyclopedia_record
 *
 * Resolved at runtime by `flags["fabula-ultima-companion"].coreAction = "study"`.
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill } from "./_action-skill-author.js";

export const key = "2026-06-05-common-study-author";
export const description =
  "Author Battle Director/Common/Study action-skill Item (single encyclopedia_record row) " +
  "for the resolveAction-unified Study path.";

const SPEC = {
  coreAction: "study",
  name: "Study",
  img: "icons/svg/eye.svg",
  props: {
    skill_type: "Active",
    action_command: "study",
    check_mode: "open",
    isCheck: true,
    isReaction: false,
    rolled_atr1: "INS",
    rolled_atr2: "INS",
    skill_target: "One Enemy",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "study_record",
    description:
      "<p>Make an Open Check (【INS + INS】) to learn about a creature. The " +
      "higher the result, the more its Monster Encyclopedia entry reveals.</p>",
    effect_table: {
      "0": { effect_label: "study_record", effect_kind: "encyclopedia_record" },
    },
  },
  activeEffects: [],
};

export async function migrate(game, log) {
  const { item, created, touched } = await ensureCoreActionSkill(game, SPEC, log);
  return {
    applied: true,
    summary: `Common/Study ${created ? "created" : touched ? "updated" : "already current"} (${item?.uuid ?? "?"})`,
  };
}
