// ============================================================================
// Anim Studio — SFX Manifest + Resolver
//
// Part of the Animation Studio authoring toolkit. Solves the "copy-paste SFX
// links" pain: instead of pasting Forge asset URLs one at a time, we auto-scrape
// the Forge `Sound/` tree ONCE (via Foundry's authenticated FilePicker against
// the "forgevtt" source) into a manifest, then reference sounds by NAME
// everywhere via a resolver.
//
// WHY FilePicker and not curl:
//   The Forge asset host (assets.forge-vtt.com/<bucket>/...) serves individual
//   files fine but returns 404 for directory listings — it is NOT enumerable
//   from outside. The running Foundry client, however, is already authenticated
//   to Forge and `FilePicker.browse("forgevtt", path)` returns the real file +
//   subfolder listing (full https asset URLs). So the scrape runs in-game.
//
// STORAGE:
//   - World setting `sfxManifest` (JSON) — source of truth, syncs to every
//     client automatically so the resolver works everywhere (players included,
//     since animation scripts run on all clients via the pseudo broadcast).
//   - Optional disk mirror at
//     `modules/fabula-ultima-companion/data/anim-studio/sfx-manifest.json`
//     so the disk-side CLI (anim-studio tools) and this repo can read it.
//
// RESOLVER:
//   - globalThis.ONI_SFX(name[, opts]) → full URL (or null).
//     Exposed on globalThis so it is reachable from inside pseudo-animation
//     inner scripts (which do NOT receive `game`). The Phase-3 `oni` helper
//     wraps this as `oni.sfx(name)`.
//   - FUCompanion.api.animStudio.{ scan, resolve, manifest, all, ... }
// ============================================================================
(() => {
  const TAG = "[AnimStudio][SFX]";
  const MODULE_ID = "fabula-ultima-companion";
  const SETTING_KEY = "sfxManifest";

  // Forge source + the root folder to scrape. `forgevtt` is registered by the
  // ForgeVTT integration module; the browse path mirrors the web UI
  // (…/assets/browse#path=Sound%2F).
  const FORGE_SOURCE = "forgevtt";
  const SOUND_ROOT = "Sound";

  // Audio extensions we treat as SFX. Everything else (webm/png/etc.) is left
  // for a future VFX manifest — Sound/ is audio-only in practice anyway.
  const AUDIO_EXT = new Set(["wav", "ogg", "mp3", "m4a", "flac", "opus", "webm", "wave"]);

  // Recursion guardrails so a pathological tree can never hang the client.
  const MAX_DEPTH = 12;
  const MAX_FILES = 5000;

  function log(...a) { console.debug(TAG, ...a); }
  function warn(...a) { console.warn(TAG, ...a); }

  // ── Manifest state (in-memory mirror of the world setting) ────────────────
  // { generatedAt, source, root, count, files:[{name, ext, dir, url, key}] }
  let _manifest = null;
  // Fast lookup: lowercased basename → file entry (last-wins on dupes; the
  // `all()` API and disambiguation opts handle collisions).
  let _byName = new Map();
  // Every entry keyed by lowercased "dir/name" for exact folder-qualified hits.
  let _byPath = new Map();

  function _rebuildIndex(manifest) {
    _byName = new Map();
    _byPath = new Map();
    for (const f of (manifest?.files ?? [])) {
      _byName.set(f.name.toLowerCase(), f);
      _byPath.set(`${f.dir}/${f.name}`.toLowerCase(), f);
    }
  }

  function _loadFromSetting() {
    try {
      const raw = game.settings.get(MODULE_ID, SETTING_KEY);
      _manifest = raw && typeof raw === "object" && Array.isArray(raw.files) ? raw : null;
    } catch (e) {
      _manifest = null;
    }
    _rebuildIndex(_manifest);
    return _manifest;
  }

  // ── URL / name helpers ────────────────────────────────────────────────────

  // Forge browse returns full https URLs. Extract a clean basename (no ext, no
  // query string) and extension for indexing.
  function _parseUrl(url) {
    let clean = String(url).split("?")[0].split("#")[0];
    const lastSlash = clean.lastIndexOf("/");
    const fileName = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
    let dir = lastSlash >= 0 ? clean.slice(0, lastSlash) : "";
    // Reduce the directory to the part at/after "Sound" so entries read
    // "Sound/ME" rather than the full CDN path.
    const soundIdx = dir.indexOf(`/${SOUND_ROOT}`);
    if (soundIdx >= 0) dir = dir.slice(soundIdx + 1);
    else {
      const soundIdx2 = dir.indexOf(SOUND_ROOT);
      if (soundIdx2 >= 0) dir = dir.slice(soundIdx2);
    }
    const dotIdx = fileName.lastIndexOf(".");
    const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "";
    const name = dotIdx >= 0 ? fileName.slice(0, dotIdx) : fileName;
    // Decode %20 etc. so callers can use human names; the stored url stays raw.
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep raw */ }
    let decodedDir = dir;
    try { decodedDir = decodeURIComponent(dir); } catch { /* keep raw */ }
    return { name: decoded, ext, dir: decodedDir };
  }

  // ── Scraper ───────────────────────────────────────────────────────────────

  async function _browse(path) {
    try {
      return await FilePicker.browse(FORGE_SOURCE, path);
    } catch (e) {
      warn(`browse failed for "${path}":`, e?.message ?? e);
      return null;
    }
  }

  // Recursively walk the Sound/ tree. Returns a flat file array.
  async function _walk(path, depth, acc, onProgress) {
    if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return;
    const listing = await _browse(path);
    if (!listing) return;

    for (const url of (listing.files ?? [])) {
      const parsed = _parseUrl(url);
      if (!AUDIO_EXT.has(parsed.ext)) continue;
      acc.push({ name: parsed.name, ext: parsed.ext, dir: parsed.dir, url: String(url) });
      if (acc.length >= MAX_FILES) break;
    }
    onProgress?.(acc.length, path);

    for (const sub of (listing.dirs ?? [])) {
      if (acc.length >= MAX_FILES) break;
      await _walk(sub, depth + 1, acc, onProgress);
    }
  }

  // Public: scrape Forge, build + persist the manifest. GM only (writes the
  // world setting). `onProgress(count, currentPath)` is optional (for UI).
  async function scan({ onProgress = null, writeDisk = true } = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Anim Studio: only a GM can scan the SFX library.");
      return null;
    }
    ui.notifications?.info?.("Anim Studio: scanning Forge Sound library…");
    const files = [];
    const t0 = performance.now();
    await _walk(SOUND_ROOT, 0, files, onProgress);

    // Deterministic order (dir, then name) so diffs are readable.
    files.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir.localeCompare(b.dir)));

    const manifest = {
      generatedAt: new Date().toISOString(),
      source: FORGE_SOURCE,
      root: SOUND_ROOT,
      count: files.length,
      files,
    };

    await game.settings.set(MODULE_ID, SETTING_KEY, manifest);
    _manifest = manifest;
    _rebuildIndex(manifest);

    if (writeDisk) { try { await _writeDisk(manifest); } catch (e) { warn("disk mirror failed", e); } }

    const dt = Math.round(performance.now() - t0);
    ui.notifications?.info?.(`Anim Studio: indexed ${files.length} sounds in ${dt}ms.`);
    log(`scan complete: ${files.length} files in ${dt}ms`);
    return manifest;
  }

  // Mirror the manifest to disk so the repo + disk CLI can read it. Uses the
  // "data" FilePicker source (module folder lives under the Foundry data dir).
  async function _writeDisk(manifest) {
    // FilePicker.createDirectory is NOT recursive — create each ancestor.
    const parts = [`modules/${MODULE_ID}`, `modules/${MODULE_ID}/data`, `modules/${MODULE_ID}/data/anim-studio`];
    for (const p of parts) {
      try { await FilePicker.createDirectory("data", p, {}); } catch { /* exists — fine */ }
    }
    const dir = parts[parts.length - 1];
    const json = JSON.stringify(manifest, null, 2);
    const file = new File([json], "sfx-manifest.json", { type: "application/json" });
    await FilePicker.upload("data", dir, file, {}, { notify: false });
    log("disk mirror written:", `${dir}/sfx-manifest.json`);
  }

  // ── Resolver ──────────────────────────────────────────────────────────────
  //
  // resolve(name, opts) → URL string | null
  //   name  : basename (with or without extension), case-insensitive. May be a
  //           folder-qualified "ME/Shock2" for disambiguation.
  //   opts.folder : restrict to entries whose dir ends with this fragment.
  //   opts.silent : suppress the not-found warning.
  //
  // Match order: exact path → exact basename → folder-filtered basename →
  //   substring. Deterministic (index built from sorted files).
  function resolve(name, opts = {}) {
    if (!_manifest) _loadFromSetting();
    if (!name) return null;
    let q = String(name).trim();
    // Strip a trailing extension if the caller included one.
    q = q.replace(/\.(wav|ogg|mp3|m4a|flac|opus|webm|wave)$/i, "");
    const ql = q.toLowerCase();

    // 1. Folder-qualified exact path ("ME/Shock2").
    if (ql.includes("/")) {
      const hit = _byPath.get(ql.startsWith("sound/") ? ql : `sound/${ql}`) ?? _byPath.get(ql);
      if (hit) return hit.url;
    }

    const folder = opts.folder ? String(opts.folder).toLowerCase() : null;
    const pool = folder
      ? (_manifest?.files ?? []).filter((f) => f.dir.toLowerCase().includes(folder))
      : (_manifest?.files ?? []);

    // 2. Exact basename.
    if (!folder) {
      const exact = _byName.get(ql);
      if (exact) return exact.url;
    } else {
      const exact = pool.find((f) => f.name.toLowerCase() === ql);
      if (exact) return exact.url;
    }

    // 3. Substring fallback (first in sorted order).
    const sub = pool.find((f) => f.name.toLowerCase().includes(ql));
    if (sub) return sub.url;

    if (!opts.silent) warn(`no SFX match for "${name}"${folder ? ` in folder ~"${opts.folder}"` : ""}.`);
    return null;
  }

  // Return ALL entries matching a query (for the Browser + disambiguation).
  function all(query = "") {
    if (!_manifest) _loadFromSetting();
    const ql = String(query).trim().toLowerCase();
    const files = _manifest?.files ?? [];
    if (!ql) return files.slice();
    return files.filter((f) =>
      f.name.toLowerCase().includes(ql) || f.dir.toLowerCase().includes(ql));
  }

  function manifest() { if (!_manifest) _loadFromSetting(); return _manifest; }

  // ── Registration ──────────────────────────────────────────────────────────

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Anim Studio SFX Manifest",
      scope: "world",
      config: false,
      type: Object,
      default: null,
    });
  });

  Hooks.once("ready", () => {
    _loadFromSetting();

    // Global resolver — reachable from pseudo inner scripts (no `game` there).
    globalThis.ONI_SFX = (name, opts) => resolve(name, opts);

    // API surface.
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    const api = (globalThis.FUCompanion.api.animStudio ??= {});
    api.sfx = {
      scan,
      resolve,
      all,
      manifest,
      reload: _loadFromSetting,
      get count() { return _manifest?.count ?? 0; },
    };

    const n = _manifest?.count ?? 0;
    log(`ready — ${n} sounds indexed${n ? "" : " (run FUCompanion.api.animStudio.sfx.scan() to build)"}.`);
  });

  // Keep the in-memory index fresh if another GM re-scans mid-session.
  Hooks.on("updateSetting", (setting) => {
    if (setting?.key === `${MODULE_ID}.${SETTING_KEY}`) _loadFromSetting();
  });
})();
