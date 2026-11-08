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
//   - Reports every warning / error toast with the stack that raised it
//     ("notice"), so a toast nobody can find in the code names its source.
//   - Reports the canvas frame rate about once a minute of visible time ("fps"):
//     average, worst frame and how many frames ran slow, with the Battle depth
//     setting, so a report of low frame rate has numbers per player and scene.
//
// Reports queue in localStorage and go to the primary GM over the module
// socket, so a reload does not lose them. The primary GM writes the session's
// reports to Data/client-health-logs/ (gitignored) every 2 minutes.
//
// A GM can also ask one connected client for a read-only report of its screen
// (2026-11-01 report: one player's camp button failed and nobody could look).
// The client shows nothing and changes nothing. The list of checks is fixed and
// the message runs no code it carries, because a socket message doesn't prove
// who sent it. A page that is frozen or still loading can't answer.
//
// GM console:  FUCompanion.api.clientHealth.summary()   per-player roll-up
//              FUCompanion.api.clientHealth.log()       raw entries
//              await FUCompanion.api.clientHealth.ask("Rinri", { selectors: ["#oni-camp-phase-btn"] })
// Other scripts add entries with FUCompanion.api.clientHealth.record(kind, data)
// (load-indicator.js: "load-progress", "load-waiting").
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
  const FPS_WINDOW_MS   = 60000;   // visible canvas time in one "fps" report
  const FPS_MIN_MS      = 5000;    // a scene left sooner than this reports nothing
  const QUEUE_MAX  = 300;
  const LOG_MAX    = 5000;
  const CONSOLE_LINES = 15;
  const CONSOLE_CHARS = 300;

  const MSG_ASK    = "FU_CLIENT_ASK";
  const MSG_ANSWER = "FU_CLIENT_ANSWER";
  const ASK_TIMEOUT_MS   = 8000;
  const ANSWER_MIN_GAP_MS = 1000;  // the socket doesn't prove the sender: nobody gets to spam a client
  const REPORT_LINES_MAX = 100;
  const REPORT_SELECTORS_MAX = 5;
  const REPORT_WINDOWS_MAX = 20;

  const keyBeat = () => `fuc.clientHealth.beat.${game.world.id}`;
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

  // ── Warning toasts ─────────────────────────────────────────────────────────
  // 2026-11-07 bug list item 4: a player saw "FX: please select at least one
  // token" during Bimagus. That text is in no file in this repo, the world or
  // its packs, and the console line never reached us. Every warning / error
  // toast is now recorded with the code that raised it, so the next one names
  // its source in the GM's client-health log ("notice" entries).
  const NOTICE_FRAMES = 6;
  const NOTICE_REPEAT_MS = 5000;   // the same text again this soon is not news
  const lastNoticeAt = new Map();

  function callerFrames() {
    return String(new Error().stack ?? "").split("\n").slice(1)
      .map(l => l.trim())
      .filter(l => l && !/client-health\.js|\/scripts\/foundry\.js/.test(l))
      .slice(0, NOTICE_FRAMES)
      .map(l => l.replace(/https?:\/\/[^/]+\//g, "").slice(0, 200));
  }

  function tapNotices() {
    const n = globalThis.ui?.notifications;
    if (!n || typeof n.notify !== "function" || n.__fucHealthTap) return;
    const orig = n.notify;
    n.notify = function (message, type = "info", options) {
      try {
        if (type === "warning" || type === "error") {
          const msg = String(message ?? "").slice(0, CONSOLE_CHARS);
          const now = Date.now();
          if (now - (lastNoticeAt.get(msg) ?? 0) > NOTICE_REPEAT_MS) {
            lastNoticeAt.set(msg, now);
            if (lastNoticeAt.size > 200) lastNoticeAt.clear();
            push("notice", { type, msg, from: callerFrames(), ...sceneInfo() });
          }
        }
      } catch (_) { /* a health probe never breaks a toast */ }
      return orig.call(this, message, type, options);
    };
    n.__fucHealthTap = true;
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
    reportFps(FPS_WINDOW_MS);
    if (nextSampleAt && now >= nextSampleAt && lastDrawAt) {
      const since = now - lastDrawAt;
      push("sample", { ...sceneInfo(), sinceDrawMs: since, hidden: document.hidden, mem: measure() });
      nextSampleAt = now + (since < EARLY_WINDOW_MS ? EARLY_SAMPLE_MS : LATE_SAMPLE_MS);
    }
  }

  // ── Frame rate ─────────────────────────────────────────────────────────────

  let frameTicker = null;
  let lastFrameAt = null;    // null = the next frame only starts the clock
  const frameStats = () => ({ frames: 0, ms: 0, worstMs: 0, over33: 0, over50: 0, over100: 0 });
  let fps = frameStats();

  function onFrame() {
    const now = performance.now();
    if (lastFrameAt !== null) {
      const d = now - lastFrameAt;
      fps.frames++;
      fps.ms += d;
      if (d > fps.worstMs) fps.worstMs = d;
      if (d > 33.4) fps.over33++;
      if (d > 50) fps.over50++;
      if (d > 100) fps.over100++;
    }
    lastFrameAt = now;
  }

  function watchFrames() {
    const ticker = canvas?.app?.ticker;
    if (!ticker || ticker === frameTicker) return;
    frameTicker?.remove(onFrame);
    ticker.add(onFrame, null, PIXI.UPDATE_PRIORITY.UTILITY);
    frameTicker = ticker;
    lastFrameAt = null;
  }

  function fpsNow() {
    let depth = null;
    try { depth = game.settings.get("fabula-ultima-companion", "battleStage3d"); } catch { /* not registered yet */ }
    return {
      fps: fps.ms ? Math.round(fps.frames / (fps.ms / 1000) * 10) / 10 : null,
      frames: fps.frames,
      seconds: Math.round(fps.ms / 1000),
      worstMs: Math.round(fps.worstMs),
      over33: fps.over33,
      over50: fps.over50,
      over100: fps.over100,
      maxFPS: frameTicker?.maxFPS ?? null,
      depth,
    };
  }

  function reportFps(minMs) {
    if (fps.ms < minMs) return;
    push("fps", { ...sceneInfo(), ...fpsNow() });
    fps = frameStats();
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

  // ── Report on request ──────────────────────────────────────────────────────

  function describeElement(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: String(el.className?.baseVal ?? el.className ?? "").slice(0, 120) || null,
      zIndex: cs.zIndex,
      pointerEvents: cs.pointerEvents,
    };
  }

  // Is this control there, and would a press in its middle land on it?
  function checkSelector(selector) {
    let el;
    try { el = document.querySelector(selector); }
    catch { return { selector, error: "not a valid selector" }; }
    if (!el) return { selector, found: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const stack = r.width && r.height
      ? document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).slice(0, 5)
      : [];
    return {
      selector,
      found: true,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      disabled: !!el.disabled,
      onTop: !!stack[0] && (stack[0] === el || el.contains(stack[0])),
      stack: stack.map(describeElement),
    };
  }

  function openWindows() {
    const apps = [
      ...Object.values(ui?.windows ?? {}),
      ...(foundry.applications?.instances?.values?.() ?? []),
    ];
    return apps.filter(a => a?.rendered !== false).slice(0, REPORT_WINDOWS_MAX).map(a => {
      const title = a.title ?? a.options?.window?.title ?? a.id ?? a.constructor?.name;
      return String(title).slice(0, 80);
    });
  }

  function buildReport({ selectors = [], lines = 40, levels = ["warn", "error"], grep } = {}) {
    const tap = globalThis.__FUConsoleTap?.snapshot?.({
      levels,
      grep,
      limit: Math.min(Math.max(0, Number(lines) || 0), REPORT_LINES_MAX),
    });
    return {
      user: game.user.name,
      at: new Date().toISOString(),
      module: game.modules.get("fabula-ultima-companion")?.version ?? null,
      ...sceneInfo(),
      viewedScene: game.user.viewedScene ?? null,
      canvasReady: canvas?.ready ?? null,
      drawing: tearDownAt !== null,
      sinceDrawMs: lastDrawAt ? Date.now() - lastDrawAt : null,
      hidden: document.hidden,
      focused: document.hasFocus(),
      viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      socketConnected: !!game.socket?.connected,
      mem: measure(),
      fps: fpsNow(),
      windows: openWindows(),
      console: (tap?.logs ?? []).map(e => ({ ts: e.ts, level: e.level, msg: String(e.msg).slice(0, CONSOLE_CHARS) })),
      consoleDropped: tap?.dropped ?? null,
      selectors: selectors.slice(0, REPORT_SELECTORS_MAX).map(s => checkSelector(String(s))),
    };
  }

  const pendingAsks = new Map();
  let lastAnswerAt = 0;

  function onAskSocket(payload) {
    if (payload?.type === MSG_ANSWER) {
      const resolve = pendingAsks.get(payload.requestId);
      if (!resolve) return;   // another GM's question
      pendingAsks.delete(payload.requestId);
      resolve(payload.error ? { ok: false, error: payload.error } : { ok: true, report: payload.report });
      return;
    }
    if (payload?.type !== MSG_ASK || payload.toUserId !== game.user.id) return;
    const now = Date.now();
    if (now - lastAnswerAt < ANSWER_MIN_GAP_MS) return;
    lastAnswerAt = now;
    const answer = { type: MSG_ANSWER, requestId: payload.requestId };
    try { answer.report = buildReport(payload.options); }
    catch (err) { answer.error = String(err?.message ?? err); }
    game.socket.emit(SOCKET_NS, answer);
  }

  // Resolves { ok: true, report } or { ok: false, error }, never rejects.
  async function ask(who, options = {}, timeoutMs = ASK_TIMEOUT_MS) {
    if (!game.user.isGM) return { ok: false, error: "GM only" };
    const name = String(who ?? "").trim().toLowerCase();
    const user = game.users.get(who) ?? game.users.find(u => u.name.toLowerCase() === name);
    if (!user) return { ok: false, error: `no user called "${who}"` };
    if (!user.active) return { ok: false, user: user.name, error: "not connected" };
    if (user.id === game.user.id) return { ok: true, report: buildReport(options) };   // a socket emit never echoes

    const requestId = foundry.utils.randomID();
    const result = await new Promise(resolve => {
      pendingAsks.set(requestId, resolve);
      setTimeout(() => {
        if (!pendingAsks.delete(requestId)) return;
        resolve({ ok: false, error: `no answer in ${Math.round(timeoutMs / 1000)} s: the page may be frozen or still loading` });
      }, timeoutMs);
      game.socket.emit(SOCKET_NS, { type: MSG_ASK, requestId, toUserId: user.id, options });
    });
    push("ask", { target: user.name, ok: result.ok, error: result.error ?? null });
    return { user: user.name, ...result };
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  Hooks.on("canvasTearDown", () => {
    // what is left of the window belongs to the scene being left; a draw is not a slow frame
    reportFps(FPS_MIN_MS);
    fps = frameStats();
    lastFrameAt = null;
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
    lastFrameAt = null;
    watchFrames();
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
      fps: fpsNow,
      record: (kind, data = {}) => push(kind, data),
      ask,
    };

    reportBoot();
    booted = true;
    tapNotices();
    watchFrames();
    // the first scene usually drew before ready (canvasReady already set these)
    lastDrawAt ??= canvas?.ready ? Date.now() : null;
    nextSampleAt ??= lastDrawAt ? lastDrawAt + EARLY_SAMPLE_MS : null;
    beat();
    lastBeatAt = Date.now();
    setInterval(tick, BEAT_MS);
    setInterval(flush, FLUSH_MS);
    setInterval(upload, UPLOAD_MS);

    game.socket.on(SOCKET_NS, onSocket);
    game.socket.on(SOCKET_NS, onAskSocket);
    game.socket.on("disconnect", reason => push("disconnect", { reason: String(reason), ...sceneInfo() }));
    game.socket.on("connect", () => { push("connect"); flush(); });
    game.socket.on("reload", () => push("server-reload"));   // core's own reload broadcast

    document.addEventListener("visibilitychange", () => {
      lastFrameAt = null;   // a hidden page draws nothing: the gap is not a slow frame
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
