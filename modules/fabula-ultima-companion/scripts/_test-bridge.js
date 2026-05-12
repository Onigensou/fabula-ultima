/**
 * [ONI] Test Bridge — file-based IPC for autonomous Claude iteration.
 * ---------------------------------------------------------------------------
 * A GM-side watcher that lets an external process (Claude / scripts on disk)
 * drive the live Foundry world: run dry-runs, edit documents, invoke macros,
 * reload. Replaces safe-edit when the world is open (safe-edit needs the
 * LevelDB lock).
 *
 * Protocol
 *   - Inbox / outbox / heartbeat live under worlds/<worldId>/test-bridge/.
 *   - Requests:  inbox/req-<id>.json
 *   - Responses: outbox/res-<id>.json
 *   - Heartbeat: state.json (bootId + timestamp; tells Claude the watcher is alive)
 *   - Secret:    .secret (32-char token, generated on first boot, required for evalGM)
 *
 * Request shape
 *   {
 *     "id":   "<unique-id>",
 *     "kind": "ping" | "dryRun" | "diffLastAction" | "updateDocument"
 *           | "createDocument" | "deleteDocument" | "runMacro"
 *           | "query" | "evalGM" | "reload",
 *     "args": { ...kind-specific... },
 *     "auth": "<secret>"   // required for evalGM only
 *   }
 *
 * Response shape
 *   {
 *     "id": "...", "kind": "...", "ok": bool,
 *     "result": any | null, "error": string | null,
 *     "bootId": "...", "tookMs": number, "completedAt": iso
 *   }
 *
 * Watcher state is in-memory (Set<processedFileUrl>). Reload clears it, so
 * unconsumed requests get re-run on next boot — keep iteration tight or
 * sweep stale files from the inbox before reloading.
 *
 * GM only. Watcher self-disables for non-GM users so multiple browsers
 * don't race on the same inbox.
 */
(() => {
  const TAG = "[FUCompanion][TestBridge]";
  const SOURCE = "data";
  const POLL_INTERVAL_MS = 500;
  const HEARTBEAT_EVERY_N_POLLS = 6;
  const MAX_REQUEST_BYTES = 256 * 1024;
  const DEFAULT_TIMEOUT_MS = 30000;
  const MAX_TIMEOUT_MS = 5 * 60 * 1000;

  let bootId = null;
  let secret = null;
  let pollTimer = null;
  let pollTick = 0;
  const processed = new Set();

  function worldDir()  { return `worlds/${game.world.id}/test-bridge`; }
  function inboxDir()  { return `${worldDir()}/inbox`; }
  function outboxDir() { return `${worldDir()}/outbox`; }

  function clampTimeout(reqValue) {
    const n = Number(reqValue);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(n)));
  }

  async function ensureDir(path) {
    try {
      await FilePicker.createDirectory(SOURCE, path, {});
    } catch (e) {
      // Already-exists throws — that's fine. Anything else gets logged.
      const msg = String(e?.message ?? e);
      if (!/exist/i.test(msg)) console.warn(`${TAG} createDirectory(${path})`, msg);
    }
  }

  async function uploadJson(dirPath, filename, dataObj) {
    const text = (typeof dataObj === "string") ? dataObj : JSON.stringify(dataObj, null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const file = new File([blob], filename, { type: "application/json" });
    await FilePicker.upload(SOURCE, dirPath, file, {}, { notify: false });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_REQUEST_BYTES) throw new Error("request too large");
    return JSON.parse(text);
  }

  async function loadOrCreateSecret() {
    const url = `/${worldDir()}/.secret`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text.length >= 16) return text;
      }
    } catch {}
    // Generate fresh secret.
    const fresh = foundry.utils.randomID(32);
    const blob = new Blob([fresh], { type: "text/plain" });
    const file = new File([blob], ".secret", { type: "text/plain" });
    await FilePicker.upload(SOURCE, worldDir(), file, {}, { notify: false });
    console.info(`${TAG} generated new secret token`);
    return fresh;
  }

  async function writeHeartbeat() {
    const state = {
      bootId,
      ready: true,
      lastHeartbeat: new Date().toISOString(),
      gmUserId: game.user?.id ?? null,
      worldId: game.world.id,
      pollIntervalMs: POLL_INTERVAL_MS,
      processedThisSession: processed.size
    };
    try {
      await uploadJson(worldDir(), "state.json", state);
    } catch (e) {
      // Heartbeat failures are non-fatal; the next tick retries.
    }
  }

  async function pollInbox() {
    let listing;
    try {
      listing = await FilePicker.browse(SOURCE, inboxDir());
    } catch (e) {
      // Inbox may not exist yet; ensureDir on boot should prevent this.
      return;
    }
    const reqFiles = (listing.files ?? [])
      .filter(f => /\/req-[A-Za-z0-9_-]+\.json$/.test(f))
      .filter(f => !processed.has(f));

    // Cross-session dedup: if outbox already has res-<id>.json, a previous
    // bridge instance handled this request. Skip — otherwise a `reload`
    // command would re-fire on every boot. Claude is expected to delete both
    // inbox/req and outbox/res after consuming, so steady-state has neither.
    let outboxListing = null;
    try { outboxListing = await FilePicker.browse(SOURCE, outboxDir()); }
    catch {}
    const outboxIds = new Set();
    for (const f of (outboxListing?.files ?? [])) {
      const m = /\/res-([A-Za-z0-9_-]+)\.json$/.exec(f);
      if (m) outboxIds.add(m[1]);
    }

    for (const fileUrl of reqFiles) {
      processed.add(fileUrl);
      const idMatch = /\/req-([A-Za-z0-9_-]+)\.json$/.exec(fileUrl);
      const id = idMatch ? idMatch[1] : null;
      if (id && outboxIds.has(id)) {
        console.info(`${TAG} skipping ${id} (response already in outbox)`);
        continue;
      }
      // Process sequentially — most commands mutate world state and we don't
      // want races (e.g. two updateDocument calls clobbering each other).
      try {
        await handleRequest(fileUrl);
      } catch (e) {
        console.error(`${TAG} request handler threw`, e, fileUrl);
      }
    }
  }

  async function handleRequest(fileUrl) {
    let req = null;
    try { req = await fetchJson(fileUrl); }
    catch (e) { console.warn(`${TAG} could not parse ${fileUrl}`, e); return; }

    if (!req?.id || typeof req.kind !== "string") {
      console.warn(`${TAG} bad request shape`, req);
      return;
    }

    const started = Date.now();
    const response = {
      id: req.id,
      kind: req.kind,
      ok: false,
      bootId,
      requestedAt: req.requestedAt ?? null,
      completedAt: null,
      tookMs: 0,
      result: null,
      error: null
    };

    // Watchdog: race dispatch against a timeout so a hung handler (e.g. a
    // dry-run waiting on an unsuppressed dialog) doesn't block the bridge
    // forever. The underlying promise keeps running in the world — we just
    // stop waiting and write a failure response.
    const timeoutMs = clampTimeout(req.timeoutMs);
    const timedRace = (async () => {
      let timerId;
      try {
        const result = await Promise.race([
          dispatch(req),
          new Promise((_, reject) => {
            timerId = setTimeout(
              () => reject(Object.assign(new Error(`bridge timeout after ${timeoutMs}ms`), { __timedOut: true })),
              timeoutMs
            );
          })
        ]);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e };
      } finally {
        if (timerId) clearTimeout(timerId);
      }
    })();

    const raceResult = await timedRace;
    if (raceResult.ok) {
      response.ok = true;
      response.result = raceResult.result;
    } else {
      const e = raceResult.error;
      response.ok = false;
      response.error = String(e?.message ?? e);
      response.errorStack = e?.stack ? String(e.stack).split("\n").slice(0, 6).join("\n") : null;
      if (e?.__timedOut) response.timedOut = true;
      console.error(`${TAG} command "${req.kind}" failed`, e);
    }

    response.tookMs = Date.now() - started;
    response.completedAt = new Date().toISOString();

    try {
      await uploadJson(outboxDir(), `res-${req.id}.json`, response);
    } catch (e) {
      console.error(`${TAG} failed to write response for ${req.id}`, e);
    }
  }

  async function dispatch(req) {
    const args = (req.args && typeof req.args === "object") ? req.args : {};

    switch (req.kind) {
      case "ping":
        return {
          pong: true,
          bootId,
          worldId: game.world.id,
          foundryVersion: game.version ?? null,
          time: new Date().toISOString()
        };

      case "dryRun": {
        const api = globalThis.FUCompanion?.api?.test?.runActionDryRun;
        if (!api) throw new Error("FUCompanion.api.test.runActionDryRun not loaded");
        return await api(args);
      }

      case "diffLastAction": {
        const api = globalThis.FUCompanion?.api?.test?.diffLastAction;
        if (!api) throw new Error("FUCompanion.api.test.diffLastAction not loaded");
        return await api(args);
      }

      case "updateDocument": {
        const { uuid, changes, options } = args;
        if (!uuid) throw new Error("updateDocument: uuid required");
        const doc = await fromUuid(uuid);
        if (!doc) throw new Error(`updateDocument: fromUuid failed for ${uuid}`);
        await doc.update(changes ?? {}, options ?? {});
        return { uuid, updated: true };
      }

      case "createDocument": {
        const { parentUuid, embeddedName = "Item", type, data } = args;
        if (!data) throw new Error("createDocument: data required");
        if (parentUuid) {
          const parent = await fromUuid(parentUuid);
          if (!parent) throw new Error(`createDocument: fromUuid failed for ${parentUuid}`);
          const docs = await parent.createEmbeddedDocuments(embeddedName, [data]);
          return { created: docs.map(d => d.uuid) };
        }
        if (!type) throw new Error("createDocument: type required when parentUuid is omitted");
        const cls = CONFIG[type]?.documentClass;
        if (!cls) throw new Error(`createDocument: unknown type ${type}`);
        const doc = await cls.create(data);
        return { created: [doc.uuid] };
      }

      case "deleteDocument": {
        const { uuid } = args;
        if (!uuid) throw new Error("deleteDocument: uuid required");
        const doc = await fromUuid(uuid);
        if (!doc) throw new Error(`deleteDocument: fromUuid failed for ${uuid}`);
        await doc.delete();
        return { uuid, deleted: true };
      }

      case "runMacro": {
        const { name, payload, autoFlag = true } = args;
        if (!name) throw new Error("runMacro: name required");
        const macro = game.macros.getName(name);
        if (!macro) throw new Error(`runMacro: macro not found "${name}"`);
        const result = await macro.execute({
          __AUTO: !!autoFlag,
          __PAYLOAD: payload ?? {}
        });
        return { ran: name, result };
      }

      case "query":
        return await runQuery(args);

      case "evalGM": {
        if (!secret) throw new Error("evalGM: no secret loaded (watcher init bug?)");
        if (!args.auth || args.auth !== secret) {
          throw new Error("evalGM: missing or invalid auth token");
        }
        const code = String(args.code ?? "");
        if (!code.trim()) throw new Error("evalGM: empty code");
        const fn = new Function(
          "game", "canvas", "ui", "fromUuid", "FUCompanion", "Hooks",
          `return (async () => { ${code} })();`
        );
        return await fn(game, canvas, ui, fromUuid, globalThis.FUCompanion, Hooks);
      }

      case "reload": {
        const delayMs = Math.max(50, Math.min(10000, Number(args.delayMs ?? 250)));
        // Schedule reload AFTER the response is written. Watcher's caller
        // (handleRequest) writes the response after dispatch returns, so
        // we set the timer here and let dispatch return immediately.
        //
        // Foundry registers a beforeunload handler that prompts "Leave site?".
        // Suppress it three ways before reloading:
        //   1) null out window.onbeforeunload
        //   2) install a capture-phase listener that stops the event from
        //      reaching other (addEventListener-registered) handlers
        //   3) call location.reload() — capture listener clears returnValue
        // The user said autonomous reload is fine during dev — this is the
        // tradeoff for not prompting them on every iteration.
        setTimeout(() => {
          try {
            try { window.onbeforeunload = null; } catch {}
            const killOthers = (e) => {
              try {
                e.stopImmediatePropagation();
                delete e.returnValue;
                e.returnValue = undefined;
              } catch {}
            };
            window.addEventListener("beforeunload", killOthers, { capture: true });
            location.reload();
          } catch (e) {
            console.warn(`${TAG} reload failed`, e);
          }
        }, delayMs);
        return { reloading: true, delayMs };
      }

      default:
        throw new Error(`unknown command kind: ${req.kind}`);
    }
  }

  async function runQuery({ kind, filter = {} } = {}) {
    switch (kind) {
      case "fromUuid": {
        if (!filter?.uuid) throw new Error("query/fromUuid: filter.uuid required");
        const doc = await fromUuid(filter.uuid);
        if (!doc) return { found: false };
        return {
          found: true,
          uuid: doc.uuid,
          name: doc.name ?? null,
          type: doc.type ?? null,
          system: doc.system ?? null,
          flags: doc.flags ?? null
        };
      }
      case "macros":
        return (game.macros?.contents ?? []).map(m => ({ id: m.id, name: m.name }));
      case "actors":
        return (game.actors?.contents ?? []).map(a => ({
          id: a.id, uuid: a.uuid, name: a.name, type: a.type
        }));
      case "items": {
        if (filter?.actorUuid) {
          const actor = await fromUuid(filter.actorUuid);
          if (!actor) throw new Error(`query/items: fromUuid failed for ${filter.actorUuid}`);
          return (actor.items?.contents ?? []).map(i => ({
            uuid: i.uuid, name: i.name, type: i.type,
            uniqueId: i.system?.uniqueId ?? null,
            template:  i.system?.template ?? null
          }));
        }
        return (game.items?.contents ?? []).map(i => ({
          uuid: i.uuid, name: i.name, type: i.type
        }));
      }
      case "tokens":
        return (canvas?.tokens?.placeables ?? []).map(t => ({
          id: t.id, uuid: t.document?.uuid ?? null, name: t.name,
          actorUuid: t.actor?.uuid ?? null, controlled: !!t.controlled
        }));
      case "controlled":
        return Array.from(canvas?.tokens?.controlled ?? []).map(t => ({
          id: t.id, uuid: t.document?.uuid ?? null, name: t.name,
          actorUuid: t.actor?.uuid ?? null
        }));
      case "targets":
        return Array.from(game.user?.targets ?? []).map(t => ({
          uuid: t.document?.uuid ?? null, name: t.name,
          actorUuid: t.actor?.uuid ?? null
        }));
      default:
        throw new Error(`unknown query kind: ${kind}`);
    }
  }

  async function boot() {
    if (!game.user?.isGM) {
      console.info(`${TAG} bridge inactive (not GM).`);
      return;
    }

    await ensureDir(worldDir());
    await ensureDir(inboxDir());
    await ensureDir(outboxDir());

    bootId = foundry.utils.randomID(16);
    secret = await loadOrCreateSecret();

    await writeHeartbeat();

    pollTimer = setInterval(async () => {
      pollTick++;
      try { await pollInbox(); }
      catch (e) { console.warn(`${TAG} poll error`, e); }
      if (pollTick % HEARTBEAT_EVERY_N_POLLS === 0) {
        try { await writeHeartbeat(); } catch {}
      }
    }, POLL_INTERVAL_MS);

    console.info(`${TAG} bridge ready. bootId=${bootId} dir=${worldDir()} poll=${POLL_INTERVAL_MS}ms`);
  }

  Hooks.once("ready", () => {
    boot().catch(e => console.error(`${TAG} boot failed`, e));
  });

  // Expose a tiny inspection API for the console / other modules.
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};
  API_ROOT.api.testBridge = {
    get bootId()    { return bootId; },
    get worldDir()  { return worldDir(); },
    get processed() { return Array.from(processed); },
    forceHeartbeat: writeHeartbeat,
    stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      console.info(`${TAG} stopped.`);
    }
  };
})();
