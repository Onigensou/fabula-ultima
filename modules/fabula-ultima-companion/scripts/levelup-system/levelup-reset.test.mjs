/**
 * The rules around giving things back: refunds, Unlearn Heroic and the stash.
 *
 * Runs the real GM handlers against a small fake world. It exists because of
 * reports that Reset was unusable once Heroic Skills were involved: mastered
 * classes refused with "unlearn X first" when nothing could unlearn X, while
 * other mastered classes let a character keep more Heroics than slots.
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
      const { id, parent: _p, uuid: _u, toObject: _t, update: _a, delete: _d, ...rest } = this;
      return clone({ ...rest, _id: id });
    },
    async update(u) { for (const [k, v] of Object.entries(u)) setPath(this, k, v); },
    async delete() { await parent.deleteEmbeddedDocuments("Item", [this.id]); },
  };
  return item;
}

function makeActor(id, name, { props = {}, items = [], folder = null, type = "character", owners = [] } = {}) {
  const actor = {
    id, name, type, folder, img: "", uuid: `Actor.${id}`,
    documentName: "Actor",
    flags: {},
    system: { props: clone(props) },
    items: { contents: [] },
    writes: 0,
    failNextCreate: false,
    testUserPermission: (user) => owners.includes(user.id),
    async update(u) {
      actor.writes++;
      for (const [k, v] of Object.entries(u)) {
        const m = k.match(/^(.*)\.-=(.+)$/);
        if (m) {
          const at = m[1].split(".").reduce((o, p) => o?.[p], actor);
          if (at) delete at[m[2]];
        } else {
          setPath(actor, k, clone(v));
        }
      }
    },
    async createEmbeddedDocuments(_t, list) {
      if (actor.failNextCreate) { actor.failNextCreate = false; throw new Error("create failed"); }
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

const skill = (name, props = {}) => ({
  name, img: "",
  system: { props: { skill_type: "Passive", level: 1, max_level: 5, description: "", ...props } },
});
const heroic = (name, req, props = {}) => skill(name, { isHeroic: true, heroic_requirement: req, ...props });
const facet = (name) => skill(name, { skill_type: "Spell", isFacet: true });

const rootFolder = { id: "root", name: "Classes", type: "Actor", folder: null };
const classicFolder = { id: "classic", name: "Classic Classes", type: "Actor", folder: rootFolder };

const docs = new Map();

function classActor(id, name, items) {
  const a = makeActor(id, name, { folder: classicFolder, items, props: { benefit_dropdown: "hp_benefit" } });
  docs.set(a.uuid, a);
  for (const i of a.items.contents) docs.set(i.uuid, i);
  return a;
}

const dance = classActor("dancer", "Dancer", [
  skill("Dance", { max_level: 10, description: "you learn a dance (see Facet)" }),
  skill("Footwork"),
  facet("Waltz"),
  facet("Tango"),
  heroic("Dance Heroic", "You must have mastered the Dancer Class."),
]);
const sym = classActor("symbolist", "Symbolist", [
  skill("Symbolism", { description: "you learn two symbols (see Facet)" }),
  facet("Sun"),
  facet("Moon"),
  facet("Star"),
]);
const guard = classActor("guardian", "Guardian", [
  skill("Protect"),
  heroic("Rampart", "You must have mastered the Guardian Class."),
  skill("Dismissal", { skill_type: "Active" }),
  heroic("Warlord", "You must have mastered the Guardian Class.", { companion_skills: "Dismissal" }),
]);
const arc = classActor("arcanist", "Arcanist", [
  skill("Arcane Circle"),
  skill("test skill", { skill_type: "" }),
]);

const folders = [rootFolder, classicFolder];
globalThis.Hooks = { once() {}, on() {}, off() {}, callAll() {} };
globalThis.game = {
  actors: { contents: [dance, sym, guard, arc], get: (id) => docs.get(`Actor.${id}`) ?? null },
  items: [],
  folders: Object.assign(folders, { get: (id) => folders.find((f) => f.id === id) }),
  users: new Map([["gm", { id: "gm", isGM: true }], ["p1", { id: "p1", isGM: false }], ["p2", { id: "p2", isGM: false }]]),
  user: { id: "gm", isGM: true },
  settings: { get: () => "" },
  socket: { emit() {}, on() {} },
  data: {},
  world: { id: "w" },
  // A title-screen scene, so the spend gate is open.
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

const { LEVELUP } = await import("./levelup-const.js");
const API = await import("./levelup-api.js");
const { getRegistry, invalidate } = await import("./class-registry.js");
const { availableHeroics } = await import("./requirement-eval.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

const nut = (qty) => ({ name: "Forget me Nut", system: { props: { item_quantity: qty } } });

function pc(id, { classes, items = [], nuts = 5, sp = 0, owners = ["p1"] }) {
  const class_list = {};
  classes.forEach(([class_name, level], i) => { class_list[i] = { class_name, level, benefit: "hp" }; });
  const total = classes.reduce((s, [, l]) => s + l, 0);
  const a = makeActor(id, id, {
    owners,
    props: { level: total + sp, skill_point: sp, skill_point_bonus: 0, class_list },
    items: nuts ? [...items, nut(nuts)] : items,
  });
  docs.set(a.uuid, a);
  return a;
}

const uuidOf = (cls, name) => cls.items.contents.find((i) => i.name === name).uuid;
const levelOf = (a, name) => a.items.contents.find((i) => i.name === name)?.system.props.level ?? 0;
const has = (a, name) => a.items.contents.some((i) => i.name === name);
const nutsOf = (a) => API.readNuts(a).count;

const refund = (a, cls, name, facetUuids) => API.refundPoint({
  actorUuid: a.uuid, classKey: cls.name.toLowerCase(), skillUuid: uuidOf(cls, name), facetUuids,
});
const spend = (a, cls, name, facetUuids, requesterUserId) => API.spendPoint({
  actorUuid: a.uuid, classKey: cls.name.toLowerCase(), skillUuid: uuidOf(cls, name), benefit: "hp", facetUuids, requesterUserId,
});
const unlearn = (a, name) => API.unlearnHeroic({
  actorUuid: a.uuid, skillKey: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
});

invalidate();
getRegistry();

console.log("registry");
eq("a skill with no type is not on sale", getRegistry().byKey.get("arcanist").skills.map((s) => s.name), ["Arcane Circle"]);

console.log("heroic blocks a refund, and unlearning clears the way");
{
  const a = pc("A1", {
    classes: [["Guardian", 10]],
    items: [skill("Protect", { level: 10 }), heroic("Rampart", "You must have mastered the Guardian Class.")],
  });
  const r = await refund(a, guard, "Protect");
  eq("refused", r.reason, "would_orphan_heroic");
  eq("names the Heroic", r.broken.map((b) => b.name), ["Rampart"]);
  eq("no nut charged", nutsOf(a), 5);

  const u = await unlearn(a, "Rampart");
  eq("unlearn succeeds", u.ok, true);
  eq("Heroic is gone", has(a, "Rampart"), false);
  eq("costs one nut", nutsOf(a), 4);
  eq("slot is open", API.heroicSlots(a).open, 1);

  const r2 = await refund(a, guard, "Protect");
  eq("the refund now works", r2.ok, true);
  eq("class dropped", a.system.props.class_list[0].level, 9);
}

console.log("slot count holds even with no dependency");
{
  const a = pc("A2", {
    classes: [["Guardian", 10], ["Dancer", 10]],
    items: [
      skill("Protect", { level: 10 }), skill("Footwork", { level: 10 }),
      heroic("Rampart", "You must have mastered the Guardian Class."),
      heroic("Other Heroic", "You must have mastered the Guardian Class."),
    ],
  });
  const r = await refund(a, dance, "Footwork");
  eq("no free Heroic from dropping a mastery", r.reason, "would_exceed_heroic_slots");
  eq("level untouched", levelOf(a, "Footwork"), 10);
}

console.log("gear-granted Heroics");
{
  const a = pc("A3", {
    classes: [["Guardian", 10]],
    items: [
      skill("Protect", { level: 10 }),
      heroic("Hat Passive", "You must have mastered the Guardian Class.", { container: "hat" }),
    ],
  });
  const r = await refund(a, guard, "Protect");
  eq("do not block a refund", r.ok, true);
  const u = await unlearn(a, "Hat Passive");
  eq("cannot be unlearned", u.reason, "heroic_from_gear");
}

console.log("only a clause the change breaks counts");
{
  const a = pc("A4", {
    classes: [["Dancer", 5], ["Guardian", 3]],
    items: [
      skill("Footwork", { level: 5 }), skill("Protect", { level: 3 }),
      heroic("Already Broken", "You must have mastered the Guardian Class."),
    ],
  });
  const r = await refund(a, dance, "Footwork");
  eq("an already-broken Heroic does not block an unrelated refund", r.ok, true);
}

console.log("a requirement met from another class");
{
  const a = pc("A5", {
    classes: [["Guardian", 10], ["Dancer", 3]],
    items: [
      skill("Protect", { level: 10 }), skill("Footwork", { level: 1 }), skill("Dance", { level: 2 }),
      facet("Waltz"), facet("Tango"),
      heroic("Needs Waltz", "You must have mastered the Guardian Class, and you must have learned the Waltz spell."),
    ],
  });
  const r = await refund(a, dance, "Dance", [uuidOf(dance, "Waltz")]);
  eq("refused when the Facet it needs would leave", r.reason, "would_orphan_heroic");
  const r2 = await refund(a, dance, "Dance", [uuidOf(dance, "Tango")]);
  eq("allowed when another Facet goes instead", r2.ok, true);
}

console.log("a Heroic another Heroic needs");
{
  const a = pc("A6", {
    classes: [["Guardian", 10]],
    items: [
      skill("Protect", { level: 10 }),
      heroic("Base Heroic", "You must have mastered the Guardian Class."),
      heroic("Top Heroic", "You must have mastered the Guardian Class, and you must have acquired the Base Heroic Skill."),
    ],
  });
  const u = await unlearn(a, "Base Heroic");
  eq("refused", u.reason, "would_orphan_heroic");
  eq("no nut charged", nutsOf(a), 5);
}

console.log("Facet counts");
{
  const a = pc("A7", {
    classes: [["Symbolist", 1]],
    items: [skill("Symbolism", { level: 1 }), facet("Sun"), facet("Moon")],
  });
  const one = await refund(a, sym, "Symbolism", [uuidOf(sym, "Sun")]);
  eq("a two-Facet level cannot give back one", one.reason, "facet_count");
  const both = await refund(a, sym, "Symbolism", [uuidOf(sym, "Sun"), uuidOf(sym, "Moon")]);
  eq("gives back both", both.ok, true);

  const b = pc("A8", { classes: [["Symbolist", 1]], sp: 1, items: [skill("Symbolism", { level: 1 })] });
  const greedy = await spend(b, sym, "Symbolism", [uuidOf(sym, "Sun"), uuidOf(sym, "Moon"), uuidOf(sym, "Star")]);
  eq("a spend cannot claim more than the grant", greedy.reason, "facet_count");
  const noGrant = pc("A9", { classes: [["Guardian", 1]], sp: 1, items: [skill("Protect", { level: 1 })] });
  const r = await API.spendPoint({
    actorUuid: noGrant.uuid, classKey: "guardian", skillUuid: uuidOf(guard, "Protect"), facetUuids: [uuidOf(sym, "Sun")],
  });
  eq("a skill with no grant takes no Facets", r.reason, "facet_count");
}

console.log("the stash");
{
  const a = pc("B1", {
    classes: [["Guardian", 10]],
    items: [skill("Protect", { level: 10 }), heroic("Rampart", "You must have mastered the Guardian Class.", { animation_script: "mine" })],
  });
  await unlearn(a, "Rampart");
  eq("copy kept", a.flags[LEVELUP.MODULE_ID][LEVELUP.STASH_FLAG].rampart.system.props.animation_script, "mine");
  const offer = availableHeroics(a).find((o) => o.skill.key === "rampart");
  const p = await API.pickHeroic({ actorUuid: a.uuid, skillUuid: offer.skill.uuid });
  eq("re-pick works", p.ok, true);
  eq("restores the character's copy, not the class's",
    a.items.contents.find((i) => i.name === "Rampart").system.props.animation_script, "mine");
  eq("stash emptied", a.flags[LEVELUP.MODULE_ID][LEVELUP.STASH_FLAG].rampart, undefined);

  const c = pc("B2", {
    classes: [["Guardian", 10]],
    items: [skill("Protect", { level: 10 }), heroic("Sheet Only", "You must have mastered the Guardian Class.")],
  });
  await unlearn(c, "Sheet Only");
  const off2 = availableHeroics(c).find((o) => o.skill.key === "sheetonly");
  eq("a Heroic on no class is still offered", !!off2?.met, true);
  eq("re-pick from the stash works", (await API.pickHeroic({ actorUuid: c.uuid, skillUuid: off2.skill.uuid })).ok, true);
  eq("and is back", has(c, "Sheet Only"), true);

  const d = pc("B3", { classes: [["Dancer", 1]], sp: 0, items: [skill("Footwork", { level: 1, animation_script: "mine" })] });
  await refund(d, dance, "Footwork");
  eq("a skill refunded to zero leaves", has(d, "Footwork"), false);
  await spend(d, dance, "Footwork");
  eq("re-buying restores the character's copy",
    d.items.contents.find((i) => i.name === "Footwork").system.props.animation_script, "mine");

  const e = pc("B4", {
    classes: [["Guardian", 10]],
    items: [
      skill("Protect", { level: 10 }),
      heroic("Warlord", "You must have mastered the Guardian Class.", { companion_skills: "Dismissal" }),
      skill("Dismissal", { skill_type: "Active", animation_script: "mine" }),
    ],
  });
  await unlearn(e, "Warlord");
  eq("a companion leaves with its Heroic", has(e, "Dismissal"), false);
  const off3 = availableHeroics(e).find((o) => o.skill.key === "warlord");
  await API.pickHeroic({ actorUuid: e.uuid, skillUuid: off3.skill.uuid });
  eq("and comes back with it",
    e.items.contents.find((i) => i.name === "Dismissal")?.system.props.animation_script, "mine");
}

console.log("half-applied spends");
{
  const a = pc("C1", { classes: [["Dancer", 1]], sp: 1, items: [skill("Dance", { level: 1 })] });
  const saved = docs.get(uuidOf(dance, "Footwork"));
  docs.delete(uuidOf(dance, "Footwork"));
  const uuid = saved.uuid;
  const r = await API.spendPoint({ actorUuid: a.uuid, classKey: "dancer", skillUuid: uuid, benefit: "hp" });
  docs.set(uuid, saved);
  eq("a missing source is refused", r.reason, "skill_source_missing");
  eq("the class level did not move", a.system.props.class_list[0].level, 1);
  eq("the point is kept", a.system.props.skill_point, 1);

  a.failNextCreate = true;
  const r2 = await spend(a, dance, "Footwork");
  eq("a failed create reports an error", r2.reason, "error");
  eq("the class level is put back", a.system.props.class_list[0].level, 1);
  eq("the point is kept", a.system.props.skill_point, 1);
}

console.log("ownership");
{
  const a = pc("D1", { classes: [["Dancer", 1]], sp: 1, items: [skill("Dance", { level: 1 })], owners: ["p1"] });
  eq("another player is refused", (await spend(a, dance, "Footwork", undefined, "p2")).reason, "not_owner");
  eq("the owner is allowed", (await spend(a, dance, "Footwork", undefined, "p1")).ok, true);
  const b = pc("D2", { classes: [["Dancer", 1]], sp: 1, items: [skill("Dance", { level: 1 })], owners: ["p1"] });
  eq("a GM is allowed", (await spend(b, dance, "Footwork", undefined, "gm")).ok, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
