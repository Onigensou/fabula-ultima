// ============================================================================
// Default action animations — rules harness.
//
//     node scripts/battle-director/action-anim-rules.test.mjs
//
// These are the choices the user approved on the mockup (2026-11-04). A wrong
// pick fails silently at the table — the wrong clip plays, a miss shows a hit,
// a poison flashes on a target the bite never touched — so each one is pinned.
// ============================================================================
import assert from "node:assert/strict";
import {
  MV_CLIPS, CATEGORY, FAMILY, ELEMENT, SFX, clipUrl, sfxUrl,
  normalizeCategory, normalizeElement, summarizeOutcome, pickAttack,
  composeBeats, resolveBeats, attackImpactAt, beatsImpactAt, TIMING,
} from "./action-anim-rules.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };
const rows = (...r) => Object.fromEntries(r.map((x, i) => [String(i), x]));
const tags = { Poison: "debuff", Burn: "debuff", Swift: "buff", "Power Up": "buff" };
const aeTagOf = (name) => tags[name] ?? null;

console.log("tables");
t("every clip a rule can pick exists in the clip table", () => {
  const picked = new Set();
  for (const f of Object.values(FAMILY)) for (const k of Object.values(f)) picked.add(k);
  for (const c of Object.values(CATEGORY)) { if (c.crit) picked.add(c.crit); if (c.physical) picked.add(c.physical); }
  for (const k of ["041_heal_one_1", "051_powerup_1", "054_powerdown_1"]) picked.add(k);
  for (const k of picked) assert.ok(MV_CLIPS[k], `missing clip ${k}`);
});
t("clip and sound URLs point at the Forge library", () => {
  assert.equal(clipUrl("006_slash_physical"), "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/006_slash_physical.webm");
  assert.match(sfxUrl("gun"), /GunshotA\.ogg$/);
  assert.equal(sfxUrl("nope"), null);
});
t("the gunshot stays quiet (user: 0.5 was too loud)", () => assert.ok(SFX.gun.vol <= 0.25));

console.log("normalizing");
t("blank or unknown weapon category is a plain hit (unarmed, NPC attack items)", () => {
  assert.equal(normalizeCategory(""), "Brawling");
  assert.equal(normalizeCategory(null), "Brawling");
  assert.equal(normalizeCategory("tentacle"), "Brawling");
});
t("category names match whatever their case", () => {
  assert.equal(normalizeCategory("sword"), "Sword");
  assert.equal(normalizeCategory("FIREARM"), "Firearm");
  assert.equal(normalizeCategory("Heavy"), "Heavy");
});
t("elements: FU names, common aliases, and anything else is Physical", () => {
  assert.equal(normalizeElement("Fire"), "Fire");
  assert.equal(normalizeElement("bolt"), "Bolt");
  assert.equal(normalizeElement("Lightning"), "Bolt");
  assert.equal(normalizeElement("wind"), "Air");
  assert.equal(normalizeElement(""), "Physical");
  assert.equal(normalizeElement("healing"), "Physical");
});
t("outcome: any crit wins, all-miss is a miss, unknown is a hit", () => {
  assert.equal(summarizeOutcome([{ hit: true }, { hit: true, crit: true }]), "crit");
  assert.equal(summarizeOutcome([{ hit: false }, { hit: false }]), "miss");
  assert.equal(summarizeOutcome([{ hit: false }, { hit: true }]), "hit");
  assert.equal(summarizeOutcome(null), "hit");
  assert.equal(summarizeOutcome([{ hit: false, pierceMiss: true }]), "hit");
});

console.log("attacks");
t("sword hit = physical slash, swing + slash sounds", () => {
  const p = pickAttack({ category: "Sword", element: "Physical" });
  assert.equal(p.clip, "006_slash_physical");
  assert.equal(p.motion, "melee");
  assert.deepEqual(p.sfx, { swing: "swing", hit: "slash", element: null, crit: null });
});
t("element swaps the clip suffix", () => {
  assert.equal(pickAttack({ category: "Sword", element: "Fire" }).clip, "008_slash_fire");
  assert.equal(pickAttack({ category: "Spear", element: "Ice" }).clip, "014_pierce_ice");
  assert.equal(pickAttack({ category: "Flail", element: "Bolt" }).clip, "020_claw_thunder");
  assert.equal(pickAttack({ category: "Sword", element: "Fire" }).sfx.element, "fire");
});
t("elements with no clip of their own tint the _effect clip", () => {
  const p = pickAttack({ category: "Sword", element: "Dark" });
  assert.equal(p.clip, "007_slash_effect");
  assert.deepEqual(p.tint, ELEMENT.Dark.tint);
});
t("arcane physical uses the magic sheen; firearm physical uses the gunshot", () => {
  assert.equal(pickAttack({ category: "Arcane", element: "Physical" }).clip, "002_hit_effect");
  assert.equal(pickAttack({ category: "Firearm", element: "Physical" }).clip, "111_shoot_normal");
  assert.equal(pickAttack({ category: "Firearm", element: "Fire" }).clip, "013_pierce_fire");
});
t("crit = the family's special clip, shaken, crit sound, a touch smaller, no tint", () => {
  const p = pickAttack({ category: "Sword", element: "Dark", outcome: "crit" });
  assert.equal(p.clip, "023_slash_special_1");
  assert.equal(p.tint, null);
  assert.equal(p.shake, true);
  assert.equal(p.sfx.crit, "crit");
  assert.equal(p.scale, 0.9);
  assert.equal(pickAttack({ category: "Bow", outcome: "crit" }).clip, "029_arrow_special");
});
t("miss = swing only: no clip, no hit sound", () => {
  const p = pickAttack({ category: "Spear", element: "Fire", outcome: "miss" });
  assert.equal(p.clip, null);
  assert.equal(p.sfx.hit, null);
  assert.equal(p.sfx.element, null);
  assert.equal(p.sfx.swing, "swing");
});
t("ranged weapons fire from where they stand", () => {
  assert.equal(pickAttack({ category: "Bow" }).motion, "arrow");
  assert.equal(pickAttack({ category: "Thrown" }).motion, "throw");
  assert.equal(pickAttack({ category: "Firearm" }).motion, "gun");
  assert.equal(pickAttack({ category: "Firearm" }).sfx.swing, "gun");
});
t("a weapon preset swaps the clip and keeps the motion; an unknown preset is ignored", () => {
  const p = pickAttack({ category: "Spear", element: "Dark", preset: "024_slash_special_2" });
  assert.equal(p.clip, "024_slash_special_2");
  assert.equal(p.motion, "melee");
  assert.equal(p.tint, null);
  assert.equal(p.source, "preset");
  assert.equal(pickAttack({ category: "Spear", preset: "999_nope" }).clip, "011_pierce_physical");
});
t("a preset does not resurrect a missed attack", () => {
  assert.equal(pickAttack({ category: "Sword", outcome: "miss", preset: "024_slash_special_2" }).clip, null);
});
t("unknown category and element fall back to a physical hit", () => {
  const p = pickAttack({ category: "Nope", element: "Nope" });
  assert.equal(p.clip, "001_hit_physical");
});

console.log("composer");
t("plain damage skill = one damage beat", () => {
  const c = composeBeats({ type_damage: "Fire" }, { intent: "harmful" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to, b.post]), [["damage", "target", false]]);
});
t("healing damage type = a heal beat on the target", () => {
  const c = composeBeats({ type_damage: "Healing" }, { intent: "aid" });
  assert.deepEqual(c.beats.map((b) => b.k), ["heal"]);
  assert.equal(c.hasDamage, false);
});
t("Venom Bite shape: damage, then a poison that needs the hit", () => {
  const c = composeBeats({ type_damage: "Poison",
    effect_table: rows({ effect_label: "vb_poison", effect_kind: "apply_ae", target_ref: "hit_action_targets", ae_template_ref: "Poison" }),
  }, { aeTagOf, intent: "harmful" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to, b.post, b.needsHit]), [["damage", "target", false, false], ["debuff", "target", true, true]]);
});
t("Life Drain shape: damage, then a self-heal that needs the hit", () => {
  const c = composeBeats({ type_damage: "Dark", action_keywords: "drain" }, { intent: "harmful" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to, b.needsHit]), [["damage", "target", false], ["heal", "self", true]]);
});
t("War Cry shape: a pre-damage self buff comes BEFORE the damage and does not need the hit", () => {
  const c = composeBeats({ type_damage: "Physical", on_activate_effect_ref: "wc",
    effect_table: rows({ effect_label: "wc", effect_kind: "apply_ae", target_ref: "self", ae_template_ref: "Power Up" }),
  }, { aeTagOf, intent: "harmful" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to, b.post, b.needsHit]), [["buff", "self", false, false], ["damage", "target", false, false]]);
});
t("Mending Hymn shape: heal then buff, nothing needs a hit (no damage)", () => {
  const c = composeBeats({ type_damage: "Healing", post_damage_effect_ref: "mh",
    effect_table: rows({ effect_label: "mh", effect_kind: "apply_ae", target_ref: "action_targets", ae_template_ref: "Swift" }),
  }, { aeTagOf, intent: "aid" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to, b.needsHit]), [["heal", "target", false], ["buff", "target", false]]);
});
t("chains are walked; an untagged AE on the target of a harmful skill reads as a debuff", () => {
  const c = composeBeats({ type_damage: "", on_activate_effect_ref: "go", skill_target: "One enemy",
    effect_table: rows(
      { effect_label: "go", effect_kind: "chain", chain_steps: "a, b" },
      { effect_label: "a", effect_kind: "apply_ae", target_ref: "action_targets", ae_template_ref: "Mystery" },
      { effect_label: "b", effect_kind: "grant", target_ref: "self", grant_resource: "mp", grant_amount: 5 },
    ) }, { aeTagOf, intent: "harmful" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to]), [["debuff", "target"], ["heal", "self"]]);
});
t("a menu stops the walk and is reported opaque", () => {
  const c = composeBeats({ on_activate_effect_ref: "m",
    effect_table: rows({ effect_label: "m", effect_kind: "open_action_menu", menu_option_refs: "x" },
      { effect_label: "x", effect_kind: "apply_ae", target_ref: "action_targets", ae_template_ref: "Swift" }) },
  { aeTagOf, intent: "aid" });
  assert.equal(c.opaque, true);
  // the menu's option is referenced, so it is not read as a free post effect;
  // nothing readable is left, so the aid intent gives one buff
  assert.deepEqual(c.beats.map((b) => b.k), ["buff"]);
});
t("rows with no visible meaning add nothing; then the intent decides", () => {
  const props = { effect_table: rows({ effect_label: "c", effect_kind: "consume_resource" }, { effect_label: "d", effect_kind: "adjust_damage" }) };
  assert.deepEqual(composeBeats(props, { intent: "harmful" }).beats.map((b) => b.k), ["debuff"]);
  assert.deepEqual(composeBeats(props, { intent: "aid" }).beats.map((b) => b.k), ["buff"]);
  assert.deepEqual(composeBeats(props, { intent: "neutral" }).beats, []);
});
t("cleanse reads as a buff, dispel as a debuff", () => {
  const c = composeBeats({ effect_table: rows({ effect_label: "c", effect_kind: "remove_tagged_ae", filter_tag: "debuff", target_ref: "action_targets" }) }, { intent: "aid" });
  assert.deepEqual(c.beats.map((b) => b.k), ["buff"]);
});
t("the same beat on the same recipient plays once; at most three beats", () => {
  const c = composeBeats({ type_damage: "Fire", effect_table: rows(
    { effect_label: "a", effect_kind: "apply_ae", target_ref: "hit_action_targets", ae_template_ref: "Burn" },
    { effect_label: "b", effect_kind: "apply_ae", target_ref: "hit_action_targets", ae_template_ref: "Poison" },
    { effect_label: "c", effect_kind: "grant", target_ref: "self", grant_resource: "hp", grant_amount: 10 },
    { effect_label: "d", effect_kind: "apply_ae", target_ref: "self", ae_template_ref: "Swift" },
  ) }, { aeTagOf, intent: "harmful" });
  assert.deepEqual(c.beats.map((b) => [b.k, b.to]), [["damage", "target"], ["debuff", "target"], ["heal", "self"]]);
});
t("deleted rows are ignored", () => {
  const c = composeBeats({ type_damage: "Fire", effect_table: rows({ $deleted: true, effect_label: "a", effect_kind: "apply_ae", ae_template_ref: "Burn" }) }, { aeTagOf, intent: "harmful" });
  assert.equal(c.beats.length, 1);
});

console.log("beats vs outcome");
const venom = composeBeats({ type_damage: "Poison", effect_table: rows({ effect_label: "p", effect_kind: "apply_ae", target_ref: "hit_action_targets", ae_template_ref: "Poison" }) }, { aeTagOf, intent: "harmful" }).beats;
t("hit: damage clip by element, then the debuff clip", () => {
  const r = resolveBeats(venom, { outcome: "hit", element: "Poison" });
  assert.deepEqual(r.map((b) => b.clip), ["002_hit_effect", "054_powerdown_1"]);
  assert.deepEqual(r[0].tint, ELEMENT.Poison.tint);
});
t("miss: the damage beat swings with no clip and the poison is dropped", () => {
  const r = resolveBeats(venom, { outcome: "miss", element: "Poison" });
  assert.deepEqual(r.map((b) => [b.k, b.clip]), [["damage", null]]);
});
t("crit: the special hit clip", () => {
  assert.equal(resolveBeats(venom, { outcome: "crit" })[0].clip, "021_hit_special_1");
});
t("a missed War Cry still shows its self buff (it came before the roll)", () => {
  const wc = composeBeats({ type_damage: "Physical", on_activate_effect_ref: "wc",
    effect_table: rows({ effect_label: "wc", effect_kind: "apply_ae", target_ref: "self", ae_template_ref: "Power Up" }) }, { aeTagOf, intent: "harmful" }).beats;
  assert.deepEqual(resolveBeats(wc, { outcome: "miss" }).map((b) => [b.k, b.clip]), [["buff", "051_powerup_1"], ["damage", null]]);
});
t("NPC attack items (attack-like) use the plain physical hit, not the magic sheen", () => {
  const dmg = [{ k: "damage", to: "target", post: false, needsHit: false }];
  assert.equal(resolveBeats(dmg, { element: "Physical", attackLike: true })[0].clip, "001_hit_physical");
  assert.equal(resolveBeats(dmg, { element: "Physical" })[0].clip, "002_hit_effect");
});

console.log("timing");
const T = TIMING;
t("melee damage lands on the clip's contact frame after the step", () => {
  assert.equal(attackImpactAt(pickAttack({ category: "Sword" })), T.stepMs + 40);
  assert.equal(attackImpactAt(pickAttack({ category: "Dagger" })), T.quickStepMs + 40);
  assert.equal(attackImpactAt(pickAttack({ category: "Spear" })), T.stepMs + 133);
});
t("ranged: ready, flight, then the contact frame", () => {
  assert.equal(attackImpactAt(pickAttack({ category: "Bow" })), T.readyMs + T.arrowMs + 133);
  assert.equal(attackImpactAt(pickAttack({ category: "Firearm" })), T.readyMs + T.gunLeadMs + 133);
});
t("a crit lands on the special clip's LAST contact frame", () => {
  assert.equal(attackImpactAt(pickAttack({ category: "Sword", outcome: "crit" })), T.stepMs + 1000);
});
t("a miss lands on the swing", () => {
  assert.equal(attackImpactAt(pickAttack({ category: "Sword", outcome: "miss" })), T.stepMs + 60);
});
t("Chain N: one beat per strike, damage on the last strike's contact", () => {
  assert.equal(attackImpactAt(pickAttack({ category: "Sword" }), { strikes: 3 }), T.stepMs + 2 * T.chainBeatMs + 40);
});
t("composer: damage first lands right after the slide + glow", () => {
  const r = resolveBeats(venom, { element: "Poison" });
  assert.equal(beatsImpactAt(r), T.slideMs + T.castMs + 67);
});
t("composer: a pre-damage buff pushes the damage back by its beat", () => {
  const wc = composeBeats({ type_damage: "Physical", on_activate_effect_ref: "wc",
    effect_table: rows({ effect_label: "wc", effect_kind: "apply_ae", target_ref: "self", ae_template_ref: "Power Up" }) }, { aeTagOf, intent: "harmful" }).beats;
  const r = resolveBeats(wc, {});
  assert.equal(beatsImpactAt(r), T.slideMs + T.castMs + (333 + T.beatGapMs) + 67);
});

console.log(`\n${n} passed`);
