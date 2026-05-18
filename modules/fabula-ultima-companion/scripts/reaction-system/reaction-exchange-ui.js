/**
 * [ONI] Reaction Exchange — UI (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Pinned center-screen surface that renders the shared Reaction Exchange
 * stack. Hook-driven; opens on `oni:exchange:opened`, refreshes on
 * `oni:exchange:mutated|resolving`, animates entries on
 * `oni:exchange:entryResolved`, fades out on `oni:exchange:closed`.
 *
 * Per the design (see project_reaction_exchange_design.md):
 *   - Pinned center; non-draggable; matches CSB / action-card aesthetic.
 *   - Single shared queue between PCs and GM ("blow-to-blow trade").
 *   - Per-user "your reactions" panel — private; reads
 *     `state.candidatesByUser[game.user.id]`.
 *   - Ready strip — visible to all; indicates Ready / waiting / AFK.
 *   - Drag-reorder on queue (HTML5 drag API). Entries restrict mutation
 *     to their owner (or GM).
 *
 * Step 3 scope:
 *   - Reactor entries / candidates / ready strip / Force Resolve / Ready.
 *   - One Exchange at a time (multi-Exchange-overlap is rare and deferred).
 *   - Resolution log appended live as entries fire (drives the animation).
 *
 * Mutations go through `oni.ReactionExchangeSync.request*` so the path
 * is identical on GM and non-GM clients.
 *
 * Exposed:
 *   - window["oni.ReactionExchangeUI"]
 *   - FUCompanion.api.reactionExchangeUI
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionExchangeUI";
    if (window[KEY]) {
      console.debug("[ReactionExchangeUI] Already installed.");
      return;
    }

    const TAG = "[ReactionExchangeUI]";
    const ROOT_ID = "oni-reaction-exchange";

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _esc(s) {
      if (s == null) return "";
      return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function _userId() { return game.user?.id ?? null; }
    function _isGM()   { return !!game.user?.isGM; }

    function _displayUserName(userId) {
      if (!userId) return "?";
      const upper = String(userId).toUpperCase();
      if (upper === "GM" || upper === "__GM__") return "GM";
      try {
        const u = game.users?.get?.(userId);
        if (u) return u.name + (u.isGM ? " (GM)" : "");
      } catch (_) {}
      return userId;
    }

    function _exchangeApi()  { return window["oni.ReactionExchange"] ?? null; }
    function _syncApi()      { return window["oni.ReactionExchangeSync"] ?? null; }

    /** Decide if `actorUserId` can mutate `entry`. Mirrors state-machine rule. */
    function _canMutateEntry(entry) {
      const me = _userId();
      if (!me) return false;
      if (entry?.userId === me) return true;
      return _isGM();
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    function _renderTriggers(triggers) {
      if (!Array.isArray(triggers) || !triggers.length) {
        return `<span class="oni-rx-empty-inline">no triggers</span>`;
      }
      return triggers.map(t =>
        `<span class="oni-rx-trigger-chip" title="${_esc(JSON.stringify(t.payload ?? {}))}">${_esc(t.key)}</span>`
      ).join("");
    }

    function _renderQueue(snapshot) {
      const status = snapshot.status;
      const log = snapshot.resolutionLog ?? [];
      const logByEntry = new Map();
      for (const l of log) if (l?.entryId) logByEntry.set(l.entryId, l);

      const editable = status === "queueing";
      if (!snapshot.queue.length) {
        return `<div class="oni-rx-empty">No reactions queued yet.</div>`;
      }
      return `<ol class="oni-rx-entries">${snapshot.queue.map((entry, idx) => {
        const mineOrGm = _canMutateEntry(entry);
        const logEntry = logByEntry.get(entry.entryId);
        const outcomeClass = logEntry ? `oni-rx-entry--${_esc(logEntry.outcome)}` : "";
        const outcomeBadge = logEntry
          ? `<span class="oni-rx-entry-outcome oni-rx-outcome--${_esc(logEntry.outcome)}">${_esc(logEntry.outcome)}${logEntry.reason ? `: ${_esc(logEntry.reason)}` : ""}</span>`
          : "";
        const actions = (editable && mineOrGm)
          ? `<div class="oni-rx-entry-actions">
              <button class="oni-rx-btn oni-rx-btn--icon" data-action="up"     ${idx === 0 ? "disabled" : ""} title="Move up">↑</button>
              <button class="oni-rx-btn oni-rx-btn--icon" data-action="down"   ${idx === snapshot.queue.length - 1 ? "disabled" : ""} title="Move down">↓</button>
              <button class="oni-rx-btn oni-rx-btn--icon oni-rx-btn--danger" data-action="remove" title="Remove from queue">✕</button>
            </div>`
          : "";
        const draggable = (editable && mineOrGm) ? "draggable=\"true\"" : "";
        const userLabel = _displayUserName(entry.userId);
        return `<li class="oni-rx-entry ${outcomeClass}" data-entry-id="${_esc(entry.entryId)}" data-owner="${_esc(entry.userId)}" ${draggable}>
          <span class="oni-rx-entry-index">${idx + 1}</span>
          <div class="oni-rx-entry-body">
            <div class="oni-rx-entry-reactor">
              <strong>${_esc(entry.reactorName || userLabel)}</strong>
              <span class="oni-rx-entry-owner">${_esc(userLabel)}</span>
            </div>
            <div class="oni-rx-entry-skill">${_esc(entry.skillName)}</div>
            ${entry.sourceTriggerKey ? `<div class="oni-rx-entry-trigger">↪ ${_esc(entry.sourceTriggerKey)}</div>` : ""}
            ${outcomeBadge}
          </div>
          ${actions}
        </li>`;
      }).join("")}</ol>`;
    }

    function _renderCandidates(snapshot) {
      const me = _userId();
      const cby = snapshot.candidatesByUser ?? {};
      // GM placeholder ("GM" / "__GM__") used by bridge scenarios resolves to
      // the real GM user. Real userId still wins if both are present.
      let myCandidates = cby[me] ?? [];
      if (!myCandidates.length && _isGM()) {
        myCandidates = cby.GM ?? cby.__GM__ ?? [];
      }
      const editable = snapshot.status === "queueing";

      if (!myCandidates.length) {
        return `<div class="oni-rx-empty">No reactions available for you.</div>`;
      }
      return `<ul class="oni-rx-candidate-list">${myCandidates.map(c => {
        const queueable = editable && c.available;
        const button = queueable
          ? `<button class="oni-rx-btn oni-rx-btn--primary" data-action="queue" data-skill-uuid="${_esc(c.skillUuid)}">Queue</button>`
          : `<span class="oni-rx-cand-disabled" title="${_esc(c.disabledReason ?? "unavailable")}">${_esc(c.disabledReason ?? "—")}</span>`;
        const triggerLine = c.sourceTriggerKey
          ? `<div class="oni-rx-cand-trigger">↪ ${_esc(c.sourceTriggerKey)}</div>`
          : "";
        const predicted = (c.predictedTriggers ?? []).map(t =>
          `<span class="oni-rx-trigger-chip oni-rx-trigger-chip--small">${_esc(t.key)}</span>`
        ).join("");
        return `<li class="oni-rx-candidate" data-skill-uuid="${_esc(c.skillUuid)}" data-available="${c.available}">
          <div class="oni-rx-cand-body">
            <div class="oni-rx-cand-reactor">${_esc(c.reactorName ?? "")}</div>
            <div class="oni-rx-cand-skill">${_esc(c.skillName)}</div>
            ${triggerLine}
            ${predicted ? `<div class="oni-rx-cand-predicted">→ ${predicted}</div>` : ""}
          </div>
          <div class="oni-rx-cand-action">${button}</div>
        </li>`;
      }).join("")}</ul>`;
    }

    function _renderReadyStrip(snapshot) {
      const eligible = snapshot.eligibleUserIds ?? [];
      const ready = snapshot.readyUsers ?? {};
      if (!eligible.length) {
        return `<div class="oni-rx-empty-inline">no eligible participants</div>`;
      }
      return eligible.map(uid => {
        const isReady = !!ready[uid];
        const cls = isReady ? "oni-rx-ready-chip oni-rx-ready-chip--ready" : "oni-rx-ready-chip oni-rx-ready-chip--waiting";
        const icon = isReady ? "✓" : "⏳";
        const label = _displayUserName(uid);
        return `<span class="${cls}" title="${_esc(label)}">${icon} ${_esc(label)}</span>`;
      }).join("");
    }

    function _renderFooter(snapshot) {
      const me = _userId();
      const eligible = snapshot.eligibleUserIds ?? [];
      const isEligible = eligible.includes(me) || (_isGM() && eligible.some(u => /^(GM|__GM__)$/i.test(u)));
      const ready = snapshot.readyUsers ?? {};
      const myReady = !!(ready[me] || (_isGM() && (ready.GM || ready.__GM__)));
      const editable = snapshot.status === "queueing";

      // Force-resolve: enabled if every OTHER eligible user is Ready, OR you're GM.
      let canForceResolve = editable && (isEligible || _isGM());
      if (canForceResolve && !_isGM()) {
        for (const u of eligible) {
          if (u === me) continue;
          if (!ready[u]) { canForceResolve = false; break; }
        }
      }

      const readyBtn = isEligible && editable
        ? `<button class="oni-rx-btn ${myReady ? "oni-rx-btn--secondary" : "oni-rx-btn--primary"}" data-action="toggle-ready">
            ${myReady ? "Un-Ready" : "Ready ✓"}
          </button>`
        : "";

      const forceBtn = editable
        ? `<button class="oni-rx-btn oni-rx-btn--danger" data-action="force-resolve" ${canForceResolve ? "" : "disabled"}>
            Force Resolve
          </button>`
        : "";

      return `<div class="oni-rx-footer">
        <div class="oni-rx-ready-strip">${_renderReadyStrip(snapshot)}</div>
        <div class="oni-rx-actions">${readyBtn}${forceBtn}</div>
      </div>`;
    }

    function _renderHeader(snapshot) {
      const statusLabel = ({
        queueing:  "Awaiting reactions",
        resolving: "Resolving…",
        closed:    "Closed"
      })[snapshot.status] ?? snapshot.status;

      return `<header class="oni-rx-header">
        <div class="oni-rx-title-row">
          <h2 class="oni-rx-title">⚔ Reaction Exchange ⚔</h2>
          <span class="oni-rx-status oni-rx-status--${_esc(snapshot.status)}">${_esc(statusLabel)}</span>
        </div>
        <div class="oni-rx-subtitle">
          <span class="oni-rx-kind">${_esc(snapshot.kind)}</span>
          <span class="oni-rx-boundary">${_esc(snapshot.boundaryKey)}</span>
        </div>
        <div class="oni-rx-triggers">${_renderTriggers(snapshot.firedTriggers)}</div>
      </header>`;
    }

    function _renderBody(snapshot) {
      return `<div class="oni-rx-body">
        <section class="oni-rx-section oni-rx-section--queue">
          <h3 class="oni-rx-section-title">Resolution Queue</h3>
          ${_renderQueue(snapshot)}
        </section>
        <section class="oni-rx-section oni-rx-section--candidates">
          <h3 class="oni-rx-section-title">Your reactions</h3>
          ${_renderCandidates(snapshot)}
        </section>
      </div>`;
    }

    function _renderFull(snapshot) {
      return `<div class="oni-rx-panel">
        ${_renderHeader(snapshot)}
        ${_renderBody(snapshot)}
        ${_renderFooter(snapshot)}
      </div>`;
    }

    // -------------------------------------------------------------------------
    // UI manager (single instance)
    // -------------------------------------------------------------------------

    let _instance = null;
    let _dragSrcEntryId = null;

    class ReactionExchangeUI {
      constructor() {
        this.element = null;
        this.snapshot = null;
        this.closing = false;
      }

      mount(snapshot) {
        this.snapshot = snapshot;
        // Tear down any prior orphaned root.
        const existing = document.getElementById(ROOT_ID);
        if (existing) existing.remove();

        const root = document.createElement("div");
        root.id = ROOT_ID;
        root.className = "oni-rx-app";
        root.innerHTML = _renderFull(snapshot);
        document.body.appendChild(root);
        this.element = root;
        this._bind();
        console.debug(`${TAG} mounted for exchange ${snapshot.exchangeId}.`);
      }

      refresh(snapshot) {
        if (this.closing) return;
        this.snapshot = snapshot;
        if (!this.element) {
          this.mount(snapshot);
          return;
        }
        // Re-render body / footer to preserve outer animations / element identity.
        // For step 3 we just re-render everything in-place; perf is fine for the
        // sizes involved.
        this.element.innerHTML = _renderFull(snapshot);
        this._bind();
      }

      flashEntry(entryId, outcome) {
        if (!this.element) return;
        const el = this.element.querySelector(`.oni-rx-entry[data-entry-id="${entryId}"]`);
        if (!el) return;
        el.classList.add("oni-rx-entry--flash", `oni-rx-flash--${outcome}`);
        setTimeout(() => {
          el.classList.remove("oni-rx-entry--flash", `oni-rx-flash--${outcome}`);
        }, 1200);
      }

      destroy(reason) {
        if (this.closing) return;
        this.closing = true;
        const el = this.element;
        if (!el) return;
        el.classList.add("oni-rx-app--closing");
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 600);
        console.debug(`${TAG} closed (reason=${reason}).`);
      }

      // -----------------------------------------------------------------------
      // Event binding
      // -----------------------------------------------------------------------

      _bind() {
        if (!this.element) return;
        const root = this.element;

        // Queue entry buttons
        root.querySelectorAll(".oni-rx-entry [data-action]").forEach(btn => {
          btn.addEventListener("click", (ev) => this._onEntryAction(ev));
        });

        // Candidate "Queue" buttons
        root.querySelectorAll(".oni-rx-candidate [data-action='queue']").forEach(btn => {
          btn.addEventListener("click", (ev) => this._onCandidateQueue(ev));
        });

        // Footer buttons
        const readyBtn = root.querySelector("[data-action='toggle-ready']");
        if (readyBtn) readyBtn.addEventListener("click", () => this._onToggleReady());

        const forceBtn = root.querySelector("[data-action='force-resolve']");
        if (forceBtn) forceBtn.addEventListener("click", () => this._onForceResolve());

        // Drag-reorder on queue entries
        root.querySelectorAll(".oni-rx-entry[draggable='true']").forEach(li => {
          li.addEventListener("dragstart", (ev) => {
            _dragSrcEntryId = li.dataset.entryId || null;
            li.classList.add("oni-rx-entry--dragging");
            if (ev.dataTransfer) {
              ev.dataTransfer.effectAllowed = "move";
              try { ev.dataTransfer.setData("text/plain", _dragSrcEntryId ?? ""); } catch (_) {}
            }
          });
          li.addEventListener("dragend", () => {
            li.classList.remove("oni-rx-entry--dragging");
            _dragSrcEntryId = null;
          });
          li.addEventListener("dragover", (ev) => {
            if (!_dragSrcEntryId) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move";
            li.classList.add("oni-rx-entry--drop-target");
          });
          li.addEventListener("dragleave", () => {
            li.classList.remove("oni-rx-entry--drop-target");
          });
          li.addEventListener("drop", (ev) => {
            ev.preventDefault();
            li.classList.remove("oni-rx-entry--drop-target");
            const srcId = _dragSrcEntryId;
            const targetId = li.dataset.entryId;
            if (!srcId || !targetId || srcId === targetId) return;
            this._onDropReorder(srcId, targetId);
          });
        });
      }

      // -----------------------------------------------------------------------
      // Mutation handlers (all go through the sync API)
      // -----------------------------------------------------------------------

      async _onEntryAction(ev) {
        const btn = ev.currentTarget;
        const action = btn.dataset.action;
        const li = btn.closest(".oni-rx-entry");
        const entryId = li?.dataset?.entryId;
        if (!entryId) return;

        const snapshot = this.snapshot;
        const idx = snapshot.queue.findIndex(e => e.entryId === entryId);
        if (idx < 0) return;

        const sync = _syncApi();
        if (!sync) return;
        try {
          switch (action) {
            case "up":
              if (idx > 0) await sync.requestReorderEntry(snapshot.exchangeId, entryId, idx - 1);
              break;
            case "down":
              if (idx < snapshot.queue.length - 1) await sync.requestReorderEntry(snapshot.exchangeId, entryId, idx + 1);
              break;
            case "remove":
              await sync.requestRemoveEntry(snapshot.exchangeId, entryId);
              break;
          }
        } catch (e) {
          ui.notifications?.warn?.(`Reaction Exchange: ${e?.message ?? e}`);
        }
      }

      async _onDropReorder(srcEntryId, targetEntryId) {
        const snapshot = this.snapshot;
        const targetIdx = snapshot.queue.findIndex(e => e.entryId === targetEntryId);
        if (targetIdx < 0) return;
        const sync = _syncApi();
        if (!sync) return;
        try {
          await sync.requestReorderEntry(snapshot.exchangeId, srcEntryId, targetIdx);
        } catch (e) {
          ui.notifications?.warn?.(`Reaction Exchange: ${e?.message ?? e}`);
        }
      }

      async _onCandidateQueue(ev) {
        const btn = ev.currentTarget;
        const skillUuid = btn.dataset.skillUuid;
        if (!skillUuid) return;

        const me = _userId();
        const snapshot = this.snapshot;
        const candidates = snapshot.candidatesByUser?.[me] ?? [];
        const cand = candidates.find(c => c.skillUuid === skillUuid);
        if (!cand) return;

        const sync = _syncApi();
        if (!sync) return;
        try {
          // userId is REQUIRED by addEntry. Default to the current user
          // — the queuer owns the entry (mutations gated by entry.userId).
          // Symmetric queue: GM queueing a PC's reaction yields an entry
          // owned by GM (the queuer). The PC's player still sees it in
          // the shared queue but can't remove/reorder it without GM
          // override (matches the "GM is just another participant" model).
          await sync.requestAddEntry(snapshot.exchangeId, {
            userId: _userId(),
            reactorTokenId: cand.reactorTokenId,
            reactorActorUuid: cand.reactorActorUuid,
            reactorName: cand.reactorName,
            skillUuid: cand.skillUuid,
            skillName: cand.skillName,
            sourceTriggerKey: cand.sourceTriggerKey,
            effectRefs: cand.effectRefs,
            predictedTriggers: cand.predictedTriggers
          });
        } catch (e) {
          ui.notifications?.warn?.(`Reaction Exchange: ${e?.message ?? e}`);
        }
      }

      async _onToggleReady() {
        const me = _userId();
        const snapshot = this.snapshot;
        const ready = snapshot.readyUsers ?? {};
        const isReady = !!(ready[me] || (_isGM() && (ready.GM || ready.__GM__)));
        const sync = _syncApi();
        if (!sync) return;
        try {
          await sync.requestSetReady(snapshot.exchangeId, !isReady);
        } catch (e) {
          ui.notifications?.warn?.(`Reaction Exchange: ${e?.message ?? e}`);
        }
      }

      async _onForceResolve() {
        const sync = _syncApi();
        if (!sync) return;
        try {
          await sync.requestForceResolve(this.snapshot.exchangeId);
        } catch (e) {
          ui.notifications?.warn?.(`Reaction Exchange: ${e?.message ?? e}`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Hook plumbing
    // -------------------------------------------------------------------------

    function _onOpened({ snapshot }) {
      if (_instance && _instance.snapshot?.exchangeId !== snapshot.exchangeId) {
        // Different Exchange opened while one was still up — discard old.
        _instance.destroy("superseded");
      }
      _instance = new ReactionExchangeUI();
      _instance.mount(snapshot);
    }

    function _onMutated({ snapshot }) {
      if (!_instance) {
        // Late-join: receive a mutated snapshot before opened. Treat as open.
        _onOpened({ snapshot });
        return;
      }
      if (_instance.snapshot?.exchangeId !== snapshot.exchangeId) return;
      _instance.refresh(snapshot);
    }

    function _onResolving({ snapshot }) {
      _onMutated({ snapshot });
    }

    function _onEntryResolved({ exchangeId, entry, logRow }) {
      if (!_instance || _instance.snapshot?.exchangeId !== exchangeId) return;
      // The state machine appends to resolutionLog only at markResolved
      // (batch commit), so we synthesize a per-entry visual update here.
      const snap = _instance.snapshot;
      const log = Array.isArray(snap.resolutionLog) ? snap.resolutionLog.slice() : [];
      log.push(logRow);
      _instance.refresh({ ...snap, resolutionLog: log });
      _instance.flashEntry(entry.entryId, logRow.outcome);
    }

    function _onClosed({ snapshot, reason }) {
      if (!_instance) return;
      if (_instance.snapshot?.exchangeId !== snapshot.exchangeId) return;
      _instance.refresh(snapshot);
      _instance.destroy(reason);
      _instance = null;
    }

    Hooks.on("oni:exchange:opened",        _onOpened);
    Hooks.on("oni:exchange:mutated",       _onMutated);
    Hooks.on("oni:exchange:resolving",     _onResolving);
    Hooks.on("oni:exchange:entryResolved", _onEntryResolved);
    Hooks.on("oni:exchange:closed",        _onClosed);

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    const api = {
      // Inspection only — UI itself responds to hooks
      getCurrentInstance: () => _instance,
      isOpen: () => !!_instance && !_instance.closing,
      // Test helpers — force-mount with an arbitrary snapshot, for visual smoke
      _forceMount: (snap) => { _onOpened({ snapshot: snap }); },
      _forceClose: (reason = "test") => {
        if (_instance) { _instance.destroy(reason); _instance = null; }
      }
    };

    window[KEY] = api;
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.reactionExchangeUI = api;

    console.debug(`${TAG} Installed.`);
  })();
});
