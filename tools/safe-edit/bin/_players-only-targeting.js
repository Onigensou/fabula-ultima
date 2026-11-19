#!/usr/bin/env node
"use strict";
// ============================================================================
// Moves that never target a summon or a guest, + Bandit Roo automation.
//
//   node bin/_players-only-targeting.js           # dry run
//   node bin/_players-only-targeting.js --apply   # GAME MUST BE CLOSED
//
// Code side: skill-formulas IS_SUMMON / IS_GUEST. Data side, here:
//
//   Kurona       Infectious Bite        target_eligibility = PLAYERS_ONLY
//   Roo          Chef's Knife (Active)  target_eligibility = PLAYERS_ONLY
//                Approach               ap_victim target_filter = PLAYERS_ONLY and
//                                       exclude_defeated; if the Marked victim is
//                                       gone (a KO strips Marked) the walk restarts
//                                       on a new victim (it used to re-Mark the KO'd
//                                       body and keep walking toward it).
//   Bandit Roo   Approach               6-step clock, +1 at the start of every
//                                       enemy turn (was a manual "ask" passive)
//                Robbed Blind           at 6: rob the victim's IP (lethal if it
//                                       had none — the old custom_logic did that),
//                                       then run from the battle. PLAYERS_ONLY.
//                Chef's Knife           new Attack skill from the weapon's numbers
//                                       (the AI never swings a weapon item); its
//                                       crit text automated (crit → 0 HP, not vs
//                                       Champions). The loot weapon is untouched.
//                Curse                  applies Cursed on hit (had no effect row)
//                AI table               Robbed Blind > Chef's Knife / Curse
//
// Idempotent: every write is a whole replacement of the fields it owns.
// ============================================================================

const { makeSkill, run } = require("./_fafnir-util");
const { getByKey } = require("../lib/db");

const NS = "fabula-ultima-companion";
const PLAYERS_ONLY = "IS_SUMMON == 0 && IS_GUEST == 0";

const KURONA = "vmYeN1WWIF5TSjjF";
const ROO = "VwClo606KbQSK6aQ";
const BROO = "kIvWhnszRhsHafWu";
const ID = {
  ROO_KNIFE: "IqytDxaB5BGEtSZZ", ROO_APPROACH: "5nRPZWogdOXD6n2I",
  BR_APPROACH: "0GYDuppAXdGwMER0", BR_ROBBED: "98LqIWG0eOWKhqot", BR_KNIFE: "hwHRNHyRzP29kT3u", BR_CURSE: "GHxHlexPrFSyWG72",
  // new documents
  BR_KNIFE_A: "BrooKnifeAttack1",
  BR_KNIFE_P: "BrooKnifePassiv1",   // retired sandbox-only id, deleted if present
  AE_BR_APPROACH: "BrooApproachClk1",
  AE_BR_LOOT: "BrooLootTaken001",
  AE_BR_SPENT: "BrooOppSpent0001",
};
const ik = (a, i) => `!actors.items!${a}.${i}`;
const aek = (a, i, ae) => `!actors.items.effects!${a}.${i}.${ae}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

const put = (label, kind, extra) => ({ $deleted: false, effect_kind: kind, effect_label: label, ...extra });
const chain = (label, steps) => put(label, "chain", { chain_steps: steps.join(", ") });
const removeAe = (label, name, target = "self") => put(label, "remove_ae", { ae_template_ref: name, target_ref: target, include_persistent: "true", count: "all" });
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const react = (trigger, ref, extra = {}) => ({ $deleted: false, reaction_trigger: trigger, reaction_source: "self", reaction_isPassive: true,
  reaction_passive_mode: "force", reaction_effect_ref: ref, ...extra });
const pat = (name, condition, string, priority, extra = {}) => ({ $deleted: false, action_pattern_name: name, action_pattern_condition: condition,
  action_pattern_string: string, action_pattern_value_1: "0", action_pattern_value_2: "100", action_pattern_priority: String(priority),
  action_pattern_target_focus: "auto", action_pattern_cooldown: "0", action_pattern_hp_reserve: "0", action_pattern_hp_ceiling: "0", ...extra });

function rowsOf(item, k) { return Object.values(item.system.props[k] ?? {}).filter((r) => r && !r.$deleted && !r.deleted); }
function byLabel(item, label) {
  const t = item.system.props.effect_table ?? {};
  const key = Object.keys(t).find((k) => t[k]?.effect_label === label);
  if (!key) throw new Error(`${item.name}: effect row "${label}" not found`);
  return t[key];
}
function aeFrom(src, owner, item, id, name, flags) {
  const d = clone(src);
  d._id = id; d.name = name; d.origin = `Actor.${owner}.Item.${item}`;
  if (d._stats) { d._stats.createdTime = null; d._stats.modifiedTime = null; d._stats.duplicateSource = null; }
  d.flags = { ...(d.flags ?? {}), [NS]: { ...(d.flags?.[NS] ?? {}), ...flags } };
  return d;
}

run(async ({ changes, deletes }) => {
  const need = async (key) => { const d = await getByKey("actors", key); if (!d) throw new Error(`missing ${key}`); return d; };

  // ── Kurona ────────────────────────────────────────────────────────────────
  const kurona = await need(`!actors!${KURONA}`);
  let bite = null;
  for (const iid of kurona.items) { const it = await getByKey("actors", ik(KURONA, iid)); if (it?.name === "Infectious Bite") { bite = it; break; } }
  if (!bite) throw new Error("Kurona: Infectious Bite not found");
  bite.system.props.target_eligibility = PLAYERS_ONLY;
  changes.push([ik(KURONA, bite._id), bite, "Kurona / Infectious Bite: never targets a summon or guest"]);

  // ── Roo ───────────────────────────────────────────────────────────────────
  const rooKnife = await need(ik(ROO, ID.ROO_KNIFE));
  if (rooKnife.system.props.skill_type !== "Active") throw new Error("Roo knife id is not the Active");
  rooKnife.system.props.target_eligibility = PLAYERS_ONLY;
  changes.push([ik(ROO, ID.ROO_KNIFE), rooKnife, "Roo / Chef's Knife: never targets a summon or guest"]);

  // A KO strips Marked, so "the victim went down" shows up at the Roo's next turn
  // start as "walking, but no LIVING creature is Marked" (a KO by an HP edit
  // leaves Marked on the body, so the check is COMBAT_LIVING_...). Three
  // mutually exclusive turn_start rows:
  //   fresh / mid-walk with a victim  → ap_step
  //   two steps in, victim still here → ap_arrive
  //   walking, victim gone            → ap_restart (clear stale marks, new victim,
  //                                     walk from step 1)
  // Before this the Roo re-Marked the KO'd body (ap_victim had no exclude_defeated)
  // and walked on toward it.
  const rooAp = await need(ik(ROO, ID.ROO_APPROACH));
  const victim = byLabel(rooAp, "ap_victim");
  victim.target_filter = PLAYERS_ONLY;
  victim.exclude_defeated = true;
  byLabel(rooAp, "ap_mark").condition_formula = "COMBAT_LIVING_MAX_AE_CHARGES_MARKED == 0";
  {
    const P = rooAp.system.props;
    const keepFx = rowsOf(rooAp, "effect_table").filter((r) => !/^ap_(reset|restart|unmark|unstep|unreach|stale)$/.test(r.effect_label));
    P.effect_table = table([...keepFx,
      chain("ap_restart", ["ap_unstep", "ap_unreach", "ap_unmark", "ap_mark", "ap_tick", "ap_slide"]),
      removeAe("ap_unstep", "Approach"),
      removeAe("ap_unreach", "In Melee Range"),
      put("ap_stale", "targeting", { candidate_source: "combat", category: "enemy", mode: "all", exclude_self: true,
        target_filter: "AE_CHARGES_MARKED > 0", allow_empty: true }),
      removeAe("ap_unmark", "Marked", "ap_stale"),
    ]);
    const COND = {
      ap_step: "AE_CHARGES_APPROACH < 2 && (AE_CHARGES_APPROACH == 0 || COMBAT_LIVING_MAX_AE_CHARGES_MARKED > 0)",
      ap_arrive: "AE_CHARGES_APPROACH >= 2 && COMBAT_LIVING_MAX_AE_CHARGES_MARKED > 0",
    };
    const keepRx = rowsOf(rooAp, "reaction_config_table").filter((r) => !["ap_reset", "ap_restart"].includes(r.reaction_effect_ref));
    for (const r of keepRx) if (COND[r.reaction_effect_ref]) r.condition_formula = COND[r.reaction_effect_ref];
    if (keepRx.filter((r) => COND[r.reaction_effect_ref]).length !== 2) throw new Error("Roo Approach: step/arrive rows not found");
    P.reaction_config_table = table([...keepRx,
      react("turn_start", "ap_restart", { condition_formula: "AE_CHARGES_APPROACH > 0 && COMBAT_LIVING_MAX_AE_CHARGES_MARKED == 0" }),
    ]);
  }
  changes.push([ik(ROO, ID.ROO_APPROACH), rooAp, "Roo / Approach: victim never a summon/guest or defeated; victim gone → restart the walk"]);

  // ── Bandit Roo ────────────────────────────────────────────────────────────
  const broo = await need(`!actors!${BROO}`);
  const rooApAe = await need(aek(ROO, ID.ROO_APPROACH, rooAp.effects[0] ?? ""));      // donor: Roo's "Approach" counter
  const rooKnifeAe = await need(aek(ROO, ID.ROO_KNIFE, rooKnife.effects[0] ?? ""));   // donor: "Knife Drawn" marker
  if (rooApAe.name !== "Approach" || rooKnifeAe.name !== "Knife Drawn") throw new Error("donor AE order changed");

  // Approach — a 6-section clock, one section at the start of every enemy turn.
  const brAp = await need(ik(BROO, ID.BR_APPROACH));
  {
    const P = brAp.system.props;
    P.skill_target = "-";
    P.isReaction = true;
    P.reaction_config_table = table([
      react("turn_start", "ap_tick", { reaction_source: "enemy", condition_formula: "AE_CHARGES_APPROACH < 6" }),
    ]);
    P.effect_table = table([
      put("ap_tick", "apply_ae", { ae_template_ref: "Approach", target_ref: "self", ae_duplicate_mode: "add_charges", ae_initial_charges: "1" }),
    ]);
    brAp.effects = [ID.AE_BR_APPROACH];
    changes.push([aek(BROO, ID.BR_APPROACH, ID.AE_BR_APPROACH),
      aeFrom(rooApAe, BROO, ID.BR_APPROACH, ID.AE_BR_APPROACH, "Approach", { charges: 0, chargesMax: 6 }), "NEW AE — Approach (6-section counter)"]);
  }
  changes.push([ik(BROO, ID.BR_APPROACH), brAp, "Bandit Roo / Approach: automated 6-step clock"]);

  // Robbed Blind — lethal if the victim has no IP left, otherwise takes it all; then runs.
  const brRob = await need(ik(BROO, ID.BR_ROBBED));
  {
    const P = brRob.system.props;
    P.skill_target = "One Enemy";
    P.target_eligibility = PLAYERS_ONLY;
    P.isReaction = true;
    P.custom_logic_action = "";        // the BD never ran these; the rows below are the same rules
    P.custom_logic_resolution = "";
    P.on_activate_effect_ref = "rb_rob";
    P.effect_table = table([
      chain("rb_rob", ["rb_hit", "rb_take", "rb_mark"]),
      put("rb_hit", "deal_damage", { damage_amount: "9999 * (CUR_IP == 0)" /* deal_damage binds the VICTIM as actor */, damage_element: "dark", damage_cause: "damage", target_ref: "action_targets" }),
      put("rb_take", "consume_resource", { consume_resource: "ip", consume_amount: "TARGET_CURRENT_IP", on_empty: "drain", target_ref: "action_targets" }),
      put("rb_mark", "apply_ae", { ae_template_ref: "Loot Taken", target_ref: "self", ae_duplicate_mode: "replace" }),
      chain("rb_leave", ["rb_escaped", "rb_run"]),
      put("rb_escaped", "set_battle_outcome", { condition_formula: "ALLY_COUNT == 0", outcome_value: "escaped" }),
      put("rb_run", "leave_combat", { target_ref: "self", leave_exit: "run" }),
    ]);
    P.reaction_config_table = table([
      react("turn_end", "rb_leave", { condition_formula: "AE_COUNT_LOOT_TAKEN > 0" }),
    ]);
    brRob.effects = [ID.AE_BR_LOOT];
    changes.push([aek(BROO, ID.BR_ROBBED, ID.AE_BR_LOOT),
      aeFrom(rooKnifeAe, BROO, ID.BR_ROBBED, ID.AE_BR_LOOT, "Loot Taken", { charges: 1 }), "NEW AE — Loot Taken (runs at turn end)"]);
  }
  changes.push([ik(BROO, ID.BR_ROBBED), brRob, "Bandit Roo / Robbed Blind: automated, never a summon/guest"]);

  // Chef's Knife — the NPC autopilot attacks with Attack-type skills, never with a
  // weapon item, so the knife becomes Bandit Roo's basic attack (Roo's own setup:
  // a loot weapon + an action of the same name; the matcher picks the action).
  // Numbers are the weapon's: DEX + DEX, HR + 7 Dark, melee. Its crit rule rides
  // on the attack as a reaction (Kurona's Infectious Bite pattern).
  const brKnife = await need(ik(BROO, ID.BR_KNIFE));
  const donorBite = bite;                                  // Kurona's Attack-type bite
  const knifeDesc = brKnife.system.props.description ?? "";
  const brKnifeA = makeSkill(donorBite, BROO, ID.BR_KNIFE_A, "Chef's Knife", brKnife.img, {
    skill_type: "Attack", action_command: "attack", action_intent: "harmful", skill_target: "One Creature",
    skill_range: "Melee", cost: "-", isCheck: true, isReaction: true, isOffensiveSpell: false,
    rolled_atr1: "DEX", rolled_atr2: "DEX", check_bonus: "0", damage_bonus: "7", type_damage: "Dark",
    defense_target_type: "def", target_eligibility: "", description: knifeDesc, skill_description: knifeDesc,
  });
  brKnifeA.system.props.reaction_config_table = table([
    react("creature_deals_damage", "ck_execute", { reaction_source_skill: "Chef's Knife",
      condition_formula: "ATTACK_IS_CRIT == 1 && DAMAGE_IS_HP == 1 && TARGET_IS_CHAMPION == 0 && TARGET_CURRENT_HP > 0" }),
  ]);
  // The text: "you may SPEND your opportunity to reduce the target to 0 HP" — so
  // the execute also spends it. A hidden Sonic Blow-style marker
  // (deny_own_crit_opportunity, gone at Bandit Roo's turn end) is live when
  // RESOLVE stamps the crit, so no second Opportunity wheel opens.
  brKnifeA.system.props.effect_table = table([
    chain("ck_execute", ["ck_kill", "ck_spent"]),
    put("ck_kill", "consume_resource", { consume_resource: "hp", consume_amount: "TARGET_CURRENT_HP", on_empty: "drain", consume_can_defeat: true, target_ref: "trigger_subject" }),
    put("ck_spent", "apply_ae", { ae_template_ref: "Opportunity Spent", target_ref: "self", ae_duplicate_mode: "replace" }),
  ]);
  const sonic = await getByKey("items", "!items.effects!f3QKcoZ4HwrR607a.R6nXJ0cWiEaXA3RX");
  if (!sonic || !JSON.stringify(sonic.changes ?? []).includes("deny_own_crit_opportunity")) throw new Error("Sonic Blow marker donor changed");
  const spent = aeFrom(sonic, BROO, ID.BR_KNIFE_A, ID.AE_BR_SPENT, "Opportunity Spent", { hidden: true, lifetimeMode: "target_turn_end" });
  spent.description = "<p>Chef's Knife already spent this critical success.</p>";
  delete spent.flags["custom-system-builder"];
  brKnifeA.effects = [ID.AE_BR_SPENT];
  changes.push([aek(BROO, ID.BR_KNIFE_A, ID.AE_BR_SPENT), spent, "NEW AE — Opportunity Spent (hidden, no second Opportunity)"]);
  changes.push([ik(BROO, ID.BR_KNIFE_A), brKnifeA, "NEW Chef's Knife (Attack): weapon numbers; crit → 0 HP, not vs Champions"]);
  // An earlier cut of this script made a separate passive; drop it if present.
  deletes.push([ik(BROO, ID.BR_KNIFE_P), "Chef's Knife (Passive) from an earlier sandbox cut (no-op on a world that never had it)"]);

  // Curse — the AE was on the item but nothing applied it.
  const brCurse = await need(ik(BROO, ID.BR_CURSE));
  brCurse.system.props.on_activate_effect_ref = "cu_curse";
  brCurse.system.props.effect_table = table([
    put("cu_curse", "apply_ae", { ae_template_ref: "Cursed", target_ref: "hit_action_targets", ae_duplicate_mode: "replace" }),
  ]);
  changes.push([ik(BROO, ID.BR_CURSE), brCurse, "Bandit Roo / Curse: applies Cursed on hit"]);

  // Actor: new item listed, AI table.
  broo.items = broo.items.filter((i) => i !== ID.BR_KNIFE_P);
  if (!broo.items.includes(ID.BR_KNIFE_A)) broo.items.push(ID.BR_KNIFE_A);
  broo.system.props.action_pattern_table = table([
    pat("Robbed Blind", "effect_stacks", "Approach", 9, { action_pattern_value_1: "6", action_pattern_value_2: "0" }),
    pat("Chef's Knife", "always", "", 5),
    pat("Curse", "always", "", 5),
  ]);
  changes.push([`!actors!${BROO}`, broo, "Bandit Roo: AI table (Robbed Blind at 6 Approach, else Chef's Knife / Curse) + passive listed"]);
}, "players-only targeting + Bandit Roo automation");
