// ============================================================================
// Dungeon Pathing System — Party Status HUD
//
// Compact top-left overlay showing active per-turn effects on every party
// member during dungeon exploration.  Visible to all clients.
//
// Layout (one row per member that has active AEs):
//   [portrait] [icon₁ badge] [icon₂ badge] …
//
// Stays hidden when no party member has any ticking AE.
// Re-renders automatically whenever any actor's ActiveEffect changes
// (Foundry broadcasts createActiveEffect / updateActiveEffect /
// deleteActiveEffect to all clients after the GM write).
// ============================================================================
(() => {
  const DP      = globalThis.DungeonPathing ??= {};
  const FLAG_NS = "fabula-ultima-companion";
  const TAG     = "[DungeonPathing][StatusHUD]";
  const PANEL_ID = "oni-dp-status-hud";
  const STYLE_ID = "oni-dp-status-hud-styles";

  // ── Stylesheet ─────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
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
  transform: translateX(-6px);
  transition: opacity 280ms cubic-bezier(.4,0,.2,1),
              transform 280ms cubic-bezier(.4,0,.2,1);
}
#oni-dp-status-hud.dp-hud-visible {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}

.oni-dp-hud-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 4px;
  border-radius: 7px;
  border: 1px solid rgba(200,160,80,0.35);
  background: rgba(18,12,6,0.84);
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.45);
}

.oni-dp-hud-portrait {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(200,160,80,0.55);
  flex-shrink: 0;
  background: rgba(40,28,14,0.9);
}

.oni-dp-hud-divider {
  width: 1px;
  height: 20px;
  background: rgba(200,160,80,0.2);
  flex-shrink: 0;
}

.oni-dp-hud-aes {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  align-items: center;
}

.oni-dp-hud-ae {
  position: relative;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  cursor: default;
}

.oni-dp-hud-ae img {
  width: 100%;
  height: 100%;
  border-radius: 4px;
  object-fit: cover;
  display: block;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.7));
}

.oni-dp-hud-badge {
  position: absolute;
  bottom: -2px;
  right: -3px;
  background: rgba(12,8,4,0.96);
  border: 1px solid rgba(200,160,80,0.65);
  color: #e8c870;
  font-family: var(--font-primary, sans-serif);
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  min-width: 11px;
  height: 11px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  padding: 0 1px;
}
    `;
    document.head.appendChild(s);
  }

  // ── AE data helpers ─────────────────────────────────────────────────────────

  function getDungeonAEs(actor) {
    const result = [];
    for (const eff of actor?.effects ?? []) {
      if (eff.disabled) continue;
      const flags = eff.flags?.[FLAG_NS] ?? {};
      if (flags.directorPermanent === true) continue;
      const mode = String(flags.lifetimeMode ?? "").trim().toLowerCase();
      if (mode === "on_activation" || mode === "round_end") continue;

      // Resolve turns remaining (mirrors tickAEsOnActor logic)
      const stamp = flags.directorAppliedBy;
      let turns;
      if (stamp && stamp.turnsRemaining != null) {
        turns = Number(stamp.turnsRemaining);
      } else if (flags.dungeonTurnsRemaining != null) {
        turns = Number(flags.dungeonTurnsRemaining);
      } else {
        const explicit = Number(eff.duration?.rounds);
        turns = (Number.isFinite(explicit) && explicit > 0) ? explicit : 3;
      }

      result.push({ eff, turns });
    }
    return result;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  let _renderPending = false;

  function scheduleRender() {
    if (_renderPending) return;
    _renderPending = true;
    // Defer one microtask so batched AE updates (updateEmbeddedDocuments) only
    // trigger a single re-render instead of one per updated AE.
    Promise.resolve().then(() => {
      _renderPending = false;
      _render().catch(e => console.warn(TAG, "render failed", e));
    });
  }

  async function _render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const members = await CampSystem?.Party?.resolve?.() ?? [];

    // Build rows — collect members that have ticking AEs
    const rows = [];
    for (const { actor } of members) {
      const aes = getDungeonAEs(actor);
      if (aes.length) rows.push({ actor, aes });
    }

    if (!rows.length) {
      panel.classList.remove("dp-hud-visible");
      return;
    }

    panel.innerHTML = rows.map(({ actor, aes }) => {
      const portrait  = actor.img ?? "icons/svg/mystery-man.svg";
      const actorName = actor.name ?? "?";

      const aeHtml = aes.map(({ eff, turns }) => {
        const icon    = eff.icon ?? "icons/svg/mystery-man.svg";
        const tooltip = `${eff.name} — ${turns} turn${turns !== 1 ? "s" : ""} left`;
        return `
          <div class="oni-dp-hud-ae" title="${tooltip}">
            <img src="${icon}" alt="${eff.name}">
            <span class="oni-dp-hud-badge">${turns}</span>
          </div>`;
      }).join("");

      return `
        <div class="oni-dp-hud-row">
          <img class="oni-dp-hud-portrait" src="${portrait}" alt="${actorName}" title="${actorName}">
          <div class="oni-dp-hud-divider"></div>
          <div class="oni-dp-hud-aes">${aeHtml}</div>
        </div>`;
    }).join("");

    panel.classList.add("dp-hud-visible");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const _hookIds = [];   // [hookName, hookId]

  function _on(name, fn) {
    _hookIds.push([name, Hooks.on(name, fn)]);
  }

  function _removeHooks() {
    for (const [name, id] of _hookIds) Hooks.off(name, id);
    _hookIds.length = 0;
  }

  DP.StatusHUD = {

    show() {
      injectStyles();

      // Create panel if missing
      if (!document.getElementById(PANEL_ID)) {
        const el = document.createElement("div");
        el.id = PANEL_ID;
        document.body.appendChild(el);
      }

      // Re-render whenever AEs change — Foundry broadcasts these to all clients
      _on("createActiveEffect", scheduleRender);
      _on("updateActiveEffect", scheduleRender);
      _on("deleteActiveEffect", scheduleRender);

      // Also refresh at standbyStart (after each turn's tick + rebuild settles)
      _on(DP.HOOKS.STANDBY_START, scheduleRender);

      scheduleRender();
      console.debug(TAG, "HUD shown.");
    },

    hide() {
      _removeHooks();
      const el = document.getElementById(PANEL_ID);
      if (el) {
        el.classList.remove("dp-hud-visible");
        // Remove from DOM after transition
        setTimeout(() => el.remove(), 350);
      }
      console.debug(TAG, "HUD hidden.");
    },

    refresh() { scheduleRender(); },
  };

  console.debug(TAG, "Loaded.");
})();
