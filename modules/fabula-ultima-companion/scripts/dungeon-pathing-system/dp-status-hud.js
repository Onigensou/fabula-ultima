// ============================================================================
// Dungeon Pathing System — Party Status HUD
//
// Compact overlay showing party status during dungeon exploration.
//
// Layout per member row (single horizontal strip):
//   [portrait]  [HP bar / MP bar / IP pips]  |  [AE icon] [AE icon] …
//
// GM fade: the HUD sits at the same top-left position for all clients.
// For the GM, hovering the panel fades it to near-transparent (opacity 0.08)
// and removes pointer-events so the toolbar underneath remains clickable.
// A document-level mousemove restores the panel once the cursor leaves the zone.
//
// AE filtering: only effects whose system.tags contains at least one of
//   VISIBLE_TAGS ("debuff", "buff", "dungeon", "food").
//   Charge-governed (lifetimeMode "on_activation") are always excluded.
//
// Tooltip: hovering an AE icon shows a fixed-position DOM tooltip with the
// effect's name, remaining turns, and description (resolved via the same
// priority chain as active-effect-tooltip.js, with a session cache).
// ============================================================================
(() => {
  const DP      = globalThis.DungeonPathing ??= {};
  const FLAG_NS = "fabula-ultima-companion";
  const TAG     = "[DungeonPathing][StatusHUD]";
  const PANEL_ID   = "oni-dp-status-hud";
  const TOOLTIP_ID = "oni-dp-hud-tooltip";
  const STYLE_ID   = "oni-dp-status-hud-styles";

  const VISIBLE_TAGS = new Set(["debuff", "buff", "dungeon", "food"]);

  // ── Stylesheet ─────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
/* ── Panel ── */
#oni-dp-status-hud {
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 99990;
  display: flex;
  flex-direction: column;
  gap: 5px;
  pointer-events: none;
  opacity: 0;
  transform: translateX(-8px);
  transition:
    opacity 280ms cubic-bezier(.4,0,.2,1),
    transform 280ms cubic-bezier(.4,0,.2,1);
}
#oni-dp-status-hud.dp-hud-visible {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}
#oni-dp-status-hud.dp-hud-faded {
  opacity: 0.08 !important;
  pointer-events: none !important;
  transition:
    opacity 140ms ease,
    transform 280ms cubic-bezier(.4,0,.2,1);
}

/* ── Vertigo chip — party-level, sits above the member rows ── */
.oni-dp-hud-vertigo {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 8px;
  border: 1px solid rgba(120,90,190,0.45);
  background: rgba(18,10,30,0.9);
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 10px rgba(0,0,0,0.55);
  color: #d8c8ff;
  font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-shadow: 0 0 6px rgba(0,0,0,0.8);
}
.oni-dp-hud-vertigo span { font-size: 13px; }

/* ── Row — single horizontal strip ── */
.oni-dp-hud-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid rgba(200,160,80,0.28);
  background: rgba(14,10,4,0.88);
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 10px rgba(0,0,0,0.5);
  gap: 0;
}

/* ── Portrait ── */
.oni-dp-hud-portrait {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(200,160,80,0.45);
  background: rgba(40,28,14,0.9);
  flex-shrink: 0;
  margin-right: 8px;
}

/* ── Resource bars section ── */
.oni-dp-hud-resources {
  display: flex;
  flex-direction: column;
  gap: 3px;
  justify-content: center;
  width: 56px;
  flex-shrink: 0;
}

.oni-dp-hud-bar-wrap {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
}

.oni-dp-hud-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 350ms ease;
}

.oni-dp-hud-bar-hp { background: linear-gradient(90deg, #2a6, #4d4); }
.oni-dp-hud-bar-mp { background: linear-gradient(90deg, #338, #56c); }
/* Crisis colours, same bands as the battle HP bar: yellow at half, red at a quarter */
.oni-dp-hud-bar-hp.is-crisis { background: linear-gradient(90deg, #b8901c, #e8c33a); }
.oni-dp-hud-bar-hp.is-low    { background: linear-gradient(90deg, #a82a1e, #e84b3a); }

/* ── Damage pulse (trap hits): ghost under the HP fill + slide-out readout ── */
.oni-dp-hud-row { position: relative; transition: border-color 300ms ease, box-shadow 300ms ease; }
.oni-dp-hud-row.is-struck {
  border-color: rgba(255,110,90,0.75);
  box-shadow: 0 2px 10px rgba(0,0,0,0.5), 0 0 8px rgba(255,70,50,0.35);
  transition: none;
}
.oni-dp-hud-bar-wrap.is-hp { position: relative; }
.oni-dp-hud-bar-wrap.is-hp .oni-dp-hud-bar-fill { position: relative; z-index: 1; }
.oni-dp-hud-bar-ghost {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  border-radius: 2px; background: linear-gradient(90deg, #d92c1e, #ff6a55);
}
.oni-dp-hud-read {
  position: absolute; left: 100%; top: 50%; margin-left: 5px;
  display: flex; align-items: center; gap: 7px; white-space: nowrap;
  padding: 5px 9px; border-radius: 8px;
  border: 1px solid rgba(200,160,80,0.28); background: rgba(14,10,4,0.88);
  box-shadow: 0 2px 10px rgba(0,0,0,0.5);
  opacity: 0; pointer-events: none;
  transform: translate(-10px, -50%);
  clip-path: inset(0 100% 0 0 round 8px);
  transition: opacity 160ms ease-out, transform 220ms cubic-bezier(.2,.8,.2,1), clip-path 220ms cubic-bezier(.2,.8,.2,1);
}
.oni-dp-hud-read.is-on { opacity: 1; transform: translate(0, -50%); clip-path: inset(0 0 0 0 round 8px); }
.oni-dp-hud-read.no-anim { transition: none; }
.oni-dp-hud-read-n {
  font: italic 900 17px/1 "Arial Black", "Segoe UI", sans-serif; color: #ff8f7d;
  transform: skewX(-8deg); font-variant-numeric: tabular-nums;
}
.oni-dp-hud-read-n.is-zero { color: #bcd2e8; }
.oni-dp-hud-read-hp {
  font: 700 13px/1 "Palatino Linotype", Palatino, Georgia, serif; color: #e8dcc0;
  font-variant-numeric: tabular-nums;
}
.oni-dp-hud-read-hp small { font-size: .8em; color: rgba(232,220,192,0.6); font-weight: 600; }
.oni-dp-hud-chip { font: 700 10px/1 "Signika", sans-serif; padding: 3px 5px; border-radius: 3px; letter-spacing: .03em; }
.oni-dp-hud-chip.rs  { background: #3a5b80; color: #fff; }
.oni-dp-hud-chip.im  { background: #2a3140; color: #fff; }
.oni-dp-hud-chip.dr  { background: rgba(200,160,80,0.18); color: #e8c870; border: 1px solid rgba(200,160,80,0.35); }
.oni-dp-hud-chip.cr  { background: #e8c33a; color: #3a2a00; }
.oni-dp-hud-chip.one { background: #8a4b22; color: #fff4e0; }
@media (prefers-reduced-motion: reduce) {
  .oni-dp-hud-read { transition: none; }
}

.oni-dp-hud-pips {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
  width: 100%;
}

.oni-dp-hud-pip {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255,255,255,0.10);
  border: 1px solid rgba(200,160,80,0.22);
  flex-shrink: 0;
  transition: background 250ms ease, border-color 250ms ease;
}

.oni-dp-hud-pip.filled {
  background: #c8a050;
  border-color: rgba(220,180,80,0.8);
}

/* ── Divider ── */
.oni-dp-hud-divider {
  width: 1px;
  align-self: stretch;
  background: rgba(200,160,80,0.16);
  flex-shrink: 0;
  margin: 0 8px;
}

/* ── AE icons ── */
.oni-dp-hud-aes {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  min-width: 0;
}

.oni-dp-hud-ae {
  position: relative;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  cursor: default;
}

.oni-dp-hud-ae img {
  width: 100%;
  height: 100%;
  border-radius: 5px;
  object-fit: cover;
  display: block;
  filter: drop-shadow(0 1px 3px rgba(0,0,0,0.75));
}

.oni-dp-hud-badge {
  position: absolute;
  bottom: -3px;
  right: -4px;
  background: rgba(10,7,3,0.97);
  border: 1px solid rgba(200,160,80,0.7);
  color: #e8c870;
  font-family: var(--font-primary, sans-serif);
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  min-width: 12px;
  height: 12px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  padding: 0 2px;
}

/* Rest-bound effects (food buffs) carry no countdown — they last until the next
   rest, so they show a sun instead of a number. */
.oni-dp-hud-badge.is-rest-bound {
  border-color: rgba(240,190,90,0.85);
  color: #ffd98a;
  font-size: 9px;
}

/* ── AE Tooltip ── */
#oni-dp-hud-tooltip {
  position: fixed;
  z-index: 100001;
  max-width: 300px;
  min-width: 160px;
  padding: 9px 12px;
  border-radius: 9px;
  background: rgba(13,10,5,0.95);
  border: 1px solid rgba(200,160,80,0.35);
  box-shadow: 0 8px 22px rgba(0,0,0,0.55);
  color: #ddd;
  font: 12px/1.45 var(--font-primary, sans-serif);
  pointer-events: none;
  display: none;
  white-space: normal;
}

.oni-dp-hud-tt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.oni-dp-hud-tt-icon {
  width: 26px;
  height: 26px;
  border-radius: 5px;
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid rgba(200,160,80,0.4);
}

.oni-dp-hud-tt-name {
  font-size: 13px;
  font-weight: 600;
  color: #e8c870;
  line-height: 1.2;
}

.oni-dp-hud-tt-turns {
  font-size: 10px;
  color: rgba(220,200,140,0.65);
  margin-bottom: 5px;
}

.oni-dp-hud-tt-desc {
  font-size: 11px;
  color: rgba(220,220,220,0.85);
  line-height: 1.5;
  border-top: 1px solid rgba(200,160,80,0.15);
  padding-top: 5px;
  margin-top: 2px;
}
    `;
    document.head.appendChild(s);
  }

  // ── GM fade-on-hover ────────────────────────────────────────────────────────
  // Fades the HUD to near-transparent when GM's cursor enters the panel zone,
  // so the toolbar underneath stays clickable.
  // A document-level mousemove restores opacity once the cursor leaves.

  let _fadeMoveHandler = null;

  function setupGMFade(panel) {
    if (!game.user?.isGM) return;

    panel.addEventListener("mouseenter", () => {
      panel.classList.add("dp-hud-faded");
    });

    _fadeMoveHandler = (ev) => {
      if (!panel.classList.contains("dp-hud-faded")) return;
      const rect   = panel.getBoundingClientRect();
      const margin = 24;
      const outside =
        ev.clientX < rect.left   - margin ||
        ev.clientX > rect.right  + margin ||
        ev.clientY < rect.top    - margin ||
        ev.clientY > rect.bottom + margin;
      if (outside) panel.classList.remove("dp-hud-faded");
    };
    document.addEventListener("mousemove", _fadeMoveHandler);
  }

  function teardownGMFade() {
    if (_fadeMoveHandler) {
      document.removeEventListener("mousemove", _fadeMoveHandler);
      _fadeMoveHandler = null;
    }
  }

  // ── Tooltip ─────────────────────────────────────────────────────────────────

  const _effMap    = new Map(); // uuid → AE document, repopulated each render
  const _descCache = new Map(); // uuid → resolved description string

  let _tooltipEl     = null;
  let _tooltipTarget = null;

  function getTooltipEl() {
    if (!_tooltipEl || !document.body.contains(_tooltipEl)) {
      const el = document.createElement("div");
      el.id = TOOLTIP_ID;
      document.body.appendChild(el);
      _tooltipEl = el;
    }
    return _tooltipEl;
  }

  function hideTooltip() {
    if (_tooltipEl) _tooltipEl.style.display = "none";
    _tooltipTarget = null;
  }

  function positionTooltip(clientX, clientY) {
    const el  = getTooltipEl();
    const pad = 12;
    let left  = clientX + 16;
    let top   = clientY + 14;
    el.style.display = "block";
    const { width, height } = el.getBoundingClientRect();
    if (left + width  + pad > window.innerWidth)  left = clientX - width  - 16;
    if (top  + height + pad > window.innerHeight) top  = clientY - height - 14;
    el.style.left = `${Math.max(pad, left)}px`;
    el.style.top  = `${Math.max(pad, top)}px`;
  }

  // Replicates description resolution from active-effect-tooltip.js.
  async function resolveDescription(eff) {
    const key = eff?.uuid ?? eff?.id ?? "?";
    if (_descCache.has(key)) return _descCache.get(key);

    let desc =
      eff?.description ??
      eff?.system?.description ??
      eff?.flags?.world?.description ??
      eff?.flags?.core?.description ?? "";

    if (typeof desc === "object" && desc !== null) desc = desc.value ?? "";
    if (typeof desc !== "string") desc = String(desc ?? "");
    desc = desc.trim();

    if (!desc && eff?.origin) {
      try {
        const origin = await fromUuid(eff.origin);
        let od = origin?.system?.description ?? origin?.description ?? "";
        if (typeof od === "object" && od !== null) od = od.value ?? "";
        if (typeof od === "string" && od.trim()) desc = od.trim();
      } catch {}
    }

    if (!desc) {
      const ch = Array.isArray(eff?.changes) ? eff.changes : [];
      if (ch.length) desc = ch.map(c => `• ${c.key ?? "?"}: ${c.value ?? ""}`).join("<br>");
    }

    if (!desc) desc = "(No description available.)";

    _descCache.set(key, desc);
    return desc;
  }

  async function showTooltip(aeEl, clientX, clientY) {
    const uuid = aeEl.dataset.effUuid;
    if (!uuid) return;
    const eff = _effMap.get(uuid);
    if (!eff) return;

    _tooltipTarget = aeEl;
    const el    = getTooltipEl();
    const icon  = eff.icon ?? eff.img ?? "";
    const name  = eff.name ?? "Unnamed Effect";
    const turns = getAETurns(eff);
    const turnsHtml = turns != null
      ? `<div class="oni-dp-hud-tt-turns">${turns} turn${turns !== 1 ? "s" : ""} remaining</div>`
      : "";

    el.innerHTML = `
      <div class="oni-dp-hud-tt-header">
        <img class="oni-dp-hud-tt-icon" src="${icon}" alt="${name}">
        <span class="oni-dp-hud-tt-name">${name}</span>
      </div>
      ${turnsHtml}
      <div class="oni-dp-hud-tt-desc">…</div>`;

    positionTooltip(clientX, clientY);

    const desc   = await resolveDescription(eff);
    if (_tooltipTarget !== aeEl) return;
    const descEl = el.querySelector(".oni-dp-hud-tt-desc");
    if (descEl) descEl.innerHTML = desc;
  }

  // ── Panel event delegation ──────────────────────────────────────────────────

  function onPanelMouseMove(ev) {
    const aeEl = ev.target.closest(".oni-dp-hud-ae");
    if (!aeEl) {
      if (!ev.target.closest(`#${TOOLTIP_ID}`)) hideTooltip();
      return;
    }
    if (aeEl === _tooltipTarget) {
      if (_tooltipEl?.style.display !== "none") positionTooltip(ev.clientX, ev.clientY);
      return;
    }
    showTooltip(aeEl, ev.clientX, ev.clientY).catch(() => {});
  }

  function onPanelMouseLeave() { hideTooltip(); }

  // ── Data helpers ────────────────────────────────────────────────────────────

  function hasVisibleTag(eff) {
    const tags = eff?.system?.tags;
    if (!Array.isArray(tags)) return false;
    return tags.some(t => VISIBLE_TAGS.has(String(t).toLowerCase().trim()));
  }

  // A countdown badge is only meaningful for effects a dungeon step actually
  // ticks down. Permanent / rest-bound / item-transferred / charge-governed AEs
  // get no number — see scripts/shared/ae-lifetime.js.
  function getAETurns(eff) {
    if (!globalThis.FUCompanion.AELifetime.isDungeonTickable(eff)) return null;
    const flags = eff?.flags?.[FLAG_NS] ?? {};
    const stamp = flags.directorAppliedBy;
    if (stamp && stamp.turnsRemaining != null) return Number(stamp.turnsRemaining);
    if (flags.dungeonTurnsRemaining != null) return Number(flags.dungeonTurnsRemaining);
    const explicit = Number(eff.duration?.rounds);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return null;
  }

  function getPct(current, max) {
    const c = parseInt(current) || 0;
    const m = Number(max) || 1;
    return Math.min(100, Math.max(0, Math.round((c / m) * 100)));
  }

  // Same bands as the battle HP bar (dp-trap-rules hpBand): >50% green,
  // >25% yellow (Crisis), else red. Ghost and fill sit at the current value
  // at rest; a pulse moves them.
  function hpBandClass(current, max) {
    const f = (parseInt(current) || 0) / Math.max(1, Number(max) || 1);
    return f > 0.5 ? "" : f > 0.25 ? " is-crisis" : " is-low";
  }

  // ── Damage pulse (dungeon traps) ────────────────────────────────────────────
  // pulse(rows) is called on every client by dp-trap-fx.js with the outcome
  // the GM previewed. Each member's row, staggered to match the floating
  // numbers: the edge glows, the HP bar drops with a red ghost that drains,
  // and a readout (−N, HP now / max, DR / Resist / Crisis / Held at 1) slides
  // out to the right, then folds back. The HP writes land on their own clock
  // (CSB recompute); a redraw from them is held back until the drop has played,
  // and a pulse still showing is re-applied after any redraw.
  const PULSE_STRUCK_MS = 120;
  const PULSE_GHOST_DELAY_MS = 400;
  const PULSE_GHOST_MS = 600;
  const PULSE_READ_MS = 2800;
  const PULSE_SETTLE_MS = PULSE_GHOST_DELAY_MS + PULSE_GHOST_MS + 100;

  const _pulses = new Map();   // actorId → { row, at }
  let _busyUntil = 0;          // no HP-driven redraw before this (performance.now)

  const _pct = (v, m) => Math.min(100, Math.max(0, ((Number(v) || 0) / Math.max(1, Number(m) || 1)) * 100));
  const _esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function readoutHtml(r) {
    const chips = [];
    if (r.immune) chips.push(`<span class="oni-dp-hud-chip im">Immune</span>`);
    else if (r.resisted) chips.push(`<span class="oni-dp-hud-chip rs">Resist</span>`);
    if (r.dr > 0) chips.push(`<span class="oni-dp-hud-chip dr">DR −${Number(r.dr)}</span>`);
    if (r.held) chips.push(`<span class="oni-dp-hud-chip one">Held at 1</span>`);
    else if (r.crisisCross) chips.push(`<span class="oni-dp-hud-chip cr">Crisis</span>`);
    const n = Number(r.shown) || 0;
    return `<span class="oni-dp-hud-read-n${n ? "" : " is-zero"}">${n ? "−" + n : "0"}</span>`
      + `<span class="oni-dp-hud-read-hp">${Number(r.after) || 0} <small>/ ${Number(r.max) || 0}</small></span>`
      + chips.join("");
  }

  function rowEl(actorId) {
    return document.querySelector(`#${PANEL_ID} .oni-dp-hud-row[data-actor-id="${CSS.escape(String(actorId))}"]`);
  }

  function readEl(row) {
    let read = row.querySelector(".oni-dp-hud-read");
    if (!read) {
      read = document.createElement("div");
      read.className = "oni-dp-hud-read";
      row.appendChild(read);
    }
    return read;
  }

  function playPulse(r) {
    const row = rowEl(r.actorId);
    if (!row) return;
    _pulses.set(String(r.actorId), { row: r, at: performance.now() });

    const fill  = row.querySelector(".oni-dp-hud-bar-hp");
    const ghost = row.querySelector(".oni-dp-hud-bar-ghost");
    const b = _pct(r.before, r.max), a = _pct(r.after, r.max);
    if (fill && ghost) {
      fill.style.transition = "none"; ghost.style.transition = "none";
      fill.style.width = b + "%"; ghost.style.width = b + "%";
      void fill.offsetWidth;
      fill.style.transition = "width 180ms cubic-bezier(.2,.8,.2,1)";
      fill.style.width = a + "%";
      fill.className = "oni-dp-hud-bar-fill oni-dp-hud-bar-hp" + hpBandClass(r.after, r.max);
      setTimeout(() => {
        const g = rowEl(r.actorId)?.querySelector(".oni-dp-hud-bar-ghost");
        if (!g) return;
        g.style.transition = `width ${PULSE_GHOST_MS}ms ease-in`;
        g.style.width = a + "%";
      }, PULSE_GHOST_DELAY_MS);
    }

    row.classList.add("is-struck");
    setTimeout(() => rowEl(r.actorId)?.classList.remove("is-struck"), PULSE_STRUCK_MS);

    const read = readEl(row);
    read.classList.remove("no-anim");
    read.innerHTML = readoutHtml(r);
    void read.offsetWidth;
    read.classList.add("is-on");
    setTimeout(() => {
      const p = _pulses.get(String(r.actorId));
      if (!p || p.row !== r) return;
      _pulses.delete(String(r.actorId));
      const el = rowEl(r.actorId)?.querySelector(".oni-dp-hud-read");
      el?.classList.remove("is-on", "no-anim");
    }, PULSE_READ_MS);
  }

  // After an innerHTML rebuild: a readout still on show stays on show.
  function reapplyPulses() {
    const now = performance.now();
    for (const [id, p] of _pulses) {
      if (now - p.at >= PULSE_READ_MS) { _pulses.delete(id); continue; }
      const row = rowEl(id);
      if (!row) continue;
      const read = readEl(row);
      read.classList.add("no-anim", "is-on");
      read.innerHTML = readoutHtml(p.row);
    }
  }

  function pulse(rows, { delay = 60, stagger = 120 } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return;
    _busyUntil = performance.now() + delay + stagger * list.length + PULSE_SETTLE_MS;
    list.forEach((r, i) => setTimeout(() => {
      try { playPulse(r); } catch (e) { console.warn(TAG, "pulse failed", e); }
    }, delay + i * stagger));
  }

  // HP / MP / IP changed on a party member: redraw, but not over a drop that
  // is still playing.
  let _hpRedrawTimer = null;
  function onActorResourceChange(actor, change) {
    const p = change?.system?.props;
    if (!p || !(("current_hp" in p) || ("current_mp" in p) || ("current_ip" in p) || ("max_hp" in p))) return;
    if (!rowEl(actor?.id)) return;
    const wait = _busyUntil - performance.now();
    if (wait <= 0) { scheduleRender(); return; }
    clearTimeout(_hpRedrawTimer);
    _hpRedrawTimer = setTimeout(scheduleRender, wait);
  }

  // ── Row HTML builders ───────────────────────────────────────────────────────

  function renderResources(actor) {
    const p     = actor?.system?.props ?? {};
    const hpPct = getPct(p.current_hp, p.max_hp);
    const mpPct = getPct(p.current_mp, p.max_mp);
    const maxIp = Math.max(1, Number(p.max_ip) || 6);
    const curIp = parseInt(p.current_ip) || 0;

    const pips = Array.from({ length: maxIp }, (_, i) =>
      `<span class="oni-dp-hud-pip${i < curIp ? " filled" : ""}"></span>`
    ).join("");

    const hpLabel = `HP ${parseInt(p.current_hp)||0} / ${Number(p.max_hp)||0}`;
    const mpLabel = `MP ${parseInt(p.current_mp)||0} / ${Number(p.max_mp)||0}`;
    const ipLabel = `IP ${curIp} / ${maxIp}`;

    const band = hpBandClass(p.current_hp, p.max_hp);

    return `
      <div class="oni-dp-hud-resources">
        <div class="oni-dp-hud-bar-wrap is-hp" title="${hpLabel}">
          <div class="oni-dp-hud-bar-ghost" style="width:${hpPct}%"></div>
          <div class="oni-dp-hud-bar-fill oni-dp-hud-bar-hp${band}" style="width:${hpPct}%"></div>
        </div>
        <div class="oni-dp-hud-bar-wrap" title="${mpLabel}">
          <div class="oni-dp-hud-bar-fill oni-dp-hud-bar-mp" style="width:${mpPct}%"></div>
        </div>
        <div class="oni-dp-hud-pips" title="${ipLabel}">${pips}</div>
      </div>`;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  let _renderPending = false;

  function scheduleRender() {
    if (_renderPending) return;
    _renderPending = true;
    Promise.resolve().then(() => {
      _renderPending = false;
      _render().catch(e => console.warn(TAG, "render failed", e));
    });
  }

  async function _render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const members = await CampSystem?.Party?.resolve?.() ?? [];

    _effMap.clear();

    const rows = [];
    for (const { actor } of members) {
      const aes = (actor?.effects ?? []).filter(eff => {
        if (eff.disabled) return false;
        if (!hasVisibleTag(eff)) return false;
        const mode = String(eff.flags?.[FLAG_NS]?.lifetimeMode ?? "").trim().toLowerCase();
        return mode !== "on_activation";
      });

      for (const eff of aes) {
        const key = eff?.uuid ?? eff?.id;
        if (key) _effMap.set(key, eff);
      }

      rows.push({ actor, aes });
    }

    if (!rows.length) {
      panel.classList.remove("dp-hud-visible");
      hideTooltip();
      return;
    }

    // Party-level Vertigo chip. The per-member Blind icon already carries its
    // own countdown, but the two can diverge (a GM override, a partial cleanse),
    // and the darkness is what actually gates scanning and confirmation — so
    // show the authoritative counter rather than inferring it from a debuff.
    const vertigoMoves = DP.Vertigo?.movesRemaining?.() ?? 0;
    const vertigoHtml  = vertigoMoves > 0
      ? `<div class="oni-dp-hud-vertigo" title="Vertigo — vision reduced, Scan Mode locked, moves auto-confirm">
           <span>👁</span> Vertigo · ${vertigoMoves}
         </div>`
      : "";

    panel.innerHTML = vertigoHtml + rows.map(({ actor, aes }) => {
      const portrait = actor.img ?? "icons/svg/mystery-man.svg";
      const name     = actor.name ?? "?";

      const aeHtml = aes.map(eff => {
        const icon  = eff.icon ?? eff.img ?? "icons/svg/mystery-man.svg";
        const label = eff.name ?? "Effect";
        const turns = getAETurns(eff);
        const badge = globalThis.FUCompanion.AELifetime.isRestBound(eff)
          ? `<span class="oni-dp-hud-badge is-rest-bound">☀</span>`
          : turns != null ? `<span class="oni-dp-hud-badge">${turns}</span>` : "";
        const uuid  = eff?.uuid ?? eff?.id ?? "";
        return `<div class="oni-dp-hud-ae" data-eff-uuid="${uuid}">
          <img src="${icon}" alt="${label}">${badge}
        </div>`;
      }).join("");

      const aesSection = aes.length
        ? `<div class="oni-dp-hud-divider"></div><div class="oni-dp-hud-aes">${aeHtml}</div>`
        : "";

      return `
        <div class="oni-dp-hud-row" data-actor-id="${_esc(actor.id)}">
          <img class="oni-dp-hud-portrait" src="${portrait}" alt="${name}" title="${name}">
          ${renderResources(actor)}${aesSection}
        </div>`;
    }).join("");

    // Turn chip (dp-turn-start.js): one persistent node, re-attached rather
    // than redrawn so its number roll and light survive this innerHTML rebuild.
    // Sits first, above the Vertigo chip.
    const turnChip = DP.TurnStart?.chipEl?.();
    if (turnChip) panel.prepend(turnChip);

    reapplyPulses();
    panel.classList.add("dp-hud-visible");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const _hookIds = [];
  let _resizeHandler     = null;
  let _panelMoveHandler  = null;
  let _panelLeaveHandler = null;

  function _on(name, fn) { _hookIds.push([name, Hooks.on(name, fn)]); }

  function _removeHooks() {
    for (const [name, id] of _hookIds) Hooks.off(name, id);
    _hookIds.length = 0;
  }

  DP.StatusHUD = {

    show() {
      injectStyles();

      let panel = document.getElementById(PANEL_ID);
      if (!panel) {
        panel = document.createElement("div");
        panel.id = PANEL_ID;
        document.body.appendChild(panel);
      }

      _panelMoveHandler  = ev => onPanelMouseMove(ev);
      _panelLeaveHandler = ()  => onPanelMouseLeave();
      panel.addEventListener("mousemove",  _panelMoveHandler);
      panel.addEventListener("mouseleave", _panelLeaveHandler);

      setupGMFade(panel);

      _on("createActiveEffect", scheduleRender);
      _on("updateActiveEffect", scheduleRender);
      _on("deleteActiveEffect", scheduleRender);
      _on(DP.HOOKS.STANDBY_START, scheduleRender);
      // Bars used to go stale until the next effect change (a heal tile left
      // them where they were); redraw on the member's own resource changes.
      _on("updateActor", onActorResourceChange);

      _resizeHandler = () => scheduleRender();
      window.addEventListener("resize", _resizeHandler);

      scheduleRender();
      console.debug(TAG, "HUD shown.");
    },

    hide() {
      _removeHooks();
      teardownGMFade();

      if (_resizeHandler) {
        window.removeEventListener("resize", _resizeHandler);
        _resizeHandler = null;
      }

      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        if (_panelMoveHandler)  panel.removeEventListener("mousemove",  _panelMoveHandler);
        if (_panelLeaveHandler) panel.removeEventListener("mouseleave", _panelLeaveHandler);
        panel.classList.remove("dp-hud-visible");
        setTimeout(() => panel.remove(), 350);
      }
      _panelMoveHandler  = null;
      _panelLeaveHandler = null;

      hideTooltip();
      _effMap.clear();
      console.debug(TAG, "HUD hidden.");
    },

    refresh() { scheduleRender(); },

    // Damage pulse on the member rows (dp-trap-fx.js). rows: [{ actorId, before,
    // after, max, shown, dr, resisted, immune, held, crisisCross }]
    pulse,
  };

  console.debug(TAG, "Loaded.");
})();
