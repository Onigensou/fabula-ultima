// oni:checkResolved — payload shape + once-per-check (no game needed).
//   node modules/fabula-ultima-companion/scripts/check-requester/cr-check-resolved.test.mjs
// Loads the real cr-api.js in a vm with minimal Foundry/DOM stubs and drives it the way play does:
//   A. a PLAYER client: MSG_OPEN -> MSG_UPDATE per slot (sets each panel's verdict) -> MSG_CLOSE
//   B. the GM: request() interactive -> MSG_CONFIRM per slot -> (reactions) -> MSG_CLOSE + close
//   C. a superseded session (a new MSG_OPEN replaces an unresolved one) reports NOTHING (no verdicts on its close)
//   D. hidden-DL reveal tail
// Fix pass 2026-11-23 (gate blockers; red on the pre-fix cr-api.js, green after):
//   E. SILENT check (sim mode / save_mode "silent"): fires once, authoritative, = the returned results, and
//      broadcasts MSG_RESOLVED so another client fires the same verdicts once
//   F. an OBSERVER that scored the plain CR_ROLL itself reports the GM's verdicts from MSG_CLOSE / MSG_REVEAL,
//      also for a slot it never scored (null st.result)
//   G. supersede: the GM's replaced overlay still reports its check's results; an observer's stale MSG_CLOSE
//      carrying verdicts reports that session once
// Red without the hook (no oni:checkResolved call), green with it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
// CR_API_SRC=<file> runs the same checks against another copy (the red run: the pre-hook cr-api.js).
const SRC = readFileSync(process.env.CR_API_SRC || resolve(HERE, "cr-api.js"), "utf8");
let fails = 0;
const ok = (cond, msg) => { if (cond) console.log("  ok   " + msg); else { fails++; console.log("  FAIL " + msg); } };

function el() {
  const e = {
    className: "", id: "", textContent: "", style: {}, dataset: {}, children: [], _html: "",
    appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  Object.defineProperty(e, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  return e;
}

function boot({ isGM, owner = true, dice = [] }) {
  const hooks = { once: {}, on: {} }, calls = [], emitted = [];
  let socketHandler = null;
  const actors = new Map();
  const mkActor = (id, name) => ({ documentName: "Actor", id, uuid: "Actor." + id, name, img: "", system: { props: {} }, getActiveTokens: () => [{ document: { uuid: "Scene.S.Token.T" + id } }], isOwner: owner, testUserPermission: () => owner });
  for (const [id, n] of [["hina", "Hina"], ["keren", "Keren"]]) actors.set(id, mkActor(id, n));
  const Hooks = {
    once(n, f) { (hooks.once[n] ||= []).push(f); }, on(n, f) { (hooks.on[n] ||= []).push(f); return 1; }, off() {},
    callAll(n, d) { calls.push({ n, d }); for (const f of hooks.on[n] || []) f(d); return true; },
  };
  const game = {
    user: { isGM, id: "u1" }, users: [], actors: { get: (id) => actors.get(id) ?? null, find: (f) => [...actors.values()].find(f) ?? null, [Symbol.iterator]: () => actors.values() },
    socket: { on(ch, f) { if (!socketHandler) socketHandler = f; }, emit(ch, m) { emitted.push(m); } },
    settings: { get: () => null },
  };
  const document = { body: el(), head: el(), createElement: () => el(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const sandbox = {
    console: { log() {}, debug() {}, info() {}, warn: (...a) => console.warn("    [cr warn]", ...a), error: (...a) => console.warn("    [cr error]", ...a) },
    Hooks, game, document, setTimeout, clearTimeout, Promise, Map, Set, Math, JSON, Number, String, Array, Object,
    foundry: { utils: { randomID: () => "SES" + Math.random().toString(36).slice(2, 8) } },
    fromUuid: async (u) => actors.get(String(u).replace(/^Actor\./, "")) ?? null,
    fromUuidSync: (u) => actors.get(String(u).replace(/^Actor\./, "")) ?? null,
    // dice: a queue of faces for ONI.Dice.roll (silent mode); empty = 1s
    Roll: class { constructor(f) { this.f = f; } async evaluate() { const v = dice.length ? dice.shift() : 1; this.total = v; this.dice = [{ results: [{ result: v }] }]; return this; } },
    ChatMessage: { create: async () => ({}) }, CONST: {}, CSS: { escape: (s) => String(s) }, canvas: { tokens: { placeables: [] } },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "cr-api.js" });
  for (const f of hooks.once.ready || []) f();
  return { sandbox, calls, emitted, send: (m) => socketHandler(m), resolved: () => calls.filter((c) => c.n === "oni:checkResolved") };
}

const panels = [
  { slotId: "Actor.hina#0", actorUuid: "Actor.hina", actorName: "Hina", tokenImg: "", attrA: "MIG", attrB: "WLP", singleDie: false, dieA: 8, dieB: 8, checkBuffMods: [] },
  { slotId: "Scene.S.Token.Tk.Actor.keren#1", actorUuid: "Scene.S.Token.Tk.Actor.keren", actorName: "Keren", tokenImg: "", attrA: "MIG", attrB: "WLP", singleDie: false, dieA: 8, dieB: 8, checkBuffMods: [] },
];
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── A. player client ──
console.log("A. player client: open -> verdicts -> MSG_CLOSE");
{
  const c = boot({ isGM: false });
  await c.send({ type: "CR_OPEN", payload: { sessionId: "S1", panels, dl: 16, tileLabel: "Requiem of Soul" }, opts: { hiddenDl: false } });
  await c.send({ type: "CR_UPDATE", payload: { sessionId: "S1", slot: panels[0].slotId, rollA: 3, rollB: 4, modifierParts: [] } });     // 7 < 16: fail
  await c.send({ type: "CR_UPDATE", payload: { sessionId: "S1", slot: panels[1].slotId, rollA: 8, rollB: 8, modifierParts: [{ label: "x", value: 2 }] } });   // 18: pass
  ok(c.resolved().length === 0, "nothing reported before the check closes");
  await c.send({ type: "CR_CLOSE", payload: { sessionId: "S1" } });
  const r = c.resolved();
  ok(r.length === 1, "oni:checkResolved fired once at MSG_CLOSE (got " + r.length + ")");
  const d = r[0]?.d ?? {};
  ok(d.label === "Requiem of Soul" && d.dl === 16 && d.sessionId === "S1", "label / dl / sessionId carried");
  ok(d.authoritative === false, "a player client reports its own panels (authoritative:false)");
  ok(Array.isArray(d.results) && d.results.length === 2, "one result per slot");
  const h = d.results?.[0] ?? {}, k = d.results?.[1] ?? {};
  ok(h.actorUuid === "Actor.hina" && h.pass === false && h.total === 7, "Hina: actorUuid, pass:false, total 7");
  ok(h.tokenUuid === "Scene.S.Token.Thina", "linked actor's tokenUuid from its active token");
  ok(k.pass === true && k.total === 18 && k.tokenUuid === "Scene.S.Token.Tk", "Keren (synthetic actor): pass, total 18, tokenUuid from the uuid");
  ok(["slotId", "actorUuid", "tokenUuid", "actorName", "pass", "total", "isCrit", "isFumble"].every((key) => key in h), "result keys");
  await c.send({ type: "CR_CLOSE", payload: { sessionId: "S1" } });
  ok(c.resolved().length === 1, "a repeated MSG_CLOSE does not report again");
}

// ── B. GM ──
console.log("B. GM: request() -> confirms -> close");
{
  const c = boot({ isGM: true });
  const p = c.sandbox.ONI.CheckRequester.request(["Actor.hina", "Actor.keren"], { attrA: "MIG", attrB: "WLP", dl: 16, label: "Requiem of Soul", hiddenDl: false, postChat: false, allowInvokes: false });
  for (let i = 0; i < 20 && !c.emitted.some((m) => m.type === "CR_OPEN"); i++) await tick();
  const open = c.emitted.find((m) => m.type === "CR_OPEN");
  ok(!!open, "GM broadcast MSG_OPEN");
  const sid = open?.payload?.sessionId, slots = (open?.payload?.panels ?? []).map((x) => x.slotId);
  await c.send({ type: "CR_CONFIRM", payload: { sessionId: sid, slotId: slots[0], actorUuid: "Actor.hina", actorName: "Hina", total: 9, pass: false, isCrit: false, isFumble: false } });
  ok(c.resolved().length === 0, "nothing reported while a roller is still pending");
  await c.send({ type: "CR_CONFIRM", payload: { sessionId: sid, slotId: slots[1], actorUuid: "Actor.keren", actorName: "Keren", total: 20, pass: true, isCrit: true, isFumble: false } });
  const out = await p;
  ok(Array.isArray(out) && out.length === 2, "request() still returns its results (unchanged)");
  const r = c.resolved();
  ok(r.length === 1, "oni:checkResolved fired once on the GM (got " + r.length + ")");
  const d = r[0]?.d ?? {};
  ok(d.authoritative === true, "GM reports the confirm payloads (authoritative:true)");
  ok(d.results?.[0]?.pass === false && d.results?.[0]?.total === 9 && d.results?.[1]?.pass === true && d.results?.[1]?.isCrit === true, "GM verdicts = the confirms");
  const iClose = c.emitted.findIndex((m) => m.type === "CR_CLOSE");
  ok(iClose >= 0, "MSG_CLOSE still sent");
}

// ── C. superseded session ──
console.log("C. a new check replacing an unresolved one");
{
  const c = boot({ isGM: false });
  await c.send({ type: "CR_OPEN", payload: { sessionId: "S1", panels, dl: 10, tileLabel: "First" }, opts: {} });
  await c.send({ type: "CR_OPEN", payload: { sessionId: "S2", panels, dl: 10, tileLabel: "Second" }, opts: {} });
  ok(c.resolved().length === 0, "the replaced session S1 reports nothing");
  await c.send({ type: "CR_CLOSE", payload: { sessionId: "S1" } });
  ok(c.resolved().length === 0, "a stale MSG_CLOSE for S1 reports nothing");
  await c.send({ type: "CR_CLOSE", payload: { sessionId: "S2" } });
  ok(c.resolved().length === 1 && c.resolved()[0].d.label === "Second", "S2 reports once, its own label");
  ok(!!c.resolved()[0]?.d?.results?.every((x) => x.pass === false && x.total === null), "slots with no verdict report pass:false, total:null");
}

// ── D. hidden-DL reveal: the player's overlay closes at its reveal tail, before the GM's MSG_CLOSE ──
console.log("D. hidden DL: reveal tail closes first, the late MSG_CLOSE adds nothing");
{
  const c = boot({ isGM: false });
  await c.send({ type: "CR_OPEN", payload: { sessionId: "S3", panels, dl: 16, tileLabel: "Requiem of Soul" }, opts: { hiddenDl: true, revealTimeout: 10, skipGroupOutcomeSound: true } });
  await c.send({ type: "CR_UPDATE", payload: { sessionId: "S3", slot: panels[0].slotId, rollA: 8, rollB: 8, modifierParts: [] } });
  await c.send({ type: "CR_REVEAL", payload: { sessionId: "S3", outcomeKey: null } });
  ok(c.resolved().length === 0, "not reported while the verdicts are still revealing");
  await new Promise((r) => setTimeout(r, 1200));
  ok(c.resolved().length === 1, "reported once at the reveal tail (the dim lifts here)");
  ok(c.resolved()[0]?.d?.results?.[0]?.pass === true && c.resolved()[0]?.d?.results?.[0]?.total === 16, "Hina 16 vs DL 16 = pass");
  await c.send({ type: "CR_CLOSE", payload: { sessionId: "S3" } });
  ok(c.resolved().length === 1, "the GM's later MSG_CLOSE does not report again");
}

// ── E. silent check ──
console.log("E. silent check: fires once with the computed results, and broadcasts them");
{
  const c = boot({ isGM: true, dice: [3, 4, 8, 8] });   // Hina 3+4 = 7 (fail vs 16), Keren 8+8 = 16 (pass, crit)
  const out = await c.sandbox.ONI.CheckRequester.request(["Actor.hina", "Actor.keren"], { mode: "silent", attrA: "MIG", attrB: "WLP", dl: 16, label: "Requiem of Soul", postChat: false });
  ok(Array.isArray(out) && out.length === 2 && out[0].total === 7 && out[1].total === 16, "request() returns its results unchanged (7, 16)");
  ok(Array.isArray(out) && out.every((r) => !("slotId" in r) && !("sessionId" in r)), "returned result shape unchanged (no slotId / sessionId added)");
  const r = c.resolved();
  ok(r.length === 1, "oni:checkResolved fired once for the silent check (got " + r.length + ")");
  const d = r[0]?.d ?? {};
  ok(d.label === "Requiem of Soul" && d.dl === 16 && !!d.sessionId, "label / dl / a sessionId");
  ok(d.authoritative === true, "silent results are authoritative");
  ok(d.results?.length === 2 && d.results[0].pass === false && d.results[0].total === 7 && d.results[1].pass === true && d.results[1].total === 16 && d.results[1].isCrit === true, "verdicts = the computed results");
  ok(d.results?.[0]?.actorUuid === "Actor.hina" && d.results?.[0]?.tokenUuid === "Scene.S.Token.Thina" && d.results?.[0]?.slotId === "Actor.hina#0", "actorUuid / tokenUuid / slotId per result");
  const bc = c.emitted.filter((m) => m.type === "CR_RESOLVED");
  ok(bc.length === 1 && bc[0].payload?.sessionId === d.sessionId && bc[0].payload?.verdicts?.length === 2, "MSG_RESOLVED broadcast once with the verdicts");
  ok(!c.emitted.some((m) => m.type === "CR_OPEN"), "no overlay opened");
  // another client (a player running the show) hears the broadcast
  const o = boot({ isGM: false, owner: false });
  await o.send(bc[0] ?? { type: "CR_RESOLVED", payload: {} });
  const ro = o.resolved();
  ok(ro.length === 1 && ro[0].d.sessionId === d.sessionId && ro[0].d.authoritative === true, "the other client fires once, same session, authoritative");
  ok(ro[0]?.d?.results?.[0]?.pass === false && ro[0]?.d?.results?.[1]?.pass === true && ro[0]?.d?.results?.[1]?.tokenUuid === "Scene.S.Token.Tkeren", "the other client reports the same verdicts");
  await o.send(bc[0] ?? { type: "CR_RESOLVED", payload: {} });
  ok(o.resolved().length === 1, "a repeated MSG_RESOLVED does not report again");
}

// ── F. observer reports the GM's verdicts ──
console.log("F. observer: its own plain-roll score is overridden by the GM's verdicts");
{
  const gmV = [
    { slotId: panels[0].slotId, actorUuid: "Actor.hina", actorName: "Hina", pass: true, total: 17, isCrit: false, isFumble: false },   // GM: 7 + 10 (a modifier the observer did not load)
    { slotId: panels[1].slotId, actorUuid: panels[1].actorUuid, actorName: "Keren", pass: false, total: 9, isCrit: false, isFumble: false },
  ];
  const c = boot({ isGM: false, owner: false });
  await c.send({ type: "CR_OPEN", payload: { sessionId: "S4", panels, dl: 16, tileLabel: "Requiem of Soul" }, opts: { hiddenDl: false, allowInvokes: false } });
  await c.send({ type: "CR_ROLL", payload: { sessionId: "S4", slot: panels[0].slotId, die: "BOTH", rollA: 3, rollB: 4 } });   // scored locally: 7, fail
  // Keren: never scored on this client (null st.result)
  await c.send({ type: "CR_CLOSE", payload: { sessionId: "S4", verdicts: gmV, label: "Requiem of Soul", dl: 16 } });
  const r = c.resolved();
  ok(r.length === 1, "fired once at MSG_CLOSE");
  const d = r[0]?.d ?? {};
  ok(d.authoritative === true, "authoritative: the GM's verdicts");
  ok(d.results?.[0]?.pass === true && d.results?.[0]?.total === 17, "Hina reports the GM's pass 17, not the local 7 fail");
  ok(d.results?.[1]?.pass === false && d.results?.[1]?.total === 9, "Keren (no local result) reports the GM's 9");
  // hidden DL: verdicts ride MSG_REVEAL; the reveal tail reports them
  const h = boot({ isGM: false, owner: false });
  await h.send({ type: "CR_OPEN", payload: { sessionId: "S5", panels, dl: 16, tileLabel: "Requiem of Soul" }, opts: { hiddenDl: true, revealTimeout: 10, skipGroupOutcomeSound: true, allowInvokes: false } });
  await h.send({ type: "CR_ROLL", payload: { sessionId: "S5", slot: panels[0].slotId, die: "BOTH", rollA: 3, rollB: 4 } });
  await h.send({ type: "CR_REVEAL", payload: { sessionId: "S5", outcomeKey: "fail", verdicts: gmV } });
  await new Promise((res) => setTimeout(res, 1200));
  const rh = h.resolved();
  ok(rh.length === 1 && rh[0].d.authoritative === true && rh[0].d.results?.[0]?.pass === true && rh[0].d.results?.[0]?.total === 17, "hidden DL: the reveal tail reports the GM's verdicts from MSG_REVEAL");
  await h.send({ type: "CR_CLOSE", payload: { sessionId: "S5", verdicts: gmV, label: "Requiem of Soul", dl: 16 } });
  ok(h.resolved().length === 1, "the later MSG_CLOSE does not report again");
}

// ── G. supersede ──
console.log("G. supersede: the replaced check still reports its own results");
{
  const c = boot({ isGM: true });
  const pA = c.sandbox.ONI.CheckRequester.request(["Actor.hina"], { attrA: "MIG", attrB: "WLP", dl: 12, label: "First", hiddenDl: false, postChat: false, allowInvokes: false });
  for (let i = 0; i < 20 && !c.emitted.some((m) => m.type === "CR_OPEN"); i++) await tick();
  const openA = c.emitted.find((m) => m.type === "CR_OPEN");
  const pB = c.sandbox.ONI.CheckRequester.request(["Actor.keren"], { attrA: "MIG", attrB: "WLP", dl: 12, label: "Second", hiddenDl: false, postChat: false, allowInvokes: false });
  for (let i = 0; i < 20 && c.emitted.filter((m) => m.type === "CR_OPEN").length < 2; i++) await tick();
  const openB = c.emitted.filter((m) => m.type === "CR_OPEN")[1];
  ok(!!openA && !!openB, "two checks opened (the second replaced the first overlay)");
  ok(c.resolved().length === 0, "the replacement itself reports nothing");
  await c.send({ type: "CR_CONFIRM", payload: { sessionId: openA?.payload?.sessionId, slotId: openA?.payload?.panels?.[0]?.slotId, actorUuid: "Actor.hina", actorName: "Hina", total: 14, pass: true, isCrit: false, isFumble: false } });
  await pA;
  const r = c.resolved();
  ok(r.length === 1 && r[0].d.label === "First" && r[0].d.sessionId === openA?.payload?.sessionId, "GM: the replaced check reports once, its own label + session");
  ok(r[0]?.d?.authoritative === true && r[0]?.d?.results?.[0]?.pass === true && r[0]?.d?.results?.[0]?.total === 14 && r[0]?.d?.results?.[0]?.tokenUuid === "Scene.S.Token.Thina", "GM: with its confirm results");
  const closeA = c.emitted.find((m) => m.type === "CR_CLOSE" && m.payload?.sessionId === openA?.payload?.sessionId);
  ok(closeA?.payload?.verdicts?.[0]?.pass === true && closeA?.payload?.label === "First" && closeA?.payload?.dl === 12, "MSG_CLOSE carries verdicts + label + dl");
  await c.send({ type: "CR_CONFIRM", payload: { sessionId: openB?.payload?.sessionId, slotId: openB?.payload?.panels?.[0]?.slotId, actorUuid: "Actor.keren", actorName: "Keren", total: 5, pass: false, isCrit: false, isFumble: false } });
  await pB;
  ok(c.resolved().length === 2 && c.resolved()[1]?.d?.label === "Second", "the second check then reports its own, once");
  // observer: its S6 overlay was replaced by S7; S6's MSG_CLOSE (with verdicts) still reports S6 once
  const o = boot({ isGM: false, owner: false });
  await o.send({ type: "CR_OPEN", payload: { sessionId: "S6", panels, dl: 10, tileLabel: "First" }, opts: {} });
  await o.send({ type: "CR_OPEN", payload: { sessionId: "S7", panels, dl: 10, tileLabel: "Second" }, opts: {} });
  const v6 = [{ slotId: panels[0].slotId, actorUuid: "Actor.hina", actorName: "Hina", pass: true, total: 12, isCrit: false, isFumble: false }];
  await o.send({ type: "CR_CLOSE", payload: { sessionId: "S6", verdicts: v6, label: "First", dl: 10 } });
  ok(o.resolved().length === 1 && o.resolved()[0].d.sessionId === "S6" && o.resolved()[0].d.label === "First" && o.resolved()[0].d.results?.[0]?.pass === true, "observer: stale MSG_CLOSE with verdicts reports S6 once");
  await o.send({ type: "CR_CLOSE", payload: { sessionId: "S6", verdicts: v6, label: "First", dl: 10 } });
  ok(o.resolved().length === 1, "observer: not twice");
  ok(o.resolved().every((x) => x.d.sessionId !== "S7"), "observer: S7 (still open) not reported");
}

console.log(fails ? "\nFAILED: " + fails : "\nALL PASS");
process.exit(fails ? 1 : 0);
