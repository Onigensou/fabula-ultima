/**
 * Per-level choices (levelup-choices.js): "Each time you take this Skill, choose
 * a creature Species." Runs the real GM handlers against a small fake world, the
 * same way levelup-reset.test.mjs does. Run: node levelup-choices.test.mjs
 */

const clone = (o) => JSON.parse(JSON.stringify(o));
const setPath = (obj, path, value) => {
  const parts = path.split(".");
  let at = obj;
  for (const p of parts.slice(0, -1)) at = at[p] ??= {};
  at[parts.at(-1)] = value;
};

let nextId = 1;

function makeItem(parent, data) {
  const item = {
    ...clone(data),
    id: data._id ?? `i${nextId++}`,
    parent,
    get uuid() { return `Actor.${parent.id}.Item.${this.id}`; },
    toObject() {
      const { id, parent: _p, uuid: _u, toObject: _t, update: _a, delete: _d, updateEmbeddedDocuments: _e, ...rest } = this;
      return clone({ ...rest, _id: id });
    },
    async update(u) { for (const [k, v] of Object.entries(u)) setPath(this, k, v); },
    async delete() { await parent.deleteEmbeddedDocuments("Item", [this.id]); },
    async updateEmbeddedDocuments(type, list) {
      if (type !== "ActiveEffect") throw new Error("only effects");
      for (const u of list) {
        const e = this.effects.find((x) => x._id === u._id);
        if (!e) throw new Error("no effect " + u._id);
        Object.assign(e, u);
      }
    },
  };
  // Fresh effect ids per copy, as Foundry gives an embedded copy new ids.
  item.effects = (item.effects ?? []).map((e) => ({ ...e, _id: `e${nextId++}` }));
  return item;
}

function makeActor(id, name, { props = {}, items = [], folder = null, owners = [] } = {}) {
  const actor = {
    id, name, type: "character", folder, img: "", uuid: `Actor.${id}`, documentName: "Actor",
    flags: {}, system: { props: clone(props) }, items: { contents: [] },
    testUserPermission: (user) => owners.includes(user.id),
    async update(u) {
      for (const [k, v] of Object.entries(u)) {
        const m = k.match(/^(.*)\.-=(.+)$/);
        if (m) { const at = m[1].split(".").reduce((o, p) => o?.[p], actor); if (at) delete at[m[2]]; }
        else setPath(actor, k, clone(v));
      }
    },
    async createEmbeddedDocuments(_t, list) {
      const made = list.map((d) => makeItem(actor, d));
      actor.items.contents.push(...made);
      return made;
    },
    async deleteEmbeddedDocuments(_t, ids) {
      actor.items.contents = actor.items.contents.filter((i) => !ids.includes(i.id));
    },
  };
  actor.items.contents = items.map((d) => makeItem(actor, d));
  return actor;
}

const SPECIES = ["Beast", "Construct", "Demon", "Elemental", "Humanoid", "Monster", "Plant", "Undead"];
const baneOils = (props = {}, on = []) => ({
  name: "Bane Oils", img: "",
  system: { props: { skill_type: "Active", level: 1, max_level: 5, description: "", ...props } },
  effects: [
    ...SPECIES.map((sp) => ({ name: `Bane Oils: ${sp}`, disabled: !on.includes(sp) })),
    { name: "Bane Oils (Beast)", disabled: false },   // an oil template — never a choice
  ],
});
const plain = (name) => ({ name, img: "", system: { props: { skill_type: "Passive", level: 1, max_level: 5, description: "" } }, effects: [] });

const rootFolder = { id: "root", name: "Classes", type: "Actor", folder: null };
const classicFolder = { id: "classic", name: "Classic Classes", type: "Actor", folder: rootFolder };
const docs = new Map();
function classActor(id, name, items) {
  const a = makeActor(id, name, { folder: classicFolder, items, props: { benefit_dropdown: "hp_benefit" } });
  docs.set(a.uuid, a);
  for (const i of a.items.contents) docs.set(i.uuid, i);
  return a;
}
const slayer = classActor("slayer", "Slayer", [baneOils(), plain("Giant Killer")]);

const folders = [rootFolder, classicFolder];
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game = {
  actors: { contents: [slayer], get: (id) => docs.get(`Actor.${id}`) ?? null },
  items: [],
  folders: Object.assign(folders, { get: (id) => folders.find((f) => f.id === id) }),
  users: new Map([["gm", { id: "gm", isGM: true }], ["p1", { id: "p1", isGM: false }], ["p2", { id: "p2", isGM: false }]]),
  user: { id: "gm", isGM: true },
  settings: { get: () => "" },
  socket: { emit() {}, on() {} },
  data: {}, world: { id: "w" },
  scenes: { active: { flags: { "fabula-ultima-companion": { oniFabula: { general: { sceneMode: "title" } } } } } },
};
game.users.activeGM = game.users.get("gm");
game.users.filter = () => [game.users.get("gm")];
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 3 } };
globalThis.foundry = { utils: { duplicate: clone, deepClone: clone, setProperty: setPath, randomID: () => "r" } };
globalThis.fromUuidSync = (u) => docs.get(u) ?? null;
globalThis.fromUuid = async (u) => docs.get(u) ?? null;
globalThis.FUCompanion = { isPrimaryGM: () => true, api: {} };
globalThis.ChatMessage = { create: async () => null };

const API = await import("./levelup-api.js");
const { getRegistry, invalidate } = await import("./class-registry.js");
const { readChoices } = await import("./levelup-choices.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

const nut = (qty) => ({ name: "Forget me Nut", system: { props: { item_quantity: qty } }, effects: [] });
function pc(id, { level = 0, sp = 0, on = [], owners = ["p1"] } = {}) {
  const class_list = level ? { 0: { class_name: "Slayer", level, benefit: "hp" } } : {};
  const items = [nut(5)];
  if (level) items.push(baneOils({ level }, on));
  const a = makeActor(id, id, { owners, props: { level: level + sp, skill_point: sp, skill_point_bonus: 0, class_list } });
  a.items.contents = items.map((d) => makeItem(a, d));
  docs.set(a.uuid, a);
  return a;
}
const bane = (a) => a.items.contents.find((i) => i.name === "Bane Oils");
const chosen = (a) => (readChoices(bane(a))?.options ?? []).filter((o) => o.held).map((o) => o.label);
const skillUuid = slayer.items.contents.find((i) => i.name === "Bane Oils").uuid;
const spend = (a, choiceKeys, requesterUserId) => API.spendPoint({ actorUuid: a.uuid, classKey: "slayer", skillUuid, benefit: "hp", choiceKeys, requesterUserId });
const refund = (a, choiceKeys) => API.refundPoint({ actorUuid: a.uuid, classKey: "slayer", skillUuid, choiceKeys });
const choose = (a, choiceKeys, requesterUserId) => API.chooseOptions({ actorUuid: a.uuid, skillKey: "baneoils", choiceKeys, requesterUserId });

invalidate();
getRegistry();

console.log("reading");
{
  const c = readChoices(bane(pc("R1", { level: 2, on: ["Beast"] })));
  eq("8 species, the oil templates are not choices", c.options.length, 8);
  eq("held / owed at SL 2 with one pick", [c.held, c.owed], [1, 1]);
  eq("a skill with no declaration has no choices", readChoices(plain("Giant Killer")), null);
}

console.log("first take");
{
  const a = pc("S1", { sp: 1 });
  const r = await spend(a, ["beast"]);
  eq("spend ok", r.ok, true);
  eq("the new copy has Beast switched on", chosen(a), ["Beast"]);
  eq("the class copy is untouched", readChoices(docs.get(skillUuid)).held, 0);
}

console.log("raising a level");
{
  const a = pc("S2", { level: 1, sp: 2, on: ["Beast"] });
  eq("two picks for one level refused", (await spend(a, ["monster", "demon"])).reason, "choice_count");
  eq("nothing moved", [bane(a).system.props.level, a.system.props.skill_point], [1, 2]);
  eq("an already-held pick refused", (await spend(a, ["beast"])).reason, "choice_already_held");
  eq("an unknown key refused", (await spend(a, ["dragon"])).reason, "choice_unknown");
  eq("one new pick ok", (await spend(a, ["monster"])).ok, true);
  eq("Beast + Monster", chosen(a), ["Beast", "Monster"]);
  eq("no pick is allowed (catch-up later)", (await spend(a)).ok, true);
  eq("SL 3, still 2 chosen, 1 owed", [bane(a).system.props.level, readChoices(bane(a)).owed], [3, 1]);
}

console.log("refund");
{
  const a = pc("F1", { level: 2, on: ["Beast", "Monster"] });
  eq("must name what goes back", (await refund(a, [])).reason, "choice_count");
  eq("cannot give back an unheld pick", (await refund(a, ["demon"])).reason, "choice_not_held");
  eq("refund with Monster", (await refund(a, ["monster"])).ok, true);
  eq("Beast stays", chosen(a), ["Beast"]);
  const b = pc("F2", { level: 2, on: ["Beast"] });
  eq("a level with nothing chosen gives nothing back", (await refund(b, [])).ok, true);
  eq("Beast stays on SL 1", chosen(b), ["Beast"]);
  eq("to zero: Beast must go back", (await refund(b, [])).reason, "choice_count");
  eq("to zero with Beast", (await refund(b, ["beast"])).ok, true);
  const stash = b.flags["fabula-ultima-companion"]?.levelupStash?.baneoils;
  eq("stashed with nothing chosen", stash.effects.filter((e) => e.name.startsWith("Bane Oils: ") && !e.disabled).length, 0);
  b.system.props.skill_point = 1;
  eq("re-take from the stash asks again", (await spend(b, ["undead"])).ok, true);
  eq("only Undead", chosen(b), ["Undead"]);
}

console.log("catch-up");
{
  const z = pc("Z1", { level: 2, owners: ["p1"] });   // Zarg: SL 2, nothing chosen
  eq("needs keys", (await choose(z, [])).reason, "choice_count");
  eq("three for SL 2 refused", (await choose(z, ["beast", "monster", "demon"])).reason, "choice_count");
  eq("another player refused", (await choose(z, ["beast"], "p2")).reason, "not_owner");
  const r = await choose(z, ["beast", "monster"], "p1");
  eq("owner picks Beast + Monster", [r.ok, r.owed], [true, 0]);
  eq("both on", chosen(z), ["Beast", "Monster"]);
  eq("nothing more owed", (await choose(z, ["demon"])).reason, "choice_count");
  eq("no point moved", z.system.props.skill_point, 0);
  const g = API.getState(z.uuid).classes.find((c) => c.key === "slayer").skills.find((s) => s.key === "baneoils");
  eq("window view", [g.choice.label, g.choice.held, g.choice.owed], ["Species", 2, 0]);
  eq("not held → refused", (await API.chooseOptions({ actorUuid: pc("Z2").uuid, skillKey: "baneoils", choiceKeys: ["beast"] })).reason, "skill_not_held");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
