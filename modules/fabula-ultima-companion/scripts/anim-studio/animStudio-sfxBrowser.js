// ============================================================================
// Anim Studio — SFX Browser
//
// A GM dialog that lists every sound in the manifest (built by
// animStudio-sfxManifest.js), with live search, per-row ▶ preview, and a
// one-click "copy sfx(\"Name\")" so you never hand-paste a Forge URL again.
//
// Opens from the Anim Studio scene-control group (installed by
// animStudio-previewBench.js) and via FUCompanion.api.animStudio.openSfxBrowser().
//
// Ships a SELF-CONTAINED scoped stylesheet (own dark panel + explicit colors)
// so the list is always legible regardless of the ambient dialog/module theme —
// the earlier version inherited a washed-out text color and names went blank.
// ============================================================================
(() => {
  const TAG = "[AnimStudio][SFXBrowser]";

  function api() { return globalThis.FUCompanion?.api?.animStudio?.sfx ?? null; }

  // Single shared preview player — clicking another row cancels the last.
  let _player = null;
  let _playingUrl = null;
  function preview(url, rowEl, volume = 0.85) {
    try {
      if (_player) { _player.pause(); _player = null; }
      // toggle off if clicking the same row
      if (_playingUrl === url) { _playingUrl = null; markPlaying(rowEl, false); return; }
      const a = new Audio(url);
      a.volume = volume;
      a.play().catch((e) => console.warn(TAG, "preview play blocked:", e?.message ?? e));
      a.addEventListener("ended", () => { _playingUrl = null; markPlaying(rowEl, false); }, { once: true });
      _player = a; _playingUrl = url;
      markPlaying(rowEl, true);
    } catch (e) { console.warn(TAG, "preview failed:", e); }
  }
  function markPlaying(rowEl, on) {
    if (!rowEl) return;
    rowEl.closest(".as-list")?.querySelectorAll(".as-row.playing").forEach((r) => r.classList.remove("playing"));
    if (on) rowEl.classList.add("playing");
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // Folders keep %20 in older manifests — show them decoded.
  function pretty(dir) { try { return decodeURIComponent(String(dir ?? "")); } catch { return String(dir ?? ""); } }

  async function copyToken(name) {
    const token = `sfx("${name}")`;
    try {
      await navigator.clipboard.writeText(token);
      ui.notifications?.info?.(`Copied: ${token}`);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = token; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ui.notifications?.info?.(`Copied: ${token}`); }
      finally { ta.remove(); }
    }
  }

  // ── Scoped stylesheet (warm parchment — matches the system UI) ────────────
  // Colors set with !important + explicit dark text so a global stylesheet rule
  // can't wash the names out (the earlier dark panel was overridden invisible).
  const STYLE = `
    .as-sfx-browser { --as-bg:#efe4c6; --as-row:#f4ecd5; --as-row2:#e9dcba; --as-hi:#e6d5a6;
      --as-text:#2b2113; --as-sub:#7a6544; --as-accent:#9c6b1f; --as-line:#c3ad78;
      color:var(--as-text) !important; }
    .as-sfx-browser * { box-sizing:border-box; }
    .as-sfx-browser .as-top { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
    .as-sfx-browser .as-search { flex:1 1 auto; background:#fffdf5 !important; color:#2b2113 !important;
      border:1px solid var(--as-line); border-radius:5px; padding:6px 9px; font-size:13px; }
    .as-sfx-browser .as-search::placeholder { color:var(--as-sub) !important; }
    .as-sfx-browser .as-rescan { background:var(--as-row); color:var(--as-text) !important; border:1px solid var(--as-line);
      border-radius:5px; padding:6px 10px; cursor:pointer; white-space:nowrap; }
    .as-sfx-browser .as-rescan:hover { background:var(--as-hi); }
    .as-sfx-browser .as-count { font-size:11px; color:var(--as-sub) !important; margin-bottom:5px; }
    .as-sfx-browser .as-list { flex:1 1 auto; overflow-y:auto; overflow-x:hidden; background:var(--as-bg);
      border:1px solid var(--as-line); border-radius:6px; }
    /* GRID (not flex) so the middle name column always has width — a flexbox
       quirk was collapsing it to 0 and clipping the name. */
    .as-sfx-browser .as-row { display:grid !important; grid-template-columns:32px minmax(0,1fr) auto;
      align-items:center; gap:10px; width:100%; padding:6px 10px;
      border-bottom:1px solid rgba(90,60,20,.14); cursor:default; }
    .as-sfx-browser .as-row:nth-child(even) { background:var(--as-row2); }
    .as-sfx-browser .as-row:hover { background:var(--as-hi); }
    .as-sfx-browser .as-row.playing { box-shadow:inset 3px 0 0 var(--as-accent); }
    .as-sfx-browser .as-play { width:30px; height:30px; border-radius:50%;
      border:1px solid var(--as-line); background:#fff7e2; color:var(--as-accent) !important; cursor:pointer;
      display:flex; align-items:center; justify-content:center; padding:0; }
    .as-sfx-browser .as-play:hover { background:var(--as-hi); }
    .as-sfx-browser .as-meta { min-width:0; overflow:hidden; }
    .as-sfx-browser .as-name { font-weight:700; font-size:13px; color:#2b2113 !important;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-sfx-browser .as-sub { font-size:11px; color:var(--as-sub) !important;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .as-sfx-browser .as-copy { flex:0 0 auto; background:var(--as-row); color:var(--as-text) !important;
      border:1px solid var(--as-line); border-radius:5px; padding:4px 9px; cursor:pointer; font-size:12px; }
    .as-sfx-browser .as-copy:hover { background:var(--as-accent); color:#fff7e2 !important; }
    .as-sfx-browser .as-empty { padding:20px; text-align:center; color:var(--as-sub) !important; }
  `;

  function rowsHtml(files) {
    if (!files.length) {
      return `<div class="as-empty">No sounds. Click <b>Rescan</b> to index your Forge Sound/ folder.</div>`;
    }
    return files.map((f) => `
      <div class="as-row" data-url="${esc(f.url)}" data-name="${esc(f.name)}">
        <button type="button" class="as-play" title="Preview"><i class="fas fa-play"></i></button>
        <div class="as-meta">
          <div class="as-name">${esc(f.name)}</div>
          <div class="as-sub">${esc(pretty(f.dir))} · .${esc(f.ext)}</div>
        </div>
        <button type="button" class="as-copy" title='Copy sfx("…")'><i class="fas fa-copy"></i> copy</button>
      </div>`).join("");
  }

  function content(files, count) {
    return `
      <style>${STYLE}</style>
      <div class="as-sfx-browser" style="display:flex;flex-direction:column;height:540px;">
        <div class="as-top">
          <input type="text" class="as-search" placeholder="Search name or folder…  (e.g. fire, explosion, ME/)" autofocus/>
          <button type="button" class="as-rescan" title="Re-index the Forge Sound/ library"><i class="fas fa-sync"></i> Rescan</button>
        </div>
        <div class="as-count">${count} sounds indexed · click ▶ to preview, <b>copy</b> for sfx("Name")</div>
        <div class="as-list">${rowsHtml(files)}</div>
      </div>`;
  }

  function wire(html) {
    const root = html[0] ?? html;
    const listEl = root.querySelector(".as-list");
    const searchEl = root.querySelector(".as-search");
    const countEl = root.querySelector(".as-count");

    const refresh = (q = "") => {
      const files = api()?.all(q) ?? [];
      listEl.innerHTML = rowsHtml(files);
      countEl.textContent = `${files.length} sound${files.length === 1 ? "" : "s"}${q ? " matched" : " indexed"}`;
    };

    let t = null;
    searchEl?.addEventListener("input", (e) => {
      clearTimeout(t);
      const q = e.target.value;
      t = setTimeout(() => refresh(q), 120);
    });

    listEl?.addEventListener("click", (e) => {
      const row = e.target.closest(".as-row");
      if (!row) return;
      if (e.target.closest(".as-copy")) copyToken(row.dataset.name);
      else preview(row.dataset.url, row);   // ▶ OR anywhere else on the row previews
    });

    root.querySelector(".as-rescan")?.addEventListener("click", async () => {
      const a = api();
      if (!a) return;
      countEl.textContent = "indexing…";
      await a.scan({ onProgress: (n) => { if (countEl) countEl.textContent = `indexing… ${n}`; } });
      refresh(searchEl?.value ?? "");
    });
  }

  function open() {
    if (!game.user?.isGM) { ui.notifications?.warn?.("Anim Studio is GM-only."); return; }
    const a = api();
    const files = a?.all("") ?? [];
    const count = a?.count ?? files.length;

    const dlg = new Dialog({
      title: "Anim Studio — SFX Browser",
      content: content(files, count),
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } },
      default: "close",
      render: (html) => wire(html),
    }, { width: 500, resizable: true, classes: ["anim-studio-dialog"] });
    dlg.render(true);
    return dlg;
  }

  Hooks.once("ready", () => {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.animStudio ??= {};
    globalThis.FUCompanion.api.animStudio.openSfxBrowser = open;
    console.debug(TAG, "ready.");
  });
})();
