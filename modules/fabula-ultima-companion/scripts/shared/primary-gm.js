// ============================================================================
// Shared — Primary GM gate (multi-GM dedupe)
//
// This game normally runs two GM clients (main GM + Co-DM). Anything delivered
// over raw game.socket arrives at BOTH of them, so a handler gated only on
// `game.user.isGM` runs twice. For read-only handlers that is noise; for
// handlers that WRITE (document updates, save/load) it is data corruption.
//
// `isPrimaryGM()` returns true on exactly one connected GM: core's
// `game.users.activeGM` (the lowest-id active GM), with an id-sort fallback for
// cores that lack it. Note it returns true for a lone GM and false for every
// player, so `if (!isPrimaryGM()) return;` is a complete gate on its own.
//
// This is Idiom A of the GM Host / Anti-Dedupe pattern. Copies of this function
// predate the shared helper in dp-constants.js, healing-socket.js,
// opportunity-manager.js, armor-equip-gate.js, set-bonus-hooks.js and
// matador-cape-crisis-def-solver.js; new callers should use this one.
//
// NOTE: socketlib's executeAsGM already routes to a single GM. Only raw
// game.socket handlers and directly-invoked GM-side APIs need this gate.
// ============================================================================
(() => {
  globalThis.FUCompanion     = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  function isPrimaryGM() {
    if (!game.user?.isGM) return false;
    const active = game.users?.activeGM ?? null;
    if (active) return active.id === game.user.id;
    const firstGM = game.users
      ?.filter?.(u => u.isGM && u.active)
      ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0];
    return firstGM ? firstGM.id === game.user.id : true;
  }

  // The GM that IS the primary — for building "ask <name> to do it" messages.
  // Returns null when no GM is connected.
  function primaryGM() {
    const active = game.users?.activeGM ?? null;
    if (active) return active;
    return game.users
      ?.filter?.(u => u.isGM && u.active)
      ?.sort?.((a, b) => String(a.id).localeCompare(String(b.id)))?.[0] ?? null;
  }

  globalThis.FUCompanion.isPrimaryGM = isPrimaryGM;
  globalThis.FUCompanion.primaryGM   = primaryGM;

  console.debug("[Shared][PrimaryGM] Helper loaded.");
})();
