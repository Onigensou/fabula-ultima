// ============================================================================
// [TreasureRoulette] Net • Foundry VTT v12
// ----------------------------------------------------------------------------
// Purpose:
// - Track multi-client UI completion (ACKs) for TreasureRoulette
// - Provide a "barrier" promise for GM awarding:
//     - Resolve when ALL expected clients ACK, OR
//     - Resolve after GM ACK + a grace window (prevents awkward long waits)
// - Uses fabula-ultima-companion socket
//
// Messages (must match your other scripts):
// - ONI_TR_PLAY_UI        : packet broadcast (from Core)
// - ONI_TR_UI_FINISHED    : ui finished ack (from UI_Listener)
//
// Install:
// - Run once per client (like BattleEnd FX Listener)
// ============================================================================

Hooks.once("ready", () => {
  const KEY = "oni.TreasureRoulette.Net";
  if (window[KEY]) {
    console.warn(`[TreasureRoulette][Net] Already installed as window["${KEY}"].`);
    return;
  }

  const DEBUG = true;
  const tag = "[TreasureRoulette][Net]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  // Socket channel (must match your module)
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  const MSG_TR_PLAY_UI = "ONI_TR_PLAY_UI";
  const MSG_TR_UI_FINISHED = "ONI_TR_UI_FINISHED";

  // Idempotent socket install guard
  const GUARD = "__ONI_TREASURE_ROULETTE_NET_LISTENER_INSTALLED__";
  if (window[GUARD] === true) {
    ui.notifications?.info?.("TreasureRoulette Net: already installed on this client.");
    log("Already installed.");
    return;
  }
  window[GUARD] = true;

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const safeInt = (v, fallback = 0) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };

  function getSpinMs(packet) {
    const a = safeInt(packet?.spinMs, 0);
    const b = safeInt(packet?.ui?.spinMs, 0);
    return clamp(Math.max(a, b, 0), 0, 600000);
  }

  // Grace window after authority (GM) finishes:
  // - enough to let slower clients finish their spin
  // - but not so long it feels "stuck"
  function computeGraceMsFromSpin(spinMs) {
    // 35% of spin, clamped 1.5s–4s
    return clamp(Math.floor(safeInt(spinMs, 0) * 0.35), 1500, 4000);
  }

  function getExpectedAcks(packet) {
    const ids = packet?.audience?.expectedAcks;
    if (Array.isArray(ids) && ids.length) return ids.slice();
    if (packet?.roller?.userId) return [packet.roller.userId];
    return [game.user?.id].filter(Boolean);
  }

  function getActiveGmUserId() {
    const gm = (game.users?.contents ?? []).find(u => u?.isGM && u?.active);
    return gm?.id ?? null;
  }

  // requestId -> record
  const _records = new Map();

  function ensureRecordFromPacket(packet) {
    const requestId = String(packet?.requestId ?? "");
    if (!requestId) return null;

    const existing = _records.get(requestId);
    if (existing) {
      // refresh packet reference if needed
      existing.packet = packet ?? existing.packet;
      return existing;
    }

    const spinMs = getSpinMs(packet);
    const graceMs = computeGraceMsFromSpin(spinMs);

    const expected = new Set(getExpectedAcks(packet));
    const finished = new Set();

    // Authority: prefer active GM; fallback to roller
    const authorityUserId = getActiveGmUserId() ?? packet?.roller?.userId ?? null;

    const rec = {
      requestId,
      packet,
      spinMs,
      graceMs,
      postDelayMs: 250,

      expected,
      finished,

      authorityUserId,
      authorityFinishedAt: null,

      forceTimer: null,
      hardTimer: null,

      resolved: false,
      resolvedReason: null,

      waiters: []
    };

    // Hard failsafe so nothing can hang forever (2 minutes max)
    rec.hardTimer = setTimeout(() => {
      tryResolve(rec, "hardTimeout");
    }, 120000);

    _records.set(requestId, rec);

    log("Record created:", {
      requestId,
      expectedAcks: Array.from(expected),
      authorityUserId,
      spinMs,
      graceMs
    });

    return rec;
  }

  function allAcked(rec) {
    for (const uid of rec.expected) {
      if (!rec.finished.has(uid)) return false;
    }
    return true;
  }

  function cleanupRecord(requestId) {
    const rec = _records.get(requestId);
    if (!rec) return;

    try { clearTimeout(rec.forceTimer); } catch {}
    try { clearTimeout(rec.hardTimer); } catch {}

    _records.delete(requestId);
  }

  function resolveRecord(rec, reason) {
    if (rec.resolved) return;

    rec.resolved = true;
    rec.resolvedReason = reason;

    // Stop timers
    try { clearTimeout(rec.forceTimer); } catch {}
    try { clearTimeout(rec.hardTimer); } catch {}

    const payload = {
      ok: true,
      requestId: rec.requestId,
      reason,
      authorityUserId: rec.authorityUserId,
      expectedAcks: Array.from(rec.expected),
      finishedAcks: Array.from(rec.finished),
      spinMs: rec.spinMs,
      graceMs: rec.graceMs
    };

    // Small post delay so UI “feels” finished before award cards
    setTimeout(() => {
      const waiters = rec.waiters.slice();
      rec.waiters.length = 0;
      for (const fn of waiters) {
        try { fn(payload); } catch {}
      }

      // Cleanup later so you can still inspect record shortly in console
      setTimeout(() => cleanupRecord(rec.requestId), 5000);
    }, rec.postDelayMs);
  }

  function tryResolve(rec, hintReason) {
    if (!rec || rec.resolved) return;

    // Best case: everyone finished
    if (allAcked(rec)) {
      resolveRecord(rec, "allAcked");
      return;
    }

    // Force case: authority finished + grace window elapsed
    if (rec.authorityFinishedAt && Date.now() >= (rec.authorityFinishedAt + rec.graceMs)) {
      resolveRecord(rec, "forceAfterGrace");
      return;
    }

    // Hard failsafe
    if (hintReason === "hardTimeout") {
      resolveRecord(rec, "hardTimeout");
    }
  }

  function onUiFinishedAck(ack) {
    const requestId = String(ack?.requestId ?? "");
    const userId = String(ack?.userId ?? "");
    if (!requestId) return;

    // Ensure we have packet (best effort)
    let rec = _records.get(requestId);

    if (!rec) {
      // Try recover from Core memory if GM receives ack first
      const core = window["oni.TreasureRoulette.Core"];
      const lastPacket =
        core?._requests && core._requests instanceof Map
          ? Array.from(core._requests.values()).find(r => r?.packet?.requestId === requestId)?.packet
          : null;

      rec = ensureRecordFromPacket(lastPacket ?? { requestId });
    }

    if (!rec) return;

    if (userId) rec.finished.add(userId);

    log("ACK received:", {
      requestId,
      userId,
      finishedNow: Array.from(rec.finished),
      expectedAcks: Array.from(rec.expected)
    });

    // If authority just finished, start force timer
    if (userId && rec.authorityUserId && userId === rec.authorityUserId && !rec.authorityFinishedAt) {
      rec.authorityFinishedAt = Date.now();

      try { clearTimeout(rec.forceTimer); } catch {}
      rec.forceTimer = setTimeout(() => {
        tryResolve(rec, "forceTimer");
      }, rec.graceMs);

      log("Authority finished → started grace timer:", {
        requestId,
        authorityUserId: rec.authorityUserId,
        graceMs: rec.graceMs
      });
    }

    // If all ACKed now, resolve immediately (postDelay still applies)
    tryResolve(rec, "ackUpdate");
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------
  function registerPacket(packet) {
    return ensureRecordFromPacket(packet);
  }

  function waitBarrier(packetOrRequestId) {
    const requestId =
      typeof packetOrRequestId === "string"
        ? packetOrRequestId
        : String(packetOrRequestId?.requestId ?? "");

    if (!requestId) {
      return Promise.resolve({ ok: false, reason: "no-requestId" });
    }

    let rec = _records.get(requestId);

    if (!rec && typeof packetOrRequestId === "object") {
      rec = ensureRecordFromPacket(packetOrRequestId);
    }

    if (!rec) {
      return Promise.resolve({ ok: false, reason: "no-record" });
    }

    if (rec.resolved) {
      return Promise.resolve({
        ok: true,
        requestId: rec.requestId,
        reason: rec.resolvedReason,
        expectedAcks: Array.from(rec.expected),
        finishedAcks: Array.from(rec.finished)
      });
    }

    return new Promise((resolve) => {
      rec.waiters.push(resolve);
      tryResolve(rec, "waitBarrier");
    });
  }

  function sendUiFinished(packetOrRequestId) {
    const requestId =
      typeof packetOrRequestId === "string"
        ? packetOrRequestId
        : String(packetOrRequestId?.requestId ?? "");

    if (!requestId) return { ok: false, reason: "no-requestId" };
    if (!game?.socket) return { ok: false, reason: "no-game-socket" };

    const ack = {
      requestId,
      userId: game.user?.id ?? null,
      finishedAt: Date.now()
    };

    // Local apply (so the sender client counts immediately)
    onUiFinishedAck(ack);

    game.socket.emit(SOCKET_CHANNEL, {
      type: MSG_TR_UI_FINISHED,
      payload: ack
    });

    return { ok: true, requestId };
  }

  function dump(requestId) {
    if (!requestId) return Array.from(_records.values()).map(r => ({
      requestId: r.requestId,
      expected: Array.from(r.expected),
      finished: Array.from(r.finished),
      authorityUserId: r.authorityUserId,
      authorityFinishedAt: r.authorityFinishedAt,
      spinMs: r.spinMs,
      graceMs: r.graceMs,
      resolved: r.resolved,
      resolvedReason: r.resolvedReason
    }));

    const r = _records.get(String(requestId));
    if (!r) return null;
    return {
      requestId: r.requestId,
      expected: Array.from(r.expected),
      finished: Array.from(r.finished),
      authorityUserId: r.authorityUserId,
      authorityFinishedAt: r.authorityFinishedAt,
      spinMs: r.spinMs,
      graceMs: r.graceMs,
      resolved: r.resolved,
      resolvedReason: r.resolvedReason
    };
  }

  // --------------------------------------------------------------------------
  // Socket listener (passive tracking + ACK handling)
  // --------------------------------------------------------------------------
  game.socket?.on(SOCKET_CHANNEL, (msg) => {
    try {
      if (!msg?.type) return;

      if (msg.type === MSG_TR_PLAY_UI) {
        const packet = msg.payload;
        ensureRecordFromPacket(packet);
        return;
      }

      if (msg.type === MSG_TR_UI_FINISHED) {
        onUiFinishedAck(msg.payload);
        return;
      }
    } catch (e) {
      console.error(`${tag} Socket handler error:`, e);
    }
  });

  window[KEY] = {
    registerPacket,
    waitBarrier,
    sendUiFinished,
    dump,

    // exposed for debugging if you want
    _records
  };
  
  log(`Installed as window["${KEY}"]. Listening on:`, SOCKET_CHANNEL);
})();
