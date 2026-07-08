// ============================================================================
// Anim Studio — Brief Builder
//
// Assemble an Animation Brief (see tools/anim-studio/BRIEF.md) by stacking
// beats from the recipe catalog, then copy the JSON to hand to Claude. Turns
// "describe free-form what I want" into "pick beats + set numbers."
//
// Each beat maps 1:1 to the oni helper recipes, so the resulting Brief is
// directly buildable. SFX are referenced by manifest name (look them up in the
// SFX Browser).
// ============================================================================
(() => {
  const TAG = "[AnimStudio][Brief]";

  // Beat catalog — type → default params. Kept in sync with BRIEF.md.
  const BEATS = {
    sfxCue:        { sfx: "", volume: 0.8, at: "inline" },
    projectile:    { color: "#ff8a3d", boltSize: 90, travelMs: 420 },
    webmOnTarget:  { webmUrl: "", size: 320, anchor: "target", preFlash: true },
    tokenLunge:    { distance: 80, outMs: 140, backMs: 200 },
    glowAura:      { color: "rgba(255,180,90,0.9)", size: 200, durationMs: 900, embers: true },
    cutIn:         { who: "caster", holdMs: 700, stingSfx: "Overdrive" },
    cameraPan:     { direction: "up", durationMs: 700 },
    zoomOutReveal: { scale: 0.4, durationMs: 800 },
    stutterScale:  { steps: 4, totalMs: 900 },
    telegraph:     { growMs: 500, color: "#000000" },
    whiteout:      { fadeIn: 140, hold: 90, fadeOut: 240, color: "#ffffff" },
    dim:           { to: 0.6, fadeInMs: 200 },
    screenshake:   { intensity: 7, durationMs: 300 },
    impact:        {},
  };

  let _dlg = null;
  // Working model: [{ type, params }]
  let _beats = [];

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function buildBrief(root) {
    const palette = (root.querySelector(".b-palette")?.value ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const brief = {
      name: root.querySelector(".b-name")?.value ?? "",
      concept: root.querySelector(".b-concept")?.value ?? "",
      caster: root.querySelector(".b-caster")?.value ?? "",
      target: root.querySelector(".b-target")?.value ?? "",
      palette: palette.length ? palette : ["#ffffff"],
      timing: root.querySelector(".b-timing")?.value ?? "default",
      beats: _beats.map((b) => ({ type: b.type, ...b.params })),
    };
    return brief;
  }

  function refreshJson(root) {
    const out = root.querySelector(".b-json");
    if (out) out.value = JSON.stringify(buildBrief(root), null, 2);
  }

  function beatRowsHtml() {
    if (!_beats.length) return `<div style="opacity:.6;padding:8px;">No beats yet — add one above.</div>`;
    return _beats.map((b, i) => `
      <div class="b-row" data-i="${i}" style="border:1px solid rgba(255,255,255,.12);border-radius:4px;padding:6px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <b style="flex:1 1 auto;">${i + 1}. ${esc(b.type)}</b>
          <button type="button" class="b-up" title="Move up">▲</button>
          <button type="button" class="b-down" title="Move down">▼</button>
          <button type="button" class="b-del" title="Remove">✕</button>
        </div>
        ${b.type === "impact" ? "" : `
        <textarea class="b-params" spellcheck="false"
          style="width:100%;height:52px;font-family:monospace;font-size:11px;margin-top:4px;">${esc(JSON.stringify(b.params))}</textarea>`}
      </div>`).join("");
  }

  function renderBeats(root) {
    const host = root.querySelector(".b-beats");
    if (host) host.innerHTML = beatRowsHtml();
    refreshJson(root);
  }

  function content() {
    const opts = Object.keys(BEATS).map((k) => `<option value="${k}">${k}</option>`).join("");
    return `
    <div class="anim-studio-brief" style="display:flex;flex-direction:column;gap:6px;min-width:540px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <label>Name <input type="text" class="b-name" style="width:100%;"/></label>
        <label>Timing
          <select class="b-timing" style="width:100%;">
            <option value="default">default (gate on impact)</option>
            <option value="offset">offset</option>
          </select>
        </label>
      </div>
      <label>Concept / flavor
        <textarea class="b-concept" style="width:100%;height:44px;"></textarea></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <label>Caster <input type="text" class="b-caster" style="width:100%;" placeholder="the mage"/></label>
        <label>Target <input type="text" class="b-target" style="width:100%;" placeholder="single enemy"/></label>
      </div>
      <label>Palette (comma-separated hex)
        <input type="text" class="b-palette" style="width:100%;" value="#ff8a3d,#ffd27f"/></label>

      <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
        <select class="b-add-type">${opts}</select>
        <button type="button" class="b-add"><i class="fas fa-plus"></i> Add beat</button>
        <button type="button" class="b-sfx" style="margin-left:auto;"><i class="fas fa-music"></i> SFX names</button>
      </div>

      <div class="b-beats" style="max-height:180px;overflow-y:auto;border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:6px;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;">
        <b style="font-size:.85em;">Brief JSON</b>
        <button type="button" class="b-copy"><i class="fas fa-copy"></i> Copy JSON</button>
      </div>
      <textarea class="b-json" spellcheck="false" readonly
        style="width:100%;height:150px;font-family:monospace;font-size:11px;"></textarea>
    </div>`;
  }

  function readParamsFromDom(root) {
    // Pull edited params back out of each beat's textarea before rebuilding.
    root.querySelectorAll(".b-row").forEach((rowEl) => {
      const i = Number(rowEl.dataset.i);
      const ta = rowEl.querySelector(".b-params");
      if (ta && _beats[i]) {
        try { _beats[i].params = JSON.parse(ta.value); }
        catch { /* keep last good on parse error */ }
      }
    });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); ui.notifications?.info?.("Brief JSON copied."); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ui.notifications?.info?.("Brief JSON copied."); }
      finally { ta.remove(); }
    }
  }

  function wire(html) {
    const root = html[0] ?? html;

    root.querySelector(".b-add")?.addEventListener("click", () => {
      readParamsFromDom(root);
      const type = root.querySelector(".b-add-type")?.value ?? "sfxCue";
      _beats.push({ type, params: foundry.utils.deepClone(BEATS[type] ?? {}) });
      renderBeats(root);
    });

    root.querySelector(".b-beats")?.addEventListener("click", (e) => {
      const row = e.target.closest(".b-row");
      if (!row) return;
      const i = Number(row.dataset.i);
      readParamsFromDom(root);
      if (e.target.closest(".b-del")) { _beats.splice(i, 1); renderBeats(root); }
      else if (e.target.closest(".b-up") && i > 0) { [_beats[i - 1], _beats[i]] = [_beats[i], _beats[i - 1]]; renderBeats(root); }
      else if (e.target.closest(".b-down") && i < _beats.length - 1) { [_beats[i + 1], _beats[i]] = [_beats[i], _beats[i + 1]]; renderBeats(root); }
    });

    // Live JSON refresh on any meta/param edit.
    root.addEventListener("input", (e) => {
      if (e.target.classList.contains("b-params")) readParamsFromDom(root);
      refreshJson(root);
    });

    root.querySelector(".b-copy")?.addEventListener("click", () => {
      readParamsFromDom(root); refreshJson(root);
      copyText(root.querySelector(".b-json")?.value ?? "");
    });
    root.querySelector(".b-sfx")?.addEventListener("click", () =>
      globalThis.FUCompanion?.api?.animStudio?.openSfxBrowser?.());

    renderBeats(root);
  }

  function open() {
    if (!game.user?.isGM) { ui.notifications?.warn?.("Anim Studio is GM-only."); return; }
    if (_dlg?.rendered) { _dlg.bringToTop?.(); return _dlg; }
    _beats = [
      { type: "sfxCue", params: { sfx: "", volume: 0.8, at: "start" } },
      { type: "projectile", params: foundry.utils.deepClone(BEATS.projectile) },
      { type: "impact", params: {} },
      { type: "screenshake", params: foundry.utils.deepClone(BEATS.screenshake) },
    ];
    _dlg = new Dialog({
      title: "Anim Studio — Brief Builder",
      content: content(),
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } },
      default: "close",
      render: (html) => wire(html),
      close: () => { _dlg = null; },
    }, { width: 580, resizable: true, classes: ["anim-studio-dialog"] });
    _dlg.render(true);
    return _dlg;
  }

  Hooks.once("ready", () => {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.animStudio ??= {};
    globalThis.FUCompanion.api.animStudio.openBriefBuilder = open;
    console.debug(TAG, "ready.");
  });
})();
