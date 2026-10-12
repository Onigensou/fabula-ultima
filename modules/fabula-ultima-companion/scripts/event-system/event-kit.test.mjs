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

const users = new Map([
  ["gm1", { id: "gm1", isGM: true }],
  ["p1", { id: "p1", isGM: false }],   // the main controller
  ["p2", { id: "p2", isGM: false }]
]);

globalThis.game = {
  user: users.get("gm1"),
  users,
  actors: { get: (id) => (id === party.id ? party : null) },
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
  "event-rows-flow.js", "event-rows-choices.js"
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

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
