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
 *   - Secret:    bridge-secret.txt (32-char token, generated on first boot,
 *                required for evalGM). Was `.secret` historically, renamed
 *                because Foundry's upload validator rejects leading-dot names.
 *
 * Request shape
 *   {
 *     "id":   "<unique-id>",
 *     "kind": "ping" | "dryRun" | "diffLastAction" | "updateDocument"
 *           | "createDocument" | "deleteDocument" | "runMacro"
 *           | "query" | "evalGM" | "reload"
 *           | "screenshot" | "getLogs",
 *     "args": { ...kind-specific... },
 *     "auth": "<secret>"   // required for evalGM only
 *   }
 *
 * Note: `screenshot` writes a PNG/JPEG into outbox/ alongside its res-*.json;
 * `getLogs` reads from globalThis.__FUConsoleTap (installed by _console-tap.js,
 * which is loaded first in module.json). `query/domSnapshot` returns the HTML
 * of a CSS selector — chat/sheet/dialog state without needing a screenshot.
 *
 * Response shape
 *   {
 *     "id": "...", "kind": "...", "ok": bool,
 *     "result": any | null, "error": string | null,
 *     "bootId": "...", "tookMs": number, "completedAt": iso
 *   }
 *
 * Watcher state is in-memory (bounded Map<processedFileUrl, ts>, capped at
 * PROCESSED_MAX with FIFO eviction). Reload clears it, so unconsumed requests
 * get re-run on next boot — keep iteration tight or sweep stale files from
 * the inbox before reloading.
 *
 * Polling is adaptive: ACTIVE rate (500ms) while requests are arriving, IDLE
 * rate (2s) after IDLE_AFTER_MS of quiet. This prevents the bridge from
 * hammering FilePicker.browse during long idle sessions.
 *
 * Activation: two independent ways to boot, both GM-only (a non-GM session
 * never starts the watcher, so multiple browsers don't race on the same inbox):
 *   1. The CLIENT-scoped "Test Bridge: auto-start on boot" setting. When on,
 *      the bridge boots on every reload with no sentinel. Ships OFF, so a fresh
 *      install / co-dev stays dormant. Client scope keeps it out of any worlds/
 *      snapshot — enabling it can't leak to someone who pulls the world.
 *   2. The `bridge-activate.txt` sentinel. Consumed on read (overwritten
 *      empty); a sentinel-driven boot re-arms itself so a Claude-driven reload
 *      chain keeps the bridge alive even with the setting off.
 *
 * `FUCompanion.api.testBridge.activate()` arms the sentinel + reloads;
 * `.start()` activates in-place without reloading (use if the bridge was
 * stopped and you want it back without a reload).
 *
 * GM only. Watcher self-disables for non-GM users so multiple browsers
 * don't race on the same inbox.
 */
(() => {
  const TAG = "[FUCompanion][TestBridge]";
  const SOURCE = "data";
  // Default-on is gated behind a CLIENT-scoped setting so it ships dormant for
  // everyone and only this developer's browser opts in. Client scope (not
  // world) deliberately keeps it OUT of any worlds/ snapshot — flipping it on
  // can't leak to a co-dev who pulls the world. The sentinel/activate() path
  // still boots the bridge regardless of this setting.
  const MODULE_ID = "fabula-ultima-companion";
  const SETTING_AUTOSTART = "testBridgeAutoStart";
  // Adaptive polling: hit FilePicker.browse fast (500ms) only while requests
  // are actively arriving; back off to 2s after IDLE_AFTER_MS of quiet so an
  // unattended GM session doesn't hammer the server.
  const POLL_INTERVAL_ACTIVE_MS = 500;
  const POLL_INTERVAL_IDLE_MS = 2000;
  const IDLE_AFTER_MS = 60_000;
  // Heartbeat: time-based (not poll-count-based), so changing poll rate doesn't
  // change heartbeat cadence. Each heartbeat is a FilePicker.upload Foundry
  // logs unconditionally — keep rate low.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  // Cap the dedup Map so a long session (or churning request IDs) can't grow
  // it unbounded. 200 entries is far more than any realistic concurrent batch.
  const PROCESSED_MAX = 200;
  // Bumped from 256 KiB: authored actors (with embedded skills + effects) run
  // 300 KB–1 MB, which the old cap silently dropped (request discarded, no
  // response written). 16 MiB comfortably covers a full actor import payload.
  const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
  const DEFAULT_TIMEOUT_MS = 30000;
  const MAX_TIMEOUT_MS = 5 * 60 * 1000;

  let bootId = null;
  let secret = null;
  let pollTimer = null;
  let lastActivityAt = 0;
  let lastHeartbeatAt = 0;
  // Stamped at the START of each poll tick. The watchdog uses this to
  // detect a broken polling chain or a setTimeout that got throttled into
  // oblivion by Electron/Chromium background suspension.
  let lastPollTickAt = 0;
  let watchdogTimer = null;
  // ── skill-surface witness ─────────────────────────────────────────────────
  // A monotonic counter of changes that could move a skill-regression
  // fingerprint, published in the heartbeat so the Stop-hook gate can tell
  // "actor data changed" from "only engine code changed". Foundry's own
  // document hooks are the source of truth, so this covers sheet edits and
  // other modules, not just bridge-driven authoring.
  //
  // `seeded` says the counter continues the previous boot's value (read back
  // from state.json). Unseeded it restarts at 0, which is NOT comparable with a
  // key recorded before the reload — the gate treats that as "unknown" and
  // falls back to the engine-hash decision rather than trusting a false match.
  let skillSurface = { seq: 0, at: null, last: null, seeded: false };
  let surfaceFlushTimer = null;
  let surfaceFlushAt = 0;
  let surfaceHooked = false;
  // Burst window for the flush. Authoring writes arrive in bursts (one skill =
  // several item/AE writes); this coalesces a burst into one extra upload.
  const SURFACE_FLUSH_MS = 2000;
  // Watchdog cadence + the staleness threshold that triggers re-arming.
  // 60s = 30× the idle poll interval, so we only re-arm on genuine breakage,
  // never on normal cadence variation.
  const WATCHDOG_INTERVAL_MS = 30_000;
  const WATCHDOG_STALE_MS = 60_000;
  // Map preserves insertion order, so FIFO eviction is just keys().next().
  const processed = new Map();

  function markProcessed(fileUrl) {
    processed.set(fileUrl, Date.now());
    while (processed.size > PROCESSED_MAX) {
      processed.delete(processed.keys().next().value);
    }
  }

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

  // ------------------------------------------------------------------------
  // Activation sentinel — file-based one-shot wake-up.
  // ------------------------------------------------------------------------
  // The bridge consumes the sentinel by overwriting it with empty content.
  // We can't truly delete via FilePicker (no public delete API), so "empty"
  // means "already consumed". `armActivationSentinel()` writes a non-empty
  // value; `consumeActivationSentinel()` returns true (and clears it) only
  // when content is non-empty.

  async function consumeActivationSentinel() {
    const url = `/${worldDir()}/bridge-activate.txt`;
    let token = "";
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      token = (await res.text()).trim();
    } catch { return null; }
    if (!token) return null;
    // Best-effort clear: upload an empty file with the same name. If the
    // upload fails, the next boot would see the same token — that's OK,
    // it's idempotent (same activation re-fires).
    try {
      const blob = new Blob([""], { type: "text/plain" });
      const file = new File([blob], "bridge-activate.txt", { type: "text/plain" });
      await FilePicker.upload(SOURCE, worldDir(), file, {}, { notify: false });
    } catch (e) {
      console.warn(`${TAG} failed to clear activation sentinel`, e);
    }
    return token;
  }

  // Blank a request's inbox file (best-effort). Used by the reload path to
  // neutralize its OWN request before navigating: an unconsumed `reload` request
  // re-runs on the next boot (the watcher's processed-map is in-memory and
  // cleared on reload), so a committed reload would otherwise re-trigger another
  // reload every boot — a reload LOOP. We can't delete via FilePicker, so
  // overwrite empty; the next boot's fetchJson fails to parse and skips it.
  async function emptyInboxRequest(id) {
    if (!id) return;
    try {
      const blob = new Blob([""], { type: "application/json" });
      const file = new File([blob], `req-${id}.json`, { type: "application/json" });
      await FilePicker.upload(SOURCE, inboxDir(), file, {}, { notify: false });
    } catch (e) {
      console.warn(`${TAG} failed to blank inbox request req-${id}.json`, e);
    }
  }

  async function armActivationSentinel(reason = "manual") {
    const token = `${foundry.utils.randomID(12)}@${new Date().toISOString()}#${reason}`;
    const blob = new Blob([token], { type: "text/plain" });
    const file = new File([blob], "bridge-activate.txt", { type: "text/plain" });
    await FilePicker.upload(SOURCE, worldDir(), file, {}, { notify: false });
    return token;
  }

  // Suppress Foundry's "Leave site?" prompt and reload. DEFENSIVE: if the
  // navigation doesn't fire within RELOAD_WATCHDOG_MS, undo the tampering so
  // we don't poison the session. Background: previously the kill-listener +
  // `window.onbeforeunload = null` were permanent. If a bridge reload failed
  // to navigate (see reference_bridge_reload_pathology), Foundry's Electron
  // shell would refuse to close because its close handshake depends on the
  // renderer's beforeunload — required end-task to exit the desktop app.
  const RELOAD_WATCHDOG_MS = 5000;
  // Escalation cadence: fire the next navigation strategy this long after the
  // previous one if the page hasn't begun to unload. 700ms is comfortably longer
  // than a normal commit (pagehide fires in <<100ms when a strategy takes).
  const RELOAD_ESCALATE_MS = 700;
  // Additive, self-verifying reload. location.reload() remains the first attempt
  // (unchanged when it works). If the page hasn't begun unloading shortly after,
  // we ESCALATE to location.replace(href) — a distinct navigation trigger that
  // sometimes commits when reload() is swallowed by the Electron shell (see
  // reference_bridge_reload_pathology). beforeunload is neutralized at BOTH
  // capture and bubble phases, since a single-phase strip can miss a veto set by
  // a handler in the other phase — a likelier root cause of a swallowed reload
  // than reload() itself failing. pagehide/unload signal a real commit and stop
  // all escalation; if nothing commits, the watchdog restores beforeunload so we
  // never poison Electron's close handshake, and logs loudly so the failure is
  // OBSERVABLE (the caller also gets preReloadBootId to poll state.json against).
  function suppressBeforeUnloadAndReload() {
    const prevOnBeforeUnload = window.onbeforeunload;
    const killOthers = (e) => {
      try {
        e.stopImmediatePropagation();
        delete e.returnValue;
        e.returnValue = undefined;
      } catch {}
    };
    const restore = () => {
      try { window.removeEventListener("beforeunload", killOthers, { capture: true }); } catch {}
      try { window.removeEventListener("beforeunload", killOthers, { capture: false }); } catch {}
      try { window.onbeforeunload = prevOnBeforeUnload; } catch {}
    };
    try { window.onbeforeunload = null; } catch {}
    window.addEventListener("beforeunload", killOthers, { capture: true });
    window.addEventListener("beforeunload", killOthers, { capture: false });

    const href = window.location.href;
    // Same-URL-safe strategies only: reload() and replace() both re-navigate to
    // the current URL. (Assigning location.href = <same url> is a no-op, so it is
    // deliberately excluded — it would look like a strategy but never navigate.)
    const strategies = [
      () => location.reload(),
      () => location.replace(href),
    ];
    let committed = false;
    const timers = [];
    const clearAll = () => { for (const t of timers) { try { clearTimeout(t); } catch {} } };
    const onCommit = () => { committed = true; clearAll(); };
    // pagehide/unload fire the instant navigation actually commits.
    window.addEventListener("pagehide", onCommit, { once: true, capture: true });
    window.addEventListener("unload", onCommit, { once: true, capture: true });

    strategies.forEach((fn, i) => {
      timers.push(setTimeout(() => {
        if (committed) return;
        try {
          if (i > 0) console.warn(`${TAG} reload escalation ${i}: navigation didn't commit, trying next strategy`);
          fn();
        } catch (e) {
          console.warn(`${TAG} reload strategy ${i} threw`, e);
        }
      }, i * RELOAD_ESCALATE_MS));
    });

    // Final watchdog — all strategies exhausted without a commit.
    timers.push(setTimeout(() => {
      if (committed) return;
      try { window.removeEventListener("pagehide", onCommit, { capture: true }); } catch {}
      try { window.removeEventListener("unload", onCommit, { capture: true }); } catch {}
      restore();
      console.warn(`${TAG} reload watchdog fired — ${strategies.length} strategies exhausted, navigation didn't commit; restored beforeunload state`);
    }, (strategies.length - 1) * RELOAD_ESCALATE_MS + RELOAD_WATCHDOG_MS));
  }

  async function loadOrCreateSecret() {
    // Foundry's upload validator rejects filenames starting with `.` (the
    // historical `.secret` produced a "disallowed extension" error every boot,
    // and the file was never persisted — so a fresh secret was generated each
    // reload, silently breaking evalGM auth for any cached token). Use a `.txt`
    // name so the upload succeeds and the secret survives across boots.
    const url = `/${worldDir()}/bridge-secret.txt`;
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
    const file = new File([blob], "bridge-secret.txt", { type: "text/plain" });
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
      pollIntervalActiveMs: POLL_INTERVAL_ACTIVE_MS,
      pollIntervalIdleMs: POLL_INTERVAL_IDLE_MS,
      processedThisSession: processed.size,
      skillSurface: { ...skillSurface }
    };
    try {
      await uploadJson(worldDir(), "state.json", state);
    } catch (e) {
      // Heartbeat failures are non-fatal; the next tick retries.
    }
  }

  // ------------------------------------------------------------------------
  // Skill-surface watcher — see the `skillSurface` declaration above.
  // ------------------------------------------------------------------------

  // Continue the previous boot's count so the gate can compare across reloads.
  // A missing/blank previous heartbeat leaves `seeded:false`, which the reader
  // treats as "unknown" rather than "unchanged".
  async function seedSkillSurface() {
    try {
      const prev = await fetchJson(`/${worldDir()}/state.json?ts=${Date.now()}`);
      const seq = Number(prev?.skillSurface?.seq);
      if (Number.isFinite(seq) && seq >= 0) {
        skillSurface = { seq, at: prev.skillSurface.at ?? null, last: prev.skillSurface.last ?? null, seeded: true };
        return;
      }
      // A heartbeat that predates this field is a legitimate first run, not a
      // lost count — start clean and comparable.
      skillSurface = { seq: 0, at: null, last: null, seeded: true };
    } catch {
      skillSurface = { seq: 0, at: null, last: null, seeded: false };
      console.warn(`${TAG} could not seed the skill-surface counter — the regression gate will not skip on data this boot.`);
    }
  }

  // LEADING edge + trailing edge, deliberately. A trailing-only debounce loses
  // the bump entirely if the page reloads inside the window — and authoring
  // then reloading is a routine move here, so "seq never reached disk" would
  // leave the gate comparing two stale-but-equal keys and skipping a sweep it
  // owed. Flushing the first bump of a burst immediately keeps that window at
  // milliseconds; the trailing flush then folds in the rest of the burst.
  function flushSkillSurfaceSoon() {
    const now = Date.now();
    const since = now - surfaceFlushAt;
    const write = async () => {
      surfaceFlushAt = Date.now();
      try { await writeHeartbeat(); lastHeartbeatAt = Date.now(); } catch {}
    };
    if (since >= SURFACE_FLUSH_MS) { void write(); return; }
    if (surfaceFlushTimer) return;
    surfaceFlushTimer = setTimeout(() => { surfaceFlushTimer = null; void write(); }, SURFACE_FLUSH_MS - since);
  }

  function noteSkillSurfaceChange(what) {
    skillSurface = {
      seq: skillSurface.seq + 1,
      at: new Date().toISOString(),
      last: String(what).slice(0, 160),
      seeded: skillSurface.seeded,
    };
    flushSkillSurfaceSoon();
  }

  // Does this update payload touch AUTHORED content? Play writes hp/mp/ip and
  // battle logs constantly; treating those as authoring would sweep on every
  // turn of a live session. flattenObject normalizes both nested and dotted
  // update forms, so `{system:{props:{x:1}}}` and `{"system.props.x":1}` match.
  function touchesAuthoring(changes) {
    let keys;
    try { keys = Object.keys(foundry.utils.flattenObject(changes || {})); }
    catch { return true; }   // unparseable → assume it mattered
    return keys.some((k) =>
      k === "name" ||
      k.startsWith("system.props") ||
      k.startsWith("flags.custom-system-builder") ||
      k.startsWith("flags.fabula-ultima-companion"));
  }

  const onActor = (doc) =>
    doc?.parent?.documentName === "Actor" || doc?.parent?.parent?.documentName === "Actor";

  // Only AEs that can change a compute result: a transfer AE (gear/passive
  // grants, including the equip toggle that flips `disabled`) or one carrying a
  // reaction config. A plain combat status is play, not authoring.
  const aeMatters = (ae) =>
    ae?.transfer === true || !!ae?.flags?.["fabula-ultima-companion"]?.reactionConfig;

  function watchSkillSurface() {
    if (surfaceHooked) return;
    surfaceHooked = true;
    Hooks.on("createItem", (doc) => { if (onActor(doc)) noteSkillSurfaceChange(`+item ${doc.name}`); });
    Hooks.on("deleteItem", (doc) => { if (onActor(doc)) noteSkillSurfaceChange(`-item ${doc.name}`); });
    Hooks.on("updateItem", (doc, changes) => {
      if (onActor(doc) && touchesAuthoring(changes)) noteSkillSurfaceChange(`~item ${doc.name}`);
    });
    Hooks.on("createActiveEffect", (ae) => { if (onActor(ae) && aeMatters(ae)) noteSkillSurfaceChange(`+ae ${ae.name}`); });
    Hooks.on("deleteActiveEffect", (ae) => { if (onActor(ae) && aeMatters(ae)) noteSkillSurfaceChange(`-ae ${ae.name}`); });
    Hooks.on("updateActiveEffect", (ae) => { if (onActor(ae) && aeMatters(ae)) noteSkillSurfaceChange(`~ae ${ae.name}`); });
    // The bench roster is a live predicate over the actor list, so the roster
    // itself changing is a surface change. `updateActor` is deliberately NOT
    // watched — that is where resource churn lives.
    Hooks.on("createActor", (doc) => noteSkillSurfaceChange(`+actor ${doc.name}`));
    Hooks.on("deleteActor", (doc) => noteSkillSurfaceChange(`-actor ${doc.name}`));
  }

  // Re-entrancy guard. `pollInbox` awaits `handleRequest`, so one long request
  // (a bench build, a 30-skill regression page) keeps a tick inside this
  // function for minutes. The watchdog stamps staleness off `lastPollTickAt`,
  // which only advances when a tick STARTS — so a legitimately-long request
  // looks like a stalled chain, the watchdog re-arms, and a SECOND poll chain
  // starts while the first is still mid-request. Two chains listing the same
  // inbox is how one `bench` invocation built two "Regression Bench" scenes
  // ~200ms apart (2026-08-02). Serialising here makes the overlap impossible;
  // the watchdog's re-arm then just replaces the timer, which is harmless.
  let polling = false;

  async function pollInbox() {
    if (polling) return;
    polling = true;
    try {
      return await pollInboxInner();
    } finally {
      polling = false;
    }
  }

  async function pollInboxInner() {
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

    // Any unprocessed request — even one we'll skip due to outbox dedup —
    // counts as activity, so the bridge stays on the fast poll rate while the
    // user is interacting with it.
    if (reqFiles.length > 0) lastActivityAt = Date.now();

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
      markProcessed(fileUrl);
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
      // A long request is PROGRESS, not a stall. Without this the watchdog
      // (stale at 60s, measured from the last tick START) fires mid-request and
      // re-arms the poll chain — see the re-entrancy note above.
      lastPollTickAt = Date.now();
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
        // The doc comment at the top of this file shows `auth` at the top
        // level of the request envelope; accept either there or inside `args`
        // (some early callers wrote it inside args). Either form works.
        const auth = req.auth ?? args.auth;
        if (!auth || auth !== secret) {
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

      case "screenshot": {
        // Capture the PIXI map canvas (tokens / effects / animations) and
        // write a PNG/JPEG into outbox/. DOM-side UI (chat, sheets, dialogs)
        // is queryable as HTML — use `query/domSnapshot` for that, not this.
        const {
          target = "canvas",
          format = "png",
          quality = 0.92,
          filename
        } = args;
        if (target !== "canvas") {
          // Reserved for a future Electron-IPC path. Today the renderer
          // doesn't have a reliable way to grab the whole window; chat /
          // sheets / dialogs go through domSnapshot.
          throw new Error(`screenshot: only target="canvas" is supported (got "${target}")`);
        }
        if (format !== "png" && format !== "jpeg") {
          throw new Error(`screenshot: format must be "png" or "jpeg" (got "${format}")`);
        }
        const extract = canvas?.app?.renderer?.extract;
        if (!extract) throw new Error("screenshot: PIXI extract plugin unavailable (no active scene?)");

        const mime = `image/${format}`;
        const dataUrl = await extract.base64(canvas.app.stage, mime, quality);
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("screenshot: extract.base64 returned malformed data URL");
        const b64 = dataUrl.slice(comma + 1);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const safeId = String(req.id).replace(/[^A-Za-z0-9_-]/g, "_");
        const name = (filename && /^[A-Za-z0-9._-]+$/.test(filename))
          ? filename
          : `shot-${safeId}.${format === "jpeg" ? "jpg" : "png"}`;
        const blob = new Blob([bytes], { type: mime });
        const file = new File([blob], name, { type: mime });
        await FilePicker.upload(SOURCE, outboxDir(), file, {}, { notify: false });

        return {
          path: `${outboxDir()}/${name}`,
          bytes: bytes.length,
          format,
          width: canvas.app.renderer.width,
          height: canvas.app.renderer.height,
          sceneId: canvas.scene?.id ?? null,
          sceneName: canvas.scene?.name ?? null
        };
      }

      case "getLogs": {
        const tap = globalThis.__FUConsoleTap;
        if (!tap) throw new Error("getLogs: __FUConsoleTap not installed (is _console-tap.js loaded?)");
        return tap.snapshot(args);
      }

      case "reload": {
        const delayMs = Math.max(50, Math.min(10000, Number(args.delayMs ?? 250)));
        // Schedule reload AFTER the response is written. Watcher's caller
        // (handleRequest) writes the response after dispatch returns, so
        // we set the timer here and let dispatch return immediately.
        // beforeunload tampering + reload are wrapped in
        // suppressBeforeUnloadAndReload() which self-restores via watchdog
        // if the navigation doesn't actually commit.
        setTimeout(async () => {
          try {
            // Blank our own request FIRST so a reload that commits can't leave
            // this file behind to re-trigger another reload on the next boot.
            await emptyInboxRequest(req.id);
            try { await armActivationSentinel("reload"); }
            catch (e) { console.warn(`${TAG} failed to arm activation sentinel pre-reload`, e); }
            suppressBeforeUnloadAndReload();
          } catch (e) {
            console.warn(`${TAG} reload failed`, e);
          }
        }, delayMs);
        // preReloadBootId lets the caller VERIFY the reload actually committed:
        // poll state.json until bootId differs from this value (a fresh boot
        // regenerates it). If it never changes, the reload was swallowed — the
        // reload pathology — and the caller can surface that instead of hanging.
        return { reloading: true, delayMs, sentinelArmed: true, preReloadBootId: bootId };
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
      case "domSnapshot": {
        // Return HTML / text from the live DOM. Use this for chat-log entries,
        // dialog contents, sheet windows — anything rendered by the browser
        // rather than the PIXI canvas. For PIXI content use `screenshot`.
        //
        // filter:
        //   selector  — CSS selector (default "body"). If "all", returns an
        //               array of matches (capped at maxMatches).
        //   attribute — "outerHTML" | "innerHTML" | "innerText" | "textContent"
        //               (default "outerHTML")
        //   maxMatches — cap when selector="all" (default 20)
        //   maxBytes  — per-match byte cap (default 64 KiB)
        const {
          selector = "body",
          attribute = "outerHTML",
          maxMatches = 20,
          maxBytes = 64 * 1024
        } = filter;
        const ALLOWED_ATTRS = new Set(["outerHTML", "innerHTML", "innerText", "textContent"]);
        if (!ALLOWED_ATTRS.has(attribute)) {
          throw new Error(`query/domSnapshot: attribute must be one of ${Array.from(ALLOWED_ATTRS).join(", ")}`);
        }
        const trim = (s) => {
          if (typeof s !== "string") return s;
          if (s.length <= maxBytes) return s;
          return s.slice(0, maxBytes) + `…[truncated +${s.length - maxBytes} bytes]`;
        };
        const effective = selector === "all" ? "*" : selector;
        let nodes;
        try { nodes = document.querySelectorAll(effective); }
        catch (e) { throw new Error(`query/domSnapshot: bad selector "${selector}": ${e.message}`); }
        if (!nodes.length) return { found: false, selector };
        const slice = Array.from(nodes).slice(0, Math.max(1, maxMatches));
        const matches = slice.map(el => ({
          tag: el.tagName?.toLowerCase() ?? null,
          id: el.id || null,
          classes: el.className && typeof el.className === "string" ? el.className : null,
          content: trim(el[attribute] ?? null)
        }));
        return {
          found: true,
          selector,
          attribute,
          totalMatches: nodes.length,
          returnedMatches: matches.length,
          matches
        };
      }
      default:
        throw new Error(`unknown query kind: ${kind}`);
    }
  }

  // Opt-in default-on: when the "auto-start" client setting is enabled, the
  // bridge boots on every GM reload with no sentinel required. The setting
  // ships OFF, so a fresh install / co-dev stays dormant. Independently, an
  // armed activation sentinel still boots the bridge (Claude-driven reload
  // keepalive), regardless of the setting.
  async function bootBridge() {
    if (!game.user?.isGM) {
      console.info(`${TAG} bridge inactive (not GM).`);
      return;
    }
    // Ensure the world dir exists before boot() creates inbox/outbox under it.
    await ensureDir(worldDir());
    const sentinel = await consumeActivationSentinel().catch(() => null);
    let autoStart = false;
    try { autoStart = !!game.settings.get(MODULE_ID, SETTING_AUTOSTART); }
    catch { /* unregistered (shouldn't happen post-init) — treat as off */ }

    if (!autoStart && !sentinel) {
      console.info(
        `${TAG} dormant. Enable "Test Bridge: auto-start" in settings, write a ` +
        `non-empty bridge-activate.txt to the world dir, or call ` +
        `FUCompanion.api.testBridge.activate() / .start().`
      );
      return;
    }
    // Sentinel-driven boot (setting off): re-arm to keep alive across reloads,
    // matching the original Claude-driven keepalive. When the setting is on we
    // don't need the sentinel at all.
    if (sentinel && !autoStart) {
      await armActivationSentinel("auto-re-arm-on-boot").catch(
        e => console.warn(`${TAG} auto-re-arm failed (non-fatal)`, e)
      );
    }
    console.info(
      `${TAG} starting bridge (${autoStart ? "auto-start setting on" : "activation sentinel"}).`
    );
    await boot();
  }

  // Quarantine every request already sitting in the inbox at boot. Such a
  // request was written by a client of a PREVIOUS bridge session; that client
  // is gone (or has long since timed out), so nobody is waiting on the result —
  // but re-running it would re-apply a world mutation. Observed 2026-08-02: a
  // headless client killed mid-run left two `req-rg-*.json` behind, and the
  // next boot replayed a bench build, creating a SECOND "Regression Bench"
  // scene ~200ms after the legitimate one (which then made `teardown` refuse:
  // "2 scenes named … — refusing to guess").
  //
  // The pre-existing outbox dedup (skip when res-<id>.json exists) does not
  // cover this: it only helps while the RESPONSE file survives, and a client
  // that deletes the res but dies before deleting the req — or one killed
  // between the two unlinks — leaves exactly the replayable state.
  //
  // Marking them processed (rather than deleting) keeps the files around for
  // post-mortem, and the ordinary FIFO eviction cleans the set up later.
  async function quarantineStaleInbox() {
    let listing = null;
    try { listing = await FilePicker.browse(SOURCE, inboxDir()); }
    catch { return; }
    const stale = (listing?.files ?? []).filter(f => /\/req-[A-Za-z0-9_-]+\.json$/.test(f));
    if (!stale.length) return;
    for (const fileUrl of stale) markProcessed(fileUrl);
    console.warn(
      `${TAG} quarantined ${stale.length} stale inbox request(s) from a previous session — NOT replayed: `
      + stale.map(f => f.split("/").pop()).join(", ")
    );
  }

  async function boot() {
    await ensureDir(inboxDir());
    await ensureDir(outboxDir());

    bootId = foundry.utils.randomID(16);
    secret = await loadOrCreateSecret();
    lastActivityAt = Date.now();
    lastHeartbeatAt = Date.now();
    lastPollTickAt = 0;

    // MUST run before the first poll — otherwise the poll loop picks the
    // leftovers up and re-executes them.
    await quarantineStaleInbox();

    // Seed BEFORE the first heartbeat, or that heartbeat publishes seq 0 and
    // overwrites the previous boot's count we are trying to continue from.
    await seedSkillSurface();
    watchSkillSurface();

    await writeHeartbeat();

    scheduleNextPoll();
    startWatchdog();

    console.info(
      `${TAG} bridge ready. bootId=${bootId} dir=${worldDir()} ` +
      `poll=${POLL_INTERVAL_ACTIVE_MS}ms (idle ${POLL_INTERVAL_IDLE_MS}ms after ${IDLE_AFTER_MS}ms) ` +
      `watchdog=${WATCHDOG_INTERVAL_MS}ms (stale at ${WATCHDOG_STALE_MS}ms)`
    );
  }

  function scheduleNextPoll() {
    const idle = (Date.now() - lastActivityAt) > IDLE_AFTER_MS;
    const intervalMs = idle ? POLL_INTERVAL_IDLE_MS : POLL_INTERVAL_ACTIVE_MS;
    pollTimer = setTimeout(async () => {
      lastPollTickAt = Date.now();
      // try/finally guarantees scheduleNextPoll runs even if a future edit
      // introduces a throw outside the inner try/catches. Previously, any
      // unexpected exception between the catches and the recursive call would
      // permanently break the polling chain — bridge would appear "dead" with
      // no log line explaining why.
      try {
        try { await pollInbox(); }
        catch (e) { console.warn(`${TAG} poll error`, e); }
        if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
          try {
            await writeHeartbeat();
            lastHeartbeatAt = Date.now();
          } catch {}
        }
      } finally {
        try { scheduleNextPoll(); }
        catch (e) { console.error(`${TAG} scheduleNextPoll threw — watchdog will re-arm`, e); }
      }
    }, intervalMs);
  }

  // Self-healing watchdog. If pollTimer is set but no tick has run in
  // WATCHDOG_STALE_MS, the chain is broken (or setTimeout was throttled
  // away by Chromium background-tab suspension). Clear the stale timer
  // handle and reschedule. The watchdog itself is also subject to
  // background throttling, but it resumes promptly when the window regains
  // focus, which is exactly when we want recovery to fire.
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!pollTimer) return;             // legitimately stopped
      if (!lastPollTickAt) return;        // boot just happened, give it a cycle
      const sinceLastTick = Date.now() - lastPollTickAt;
      if (sinceLastTick <= WATCHDOG_STALE_MS) return;
      console.warn(
        `${TAG} watchdog: no poll tick for ${sinceLastTick}ms — re-arming polling`
      );
      try { clearTimeout(pollTimer); } catch {}
      pollTimer = null;
      try { scheduleNextPoll(); }
      catch (e) { console.error(`${TAG} watchdog reschedule failed`, e); }
    }, WATCHDOG_INTERVAL_MS);
  }

  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, SETTING_AUTOSTART, {
        name: "Test Bridge: auto-start on boot",
        hint: "When on, the file-based test bridge (GM only) starts on every " +
          "reload without needing an activation sentinel. Client-scoped — " +
          "follows this browser, never travels with the world. Leave off for " +
          "normal play; the bridge adds background file-polling + heartbeats.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
      });
    } catch (e) { /* already registered — fine */ }
  });

  Hooks.once("ready", () => {
    bootBridge().catch(e => console.error(`${TAG} boot failed`, e));
  });

  // Stop the poller as early as possible during shutdown so in-flight
  // FilePicker.browse / upload calls don't race the Electron close handshake.
  // pagehide fires reliably on both reload and window-close; the listener
  // is idempotent and safe to call even when the bridge is dormant.
  window.addEventListener("pagehide", () => {
    if (pollTimer) { try { clearTimeout(pollTimer); } catch {} pollTimer = null; }
    if (watchdogTimer) { try { clearInterval(watchdogTimer); } catch {} watchdogTimer = null; }
    // A pending TRAILING flush can't complete during the close handshake; drop
    // it rather than let it race the teardown. Safe because the burst's leading
    // flush already put a bumped seq on disk — what is lost is at most the tail
    // of a burst that already registered as "changed".
    if (surfaceFlushTimer) { try { clearTimeout(surfaceFlushTimer); } catch {} surfaceFlushTimer = null; }
  }, { capture: true });

  // Expose a tiny inspection API for the console / other modules.
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};
  API_ROOT.api.testBridge = {
    get bootId()    { return bootId; },
    get worldDir()  { return worldDir(); },
    get processed() { return Array.from(processed.keys()); },
    get running()   { return !!pollTimer; },
    get lastPollTickAt() { return lastPollTickAt; },
    get sinceLastTickMs() { return lastPollTickAt ? Date.now() - lastPollTickAt : null; },
    get watchdogRunning() { return !!watchdogTimer; },
    forceHeartbeat: writeHeartbeat,
    // Arm the sentinel and reload. Use this if you intentionally want the
    // bridge running on the *next* boot (e.g. starting a Claude session).
    async activate() {
      if (!game.user?.isGM) { console.warn(`${TAG} GM only.`); return; }
      const token = await armActivationSentinel("api.activate");
      console.info(`${TAG} sentinel armed (${token.slice(0, 24)}...). Reloading...`);
      suppressBeforeUnloadAndReload();
    },
    // Activate the bridge in-place without reloading. Use this when the page
    // is responsive and you don't want to lose UI state.
    async start() {
      if (!game.user?.isGM) { console.warn(`${TAG} GM only.`); return; }
      if (pollTimer) { console.info(`${TAG} already running.`); return; }
      await boot();
    },
    stop() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      console.info(`${TAG} stopped.`);
    }
  };
})();
