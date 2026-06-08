// ============================================================================
// Dungeon Pathing System — Party Status HUD
//
// Compact overlay showing party status during dungeon exploration.
//
// Layout per row:
//   LEFT column  — portrait (top) + HP / MP bars + IP pips (below)
//   RIGHT column — AE icons grid with turn-count badge
//
// Hovering an AE icon shows a tooltip with the effect's description,
// resolved using the same priority chain as active-effect-tooltip.js:
//   effect.description → system.description → flags → origin item → changes.
//
// Filtering: only AEs whose system.tags array contains at least one of
//   VISIBLE_TAGS ("debuff", "buff", "dungeon", "food").
//   Charge-governed AEs (lifetimeMode "on_activation") are excluded.
//
// Positioning: top-left for players; right-offset on GM clients to clear
//   Foundry's scene-controls toolbar on the left side.
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
  left: var(--dp-hud-left, 10px);
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

/* ── Row ── */
.oni-dp-hud-row {
  display: flex;
  align-items: stretch;
  padding: 6px 8px 6px 6px;
  border-radius: 8px;
  border: 1px solid rgba(200,160,80,0.30);
  background: rgba(16,11,5,0.87);
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 10px rgba(0,0,0,0.5);
}

/* ── Left column: portrait + resource bars ── */
.oni-dp-hud-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 44px;
  flex-shrink: 0;
}

.oni-dp-hud-portrait {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(200,160,80,0.5);
  background: rgba(40,28,14,0.9);
  flex-shrink: 0;
}

.oni-dp-hud-bar-wrap {
  width: 38px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
  flex-shrink: 0;
}

.oni-dp-hud-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 350ms ease;
}

.oni-dp-hud-bar-hp { background: linear-gradient(90deg, #2a6, #4d4); }
.oni-dp-hud-bar-mp { background: linear-gradient(90deg, #338, #56c); }

.oni-dp-hud-pips {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
  justify-content: center;
  width: 38px;
}

.oni-dp-hud-pip {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255,255,255,0.10);
  border: 1px solid rgba(200,160,80,0.25);
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
  margin: 0 7px;
}

/* ── Right column: AE icons ── */
.oni-dp-hud-aes {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  align-content: flex-start;
  align-items: flex-start;
  min-width: 28px;
  padding: 2px 0;
}

.oni-dp-hud-ae {
  position: relative;
  width: 28px;
  height: 28px;
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
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  min-width: 13px;
  height: 13px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  padding: 0 2px;
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

  // ── Tooltip ─────────────────────────────────────────────────────────────────

  // Map uuid → AE document, populated during each render.
  const _effMap = new Map();
  // Description cache uuid → resolved string (survives re-renders).
  const _descCache = new Map();

  let _tooltipEl = null;
  let _tooltipTarget = null;  // current .oni-dp-hud-ae element

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
    const el = getTooltipEl();
    const pad = 12;
    let left = clientX + 16;
    let top  = clientY + 14;
    // Force a layout pass to get real dimensions before clamping.
    el.style.display = "block";
    const { width, height } = el.getBoundingClientRect();
    if (left + width + pad > window.innerWidth)  left = clientX - width - 16;
    if (top  + height + pad > window.innerHeight) top  = clientY - height - 14;
    el.style.left = `${Math.max(pad, left)}px`;
    el.style.top  = `${Math.max(pad, top)}px`;
  }

  // Replicates the description resolution from active-effect-tooltip.js.
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

    // Fallback: origin item description
    if (!desc && eff?.origin) {
      try {
        const origin = await fromUuid(eff.origin);
        let od = origin?.system?.description ?? origin?.description ?? "";
        if (typeof od === "object" && od !== null) od = od.value ?? "";
        if (typeof od === "string" && od.trim()) desc = od.trim();
      } catch {}
    }

    // Final fallback: changes list
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
    const el = getTooltipEl();

    const icon  = eff.icon ?? eff.img ?? "";
    const name  = eff.name ?? "Unnamed Effect";
    const turns = getAETurns(eff);
    const turnsHtml = turns != null
      ? `<div class="oni-dp-hud-tt-turns">${turns} turn${turns !== 1 ? "s" : ""} remaining</div>`
      : "";

    // Render with a placeholder while description resolves async.
    el.innerHTML = `
      <div class="oni-dp-hud-tt-header">
        <img class="oni-dp-hud-tt-icon" src="${icon}" alt="${name}">
        <span class="oni-dp-hud-tt-name">${name}</span>
      </div>
      ${turnsHtml}
      <div class="oni-dp-hud-tt-desc">…</div>`;

    positionTooltip(clientX, clientY);

    // Resolve description and update in-place.
    const desc = await resolveDescription(eff);
    // Guard: user may have moved off the icon by the time this resolves.
    if (_tooltipTarget !== aeEl) return;
    const descEl = el.querySelector(".oni-dp-hud-tt-desc");
    if (descEl) descEl.innerHTML = desc;
  }

  // ── Event delegation on the panel ──────────────────────────────────────────

  function onPanelMouseMove(ev) {
    const aeEl = ev.target.closest(".oni-dp-hud-ae");
    if (!aeEl) {
      if (!ev.target.closest(`#${TOOLTIP_ID}`)) hideTooltip();
      return;
    }
    if (aeEl === _tooltipTarget) {
      // Tooltip already shown; just reposition.
      if (_tooltipEl?.style.display !== "none") positionTooltip(ev.clientX, ev.clientY);
      return;
    }
    showTooltip(aeEl, ev.clientX, ev.clientY).catch(() => {});
  }

  function onPanelMouseLeave() {
    hideTooltip();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function hasVisibleTag(eff) {
    const tags = eff?.system?.tags;
    if (!Array.isArray(tags)) return false;
    return tags.some(t => VISIBLE_TAGS.has(String(t).toLowerCase().trim()));
  }

  function getAETurns(eff) {
    const flags = eff?.flags?.[FLAG_NS] ?? {};
    const mode  = String(flags.lifetimeMode ?? "").trim().toLowerCase();
    if (mode === "on_activation") return null;
    if (flags.directorPermanent === true || mode === "round_end") return null;
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

  function renderLeft(actor) {
    const p    = actor?.system?.props ?? {};
    const hpPct = getPct(p.current_hp, p.max_hp);
    const mpPct = getPct(p.current_mp, p.max_mp);
    const maxIp  = Math.max(1, Number(p.max_ip) || 6);
    const curIp  = parseInt(p.current_ip) || 0;

    const pipHtml = Array.from({ length: maxIp }, (_, i) =>
      `<span class="oni-dp-hud-pip${i < curIp ? " filled" : ""}"></span>`
    ).join("");

    const portrait  = actor.img ?? "icons/svg/mystery-man.svg";
    const actorName = actor.name ?? "?";
    const hpLabel   = `HP ${parseInt(p.current_hp)||0} / ${Number(p.max_hp)||0}`;
    const mpLabel   = `MP ${parseInt(p.current_mp)||0} / ${Number(p.max_mp)||0}`;
    const ipLabel   = `IP ${curIp} / ${maxIp}`;

    return `
      <div class="oni-dp-hud-left">
        <img class="oni-dp-hud-portrait" src="${portrait}" alt="${actorName}" title="${actorName}">
        <div class="oni-dp-hud-bar-wrap" title="${hpLabel}">
          <div class="oni-dp-hud-bar-fill oni-dp-hud-bar-hp" style="width:${hpPct}%"></div>
        </div>
        <div class="oni-dp-hud-bar-wrap" title="${mpLabel}">
          <div class="oni-dp-hud-bar-fill oni-dp-hud-bar-mp" style="width:${mpPct}%"></div>
        </div>
        <div class="oni-dp-hud-pips" title="${ipLabel}">${pipHtml}</div>
      </div>`;
  }

  // ── Left offset — clears GM toolbar ─────────────────────────────────────────

  function computeLeftPx() {
    const ctrl = document.querySelector("#controls, .controls-panel, #scene-controls, #ui-controls");
    if (ctrl && ctrl.offsetWidth > 20) return ctrl.offsetWidth + 8;
    return game.user?.isGM ? 78 : 10;
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

    panel.style.setProperty("--dp-hud-left", computeLeftPx() + "px");

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

      // Register all visible AEs in the map for tooltip lookup.
      for (const eff of aes) {
        const key = eff?.uuid ?? eff?.id;
        if (key) _effMap.set(key, eff);
      }

      if (aes.length) rows.push({ actor, aes });
    }

    if (!rows.length) {
      panel.classList.remove("dp-hud-visible");
      hideTooltip();
      return;
    }

    panel.innerHTML = rows.map(({ actor, aes }) => {
      const aeHtml = aes.map(eff => {
        const icon  = eff.icon ?? eff.img ?? "icons/svg/mystery-man.svg";
        const name  = eff.name ?? "Effect";
        const turns = getAETurns(eff);
        const badge = turns != null ? `<span class="oni-dp-hud-badge">${turns}</span>` : "";
        const uuid  = eff?.uuid ?? eff?.id ?? "";
        return `
          <div class="oni-dp-hud-ae" data-eff-uuid="${uuid}">
            <img src="${icon}" alt="${name}">${badge}
          </div>`;
      }).join("");

      return `
        <div class="oni-dp-hud-row">
          ${renderLeft(actor)}
          <div class="oni-dp-hud-divider"></div>
          <div class="oni-dp-hud-aes">${aeHtml}</div>
        </div>`;
    }).join("");

    panel.classList.add("dp-hud-visible");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const _hookIds = [];
  let _resizeHandler = null;
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

      // Event delegation for AE tooltips.
      _panelMoveHandler  = ev => onPanelMouseMove(ev);
      _panelLeaveHandler = ()  => onPanelMouseLeave();
      panel.addEventListener("mousemove",  _panelMoveHandler);
      panel.addEventListener("mouseleave", _panelLeaveHandler);

      // Foundry broadcasts AE doc hooks to all clients after GM writes.
      _on("createActiveEffect", scheduleRender);
      _on("updateActiveEffect", scheduleRender);
      _on("deleteActiveEffect", scheduleRender);
      _on(DP.HOOKS.STANDBY_START, scheduleRender);

      _resizeHandler = () => scheduleRender();
      window.addEventListener("resize", _resizeHandler);

      scheduleRender();
      console.debug(TAG, "HUD shown.");
    },

    hide() {
      _removeHooks();

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
  };

  console.debug(TAG, "Loaded.");
})();
