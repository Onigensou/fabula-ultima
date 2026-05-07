/**
 * remote-choice-api.js
 * Foundry V12
 *
 * What this does:
 * - Exposes: game.modules.get("fabula-ultima-companion").api.RemoteChoice
 * - Lets one client request a button-choice dialog on another client
 * - Waits for that other client to answer, then resolves back to the requester
 *
 * Return shape:
 *   { id, label, value }  OR  null
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NAME = `module.${MODULE_ID}`;
  const TAG = "[ONI][RemoteChoice]";
  const DEBUG = true;

  const STATE_KEY = "__ONI_REMOTE_CHOICE_STATE__";
  const state = globalThis[STATE_KEY] ||= {
    socketBound: false,
    apiBound: false,
    pending: new Map(),      // requestId -> { resolve, timer, createdAt, cfg }
    openDialogs: new Map()   // requestId -> Dialog
  };

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const err = (...a) => DEBUG && console.error(TAG, ...a);

  function nowMs() {
    return Date.now();
  }

  function buildRequestId(prefix = "RC") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function str(v, fallback = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : fallback;
  }

  function toInt(v, fallback = 0) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function deepClone(obj, fallback = {}) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(obj ?? fallback);
      return JSON.parse(JSON.stringify(obj ?? fallback));
    } catch {
      return fallback;
    }
  }

  function sanitizeChoices(choices = []) {
    return (Array.isArray(choices) ? choices : [])
      .map((c) => ({
        id: str(c?.id),
        label: str(c?.label ?? c?.id),
        value: c?.value
      }))
      .filter((c) => c.id);
  }

  function normalizeConfig(cfg = {}) {
    return {
      userId: str(cfg?.userId ?? cfg?.targetUserId ?? game.user?.id),
      requesterUserId: str(cfg?.requesterUserId ?? game.user?.id),
      title: str(cfg?.title, "Choose"),
      bodyHtml: String(cfg?.bodyHtml ?? ""),
      choices: sanitizeChoices(cfg?.choices),
      cancelLabel: str(cfg?.cancelLabel, "Cancel"),
      timeoutMs: Math.max(1000, toInt(cfg?.timeoutMs, 120000)),
      width: Math.max(280, toInt(cfg?.width, 420)),
      metadata: deepClone(cfg?.metadata ?? {}, {})
    };
  }

  function getModuleApiRoot() {
    const mod = game.modules?.get(MODULE_ID);
    if (!mod) return null;
    mod.api ||= {};
    return mod.api;
  }

  function emitSocket(payload) {
    game.socket.emit(SOCKET_NAME, payload);
  }

  async function openLocalChoiceDialog(cfg = {}, envelope = {}) {
    const requestId = str(envelope?.requestId, buildRequestId("LOCAL"));
    const title = str(cfg?.title, "Choose");
    const bodyHtml = String(cfg?.bodyHtml ?? "");
    const choices = sanitizeChoices(cfg?.choices);
    const cancelLabel = str(cfg?.cancelLabel, "Cancel");
    const width = Math.max(280, toInt(cfg?.width, 420));

    log("OPEN LOCAL DIALOG", {
      requestId,
      currentUserId: game.user?.id ?? null,
      title,
      choicesCount: choices.length,
      remote: !!envelope?.remote
    });

    return await new Promise((resolve) => {
      let done = false;

      const safeResolve = (val) => {
        if (done) return;
        done = true;

        const existing = state.openDialogs.get(requestId);
        if (existing) state.openDialogs.delete(requestId);

        resolve(val);
      };

      const buttons = {};

      for (const c of choices) {
        buttons[c.id] = {
          label: String(c.label ?? c.id),
          callback: () => {
            log("LOCAL CHOICE CLICK", {
              requestId,
              pickedId: c.id,
              pickedValue: c.value
            });

            safeResolve({
              id: c.id,
              label: String(c.label ?? c.id),
              value: c.value
            });
          }
        };
      }

      buttons.__cancel = {
        label: cancelLabel,
        callback: () => {
          log("LOCAL CHOICE CANCEL", { requestId });
          safeResolve(null);
        }
      };

      const dialog = new Dialog({
        title,
        content: `
          <div style="display:flex; flex-direction:column; gap:.5rem;">
            ${bodyHtml}
            <p style="margin:0; opacity:.75; font-size:12px;">
              ${envelope?.remote ? "(Waiting for this player's answer...)" : "(Waiting for your choice...)"}
            </p>
          </div>
        `,
        buttons,
        default: choices?.[0]?.id ? String(choices[0].id) : "__cancel",
        close: () => {
          log("LOCAL DIALOG CLOSED", { requestId });
          safeResolve(null);
        }
      }, {
        width
      });

      state.openDialogs.set(requestId, dialog);
      dialog.render(true);
    });
  }

  async function handleSocketRequest(packet) {
    const targetUserId = str(packet?.targetUserId);
    const requesterUserId = str(packet?.requesterUserId);
    const requestId = str(packet?.requestId);

    if (!requestId || !targetUserId) return;
    if (String(game.user?.id) !== targetUserId) return;

    const cfg = normalizeConfig(packet?.cfg ?? {});
    log("SOCKET REQUEST RECEIVED", {
      requestId,
      requesterUserId,
      targetUserId,
      currentUserId: game.user?.id ?? null,
      title: cfg.title,
      choicesCount: cfg.choices.length
    });

    let result = null;

    try {
      result = await openLocalChoiceDialog(cfg, {
        requestId,
        remote: true
      });
    } catch (e) {
      err("REMOTE DIALOG FAILED", { requestId, error: e });
      result = null;
    }

    try {
      emitSocket({
        ns: "oni.remoteChoice",
        type: "response",
        requestId,
        requesterUserId,
        responderUserId: game.user?.id ?? null,
        result
      });

      log("SOCKET RESPONSE SENT", {
        requestId,
        requesterUserId,
        responderUserId: game.user?.id ?? null,
        result
      });
    } catch (e) {
      err("FAILED TO SEND REMOTE RESPONSE", { requestId, error: e });
    }
  }

  function handleSocketResponse(packet) {
    const requesterUserId = str(packet?.requesterUserId);
    const requestId = str(packet?.requestId);

    if (!requestId || !requesterUserId) return;
    if (String(game.user?.id) !== requesterUserId) return;

    const pending = state.pending.get(requestId);
    if (!pending) {
      warn("RESPONSE RECEIVED FOR UNKNOWN REQUEST", {
        requestId,
        requesterUserId,
        currentUserId: game.user?.id ?? null
      });
      return;
    }

    clearTimeout(pending.timer);
    state.pending.delete(requestId);

    log("SOCKET RESPONSE RECEIVED", {
      requestId,
      responderUserId: packet?.responderUserId ?? null,
      result: packet?.result ?? null
    });

    pending.resolve(packet?.result ?? null);
  }

  function handleSocketCancel(packet) {
    const targetUserId = str(packet?.targetUserId);
    const requestId = str(packet?.requestId);

    if (!requestId || !targetUserId) return;
    if (String(game.user?.id) !== targetUserId) return;

    const dialog = state.openDialogs.get(requestId);
    if (!dialog) return;

    log("SOCKET CANCEL RECEIVED", {
      requestId,
      targetUserId,
      currentUserId: game.user?.id ?? null
    });

    try {
      dialog.close();
    } catch (e) {
      err("FAILED TO CLOSE REMOTE DIALOG", { requestId, error: e });
    } finally {
      state.openDialogs.delete(requestId);
    }
  }

  function onSocketMessage(packet) {
    if (!packet || packet.ns !== "oni.remoteChoice") return;

    switch (String(packet.type ?? "")) {
      case "request":
        handleSocketRequest(packet);
        break;
      case "response":
        handleSocketResponse(packet);
        break;
      case "cancel":
        handleSocketCancel(packet);
        break;
      default:
        break;
    }
  }

  const api = {
    version: "1.0.0",

    /**
     * Open a local choice if userId is current user,
     * otherwise ask another client to open the dialog and wait for answer.
     *
     * @returns {Promise<{id,label,value} | null>}
     */
    async requestChoice(cfg = {}) {
      const normalized = normalizeConfig(cfg);
      const targetUserId = normalized.userId || game.user?.id || null;

      log("REQUEST CHOICE", {
        requesterUserId: game.user?.id ?? null,
        targetUserId,
        title: normalized.title,
        choicesCount: normalized.choices.length,
        timeoutMs: normalized.timeoutMs
      });

      // Local shortcut
      if (!targetUserId || String(targetUserId) === String(game.user?.id)) {
        return await openLocalChoiceDialog(normalized, {
          requestId: buildRequestId("LOCAL"),
          remote: false
        });
      }

      const targetUser = game.users?.get(targetUserId);
      if (!targetUser?.active) {
        warn("TARGET USER NOT ACTIVE", {
          targetUserId,
          requesterUserId: game.user?.id ?? null
        });
        return null;
      }

      const requestId = buildRequestId("REMOTE");

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          state.pending.delete(requestId);

          warn("REMOTE CHOICE TIMEOUT", {
            requestId,
            targetUserId,
            timeoutMs: normalized.timeoutMs
          });

          try {
            emitSocket({
              ns: "oni.remoteChoice",
              type: "cancel",
              requestId,
              targetUserId
            });
          } catch (e) {
            err("FAILED TO EMIT TIMEOUT CANCEL", { requestId, error: e });
          }

          resolve(null);
        }, normalized.timeoutMs);

        state.pending.set(requestId, {
          resolve,
          timer,
          createdAt: nowMs(),
          cfg: normalized
        });

        try {
          emitSocket({
            ns: "oni.remoteChoice",
            type: "request",
            requestId,
            requesterUserId: game.user?.id ?? null,
            targetUserId,
            cfg: normalized
          });

          log("REMOTE REQUEST SENT", {
            requestId,
            requesterUserId: game.user?.id ?? null,
            targetUserId
          });
        } catch (e) {
          clearTimeout(timer);
          state.pending.delete(requestId);
          err("FAILED TO EMIT REMOTE REQUEST", { requestId, error: e });
          resolve(null);
        }
      });
    },

    async cancelRequest({ requestId, targetUserId = null } = {}) {
      const rid = str(requestId);
      if (!rid) return false;

      const pending = state.pending.get(rid);
      if (pending) {
        clearTimeout(pending.timer);
        state.pending.delete(rid);
      }

      try {
        emitSocket({
          ns: "oni.remoteChoice",
          type: "cancel",
          requestId: rid,
          targetUserId: str(targetUserId)
        });
      } catch (e) {
        err("cancelRequest emit failed", { requestId: rid, error: e });
      }

      return true;
    },

    getPendingSnapshot() {
      return Array.from(state.pending.entries()).map(([requestId, entry]) => ({
        requestId,
        createdAt: entry?.createdAt ?? null,
        ageMs: entry?.createdAt ? (nowMs() - entry.createdAt) : null,
        title: entry?.cfg?.title ?? null,
        targetUserId: entry?.cfg?.userId ?? null
      }));
    }
  };

  Hooks.once("ready", () => {
    const apiRoot = getModuleApiRoot();
    if (!apiRoot) {
      warn("Module not found; RemoteChoice API not registered.");
      return;
    }

    if (!state.socketBound) {
      game.socket.on(SOCKET_NAME, onSocketMessage);
      state.socketBound = true;
      log("Socket bound", { socket: SOCKET_NAME });
    }

    apiRoot.RemoteChoice = api;
    state.apiBound = true;

    log("API READY", {
      moduleId: MODULE_ID,
      socket: SOCKET_NAME,
      apiPath: `game.modules.get("${MODULE_ID}").api.RemoteChoice`
    });
  });
})();
