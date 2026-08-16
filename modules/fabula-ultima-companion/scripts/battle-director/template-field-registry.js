// Template field registry — the SINGLE source of truth for declarative
// row-fields the engine reads out of the dynamic tables `effect_table` and
// `reaction_config_table`.
//
// WHY THIS EXISTS (read before adding any new declarative field):
//   CSB dynamic-table rows only expose a field in the sheet if the table's
//   `rowLayout` declares a COLUMN for it. A field authored via migration but
//   with no column is "data-only": it works in the harness (which never opens a
//   sheet) but is uneditable in the UI and can be stripped on sheet save. This
//   gap has bitten us repeatedly (menu_* fields, free_hr_as_zero, …) because the
//   miss is invisible to behavioral tests.
//
//   The every-boot sync in _module-boot.js consumes THIS registry to ensure each
//   field has a column on every template that carries the matching table —
//   self-healing, like the dropdown-OPTION sync does for select values. So:
//
//   ➜ TO ADD A NEW DECLARATIVE effect_table / reaction_config_table FIELD:
//       1. add ONE entry here (key + column def), and
//       2. read it in the engine.
//     The boot sync exposes it on every template automatically. DO NOT hand-write
//     a per-field "add column" migration; DO NOT rely on data-only fields.
//   See [[feedback_csb_template_gating]].
//
// Column-def shape mirrors CSB rowLayout entries. `visibilityFormula: ""` =
// always visible. Helper builders below cover the common shapes.

import { RESOURCE_REGISTRY } from "./resources.js";

const OAM_VIS = `equalText(sameRow("effect_kind",''), "open_action_menu")`;
// Damage-effect visibility gates.
const DEAL_VIS = `equalText(sameRow("effect_kind",''), "deal_damage")`;
const ADJUST_VIS = `equalText(sameRow("effect_kind",''), "adjust_damage")`;
const DEAL_OR_ADJUST_VIS = `or(equalText(sameRow("effect_kind",''), "deal_damage"), equalText(sameRow("effect_kind",''), "adjust_damage"))`;
const TGT_VIS = `equalText(sameRow("effect_kind",''), "targeting")`;
const APPLY_AE_VIS = `equalText(sameRow("effect_kind",''), "apply_ae")`;
const KEYWORD_VIS = `equalText(sameRow("effect_kind",''), "apply_action_keyword")`;
const CONSUME_RES_VIS = `equalText(sameRow("effect_kind",''), "consume_resource")`;
// consume_item — spend one unit of a carried consumable (Life Charm spends
// itself when its death-save fires). The permanent twin of hide_item.
const CONSUME_ITEM_VIS = `equalText(sameRow("effect_kind",''), "consume_item")`;
// adjust_charges — charge arithmetic on a target's named charge-AE.
const ADJUST_CHARGES_VIS = `equalText(sameRow("effect_kind",''), "adjust_charges")`;
// trigger_status — fire a charge-based status's own tick N× on the target(s).
const TRIGGER_STATUS_VIS = `equalText(sameRow("effect_kind",''), "trigger_status")`;
// free_action — perform ONE free turn-action (skill name / "self" / type).
const FREE_ACTION_VIS = `equalText(sameRow("effect_kind",''), "free_action")`;
// remove_ae is the canonical AE-deletion kind; remove_tagged_ae is its alias.
const REMOVE_AE_VIS = `or(equalText(sameRow("effect_kind",''), "remove_ae"), equalText(sameRow("effect_kind",''), "remove_tagged_ae"))`;
// prompt_number — interactive amount picker (Blazing Tether's Burn-stack move).
const PROMPT_NUMBER_VIS = `equalText(sameRow("effect_kind",''), "prompt_number")`;
// prompt_element — interactive damage-type picker (Meteor Shower). Stores the
// chosen element string under prompt_var, read later as VAR_<NAME>.
const PROMPT_ELEMENT_VIS = `equalText(sameRow("effect_kind",''), "prompt_element")`;
// roll_dice — auto-roll NdX and stash the total in VAR_<prompt_var>. The
// auto-rolling counterpart to prompt_number; feeds adjust_charges / adjust_damage
// / grant amounts a real die result (Fatigue 1d6, Instability 1d8).
const ROLL_DICE_VIS = `equalText(sameRow("effect_kind",''), "roll_dice")`;
// prompt_var is shared by prompt_number (amount), prompt_element (element), and
// roll_dice (rolled total).
const PROMPT_VAR_VIS = `or(equalText(sameRow("effect_kind",''), "prompt_number"), equalText(sameRow("effect_kind",''), "prompt_element"), equalText(sameRow("effect_kind",''), "roll_dice"))`;
// confirm — N-button decision dialog (gate or branch).
const CONFIRM_VIS = `equalText(sameRow("effect_kind",''), "confirm")`;
// Shared free-action GRANT fields (bonuses / cost) — used by BOTH the legacy
// open_action_menu free_mode grant AND the new free_action kind.
const FREE_GRANT_VIS = `or(equalText(sameRow("effect_kind",''), "open_action_menu"), equalText(sameRow("effect_kind",''), "free_action"))`;
// notify — surface a message (stub branches / info).
const NOTIFY_VIS = `equalText(sameRow("effect_kind",''), "notify")`;
// change_damage_element — override the in-flight attack's element (Tinkerer Infusions).
const CHANGE_EL_VIS = `equalText(sameRow("effect_kind",''), "change_damage_element")`;
const CHECK_DIE_SWAP_VIS = `equalText(sameRow("effect_kind",''), "check_die_swap")`;
// adjust_accuracy — action-level accuracy override (Magical Artillery, Adversity,
// Cognitive Focus, Crossfire). The DEFENDER twin (adjust_defense) reuses no fields.
const ADJUST_ACC_VIS = `equalText(sameRow("effect_kind",''), "adjust_accuracy")`;
// modify_turns — adjust a target's action count this round / next turn (Stop).
const MODIFY_TURNS_VIS = `equalText(sameRow("effect_kind",''), "modify_turns")`;
// create_bond — form an FU Bond (emotion) toward a creature (Heart of Darkness).
const CREATE_BOND_VIS = `equalText(sameRow("effect_kind",''), "create_bond")`;
// trigger_opportunity — offer N distinct Opportunity wheel picks (A Million Possibility).
const TRIGGER_OPP_VIS = `equalText(sameRow("effect_kind",''), "trigger_opportunity")`;
const SET_CHECK_DIE_VIS = `equalText(sameRow("effect_kind",''), "set_check_die")`;
// check_buff — a PASSIVE action-scoped Check bonus on an equipped gear's linked
// _skill, read at the action's COMPUTE by sumEquippedCheckBuffs (Encyclopedia +2
// Study, Sneaker +2 Stealth, Cat Ears +1 Any). Its two fields were data-only.
const CHECK_BUFF_VIS = `equalText(sameRow("effect_kind",''), "check_buff")`;
// adjust_grant — the heal/restore twin of adjust_accuracy: boost an in-flight
// action's PER-TARGET grant amount (Cognitive Focus, Potion Rain, the Retainer
// uniforms' "+5 HP/MP from your potions").
const ADJUST_GRANT_VIS = `equalText(sameRow("effect_kind",''), "adjust_grant")`;

// ── reaction_config_table visibility ─────────────────────────────────────────
// The trigger-specific FILTER cells. Gated by coarse trigger FAMILY (declared in
// reaction-triggers.config.js) rather than per-trigger capability: 15 of the 26
// reaction columns used to render on every row, so a simple "when does the enemy
// take damage" row showed a dozen cells that could never apply to it.
//
// ⚠ A gate here HIDES data it excludes — the value survives in the row but
// becomes uneditable. Every family below is a measured superset of the triggers
// its cells are actually authored against; before NARROWING one, re-check with
//   node tools/csb-template/bin/visibility-audit.js
// which flags a gate that references a field no column supplies (the exact way
// reaction_passive_target went dark) plus every data-only key.
const TRIG = `sameRow("reaction_trigger",'')`;
const RESOURCE_TRIG_VIS = `triggerInFamily(${TRIG}, "resource")`;
const STATUS_TRIG_VIS = `triggerInFamily(${TRIG}, "status")`;
const ACTION_TRIG_VIS = `triggerInFamily(${TRIG}, "action")`;
// Passive target is meaningless only when the row is switched OFF entirely.
// (It was gated on `reaction_isPassive` — a legacy prop with no column, set on
// ZERO of 544 live rows, so all 142 authored values were invisible.)
const PASSIVE_LIVE_VIS = `not(equalText(sameRow("reaction_passive_mode",''), "off"))`;

// ── substitute_cost — pay a cost out of a different resource pool. ───────────
const SUBSTITUTE_COST_VIS = `equalText(sameRow("effect_kind",''), "substitute_cost")`;
// ── adjust_cost — retune the in-flight action's own cost. ────────────────────
const ADJUST_COST_VIS = `equalText(sameRow("effect_kind",''), "adjust_cost")`;

// Resource dropdowns are DERIVED from the resource registry, never hand-copied:
// resources.js promises "add a row and that's it", and a hand-written option list
// silently breaks that promise (a `shield` row would render with no matching
// option and be stripped on the next sheet save).
const RESOURCE_OPTIONS = Object.entries(RESOURCE_REGISTRY)
  .map(([key, def]) => ({ key, value: def.label ?? key }));

// `reconcileVis: true` = "this gate has been checked against the live corpus and
// may be pushed onto columns that ALREADY exist". Without it the boot sync only
// applies the gate to a column it creates, which is the safe default: a narrower
// gate hides authored data. Check with tools/csb-template/bin/visibility-audit.js
// before setting it.
function textCol(key, colName, { tooltip = "", vis = "", reconcileVis = false } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: vis, reconcileVis,
    type: "textField", size: "full-size", label: "", defaultValue: "", autocomplete: "", align: "left",
    colName, readonlyPredefined: false,
  };
}
function checkboxCol(key, colName, { tooltip = "", vis = "", defaultChecked = false, reconcileVis = false } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: vis, reconcileVis,
    type: "checkbox", size: "full-size", label: "", defaultChecked, align: "left",
    colName, readonlyPredefined: false,
  };
}
function selectCol(key, colName, options, { tooltip = "", vis = "", defaultValue = "", reconcileVis = false } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: vis, reconcileVis,
    type: "select", size: "full-size", label: "", defaultValue, selectedOptionType: "custom",
    options: options.map((o) => ({ ...o })), align: "left",
    colName, readonlyPredefined: false,
  };
}

// ── effect_table declarative fields ──────────────────────────────────────────
// (Only fields prone to being added/forgotten are listed; the ensure-pass is a
// no-op for columns that already exist, so listing a stable field is harmless.)
export const EFFECT_TABLE_REQUIRED_COLUMNS = [
  // remove_ae — the ONE AE-deletion verb. `ae_template_ref` (name) is a real
  // column; `filter_tag` is NOT (it is authored on 76 rows and has never had
  // one — see the data-only list from visibility-audit) so it is registered
  // below rather than assumed present.
  checkboxCol("include_persistent", "Incl. Persistent Counters", { tooltip: "remove_ae: also delete AEs whose lifetimeMode is persistent_counter (clocks / point-pools). OFF by default so Dispel and Cleanse can never strip a resource tracker; turn ON when a skill clears a counter IT applied (e.g. Bimagus sweeping its own MP budget at turn end).", vis: REMOVE_AE_VIS }),
  // open_action_menu config
  // Gate covers every kind whose handler READS row.menu_title: open_action_menu
  // (:7548, :7626), prompt_element (:3527), remove_ae / remove_tagged_ae
  // (:9680, :9734) and transfer_ae (:8765). An earlier arming of this entry
  // covered only the first two and left 19 engine-read cells uneditable —
  // `reconcileVis: true` claims the gate was checked against live data, so the
  // check has to cover the handlers, not just the obvious kind.
  // 10 further cells (chain ×5, targeting ×5) stay hidden deliberately: no
  // handler reads menu_title on those kinds, so they are inert data.
  textCol("menu_title", "Menu Title", { tooltip: "Prompt title above the option list (open_action_menu, prompt_element, remove_ae / remove_tagged_ae, transfer_ae).", vis: `or(or(${OAM_VIS}, ${PROMPT_ELEMENT_VIS}), or(${REMOVE_AE_VIS}, equalText(sameRow("effect_kind",''), "transfer_ae")))`, reconcileVis: true }),
  textCol("menu_subtitle", "Menu Subtitle", { tooltip: "Prompt subtitle / instruction line.", vis: OAM_VIS }),
  textCol("menu_pick_count", "Pick Count", { tooltip: "How many options to choose (number or formula, default 1).", vis: OAM_VIS }),
  textCol("menu_option_refs", "Option Refs", { tooltip: "Comma-separated effect_label refs offered by this menu, in order.", vis: OAM_VIS }),
  textCol("menu_option_labels", "Option Labels", { tooltip: "Pipe (|)-separated display labels, paired with Option Refs.", vis: OAM_VIS }),
  textCol("menu_option_descriptions", "Option Descriptions", { tooltip: "Pipe (|)-separated descriptions, paired with Option Refs.", vis: OAM_VIS }),
  textCol("menu_option_icons", "Option Icons", { tooltip: "Optional pipe (|)-separated icon image paths, paired with Option Refs. Blank = no icon (plain row).", vis: OAM_VIS }),
  textCol("menu_option_colors", "Option Colors", { tooltip: "Optional pipe (|)-separated accent colors (CSS), paired with Option Refs. Blank = no accent.", vis: OAM_VIS }),
  checkboxCol("menu_hide_disabled", "Hide Disabled", { tooltip: "Hide every disabled (gate-failed) option instead of showing it greyed. Default off = show greyed (per-option disable_ui_type). Turn on for large gated menus (e.g. Invocation) where 10+ unavailable options would be noise.", vis: OAM_VIS }),
  // free-action grant config (open_action_menu free_mode — High Speed, Hawkeye
  // option b, On the Hunt). free_mode + allowed_types were historically added by
  // a dedicated column migration but never registry-backed, so a fresh template
  // or an un-migrated co-dev world could lack them (data-only / strippable). List
  // them here so the boot-3b sync self-heals the columns everywhere.
  checkboxCol("free_mode", "Free Mode", { tooltip: "Grant a FREE ACTION + mini-turn (no inline picker) instead of showing menu options. Pairs with Allowed Types / Free: HR as 0.", vis: OAM_VIS }),
  textCol("allowed_types", "Allowed Types", { tooltip: "Free Mode only: comma-separated action types the granted free action is limited to (e.g. \"Attack\"). Blank = any.", vis: OAM_VIS }),
  checkboxCol("free_hr_as_zero", "Free: HR as 0", { tooltip: "Granted free attack treats High Roll as 0 for damage (Hawkeye option b / Soaring Strike). Pairs with Free Mode.", vis: OAM_VIS }),
  // deal_damage / adjust_damage config — these kinds were added (deal_damage;
  // adjust_damage from the add_damage+modify_damage_taken unify) without any
  // effect_table columns, so their rows showed only the Kind dropdown and the
  // damage values were data-only / uneditable in the sheet. See
  // [[feedback_csb_template_gating]].
  textCol("damage_element", "Damage Element", { tooltip: "deal_damage element: fire/ice/bolt/earth/air/light/dark/physical/poison (default elementless).", vis: DEAL_VIS }),
  checkboxCol("damage_ignore_affinity", "Ignore Affinity", { tooltip: "deal_damage lands flat — skips RS/VU/IM/AB + condition-forced VU (for fixed/'true' damage like an opposed-check consequence). DR/shield still apply.", vis: DEAL_VIS }),
  textCol("damage_keywords", "Damage Keywords", { tooltip: "Comma-separated action keywords carried by THIS damage instance (the effect-damage counterpart of a weapon's action_keywords). Currently read: crush = damage cannot be reduced (skips flat + % DR, a reducing weapon-efficiency, and a <1 damage_taken_mult) and ignores Immunity (RS and IM read as NE). VU/AB and damage-increasing axes still apply; shields still absorb.", vis: DEAL_VIS }),
  checkboxCol("consume_can_defeat", "Can Defeat Target", { tooltip: "consume_resource: report an HP debit from this row to the battle director so the settle's Crisis and Defeat reactors fire — i.e. this loss can knock the target out. A plain consume writes HP silently, so it can empty the HP bar without ever KO-ing (Crisis still lands via the standing updateActor hook; Defeat does not, because auto-defeat is NPC-only). Turn ON for 'you lose X HP' curses (Cursed Sword); leave OFF for ordinary costs, which should never defeat their payer. To also let the debit take the LAST points instead of refusing when the target is short, set On Empty = drain — that is a separate control.", vis: CONSUME_RES_VIS }),
  // consume_item config — which carried item gets spent. Default subject is the
  // firing skill's container (a gear's linked _skill consumes its own gear), but
  // an AE-carried reaction has no firing skill (resolveDamageReactions runs
  // follow-ups with skill:null), so those MUST name their item. Life Charm.
  textCol("consume_item_name", "Consume Item Name", { tooltip: "consume_item: name of the carried item to spend one unit of (case-insensitive). Required when the row fires from an AE, which has no firing skill to infer a container from. Blank = fall back to Consume Item Id, then the firing skill's container item.", vis: CONSUME_ITEM_VIS }),
  textCol("consume_item_id", "Consume Item Id", { tooltip: "consume_item: exact item id to spend, when a name would be ambiguous. Takes precedence over Consume Item Name.", vis: CONSUME_ITEM_VIS }),
  selectCol("damage_cause", "Damage Cause", [
    { key: "hazard", value: "Hazard (Burn/Poison/environment — not an attack)" },
    { key: "damage", value: "Damage (creature-inflicted — counts as an attack)" },
  ], { tooltip: "Resource-ledger cause for this deal_damage. hazard (default) won't trip 'player-inflicted damage' reactions; damage = creature-inflicted. Reactions filter via reaction_cause_filter.", vis: DEAL_VIS, defaultValue: "hazard" }),
  selectCol("damage_resource", "Damage Resource", [
    { key: "hp", value: "HP (default)" },
    { key: "mp", value: "MP (MP-burn / drain — clamps at 0, no affinity)" },
  ], { tooltip: "deal_damage: which resource the damage comes off. hp (default) = normal damage with affinity/shield/crisis-ledger; mp = MP-burn (e.g. Curse's drain) via applyDamageToTarget's MP path — clamps at 0, fires the −N loss VFX, no affinity/shield/ledger.", vis: DEAL_VIS, defaultValue: "hp" }),
  // emit_trigger / emit_status — announce that this damage REPRESENTS a status
  // producing its effect (the Burn DoT tick carries these; trigger_status replays
  // it). Emitted DECOUPLED from the HP delta (absorb/immune ticks still count), so
  // a listener ("when a creature's Burn triggers") fires every time. See
  // [[feedback_reaction_origin_filter]] (the status_triggered successor).
  textCol("emit_trigger", "Emit Trigger", { tooltip: "deal_damage: a reaction trigger to fire after this row applies, regardless of the HP delta (e.g. \"creature_status_triggered\"). Pairs with Emit Status. Blank = none. Used by the Burn tick + trigger_status.", vis: DEAL_VIS }),
  textCol("emit_status", "Emit Status", { tooltip: "deal_damage: the status NAME carried on the emitted event's payload.status (e.g. \"Burn\"), so a listener scopes via reaction_status_filter. Defaults to the row's attacker_name/source when blank.", vis: DEAL_VIS }),
  textCol("damage_amount", "Damage Amount", { tooltip: "Damage formula. deal_damage: amount dealt per target. adjust_damage: the operand.", vis: DEAL_OR_ADJUST_VIS }),
  selectCol("damage_operation", "Damage Op", [
    { key: "add",      value: "Add" },
    { key: "subtract", value: "Subtract" },
    { key: "multiply", value: "Multiply" },
    { key: "set",      value: "Set" },
    { key: "cap",      value: "Cap (upper bound)" },
    { key: "floor",    value: "Floor (lower bound)" },
  ], { tooltip: "How adjust_damage combines its amount with the in-flight damage.", vis: ADJUST_VIS, defaultValue: "add" }),
  selectCol("damage_stage", "Damage Stage", [
    { key: "outgoing", value: "Outgoing (attacker, pre-resolve)" },
    { key: "incoming", value: "Incoming (victim, at HP-write)" },
  ], { tooltip: "Which side adjust_damage modifies.", vis: ADJUST_VIS, defaultValue: "outgoing" }),
  // adjust_accuracy config — action-level accuracy override (the accuracy twin of
  // adjust_damage). Was added (Magical Artillery / Adversity / Cognitive Focus /
  // Crossfire) without effect_table columns → its operand was data-only / strippable
  // on a sheet save. Register so boot self-heals the columns. See [[feedback_csb_template_gating]].
  textCol("accuracy_amount", "Accuracy Amount", { tooltip: "adjust_accuracy: the operand (number or formula) combined with the action's accuracy total. e.g. SL * 2, min(STATUS_COUNT,3).", vis: ADJUST_ACC_VIS }),
  selectCol("accuracy_operation", "Accuracy Op", [
    { key: "add",      value: "Add" },
    { key: "subtract", value: "Subtract" },
    { key: "set",      value: "Set (e.g. Crossfire → 0 = miss)" },
  ], { tooltip: "adjust_accuracy: how Accuracy Amount combines with the in-flight accuracy total. Add raises the total (recomputes hit/miss); Set overrides it (Crossfire sets 0).", vis: ADJUST_ACC_VIS, defaultValue: "" }),
  // adjust_grant config — per-target heal/restore boost on the in-flight card.
  // Same story as adjust_accuracy above: shipped with Cognitive Focus / Potion Rain
  // and left data-only, so a sheet save could strip the operand. Registered here so
  // boot self-heals the columns. See [[feedback_new_prop_needs_template_column]].
  // Union of every kind whose handler reads grant_amount: grant and
  // consume_resource (:1205, `row.consume_amount ?? row.grant_amount`),
  // adjust_grant (:4827), and set_resource (:4980,
  // `row.grant_amount ?? row.set_amount`). set_resource was missed on the first
  // pass despite 17 authored cells — the comment claimed "union" and wasn't one.
  textCol("grant_amount", "Grant Amount", { tooltip: "The operand (number or formula) combined with the restore amount. adjust_grant: e.g. 5, SL * 2. grant / consume_resource / set_resource: the amount moved or set.", vis: `or(or(equalText(sameRow("effect_kind",''), "grant"), equalText(sameRow("effect_kind",''), "consume_resource")), or(${ADJUST_GRANT_VIS}, equalText(sameRow("effect_kind",''), "set_resource")))`, reconcileVis: true }),
  selectCol("grant_operation", "Grant Op", [
    { key: "add",      value: "Add" },
    { key: "subtract", value: "Subtract" },
    { key: "multiply", value: "Multiply (Potion Rain × 0.5)" },
    { key: "set",      value: "Set" },
    { key: "cap",      value: "Cap (upper bound)" },
    { key: "floor",    value: "Floor (lower bound)" },
  ], { tooltip: "How Grant Amount combines with the target's restore amount. Default Add.", vis: `or(equalText(sameRow("effect_kind",''), "grant"), ${ADJUST_GRANT_VIS})`, reconcileVis: true, defaultValue: "" }),
  // `target_ref` and `damage_verbosity` existed as LIVE columns with no registry
  // entry, so neither could self-heal onto a template and neither gate could be
  // corrected from here. target_ref's live gate excluded add_target — whose
  // handler REQUIRES it (skill-effects.js:4713) — so the field the engine
  // demands could not be set from the sheet at all.
  // UNGATED, deliberately. target_ref is authored on 20 distinct kinds (212 cells
  // outside any plausible enumeration) and read by handlers on most of them —
  // consume_resource (:5523), free_action (:8336), take_turn_next (:9317),
  // leave_combat (:3693), destroy_summon (:3734), set_resource (:4983),
  // save_check (:8485), summon (:9064) …
  //
  // A first attempt listed the kinds this pass happened to move rows TO, which
  // hid 212 authored cells — the same error this file had just corrected in
  // `menu_title`. Enumerating kinds for a field this broad is the wrong shape.
  // Ungating is affordable now that CompactDynamicTable folds an empty chip to
  // nothing: the cost of an ungated cross-kind field is a fold entry, not a
  // column on every row.
  textCol("target_ref", "Target Ref", { tooltip: "Label of the targeting row (or another row) whose resolved targets this row acts on. Blank usually means 'self' or the action's own targets, per kind.", vis: "", reconcileVis: true }),
  selectCol("damage_verbosity", "Damage Verbosity", [
    { key: "",      value: "(default)" },
    { key: "full",  value: "Full — itemised breakdown" },
    { key: "short", value: "Short — total only" },
  ], { tooltip: "deal_damage / adjust_damage: how much detail the damage card shows.", vis: DEAL_OR_ADJUST_VIS }),
  selectCol("grant_scope", "Grant Scope", [
    { key: "per_target", value: "Per target (gate each by Condition)" },
    { key: "per_action", value: "Per action (every grant target)" },
  ], { tooltip: "adjust_grant: per_target evaluates Condition Formula against each grant target (Cognitive Focus → my focus only); per_action boosts every grant target unconditionally.", vis: ADJUST_GRANT_VIS, defaultValue: "per_target" }),
  selectCol("grant_resource", "Grant Resource", [
    { key: "",    value: "(any)" },
    { key: "hp",  value: "HP only" },
    { key: "mp",  value: "MP only" },
    { key: "ip",  value: "IP only" },
    { key: "all", value: "All resources" },
  ], { tooltip: "adjust_grant: only boost restores of this resource. Blank or All = any. Butler Uniform filters hp, Maid Uniform filters mp.", vis: ADJUST_GRANT_VIS }),
  selectCol("grant_round", "Grant Rounding", [
    { key: "up",   value: "Up (default)" },
    { key: "down", value: "Down" },
  ], { tooltip: "adjust_grant: rounding for a fractional Multiply result. Ignored by Add/Set.", vis: ADJUST_GRANT_VIS, reconcileVis: true, defaultValue: "" }),
  // modify_turns config — adjust a target's remaining actions (Stop = -1, min 0).
  // turns_delta lands this round; an unspendable reduction carries to the NEXT turn
  // (combatant.flags.pendingTurnDebt). Was data-only until registered here.
  textCol("turns_delta", "Turns Delta", { tooltip: "modify_turns: signed change to the target's action count (e.g. -1 = one fewer action; positive = grant an extra action). Lands this round, else carries one-time to the target's next turn.", vis: MODIFY_TURNS_VIS }),
  textCol("turns_floor", "Turns Floor", { tooltip: "modify_turns: lower clamp on the target's remaining actions this round (default 0 — can't drop below 0).", vis: MODIFY_TURNS_VIS }),
  // create_bond config — the Bond's emotion when no AE template supplies one
  // (the AE template's flags.bondAE.emotions wins when present). Heart of Darkness.
  textCol("bond_emotion", "Bond Emotion", { tooltip: "create_bond: the emotion for the formed Bond (e.g. hatred) when the ae_template_ref AE doesn't carry flags.bondAE.emotions. Default 'hatred'.", vis: CREATE_BOND_VIS }),
  // trigger_opportunity config — how many Opportunity picks to offer + whether
  // they must be distinct (A Million Possibility: count 3, distinct).
  // `count` is genuinely cross-kind and the live gate admitted only
  // targeting/consume_charge, leaving ~100 authored cells uneditable — most of
  // them on remove_tagged_ae, where `count: "all"` is load-bearing
  // (skill-effects.js:9623 removes every match). Union of the kinds that read
  // it; widening can only reveal authored data, never hide it.
  // UNGATED for the same reason as target_ref: authored on 10 kinds (targeting
  // 130, remove_tagged_ae 61, consume_charge 42, remove_ae 13, apply_ae 9,
  // redirect_target 5, transfer_ae 3, trigger_opportunity 3, open_action_menu 2,
  // deal_damage 1). The live gate admitted two of those and left ~100 cells
  // uneditable, several of them load-bearing — `count: "all"` on
  // remove_tagged_ae removes every match (skill-effects.js:9628).
  // ⚠ 60 cells hold the STRING "all" and 7 hold "SL" against a numberField live
  // column; the type is a separate migration and is why this entry stays textCol.
  textCol("count", "Count", { tooltip: "How many to act on. targeting: how many targets. remove_ae / remove_tagged_ae / transfer_ae: how many AEs — 'all' acts on every match. trigger_opportunity: how many Opportunity picks (A Million Possibility = 3).", vis: "", reconcileVis: true }),
  checkboxCol("distinct", "Distinct Picks", { tooltip: "trigger_opportunity: when checked, an already-chosen Opportunity is removed from later pickers (RAW 'the same Opportunity cannot be chosen twice').", vis: TRIGGER_OPP_VIS, defaultChecked: false }),
  textCol("opportunity_title", "Opportunity Title", { tooltip: "trigger_opportunity: optional title shown above the Opportunity wheel (default 'Critical! — Spend an Opportunity').", vis: TRIGGER_OPP_VIS }),
  // apply_action_keyword config — which keyword to tag the in-flight hit with.
  // Extensible: each new keyword = one option here + one branch in
  // recomputePerTargetDamages. Author via a creature_will_deal_damage reaction
  // (e.g. Chomp: FINAL_DAMAGE >= 100 → apply_action_keyword crush).
  // ⚠ Not every keyword can live here. This row applies at damage recompute, so
  // it can only carry keywords the engine reads AT THAT POINT. `pierce` is read
  // much earlier — action-profile.js `describePrimary` sets `pierce:
  // keywords.includes("pierce")` at the PRIMARY stage, where pierceMiss
  // (50%-on-miss) is decided, before any damage exists. A damage-conditional
  // Pierce is therefore not expressible; declare Pierce inherently on the item's
  // `action_keywords` prop instead.
  selectCol("action_keyword", "Action Keyword", [
    { key: "drain",  value: "Drain (heal user 50% of damage dealt)" },
    { key: "crush",  value: "Crush (step affinity down one level)" },
    // `benign` was already authored on 2 live rows (The Tormentor) and IS read
    // at damage recompute (action-profile.js:681, reactionKeywords), but was
    // missing from this list — so the next sheet save would have silently
    // dropped a value outside the options and killed the behaviour.
    { key: "benign", value: "Benign (cannot reduce the target below 1 HP)" },
  ], { tooltip: "apply_action_keyword: the keyword applied to this hit. Drain = the attacker recovers HP equal to half the HP damage this hit deals (Tinkerer Vampire infusion; matches the Keyword Repository). Crush = damage cannot be reduced (skips flat + % DR, a reducing weapon-efficiency, and a <1 damage_taken_mult) AND steps the target affinity DOWN one level on NE < RS < IM < AB (AB→IM, IM→RS, RS→NE; NE is the floor, VU untouched). Shields still absorb. NO DEFAULT ON PURPOSE — an unset row applies no keyword. The old default was 'pierce', which is how the Tinkerer's Vampire infusion silently shipped as ignore-Resistance instead of Drain: the author never touched the dropdown.", vis: KEYWORD_VIS, defaultValue: "" }),
  // GENERIC row gate — a non-empty formula gates this row at dispatch (falsy →
  // skip the row, chain continues) AND, when the row is a menu option
  // (referenced by an open_action_menu), drops the option from the menu entirely.
  // Used for: tier-gating Gadgets infusions (GADGET_INFUSION_TIER >= 2), Prepare-
  // to-Charge style conditionals, Soul Steal HIT_COUNT > 0, etc. Always visible.
  // SPECIAL CASE: on an apply_action_keyword row the gate is evaluated LATER (post
  // pre-resolve bonuses) so it may reference FINAL_DAMAGE (e.g. Chomp's crush:
  // "FINAL_DAMAGE >= 100"); on every other kind it's a dispatch-time gate. That
  // late evaluation is exactly why `pierce` cannot be granted this way.
  textCol("condition_formula", "Row Condition", { tooltip: "Generic gate: blank = always. Falsy → skip this row (chain continues); on a menu-option row, falsy also HIDES the option. e.g. GADGET_INFUSION_TIER >= 2, HIT_COUNT > 0. (apply_action_keyword: evaluated post-bonus, may use FINAL_DAMAGE.)", vis: "", reconcileVis: true }),
  // notify — surface a short message (stub branches / info toast).
  textCol("notify_message", "Notify Message", { tooltip: "notify: the text shown (chat + UI toast). e.g. \"Alchemy gadgets are not yet implemented.\"", vis: NOTIFY_VIS }),
  selectCol("notify_type", "Notify Type", [
    { key: "info",    value: "Info" },
    { key: "warning", value: "Warning" },
    { key: "error",   value: "Error" },
  ], { tooltip: "notify: UI toast level.", vis: NOTIFY_VIS, defaultValue: "info" }),
  checkboxCol("notify_abort", "Notify Abort", { tooltip: "notify: stop the chain after the message (default ON — a stub branch has nothing more to do). Uncheck to notify then continue.", vis: NOTIFY_VIS, defaultChecked: true }),
  // change_damage_element — override the in-flight attack's element for the chosen
  // targets (Infusions: Cryo→ice, Pyro→fire, …). Applied at the card-mutation phase
  // (re-derives each target's affinity for the new element). Literal element id or
  // VAR_<NAME> (a prompt_element pick from earlier in the chain).
  textCol("change_element", "Change To Element", { tooltip: "change_damage_element: the new element — fire/ice/bolt/earth/air/light/dark/poison/physical, or VAR_<NAME> from an earlier prompt_element pick.", vis: CHANGE_EL_VIS }),
  // check_die_swap config (Psychokinesis) — which Attribute to swap an accuracy die TO + firing mode.
  selectCol("swap_to_attribute", "Swap To Attribute", [
    { key: "WLP", value: "WLP — Willpower" },
    { key: "INS", value: "INS — Insight" },
    { key: "MIG", value: "MIG — Might" },
    { key: "DEX", value: "DEX — Dexterity" },
  ], { tooltip: "check_die_swap: the Attribute to replace one accuracy-check die with (its die size).", vis: CHECK_DIE_SWAP_VIS, defaultValue: "WLP" }),
  selectCol("swap_mode", "Swap Mode", [
    { key: "on",  value: "On — auto-swap the best beneficial die" },
    { key: "ask", value: "Ask — pre-roll picker (player chooses)" },
    { key: "off", value: "Off — disabled" },
  ], { tooltip: "check_die_swap: on = auto-swap the biggest upgrade · ask = pre-roll picker · off = disabled. One charge per swap skill (a single skill can't swap both dice).", vis: CHECK_DIE_SWAP_VIS, defaultValue: "on" }),
  // set_check_die config — replace one rolled die with a value (Hina's Lucky Seven
  // is the first user). `which_die` is authored one per open_action_menu option
  // (die A / die B) when the player chooses; the pick routes the chosen option's
  // set_check_die row to the card-mutation phase. Blank → the mutation falls back to
  // the lower die.
  selectCol("which_die", "Which Die", [
    { key: "A", value: "A — the first die" },
    { key: "B", value: "B — the second die" },
  ], { tooltip: "set_check_die: which rolled die this row replaces (A = first / rA, B = second / rB). Blank → the lower die.", vis: SET_CHECK_DIE_VIS, defaultValue: "A" }),
  // The value to set the die to: a number, a formula (reactor context), or blank to
  // use the CARRIER AE's charge (so a charge-bearing AE acts as a stored die value
  // — Lucky Seven leaves this blank and stores 7 on the carrier "Lucky Number" AE).
  textCol("die_value", "Die Value", { tooltip: "set_check_die: value to set the die to (number or formula). Blank → use the carrier AE's charge as the value (a stored die value). No clamp to die faces — an impossible value like 7 on a d6 is allowed (RAW).", vis: SET_CHECK_DIE_VIS }),
  // Mutate the stored value: write the REPLACED die's old face back to the carrier
  // AE's charge (Lucky Seven's "the replaced value becomes your new lucky number").
  checkboxCol("writeback_carrier_charge", "Writeback Old Face", { tooltip: "set_check_die: when checked, the replaced die's OLD face is written back to the carrier AE's charge, so the stored value mutates on each use (Lucky Seven: the swapped-out value becomes the new lucky number).", vis: SET_CHECK_DIE_VIS, defaultChecked: false }),
  // targeting config — Auto-target. Governs ASSURED targets (self / all / single).
  // "auto" (default) is ROLE-BASED: the GM resolves silently for pace; a PLAYER
  // gets a locked Confirm so they see what they're committing to. "skip" = never
  // prompt (either role); "confirm" = always lock-prompt (either role). Engine
  // reads it in skill-targeting.resolveTargetingRow; passive auto-fires always
  // skip regardless. Default "auto" so a sheet save preserves the role-based behavior.
  // apply_ae add_charges config — charge count to grant/increment. Data-only until
  // now (the add_charges option migration never added the column), so a sheet save
  // could strip it and an "+1 per turn" stacker would fall back to the template's
  // default charges. Register so boot-3b self-heals the column. See Burning Grasp.
  textCol("ae_initial_charges", "Initial Charges", { tooltip: "apply_ae: charge count to grant (add_charges: amount to add per application; otherwise the new AE's starting charges). Blank = AE template's charges.", vis: APPLY_AE_VIS }),
  textCol("ae_initial_charges_max", "Charges Max", { tooltip: "apply_ae add_charges: cap on total charges. Blank = template chargesMax / uncapped.", vis: APPLY_AE_VIS }),
  // apply_ae replace_family group id. When ae_duplicate_mode is replace_family
  // (or replace_family_per_caster), only ONE AE carrying this family may exist
  // on a creature — re-applying a sibling variant (e.g. Elemental Shroud Fire
  // over Ice) replaces the prior one even though name + status differ. Blank =
  // fall back to the AE template's own flags.fabula-ultima-companion.aeFamily.
  // Data-only without a column → strippable on a sheet save; register so
  // boot-3b self-heals it. See Elemental Shroud / Elemental Weapon (Hina).
  textCol("ae_family", "AE Family", { tooltip: "apply_ae replace_family: group id for the 'one of its kind per creature' rule (e.g. elemental-shroud). Blank = use the AE template's aeFamily flag.", vis: APPLY_AE_VIS }),
  // Random-pool mode. `ae_name_pool` (hand-listed) was data-only and therefore
  // strippable on a sheet save; register both so boot-3b self-heals them.
  textCol("ae_name_pool", "AE Name Pool", { tooltip: "apply_ae: comma/semicolon/pipe-separated AE names; ONE is picked at random per target instead of Template Ref (Draconic Roar). Prefer AE Pool Tag when you mean \"any status of this kind\".", vis: APPLY_AE_VIS }),
  textCol("ae_pool_tag", "AE Pool Tag", { tooltip: "apply_ae: build the random pool LIVE from every curated status carrying this tag (e.g. \"debuff\"), instead of hand-listing names — so the roll keeps covering the whole library as it grows. Untagged statuses (KO/Death) can never be rolled. Takes precedence over AE Name Pool. Backs Magic Mushroom.", vis: APPLY_AE_VIS }),
  // Per-application duration override. Without it, "for the rest of the scene"
  // could only be expressed by giving the item its own COPY of a shared status,
  // which splits the definition (Blue Bovine vs Milk both grant Strong).
  textCol("ae_duration_rounds", "Duration (turns)", { tooltip: "apply_ae: how long THIS application lasts, overriding the AE template's duration.rounds. \"scene\" (or 0) = lasts until the battle ends (no turn counter; the scene-end sweep removes it). A number = that many turns. Blank = the template's duration.rounds, else the 3-turn default.", vis: APPLY_AE_VIS }),
  selectCol("auto_target", "Auto-target", [
    { key: "auto",    value: "Auto — GM skips, player confirms (default)" },
    { key: "skip",    value: "Always skip (no prompt)" },
    { key: "confirm", value: "Always confirm (locked prompt)" },
  ], { tooltip: "Assured targets (self/all/single): Auto = GM silent for pace + player gets a locked Confirm; Skip = never prompt; Confirm = always lock-prompt.", vis: TGT_VIS, defaultValue: "" }),
  // targeting filters — two orthogonal, non-growing axes for narrowing the pool.
  // target_filter = per-candidate predicate (keep where truthy; invert for
  // exclusion). exclude = membership exclusion by ref (reserved or named).
  textCol("target_filter", "Target Filter", { tooltip: "targeting: per-candidate keep-if-truthy formula, evaluated against EACH candidate's own actor. e.g. \"AE_CHARGES_BURN >= 1\" (must carry Burn). Exclude is the inverse: \"AE_CHARGES_BURN == 0\" / \"!(...)\". Blank = no filter.", vis: TGT_VIS }),
  textCol("exclude", "Exclude Refs", { tooltip: "targeting: drop any candidate appearing in these ref(s) — reserved (\"self\", \"action_targets\") or named targeting-row labels, comma-listed (\"self,tether_giver\"). Generic replacement for exclude_self / exclude_action_targets.", vis: TGT_VIS }),
  checkboxCol("allow_empty", "Allow Empty", { tooltip: "targeting: this row may legitimately resolve to ZERO targets (e.g. \"the REST of the enemies\" when there is only one). Without it, an empty pool returns ok:false and HALTS the enclosing chain; with it, an empty pool resolves to an empty set so dependent target_ref applies no-op and the chain continues.", vis: TGT_VIS }),
  // free_action config — perform ONE free turn-action (no menu). action_ref names
  // it: "self" (re-perform the carrier skill), a skill/item NAME on the actor, or
  // an action TYPE / comma-list ("Attack" / "Attack,Hinder" → compose filtered,
  // like the legacy free_mode). target_ref (a general column) optionally LOCKS the
  // targets (Counterattack → the attacker); blank → picked at TARGET by role.
  textCol("action_ref", "Free Action Ref", { tooltip: 'free_action: what to perform — "self" (re-cast the carrier skill), a skill/item NAME on the actor, or an action TYPE / comma-list ("Attack" / "Attack,Hinder"). A single specific action skips the menu and auto-performs.', vis: FREE_ACTION_VIS }),
  checkboxCol("chain", "Chain Strike", { tooltip: "free_action: mark this as a CHAIN strike (not a Free Attack) — it bypasses preventFreeAttack, so a 'no Free Attacks' debuff can't stop a Chain N attack. Used by Centimare Scythe (Chain 2).", vis: FREE_ACTION_VIS }),
  // Bonus/cost fields shared with the open_action_menu free_mode grant (register
  // them so the column self-heals where missing; free_action reuses the same
  // free-action queue + COMPUTE-time bonus application).
  textCol("check_bonus_formula", "Free: Check Bonus", { tooltip: "Free action grant: bonus added to the granted action's Check (formula). e.g. Blazing Sweep repeat: -(AE_CHARGES_BLAZING_SWEEP_LOCK).", vis: FREE_GRANT_VIS, reconcileVis: true }),
  textCol("damage_bonus_formula", "Free: Damage Bonus", { tooltip: "Free action grant: bonus added to the granted action's damage (formula, may be negative). e.g. Blazing Sweep repeat: floor(38 * pow(0.5, AE_CHARGES_BLAZING_SWEEP_LOCK)) - 38.", vis: FREE_GRANT_VIS, reconcileVis: true }),
  textCol("max_mp_cost", "Free: Max MP Cost", { tooltip: "Free action grant: cap on the granted action's MP cost (FORMULA, e.g. Bimagus \"20 + MP_SPENT_THIS_TURN\" / \"AE_CHARGES_BIMAGUS\"; blank = the action's own cost applies).", vis: FREE_GRANT_VIS, reconcileVis: true }),
  checkboxCol("free_of_cost", "Free: No Resource Cost", { tooltip: "Free action grant: the granted action pays NO resource cost (RAW Bimagus \"spells cost no MP\"). The Max MP Cost cap still gates which spell is eligible by its printed cost.", vis: FREE_GRANT_VIS }),
  textCol("element_override", "Free: Element Override", { tooltip: 'free_action: force the spawned action\'s damage element. "trigger_element" adopts the trigger payload\'s element (Ripples: "all its damage becomes the type dealt by your ally"); any other value is a literal element (fire/ice/bolt/…). Blank = the weapon\'s own element.', vis: FREE_ACTION_VIS }),
  textCol("on_hit_effect_refs", "Free: On-Hit Effect Refs", { tooltip: "free_action: effect_label(s) on THIS skill's effect_table to run AFTER the spawned attack RESOLVES, against its hit targets (hit_action_targets). Gated on a real hit. Comma/newline list. Ripples ends all \"hex\" AEs on the struck enemy via a remove_tagged_ae row.", vis: FREE_ACTION_VIS }),
  textCol("performer_ref", "Free: Performer Ref", { tooltip: 'free_action: WHO performs the granted action. Blank = the reactor (the reaction\'s bearer). A target ref (e.g. "action_targets", "trigger_subject", or a targeting-row label) grants the free action to a RESOLVED ally instead — Glowstick: "an ally other than yourself performs a free Magichant/Dance". The compose picker then lists that ally\'s own skills (filtered by Allowed Skill Refs).', vis: FREE_ACTION_VIS }),
  // adjust_charges config — charge arithmetic on a target's named charge-AE
  // (Enkindle: double the target's Burn = Burn × 2). Mirrors adjust_damage.
  textCol("charge_ae_name", "Charge AE Name", { tooltip: "adjust_charges: the charge-AE to modify, by name (e.g. Burn).", vis: ADJUST_CHARGES_VIS }),
  selectCol("charge_operation", "Charge Op", [
    { key: "add",      value: "Add" },
    { key: "subtract", value: "Subtract" },
    { key: "multiply", value: "Multiply" },
    { key: "set",      value: "Set" },
    { key: "cap",      value: "Cap (upper bound)" },
    { key: "floor",    value: "Floor (lower bound)" },
  ], { tooltip: "adjust_charges: how charge_amount combines with the target's current charge count.", vis: ADJUST_CHARGES_VIS, defaultValue: "multiply" }),
  textCol("charge_amount", "Charge Amount", { tooltip: "adjust_charges: the operand (number or per-target formula). e.g. 2 to double.", vis: ADJUST_CHARGES_VIS }),
  textCol("charge_max", "Charge Max", { tooltip: "adjust_charges: optional cap on the resulting charge total. Blank = uncapped.", vis: ADJUST_CHARGES_VIS }),
  // trigger_status config — fire a charge-based status's OWN tick on the target(s)
  // (a skill that 'triggers Burn': Flame Claw, Meteor Impact). Runs the real tick
  // (formula read from the status's common-AE — DRY) and emits creature_status_triggered.
  // BATCHED: N stacks => one N×(per-tick) deal_damage per target. See trigger_status.
  textCol("status_name", "Trigger Status Name", { tooltip: "trigger_status: the status/AE to trigger by name (e.g. Burn). Its tick formula + element are read from the status's common-AE definition.", vis: TRIGGER_STATUS_VIS }),
  textCol("trigger_count", "Trigger Count", { tooltip: "trigger_status: how many stacks to trigger (per-victim number or formula). Default 1. \"AE_CHARGES_BURN\" = all of the target's stacks (batched into one N×tick hit).", vis: TRIGGER_STATUS_VIS }),
  checkboxCol("consume_charges", "Consume Charges", { tooltip: "trigger_status: also REMOVE Trigger Count charges of the status from each target (Flame Claw: trigger 1 + consume 1). Off = the skill manages charges (Meteor triggers all, then halves via adjust_charges).", vis: TRIGGER_STATUS_VIS }),
  checkboxCol("suppress_status_trigger", "Suppress Status Trigger", { tooltip: "trigger_status: do NOT emit the creature_status_triggered signal for this detonation, so status-trigger listeners (e.g. Ignition) don't react to it. Damage/element/affinity are unchanged. Meteor Impact uses this so detonating Burn doesn't refund Wandering Flame's own Zero Power.", vis: TRIGGER_STATUS_VIS }),
  // prompt_number config — interactive amount picker. Stores the entered value as
  // a chain variable read later via the VAR_<NAME> formula identifier (Blazing
  // Tether's move = prompt_number then two adjust_charges using VAR_MOVE_AMOUNT).
  textCol("prompt_var", "Prompt Var", { tooltip: "prompt_number / prompt_element: variable name to store the chosen value under. Read later as VAR_<NAME> (e.g. prompt_var \"move_amount\" → VAR_MOVE_AMOUNT; \"element\" → VAR_ELEMENT).", vis: PROMPT_VAR_VIS, reconcileVis: true }),
  // prompt_element config — interactive damage-type picker. Stores the chosen
  // element string under prompt_var; a later deal_damage reads damage_element
  // "VAR_<NAME>". Blank Element Options → the 9 FU damage types.
  textCol("element_options", "Element Options", { tooltip: "prompt_element: optional |/comma-separated element id list (e.g. \"fire|ice|bolt\"). Blank = all 9 FU types (physical, air, bolt, dark, earth, fire, ice, light, poison).", vis: PROMPT_ELEMENT_VIS }),
  textCol("prompt_label", "Prompt Label", { tooltip: "prompt_number: the dialog prompt text (e.g. \"Burn stacks to move?\").", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_min", "Prompt Min", { tooltip: "prompt_number: minimum (number or formula). Default 0.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_max", "Prompt Max", { tooltip: "prompt_number: maximum (number or formula, evaluated against Prompt Max Ref's actor). e.g. \"AE_CHARGES_BURN\". Blank = unbounded.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_max_ref", "Prompt Max Ref", { tooltip: "prompt_number: target ref whose actor the min/max/default formulas read (e.g. \"tether_giver\" so max = the giver's Burn). Blank = the caster.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_default", "Prompt Default", { tooltip: "prompt_number: the input's starting value (number or formula). Blank = max.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_step", "Prompt Step", { tooltip: "prompt_number: increment between selectable options (number or formula). Default 1. e.g. Min 10 + Step 10 → the picker offers 10, 20, 30 … up to Prompt Max.", vis: PROMPT_NUMBER_VIS }),

  // roll_dice config — auto-roll NdX into VAR_<prompt_var> (rolled through the
  // shared ONI.Dice.roll primitive). Fatigue = roll_dice 1d6 → adjust_charges.
  textCol("dice_count", "Dice Count", { tooltip: "roll_dice: number of dice to roll (number or formula). Default 1.", vis: ROLL_DICE_VIS }),
  textCol("dice_faces", "Dice Faces", { tooltip: "roll_dice: die size — 6 → d6, 8 → d8 (number or formula). Default 6. The summed total is stored under Prompt Var, read later as VAR_<NAME>.", vis: ROLL_DICE_VIS }),
  checkboxCol("roll_interactive", "Roll: Interactive", { tooltip: "roll_dice: when ON, the roll is routed to the reactor's OWNER as a Request Check-style click-to-roll panel (player manually rolls). OFF (default) = silent auto-roll. Falls back to auto in headless / harness contexts.", vis: ROLL_DICE_VIS }),
  textCol("roll_label", "Roll: Label", { tooltip: "roll_dice (interactive): caption shown on the cost-roll panel (e.g. \"Bodyguard Fatigue\"). Blank = the skill name.", vis: ROLL_DICE_VIS }),

  // confirm — N-button decision dialog. GATE mode (no Button Refs) = OK/Cancel;
  // BRANCH mode (Button Refs set) = one button per ref + Cancel (branch buttons
  // reuse the ref row's menu_label / button_style). Cancel/dismiss aborts the chain.
  textCol("confirm_title", "Confirm Title", { tooltip: "confirm: dialog title. Blank = the skill name.", vis: CONFIRM_VIS }),
  textCol("confirm_message", "Confirm Message", { tooltip: "confirm: dialog body text.", vis: CONFIRM_VIS }),
  textCol("confirm_ok_label", "Confirm OK Label", { tooltip: "confirm GATE mode: the proceed button's label. Default \"Confirm\".", vis: CONFIRM_VIS }),
  selectCol("confirm_ok_style", "Confirm OK Style", [
    { key: "default", value: "Default" }, { key: "danger", value: "Danger (red)" },
    { key: "primary", value: "Primary (blue)" }, { key: "warning", value: "Warning (amber)" },
    { key: "success", value: "Success (green)" },
  ], { tooltip: "confirm GATE mode: proceed button color.", vis: CONFIRM_VIS, defaultValue: "default" }),
  textCol("confirm_cancel_label", "Confirm Cancel Label", { tooltip: "confirm: the cancel button's label. Default \"Cancel\".", vis: CONFIRM_VIS }),
  selectCol("confirm_cancel_style", "Confirm Cancel Style", [
    { key: "default", value: "Default" }, { key: "danger", value: "Danger (red)" },
    { key: "primary", value: "Primary (blue)" }, { key: "warning", value: "Warning (amber)" },
    { key: "success", value: "Success (green)" },
  ], { tooltip: "confirm: cancel button color.", vis: CONFIRM_VIS, defaultValue: "default" }),
  textCol("confirm_button_refs", "Confirm Button Refs", { tooltip: "confirm BRANCH mode: comma-separated effect_label refs — one button per ref (any number); clicking dispatches that ref then stops the chain. Blank = GATE mode (OK/Cancel).", vis: CONFIRM_VIS }),
  // check_buff config — action-scoped passive Check bonus (Encyclopedia/Sneaker/Cat
  // Ears). Both were data-only (no column) → strippable on a sheet save. Register so
  // boot-3b self-heals them. See [[feedback_csb_template_gating]].
  textCol("check_buff_action", "Check Buff Action", { tooltip: "check_buff: comma-separated action token(s) the bonus applies to — study / stealth / strength / mobility / … — matched BY STRING against the Request Check tag. \"any\" or \"*\" = wildcard (applies to EVERY check regardless of action, e.g. Cat Ears).", vis: CHECK_BUFF_VIS }),
  textCol("check_buff_amount", "Check Buff Amount", { tooltip: "check_buff: bonus added to the matched Check (number or wielder-relative formula, e.g. 2).", vis: CHECK_BUFF_VIS }),

  // ── DATA-ONLY BACKFILL ─────────────────────────────────────────────────────
  // Fields the engine has always read but no template ever declared a column
  // for. They work (the harness reads the row dict directly) yet nobody can edit
  // them in a sheet, and CSB prunes an undeclared prop on reloadTemplate — so a
  // sheet save could delete them. `node tools/csb-template/bin/visibility-audit.js`
  // enumerates the rest; these are the highest-volume ones, with their kind gates
  // taken from measured usage rather than from the handler's doc comment.

  // remove_tagged_ae / remove_ae / transfer_ae — WHICH AEs to act on, by tag or
  // chargeKey. 76 authored cells and never a column. (The internal option name
  // is `filterTag`; the ROW field is snake_case — do not "fix" one to the other.)
  textCol("filter_tag", "Filter Tag", { tooltip: "remove_ae / remove_tagged_ae / transfer_ae: select AEs carrying this tag or chargeKey (system.tags). Comma-list = any of them; \"*\" or \"all\" = every AE. Blank = fall back to Active Effect Ref (by name).", vis: `or(${REMOVE_AE_VIS}, equalText(sameRow("effect_kind",''), "transfer_ae"))` }),

  // consume_resource — the PRIMARY fields of that kind, data-only even though its
  // accessory flag (consume_can_defeat) got a column long ago.
  // Gated to consume_resource ONLY. They are also present on 15 adjust_cost/chain
  // rows, but nothing reads them there — applyAdjustCostEffect reads cost_resource
  // / cost_amount / cost_operation (registered just below), and those rows carry
  // BOTH sets with identical values. Showing the ignored pair on an adjust_cost row
  // would invite edits that do nothing.
  selectCol("consume_resource", "Consume Resource", RESOURCE_OPTIONS,
    { tooltip: "consume_resource: which pool the amount comes out of.", vis: CONSUME_RES_VIS }),
  textCol("consume_amount", "Consume Amount", { tooltip: "consume_resource: how much to spend (number or formula, e.g. \"SL * 10\", \"max(5, AE_CHARGES_X)\").", vis: CONSUME_RES_VIS }),

  // adjust_cost — the fields that actually retune an in-flight action's cost
  // (Dance, Barrage, Cataclysm, Bimagus). 141 authored cells, never a column.
  selectCol("cost_resource", "Cost Resource", RESOURCE_OPTIONS,
    { tooltip: "adjust_cost: which resource of the in-flight action's cost to adjust.", vis: ADJUST_COST_VIS }),
  textCol("cost_amount", "Cost Amount", { tooltip: "adjust_cost: the operand (number or formula, e.g. \"MAX_MP\", \"10 * ADDED_TARGETS\", \"VAR_OVERCHARGE\").", vis: ADJUST_COST_VIS }),
  selectCol("cost_operation", "Cost Op", [
    { key: "add", value: "Add" },
    { key: "subtract", value: "Subtract" },
  ], { tooltip: "adjust_cost: how Cost Amount combines with the action's cost. Default Add.", vis: ADJUST_COST_VIS, defaultValue: "add" }),

  // substitute_cost — "pay X instead of Y" (Vismagus). Whole kind was data-only.
  // ⚠ These two are ALREADY columns, and ungated — they render on all 2221 rows
  // to serve 4. `reconcileVis` is what actually lands the gate.
  textCol("from_resource", "From Resource", { tooltip: "substitute_cost: the resource the caster cannot afford (default mp).", vis: SUBSTITUTE_COST_VIS, reconcileVis: true }),
  textCol("to_resource", "To Resource", { tooltip: "substitute_cost: the resource paid instead (default hp).", vis: SUBSTITUTE_COST_VIS, reconcileVis: true }),
  textCol("multiplier", "Substitution Rate", { tooltip: "substitute_cost: to_amount = from_amount x this. Default 2 (RAW Vismagus: 2 HP per missing MP).", vis: SUBSTITUTE_COST_VIS }),
  textCol("min_remaining", "Min Remaining", { tooltip: "substitute_cost: the minimum the payer must RETAIN in the substitute resource. Default 1 (Vismagus: \"cannot reduce yourself to 0 HP\").", vis: SUBSTITUTE_COST_VIS }),
  checkboxCol("suppress_self_grant", "Suppress Self Grant", { tooltip: "substitute_cost: also suppress any grant TO the substitute resource on the payer (RAW Vismagus: \"if the spell would heal you, you recover no HP\"). Defaults ON when substituting away from MP.", vis: SUBSTITUTE_COST_VIS }),

  // ── UNGATED COLUMNS THAT SHOULD NOT BE ────────────────────────────────────
  // Measured 2026-08-16: these render on every one of the 2221 effect rows while
  // serving a handful. Together with from_/to_resource above they are 4 of the
  // ~5 cells of pure noise on an average row — gating them is a 20% cut in the
  // columns a skill's effect_table renders (mean 21.7 → 17.4, median 17 → 13).
  //
  // NOT gated, deliberately: `count` and `menu_label` (11 kinds each) and
  // `consume_self` (read off ANY row that an AE carries — engine reads
  // `effRow.consume_self` with no kind check). Those are genuinely cross-kind;
  // their noise is the honest price of a general field.
  // target_prompt is NOT a targeting-only field, despite the name and despite all
  // 3 authored cells sitting on `targeting` rows: applyApplyAeEffect reads it
  // (reaction-grant.js — the Heart of Darkness "choose a creature you can see"
  // flow). Gate to the kinds the ENGINE reads it for, not the kinds that happen
  // to have used it, or the next apply_ae row that wants it has no cell to set.
  // ⚠ its three companions — target_prompt_filter / _title / _message — are read
  // by the same handler and have no column at all. Registering them needs their
  // shapes confirmed first; listed as a follow-up rather than guessed at here.
  textCol("target_prompt", "Target Prompt", { tooltip: "targeting / apply_ae: prompt text shown when this row asks the player to pick a target. Blank = a default built from the skill name.", vis: `or(${TGT_VIS}, ${APPLY_AE_VIS})`, reconcileVis: true }),
  // Gate = the kinds that READ it: applyApplyAeEffect (skill-effects + reaction-grant)
  // plus the redirect_target / open_action_menu rows that carry 10 authored values
  // between them. `transfer_ae` is deliberately NOT here — zero authored cells and
  // zero engine reads, i.e. pure headroom that would render an inert cell.
  // Options mirror the LIVE column exactly (11, default "replace"). "ask" is
  // omitted on purpose: it is valid in the AE-manager API but resolves to a GM
  // dialog and silently degrades to "skip" for a player, so offering it on the
  // sheet would make one authored row behave differently per viewer.
  selectCol("ae_duplicate_mode", "Duplicate Mode", [
    { key: "replace", value: "Replace — refresh the existing one" },
    { key: "stack", value: "Stack — apply another copy" },
    { key: "skip", value: "Skip — do not re-apply if present" },
    { key: "remove", value: "Remove — strip it instead" },
    { key: "replace_per_caster", value: "Replace, per caster" },
    { key: "skip_per_caster", value: "Skip, per caster" },
    { key: "remove_per_caster", value: "Remove, per caster" },
    { key: "add_charges", value: "Add charges — increment instead of re-applying" },
    { key: "replace_same_status", value: "Replace same status (Hinder-style dedup)" },
    { key: "replace_family", value: "Replace family — one per aeFamily" },
    { key: "replace_family_per_caster", value: "Replace family, per caster" },
  ], { tooltip: "apply_ae: what to do when the target already carries this AE. Also read on a redirect_target / open_action_menu row that applies one.", vis: `or(${APPLY_AE_VIS}, equalText(sameRow("effect_kind",''), "redirect_target"), ${OAM_VIS})`, defaultValue: "replace", reconcileVis: true }),

  // Menu presentation. UNGATED, and that is a considered choice, not an oversight.
  //
  // The rule the engine implements is "this row is named in some other row's
  // menu_option_refs" — which no per-row CSB formula can express. An earlier
  // draft gated these on the row having a `menu_label`, on the evidence that all
  // 149 + 80 authored cells sit on a row that has one. That correlation is an
  // artifact of two authoring shapes having been used disjointly so far, NOT a
  // rule: skill-effects.js states per-option `menu_label` is the LEGACY shape and
  // resolves label / description / colour through three INDEPENDENT fallbacks, so
  // a row whose label comes positionally from the parent's `menu_option_labels`
  // is a perfectly ordinary option — 196 of the 376 referenced option rows are
  // exactly that. The gate would have hidden the description/colour cells on all
  // of them, and the only workaround would be typing a redundant menu_label the
  // engine then ignores. That is the same "gate derived from observed usage
  // instead of from the read sites" failure as the target_prompt one above.
  //
  // Cost of staying ungated, stated plainly: two more always-visible columns.
  // `reconcileVis` is set so the boot sync CLEARS the bad gate from any template
  // that already received it.
  textCol("menu_description", "Menu Description", { tooltip: "Shown under this row's label when it is offered as a menu option. Supports ${...} interpolation. The parent menu's Option Descriptions win when it supplies one.", vis: "", reconcileVis: true }),
  textCol("menu_color", "Menu Color", { tooltip: "Accent colour (CSS, e.g. #e8603c) for this row's option in a menu. The parent menu's Option Colors win when it supplies one. Blank = no accent.", vis: "", reconcileVis: true }),
];

// ── reaction_config_table declarative fields ─────────────────────────────────
export const REACTION_CONFIG_REQUIRED_COLUMNS = [
  selectCol("reaction_passive_mode", "Firing Mode", [
    { key: "ask",   value: "Ask — player decides (clickable pill)" },
    { key: "on",    value: "On — auto-fires, visible" },
    { key: "off",   value: "Off — disabled" },
    { key: "force", value: "Force — auto-fires, UI-invisible (engine-mandatory)" },
  ], { tooltip: "ask = clickable pill · on = auto-fire visible · off = disabled · force = auto-fire, engine-only.", defaultValue: "ask" }),
  // WHO an auto-firing row targets. Registry-owned so the broken gate below can
  // be corrected everywhere: it was `sameRow("reaction_isPassive")`, a prop the
  // reaction editor stopped writing when firing MODE replaced the passive flag.
  // Zero of 544 live rows carry it, so all 142 authored Passive Target values
  // were invisible — while ActiveEffectManager-reaction-ui warns when an
  // auto-firing row LACKS one. Unfixable from the sheet: the cell was not there.
  // Option set matches the reaction editor's PASSIVE_TARGET_OPTIONS (["self"])
  // and every one of the 142 live values. Kept as a select, not a text field, so
  // it cannot drift; widen BOTH lists together if another target ever lands.
  selectCol("reaction_passive_target", "Passive Target", [
    { key: "self", value: "Self" },
  ], { tooltip: "Who an auto-firing (on / force) reaction resolves its effect against. Required whenever Firing Mode is on or force — the reaction editor warns when it is blank. Hidden only when the row is switched off.", vis: PASSIVE_LIVE_VIS, reconcileVis: true }),
  // Responder — hand the ASK prompt to the action's TARGET instead of this row's
  // bearer (Torment / Condemn). The engine accepts exactly one value: anything
  // that isn't "target" falls through to the bearer (findTargetOwnedCandidates,
  // skill-effects.js), so a typo is a silent no-op.
  // Deliberately a textField, NOT a select, even though a select would express
  // that better: every live template carries this column as a textField, and the
  // reconcile skips on a type mismatch — so a select here would decline to ship
  // on _Skill Template, the one template that actually has the two live rows.
  // Guidance that reaches the author beats a stricter widget that does not.
  // Changing the type is a migration; see the type-divergence follow-up.
  // Left UNGATED: who answers a prompt is independent of what fired it.
  textCol("reaction_responder", "Responder", { tooltip: "Who ANSWERS this reaction. \"target\" = the action's target decides (target-owned reaction — Condemn / Torment). Blank or \"self\" = this row's bearer (default). No other value is recognised — an unrecognised string silently falls back to the bearer.", vis: "", reconcileVis: true }),
  // Resource-ledger trigger filters (creature_lose_resource / creature_gain_resource).
  // Blank = any. resource matches the changed resource; cause matches why.
  textCol("reaction_resource_filter", "Resource Filter", { tooltip: "Resource-change triggers: fire only when this resource changed — hp/mp/ip/fp/zero_power/shield/zenit/enmity. Blank = any.", vis: RESOURCE_TRIG_VIS, reconcileVis: true }),
  textCol("reaction_cause_filter", "Cause Filter", { tooltip: "Resource-change triggers: fire only for this cause — damage/hazard/cost/drain/grant/heal. Blank = any. (damage = inflicted attack; hazard = Burn/Poison/environment.) Also read on creature_defeated, to scope \"defeated BY <cause>\".", vis: RESOURCE_TRIG_VIS, reconcileVis: true }),
  // Damage-SOURCE (origin) filter — fire only when the resource change was dealt by
  // an effect/skill/status of this NAME (payload.originLabel, e.g. "Burn", a weapon
  // name). WHAT dealt it (vs reaction_source's WHO). General "react to damage from
  // source X". See [[feedback_reaction_origin_filter]].
  textCol("reaction_origin_filter", "Origin Filter", { tooltip: "Resource-change triggers: fire only when the change's SOURCE name (the effect/skill/status that dealt it — payload.originLabel, e.g. \"Burn\") matches. Blank = any. Distinct from Source (which creature).", vis: RESOURCE_TRIG_VIS, reconcileVis: true }),
  // Status-ledger filter (creature_status_applied / creature_status_triggered).
  textCol("reaction_status_filter", "Status Filter", { tooltip: "Status triggers: fire only when this status (AE) changed — e.g. Crisis. Blank = any.", vis: STATUS_TRIG_VIS, reconcileVis: true }),
  // Action-kind filter. Comma-list of action TYPES the reaction accepts
  // (Attack/Skill/Spell/Item/Guard/…), matched vs payload.actionKind. Authored
  // against performs_action AND targeted_by_action / will_deal_damage /
  // hit_by_action / completes_action — hence the family gate, not a single key.
  textCol("reaction_action_kind", "Action Kind Filter", { tooltip: "Action triggers: fire only for these action TYPES — comma-list (e.g. \"Attack,Skill,Spell\"). Matched against the acting creature's action kind. Blank = any kind.", vis: ACTION_TRIG_VIS, reconcileVis: true }),
  // Source-skill NAME filter — "the action came from <Skill>". Despite the old
  // wording this is used far more on the damage triggers (creature_deals_damage /
  // creature_will_deal_damage = 49 of 58 live rows) than on creature_completes_skill.
  textCol("reaction_source_skill", "Source Skill Filter", { tooltip: "Action triggers: fire only when the skill/action driving the event has this NAME (e.g. \"Crossfire\"). Most often used on the damage triggers to scope a rider to one weapon or spell. Blank = any skill.", vis: ACTION_TRIG_VIS, reconcileVis: true }),
  // Per-round fire quota — bound how many times this reaction row may auto/ask-fire
  // within one BD round (counter resets each round, wiped at combat end). Wandering
  // Flame's Ignition caps Burn-triggered MP/ZP gains at 3/round.
  textCol("reaction_max_per_round", "Max Fires", { tooltip: "Limit how many times this reaction can fire (e.g. 3). The row is hidden/skipped once its quota is spent. What the quota resets against is set by Max Scope. Blank or 0 = unlimited." }),
  // Which bucket the Max Fires quota counts into. Was per-round only; the scope
  // dimension is what lets "once per target" (Pantie) be plain config instead of
  // a second bespoke ledger alongside Study's studyLog. See the cap block in
  // skill-effects.js.
  selectCol("reaction_max_scope", "Max Scope", [
    { key: "round",        value: "Per round (default)" },
    { key: "battle",       value: "Per battle" },
    { key: "target",       value: "Per target, whole battle (once per creature)" },
    { key: "target_round", value: "Per target, per round" },
  ], { tooltip: "What the Max Fires quota resets against. Per round = the classic cap. Per battle = N times all fight. Per target = N times against EACH creature for the whole fight (\"this effect triggers once per target\"). Per target, per round = both. Ignored when Max Fires is blank/0.", defaultValue: "round" }),
  // Weapon-USED gate (the gear `_skill`-inside-a-WEAPON model). When CHECKED, this
  // row only fires if the weapon backing the carrier is the one ACTUALLY USED in the
  // triggering action (carrier-is-weapon, else the carrier's `system.container`
  // weapon). Constrains only the acting attacker; a spell/other-weapon hit won't
  // proc it. UNCHECKED (default) = live whenever the carrier/container is merely
  // EQUIPPED — accessory-like, so a weapon skill can still be equip-activated. Read
  // by reactionWeaponUsedSatisfied (skill-effects.js). Morrigan's "on hit with THIS
  // weapon, recover 10 MP" sets this.
  checkboxCol("reaction_requires_weapon_used", "Requires Weapon Used", { tooltip: "CHECK for an on-use weapon rider: the row fires only when the weapon backing this skill (its own type, or its container weapon) is the one actually used in the action — not on a spell or a different weapon, and only for the acting attacker. UNCHECK (default) = fires whenever the weapon/gear is merely equipped (accessory-like)." }),
];

// Map a table key → its required columns, for the boot sync to iterate.
export const REQUIRED_COLUMNS_BY_TABLE = {
  effect_table: EFFECT_TABLE_REQUIRED_COLUMNS,
  reaction_config_table: REACTION_CONFIG_REQUIRED_COLUMNS,
};

// ---------------------------------------------------------------------------
// Engine CONTRACT per effect kind — which row fields the handler refuses without.
// ---------------------------------------------------------------------------
// Harvested from skill-effects.js's own rejection guards ("missing X",
// "needs X or Y") and cross-checked against the dispatch map, so aliases that
// share a handler share the contract (remove_tagged_ae reads the same guard as
// remove_ae but is never named in its warn text).
//
// Regenerate with:  node tools/skill-primitives/bin/skill-primitives.js fields <kind>
//
// ⚠ This is a FLOOR, not the whole contract. Only warn-text guards are
// harvestable; handlers also reject via reason codes that name no field. An
// absent kind means nothing was FOUND, not that nothing is required.
//
// Used by CompactDynamicTable to keep a required-but-empty field VISIBLE when a
// row is collapsed — an unset requirement is the one blank worth showing, since
// it means the row silently does nothing. That is how the 9 `grant` rows with no
// `grant_resource` stayed invisible for so long.
//
//   all:              every field must be set
//   either:           at least one field from each group must be set
//   unlessTrue:       if any of these row fields is truthy the handler returns
//                     before the check, so nothing here is required. LOOSE —
//                     the string "true" counts, matching handlers that coerce.
//   unlessTrueStrict: same, but the handler tests `=== true`, so a stored
//                     string does NOT exempt the row.
//   unlessSet:        satisfied by any non-blank value
//
// The strict/loose split is not pedantry: summon coerces (skill-effects.js:8881
// accepts "true") while open_action_menu's free_mode is `=== true` (:8154).
// Using one rule for both would exempt a row the engine still rejects.
//
// The exemptions are not decoration. Without them the highlight cries wolf on
// rows that are correct — a cloning summon legitimately has no summon_actor —
// and a warning that is wrong half the time gets ignored the other half.
// ⚠ A requirement is only useful here if the field HAS A COLUMN on the kind in
// question — the highlight marks a rendered chip, so a field with no column
// produces no warning however right the entry is. Two known cases are left out
// for exactly that reason and are tracked as column work, not map work:
//   - add_target.target_ref — real guard (skill-effects.js:4713), but the live
//     target_ref column's gate excludes add_target, so the field cannot be set
//     from the sheet at all. Fix the COLUMN, then add the entry.
//   - summon.summon_actor / summon_clone_target — neither is a declared column.
export const REQUIRED_FIELDS_BY_KIND = {
  adjust_charges:   { all: ["charge_ae_name"],    either: [] },
  chain:            { all: ["chain_steps"],       either: [] },
  consume_charge:   { all: ["charge_key"],        either: [] },
  grant:            { all: ["grant_resource"],    either: [] },
  prompt_element:   { all: ["prompt_var"],        either: [] },
  prompt_number:    { all: ["prompt_var"],        either: [] },
  roll_dice:        { all: ["prompt_var"],        either: [] },
  trigger_status:   { all: ["status_name"],       either: [] },
  // if (!aeRef && !poolMode) → reject.  skill-effects.js:5802
  apply_ae:         { all: ["ae_template_ref"],   either: [], unlessSet: ["ae_pool_tag", "ae_name_pool"] },
  // free_mode returns before the option check (:8154, strict ===). An arcanum
  // dynamic source (:7273) and inline menu_options (:7361) also return early.
  open_action_menu: { all: ["menu_option_refs"],  either: [], unlessTrueStrict: ["free_mode"], unlessSet: ["menu_dynamic_source", "menu_options"] },
  // A blank resource here aborts the WHOLE chain, not just the row
  // (:5557 abort:true). Reads consume_resource ?? grant_resource (:5522).
  consume_resource: { all: [], either: [["consume_resource", "grant_resource"]] },
  // Reads grant_resource ?? set_resource (:4981), rejects on blank (:5001).
  set_resource:     { all: [], either: [["set_resource", "grant_resource"]] },
  remove_ae:        { all: [], either: [["ae_template_ref", "filter_tag"]] },
  remove_tagged_ae: { all: [], either: [["ae_template_ref", "filter_tag"]] },
  transfer_ae:      { all: [], either: [["ae_template_ref", "filter_tag"]] },
};
