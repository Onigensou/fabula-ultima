// Tests for the Event System's row engine and actions. No game required.
//
// Part 1 checks event-logic.js on its own (plain calculation).
// Part 2 loads the real registry, flow, game state and action files against
// small stand-ins for Foundry (Hooks, game, an actor that takes dotted
// updates), and runs events the way event-executeCore.js does.
//
// What this cannot check: anything drawn (menus, fades, the camera glide on a
// canvas) and anything that crosses a socket between two clients.
//
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => vm.runInThisContext(readFileSync(resolve(HERE, name), "utf8"), { filename: name });

// Kept apart from console.log, which some checks silence while an event runs.
const print = console.log.bind(console);
let fail = 0;
const check = (name, ok, detail = "") => {
  print(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};
// A second name for it, for the block where "check" builds a Run Check row.
const verify = check;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stand-ins for Foundry
// ---------------------------------------------------------------------------
globalThis.window = globalThis;
console.debug = () => {};
const realLog = console.log;

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

// An actor that takes Foundry-style updates: dotted paths, and "-=key" to delete.
function makeActor(id, data) {
  const actor = {
    id,
    name: "Test Party",
    ...data,
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const parts = path.split(".");
        let node = actor;
        for (const part of parts.slice(0, -1)) node = (node[part] ??= {});
        const last = parts.at(-1);
        if (last.startsWith("-=")) delete node[last.slice(2)];
        else node[last] = value;
      }
      Hooks.callAll("updateActor", actor, {});
    }
  };
  return actor;
}

const party = makeActor("party1", {
  system: {
    props: {
      global_switch_table: {},
      global_variable_table: {
        0: { $deleted: false, global_variable_name: "Festival Score", global_variable_value: "25" }
      }
    }
  },
  flags: {}
});

// Four party members, each owned by one player; the Current Game sheet, which
// remembers the last main controller's character; and one actor outside the party.
const member = (id, name, ownerId) => ({
  id, name, uuid: `Actor.${id}`,
  testUserPermission: (user) => user?.id === ownerId
});
const members = [member("m1", "Hina", "p1"), member("m2", "Keren", "p2"), member("m3", "Blanche", "p3"), member("m4", "Zarg", "p4")];
members.forEach((m, i) => { party.system.props[`member_id_${i + 1}`] = m.id; });
const currentGame = { id: "cg", name: "Current Game", flags: { "fabula-ultima-companion": { movementControlState: { controllerActorUuid: "Actor.m3" } } } };
const outsider = member("x1", "Otto", "nobody");
const worldActors = () => [party, currentGame, ...members, outsider];
globalThis.fromUuid = async (uuid) => worldActors().find(a => `Actor.${a.id}` === uuid) ?? null;

const users = new Map([
  ["gm1", { id: "gm1", isGM: true }],
  ["p1", { id: "p1", isGM: false }],   // the main controller
  ["p2", { id: "p2", isGM: false }]
]);

globalThis.game = {
  user: users.get("gm1"),
  users,
  actors: {
    get: (id) => worldActors().find(a => a.id === id) ?? null,
    find: (fn) => worldActors().find(fn),
    [Symbol.iterator]: () => worldActors()[Symbol.iterator]()
  },
  socket: { emit: () => {}, on: () => {} },
  settings: { register: () => {}, get: () => false }
};

globalThis.canvas = {
  ready: true,
  scene: { id: "scene1", tiles: { get: () => null }, tokens: { get: () => null } }
};

globalThis.FUCompanion = {
  api: {
    getCurrentGameDb: async () => ({ db: party }),
    MovementControl: { getCurrentControllerUser: async () => ({ userId: "p1" }) }
  }
};

// ---------------------------------------------------------------------------
// Part 1 — event-logic.js
// ---------------------------------------------------------------------------
load("event-logic.js");
const Logic = globalThis.oni.EventSystem.Logic;

check("nameKey: spacing, case and underscores are one name",
  Logic.nameKey("Festival Score") === Logic.nameKey("festival_score ") && Logic.nameKey("a") !== Logic.nameKey("b"));

{
  const defs = {
    showText: { defaultData: { speaker: "Self", text: "" } },
    branch: {
      defaultData: { thenRows: [] },
      prepare: (row) => { if (!Array.isArray(row.thenRows)) row.thenRows = []; },
      childLists: (row) => [{ label: "Then", rows: row.thenRows }]
    }
  };
  const getDef = (type) => defs[type] ?? null;

  const rows = Logic.normalizeRows([
    { type: "showText", text: "hi" },
    { id: "keep", type: "fromAnotherScript", anything: { a: 1 } },
    { type: "branch", thenRows: [{ text: "inner" }] },
    { text: "no type at all" }
  ], getDef);

  check("normalizeRows: defaults filled, given fields kept", rows[0].speaker === "Self" && rows[0].text === "hi" && !!rows[0].id);
  check("normalizeRows: an unregistered type is kept as written, not turned into Show Text",
    rows[1].type === "fromAnotherScript" && rows[1].anything.a === 1 && rows[1].id === "keep" && !("speaker" in rows[1]));
  check("normalizeRows: child lists are normalized too",
    rows[2].thenRows[0].type === "showText" && rows[2].thenRows[0].speaker === "Self");
  check("normalizeRows: a row with no type is Show Text", rows[3].type === "showText");
  check("normalizeRows: a JSON string is accepted", Logic.normalizeRows('[{"type":"showText"}]', getDef).length === 1);
  check("normalizeRows: garbage gives an empty list", Logic.normalizeRows("{nope", getDef).length === 0);

  let visited = 0;
  Logic.walkRows(rows, getDef, () => { visited += 1; });
  check("walkRows: visits children", visited === 5, `visited ${visited}`);
}

{
  const ran = [];
  const env = (over = {}) => ({
    execute: async (row) => { ran.push(row.id); return row.result ?? { ok: true }; },
    isCritical: (row) => row.critical === true,
    aborted: () => false,
    ...over
  });

  ran.length = 0;
  let out = await Logic.runRows([{ id: "a" }, { id: "b", result: { ok: false } }, { id: "c" }], env());
  check("runRows: a failed ordinary row is passed over", out.ok && ran.join("") === "abc");

  ran.length = 0;
  out = await Logic.runRows([{ id: "a" }, { id: "b", critical: true, result: { ok: false } }, { id: "c" }], env());
  check("runRows: a failed critical row ends the event", !out.ok && out.rowIndex === 1 && ran.join("") === "ab");

  ran.length = 0;
  out = await Logic.runRows([{ id: "a", result: { ok: true, stop: true } }, { id: "b" }], env());
  check("runRows: stop ends the list", out.ok && out.stop && ran.join("") === "a");

  ran.length = 0;
  out = await Logic.runRows([{ id: "a" }, { id: "b" }], env({ aborted: () => ran.length >= 1 }));
  check("runRows: an ended event runs nothing further", out.aborted === true && ran.join("") === "a");

  ran.length = 0;
  out = await Logic.runRows([{ id: "a" }, { id: "b" }], env({ execute: async (row) => { ran.push(row.id); throw new Error("boom"); } }));
  check("runRows: a throwing row is passed over like a failed one", out.ok && ran.join("") === "ab");
}

{
  const reader = {
    switch: (name) => Logic.nameKey(name) === "bossdown",
    variable: (name) => (Logic.nameKey(name) === "score" ? 10 : 0),
    self: (slot) => slot === "B",
    runs: () => 2,
    erased: () => false
  };
  const K = Logic.CONDITION_KINDS;

  check("condition: none is always true", Logic.evalCondition(null, reader) && Logic.evalCondition({ kind: "nonsense" }, reader));
  check("condition: switch on / off",
    Logic.evalCondition({ kind: K.SWITCH, name: "Boss Down", want: "on" }, reader)
    && !Logic.evalCondition({ kind: K.SWITCH, name: "Boss Down", want: "off" }, reader)
    && Logic.evalCondition({ kind: K.SWITCH, name: "other", want: "off" }, reader));
  check("condition: variable compares as numbers",
    Logic.evalCondition({ kind: K.VARIABLE, name: "score", op: ">=", value: "10" }, reader)
    && !Logic.evalCondition({ kind: K.VARIABLE, name: "score", op: "<", value: 10 }, reader)
    && Logic.evalCondition({ kind: K.VARIABLE, name: "unset", op: "=", value: 0 }, reader));
  check("condition: this event's switch",
    Logic.evalCondition({ kind: K.SELF, slot: "B", want: "on" }, reader)
    && Logic.evalCondition({ kind: K.SELF, slot: "A", want: "off" }, reader));
  check("condition: has run",
    Logic.evalCondition({ kind: K.HAS_RUN, want: "yes" }, reader) && !Logic.evalCondition({ kind: K.HAS_RUN, want: "no" }, reader));

  check("eventAvailable: once only hides an event that has run",
    !Logic.eventAvailable({ onceOnly: true }, reader) && Logic.eventAvailable({ onceOnly: true }, { ...reader, runs: () => 0 }));
  check("eventAvailable: erased hides it", !Logic.eventAvailable({}, { ...reader, erased: () => true }));
  check("eventAvailable: no settings means available", Logic.eventAvailable({}, reader) && Logic.eventAvailable(null, reader));
  check("eventAvailable: the condition is applied",
    !Logic.eventAvailable({ availableWhen: { kind: K.SWITCH, name: "other", want: "on" } }, reader));

  const getDef = (type) => (type === "condition" ? { childLists: (row) => [{ rows: row.thenRows }] } : {});
  check("usesRunMemory: only when something reads the run count",
    !Logic.usesRunMemory([{ type: "showText" }], {}, getDef)
    && Logic.usesRunMemory([], { onceOnly: true }, getDef)
    && Logic.usesRunMemory([], { availableWhen: { kind: K.HAS_RUN } }, getDef)
    && Logic.usesRunMemory([{ type: "condition", thenRows: [{ type: "condition", condition: { kind: K.HAS_RUN }, thenRows: [] }] }], {}, getDef));
}

check("substituteVars: prints a variable, 0 when unset",
  Logic.substituteVars("Score {var:Festival Score}, lost {VAR:nope}.", (n) => (Logic.nameKey(n) === "festivalscore" ? "25" : undefined)) === "Score 25, lost 0.");

{
  const table = {
    0: { $deleted: false, n: "Boss Down", v: "on" },
    1: { $deleted: true, n: "ghost", v: "on" },
    4: { $deleted: false, n: "other", v: "off" }
  };
  check("table: finds a row by loose name", Logic.findTableKey(table, "n", "boss_down") === "0");
  check("table: a removed row is not found", Logic.findTableKey(table, "n", "ghost") === null);
  check("table: next key is past every key, removed ones included", Logic.nextTableKey(table) === "5" && Logic.nextTableKey({}) === "0");
  check("table: names of live rows", Logic.tableNames(table, "n").join(",") === "Boss Down,other");
  check("isOn", Logic.isOn("on") && Logic.isOn("ON") && Logic.isOn(true) && !Logic.isOn("off") && !Logic.isOn(undefined));
}

{
  const from = { x: 0, y: 100, scale: 1 }, to = { x: 200, y: -100, scale: 2 };
  const start = Logic.glideAt(from, to, 1000, 1000, 1000);
  const mid = Logic.glideAt(from, to, 1000, 1000, 1500);
  const end = Logic.glideAt(from, to, 1000, 1000, 9999);
  check("glide: starts at from, ends at to", start.x === 0 && !start.done && end.x === 200 && end.y === -100 && end.scale === 2 && end.done);
  check("glide: halfway in time is halfway there (symmetric ease)", Math.abs(mid.x - 100) < 1e-9 && Math.abs(mid.scale - 1.5) < 1e-9);
  check("glide: eases in (a quarter of the time is less than a quarter of the way)", Logic.glideAt(from, to, 0, 1000, 250).x < 50);
  check("glide: no duration lands at once", Logic.glideAt(from, to, 0, 0, 0).done && Logic.glideAt(from, to, 0, 0, 0).x === 200);
}

// ---------------------------------------------------------------------------
// Part 2 — the real registry, flow, game state and actions
// ---------------------------------------------------------------------------
load("event-constants.js");

// Show Text needs the dialogue system; a stand-in records what it was asked to say.
const said = [];
globalThis.oni.EventSystem.ShowText = {
  Execute: { installed: true, execute: async (row) => { said.push(row.text); return row.text === "FAIL" ? { ok: false } : { ok: true }; } }
};

for (const file of [
  "event-client.js", "event-gameState.js", "event-eventRegistry.js", "event-flow.js",
  "event-rows-flow.js", "event-rows-choices.js", "event-rows-check.js", "event-rows-float.js"
]) load(file);

const ES = globalThis.oni.EventSystem;
const { Constants: C, EventRegistry, Flow, GameState, Client } = ES;

Hooks.callAll("ready");
await GameState.refresh();

check("registry: the built-in actions are all registered",
  ["showText", "setMovement", "wait", "condition", "endEvent", "eraseEvent", "setSwitch", "setVariable", "showChoices"]
    .every(t => EventRegistry.has(t)));
check("registry: registering makes a type known to the constants (no second list to edit)",
  C.isKnownEventType("showChoices") && C.EVENT_TYPE_LABELS.showChoices === "Show Choices");
check("registry: a new action did not replace Show Text",
  EventRegistry.peek("showText").label === "Show Text" && EventRegistry.peek("wait").label === "Wait");
check("registry: an unknown type is not Show Text", !EventRegistry.has("nope") && EventRegistry.has(""));

// Run an event the way event-executeCore.js does.
let eventSeq = 0;
async function runEvent(rawRows, { sourceId = `tile${++eventSeq}`, during = null } = {}) {
  const rows = EventRegistry.normalizeRows(rawRows);
  Flow.begin(sourceId, "scene1", { flags: {} });

  const runList = (list) => Logic.runRows(list, {
    aborted: () => Flow.isAborted(sourceId),
    isCritical: (row) => EventRegistry.peek(row?.type)?.critical === true,
    execute: (row) => EventRegistry.executeRow(row, { sceneId: "scene1", tileId: sourceId, runRows: runList })
  });

  const running = runList(rows);
  if (during) await during(sourceId);
  const outcome = await running;
  Flow.end(sourceId);
  Hooks.callAll("oniEventExecuteDone", { sceneId: "scene1", sourceId });
  return outcome;
}

const text = (t) => ({ type: "showText", text: t });
const quiet = async (fn) => { console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = realLog; console.warn = realLog; } };

// --- Switches, variables, conditions ---------------------------------------
await quiet(async () => {
  said.length = 0;
  await runEvent([
    { type: "condition", condition: { kind: "switch", name: "Boss Down", want: "on" }, thenRows: [text("after")], elseRows: [text("before")] },
    { type: "setSwitch", scope: "story", name: "boss_down", value: "on" },
    { type: "condition", condition: { kind: "switch", name: "BOSS DOWN", want: "on" }, thenRows: [text("after")], elseRows: [text("before")] }
  ]);
});
check("condition + Set Switch: Else before the switch, Then after", said.join(",") === "before,after", said.join(","));
check("Set Switch: a new switch is added to the party sheet as a table row",
  party.system.props.global_switch_table[0]?.global_switch_name === "boss_down"
  && party.system.props.global_switch_table[0]?.global_switch_boolean === "on"
  && party.system.props.global_switch_table[0]?.$deleted === false);

await quiet(() => runEvent([{ type: "setSwitch", scope: "story", name: "Boss Down", value: "toggle" }]));
check("Set Switch: toggle updates the same row, whatever the spelling",
  Object.keys(party.system.props.global_switch_table).length === 1
  && party.system.props.global_switch_table[0].global_switch_boolean === "off" && !GameState.getSwitch("boss down"));

await quiet(() => runEvent([
  { type: "setVariable", name: "festival_score", op: "add", value: 5 },
  { type: "setVariable", name: "New Counter", op: "sub", value: 3 }
]));
check("Set Variable: adds to the existing row found by loose name",
  GameState.getVariable("Festival Score") === 30 && Object.keys(party.system.props.global_variable_table).length === 2);
check("Set Variable: a new variable starts from 0", GameState.getVariable("new counter") === -3);

await quiet(() => runEvent([{ type: "setVariable", name: "dice", op: "random", value: 3, max: 3 }]));
check("Set Variable: random stays in range", GameState.getVariable("dice") === 3);

// --- End Event, failures -----------------------------------------------------
await quiet(async () => {
  said.length = 0;
  const out = await runEvent([
    text("one"),
    { type: "condition", condition: { kind: "variable", name: "festival score", op: ">", value: 10 }, thenRows: [text("two"), { type: "endEvent" }, text("never")], elseRows: [] },
    text("never")
  ]);
  check("End Event inside a branch ends the whole event", out.ok && out.stop === true && said.join(",") === "one,two", said.join(","));
});

await quiet(async () => {
  said.length = 0;
  const out = await runEvent([{ type: "fromAnotherScript" }, { type: "setSwitch", scope: "story", name: "" }, text("still here")]);
  check("an unknown action and a failed action are passed over", out.ok && said.join(",") === "still here");

  said.length = 0;
  const bad = await runEvent([text("FAIL"), text("never")]);
  check("a failed line of text still ends the event", !bad.ok && said.join(",") === "FAIL");
});

// --- This event's own memory ------------------------------------------------
await quiet(async () => {
  await runEvent([{ type: "setSwitch", scope: "self", slot: "C", value: "on" }], { sourceId: "chest" });
  await GameState.markRun("scene1", "chest");
});
{
  const reader = GameState.readerFor("scene1", "chest");
  check("event memory: own switch and run count are per event",
    reader.self("C") === true && reader.self("A") === false && reader.runs() === 1
    && GameState.readerFor("scene1", "otherTile").runs() === 0
    && GameState.readerFor("scene2", "chest").runs() === 0);
  check("once only: available before, not after", !Logic.eventAvailable({ onceOnly: true }, reader)
    && Logic.eventAvailable({ onceOnly: true }, GameState.readerFor("scene1", "otherTile")));

  await quiet(() => runEvent([{ type: "eraseEvent" }], { sourceId: "pickup" }));
  check("Erase Event: the event is no longer available", !Logic.eventAvailable({}, GameState.readerFor("scene1", "pickup")));

  await GameState.resetEvent("scene1", "pickup");
  check("reset memory: it is available again", Logic.eventAvailable({}, GameState.readerFor("scene1", "pickup")));
}

// --- Snapshot / restore (the pre-push clean-up) ------------------------------
{
  const snap = GameState.snapshot();
  await quiet(async () => {
    await GameState.setSwitch("made in a play-test", true);
    await GameState.setVariable("Festival Score", "set", 9999);
    await GameState.markRun("scene9", "tile9");
  });
  const changed = GameState.getSwitch("made in a play-test") && GameState.getVariable("festival score") === 9999;
  await GameState.restore(snap);
  check("snapshot / restore: play-test progress is gone, earlier progress is back",
    changed && !GameState.switchNames().includes("made in a play-test")
    && GameState.getVariable("festival score") === 30
    && GameState.getMemory("scene9", "tile9").runs === 0
    && GameState.getMemory("scene1", "chest").runs === 1);
}

// --- Wait and ending early ---------------------------------------------------
{
  const startedAt = Date.now();
  await quiet(() => runEvent([{ type: "wait", seconds: 0.15 }]));
  check("Wait: waits", Date.now() - startedAt >= 140, `${Date.now() - startedAt} ms`);

  said.length = 0;
  const t0 = Date.now();
  const out = await quiet(() => runEvent([{ type: "wait", seconds: 30 }, text("never")], {
    during: async (id) => { await sleep(30); Flow.abort(id); }
  }));
  check("ending an event cuts a Wait short and runs nothing after it",
    out.aborted === true && Date.now() - t0 < 2000 && said.length === 0);
}

// --- Choices -----------------------------------------------------------------
const choice = (extra = {}) => ({
  type: "showChoices",
  prompt: "Open the chest? ({var:Festival Score})",
  options: [
    { label: "Yes", rows: [text("opened")] },
    { label: "No", cancel: true, rows: [text("left it")] }
  ],
  ...extra
});

// What the GM tells every client, captured from the one channel they all use.
const sent = [];
for (const kind of ["choice.open", "choice.highlight", "choice.roleplay", "choice.close"]) {
  Client.register(kind, (data, info) => { sent.push({ kind, data, sourceId: info.sourceId }); });
}
// A request from another client, as the GM running the event receives it.
const ask = (userId, data) => Flow.state.requestHandlers.get("choice")(data, userId);

// A fresh menu takes no answer for a moment (see pickGuardMs). Checked once
// here, then switched off so the other checks need not wait it out.
ES.RowsChoices.settings.pickGuardMs = 150;
await quiet(async () => {
  said.length = 0;
  await runEvent([choice()], {
    during: async (sourceId) => {
      await sleep(10);
      await ask("p1", { sourceId, op: "pick", index: 0 });
      await ask("p1", { sourceId, op: "cancel" });
      await sleep(20);
      check("choices: a press in the first moment after the menu opens picks nothing", said.length === 0);
      await ask("p1", { sourceId, op: "move", index: 1 });
      await sleep(180);
      await ask("p1", { sourceId, op: "pick", index: 1 });
    }
  });
  check("choices: after that moment the pick is taken", said.join(",") === "left it", said.join(","));
});
ES.RowsChoices.settings.pickGuardMs = 0;

await quiet(async () => {
  said.length = 0; sent.length = 0;
  const out = await runEvent([choice(), text("after")], {
    during: async (sourceId) => {
      await sleep(10);
      const open = sent.find(m => m.kind === "choice.open");
      check("choices: the menu opens with the question, the answers and the roleplay answer",
        open?.data.menu.options.length === 2 && open.data.menu.roleplay === true
        && open.data.menu.prompt === "Open the chest? (30)", JSON.stringify(open?.data.menu.prompt));

      await ask("p2", { sourceId, op: "pick", index: 0 });
      await sleep(10);
      check("choices: a player who is not the main controller cannot choose", said.length === 0);

      await ask("p1", { sourceId, op: "move", index: 1 });
      check("choices: the controller's highlight is told to everyone", sent.some(m => m.kind === "choice.highlight" && m.data.index === 1));

      await ask("p1", { sourceId, op: "pick", index: 0 });
    }
  });
  check("choices: the picked answer's events run, then the event carries on", out.ok && said.join(",") === "opened,after", said.join(","));
  check("choices: the menu is closed for everyone", sent.some(m => m.kind === "choice.close" && m.data.index === 0));
});

await quiet(async () => {
  said.length = 0;
  await runEvent([choice()], { during: async (sourceId) => { await sleep(10); await ask("p1", { sourceId, op: "cancel" }); } });
  check("choices: Cancel takes the answer marked for it", said.join(",") === "left it", said.join(","));

  said.length = 0;
  await runEvent([choice({ options: [{ label: "A", rows: [text("a")] }, { label: "B", rows: [text("b")] }] }), text("after")], {
    during: async (sourceId) => {
      await sleep(10);
      await ask("p1", { sourceId, op: "cancel" });
      await sleep(10);
      check("choices: Cancel does nothing when no answer is marked for it", said.length === 0);
      await ask("p1", { sourceId, op: "pick", index: 1 });
    }
  });
  check("choices: second answer runs its own events", said.join(",") === "b,after", said.join(","));
});

await quiet(async () => {
  said.length = 0; sent.length = 0;
  let optionId = null;
  await runEvent([choice(), text("after")], {
    during: async (sourceId) => {
      await sleep(10);
      optionId = sent.find(m => m.kind === "choice.open").data.menu.options[1].id;

      await ask("p1", { sourceId, op: "pick", index: 2 });   // the roleplay answer
      check("roleplay: picking it tells everyone, and picks no branch",
        sent.some(m => m.kind === "choice.roleplay") && said.length === 0);

      await ask("p1", { sourceId, op: "pick", index: 0 });
      await ask("p1", { sourceId, op: "resolve", how: "option", optionId });
      await sleep(10);
      check("roleplay: players can no longer pick, and cannot resolve", said.length === 0);

      await ask("gm1", { sourceId, op: "resolve", how: "option", optionId });
    }
  });
  check("roleplay: the GM resolves it as a written answer", said.join(",") === "left it,after", said.join(","));
});

await quiet(async () => {
  said.length = 0;
  const out = await runEvent([choice(), text("after")], {
    during: async (sourceId) => {
      await sleep(10);
      await ask("p1", { sourceId, op: "pick", index: 2 });
      await ask("gm1", { sourceId, op: "resolve", how: "none" });
    }
  });
  check("roleplay: the GM can resolve it with no branch, and the event carries on", out.ok && said.join(",") === "after", said.join(","));

  said.length = 0;
  const direct = await runEvent([choice(), text("after")], {
    during: async (sourceId) => {
      await sleep(10);
      const id = sent.filter(m => m.kind === "choice.open").at(-1).data.menu.options[0].id;
      await ask("gm1", { sourceId, op: "resolve", how: "option", optionId: id });
    }
  });
  check("choices: the GM can take an answer directly, with no roleplay first", direct.ok && said.join(",") === "opened,after", said.join(","));

  said.length = 0; sent.length = 0;
  const ended = await runEvent([choice(), text("never")], {
    during: async (sourceId) => { await sleep(10); await ask("p1", { sourceId, op: "pick", index: 2 }); Flow.abort(sourceId); }
  });
  check("roleplay: ending the event closes the menu and runs nothing more",
    ended.aborted === true && said.length === 0 && sent.some(m => m.kind === "choice.close"));
});

{
  const row = EventRegistry.normalizeRows([{ type: "showChoices", options: [{ label: "only" }, { cancel: true }, { cancel: true }, {}, {}, {}] }])[0];
  check("choices: at most four answers, each with an id and its own list",
    row.options.length === 4 && row.options.every(o => o.id && Array.isArray(o.rows)));
  check("choices: only one answer stands for Cancel", row.options.filter(o => o.cancel).length === 1);
  check("choices: fewer than two answers are padded to two",
    EventRegistry.normalizeRows([{ type: "showChoices", options: [] }])[0].options.length === 2);
  check("choices: a new row has two answers and the roleplay answer on",
    EventRegistry.makeDefaultRow("showChoices").options.length === 2 && EventRegistry.makeDefaultRow("showChoices").roleplay === true);
}

// --- Run Check ---------------------------------------------------------------
// The Check Requester is replaced by a stand-in that records who was asked to
// roll and answers with the results the test sets up.
{
  const asked = [];
  let nextResults = [];
  let nextGroup = null;
  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.CheckRequester = {
    request: async (actors, opts) => {
      asked.push({ kind: "check", names: actors.map(a => a.name), opts });
      return actors.map((a, i) => ({ actorUuid: a.uuid, actorName: a.name, ...(nextResults[i] ?? { pass: false }) }));
    }
  };
  globalThis.ONI.GroupCheck = {
    request: async (opts) => { asked.push({ kind: "group", uuids: opts.allActorUuids, opts }); return nextGroup; }
  };

  const check = (extra = {}) => ({
    type: "runCheck", label: "Force the door", attrA: "MIG", attrB: "MIG", dl: 12,
    successRows: [text("success")], failureRows: [text("failure")],
    ...extra
  });
  const PASS = { pass: true }, FAIL = { pass: false };
  const CRIT = { pass: true, isCrit: true }, FUMBLE = { pass: false, isFumble: true };

  // Like runEvent, with the user who pressed the prompt.
  const runAs = async (requesterId, rows, opts = {}) => {
    const sourceId = `check${++eventSeq}`;
    const normalized = EventRegistry.normalizeRows(rows);
    Flow.begin(sourceId, "scene1", { flags: {} });
    const runList = (list) => Logic.runRows(list, {
      aborted: () => Flow.isAborted(sourceId),
      isCritical: (row) => EventRegistry.peek(row?.type)?.critical === true,
      execute: (row) => EventRegistry.executeRow(row, { sceneId: "scene1", tileId: sourceId, requesterId, runRows: runList })
    });
    const running = runList(normalized);
    if (opts.during) await opts.during(sourceId);
    const out = await running;
    Flow.end(sourceId);
    Hooks.callAll("oniEventExecuteDone", { sceneId: "scene1", sourceId });
    return out;
  };

  await quiet(async () => {
    // Who rolls.
    asked.length = 0; said.length = 0; nextResults = [PASS];
    await runAs("p2", [check()]);
    verify("Run Check: by default the roller is the character of the player who interacted", asked[0]?.names.join() === "Keren", asked[0]?.names.join());
    verify("Run Check: the check asked for is the one written",
      asked[0].opts.attrA === "MIG" && asked[0].opts.dl === 12 && asked[0].opts.label === "Force the door" && asked[0].opts.hiddenDl === true);
    verify("Run Check: a pass runs Success", said.join() === "success");

    asked.length = 0; said.length = 0; nextResults = [FAIL];
    await runAs("gm1", [check()]);
    verify("Run Check: when the GM interacted, the main controller's character rolls (p1 holds the controller)", asked[0]?.names.join() === "Hina", asked[0]?.names.join());
    verify("Run Check: a fail runs Failure", said.join() === "failure");

    asked.length = 0; nextResults = [PASS, PASS, PASS, PASS];
    await runAs("p1", [check({ targets: [{ kind: "party" }, { kind: "controller" }, { kind: "member", slot: 2 }] })]);
    verify("Run Check: whole party, and a character named twice rolls once", asked[0]?.names.join() === "Hina,Keren,Blanche,Zarg", asked[0]?.names.join());

    asked.length = 0; nextResults = [PASS, PASS];
    await runAs("p1", [check({ targets: [{ kind: "member", slot: 4 }, { kind: "name", name: "otto" }, { kind: "name", name: "nobody at all" }] })]);
    verify("Run Check: a slot and a character by name; a name that matches nobody is left out", asked[0]?.names.join() === "Zarg,Otto", asked[0]?.names.join());

    // Several rollers.
    said.length = 0; nextResults = [PASS, FAIL];
    await runAs("p1", [check({ targets: [{ kind: "member", slot: 1 }, { kind: "member", slot: 2 }], combine: "all" })]);
    said.push("|"); nextResults = [PASS, FAIL];
    await runAs("p1", [check({ targets: [{ kind: "member", slot: 1 }, { kind: "member", slot: 2 }], combine: "any" })]);
    verify("Run Check: 'everyone must succeed' fails on one failure, 'one is enough' passes", said.join("") === "failure|success", said.join(""));

    asked.length = 0; said.length = 0;
    nextGroup = { leaderPass: true, leaderResult: PASS, helperResults: [PASS, FAIL], bonus: 1 };
    await runAs("p1", [check({ targets: [{ kind: "party" }], combine: "group", storeVar: "door_successes" })]);
    verify("Run Check: a Group Check goes to the group orchestrator with every roller, and its leader decides",
      asked[0]?.kind === "group" && asked[0].uuids.length === 4 && asked[0].opts.leaderDl === 12 && said.join() === "success");
    verify("Run Check: the number of successes is stored (1 helper + the leader)", GameState.getVariable("door_successes") === 2);

    asked.length = 0; said.length = 0; nextGroup = null;
    const closed = await runAs("p1", [check({ targets: [{ kind: "party" }], combine: "group" }), text("after")]);
    verify("Run Check: a Group Check closed without a roll runs neither list, and the event carries on", closed.ok && said.join() === "after", said.join());

    asked.length = 0; nextResults = [PASS];
    await runAs("p1", [check({ targets: [{ kind: "member", slot: 3 }], combine: "group" })]);
    verify("Run Check: a Group Check with one roller is an ordinary check", asked[0]?.kind === "check");

    // Critical and fumble.
    const special = { useSpecial: true, critRows: [text("crit")], fumbleRows: [text("fumble")] };
    said.length = 0;
    nextResults = [CRIT]; await runAs("p1", [check(special)]);
    nextResults = [FUMBLE]; await runAs("p1", [check(special)]);
    nextResults = [CRIT]; await runAs("p1", [check()]);
    nextResults = [FUMBLE]; await runAs("p1", [check()]);
    nextResults = [CRIT]; await runAs("p1", [check({ useSpecial: true })]);
    verify("Run Check: critical and fumble have their own lists only when turned on and filled in",
      said.join() === "crit,fumble,success,failure,success", said.join());

    said.length = 0; nextResults = [{ pass: false, isCrit: true }];
    await runAs("p1", [check()]);
    verify("Run Check: a critical succeeds even under the difficulty", said.join() === "success");

    // Nobody to roll, and the table picking.
    said.length = 0; asked.length = 0;
    const none = await runAs("p1", [check({ targets: [{ kind: "name", name: "nobody at all" }] }), text("after")]);
    verify("Run Check: with nobody to roll it is passed over and the event carries on", none.ok && asked.length === 0 && said.join() === "after");

    said.length = 0; asked.length = 0; sent.length = 0; nextResults = [PASS];
    await runAs("p1", [check({ targets: [{ kind: "pick" }] })], {
      during: async (sourceId) => {
        await sleep(10);
        const open = sent.find(m => m.kind === "choice.open");
        verify("Run Check: 'the table picks one' opens a menu of the party, with no roleplay answer",
          open?.data.menu.options.map(o => o.label).join() === "Hina,Keren,Blanche,Zarg" && open.data.menu.roleplay === false
          && open.data.menu.prompt === "Force the door: who attempts it?");
        await ask("p1", { sourceId, op: "pick", index: 2 });
      }
    });
    verify("Run Check: the picked character rolls", asked[0]?.names.join() === "Blanche" && said.join() === "success", asked[0]?.names.join());
  });

  const R = ES.RowsCheck;
  verify("Run Check: reading results — a crit among successes is a crit, a fumble among failures is a fumble",
    R.readIndividual([PASS, CRIT], "all").special === "crit" && R.readIndividual([FAIL, FUMBLE], "all").special === "fumble"
    && R.readIndividual([PASS, FUMBLE], "any").special === null && R.readIndividual([PASS, FUMBLE], "any").success === true
    && R.readIndividual([], "all").success === false);

  const row = EventRegistry.normalizeRows([{ type: "runCheck", attrA: "nonsense", targets: [{ kind: "nonsense" }], dl: "x" }])[0];
  verify("Run Check: a damaged row is repaired to a usable default",
    row.attrA === "DEX" && row.dl === 10 && row.targets.length === 1 && row.targets[0].kind === "controller"
    && [row.successRows, row.failureRows, row.critRows, row.fumbleRows].every(Array.isArray));
}

// --- Floating Text -----------------------------------------------------------
// The dialogue system is replaced by a stand-in that records each line shown
// and each time the floating text is cleared.
{
  const log = [];
  let floating = 0;
  globalThis.FU = {
    Dialog: {
      showFloating: async (opts) => {
        log.push({ show: opts.text, opts });
        floating += 1;
        return { bubbleId: `float${log.length}`, finished: Promise.resolve() };
      }
    },
    DialogUI: {
      renderFloat: () => {},
      isFloating: () => floating > 0,
      clearFloating: () => { log.push({ clear: true }); floating = 0; },
      FLOAT_FADE_OUT_MS: 1,
      control: () => {}, isShowing: () => false, isDone: () => true
    }
  };

  const float = (t, extra = {}) => ({ type: "floatingText", text: t, ...extra });
  const trace = () => log.map(e => (e.clear ? "CLEAR" : e.show)).join(" > ");

  // runEvent, passing each row the type of the row after it, as the executor does.
  const runFloat = async (rows, { sourceDoc = null, locked = true } = {}) => {
    const sourceId = `float${++eventSeq}`;
    const normalized = EventRegistry.normalizeRows(rows);
    Flow.begin(sourceId, "scene1", { flags: { "oni-event-system": { lockMovement: locked } } });
    const runList = (list) => Logic.runRows(list, {
      aborted: () => Flow.isAborted(sourceId),
      isCritical: (row) => EventRegistry.peek(row?.type)?.critical === true,
      execute: (row, index, total, next) => EventRegistry.executeRow(row, {
        sceneId: "scene1", tileId: sourceId, sourceDoc, nextRowType: next?.type ?? null, runRows: runList
      })
    });
    const out = await runList(normalized);
    Flow.end(sourceId);
    return out;
  };

  await quiet(async () => {
    log.length = 0; said.length = 0;
    await runFloat([float("one"), float("two"), text("spoken"), float("three")]);
    verify("Floating Text: lines that follow one another stay; the passage is cleared once, when another kind of row comes next",
      trace() === "one > two > CLEAR > three > CLEAR" && said.join() === "spoken", trace());

    log.length = 0;
    await runFloat([float("a"), { type: "condition", condition: { kind: "none" }, thenRows: [float("b"), float("c")], elseRows: [] }]);
    verify("Floating Text: a passage inside a branch is cleared at the end of that branch", trace() === "a > CLEAR > b > c > CLEAR", trace());

    log.length = 0;
    await runFloat([float("Score {var:Festival Score}", { startFresh: true })]);
    verify("Floating Text: variables are printed, and 'start fresh' is passed on",
      log[0].show === "Score 30" && log[0].opts.startFresh === true, log[0].show);

    log.length = 0;
    await runFloat([float("   ")]);
    verify("Floating Text: an empty line shows nothing", !log.some(e => e.show));

    // Waiting for a press, or not.
    log.length = 0;
    await runFloat([float("locked")], { locked: true });
    await runFloat([float("free")], { locked: false });
    await runFloat([float("timed", { autoSeconds: 2.5 })], { locked: true });
    const [locked, free, timed] = log.filter(e => e.show).map(e => e.opts);
    verify("Floating Text: in a locked event a line waits for a press; in a free one it does not",
      locked.waitForInput === true && free.waitForInput === false && locked.controlled === true);
    verify("Floating Text: 'advance by itself' holds for that long and does not wait for a press",
      timed.waitForInput === false && timed.holdMs === 2500 && locked.holdMs === null);

    // Where it goes.
    log.length = 0;
    await runFloat([float("auto"), float("bottom", { place: "bc", nudgeX: 40, nudgeY: -20 }), float("here", { place: "source" })],
      { sourceDoc: { documentName: "Tile", id: "tileX" } });
    const [auto, bottom, here] = log.filter(e => e.show).map(e => e.opts);
    verify("Floating Text: Auto is the upper centre of the screen, with no nudge", auto.anchor === "tc" && auto.nudge === null && !auto.target);
    verify("Floating Text: a screen place and its nudge are passed on", bottom.anchor === "bc" && bottom.nudge.x === 40 && bottom.nudge.y === -20);
    verify("Floating Text: 'beside this event' attaches the line to the event's own tile", here.target?.kind === "tile" && here.target.id === "tileX");
  });

  const row = EventRegistry.normalizeRows([{ type: "floatingText", place: "nonsense", autoSeconds: 999, nudgeX: "x" }])[0];
  verify("Floating Text: a damaged row is repaired to a usable default", row.place === "auto" && row.autoSeconds === 60 && row.nudgeX === 0 && row.text === "");

  // The executor hands each row the one that follows it.
  const seen = [];
  await Logic.runRows([{ id: 1 }, { id: 2 }], { execute: async (r, i, total, next) => { seen.push(next?.id ?? null); return { ok: true }; } });
  verify("runRows: each row is told which row comes next", seen.join() === "2,");
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
