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
      { key: CAMP.SETTING.SAVE_CHOICE,         type: String,  default: "{}" },
      { key: CAMP.SETTING.RETURN_POINT,        type: String,  default: "{}" },
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

  // One read-modify-write at a time. A setting's new value only lands locally
  // once the server answers, so two presses in the same round trip would both
  // start from the old map and the second write would drop the first press.
  let _writes = Promise.resolve();
  function serial(fn) {
    const next = _writes.catch(() => {}).then(fn);
    _writes = next;
    return next;
  }

  // ready: true/false sets the entry; undefined flips it.
  function setInMap(key, userId, ready) {
    return serial(async () => {
      const map  = getJSON(key);
      const want = ready ?? !map[userId];
      if (!!map[userId] === !!want) return map;
      if (want) map[userId] = true; else delete map[userId];
      await setJSON(key, map);
      return map;
    });
  }

  const clearMap = (key) => serial(() => setJSON(key, {}));

  // Maps that must start empty when a phase is entered, however it was entered
  // (Start, a Force button, the GM panel's arrows).
  function mapsToClearOnEntry(phase) {
    const P = CAMP.PHASE, S = CAMP.SETTING;
    switch (phase) {
      case P.FREE_ROAM:
      case P.ACTIVITY_SELECT:  return [S.READY];
      case P.ACTIVITY_RESOLVE: return [S.READY, S.RESOLVED];
      case P.SLEEP_LOBBY:
      case P.SLEEPING:         return [S.SLEEP_READY];
      case P.SET_OUT_LOBBY:
      case P.SETTING_OUT:      return [S.SET_OUT_READY];
      default:                 return [];
    }
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
      if (phase !== this.getPhase()) {
        for (const key of mapsToClearOnEntry(phase)) {
          if (Object.keys(getJSON(key)).length) await clearMap(key);
        }
      }
      await game.settings.set(MOD, CAMP.SETTING.PHASE, phase);
    },

    // ── Activity-lobby ready ────────────────────────────────────────────────
    getReady() { return getJSON(CAMP.SETTING.READY); },
    setReady(userId, ready) { return setInMap(CAMP.SETTING.READY, userId, ready); },
    toggleReady(userId) { return this.setReady(userId); },
    clearReady() { return clearMap(CAMP.SETTING.READY); },
    isAllReady(activeUserIds) {
      const map = this.getReady();
      return activeUserIds.length > 0 && activeUserIds.every(id => map[id]);
    },

    // ── Activity selections ─────────────────────────────────────────────────
    getSelections() { return getJSON(CAMP.SETTING.SELECTIONS); },
    setLocked(actorId, activityKey) {
      return serial(async () => {
        const sel = this.getSelections();
        // Check uniqueness — no two actors can lock the same activity
        for (const [id, entry] of Object.entries(sel)) {
          if (id !== actorId && entry.locked === activityKey) return { ok: false, reason: "taken" };
        }
        sel[actorId] = { locked: activityKey, lockedAt: Date.now() };
        await setJSON(CAMP.SETTING.SELECTIONS, sel);
        return { ok: true };
      });
    },
    clearLocked(actorId) {
      return serial(async () => {
        const sel = this.getSelections();
        if (sel[actorId]) { sel[actorId].locked = null; sel[actorId].lockedAt = null; }
        await setJSON(CAMP.SETTING.SELECTIONS, sel);
      });
    },
    clearSelections() { return clearMap(CAMP.SETTING.SELECTIONS); },
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
    markResolved(actorId) { return setInMap(CAMP.SETTING.RESOLVED, actorId, true); },
    clearResolved() { return clearMap(CAMP.SETTING.RESOLVED); },
    isAllResolved(activeActorIds) {
      const r = this.getResolved();
      return activeActorIds.length > 0 && activeActorIds.every(id => r[id]);
    },

    // ── Bond confirmed ──────────────────────────────────────────────────────
    getBondConfirmed() { return getJSON(CAMP.SETTING.BOND_CONFIRMED); },
    setBondConfirmed(userId, summary) {
      return serial(async () => {
        // Merge summary into BOND_SUMMARY first: the confirm is what lets the
        // phase advance, and the summary screen reads this map.
        const allSummaries = getJSON(CAMP.SETTING.BOND_SUMMARY);
        if (summary?.actorId) allSummaries[summary.actorId] = summary;
        await setJSON(CAMP.SETTING.BOND_SUMMARY, allSummaries);
        const confirmed = this.getBondConfirmed();
        confirmed[userId] = true;
        await setJSON(CAMP.SETTING.BOND_CONFIRMED, confirmed);
      });
    },
    clearBondConfirmed() {
      return serial(async () => {
        await setJSON(CAMP.SETTING.BOND_CONFIRMED, {});
        await setJSON(CAMP.SETTING.BOND_SUMMARY, {});
      });
    },
    clearBondConfirmedForUser(userId) { return setInMap(CAMP.SETTING.BOND_CONFIRMED, userId, false); },
    isAllBondConfirmed(activeUserIds) {
      const c = this.getBondConfirmed();
      return activeUserIds.length > 0 && activeUserIds.every(id => c[id]);
    },
    getBondSummary() { return getJSON(CAMP.SETTING.BOND_SUMMARY); },

    // ── Sleep lobby ready ───────────────────────────────────────────────────
    getSleepReady() { return getJSON(CAMP.SETTING.SLEEP_READY); },
    setSleepReady(userId, ready) { return setInMap(CAMP.SETTING.SLEEP_READY, userId, ready); },
    toggleSleepReady(userId) { return this.setSleepReady(userId); },
    clearSleepReady() { return clearMap(CAMP.SETTING.SLEEP_READY); },
    isAllSleepReady(activeUserIds) {
      const m = this.getSleepReady();
      return activeUserIds.length > 0 && activeUserIds.every(id => m[id]);
    },

    // ── Exploration debuffs ─────────────────────────────────────────────────
    getExplorationDebuffs() { return getJSON(CAMP.SETTING.EXPLORATION_DEBUFFS); },
    setExplorationDebuff(actorId, debuff) {
      return serial(async () => {
        const d = this.getExplorationDebuffs();
        d[actorId] = { ...(d[actorId] ?? {}), ...debuff };
        await setJSON(CAMP.SETTING.EXPLORATION_DEBUFFS, d);
      });
    },
    clearExplorationDebuffs() { return clearMap(CAMP.SETTING.EXPLORATION_DEBUFFS); },

    // ── Rest-time save choice ───────────────────────────────────────────────
    getSaveChoice() {
      return { ...CAMP.SAVE_CHOICE_EMPTY, ...getJSON(CAMP.SETTING.SAVE_CHOICE) };
    },
    setSaveChoice(patch) {
      return serial(() => setJSON(CAMP.SETTING.SAVE_CHOICE, { ...this.getSaveChoice(), ...patch }));
    },
    clearSaveChoice() { return clearMap(CAMP.SETTING.SAVE_CHOICE); },

    // ── Landing phase (see CAMP.LANDING_PHASE) ──────────────────────────────
    // Where a save taken during `phase` should resume. Unknown/absent phases
    // map to themselves, so a new phase is safe by default and only needs an
    // entry once it becomes a one-shot animation.
    landingPhaseFor(phase) {
      const p = phase ?? CAMP.PHASE.FREE_ROAM;
      return CAMP.LANDING_PHASE[p] ?? p;
    },

    // ── Set Out lobby ready ─────────────────────────────────────────────────
    getSetOutReady() { return getJSON(CAMP.SETTING.SET_OUT_READY); },
    setSetOutReady(userId, ready) { return setInMap(CAMP.SETTING.SET_OUT_READY, userId, ready); },
    toggleSetOutReady(userId) { return this.setSetOutReady(userId); },
    clearSetOutReady() { return clearMap(CAMP.SETTING.SET_OUT_READY); },
    isAllSetOutReady(activeUserIds) {
      const m = this.getSetOutReady();
      return activeUserIds.length > 0 && activeUserIds.every(id => m[id]);
    },

    // ── Return point (see CAMP.SETTING.RETURN_POINT) ────────────────────────
    // null when nothing usable is recorded.
    getReturnPoint() {
      const p = getJSON(CAMP.SETTING.RETURN_POINT);
      return p?.sceneId ? p : null;
    },
    async setReturnPoint(point) { await setJSON(CAMP.SETTING.RETURN_POINT, point ?? {}); },

    // ── Full reset (called when camp cycle completes) ───────────────────────
    // Clears the return point too: a finished Set Out has used it, and a fresh
    // entry records its own right after resetting.
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
      await setJSON(CAMP.SETTING.SAVE_CHOICE, {});
      await setJSON(CAMP.SETTING.RETURN_POINT, {});
      console.debug(TAG, "State reset to FREE_ROAM.");
    },
  };

  // Register settings once the game is ready
  Hooks.once("ready", () => registerSettings());

  console.debug(TAG, "State module loaded.");
})();
