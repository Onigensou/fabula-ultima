// ============================================================================
// Opportunity Effect — Progress
// Requires: Global Progress Clocks (global-progress-clocks)
//
// Flow (pre/post):
//   pre  — DOM overlay: clock picker + delta + SVG preview
//          returns { clockId, clockName, oldValue, newValue, max }
//   post — spotlight dim, sequential ticks with particles, chat card
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Progress]";

  // ── Sounds ──────────────────────────────────────────────────────────────────
  const SFX_UI_OPEN  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Equip1.ogg";
  const SFX_CURSOR   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav";
  const SFX_TICK_INC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/SFX_TINK.wav";
  const SFX_TICK_DEC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/collision_1.wav";
  const SFX_CONFIRM  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/opportunity_confirmed.wav";
  const SFX_CANCEL   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav";

  function playSound(url, vol = 0.7) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true, loop: false }, false); }
    catch (_) { try { const a = new Audio(url); a.volume = vol; a.play().catch(() => {}); } catch {} }
  }

  // Always creates a fresh Audio node — bypasses AudioHelper deduplication for rapid sequential plays.
  function playTickSound(url, vol = 0.7) {
    try { const a = new Audio(url); a.volume = vol; a.play().catch(() => {}); } catch {}
  }

  // ── Utilities ────────────────────────────────────────────────────────────────
  const esc   = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ── Actor clock registry ──────────────────────────────────────────────────────
  // numberField maxVal per key, sourced from _FabU Char Template v3.fire
  const ACTOR_CLOCK_MAX = {
    clock_brainwave: 4,
    clock_trade:     6,
    clock_adoration: 5,
    clock_grave:     6,
  };
  const ACTOR_CLOCK_LABEL = {
    clock_brainwave: "Brainwave",
    clock_trade:     "Trade",
    clock_adoration: "Adoration",
    clock_grave:     "Grave",
  };

  // Parent panel keys in the CSB template that gate each clock field's visibility.
  const ACTOR_CLOCK_PANEL_KEY = {
    clock_brainwave: "blainwave_panel",
    clock_trade:     "trade_panel",
    clock_adoration: "adoration_panel",
    clock_grave:     "grave_panel",
  };

  // Walk a CSB template node tree looking for a node with the given key.
  function _findNodeByKey(node, key) {
    if (!node || typeof node !== "object") return null;
    if (node.key === key) return node;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      const hit = _findNodeByKey(child, key);
      if (hit) return hit;
    }
    return null;
  }

  // Returns true if the clock field's governing parent panel is visible for this actor.
  // Reads the panel's visibilityFormula, extracts the class name from the lookup() call,
  // and checks actor.system.props.class_list — mirroring exactly what CSB evaluates.
  function isClockVisibleForActor(actor, clockKey, tmplSystem) {
    const panelKey = ACTOR_CLOCK_PANEL_KEY[clockKey];
    if (!panelKey || !tmplSystem) return true;
    const panel = _findNodeByKey(tmplSystem, panelKey);
    if (!panel?.visibilityFormula) return true;
    const m = panel.visibilityFormula.match(/lookup\(\s*'class_list'\s*,\s*'class_name'\s*,\s*'class_name'\s*,\s*'([^']+)'\s*\)/);
    if (!m) return true;  // unrecognised formula — err on the side of showing it
    const requiredClass = m[1];
    const table = actor.system?.props?.class_list;
    if (!table) return false;
    return Object.values(table).some(row => !row.$deleted && row.class_name === requiredClass);
  }

  async function gatherAllClocks() {
    const clocks = [];

    // Clock System clocks (FUCompanion.api.clocks) — the ones with sides, poles
    // and success/failure. Listed first because they are the ones that matter.
    // Only ACTIVE clocks: spending an opportunity on a clock that already
    // resolved would be a no-op the player paid for.
    const clockApi = globalThis.FUCompanion?.api?.clocks;
    if (clockApi) {
      for (const c of clockApi.list({ state: clockApi.CLOCK_STATE.ACTIVE })) {
        if (c.visibility === clockApi.VISIBILITY.GM && !game.user.isGM) continue;
        clocks.push({
          id: `f:${c.id}`, name: c.name, value: c.value, max: c.sections,
          source: "fu", fuId: c.id,
        });
      }
    }

    // Legacy: the standalone Global Progress Clocks module. No API, no sides,
    // no success/failure — kept only so clocks authored there still work.
    const db = window.clockDatabase;
    if (db) {
      db.forEach(c => clocks.push({
        id: `g:${c.id}`, name: c.name, value: c.value, max: c.max,
        source: "global", dbId: c.id,
      }));
    }

    // Actor clocks — party members in slot order, then scene-only actors alphabetically
    const actorIds    = await getRelevantActorIds();
    const tmplSysCache = new Map();  // templateId → system, shared across actors

    for (const actorId of actorIds) {
      const actor = game.actors?.get(actorId);
      if (!actor?.system?.props) continue;

      const tmplId  = actor.system?.template;
      if (!tmplSysCache.has(tmplId)) {
        const tmpl = game.actors?.get(tmplId);
        tmplSysCache.set(tmplId, tmpl?.system ?? null);
      }
      const tmplSys = tmplSysCache.get(tmplId);

      for (const [key, rawVal] of Object.entries(actor.system.props)) {
        if (!(key in ACTOR_CLOCK_MAX)) continue;
        if (!isClockVisibleForActor(actor, key, tmplSys)) continue;
        clocks.push({
          id:       `a:${actorId}:${key}`,
          name:     `${actor.name} — ${ACTOR_CLOCK_LABEL[key] ?? key}`,
          value:    parseInt(rawVal) || 0,
          max:      ACTOR_CLOCK_MAX[key],
          source:   "actor",
          actorId,
          clockKey:  key,
          actorName: actor.name,
        });
      }
    }

    return clocks;
  }

  async function getRelevantActorIds() {
    const ordered = [];
    const seen    = new Set();

    // Party members from db_resolver — in slot order (1–4)
    try {
      const result = await window.FUCompanion?.api?.getCurrentGameDb?.();
      const props  = result?.db?.system?.props;
      if (props) {
        for (let i = 1; i <= 4; i++) {
          const ref = props[`member_id_${i}`];
          if (!ref) continue;
          const id = ref.startsWith("Actor.") ? ref.slice(6) : ref;
          if (id && !seen.has(id)) { seen.add(id); ordered.push(id); }
        }
      }
    } catch {}

    // Actors with tokens on the active scene — alphabetical, deduped
    const sceneActors = (canvas?.tokens?.placeables ?? [])
      .map(t => t.actor)
      .filter(a => a?.id && !seen.has(a.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const a of sceneActors) { seen.add(a.id); ordered.push(a.id); }

    return ordered;
  }

  // ── SVG Clock ─────────────────────────────────────────────────────────────────
  function renderClockSVG(value, max, newValue = null, fill = false) {
    const display = Math.min(Math.max(max, 0), 16);
    if (display === 0) return "";

    const cx = 60, cy = 60, outerR = 52, innerR = 20;

    function sectorFill(i) {
      const wasFilled    = i < value;
      const willBeFilled = newValue !== null ? i < newValue : wasFilled;
      if (newValue !== null) {
        if (!wasFilled && willBeFilled) return "#7ec87a";
        if (wasFilled && !willBeFilled) return "#e08080";
        if (willBeFilled)               return "#f9a825";
        return "#2a2a3a";
      }
      return wasFilled ? "#f9a825" : "#2a2a3a";
    }

    const svgAttrs = fill
      ? `style="display:block;width:100%;height:100%;" viewBox="0 0 120 120"`
      : `width="120" height="120" viewBox="0 0 120 120" style="display:block;margin:0 auto;"`;

    if (display === 1) {
      return `<svg ${svgAttrs}>
        <circle cx="${cx}" cy="${cy}" r="${outerR}" fill="${sectorFill(0)}" stroke="#0d141a" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy}" r="${innerR}"  fill="#0d141a"/>
      </svg>`;
    }

    const GAP_RAD = (display > 8 ? 1.5 : 2.5) * Math.PI / 180;
    const TWO_PI  = Math.PI * 2;
    const f       = n => n.toFixed(2);
    let paths = "";

    for (let i = 0; i < display; i++) {
      const sa  = (i / display) * TWO_PI - Math.PI / 2 + GAP_RAD / 2;
      const ea  = ((i + 1) / display) * TWO_PI - Math.PI / 2 - GAP_RAD / 2;
      const la  = (ea - sa) > Math.PI ? 1 : 0;
      const ox1 = cx + outerR * Math.cos(sa), oy1 = cy + outerR * Math.sin(sa);
      const ox2 = cx + outerR * Math.cos(ea), oy2 = cy + outerR * Math.sin(ea);
      const ix1 = cx + innerR * Math.cos(sa), iy1 = cy + innerR * Math.sin(sa);
      const ix2 = cx + innerR * Math.cos(ea), iy2 = cy + innerR * Math.sin(ea);
      const d = `M ${f(ix1)} ${f(iy1)} L ${f(ox1)} ${f(oy1)} A ${outerR} ${outerR} 0 ${la} 1 ${f(ox2)} ${f(oy2)} L ${f(ix2)} ${f(iy2)} A ${innerR} ${innerR} 0 ${la} 0 ${f(ix1)} ${f(iy1)} Z`;
      paths += `<path d="${d}" fill="${sectorFill(i)}" stroke="#0d141a" stroke-width="1.5"/>`;
    }

    const overflow = max > display
      ? `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="9" fill="#666" font-family="Signika,sans-serif">+${max - display}</text>`
      : "";

    return `<svg ${svgAttrs}>${paths}${overflow}</svg>`;
  }

  // ── Dot renderer (chat card only) ─────────────────────────────────────────────
  function renderDots(value, max, newValue = null) {
    const display = Math.min(max, 16);
    let out = "";
    for (let i = 0; i < display; i++) {
      const wasFilled    = i < value;
      const willBeFilled = newValue !== null ? i < newValue : wasFilled;
      let color;
      if (newValue !== null) {
        if (!wasFilled && willBeFilled)      color = "#7ec87a";
        else if (wasFilled && !willBeFilled) color = "#e08080";
        else if (willBeFilled)               color = "#f9a825";
        else                                 color = "#555";
      } else {
        color = wasFilled ? "#f9a825" : "#555";
      }
      out += `<span style="font-size:1.15rem;color:${color};line-height:1;">●</span>`;
    }
    if (max > display) out += `<span style="font-size:.8rem;opacity:.55;"> +${max - display}</span>`;
    return out;
  }

  // ── Chat card ─────────────────────────────────────────────────────────────────
  async function postProgressCard({ actorName, clockName, oldValue, newValue, max }) {
    const filled  = newValue > oldValue;
    const accent  = filled ? "#2a6a8a" : "#8a3a2a";
    const verb    = filled ? "filled" : "erased";
    const count   = Math.abs(newValue - oldValue);
    const content = `
      <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
        background:linear-gradient(160deg,#0d141a 0%,#0f1e2a 100%);
        border:2px solid ${esc(accent)};color:#c8d8e8;">
        <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
          <i class="fas fa-clock" style="margin-right:4px;"></i>Progress — ${esc(actorName)}
        </div>
        <div style="font-weight:900;font-size:.95rem;margin-bottom:6px;">${esc(clockName)}</div>
        <div style="margin-bottom:6px;">${renderDots(oldValue, max, newValue)}</div>
        <div style="font-size:.82rem;opacity:.8;">
          ${count} section${count !== 1 ? "s" : ""} ${esc(verb)} &nbsp;·&nbsp; ${oldValue} → ${newValue} / ${max}
        </div>
      </div>`;
    await ChatMessage.create({ content }).catch(e => console.error(TAG, "postProgressCard failed:", e));
  }

  // ── DOM Overlay UI ────────────────────────────────────────────────────────────
  function ensureOverlayStyle() {
    if (document.getElementById("oni-prog-ovl-style")) return;
    const s = document.createElement("style");
    s.id = "oni-prog-ovl-style";
    s.textContent = `
      @keyframes oni-prog-in  { from { opacity:0; transform:scale(.95) } to { opacity:1; transform:scale(1) } }
      @keyframes oni-prog-out { from { opacity:1; transform:scale(1)   } to { opacity:0; transform:scale(.95) } }
      #oni-prog-ovl {
        position:fixed;inset:0;z-index:100025;
        display:flex;align-items:center;justify-content:center;
        background:rgba(4,2,10,.82);
        font-family:'Signika','Noto Sans',system-ui,sans-serif;
      }
      #oni-prog-ovl .oni-card {
        background:linear-gradient(160deg,#0c1117 0%,#0f1e2a 100%);
        border:1.5px solid #2a4a6a;border-radius:14px;
        padding:22px 24px;min-width:300px;max-width:380px;width:90vw;
        animation:oni-prog-in 220ms ease-out forwards;
        box-shadow:0 8px 40px rgba(0,0,0,.7);color:#c8d8e8;
      }
      #oni-prog-ovl .oni-card.closing { animation:oni-prog-out 160ms ease-in forwards; }
      #oni-prog-ovl h3 {
        margin:0 0 16px;font-size:.9rem;text-transform:uppercase;
        letter-spacing:.08em;opacity:.55;font-weight:600;
      }
      #oni-prog-ovl label { font-size:.8rem;opacity:.65;display:block;margin-bottom:4px; }
      #oni-prog-ovl select {
        width:100%;padding:6px 8px;border-radius:6px;border:1px solid #2a4a6a;
        background:#0d1920;color:#c8d8e8;font-size:.88rem;cursor:pointer;
      }
      #oni-prog-ovl option, #oni-prog-ovl optgroup {
        background:#fff;color:#1a2a38;
      }
      #oni-prog-ovl optgroup { font-weight:700; }
      #oni-prog-ovl .delta-row {
        display:flex;align-items:center;gap:8px;margin-top:14px;
      }
      #oni-prog-ovl .delta-lbl { font-size:.8rem;opacity:.65;white-space:nowrap;margin:0; }
      #oni-prog-ovl .delta-btn {
        width:34px;height:34px;border-radius:6px;border:1px solid #2a4a6a;
        background:#0d1920;color:#c8d8e8;font-size:1.2rem;cursor:pointer;
        display:flex;align-items:center;justify-content:center;flex-shrink:0;
        transition:background 100ms,border-color 100ms;
      }
      #oni-prog-ovl .delta-btn:hover { background:#1a3040;border-color:#4a8ab0; }
      #oni-prog-ovl .delta-input {
        flex:1;text-align:center;padding:6px;border-radius:6px;
        border:1px solid #2a4a6a;background:#0d1920;color:#c8d8e8;font-size:1rem;
      }
      #oni-prog-ovl .preview { margin:16px 0 2px;min-height:128px;text-align:center; }
      #oni-prog-ovl .hint { font-size:.74rem;opacity:.45;text-align:center;margin-top:6px; }
      #oni-prog-ovl .btn-row { display:flex;gap:10px;margin-top:18px; }
      #oni-prog-ovl .oni-btn {
        flex:1;padding:9px 14px;border-radius:7px;border:none;
        font-size:.88rem;font-family:inherit;cursor:pointer;
        transition:background 120ms,transform 80ms;
      }
      #oni-prog-ovl .oni-btn:active { transform:scale(.97); }
      #oni-prog-ovl .oni-btn-cancel {
        background:#1a2a38;color:#c8d8e8;border:1px solid #2a4a6a;
      }
      #oni-prog-ovl .oni-btn-cancel:hover { background:#243242; }
      #oni-prog-ovl .oni-btn-confirm {
        background:linear-gradient(135deg,#1a5a8a,#2a7ab0);color:#fff;
      }
      #oni-prog-ovl .oni-btn-confirm:hover { background:linear-gradient(135deg,#2a6a9a,#3a8ac0); }
    `;
    document.head.appendChild(s);
  }

  async function showProgressOverlay(clocks) {
    ensureOverlayStyle();
    return new Promise(resolve => {
      // Build optgroups: Clock System first, then the legacy module's clocks,
      // then per-actor groups (preserving order)
      const fuClocks  = clocks.filter(c => c.source === "fu");
      const globals   = clocks.filter(c => c.source === "global");
      const actorMap  = new Map();
      for (const c of clocks.filter(c => c.source === "actor")) {
        if (!actorMap.has(c.actorId)) actorMap.set(c.actorId, { name: c.actorName, entries: [] });
        actorMap.get(c.actorId).entries.push(c);
      }

      let opts = "";
      if (fuClocks.length) {
        opts += `<optgroup label="⏱ Clocks">`;
        for (const c of fuClocks)
          opts += `<option value="${clocks.indexOf(c)}">${esc(c.name)} (${c.value} / ${c.max})</option>`;
        opts += `</optgroup>`;
      }
      if (globals.length) {
        opts += `<optgroup label="⏱ Global Clocks (legacy)">`;
        for (const c of globals)
          opts += `<option value="${clocks.indexOf(c)}">${esc(c.name)} (${c.value} / ${c.max})</option>`;
        opts += `</optgroup>`;
      }
      for (const [, grp] of actorMap) {
        opts += `<optgroup label="◈ ${esc(grp.name)}">`;
        for (const c of grp.entries) {
          const lbl = ACTOR_CLOCK_LABEL[c.clockKey] ?? c.clockKey;
          opts += `<option value="${clocks.indexOf(c)}">${esc(lbl)}  ${c.value} / ${c.max}</option>`;
        }
        opts += `</optgroup>`;
      }
      if (!opts) opts = `<option value="0" disabled>No clocks available</option>`;

      const ovl = document.createElement("div");
      ovl.id = "oni-prog-ovl";
      ovl.innerHTML = `
        <div class="oni-card">
          <h3><i class="fas fa-clock" style="margin-right:6px;opacity:.7;"></i>Progress — Choose Clock</h3>
          <div>
            <label>Clock</label>
            <select id="oni-prog-clock">${opts}</select>
          </div>
          <div class="delta-row">
            <label class="delta-lbl">Sections (+/−)</label>
            <button class="delta-btn" id="oni-prog-minus">−</button>
            <input  class="delta-input" id="oni-prog-delta" type="number" min="-2" max="2" value="1"/>
            <button class="delta-btn" id="oni-prog-plus">+</button>
          </div>
          <div class="preview" id="oni-prog-preview"></div>
          <div class="hint">Preview above &nbsp;·&nbsp; max ±2 sections</div>
          <div class="btn-row">
            <button class="oni-btn oni-btn-cancel"  id="oni-prog-cancel">Cancel</button>
            <button class="oni-btn oni-btn-confirm" id="oni-prog-confirm">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(ovl);
      playSound(SFX_UI_OPEN, 0.7);

      let closed = false;

      function getState() {
        const idx   = parseInt(document.getElementById("oni-prog-clock")?.value ?? "0", 10);
        const raw   = parseInt(document.getElementById("oni-prog-delta")?.value  ?? "0", 10);
        const clock = clocks[Number.isFinite(idx) ? idx : 0];
        const delta = Math.max(-2, Math.min(2, Number.isFinite(raw) ? raw : 0));
        const nv    = clock ? Math.max(0, Math.min(clock.max, clock.value + delta)) : 0;
        return { clock, delta, newValue: nv };
      }

      function updatePreview() {
        const { clock, newValue } = getState();
        const el = document.getElementById("oni-prog-preview");
        if (!el || !clock) return;
        el.innerHTML = `
          ${renderClockSVG(clock.value, clock.max, newValue)}
          <div style="font-size:.78rem;opacity:.5;margin-top:6px;">
            ${clock.value} → ${newValue} / ${clock.max}
            ${newValue === clock.value ? " <em>(no change)</em>" : ""}
          </div>`;
      }

      function dismiss(result) {
        if (closed) return;
        closed = true;
        const card = ovl.querySelector(".oni-card");
        if (card) card.classList.add("closing");
        ovl.style.cssText += ";transition:opacity 180ms ease-in;opacity:0;";
        setTimeout(() => { ovl.remove(); resolve(result); }, 190);
      }

      document.getElementById("oni-prog-clock").addEventListener("change", () => {
        playSound(SFX_UI_OPEN, 0.55);
        updatePreview();
      });
      document.getElementById("oni-prog-minus").addEventListener("click", () => {
        const el = document.getElementById("oni-prog-delta");
        el.value = Math.max(-2, parseInt(el.value ?? "0", 10) - 1);
        playSound(SFX_CURSOR, 0.65);
        updatePreview();
      });
      document.getElementById("oni-prog-plus").addEventListener("click", () => {
        const el = document.getElementById("oni-prog-delta");
        el.value = Math.min(2, parseInt(el.value ?? "0", 10) + 1);
        playSound(SFX_CURSOR, 0.65);
        updatePreview();
      });
      document.getElementById("oni-prog-delta").addEventListener("input", () => {
        const el = document.getElementById("oni-prog-delta");
        const v  = parseInt(el.value, 10);
        if (Number.isFinite(v)) el.value = Math.max(-2, Math.min(2, v));
        updatePreview();
      });
      document.getElementById("oni-prog-confirm").addEventListener("click", () => {
        const { clock, delta } = getState();
        playSound(SFX_CONFIRM, 0.8);
        dismiss({ clock, delta });
      });
      document.getElementById("oni-prog-cancel").addEventListener("click", () => {
        playSound(SFX_CANCEL, 0.65);
        dismiss(null);
      });

      function onKey(e) {
        if (e.key === "Enter")  document.getElementById("oni-prog-confirm")?.click();
        if (e.key === "Escape") document.getElementById("oni-prog-cancel")?.click();
      }
      document.addEventListener("keydown", onKey);

      const mo = new MutationObserver(() => {
        if (!document.getElementById("oni-prog-ovl")) {
          document.removeEventListener("keydown", onKey);
          mo.disconnect();
        }
      });
      mo.observe(document.body, { childList: true });

      updatePreview();
    });
  }

  // ── Particle burst ────────────────────────────────────────────────────────────
  function emitParticleBurst(cx, cy, isIncrease) {
    if (cx == null || cy == null) return;
    const color = isIncrease ? "#7ec87a" : "#e08080";

    for (let i = 0; i < 6; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = 28 + Math.random() * 28;
      const tx    = Math.cos(angle) * dist;
      const ty    = Math.sin(angle) * dist;

      const p = document.createElement("div");
      p.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;
        width:7px;height:7px;border-radius:50%;background:${color};
        pointer-events:none;z-index:100022;opacity:1;`;
      document.body.appendChild(p);

      const start = performance.now();
      const dur   = 320;
      const step  = now => {
        const t     = Math.min((now - start) / dur, 1);
        const easeT = 1 - (1 - t) * (1 - t);
        p.style.left    = `${cx + tx * easeT}px`;
        p.style.top     = `${cy + ty * easeT}px`;
        p.style.opacity = String(1 - t);
        if (t < 1) requestAnimationFrame(step);
        else p.remove();
      };
      requestAnimationFrame(step);
    }
  }

  // ── Token clock animation helpers ─────────────────────────────────────────────
  function ensureTokenAnimStyle() {
    if (document.getElementById("oni-prog-token-style")) return;
    const s = document.createElement("style");
    s.id = "oni-prog-token-style";
    s.textContent = `
      @keyframes oni-prog-token-in  { from { opacity:0; transform:translateX(-60px); } to { opacity:1; transform:translateX(0); } }
      @keyframes oni-prog-token-out { from { opacity:1; transform:translateX(0);     } to { opacity:0; transform:translateX(60px); } }
    `;
    document.head.appendChild(s);
  }

  function getTokenScreenPos(actorId) {
    if (!canvas?.tokens?.placeables) return null;
    const token = canvas.tokens.placeables.find(t => t.visible && t.actor?.id === actorId)
               ?? canvas.tokens.placeables.find(t => t.actor?.id === actorId);
    if (!token) return null;
    const { a: scale, tx, ty } = canvas.stage.worldTransform;
    const center = token.center;
    return {
      screenX: center.x * scale + tx,
      screenY: center.y * scale + ty,
      tokenW:  token.w * scale,
      tokenH:  token.h * scale,
    };
  }

  async function createTokenSpotlight(actorId, currentValue, max) {
    ensureTokenAnimStyle();
    const pos = getTokenScreenPos(actorId);

    const dim = document.createElement("div");
    dim.style.cssText = `position:fixed;inset:0;z-index:100020;
      background:rgba(0,0,0,0);pointer-events:none;
      transition:background 250ms ease-out;`;
    document.body.appendChild(dim);

    let glowRing   = null;
    let svgOverlay = null;
    let cx = window.innerWidth  / 2;
    let cy = window.innerHeight / 2;

    if (pos) {
      // Glow ring around token
      const pad = 8;
      glowRing = document.createElement("div");
      glowRing.style.cssText = `
        position:fixed;
        left:${pos.screenX - pos.tokenW / 2 - pad}px;
        top:${pos.screenY  - pos.tokenH / 2 - pad}px;
        width:${pos.tokenW + pad * 2}px; height:${pos.tokenH + pad * 2}px;
        border-radius:50%;
        border:3px solid rgba(255,220,80,.9);
        box-shadow:0 0 20px rgba(255,200,50,.65), inset 0 0 14px rgba(255,200,50,.2);
        z-index:100021;pointer-events:none;
        opacity:0;transition:opacity 250ms ease-out;
      `;
      document.body.appendChild(glowRing);

      // SVG clock — smaller, positioned above the token's head
      const svgSize = Math.max(52, Math.min(80, pos.tokenW * 0.65));
      const svgLeft = pos.screenX - svgSize / 2;
      const svgTop  = pos.screenY - pos.tokenH / 2 - svgSize - 6;
      cx = svgLeft + svgSize / 2;
      cy = svgTop  + svgSize / 2;

      svgOverlay = document.createElement("div");
      svgOverlay.style.cssText = `
        position:fixed;
        left:${svgLeft}px; top:${svgTop}px;
        width:${svgSize}px; height:${svgSize}px;
        z-index:100022;pointer-events:none;
        animation:oni-prog-token-in 280ms ease-out forwards;
      `;
      svgOverlay.innerHTML = renderClockSVG(currentValue, max, null, true);
      document.body.appendChild(svgOverlay);
    }

    void dim.offsetWidth;
    dim.style.background = "rgba(0,0,0,.5)";
    if (glowRing) { void glowRing.offsetWidth; glowRing.style.opacity = "1"; }
    await delay(290);

    return { dim, svgOverlay, glowRing, cx, cy, slideOut: true };
  }

  // ── Spotlight dim ─────────────────────────────────────────────────────────────
  // Strategy: full-screen dim + an SVG overlay clone positioned over the real clock
  // element at a guaranteed-high z-index. The real clock is untouched (it updates
  // once behind the dim, invisible). All animation runs on the SVG overlay.
  async function createSpotlight(clockId, currentValue, max) {
    const escaped    = clockId != null ? CSS.escape(String(clockId)) : null;
    const entryEl    = escaped
      ? (document.querySelector(`.clock-entry[data-id="${escaped}"]`) ??
         document.querySelector(`[data-id="${escaped}"]`))
      : null;
    const clockInner = entryEl?.querySelector(".clock") ?? entryEl;

    const dim = document.createElement("div");
    dim.style.cssText = `position:fixed;inset:0;z-index:100020;
      background:rgba(0,0,0,0);pointer-events:none;
      transition:background 250ms ease-out;`;
    document.body.appendChild(dim);

    let svgOverlay = null;
    let cx = window.innerWidth / 2;
    let cy = window.innerHeight / 2;

    if (clockInner) {
      const rect = clockInner.getBoundingClientRect();
      cx = rect.left + rect.width  / 2;
      cy = rect.top  + rect.height / 2;

      svgOverlay = document.createElement("div");
      svgOverlay.style.cssText = `
        position:fixed;
        left:${rect.left}px; top:${rect.top}px;
        width:${rect.width}px; height:${rect.height}px;
        z-index:100021; pointer-events:none;
        transition:opacity 200ms ease-in;
      `;
      svgOverlay.innerHTML = renderClockSVG(currentValue, max, null, true);
      document.body.appendChild(svgOverlay);
    }

    void dim.offsetWidth;
    dim.style.background = "rgba(0,0,0,.55)";
    await delay(260);

    return { dim, svgOverlay, cx, cy, glowRing: null, slideOut: false };
  }

  async function destroySpotlight({ dim, svgOverlay, glowRing = null, slideOut = false }) {
    if (!dim) return;
    dim.style.transition = "background 200ms ease-in";
    dim.style.background = "rgba(0,0,0,0)";
    if (svgOverlay) {
      if (slideOut) {
        svgOverlay.style.animation = "oni-prog-token-out 260ms ease-in forwards";
      } else {
        svgOverlay.style.transition = "opacity 200ms ease-in";
        svgOverlay.style.opacity    = "0";
      }
    }
    if (glowRing) {
      glowRing.style.transition = "opacity 260ms ease-in";
      glowRing.style.opacity    = "0";
    }
    await delay(slideOut ? 270 : 210);
    dim.remove();
    svgOverlay?.remove();
    glowRing?.remove();
  }

  // ── Effect registration ───────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    // Pre-load tick sounds into the browser HTTP cache so the first animation
    // plays both ticks correctly (without pre-loading, the second Audio element
    // created within the 300ms loop window hits a partial download and is silently
    // rejected by the .catch in playTickSound).
    [SFX_TICK_INC, SFX_TICK_DEC].forEach(url => {
      try { const a = new Audio(url); a.preload = "auto"; a.load(); } catch {}
    });

    window["oni.OppEffectRegistry"]?.register("progress", {

      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const clocks = await gatherAllClocks();
        if (!clocks.length) {
          ui.notifications?.warn("[Opportunity] No clocks found.");
          return null;
        }

        const result = await showProgressOverlay(clocks);
        console.debug(TAG, "[pre] result:", result ? { clockName: result.clock?.name, delta: result.delta } : "NULL");
        if (!result) return null;

        const { clock, delta } = result;
        if (delta === 0) return null;

        const newValue = Math.max(0, Math.min(clock.max, clock.value + delta));
        if (newValue === clock.value) {
          ui.notifications?.info(`[Opportunity] "${clock.name}" is already at its limit.`);
          return null;
        }

        return {
          clockName: clock.name,
          oldValue:  clock.value,
          newValue,
          max:       clock.max,
          source:    clock.source,
          fuId:      clock.fuId,
          dbId:      clock.dbId,
          actorId:   clock.actorId,
          clockKey:  clock.clockKey,
        };
      },

      async post(ctx, preResult) {
        if (!preResult) return;
        const { clockName, oldValue, newValue, max, source, fuId, dbId, actorId, clockKey } = preResult;

        const step       = newValue > oldValue ? 1 : -1;
        const isIncrease = step > 0;

        // ── Clock System clocks ────────────────────────────────────────────
        // No spotlight, no SVG loop: the clock bar already animates its own
        // sections one at a time with a tick, on every client. Duplicating that
        // here would double the sound and fight the bar's own stepper.
        //
        // `direction` moves the AXIS rather than a side's pole, so an
        // opportunity can nudge a clock whichever way the fiction demands —
        // including a direction whose pole nobody owns.
        if (source === "fu") {
          const clockApi = globalThis.FUCompanion?.api?.clocks;
          if (!clockApi) { console.error(TAG, "[post] clock API not available"); return; }

          const moved = await clockApi.advance(fuId, {
            direction: isIncrease ? clockApi.POLE.HIGH : clockApi.POLE.LOW,
            sections: Math.abs(newValue - oldValue),
            cause: `Opportunity: Progress (${ctx.actorName})`,
          });
          if (!moved) { console.warn(TAG, "[post] clock advance refused or was a no-op"); return; }

          // Let the bar's staggered fill land before the chat card.
          await delay(Math.abs(newValue - oldValue) * 140 + 500);
          await postProgressCard({ actorName: ctx.actorName, clockName, oldValue, newValue, max });
          console.debug(TAG, "[done]");
          return;
        }

        // Update real data once before animation — hidden behind the dim.
        if (source === "global") {
          const db = window.clockDatabase;
          if (!db) { console.error(TAG, "[post] clockDatabase not available"); return; }
          db.update({ id: dbId, value: newValue });
        } else {
          const actor = game.actors?.get(actorId);
          if (!actor) { console.error(TAG, "[post] actor not found:", actorId); return; }
          await actor.update({ [`system.props.${clockKey}`]: String(newValue) });
        }

        const spotlight = source === "global"
          ? await createSpotlight(dbId, oldValue, max)
          : await createTokenSpotlight(actorId, oldValue, max);
        const { svgOverlay, cx, cy } = spotlight;

        try {
          for (let v = oldValue + step; isIncrease ? v <= newValue : v >= newValue; v += step) {
            if (svgOverlay) svgOverlay.innerHTML = renderClockSVG(v, max, null, true);
            playTickSound(isIncrease ? SFX_TICK_INC : SFX_TICK_DEC, 0.7);
            emitParticleBurst(cx, cy, isIncrease);
            await delay(300);
          }
          await delay(700); // hold on final state before exit
        } finally {
          await destroySpotlight(spotlight);
        }

        await postProgressCard({ actorName: ctx.actorName, clockName, oldValue, newValue, max });
        console.debug(TAG, "[done]");
      },
    });
  });
})();
