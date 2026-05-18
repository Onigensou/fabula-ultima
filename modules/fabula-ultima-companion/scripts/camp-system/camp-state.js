// ============================================================================
// Camp System — State Management (World Settings)
//
// All persistent camp state lives in world settings so it survives refreshes
// and syncs to all clients via Foundry's built-in updateSetting hook.
// Only the GM can write world settings; players request changes via socket.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const MOD  = CAMP.MODULE_ID;
  const TAG  = "[CampSystem][State]";

  // ---------------------------------------------------------------------------
  // Registration (called once on ready)
  // ---------------------------------------------------------------------------
  function registerSettings() {
    const defs = [
      { key: CAMP.SETTING.PHASE,               type: String,  default: CAMP.PHASE.FREE_ROAM },
      { key: CAMP.SETTING.READY,               type: String,  default: "{}" },
      { key: CAMP.SETTING.SELECTIONS,          type: String,  default: "{}" },
      { key: CAMP.SETTING.RESOLVED,            type: String,  default: "{}" },
      { key: CAMP.SETTING.BOND_CONFIRMED,      type: String,  default: "{}" },
      { key: CAMP.SETTING.BOND_SUMMARY,        type: String,  default: "{}" },
      { key: CAMP.SETTING.SLEEP_READY,         type: String,  default: "{}" },
      { key: CAMP.SETTING.SET_OUT_READY,       type: String,  default: "{}" },
      { key: CAMP.SETTING.EXPLORATION_DEBUFFS, type: String,  default: "{}" },
    ];

    for (const { key, type, default: def } of defs) {
      try {
        game.settings.register(MOD, key, {
          scope: "world",
          config: false,
          type,
          default: def,
        });
      } catch { /* already registered */ }
    }
    console.debug(TAG, "Settings registered.");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function getJSON(key) {
    try { return JSON.parse(game.settings.get(MOD, key) ?? "{}"); }
    catch { return {}; }
  }

  async function setJSON(key, value) {
    if (!game.user?.isGM) { console.warn(TAG, "setJSON called by non-GM:", key); return; }
    await game.settings.set(MOD, key, JSON.stringify(value));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.State = {
    // ── Phase ──────────────────────────────────────────────────────────────
    getPhase() {
      return game.settings.get(MOD, CAMP.SETTING.PHASE) ?? CAMP.PHASE.FREE_ROAM;
    },
    async setPhase(phase) {
      await game.settings.set(MOD, CAMP.SETTING.PHASE, phase);
    },

    // ── Activity-lobby ready ────────────────────────────────────────────────
    getReady() { return getJSON(CAMP.SETTING.READY); },
    async toggleReady(userId) {
      const map = this.getReady();
      if (map[userId]) delete map[userId]; else map[userId] = true;
      await setJSON(CAMP.SETTING.READY, map);
      return map;
    },
    async clearReady() { await setJSON(CAMP.SETTING.READY, {}); },
    isAllReady(activeUserIds) {
      const map = this.getReady();
      return activeUserIds.length > 0 && activeUserIds.every(id => map[id]);
    },

    // ── Activity selections ─────────────────────────────────────────────────
    getSelections() { return getJSON(CAMP.SETTING.SELECTIONS); },
    async setLocked(actorId, activityKey) {
      const sel = this.getSelections();
      // Check uniqueness — no two actors can lock the same activity
      for (const [id, entry] of Object.entries(sel)) {
        if (id !== actorId && entry.locked === activityKey) return { ok: false, reason: "taken" };
      }
      sel[actorId] = { locked: activityKey, lockedAt: Date.now() };
      await setJSON(CAMP.SETTING.SELECTIONS, sel);
      return { ok: true };
    },
    async clearLocked(actorId) {
      const sel = this.getSelections();
      if (sel[actorId]) { sel[actorId].locked = null; sel[actorId].lockedAt = null; }
      await setJSON(CAMP.SETTING.SELECTIONS, sel);
    },
    async clearSelections() { await setJSON(CAMP.SETTING.SELECTIONS, {}); },
    isActivityLocked(activityKey) {
      return Object.values(this.getSelections()).some(e => e.locked === activityKey);
    },
    getLockedByActor(actorId) {
      return this.getSelections()[actorId]?.locked ?? null;
    },
    isAllLocked(activeActorIds) {
      const sel = this.getSelections();
      return activeActorIds.length > 0 && activeActorIds.every(id => sel[id]?.locked);
    },
    getOrderedResolutions() {
      return Object.entries(this.getSelections())
        .filter(([, e]) => e.locked)
        .sort(([, a], [, b]) => (a.lockedAt ?? 0) - (b.lockedAt ?? 0))
        .map(([actorId, e]) => ({ actorId, activityKey: e.locked }));
    },

    // ── Activity resolved ───────────────────────────────────────────────────
    getResolved() { return getJSON(CAMP.SETTING.RESOLVED); },
    async markResolved(actorId) {
      const r = this.getResolved();
      r[actorId] = true;
      await setJSON(CAMP.SETTING.RESOLVED, r);
    },
    async clearResolved() { await setJSON(CAMP.SETTING.RESOLVED, {}); },
    isAllResolved(activeActorIds) {
      const r = this.getResolved();
      return activeActorIds.length > 0 && activeActorIds.every(id => r[id]);
    },

    // ── Bond confirmed ──────────────────────────────────────────────────────
    getBondConfirmed() { return getJSON(CAMP.SETTING.BOND_CONFIRMED); },
    async setBondConfirmed(userId, summary) {
      const confirmed = this.getBondConfirmed();
      confirmed[userId] = true;
      await setJSON(CAMP.SETTING.BOND_CONFIRMED, confirmed);
      // Merge summary into BOND_SUMMARY
      const allSummaries = getJSON(CAMP.SETTING.BOND_SUMMARY);
      if (summary?.actorId) allSummaries[summary.actorId] = summary;
      await setJSON(CAMP.SETTING.BOND_SUMMARY, allSummaries);
    },
    async clearBondConfirmed() {
      await setJSON(CAMP.SETTING.BOND_CONFIRMED, {});
      await setJSON(CAMP.SETTING.BOND_SUMMARY, {});
    },
    async clearBondConfirmedForUser(userId) {
      const c = this.getBondConfirmed();
      delete c[userId];
      await setJSON(CAMP.SETTING.BOND_CONFIRMED, c);
    },
    isAllBondConfirmed(activeUserIds) {
      const c = this.getBondConfirmed();
      return activeUserIds.length > 0 && activeUserIds.every(id => c[id]);
    },
    getBondSummary() { return getJSON(CAMP.SETTING.BOND_SUMMARY); },

    // ── Sleep lobby ready ───────────────────────────────────────────────────
    getSleepReady() { return getJSON(CAMP.SETTING.SLEEP_READY); },
    async toggleSleepReady(userId) {
      const map = this.getSleepReady();
      if (map[userId]) delete map[userId]; else map[userId] = true;
      await setJSON(CAMP.SETTING.SLEEP_READY, map);
    },
    async clearSleepReady() { await setJSON(CAMP.SETTING.SLEEP_READY, {}); },
    isAllSleepReady(activeUserIds) {
      const m = this.getSleepReady();
      return activeUserIds.length > 0 && activeUserIds.every(id => m[id]);
    },

    // ── Exploration debuffs ─────────────────────────────────────────────────
    getExplorationDebuffs() { return getJSON(CAMP.SETTING.EXPLORATION_DEBUFFS); },
    async setExplorationDebuff(actorId, debuff) {
      const d = this.getExplorationDebuffs();
      d[actorId] = { ...(d[actorId] ?? {}), ...debuff };
      await setJSON(CAMP.SETTING.EXPLORATION_DEBUFFS, d);
    },
    async clearExplorationDebuffs() { await setJSON(CAMP.SETTING.EXPLORATION_DEBUFFS, {}); },

    // ── Set Out lobby ready ─────────────────────────────────────────────────
    getSetOutReady() { return getJSON(CAMP.SETTING.SET_OUT_READY); },
    async toggleSetOutReady(userId) {
      const map = this.getSetOutReady();
      if (map[userId]) delete map[userId]; else map[userId] = true;
      await setJSON(CAMP.SETTING.SET_OUT_READY, map);
    },
    async clearSetOutReady() { await setJSON(CAMP.SETTING.SET_OUT_READY, {}); },
    isAllSetOutReady(activeUserIds) {
      const m = this.getSetOutReady();
      return activeUserIds.length > 0 && activeUserIds.every(id => m[id]);
    },

    // ── Full reset (called when camp cycle completes) ───────────────────────
    async reset() {
      if (!game.user?.isGM) return;
      await game.settings.set(MOD, CAMP.SETTING.PHASE, CAMP.PHASE.FREE_ROAM);
      await setJSON(CAMP.SETTING.READY, {});
      await setJSON(CAMP.SETTING.SELECTIONS, {});
      await setJSON(CAMP.SETTING.RESOLVED, {});
      await setJSON(CAMP.SETTING.BOND_CONFIRMED, {});
      await setJSON(CAMP.SETTING.BOND_SUMMARY, {});
      await setJSON(CAMP.SETTING.SLEEP_READY, {});
      await setJSON(CAMP.SETTING.SET_OUT_READY, {});
      await setJSON(CAMP.SETTING.EXPLORATION_DEBUFFS, {});
      console.debug(TAG, "State reset to FREE_ROAM.");
    },
  };

  // Register settings once the game is ready
  Hooks.once("ready", () => registerSettings());

  console.debug(TAG, "State module loaded.");
})();
