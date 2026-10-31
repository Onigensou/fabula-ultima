// ============================================================================
// Camp System — Activity Resolve UI
//
// Shown during the ACTIVITY_RESOLVE phase. Displays a queue of locked
// activities and runs them one by one. Each activity's execute() function
// handles the actual mini-game / skill check.
//
// The primary GM drives the queue. An activity it has finished is recorded in
// the RESOLVED setting, so a reload or redraw carries on instead of running the
// night's activities (and their rewards) again. The running activity ends early
// if its owner stays offline or the GM forces the phase on; either way this
// closes it on every client.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][ActivityResolve]";
  const OVL_ID = "oni-camp-overlay";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  const OWNER_GONE_MS = 20000;  // offline this long and the activity is given up
  const OWNER_POLL_MS = 2000;

  // Activity key → [UI object, message that closes it on the other clients].
  // Activities not listed draw no overlay of their own here.
  const ACTIVITY_CLOSE = {
    cartography:      ["CartographyUI",     "CARTOGRAPHY_DONE"],
    combat_lesson:    ["CombatLessonUI",    "COMBAT_LESSON_DONE"],
    curse:            ["CurseUI",           "CURSE_DONE"],
    daydream:         ["DaydreamUI",        "DAYDREAM_DONE"],
    double_portion:   ["DoublePortionUI",   "DOUBLE_PORTION_DONE"],
    exploration:      ["ExplorationUI",     "EXPLORATION_DONE"],
    fishing:          ["FishingUI",         "FISHING_DONE"],
    gathering:        ["GatheringUI",       "GATHERING_DONE"],
    magic_lesson:     ["MagicLessonUI",     "MAGIC_LESSON_DONE"],
    martial_practice: ["MartialPracticeUI", "MARTIAL_PRACTICE_DONE"],
    massage:          ["MassageUI",         "MASSAGE_DONE"],
    midnight_oil:     ["MidnightOilUI",     "MIDNIGHT_OIL_DONE"],
    pep_talk:         ["PepTalkUI",         "PEP_TALK_DONE"],
    planning:         ["PlanningUI",        "PLANNING_DONE"],
    sleep_soundly:    ["SleepSoundlyUI",    "SLEEP_SOUNDLY_DONE"],
    training:         ["TrainingUI",        "TRAINING_DONE"],
  };

  let _running  = false;
  let _forceEnd = null;   // ends the running activity when the phase moves on

  CAMP.ActivityResolveUI = {
    _party: [],
    _queue: [],  // [{ actorId, activityKey, actor, actorName }]

    async show() {
      this._party = await CAMP.Party.resolve();
      this._queue = _buildQueue(this._party);
      _buildOverlay(this._queue);
      this.refreshDone();

      // Only the primary GM drives the resolution sequence
      if (isPrimaryGM()) {
        await this._runAll();
      }
    },

    refreshDone() {
      for (const actorId of Object.keys(CAMP.State.getResolved())) this.markDone(actorId);
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

    // Primary GM runs all activities sequentially. Re-entered by a canvas redraw
    // while it's already running, in which case the first run carries on.
    async _runAll() {
      if (_running) return;
      _running = true;
      try {
        const stillResolving = () => CAMP.State.getPhase() === CAMP.PHASE.ACTIVITY_RESOLVE;

        if (this._queue.length === 0) {
          // Nothing to resolve — skip directly to bond update
          await new Promise(r => setTimeout(r, 800));
        }

        for (const entry of this._queue) {
          if (!stillResolving()) return;
          if (CAMP.State.getResolved()[entry.actorId]) continue;

          this.markRunning(entry.actorId);
          CAMP.Sound?.play(CAMP.SFX?.CAMP_START);
          await _runOne(entry);
          if (!stillResolving()) return;

          await CAMP.State.markResolved(entry.actorId);
          this.markDone(entry.actorId);
          await new Promise(r => setTimeout(r, 600));
        }

        // All done — auto-advance to Bond Update
        await new Promise(r => setTimeout(r, 800));
        if (!stillResolving()) return;
        await CAMP.State.clearResolved();
        await CAMP.State.setPhase(CAMP.PHASE.BOND_UPDATE);
      } finally {
        _running = false;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // One activity: runs until it finishes, its owner is gone, or the phase moves
  // ---------------------------------------------------------------------------
  async function _runOne(entry) {
    const def = CAMP.ActivityRegistry?.get(entry.activityKey);
    if (!def?.execute) {
      await new Promise(r => setTimeout(r, 1200));
      return;
    }

    const owner = _watchOwner(entry);
    const finished = Promise.resolve()
      .then(() => def.execute(entry.actor, canvas?.scene ?? null))
      .catch(e => console.error(TAG, "Activity execute failed:", entry.activityKey, e))
      .then(() => "finished");
    const forced = new Promise(r => { _forceEnd = () => r("forced"); });

    const how = await Promise.race([finished, owner.gone, forced]);
    owner.stop();
    _forceEnd = null;

    if (how === "finished") return;
    console.warn(TAG, `Ending ${entry.activityKey} early (${how}) for`, entry.actorName);
    if (how === "owner offline") {
      ui.notifications?.warn(`${entry.actorName} is offline: moving on from ${entry.actName}.`);
    }
    _closeActivity(entry.activityKey);
  }

  // Resolves once the activity's owner has been offline for OWNER_GONE_MS. A
  // player who is connected keeps as long as they like.
  function _watchOwner(entry) {
    let timer = null;
    const gone = new Promise(resolve => {
      const user = entry.userId ? game.users?.get(entry.userId) : null;
      if (!user) return;   // no player owner: the GM runs it
      let offlineSince = null;
      timer = setInterval(() => {
        if (user.active) { offlineSince = null; return; }
        offlineSince ??= Date.now();
        if (Date.now() - offlineSince >= OWNER_GONE_MS) resolve("owner offline");
      }, OWNER_POLL_MS);
    });
    return { gone, stop: () => clearInterval(timer) };
  }

  // A broadcast doesn't echo to its sender, so close it locally too.
  function _closeActivity(key) {
    const close = ACTIVITY_CLOSE[key];
    if (!close) return;
    const [ui, msg] = close;
    CAMP.Socket.broadcast(CAMP.MSG[msg], {});
    CAMP[ui]?.hide?.();
  }

  Hooks.on("updateSetting", (setting) => {
    const key = setting?.key ?? "";
    if (key === `${CAMP.MODULE_ID}.${CAMP.SETTING.RESOLVED}`) {
      CAMP.ActivityResolveUI.refreshDone();
    } else if (key === `${CAMP.MODULE_ID}.${CAMP.SETTING.PHASE}`) {
      if (CAMP.State.getPhase() !== CAMP.PHASE.ACTIVITY_RESOLVE) _forceEnd?.();
    }
  });

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
        userId:    entry?.userId ?? null,
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
