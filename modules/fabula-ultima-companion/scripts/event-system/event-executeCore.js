/**
 * [ONI] Event System — Execute Core
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-executeCore.js
 *
 * What this does:
 * - Auto-installs after Foundry is ready
 * - Reads Tile and Token flags from flags.oni-event-system.*
 *   (a Token carrying the flags is an NPC you can talk to)
 * - Scans for nearby Event Tiles / Event Tokens
 * - Uses nearest valid Event Tile as the current candidate
 * - Sends execution requests to GM through fabula-ultima-companion socket
 * - Executes event rows in strict sequence, waiting for each row to finish
 *   (a row may own child lists: the branches of a choice or a condition)
 * - Offers an event only while it is available: not erased, not already run
 *   when it is "once only", and its "available when" condition holds
 *
 * Refactor notes:
 * - UI/UX for the "!" icon is now handled by:
 *   scripts/event-system/event-runtimeUI.js
 * - This core still owns the event startup logic.
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-eventRegistry.js
 * - event-runtimeUI.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ExecuteCore]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Core?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const EventRuntimeUI = window.oni.EventSystem.RuntimeUI;
  const Logic = window.oni.EventSystem.Logic;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!EventRegistry) {
    console.error(INSTALL_TAG, "Missing EventRegistry. Load event-eventRegistry.js first.");
    return;
  }

  if (!EventRuntimeUI) {
    console.error(INSTALL_TAG, "Missing RuntimeUI. Load event-runtimeUI.js before event-executeCore.js");
    return;
  }

  const DEBUG_SCOPE = "ExecuteCore";
  const CHANNELS = Array.isArray(C.SOCKET_CHANNELS)
    ? C.SOCKET_CHANNELS
    : ["module.fabula-ultima-companion"];

  const MSG_EXECUTE_REQ = C.MSG_EVENT_EXECUTE_REQ || "ONI_EVENT_EXECUTE_REQ_V1";
  const MSG_EXECUTE_START = "ONI_EVENT_EXECUTE_START_V1";
  const MSG_EXECUTE_DONE = C.MSG_EVENT_EXECUTE_DONE || "ONI_EVENT_EXECUTE_DONE_V1";
  const MSG_EXECUTE_ERROR = C.MSG_EVENT_EXECUTE_ERROR || "ONI_EVENT_EXECUTE_ERROR_V1";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    group: (...args) => {
      console.groupCollapsed(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args);
      return true;
    },
    groupEnd: () => console.groupEnd()
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Runtime execution state
  // ------------------------------------------------------------
  const gmActiveExecutions = new Set();
  const clientRunningTiles = new Set();

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function isTokenSource(sourceLike) {
    const d = sourceLike?.document ?? sourceLike;
    return d?.documentName === "Token";
  }

  function getSourceGridSize(sourceLike) {
    const d = sourceLike?.document ?? sourceLike;
    return Number(d?.parent?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
  }

  function getTileRect(tileLike) {
    const d = tileLike?.document ?? tileLike;
    // A token's width/height are in grid units, a tile's are in pixels.
    const unit = isTokenSource(d) ? getSourceGridSize(d) : 1;
    const width = Number(d?.width ?? 0) * unit;
    const height = Number(d?.height ?? 0) * unit;
    return {
      left: Number(d?.x ?? 0),
      top: Number(d?.y ?? 0),
      width,
      height,
      right: Number(d?.x ?? 0) + width,
      bottom: Number(d?.y ?? 0) + height
    };
  }

  function getAuthoritativeTokenCenterPx(token, overrideXY = null) {
    const doc = token?.document;
    // token.x/y is the drawn position. The document follows it during a walk
    // but snaps to the destination for an instant whenever Foundry prepares
    // the next move, which would flick anything placed from it.
    const baseX = overrideXY?.x ?? token?.x ?? doc?.x ?? 0;
    const baseY = overrideXY?.y ?? token?.y ?? doc?.y ?? 0;
    const w = token?.w ?? 0;
    const h = token?.h ?? 0;
    return { x: baseX + (w / 2), y: baseY + (h / 2) };
  }

  function pointToRectDistance(point, rect) {
    const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
    const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
    return Math.hypot(dx, dy);
  }

  function normalizeBoolean(raw, fallback = false) {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return !!raw;

    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }

    return fallback;
  }

  function normalizeProximityPx(raw, fallback = C.DEFAULT_PROXIMITY_PX ?? 0) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(C.MIN_PROXIMITY_PX ?? 0, Math.round(n));
  }

  function findEventConfigObject(tileDoc) {
    const flags = tileDoc?.flags ?? {};

    for (const [scope, scopeObj] of Object.entries(flags)) {
      if (!scopeObj || typeof scopeObj !== "object") continue;

      for (const [, val] of Object.entries(scopeObj)) {
        if (val && typeof val === "object" && ("isEventTile" in val)) {
          return { scope, data: val };
        }
      }

      if ("isEventTile" in scopeObj) {
        return { scope, data: scopeObj };
      }
    }

    return { scope: null, data: null };
  }

  function normalizeEventRows(rawRows) {
    return EventRegistry.normalizeRows(rawRows);
  }

  // Is this event offered right now? Read from the party's switches,
  // variables and this event's own memory; with no game state loaded, it is.
  function isEventAvailable(sourceLike, data) {
    const state = window.oni.EventSystem.GameState;
    if (!state?.readerFor || !Logic) return true;

    const doc = sourceLike?.document ?? sourceLike;
    const sceneId = doc?.parent?.id ?? canvas?.scene?.id ?? null;

    try {
      return Logic.eventAvailable(
        { onceOnly: data.onceOnly, availableWhen: data.availableWhen },
        state.readerFor(sceneId, doc?.id)
      );
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Availability check failed; treating the event as available.", e);
      return true;
    }
  }

  function readEventData(tileLike) {
    const doc = tileLike?.document ?? tileLike;
    const found = findEventConfigObject(doc);
    const data = found?.data ?? {};

    return {
      isEventTile: normalizeBoolean(data?.isEventTile, false),
      isHidden: !!doc?.hidden,
      // An NPC with no range set is talkable from one grid away.
      proximityPx: normalizeProximityPx(
        data?.proximityPx,
        isTokenSource(doc) ? getSourceGridSize(doc) : (C.DEFAULT_PROXIMITY_PX ?? 0)
      ),
      eventRows: normalizeEventRows(data?.eventRows ?? []),
      onceOnly: normalizeBoolean(data?.onceOnly, false),
      availableWhen: data?.availableWhen ?? null,
      _scope: found?.scope ?? null,
      _raw: data
    };
  }

  function markTileRunning(tileId) {
    const safeTileId = String(tileId || "");
    if (!safeTileId) return;
    clientRunningTiles.add(safeTileId);
  }

  function unmarkTileRunning(tileId) {
    const safeTileId = String(tileId || "");
    if (!safeTileId) return;
    clientRunningTiles.delete(safeTileId);
  }

  function isTileRunningAnywhere(tileId) {
    const safeTileId = String(tileId || "");
    if (!safeTileId) return false;
    return gmActiveExecutions.has(safeTileId) || clientRunningTiles.has(safeTileId);
  }

  async function resolveCurrentDbContext() {
    try {
      const api = window.FUCompanion?.api;
      if (!api?.getCurrentGameDb) {
        DBG.verboseLog(DEBUG_SCOPE, "FUCompanion DB resolver not available.");
        return { db: null, source: null };
      }

      const cache = await api.getCurrentGameDb();
      return {
        db: cache?.db ?? null,
        source: cache?.source ?? null
      };
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Failed resolving current DB context:", e);
      return { db: null, source: null };
    }
  }

  async function resolvePartyToken() {
    if (!canvas?.ready) return null;

    const controlled = canvas.tokens?.controlled?.[0] ?? null;
    if (controlled) {
      DBG.verboseLog(DEBUG_SCOPE, "Party token resolved from controlled token.", {
        tokenId: controlled.id,
        tokenName: controlled.name
      });
      return controlled;
    }

    const { db, source } = await resolveCurrentDbContext();
    if (!db) return null;

    const tokens = canvas.tokens?.placeables ?? [];
    const dbToken =
      tokens.find(t => t?.actor?.id === db.id) ||
      (source ? tokens.find(t => t?.actor?.id === source.id) : null) ||
      tokens.find(t => String(t?.name || "").trim() === String(db?.name || "").trim()) ||
      tokens.find(t => String(t?.actor?.name || "").trim() === String(db?.name || "").trim()) ||
      null;

    if (dbToken) {
      DBG.verboseLog(DEBUG_SCOPE, "Party token resolved from FUCompanion DB fallback.", {
        tokenId: dbToken.id,
        tokenName: dbToken.name
      });
    }

    return dbToken;
  }

  async function checkProximityForTile(tileLike, partyToken, overrideXY = null) {
    const data = readEventData(tileLike);
    const point = getAuthoritativeTokenCenterPx(partyToken, overrideXY);
    const rect = getTileRect(tileLike);
    const d = pointToRectDistance(point, rect);

    return {
      ok: d <= data.proximityPx,
      distance: d,
      proximityPx: data.proximityPx
    };
  }

  function buildRuntimeContext({ tileDoc, requesterId, partyToken }) {
    return {
      sceneId: canvas?.scene?.id ?? tileDoc?.parent?.id ?? null,
      tileId: tileDoc?.id ?? null,
      requesterId: requesterId ?? game?.user?.id ?? null,
      userId: requesterId ?? game?.user?.id ?? null,
      tokenId: partyToken?.id ?? null,
      actorId: partyToken?.actor?.id ?? null,
      partyToken,
      partyActor: partyToken?.actor ?? null,
      sourceTokenId: isTokenSource(tileDoc) ? (tileDoc?.id ?? null) : null
    };
  }

  function emitSocketMessage(type, payload) {
    for (const ch of CHANNELS) {
      try {
        game.socket.emit(ch, { type, payload });
        DBG.verboseLog(DEBUG_SCOPE, "Socket emit ok.", { channel: ch, type, payload });
        return true;
      } catch (e) {
        DBG.warn(DEBUG_SCOPE, "Socket emit failed on channel.", { channel: ch, type, error: e });
      }
    }
    return false;
  }

  // ------------------------------------------------------------
  // GM execution
  // ------------------------------------------------------------
  async function gmExecuteEventTile({ sceneId, tileId, requesterId }) {
    const safeTileId = String(tileId || "");
    const safeSceneId = String(sceneId || "");

    const grouped = !!DBG.group?.(DEBUG_SCOPE, `GM Execute Tile [${safeTileId}]`, true);
    DBG.log(DEBUG_SCOPE, "Execution request received.", {
      sceneId: safeSceneId,
      tileId: safeTileId,
      requesterId
    });

    try {
      const scene = game.scenes?.get(safeSceneId);
      if (!scene) {
        DBG.warn(DEBUG_SCOPE, "Scene not found.", { sceneId: safeSceneId });
        return { ok: false, reason: "sceneNotFound", tileId: safeTileId };
      }

      const tileDoc = scene.tiles?.get(safeTileId) ?? scene.tokens?.get(safeTileId);
      if (!tileDoc) {
        DBG.warn(DEBUG_SCOPE, "Tile not found.", { tileId: safeTileId, sceneId: safeSceneId });
        return { ok: false, reason: "tileNotFound", tileId: safeTileId };
      }

      if (tileDoc.hidden) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile is hidden.", { tileId: safeTileId });
        return { ok: false, reason: "tileHidden", tileId: safeTileId };
      }

      const data = readEventData(tileDoc);

      if (!data.isEventTile) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile is not an Event Tile.", { tileId: safeTileId });
        return { ok: false, reason: "notEventTile", tileId: safeTileId };
      }

      if (!Array.isArray(data.eventRows) || !data.eventRows.length) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile has no event rows.", { tileId: safeTileId });
        return { ok: false, reason: "noEventRows", tileId: safeTileId };
      }

      if (!isEventAvailable(tileDoc, data)) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because the event is not available.", { tileId: safeTileId });
        return { ok: false, reason: "notAvailable", tileId: safeTileId };
      }

      if (gmActiveExecutions.has(safeTileId)) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile is already running.", { tileId: safeTileId });
        return { ok: false, reason: "alreadyExecuting", tileId: safeTileId };
      }

      const partyToken = await resolvePartyToken();
      if (!partyToken) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because no party token could be resolved.", { tileId: safeTileId });
        return { ok: false, reason: "noPartyToken", tileId: safeTileId };
      }

      if (String(partyToken.id) === safeTileId) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because the event token is the party token.", { tileId: safeTileId });
        return { ok: false, reason: "sourceIsPartyToken", tileId: safeTileId };
      }

      const proximity = await checkProximityForTile(tileDoc, partyToken, null);
      if (!proximity.ok) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked by proximity check.", {
          tileId: safeTileId,
          distance: Math.round(proximity.distance),
          proximityPx: proximity.proximityPx
        });
        return { ok: false, reason: "outOfRange", tileId: safeTileId, proximity };
      }

      gmActiveExecutions.add(safeTileId);
      markTileRunning(safeTileId);
      window.oni.EventSystem.Flow?.begin(safeTileId, safeSceneId, tileDoc);

      emitSocketMessage(MSG_EXECUTE_START, {
        sceneId: safeSceneId,
        tileId: safeTileId,
        requesterId,
        gmUserId: game.user?.id ?? null
      });
      announceExecution("start", safeSceneId, safeTileId, game.user?.id ?? null);

      const context = buildRuntimeContext({
        tileDoc,
        requesterId,
        partyToken
      });
      context.sourceDoc = tileDoc;

      DBG.log(DEBUG_SCOPE, "Beginning event sequence.", {
        tileId: safeTileId,
        rowCount: data.eventRows.length,
        proximityPx: data.proximityPx
      });
      DBG.verboseLog(DEBUG_SCOPE, "Execution context:", context);
      DBG.verboseLog(DEBUG_SCOPE, "Event rows:", data.eventRows);

      const flow = window.oni.EventSystem.Flow;

      // One list of rows, top to bottom. A row that owns child lists (a
      // choice, a condition) runs the one it picks through context.runRows.
      const runList = (rows) => Logic.runRows(rows, {
        aborted: () => !!flow?.isAborted?.(safeTileId),
        isCritical: (row) => EventRegistry.peek(row?.type)?.critical === true,

        onSkip: (row, result) => {
          DBG.warn(DEBUG_SCOPE, "Row passed over; the event carries on.", {
            tileId: safeTileId,
            rowId: row?.id ?? null,
            type: row?.type ?? null,
            result
          });
        },

        execute: async (row, index, total) => {
          const def = EventRegistry.peek(row?.type);

          DBG.log(DEBUG_SCOPE, "Executing row.", {
            tileId: safeTileId,
            rowIndex: index,
            rowNumber: index + 1,
            rowId: row?.id ?? null,
            type: row?.type ?? null
          });

          flow?.setProgress?.(safeTileId, {
            index,
            total,
            label: def?.label ?? String(row?.type ?? ""),
            summary: String(def?.summary?.(row) ?? "")
          });

          const result = await EventRegistry.executeRow(row, {
            ...context,
            rowIndex: index,
            rowNumber: index + 1,
            totalRows: total,
            runRows: runList
          });

          DBG.verboseLog(DEBUG_SCOPE, "Row result:", result);
          return result;
        }
      });

      const outcome = await runList(data.eventRows);

      if (!outcome?.ok) {
        DBG.warn(DEBUG_SCOPE, "Sequence stopped because a row failed.", {
          tileId: safeTileId,
          outcome
        });

        emitSocketMessage(MSG_EXECUTE_ERROR, {
          sceneId: safeSceneId,
          tileId: safeTileId,
          requesterId,
          rowIndex: outcome?.rowIndex ?? null,
          rowId: outcome?.rowId ?? null
        });
        announceExecution("done", safeSceneId, safeTileId);

        return {
          ok: false,
          reason: "rowFailed",
          tileId: safeTileId,
          rowIndex: outcome?.rowIndex ?? null,
          rowId: outcome?.rowId ?? null,
          result: outcome?.result ?? null
        };
      }

      // An event ended early by the GM has not run: it stays available.
      const state = window.oni.EventSystem.GameState;
      if (!outcome.aborted && state?.markRun
        && Logic.usesRunMemory(data.eventRows, data, (type) => EventRegistry.peek(type))) {
        await state.markRun(safeSceneId, safeTileId);
      }

      DBG.log(DEBUG_SCOPE, "Event sequence finished.", {
        tileId: safeTileId,
        rowCount: data.eventRows.length,
        endedEarly: !!outcome.aborted
      });

      emitSocketMessage(MSG_EXECUTE_DONE, {
        sceneId: safeSceneId,
        tileId: safeTileId,
        requesterId
      });
      announceExecution("done", safeSceneId, safeTileId);

      return {
        ok: true,
        tileId: safeTileId,
        sceneId: safeSceneId
      };
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "GM execution failed.", e);

      emitSocketMessage(MSG_EXECUTE_ERROR, {
        sceneId: safeSceneId,
        tileId: safeTileId,
        requesterId,
        error: String(e?.message || e)
      });
      announceExecution("done", safeSceneId, safeTileId);

      return {
        ok: false,
        reason: "exception",
        tileId: safeTileId,
        error: e
      };
    } finally {
      gmActiveExecutions.delete(safeTileId);
      unmarkTileRunning(safeTileId);
      window.oni.EventSystem.Flow?.end(safeTileId);
      if (grouped) DBG.groupEnd?.();
    }
  }

  // Tell the rest of the module, on this client, that an event began or ended.
  // Sockets do not echo to their sender, so the executing GM calls this
  // directly and every other client calls it when the broadcast arrives.
  function announceExecution(phase, sceneId, sourceId, gmUserId = null) {
    try {
      Hooks.callAll(phase === "start" ? "oniEventExecuteStart" : "oniEventExecuteDone", {
        sceneId: String(sceneId || ""),
        sourceId: String(sourceId || ""),
        gmUserId: gmUserId ? String(gmUserId) : null
      });
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "announceExecution failed.", e);
    }
  }

  // ------------------------------------------------------------
  // Core
  // ------------------------------------------------------------
  const core = {
    installed: true,
    running: false,

    ui: null,
    _hooks: [],
    _socketFn: null,
    _posOverrides: new Map(),
    _scanQueued: false,
    _activeCandidate: null,
    _activeTalkCandidate: null,
    _moveWatchTimer: null,

    getActiveCandidate() {
      return this._activeCandidate ? foundry.utils.deepClone(this._activeCandidate) : null;
    },

    _setOverride(tokenId, x, y) {
      this._posOverrides.set(String(tokenId), {
        x: Number(x),
        y: Number(y),
        ts: Date.now()
      });
    },

    _getOverride(tokenId) {
      const key = String(tokenId || "");
      const o = this._posOverrides.get(key);
      if (!o) return null;

      const ttl = Number(C.POS_OVERRIDE_TTL_MS ?? 800);
      if ((Date.now() - o.ts) > ttl) {
        this._posOverrides.delete(key);
        return null;
      }

      return o;
    },

    _cleanupOverrides() {
      const ttl = Number(C.POS_OVERRIDE_TTL_MS ?? 800);
      const now = Date.now();

      for (const [tokenId, o] of this._posOverrides.entries()) {
        if ((now - o.ts) > ttl) this._posOverrides.delete(tokenId);
      }
    },

    _stopMoveWatch() {
      if (this._moveWatchTimer) clearInterval(this._moveWatchTimer);
      this._moveWatchTimer = null;
    },

    // Re-scan while the party token is walking, so a button appears as the
    // token comes into range and goes as it leaves, then once more on arrival.
    _startMoveWatch(tokenId) {
      this._stopMoveWatch();

      const startedAt = Date.now();
      const maxMs = Number(C.MOVE_WATCH_MAX_MS ?? 20000);

      this._moveWatchTimer = setInterval(() => {
        const token = canvas?.tokens?.get?.(tokenId) ?? null;
        const src = token?.document?._source ?? null;

        const walking = !!token && !!src
          && (Math.abs(token.x - src.x) > 0.5 || Math.abs(token.y - src.y) > 0.5);

        if (!walking || !this.running || (Date.now() - startedAt) > maxMs) {
          this._stopMoveWatch();
          this._queueScan("moveWatch:arrived");
          return;
        }

        this._queueScan("moveWatch");
      }, Number(C.MOVE_WATCH_INTERVAL_MS ?? 100));
    },

    _queueScan(reason = "unknown") {
      if (this._scanQueued) return;
      this._scanQueued = true;

      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          this._scanQueued = false;
          await this.scan(reason);
        });
      });
    },

    async scan(reason = "scan") {
      try {
        if (!canvas?.ready) return;
        if (!this.running) return;

        this._cleanupOverrides();

        const partyToken = await resolvePartyToken();
        if (!partyToken) {
          this._activeCandidate = null;
          this._activeTalkCandidate = null;
          this.ui?.hideAll();
          DBG.verboseLog(DEBUG_SCOPE, "Scan aborted: no party token.", { reason });
          return;
        }

        const ov = this._getOverride(partyToken.id);
        const partyCenter = getAuthoritativeTokenCenterPx(
          partyToken,
          ov ? { x: ov.x, y: ov.y } : null
        );

        const tiles = [
          ...(canvas.tiles?.placeables ?? []),
          ...(canvas.tokens?.placeables ?? []).filter(t => t.id !== partyToken.id)
        ];
        // Examine points (tiles) and talking NPCs (tokens) are offered side by
        // side, so the nearest of each kind is tracked separately.
        let best = null;
        let bestTalk = null;

        for (const tile of tiles) {
          const data = readEventData(tile);
          if (!data.isEventTile) continue;
          if (data.isHidden) continue;
          if (!Array.isArray(data.eventRows) || !data.eventRows.length) continue;
          if (isTileRunningAnywhere(tile.id)) continue;
          if (!isEventAvailable(tile, data)) continue;

          const rect = getTileRect(tile);
          const d = pointToRectDistance(partyCenter, rect);

          if (d > data.proximityPx) continue;

          const candidate = {
            tileId: tile.id,
            tileName: tile.document?.name || tile.name || "Event Tile",
            distance: d,
            proximityPx: data.proximityPx
          };

          if (isTokenSource(tile)) {
            if (!bestTalk || d < bestTalk.distance) bestTalk = candidate;
          } else if (!best || d < best.distance) {
            best = candidate;
          }
        }

        this._activeCandidate = best;
        this._activeTalkCandidate = bestTalk;
        this.ui?.setInteractive?.(window.oni.EventSystem.Flow?.isLocalUserInteractor?.() ?? true);

        if (best) {
          this.ui?.showForCandidate(
            best,
            partyToken,
            ov ? { x: ov.x, y: ov.y } : null
          );
        } else {
          this.ui?.hide();
        }

        const talkToken = bestTalk ? (canvas.tokens?.get(bestTalk.tileId) ?? null) : null;
        if (talkToken) {
          this.ui?.showTalkForCandidate(bestTalk, talkToken);
        } else {
          this.ui?.hideTalk();
        }

        DBG.verboseLog(DEBUG_SCOPE, "Scan result.", {
          reason,
          partyTokenId: partyToken.id,
          override: ov ?? null,
          activeCandidate: best,
          activeTalkCandidate: bestTalk
        });
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "scan failed:", e);
      }
    },

    // End an event on this client without word from the GM running it (its
    // time limit ran out, or that GM dropped out).
    forceEndLocal(sourceId) {
      const id = String(sourceId || "");
      if (!id) return;

      unmarkTileRunning(id);
      announceExecution("done", canvas?.scene?.id ?? null, id);
      this._queueScan("forceEndLocal");
    },

    async requestExecute(tileId) {
      const safeTileId = String(tileId || "");

      try {
        const sceneId = canvas?.scene?.id;
        if (!sceneId || !safeTileId) return;

        if (window.oni.EventSystem.Flow && !window.oni.EventSystem.Flow.isLocalUserInteractor()) {
          DBG.verboseLog(DEBUG_SCOPE, "requestExecute ignored: this user is not the main controller.", {
            tileId: safeTileId
          });
          return;
        }

        DBG.log(DEBUG_SCOPE, "requestExecute called.", {
          sceneId,
          tileId: safeTileId,
          userId: game?.user?.id ?? null,
          isGM: !!game?.user?.isGM
        });

        markTileRunning(safeTileId);
        if (this._activeCandidate?.tileId === safeTileId) {
          this._activeCandidate = null;
          this.ui?.hide();
        }
        if (this._activeTalkCandidate?.tileId === safeTileId) {
          this._activeTalkCandidate = null;
          this.ui?.hideTalk();
        }

        if (game?.user?.isGM) {
          await gmExecuteEventTile({
            sceneId,
            tileId: safeTileId,
            requesterId: game.user.id
          });
          this._queueScan("after-gm-execute");
          return;
        }

        const emitted = emitSocketMessage(MSG_EXECUTE_REQ, {
          sceneId,
          tileId: safeTileId,
          requesterId: game?.user?.id ?? null
        });

        if (!emitted) {
          unmarkTileRunning(safeTileId);
          this._queueScan("requestExecuteEmitFailed");
        }
      } catch (e) {
        unmarkTileRunning(safeTileId);
        DBG.error(DEBUG_SCOPE, "requestExecute failed:", e);
      }
    },

    async start() {
      if (this.running) return;

      if (!canvas?.ready) {
        DBG.warn(DEBUG_SCOPE, "start() called before canvas is ready.");
        return;
      }

      this.ui = new EventRuntimeUI({
        constants: C,
        debug: DBG,
        getOverride: (tokenId) => this._getOverride(tokenId),
        onInteract: async (tileId) => this.requestExecute(tileId)
      });
      this.ui.start();

      this._socketFn = async (msg) => {
        try {
          if (!msg?.type) return;

          if (msg.type === MSG_EXECUTE_REQ) {
            DBG.verboseLog(DEBUG_SCOPE, "Socket RX execute request.", msg);
            if (!game?.user?.isGM) return;

            // The request reaches every GM client; one of them runs it.
            const isPrimaryGM = globalThis.FUCompanion?.isPrimaryGM;
            if (typeof isPrimaryGM === "function" && !isPrimaryGM()) return;

            const flow = window.oni.EventSystem.Flow;
            if (flow && !(await flow.isUserInteractor(msg?.payload?.requesterId))) {
              DBG.warn(DEBUG_SCOPE, "Execute request refused: sender is not the main controller.", msg?.payload);
              return;
            }

            await gmExecuteEventTile(msg.payload);
            this._queueScan("after-socket-execute");
            return;
          }

          if (msg.type === MSG_EXECUTE_START) {
            DBG.verboseLog(DEBUG_SCOPE, "Socket RX execute start.", msg);

            const runningTileId = String(msg?.payload?.tileId || "");
            if (runningTileId) {
              markTileRunning(runningTileId);
              announceExecution("start", msg?.payload?.sceneId, runningTileId, msg?.payload?.gmUserId ?? null);

              if (this._activeCandidate?.tileId === runningTileId) {
                this._activeCandidate = null;
                this.ui?.hide();
              }
              if (this._activeTalkCandidate?.tileId === runningTileId) {
                this._activeTalkCandidate = null;
                this.ui?.hideTalk();
              }
            }

            this._queueScan("after-execute-start");
            return;
          }

          if (msg.type === MSG_EXECUTE_DONE) {
            DBG.verboseLog(DEBUG_SCOPE, "Socket RX execute done.", msg);

            const finishedTileId = String(msg?.payload?.tileId || "");
            if (finishedTileId) {
              unmarkTileRunning(finishedTileId);
              announceExecution("done", msg?.payload?.sceneId, finishedTileId);
            }

            this._queueScan("after-execute-done");
            return;
          }

          if (msg.type === MSG_EXECUTE_ERROR) {
            DBG.warn(DEBUG_SCOPE, "Socket RX execute error.", msg);

            const erroredTileId = String(msg?.payload?.tileId || "");
            if (erroredTileId) {
              unmarkTileRunning(erroredTileId);
              announceExecution("done", msg?.payload?.sceneId, erroredTileId);
            }

            this._queueScan("after-execute-error");
            return;
          }
        } catch (e) {
          DBG.error(DEBUG_SCOPE, "Socket handler error:", e);
        }
      };

      for (const ch of CHANNELS) {
        try {
          game.socket.on(ch, this._socketFn);
          DBG.verboseLog(DEBUG_SCOPE, "Socket listener installed.", { channel: ch });
        } catch (e) {
          DBG.warn(DEBUG_SCOPE, "Failed installing socket listener.", { channel: ch, error: e });
        }
      }

      const onUpdateToken = async (tokenDoc, changes) => {
        const moved = ("x" in changes) || ("y" in changes);

        const partyToken = await resolvePartyToken();
        if (!partyToken || String(tokenDoc.id) !== String(partyToken.id)) {
          // An event token moved, was hidden/revealed, or had its event edited.
          if (moved || ("hidden" in changes) || ("flags" in changes)) {
            this._queueScan("updateToken(other)");
          }
          return;
        }
        if (!moved) return;

        // No position override here: while a token walks, document.x/y is its
        // animated position, so the buttons ride on the token and range is
        // judged from where it is, not from where it was told to go.
        this._queueScan("updateToken(move)");
        this._startMoveWatch(tokenDoc.id);
      };

      const onCreateToken = () => this._queueScan("createToken");
      const onDeleteToken = () => this._queueScan("deleteToken");
      const onCreateTile = () => this._queueScan("createTile");
      const onDeleteTile = () => this._queueScan("deleteTile");
      const onUpdateTile = () => this._queueScan("updateTile");
      const onControlToken = () => this._queueScan("controlToken");
      const onCanvasPan = async () => {
        const partyToken = await resolvePartyToken();
        if (!partyToken) return;
        const ov = this._getOverride(partyToken.id);
        this.ui?.placeForToken(partyToken, ov ? { x: ov.x, y: ov.y } : null);
      };
      const onCanvasReady = () => this._queueScan("canvasReady");
      // A switch flipped, a variable changed, a save was loaded.
      const onGameStateChanged = () => this._queueScan("gameStateChanged");
      const onResize = async () => {
        const partyToken = await resolvePartyToken();
        if (!partyToken) return;
        const ov = this._getOverride(partyToken.id);
        this.ui?.placeForToken(partyToken, ov ? { x: ov.x, y: ov.y } : null);
      };

      Hooks.on("updateToken", onUpdateToken);
      Hooks.on("createToken", onCreateToken);
      Hooks.on("deleteToken", onDeleteToken);
      Hooks.on("createTile", onCreateTile);
      Hooks.on("deleteTile", onDeleteTile);
      Hooks.on("updateTile", onUpdateTile);
      Hooks.on("controlToken", onControlToken);
      Hooks.on("canvasPan", onCanvasPan);
      Hooks.on("canvasReady", onCanvasReady);
      Hooks.on("oniGameStateChanged", onGameStateChanged);
      window.addEventListener("resize", onResize);

      this._hooks.push(["updateToken", onUpdateToken]);
      this._hooks.push(["createToken", onCreateToken]);
      this._hooks.push(["deleteToken", onDeleteToken]);
      this._hooks.push(["createTile", onCreateTile]);
      this._hooks.push(["deleteTile", onDeleteTile]);
      this._hooks.push(["updateTile", onUpdateTile]);
      this._hooks.push(["controlToken", onControlToken]);
      this._hooks.push(["canvasPan", onCanvasPan]);
      this._hooks.push(["canvasReady", onCanvasReady]);
      this._hooks.push(["oniGameStateChanged", onGameStateChanged]);
      this._hooks.push(["resize", onResize]);

      this.running = true;

      await this.scan("start");

      DBG.log(DEBUG_SCOPE, "Event System started.", {
        channels: CHANNELS,
        buttonText: C.INTERACT_BUTTON_TEXT || "!",
        defaultProximityPx: C.DEFAULT_PROXIMITY_PX ?? 0
      });
    },

    async stop() {
      if (!this.running) return;

      for (const ch of CHANNELS) {
        try {
          game.socket.off(ch, this._socketFn);
        } catch (_) {}
      }

      for (const [evt, fn] of this._hooks) {
        try {
          if (evt === "resize") window.removeEventListener("resize", fn);
          else Hooks.off(evt, fn);
        } catch (_) {}
      }

      this._hooks = [];
      this._posOverrides.clear();
      this._scanQueued = false;
      this._activeCandidate = null;
      this._activeTalkCandidate = null;
      this._stopMoveWatch();
      clientRunningTiles.clear();

      this.ui?.stop();
      this.ui = null;

      this.running = false;

      DBG.log(DEBUG_SCOPE, "Event System stopped.");
    }
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  core.readEventData = readEventData;
  window.oni.EventSystem.Core = core;

  // ------------------------------------------------------------
  // Auto boot
  // ------------------------------------------------------------
  function boot() {
    if (canvas?.ready) {
      core.start();
    } else {
      Hooks.once("canvasReady", () => core.start());
    }
  }

  Hooks.once("ready", () => {
    DBG.verboseLog(DEBUG_SCOPE, "Boot on ready.");
    boot();
  });

  console.debug(INSTALL_TAG, "Installed. API: window.oni.EventSystem.Core");
})();
