// Bare-Node test: fragment DEF/MDEF mirror the owner's STATUS-FREE sheet values (2026-11-23, pass 2).
//   node scripts/conflict-event/events/soul-tithe-defense.test.mjs
// The status-free value comes from CSB itself (a prepared in-memory copy of the owner minus its
// transient AEs). Here only the PLUMBING is tested (predicate filter, clone call, fallbacks, mods);
// the real CSB computation is proven only in Staging.
globalThis.game = { user: { isGM: false } };
const { fragmentDefenseMods, transientEffectIds, ownerStatusFreeSheet } = await import("./soul-tithe.js");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`FAIL ${n}`); } };
const NS = "fabula-ultima-companion";

// ---- fragmentDefenseMods: mods from two integers ----
// Fragment model (layout a7204eb261df895c): dex_current/ins_current floored at 6 (non-Masterful),
// so the fragment's own Slow/Dazed/Enraged never lowers it; only +2 (Swift/Clarity/Awake) raises.
// defense = def_mod has "+" ? dex_current + def_mod : def_mod ; magic_defense = ins_current + mdef_mod.
const computeDef = (p) => (p.def_mod.includes("+") ? p.dex_current + Number(p.def_mod) : Number(p.def_mod));
const computeMdef = (p) => p.ins_current + Number(p.mdef_mod);
const frag = { dex_current: 6, ins_current: 6 };
for (const [name, d, m] of [["Hina", 8, 15], ["Keren", 11, 13], ["Blanche", 19, 15], ["Zarg", 14, 10], ["low", 4, 3], ["equal", 6, 6]]) {
  const mods = fragmentDefenseMods({ ownerDef: d, ownerMdef: m });
  const p = { ...frag, ...mods };
  ok(`${name} DEF ${d}`, computeDef(p) === d);
  ok(`${name} MDEF ${m}`, computeMdef(p) === m);
  ok(`${name} integer strings`, /^\d+$|^[-+]\d+$/.test(mods.def_mod) && /^[-+]\d+$/.test(mods.mdef_mod));
  if (d >= 6) ok(`${name} own Swift +2 DEF`, computeDef({ ...p, dex_current: 8 }) === d + 2);
  ok(`${name} own Awake +2 MDEF`, computeMdef({ ...p, ins_current: 8 }) === m + 2);
  ok(`${name} own Slow floored: no change`, computeDef({ ...p, dex_current: Math.max(6, 4) }) === d);
  ok(`${name} own Dazed floored: no change`, computeMdef({ ...p, ins_current: Math.max(6, 4) }) === m);
}
ok("Blanche 19/15 -> +13/+9", (() => { const m = fragmentDefenseMods({ ownerDef: 19, ownerMdef: 15 }); return m.def_mod === "+13" && m.mdef_mod === "+9"; })());
ok("below-basis DEF written absolute", fragmentDefenseMods({ ownerDef: 4, ownerMdef: 9 }).def_mod === "4");
ok("negative mdef diff", fragmentDefenseMods({ ownerDef: 8, ownerMdef: 3 }).mdef_mod === "-3");
ok("zero is +0", fragmentDefenseMods({ ownerDef: 6, ownerMdef: 6 }).def_mod === "+0");
ok("fractional rounds", fragmentDefenseMods({ ownerDef: 14.25, ownerMdef: 10.6 }).def_mod === "+8" && fragmentDefenseMods({ ownerDef: 14.25, ownerMdef: 10.6 }).mdef_mod === "+5");
ok("non-default dex basis", fragmentDefenseMods({ ownerDef: 10, ownerMdef: 6, fragDex: 8 }).def_mod === "+2");
ok("string inputs ok", fragmentDefenseMods({ ownerDef: "8", ownerMdef: "15" }).mdef_mod === "+9");
ok("missing owner -> null", fragmentDefenseMods() === null);
ok("undefined def -> null", fragmentDefenseMods({ ownerMdef: 5 }) === null);
ok("blank mdef -> null", fragmentDefenseMods({ ownerDef: 5, ownerMdef: "" }) === null);
ok("NaN -> null", fragmentDefenseMods({ ownerDef: "x", ownerMdef: 5 }) === null);
ok("null (clone failed) -> null", fragmentDefenseMods({ ownerDef: null, ownerMdef: null }) === null);

// ---- predicate filter ----
// Mirrors of the engine predicates (skill-effects.js needs Foundry globals to import):
// isBuffOrDebuffAE = active + tags buff/debuff + not persistent_counter; isTransientAE per that file.
const isBuffOrDebuff = (e) => {
  if (!e || e.disabled === true) return false;
  if (String(e.flags?.[NS]?.lifetimeMode ?? "").toLowerCase() === "persistent_counter") return false;
  const t = e.system?.tags; return Array.isArray(t) && (t.includes("buff") || t.includes("debuff"));
};
const isTransient = (e) => {
  const f = e?.flags?.[NS] ?? {};
  if (f.conflictScoped === true) return true;
  if (f.crossScene === true || f.directorPermanent === true) return false;
  if (f.directorAppliedBy) return true;
  const d = e?.duration ?? {};
  if (d.rounds != null || d.turns != null || d.seconds != null) return true;
  return isBuffOrDebuff(e);
};
const preds = { isBuffOrDebuff, isTransient };
const fx = {
  slowStatus: { id: "a", name: "Slow", statuses: ["slow"], duration: { rounds: 3 }, system: { tags: ["debuff"] } },
  withdraw: { id: "b", name: "Crystal Withdraw", system: { tags: ["debuff"] } },
  high: { id: "c", name: "Crystal High", system: { tags: ["buff"] } },
  directorApplied: { id: "d", name: "Orator Encourage", flags: { [NS]: { directorAppliedBy: "x" } } },
  counter: { id: "e", name: "Prophecy", flags: { [NS]: { lifetimeMode: "persistent_counter" } }, system: { tags: ["buff"] } },
  gear: { id: "f", name: "Paladin Armor", transfer: true, changes: [{ key: "system.props.base_defense", mode: 4, value: "4" }] },
  torn: { id: "g", name: "Soul-Torn", flags: { [NS]: { soulTorn: true, directorPermanent: true, conflictScoped: true } } },
  disabled: { id: "h", name: "Off", disabled: true, system: { tags: [] } },
  passive: { id: "i", name: "Trait", system: { tags: [] } },
};
const drop = transientEffectIds(Object.values(fx), preds);
for (const k of ["slowStatus", "withdraw", "high", "directorApplied", "disabled"]) ok(`${k} dropped`, drop.has(fx[k].id));
// persistent_counter: isBuffOrDebuff refuses it and it carries no transient signal -> kept
for (const k of ["counter", "gear", "torn", "passive"]) ok(`${k} kept`, !drop.has(fx[k].id));
ok("exactly 5 dropped", drop.size === 5);
ok("no predicates: only disabled drops", transientEffectIds(Object.values(fx), {}).size === 1);
ok("empty/null input", transientEffectIds(null, preds).size === 0 && transientEffectIds([null], preds).size === 0);
ok("uses _id when id absent", transientEffectIds([{ _id: "z", system: { tags: ["buff"] } }], preds).has("z"));

// ---- clone path with a stub Actor class (plumbing only) ----
const mkOwner = (effects, { defense = 11, magic_defense = 9, noToObject = false } = {}) => {
  const src = { name: "Owner", system: { props: { defense, magic_defense } }, effects: effects.map((e) => ({ _id: e.id, name: e.name })) };
  const o = { effects: { contents: effects }, toObject: () => structuredClone(src) };
  if (noToObject) delete o.toObject;
  return o;
};
const ctorCalls = []; let writes = 0;
class StubActor {
  constructor(data) { ctorCalls.push(data); this.system = { props: { defense: data.system.props.defense, magic_defense: data.system.props.magic_defense } }; }
  update() { writes++; } createEmbeddedDocuments() { writes++; }
}
const res = ownerStatusFreeSheet(mkOwner(Object.values(fx)), { ActorClass: StubActor, preds });
ok("stub: ints returned", res && res.def === 11 && res.mdef === 9);
ok("stub: constructed once, nothing written", ctorCalls.length === 1 && writes === 0);
ok("stub: clone carries only kept effects (e,f,g,i)", ctorCalls[0].effects.map((e) => e._id).sort().join("") === "efgi");
ok("fractional prepared rounds", (() => { const r = ownerStatusFreeSheet(mkOwner([], { defense: 14.6, magic_defense: 9.4 }), { ActorClass: StubActor, preds }); return r.def === 15 && r.mdef === 9; })());
const origWarn = console.warn; let warns = 0; console.warn = () => { warns++; };
class Boom { constructor() { throw new Error("nope"); } }
ok("constructor throws -> null", ownerStatusFreeSheet(mkOwner([]), { ActorClass: Boom, preds }) === null);
ok("second throw does not re-warn", ownerStatusFreeSheet(mkOwner([]), { ActorClass: Boom, preds }) === null && warns === 1);
console.warn = origWarn;
ok("non-finite -> null", ownerStatusFreeSheet(mkOwner([], { defense: "x" }), { ActorClass: StubActor, preds }) === null);
ok("blank -> null", ownerStatusFreeSheet(mkOwner([], { magic_defense: "" }), { ActorClass: StubActor, preds }) === null);
console.warn = () => {};
ok("no toObject -> null", ownerStatusFreeSheet(mkOwner([], { noToObject: true }), { ActorClass: StubActor, preds }) === null);
console.warn = origWarn;
ok("null owner -> null", ownerStatusFreeSheet(null, { ActorClass: StubActor, preds }) === null);
ok("e2e: sheet -> mods -> value", (() => { const r = ownerStatusFreeSheet(mkOwner([], { defense: 19, magic_defense: 15 }), { ActorClass: StubActor, preds }); const m = fragmentDefenseMods({ ownerDef: r.def, ownerMdef: r.mdef }); return computeDef({ ...frag, ...m }) === 19 && computeMdef({ ...frag, ...m }) === 15; })());

console.log(`soul-tithe-defense: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
