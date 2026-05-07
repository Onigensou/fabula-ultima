/**
 * Fabula Initiative — Turn Emitter / Once-per-Turn Reset Bridge
 * Foundry V12
 *
 * Purpose:
 * - Adds a stable Fabula-side event layer over Lancer Initiative timing.
 * - Detects:
 *   1) activation starts: combat.turn becomes a number
 *   2) activation ends: combat.turn becomes null
 *   3) round changes
 *   4) combat start/end
 * - Clears registered once-per-turn flags, including Agony.
 *
 * Load this from module.json after your Fabula Initiative scripts.
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][FabulaInitiativeTurnEmitter]";
  const LI = "lancer-initiative";

  const DEBUG = true;

  const DEFAULT_ONCE_PER_TURN_FLAGS = [
    {
      scope: MODULE_ID,
      key: "agonyOncePerTurn",
      label: "Agony"
    }
  ];

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);

  const GLOBAL_KEY = "__ONI_FABULA_INITIATIVE_TURN_EMITTER__";

  if (globalThis[GLOBAL_KEY]?.installed) {
    log("Already installed.");
    return;
  }

  const state = globalThis[GLOBAL_KEY] = globalThis[GLOBAL_KEY] || {
    installed: false,
    serial: 0,
    turnSerial: 0,
    roundSerial: 0,
    combatSerial: 0,
    lastEvent: null,
    lastActiveByCombatId: new Map(),
    prevTurnByCombatId: new Map(),
    prevRoundByCombatId: new Map(),
    registeredFlags: new Map(),
    lastClearKey: "",
    lastClearAt: 0
  };

  for (const row of DEFAULT_ONCE_PER_TURN_FLAGS) {
    state.registeredFlags.set(`${row.scope}.${row.key}`, { ...row });
  }

  function str(v, d = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : d;
  }

  function isNumberTurn(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function collectionValues(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (collection instanceof Map) return Array.from(collection.values());
    if (typeof collection.values === "function") return Array.from(collection.values());
    if (typeof collection === "object") return Object.values(collection);
    return [];
  }

  function getPrimaryActiveGM() {
    return Array.from(game.users ?? [])
      .filter(u => u?.active && u?.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
  }

  function isPrimaryActiveGM() {
    const gm = getPrimaryActiveGM();
    return !!gm && gm.id === game.userId;
  }

  function getCombatantByTurn(combat, turnIndex) {
    if (!combat || !isNumberTurn(turnIndex)) return null;
    return combat.turns?.[turnIndex] ?? null;
  }

  function getCombatSceneId(combat) {
    return combat?.scene?.id ?? combat?.sceneId ?? combat?.scene ?? null;
  }

  function getViewedSceneId() {
    return canvas?.scene?.id ?? game.user?.viewedScene ?? null;
  }

  function isRelevantCombat(combat) {
    if (!combat) return false;

    const combatSceneId = getCombatSceneId(combat);
    const viewedSceneId = getViewedSceneId();

    if (!combatSceneId || !viewedSceneId) return true;
    return combatSceneId === viewedSceneId;
  }

  function getCombatantSnapshot(combatant) {
    if (!combatant) return null;

    const actor = combatant.actor ?? (combatant.actorId ? game.actors?.get(combatant.actorId) : null);
    const token =
      combatant.tokenId && canvas?.tokens?.get
        ? canvas.tokens.get(combatant.tokenId)
        : null;

    const value = Number(combatant.getFlag?.(LI, "activations.value") ?? 0) || 0;
    const max = Number(combatant.getFlag?.(LI, "activations.max") ?? 0) || 0;

    return {
      combatantId: combatant.id ?? null,
      tokenId: combatant.tokenId ?? null,
      tokenUuid: token?.document?.uuid ?? combatant.token?.uuid ?? null,
      actorId: actor?.id ?? combatant.actorId ?? null,
      actorUuid: actor?.uuid ?? null,
      name: combatant.name ?? actor?.name ?? token?.name ?? "Unknown",
      activations: { value, max }
    };
  }

  function getActivationStamp(combat) {
    const combatants = collectionValues(combat?.combatants);
    return combatants.map(c => {
      const value = c?.getFlag?.(LI, "activations.value") ?? "na";
      const max = c?.getFlag?.(LI, "activations.max") ?? "na";
      return `${c?.id ?? "no-id"}:${value}/${max}`;
    }).join("|");
  }

  function buildEventPayload({
    type,
    combat,
    previousTurn = null,
    currentTurn = null,
    previousCombatant = null,
    currentCombatant = null,
    changed = {},
    reason = ""
  }) {
    const current = currentCombatant ?? getCombatantByTurn(combat, combat?.turn);
    const previous = previousCombatant ?? getCombatantByTurn(combat, previousTurn);

    return {
      type,
      reason,

      serial: state.serial,
      turnSerial: state.turnSerial,
      roundSerial: state.roundSerial,
      combatSerial: state.combatSerial,

      combatId: combat?.id ?? null,
      sceneId: getCombatSceneId(combat),
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,

      previousTurn,
      currentTurn,

      previousCombatant: getCombatantSnapshot(previous),
      currentCombatant: getCombatantSnapshot(current),

      activationStamp: combat ? getActivationStamp(combat) : "",

      changed,
      at: Date.now()
    };
  }

  function callLocalHooks(eventName, payload) {
    Hooks.callAll("oni.fabulaInitiative.event", payload);
    Hooks.callAll(`oni.fabulaInitiative.${eventName}`, payload);

    // Short aliases for future custom scripts.
    Hooks.callAll("fabulaInitiativeEvent", payload);
    Hooks.callAll(`fabulaInitiative${eventName[0].toUpperCase()}${eventName.slice(1)}`, payload);
  }

  function emit(eventName, payload) {
    state.serial++;
    payload.serial = state.serial;
    payload.turnSerial = state.turnSerial;
    payload.roundSerial = state.roundSerial;
    payload.combatSerial = state.combatSerial;
    payload.at = Date.now();

    state.lastEvent = payload;

    log("EMIT", eventName, payload);
    callLocalHooks(eventName, payload);
  }

  function shouldDedupeClear(reason, payload) {
    const key = [
      reason,
      payload?.combatId ?? "no-combat",
      payload?.round ?? "no-round",
      payload?.turn ?? "no-turn",
      payload?.turnSerial ?? "no-turn-serial",
      payload?.roundSerial ?? "no-round-serial"
    ].join("|");

    const now = Date.now();
    if (key === state.lastClearKey && (now - state.lastClearAt) < 250) return true;

    state.lastClearKey = key;
    state.lastClearAt = now;
    return false;
  }

  async function clearRegisteredOncePerTurnFlags(reason, payload) {
    if (!game.user?.isGM) return;
    if (!isPrimaryActiveGM()) return;
    if (shouldDedupeClear(reason, payload)) return;

    const combat = game.combats?.get(payload?.combatId) ?? game.combat ?? null;
    if (!combat) return;

    const flags = Array.from(state.registeredFlags.values());
    if (!flags.length) return;

    const actors = [];
    const seen = new Set();

    for (const combatant of collectionValues(combat.combatants)) {
      const actor =
        combatant?.actor ??
        (combatant?.actorId ? game.actors?.get(combatant.actorId) : null);

      if (!actor?.uuid) continue;
      if (seen.has(actor.uuid)) continue;

      seen.add(actor.uuid);
      actors.push(actor);
    }

    let cleared = 0;

    for (const actor of actors) {
      for (const flag of flags) {
        try {
          const existing = actor.getFlag?.(flag.scope, flag.key);
          if (existing === undefined || existing === null) continue;

          await actor.unsetFlag(flag.scope, flag.key);
          cleared++;
        } catch (e) {
          warn("Failed to clear once-per-turn flag.", {
            actor: actor?.name,
            flag,
            error: e
          });
        }
      }
    }

    if (cleared > 0) {
      log("Cleared once-per-turn flags.", {
        reason,
        cleared,
        flags,
        combatId: combat.id,
        round: combat.round,
        turn: combat.turn
      });
    }
  }

  function exposeApi() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = mod.api || {};

    const api = {
      getState() {
        return {
          serial: state.serial,
          turnSerial: state.turnSerial,
          roundSerial: state.roundSerial,
          combatSerial: state.combatSerial,
          lastEvent: state.lastEvent ? foundry.utils.deepClone(state.lastEvent) : null,
          registeredFlags: Array.from(state.registeredFlags.values())
        };
      },

      getTurnKey(extra = {}) {
        const actorUuid =
          typeof extra === "string"
            ? extra
            : extra?.actor?.uuid ?? extra?.actorUuid ?? "";

        const combat = game.combat ?? null;

        return [
          "fabula-initiative",
          combat?.id ?? "no-combat",
          "combatSerial", state.combatSerial,
          "roundSerial", state.roundSerial,
          "turnSerial", state.turnSerial,
          "round", combat?.round ?? "no-round",
          "turn", combat?.turn ?? "no-turn",
          "actor", actorUuid || "no-actor"
        ].join("::");
      },

      registerOncePerTurnFlag({ scope = MODULE_ID, key, label = "" } = {}) {
        if (!key) return false;
        state.registeredFlags.set(`${scope}.${key}`, { scope, key, label });
        log("Registered once-per-turn flag.", { scope, key, label });
        return true;
      },

      unregisterOncePerTurnFlag({ scope = MODULE_ID, key } = {}) {
        if (!key) return false;
        return state.registeredFlags.delete(`${scope}.${key}`);
      },

      async clearOncePerTurnFlagsNow(reason = "manual") {
        const payload = buildEventPayload({
          type: "manualClear",
          combat: game.combat,
          reason
        });

        await clearRegisteredOncePerTurnFlags(reason, payload);
        return true;
      }
    };

    globalThis.FUCompanion.api.fabulaInitiativeTurnEmitter = api;
    globalThis.FUCompanion.api.fabulaInitiative = {
      ...(globalThis.FUCompanion.api.fabulaInitiative ?? {}),
      turnEmitter: api
    };

    if (mod) {
      mod.api.fabulaInitiativeTurnEmitter = api;
      mod.api.fabulaInitiative = {
        ...(mod.api.fabulaInitiative ?? {}),
        turnEmitter: api
      };
    }
  }

  function installHooks() {
    const prevTurnByCombatId = state.prevTurnByCombatId;
    const prevRoundByCombatId = state.prevRoundByCombatId;

    Hooks.on("preUpdateCombat", (combat, changed) => {
      if (!combat) return;

      if (Object.prototype.hasOwnProperty.call(changed ?? {}, "turn")) {
        prevTurnByCombatId.set(combat.id, combat.turn);
      }

      if (Object.prototype.hasOwnProperty.call(changed ?? {}, "round")) {
        prevRoundByCombatId.set(combat.id, combat.round);
      }
    });

    Hooks.on("updateCombat", async (combat, changed) => {
      if (!combat) return;
      if (!isRelevantCombat(combat)) return;

      if (changed?.started === true) {
        state.combatSerial++;
        state.roundSerial++;
        state.turnSerial++;

        const payload = buildEventPayload({
          type: "combatStarted",
          combat,
          changed,
          reason: "combat-start"
        });

        emit("combatStarted", payload);
        await clearRegisteredOncePerTurnFlags("combat-start", payload);
      }

      if (changed?.started === false || changed?.active === false) {
        state.combatSerial++;
        state.turnSerial++;

        const payload = buildEventPayload({
          type: "combatEnded",
          combat,
          changed,
          reason: "combat-end"
        });

        emit("combatEnded", payload);
        await clearRegisteredOncePerTurnFlags("combat-end", payload);
      }

      if (Object.prototype.hasOwnProperty.call(changed ?? {}, "round")) {
        state.roundSerial++;
        state.turnSerial++;

        const previousRound = prevRoundByCombatId.get(combat.id) ?? null;

        const payload = buildEventPayload({
          type: "roundChanged",
          combat,
          changed,
          reason: "round-change"
        });

        payload.previousRound = previousRound;
        payload.currentRound = combat.round ?? null;

        emit("roundChanged", payload);
        emit("turnBoundary", { ...payload, type: "turnBoundary", reason: "round-change" });

        await clearRegisteredOncePerTurnFlags("round-change", payload);
      }

      if (Object.prototype.hasOwnProperty.call(changed ?? {}, "turn")) {
        const previousTurn = prevTurnByCombatId.get(combat.id);
        const currentTurn = combat.turn;

        if (previousTurn === currentTurn) return;

        const previousCombatant = getCombatantByTurn(combat, previousTurn);
        const currentCombatant = getCombatantByTurn(combat, currentTurn);

        // Number -> null means the active combatant ended/cleared.
        if (isNumberTurn(previousTurn) && currentTurn === null) {
          state.turnSerial++;

          const payload = buildEventPayload({
            type: "turnEnded",
            combat,
            previousTurn,
            currentTurn,
            previousCombatant,
            currentCombatant,
            changed,
            reason: "turn-ended"
          });

          state.lastActiveByCombatId.set(combat.id, previousCombatant?.id ?? null);

          emit("turnEnded", payload);
          emit("turnBoundary", { ...payload, type: "turnBoundary", reason: "turn-ended" });

          await clearRegisteredOncePerTurnFlags("turn-ended", payload);
        }

        // null -> number, or number -> different number, means a combatant is now active.
        if (isNumberTurn(currentTurn)) {
          state.turnSerial++;

          const payload = buildEventPayload({
            type: "turnStarted",
            combat,
            previousTurn,
            currentTurn,
            previousCombatant,
            currentCombatant,
            changed,
            reason: "turn-started"
          });

          state.lastActiveByCombatId.set(combat.id, currentCombatant?.id ?? null);

          emit("turnStarted", payload);
          emit("turnBoundary", { ...payload, type: "turnBoundary", reason: "turn-started" });

          await clearRegisteredOncePerTurnFlags("turn-started", payload);
        }
      }
    });

    Hooks.on("combatRound", async (combat) => {
      if (!combat) return;
      if (!isRelevantCombat(combat)) return;

      state.roundSerial++;
      state.turnSerial++;

      const payload = buildEventPayload({
        type: "combatRound",
        combat,
        reason: "combatRound-hook"
      });

      emit("roundChanged", payload);
      emit("turnBoundary", { ...payload, type: "turnBoundary", reason: "combatRound-hook" });

      await clearRegisteredOncePerTurnFlags("combatRound-hook", payload);
    });

    Hooks.on("deleteCombat", async (combat) => {
      state.combatSerial++;
      state.turnSerial++;

      const payload = buildEventPayload({
        type: "combatDeleted",
        combat,
        reason: "deleteCombat"
      });

      emit("combatEnded", payload);
      await clearRegisteredOncePerTurnFlags("deleteCombat", payload);
    });
  }

  Hooks.once("ready", () => {
    try {
      if (state.installed) return;

      state.installed = true;

      exposeApi();
      installHooks();

      log("Installed.", {
        user: game.user?.name,
        isGM: !!game.user?.isGM,
        isPrimaryActiveGM: isPrimaryActiveGM(),
        registeredFlags: Array.from(state.registeredFlags.values())
      });
    } catch (e) {
      console.error(TAG, "Install failed.", e);
    }
  });
})();