// ============================================================================
// Camp System — Activity Registry
//
// Each activity file calls CAMP.ActivityRegistry.register(key, config).
// The config object must provide at least { execute(actor, scene) }.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][ActivityRegistry]";

  const _registry = new Map();

  CAMP.ActivityRegistry = {
    /**
     * Register an activity implementation.
     * @param {string} key - Must match a key in CAMP.ACTIVITY_DEFS
     * @param {{ execute: (actor: Actor, scene: Scene) => Promise<void> }} config
     */
    register(key, config) {
      if (_registry.has(key)) {
        console.warn(TAG, `Activity "${key}" already registered — overwriting.`);
      }
      _registry.set(key, config);
      console.debug(TAG, `Registered activity: ${key}`);
    },

    get(key) { return _registry.get(key) ?? null; },
    getAll()  { return Array.from(_registry.values()); },
    has(key)  { return _registry.has(key); },
  };

  console.debug(TAG, "Activity registry loaded.");
})();
