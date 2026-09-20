// Hilde-Fafnir — Disenchant, her answer to a party that wards itself against
// Fire and Bolt. A DELTA on the live docs. From tools/safe-edit; --apply.
//
// Disenchant (10 MP, one creature): remove ALL effects with a duration of Scene.
// Mechanically it is the Entropist's Dispel with the picker removed —
// `remove_tagged_ae` / `filter_tag: "dispellable"` — except `count: "all"`,
// which the handler treats as "remove every match, no prompt".
//
// AI gate (the whole point of the design): `enemy_has_affinity_buff` with
// "fire,bolt", focus `affinity_buff_focus` on the same elements, priority 5,
// cooldown 1.
//   - cooldown 1 is ONCE PER ROUND — the picker blocks a row while
//     (currentRound - lastUsedRound) < cooldown. Without it a multi-activation
//     champion could spend a whole round stripping buffs and apply no pressure,
//     which is exactly what the user ruled out.
//   - priority 5 ties Wyrmbreath, so on a round where a buff is up the window
//     holds Disenchant 3 / Wyrmbreath 3 / Impalement 2 / Scorched Claw 1. She
//     strips OFTEN, not always. Priority 6 would have made it near-automatic and
//     pushed Scorched Claw out of the window entirely.
//   - the condition only sees DISPELLABLE effects, so the party's innate Fire
//     resistance and Hina's Ring of Magma never trigger it — she would have been
//     casting into an unremovable buff every round.
//
// ALSO patches the CSB NPC template's two dropdowns to offer the new condition
// and focus values. Without that the sheet re-stamps the row to its fallback the
// first time anyone opens it (the Dryad burn_spread regression, twice).
const { getByKey } = require("../lib/db");
const { IDS, L, ICON } = require("./_fafnir-lib");
const { makeSkill, run } = require("./_fafnir-util");

const A = IDS.HF;
const NAME = "Disenchant";
const ELEMENTS = "fire,bolt";
const TEMPLATE_ACTOR = "yegF6R8aaymhrvCg";   // "_Fabula NPC template v.2"
const NEW_CONDITION = { key: "enemy_has_affinity_buff", value: "Enemy Has Affinity Buff" };
const NEW_FOCUS = { key: "affinity_buff_focus", value: "Affinity Buff Focus" };

const DESC =
  `<p>Remove all effects with a duration of <strong>Scene</strong> from one creature.</p>`;

run(async ({ changes }) => {
  const ik = (id) => `!actors.items!${A}.${id}`;
  const actor = await getByKey("actors", `!actors!${A}`);
  const breath = await getByKey("actors", ik(IDS.HF_BREATH));
  if (!actor || !breath) throw new Error("missing Hilde-Fafnir doc");

  // ── Disenchant ──────────────────────────────────────────────────────────
  // Cloned from Wyrmbreath so the Spell scaffold matches her other casts; every
  // damage field is zeroed — this one only strips.
  const spell = makeSkill(breath, A, IDS.HF_DISEN, NAME, ICON.spell, {
    skill_type: "Spell", skill_target: "One Creature", skill_range: "Range",
    rolled_atr1: "-", rolled_atr2: "-",
    check_bonus: "0", damage_bonus: "0", type_damage: "", defense_target_type: "def",
    isCheck: false, isOffensiveSpell: false, isReaction: false,
    cost: "10 MP", duration: "Instantaneous", details_roller: "Show",
    action_keywords: "", description: DESC,
    on_activate_effect_ref: "disen_strip",
  });
  Object.assign(spell.system.props, {
    effect_table: {
      // `count: "all"` — every dispellable effect, no picker. Dispel's own row is
      // the same shape with count 1 plus a menu.
      "0": { $deleted: false, effect_kind: "remove_tagged_ae", effect_label: "disen_strip",
             target_ref: "action_targets", filter_tag: "dispellable", count: "all" },
    },
  });
  changes.push([ik(IDS.HF_DISEN), spell, `NEW item — ${NAME} (strip all dispellable effects, 10 MP)`]);

  // ── Actor: item list, spell list, AI row ────────────────────────────────
  const p = actor.system.props;
  const items = Array.isArray(actor.items) ? [...actor.items] : [];
  if (!items.includes(IDS.HF_DISEN)) items.push(IDS.HF_DISEN);
  actor.items = items;

  p.normal_spell_list = { ...(p.normal_spell_list ?? {}),
    [IDS.HF_DISEN]: { name: NAME, id: "${item.id}", uuid: `Actor.${A}.Item.${IDS.HF_DISEN}`,
      cost: "10 MP", spell_target: "One Creature", duration: "Instantaneous",
      spell_description: DESC, roll: "" },
  };

  const pat = p.action_pattern_table ?? {};
  const nextKey = String(Math.max(-1, ...Object.keys(pat).map(Number).filter(Number.isFinite)) + 1);
  pat[nextKey] = {
    $deleted: false, action_pattern_name: NAME,
    action_pattern_condition: NEW_CONDITION.key, action_pattern_string: ELEMENTS,
    action_pattern_value_1: "", action_pattern_value_2: "",
    action_pattern_priority: "5",
    action_pattern_target_focus: NEW_FOCUS.key, action_pattern_focus_status: ELEMENTS,
    action_pattern_cooldown: "1", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0",
  };
  p.action_pattern_table = pat;
  changes.push([`!actors!${A}`, actor, `actor — ${NAME} added, AI row ${nextKey} (prio 5, once per round)`]);

  // ── CSB template dropdowns ──────────────────────────────────────────────
  const tpl = await getByKey("actors", `!actors!${TEMPLATE_ACTOR}`);
  if (!tpl) throw new Error("NPC template actor not found");
  const rowLayout = ["contents", 0, "contents", 1, "contents", 5, "contents", 0, "contents", 0, "rowLayout"]
    .reduce((x, k) => x?.[k], tpl.system.body);
  if (!rowLayout) throw new Error("template rowLayout not at the documented path — re-locate before writing");
  const addOption = (cellKey, opt) => {
    const cell = rowLayout[cellKey];
    const holder = cell?.options ? cell : cell?.contents?.[0];
    if (!Array.isArray(holder?.options)) throw new Error(`template cell ${cellKey} has no options array`);
    if (holder.options.some((o) => o.key === opt.key)) return false;
    holder.options.push({ key: opt.key, value: opt.value });
    return true;
  };
  const addedCond = addOption("1", NEW_CONDITION);
  const addedFocus = addOption("6", NEW_FOCUS);
  if (addedCond || addedFocus) {
    changes.push([`!actors!${TEMPLATE_ACTOR}`, tpl,
      `NPC template — dropdown options${addedCond ? " +" + NEW_CONDITION.key : ""}${addedFocus ? " +" + NEW_FOCUS.key : ""}`]);
  } else {
    console.log("  note: template already offers both options — nothing to add");
  }
}, "hilde-fafnir: Disenchant", "actors");
