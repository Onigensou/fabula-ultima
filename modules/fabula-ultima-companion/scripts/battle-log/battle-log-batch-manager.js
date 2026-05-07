// ============================================================================
// Battle Log Batch Manager
// Foundry VTT v12
// Module: fabula-ultima-companion
//
// Purpose:
// - Capture BattleLog entries/rows during a Damage Card batch.
// - Flush them once at the end of the full action/passive/reaction chain.
// - Reduces repeated calls to "BattleLog: Append" during multi-target/passive chains.
//
// Public API:
//   FUCompanion.api.battleLogBatch.capture({ batchId, entries, rows, source })
//   FUCompanion.api.battleLogBatch.captureOrAppend({ batchId, entries, rows, source })
//   FUCompanion.api.battleLogBatch.flush(batchId)
//   FUCompanion.api.battleLogBatch.cancel(batchId)
//   FUCompanion.api.battleLogBatch.get(batchId)
//   FUCompanion.api.battleLogBatch.list()
//
// Notes:
// - This manager does NOT change the BattleLog format.
// - It still uses your existing "BattleLog: Append" macro for final persistence.
// - If no batchId exists, captureOrAppend falls back to immediate append.
// ============================================================================

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const TAG = "[ONI][BattleLogBatch]";
  const DEBUG = true;

  const LOGGER_MACRO_NAME = "BattleLog: Append";

  const DEFAULT_TTL_MS = 120000;

  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  const batches = new Map();

  function log(...args) {
    if (DEBUG) console.log(TAG, ...args);
  }

  function warn(...args) {
    if (DEBUG) console.warn(TAG, ...args);
  }

  function nowMs() {
    return Date.now();
  }

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function safeClone(value, fallback = null) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_e) {}

    try {
      return structuredClone(value);
    } catch (_e) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {}

    return fallback;
  }

  function normalizeBatchId(input = {}) {
    if (typeof input === "string") return safeString(input);

    return safeString(
      input?.battleLogBatchId ??
      input?.batchId ??
      input?.damageBatchId ??
      input?.meta?.battleLogBatchId ??
      input?.meta?.damageBatchId ??
      input?.actionContext?.battleLogBatchId ??
      input?.actionContext?.damageBatchId ??
      input?.actionContext?.meta?.battleLogBatchId ??
      input?.actionContext?.meta?.damageBatchId ??
      ""
    );
  }

  function cleanupExpired() {
    const now = nowMs();

    for (const [batchId, batch] of batches.entries()) {
      const touchedAt = Number(batch?.touchedAt ?? batch?.createdAt ?? 0);
      const ttlMs = Number(batch?.ttlMs ?? DEFAULT_TTL_MS);

      if (ttlMs > 0 && now - touchedAt > ttlMs) {
        warn("Expired stale batch.", {
          batchId,
          ageMs: now - touchedAt,
          entries: batch?.entries?.length ?? 0,
          rows: batch?.rows?.length ?? 0
        });

        batches.delete(batchId);
      }
    }
  }

  function ensureBatch(batchId, options = {}) {
    const id = safeString(batchId);
    if (!id) return null;

    cleanupExpired();

    let batch = batches.get(id);

    if (!batch) {
      const now = nowMs();

      batch = {
        batchId: id,
        createdAt: now,
        touchedAt: now,
        ttlMs: Number(options?.ttlMs ?? DEFAULT_TTL_MS) || DEFAULT_TTL_MS,
        entries: [],
        rows: [],
        sources: [],
        flushing: false,
        flushPromise: null
      };

      batches.set(id, batch);

      log("BEGIN lazy batch", {
        batchId: id
      });
    }

    batch.touchedAt = nowMs();

    return batch;
  }

  function getLoggerMacro() {
    return game.macros?.getName?.(LOGGER_MACRO_NAME) ?? null;
  }

  async function appendImmediately({ entries = [], rows = [], source = "immediate" } = {}) {
    const safeEntries = safeArray(entries);
    const safeRows = safeArray(rows);

    if (!safeEntries.length && !safeRows.length) {
      return {
        ok: true,
        appended: false,
        reason: "empty"
      };
    }

    const logger = getLoggerMacro();

    if (!logger) {
      warn(`Logger macro "${LOGGER_MACRO_NAME}" not found.`);
      return {
        ok: false,
        appended: false,
        reason: "logger_missing",
        entries: safeEntries.length,
        rows: safeRows.length
      };
    }

    log("APPEND immediate", {
      source,
      entries: safeEntries.length,
      rows: safeRows.length
    });

    const result = await logger.execute({
      __AUTO: true,
      __PAYLOAD: {
        entries: safeClone(safeEntries, safeEntries),
        rows: safeClone(safeRows, safeRows)
      }
    });

    return {
      ok: true,
      appended: true,
      source,
      entries: safeEntries.length,
      rows: safeRows.length,
      result
    };
  }

  function capture(input = {}) {
    const batchId = normalizeBatchId(input);
    const entries = safeArray(input?.entries);
    const rows = safeArray(input?.rows);
    const source = safeString(input?.source, "unknown");

    if (!batchId) {
      return {
        ok: false,
        captured: false,
        reason: "missing_batch_id",
        entries: entries.length,
        rows: rows.length
      };
    }

    if (!entries.length && !rows.length) {
      return {
        ok: true,
        captured: false,
        reason: "empty",
        batchId
      };
    }

    const batch = ensureBatch(batchId, input);

    if (!batch) {
      return {
        ok: false,
        captured: false,
        reason: "batch_create_failed",
        batchId
      };
    }

    const entryStart = batch.entries.length;
    const rowStart = batch.rows.length;

    for (const entry of entries) {
      batch.entries.push(safeClone(entry, entry));
    }

    for (const row of rows) {
      batch.rows.push(safeClone(row, row));
    }

    batch.sources.push({
      source,
      at: nowMs(),
      entries: entries.length,
      rows: rows.length
    });

    batch.touchedAt = nowMs();

    log("CAPTURE", {
      batchId,
      source,
      entriesAdded: entries.length,
      rowsAdded: rows.length,
      totalEntries: batch.entries.length,
      totalRows: batch.rows.length,
      entryStart,
      rowStart
    });

    return {
      ok: true,
      captured: true,
      batchId,
      source,
      entriesAdded: entries.length,
      rowsAdded: rows.length,
      entries: batch.entries.length,
      rows: batch.rows.length
    };
  }

  async function captureOrAppend(input = {}) {
    const batchId = normalizeBatchId(input);

    if (batchId) {
      return capture({
        ...input,
        batchId
      });
    }

    if (input?.immediateIfNoBatch === false) {
      return {
        ok: false,
        captured: false,
        appended: false,
        reason: "missing_batch_id"
      };
    }

    return await appendImmediately(input);
  }

  async function flush(batchIdOrInput, options = {}) {
    const batchId = normalizeBatchId(batchIdOrInput);
    if (!batchId) {
      return {
        ok: false,
        flushed: false,
        reason: "missing_batch_id"
      };
    }

    const batch = batches.get(batchId);

    if (!batch) {
      return {
        ok: true,
        flushed: false,
        reason: "batch_not_found",
        batchId
      };
    }

    if (batch.flushing && batch.flushPromise) {
      log("FLUSH already in progress", {
        batchId
      });

      return await batch.flushPromise;
    }

    batch.flushing = true;

    batch.flushPromise = (async () => {
      const entries = safeArray(batch.entries);
      const rows = safeArray(batch.rows);

      if (!entries.length && !rows.length) {
        batches.delete(batchId);

        log("FLUSH empty", {
          batchId
        });

        return {
          ok: true,
          flushed: false,
          empty: true,
          batchId,
          entries: 0,
          rows: 0
        };
      }

      const logger = getLoggerMacro();

      if (!logger) {
        warn(`FLUSH failed. Logger macro "${LOGGER_MACRO_NAME}" not found.`, {
          batchId,
          entries: entries.length,
          rows: rows.length
        });

        // Keep the batch around so it can be retried manually.
        batch.flushing = false;
        batch.flushPromise = null;

        return {
          ok: false,
          flushed: false,
          reason: "logger_missing",
          batchId,
          entries: entries.length,
          rows: rows.length
        };
      }

      log("FLUSH begin", {
        batchId,
        entries: entries.length,
        rows: rows.length,
        sources: batch.sources
      });

      try {
        const result = await logger.execute({
          __AUTO: true,
          __PAYLOAD: {
            entries: safeClone(entries, entries),
            rows: safeClone(rows, rows),
            batchId,
            battleLogBatchId: batchId,
            source: "BattleLogBatch.flush"
          }
        });

        batches.delete(batchId);

        log("FLUSH done", {
          batchId,
          entries: entries.length,
          rows: rows.length
        });

        return {
          ok: true,
          flushed: true,
          batchId,
          entries: entries.length,
          rows: rows.length,
          result
        };
      } catch (error) {
        warn("FLUSH failed.", {
          batchId,
          error: String(error?.message ?? error)
        });

        batch.flushing = false;
        batch.flushPromise = null;

        return {
          ok: false,
          flushed: false,
          reason: "flush_failed",
          batchId,
          entries: entries.length,
          rows: rows.length,
          error: String(error?.message ?? error)
        };
      }
    })();

    return await batch.flushPromise;
  }

  function cancel(batchIdOrInput, reason = "cancelled") {
    const batchId = normalizeBatchId(batchIdOrInput);

    if (!batchId) {
      return {
        ok: false,
        cancelled: false,
        reason: "missing_batch_id"
      };
    }

    const existed = batches.delete(batchId);

    log("CANCEL", {
      batchId,
      existed,
      reason
    });

    return {
      ok: true,
      cancelled: existed,
      batchId,
      reason
    };
  }

  function get(batchIdOrInput) {
    const batchId = normalizeBatchId(batchIdOrInput);
    const batch = batches.get(batchId);

    if (!batch) return null;

    return {
      batchId,
      createdAt: batch.createdAt,
      touchedAt: batch.touchedAt,
      entries: batch.entries.length,
      rows: batch.rows.length,
      sources: safeClone(batch.sources, [])
    };
  }

  function list() {
    cleanupExpired();

    return Array.from(batches.values()).map(batch => ({
      batchId: batch.batchId,
      createdAt: batch.createdAt,
      touchedAt: batch.touchedAt,
      entries: batch.entries.length,
      rows: batch.rows.length,
      sources: safeClone(batch.sources, [])
    }));
  }

  const api = {
    version: "0.1.0",
    capture,
    captureOrAppend,
    appendImmediately,
    flush,
    flushForDamageBatch: flush,
    cancel,
    get,
    list,
    normalizeBatchId
  };

  function registerApi(reason = "manual") {
    const root = (globalThis.FUCompanion = globalThis.FUCompanion || {});
    root.api = root.api || {};
    root.api.battleLogBatch = api;

    try {
      const mod = game.modules?.get?.(MODULE_NS);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.battleLogBatch = api;
      }
    } catch (error) {
      warn("Could not attach API to module.", error);
    }

    log("BattleLog Batch Manager registered.", {
      version: api.version,
      reason
    });

    return api;
  }

  registerApi("script-load");

  // Safety re-register:
  // Some later module scripts may recreate FUCompanion.api or module.api.
  // Reattaching on ready makes this manager survive load-order/API-clobber issues.
  Hooks.once("ready", () => {
    registerApi("ready");
  });
})();