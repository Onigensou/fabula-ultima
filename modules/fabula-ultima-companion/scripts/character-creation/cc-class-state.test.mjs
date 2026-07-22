/**
 * The seam between Character Creation and the level-up window.
 *
 * The whole design of step 3 rests on one claim: `draftState(draft)` returns
 * the same shape `getState(actorUuid)` does, so LevelUpApp's own renderers can
 * draw a character who does not exist yet. These assertions hold that claim up.
 *
 * Two halves:
 *   1. the shape and arithmetic of draftState against a stubbed class registry
 *   2. actually running LevelUpApp._rail / _main / _project over it, which is
 *      the only way to find out that the renderers accept it
 */

// ── a world with two real-shaped class actors ──────────────────────────────
const folder = (id, name, parent = null) => ({ id, _id: id, name, type: "Actor", folder: parent });
const classesRoot = folder("f-root", "Classes");
const classic = folder("f-classic", "Classic Classes", classesRoot);

// A facet grant is not a field — the registry reads it out of the authored
// prose, which must say "see Facet" and name a count. Writing the fixture the
// way the world actually writes it is the point; a made-up shape would test
// nothing.
const GRANT_TEXT = {
  1: "You learn one Elementalist spell of your choice (see Facet).",
  2: "You learn two Elementalist spells of your choice (see Facet).",
};

const skillItem = (name, { maxLevel = 5, facetGrant = 0, isFacet = false } = {}) => ({
  id: `i-${name}`, uuid: `Item.${name}`, name, img: `icons/${name}.webp`,
  system: { props: {
    skill_type: isFacet ? "Facet" : "Skill",
    max_level: String(maxLevel),
    cost: "",
    description: facetGrant ? GRANT_TEXT[facetGrant] : "<p>Does a thing.</p>",
    isFacet, isHeroic: false,
  } },
});

const classActor = (id, name, props, items) => ({
  id, _id: id, uuid: `Actor.${id}`, name, img: `icons/${id}.webp`,
  folder: classic,
  system: { props },
  items: { contents: items },
});

const guardian = classActor("a-guardian", "Guardian", {
  benefit_dropdown: "hp_benefit", flavor_text: "A wall between harm and the world.",
  martialArmor_equippable: true, martialShield_equippable: true,
}, [
  skillItem("Bodyguard"), skillItem("Fortress", { maxLevel: 10 }),
  skillItem("Dual Shieldbearer", { maxLevel: 1 }),
]);

const elementalist = classActor("a-elementalist", "Elementalist", {
  benefit_dropdown: "choice_benefit", flavor_text: "Calls on the raw stuff of the world.",
  ritual_performable: true,
}, [
  skillItem("Elemental Magic", { maxLevel: 10, facetGrant: 2 }),
  skillItem("Spellblade"),
  skillItem("Flare", { isFacet: true }), skillItem("Aura", { isFacet: true }),
  skillItem("Glacial Breath", { isFacet: true }),
]);

const allFolders = [classesRoot, classic];
allFolders.get = (id) => allFolders.find((f) => f.id === id) ?? null;

globalThis.game = {
  user: { id: "u1", name: "Oni", isGM: false },
  users: [], items: [], scenes: {},
  folders: allFolders,
  actors: Object.assign([guardian, elementalist], { contents: [guardian, elementalist] }),
  settings: { get: () => "" },
  socket: { emit() {}, on() {} },
  data: {}, world: { id: "w" },
};
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.CONFIG = { sounds: {} };

const { draftState, takenClasses } = await import("./cc-class-state.js");
const D = await import("./cc-draft.js");
const C = await import("./cc-step-classes.js");
const { LevelUpApp } = await import("../levelup-system/levelup-app.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split("\n")[0]}`); }
};

const mk = (level = 5) => { const d = D.createDraft(); d.attributes.level = level; return d; };
const clsOf = (s, key) => s.classes.find((c) => c.key === key);
const sklOf = (s, key, name) => clsOf(s, key).skills.find((x) => x.name === name);
const spend = (d, s, key, name, opts) => C.applySpend(d, clsOf(s, key), sklOf(s, key, name), opts);

// ── the registry stub is producing real classes ────────────────────────────
{
  const s = draftState(mk());
  eq("both classes are visible", s.classes.map((c) => c.name), ["Elementalist", "Guardian"]);
  eq("a fixed benefit is read from the class", clsOf(s, "guardian").benefit, "hp");
  eq("a chooser reports no benefit yet", clsOf(s, "elementalist").benefit, null);
  eq("free martial rights survive",
    [clsOf(s, "guardian").free.martialArmor, clsOf(s, "guardian").free.martialShield], [true, true]);
  eq("skills are separated from facets",
    clsOf(s, "elementalist").skills.map((x) => x.name), ["Elemental Magic", "Spellblade"]);
  eq("facets land in their own list",
    clsOf(s, "elementalist").facets.map((x) => x.name).sort(), ["Aura", "Flare", "Glacial Breath"]);
  eq("a facet grant is parsed from the description",
    sklOf(s, "elementalist", "Elemental Magic").facetGrant, 2);
}

// ── the shape getState promises ────────────────────────────────────────────
{
  const s = draftState(mk(20));
  eq("reports ok", s.ok, true);
  eq("every key the renderers read is present",
    ["ok", "actor", "level", "points", "gate", "nuts", "rules", "unmastered", "classes"]
      .filter((k) => !(k in s)), []);
  eq("actor stands in for the unmade character", s.actor.name, "New character");
  eq("the actor has no uuid, because there is no actor", s.actor.uuid, null);
  eq("rules come from the level-up system",
    [s.rules.maxClassLevel, s.rules.maxUnmastered], [10, 3]);
  eq("the gate reads open — finalize is what actually checks it", s.gate.open, true);
  eq("giving a level back is free before anything is written", s.nuts.count, Infinity);
}

// ── levels are counted out of the draft ────────────────────────────────────
{
  const d = mk(20);
  let s = draftState(d);
  eq("nothing taken yet", [clsOf(s, "guardian").level, clsOf(s, "guardian").taken], [0, false]);
  eq("the full pool is unspent", s.points.stored, 20);

  spend(d, s, "guardian", "Bodyguard");
  spend(d, s, "guardian", "Bodyguard");
  spend(d, s, "guardian", "Fortress");
  s = draftState(d);
  eq("class level is the count of picks", clsOf(s, "guardian").level, 3);
  eq("skill level is the count for that skill", sklOf(s, "guardian", "Bodyguard").level, 2);
  eq("a sibling skill counts separately", sklOf(s, "guardian", "Fortress").level, 1);
  eq("an untouched skill is zero", sklOf(s, "guardian", "Dual Shieldbearer").level, 0);
  eq("points are drawn down", s.points.stored, 17);
  eq("the class is now taken", clsOf(s, "guardian").taken, true);
  eq("but not mastered", clsOf(s, "guardian").mastered, false);
  eq("one unmastered class", s.unmastered, 1);
  eq("no drift — the draft is its own ledger", s.points.drift, false);
}

// ── mastery and the maxLevel cap ───────────────────────────────────────────
{
  const d = mk(20);
  const s0 = draftState(d);
  for (let i = 0; i < 10; i++) spend(d, s0, "guardian", "Fortress");
  const s = draftState(d);
  eq("ten picks is mastery", clsOf(s, "guardian").mastered, true);
  eq("a mastered class stops counting as unmastered", s.unmastered, 0);
  eq("the skill reports its own ceiling", sklOf(s, "guardian", "Fortress").atMax, true);
  eq("a one-level skill reports atMax at one",
    (() => { const dd = mk(20); const ss = draftState(dd);
             spend(dd, ss, "guardian", "Dual Shieldbearer");
             return sklOf(draftState(dd), "guardian", "Dual Shieldbearer").atMax; })(), true);
}

// ── the chosen benefit sticks to the class ─────────────────────────────────
{
  const d = mk(10);
  const s0 = draftState(d);
  spend(d, s0, "elementalist", "Spellblade", { benefit: "mp" });
  eq("the class now reports the chosen benefit", clsOf(draftState(d), "elementalist").benefit, "mp");
  eq("a fixed-benefit class is unaffected", clsOf(draftState(d), "guardian").benefit, "hp");
}

// ── facets are held once claimed ───────────────────────────────────────────
{
  const d = mk(10);
  const s0 = draftState(d);
  eq("nothing held to begin with", clsOf(s0, "elementalist").facets.every((f) => !f.held), true);
  spend(d, s0, "elementalist", "Elemental Magic",
    { benefit: "mp", facetUuids: ["Item.Flare", "Item.Aura"] });
  const s = draftState(d);
  eq("claimed facets read as held",
    s.classes.find((c) => c.key === "elementalist").facets
      .filter((f) => f.held).map((f) => f.name).sort(), ["Aura", "Flare"]);
  eq("unclaimed ones do not",
    s.classes.find((c) => c.key === "elementalist").facets
      .find((f) => f.name === "Glacial Breath").held, false);
}

// ── takenClasses keeps first-picked order ──────────────────────────────────
{
  const d = mk(20);
  const s0 = draftState(d);
  spend(d, s0, "elementalist", "Spellblade", { benefit: "hp" });
  spend(d, s0, "guardian", "Bodyguard");
  spend(d, s0, "elementalist", "Spellblade");
  const s = draftState(d);
  eq("order is when each class was opened",
    takenClasses(s, d).map((c) => c.name), ["Elementalist", "Guardian"]);
  eq("untaken classes are excluded", takenClasses(s, d).length, 2);
}

// ── THE POINT: LevelUpApp's own renderers accept this state ────────────────
{
  const d = mk(20);
  const s0 = draftState(d);
  spend(d, s0, "guardian", "Bodyguard");
  spend(d, s0, "guardian", "Fortress");
  const s = draftState(d);

  // The same derived object the step builds.
  const v = Object.create(LevelUpApp);
  Object.assign(v, {
    _creation: true, _stateSource: () => s, _pending: [],
    _selected: "guardian", _tab: "skill", _resetMode: false,
    _actorUuid: null, _root: null, _updateCursor: () => {},
  });
  Object.defineProperty(v, "isOpen", { get: () => true, configurable: true });

  let proj = null;
  ok("_project runs over draft state", () => { proj = v._project(s); });
  eq("an empty pending queue means no deltas",
    [proj.classDelta.size, proj.skillDelta.size], [0, 0]);
  eq("...so projected points equal stored points", proj.points, s.points.stored);
  eq("_classLevel reads straight through", v._classLevel(s, clsOf(s, "guardian"), proj), 2);
  eq("_skillLevel reads straight through",
    v._skillLevel(sklOf(s, "guardian", "Bodyguard"), proj), 1);
  eq("_projectedUnmastered counts the draft", v._projectedUnmastered(s, proj), 1);

  let rail = "", main = "";
  ok("_rail renders", () => { rail = v._rail(s, takenClasses(s, d), proj); });
  ok("_main renders", () => { main = v._main(s, proj); });

  eq("the rail names the taken class", rail.includes("Guardian"), true);
  eq("the rail shows its level out of ten", rail.includes("2/10"), true);
  eq("the rail offers a new class", rail.includes("New Class"), true);

  eq("the main pane lists the class skills", main.includes("Bodyguard") && main.includes("Fortress"), true);
  eq("skill levels are shown", main.includes("1 / 5"), true);
  eq("creation mode shows the buy button", main.includes(`data-act="spend"`), true);
  // Both controls at once is the creation-only change to _main.
  eq("creation mode also shows refund, without Reset mode",
    main.includes(`data-act="refund"`), true);
  eq("...and does not price it in Forget me Nuts", main.includes("Forget me Nut"), false);
  eq("no placeholder leaked into the markup",
    /undefined|\[object Object\]|NaN/.test(rail + main), false);

  // The facet grid is the other borrowed renderer.
  let grid = "";
  ok("_facetGrid renders", () => { grid = v._facetGrid(s, clsOf(s, "elementalist")); });
  eq("it lists the class facets", grid.includes("Flare") && grid.includes("Aura"), true);
  eq("no placeholder leaked there either",
    /undefined|\[object Object\]|NaN/.test(grid), false);
}

// ── the normal path is untouched ───────────────────────────────────────────
{
  // Without _stateSource, _readState must still go to the live API. There is no
  // API registered in this stub, so it returns undefined rather than throwing —
  // what matters is that it does not reach for the creation source.
  const plain = Object.create(LevelUpApp);
  Object.assign(plain, { _actorUuid: "Actor.nope" });
  ok("_readState falls through to getState when no source is set", () => {
    const r = plain._readState();
    if (r !== undefined && r !== null && r.gate?.where === "creation") {
      throw new Error("the live path picked up creation state");
    }
  });
  eq("a plain app is not in creation mode", plain._creation, undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
