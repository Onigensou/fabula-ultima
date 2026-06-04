/**
 * Migration: 2026-06-05-common-guard-author  (resolveAction-unification, Phase 1)
 * ---------------------------------------------------------------------------
 * Author the canonical **Guard** action-skill Item under `Battle Director /
 * Common`, so the Guard turn-action resolves through the one unified
 * `resolveAction()` pipeline instead of a bespoke RESOLVE branch.
 *
 * RAW Core p.70 — until the start of the guarder's next turn:
 *   - the guarder gains Resistance to all damage types,
 *   - +2 to Opposed Checks,
 *   - an optionally-Covered ally cannot be targeted by melee attacks.
 *
 * These are reproduced EXACTLY by the existing engine:
 *   - The "Guard" AE (named "Guard") on the guarder drives Resistance via
 *     `readActiveConditions` (name match `"Guard"`) + the +2 Opposed read,
 *     identical to the bespoke branch.
 *   - The "Covered" AE carries `cannot_be_targeted_by: melee` (mode 5 OVERRIDE),
 *     the same change `applyAttackRangeGate` reads to exclude the ally from
 *     melee pickers.
 *   - 1-turn expiry: both AE templates set `duration.rounds: 1`, so apply_ae
 *     stamps `directorAppliedBy.turnsRemaining: 1` and `tickDirectorAEsForApplier`
 *     removes them at the guarder's next TurnStart (same as before).
 *   - `creature_guards` post-resolve trigger is queued by resolveAction for
 *     kind "Guard" (Bodyguard listens on `didCoverAlly`).
 *
 * The legacy `flags.directorGuard` blob is intentionally dropped — it was
 * write-only (never read; lifecycle is owned by `directorAppliedBy`).
 *
 * effect_table:
 *   guard_activate → chain(guard_self, guard_cover)
 *   guard_self     → apply_ae "Guard"   → self
 *   guard_cover    → apply_ae "Covered" → cover_target  (no-op when no ally)
 *
 * Resolved at runtime by `flags["fabula-ultima-companion"].coreAction = "guard"`.
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill, MODULE_ID } from "./_action-skill-author.js";

export const key = "2026-06-05-common-guard-author";
export const description =
  "Author Battle Director/Common/Guard action-skill Item (Guard + Covered AEs, " +
  "self+cover apply_ae chain) for the resolveAction-unified Guard path.";

const GUARD_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/shield_oath.png";
const COVER_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/intervene.png";

const NULL_DURATION = {
  startTime: null, seconds: null, rounds: 1, turns: null,
  startRound: null, startTurn: null, type: "none", duration: null,
};

const SPEC = {
  coreAction: "guard",
  name: "Guard",
  img: GUARD_ICON,
  props: {
    skill_type: "Active",
    action_command: "guard",
    check_mode: "none",
    isCheck: false,
    isReaction: false,
    skill_target: "Self",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "guard_activate",
    description:
      "<p>Until the start of your next turn you have Resistance to all damage " +
      "types and a +2 bonus to Opposed Checks. You may also Cover one ally, " +
      "who cannot be targeted by melee attacks until then.</p>",
    effect_table: {
      "0": { effect_label: "guard_activate", effect_kind: "chain",
             chain_steps: "guard_self,guard_cover" },
      "1": { effect_label: "guard_self", effect_kind: "apply_ae",
             ae_template_ref: "Guard", target_ref: "self", ae_duplicate_mode: "replace" },
      "2": { effect_label: "guard_cover", effect_kind: "apply_ae",
             ae_template_ref: "Covered", target_ref: "cover_target", ae_duplicate_mode: "replace" },
    },
  },
  activeEffects: [
    {
      name: "Guard",
      icon: GUARD_ICON,
      description: "<p><em>Guard:</em> Resistance to all damage + 2 to Opposed Checks until your next turn.</p>",
      transfer: false,
      disabled: false,
      duration: { ...NULL_DURATION },
      statuses: ["guard"],
      changes: [],
      flags: { [MODULE_ID]: { category: "buff" }, core: { statusId: "guard" } },
      system: { tags: ["buff"] },
    },
    {
      name: "Covered",
      icon: COVER_ICON,
      description: "<p><em>Covered:</em> Cannot be targeted by melee attacks until the guard's next turn.</p>",
      transfer: false,
      disabled: false,
      duration: { ...NULL_DURATION },
      statuses: ["covered"],
      // Mode 5 = OVERRIDE (string value). Same change applyAttackRangeGate reads.
      changes: [{ key: "cannot_be_targeted_by", value: "melee", mode: 5, priority: 0 }],
      flags: { [MODULE_ID]: { category: "buff" }, core: { statusId: "covered" } },
      system: { tags: ["buff"] },
    },
  ],
};

export async function migrate(game, log) {
  const { item, created, touched } = await ensureCoreActionSkill(game, SPEC, log);
  return {
    applied: true,
    summary: `Common/Guard ${created ? "created" : touched ? "updated" : "already current"} (${item?.uuid ?? "?"})`,
  };
}
