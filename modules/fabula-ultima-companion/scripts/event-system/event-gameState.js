/**
 * [ONI] Event System — Game State (switches, variables, event memory)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-gameState.js
 *
 * What this does:
 * - Reads and writes the progress an event can test and change. All of it
 *   lives on the CURRENT PARTY's database actor, so each party keeps its own
 *   and the save system already carries it:
 *     switches    system.props.global_switch_table    (Name, State on/off)
 *     variables   system.props.global_variable_table  (Name, Value)
 *     memory      flags.fabula-ultima-companion.eventState.<scene>.<event>
 *                 { runs, erased, self: { A, B, C, D } }
 *   The two tables are the ones on the database sheet: a GM can read and fix
 *   them by hand. The memory is per event ("this chest was opened"), far too
 *   many entries for a sheet table, so it sits in a flag.
 * - Names are matched loosely: "Festival Score" and "festival_score" are one.
 * - Reading works on every client. Only a GM writes.
 * - Fires the hook "oniGameStateChanged" when any of it changes, so event
 *   prompts appear and disappear with it (a switch flipped, a save loaded).
 *
 * Exposes API to:
 *   window.oni.EventSystem.GameState   (also window.oni.GameState)
 *
 * Requires:
 * - event-constants.js, event-logic.js
 * - scripts/db-resolver.js (FUCompanion.api.getCurrentGameDb)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][GameState]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.GameState?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const Logic = window.oni.EventSystem.Logic;
  if (!C || !Logic) {
    console.error(INSTALL_TAG, "Missing Constants or Logic. Check load order.");
    return;
  }

  const MODULE_ID = C.MODULE_ID || "fabula-ultima-companion";

  const SWITCH_TABLE = "global_switch_table";
  const SWITCH_NAME = "global_switch_name";
  const SWITCH_STATE = "global_switch_boolean";

  const VARIABLE_TABLE = "global_variable_table";
  const VARIABLE_NAME = "global_variable_name";
  const VARIABLE_VALUE = "global_variable_value";

  const MEMORY_FLAG = "eventState";

  const store = {
    partyActorId: null,
    changeTimer: null
  };

  // ------------------------------------------------------------
  // The current party's database actor
  // ------------------------------------------------------------
  async function refresh() {
    try {
      const cache = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
      const next = cache?.db?.id ?? null;
      if (next !== store.partyActorId) {
        store.partyActorId = next;
        announceChange();
      }
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not resolve the current party actor.", e);
    }
    return partyActor();
  }

  function partyActor() {
    return store.partyActorId ? (game.actors?.get(store.partyActorId) ?? null) : null;
  }

  function table(name) {
    return partyActor()?.system?.props?.[name] ?? {};
  }

  function memoryRoot() {
    return partyActor()?.flags?.[MODULE_ID]?.[MEMORY_FLAG] ?? {};
  }

  // ------------------------------------------------------------
  // Reading (every client)
  // ------------------------------------------------------------
  function getSwitch(name) {
    const tbl = table(SWITCH_TABLE);
    const key = Logic.findTableKey(tbl, SWITCH_NAME, name);
    return key === null ? false : Logic.isOn(tbl[key]?.[SWITCH_STATE]);
  }

  function getVariable(name) {
    const tbl = table(VARIABLE_TABLE);
    const key = Logic.findTableKey(tbl, VARIABLE_NAME, name);
    return key === null ? 0 : Logic.toNumber(tbl[key]?.[VARIABLE_VALUE], 0);
  }

  function switchNames() {
    return Logic.tableNames(table(SWITCH_TABLE), SWITCH_NAME);
  }

  function variableNames() {
    return Logic.tableNames(table(VARIABLE_TABLE), VARIABLE_NAME);
  }

  function getMemory(sceneId, sourceId) {
    const entry = memoryRoot()?.[String(sceneId || "")]?.[String(sourceId || "")] ?? {};
    return {
      runs: Logic.toNumber(entry.runs, 0),
      erased: entry.erased === true,
      self: { ...(entry.self ?? {}) }
    };
  }

  // What a condition reads, for one event.
  function readerFor(sceneId, sourceId) {
    return {
      switch: (name) => getSwitch(name),
      variable: (name) => getVariable(name),
      self: (slot) => getMemory(sceneId, sourceId).self?.[slot] === true,
      runs: () => getMemory(sceneId, sourceId).runs,
      erased: () => getMemory(sceneId, sourceId).erased
    };
  }

  // ------------------------------------------------------------
  // Writing (GM)
  // ------------------------------------------------------------
  async function writableActor() {
    if (!game.user?.isGM) return null;
    return (await refresh()) ?? null;
  }

  // value: true | false | "toggle". Returns the new state, or null.
  async function setSwitch(name, value) {
    const label = String(name ?? "").trim();
    const actor = await writableActor();
    if (!actor || !label) return null;

    const tbl = table(SWITCH_TABLE);
    const key = Logic.findTableKey(tbl, SWITCH_NAME, label);
    const current = key === null ? false : Logic.isOn(tbl[key]?.[SWITCH_STATE]);
    const next = value === "toggle" ? !current : !!value;
    const stored = next ? "on" : "off";

    if (key === null) {
      await actor.update({
        [`system.props.${SWITCH_TABLE}.${Logic.nextTableKey(tbl)}`]: {
          $deleted: false,
          [SWITCH_NAME]: label,
          [SWITCH_STATE]: stored
        }
      });
    } else if (current !== next) {
      await actor.update({ [`system.props.${SWITCH_TABLE}.${key}.${SWITCH_STATE}`]: stored });
    }

    return next;
  }

  // op: "set" | "add" | "sub". Returns the new value, or null.
  async function setVariable(name, op, value) {
    const label = String(name ?? "").trim();
    const actor = await writableActor();
    if (!actor || !label) return null;

    const tbl = table(VARIABLE_TABLE);
    const key = Logic.findTableKey(tbl, VARIABLE_NAME, label);
    const current = key === null ? 0 : Logic.toNumber(tbl[key]?.[VARIABLE_VALUE], 0);
    const amount = Logic.toNumber(value, 0);

    let next = amount;
    if (op === "add") next = current + amount;
    else if (op === "sub") next = current - amount;

    // The sheet keeps a number field's value as text.
    if (key === null) {
      await actor.update({
        [`system.props.${VARIABLE_TABLE}.${Logic.nextTableKey(tbl)}`]: {
          $deleted: false,
          [VARIABLE_NAME]: label,
          [VARIABLE_VALUE]: String(next)
        }
      });
    } else if (current !== next) {
      await actor.update({ [`system.props.${VARIABLE_TABLE}.${key}.${VARIABLE_VALUE}`]: String(next) });
    }

    return next;
  }

  function memoryPath(sceneId, sourceId) {
    return `flags.${MODULE_ID}.${MEMORY_FLAG}.${sceneId}.${sourceId}`;
  }

  async function updateMemory(sceneId, sourceId, changes) {
    const scene = String(sceneId || "");
    const source = String(sourceId || "");
    const actor = await writableActor();
    if (!actor || !scene || !source) return false;

    const update = {};
    for (const [key, value] of Object.entries(changes)) {
      update[`${memoryPath(scene, source)}.${key}`] = value;
    }
    await actor.update(update);
    return true;
  }

  async function markRun(sceneId, sourceId) {
    return updateMemory(sceneId, sourceId, { runs: getMemory(sceneId, sourceId).runs + 1 });
  }

  async function erase(sceneId, sourceId) {
    return updateMemory(sceneId, sourceId, { erased: true });
  }

  // value: true | false | "toggle"
  async function setSelf(sceneId, sourceId, slot, value) {
    const key = Logic.SELF_SLOTS.includes(slot) ? slot : "A";
    const current = getMemory(sceneId, sourceId).self?.[key] === true;
    const next = value === "toggle" ? !current : !!value;
    await updateMemory(sceneId, sourceId, { [`self.${key}`]: next });
    return next;
  }

  async function resetEvent(sceneId, sourceId) {
    const scene = String(sceneId || "");
    const source = String(sourceId || "");
    const actor = await writableActor();
    if (!actor || !scene || !source) return false;

    if (memoryRoot()?.[scene]?.[source] === undefined) return true;
    await actor.update({ [`flags.${MODULE_ID}.${MEMORY_FLAG}.${scene}.-=${source}`]: null });
    return true;
  }

  // ------------------------------------------------------------
  // Snapshot / restore
  // For play-testing: take a snapshot before walking the party through
  // events, restore it after, and no test progress is left in the world.
  // ------------------------------------------------------------
  function snapshot() {
    return Logic.clone({
      partyActorId: store.partyActorId,
      switches: table(SWITCH_TABLE),
      variables: table(VARIABLE_TABLE),
      memory: memoryRoot()
    });
  }

  async function restore(snap) {
    const actor = await writableActor();
    if (!actor || !snap) return false;
    if (snap.partyActorId && snap.partyActorId !== actor.id) {
      console.warn(INSTALL_TAG, "restore() refused: the snapshot is from another party.", {
        snapshot: snap.partyActorId,
        current: actor.id
      });
      return false;
    }

    // An update merges, so anything added since the snapshot is removed first.
    const wipe = {};
    for (const [name, saved] of [[SWITCH_TABLE, snap.switches], [VARIABLE_TABLE, snap.variables]]) {
      for (const key of Object.keys(table(name))) {
        if (!(key in (saved ?? {}))) wipe[`system.props.${name}.-=${key}`] = null;
      }
    }
    if (actor.flags?.[MODULE_ID]?.[MEMORY_FLAG] !== undefined) {
      wipe[`flags.${MODULE_ID}.-=${MEMORY_FLAG}`] = null;
    }
    if (Object.keys(wipe).length) await actor.update(wipe);

    const put = {
      [`system.props.${SWITCH_TABLE}`]: snap.switches ?? {},
      [`system.props.${VARIABLE_TABLE}`]: snap.variables ?? {}
    };
    // No memory in the snapshot means no flag at all, as before any event ran.
    if (Object.keys(snap.memory ?? {}).length) put[`flags.${MODULE_ID}.${MEMORY_FLAG}`] = snap.memory;

    await actor.update(put);
    return true;
  }

  // ------------------------------------------------------------
  // Telling the rest of the module
  // ------------------------------------------------------------
  // Several writes land together (a save being loaded); one hook covers them.
  function announceChange() {
    if (store.changeTimer) return;
    store.changeTimer = setTimeout(() => {
      store.changeTimer = null;
      try { Hooks.callAll("oniGameStateChanged"); } catch (_) {}
    }, 50);
  }

  function touchesGameState(changes) {
    const props = changes?.system?.props;
    if (props && (SWITCH_TABLE in props || VARIABLE_TABLE in props
      || `-=${SWITCH_TABLE}` in props || `-=${VARIABLE_TABLE}` in props)) return true;

    const flags = changes?.flags?.[MODULE_ID];
    return !!flags && (MEMORY_FLAG in flags || `-=${MEMORY_FLAG}` in flags);
  }

  Hooks.on("updateActor", (actor, changes) => {
    // The Current Game sheet now points at another party.
    if (changes?.system?.props && "game_id" in changes.system.props) {
      refresh();
      return;
    }
    if (actor?.id === store.partyActorId && touchesGameState(changes)) announceChange();
  });

  Hooks.once("ready", () => { refresh(); });
  Hooks.on("canvasReady", () => { refresh(); });

  const GameState = {
    installed: true,
    SWITCH_TABLE,
    VARIABLE_TABLE,
    MEMORY_FLAG,

    refresh,
    partyActor,

    getSwitch,
    getVariable,
    switchNames,
    variableNames,
    getMemory,
    readerFor,

    setSwitch,
    setVariable,
    setSelf,
    markRun,
    erase,
    resetEvent,

    snapshot,
    restore,

    // Console helper: everything this party's events can read.
    dump() {
      return {
        party: partyActor()?.name ?? null,
        switches: Object.fromEntries(switchNames().map(n => [n, getSwitch(n)])),
        variables: Object.fromEntries(variableNames().map(n => [n, getVariable(n)])),
        memory: Logic.clone(memoryRoot())
      };
    }
  };

  window.oni.EventSystem.GameState = GameState;
  window.oni.GameState = GameState;

  console.debug(INSTALL_TAG, "Installed. API: window.oni.GameState");
})();
