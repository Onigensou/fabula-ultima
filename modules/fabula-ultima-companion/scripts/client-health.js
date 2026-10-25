// ============================================================================
// Client Health — why did a player's page reload?
//
// Two players reloaded 12 times each on 2026-10-24 without pressing F5
// (docs/player-reload-investigation-2026-10-24.md). The cause is on their
// machines, and asking them to keep F12 open with "Preserve log" all session
// does not work. This records the evidence on every client instead.
//
// Every client:
//   - Writes a heartbeat to localStorage every 30 s: memory, GPU textures,
//     ticker listeners, DOM size, timer drift (a frozen page), the scene and
//     how long since it was drawn, and the last warnings/errors from the
//     console tap. `pagehide` marks the heartbeat as a clean exit.
//   - On boot, reads the previous page's heartbeat and reports how it ended:
//     the navigation type (reload / navigate), Chrome's `document.wasDiscarded`
//     (Memory Saver killed the tab), and whether `pagehide` ran. A reload whose
//     last page never got a pagehide died: a renderer crash or a killed tab.
//   - Reports each scene draw (time, memory before/after), draws that stall,
//     memory samples after a scene change (every minute for 10 min, then every
//     5), tab hide/show, and socket disconnects with their reason.
//
// Reports queue in localStorage and go to the primary GM over the module
// socket, so a reload does not lose them. The primary GM writes the session's
// reports to Data/client-health-logs/ (gitignored) every 2 minutes.
//
// GM console:  FUCompanion.api.clientHealth.summary()   per-player roll-up
//              FUCompanion.api.clientHealth.log()       raw entries
// ============================================================================
(() => {
  const TAG       = "[FUCompanion][ClientHealth]";
  const SOCKET_NS = "module.fabula-ultima-companion";
  const MSG_TYPE  = "FU_CLIENT_HEALTH";
  const LOG_DIR   = "client-health-logs";

  const BEAT_MS        = 30000;
  const FLUSH_MS       = 15000;    // send the queue to the GM
  const UPLOAD_MS      = 120000;   // GM writes the log file when it changed
  const STALL_MS       = 60000;    // a draw still unfinished after this is reported
  const EARLY_SAMPLE_MS = 60000;   // memory sample cadence right after a draw…
  const EARLY_WINDOW_MS = 600000;  // …for this long (the 5½–6½ min reload pattern)
  const LATE_SAMPLE_MS  = 300000;  // …then this
  const QUEUE_MAX  = 300;
  const LOG_MAX    = 5000;
  const CONSOLE_LINES = 15;
  const CONSOLE_CHARS = 300;

  const keyBeat  = () => `fuc.clientHealth.beat.${game.world.id}`;
  const keyQueue = () => `fuc.clientHealth.queue.${game.world.id}`;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  };

  // ── Measurements ───────────────────────────────────────────────────────────

  const mb = n => (Number.isFinite(n) ? Math.round(n / 1048576) : null);

  function measure() {
    const pm = performance.memory;   // Chrome / Edge only
    const app = globalThis.canvas?.app;
    return {
      heapMB:      mb(pm?.usedJSHeapSize),
      heapTotalMB: mb(pm?.totalJSHeapSize),
      heapLimitMB: mb(pm?.jsHeapSizeLimit),
      textures:    app?.renderer?.texture?.managedTextures?.length ?? null,
      tickers:     app?.ticker?.count ?? null,
      dom:         document.getElementsByTagName("*").length,
      videos:      document.getElementsByTagName("video").length,
    };
  }

  function recentConsole() {
    const snap = globalThis.__FUConsoleTap?.snapshot?.({ levels: ["warn", "error"], limit: CONSOLE_LINES });
    return (snap?.logs ?? []).map(e => ({ ts: e.ts, level: e.level, msg: String(e.msg).slice(0, CONSOLE_CHARS) }));
  }

  function machine() {
    let gpu = null;
    try {
      const gl = canvas?.app?.renderer?.gl;
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    } catch { /* no GL */ }
    return {
      ua: navigator.userAgent,
      deviceMemoryGB: navigator.deviceMemory ?? null,
      cores: navigator.hardwareConcurrency ?? null,
      gpu,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    };
  }

  // ── Per-page state ─────────────────────────────────────────────────────────

  let lastDrawAt   = null;   // canvasReady time of the current scene
  let tearDownAt   = null;   // set while a draw is in progress
  let tearDownMem  = null;
  let lastBeatAt   = null;
  let maxDriftMs   = 0;      // worst timer lateness since the last beat
  let nextSampleAt = null;
  let hiddenAt     = null;
  let booted       = false;  // the previous page's heartbeat has been read

  const sceneInfo = () => ({ sceneId: canvas?.scene?.id ?? null, scene: canvas?.scene?.name ?? null });

  // ── Queue → GM ─────────────────────────────────────────────────────────────

  function push(kind, data = {}) {
    const entry = { kind, t: Date.now(), userId: game.user.id, user: game.user.name, ...data };
    if (isCollector()) { collect([entry]); return; }
    const q = store.get(keyQueue()) ?? [];
    q.push(entry);
    store.set(keyQueue(), q.slice(-QUEUE_MAX));
  }

  function flush() {
    if (isCollector()) return;
    const q = store.get(keyQueue()) ?? [];
    if (!q.length || !game.socket?.connected || !game.users?.activeGM) return;
    game.socket.emit(SOCKET_NS, { type: MSG_TYPE, entries: q });
    store.set(keyQueue(), []);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  function beat(extra = {}) {
    const now = Date.now();
    store.set(keyBeat(), {
      t: now, ...sceneInfo(),
      sinceDrawMs: lastDrawAt ? now - lastDrawAt : null,
      drawing: tearDownAt !== null,
      hidden: document.hidden,
      driftMs: maxDriftMs,
      mem: measure(),
      console: recentConsole(),
      clean: false,
      ...extra,
    });
    maxDriftMs = 0;
  }

  function tick() {
    const now = Date.now();
    if (lastBeatAt) maxDriftMs = Math.max(maxDriftMs, now - lastBeatAt - BEAT_MS);
    lastBeatAt = now;
    beat();
    if (nextSampleAt && now >= nextSampleAt && lastDrawAt) {
      const since = now - lastDrawAt;
      push("sample", { ...sceneInfo(), sinceDrawMs: since, hidden: document.hidden, mem: measure() });
      nextSampleAt = now + (since < EARLY_WINDOW_MS ? EARLY_SAMPLE_MS : LATE_SAMPLE_MS);
    }
  }

  // ── How did the previous page end? ─────────────────────────────────────────

  function reportBoot() {
    const prev = store.get(keyBeat());
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    push("boot", {
      navType: nav?.type ?? null,               // navigate | reload | back_forward
      wasDiscarded: document.wasDiscarded ?? null,
      loadMs: Math.round(performance.now()),     // navigation start → ready
      transferKB: nav ? Math.round(nav.transferSize / 1024) : null,
      prev: prev ? {
        ...prev,
        endedAgoMs: Date.now() - prev.t,
        verdict: prev.clean ? "clean-exit" : "died",   // died = crash, kill, or discard
      } : null,
      machine: machine(),
    });
  }

  // ── GM collector ───────────────────────────────────────────────────────────

  const isCollector = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? game.user.isGM;
  const sessionLog = [];
  const sessionStart = new Date();
  let dirty = false;
  let dirReady = false;

  function collect(entries) {
    sessionLog.push(...entries);
    if (sessionLog.length > LOG_MAX) sessionLog.splice(0, sessionLog.length - LOG_MAX);
    dirty = true;
    for (const e of entries) {
      if (e.kind === "boot" && e.prev?.verdict === "died") {
        console.warn(TAG, `${e.user}'s last page ended without a clean exit`, e);
      }
    }
  }

  function onSocket(payload) {
    if (payload?.type !== MSG_TYPE || !isCollector()) return;
    collect(Array.isArray(payload.entries) ? payload.entries : []);
  }

  async function upload() {
    if (!dirty || !isCollector()) return;
    dirty = false;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker.implementation ?? FilePicker;
    const stamp = sessionStart.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = `${game.world.id}_${stamp}.json`;
    const body = JSON.stringify({ world: game.world.id, sessionStart, written: new Date(), entries: sessionLog });
    try {
      if (!dirReady) {
        await FP.createDirectory("data", LOG_DIR, {}).catch(() => {});   // already there is fine
        dirReady = true;
      }
      // upload reports failure by its return value, not by throwing
      const res = await FP.upload("data", LOG_DIR, new File([body], name, { type: "application/json" }), {}, { notify: false });
      if (!res?.path) throw new Error("no path in upload response");
    } catch (err) {
      dirty = true;
      console.warn(TAG, "log upload failed", err);
    }
  }

  function summary() {
    const by = {};
    for (const e of sessionLog) {
      const u = (by[e.user] ??= { boots: 0, died: 0, discarded: 0, reloads: 0, draws: 0, stalls: 0,
                                  worstDrawMs: 0, peakHeapMB: 0, disconnects: 0, hides: 0 });
      if (e.kind === "boot") {
        u.boots++;
        if (e.prev?.verdict === "died") u.died++;
        if (e.wasDiscarded) u.discarded++;
        if (e.navType === "reload") u.reloads++;
      }
      if (e.kind === "draw") { u.draws++; u.worstDrawMs = Math.max(u.worstDrawMs, e.ms ?? 0); }
      if (e.kind === "draw-stall") u.stalls++;
      if (e.kind === "disconnect") u.disconnects++;
      if (e.kind === "hidden") u.hides++;
      u.peakHeapMB = Math.max(u.peakHeapMB, e.mem?.heapMB ?? e.after?.heapMB ?? 0);
    }
    return by;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  Hooks.on("canvasTearDown", () => {
    const at = Date.now();
    tearDownAt = at;
    tearDownMem = measure();
    nextSampleAt = null;
    setTimeout(() => {
      if (tearDownAt !== at) return;   // drew (or another change began)
      push("draw-stall", { afterMs: STALL_MS, loading: canvas?.loading === true, mem: measure() });
    }, STALL_MS);
  });

  Hooks.on("canvasReady", () => {
    const now = Date.now();
    if (tearDownAt) {
      push("draw", { ...sceneInfo(), ms: now - tearDownAt, before: tearDownMem, after: measure() });
    }
    tearDownAt = null;
    lastDrawAt = now;
    nextSampleAt = now + EARLY_SAMPLE_MS;
    // the first scene draws BEFORE ready: beating then would overwrite the
    // previous page's heartbeat before reportBoot reads it
    if (booted) beat();
  });

  Hooks.once("ready", () => {
    globalThis.FUCompanion     = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.clientHealth = {
      log: () => sessionLog.slice(),
      summary,
      upload: () => { dirty = true; return upload(); },
      measure,
    };

    reportBoot();
    booted = true;
    // the first scene usually drew before ready (canvasReady already set these)
    lastDrawAt ??= canvas?.ready ? Date.now() : null;
    nextSampleAt ??= lastDrawAt ? lastDrawAt + EARLY_SAMPLE_MS : null;
    beat();
    lastBeatAt = Date.now();
    setInterval(tick, BEAT_MS);
    setInterval(flush, FLUSH_MS);
    setInterval(upload, UPLOAD_MS);

    game.socket.on(SOCKET_NS, onSocket);
    game.socket.on("disconnect", reason => push("disconnect", { reason: String(reason), ...sceneInfo() }));
    game.socket.on("connect", () => { push("connect"); flush(); });
    game.socket.on("reload", () => push("server-reload"));   // core's own reload broadcast

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { hiddenAt = Date.now(); push("hidden", sceneInfo()); }
      else if (hiddenAt) { push("visible", { hiddenMs: Date.now() - hiddenAt }); hiddenAt = null; }
    });
    // the last thing a page that ends normally does; a crash or a kill never runs it.
    // No flush here: a send during unload may never leave, so the queue waits for
    // the next page.
    addEventListener("pagehide", e => beat({ clean: true, persisted: e.persisted }));

    flush();
  });
})();
