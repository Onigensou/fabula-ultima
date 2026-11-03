// fake-io — stands in for the socket.io client, and through it for the Foundry SERVER.
//
// Foundry's client talks to its server over exactly one socket. Replacing `io.connect`
// lets the REAL client (foundry.js, CSB, every module) boot and run unchanged, with
// the world data served from a snapshot file instead of a LevelDB-backed server.
// Everything this file answers is logged in `window.__runner` so a gap in the
// emulation shows up as a recorded event, never as a silent wrong answer.
(() => {
  const CFG = window.__RUNNER_CFG ?? {};
  const S = window.__runner = {
    userId: CFG.userId, worldId: CFG.worldId, events: {}, unknown: {}, writes: [], errors: [],
    t0: performance.now(),
  };
  const count = (ev) => { S.events[ev] = (S.events[ev] ?? 0) + 1; };
  const wire = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));   // what a real socket would deliver
  // The real server mints ids on ITS side, so it never draws from the client's Math.random.
  // Drawing from it here shifted a seeded page's random stream on every document create, and a
  // seeded sim battle diverged from the real engine's after two actions (2026-11-03).
  const randomID = (n = 16) => { const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; const b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (let i = 0; i < n; i++) s += c[b[i] % c.length]; return s; };

  // The server also mints the ids of EMBEDDED documents that arrive without one, the token's
  // ActorDelta above all (it always exists server-side, even for a linked token). Echoed with a
  // null id, every later write to an unlinked token's synthetic actor went to the parent
  // "Scene.….Token.….ActorDelta." and died "reading 'createDocument'": no Provoked, no Element
  // Gorge on an NPC, so a sim battle played out differently from the real engine (2026-11-03).
  const fillEmbeddedIds = (type, d) => {
    if (type === "Token" && !d.delta) d.delta = {};
    const embedded = globalThis.CONFIG?.[type]?.documentClass?.metadata?.embedded ?? {};
    for (const [childType, field] of Object.entries(embedded)) {
      const v = d[field];
      for (const c of Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : [])) {
        if (!c._id) c._id = randomID();
        fillEmbeddedIds(childType, c);
      }
    }
    return d;
  };

  let worldTime = 0;

  // ------------------------------------------------------------- server handlers
  const handlers = {
    async world() {
      const r = await fetch("/runner/world.json", { cache: "no-store" });
      const data = await r.json();
      // Test-time world-setting overrides (run.mjs --world-setting key=value).
      for (const [key, value] of Object.entries(window.__RUNNER_SETTINGS ?? {})) {
        const v = JSON.stringify(value);
        const row = (data.settings ??= []).find((s) => s.key === key);
        // A new row copies a real row's shape: Foundry silently drops a Setting it can't validate.
        if (row) row.value = v;
        else data.settings.push({ ...structuredClone(data.settings[0] ?? {}), _id: randomID(), key, value: v });
      }
      // --code: our module's manifest entry reports the version actually being served
      if (CFG.code) { const m = (data.modules ?? []).find((x) => x.id === "fabula-ultima-companion"); if (m) m.version = CFG.code.version; S.code = CFG.code; }
      worldTime = Number((data.settings ?? []).find((s) => s.key === "core.time")?.value ?? 0) || 0;
      S.worldLoadedMs = Math.round(performance.now() - S.t0);
      return data;
    },
    getWorldStatus: () => true,
    time: () => ({ serverTime: Date.now(), worldTime }),
    async template(path) {
      const r = await fetch("/" + String(path).replace(/^\/+/, ""));
      if (!r.ok) return { error: `template not found: ${path}` };
      return { html: await r.text(), success: true };
    },
    modifyDocument(request) {
      const { type, action, operation = {} } = request;
      let result;
      switch (action) {
        case "get":
          // Compendium/document reads the world payload did not carry. Logged: a
          // non-empty need here is a real gap, not "nothing found".
          (S.unknown["modifyDocument.get"] ??= []).push({ type, pack: operation.pack ?? null, query: operation.query ?? null });
          result = [];
          break;
        case "create":
          result = (operation.data ?? []).map((d) => fillEmbeddedIds(type, { ...d, _id: (operation.keepId && d._id) ? d._id : (d._id ?? randomID()) }));
          break;
        case "update":
          result = operation.updates ?? [];
          break;
        case "delete":
          result = operation.ids ?? [];
          break;
        default:
          return { error: `runner: unsupported modifyDocument action ${action}` };
      }
      // ids: the warm runner (www/warm.js) resets exactly the documents a test wrote to.
      const ids = action === "create" || action === "update" ? result.map((d) => d?._id ?? null) : action === "delete" ? [...result] : [];
      S.writes.push({ type, action, n: result.length, parentUuid: operation.parentUuid ?? null, pack: operation.pack ?? null, ids });
      return { type, action, operation, result, userId: S.userId };
    },
    async manageFiles(data /*, options */) {
      if (data?.action === "browseFiles") {
        const r = await fetch(`/runner/browse?target=${encodeURIComponent(data.target ?? "")}`);
        return r.ok ? await r.json() : { error: `browse failed: ${data.target}` };
      }
      if (data?.action === "createDirectory") {
        await fetch(`/runner/mkdir?target=${encodeURIComponent(data.target ?? "")}`, { method: "POST" });
        return { target: data.target };
      }
      (S.unknown.manageFiles ??= []).push(data?.action);
      return { error: `runner: manageFiles ${data?.action} not supported` };
    },
    // fire-and-forget broadcasts / activity: nobody else is connected
    userActivity: () => undefined,
    getUserActivity: () => undefined,
    pause: () => undefined,
  };

  class FakeSocket {
    constructor() {
      this.handlers = {};
      this.connected = true;
      this.disconnected = false;
      this.id = "runner";
      this.io = { on() { return this; }, off() { return this; }, opts: {}, engine: { transport: { name: "websocket" } } };
      setTimeout(() => this._push("session", { sessionId: "runner", userId: S.userId }), 0);
    }
    on(ev, fn) { (this.handlers[ev] ??= []).push(fn); return this; }
    once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
    off(ev, fn) { if (!fn) delete this.handlers[ev]; else this.handlers[ev] = (this.handlers[ev] ?? []).filter((f) => f !== fn); return this; }
    removeListener(ev, fn) { return this.off(ev, fn); }
    removeAllListeners(ev) { if (ev) delete this.handlers[ev]; else this.handlers = {}; return this; }
    listeners(ev) { return this.handlers[ev] ?? []; }
    // catch-all listeners (Foundry buffers events with prependAny until the game is ready)
    prependAny(fn) { (this.any ??= []).unshift(fn); return this; }
    onAny(fn) { (this.any ??= []).push(fn); return this; }
    offAny(fn) { this.any = fn ? (this.any ?? []).filter((f) => f !== fn) : []; return this; }
    listenersAny() { return this.any ?? []; }
    onAnyOutgoing() { return this; }
    offAnyOutgoing() { return this; }
    hasListeners(ev) { return !!this.handlers[ev]?.length; }
    disconnect() { this.connected = false; this.disconnected = true; return this; }
    close() { return this.disconnect(); }
    connect() { this.connected = true; return this; }
    get active() { return this.connected; }
    _push(ev, ...args) { for (const f of [...(this.any ?? [])]) { try { f(ev, ...args); } catch (e) { S.errors.push({ ev, msg: String(e?.message ?? e) }); } } for (const f of [...(this.handlers[ev] ?? [])]) { try { f(...args); } catch (e) { S.errors.push({ ev, msg: String(e?.message ?? e) }); console.error(e); } } }
    emit(ev, ...args) {
      const ack = typeof args[args.length - 1] === "function" ? args.pop() : null;
      count(ev);
      const h = handlers[ev];
      const payload = wire(args);
      Promise.resolve().then(async () => {
        if (!h) {
          // module.<id> channels (socketlib etc.) broadcast to OTHER clients — none here
          if (!ev.startsWith("module.")) (S.unknown[ev] ??= 0), S.unknown[ev]++;
          if (ack) ack({ error: `runner: no handler for "${ev}"` });
          return;
        }
        try {
          const res = await h(...payload);
          if (ack) ack(wire(res));
        } catch (e) {
          S.errors.push({ ev, msg: String(e?.message ?? e) });
          if (ack) ack({ error: String(e?.message ?? e) });
        }
      });
      return this;
    }
  }

  // S.socket: the warm runner pushes document changes through it, the way the server
  // broadcasts another client's writes.
  window.io = { connect: () => (S.socket = new FakeSocket()), Socket: FakeSocket };
})();
