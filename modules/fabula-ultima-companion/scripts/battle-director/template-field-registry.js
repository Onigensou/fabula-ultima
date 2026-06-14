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

const OAM_VIS = `equalText(sameRow("effect_kind",''), "open_action_menu")`;
// Damage-effect visibility gates.
const DEAL_VIS = `equalText(sameRow("effect_kind",''), "deal_damage")`;
const ADJUST_VIS = `equalText(sameRow("effect_kind",''), "adjust_damage")`;
const DEAL_OR_ADJUST_VIS = `or(equalText(sameRow("effect_kind",''), "deal_damage"), equalText(sameRow("effect_kind",''), "adjust_damage"))`;
const TGT_VIS = `equalText(sameRow("effect_kind",''), "targeting")`;
const APPLY_AE_VIS = `equalText(sameRow("effect_kind",''), "apply_ae")`;
const KEYWORD_VIS = `equalText(sameRow("effect_kind",''), "apply_action_keyword")`;
// adjust_charges — charge arithmetic on a target's named charge-AE.
const ADJUST_CHARGES_VIS = `equalText(sameRow("effect_kind",''), "adjust_charges")`;
// free_action — perform ONE free turn-action (skill name / "self" / type).
const FREE_ACTION_VIS = `equalText(sameRow("effect_kind",''), "free_action")`;
// prompt_number — interactive amount picker (Blazing Tether's Burn-stack move).
const PROMPT_NUMBER_VIS = `equalText(sameRow("effect_kind",''), "prompt_number")`;
// prompt_element — interactive damage-type picker (Meteor Shower). Stores the
// chosen element string under prompt_var, read later as VAR_<NAME>.
const PROMPT_ELEMENT_VIS = `equalText(sameRow("effect_kind",''), "prompt_element")`;
// prompt_var is shared by prompt_number (amount) and prompt_element (element).
const PROMPT_VAR_VIS = `or(equalText(sameRow("effect_kind",''), "prompt_number"), equalText(sameRow("effect_kind",''), "prompt_element"))`;
// confirm — N-button decision dialog (gate or branch).
const CONFIRM_VIS = `equalText(sameRow("effect_kind",''), "confirm")`;
// Shared free-action GRANT fields (bonuses / cost) — used by BOTH the legacy
// open_action_menu free_mode grant AND the new free_action kind.
const FREE_GRANT_VIS = `or(equalText(sameRow("effect_kind",''), "open_action_menu"), equalText(sameRow("effect_kind",''), "free_action"))`;

function textCol(key, colName, { tooltip = "", vis = "" } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: vis,
    type: "textField", size: "full-size", label: "", defaultValue: "", autocomplete: "", align: "left",
    colName, readonlyPredefined: false,
  };
}
function checkboxCol(key, colName, { tooltip = "", vis = "", defaultChecked = false } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: vis,
    type: "checkbox", size: "full-size", label: "", defaultChecked, align: "left",
    colName, readonlyPredefined: false,
  };
}
function selectCol(key, colName, options, { tooltip = "", vis = "", defaultValue = "" } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: vis,
    type: "select", size: "full-size", label: "", defaultValue, selectedOptionType: "custom",
    options: options.map((o) => ({ ...o })), align: "left",
    colName, readonlyPredefined: false,
  };
}

// ── effect_table declarative fields ──────────────────────────────────────────
// (Only fields prone to being added/forgotten are listed; the ensure-pass is a
// no-op for columns that already exist, so listing a stable field is harmless.)
export const EFFECT_TABLE_REQUIRED_COLUMNS = [
  // open_action_menu config
  textCol("menu_title", "Menu Title", { tooltip: "Prompt title above the option list (open_action_menu / prompt_element).", vis: `or(${OAM_VIS}, ${PROMPT_ELEMENT_VIS})` }),
  textCol("menu_subtitle", "Menu Subtitle", { tooltip: "Prompt subtitle / instruction line.", vis: OAM_VIS }),
  textCol("menu_pick_count", "Pick Count", { tooltip: "How many options to choose (number or formula, default 1).", vis: OAM_VIS }),
  textCol("menu_option_refs", "Option Refs", { tooltip: "Comma-separated effect_label refs offered by this menu, in order.", vis: OAM_VIS }),
  textCol("menu_option_labels", "Option Labels", { tooltip: "Pipe (|)-separated display labels, paired with Option Refs.", vis: OAM_VIS }),
  textCol("menu_option_descriptions", "Option Descriptions", { tooltip: "Pipe (|)-separated descriptions, paired with Option Refs.", vis: OAM_VIS }),
  textCol("menu_option_icons", "Option Icons", { tooltip: "Optional pipe (|)-separated icon image paths, paired with Option Refs. Blank = no icon (plain row).", vis: OAM_VIS }),
  textCol("menu_option_colors", "Option Colors", { tooltip: "Optional pipe (|)-separated accent colors (CSS), paired with Option Refs. Blank = no accent.", vis: OAM_VIS }),
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
  selectCol("damage_cause", "Damage Cause", [
    { key: "hazard", value: "Hazard (Burn/Poison/environment — not an attack)" },
    { key: "damage", value: "Damage (creature-inflicted — counts as an attack)" },
  ], { tooltip: "Resource-ledger cause for this deal_damage. hazard (default) won't trip 'player-inflicted damage' reactions; damage = creature-inflicted. Reactions filter via reaction_cause_filter.", vis: DEAL_VIS, defaultValue: "hazard" }),
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
  // apply_action_keyword config — which keyword to tag the in-flight hit with.
  // Extensible: each new keyword = one option here + one branch in
  // recomputePerTargetDamages. Author via a creature_will_deal_damage reaction
  // (e.g. Chomp: TRIGGER_IS_SELF == 1 && RAW_DAMAGE >= 100 → apply_action_keyword pierce).
  selectCol("action_keyword", "Action Keyword", [
    { key: "pierce", value: "Pierce (ignore Resistance)" },
  ], { tooltip: "apply_action_keyword: the keyword applied to this hit. Pierce = the target's Resistance (RS) is treated as neutral for this hit (VU/IM/AB unchanged).", vis: KEYWORD_VIS, defaultValue: "pierce" }),
  // Optional gate for the keyword, evaluated AFTER pre-resolve bonuses (so it can
  // reference FINAL_DAMAGE — the post-bonus, pre-affinity hit). Blank = always.
  // e.g. Chomp pierce: "FINAL_DAMAGE >= 100".
  textCol("condition_formula", "Keyword Condition", { tooltip: "apply_action_keyword gate (blank = always). Evaluated after pre-resolve bonuses; can use FINAL_DAMAGE (post-bonus, pre-affinity hit). e.g. FINAL_DAMAGE >= 100.", vis: KEYWORD_VIS }),
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
  selectCol("auto_target", "Auto-target", [
    { key: "auto",    value: "Auto — GM skips, player confirms (default)" },
    { key: "skip",    value: "Always skip (no prompt)" },
    { key: "confirm", value: "Always confirm (locked prompt)" },
  ], { tooltip: "Assured targets (self/all/single): Auto = GM silent for pace + player gets a locked Confirm; Skip = never prompt; Confirm = always lock-prompt.", vis: TGT_VIS, defaultValue: "auto" }),
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
  textCol("check_bonus_formula", "Free: Check Bonus", { tooltip: "Free action grant: bonus added to the granted action's Check (formula). e.g. Blazing Sweep repeat: -(AE_CHARGES_BLAZING_SWEEP_LOCK).", vis: FREE_GRANT_VIS }),
  textCol("damage_bonus_formula", "Free: Damage Bonus", { tooltip: "Free action grant: bonus added to the granted action's damage (formula, may be negative). e.g. Blazing Sweep repeat: floor(38 * pow(0.5, AE_CHARGES_BLAZING_SWEEP_LOCK)) - 38.", vis: FREE_GRANT_VIS }),
  textCol("max_mp_cost", "Free: Max MP Cost", { tooltip: "Free action grant: cap on the granted action's MP cost (blank = the action's own cost applies).", vis: FREE_GRANT_VIS }),
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
  // prompt_number config — interactive amount picker. Stores the entered value as
  // a chain variable read later via the VAR_<NAME> formula identifier (Blazing
  // Tether's move = prompt_number then two adjust_charges using VAR_MOVE_AMOUNT).
  textCol("prompt_var", "Prompt Var", { tooltip: "prompt_number / prompt_element: variable name to store the chosen value under. Read later as VAR_<NAME> (e.g. prompt_var \"move_amount\" → VAR_MOVE_AMOUNT; \"element\" → VAR_ELEMENT).", vis: PROMPT_VAR_VIS }),
  // prompt_element config — interactive damage-type picker. Stores the chosen
  // element string under prompt_var; a later deal_damage reads damage_element
  // "VAR_<NAME>". Blank Element Options → the 9 FU damage types.
  textCol("element_options", "Element Options", { tooltip: "prompt_element: optional |/comma-separated element id list (e.g. \"fire|ice|bolt\"). Blank = all 9 FU types (physical, air, bolt, dark, earth, fire, ice, light, poison).", vis: PROMPT_ELEMENT_VIS }),
  textCol("prompt_label", "Prompt Label", { tooltip: "prompt_number: the dialog prompt text (e.g. \"Burn stacks to move?\").", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_min", "Prompt Min", { tooltip: "prompt_number: minimum (number or formula). Default 0.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_max", "Prompt Max", { tooltip: "prompt_number: maximum (number or formula, evaluated against Prompt Max Ref's actor). e.g. \"AE_CHARGES_BURN\". Blank = unbounded.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_max_ref", "Prompt Max Ref", { tooltip: "prompt_number: target ref whose actor the min/max/default formulas read (e.g. \"tether_giver\" so max = the giver's Burn). Blank = the caster.", vis: PROMPT_NUMBER_VIS }),
  textCol("prompt_default", "Prompt Default", { tooltip: "prompt_number: the input's starting value (number or formula). Blank = max.", vis: PROMPT_NUMBER_VIS }),

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
];

// ── reaction_config_table declarative fields ─────────────────────────────────
export const REACTION_CONFIG_REQUIRED_COLUMNS = [
  selectCol("reaction_passive_mode", "Firing Mode", [
    { key: "ask",   value: "Ask — player decides (clickable pill)" },
    { key: "on",    value: "On — auto-fires, visible" },
    { key: "off",   value: "Off — disabled" },
    { key: "force", value: "Force — auto-fires, UI-invisible (engine-mandatory)" },
  ], { tooltip: "ask = clickable pill · on = auto-fire visible · off = disabled · force = auto-fire, engine-only.", defaultValue: "ask" }),
  // Resource-ledger trigger filters (creature_lose_resource / creature_gain_resource).
  // Blank = any. resource matches the changed resource; cause matches why.
  textCol("reaction_resource_filter", "Resource Filter", { tooltip: "For creature_lose_resource / creature_gain_resource: fire only when this resource changed — hp/mp/ip/fp/zero_power/shield/zenit/enmity. Blank = any." }),
  textCol("reaction_cause_filter", "Cause Filter", { tooltip: "For creature_lose_resource / creature_gain_resource: fire only for this cause — damage/hazard/cost/drain/grant/heal. Blank = any. (damage = inflicted attack; hazard = Burn/Poison/environment.)" }),
  // Status-ledger filter (creature_status_applied / creature_loses_status).
  textCol("reaction_status_filter", "Status Filter", { tooltip: "For creature_status_applied / creature_loses_status: fire only when this status (AE) changed — e.g. Crisis. Blank = any." }),
  // Action-kind filter (creature_performs_action). Comma-list of action TYPES the
  // reaction accepts (Attack/Skill/Spell/Item/Guard/…), matched vs payload.actionKind.
  textCol("reaction_action_kind", "Action Kind Filter", { tooltip: "For creature_performs_action: fire only for these action TYPES — comma-list (e.g. \"Attack,Skill,Spell\"). Matched against the performed action's kind. Blank = any kind." }),
  // Source-skill name filter (creature_completes_skill). The NAME of the skill
  // whose completion fired the trigger — for "after you use <Skill>" follow-ups.
  textCol("reaction_source_skill", "Source Skill Filter", { tooltip: "For creature_completes_skill: fire only when the completing skill has this NAME (e.g. \"Crossfire\"). Matched against the completing skill's name. Blank = any skill." }),
];

// Map a table key → its required columns, for the boot sync to iterate.
export const REQUIRED_COLUMNS_BY_TABLE = {
  effect_table: EFFECT_TABLE_REQUIRED_COLUMNS,
  reaction_config_table: REACTION_CONFIG_REQUIRED_COLUMNS,
};
