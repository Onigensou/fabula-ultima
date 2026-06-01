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

  function gatherAllClocks() {
    const clocks = [];

    const db = window.clockDatabase;
    if (db) {
      db.forEach(c => clocks.push({
        id: `g:${c.id}`, name: c.name, value: c.value, max: c.max,
        source: "global", dbId: c.id,
      }));
    }

    for (const actor of (game?.actors?.contents ?? [])) {
      const props = actor.system?.props;
      if (!props) continue;
      for (const [key, rawVal] of Object.entries(props)) {
        if (!(key in ACTOR_CLOCK_MAX)) continue;
        clocks.push({
          id:      `a:${actor.id}:${key}`,
          name:    `${actor.name} — ${ACTOR_CLOCK_LABEL[key] ?? key}`,
          value:   parseInt(rawVal) || 0,
          max:     ACTOR_CLOCK_MAX[key],
          source:  "actor",
          actorId: actor.id,
          clockKey: key,
        });
      }
    }

    return clocks;
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
      const globals = clocks.filter(c => c.source === "global");
      const actors  = clocks.filter(c => c.source === "actor");
      const hasGroups = globals.length > 0 && actors.length > 0;
      let opts = "";
      if (hasGroups) {
        opts += `<optgroup label="Global Clocks">`;
        for (const c of globals)
          opts += `<option value="${clocks.indexOf(c)}">${esc(c.name)} (${c.value}/${c.max})</option>`;
        opts += `</optgroup><optgroup label="Actor Clocks">`;
        for (const c of actors)
          opts += `<option value="${clocks.indexOf(c)}">${esc(c.name)} (${c.value}/${c.max})</option>`;
        opts += `</optgroup>`;
      } else {
        opts = clocks.map((c, i) =>
          `<option value="${i}">${esc(c.name)} (${c.value}/${c.max})</option>`
        ).join("");
      }

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

    return { dim, svgOverlay, cx, cy };
  }

  async function destroySpotlight({ dim, svgOverlay }) {
    if (!dim) return;
    dim.style.transition  = "background 200ms ease-in";
    dim.style.background  = "rgba(0,0,0,0)";
    if (svgOverlay) svgOverlay.style.opacity = "0";
    await delay(210);
    dim.remove();
    svgOverlay?.remove();
  }

  // ── Effect registration ───────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("progress", {

      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const clocks = gatherAllClocks();
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
          dbId:      clock.dbId,
          actorId:   clock.actorId,
          clockKey:  clock.clockKey,
        };
      },

      async post(ctx, preResult) {
        if (!preResult) return;
        const { clockName, oldValue, newValue, max, source, dbId, actorId, clockKey } = preResult;

        const step       = newValue > oldValue ? 1 : -1;
        const isIncrease = step > 0;

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

        // Spotlight uses global clock DOM only; actor clocks get center-screen fallback.
        const spotlight = await createSpotlight(source === "global" ? dbId : null, oldValue, max);
        const { svgOverlay, cx, cy } = spotlight;

        try {
          for (let v = oldValue + step; isIncrease ? v <= newValue : v >= newValue; v += step) {
            if (svgOverlay) svgOverlay.innerHTML = renderClockSVG(v, max, null, true);
            playTickSound(isIncrease ? SFX_TICK_INC : SFX_TICK_DEC, 0.7);
            emitParticleBurst(cx, cy, isIncrease);
            await delay(300);
          }
        } finally {
          await destroySpotlight(spotlight);
        }

        await postProgressCard({ actorName: ctx.actorName, clockName, oldValue, newValue, max });
        console.debug(TAG, "[done]");
      },
    });
  });
})();
