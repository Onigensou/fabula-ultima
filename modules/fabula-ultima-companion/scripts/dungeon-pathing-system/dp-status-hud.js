// ============================================================================
// Dungeon Pathing System — Party Status HUD
//
// Compact overlay showing party status during dungeon exploration.
//
// Filtering: only AEs whose system.tags array contains at least one of
//   VISIBLE_TAGS ("debuff", "buff", "dungeon", "food").
//   Charge-governed AEs (lifetimeMode "on_activation") are excluded since
//   they are consumed per-fire, not tracked turn-by-turn.
//
// Each member row:
//   [portrait] | [AE icons with turn badge] | [HP bar] [MP bar] [IP pips]
//
// Positioning: top-left for players; right-offset on GM clients to clear
//   Foundry's scene-controls toolbar on the left side.
//
// Refresh: piggybacks on Foundry's ActiveEffect document hooks which broadcast
//   to all clients after any GM write — no extra socket needed.
// ============================================================================
(() => {
  const DP      = globalThis.DungeonPathing ??= {};
  const FLAG_NS = "fabula-ultima-companion";
  const TAG     = "[DungeonPathing][StatusHUD]";
  const PANEL_ID = "oni-dp-status-hud";
  const STYLE_ID = "oni-dp-status-hud-styles";

  // Tags that opt an AE into the HUD display.
  const VISIBLE_TAGS = new Set(["debuff", "buff", "dungeon", "food"]);

  // ── Stylesheet ─────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
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
    transform 280ms cubic-bezier(.4,0,.2,1),
    left 200ms ease;
}
#oni-dp-status-hud.dp-hud-visible {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}

/* ── Row ── */
.oni-dp-hud-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px 5px 5px;
  border-radius: 8px;
  border: 1px solid rgba(200,160,80,0.32);
  background: rgba(16,11,5,0.86);
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 10px rgba(0,0,0,0.5);
}

/* ── Portrait ── */
.oni-dp-hud-portrait {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(200,160,80,0.5);
  flex-shrink: 0;
  background: rgba(40,28,14,0.9);
}

/* ── Divider ── */
.oni-dp-hud-divider {
  width: 1px;
  align-self: stretch;
  background: rgba(200,160,80,0.18);
  flex-shrink: 0;
  margin: 2px 0;
}

/* ── AE icons ── */
.oni-dp-hud-aes {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  align-items: center;
  min-width: 28px;
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

/* ── Resources ── */
.oni-dp-hud-res {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex-shrink: 0;
}

.oni-dp-hud-bar-wrap {
  width: 44px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255,255,255,0.08);
  overflow: hidden;
  flex-shrink: 0;
}

.oni-dp-hud-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 300ms ease;
}

.oni-dp-hud-bar-hp { background: linear-gradient(90deg, #a33, #e55); }
.oni-dp-hud-bar-mp { background: linear-gradient(90deg, #338, #56c); }

.oni-dp-hud-pips {
  display: flex;
  gap: 2px;
  align-items: center;
  height: 4px;
}

.oni-dp-hud-pip {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255,255,255,0.12);
  flex-shrink: 0;
  border: 1px solid rgba(200,160,80,0.3);
  transition: background 250ms ease;
}

.oni-dp-hud-pip.filled {
  background: #c8a050;
  border-color: rgba(200,160,80,0.7);
}
    `;
    document.head.appendChild(s);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function hasVisibleTag(eff) {
    const tags = eff?.system?.tags;
    if (!Array.isArray(tags)) return false;
    return tags.some(t => VISIBLE_TAGS.has(String(t).toLowerCase().trim()));
  }

  function getAETurns(eff) {
    const flags = eff?.flags?.[FLAG_NS] ?? {};
    // Charge-governed — excluded at filter stage, but guard here too.
    const mode = String(flags.lifetimeMode ?? "").trim().toLowerCase();
    if (mode === "on_activation") return null;
    // Permanent or round-end — no meaningful per-turn count.
    if (flags.directorPermanent === true || mode === "round_end") return null;

    const stamp = flags.directorAppliedBy;
    if (stamp && stamp.turnsRemaining != null) return Number(stamp.turnsRemaining);
    if (flags.dungeonTurnsRemaining != null) return Number(flags.dungeonTurnsRemaining);
    const explicit = Number(eff.duration?.rounds);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return null;  // tagged but no turn count — show icon only
  }

  function getPct(current, max) {
    const c = parseInt(current) || 0;
    const m = Number(max) || 1;
    return Math.min(100, Math.max(0, Math.round((c / m) * 100)));
  }

  function renderResourceBars(actor) {
    const p = actor?.system?.props ?? {};
    const hpPct = getPct(p.current_hp, p.max_hp);
    const mpPct = getPct(p.current_mp, p.max_mp);

    const maxIp  = Math.min(Math.max(1, Number(p.max_ip) || 6), 8);
    const curIp  = parseInt(p.current_ip) || 0;
    const pipHtml = Array.from({ length: maxIp }, (_, i) =>
      `<span class="oni-dp-hud-pip${i < curIp ? " filled" : ""}"></span>`
    ).join("");

    const hpLabel = `HP ${parseInt(p.current_hp)||0}/${Number(p.max_hp)||0}`;
    const mpLabel = `MP ${parseInt(p.current_mp)||0}/${Number(p.max_mp)||0}`;
    const ipLabel = `IP ${curIp}/${maxIp}`;

    return `
      <div class="oni-dp-hud-res">
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
    const ctrl = document.querySelector("#controls");
    if (ctrl && ctrl.offsetWidth > 20) return ctrl.offsetWidth + 8;
    // Foundry v12 alternate selectors
    const alt = document.querySelector(".controls-panel, #scene-controls, #ui-controls");
    if (alt && alt.offsetWidth > 20) return alt.offsetWidth + 8;
    // Player clients have no left toolbar; GM fallback ~76px
    return game.user?.isGM ? 78 : 10;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  let _renderPending = false;

  function scheduleRender() {
    if (_renderPending) return;
    _renderPending = true;
    // Defer one microtask — batched AE writes (4-member tick) coalesce to one redraw.
    Promise.resolve().then(() => {
      _renderPending = false;
      _render().catch(e => console.warn(TAG, "render failed", e));
    });
  }

  async function _render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    // Sync left offset each render so the HUD adjusts if the toolbar loads late.
    panel.style.setProperty("--dp-hud-left", computeLeftPx() + "px");

    const members = await CampSystem?.Party?.resolve?.() ?? [];

    // Build rows: members who have at least one tagged, non-charge AE.
    const rows = [];
    for (const { actor } of members) {
      const aes = (actor?.effects ?? []).filter(eff => {
        if (eff.disabled) return false;
        if (!hasVisibleTag(eff)) return false;
        const mode = String(eff.flags?.[FLAG_NS]?.lifetimeMode ?? "").trim().toLowerCase();
        if (mode === "on_activation") return false;
        return true;
      });
      if (aes.length) rows.push({ actor, aes });
    }

    if (!rows.length) {
      panel.classList.remove("dp-hud-visible");
      return;
    }

    panel.innerHTML = rows.map(({ actor, aes }) => {
      const portrait  = actor.img ?? "icons/svg/mystery-man.svg";
      const actorName = actor.name ?? "?";

      const aeHtml = aes.map(eff => {
        const icon    = eff.icon ?? "icons/svg/mystery-man.svg";
        const turns   = getAETurns(eff);
        const badge   = turns != null ? `<span class="oni-dp-hud-badge">${turns}</span>` : "";
        const tooltip = turns != null
          ? `${eff.name} — ${turns} turn${turns !== 1 ? "s" : ""} left`
          : eff.name;
        return `
          <div class="oni-dp-hud-ae" title="${tooltip}">
            <img src="${icon}" alt="${eff.name}">${badge}
          </div>`;
      }).join("");

      return `
        <div class="oni-dp-hud-row">
          <img class="oni-dp-hud-portrait" src="${portrait}" alt="${actorName}" title="${actorName}">
          <div class="oni-dp-hud-divider"></div>
          <div class="oni-dp-hud-aes">${aeHtml}</div>
          <div class="oni-dp-hud-divider"></div>
          ${renderResourceBars(actor)}
        </div>`;
    }).join("");

    panel.classList.add("dp-hud-visible");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const _hookIds = [];   // [[hookName, hookId], …]

  function _on(name, fn) { _hookIds.push([name, Hooks.on(name, fn)]); }

  function _removeHooks() {
    for (const [name, id] of _hookIds) {
      if (name === "__resize__") continue;  // handled separately in hide()
      Hooks.off(name, id);
    }
    _hookIds.length = 0;
  }

  DP.StatusHUD = {

    show() {
      injectStyles();

      if (!document.getElementById(PANEL_ID)) {
        const el = document.createElement("div");
        el.id = PANEL_ID;
        document.body.appendChild(el);
      }

      // Foundry broadcasts these hooks to all clients after any GM AE write.
      _on("createActiveEffect", scheduleRender);
      _on("updateActiveEffect", scheduleRender);
      _on("deleteActiveEffect", scheduleRender);

      // Also refresh after each turn's tick + rebuild settles.
      _on(DP.HOOKS.STANDBY_START, scheduleRender);

      // Re-sync left position when window resizes (toolbar might reflow).
      const onResize = () => scheduleRender();
      window.addEventListener("resize", onResize);
      _hookIds.push(["__resize__", onResize]);  // stored so hide() can remove it

      scheduleRender();
      console.debug(TAG, "HUD shown.");
    },

    hide() {
      // Remove resize listener separately — it's not a Foundry hook.
      const resizeEntry = _hookIds.find(([n]) => n === "__resize__");
      if (resizeEntry) window.removeEventListener("resize", resizeEntry[1]);

      _removeHooks();
      const el = document.getElementById(PANEL_ID);
      if (el) {
        el.classList.remove("dp-hud-visible");
        setTimeout(() => el.remove(), 350);
      }
      console.debug(TAG, "HUD hidden.");
    },

    refresh() { scheduleRender(); },
  };

  console.debug(TAG, "Loaded.");
})();
