// ============================================================================
// Camp System — Bond Summary UI
//
// Animated display shown after all players confirm their bonds.
// Reveals each party member's changes sequentially.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][BondSummary]";
  const OVL_ID = "oni-camp-overlay";

  CAMP.BondSummaryUI = {
    async show() {
      const summaryData = CAMP.State.getBondSummary(); // { [actorId]: { actorName, changes[] } }
      const entries = Object.values(summaryData).filter(e => e?.changes?.length > 0);

      _buildOverlay(entries);

      // Animate entries in with stagger
      const entryEls = document.querySelectorAll(".oni-bond-summary-entry");
      for (let i = 0; i < entryEls.length; i++) {
        entryEls[i].style.animationDelay = `${i * 0.4}s`;
      }

      // GM auto-advances after all entries have animated
      if (game.user?.isGM) {
        const delay = Math.max(3000, entries.length * 2000);
        await new Promise(r => setTimeout(r, delay));
        await CAMP.State.clearBondConfirmed();
        await CAMP.State.setPhase(CAMP.PHASE.SLEEP_LOBBY);
      }
    },

    hide() {
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    },
  };

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------
  function _changeLabel(change) {
    switch (change.type) {
      case "add":
        return `<span class="bse-change-icon"><i class="fas fa-plus"></i></span>
                <span class="bse-change-text">Added bond with <strong>${change.after?.name}</strong>
                  ${_emotionList(change.after)}</span>`;
      case "remove":
        return `<span class="bse-change-icon"><i class="fas fa-minus"></i></span>
                <span class="bse-change-text">Released bond with <strong>${change.before?.name}</strong></span>`;
      case "update":
        return `<span class="bse-change-icon"><i class="fas fa-edit"></i></span>
                <span class="bse-change-text">Updated bond with <strong>${change.after?.name || change.before?.name}</strong>
                  ${_emotionList(change.after)}</span>`;
      default:
        return `<span class="bse-change-text">${JSON.stringify(change)}</span>`;
    }
  }

  function _emotionList(bond) {
    if (!bond) return "";
    const ems = [bond.e1, bond.e2, bond.e3].filter(Boolean);
    return ems.length ? `<span style="opacity:.7;"> — ${ems.join(", ")}</span>` : "";
  }

  function _buildEntry(entry) {
    const changes = (entry.changes ?? []).map(c => `
      <div class="bse-change">${_changeLabel(c)}</div>
    `).join("");

    return `
      <div class="oni-bond-summary-entry">
        <div class="bse-header">
          <i class="fas fa-heart"></i> ${entry.actorName ?? "Unknown"}
        </div>
        <div class="bse-changes">
          ${changes || '<div style="opacity:.6;font-size:.82em;">No changes this camp.</div>'}
        </div>
      </div>
    `;
  }

  function _buildOverlay(entries) {
    document.getElementById(OVL_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;

    const noChanges = entries.length === 0;

    overlay.innerHTML = `
      <div class="oni-camp-panel oni-bond-summary-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-heart"></i> Bond Summary</div>
        <div style="font-size:.82em;opacity:.7;margin-bottom:10px;">
          Here is how everyone's bonds changed tonight.
        </div>
        <div class="panel-body">
          ${noChanges
            ? `<div style="opacity:.6;font-style:italic;text-align:center;padding:20px;">No bond changes this camp session.</div>`
            : entries.map(_buildEntry).join("")
          }
        </div>
        <hr>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
          <span style="font-size:.78em;opacity:.6;">
            <i class="fas fa-moon"></i> Continuing to sleep phase…
          </span>
          ${game.user?.isGM ? `<button class="oni-camp-gm-btn" id="oni-camp-bsum-force">Skip →</button>` : ""}
        </div>
      </div>
    `;

    overlay.querySelector("#oni-camp-bsum-force")?.addEventListener("click", async () => {
      await CAMP.State.clearBondConfirmed();
      await CAMP.State.setPhase(CAMP.PHASE.SLEEP_LOBBY);
    });

    document.body.appendChild(overlay);
  }

  console.debug(TAG, "BondSummary UI loaded.");
})();
