// ============================================================================
// Camp System — Bottom-Left Action Button
//
// Matches the visual style of the Dungeon Pathing scan/helper buttons:
// circular 64×64, dark radial gradient, gold border, bottom-left fixed.
//
// PLAYER view:
//   - Single circular button with phase emoji (🔥 / 💤 / 👣)
//   - Click toggles their ready state
//   - Glows green when they are ready
//
// GM view:
//   - No ready-up button
//   - "▶" Start button appears only when ALL active players are ready
//   - GM clicks Start → advances the phase
//
// Lobby indicator: small coloured dots above the button showing who's ready.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][Button]";

  const WRAP_ID  = "oni-camp-btn-wrap";
  const STYLE_ID = "oni-camp-btn-style";

  // SIZE / POSITION matching the DP scan button constants (dp-scan-mode.js)
  const SIZE   = 64;
  const BOTTOM = 80;
  const LEFT   = 20;

  // Phase config: which phases show the button and with what emoji
  const PHASE_CFG = {
    [CAMP.PHASE.FREE_ROAM]:     { emoji: "🔥", title: "Camp Activity — click to ready up" },
    [CAMP.PHASE.SLEEP_LOBBY]:   { emoji: "💤", title: "Sleep — click to ready up" },
    [CAMP.PHASE.SET_OUT_LOBBY]: { emoji: "👣", title: "Set Out — click to ready up" },
  };

  // ── CSS (injected once, mirrors .oni-dp-mode-btn) ─────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#oni-camp-btn-wrap {
  position: fixed;
  z-index: 99998;
  bottom: ${BOTTOM}px;
  left: ${LEFT}px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}
#oni-camp-btn-wrap.hidden { display: none !important; }

/* Lobby dots */
.oni-camp-lobby-dots {
  display: flex;
  gap: 5px;
  align-items: center;
  justify-content: center;
  min-height: 12px;
}
.oni-camp-lobby-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: rgba(255,255,255,.22);
  border: 1px solid rgba(255,255,255,.18);
  transition: background .2s ease, box-shadow .2s ease;
}
.oni-camp-lobby-dot.ready {
  background: #7ec87a;
  border-color: #5aaa55;
  box-shadow: 0 0 5px rgba(126,200,122,.7);
}

/* Shared circular button base */
.oni-camp-circle-btn {
  width:  ${SIZE}px;
  height: ${SIZE}px;
  border-radius: 50%;
  border: 2px solid rgba(200,160,80,0.65);
  background: radial-gradient(circle at 40% 35%,
    rgba(90,65,30,0.92) 0%,
    rgba(45,32,14,0.96) 100%);
  box-shadow:
    0 0 14px rgba(0,0,0,0.55),
    0 2px 6px  rgba(0,0,0,0.4),
    inset 0 1px 0 rgba(255,255,255,0.12);
  color: #e8c870;
  text-shadow: 0 0 8px rgba(0,0,0,0.9);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  transition:
    opacity   250ms cubic-bezier(.4,0,.2,1),
    transform 250ms cubic-bezier(.4,0,.2,1),
    background 180ms ease,
    box-shadow 180ms ease,
    border-color 180ms ease;

  /* entry animation */
  opacity: 0;
  transform: scale(0.6) translateY(10px);
}
.oni-camp-circle-btn.visible {
  opacity: 1;
  transform: scale(1) translateY(0);
}
.oni-camp-circle-btn:hover  { filter: brightness(1.18); }
.oni-camp-circle-btn:active { filter: brightness(0.9); transform: scale(0.94); }

/* Phase button (player) */
#oni-camp-phase-btn .btn-emoji {
  font-size: 26px;
  line-height: 1;
  margin-bottom: 1px;
}
#oni-camp-phase-btn .btn-label {
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: .5px;
  text-transform: uppercase;
  opacity: .75;
  color: #e8c870;
  font-family: "Signika","Noto Sans",system-ui,sans-serif;
}

/* Ready highlight */
#oni-camp-phase-btn.ready {
  border-color: rgba(126,200,122,0.85);
  background: radial-gradient(circle at 40% 35%,
    rgba(40,90,40,0.93) 0%,
    rgba(20,50,20,0.97) 100%);
  box-shadow:
    0 0 18px rgba(126,200,122,0.45),
    0 2px 6px rgba(0,0,0,0.4),
    inset 0 1px 0 rgba(255,255,255,0.12);
  color: #a0e896;
  text-shadow: 0 0 10px rgba(126,200,122,0.8);
}
#oni-camp-phase-btn.ready .btn-label { color: #a0e896; }

/* GM Start button */
#oni-camp-start-btn {
  border-color: rgba(202,164,77,0.9);
  animation: campGMPulse 1.6s ease infinite;
}
#oni-camp-start-btn .btn-emoji { font-size: 28px; }
#oni-camp-start-btn .btn-label { color: #f4d488; }

@keyframes campGMPulse {
  0%, 100% { box-shadow: 0 0 14px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12); }
  50%       { box-shadow: 0 0 22px rgba(244,212,136,0.5), 0 2px 6px rgba(0,0,0,0.4), 0 0 40px rgba(244,212,136,0.2), inset 0 1px 0 rgba(255,255,255,0.12); }
}
    `;
    document.head.appendChild(s);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  CAMP.Button = {
    show() {
      ensureStyle();
      let wrap = document.getElementById(WRAP_ID);
      if (!wrap) wrap = _build();
      wrap.classList.remove("hidden");
      // Trigger entry animation next frame
      requestAnimationFrame(() => {
        wrap.querySelectorAll(".oni-camp-circle-btn").forEach(b => b.classList.add("visible"));
      });
      this.render();
    },

    hide() {
      const wrap = document.getElementById(WRAP_ID);
      if (!wrap) return;
      wrap.classList.add("hidden");
    },

    async render() {
      const wrap = document.getElementById(WRAP_ID);
      if (!wrap) return;

      const phase    = CAMP.State.getPhase();
      const cfg      = PHASE_CFG[phase];
      const isGM     = game.user?.isGM;

      if (!cfg) { this.hide(); return; }

      const userId   = game.user?.id;
      const readyMap = _getReadyMap(phase);

      // allReady: no players online = GM solo test, treat as all-ready
      const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
      const allReady    = activeUsers.length === 0 || activeUsers.every(u => readyMap[u.id]);
      const iAmReady    = !!readyMap[userId];

      // Party resolution is best-effort (dots only); fall back to active users
      const party = await CAMP.Party.resolve().catch(() => []);

      wrap.classList.remove("hidden");

      const phaseBtn = wrap.querySelector("#oni-camp-phase-btn");
      const startBtn = wrap.querySelector("#oni-camp-start-btn");
      const dotsEl   = wrap.querySelector(".oni-camp-lobby-dots");

      if (isGM) {
        // GM: hide player button, show Start only when all ready
        if (phaseBtn) phaseBtn.style.display = "none";
        if (startBtn) {
          const show = allReady;
          startBtn.style.display = show ? "" : "none";
          if (show) {
            startBtn.classList.add("visible");
          }
        }
      } else {
        // Player: show phase button, hide Start
        if (phaseBtn) {
          phaseBtn.style.display = "";
          phaseBtn.querySelector(".btn-emoji").textContent = cfg.emoji;
          phaseBtn.title = cfg.title;
          phaseBtn.classList.toggle("ready", iAmReady);
        }
        if (startBtn) startBtn.style.display = "none";
      }

      // Lobby dots: party members if resolved, otherwise all active non-GM users
      if (dotsEl) {
        const dotList = party.length > 0
          ? party
          : activeUsers.map(u => ({ userId: u.id, userName: u.name }));
        dotsEl.innerHTML = dotList.map(({ userId: uid, userName }) => {
          const r = !!readyMap[uid];
          return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${userName}"></div>`;
        }).join("");
      }
    },

    // Player clicked their phase button
    async onClick() {
      const phase  = CAMP.State.getPhase();
      const userId = game.user?.id;
      let msg;
      switch (phase) {
        case CAMP.PHASE.FREE_ROAM:     msg = CAMP.MSG.TOGGLE_READY;    break;
        case CAMP.PHASE.SLEEP_LOBBY:   msg = CAMP.MSG.TOGGLE_SLEEP;    break;
        case CAMP.PHASE.SET_OUT_LOBBY: msg = CAMP.MSG.TOGGLE_SET_OUT;  break;
        default: return;
      }
      CAMP.Socket.emit(msg, { userId });
      // Optimistic local re-render while waiting for setting update
      await this.render();
    },

    // GM clicked the Start button
    async onGMStart() {
      if (!game.user?.isGM) return;
      const phase = CAMP.State.getPhase();
      switch (phase) {
        case CAMP.PHASE.FREE_ROAM:
          await CAMP.State.clearReady();
          await CAMP.State.setPhase(CAMP.PHASE.ACTIVITY_SELECT);
          break;
        case CAMP.PHASE.SLEEP_LOBBY:
          await CAMP.State.clearSleepReady();
          await CAMP.State.setPhase(CAMP.PHASE.SLEEPING);
          break;
        case CAMP.PHASE.SET_OUT_LOBBY:
          await CAMP.State.clearSetOutReady();
          await CAMP.State.reset();   // resets to FREE_ROAM
          break;
      }
    },
  };

  // ── DOM builder ─────────────────────────────────────────────────────────────
  function _build() {
    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;

    wrap.innerHTML = `
      <div class="oni-camp-lobby-dots"></div>

      <button id="oni-camp-phase-btn" class="oni-camp-circle-btn" style="display:none;">
        <span class="btn-emoji">🔥</span>
        <span class="btn-label">Camp</span>
      </button>

      <button id="oni-camp-start-btn" class="oni-camp-circle-btn" style="display:none;" title="All players ready — click to start!">
        <span class="btn-emoji">▶</span>
        <span class="btn-label">Start</span>
      </button>
    `;

    wrap.querySelector("#oni-camp-phase-btn")?.addEventListener("click", () => CAMP.Button.onClick());
    wrap.querySelector("#oni-camp-start-btn")?.addEventListener("click",  () => CAMP.Button.onGMStart());

    document.body.appendChild(wrap);
    return wrap;
  }

  function _getReadyMap(phase) {
    switch (phase) {
      case CAMP.PHASE.FREE_ROAM:     return CAMP.State.getReady();
      case CAMP.PHASE.SLEEP_LOBBY:   return CAMP.State.getSleepReady();
      case CAMP.PHASE.SET_OUT_LOBBY: return CAMP.State.getSetOutReady();
      default: return {};
    }
  }

  console.debug(TAG, "Button module loaded.");
})();
