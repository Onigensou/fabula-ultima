// ============================================================================
// Camp System — Persistent GM Control Panel
//
// A small floating panel (bottom-right) visible only to the GM.
// Always rendered above overlays (z-index 99999) so GM can never get stuck.
// Shows current phase and Prev / Next navigation buttons.
// ============================================================================
(() => {
  const CAMP     = globalThis.CampSystem ??= {};
  const TAG      = "[CampSystem][GMPanel]";
  const ID       = "oni-camp-gm-panel";
  const STYLE_ID = "oni-camp-gm-panel-style";

  const PHASE_LABELS = {
    [CAMP.PHASE.FREE_ROAM]:        "🔥 Free Roam",
    [CAMP.PHASE.ACTIVITY_SELECT]:  "📋 Activity Select",
    [CAMP.PHASE.ACTIVITY_RESOLVE]: "⚙️ Activity Resolve",
    [CAMP.PHASE.BOND_UPDATE]:      "💛 Bond Update",
    [CAMP.PHASE.BOND_SUMMARY]:     "📜 Bond Summary",
    [CAMP.PHASE.SLEEP_LOBBY]:      "💤 Sleep Lobby",
    [CAMP.PHASE.SLEEPING]:         "🌙 Sleeping",
    [CAMP.PHASE.REST_SAVE_PROMPT]: "💾 Save Prompt",
    [CAMP.PHASE.REST_SAVING]:      "💾 Saving",
    [CAMP.PHASE.REST_TITLE_PROMPT]:"🏛 Title Prompt",
    [CAMP.PHASE.SET_OUT_LOBBY]:    "👣 Set Out Lobby",
  };

  const PHASE_ORDER = [
    CAMP.PHASE.FREE_ROAM,
    CAMP.PHASE.ACTIVITY_SELECT,
    CAMP.PHASE.ACTIVITY_RESOLVE,
    CAMP.PHASE.BOND_UPDATE,
    CAMP.PHASE.BOND_SUMMARY,
    CAMP.PHASE.SLEEP_LOBBY,
    CAMP.PHASE.SLEEPING,
    CAMP.PHASE.REST_SAVE_PROMPT,
    CAMP.PHASE.REST_SAVING,
    CAMP.PHASE.REST_TITLE_PROMPT,
    CAMP.PHASE.SET_OUT_LOBBY,
  ];

  CAMP.GMPanel = {
    show() {
      if (!game.user?.isGM) return;
      _ensureStyle();
      let el = document.getElementById(ID);
      if (!el) el = _build();
      el.classList.remove("hidden");
      this.render();
    },

    hide() {
      const el = document.getElementById(ID);
      if (el) el.classList.add("hidden");
    },

    render() {
      if (!game.user?.isGM) return;
      const el = document.getElementById(ID);
      if (!el) return;
      const phase = CAMP.State.getPhase();
      const idx   = PHASE_ORDER.indexOf(phase);

      const phaseEl = el.querySelector(".gm-panel-phase");
      if (phaseEl) phaseEl.textContent = PHASE_LABELS[phase] ?? phase;

      const prevBtn = el.querySelector("#oni-camp-gm-prev");
      if (prevBtn) prevBtn.disabled = idx <= 0;

      const nextBtn = el.querySelector("#oni-camp-gm-next");
      if (nextBtn) nextBtn.disabled = idx >= PHASE_ORDER.length - 1;
    },
  };

  // ---------------------------------------------------------------------------

  function _build() {
    const el = document.createElement("div");
    el.id = ID;
    el.innerHTML = `
      <span class="gm-panel-badge">GM</span>
      <button class="gm-panel-arrow" id="oni-camp-gm-prev" title="Previous Phase">◀</button>
      <span class="gm-panel-phase">—</span>
      <button class="gm-panel-arrow" id="oni-camp-gm-next" title="Force Next Phase">▶</button>
    `;

    el.querySelector("#oni-camp-gm-prev")?.addEventListener("click", async () => {
      const cur = CAMP.State.getPhase();
      const idx = PHASE_ORDER.indexOf(cur);
      if (idx > 0) await CAMP.State.setPhase(PHASE_ORDER[idx - 1]);
    });

    el.querySelector("#oni-camp-gm-next")?.addEventListener("click", async () => {
      const cur = CAMP.State.getPhase();
      const idx = PHASE_ORDER.indexOf(cur);
      if (idx < PHASE_ORDER.length - 1) {
        await CAMP.State.setPhase(PHASE_ORDER[idx + 1]);
      }
    });

    document.body.appendChild(el);
    return el;
  }

  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#oni-camp-gm-panel {
  position: fixed;
  bottom: 80px;
  right: 20px;
  z-index: 99999;        /* above all overlays */
  display: flex;
  align-items: center;
  gap: 5px;
  background: rgba(22,14,6,0.92);
  border: 1px solid rgba(180,120,40,0.65);
  border-radius: 10px;
  padding: 5px 10px;
  pointer-events: auto;
  box-shadow: 0 2px 10px rgba(0,0,0,0.55);
  font-family: "Signika","Noto Sans",system-ui,sans-serif;
}
#oni-camp-gm-panel.hidden { display: none !important; }

.gm-panel-badge {
  font-size: .62em;
  font-weight: 800;
  letter-spacing: .8px;
  text-transform: uppercase;
  color: rgba(200,140,50,.9);
  background: rgba(180,120,40,.18);
  border: 1px solid rgba(180,120,40,.35);
  border-radius: 4px;
  padding: 1px 5px;
  margin-right: 2px;
  line-height: 1.4;
}
.gm-panel-phase {
  font-size: .78em;
  color: #e8c870;
  white-space: nowrap;
  min-width: 120px;
  text-align: center;
}
.gm-panel-arrow {
  appearance: none;
  border: 1px solid rgba(180,120,40,.5);
  border-radius: 6px;
  background: rgba(180,120,40,.16);
  color: #c8a050;
  font-size: .85em;
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background .12s ease;
  flex-shrink: 0;
}
.gm-panel-arrow:hover:not(:disabled) { background: rgba(180,120,40,.38); }
.gm-panel-arrow:disabled { opacity: .28; cursor: not-allowed; }
    `;
    document.head.appendChild(s);
  }

  console.debug(TAG, "GM Panel loaded.");
})();
