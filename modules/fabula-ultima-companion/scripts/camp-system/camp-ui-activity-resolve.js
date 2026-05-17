// ============================================================================
// Camp System — Activity Resolve UI
//
// Shown during the ACTIVITY_RESOLVE phase. Displays a queue of locked
// activities and runs them one by one. Each activity's execute() function
// handles the actual mini-game / skill check.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][ActivityResolve]";
  const OVL_ID = "oni-camp-overlay";

  CAMP.ActivityResolveUI = {
    _party: [],
    _queue: [],  // [{ actorId, activityKey, actor, actorName }]

    async show() {
      this._party = await CAMP.Party.resolve();
      this._queue = _buildQueue(this._party);
      _buildOverlay(this._queue);

      // Only the GM drives the resolution sequence
      if (game.user?.isGM) {
        await this._runAll();
      }
    },

    hide() {
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    },

    // Mark a row as done and update the UI
    markDone(actorId) {
      const row = document.querySelector(`.oni-camp-resolve-item[data-actor-id="${actorId}"]`);
      if (!row) return;
      const status = row.querySelector(".ri-status");
      if (status) { status.className = "ri-status done"; status.textContent = "Done"; }
    },

    markRunning(actorId) {
      const row = document.querySelector(`.oni-camp-resolve-item[data-actor-id="${actorId}"]`);
      if (!row) return;
      const status = row.querySelector(".ri-status");
      if (status) { status.className = "ri-status running"; status.textContent = "Resolving..."; }
    },

    // GM runs all activities sequentially
    async _runAll() {
      if (this._queue.length === 0) {
        // Nothing to resolve — skip directly to bond update
        await new Promise(r => setTimeout(r, 800));
        await CAMP.State.clearResolved();
        await CAMP.State.setPhase(CAMP.PHASE.BOND_UPDATE);
        return;
      }

      for (const entry of this._queue) {
        this.markRunning(entry.actorId);
        try {
          const def = CAMP.ActivityRegistry?.get(entry.activityKey);
          if (def?.execute) {
            await def.execute(entry.actor, canvas?.scene ?? null);
          } else {
            await new Promise(r => setTimeout(r, 1200));
          }
        } catch (e) {
          console.error(TAG, "Activity execute failed:", entry.activityKey, e);
        }
        this.markDone(entry.actorId);
        await new Promise(r => setTimeout(r, 600));
      }

      // All done — auto-advance to Bond Update
      await new Promise(r => setTimeout(r, 800));
      await CAMP.State.clearResolved();
      await CAMP.State.setPhase(CAMP.PHASE.BOND_UPDATE);
    },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _buildQueue(party) {
    const resolutions = CAMP.State.getOrderedResolutions();
    return resolutions.map(({ actorId, activityKey }) => {
      const entry   = party.find(e => e.actorId === actorId);
      const def     = CAMP.ACTIVITY_DEFS.find(d => d.key === activityKey);
      return {
        actorId,
        activityKey,
        actor:     entry?.actor ?? null,
        actorName: entry?.userName ?? actorId,
        actName:   def?.name ?? activityKey,
        actIcon:   def?.icon ?? "fas fa-star",
      };
    });
  }

  function _buildOverlay(queue) {
    document.getElementById(OVL_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;

    const rows = queue.map(({ actorId, actorName, actName, actIcon }) => `
      <div class="oni-camp-resolve-item" data-actor-id="${actorId}">
        <div class="ri-icon"><i class="${actIcon}"></i></div>
        <div class="ri-info">
          <div class="ri-name">${actName}</div>
          <div class="ri-actor">${actorName}</div>
        </div>
        <div class="ri-status pending">Pending</div>
      </div>
    `).join("");

    const gmBar = game.user?.isGM ? `
      <div class="oni-camp-gm-override" style="margin-top:12px;">
        <span class="gm-override-label"><i class="fas fa-shield-alt"></i> GM Controls</span>
        <button class="oni-camp-gm-btn" id="oni-camp-resolve-force">Force Next Phase →</button>
      </div>` : "";

    overlay.innerHTML = `
      <div class="oni-camp-panel" style="width:min(560px,90vw);">
        <div class="oni-camp-panel__title"><i class="fas fa-campfire"></i> Camp Activity Resolution</div>
        <div style="font-size:.82em;opacity:.7;margin-bottom:10px;">
          Performing tonight's activities...
        </div>
        <div>${rows || '<div style="opacity:.5;font-style:italic;font-size:.85em;text-align:center;padding:12px;">No activities to resolve.</div>'}</div>
        ${gmBar}
      </div>
    `;

    overlay.querySelector("#oni-camp-resolve-force")?.addEventListener("click", async () => {
      await CAMP.State.clearResolved();
      await CAMP.State.setPhase(CAMP.PHASE.BOND_UPDATE);
    });

    document.body.appendChild(overlay);
  }

  console.debug(TAG, "ActivityResolve UI loaded.");
})();
