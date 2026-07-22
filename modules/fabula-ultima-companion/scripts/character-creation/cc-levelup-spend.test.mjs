/**
 * Staging in the live level-up window: allocate freely, confirm once.
 *
 * This exists because of a report that spending one point locked the rest —
 * "I have 2 Skill Points, spent 1, and now every + is dead". The staging model
 * is fine; what was missing was any way to find out WHY a + had gone dead, and
 * the one notice that would have explained it hid itself the moment anything
 * was staged.
 *
 * Both halves are pinned here: a healthy actor must be able to spend its whole
 * pool one click at a time, and a drifted one must say plainly that it cannot.
 */

globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game = {
  actors: [], items: [], folders: [], users: [], user: { id: "u1", isGM: true },
  settings: { get: () => "" }, socket: { emit() {}, on() {} }, data: {}, world: { id: "w" },
};
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };

const { LevelUpApp } = await import("../levelup-system/levelup-app.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

const skill = (name, lvl, maxLevel = 5) => ({
  uuid: `Item.${name}`, key: name, name, img: "", type: "", cost: "", description: "",
  maxLevel, level: lvl, atMax: lvl >= maxLevel, facetGrant: 0,
});

/** A getState-shaped world with one taken class and two skills. */
const state = (stored, expected = stored, gate = { open: true, where: "camp", reason: "" }) => ({
  ok: true, actor: { name: "X", img: "" }, level: 10, classLevelTotal: 3,
  points: { stored, expected, drift: stored !== expected },
  gate,
  nuts: { count: 3, name: "Forget me Nut", img: "" },
  rules: { maxClassLevel: 10, maxCharLevel: 50, maxUnmastered: 3 },
  unmastered: 1,
  heroic: { slots: 0, used: 0, available: [], picked: [], open: 0 },
  classes: [{
    key: "guardian", id: "g", name: "Guardian", img: "", folder: "Classic Classes",
    benefit: "hp", free: {}, flavor: "", lore: "", also: "", mechanic: "",
    level: 3, mastered: false, taken: true,
    skills: [skill("Bodyguard", 1), skill("Fortress", 2)],
    facets: [],
  }],
});

const mkApp = (s) => {
  const a = Object.create(LevelUpApp);
  Object.assign(a, {
    _pending: [], _selected: "guardian", _tab: "skill", _resetMode: false,
    _detailMode: false, _root: null, _details: new Map(), _pinned: null,
    _updateCursor: () => {}, _benefitChoice: new Map(), _stateSource: () => s,
  });
  Object.defineProperty(a, "isOpen", { get: () => true, configurable: true });
  return a;
};

const buys = (html) => (html.match(/<button class="lu-btn buy"[\s\S]*?>/g) || []);
const enabled = (html) => buys(html).filter((b) => !b.includes("disabled")).length;
const deadTitle = (html) =>
  (buys(html).find((b) => b.includes("disabled"))?.match(/title="([^"]*)"/) || [])[1] ?? "";
const paint = (app, s) => app._main(s, app._project(s));

// ── a healthy pool spends one click at a time ──────────────────────────────
{
  const s = state(3);
  const app = mkApp(s);
  eq("all skills start buyable", enabled(paint(app, s)), 2);

  app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Bodyguard" });
  eq("one staged leaves two points", app._project(s).points, 2);
  eq("...and everything still buyable", enabled(paint(app, s)), 2);

  app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Fortress" });
  eq("two staged leaves one point", app._project(s).points, 1);
  eq("...and everything still buyable", enabled(paint(app, s)), 2);

  app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Bodyguard" });
  eq("the whole pool staged leaves none", app._project(s).points, 0);
  eq("...and NOW the buttons close", enabled(paint(app, s)), 0);
  eq("...saying the batch spent them", deadTitle(paint(app, s)),
    "No Skill Points left — this batch has spent them all");

  // A refund frees a point back into the same batch.
  app._pending.push({ op: "refund", classKey: "guardian", skillUuid: "Item.Fortress" });
  eq("a staged refund returns a point", app._project(s).points, 1);
  eq("...and reopens the buttons", enabled(paint(app, s)), 2);
}

// ── the confirm bar appears once, for the batch ────────────────────────────
{
  const s = state(3);
  const app = mkApp(s);
  eq("nothing staged, no footer", app._footer(s, app._project(s)), "");

  app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Bodyguard" });
  const one = app._footer(s, app._project(s));
  eq("one staged raises the bar", one.includes("Confirm 1 change"), true);

  app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Fortress" });
  const two = app._footer(s, app._project(s));
  eq("a second does NOT raise a second bar", two.includes("Confirm 2 changes"), true);
  eq("...it is still one Discard and one Confirm",
    [(two.match(/data-act="cancel"/g) || []).length,
     (two.match(/data-act="confirm"/g) || []).length], [1, 1]);
}

// ── a dead + always says why ───────────────────────────────────────────────
{
  const closed = state(3, 3, { open: false, where: null, reason: "Not at camp." });
  eq("a closed gate is quoted verbatim", deadTitle(paint(mkApp(closed), closed)), "Not at camp.");

  const maxed = state(3);
  maxed.classes[0].skills = [skill("Bodyguard", 5)];      // already at its ceiling
  eq("a maxed skill names its ceiling",
    deadTitle(paint(mkApp(maxed), maxed)), "Bodyguard is at its maximum (5)");

  const mastered = state(3);
  mastered.classes[0].level = 10;
  eq("a mastered class says so",
    deadTitle(paint(mkApp(mastered), mastered)), "Guardian is already mastered");

  const broke = state(0);
  eq("an empty purse says so, without blaming a batch",
    deadTitle(paint(mkApp(broke), broke)), "No Skill Points left");
}

// ── drift: the reported symptom, now explained ─────────────────────────────
//
// Stored says 1, the level says 2. Spending the one real point empties the
// purse — correctly — and the notice that explains it used to disappear at
// exactly that moment, leaving "the window broke".
{
  const s = state(1, 2);
  const app = mkApp(s);

  eq("the drift notice shows before staging", app._notes(s).includes("lu-note drift"), true);
  app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Bodyguard" });
  eq("...and STILL shows after staging", app._notes(s).includes("lu-note drift"), true);
  eq("...stating how many can actually be spent",
    app._notes(s).includes("Only 1 can be spent until this is fixed"), true);
  eq("...and offering the fix", app._notes(s).includes(`data-act="heal"`), true);

  eq("the buttons are correctly closed", enabled(paint(app, s)), 0);
  eq("...and say the batch spent the pool", deadTitle(paint(app, s)),
    "No Skill Points left — this batch has spent them all");

  // A surplus is drift too, and must not claim a spending cap it does not have.
  const rich = state(5, 2);
  const richApp = mkApp(rich);
  eq("a surplus reports drift", richApp._notes(rich).includes("lu-note drift"), true);
  eq("...without inventing a cap", richApp._notes(rich).includes("can be spent until"), false);
  eq("...and spends freely", enabled(paint(richApp, rich)), 2);

  // No drift, no notice.
  const fine = state(2);
  eq("a healthy actor gets no notice", mkApp(fine)._notes(fine).includes("lu-note drift"), false);
}

// ── players never see it; they cannot fix it ───────────────────────────────
{
  const s = state(1, 2);
  const app = mkApp(s);
  globalThis.game.user = { id: "u2", isGM: false };
  eq("a player is not shown the drift", app._notes(s).includes("lu-note drift"), false);
  globalThis.game.user = { id: "u1", isGM: true };
  eq("the GM is", app._notes(s).includes("lu-note drift"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
