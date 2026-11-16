// Tests for three small Event System options. No game required.
//
//   Run Check remembers who passed and who failed, for this run of the event,
//   and "Failed / Passed the last check" targets read it (Deal Damage, Apply
//   Status).
//   Show Text keeps its style and text speed; the typewriter's slow pace.
//   Boss Banner: its timing, the card's frames and the face aim.
//
// What this cannot check: anything drawn (the card on screen, the camera glide)
// and anything that crosses a socket between two clients.
//
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (path) => vm.runInThisContext(readFileSync(resolve(HERE, path), "utf8"), { filename: path });

const print = console.log.bind(console);
let fail = 0;
let count = 0;
const check = (name, ok, detail = "") => {
  count += 1;
  print(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};
const realLog = console.log, realWarn = console.warn;
const quiet = async (fn) => { console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = realLog; console.warn = realWarn; } };

// ---------------------------------------------------------------------------
// Stand-ins for Foundry
// ---------------------------------------------------------------------------
globalThis.window = globalThis;
console.debug = () => {};
console.groupCollapsed = () => {};
console.groupEnd = () => {};

const hooks = {};
globalThis.Hooks = {
  on: (name, fn) => { (hooks[name] ??= []).push(fn); },
  once: (name, fn) => { (hooks[name] ??= []).push(fn); },
  callAll: (name, ...args) => { for (const fn of hooks[name] ?? []) fn(...args); }
};

let idCounter = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `id${++idCounter}`,
    deepClone: (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
    mergeObject: (a, b) => ({ ...a, ...b })
  }
};

const member = (id, name, ownerId) => ({ id, name, uuid: `Actor.${id}`, testUserPermission: (user) => user?.id === ownerId });
const members = [member("m1", "Hina", "p1"), member("m2", "Keren", "p2"), member("m3", "Blanche", "p3"), member("m4", "Zarg", "p4")];
const party = { id: "party1", name: "Party", system: { props: { global_switch_table: {}, global_variable_table: {} } }, flags: {}, async update() {} };
members.forEach((m, i) => { party.system.props[`member_id_${i + 1}`] = m.id; });
const worldActors = () => [party, ...members];
globalThis.fromUuid = async (uuid) => worldActors().find(a => `Actor.${a.id}` === uuid) ?? null;

const users = new Map([["gm1", { id: "gm1", isGM: true }], ["p1", { id: "p1", isGM: false }]]);
globalThis.game = {
  user: users.get("gm1"),
  users,
  paused: false,
  actors: {
    get: (id) => worldActors().find(a => a.id === id) ?? null,
    find: (fn) => worldActors().find(fn),
    [Symbol.iterator]: () => worldActors()[Symbol.iterator]()
  },
  socket: { emit: () => {}, on: () => {} },
  settings: { register: () => {}, get: () => false }
};
globalThis.canvas = { ready: true, scene: { id: "scene1", tiles: { get: () => null }, tokens: { get: () => null } }, tokens: { get: () => null, placeables: [] } };

const damaged = [];
globalThis.FUCompanion = {
  api: {
    getCurrentGameDb: async () => ({ db: party }),
    MovementControl: { getCurrentControllerUser: async () => ({ userId: "p1" }) },
    applyDamage: { applyToActor: async (o) => { damaged.push({ name: o.targetActor.name, amount: o.baseDamage, element: o.elementType }); } },
    heldStatus: { applyNow: async ({ actors }) => ({ applied: actors }), statusNames: () => [] }
  }
};

// The dialogue system: the real typewriter's timing, and a stand-in bubble.
load("../dialog-system/dialog-ui.js");
const shown = [];
globalThis.FU.Dialog = { show: async (opts) => { shown.push(opts); return { bubbleId: null }; } };

load("event-logic.js");
load("event-constants.js");
globalThis.oni.EventSystem.ShowText = {
  SpeakerResolver: { resolve: async () => ({ ok: false }) }
};
load("event-showText-execute.js");
for (const file of [
  "event-client.js", "event-gameState.js", "event-eventRegistry.js", "event-flow.js",
  "event-rows-check.js", "event-rows-party-effects.js", "event-rows-banner.js"
]) load(file);

const ES = globalThis.oni.EventSystem;
const { EventRegistry, Flow, Logic } = ES;
Hooks.callAll("ready");

let seq = 0;
async function runEvent(rawRows) {
  const sourceId = `t${++seq}`;
  const rows = EventRegistry.normalizeRows(rawRows);
  Flow.begin(sourceId, "scene1", { flags: {} });
  const runList = (list) => Logic.runRows(list, {
    aborted: () => Flow.isAborted(sourceId),
    isCritical: (row) => EventRegistry.peek(row?.type)?.critical === true,
    execute: (row) => EventRegistry.executeRow(row, { sceneId: "scene1", tileId: sourceId, requesterId: "p1", runRows: runList })
  });
  const out = await runList(rows);
  Flow.end(sourceId);
  Hooks.callAll("oniEventExecuteDone", { sceneId: "scene1", sourceId });
  return out;
}

// ---------------------------------------------------------------------------
// Run Check: the last result
// ---------------------------------------------------------------------------
{
  const R = ES.RowsCheck;
  let nextResults = [];
  let nextGroup = null;
  globalThis.ONI = {
    CheckRequester: { request: async (actors) => actors.map((a, i) => ({ actorUuid: a.uuid, actorName: a.name, ...(nextResults[i] ?? { pass: false }) })) },
    GroupCheck: { request: async () => nextGroup }
  };

  check("Run Check: the target list offers Failed / Passed the last check",
    R.TARGET_KINDS.some(([k, l]) => k === "lastFailed" && l === "Failed the last check")
    && R.TARGET_KINDS.some(([k, l]) => k === "lastPassed" && l === "Passed the last check"));

  const split = R.splitIndividual([
    { actorUuid: "Actor.m1", pass: true }, { actorUuid: "Actor.m2", pass: false },
    { actorUuid: "Actor.m3", pass: true, isFumble: true }, { actorUuid: "Actor.m4", pass: false, isCrit: true }
  ]);
  check("Run Check: each roller is split by their own roll (a fumble fails, a critical passes)",
    split.passed.join() === "Actor.m1,Actor.m4" && split.failed.join() === "Actor.m2,Actor.m3", JSON.stringify(split));

  const group = { leaderResult: { actorUuid: "Actor.m1" }, helperResults: [{ actorUuid: "Actor.m2", pass: true }, { actorUuid: "Actor.m3", pass: false }] };
  check("Run Check: a Group Check passes or fails as one (everyone who took part)",
    R.splitGroup(group, false).failed.join() === "Actor.m1,Actor.m2,Actor.m3" && R.splitGroup(group, false).passed.length === 0
    && R.splitGroup(group, true).passed.length === 3);

  check("Run Check: a row of only last-check targets is recognised; a mixed one is not",
    R.onlyLastCheck({ targets: [{ kind: "lastFailed" }] }) && R.onlyLastCheck({ targets: [{ kind: "lastPassed" }, { kind: "lastFailed" }] })
    && !R.onlyLastCheck({ targets: [{ kind: "lastFailed" }, { kind: "party" }] }) && !R.onlyLastCheck({ targets: [] }));

  const normal = EventRegistry.normalizeRows([{ type: "dealDamage", targets: [{ kind: "lastFailed" }], amount: 30 }])[0];
  check("Deal Damage: a lastFailed target survives the row repair", normal.targets[0].kind === "lastFailed");

  const rollAll = { type: "runCheck", attrA: "DEX", attrB: "INS", dl: 11, targets: [{ kind: "party" }], combine: "all" };
  const hitFailed = { type: "dealDamage", targets: [{ kind: "lastFailed" }], amount: 30, element: "physical" };

  // Everyone rolls DEX+INS DL 11, then 30 physical to those who failed.
  await quiet(async () => {
    damaged.length = 0; nextResults = [{ pass: true }, { pass: false }, { pass: true }, { pass: false, isFumble: true }];
    // (In the real event an animation plays between the two.)
    const out = await runEvent([rollAll, hitFailed]);
    check("Deal Damage on Failed the last check hits only those who failed",
      out.ok && damaged.map(d => d.name).join() === "Keren,Zarg" && damaged.every(d => d.amount === 30 && d.element === "physical"),
      JSON.stringify(damaged));
  });

  await quiet(async () => {
    damaged.length = 0; nextResults = [{ pass: true }, { pass: true }, { pass: true }, { pass: true }];
    const results = [];
    const rows = EventRegistry.normalizeRows([rollAll, hitFailed, { type: "dealDamage", targets: [{ kind: "lastPassed" }], amount: 5 }]);
    const sourceId = `t${++seq}`;
    Flow.begin(sourceId, "scene1", { flags: {} });
    const runList = (list) => Logic.runRows(list, {
      aborted: () => false,
      isCritical: () => false,
      execute: async (row) => { const r = await EventRegistry.executeRow(row, { sceneId: "scene1", tileId: sourceId, requesterId: "p1", runRows: runList }); results.push(r); return r; }
    });
    await runList(rows);
    Flow.end(sourceId);
    check("Deal Damage on Failed the last check with nobody failed: nothing hit, no error",
      results[1]?.ok === true && results[1]?.hit?.length === 0, JSON.stringify(results[1]));
    check("Deal Damage on Passed the last check hits everyone who passed",
      damaged.length === 4 && damaged.every(d => d.amount === 5));
  });

  await quiet(async () => {
    damaged.length = 0;
    const out = await runEvent([hitFailed]);
    check("Failed the last check before any check: nobody, the event carries on", out.ok && damaged.length === 0);
  });

  await quiet(async () => {
    // A second run of the same event starts clean.
    damaged.length = 0; nextResults = [{ pass: false }, { pass: false }, { pass: false }, { pass: false }];
    await runEvent([rollAll]);
    await runEvent([hitFailed]);
    check("The last check is kept per run: the next run of an event does not see it", damaged.length === 0);
  });

  await quiet(async () => {
    // The most recent check wins; a check inside the Failure branch sees the first.
    damaged.length = 0;
    nextResults = [{ pass: false }, { pass: true }, { pass: true }, { pass: true }];
    const first = { ...rollAll, failureRows: [hitFailed] };
    await runEvent([first]);
    check("Inside the Failure branch the check's own result is already there", damaged.map(d => d.name).join() === "Hina");

    damaged.length = 0;
    const second = { type: "runCheck", attrA: "MIG", attrB: "MIG", dl: 10, targets: [{ kind: "lastFailed" }] };
    let call = 0;
    globalThis.ONI.CheckRequester.request = async (actors) => {
      call += 1;
      return actors.map((a, i) => ({ actorUuid: a.uuid, pass: call === 1 ? i < 2 : false }));
    };
    await runEvent([{ ...rollAll, failureRows: [] }, second, hitFailed]);
    check("Failed the last check as a roller: only those roll again, and the newest result counts",
      damaged.map(d => d.name).join() === "Blanche,Zarg", damaged.map(d => d.name).join());

    damaged.length = 0;
    call = 0;
    globalThis.ONI.CheckRequester.request = async (actors) => actors.map((a) => ({ actorUuid: a.uuid, pass: true }));
    const out = await runEvent([{ ...rollAll }, second, hitFailed]);
    check("Failed the last check as a roller with nobody failed: no roll, the event carries on", out.ok && damaged.length === 0);
  });

  await quiet(async () => {
    damaged.length = 0;
    nextGroup = {
      leaderResult: { actorUuid: "Actor.m1", pass: false },
      helperResults: [{ actorUuid: "Actor.m2", pass: true }],
      leaderPass: false
    };
    await runEvent([{ ...rollAll, combine: "group" }, hitFailed]);
    check("After a failed Group Check, Failed the last check is everyone who took part",
      damaged.map(d => d.name).join() === "Hina,Keren", damaged.map(d => d.name).join());
  });
}

// ---------------------------------------------------------------------------
// Show Text: style and speed
// ---------------------------------------------------------------------------
{
  const def = EventRegistry.peek("showText");
  const fresh = EventRegistry.makeDefaultRow("showText");
  check("Show Text: a new row starts Normal style, Normal speed", fresh.bubbleMode === "normal" && fresh.textSpeed === "normal");

  await quiet(async () => {
    shown.length = 0;
    await runEvent([{ type: "showText", text: "You who have trespassed..", bubbleMode: "shout", textSpeed: "slow" }]);
    await runEvent([{ type: "showText", text: "Hello." }]);
  });
  check("Show Text: the style and the slow pace reach the dialogue system",
    shown[0]?.mode === "shout" && shown[0]?.pace === "slow" && shown[1]?.mode === "normal" && !shown[1]?.pace,
    JSON.stringify(shown.map(s => ({ mode: s.mode, pace: s.pace }))));
  check("Show Text: config collects Style and Text speed (so saving keeps them)",
    typeof def.collectFields === "function" && /bubbleMode/.test(String(def.collectFields)) && /textSpeed/.test(String(def.collectFields)));

  const UI = globalThis.FU.DialogUI;
  const normal = UI.linePace("Hello there", { speed: 28 });
  check("Typewriter: without a pace it types as before (characters per second)",
    normal.typeMs === Math.ceil((11 / 28) * 1000) && normal.countAt(0) === 0
    && normal.countAt(1000) === 11 && normal.countAt(200) === Math.floor(200 * 28 / 1000));

  const slow = UI.linePace("Hi. Yo", { pace: "slow" });
  // H 55, i 110, . 165, (stop 190) space 410, Y 465, o 520
  check("Typewriter slow: 55 ms a letter, a 190 ms stop after each full stop",
    slow.typeMs === 520 && slow.countAt(54) === 0 && slow.countAt(55) === 1 && slow.countAt(165) === 3
    && slow.countAt(400) === 3 && slow.countAt(410) === 4 && slow.countAt(520) === 6 && slow.countAt(99999) === 6,
    `typeMs ${slow.typeMs}`);

  const dots = UI.linePace("No..", { pace: "slow" });
  check("Typewriter slow: nothing waits after the last letter (\"..\" ends the line)",
    dots.typeMs === 4 * 55 + 190, `typeMs ${dots.typeMs}`);

  // Skipping mid-line: the bubble shows the whole line at once. The real
  // runLine with a stand-in box: press = complete -> full text.
  globalThis.performance ??= { now: () => Date.now() };
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.document = {
    createElement: (tag) => ({ tag, className: "", textContent: "", children: [], appendChild(c) { this.children.push(c); } }),
    createTextNode: (text) => ({ text })
  };
  const typed = {
    nodes: [],
    replaceChildren() { this.nodes = []; },
    appendChild(n) { this.nodes.push(n); },
    get text() { return this.nodes.map(n => n.text ?? n.textContent ?? "").join(""); }
  };
  const box = { isConnected: true, classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {} };
  const line = UI.runLine({
    box, typed, remote: true, id: "skip1", leave: () => {},
    payload: { text: "You who have <b>trespassed</b> this holy ground without Sacrifice..", pace: "slow", waitForInput: true, controlled: true }
  });
  // A few frames in, then a press arrives (control "complete", as Flow sends it).
  await new Promise(r => setTimeout(r, 140));
  frames.splice(0).forEach(fn => fn());
  const partial = typed.text;
  UI.control("skip1", "complete", { broadcast: false });
  const whole = typed.text;
  await new Promise(r => setTimeout(r, 120));
  frames.splice(0).forEach(fn => fn());
  check("Typewriter: a skip mid-line (slow, before a full stop) shows the whole line and it stays whole",
    partial.length < whole.length && whole === "You who have trespassed this holy ground without Sacrifice.." && typed.text === whole && UI.isDone("skip1"),
    `partial "${partial}"`);
  line.dispose();
  delete globalThis.document;
}

// ---------------------------------------------------------------------------
// Boss Banner
// ---------------------------------------------------------------------------
{
  const B = ES.RowsBanner;
  check("Boss Banner: registered", EventRegistry.has("bossBanner") && EventRegistry.peek("bossBanner").label === "Boss Banner");

  const row = EventRegistry.makeDefaultRow("bossBanner");
  check("Boss Banner: defaults (2.6 s, ×1.45, face 0.64, waits)",
    row.seconds === 2.6 && row.zoomFactor === 1.45 && row.faceFrac === 0.64 && row.wait === true && row.token === "" && row.color === "#e58c6a");

  const fixed = EventRegistry.normalizeRows([{ type: "bossBanner", seconds: "x", zoomFactor: 99, faceFrac: -2, color: "red" }])[0];
  check("Boss Banner: a damaged row is repaired", fixed.seconds === 2.6 && fixed.zoomFactor === 4 && fixed.faceFrac === 0 && fixed.color === "#e58c6a");

  const plain = B.timing({ seconds: 2.6 });
  const cam = B.timing({ seconds: 2.6, token: "Asura" });
  const short = B.timing({ seconds: 1, token: "Asura" });
  check("Boss Banner: without a token it waits for the card only",
    plain.bannerMs === 2600 && plain.waitMs === 2600 && !plain.camera && plain.pushMs === 0);
  check("Boss Banner: with a token it pushes in 2.2 s and waits for the 0.6 s pull-back",
    cam.camera && cam.pushMs === 2200 && cam.returnMs === 600 && cam.waitMs === 3200);
  check("Boss Banner: a short card cuts the push short", short.pushMs === 1000 && short.waitMs === 1600);

  const f0 = B.bannerFrame(0), f10 = B.bannerFrame(0.1), f20 = B.bannerFrame(0.2), f50 = B.bannerFrame(0.5), f90 = B.bannerFrame(0.9), f1 = B.bannerFrame(1);
  check("Boss Banner: slides 140 in over the first fifth, fades out over the last fifth",
    f0.alpha === 0 && f0.slide === 140 && f10.slide > 0 && f10.slide < 140 && f20.slide === 0 && f50.alpha === 1
    && Math.abs(f90.alpha - 0.5) < 1e-9 && f1.alpha === 0, JSON.stringify({ f10, f90 }));

  const aim = B.faceAim({ x: 890, top: 100, height: 260 }, 0.64);
  check("Boss Banner: aims at top + (1 - faceFrac) of the sprite (the face)", aim.x === 890 && Math.abs(aim.y - (100 + 0.36 * 260)) < 1e-9);
  const target = B.pushTarget({ x: 0, y: 0, scale: 0.8 }, aim, 1.45, { x: 40, y: 0 });
  check("Boss Banner: pushes to this client's own zoom × the factor, with the sidebar shift",
    Math.abs(target.scale - 1.16) < 1e-9 && target.x === 930);

  // On the GM the row waits for the card (and skips with nothing to show).
  await quiet(async () => {
    const t0 = Date.now();
    const out = await runEvent([{ type: "bossBanner", name: "Asura", kicker: "SEEKER OF STRENGTH", seconds: 0.5 }]);
    const took = Date.now() - t0;
    check("Boss Banner: Wait holds the event until the card is gone", out.ok && took >= 480, `${took} ms`);
    const t1 = Date.now();
    await runEvent([{ type: "bossBanner", name: "Asura", seconds: 0.5, wait: false }]);
    check("Boss Banner: without Wait the event goes straight on", Date.now() - t1 < 200);
  });
}

print(fail ? `\n${fail} of ${count} failed` : `\nall ${count} passed`);
process.exit(fail ? 1 : 0);
