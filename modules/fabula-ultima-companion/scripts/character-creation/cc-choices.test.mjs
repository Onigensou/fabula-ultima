/**
 * Per-level choices in Character Creation (Bane Oils: "each time you take this
 * Skill, choose a creature Species").
 *
 * Creation has no actor yet, so a pick lives on the draft row that bought the
 * level. That makes the rules fall out of the existing ones: removing a level
 * gives its pick back (last in, first out, like a Facet), dropping the class
 * gives them all back, and finalize replays them through spendPoint.
 *
 * Run: node cc-choices.test.mjs
 */
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game = {
  actors: [], items: [], folders: [], users: [], user: { id: "u1", name: "Oni", isGM: true },
  settings: { get: () => "" }, socket: { emit() {}, on() {} }, data: {}, world: { id: "w" },
};
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };

// The class copy of Bane Oils: one disabled effect per species, as in the world.
const SPECIES = ["Beast", "Construct", "Demon", "Elemental", "Humanoid", "Monster", "Plant", "Undead"];
const baneClassCopy = {
  name: "Bane Oils",
  system: { props: { level: 1 } },
  effects: [
    ...SPECIES.map((s, i) => ({ _id: `e${i}`, name: `Bane Oils: ${s}`, img: `${s}.png`, disabled: true })),
    { _id: "x1", name: "Bane Oils (Beast)", img: "", disabled: false },   // an oil template, not a choice
  ],
};
globalThis.fromUuidSync = (u) => (u === "Item.bane" ? baneClassCopy : null);

const C = await import("./cc-step-classes.js");
const S = await import("./cc-class-state.js");
const { choiceViewOf } = await import("../levelup-system/levelup-choices.js");
const { LevelUpApp } = await import("../levelup-system/levelup-app.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

const slayer = { key: "slayer", name: "Slayer", img: "", benefit: "ip", facets: [], skills: [] };
const bane = { uuid: "Item.bane", key: "baneoils", name: "Bane Oils", img: "", maxLevel: 5, facetGrant: 0 };
const gk = { uuid: "Item.gk", key: "giantkiller", name: "Giant Killer", img: "", maxLevel: 1, facetGrant: 0 };
const draft = () => ({ classes: [] });

// ── the draft row carries the pick ───────────────────────────────────────────
{
  const d = draft();
  C.applySpend(d, slayer, bane, { choiceKeys: ["beast"], choiceLabels: ["Beast"] });
  C.applySpend(d, slayer, gk);
  C.applySpend(d, slayer, bane, { choiceKeys: ["monster"], choiceLabels: ["Monster"] });
  eq("rows keep their own picks", d.classes.map((r) => r.choiceKeys), [["beast"], [], ["monster"]]);
  eq("labels ride along", d.classes.map((r) => r.choiceLabels), [["Beast"], [], ["Monster"]]);
  eq("draftChoiceKeys gathers a skill's picks", S.draftChoiceKeys(d, "Item.bane"), ["beast", "monster"]);
  eq("other skills hold none", S.draftChoiceKeys(d, "Item.gk"), []);

  C.removeLast(d, "Item.bane");
  eq("removing a level gives its pick back (last in, first out)", S.draftChoiceKeys(d, "Item.bane"), ["beast"]);
  C.dropClass(d, "slayer");
  eq("dropping the class gives every pick back", S.draftChoiceKeys(d, "Item.bane"), []);
}

// ── the view the window reads, built from the class copy + the draft ────────
{
  const v = choiceViewOf(baneClassCopy, 2, ["beast", "monster"]);
  eq("held comes from the draft, not the (all-disabled) class copy",
    v.options.filter((o) => o.held).map((o) => o.label), ["Beast", "Monster"]);
  eq("8 species offered, the oil templates are not", v.options.length, 8);
  eq("nothing owed at SL 2 with 2 picks", v.owed, 0);
  eq("one owed at SL 2 with 1 pick", choiceViewOf(baneClassCopy, 2, ["beast"]).owed, 1);
  eq("without an override the item's own state counts", choiceViewOf(baneClassCopy, 1).held, 0);
}

// ── the window's own picker, as creation drives it ───────────────────────────
const stateWith = (level, heldKeys) => ({
  ok: true, actor: { name: "New", img: "" }, level: 5, classLevelTotal: level,
  points: { stored: 5, expected: 5, drift: false },
  gate: { open: true, where: "creation", reason: "" },
  nuts: { count: 0, name: "Forget me Nut", img: "" },
  rules: { maxClassLevel: 10, maxCharLevel: 50, maxUnmastered: 3 },
  unmastered: 1,
  heroic: { slots: 0, used: 0, available: [], picked: [], open: 0 },
  classes: [{
    key: "slayer", id: "s", name: "Slayer", img: "", folder: "", benefit: "ip", free: {},
    flavor: "", lore: "", also: "", mechanic: "", level, mastered: false, taken: level > 0,
    skills: [{ ...bane, type: "", cost: "", description: "", level, atMax: false,
      choice: choiceViewOf(baneClassCopy, level, heldKeys) }],
    facets: [],
  }],
});
const mkView = (s) => {
  const a = Object.create(LevelUpApp);
  Object.assign(a, {
    _creation: true, _pending: [], _selected: "slayer", _tab: "skill", _resetMode: false,
    _detailMode: false, _root: null, _details: new Map(), _pinned: null, _facet: null,
    _updateCursor: () => {}, _benefitChoice: new Map(), _stateSource: () => s,
    render() {},
  });
  return a;
};
{
  const v = mkView(stateWith(0, []));
  eq("a first take opens the picker", v._openChoicePicker("spend", "slayer", "Item.bane"), true);
  eq("…asking for one species", v._facet.need, 1);
  eq("…from all 8", v._facet.pool.length, 8);
  eq("…in choice mode", v._facet.mode, "choice");
}
{
  const v = mkView(stateWith(1, ["beast"]));
  v._openChoicePicker("spend", "slayer", "Item.bane");
  eq("the second level offers the 7 not yet chosen", v._facet.pool.map((o) => o.uuid).includes("beast"), false);
  eq("…still one to pick", v._facet.need, 1);
}
{
  const v = mkView({ ...stateWith(0, []), classes: [{ ...stateWith(0, []).classes[0],
    skills: [{ ...gk, type: "", cost: "", description: "", level: 0, atMax: false, choice: null }] }] });
  eq("a skill with no per-level choice opens nothing", v._openChoicePicker("spend", "slayer", "Item.gk"), false);
}
{
  const v = mkView(stateWith(0, []));
  eq("creation never shows the catch-up button",
    v._choiceOwedBtn({ ...bane, level: 2, choice: choiceViewOf(baneClassCopy, 2, []) }), "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
