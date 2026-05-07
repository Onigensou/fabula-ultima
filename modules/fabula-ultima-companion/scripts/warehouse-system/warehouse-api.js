// scripts/warehouse-system/warehouse-api.js
// ----------------------------------------------------------------------------
// ONI Warehouse — API (Context + Snapshot)
// - resolveContext(payload): fills payload.ctx (actor + storage via DB Resolver)
// - buildSnapshot(payload): fills payload.snapshot (items + zenit)
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehousePayloadManager } from "./warehouse-payloadManager.js";

export class WarehouseAPI {
  // -----------------------------
  // Helpers
  // -----------------------------

  static _asInt(n, fallback = 0) {
    const v = Number.parseInt(n ?? "", 10);
    return Number.isFinite(v) ? v : fallback;
  }

  static getZenit(doc) {
    // Your data key is ".zenit" on both Actor + DB Actor.
    const z =
      doc?.system?.zenit ??
      doc?.system?.props?.zenit ??
      doc?.system?.data?.zenit; // extra fallback

    return this._asInt(z, 0);
  }

  static normalizeItem(item) {
    const itemType = item?.system?.props?.item_type ?? item?.system?.item_type ?? item?.type ?? "";
    const rawQty = item?.system?.props?.item_quantity ?? item?.system?.item_quantity ?? null;

    const isConsumable = String(itemType).toLowerCase() === "consumable";
    const qty = isConsumable ? Math.max(1, this._asInt(rawQty, 1)) : 1;

    return {
      itemUuid: item?.uuid ?? null,
      itemId: item?.id ?? null,
      name: item?.name ?? "(Unnamed Item)",
      img: item?.img ?? "icons/svg/item-bag.svg",
      itemType,
      qty,
      flags: item?.flags ?? {},
      system: item?.system ?? {}
    };
  }

  static getActorFromUuidOrUser(payload) {
    const actorUuid = payload?.ctx?.actorUuid ?? null;

    if (actorUuid && actorUuid !== "TEST") {
      return fromUuid(actorUuid);
    }

    if (game.user?.character) return game.user.character;

    return null;
  }

  /**
   * DB Resolver returns a cache object:
   * { db, dbUuid, gameName, source, rawGameId, ts }
   * If we detect that shape, choose:
   *  1) dbUuid (best, already "Actor.<id>")
   *  2) db (actor doc)
   *  3) source (token override actor)
   */
  static unwrapDbResolverResult(maybeCacheObj) {
    if (!maybeCacheObj || typeof maybeCacheObj !== "object") return maybeCacheObj;

    const looksLikeResolverCache =
      ("dbUuid" in maybeCacheObj) ||
      ("db" in maybeCacheObj) ||
      ("source" in maybeCacheObj) ||
      ("rawGameId" in maybeCacheObj);

    if (!looksLikeResolverCache) return maybeCacheObj;

    // Prefer dbUuid if present
    if (typeof maybeCacheObj.dbUuid === "string" && maybeCacheObj.dbUuid.trim()) {
      return maybeCacheObj.dbUuid.trim();
    }

    // Else try db actor doc
    if (maybeCacheObj.db) return maybeCacheObj.db;

    // Else try source (token override actor)
    if (maybeCacheObj.source) return maybeCacheObj.source;

    return maybeCacheObj;
  }

  /**
   * Coerce many possible refs into an Actor UUID string.
   * Accepts:
   * - Actor document
   * - UUID string ("Actor.xxxxx", "Compendium....", "Scene....")
   * - Actor ID string (we will look up game.actors.get(id))
   * - object with uuid/id/_id/actorId/actorID
   */
  static async coerceToActorUuid(refRaw) {
    if (!refRaw) return null;

    // If it is the resolver cache, unwrap it first
    const ref = this.unwrapDbResolverResult(refRaw);

    // Actor doc
    if (ref?.documentName === "Actor" || ref?.constructor?.name === "Actor") {
      return ref.uuid ?? (ref.id ? `Actor.${ref.id}` : null);
    }

    // UUID string or ID string
    if (typeof ref === "string") {
      const s = ref.trim();
      if (!s) return null;

      if (s.startsWith("Actor.") || s.startsWith("Scene.") || s.startsWith("Compendium.")) return s;

      const actor = game.actors?.get(s);
      if (actor) return actor.uuid ?? `Actor.${actor.id}`;

      // Try resolving as Actor.<id>
      const byUuid = await fromUuid(`Actor.${s}`).catch(() => null);
      if (byUuid) return byUuid.uuid ?? `Actor.${byUuid.id}`;

      return null;
    }

    // Object with uuid
    const uuid = ref.uuid;
    if (typeof uuid === "string" && uuid.trim()) return uuid.trim();

    // Object with id-like fields
    const id = ref.id ?? ref._id ?? ref.actorId ?? ref.actorID;
    if (typeof id === "string" && id.trim()) {
      const trimmed = id.trim();
      const actor = game.actors?.get(trimmed);
      if (actor) return actor.uuid ?? `Actor.${actor.id}`;
      return `Actor.${trimmed}`;
    }

    return null;
  }

  // -----------------------------
  // 1) Context Resolve
  // -----------------------------
  static async resolveContext(payload) {
    WarehouseDebug.log(payload, "CTX", "Resolving context...");

    payload = WarehousePayloadManager.getOrCreate(payload?.meta?.initial ?? {});

    payload.ctx.userId = payload.ctx.userId ?? game.user?.id ?? null;

    // actor
    let actorDoc = await this.getActorFromUuidOrUser(payload);
    if (actorDoc?.document) actorDoc = actorDoc.document;

    if (!actorDoc) {
      payload.gates.ok = false;
      payload.gates.errors.push("No actor found (payload.ctx.actorUuid is missing and user has no linked character).");
      WarehouseDebug.error(payload, "CTX", "Failed: No actor resolved", { actorUuid: payload.ctx.actorUuid });
      ui.notifications?.error?.("Warehouse: No actor found. Link a character or pass actorUuid.");
      return payload;
    }

    payload.ctx.actorUuid = actorDoc.uuid;
    payload.ctx.actorName = actorDoc.name;

    // storage / db via DB Resolver
    const hasResolver = !!(window.FUCompanion?.api?.getCurrentGameDb);
    if (!hasResolver) {
      payload.gates.ok = false;
      payload.gates.errors.push("DB Resolver not found: window.FUCompanion.api.getCurrentGameDb is missing.");
      WarehouseDebug.error(payload, "CTX", "Failed: DB Resolver missing", {});
      ui.notifications?.error?.("Warehouse: DB Resolver missing (FUCompanion).");
      return payload;
    }

    let dbResolverResult = null;
    try {
      dbResolverResult = await window.FUCompanion.api.getCurrentGameDb();
    } catch (err) {
      payload.gates.ok = false;
      payload.gates.errors.push(`DB Resolver error: ${err?.message ?? String(err)}`);
      WarehouseDebug.error(payload, "CTX", "Failed: DB Resolver threw error", { err });
      ui.notifications?.error?.("Warehouse: DB Resolver error. See console.");
      return payload;
    }

    if (!dbResolverResult) {
      payload.gates.ok = false;
      payload.gates.errors.push("DB Resolver returned null/undefined.");
      WarehouseDebug.error(payload, "CTX", "Failed: DB Resolver returned null", {});
      ui.notifications?.error?.("Warehouse: Database Actor not found (resolver returned null).");
      return payload;
    }

    // Log the raw resolver cache shape for debugging
    WarehouseDebug.log(payload, "CTX", "DB Resolver raw result", {
      type: typeof dbResolverResult,
      keys: Object.keys(dbResolverResult || {}),
      // NOTE: This prints the whole object; useful now. We can reduce later.
      dbResolverResult
    });

    // NEW: unwrap + coerce
    const storageUuid = await this.coerceToActorUuid(dbResolverResult);

    if (!storageUuid) {
      payload.gates.ok = false;
      payload.gates.errors.push("DB Resolver returned a value that cannot be converted into an Actor UUID.");
      WarehouseDebug.error(payload, "CTX", "Failed: storageUuid is null", { dbResolverResult });
      ui.notifications?.error?.("Warehouse: Storage Actor not resolved (unexpected DB Resolver return shape).");
      return payload;
    }

    payload.ctx.storageDbUuid = storageUuid;
    payload.ctx.storageActorUuid = storageUuid;

    try {
      const storageDoc = await fromUuid(storageUuid);
      payload.ctx.storageName = storageDoc?.name ?? payload.ctx.storageName;
    } catch (_) {}

    WarehouseDebug.log(payload, "CTX", "Context resolved", {
      userId: payload.ctx.userId,
      actorUuid: payload.ctx.actorUuid,
      storageActorUuid: payload.ctx.storageActorUuid
    });

    return payload;
  }

  // -----------------------------
  // 2) Snapshot Builder
  // -----------------------------
  static async buildSnapshot(payload) {
    WarehouseDebug.log(payload, "SNAPSHOT", "Building snapshot...");

    const needsCtx = !payload?.ctx?.actorUuid || !payload?.ctx?.storageActorUuid;
    if (needsCtx) {
      await this.resolveContext(payload);
    }

    if (payload?.gates?.ok === false) {
      WarehouseDebug.warn(payload, "SNAPSHOT", "Skipped because gates.ok=false", {
        errors: payload.gates?.errors ?? []
      });
      return payload;
    }

    const actorDoc = await fromUuid(payload.ctx.actorUuid);
    const storageDoc = await fromUuid(payload.ctx.storageActorUuid);

    if (!actorDoc || !storageDoc) {
      payload.gates.ok = false;
      payload.gates.errors.push("Snapshot failed: could not resolve actor/storage documents from UUID.");
      WarehouseDebug.error(payload, "SNAPSHOT", "Failed: fromUuid returned null", {
        actorUuid: payload.ctx.actorUuid,
        storageActorUuid: payload.ctx.storageActorUuid,
        actorDocOk: !!actorDoc,
        storageDocOk: !!storageDoc
      });
      return payload;
    }

    payload.snapshot.actorZenit = this.getZenit(actorDoc);
    payload.snapshot.storageZenit = this.getZenit(storageDoc);

    const actorItems = Array.from(actorDoc.items ?? []).map((it) => this.normalizeItem(it));
    const storageItems = Array.from(storageDoc.items ?? []).map((it) => this.normalizeItem(it));

    payload.snapshot.actorItems = actorItems;
    payload.snapshot.storageItems = storageItems;
    payload.snapshot.sourceCounts = { actor: actorItems.length, storage: storageItems.length };
    payload.snapshot.normalizedAt = Date.now();

    WarehouseDebug.log(payload, "SNAPSHOT", "Snapshot built", {
      actorItems: actorItems.length,
      storageItems: storageItems.length,
      actorZenit: payload.snapshot.actorZenit,
      storageZenit: payload.snapshot.storageZenit
    });

    return payload;
  }
}
