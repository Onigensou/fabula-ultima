// ============================================================================
// Camp System — Socket Handler
//
// All camp messages share the raw game.socket channel used by other systems
// (module.fabula-ultima-companion). Camp messages are identified by their
// CAMP_* type prefix so they don't collide with DP system messages.
//
// Architecture:
//  - Players emit requests to the GM (TOGGLE_READY, LOCK_ACTIVITY, etc.)
//  - GM processes requests, updates world settings, Foundry broadcasts
//    updateSetting to all clients automatically.
//  - Hover state is ephemeral: broadcast to all directly (no persistence).
// ============================================================================
(() => {
  const CAMP    = globalThis.CampSystem ??= {};
  const TAG     = "[CampSystem][Socket]";
  const GUARD   = "__ONI_CAMP_SOCKET__";

  CAMP.Socket = {
    // ── Emit a request to the GM ──────────────────────────────────────────
    emit(type, payload = {}) {
      game.socket.emit(CAMP.SOCKET_CH, { type, payload });
    },

    // ── Broadcast to all clients (GM only) ───────────────────────────────
    broadcast(type, payload = {}) {
      if (!game.user?.isGM) return;
      game.socket.emit(CAMP.SOCKET_CH, { type, payload });
    },

    // ── Install listener (called on ready) ───────────────────────────────
    setup() {
      if (window[GUARD]) return;
      window[GUARD] = true;

      game.socket.on(CAMP.SOCKET_CH, async (msg) => {
        const { type, payload } = msg ?? {};
        if (!type?.startsWith("CAMP_")) return; // not our message

        // ── Ephemeral: hover (any client, processed by all) ──────────────
        if (type === CAMP.MSG.HOVER_ACTIVITY) {
          CAMP.ActivitySelectUI?.onRemoteHover?.(payload?.actorId, payload?.activityKey);
          return;
        }

        // ── GM-only: state mutation requests ────────────────────────────
        if (!game.user?.isGM) return;

        switch (type) {
          case CAMP.MSG.TOGGLE_READY:
            await _handleToggleReady(payload);
            break;

          case CAMP.MSG.LOCK_ACTIVITY:
            await _handleLockActivity(payload);
            break;

          case CAMP.MSG.UNLOCK_ACTIVITY:
            await _handleUnlockActivity(payload);
            break;

          case CAMP.MSG.CONFIRM_BOND:
            await _handleConfirmBond(payload);
            break;

          case CAMP.MSG.UNCONFIRM_BOND:
            await _handleUnconfirmBond(payload);
            break;

          case CAMP.MSG.ACTIVITY_DONE:
            await _handleActivityDone(payload);
            break;

          case CAMP.MSG.TOGGLE_SLEEP:
            await _handleToggleSleep(payload);
            break;

          case CAMP.MSG.TOGGLE_SET_OUT:
            await _handleToggleSetOut(payload);
            break;
        }
      });

      console.debug(TAG, "Socket listener installed.");
    },
  };

  // ---------------------------------------------------------------------------
  // GM-side handlers
  // ---------------------------------------------------------------------------

  async function _handleToggleReady({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.toggleReady(userId);

    // In ACTIVITY_SELECT: auto-advance when all active players have confirmed
    if (CAMP.State.getPhase() === CAMP.PHASE.ACTIVITY_SELECT) {
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      const readyMap    = CAMP.State.getReady();
      if (activeUsers.length > 0 && activeUsers.every(u => readyMap[u.id])) {
        await CAMP.State.clearReady();
        await CAMP.State.setPhase(CAMP.PHASE.ACTIVITY_RESOLVE);
      }
    }
  }

  async function _handleLockActivity({ actorId, activityKey } = {}) {
    if (!actorId || !activityKey) return;
    const res = await CAMP.State.setLocked(actorId, activityKey);
    if (!res.ok) return; // taken by another actor
    // Check if all party members have locked
    const party    = await CAMP.Party.resolve();
    const actorIds = party.map(e => e.actorId);
    if (CAMP.State.isAllLocked(actorIds)) {
      await CAMP.State.setPhase(CAMP.PHASE.ACTIVITY_RESOLVE);
    }
  }

  async function _handleUnlockActivity({ actorId } = {}) {
    if (!actorId) return;
    await CAMP.State.clearLocked(actorId);
  }

  async function _handleUnconfirmBond({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.clearBondConfirmedForUser(userId);
    // Refresh the GM lobby dots
    const dots = document.getElementById("oni-camp-bond-wait-dots");
    if (dots) {
      const confirmed   = CAMP.State.getBondConfirmed();
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      dots.innerHTML = activeUsers.map(u => {
        const r = !!confirmed[u.id];
        return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${u.name}"></div>`;
      }).join("");
    }
  }

  async function _handleConfirmBond({ userId, summary } = {}) {
    if (!userId) return;
    await CAMP.State.setBondConfirmed(userId, summary);

    // Refresh the GM lobby dots if the wait overlay is showing
    const dots = document.getElementById("oni-camp-bond-wait-dots");
    if (dots) {
      const confirmed   = CAMP.State.getBondConfirmed?.() ?? {};
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      dots.innerHTML = activeUsers.map(u => {
        const r = !!confirmed[u.id];
        return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${u.name}"></div>`;
      }).join("");
    }

    // Auto-advance when all active players have confirmed
    const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
    if (activeUsers.length === 0 || CAMP.State.isAllBondConfirmed(activeUsers.map(u => u.id))) {
      await CAMP.State.setPhase(CAMP.PHASE.BOND_SUMMARY);
    }
  }

  async function _handleActivityDone({ actorId } = {}) {
    if (!actorId) return;
    await CAMP.State.markResolved(actorId);
    // Use the locked actor IDs from selections as the source of truth
    const sel = CAMP.State.getSelections();
    const lockedActorIds = Object.keys(sel).filter(id => sel[id]?.locked);
    if (lockedActorIds.length > 0 && CAMP.State.isAllResolved(lockedActorIds)) {
      await CAMP.State.clearResolved();
      await CAMP.State.setPhase(CAMP.PHASE.BOND_UPDATE);
    }
  }

  async function _handleToggleSleep({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.toggleSleepReady(userId);
  }

  async function _handleToggleSetOut({ userId } = {}) {
    if (!userId) return;
    await CAMP.State.toggleSetOutReady(userId);
  }

  // Install on ready
  Hooks.once("ready", () => CAMP.Socket.setup());

  console.debug(TAG, "Socket module loaded.");
})();
