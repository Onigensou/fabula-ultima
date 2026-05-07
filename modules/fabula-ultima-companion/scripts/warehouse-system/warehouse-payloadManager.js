// scripts/warehouse/PayloadManager.js
// ----------------------------------------------------------------------------
// ONI Warehouse — Payload Manager (Foundry V12)
// - Creates a universal payload (global) but DOES NOT lock actor context forever
// - Each "open" should refresh ctx.actorUuid based on the caller's current context
// - If actorUuid is not provided, we CLEAR it so resolver can fall back to
//   game.user.character AT THE MOMENT OF USE.
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";

export class WarehousePayloadManager {
  static GLOBAL_KEY = "__WAREHOUSE_PAYLOAD";

  /**
   * Create a short payload id for tracing logs.
   */
  static _makeId() {
    return Math.random().toString(16).slice(2, 10);
  }

  /**
   * Refresh run-time context so payload doesn't get "stuck" with old actorUuid.
   * Rules:
   * - Always update meta.initial to latest initial input (debug trace).
   * - Always refresh ctx.userId + ctx.sceneId (helps track GM edge cases).
   * - If initial.actorUuid is provided => set it now (live "moment of use").
   * - If initial.actorUuid is NOT provided => clear ctx.actorUuid
   *   so WarehouseAPI.resolveContext can pull game.user.character NOW.
   */
  static refresh(payload, initial = {}) {
    payload.meta = payload.meta ?? {};
    payload.ctx = payload.ctx ?? {};

    // Keep an always-up-to-date snapshot of the latest call that opened the system
    payload.meta.initial = initial ?? {};
    payload.meta.lastOpenedAt = Date.now();

    // Refresh user + scene every run (useful for GM edge-case probes)
    payload.ctx.userId = initial.userId ?? game.user?.id ?? payload.ctx.userId ?? null;
    payload.ctx.sceneId = canvas?.scene?.id ?? payload.ctx.sceneId ?? null;

    // Live actor context refresh
    if (initial?.actorUuid) {
      payload.ctx.actorUuid = initial.actorUuid;
    } else {
      // Important: do NOT keep stale actorUuid; allow resolver to decide "now"
      payload.ctx.actorUuid = null;
    }

    // Allow caller to override storage pointers if they ever pass them (optional)
    if (initial?.storageDbUuid) payload.ctx.storageDbUuid = initial.storageDbUuid;
    if (initial?.storageActorUuid) payload.ctx.storageActorUuid = initial.storageActorUuid;

    // Prevent stale labels if UI shows actorName
    if ("actorName" in payload.ctx) payload.ctx.actorName = null;

    // Debug flag can be refreshed too
    if (typeof initial?.debug === "boolean") {
      payload.meta.debug = initial.debug;
    }

    WarehouseDebug.log(payload, "PAYLOAD", "Payload refreshed (live context)", {
      payloadId: payload.meta.payloadId,
      userId: payload.ctx.userId,
      actorUuid: payload.ctx.actorUuid,
      sceneId: payload.ctx.sceneId
    });

    return payload;
  }

  /**
   * Get (or create) the global payload.
   * NEW behavior:
   * - If it exists, we REFRESH it with the latest initial context.
   * - This prevents "Database Actor / Database Actor" from getting stuck until reload.
   */
  static getOrCreate(initial = {}) {
    const existing = globalThis[this.GLOBAL_KEY];
    if (existing) return this.refresh(existing, initial);

    const payload = this.create(initial);
    globalThis[this.GLOBAL_KEY] = payload;
    return payload;
  }

  /**
   * Create a fresh payload object.
   * NOTE: This should be called ONLY at the start of the pipeline.
   */
  static create(initial = {}) {
    const payloadId = this._makeId();

    const payload = {
      meta: {
        payloadId,
        createdAt: Date.now(),
        system: "ONI_Warehouse",
        version: "0.1.0",
        debug: initial.debug ?? true,

        // Latest "open" input snapshot (updated every run in refresh())
        initial: initial ?? {},
        lastOpenedAt: Date.now()
      },

      // ----------------------------------------------------------------------
      // ctx: resolved context (filled later by resolver script)
      // ----------------------------------------------------------------------
      ctx: {
        userId: initial.userId ?? game.user?.id ?? null,
        actorUuid: initial.actorUuid ?? null,
        storageDbUuid: initial.storageDbUuid ?? null,
        storageActorUuid: initial.storageActorUuid ?? null,

        // Optional extras (safe placeholders)
        actorName: null,
        storageName: null,
        sceneId: canvas?.scene?.id ?? null
      },

      // ----------------------------------------------------------------------
      // snapshot: read-only snapshot (filled later)
      // ----------------------------------------------------------------------
      snapshot: {
        actorZenit: null,
        storageZenit: null,
        actorItems: [],
        storageItems: [],
        normalizedAt: null,
        sourceCounts: { actor: 0, storage: 0 }
      },

      // ----------------------------------------------------------------------
      // plan: planning layer (changes over time, but never removed)
      // ----------------------------------------------------------------------
      plan: {
        itemMoves: [], // {from,to,itemUuid,qty,requestedByUserId,...}
        zenit: {
          depositToStorage: 0,
          withdrawFromStorage: 0,
          lastEditedAt: null,
          lastEditedBy: null
        }
      },

      // ----------------------------------------------------------------------
      // gates: validation output (rewritten each time evaluateAll runs)
      // ----------------------------------------------------------------------
      gates: {
        ok: true,
        errors: [],
        warnings: [],
        byRule: {}
      },

      // ----------------------------------------------------------------------
      // ui: references + render counters
      // ----------------------------------------------------------------------
      ui: {
        instanceId: null,
        appId: null,
        renderCount: 0,
        dragState: null,
        refs: {}
      },

      // ----------------------------------------------------------------------
      // commit: commit report (filled on Confirm)
      // ----------------------------------------------------------------------
      commit: {
        status: "idle", // idle|running|success|failed
        startedAt: null,
        finishedAt: null,
        results: [],
        deltaSummary: null,
        errorDetails: null
      },

      // ----------------------------------------------------------------------
      // audit: append-only log (Debug helper writes here)
      // ----------------------------------------------------------------------
      audit: []
    };

    WarehouseDebug.log(payload, "BOOT", "Payload created", {
      payloadId,
      userId: payload.ctx.userId,
      actorUuid: payload.ctx.actorUuid
    });

    return payload;
  }

  /**
   * Safe "add-only" merge:
   * - Adds new keys that don't exist
   * - Does NOT delete
   * - Does NOT overwrite existing non-null/defined values unless forced
   */
  static add(payload, patch = {}, { force = false } = {}) {
    const walk = (target, src, path = "") => {
      for (const [k, v] of Object.entries(src || {})) {
        const nextPath = path ? `${path}.${k}` : k;

        if (v && typeof v === "object" && !Array.isArray(v)) {
          target[k] = target[k] && typeof target[k] === "object" ? target[k] : {};
          walk(target[k], v, nextPath);
          continue;
        }

        // Arrays: only append, never replace
        if (Array.isArray(v)) {
          target[k] = target[k] ?? [];
          if (!Array.isArray(target[k])) target[k] = [];
          target[k].push(...v);
          continue;
        }

        // Primitive:
        if (target[k] === undefined || target[k] === null || force) {
          target[k] = v;
        }
      }
    };

    walk(payload, patch);

    WarehouseDebug.log(payload, "PAYLOAD", "Add-only patch applied", { patch });
    return payload;
  }

  /**
   * Mark payload closed without deleting (useful for debugging).
   */
  static markClosed(payload, reason = "closed") {
    payload.meta.closedAt = Date.now();
    payload.meta.closeReason = reason;
    WarehouseDebug.log(payload, "CLOSE", "Payload marked closed", { reason });
  }

  /**
   * Optional helper: hard reset payload (useful if you want a "Reset Warehouse" macro later).
   */
  static hardReset(reason = "hardReset") {
    const existing = globalThis[this.GLOBAL_KEY];
    if (existing) this.markClosed(existing, reason);
    delete globalThis[this.GLOBAL_KEY];
  }
}
