// node scripts/battle-director/stays-down.test.mjs
//
// creature_stays_down (Nox Servant's trigger) + the side-wipe hold.
//   Part 1: stays-down.js, pure (holdsStaysDown states, row walk, source sides).
//   Part 2: registration (director-triggers native + phase; reaction-triggers config + family).
//   Part 3: defeatReactor with the reaction dispatch stubbed (once per fall, observers only,
//           guests/objects never emit, Auto-Life wins, hold while in flight, release always).
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  STAYS_DOWN_TRIGGER, beginStaysDown, endStaysDown, markStaysDownSettled, clearStaysDownSettled,
  isStaysDownSettled, holdsStaysDown, staysDownRowsOf, sourceCovers, _resetStaysDown,
} from "./stays-down.js";

let n = 0;
const t = async (name, fn) => { _resetStaysDown(); await fn(); n++; console.log("  ok", name); };
const NS = "fabula-ultima-companion";

// ── fakes ────────────────────────────────────────────────────────────────────
const row = (trigger, extra = {}) => ({ reaction_trigger: trigger, reaction_passive_mode: "force", reaction_source: "enemy", ...extra });
const passive = (rows) => ({ name: "Zero Trigger: Nox Servant", system: { props: { reaction_config_table: rows } } });
const koAE = () => ({ id: "ko", name: "KO", flags: { [NS]: { bdDefeated: true } } });
let _ids = 0;
function actor(uuid, { hp = 10, props = {}, flags = {}, items = [], effects = [] } = {}) {
  const a = {
    uuid, name: uuid, flags, items,
    system: { props: { current_hp: hp, max_hp: 30, ...props } },
    _effects: [...effects],
    get effects() { const arr = a._effects; return { contents: arr, some: (f) => arr.some(f) }; },
    get appliedEffects() { return a._effects.filter((e) => !e.disabled); },
    getActiveTokens: () => [{ document: { uuid: `Scene.s.Token.${uuid}`, object: { id: `T.${uuid}` }, flags: {} } }],
    async createEmbeddedDocuments(_t, docs) { for (const d of docs) a._effects.push({ id: `e${++_ids}`, ...d }); return docs; },
    async deleteEmbeddedDocuments(_t, ids) { a._effects = a._effects.filter((e) => !ids.includes(e.id)); },
  };
  return a;
}
function combatant(a, side) {
  return { actorDoc: a, actor: a, side, defeated: false, isDefeatedLive: () => Number(a.system.props.current_hp) <= 0 };
}
const noxRow = () => passive({ 0: row(STAYS_DOWN_TRIGGER) });

// ═══ Part 1: stays-down.js ═══════════════════════════════════════════════════
console.log("stays-down.js");
const setup = (pcOpts = {}, nidOpts = {}) => {
  const pc = actor("Actor.pc", { hp: 0, ...pcOpts });
  const nid = actor("Actor.nid", { hp: 100, items: [noxRow()], ...nidOpts });
  const cPc = combatant(pc, "party"), cNid = combatant(nid, "enemy");
  return { pc, nid, cPc, cNid, dc: { combatants: [cPc, cNid] } };
};

await t("(a) downed PC, no KO marker yet, live enemy with a source:enemy row → hold", () => {
  const { dc, cPc } = setup();
  assert.equal(holdsStaysDown(dc, cPc), true);
});
await t("(b) the same PC after markStaysDownSettled → no hold", () => {
  const { dc, cPc, pc } = setup();
  markStaysDownSettled(pc, dc);
  assert.equal(isStaysDownSettled(pc, dc), true);
  assert.equal(holdsStaysDown(dc, cPc), false);
});
await t("(b2) settled in ANOTHER battle does not count (raised off the ledger between fights)", () => {
  const { dc, cPc, pc } = setup();
  markStaysDownSettled(pc, { combatants: [] });
  assert.equal(isStaysDownSettled(pc, dc), false);
  assert.equal(holdsStaysDown(dc, cPc), true);
});
await t("(c) KO marker present, nothing in flight (sweep / off-ledger) → no hold", () => {
  const { dc, cPc } = setup({ effects: [koAE()] });
  assert.equal(holdsStaysDown(dc, cPc), false);
});
await t("(c2) a DISABLED KO marker is no marker → hold", () => {
  const { dc, cPc } = setup({ effects: [{ ...koAE(), disabled: true }] });
  assert.equal(holdsStaysDown(dc, cPc), true);
});
await t("(d) beginStaysDown + KO marker → hold; endStaysDown → released", () => {
  const { dc, cPc, pc } = setup({ effects: [koAE()] });
  beginStaysDown(pc);
  assert.equal(holdsStaysDown(dc, cPc), true);
  endStaysDown(pc);
  assert.equal(holdsStaysDown(dc, cPc), false);
});
await t("(e) reactor downed (Nidhogg fallen) → no hold; `defeated` flag counts too", () => {
  const { dc, cPc, nid, cNid } = setup();
  nid.system.props.current_hp = 0;
  assert.equal(holdsStaysDown(dc, cPc), false);
  nid.system.props.current_hp = 100; cNid.defeated = true;
  assert.equal(holdsStaysDown(dc, cPc), false);
});
await t("(f) row passive_mode off / $deleted / disabled AE → no hold; a live AE row → hold", () => {
  for (const extra of [{ reaction_passive_mode: "off" }, { $deleted: true }]) {
    const { dc, cPc } = setup({}, { items: [passive({ 0: row(STAYS_DOWN_TRIGGER, extra) })] });
    assert.equal(holdsStaysDown(dc, cPc), false, JSON.stringify(extra));
  }
  const ae = { id: "x", flags: { [NS]: { reactionConfig: { 0: row(STAYS_DOWN_TRIGGER) } } } };
  const off = setup({}, { items: [], effects: [{ ...ae, disabled: true }] });
  assert.equal(holdsStaysDown(off.dc, off.cPc), false);
  const on = setup({}, { items: [], effects: [ae] });
  assert.equal(holdsStaysDown(on.dc, on.cPc), true);
});
await t("(g) source:ally on the enemy side vs a party subject → no hold; party/hostile absolute", () => {
  const ally = setup({}, { items: [passive({ 0: row(STAYS_DOWN_TRIGGER, { reaction_source: "ally" }) })] });
  assert.equal(holdsStaysDown(ally.dc, ally.cPc), false);
  const party = setup({}, { items: [passive({ 0: row(STAYS_DOWN_TRIGGER, { reaction_source: "party" }) })] });
  assert.equal(holdsStaysDown(party.dc, party.cPc), true);
  const hostile = setup({}, { items: [passive({ 0: row(STAYS_DOWN_TRIGGER, { reaction_source: "hostile" }) })] });
  assert.equal(holdsStaysDown(hostile.dc, hostile.cPc), false);
  assert.equal(sourceCovers("", "enemy", "party"), true);
  assert.equal(sourceCovers("all", "enemy", "party"), true);
  assert.equal(sourceCovers("self", "party", "party"), false);
  assert.equal(sourceCovers("enemy", "party", "party"), false);
  assert.equal(sourceCovers("ally", "party", "party"), true);
});
await t("(h) clearStaysDownSettled re-arms the hold", () => {
  const { dc, cPc, pc } = setup();
  markStaysDownSettled(pc, dc);
  clearStaysDownSettled(pc);
  assert.equal(isStaysDownSettled(pc, dc), false);
  assert.equal(holdsStaysDown(dc, cPc), true);
});
await t("(i) the fallen creature's OWN row never holds it (observers only)", () => {
  const pc = actor("Actor.pc", { hp: 0, items: [passive({ 0: row(STAYS_DOWN_TRIGGER, { reaction_source: "" }) })] });
  const cPc = combatant(pc, "party");
  assert.equal(holdsStaysDown({ combatants: [cPc] }, cPc), false);
});
await t("(j) other triggers / no rows → nothing; rows walk items + AEs", () => {
  const a = actor("Actor.a", { items: [passive({ 0: row("creature_defeated") })] });
  assert.deepEqual(staysDownRowsOf(a), []);
  const b = actor("Actor.b", { items: [noxRow()], effects: [{ id: "y", flags: { [NS]: { reactionConfig: { 0: row(STAYS_DOWN_TRIGGER, { reaction_source: "Party" }) } } } }] });
  assert.deepEqual(staysDownRowsOf(b), [{ source: "enemy" }, { source: "party" }]);
  assert.equal(holdsStaysDown(null, null), false);
});

// ═══ Part 2: registration ════════════════════════════════════════════════════
console.log("registration");
const dt = await import("./director-triggers.js");
await t("director-triggers: native, post-resolve, in ALL_DIRECTOR_TRIGGERS", () => {
  assert.equal(dt.DIRECTOR_NATIVE_TRIGGERS.has(STAYS_DOWN_TRIGGER), true);
  assert.equal(dt.phaseOf(STAYS_DOWN_TRIGGER), "post-resolve");
  assert.equal(dt.POST_RESOLVE_TRIGGERS.has(STAYS_DOWN_TRIGGER), true);
  assert.equal(dt.ALL_DIRECTOR_TRIGGERS.has(STAYS_DOWN_TRIGGER), true);
});
await t("reaction-triggers.config: entry (label, bucket, source filter) + resource family", () => {
  const src = readFileSync(fileURLToPath(new URL("../reaction-system/reaction-triggers.config.js", import.meta.url)), "utf8");
  const win = {};
  let ready = null;
  vm.runInNewContext(src, { window: win, console: { ...console, debug() {} }, Hooks: { once: (h, fn) => { if (h === "ready") ready = fn; }, on() {} } });
  ready();
  const api = win["oni.ReactionTriggers"];
  assert.equal(api.isValidKey(STAYS_DOWN_TRIGGER), true);
  assert.equal(api.bucketFor(STAYS_DOWN_TRIGGER), "resolution_phase");
  assert.deepEqual([...api.filtersFor(STAYS_DOWN_TRIGGER)], ["source"]);
  assert.equal(api.getTrigger(STAYS_DOWN_TRIGGER).label, "When a creature is reduced to 0 HP and not revived");
  assert.equal(api.triggerInFamily(STAYS_DOWN_TRIGGER, "resource"), true);
  assert.deepEqual(api.subjectShapeFor(STAYS_DOWN_TRIGGER), api.subjectShapeFor("creature_defeated"));
});
await t("reaction-hand label + migration option text match the config label", () => {
  const hand = readFileSync(fileURLToPath(new URL("./reaction-hand.js", import.meta.url)), "utf8");
  assert.match(hand, /creature_stays_down: \{ self: "When you stay down", other: "When a creature stays down" \}/);
  const mig = readFileSync(fileURLToPath(new URL("../../data-migrations/2026-11-21-template-options-stays-down.js", import.meta.url)), "utf8");
  assert.match(mig, /\{ key: "creature_stays_down", value: "When a creature is reduced to 0 HP and not revived" \}/);
  const man = JSON.parse(readFileSync(fileURLToPath(new URL("../../data-migrations/_manifest.json", import.meta.url)), "utf8"));
  const all = JSON.stringify(man);
  assert.ok(all.includes('"2026-11-21-template-options-stays-down"'));
});

// ═══ Part 3: defeatReactor (dispatch stubbed) ════════════════════════════════
console.log("defeatReactor");
const stub = globalThis.__staysStub = {
  reactors: [], dispatches: [], wipes: [], onDispatch: null, onWipe: null,
  reset() { this.reactors = []; this.dispatches = []; this.wipes = []; this.onDispatch = null; this.onWipe = null; },
};
const STUBS = {
  "standalone-reactions.js": `export async function collectReactors(d) { return globalThis.__staysStub.reactors.filter((r) => Number(r.actor.system.props.current_hp) > 0); }
    export async function dispatchReactionMenu(a) { globalThis.__staysStub.dispatches.push(a); if (globalThis.__staysStub.onDispatch) await globalThis.__staysStub.onDispatch(a); }`,
  "state-handlers.js": `export function checkSideWipe(d) { globalThis.__staysStub.wipes.push(d); globalThis.__staysStub.onWipe?.(d); return false; }`,
  "skill-effects.js": `export function isBuffOrDebuffAE() { return false; }`,
  "conflict-event-runtime.js": `export async function dispatchConflictEventObjectDestroyed() {}`,
};
registerHooks({
  resolve(spec, ctx, next) {
    const base = spec.split("?")[0].split("/").pop();
    if (STUBS[base] && /^\.\.?\//.test(spec)) {
      return { url: `data:text/javascript,${encodeURIComponent(STUBS[base])}`, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const anyStub = () => new Proxy(class {}, { get: (o, k) => (k in o ? o[k] : anyStub()), construct: () => anyStub(), apply: () => anyStub() });
Object.assign(globalThis, {
  Hooks: { on() {}, once() {}, off() {}, call() {}, callAll() {} },
  game: { user: { isGM: true }, settings: { get() { return false; }, register() {} }, scenes: { contents: [] } },
  foundry: { utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), deepClone: (x) => structuredClone(x) } },
  CONFIG: {}, PIXI: anyStub(), canvas: null, window: globalThis,
  fromUuid: async () => null,
});
const origWarn = console.warn; console.warn = () => {};
const origLog = console.log;
const quiet = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };
const DR = await import("./defeat-reactor.js");

const tok = (a) => ({ id: `T.${a.uuid}`, uuid: `Scene.s.Token.${a.uuid}` });
function battle({ pcOpts = {}, nidOpts = {} } = {}) {
  stub.reset();
  const pc = actor("Actor.pc", { hp: 0, ...pcOpts });
  const nid = actor("Actor.nid", { hp: 100, items: [noxRow()], props: { npc_rank: "champion" }, ...nidOpts });
  const cPc = combatant(pc, "party"), cNid = combatant(nid, "enemy");
  const director = { ctx: {}, dCombat: { combatants: [cPc, cNid], started: true, ended: false } };
  stub.reactors = [{ actor: nid, token: tok(nid) }, { actor: pc, token: tok(pc) }];
  return { pc, nid, cPc, cNid, director };
}
const hpEvent = (a, extra = {}) => ({ payload: { resource: "hp", direction: "loss", subjectActorUuid: a.uuid, isDamage: true, element: "dark", causeActorUuid: "Actor.nid", ...extra }, casterActor: a });
const sd = () => stub.dispatches.filter((d) => d.trigger === STAYS_DOWN_TRIGGER);
const run = (director, cfg, firedKeys = new Set(), batch = []) => quiet(() => DR.defeatReactor(director, cfg, { firedKeys, batch }));

await t("real stay-down → ONE emit, observers only (forced + ask), payload = the fall", async () => {
  const { pc, nid, director } = battle();
  await run(director, hpEvent(pc));
  const got = sd();
  assert.deepEqual(got.map((d) => [d.reactor.uuid, d.phase]), [["Actor.nid", "forced"], ["Actor.nid", "ask"]]);
  const p = got[0].payload;
  assert.equal(p.trigger, STAYS_DOWN_TRIGGER);
  assert.equal(p.subjectActorUuid, pc.uuid);
  assert.equal(p.sourceActorUuid, pc.uuid);
  assert.equal(p.element, "dark");
  assert.equal(p.causeActorUuid, "Actor.nid");
  assert.equal(p.isDamage, true);
  for (const k of ["sourceTokenUuid", "subjectTokenUuid", "summonedBy", "isPhantasm", "cause", "causeTokenUuid", "subjectSnapshot", "damageInstance"]) assert.ok(k in p, k);
  assert.equal(got[0].askPassFollows, true);
  assert.equal(got[0].director, director);
  assert.equal(p.subjectTokenUuid, `Scene.s.Token.${pc.uuid}`);
  // creature_defeated still fires first, and before stays-down
  const first = stub.dispatches.findIndex((d) => d.trigger === "creature_defeated");
  const firstSd = stub.dispatches.findIndex((d) => d.trigger === STAYS_DOWN_TRIGGER);
  assert.ok(first >= 0 && first < firstSd);
  assert.equal(isStaysDownSettled(pc, director.dCombat), true);
  assert.ok(pc._effects.some((e) => e.flags?.[NS]?.bdDefeated), "KO marker landed before the emit");
  void nid;
});
await t("no double emit per fall: same settle (batch) and a later settle at 0 HP", async () => {
  const { pc, director } = battle();
  const keys = new Set();
  await run(director, hpEvent(pc), keys);
  await run(director, hpEvent(pc), keys);           // a second loss event in the same settle
  await run(director, hpEvent(pc));                  // a later settle, still at 0
  assert.equal(sd().length, 2);                      // forced + ask of ONE emit
});
await t("back up (HP event > 0) re-arms: the next fall emits again", async () => {
  const { pc, director } = battle();
  await run(director, hpEvent(pc));
  pc.system.props.current_hp = 12;
  await run(director, hpEvent(pc, { direction: "gain" }));
  assert.equal(isStaysDownSettled(pc, director.dCombat), false);
  pc.system.props.current_hp = 0;
  await run(director, hpEvent(pc));
  assert.equal(sd().length, 4);
});
await t("a NEW battle (new dCombat) is a new fall even if never seen back up", async () => {
  const { pc, director } = battle();
  await run(director, hpEvent(pc));
  director.dCombat = { ...director.dCombat };     // next fight, PC healed off the ledger in between
  await run(director, hpEvent(pc));
  assert.equal(sd().length, 4);
});
await t("guests and battlefield objects never emit", async () => {
  const g = battle({ pcOpts: { flags: { [NS]: { bdGuest: true } } } });
  await run(g.director, hpEvent(g.pc));
  assert.equal(sd().length, 0);
  const o = battle({ pcOpts: { flags: { [NS]: { bdObject: true } } } });
  await run(o.director, hpEvent(o.pc));
  assert.equal(sd().length, 0);
});
await t("the fallen creature's own stays-down row is never dispatched", async () => {
  const { pc, director } = battle({ pcOpts: { items: [passive({ 0: row(STAYS_DOWN_TRIGGER, { reaction_source: "" }) })] } });
  await run(director, hpEvent(pc));
  assert.ok(sd().every((d) => d.reactor.uuid !== pc.uuid));
});
await t("a downed reactor (Nidhogg fallen) is never asked; no hold, wipe re-checked", async () => {
  const { pc, nid, director, cPc } = battle();
  nid.system.props.current_hp = 0;
  await run(director, hpEvent(pc));
  assert.equal(sd().length, 0);
  assert.equal(holdsStaysDown(director.dCombat, cPc), false);
  assert.equal(stub.wipes.length, 1);
});
await t("C2 Auto-Life revive → no stays-down", async () => {
  const autoLife = { id: "al", name: "Auto-Life", flags: { [NS]: { reactionConfig: { 0: row("creature_knocked_out", { reaction_source: "self" }) } } } };
  const { pc, director } = battle({ pcOpts: { effects: [autoLife] } });
  stub.onDispatch = (a) => { if (a.trigger === "creature_knocked_out") pc.system.props.current_hp = 10; };
  await run(director, hpEvent(pc));
  assert.ok(stub.dispatches.some((d) => d.trigger === "creature_knocked_out"));
  assert.equal(sd().length, 0);
  assert.equal(isStaysDownSettled(pc, director.dCombat), false);
});
await t("hold while in flight, released at the end; the wipe re-check sees it released", async () => {
  const { pc, director, cPc } = battle();
  assert.equal(holdsStaysDown(director.dCombat, cPc), true, "the watcher's moment (HP written, reactor not run)");
  const seen = [];
  stub.onDispatch = () => { seen.push(holdsStaysDown(director.dCombat, cPc)); };
  stub.onWipe = () => { seen.push(`wipe:${holdsStaysDown(director.dCombat, cPc)}`); };
  await run(director, hpEvent(pc));
  assert.ok(seen.length > 2 && seen.slice(0, -1).every((v) => v === true), JSON.stringify(seen));
  assert.equal(seen.at(-1), "wipe:false");
  assert.equal(stub.wipes.length, 1);
});
await t("a revive INSIDE the emit (settleRevive) → not settled; it stands", async () => {
  const { pc, director } = battle();
  stub.onDispatch = async (a) => {
    if (a.trigger !== STAYS_DOWN_TRIGGER || a.phase !== "forced") return;
    pc.system.props.current_hp = pc.system.props.max_hp;
    await DR.settleRevive(pc);
  };
  await run(director, hpEvent(pc));
  assert.equal(isStaysDownSettled(pc, director.dCombat), false);
  assert.ok(!pc._effects.some((e) => e.flags?.[NS]?.bdDefeated), "KO marker removed by settleRevive");
});
await t("a throw mid-reactor still releases the in-flight hold and re-checks the wipe", async () => {
  const { pc, director, cPc } = battle({ pcOpts: { effects: [koAE()] } });
  const prev = globalThis.fromUuid;
  globalThis.fromUuid = () => { throw new Error("boom"); };
  await assert.rejects(run(director, hpEvent(pc, { subjectTokenUuid: "Scene.s.Token.x" })));
  globalThis.fromUuid = prev;
  assert.equal(holdsStaysDown(director.dCombat, cPc), false);   // KO marker, not in flight
  assert.equal(stub.wipes.length, 1);
});
await t("sweepDefeat re-checks the wipe when it lands a KO (off-ledger 0 HP)", async () => {
  const { pc, director } = battle();
  await quiet(() => DR.sweepDefeat(director));
  assert.ok(pc._effects.some((e) => e.flags?.[NS]?.bdDefeated));
  assert.equal(stub.wipes.length, 1);
  await quiet(() => DR.sweepDefeat(director));   // nothing new applied → no re-check
  assert.equal(stub.wipes.length, 1);
});
await t("sweepDefeat emits stays-down for an off-ledger PC at 0 (once), not for a Servant / guest / no reactor", async () => {
  const { pc, director } = battle();
  await quiet(() => DR.sweepDefeat(director));
  assert.equal(sd().length, 2, "forced + ask, once");
  assert.equal(isStaysDownSettled(pc, director.dCombat), true);
  await quiet(() => DR.sweepDefeat(director));
  assert.equal(sd().length, 2, "settled: no re-emit");
  // a Servant at 0 (cannot normally happen) does not emit
  const nox = (await import("./nox-servant.js")).noxServantAeData();
  const sv = battle({ pcOpts: { effects: [{ id: "n", ...nox }] } });
  await quiet(() => DR.sweepDefeat(sv.director));
  assert.equal(sd().length, 0, "servant");
  const g = battle({ pcOpts: { flags: { [NS]: { bdGuest: true } } } });
  await quiet(() => DR.sweepDefeat(g.director));
  assert.equal(sd().length, 0, "guest");
  const none = battle({ nidOpts: { items: [] } });
  await quiet(() => DR.sweepDefeat(none.director));
  assert.equal(sd().length, 0, "no stays-down reactor stands");
  const up = battle({ pcOpts: { hp: 5 } });
  await quiet(() => DR.sweepDefeat(up.director));
  assert.equal(sd().length, 0, "PC above 0");
});
await t("sweepDefeat: a PC the stays-down row revives is left up and not marked settled", async () => {
  const { pc, director } = battle();
  stub.onDispatch = async (a) => { if (a.trigger === STAYS_DOWN_TRIGGER) { pc.system.props.current_hp = 1; await DR.settleRevive(pc); } };
  await quiet(() => DR.sweepDefeat(director));
  assert.equal(isStaysDownSettled(pc, director.dCombat), false);
  assert.ok(!pc._effects.some((e) => e.flags?.[NS]?.bdDefeated && !e.disabled));
});
await t("in-flight is a counter: two overlapping falls, one end does not release the hold", () => {
  const { dc, cPc, pc } = setup({ effects: [koAE()] });
  beginStaysDown(pc); beginStaysDown(pc);
  endStaysDown(pc);
  assert.equal(holdsStaysDown(dc, cPc), true);
  endStaysDown(pc);
  assert.equal(holdsStaysDown(dc, cPc), false);
  endStaysDown(pc);   // extra end never goes negative
  beginStaysDown(pc);
  assert.equal(holdsStaysDown(dc, cPc), true);
});
await t("no stays-down reactor in the battle -> NO dispatch at all (ordinary battles pay nothing)", async () => {
  const { pc, director } = battle({ nidOpts: { items: [] } });
  await run(director, hpEvent(pc));
  assert.equal(sd().length, 0);
});
await t("emitStaysDown (B13 entry): fires for a settled fall when called directly; csd dedup per Set", async () => {
  const { pc, director } = battle();
  await run(director, hpEvent(pc));
  stub.dispatches = [];
  const keys = new Set();
  await quiet(() => DR.emitStaysDown(director, pc, { subjectActorUuid: pc.uuid }, keys));
  await quiet(() => DR.emitStaysDown(director, pc, { subjectActorUuid: pc.uuid }, keys));
  assert.equal(sd().length, 2);
  assert.ok(keys.has(`csd:${pc.uuid}`));
});

console.warn = origWarn;
console.log(`\n${n} passed`);
