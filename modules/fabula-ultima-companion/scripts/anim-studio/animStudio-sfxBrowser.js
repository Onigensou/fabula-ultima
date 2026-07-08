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
// Uses the classic Application/Dialog stack (module is Foundry v12). Preview is
// a single reused HTMLAudioElement so clicking a new row stops the previous one.
// ============================================================================
(() => {
  const TAG = "[AnimStudio][SFXBrowser]";

  function api() { return globalThis.FUCompanion?.api?.animStudio?.sfx ?? null; }

  // Single shared preview player — clicking another row cancels the last.
  let _player = null;
  function preview(url, volume = 0.8) {
    try {
      if (_player) { _player.pause(); _player = null; }
      const a = new Audio(url);
      a.volume = volume;
      a.play().catch((e) => console.warn(TAG, "preview play blocked:", e?.message ?? e));
      _player = a;
    } catch (e) { console.warn(TAG, "preview failed:", e); }
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function copyToken(name) {
    const token = `sfx("${name}")`;
    try {
      await navigator.clipboard.writeText(token);
      ui.notifications?.info?.(`Copied: ${token}`);
    } catch {
      // Fallback: transient textarea select-copy (clipboard API can be blocked).
      const ta = document.createElement("textarea");
      ta.value = token; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ui.notifications?.info?.(`Copied: ${token}`); }
      finally { ta.remove(); }
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function rowsHtml(files) {
    if (!files.length) {
      return `<div class="as-empty" style="padding:18px;text-align:center;opacity:.7;">
        No sounds. Click <b>Rescan Library</b> to index your Forge Sound/ folder.</div>`;
    }
    return files.map((f) => `
      <div class="as-row" data-url="${esc(f.url)}" data-name="${esc(f.name)}"
           style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.06);">
        <button type="button" class="as-play" title="Preview"
                style="flex:0 0 auto;width:26px;height:26px;cursor:pointer;">
          <i class="fas fa-play"></i></button>
        <div style="flex:1 1 auto;min-width:0;">
          <div class="as-name" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)}</div>
          <div style="font-size:.78em;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.dir)} · .${esc(f.ext)}</div>
        </div>
        <button type="button" class="as-copy" title="Copy sfx(&quot;…&quot;)"
                style="flex:0 0 auto;cursor:pointer;"><i class="fas fa-copy"></i> token</button>
      </div>`).join("");
  }

  function content(files, count) {
    return `
      <div class="anim-studio-sfx" style="display:flex;flex-direction:column;height:520px;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
          <input type="text" class="as-search" placeholder="Search name or folder…"
                 style="flex:1 1 auto;" autofocus/>
          <button type="button" class="as-rescan" title="Re-index the Forge Sound/ library">
            <i class="fas fa-sync"></i> Rescan</button>
        </div>
        <div class="as-count" style="font-size:.8em;opacity:.6;margin-bottom:4px;">${count} sounds indexed</div>
        <div class="as-list" style="flex:1 1 auto;overflow-y:auto;border:1px solid rgba(255,255,255,.1);border-radius:4px;">
          ${rowsHtml(files)}
        </div>
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
      countEl.textContent = `${files.length} sounds${q ? " matched" : " indexed"}`;
    };

    // Debounced search.
    let t = null;
    searchEl?.addEventListener("input", (e) => {
      clearTimeout(t);
      const q = e.target.value;
      t = setTimeout(() => refresh(q), 120);
    });

    // Event delegation for play / copy.
    listEl?.addEventListener("click", (e) => {
      const row = e.target.closest(".as-row");
      if (!row) return;
      if (e.target.closest(".as-play")) preview(row.dataset.url);
      else if (e.target.closest(".as-copy")) copyToken(row.dataset.name);
    });

    root.querySelector(".as-rescan")?.addEventListener("click", async () => {
      const a = api();
      if (!a) return;
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
    }, { width: 480, resizable: true, classes: ["anim-studio-dialog"] });
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
