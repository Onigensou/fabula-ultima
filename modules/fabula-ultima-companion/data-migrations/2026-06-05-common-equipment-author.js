/**
 * Migration: 2026-06-05-common-equipment-author  (resolveAction-unification, Phase 4)
 * ---------------------------------------------------------------------------
 * Author the canonical **Equipment** action-skill Item under `Battle Director /
 * Common`, so the Equipment turn-action resolves through `resolveAction()`.
 *
 * RAW Core p.70 — the Equipment action stores/equips items from the backpack
 * (no roll, no targeting). The card collects per-slot selections; RESOLVE
 * commits them. The single `equip_swap` effect row wraps the proven
 * `applyEquipmentSwap(actor, ar.equipmentSelections)` so behavior is identical
 * to the bespoke RESOLVE branch.
 *
 * effect_table:
 *   equipment_swap → equip_swap (target_ref self)
 *
 * Resolved at runtime by `flags["fabula-ultima-companion"].coreAction = "equipment"`.
 * IDEMPOTENT.
 */

import { ensureCoreActionSkill } from "./_action-skill-author.js";

export const key = "2026-06-05-common-equipment-author";
export const description =
  "Author Battle Director/Common/Equipment action-skill Item (single equip_swap row) " +
  "for the resolveAction-unified Equipment path.";

const SPEC = {
  coreAction: "equipment",
  name: "Equipment",
  img: "icons/svg/upgrade.svg",
  props: {
    skill_type: "Active",
    action_command: "equipment",
    check_mode: "none",
    isCheck: false,
    isReaction: false,
    skill_target: "Self",
    cost: "",
    max_level: "1",
    on_activate_effect_ref: "equipment_swap",
    description:
      "<p>Store equipped items in your backpack and equip items from it " +
      "(armor excepted). No roll.</p>",
    effect_table: {
      "0": { effect_label: "equipment_swap", effect_kind: "equip_swap", target_ref: "self" },
    },
  },
  activeEffects: [],
};

export async function migrate(game, log) {
  const { item, created, touched } = await ensureCoreActionSkill(game, SPEC, log);
  return {
    applied: true,
    summary: `Common/Equipment ${created ? "created" : touched ? "updated" : "already current"} (${item?.uuid ?? "?"})`,
  };
}
