// scripts/db-resolver.js
// ──────────────────────────────────────────────────────────────
// Global: Current-Game → Database Actor Resolver (Foundry v12)
// Exposes: window.FUCompanion.api.getCurrentGameDb()
//          window.FUCompanion.api.refreshGameDbCache()
//          window.FUCompanion.api.getCurrentGameNameSync()
// ──────────────────────────────────────────────────────────────
(() => {
  // 1) CONSTANT: your “Current Game” actor UUID (or keep placeholder)
  //    You can put either "Actor.<id>" or just the raw actor id here.
  const CURRENT_GAME_ACTOR_UUID = "Actor.DMpK5Bi119jIrCFZ"; // ← replace if needed

  // 2) Ensure namespace
  window.FUCompanion = window.FUCompanion || { api: {} };
  const API = window.FUCompanion.api;

  // 3) Small internal cache to avoid re-resolving every time
  //    cache.shape: { db, dbUuid, gameName, source, rawGameId, ts }
  let _cache = null;

  // Helper: safely read nested properties
  function _gp(obj, path) {
    try {
      return foundry.utils.getProperty(obj, path);
    } catch {
      return undefined;
    }
  }

  // Helper: resolve an Actor from raw (id or UUID)
  async function _resolveActorFromRaw(raw) {
    if (!raw || typeof raw !== "string") return { actor: null, uuid: null };
    const trimmed = raw.trim();

    // If it looks like a UUID already ("Actor.<id>")
    if (/^\s*Actor\./i.test(trimmed)) {
      const actor = await fromUuid(trimmed).catch(() => null);
      return { actor, uuid: actor ? trimmed : null };
    }

    // Otherwise try plain ID → game.actors → fallback to fromUuid
    const byId = game.actors?.get(trimmed);
    if (byId) return { actor: byId, uuid: `Actor.${byId.id}` };

    const byUuid = await fromUuid(`Actor.${trimmed}`).catch(() => null);
    return { actor: byUuid, uuid: byUuid ? `Actor.${byUuid.id}` : null };
  }

  // Helper: optional token override (if a token with same name as DB is on the canvas)
  function _tokenOverrideFor(actor) {
    const tok = canvas?.tokens?.placeables?.find(t => t?.name === actor?.name);
    return tok?.actor ?? actor;
  }

  // 4) Core resolver (no caching)
  async function _resolveNow() {
    // a) Load the “Current Game” sheet
    const cg = await fromUuid(CURRENT_GAME_ACTOR_UUID).catch(() => null);
    if (!cg) {
      ui.notifications?.error("Current Game sheet not found. Check CURRENT_GAME_ACTOR_UUID in db-resolver.js.");
      return null;
    }

    // b) Read the DB id/uuid string from the sheet
    //    Expected: cg.system.props.game_id holds either "<id>" or "Actor.<id>"
    const rawGameId = String(_gp(cg, "system.props.game_id") ?? "").trim();
    if (!rawGameId) {
      ui.notifications?.error("Set system.props.game_id on the Current Game sheet.");
      return null;
    }

    // c) Resolve the Database Actor
    const { actor: db, uuid: dbUuid } = await _resolveActorFromRaw(rawGameId);
    if (!db) {
      ui.notifications?.error(`Database actor not found: ${rawGameId}`);
      return null;
    }

    // d) Optional token override for per-scene custom props
    const source = _tokenOverrideFor(db);

    // e) Game name comes from DB (fallback to actor name)
    const gameName = _gp(db, "system.props.game_name") || db.name || "Game";

    return { db, dbUuid, gameName, source, rawGameId, ts: Date.now() };
  }

  // 5) Public: get current DB (cached, but auto-refreshes if Current Game changed)
  API.getCurrentGameDb = async function getCurrentGameDb() {
    const cg = await fromUuid(CURRENT_GAME_ACTOR_UUID).catch(() => null);
    const liveRawGameId = String(_gp(cg, "system.props.game_id") ?? "").trim();

    // Use cache only if it still matches the Current Game sheet.
    if (
      _cache?.db &&
      _cache?.dbUuid &&
      _cache?.rawGameId === liveRawGameId
    ) {
      return _cache;
    }

    // If Current Game changed, rebuild cache automatically.
    if (_cache?.rawGameId && _cache.rawGameId !== liveRawGameId) {
      console.warn("[DB-Resolver] Cache stale; refreshing.", {
        cachedRawGameId: _cache.rawGameId,
        liveRawGameId
      });
    }

    _cache = await _resolveNow();
    return _cache ?? { db: null, dbUuid: null, gameName: null, source: null };
  };

  // 6) Public: force refresh (e.g., if you changed “Current Game” mid-session)
  API.refreshGameDbCache = async function refreshGameDbCache() {
    _cache = await _resolveNow();
    return _cache ?? { db: null, dbUuid: null, gameName: null, source: null };
  };

  // 7) Public (sync): quick name read if cached
  API.getCurrentGameNameSync = function getCurrentGameNameSync() {
    return _cache?.gameName ?? null;
  };

  // 8) Warm the cache once the world is ready (non-blocking)
  Hooks.once("ready", async () => { await API.refreshGameDbCache(); });
})();
