/**
 * Migration: 2026-11-12-polymorph-revert-objective  (Polymorph, battle phase)
 * ---------------------------------------------------------------------------
 * Author the **Revert** Objective option under `Battle Director / Common`.
 *
 * A Polymorph form (scripts/polymorph/polymorph-core.js) grants this option to
 * its bearer through a `grant_objective: revert_form` change row on the Form
 * effect, so it is GRANT-ONLY (`objectiveScope: "none"`): nobody else sees it.
 *
 * User ruling 2026-11-12: reverting in battle is FREE. `skill_free_action: true`
 * routes RESOLVE back to the action menu with the turn action intact (the same
 * authored-free return Birth of the Cruel's Dismiss uses), so the creature
 * reverts and then acts in its own body this turn.
 *
 * `polymorph_revert`, not `remove_ae` on the Form effect: revert carries HP/MP
 * back and removes the copied form items, and the effect kind AWAITS it so the
 * reopened menu reads the creature already back in its own body.
 *
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill } from "./_action-skill-author.js";

export const key = "2026-11-12-polymorph-revert-objective";
export const description =
  "Author Battle Director/Common Objective option: Revert (ends a Polymorph form; " +
  "free action, granted only by the form).";

const REVERT_FORM = {
  coreAction: "objective:revert_form",
  name: "Revert",
  img: "icons/svg/regen.svg",
  flags: {
    objectiveScope: "none",
  },
  props: {
    skill_type: "Active",
    isCheck: false,
    isReaction: false,
    skill_target: "Self",
    skill_free_action: true,
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "revert_form_root",
    description:
      "<p>Shed your Polymorph form and return to your own body. " +
      "<strong>Free</strong> — you still take your action this turn.</p>" +
      "<p>Your HP and MP carry back in proportion to what happened while transformed.</p>",
    effect_table: {
      "0": {
        effect_label: "revert_form_root",
        effect_kind: "polymorph_revert",
        target_ref: "self",
      },
    },
  },
  activeEffects: [],
};

export async function migrate(game, log) {
  const { item, created, touched } = await ensureCoreActionSkill(game, REVERT_FORM, log);
  return {
    applied: true,
    summary: `Common Objective — Revert ${created ? "created" : touched ? "updated" : "already current"} (${item?.uuid ?? "?"})`,
  };
}
