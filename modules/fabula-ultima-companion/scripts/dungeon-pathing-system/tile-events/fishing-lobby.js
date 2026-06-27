// ============================================================================
// Dungeon Pathing — Fishing Participation Lobby
//
// A lightweight opt-in lobby shown when the party lands on a Fishing tile.
// Each party member gets a panel; their owner clicks "Fish" to join (or
// "Leave" to drop out). The GM starts once at least one member has joined.
//
// Visual style mirrors the Check Requester group-check lobby, slimmed down —
// no leader / ready / DL machinery, since fishing has none of those.
//
// Public API (GM only):
//   globalThis.ONI.FishingLobby.request({ allActorUuids, label })
//     → Promise<Actor[]>   resolves to the joined participants (in panel order)
//     → rejects if the GM cancels
//
// Socket (raw game.socket, FISHLOBBY_ prefix so it won't clash):
//   GM  → all  FISHLOBBY_OPEN    open the lobby on player clients
//   any → all  FISHLOBBY_SYNC    broadcast updated join state + sound cue
//   GM  → all  FISHLOBBY_START   close (GM started)
//   GM  → all  FISHLOBBY_CANCEL  close (GM cancelled)
// ============================================================================
(() => {
  const ONI       = globalThis.ONI ??= {};
  const TAG       = "[ONI][FishingLobby]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_FISHING_LOBBY__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  const FL_OPEN   = "FISHLOBBY_OPEN";
  const FL_SYNC   = "FISHLOBBY_SYNC";
  const FL_START  = "FISHLOBBY_START";
  const FL_CANCEL = "FISHLOBBY_CANCEL";

  // ── Helpers ────────────────────────────────────────────────────────────────
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

  const playSfx = name => globalThis.ONI?.CheckRequester?.Sound?.[name]?.();

  // ── Styles ───────────────────────────────────────────────────────────────
  const STYLE_ID = "oni-fl-style";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-fl-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,.62);
        z-index: 100010; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px; pointer-events: auto;
      }
      .oni-fl-title {
        font-size: 1.08rem; font-weight: 800; color: #cfeaff;
        text-shadow: 0 1px 5px rgba(0,0,0,.8); letter-spacing: .04em; text-align: center;
      }
      .oni-fl-subtitle {
        font-size: .82rem; color: rgba(207,234,255,.65);
        text-align: center; font-style: italic; margin-top: -10px;
      }
      .oni-fl-panels { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 760px; }
      @keyframes oni-fl-panel-in {
        from { opacity: 0; transform: translateY(18px) scale(.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .oni-fl-panel {
        width: 150px;
        background: linear-gradient(180deg, #0d1a24 0%, #162636 55%, #122130 100%);
        border: 2.5px solid rgba(30,74,107,.95); border-radius: 16px;
        box-shadow: 0 10px 26px rgba(0,0,0,.4), inset 0 1px 0 rgba(120,180,220,.18);
        color: #b8d4e8; display: flex; flex-direction: column; align-items: center;
        padding: 12px 10px 10px; gap: 7px;
        animation: oni-fl-panel-in 300ms cubic-bezier(.22,1,.36,1) both;
        transition: opacity .3s, filter .3s, border-color .25s, box-shadow .25s;
      }
      .oni-fl-panel.is-out { filter: grayscale(60%) brightness(.78); opacity: .52; }
      .oni-fl-panel.is-in {
        filter: none; opacity: 1; border-color: rgba(90,184,232,.95);
        box-shadow: 0 0 0 3px rgba(90,184,232,.35), 0 10px 26px rgba(0,0,0,.4);
      }
      .oni-fl-portrait { width: 78px; height: 78px; flex-shrink: 0; background: transparent !important; border: none !important; box-shadow: none !important; }
      .oni-fl-portrait img, .oni-fl-portrait video {
        width: 100%; height: 100%; display: block; object-fit: contain;
        background: transparent !important; border: none !important; outline: none !important; box-shadow: none !important;
      }
      .oni-fl-name { font-size: .82rem; font-weight: 800; text-align: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .oni-fl-badge { font-size: .72rem; font-weight: 800; padding: 2px 10px; border-radius: 6px; text-transform: uppercase; letter-spacing: .04em; }
      .oni-fl-badge.in  { background: rgba(90,184,232,.18); color: #6cc0ee; }
      .oni-fl-badge.out { background: rgba(0,0,0,.18); color: rgba(184,212,232,.45); font-style: italic; }
      .oni-fl-btn {
        font-size: .72rem; font-weight: 700; padding: 5px 8px; border-radius: 8px;
        border: 1.5px solid rgba(30,74,107,.9);
        background: linear-gradient(180deg, #1e3a52, #122433); color: #cfeaff;
        cursor: pointer; width: 100%; transition: filter .1s, transform .1s;
      }
      .oni-fl-btn:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
      .oni-fl-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; }
      .oni-fl-btn.primary { background: linear-gradient(180deg, #2a8ac8, #1e6a9a); border-color: #1e6a9a; color: #fff; }
      .oni-fl-controls { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 4px; }
      .oni-fl-start-btn {
        padding: 10px 30px; font-size: .9rem; font-weight: 800; border-radius: 12px;
        border: 2px solid #1e6a9a; background: linear-gradient(180deg, #2a8ac8, #1e6a9a);
        color: #fff; cursor: pointer; letter-spacing: .03em; box-shadow: 0 4px 12px rgba(0,0,0,.3);
        transition: filter .1s, transform .1s;
      }
      .oni-fl-start-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-fl-start-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; filter: none; }
      .oni-fl-cancel-btn {
        padding: 10px 18px; font-size: .84rem; font-weight: 700; border-radius: 12px;
        border: 1.5px solid rgba(30,74,107,.9);
        background: linear-gradient(180deg, #1e3a52, #122433); color: #cfeaff;
        cursor: pointer; transition: filter .1s;
      }
      .oni-fl-cancel-btn:hover { filter: brightness(1.1); }
    `;
    document.head.appendChild(s);
  }

  // ── Lobby session state ──────────────────────────────────────────────────
  let _session = null;
  // { sessionId, panels:[{uuid,name,img,joined}], label, backdropEl, resolve, reject }

  function panelHtml(pd) {
    const isVideo = /\.(webm|mp4|ogg)(\?|$)/i.test(pd.img ?? "");
    const media   = isVideo
      ? `<video src="${esc(pd.img)}" autoplay loop muted playsinline preload="auto"></video>`
      : `<img src="${esc(pd.img)}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">`;
    return `
      <div class="oni-fl-panel is-${pd.joined ? "in" : "out"}" data-uuid="${esc(pd.uuid)}">
        <div class="oni-fl-portrait">${media}</div>
        <div class="oni-fl-name" title="${esc(pd.name)}">${esc(pd.name)}</div>
        <div class="oni-fl-badge ${pd.joined ? "in" : "out"}" data-zone="badge"></div>
        <button class="oni-fl-btn primary" data-action="join"  data-uuid="${esc(pd.uuid)}" style="display:none">🎣 Fish</button>
        <button class="oni-fl-btn"         data-action="leave" data-uuid="${esc(pd.uuid)}" style="display:none">✕ Leave</button>
      </div>`;
  }

  function openLobby(data, isGM) {
    closeLobby();
    ensureStyles();
    const { sessionId, panels, label } = data;

    const backdrop = document.createElement("div");
    backdrop.className = "oni-fl-backdrop";

    const titleEl = document.createElement("div");
    titleEl.className = "oni-fl-title";
    titleEl.textContent = `🎣 Fishing${label ? ` — ${label}` : ""}`;
    backdrop.appendChild(titleEl);

    const subtitleEl = document.createElement("div");
    subtitleEl.className = "oni-fl-subtitle";
    subtitleEl.textContent = "Who wants to fish? Each angler plays once.";
    backdrop.appendChild(subtitleEl);

    const panelRow = document.createElement("div");
    panelRow.className = "oni-fl-panels";
    panelRow.innerHTML = panels.map(panelHtml).join("");
    backdrop.appendChild(panelRow);
    panelRow.querySelectorAll(".oni-fl-panel").forEach((el, i) => { el.style.animationDelay = `${i * 70}ms`; });

    const controls = document.createElement("div");
    controls.className = "oni-fl-controls";
    if (isGM) {
      controls.innerHTML = `
        <button class="oni-fl-cancel-btn" id="oni-fl-cancel-btn">✕ Cancel</button>
        <button class="oni-fl-start-btn"  id="oni-fl-start-btn" disabled>▶ Start Fishing</button>`;
    }
    backdrop.appendChild(controls);
    document.body.appendChild(backdrop);
    playSfx("playCheckStart");

    _session = {
      sessionId, label,
      panels: panels.map(p => ({ ...p })),
      backdropEl: backdrop,
      resolve: null, reject: null,
    };

    for (const pd of panels) syncPanel(pd.uuid);
    updateStartButton();

    backdrop.addEventListener("click", ev => {
      const actionBtn = ev.target.closest("[data-action]");
      if (actionBtn) onBtnClick(actionBtn);
      if (isGM) {
        if (ev.target.id === "oni-fl-start-btn" && !ev.target.disabled) onGMStart();
        if (ev.target.id === "oni-fl-cancel-btn") onGMCancel();
      }
    });
  }

  function syncPanel(uuid) {
    const ses = _session;
    if (!ses) return;
    const pd = ses.panels.find(p => p.uuid === uuid);
    if (!pd) return;
    const el = ses.backdropEl?.querySelector(`.oni-fl-panel[data-uuid="${CSS.escape(uuid)}"]`);
    if (!el) return;

    const isOwner = canOwnerAct(uuid);
    el.className = `oni-fl-panel is-${pd.joined ? "in" : "out"}`;

    const badge = el.querySelector("[data-zone='badge']");
    if (badge) {
      badge.className = `oni-fl-badge ${pd.joined ? "in" : "out"}`;
      badge.textContent = pd.joined ? "🎣 Fishing" : "Not Joined";
    }

    const joinBtn  = el.querySelector("[data-action='join']");
    const leaveBtn = el.querySelector("[data-action='leave']");
    const show = (btn, v) => { if (btn) btn.style.display = v ? "" : "none"; };
    show(joinBtn,  !pd.joined && isOwner);
    show(leaveBtn,  pd.joined && isOwner);
  }

  function updateStartButton() {
    const ses = _session;
    if (!ses) return;
    const btn = ses.backdropEl?.querySelector("#oni-fl-start-btn");
    if (btn) btn.disabled = !ses.panels.some(p => p.joined);
  }

  function onBtnClick(btn) {
    const ses = _session;
    if (!ses) return;
    const { action, uuid } = btn.dataset;
    if (!uuid || !canOwnerAct(uuid)) return;

    let sound = null;
    const panels = ses.panels.map(p => {
      if (p.uuid !== uuid) return { ...p };
      if (action === "join")  { sound = "playParticipantEnter"; return { ...p, joined: true }; }
      if (action === "leave") { sound = "playParticipantExit";  return { ...p, joined: false }; }
      return { ...p };
    });
    if (!sound) return;

    ses.panels = panels;
    for (const p of panels) syncPanel(p.uuid);
    updateStartButton();
    playSfx(sound);

    game.socket.emit(SOCKET_CH, { type: FL_SYNC, payload: { sessionId: ses.sessionId, panels, sound } });
  }

  function onGMStart() {
    const ses = _session;
    if (!ses) return;
    const joined = ses.panels.filter(p => p.joined);
    if (!joined.length) { ui.notifications?.warn("Fishing: no one has joined."); return; }
    game.socket.emit(SOCKET_CH, { type: FL_START, payload: { sessionId: ses.sessionId } });
    if (ses.resolve) ses.resolve(joined.map(p => p.uuid));
    closeLobby();
  }

  function onGMCancel() {
    const ses = _session;
    if (!ses) return;
    game.socket.emit(SOCKET_CH, { type: FL_CANCEL, payload: { sessionId: ses.sessionId } });
    if (ses.reject) ses.reject(new Error("Fishing lobby cancelled."));
    closeLobby();
  }

  function closeLobby() {
    _session?.backdropEl?.remove();
    _session = null;
  }

  // ── Socket listener ──────────────────────────────────────────────────────
  function setupSocket() {
    if (window["__ONI_FISHLOBBY_SOCKET__"]) return;
    window["__ONI_FISHLOBBY_SOCKET__"] = true;

    game.socket.on(SOCKET_CH, async msg => {
      if (!msg?.type?.startsWith("FISHLOBBY_")) return;

      if (msg.type === FL_OPEN) {
        // GM opens directly (in request()). Player clients open here, but only
        // party-member clients — spectator clients are not dragged into the lobby.
        if (game.user?.isGM) return;
        const allowed = await (globalThis.CampSystem?.isPartyMemberClient?.() ?? Promise.resolve(true));
        if (allowed) openLobby(msg.payload, false);
        return;
      }
      if (msg.type === FL_SYNC) {
        const { sessionId, panels, sound } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        ses.panels = panels.map(p => ({ ...p }));
        for (const p of panels) syncPanel(p.uuid);
        updateStartButton();
        if (sound) playSfx(sound);
        return;
      }
      if (msg.type === FL_START || msg.type === FL_CANCEL) {
        const { sessionId } = msg.payload ?? {};
        if (_session?.sessionId === sessionId) closeLobby();
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // ── Public API ───────────────────────────────────────────────────────────
  async function request({ allActorUuids = [], label = "" } = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} request() must run on the GM client.`);

    const actors = (await Promise.all(allActorUuids.map(resolveActor))).filter(Boolean);
    if (!actors.length) throw new Error(`${TAG} No party actors resolved.`);

    const panels = actors.map(a => ({
      uuid: a.uuid, name: a.name, img: getTokenImg(a), joined: false,
    }));
    const sessionId = foundry.utils.randomID();
    const data = { sessionId, panels, label };

    // Broadcast to player clients, open on GM, await Start/Cancel.
    game.socket.emit(SOCKET_CH, { type: FL_OPEN, payload: data });

    const joinedUuids = await new Promise((resolve, reject) => {
      openLobby(data, true);
      if (_session) { _session.resolve = resolve; _session.reject = reject; }
      else reject(new Error("Failed to open fishing lobby."));
    });

    return (await Promise.all(joinedUuids.map(resolveActor))).filter(Boolean);
  }

  ONI.FishingLobby = { request };

  Hooks.once("ready", () => {
    setupSocket();
    console.debug(TAG, "Ready. ONI.FishingLobby available.");
  });
})();
