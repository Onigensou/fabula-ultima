// ============================================================================
// Check Requester — Group Check Orchestrator
//
// Public API:  globalThis.ONI.GroupCheck
//   .request(options)  → Promise<GroupCheckResult>
//
// Options:
//   leaderUuid       {string|null}  Actor UUID of leader. null = players choose
//   participantMode  {"designated"|"open"}
//   helperActorUuids {string[]}     Designated helper UUIDs (designated mode)
//   allActorUuids    {string[]}     All party actor UUIDs shown in lobby
//   helperDl         {number}       DL for helper rolls            default 10
//   leaderDl         {number}       DL for leader roll             default 10
//   helperBonus      {number}       Flat bonus per helper success  default 1
//   attrA            {string}       "DEX"|"MIG"|"INS"|"WLP"
//   attrB            {string}       same; ignored if singleDie=true
//   singleDie        {boolean}      Roll one die twice             default false
//   label            {string}       Title shown in UI and chat     default ""
//   allowInvokes     {boolean}      Allow Trait/Bond/Divination    default true
//   postChat         {boolean}      Post combined chat card        default true
//
// GroupCheckResult:
//   helperResults  {CheckResult[]}
//   leaderResult   {CheckResult|null}
//   bonus          {number}          total bonus granted to leader
//   leaderPass     {boolean}
// ============================================================================

(() => {
  const ONI       = globalThis.ONI ??= {};
  const TAG       = "[ONI][GroupCheck]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_GROUP_CHECK__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  // ── Socket message types (GC_ prefix, won't clash with CR_ messages) ──────
  const GC_LOBBY_OPEN = "GC_LOBBY_OPEN";
  const GC_SYNC       = "GC_SYNC";
  const GC_START      = "GC_START";
  const GC_CLOSE      = "GC_CLOSE";

  // ── Helpers ───────────────────────────────────────────────────────────────
  const esc = s => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  const getTokenImg = actor => {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  };

  const canOwnerAct = uuid => {
    if (game.user?.isGM) return true;
    const byWorld = game.actors?.find(a => a.uuid === uuid);
    if (byWorld) return byWorld.testUserPermission(game.user, "OWNER");
    for (const t of (canvas.tokens?.placeables ?? []))
      if (t.actor?.uuid === uuid) return t.actor.testUserPermission(game.user, "OWNER");
    return false;
  };

  const resolveActor = async uuid => {
    if (!uuid) return null;
    try {
      const doc = await fromUuid(uuid);
      if (doc?.actor)                    return doc.actor;
      if (doc?.documentName === "Actor") return doc;
    } catch {}
    return null;
  };

  // =========================================================================
  // CSS
  // =========================================================================
  const STYLE_ID = "oni-gc-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Lobby backdrop ─────────────────────────────────────────────────── */
      .oni-gc-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.62);
        z-index: 100010;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 14px; pointer-events: auto;
      }
      .oni-gc-title {
        font-size: 1.08rem; font-weight: 800; color: #f6ebd3;
        text-shadow: 0 1px 5px rgba(0,0,0,.8);
        letter-spacing: .04em; text-align: center;
      }
      .oni-gc-subtitle {
        font-size: .82rem; color: rgba(246,235,211,.65);
        text-align: center; font-style: italic; margin-top: -10px;
      }
      .oni-gc-panels {
        display: flex; flex-wrap: wrap; justify-content: center;
        gap: 14px; max-width: 900px;
      }

      /* ── Panel ───────────────────────────────────────────────────────────── */
      @keyframes oni-gc-panel-in {
        from { opacity: 0; transform: translateY(18px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }
      .oni-gc-panel {
        width: 158px;
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.95); border-radius: 16px;
        box-shadow: 0 10px 26px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,248,232,.7);
        color: #3b2a19;
        display: flex; flex-direction: column; align-items: center;
        padding: 12px 10px 10px; gap: 7px;
        animation: oni-gc-panel-in 300ms cubic-bezier(.22,1,.36,1) both;
        transition: opacity .3s, filter .3s, border-color .25s, box-shadow .25s;
      }

      /* State variants */
      .oni-gc-panel.is-spectator {
        filter: grayscale(60%) brightness(0.78);
        opacity: 0.52;
      }
      .oni-gc-panel.is-helper {
        filter: none;
        opacity: 1;
      }
      .oni-gc-panel.is-leader {
        filter: none;
        opacity: 1;
        border-color: rgba(210,168,42,.95);
        box-shadow: 0 0 0 3px rgba(210,168,42,.45), 0 10px 26px rgba(0,0,0,.28),
                    inset 0 1px 0 rgba(255,248,232,.7);
      }

      .oni-gc-portrait {
        width: 80px; height: 80px; flex-shrink: 0;
        background: transparent !important;
        border: none !important; box-shadow: none !important;
      }
      .oni-gc-portrait img, .oni-gc-portrait video {
        width: 100%; height: 100%; display: block; object-fit: contain;
        background: transparent !important; border: none !important;
        outline: none !important; box-shadow: none !important; filter: none !important;
      }
      .oni-gc-actor-name {
        font-size: .82rem; font-weight: 800; text-align: center;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      .oni-gc-role-badge {
        font-size: .72rem; font-weight: 800; padding: 2px 10px; border-radius: 6px;
        text-transform: uppercase; letter-spacing: .04em;
      }
      .oni-gc-role-badge.leader  { background: rgba(210,168,42,.22); color: #7a5000; }
      .oni-gc-role-badge.helper  { background: rgba(46,125,50,.15);  color: #2f6a35; }
      .oni-gc-role-badge.spectator { background: rgba(0,0,0,.07); color: rgba(59,42,25,.45); font-style: italic; }

      /* Panel buttons */
      .oni-gc-btn {
        font-size: .72rem; font-weight: 700; padding: 5px 8px;
        border-radius: 8px; border: 1.5px solid rgba(91,63,38,.8);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer; width: 100%;
        transition: filter .1s, transform .1s;
      }
      .oni-gc-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
      .oni-gc-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; }
      .oni-gc-btn.primary {
        background: linear-gradient(180deg, #4caf50, #2e7d32);
        border-color: #2e7d32; color: #fff;
      }

      /* ── GM controls bar ─────────────────────────────────────────────────── */
      .oni-gc-controls {
        display: flex; align-items: center; justify-content: center; gap: 12px;
        margin-top: 4px;
      }
      .oni-gc-start-btn {
        padding: 10px 30px; font-size: .9rem; font-weight: 800;
        border-radius: 12px; border: 2px solid #2e7d32;
        background: linear-gradient(180deg, #4caf50, #2e7d32);
        color: #fff; cursor: pointer; letter-spacing: .03em;
        box-shadow: 0 4px 12px rgba(0,0,0,.25);
        transition: filter .1s, transform .1s;
      }
      .oni-gc-start-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-gc-start-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; filter: none; }
      .oni-gc-cancel-btn {
        padding: 10px 18px; font-size: .84rem; font-weight: 700;
        border-radius: 12px; border: 1.5px solid rgba(91,63,38,.8);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer;
        transition: filter .1s;
      }
      .oni-gc-cancel-btn:hover { filter: brightness(1.07); }
    `;
    document.head.appendChild(s);
  }

  // =========================================================================
  // Lobby session state
  // =========================================================================
  let _lobbySession = null;
  // { sessionId, state, backdropEl, resolve, reject }
  // state = { sessionId, allPanels:[{uuid,name,img,role}], participantMode, label, helperDl, leaderDl }

  // =========================================================================
  // Lobby panel HTML
  // =========================================================================
  function buildLobbyPanelHtml(pd) {
    const isVideo = /\.(webm|mp4|ogg)(\?|$)/i.test(pd.img ?? "");
    const media   = isVideo
      ? `<video src="${esc(pd.img)}" autoplay loop muted playsinline preload="auto"></video>`
      : `<img src="${esc(pd.img)}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">`;

    return `
      <div class="oni-gc-panel is-${pd.role}" data-uuid="${esc(pd.uuid)}">
        <div class="oni-gc-portrait">${media}</div>
        <div class="oni-gc-actor-name" title="${esc(pd.name)}">${esc(pd.name)}</div>
        <div class="oni-gc-role-badge ${pd.role}" data-zone="badge"></div>
        <button class="oni-gc-btn" data-action="claim-leader" data-uuid="${esc(pd.uuid)}" style="display:none">👑 Lead</button>
        <button class="oni-gc-btn primary" data-action="participate" data-uuid="${esc(pd.uuid)}" style="display:none">✚ Participate</button>
        <button class="oni-gc-btn" data-action="leave" data-uuid="${esc(pd.uuid)}" style="display:none">✕ Leave</button>
      </div>`;
  }

  // =========================================================================
  // Open Lobby
  // =========================================================================
  function openLobby(data, isGM) {
    closeLobby();
    ensureStyles();
    const { sessionId, state } = data;
    const { allPanels, participantMode, label, helperDl, leaderDl } = state;

    const backdrop = document.createElement("div");
    backdrop.className = "oni-gc-backdrop";
    backdrop.id = "oni-gc-backdrop";

    const titleEl = document.createElement("div");
    titleEl.className = "oni-gc-title";
    titleEl.textContent = `Group Check${label ? ` — ${label}` : ""}`;
    backdrop.appendChild(titleEl);

    const subtitleEl = document.createElement("div");
    subtitleEl.className = "oni-gc-subtitle";
    if (participantMode === "open") {
      subtitleEl.textContent = "Choose a Leader — then Participate as Helper";
    } else {
      subtitleEl.textContent = `Helpers DL ${helperDl}  ▸  Leader DL ${leaderDl}`;
    }
    backdrop.appendChild(subtitleEl);

    const panelRow = document.createElement("div");
    panelRow.className = "oni-gc-panels";
    panelRow.innerHTML = allPanels.map(buildLobbyPanelHtml).join("");
    backdrop.appendChild(panelRow);

    // Stagger entrance
    panelRow.querySelectorAll(".oni-gc-panel").forEach((el, i) => {
      el.style.animationDelay = `${i * 70}ms`;
    });

    const controls = document.createElement("div");
    controls.className = "oni-gc-controls";
    if (isGM) {
      controls.innerHTML = `
        <button class="oni-gc-cancel-btn" id="oni-gc-cancel-btn">✕ Cancel</button>
        <button class="oni-gc-start-btn" id="oni-gc-start-btn" disabled>▶ Start Check</button>`;
    }
    backdrop.appendChild(controls);
    document.body.appendChild(backdrop);

    _lobbySession = {
      sessionId,
      state: { ...state, allPanels: allPanels.map(p => ({ ...p })) },
      backdropEl: backdrop,
      resolve: null,
      reject:  null,
    };

    for (const pd of allPanels) syncLobbyPanel(pd.uuid);
    updateStartButton();

    backdrop.addEventListener("click", ev => {
      const actionBtn = ev.target.closest("[data-action]");
      if (actionBtn) onLobbyBtnClick(actionBtn);

      if (isGM) {
        if (ev.target.id === "oni-gc-start-btn"  && !ev.target.disabled) onGMStart();
        if (ev.target.id === "oni-gc-cancel-btn") onGMCancel();
      }
    });
  }

  // =========================================================================
  // Sync one panel's DOM
  // =========================================================================
  function syncLobbyPanel(uuid) {
    const ses = _lobbySession;
    if (!ses) return;
    const pd = ses.state.allPanels.find(p => p.uuid === uuid);
    if (!pd) return;
    const el = ses.backdropEl?.querySelector(`.oni-gc-panel[data-uuid="${CSS.escape(uuid)}"]`);
    if (!el) return;

    const { participantMode } = ses.state;
    const hasLeader = ses.state.allPanels.some(p => p.role === "leader");
    const isOwner   = canOwnerAct(uuid);

    el.className = `oni-gc-panel is-${pd.role}`;

    const badge = el.querySelector("[data-zone='badge']");
    if (badge) {
      badge.className = `oni-gc-role-badge ${pd.role}`;
      if      (pd.role === "leader")   badge.textContent = "👑 Leader";
      else if (pd.role === "helper")   badge.textContent = "✚ Helper";
      else                             badge.textContent = participantMode === "open" ? "Not Joined" : "—";
    }

    const claimBtn = el.querySelector("[data-action='claim-leader']");
    const joinBtn  = el.querySelector("[data-action='participate']");
    const leaveBtn = el.querySelector("[data-action='leave']");
    const show = (btn, v) => { if (btn) btn.style.display = v ? "" : "none"; };

    if (participantMode === "open") {
      // Claim leader: visible to owner when this actor isn't already the leader
      show(claimBtn, pd.role !== "leader" && isOwner);
      // Participate: visible to owner when spectator AND a leader already exists
      show(joinBtn,  pd.role === "spectator" && hasLeader && isOwner);
      // Leave: visible to owner when helper
      show(leaveBtn, pd.role === "helper" && isOwner);
    } else {
      // Designated mode: roles are fixed, no interactive buttons
      show(claimBtn, false);
      show(joinBtn,  false);
      show(leaveBtn, false);
    }
  }

  function updateStartButton() {
    const ses = _lobbySession;
    if (!ses) return;
    const btn = ses.backdropEl?.querySelector("#oni-gc-start-btn");
    if (!btn) return;
    btn.disabled = !ses.state.allPanels.some(p => p.role === "leader");
  }

  // =========================================================================
  // Lobby button handlers
  // =========================================================================
  function onLobbyBtnClick(btn) {
    const ses = _lobbySession;
    if (!ses) return;
    const { action, uuid } = btn.dataset;
    if (!uuid || !canOwnerAct(uuid)) return;

    const pd = ses.state.allPanels.find(p => p.uuid === uuid);
    if (!pd) return;

    let newPanels = ses.state.allPanels.map(p => ({ ...p }));

    if (action === "claim-leader") {
      // Clear any existing leader → spectator, then set this actor as leader
      newPanels = newPanels.map(p => p.role === "leader" ? { ...p, role: "spectator" } : p);
      newPanels = newPanels.map(p => p.uuid === uuid    ? { ...p, role: "leader" }    : p);
    } else if (action === "participate") {
      newPanels = newPanels.map(p => p.uuid === uuid ? { ...p, role: "helper" }    : p);
    } else if (action === "leave") {
      newPanels = newPanels.map(p => p.uuid === uuid ? { ...p, role: "spectator" } : p);
    }

    ses.state = { ...ses.state, allPanels: newPanels };
    for (const p of newPanels) syncLobbyPanel(p.uuid);
    updateStartButton();

    // Broadcast state to all other clients
    game.socket.emit(SOCKET_CH, {
      type:    GC_SYNC,
      payload: { sessionId: ses.sessionId, allPanels: newPanels },
    });
  }

  // =========================================================================
  // GM start / cancel
  // =========================================================================
  function onGMStart() {
    const ses = _lobbySession;
    if (!ses) return;
    if (!ses.state.allPanels.some(p => p.role === "leader")) {
      ui.notifications?.warn("Group Check: No leader selected.");
      return;
    }
    game.socket.emit(SOCKET_CH, {
      type:    GC_START,
      payload: { sessionId: ses.sessionId, allPanels: ses.state.allPanels },
    });
    if (ses.resolve) ses.resolve(ses.state.allPanels);
    closeLobby();
  }

  function onGMCancel() {
    const ses = _lobbySession;
    if (!ses) return;
    game.socket.emit(SOCKET_CH, { type: GC_CLOSE, payload: { sessionId: ses.sessionId } });
    if (ses.reject) ses.reject(new Error("Group Check cancelled."));
    closeLobby();
  }

  // =========================================================================
  // Close lobby
  // =========================================================================
  function closeLobby() {
    _lobbySession?.backdropEl?.remove();
    _lobbySession = null;
  }

  // =========================================================================
  // Socket listener
  // =========================================================================
  function setupGCSocket() {
    if (window["__ONI_GC_SOCKET__"]) return;
    window["__ONI_GC_SOCKET__"] = true;

    game.socket.on(SOCKET_CH, msg => {
      if (!msg?.type?.startsWith("GC_")) return;

      if (msg.type === GC_LOBBY_OPEN) {
        // Only non-GM clients open the lobby from the socket; GM opens it directly
        if (!game.user?.isGM) openLobby(msg.payload, false);
        return;
      }

      if (msg.type === GC_SYNC) {
        const { sessionId, allPanels } = msg.payload ?? {};
        const ses = _lobbySession;
        if (!ses || ses.sessionId !== sessionId) return;
        ses.state = { ...ses.state, allPanels: allPanels.map(p => ({ ...p })) };
        for (const p of allPanels) syncLobbyPanel(p.uuid);
        updateStartButton();
        return;
      }

      if (msg.type === GC_START) {
        const { sessionId } = msg.payload ?? {};
        if (_lobbySession?.sessionId === sessionId) closeLobby();
        return;
      }

      if (msg.type === GC_CLOSE) {
        const { sessionId } = msg.payload ?? {};
        if (_lobbySession?.sessionId === sessionId) closeLobby();
        return;
      }
    });

    console.debug(TAG, "GC socket listener installed.");
  }

  // =========================================================================
  // Final group-check chat card
  // =========================================================================
  async function postGroupCheckChatCard(helperResults, leaderResult, bonus, opts) {
    const { label, helperDl, leaderDl, helperBonus, hiddenDl = false } = opts;
    const dlStr = dl => hiddenDl ? "?" : dl;
    const titleText = `Group Check${label ? ` — ${label}` : ""}`;

    const passClr   = "#2f8a3a", failClr = "#b33a2f",
          critClr   = "#7a5000", fumbClr = "#7a0000";

    const renderRow = (cp, _dl) => {
      let verdict, vColor, rowBg;
      if      (cp.isFumble)    { verdict = "FUMBLE";   vColor = fumbClr; rowBg = "rgba(122,0,0,.06)"; }
      else if (cp.isCrit)      { verdict = "CRITICAL!"; vColor = critClr; rowBg = "rgba(122,80,0,.06)"; }
      else if (cp.pass===true) { verdict = "✓ PASS";   vColor = passClr; rowBg = "rgba(46,125,50,.06)"; }
      else                     { verdict = "✗ FAIL";   vColor = failClr; rowBg = "rgba(179,58,47,.06)"; }
      const src = cp.tokenImg || "icons/svg/mystery-man.svg";
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 8px;
          border-radius:7px;background:${rowBg};margin-bottom:3px;">
          <img src="${esc(src)}" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;
            background:transparent!important;border:none!important;box-shadow:none!important;">
          <span style="flex:1;font-weight:800;font-size:.82rem;">${esc(cp.actorName)}</span>
          <span style="font-size:.78rem;opacity:.6;margin-right:6px;">Total ${cp.total}</span>
          <span style="font-weight:900;font-size:.8rem;color:${vColor};">${verdict}</span>
        </div>`;
    };

    const helperSection = helperResults.length > 0 ? `
      <div style="margin-bottom:8px;">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
          opacity:.45;margin-bottom:5px;">Helpers (DL ${dlStr(helperDl)})</div>
        ${helperResults.map(r => renderRow(r, helperDl)).join("")}
      </div>` : "";

    const passing    = helperResults.filter(r => r.pass && !r.isFumble).length;
    const bonusSec   = helperResults.length > 0 ? `
      <div style="text-align:center;padding:5px 10px;border-radius:7px;
        background:rgba(0,0,0,.05);border:1px dashed rgba(0,0,0,.15);
        margin-bottom:8px;font-size:.82rem;">
        <strong>${passing}</strong> helper${passing !== 1 ? "s" : ""} succeeded
        &nbsp;→&nbsp;
        <strong style="color:${bonus > 0 ? passClr : "inherit"}">+${bonus}</strong>
        bonus to Leader (${passing} × +${helperBonus})
      </div>` : "";

    const leaderSec = leaderResult ? `
      <div style="margin-bottom:8px;">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
          opacity:.45;margin-bottom:5px;">Leader (DL ${dlStr(leaderDl)})</div>
        ${renderRow(leaderResult, leaderDl)}
      </div>` : "";

    const finalPass  = leaderResult?.pass ?? false;
    const finalVerb  = finalPass ? "✓ GROUP CHECK PASSED" : "✗ GROUP CHECK FAILED";
    const finalClr   = finalPass ? passClr : failClr;
    const finalBg    = finalPass ? "rgba(46,125,50,.08)" : "rgba(179,58,47,.08)";

    const footer = leaderResult ? `
      <div style="margin-top:10px;padding:8px 12px;border-radius:9px;
        background:${finalBg};border:1.5px solid ${finalClr};text-align:center;">
        <span style="font-weight:900;font-size:.9rem;color:${finalClr};">${finalVerb}</span>
      </div>` : "";

    await ChatMessage.create({
      content: `
        <div style="font-family:inherit;padding:9px 11px 7px;border-radius:10px;
          background:linear-gradient(180deg,#f6ebd3,#e4d0b5);
          border:2px solid rgba(91,63,38,.8);color:#3b2a19;">
          <div style="font-weight:900;font-size:.92rem;margin-bottom:10px;
            border-bottom:1px solid rgba(0,0,0,.15);padding-bottom:5px;">
            👥 ${esc(titleText)}
          </div>
          ${helperSection}${bonusSec}${leaderSec}${footer}
        </div>`,
    }).catch(e => console.warn(TAG, "postGroupCheckChatCard failed:", e));
  }

  // =========================================================================
  // Main orchestration
  // =========================================================================
  async function request(opts = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} request() must run on the GM client.`);

    const {
      leaderUuid       = null,
      participantMode  = "open",
      helperActorUuids = [],
      allActorUuids    = [],
      helperDl         = 10,
      leaderDl         = 10,
      helperBonus      = 1,
      attrA            = "DEX",
      attrB            = "MIG",
      singleDie        = false,
      label            = "",
      allowInvokes     = true,
      postChat         = true,
      hiddenDl         = false,
    } = opts;

    const CR = globalThis.ONI?.CheckRequester;
    if (!CR?.request) throw new Error(`${TAG} ONI.CheckRequester not loaded.`);

    // Resolve all party actors up-front
    const allActors = (await Promise.all(allActorUuids.map(resolveActor))).filter(Boolean);

    let leaderActor, helperActors;

    // Lobby is needed when: no leader pre-set OR open participation mode
    const needsLobby = (leaderUuid === null) || (participantMode === "open");

    if (needsLobby) {
      const helperSet = new Set(helperActorUuids);
      const initialPanels = allActors.map(a => ({
        uuid: a.uuid,
        name: a.name,
        img:  getTokenImg(a),
        role: a.uuid === leaderUuid ? "leader"
            : (participantMode === "designated" && helperSet.has(a.uuid)) ? "helper"
            : "spectator",
      }));

      const sessionId  = foundry.utils.randomID();
      const lobbyState = {
        sessionId, allPanels: initialPanels,
        participantMode, label, helperDl, leaderDl, helperBonus,
      };
      const lobbyData = { sessionId, state: lobbyState };

      // Broadcast to player clients
      game.socket.emit(SOCKET_CH, { type: GC_LOBBY_OPEN, payload: lobbyData });

      // Open lobby on GM and wait for Start
      const finalPanels = await new Promise((resolve, reject) => {
        openLobby(lobbyData, true);
        if (_lobbySession) {
          _lobbySession.resolve = resolve;
          _lobbySession.reject  = reject;
        } else {
          reject(new Error("Failed to open lobby."));
        }
      });

      leaderActor  = await resolveActor(finalPanels.find(p => p.role === "leader")?.uuid ?? "");
      helperActors = (await Promise.all(
        finalPanels.filter(p => p.role === "helper").map(p => resolveActor(p.uuid))
      )).filter(Boolean);

    } else {
      // Designated mode with a pre-set leader — skip lobby
      leaderActor  = await resolveActor(leaderUuid);
      helperActors = (await Promise.all(helperActorUuids.map(resolveActor))).filter(Boolean);
    }

    if (!leaderActor) throw new Error(`${TAG} No leader actor resolved.`);

    // ── Phase A: Helper checks ─────────────────────────────────────────────
    let helperResults = [];
    if (helperActors.length > 0) {
      helperResults = await CR.request(helperActors, {
        attrA, attrB, singleDie,
        dl:                   helperDl,
        label:                label ? `${label} — Helpers` : "Group Check — Helpers",
        mode:                 "interactive",
        allowInvokes,
        postChat:             false,
        modifiers:            [],
        hiddenDl,
        skipGroupOutcomeSound: true,
        context:              { groupCheck: true, phase: "helper" },
      });
    }

    // ── Compute bonus ──────────────────────────────────────────────────────
    const passingHelpers = helperResults.filter(r => r.pass && !r.isFumble).length;
    const bonus          = passingHelpers * helperBonus;

    // ── Phase B: Leader check ──────────────────────────────────────────────
    const modifiers = bonus > 0
      ? [{ label: `Helper Bonus (${passingHelpers}×+${helperBonus})`, value: bonus }]
      : [];

    const leaderResults = await CR.request([leaderActor], {
      attrA, attrB, singleDie,
      dl:           leaderDl,
      label:        label ? `${label} — Leader` : "Group Check — Leader",
      mode:         "interactive",
      allowInvokes,
      postChat:     false,
      modifiers,
      hiddenDl,
      context:      { groupCheck: true, phase: "leader", bonus },
    });

    const leaderResult = leaderResults[0] ?? null;

    // ── Final chat card ────────────────────────────────────────────────────
    if (postChat) {
      await postGroupCheckChatCard(helperResults, leaderResult, bonus, {
        label, helperDl, leaderDl, helperBonus, hiddenDl,
      });
    }

    return {
      helperResults,
      leaderResult,
      bonus,
      leaderPass: leaderResult?.pass ?? false,
    };
  }

  // =========================================================================
  // Boot
  // =========================================================================
  ONI.GroupCheck = { request };

  Hooks.once("ready", () => {
    setupGCSocket();
    console.debug(TAG, "Ready. ONI.GroupCheck available.");
  });
})();
