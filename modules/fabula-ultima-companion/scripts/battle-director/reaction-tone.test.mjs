// ============================================================================
// Reaction tone: is a reaction helping or hindering the action it fires on?
//
//     node scripts/battle-director/reaction-tone.test.mjs
//
// Bare Node, no Foundry. Checks the rule on hand-written rows, then runs it over
// the world's export and holds the skills the user decided by name. Any export
// row a direct read gets wrong against the side rule is printed, so a new skill
// that breaks the pattern shows up here.
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chainProfile, reactionTone } from "./passive-card-ui/passive-card-classify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exportRoot = path.resolve(here, "../../../../worlds/fabula-ultima-2/_authored-export/actors");

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ok   ${name}`); };

const profileOf = (rows, ref = "start") => chainProfile({ table: Object.fromEntries(rows.map((r, i) => [String(i), r])), ref });
const row = (effect_label, effect_kind, extra = {}) => ({ effect_label, effect_kind, ...extra });
const tone = (rows, side) => reactionTone({ profile: profileOf(rows), ...side });
const ACTOR = { reactorIsActor: true, sameSide: true };
const FOE = { reactorIsActor: false, sameSide: false };

ok("more outgoing damage helps, whoever reacts", () => {
  const r = [row("start", "adjust_damage", { damage_operation: "add", damage_amount: "10", damage_stage: "outgoing" })];
  assert.equal(tone(r, ACTOR), "pos");
  assert.equal(tone(r, FOE), "pos");
});
ok("a formula added counts as more", () => {
  assert.equal(tone([row("start", "adjust_damage", { damage_operation: "add", damage_amount: "SL * 5" })], FOE), "pos");
});
ok("less damage taken hinders", () => {
  assert.equal(tone([row("start", "adjust_damage", { damage_operation: "subtract", damage_amount: "SL", damage_stage: "incoming" })], ACTOR), "neg");
});
ok("more defence hinders", () => {
  assert.equal(tone([row("start", "adjust_defense", { defense_operation: "add", defense_amount: "2" })], ACTOR), "neg");
});
ok("an extra target and a keyword help", () => {
  assert.equal(tone([row("start", "add_target")], FOE), "pos");
  assert.equal(tone([row("start", "apply_action_keyword", { action_keyword: "crush" })], FOE), "pos");
});
ok("own damage to 0 goes by side: your own trade helps, a foe's hinders", () => {
  for (const r of [
    [row("start", "adjust_damage", { damage_operation: "multiply", damage_amount: "0" })],
    [row("start", "adjust_damage", { damage_operation: "set", damage_amount: "0" })],
  ]) {
    assert.equal(tone(r, ACTOR), "pos");
    assert.equal(tone(r, FOE), "neg");
  }
});
ok("a moved target goes by side", () => {
  assert.equal(tone([row("start", "redirect_target")], FOE), "neg");
  assert.equal(tone([row("start", "redirect_target")], ACTOR), "pos");
});
ok("no row touching the action goes by side", () => {
  assert.equal(tone([row("start", "apply_ae", { ae_template_ref: "Poison" })], ACTOR), "pos");
  assert.equal(tone([row("start", "free_action")], FOE), "neg");
});
ok("rows pointing both ways go by side", () => {
  const r = [
    row("start", "chain", { chain_steps: "a,b" }),
    row("a", "adjust_damage", { damage_operation: "add", damage_amount: "10" }),
    row("b", "adjust_defense", { defense_amount: "2" }),
  ];
  assert.equal(tone(r, ACTOR), "pos");
  assert.equal(tone(r, FOE), "neg");
});
ok("a menu's options are read too", () => {
  const r = [
    row("start", "open_action_menu", { menu_option_refs: "boost" }),
    row("boost", "adjust_damage", { damage_operation: "add", damage_amount: "10" }),
  ];
  assert.equal(tone(r, FOE), "pos");
});
ok("no profile at all goes by side", () => {
  assert.equal(reactionTone({ profile: null, ...ACTOR }), "pos");
  assert.equal(reactionTone({ profile: null, ...FOE }), "neg");
});

// ── the real skills ─────────────────────────────────────────────────────────
if (fs.existsSync(exportRoot)) {
  const OWN = new Set(["creature_performs_action", "creature_will_deal_damage", "creature_deals_damage", "creature_completes_attack",
    "creature_completes_action", "creature_completes_skill", "creature_completes_spell", "creature_check_adjusted", "creature_guards"]);
  const HIT = new Set(["creature_targeted_by_action", "creature_hit_by_action", "creature_takes_damage", "creature_miss_action"]);
  // The reactor as the game would see it on the card, for each kind of row.
  const sideOf = (r) => {
    const src = String(r.reaction_source || "-");
    if (OWN.has(r.reaction_trigger)) return src === "enemy" ? FOE : src === "ally" ? { reactorIsActor: false, sameSide: true } : ACTOR;
    if (HIT.has(r.reaction_trigger)) return src === "enemy" ? ACTOR : FOE;
    return null;
  };
  const seen = new Map(), counts = { pos: 0, neg: 0 }, overrides = [];
  for (const f of fs.readdirSync(exportRoot)) {
    if (!f.endsWith(".json")) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(exportRoot, f), "utf8")); } catch { continue; }
    for (const it of d.items ?? []) {
      const p = it.system?.props;
      if (!p?.reaction_config_table || seen.has(it.name)) continue;
      for (const r of Object.values(p.reaction_config_table)) {
        if (!r || r.$deleted || !["ask", "on"].includes(r.reaction_passive_mode)) continue;
        const side = sideOf(r);
        if (!side) continue;
        const profile = chainProfile({ table: p.effect_table ?? {}, ref: r.reaction_effect_ref, item: it, trigger: r.reaction_trigger });
        const t = reactionTone({ profile, ...side }), bySide = side.reactorIsActor || side.sameSide ? "pos" : "neg";
        if (!seen.has(it.name)) { seen.set(it.name, t); counts[t]++; }
        if (t !== bySide) overrides.push(`${it.name} [${r.reaction_trigger}/${r.reaction_source || "-"}] reads ${t}, its side says ${bySide}`);
      }
    }
  }
  console.log(`\n  export: ${seen.size} reactions fire during an action: ${counts.pos} Positive, ${counts.neg} Negative`);
  if (overrides.length) console.log(`  rows override their side:\n    ${[...new Set(overrides)].join("\n    ")}`);
  const held = { "Bone Crusher": "pos", "Warning Shot": "pos", "Glowstick (Passive)": "pos", "Static Shot": "pos",
    Protect: "neg", "Prophetic Defender": "neg", Counterattack: "neg", "Verónica": "neg" };
  for (const [name, want] of Object.entries(held)) {
    ok(`${name} is ${want === "pos" ? "Positive" : "Negative"}`, () => assert.equal(seen.get(name), want, `${name}: ${seen.get(name)}`));
  }
} else {
  console.log("  (no world export here: the real skills were not checked)");
}

console.log(`\n${passed} passed`);
