// ⭐️ Fafnir (P1uCkpNnxLRBNqZr) — two-phase enemy AI + Cruel Ultimatum fix.
// 2026-09-20. Run _fafnir-ai-aes.js FIRST (it creates the Storm Gathering AE).
// Run from tools/safe-edit; --apply to write.
//
// Design: docs/fafnir-boss-design.md. Five changes, all data:
//
//  1. action_pattern_table — Fafnir had NONE, so enemy-autopilot returned null
//     and the GM hand-drove all FOUR of her turns every round.
//  2. Storm Gathering passive — the phase latch (two reaction rows, MP
//     thresholds with hysteresis).
//  3. summon_max on Summon Elemental Drake — no re-summon while the adds live.
//  4. Cruel Ultimatum — one 6 Zero Power debit on both branches (the double
//     charge on option A is gone) and both branches ignore absorption.
//  5. The stale CSB dropdown options on her sheet body, which do not yet list
//     `self_has_status` — without them a sheet re-stamp would silently reset the
//     phase rows to the fallback (the Dryad regression).
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const FAF = "P1uCkpNnxLRBNqZr";
const TEMPLATE = "yegF6R8aaymhrvCg";          // _Fabula NPC template v.2 (current options)
const ITEMS = {
  BREATH:   "5G44tRpOf2mzBFW3",
  REND:     "FE8qB6pC9i7CWqSg",
  CONDEMN:  "XohaJJnUhPSYLzFG",
  TORMENT:  "D9P5IDOhxfrIfHvH",
  BRAND:    "eLMFbgeZkVWUbE0i",
  DOMINATE: "mYlHtbtd808Wrze0",
  CALM:     "5BLT8rXoDwUHz000",
  SUMMON:   "C286kW050ikBQ85g",
  ULTIMATUM:"mZnxgj2JnNYO2Hat",
  SUFFER:   "ejrKWNUQJPXB6cS6",              // donor for the new passive
};
const SG = "StormGatherPsv01";                // new Storm Gathering passive item
const ICON_PASSIVE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Epic%207/show%20-%202025-07-20T213946.309.png";

const ak = (id) => "!actors.items!" + FAF + "." + id;
const at = (path, obj) => path.split(".").reduce((a, k) => a && a[k], obj);

// One pattern row. Priorities carry the whole design, so they are stated once
// here and explained in the table below.
function row(name, condition, v1, v2, priority, cooldown, string) {
  return {
    $deleted: false,
    action_pattern_name: name,
    action_pattern_condition: condition,
    action_pattern_value_1: v1 == null ? "" : String(v1),
    action_pattern_value_2: v2 == null ? "" : String(v2),
    action_pattern_string: string ?? "",
    action_pattern_priority: String(priority),
    action_pattern_weight: "",
    action_pattern_cooldown: String(cooldown),
    action_pattern_target_focus: "auto",
    action_pattern_focus_status: "",
    action_pattern_hp_reserve: "0",
    action_pattern_hp_ceiling: "0",
  };
}

run(async ({ changes }) => {
  const actor = await getByKey("actors", "!actors!" + FAF);
  if (!actor) throw new Error("missing Fafnir");
  const tpl = await getByKey("actors", "!actors!" + TEMPLATE);
  if (!tpl) throw new Error("missing NPC template");

  // ── 1. The action pattern table ────────────────────────────────────────
  //
  // prio  row                        why this number
  //  20   Cruel Ultimatum            exclusive — at 6 ZP it fires, full stop.
  //  10   Summon Elemental Drake     RECOVERY only. 10/9 sit >=3 above the
  //   9   Storm Calm                 fillers, so while Storm Gathering is up the
  //                                  window is 8-10 and nothing else is reachable.
  //   7   Ruinous Breath             rounds 1,3,5 (A+B*X = 1+2X), cooldown 1 so
  //                                  it can never fire twice in one round. The
  //                                  cooldown only BITES because the fillers at 5
  //                                  are within 2 priority and stay live — alone
  //                                  in its window the all-blocked fallback would
  //                                  un-block it every round (the Kirin trap).
  //   5   the five fillers           one shared window, weight 1 each.
  const table = {};
  const rows = [
    row("Zero Power: Cruel Ultimatum", "zero_power", 100, 100, 20, 0),
    row("Summon Elemental Drake", "self_has_status", null, null, 10, 4, "Storm Gathering"),
    row("Storm Calm", "self_has_status", null, null, 9, 0, "Storm Gathering"),
    row("Ruinous Breath", "round", 1, 2, 7, 1),
    row("Condemn", "always", null, null, 5, 0),
    row("Rend", "always", null, null, 5, 0),
    row("Torment", "always", null, null, 5, 3),
    row("Searing Brand", "always", null, null, 5, 2),
    row("Draconic Domination", "always", null, null, 5, 2),
  ];
  rows.forEach((r, i) => { table[String(i)] = r; });
  actor.system.props.action_pattern_table = table;

  // ── 5. Refresh the two stale pattern-row dropdowns from the live template ──
  // Her stamped body predates self_has_status / activation / the focus modes.
  // Copied surgically rather than via reloadTemplate(), which PRUNES props.
  const OPT_PATHS = [
    "body.contents.0.contents.1.contents.5.contents.0.contents.0.rowLayout.1",
    "body.contents.0.contents.1.contents.5.contents.0.contents.0.rowLayout.6",
  ];
  let optNote = [];
  for (const p of OPT_PATHS) {
    const mine = at(p, actor.system);
    const theirs = at(p, tpl.system);
    if (!mine || !theirs) throw new Error("option path missing: " + p);
    if (mine.key !== theirs.key) throw new Error("option path key mismatch at " + p + ": " + mine.key + " vs " + theirs.key);
    const before = (Array.isArray(mine.options) ? mine.options : Object.values(mine.options ?? {})).length;
    mine.options = JSON.parse(JSON.stringify(theirs.options));
    const after = (Array.isArray(mine.options) ? mine.options : Object.values(mine.options)).length;
    optNote.push(mine.key + " " + before + "->" + after);
  }

  // ── 2. Storm Gathering — the phase latch ───────────────────────────────
  // Two reaction rows on ONE passive, both force-mode, both on her own
  // resource ledger. Hysteresis is the point: she ENTERS below 100 MP (she can
  // no longer pay for Ruinous Breath) and LEAVES at 300 (three casts banked).
  // A single threshold would flicker — every Storm Calm would push her straight
  // back over it, which is exactly what the pattern-sim showed when the rows
  // were gated on an `mp` band instead of on a state.
  const suffer = await getByKey("actors", ak(ITEMS.SUFFER));
  if (!suffer) throw new Error("missing Zero Trigger: Suffering donor");
  const passive = JSON.parse(JSON.stringify(suffer));
  passive._id = SG;
  passive.name = "Storm Gathering";
  passive.img = ICON_PASSIVE;
  passive.effects = [];
  passive.folder = null;
  passive.ownership = { default: 0 };
  if (passive._stats) { passive._stats.createdTime = null; passive._stats.modifiedTime = null; passive._stats.duplicateSource = null; }
  Object.assign(passive.system.props, {
    name: "Storm Gathering",
    img: ICON_PASSIVE,
    id: "${item.id}",
    uuid: "Actor." + FAF + ".Item." + SG,
    skill_type: "Passive",
    class: "NPC",
    cost: "-",
    skill_target: "Self",
    duration: "-",
    isReaction: true,
    description: "When her magic runs dry, Fafnir breaks off and gathers the storm — "
      + "summoning her drakes and recovering her power until it is hers again.",
    on_activate_effect_ref: "",
    reaction_config_table: {
      0: {
        reaction_trigger: "creature_lose_resource",
        reaction_source: "self",
        reaction_resource_filter: "mp",
        reaction_passive_mode: "force",
        condition_formula: "CUR_MP < 100",
        reaction_effect_ref: "sg_enter",
        reaction_cause_filter: "",
        reaction_status_filter: "",
        reaction_action_kind: "",
        reaction_source_skill: "",
        reaction_responder: "",
        requires_skill: "",
      },
      1: {
        reaction_trigger: "creature_gain_resource",
        reaction_source: "self",
        reaction_resource_filter: "mp",
        reaction_passive_mode: "force",
        condition_formula: "CUR_MP >= 300",
        reaction_effect_ref: "sg_exit",
        reaction_cause_filter: "",
        reaction_status_filter: "",
        reaction_action_kind: "",
        reaction_source_skill: "",
        reaction_responder: "",
        requires_skill: "",
      },
    },
    effect_table: {
      0: {
        effect_label: "sg_enter",
        effect_kind: "apply_ae",
        ae_template_ref: "Storm Gathering",
        target_ref: "self",
        ae_duplicate_mode: "skip",
        consume_self: false,
      },
      1: {
        effect_label: "sg_exit",
        effect_kind: "remove_ae",
        ae_template_ref: "Storm Gathering",
        target_ref: "self",
        // REQUIRED: the marker is lifetimeMode persistent_counter, and
        // selectAEsOnActor skips those unless a row opts in.
        include_persistent: true,
        consume_self: false,
      },
    },
  });
  changes.push([ak(SG), passive, "NEW passive — Storm Gathering (phase latch: enter <100 MP, leave >=300 MP)"]);

  // ── 3. Summon Elemental Drake — cap the adds ───────────────────────────
  // summon_max counts the caster's own live summons of this kind and refuses
  // past the cap, so she cannot stack a second pair while the first is alive.
  // 2 = one Flame + one Lightning.
  const summon = await getByKey("actors", ak(ITEMS.SUMMON));
  if (!summon) throw new Error("missing Summon Elemental Drake");
  const st = summon.system.props.effect_table;
  const srow = Object.values(st).find((r) => r && r.effect_kind === "summon");
  if (!srow) throw new Error("no summon row on Summon Elemental Drake");
  srow.summon_max = "2";
  changes.push([ak(ITEMS.SUMMON), summon, "summon_max 2 — no re-summon while the drakes live"]);

  // ── 4. Cruel Ultimatum ─────────────────────────────────────────────────
  // ⚠ CORRECTED 2026-09-20 after `runReactionLint` flagged COST_DOUBLE_CHARGE.
  //
  // The original read of this skill was wrong in both halves, and it is worth
  // recording why so the mistake is not repeated:
  //   * "option B costs nothing" — FALSE. `system.props.cost = "6 Zero Power"`
  //     is the LEGACY cost path: the action-card pipeline parses it and debits
  //     at CONFIRM, before the menu branches. B was always charged.
  //   * "option B's target list never resolves" — FALSE. `target_ref` does NOT
  //     require the row to be chained: resolveTargetRef -> findTargetingRow
  //     looks a `targeting` row up by its effect_label anywhere in effect_table.
  //
  // The ACTUAL bug was the opposite: option A carried its own consume_resource
  // row ON TOP of the cost field, so picking A debited 12 Zero Power, not 6.
  // The first version of this script "fixed" it by hoisting that row into the
  // main chain — which spread the double-charge to BOTH branches.
  //
  // Correct shape per skill-authoring-canon.md branch 1 ("Cost rule — one
  // source of truth, never two"): keep the LEGACY path. `cost` stays, there is
  // NO consume_resource row anywhere reachable from on_activate_effect_ref, and
  // both branches are charged exactly 6 once, at CONFIRM.
  //
  // Both damage rows carry `ignore_absorption`: the clamp collapses RS/IM/AB to
  // NE (VU untouched, shields untouched), so a Zero Power can no longer be
  // shrugged off by an absorbing target. That was the hole — option A aimed at
  // the party's fire-absorber was literally 0 damage.
  //
  // The table is REPLACED outright, not merged: `run` puts whole documents, so
  // no stale row or stale intra-row key survives.
  const ult = await getByKey("actors", ak(ITEMS.ULTIMATUM));
  if (!ult) throw new Error("missing Zero Power: Cruel Ultimatum");
  ult.system.props.effect_table = {
    0: { effect_label: "cu_choice", effect_kind: "open_action_menu", menu_responder: "enemy",
         menu_title: "Cruel Ultimatum", menu_subtitle: "The enemy chooses their fate",
         menu_option_refs: "cu_optA,cu_optB", consume_self: false },
    1: { effect_label: "cu_optA", effect_kind: "chain", chain_steps: "cu_pick_one,cu_300",
         menu_label: "One of us takes 300 Fire (we choose who)", consume_self: false },
    2: { effect_label: "cu_pick_one", effect_kind: "targeting", menu_responder: "enemy",
         candidate_source: "combat", category: "enemy", mode: "exact", count: "1", consume_self: false },
    3: { effect_label: "cu_300", effect_kind: "deal_damage", damage_element: "fire", damage_amount: "300",
         target_ref: "cu_pick_one", damage_cause: "damage", damage_keywords: "ignore_absorption", consume_self: false },
    4: { effect_label: "cu_optB", effect_kind: "chain", chain_steps: "cu_all,cu_120",
         menu_label: "All of us take 120 Bolt", consume_self: false },
    5: { effect_label: "cu_all", effect_kind: "targeting", candidate_source: "combat", category: "enemy",
         mode: "all", consume_self: false },
    6: { effect_label: "cu_120", effect_kind: "deal_damage", damage_element: "bolt", damage_amount: "120",
         target_ref: "cu_all", damage_cause: "damage", damage_keywords: "ignore_absorption", consume_self: false },
  };
  ult.system.props.on_activate_effect_ref = "cu_choice";
  ult.system.props.description = "Offer the enemy a vile edict. The enemy chooses: one target enemy takes "
    + "300 Fire damage (their choice who), or all enemies take 120 Bolt damage. "
    + "This damage ignores immunities and absorption.";
  changes.push([ak(ITEMS.ULTIMATUM), ult, "single 6 ZP debit via the legacy cost field (no consume_resource row); ignore_absorption on both damage rows"]);

  // ── the actor doc itself, last (items list + passive list + pattern table) ──
  if (!actor.items.includes(SG)) actor.items = [...actor.items, SG];
  actor.system.props.skill_passive_list = {
    ...actor.system.props.skill_passive_list,
    [SG]: {
      name: "Storm Gathering",
      id: "${item.id}",
      uuid: "Actor." + FAF + ".Item." + SG,
      passive_description: passive.system.props.description,
    },
  };
  changes.push(["!actors!" + FAF, actor,
    "action_pattern_table " + rows.length + " rows; dropdowns " + optNote.join(", ") + "; +Storm Gathering passive"]);
}, "fafnir two-phase AI + Cruel Ultimatum fix", "actors");
