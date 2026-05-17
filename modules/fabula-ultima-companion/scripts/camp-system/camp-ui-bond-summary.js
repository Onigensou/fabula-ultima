// ============================================================================
// Camp System — Bond Summary UI
//
// After all players confirm bonds, this screen plays back every bond change
// as a sequential "flush" log — one entry per change, staggered with SFX.
//
// Log priority per actor:
//   1. New Bond Added
//   2. Transfer to Memory
//   3. New Emotion Added
//   4. Emotion Updated
//   5. Bond Level Reached X
//   6. Relationship Add / Update
//
// The main panel fades + slides up on enter.
// Each log entry slides in from right → left with a ~2.5 s hold between entries.
// After all entries play, the screen holds 5 s then the GM auto-advances.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][BondSummary]";
  const OVL_ID = "oni-camp-overlay";

  const LOG_HOLD_MS   = 2500;  // hold between log entries
  const POST_HOLD_MS  = 5000;  // hold after last entry before advancing

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.BondSummaryUI = {
    async show() {
      const summaryData = CAMP.State.getBondSummary();
      const logGroups   = _buildLogGroups(summaryData);
      const flatLogs    = logGroups.flatMap(g => [{ _isHeader: true, actorName: g.actorName }, ...g.logs]);

      CAMP.Sound.play(CAMP.SFX.BOND_SUM_ENTER);
      _buildOverlay(logGroups);

      // If there are no log entries, hold briefly then advance
      if (flatLogs.length === 0) {
        if (game.user?.isGM) {
          await _wait(3000);
          await CAMP.State.clearBondConfirmed();
          await CAMP.State.setPhase(CAMP.PHASE.SLEEP_LOBBY);
        }
        return;
      }

      // Sequentially reveal each log entry
      const entryEls = Array.from(document.querySelectorAll(".oni-bond-log-entry"));
      for (let i = 0; i < entryEls.length; i++) {
        const el  = entryEls[i];
        const log = flatLogs[i];

        // Play SFX for this entry (headers use generic sound)
        CAMP.Sound.play(log._isHeader ? CAMP.SFX.BOND_SUM_GENERIC : _sfxForLog(log));

        el.classList.add("visible");

        // Scroll the inner panel so the new entry is in view
        const body = document.querySelector(".oni-bond-summary-panel .panel-body");
        if (body) body.scrollTop = body.scrollHeight;

        if (i < entryEls.length - 1) {
          await _wait(LOG_HOLD_MS);
        }
      }

      // All entries revealed — hold then GM advances
      if (game.user?.isGM) {
        await _wait(POST_HOLD_MS);
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
  // Log sequence builder
  // ---------------------------------------------------------------------------

  /**
   * Returns Array<{ actorName, logs: Array<LogItem> }> where logs are sorted by
   * priority and LogItem has { priority, logType, ...fields }.
   */
  function _buildLogGroups(summaryData) {
    const groups = [];

    for (const entry of Object.values(summaryData)) {
      if (!entry) continue;
      const logs = [];

      const changes    = entry.changes    ?? [];
      const memChanges = entry.memChanges ?? [];

      // P1: New Bond Added (type === "add")
      for (const c of changes) {
        if (c.type === "add" && c.after?.name) {
          logs.push({ priority: 1, logType: "newBond", bondName: c.after.name });
        }
      }

      // P2: Transfer to Memory
      for (const mem of memChanges) {
        if (mem.name) {
          logs.push({ priority: 2, logType: "toMemory", bondName: mem.name });
        }
      }

      // P3: Bond Released / Cleared (removed without going to memory)
      for (const c of changes) {
        if (c.type === "remove" && c.before?.name) {
          logs.push({ priority: 3, logType: "bondReleased", bondName: c.before.name });
        }
      }

      // P3: Memory Released / Cleared (deleted from memory list)
      const memRemovals = entry.memRemovals ?? [];
      for (const mem of memRemovals) {
        if (mem.name) {
          logs.push({ priority: 3, logType: "memoryReleased", bondName: mem.name });
        }
      }

      // P4: New Emotion Added (slot was empty before, now filled)
      for (const c of changes) {
        if (c.type !== "update" && c.type !== "add") continue;
        const before    = c.before ?? { e1: "", e2: "", e3: "" };
        const after     = c.after  ?? {};
        const bondName  = after.name || before.name || "?";
        for (const key of ["e1", "e2", "e3"]) {
          if (!before[key] && after[key]) {
            logs.push({
              priority: 4, logType: "newEmotion",
              bondName, emotion: after[key],
              polarity: BondUpdater.emotionPolarity(after[key]),
            });
          }
        }
      }

      // P5: Emotion Updated (both non-empty, different values)
      for (const c of changes) {
        if (c.type !== "update") continue;
        const before   = c.before ?? {};
        const after    = c.after  ?? {};
        const bondName = after.name || before.name || "?";
        for (const key of ["e1", "e2", "e3"]) {
          if (before[key] && after[key] && before[key] !== after[key]) {
            logs.push({
              priority: 5, logType: "emotionUpdated",
              bondName, oldEmotion: before[key], newEmotion: after[key],
              polarity: BondUpdater.emotionPolarity(after[key]),
            });
          }
        }
      }

      // P6: Bond Level Milestone (count of filled emotions increased)
      for (const c of changes) {
        if (c.type !== "update" && c.type !== "add") continue;
        const before     = c.before ?? { e1: "", e2: "", e3: "" };
        const after      = c.after  ?? {};
        const bondName   = after.name || before.name || "?";
        const lvlBefore  = [before.e1, before.e2, before.e3].filter(Boolean).length;
        const lvlAfter   = [after.e1,  after.e2,  after.e3 ].filter(Boolean).length;
        if (lvlAfter > lvlBefore) {
          logs.push({ priority: 6, logType: "bondLevel", bondName, level: lvlAfter });
        }
      }

      // P7: Relationship Add / Update
      for (const c of changes) {
        if (c.type === "remove") continue;
        const before   = c.before ?? {};
        const after    = c.after  ?? {};
        const bondName = after.name || before.name || "?";
        if (after.rel && after.rel !== before.rel) {
          logs.push({
            priority: 7, logType: "relationship",
            bondName, oldRel: before.rel || "", newRel: after.rel,
          });
        }
      }

      if (logs.length === 0) continue;

      logs.sort((a, b) => a.priority - b.priority);
      groups.push({ actorName: entry.actorName ?? "Unknown", logs });
    }

    return groups;
  }

  // ---------------------------------------------------------------------------
  // SFX mapping
  // ---------------------------------------------------------------------------
  function _sfxForLog(log) {
    switch (log.logType) {
      case "newBond":       return CAMP.SFX.BOND_SUM_NEW_BOND;
      case "bondReleased":
      case "memoryReleased": return CAMP.SFX.BOND_SUM_CLEARED;
      case "newEmotion":
      case "emotionUpdated":
        return log.polarity === "positive"
          ? CAMP.SFX.BOND_SUM_EMOTION_UP
          : CAMP.SFX.BOND_SUM_EMOTION_DN;
      case "bondLevel":
        if (log.level === 1) return CAMP.SFX.BOND_SUM_LEVEL_1;
        if (log.level === 2) return CAMP.SFX.BOND_SUM_LEVEL_2;
        if (log.level === 3) return CAMP.SFX.BOND_SUM_LEVEL_3;
        return CAMP.SFX.BOND_SUM_GENERIC;
      default:
        return CAMP.SFX.BOND_SUM_GENERIC;
    }
  }

  // ---------------------------------------------------------------------------
  // Log label renderers
  // ---------------------------------------------------------------------------
  function _cap(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  function _logItemHTML(log) {
    switch (log.logType) {
      case "newBond":
        return `<span class="bse-log-icon"><i class="fas fa-plus-circle"></i></span>
                <span class="bse-log-text">New bond formed with <strong>${log.bondName}</strong></span>`;

      case "toMemory":
        return `<span class="bse-log-icon"><i class="fas fa-archive"></i></span>
                <span class="bse-log-text">Bond with <strong>${log.bondName}</strong> moved to memory</span>`;

      case "bondReleased":
        return `<span class="bse-log-icon"><i class="fas fa-heart-broken"></i></span>
                <span class="bse-log-text">The bond with <strong>${log.bondName}</strong> has faded.</span>`;

      case "memoryReleased":
        return `<span class="bse-log-icon"><i class="fas fa-wind"></i></span>
                <span class="bse-log-text">The memory of <strong>${log.bondName}</strong> has been let go.</span>`;

      case "newEmotion":
        return `<span class="bse-log-icon"><i class="fas fa-heart"></i></span>
                <span class="bse-log-text"><em>${_cap(log.emotion)}</em> added to bond with <strong>${log.bondName}</strong></span>`;

      case "emotionUpdated":
        return `<span class="bse-log-icon"><i class="fas fa-exchange-alt"></i></span>
                <span class="bse-log-text">Bond with <strong>${log.bondName}</strong> — <em>${_cap(log.oldEmotion)}</em> → <em>${_cap(log.newEmotion)}</em></span>`;

      case "bondLevel":
        return `<span class="bse-log-icon"><i class="fas fa-star"></i></span>
                <span class="bse-log-text">Bond level with <strong>${log.bondName}</strong> reached <strong>${log.level}</strong>!</span>`;

      case "relationship":
        return log.oldRel
          ? `<span class="bse-log-icon"><i class="fas fa-pen"></i></span>
             <span class="bse-log-text"><strong>${log.bondName}</strong> is now <em>${log.newRel}</em></span>`
          : `<span class="bse-log-icon"><i class="fas fa-pen"></i></span>
             <span class="bse-log-text"><strong>${log.bondName}</strong> has become <em>${log.newRel}</em></span>`;

      default:
        return `<span class="bse-log-text">${JSON.stringify(log)}</span>`;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------
  function _buildOverlay(logGroups) {
    document.getElementById(OVL_ID)?.remove();

    const noChanges = logGroups.length === 0;

    const groupsHTML = noChanges
      ? `<div style="font-style:italic;text-align:center;padding:20px 0;opacity:.7;">No bond changes this camp session.</div>`
      : logGroups.map(g => `
          <div class="oni-bond-log-group">
            <div class="oni-bond-log-actor-header oni-bond-log-entry">
              <i class="fas fa-heart"></i> ${g.actorName}
            </div>
            ${g.logs.map(log => `
              <div class="oni-bond-log-item oni-bond-log-entry">
                ${_logItemHTML(log)}
              </div>
            `).join("")}
          </div>
        `).join("");

    const overlay = document.createElement("div");
    overlay.id    = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-bond-summary-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-heart"></i> Bond Summary</div>
        <div class="oni-camp-inner-panel panel-body">
          <div style="font-size:.82em;margin-bottom:12px;">
            Here is how everyone's bonds changed tonight.
          </div>
          ${groupsHTML}
        </div>
        <hr>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
          <span style="font-size:.78em;opacity:.75;">
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

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  console.debug(TAG, "BondSummary UI loaded.");
})();
