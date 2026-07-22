globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game = { actors: [], items: [], folders: [], users: [], user: { id: "u1" },
  settings: { get: () => "" }, socket: { emit() {}, on() {} }, data: {}, world: { id: "w" } };
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };

const { LevelUpApp } = await import("../levelup-system/levelup-app.js");

const skill = (name, lvl, maxLevel = 5) => ({
  uuid: `Item.${name}`, key: name, name, img: "", type: "", cost: "", description: "",
  maxLevel, level: lvl, atMax: lvl >= maxLevel, facetGrant: 0,
});
const state = (stored) => ({
  ok: true, actor: { name: "X", img: "" }, level: 10, classLevelTotal: 3,
  points: { stored, expected: stored, drift: false },
  gate: { open: true, where: "camp" },
  nuts: { count: 3, name: "Nut", img: "" },
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

const app = Object.create(LevelUpApp);
Object.assign(app, {
  _pending: [], _selected: "guardian", _tab: "skill", _resetMode: false,
  _detailMode: false, _root: null, _details: new Map(), _pinned: null,
  _updateCursor: () => {}, _benefitChoice: new Map(),
});
Object.defineProperty(app, "isOpen", { get: () => true, configurable: true });

const countEnabled = (html) =>
  (html.match(/data-act="spend"[^>]*?>/gs) || []).filter((b) => !b.includes("disabled")).length;

let s = state(2);
app._stateSource = () => s;

let proj = app._project(s);
console.log("BEFORE any spend: proj.points =", proj.points);
let html = app._main(s, proj);
console.log("  enabled + buttons:", countEnabled(html), "of 2");

app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Bodyguard" });
proj = app._project(s);
console.log("AFTER 1 staged spend: proj.points =", proj.points);
html = app._main(s, proj);
console.log("  enabled + buttons:", countEnabled(html), "of 2");

// What each gate says
const cls = s.classes[0];
const clsLevel = app._classLevel(s, cls, proj);
console.log("  clsLevel:", clsLevel, "| gate.open:", s.gate.open,
            "| projectedUnmastered:", app._projectedUnmastered(s, proj),
            "| opening:", clsLevel === 0);

// ── does render() itself survive? ──
const el = () => {
  const node = {
    innerHTML: "", scrollTop: 0, id: "", className: "", style: {},
    dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} },
    querySelector: () => el(), querySelectorAll: () => [],
    addEventListener(){}, removeEventListener(){}, remove(){}, appendChild(){},
    getBoundingClientRect: () => ({ top:0,left:0,width:0,height:0 }),
    firstElementChild: null, offsetWidth: 0,
  };
  return node;
};
globalThis.document = { createElement: () => el(), getElementById: () => null, head: el(), body: el() };
globalThis.requestAnimationFrame = (f) => { f(0); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.performance = { now: () => 0 };

app._root = el();
try { app.render(); console.log("render(): OK"); }
catch (e) { console.log("render() THREW:", e.message); }

app._pending.push({ op: "spend", classKey: "guardian", skillUuid: "Item.Fortress" });
try { app.render(); console.log("render() with 2 staged: OK"); }
catch (e) { console.log("render() with 2 staged THREW:", e.message); }

console.log("_benefitChoice present on singleton:", LevelUpApp._benefitChoice instanceof Map);
console.log("footer with 2 staged:", app._footer(s, app._project(s)).slice(0, 90).replace(/\s+/g," "));
