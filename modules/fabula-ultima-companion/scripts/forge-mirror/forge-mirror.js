/**
 * scripts/forge-mirror/forge-mirror.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads Forge files from the host's mirror instead of from Forge.
 *
 * Why this is needed:
 *   For players on some ISPs the FIRST download of a Forge file crawls: on
 *   2026-10-28 map backgrounds took 223–520 s and players reloaded. The same
 *   file served by the host took ~1 s. Forge's CDN keeps copies ~8 minutes and
 *   never caches audio, so most map changes and every sound paid that again.
 *   See docs/investigations/player-reloads.
 *
 * How it works:
 *   tools/forge-mirror/sync.mjs keeps Data/forge-mirror/ an exact copy of every
 *   Forge file the game uses, listed in forge-mirror/manifest.json. This script
 *   rewrites a Forge URL to that copy ONLY when the manifest holds that exact
 *   file (same path, same ?v=). World data and code keep their Forge URLs;
 *   Forge stays the source of truth. No manifest (e.g. a dev machine without a
 *   mirror) → this script does nothing.
 *
 *   Redirect points (all fall back to Forge if the mirror copy fails):
 *     1. PIXI.Assets.load — registers the Forge URL as an alias of the mirror
 *        file, so Foundry's texture cache keeps working under the Forge URL
 *        (getTexture / unload). Maps, tiles, tokens, status icons, video tiles.
 *        If the mirror copy fails, the Forge copy is loaded here: Foundry's own
 *        cache-bust retry is switched off for Forge URLs by the Forge module.
 *     2. fetch — audio buffers, Sequencer, the module's own downloads.
 *     3. src of <img>/<video>/<audio>/<source> (property and setAttribute) —
 *        streamed music, battle-animation and cut-in videos, image preloads.
 *   Not covered: images inside HTML that Foundry renders (sheets, journals,
 *   chat) — they still load from Forge.
 *
 *   Forge URLs met here that the mirror doesn't hold are reported to the
 *   primary GM, who writes them with every Forge URL in the world data to
 *   forge-mirror/wanted.json for the next sync.
 *
 * Switch: world setting `forgeMirror` (default on). Off = everything from Forge.
 */
(() => {
  const TAG = "[FUCompanion][ForgeMirror]";
  const MODULE_ID = "fabula-ultima-companion";
  const SETTING = "forgeMirror";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const MSG_MISS = "FU_FORGE_MIRROR_MISS";
  const FORGE = "https://assets.forge-vtt.com/";
  const FORGE_RE = /https:\/\/assets\.forge-vtt\.com\/[^\s"'`<>\\]+/g;
  const DIR = "forge-mirror";
  const MANIFEST_WAIT_MS = 3000;
  const MISS_REPORT_MS = 30000;
  const EXPORT_DELAY_MS = 60000;
  const FULL_SCAN_MS = 30 * 60000;

  const route = p => foundry.utils.getRoute(p);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? game.user?.isGM ?? false;
  const record = (kind, data) => { try { globalThis.FUCompanion?.api?.clientHealth?.record?.(kind, data); } catch { /* logger optional */ } };

  // ── state ──────────────────────────────────────────────────────────────────
  let files = null;              // manifest.files once loaded: key -> { size, md5, q, file? }
  let switchOn = true;           // the world setting; unknown before init counts as on
  const stats = { hits: 0, misses: 0, fallbacks: 0 };
  let reported = { hits: 0, misses: 0, fallbacks: 0 };
  const missed = new Set();      // Forge URLs the mirror doesn't hold
  const unsent = new Set();      // …not yet reported to the GM

  const manifestStart = performance.now();
  let manifestMs = null;
  let manifestSettled = false;
  const manifestReady = fetchOriginal(route(`${DIR}/manifest.json`), { cache: "no-cache" })
    .then(r => (r.ok ? r.json() : null))
    .then(m => { files = m?.files ?? null; manifestMs = Math.round(performance.now() - manifestStart); return !!files; })
    .catch(() => false)
    .finally(() => { manifestSettled = true; });

  const active = () => !!files && switchOn;
  // loads that start before the manifest arrives wait for it (briefly); afterwards no waiting at all
  const untilManifest = () => (manifestSettled ? null : Promise.race([manifestReady, wait(MANIFEST_WAIT_MS)]));

  // ── URL → mirror ───────────────────────────────────────────────────────────
  function keyOf(url) {
    if (typeof url !== "string" || !url.startsWith(FORGE)) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    for (const k of u.searchParams.keys()) if (k !== "v") return null;   // e.g. Foundry's ?cors-retry: let it reach Forge
    let key;
    try { key = decodeURIComponent(u.pathname.replace(/^\/+/, "")); } catch { return null; }
    return { key, q: u.searchParams.get("v") };
  }

  function entryOf(url) {
    if (!files) return null;
    const k = keyOf(url);
    if (!k) return null;
    const e = files[k.key];
    // qs = every ?v= the mirror was synced for; an unseen ?v may be a re-upload → Forge until the next sync
    const qs = Array.isArray(e?.qs) ? e.qs : [e?.q ?? null];
    if (!e || !qs.includes(k.q ?? null)) return { miss: true };
    return { path: e.file ?? k.key };
  }

  /** The mirror URL for a Forge URL, or null (not Forge, not mirrored, or switched off). */
  function mirrorOf(url) {
    if (!active() || typeof url !== "string" || !url.startsWith(FORGE)) return null;
    const e = entryOf(url);
    if (!e) return null;
    if (e.miss) { noteMiss(url); return null; }
    stats.hits++;
    return route(`${DIR}/${e.path.split("/").map(encodeURIComponent).join("/")}`);
  }

  function noteMiss(url) {
    const clean = url.split("#")[0];
    if (missed.has(clean)) return;
    missed.add(clean);
    unsent.add(clean);
    stats.misses++;
  }

  // ── 1. PIXI.Assets.load: alias the Forge URL to the mirror file ────────────
  function patchPixi() {
    const A = globalThis.PIXI?.Assets;
    if (!A?.load || A.load.fuForgeMirror) return;
    const load = A.load.bind(A);
    const aliased = new Set();
    const patched = async function (urls, onProgress) {
      const pending = untilManifest();
      if (pending) await pending;
      const list = Array.isArray(urls) ? urls : [urls];
      for (const u of list) {
        if (typeof u !== "string" || !u.startsWith(FORGE) || aliased.has(u)) continue;
        if (A.cache?.has?.(u) || A.resolver?.hasKey?.(u)) continue;    // already loaded from Forge, or known to PIXI
        const m = mirrorOf(u);
        if (!m) continue;
        try { A.add({ alias: u, src: m }); aliased.add(u); } catch (err) { console.warn(TAG, "alias failed", u, err); }
      }
      try { return await load(urls, onProgress); }
      catch (err) {
        // Nothing else retries a Forge texture: the Forge module turns Foundry's cache-bust
        // retry off for Forge URLs. So load the Forge copy here, under a parameter the alias
        // doesn't match, and file it under the original key so getTexture(url) finds it.
        if (typeof urls !== "string" || !aliased.has(urls)) throw err;
        stats.fallbacks++;
        console.warn(TAG, "mirror copy failed, loading it from Forge", urls, err);
        const asset = await load(`${urls}${urls.includes("?") ? "&" : "?"}fu-mirror-fallback=1`, onProgress);
        try { if (!A.cache.has(urls)) A.cache.set(urls, asset); } catch { /* best effort */ }
        return asset;
      }
    };
    patched.fuForgeMirror = true;
    A.load = patched;
  }

  // ── 2. fetch ───────────────────────────────────────────────────────────────
  function fetchOriginal(...args) { return (globalThis.fetch.fuOriginal ?? globalThis.fetch).apply(globalThis, args); }
  function patchFetch() {
    const orig = globalThis.fetch;
    if (!orig || orig.fuForgeMirror) return;
    const patched = async function (input, init) {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.href : null);
      if (url?.startsWith(FORGE)) {
        const pending = untilManifest();
        if (pending) await pending;
        const m = mirrorOf(url);
        if (m) {
          try {
            const res = await orig.call(globalThis, m, init);
            if (res.ok) return res;
          } catch { /* fall back below */ }
          stats.fallbacks++;
        }
      }
      return orig.call(globalThis, input, init);
    };
    patched.fuForgeMirror = true;
    patched.fuOriginal = orig;
    globalThis.fetch = patched;
  }

  // ── 3. element src (property and setAttribute) ─────────────────────────────
  const MEDIA_TAGS = () => [globalThis.HTMLImageElement, globalThis.HTMLMediaElement, globalThis.HTMLSourceElement].filter(Boolean);
  const isMediaEl = el => MEDIA_TAGS().some(C => el instanceof C);
  let setAttributeOrig = null;

  // if the mirror copy fails, put the Forge URL back (only if the element still points at our copy)
  function armFallback(el, mirrorUrl, original, setSrc) {
    const onError = () => {
      const now = el.getAttribute("src");
      if (now !== mirrorUrl) return;
      stats.fallbacks++;
      setSrc(original);
      if (globalThis.HTMLSourceElement && el instanceof HTMLSourceElement) el.parentElement?.load?.();
    };
    el.addEventListener("error", onError, { once: true });
  }

  function patchElements() {
    for (const C of MEDIA_TAGS()) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, "src");
      if (!d?.set || d.set.fuForgeMirror) continue;
      const set = function (v) {
        const m = typeof v === "string" ? mirrorOf(v) : null;
        if (!m) return d.set.call(this, v);
        armFallback(this, m, v, orig => d.set.call(this, orig));
        return d.set.call(this, m);
      };
      set.fuForgeMirror = true;
      Object.defineProperty(C.prototype, "src", { ...d, set });
    }
    const sa = Element.prototype.setAttribute;
    if (sa.fuForgeMirror) return;
    setAttributeOrig = sa;
    const patched = function (name, value) {
      if (typeof value === "string" && String(name).toLowerCase() === "src" && isMediaEl(this)) {
        const m = mirrorOf(value);
        if (m) {
          armFallback(this, m, value, orig => sa.call(this, "src", orig));
          return sa.call(this, name, m);
        }
      }
      return sa.call(this, name, value);
    };
    patched.fuForgeMirror = true;
    Element.prototype.setAttribute = patched;
  }

  patchFetch();
  patchPixi();
  patchElements();

  // API from the start: the load indicator asks has() during world entry, before `ready`
  const mirrorPath = e => route(`${DIR}/${e.path.split("/").map(encodeURIComponent).join("/")}`);
  ((globalThis.FUCompanion ??= {}).api ??= {}).forgeMirror = {
    state: () => ({ mirrored: files ? Object.keys(files).length : 0, on: active(), manifestMs, ...stats, missedUrls: missed.size }),
    /** Mirror URL for a Forge URL, or null. Does not count as a hit. */
    resolve: url => { const e = active() ? entryOf(url) : null; return e && !e.miss ? mirrorPath(e) : null; },
    has: url => { const e = active() ? entryOf(url) : null; return !!e && !e.miss; },
    misses: () => [...missed],
    exportNow: null,   // primary GM only, set at ready
  };

  // ── misses → primary GM ────────────────────────────────────────────────────
  function reportMisses() {
    if (!unsent.size || !game.socket?.connected) return;
    const urls = [...unsent];
    unsent.clear();
    if (isPrimaryGM()) addRuntime(urls);
    else game.socket.emit(SOCKET_NS, { type: MSG_MISS, urls });
  }

  // ── primary GM: forge-mirror/wanted.json ───────────────────────────────────
  const worldUrls = new Set();
  const runtimeUrls = new Set();
  let lastWritten = null;
  let writeTimer = null;
  let folderExists = null;

  function scanValue(value, into) {
    for (const m of String(value ?? "").match(FORGE_RE) ?? []) into.add(m.replace(/[),;]+$/, ""));
  }
  // The whole world takes ~1 s to scan; yield every ~8 ms so the GM's game never stalls.
  async function fullScan() {
    const t0 = performance.now();
    const found = new Set();
    let slice = performance.now();
    for (const coll of game.collections.values()) {
      for (const doc of coll) {
        try { scanValue(JSON.stringify(doc._source), found); } catch { /* skip */ }
        if (performance.now() - slice > 8) { await wait(0); slice = performance.now(); }
      }
    }
    for (const s of game.settings.storage.get("world") ?? []) scanValue(s.value, found);
    for (const e of CONFIG.statusEffects ?? []) scanValue(e.img ?? e.icon, found);
    worldUrls.clear();
    for (const u of found) worldUrls.add(u);
    return Math.round(performance.now() - t0);
  }
  function addRuntime(urls) {
    let added = false;
    for (const u of urls ?? []) if (typeof u === "string" && u.startsWith(FORGE) && !runtimeUrls.has(u)) { runtimeUrls.add(u); added = true; }
    if (added) scheduleWrite();
  }
  function scheduleWrite(delay = 120000) {
    if (writeTimer) return;
    writeTimer = setTimeout(() => { writeTimer = null; writeWanted(); }, delay);
  }
  async function hasFolder() {
    if (folderExists !== null) return folderExists;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker.implementation ?? FilePicker;
    try { await FP.browse("data", DIR); folderExists = true; } catch { folderExists = false; }
    return folderExists;
  }
  async function writeWanted() {
    if (!isPrimaryGM() || !(await hasFolder())) return null;
    const body = { from: "gm-client", world: [...worldUrls].sort(), runtime: [...runtimeUrls].sort() };
    const sig = JSON.stringify(body);
    if (sig === lastWritten) return null;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker.implementation ?? FilePicker;
    try {
      const file = new File([JSON.stringify({ generated: new Date().toISOString(), ...body }, null, 1)], "wanted.json", { type: "application/json" });
      const res = await FP.upload("data", DIR, file, {}, { notify: false });
      if (!res?.path) throw new Error("no path in upload response");
      lastWritten = sig;
      console.info(TAG, `wanted.json: ${body.world.length} world + ${body.runtime.length} runtime Forge URLs`);
      return res.path;
    } catch (err) {
      console.warn(TAG, "wanted.json upload failed", err);
      return null;
    }
  }
  async function gmStart() {
    // keep what earlier sessions learned at runtime (e.g. the image a wildcard token picked)
    try {
      const r = await fetchOriginal(route(`${DIR}/wanted.json`), { cache: "no-cache" });
      if (r.ok) for (const u of (await r.json())?.runtime ?? []) runtimeUrls.add(u);
    } catch { /* first run */ }
    const run = async () => {
      const ms = await fullScan();
      console.info(TAG, `world scan: ${worldUrls.size} Forge URLs in ${ms} ms`);
      await writeWanted();
    };
    const idle = cb => (globalThis.requestIdleCallback ? requestIdleCallback(cb, { timeout: 15000 }) : setTimeout(cb, 0));
    setTimeout(() => idle(run), EXPORT_DELAY_MS);
    setInterval(() => idle(run), FULL_SCAN_MS);
    Hooks.on("canvasReady", () => {
      if (!canvas.scene) return;
      const before = worldUrls.size;
      try { scanValue(JSON.stringify(canvas.scene._source), worldUrls); } catch { /* skip */ }
      if (worldUrls.size !== before) scheduleWrite();
    });
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, SETTING, {
        name: "Serve Forge files from the game host",
        hint: "Players load map images, tokens, icons, music and animations that the host has mirrored (tools/forge-mirror) from the host instead of from Forge. Turn off to load everything from Forge; it applies to the next file loaded, nobody needs to reload.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: on => { switchOn = on !== false; },
      });
      switchOn = game.settings.get(MODULE_ID, SETTING) !== false;
    } catch (err) {
      console.warn(TAG, "setting registration failed (mirror stays on)", err);
    }
  });

  Hooks.once("ready", async () => {
    await manifestReady;
    const count = files ? Object.keys(files).length : 0;
    console.info(TAG, files ? `${count} mirrored files, manifest in ${manifestMs} ms, ${switchOn ? "on" : "switched off"}` : "no mirror on this server; everything loads from Forge");
    // client-health starts in its own ready hook, which runs after this one. The world-entry
    // draw is already done: its counts go in this record, and per-draw records start from here.
    const atEntry = { ...stats };
    reported = { ...stats };
    setTimeout(() => record("forge-mirror", { mirrored: count, manifestMs, on: active(), ...atEntry }), 2000);

    game.socket.on(SOCKET_NS, payload => {
      if (payload?.type === MSG_MISS && isPrimaryGM()) addRuntime(payload.urls);
    });
    setInterval(reportMisses, MISS_REPORT_MS);
    if (isPrimaryGM()) gmStart();

    Hooks.on("canvasReady", () => {
      const d = { hits: stats.hits - reported.hits, misses: stats.misses - reported.misses, fallbacks: stats.fallbacks - reported.fallbacks };
      reported = { ...stats };
      if (d.hits || d.misses || d.fallbacks) record("forge-mirror-draw", { scene: canvas.scene?.name ?? null, ...d });
    });

    const api = ((globalThis.FUCompanion ??= {}).api ??= {});
    api.forgeMirror ??= {};
    api.forgeMirror.exportNow = async () => { if (!isPrimaryGM()) return null; await fullScan(); reportMisses(); lastWritten = null; return writeWanted(); };
  });
})();
