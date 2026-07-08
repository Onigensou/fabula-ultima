// ============================================================================
// Anim Studio — Brief Builder
//
// Assemble an Animation Brief (see tools/anim-studio/BRIEF.md) by stacking
// beats from the recipe catalog, then copy the JSON to hand to Claude. Turns
// "describe free-form what I want" into "pick beats + set numbers."
//
// VFX beats cover the three ways you work with visuals:
//   - vfxProc : procedural DOM/PIXI (via the oni helpers — glow/ring/burst)
//   - vfxDb   : a Sequencer database key (jb2a / blfx animated webm) — the
//               "VFX (Sequencer DB)" button opens Sequencer's viewer to browse.
//   - vfxFile : a given image/webm by URL.
//
// Ships a scoped dark stylesheet so the Timeline (the heart of the tool) is
// prominent and legible regardless of the ambient dialog theme.
// ============================================================================
(() => {
  const TAG = "[AnimStudio][Brief]";

  // Beat catalog — type → default params. Kept in sync with BRIEF.md.
  const BEATS = {
    sfxCue:        { sfx: "", volume: 0.8, at: "inline" },
    projectile:    { color: "#ff8a3d", boltSize: 90, travelMs: 420 },
    vfxProc:       { shape: "glow", color: "#ff8a3d", size: 220, anchor: "target", at: "impact" },
    vfxDb:         { dbPath: "jb2a.explosion.01.orange", size: 320, anchor: "target", at: "impact" },
    vfxFile:       { url: "", size: 320, anchor: "target", loop: false, at: "impact" },
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
  // Grouped for the picker <optgroup>s.
  const GROUPS = [
    ["Motion / projectile", ["projectile", "tokenLunge", "cameraPan", "zoomOutReveal", "stutterScale"]],
    ["VFX", ["vfxProc", "vfxDb", "vfxFile", "glowAura"]],
    ["Screen / camera", ["whiteout", "dim", "screenshake", "telegraph", "cutIn"]],
    ["Audio / timing", ["sfxCue", "impact"]],
  ];

  let _dlg = null;
  let _beats = [];          // [{ type, params }]
  let _palette = [];        // ["#ff8a3d", …]

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function buildBrief(root) {
    return {
      name: root.querySelector(".b-name")?.value ?? "",
      concept: root.querySelector(".b-concept")?.value ?? "",
      caster: root.querySelector(".b-caster")?.value ?? "",
      target: root.querySelector(".b-target")?.value ?? "",
      palette: _palette.length ? _palette.slice() : ["#ffffff"],
      timing: root.querySelector(".b-timing")?.value ?? "default",
      beats: _beats.map((b) => ({ type: b.type, ...b.params })),
    };
  }

  function refreshJson(root) {
    const out = root.querySelector(".b-json");
    if (out) out.value = JSON.stringify(buildBrief(root), null, 2);
  }

  // ── Palette editor (native color pickers + live hex) ──────────────────────
  function paletteHtml() {
    const sw = _palette.map((c, i) => `
      <div class="b-swatch" data-i="${i}">
        <input type="color" class="b-color" value="${esc(/^#[0-9a-f]{6}$/i.test(c) ? c : "#ffffff")}"/>
        <input type="text" class="b-hex" value="${esc(c)}" spellcheck="false"/>
        <button type="button" class="b-color-del" title="Remove">✕</button>
      </div>`).join("");
    return sw + `<button type="button" class="b-add-color">+ color</button>`;
  }
  function renderPalette(root) {
    const host = root.querySelector(".b-palette");
    if (host) host.innerHTML = paletteHtml();
    refreshJson(root);
  }

  // ── Timeline (beats) ──────────────────────────────────────────────────────
  function beatRowsHtml() {
    if (!_beats.length) return `<div class="b-empty">No beats yet — choose one above and click <b>Add beat</b>.</div>`;
    return _beats.map((b, i) => {
      const isImpact = b.type === "impact";
      return `
      <div class="b-row${isImpact ? " b-impact" : ""}" data-i="${i}">
        <div class="b-row-head">
          <span class="b-ord">${i + 1}</span>
          <b class="b-type">${esc(b.type)}</b>
          ${isImpact ? `<span class="b-tag">← damage lands here</span>` : ""}
          <span class="b-row-btns">
            <button type="button" class="b-up" title="Move up">▲</button>
            <button type="button" class="b-down" title="Move down">▼</button>
            <button type="button" class="b-del" title="Remove">✕</button>
          </span>
        </div>
        ${isImpact ? "" : `<textarea class="b-params" spellcheck="false">${esc(JSON.stringify(b.params))}</textarea>`}
      </div>`;
    }).join("");
  }
  function renderBeats(root) {
    const host = root.querySelector(".b-beats");
    if (host) host.innerHTML = beatRowsHtml();
    refreshJson(root);
  }

  // ── Scoped stylesheet ─────────────────────────────────────────────────────
  const STYLE = `
    .bb { --bb-text:#e8ebf0; --bb-sub:#97a0ad; --bb-panel:#1b1e24; --bb-row:#232830;
      --bb-hi:#2d3440; --bb-accent:#ffb347; --bb-line:#333a45; color:var(--bb-text); display:flex; flex-direction:column; gap:7px; height:640px; }
    .bb * { box-sizing:border-box; }
    .bb label { font-size:11px; color:var(--bb-sub); }
    .bb input[type=text], .bb textarea, .bb select { background:#12151a; color:var(--bb-text);
      border:1px solid var(--bb-line); border-radius:5px; padding:5px 7px; font-size:12px; }
    .bb textarea { font-family:monospace; }
    .bb .b-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .bb button { background:var(--bb-row); color:var(--bb-text); border:1px solid var(--bb-line);
      border-radius:5px; padding:5px 9px; cursor:pointer; font-size:12px; }
    .bb button:hover { background:var(--bb-hi); }
    /* palette */
    .bb .b-palette { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
    .bb .b-swatch { display:flex; align-items:center; gap:3px; background:#12151a; border:1px solid var(--bb-line); border-radius:5px; padding:2px 4px; }
    .bb .b-color { width:24px; height:24px; border:none; background:none; padding:0; cursor:pointer; }
    .bb .b-hex { width:78px; font-family:monospace; padding:3px 5px; }
    .bb .b-color-del { padding:2px 6px; }
    /* timeline — the star */
    .bb .b-tl-head { display:flex; align-items:baseline; gap:8px; margin-top:2px; }
    .bb .b-tl-head h3 { margin:0; font-size:14px; color:var(--bb-accent); letter-spacing:.3px; }
    .bb .b-tl-head .b-hint { font-size:11px; color:var(--bb-sub); }
    .bb .b-addbar { display:flex; gap:6px; align-items:center; }
    .bb .b-addbar select { flex:0 0 auto; min-width:150px; }
    .bb .b-addbar .b-add { flex:0 0 auto; font-weight:600; }
    .bb .b-beats { flex:1 1 auto; min-height:220px; overflow-y:auto; background:var(--bb-panel);
      border:1px solid var(--bb-line); border-radius:6px; padding:6px; }
    .bb .b-empty { padding:24px; text-align:center; color:var(--bb-sub); }
    .bb .b-row { background:var(--bb-row); border:1px solid var(--bb-line); border-radius:5px; padding:6px 8px; margin-bottom:6px; }
    .bb .b-row.b-impact { border-color:var(--bb-accent); box-shadow:inset 3px 0 0 var(--bb-accent); }
    .bb .b-row-head { display:flex; align-items:center; gap:7px; }
    .bb .b-ord { display:inline-flex; width:20px; height:20px; align-items:center; justify-content:center;
      background:#12151a; border-radius:50%; font-size:11px; color:var(--bb-sub); flex:0 0 auto; }
    .bb .b-type { flex:0 0 auto; font-size:13px; }
    .bb .b-tag { font-size:10px; color:var(--bb-accent); }
    .bb .b-row-btns { margin-left:auto; display:flex; gap:3px; }
    .bb .b-row-btns button { padding:2px 7px; }
    .bb .b-params { width:100%; height:46px; margin-top:5px; font-size:11px; }
    /* json */
    .bb .b-json-head { display:flex; justify-content:space-between; align-items:center; }
    .bb .b-json-head b { font-size:11px; color:var(--bb-sub); }
    .bb .b-copy { font-weight:600; }
    .bb .b-json { width:100%; height:88px; font-size:11px; }
  `;

  function content() {
    const groupOpts = GROUPS.map(([label, keys]) =>
      `<optgroup label="${esc(label)}">${keys.map((k) => `<option value="${k}">${k}</option>`).join("")}</optgroup>`).join("");
    return `
    <style>${STYLE}</style>
    <div class="bb">
      <div class="b-grid2">
        <label>Name <input type="text" class="b-name"/></label>
        <label>Timing
          <select class="b-timing">
            <option value="default">default (gate on impact)</option>
            <option value="offset">offset</option>
          </select>
        </label>
      </div>
      <label>Concept / flavor <textarea class="b-concept" style="height:40px;"></textarea></label>
      <div class="b-grid2">
        <label>Caster <input type="text" class="b-caster" placeholder="the mage"/></label>
        <label>Target <input type="text" class="b-target" placeholder="single enemy"/></label>
      </div>
      <label>Palette</label>
      <div class="b-palette"></div>

      <div class="b-tl-head">
        <h3>◆ TIMELINE</h3>
        <span class="b-hint">order = playback · put an <b>impact</b> beat where damage lands</span>
      </div>
      <div class="b-addbar">
        <select class="b-add-type">${groupOpts}</select>
        <button type="button" class="b-add"><i class="fas fa-plus"></i> Add beat</button>
        <button type="button" class="b-sfx" title="Browse SFX names"><i class="fas fa-music"></i> SFX</button>
        <button type="button" class="b-vfx" title="Browse Sequencer VFX (jb2a / blfx)"><i class="fas fa-wand-magic-sparkles"></i> VFX DB</button>
      </div>
      <div class="b-beats"></div>

      <div class="b-json-head">
        <b>Brief JSON — hand this to Claude</b>
        <button type="button" class="b-copy"><i class="fas fa-copy"></i> Copy JSON</button>
      </div>
      <textarea class="b-json" spellcheck="false" readonly></textarea>
    </div>`;
  }

  function readParamsFromDom(root) {
    root.querySelectorAll(".b-row").forEach((rowEl) => {
      const i = Number(rowEl.dataset.i);
      const ta = rowEl.querySelector(".b-params");
      if (ta && _beats[i]) {
        try { _beats[i].params = JSON.parse(ta.value); } catch { /* keep last good */ }
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

  function openVfxDb() {
    const S = globalThis.Sequencer;
    if (S?.DatabaseViewer?.show) { try { S.DatabaseViewer.show(); return; } catch (e) { /* fall through */ } }
    ui.notifications?.warn?.("Sequencer database viewer unavailable (is the Sequencer module active?).");
  }

  function wire(html) {
    const root = html[0] ?? html;

    // Meta fields → live JSON.
    root.addEventListener("input", (e) => {
      if (e.target.classList.contains("b-params")) readParamsFromDom(root);
      // palette hex typed
      if (e.target.classList.contains("b-hex")) {
        const sw = e.target.closest(".b-swatch"); const i = Number(sw?.dataset.i);
        if (!Number.isNaN(i)) { _palette[i] = e.target.value; const col = sw.querySelector(".b-color"); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) col.value = e.target.value; }
      }
      refreshJson(root);
    });
    // color picker changed
    root.addEventListener("change", (e) => {
      if (e.target.classList.contains("b-color")) {
        const sw = e.target.closest(".b-swatch"); const i = Number(sw?.dataset.i);
        if (!Number.isNaN(i)) { _palette[i] = e.target.value; const hex = sw.querySelector(".b-hex"); if (hex) hex.value = e.target.value; refreshJson(root); }
      }
    });

    // Palette add/remove.
    root.querySelector(".b-palette")?.addEventListener("click", (e) => {
      if (e.target.classList.contains("b-add-color")) { _palette.push("#ffffff"); renderPalette(root); }
      else if (e.target.classList.contains("b-color-del")) {
        const i = Number(e.target.closest(".b-swatch")?.dataset.i);
        if (!Number.isNaN(i)) { _palette.splice(i, 1); renderPalette(root); }
      }
    });

    // Add beat.
    root.querySelector(".b-add")?.addEventListener("click", () => {
      readParamsFromDom(root);
      const type = root.querySelector(".b-add-type")?.value ?? "sfxCue";
      _beats.push({ type, params: foundry.utils.deepClone(BEATS[type] ?? {}) });
      renderBeats(root);
    });

    // Timeline row controls.
    root.querySelector(".b-beats")?.addEventListener("click", (e) => {
      const row = e.target.closest(".b-row");
      if (!row) return;
      const i = Number(row.dataset.i);
      readParamsFromDom(root);
      if (e.target.closest(".b-del")) { _beats.splice(i, 1); renderBeats(root); }
      else if (e.target.closest(".b-up") && i > 0) { [_beats[i - 1], _beats[i]] = [_beats[i], _beats[i - 1]]; renderBeats(root); }
      else if (e.target.closest(".b-down") && i < _beats.length - 1) { [_beats[i + 1], _beats[i]] = [_beats[i], _beats[i + 1]]; renderBeats(root); }
    });

    root.querySelector(".b-copy")?.addEventListener("click", () => {
      readParamsFromDom(root); refreshJson(root);
      copyText(root.querySelector(".b-json")?.value ?? "");
    });
    root.querySelector(".b-sfx")?.addEventListener("click", () => globalThis.FUCompanion?.api?.animStudio?.openSfxBrowser?.());
    root.querySelector(".b-vfx")?.addEventListener("click", openVfxDb);

    renderPalette(root);
    renderBeats(root);
  }

  function open() {
    if (!game.user?.isGM) { ui.notifications?.warn?.("Anim Studio is GM-only."); return; }
    if (_dlg?.rendered) { _dlg.bringToTop?.(); return _dlg; }
    _palette = ["#ff8a3d", "#ffd27f"];
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
    }, { width: 600, height: 720, resizable: true, classes: ["anim-studio-dialog"] });
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
