// ============================================================================
// Camp Activity — Planning UI
//
// Stages:
//   1 — Ally Picker   : owner picks target; spectators wait
//   2 — Arena         : two tokens face each other; header + score
//   2b — Guessing     : per-question; both players pick hidden A or B
//   3 — Reveal        : sequential reveal of both picks per round
//   4 — Results       : final match count + bonus + "Click to Proceed"
//
// Sync flow:
//   GM broadcasts PLANNING_START          → all call show()
//   Owner picks ally → emits PLANNING_TARGET → GM resolves target
//   GM broadcasts PLANNING_ARENA          → all call showArena()
//   GM broadcasts PLANNING_QUESTION(q)    → all call showQuestion()
//   Owner picks → emits PLANNING_PICK_OWNER → GM resolves ownerPick
//   Target picks → emits PLANNING_PICK_TARGET → GM resolves targetPick
//   (loop × 3 — picks are hidden until reveal)
//   GM broadcasts PLANNING_REVEAL(q)      → all call showReveal()
//   (loop × 3)
//   GM broadcasts PLANNING_RESULT         → all call applyResult()
//   Owner clicks Proceed → emits PLANNING_PROCEED → GM resolves
//   GM broadcasts PLANNING_DONE           → all call hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][PlanningUI]";
  const OVL_ID    = "oni-camp-pl-ovl";
  const STYLE_ID  = "oni-camp-pl-style";

  const PLANNING_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Add/MastermindPassive2.png";

  const SFX = {
    BOOK_OPEN:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Book1.ogg",
    CURSOR_NAV: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    TOPIC_UP:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav",
    OVERWHELM:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    POSITIVE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
    NEGATIVE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/participant_exit.wav",
  };

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId    = null;
  let _actorName  = null;
  let _targetId   = null;
  let _targetName = null;
  let _ownerImg   = null;
  let _targetImg  = null;
  let _isOwner    = false;
  let _isTarget   = false;
  let _pickLocked = false;   // (kept for compatibility; per-role locks below)
  let _resultShown = false;
  // Guessing round: which question is open, and who has locked in. Locks
  // travel as MG.event "lock" (never the choice itself) so everyone sees
  // "Locked in" without spoiling the reveal.
  let _curQ  = -1;
  let _locks = { owner: false, target: false };

  // Web Audio
  let _audioCtx = null;
  let _hoverBuf = null;

  function _clearState() {
    _actorId     = null;
    _actorName   = null;
    _targetId    = null;
    _targetName  = null;
    _ownerImg    = null;
    _targetImg   = null;
    _isOwner     = false;
    _isTarget    = false;
    _pickLocked  = false;
    _resultShown = false;
    _curQ        = -1;
    _locks       = { owner: false, target: false };
  }

  // ---------------------------------------------------------------------------
  // Ownership helpers
  // ---------------------------------------------------------------------------
  // Shared minigame owner rule (camp-minigame-sync.js) — used for BOTH the
  // performer and the target (an unowned target is picked by the primary GM).
  function _getOwnerUserId(actor) {
    return actor ? (CAMP.MG?.ownerUserId?.(actor) ?? null) : null;
  }

  function _isOwnerOfActor(actor) {
    return actor ? !!CAMP.MG?.isOwner?.(actor) : false;
  }

  // ── Lock status line (visible to everyone during a guessing round) ───────
  function _renderLockStatus() {
    const el = document.getElementById("oni-pl-lock-status");
    if (!el) return;
    if (_curQ < 0) { el.style.display = "none"; return; }
    el.style.display = "";
    const chip = (name, on) =>
      `<span class="oni-pl-lock-chip${on ? " oni-pl-lock-on" : ""}">${name}: ${on ? "✓ Locked in" : "Choosing…"}</span>`;
    el.innerHTML = chip(_actorName ?? "?", _locks.owner) + chip(_targetName ?? "?", _locks.target);
  }

  function _setLock(role, q) {
    if (q !== _curQ || !(role in _locks) || _locks[role]) return false;
    _locks[role] = true;
    _renderLockStatus();
    return true;
  }

  // Picker whose own row was locked before a reload: show it as locked.
  function _markOwnRowLocked(role) {
    const row = document.querySelector(`#oni-pl-choices [data-role="${role}"]`)
      ?? (document.querySelector("#oni-pl-choices > .oni-pl-choice") ? document.getElementById("oni-pl-choices") : null);
    if (!row || row.dataset.locked === "1") return;
    row.dataset.locked = "1";
    row.querySelectorAll(".oni-pl-choice").forEach(b => { b.disabled = true; b.style.opacity = "0.3"; });
    const lockMsg = document.createElement("div");
    lockMsg.className = "oni-pl-spec-wait";
    lockMsg.textContent = "Locked in!";
    lockMsg.style.marginTop = "6px";
    row.appendChild(lockMsg);
  }

  // ---------------------------------------------------------------------------
  // Audio helpers
  // ---------------------------------------------------------------------------
  async function _initWebAudio() {
    try {
      _audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
      const buf = await fetch(SFX.CURSOR_NAV)
        .then(r => r.arrayBuffer())
        .then(b => _audioCtx.decodeAudioData(b));
      _hoverBuf = buf;
    } catch {}
  }

  function _playBuf(buf) {
    if (!_audioCtx || !buf) return;
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    try {
      const src = _audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_audioCtx.destination);
      src.start(0);
    } catch {}
  }

  function _playSound(src, volume = 0.7) {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      if (AH) { AH.play({ src, volume, autoplay: true, loop: false }, false); return; }
    } catch {}
    try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Overlay shell ── */
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 10000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(10,8,6,.82);
        animation: oni-pl-fadein .25s ease;
      }
      #${OVL_ID}.oni-pl-out {
        animation: oni-pl-fadeout .3s ease forwards;
      }
      @keyframes oni-pl-fadein  { from { opacity:0 } to { opacity:1 } }
      @keyframes oni-pl-fadeout { from { opacity:1 } to { opacity:0 } }

      /* ── Panel (ally picker / waiting) ── */
      .oni-pl-panel {
        background: linear-gradient(160deg,#2a1f10,#1a1208);
        border: 2px solid #7a5a2a;
        border-radius: 12px;
        padding: 28px 36px;
        min-width: 320px;
        max-width: 520px;
        color: #e8d9b8;
        font-family: "Signika", serif;
        box-shadow: 0 8px 32px #0008;
      }
      .oni-pl-panel-title {
        display: flex; align-items: center; gap: 10px;
        font-size: 1.25em; font-weight: 700; color: #d4a853;
        margin-bottom: 14px;
      }
      .oni-pl-panel-title img { width:32px; height:32px; border:none; border-radius:6px; }
      .oni-pl-panel-sub { font-size:.9em; color:#bba87a; margin-bottom: 16px; }
      .oni-pl-waiting { font-size:.92em; color:#bba87a; font-style:italic; text-align:center; padding: 12px 0; }

      /* ── Ally grid ── */
      .oni-pl-ally-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: 10px;
        margin-top: 6px;
      }
      .oni-pl-ally-card {
        display: flex; flex-direction: column; align-items: center;
        gap: 6px; padding: 10px 8px;
        background: #1e160a; border: 1px solid #5a3f1a;
        border-radius: 8px; cursor: pointer;
        transition: border-color .15s, background .15s;
        font-size: .82em; color: #d4c49a;
      }
      .oni-pl-ally-card:hover {
        border-color: #d4a853; background: #2e2010;
      }
      .oni-pl-ally-card img {
        width: 60px; height: 60px; border: none;
        object-fit: contain; border-radius: 4px;
      }

      /* ── Arena wrap ── */
      .oni-pl-arena-wrap {
        background: linear-gradient(160deg,#2a1f10,#1a1208);
        border: 2px solid #7a5a2a;
        border-radius: 12px;
        padding: 24px 28px 20px;
        width: 540px;
        color: #e8d9b8;
        font-family: "Signika", serif;
        box-shadow: 0 8px 32px #0008;
        display: flex; flex-direction: column; gap: 16px;
      }

      /* ── Question header ── */
      .oni-pl-q-header {
        text-align: center;
        font-size: .82em; font-weight: 600;
        color: #9a8060; letter-spacing: .06em; text-transform: uppercase;
      }

      /* ── Stage: two tokens ── */
      .oni-pl-stage {
        display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
      }
      .oni-pl-side {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        flex: 0 0 auto;
      }
      .oni-pl-token-wrap { position: relative; }
      .oni-pl-token {
        width: 90px; height: 90px;
        border: none; background: transparent; object-fit: contain;
      }
      .oni-pl-token-flip { transform: scaleX(-1); }
      .oni-pl-side-name {
        font-size: .76em; color: #bba87a; text-align: center;
        text-shadow: 0 1px 3px #000a; max-width: 90px;
      }

      /* ── Center column ── */
      .oni-pl-center-col {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px;
      }

      /* ── Speech bubble ── */
      .oni-pl-bubble {
        background: #f5efe0;
        border: 2px solid #d4a853;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: .88em; color: #3a2810; font-weight: 600;
        text-align: center; width: 100%;
        box-shadow: 0 2px 8px #0006;
        animation: oni-pl-bubble-in .35s cubic-bezier(.22,1,.36,1);
      }
      @keyframes oni-pl-bubble-in {
        from { opacity:0; transform:scale(.88) translateY(-6px) }
        to   { opacity:1; transform:scale(1)  translateY(0) }
      }

      /* ── Score HUD ── */
      .oni-pl-score-hud {
        font-size: .78em; color: #9a8060;
      }
      .oni-pl-score-hud span { color: #d4a853; font-weight: 700; }

      /* ── Choice buttons ── */
      .oni-pl-choices {
        display: flex; gap: 12px; justify-content: center;
      }
      .oni-pl-choice {
        flex: 1; padding: 10px 12px;
        background: #1e160a; border: 2px solid #5a3f1a;
        border-radius: 8px; cursor: pointer;
        color: #e8d9b8; font-family: "Signika", serif;
        font-size: .88em; font-weight: 600;
        display: flex; align-items: center; gap: 8px;
        transition: border-color .15s, background .15s, opacity .15s;
        text-align: left;
      }
      .oni-pl-choice:not(:disabled):hover {
        border-color: #d4a853; background: #2e2010;
      }
      .oni-pl-choice:disabled { cursor: default; }
      .oni-pl-c-badge {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; border-radius: 50%;
        background: #5a3f1a; color: #d4a853;
        font-size: .78em; font-weight: 700; flex-shrink: 0;
      }
      .oni-pl-choice-locked {
        border-color: #3a8a3a !important;
        background: #0e2010 !important;
        opacity: 1 !important;
      }
      .oni-pl-choice-locked .oni-pl-c-badge { background: #3a8a3a; color: #c8ffc8; }

      /* ── Spectator waiting line ── */
      .oni-pl-spec-wait {
        text-align: center; font-size: .82em; color: #9a8060; font-style: italic;
      }
      /* ── Lock status (who has locked in; never which choice) ── */
      .oni-pl-lock-status {
        display: flex; gap: 16px; justify-content: center;
        font-size: .8em; color: #9a8060; font-style: italic;
      }
      .oni-pl-lock-chip.oni-pl-lock-on { color: #7ad47a; font-style: normal; font-weight: 700; }
      /* ── One client picking for both sides: one row per side ── */
      .oni-pl-choices.oni-pl-dual { flex-direction: column; gap: 10px; }
      .oni-pl-pick-row { display: flex; flex-direction: column; gap: 6px; width: 100%; }
      .oni-pl-pick-row-btns { display: flex; gap: 12px; justify-content: center; }
      .oni-pl-pick-row-label { font-size: .8em; color: #d4a853; font-weight: 700; text-align: center; }
      /* ── Spectator ally picker: read-only, owner's hover mirrored ── */
      .oni-pl-spectate .oni-pl-ally-card { cursor: default; }
      .oni-pl-spectate .oni-pl-ally-card:hover:not(.oni-pl-remote-hover) { border-color: #5a3f1a; background: #1e160a; }
      .oni-pl-ally-card.oni-pl-remote-hover { border-color: #d4a853; background: #2e2010; }
      .oni-pl-ally-card.oni-pl-remote-pick  { border-color: #d4a853; background: #2e2010; box-shadow: 0 0 0 2px rgba(212,168,83,.55); }

      /* ── Reveal: pick cards ── */
      .oni-pl-reveal-row {
        display: flex; gap: 14px; justify-content: center; align-items: stretch;
      }
      .oni-pl-reveal-card {
        flex: 1; padding: 10px 12px;
        background: #1e160a; border: 2px solid #5a3f1a;
        border-radius: 8px; color: #e8d9b8;
        font-size: .84em; font-weight: 600;
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        text-align: center;
        opacity: 0; transform: translateY(6px);
        transition: opacity .35s ease, transform .35s ease, border-color .2s;
      }
      .oni-pl-reveal-card.oni-pl-show {
        opacity: 1; transform: translateY(0);
      }
      .oni-pl-reveal-card img {
        width: 40px; height: 40px; border: none; object-fit: contain; border-radius: 4px;
      }
      .oni-pl-reveal-name { font-size: .72em; color: #9a8060; }
      .oni-pl-reveal-choice {
        font-size: .9em; font-weight: 700; color: #d4a853;
        padding: 4px 10px; border-radius: 6px; background: #2a1f0a;
      }
      .oni-pl-reveal-card.oni-pl-rc-a { border-color: #4a7acc; }
      .oni-pl-reveal-card.oni-pl-rc-b { border-color: #cc7a2a; }
      .oni-pl-reveal-card.oni-pl-rc-a .oni-pl-reveal-choice { color: #7ab4ff; }
      .oni-pl-reveal-card.oni-pl-rc-b .oni-pl-reveal-choice { color: #ffb47a; }

      /* ── Match badge ── */
      .oni-pl-match-badge {
        text-align: center; font-size: 1em; font-weight: 700;
        padding: 6px 18px; border-radius: 20px;
        opacity: 0; transform: scale(.8);
        transition: opacity .3s ease .5s, transform .3s ease .5s;
        margin: 0 auto;
      }
      .oni-pl-match-badge.oni-pl-show { opacity:1; transform: scale(1); }
      .oni-pl-match-badge.oni-pl-match    { background: #1a3a1a; color: #6aff6a; border: 2px solid #3a8a3a; }
      .oni-pl-match-badge.oni-pl-no-match { background: #3a1a1a; color: #ff8a8a; border: 2px solid #8a3a3a; }

      /* ── Token animations ── */
      @keyframes oni-pl-bounce {
        0%,100% { transform:translateY(0) }
        20%      { transform:translateY(-14px) }
        40%      { transform:translateY(-4px) }
        60%      { transform:translateY(-10px) }
        80%      { transform:translateY(-2px) }
      }
      @keyframes oni-pl-bounce-flip {
        0%,100% { transform:scaleX(-1) translateY(0) }
        20%      { transform:scaleX(-1) translateY(-14px) }
        40%      { transform:scaleX(-1) translateY(-4px) }
        60%      { transform:scaleX(-1) translateY(-10px) }
        80%      { transform:scaleX(-1) translateY(-2px) }
      }
      @keyframes oni-pl-droop {
        0%   { transform:translateY(0) rotate(0deg) }
        40%  { transform:translateY(6px) rotate(-4deg) }
        100% { transform:translateY(4px) rotate(-2deg) }
      }
      @keyframes oni-pl-droop-flip {
        0%   { transform:scaleX(-1) translateY(0) rotate(0deg) }
        40%  { transform:scaleX(-1) translateY(6px) rotate(4deg) }
        100% { transform:scaleX(-1) translateY(4px) rotate(2deg) }
      }
      .oni-pl-anim-bounce      { animation: oni-pl-bounce      .9s ease; }
      .oni-pl-anim-bounce-flip { animation: oni-pl-bounce-flip .9s ease; }
      .oni-pl-anim-droop       { animation: oni-pl-droop       .8s ease forwards; }
      .oni-pl-anim-droop-flip  { animation: oni-pl-droop-flip  .8s ease forwards; }

      /* ── Emote pop ── */
      .oni-pl-emote-pop {
        position: absolute; top: -8px; right: -8px;
        font-size: 1.3em; pointer-events: none;
        animation: oni-pl-emote-anim 2s ease forwards;
      }
      @keyframes oni-pl-emote-anim {
        0%   { opacity:0; transform:translateY(0) scale(.6) }
        20%  { opacity:1; transform:translateY(-6px) scale(1.1) }
        70%  { opacity:1; transform:translateY(-10px) scale(1) }
        100% { opacity:0; transform:translateY(-14px) scale(.9) }
      }

      /* ── Proceed button ── */
      .oni-pl-proceed-btn {
        width: 100%; padding: 10px;
        background: #3a2810; border: 2px solid #d4a853;
        border-radius: 8px; color: #d4a853;
        font-family: "Signika", serif; font-size: .9em; font-weight: 700;
        cursor: pointer; letter-spacing: .04em;
        transition: background .15s;
      }
      .oni-pl-proceed-btn:hover { background: #4a3420; }
      .oni-pl-proceed-btn:disabled { opacity: .5; cursor: default; }

      /* ── Results ── */
      .oni-pl-result-wrap {
        background: linear-gradient(160deg,#2a1f10,#1a1208);
        border: 2px solid #7a5a2a; border-radius: 12px;
        padding: 28px 36px; width: 480px;
        color: #e8d9b8; font-family: "Signika", serif;
        box-shadow: 0 8px 32px #0008;
        display: flex; flex-direction: column; gap: 14px;
        align-items: center; text-align: center;
      }
      .oni-pl-result-title { font-size: 1.15em; font-weight: 700; color: #d4a853; }
      .oni-pl-result-portraits {
        display: flex; align-items: center; gap: 16px;
      }
      .oni-pl-result-portrait {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        font-size: .78em; color: #9a8060;
      }
      .oni-pl-result-portrait img {
        width: 64px; height: 64px; border: none; object-fit: contain; border-radius: 6px;
      }
      .oni-pl-result-icon { font-size: 1.6em; }
      .oni-pl-result-score { font-size: 1.25em; font-weight: 700; letter-spacing: .04em; }
      .oni-pl-result-score.oni-pl-grade-3 { color: #c8a84b; }
      .oni-pl-result-score.oni-pl-grade-2 { color: #3a9a3a; }
      .oni-pl-result-score.oni-pl-grade-1 { color: #3a7acc; }
      .oni-pl-result-score.oni-pl-grade-0 { color: #8a6a3a; }
      .oni-pl-result-grade { font-size: .88em; color: #bba87a; font-style: italic; }
      .oni-pl-result-fx    { font-size: 1em; font-weight: 700; color: #7ab4ff; }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Internal: build arena layout
  // ---------------------------------------------------------------------------
  function _buildArena() {
    document.getElementById(OVL_ID)?.remove();
    _ensureStyle();

    const ovl = document.createElement("div");
    ovl.id = OVL_ID;
    ovl.innerHTML = `
      <div class="oni-pl-arena-wrap">
        <div class="oni-pl-q-header" id="oni-pl-q-header">Planning &middot; Question 1/3</div>

        <div class="oni-pl-stage">
          <div class="oni-pl-side">
            <div class="oni-pl-token-wrap">
              <img class="oni-pl-token oni-pl-token-flip" id="oni-pl-tok-owner"
                   src="${_ownerImg}" alt="${_actorName}">
            </div>
            <div class="oni-pl-side-name">${_actorName}</div>
          </div>

          <div class="oni-pl-center-col">
            <div class="oni-pl-bubble" id="oni-pl-bubble">
              <span id="oni-pl-bubble-txt">&hellip;</span>
            </div>
            <div class="oni-pl-score-hud">Matches: <span id="oni-pl-score">0</span>/3</div>
          </div>

          <div class="oni-pl-side">
            <div class="oni-pl-token-wrap" id="oni-pl-tok-wrap-target" style="position:relative;">
              <img class="oni-pl-token" id="oni-pl-tok-target"
                   src="${_targetImg}" alt="${_targetName}">
            </div>
            <div class="oni-pl-side-name">${_targetName}</div>
          </div>
        </div>

        <div class="oni-pl-choices" id="oni-pl-choices"></div>
        <div class="oni-pl-lock-status" id="oni-pl-lock-status" style="display:none;"></div>

        <button class="oni-pl-proceed-btn" id="oni-pl-proceed" style="display:none;">
          Click to Proceed
        </button>
      </div>
    `;

    document.body.appendChild(ovl);
  }

  // ---------------------------------------------------------------------------
  // Internal: render choice buttons for a guessing round
  // ---------------------------------------------------------------------------
  function _renderGuessChoices(actorId, targetActorId, q, question) {
    const wrap = document.getElementById("oni-pl-choices");
    if (!wrap) return;
    wrap.innerHTML = "";

    wrap.classList.remove("oni-pl-dual");
    delete wrap.dataset.locked;   // per-question lock flag (single-side layout)

    // A client can own BOTH sides (e.g. the GM playing two unowned actors):
    // it then gets one pick row per side, or the second pick never arrives.
    const roles = [];
    if (_isOwner)  roles.push("owner");
    if (_isTarget) roles.push("target");

    if (roles.length) {
      const dual = roles.length > 1;
      if (dual) wrap.classList.add("oni-pl-dual");

      const choices = [
        { label: question.a, idx: 0, badge: "A", cls: "oni-pl-rc-a" },
        { label: question.b, idx: 1, badge: "B", cls: "oni-pl-rc-b" },
      ];

      roles.forEach(role => {
        const msgType = role === "owner" ? CAMP.MSG.PLANNING_PICK_OWNER : CAMP.MSG.PLANNING_PICK_TARGET;
        // Single side: buttons sit directly in the choices row (unchanged look).
        let row = wrap, btnBox = wrap;
        if (dual) {
          row = document.createElement("div");
          row.className = "oni-pl-pick-row";
          row.dataset.role = role;
          row.innerHTML = `<div class="oni-pl-pick-row-label">${role === "owner" ? _actorName : _targetName}</div>`;
          btnBox = document.createElement("div");
          btnBox.className = "oni-pl-pick-row-btns";
          row.appendChild(btnBox);
          wrap.appendChild(row);
        }
        let rowLocked = false;

        choices.forEach(({ label, idx, badge, cls }) => {
          const btn = document.createElement("button");
          btn.className = `oni-pl-choice ${cls}`;
          btn.dataset.idx = idx;
          btn.innerHTML = `<span class="oni-pl-c-badge">${badge}</span><span>${label}</span>`;

          // Hover sound stays local: the pick is secret, so the cursor is not mirrored.
          btn.addEventListener("mouseenter", () => _playBuf(_hoverBuf));
          btn.addEventListener("click", () => {
            if (rowLocked || row.dataset.locked === "1") return;
            rowLocked = true;
            row.dataset.locked = "1";
            _pickLocked = true;

            // Lock both buttons visually
            btnBox.querySelectorAll(".oni-pl-choice").forEach(b => {
              b.disabled = true;
              if (parseInt(b.dataset.idx) === idx) {
                b.classList.add("oni-pl-choice-locked");
              } else {
                b.style.opacity = "0.3";
              }
            });

            // Add "Locked in!" text
            const lockMsg = document.createElement("div");
            lockMsg.className = "oni-pl-spec-wait";
            lockMsg.textContent = "Locked in!";
            lockMsg.style.marginTop = "6px";
            row.appendChild(lockMsg);

            // Tell everyone THAT this side locked (not what it picked).
            _setLock(role, q);
            CAMP.MG?.event?.("PLANNING", actorId, "lock", { role, q });

            // send(): reaches the GM resolver even when this client IS the GM.
            CAMP.Socket.send(msgType, {
              actorId,
              targetActorId,
              choiceIdx: idx,
            });
          }, { once: true });

          btnBox.appendChild(btn);
        });
      });
    } else {
      // Spectator
      const spec = document.createElement("div");
      spec.className = "oni-pl-spec-wait";
      spec.textContent = "Both players are choosing…";
      wrap.appendChild(spec);
    }
    _renderLockStatus();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.PlanningUI = {
    targetResolvers:     {},
    ownerPickResolvers:  {},
    targetPickResolvers: {},
    proceedResolvers:    {},

    // ── Stage 1: Ally Picker ────────────────────────────────────────────────
    show(actorId, actorName, allies) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _initWebAudio();

      _actorId   = actorId;
      _actorName = actorName;

      const actorObj = game.actors?.get(actorId);
      _isOwner  = _isOwnerOfActor(actorObj);
      _isTarget = false;

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      const cards = (allies ?? []).map(a => `
          <div class="oni-pl-ally-card" data-target-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <span>${a.name}</span>
          </div>
        `).join("");

      if (_isOwner) {
        ovl.innerHTML = `
          <div class="oni-pl-panel">
            <div class="oni-pl-panel-title">
              <img src="${PLANNING_ICON}" alt=""> Planning
            </div>
            <div class="oni-pl-panel-sub">Who would you like to strategize with?</div>
            <div class="oni-pl-ally-grid">${cards}</div>
          </div>
        `;

        let picked = false;
        ovl.querySelectorAll(".oni-pl-ally-card").forEach(card => {
          card.addEventListener("mouseenter", () => {
            if (!picked) CAMP.MG?.event?.("PLANNING", actorId, "hover", { targetId: card.dataset.targetId });
          });
          card.addEventListener("mouseleave", () => {
            if (!picked) CAMP.MG?.event?.("PLANNING", actorId, "hover", { targetId: null });
          });
          card.addEventListener("click", () => {
            const tid = card.dataset.targetId;
            if (!tid || picked) return;
            picked = true;
            CAMP.MG?.event?.("PLANNING", actorId, "pick", { targetId: tid });
            // send(): a GM-owner reaches its own resolver through the router.
            CAMP.Socket.send(CAMP.MSG.PLANNING_TARGET, { actorId, targetActorId: tid });
          }, { once: true });
        });
      } else {
        const ownerUid  = _getOwnerUserId(actorObj);
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? actorName) : actorName;
        // Spectators see the same cards (read-only) with the owner's cursor mirrored.
        ovl.innerHTML = `
          <div class="oni-pl-panel oni-pl-spectate" style="text-align:center;">
            <div class="oni-pl-panel-title" style="justify-content:center;">
              <img src="${PLANNING_ICON}" alt=""> Planning
            </div>
            <div class="oni-pl-panel-sub">Who would you like to strategize with?</div>
            <div class="oni-pl-ally-grid">${cards}</div>
            <div class="oni-pl-waiting">Waiting for ${ownerName} to choose a target…</div>
          </div>
        `;
      }

      document.body.appendChild(ovl);
      _playSound(SFX.BOOK_OPEN, 0.65);
    },

    resolveTarget(actorId, targetActorId) {
      const r = this.targetResolvers?.[actorId];
      if (!r) return;
      delete this.targetResolvers[actorId];
      r(targetActorId);
    },

    // ── Stage 2: Arena Frame ────────────────────────────────────────────────
    showArena(actorId, actorName, targetActorId, targetActorName, targetImg, ownerImg) {
      _actorId    = actorId;
      _actorName  = actorName;
      _targetId   = targetActorId;
      _targetName = targetActorName;
      _ownerImg   = ownerImg;
      _targetImg  = targetImg;
      _pickLocked = false;

      const actorObj  = game.actors?.get(actorId);
      const targetObj = game.actors?.get(targetActorId);
      _isOwner  = _isOwnerOfActor(actorObj);
      _isTarget = _isOwnerOfActor(targetObj);

      _buildArena();
      _playSound(SFX.BOOK_OPEN, 0.7);
    },

    // ── Stage 2b: Guessing Round ────────────────────────────────────────────
    showQuestion(actorId, targetActorId, q, question) {
      _pickLocked = false;
      if (q !== _curQ) { _curQ = q; _locks = { owner: false, target: false }; }
      // Late join / replay: showArena may not have run on this page.
      if (!_targetId && targetActorId) {
        _actorId  = actorId;
        _targetId = targetActorId;
        _isOwner  = _isOwnerOfActor(game.actors?.get(actorId));
        _isTarget = _isOwnerOfActor(game.actors?.get(targetActorId));
      }

      if (!document.getElementById(OVL_ID)) _buildArena();

      // Update header
      const header = document.getElementById("oni-pl-q-header");
      if (header) header.textContent = `Planning · Question ${q + 1}/3`;

      // Animate bubble in
      const bubble    = document.getElementById("oni-pl-bubble");
      const bubbleTxt = document.getElementById("oni-pl-bubble-txt");
      if (bubble && bubbleTxt) {
        bubble.style.animation = "none";
        bubble.offsetWidth;
        bubble.style.animation = "";
        bubbleTxt.textContent = `${question.a} or ${question.b}?`;
        _playSound(SFX.TOPIC_UP, 0.75);
      }

      _renderGuessChoices(actorId, targetActorId, q, question);
    },

    resolveOwnerPick(actorId, choiceIdx) {
      const r = this.ownerPickResolvers?.[actorId];
      if (!r) return;
      delete this.ownerPickResolvers[actorId];
      r(choiceIdx);
    },

    resolveTargetPick(targetActorId, choiceIdx) {
      const r = this.targetPickResolvers?.[targetActorId];
      if (!r) return;
      delete this.targetPickResolvers[targetActorId];
      r(choiceIdx);
    },

    // ── Stage 3: Reveal ─────────────────────────────────────────────────────
    showReveal(actorId, targetActorId, q, question, ownerChoice, targetChoice, match, score) {
      if (!document.getElementById(OVL_ID)) _buildArena();
      _curQ = -1;   // guessing over: hide the lock line
      _renderLockStatus();

      // Update header
      const header = document.getElementById("oni-pl-q-header");
      if (header) header.textContent = `Planning · Reveal ${q + 1}/3`;

      // Update bubble
      const bubbleTxt = document.getElementById("oni-pl-bubble-txt");
      if (bubbleTxt) bubbleTxt.textContent = `${question.a} or ${question.b}?`;

      // Update score
      const scoreEl = document.getElementById("oni-pl-score");
      if (scoreEl) scoreEl.textContent = score;

      // Build reveal row
      const wrap = document.getElementById("oni-pl-choices");
      if (wrap) {
        const ownerLabel = ownerChoice === 0 ? question.a : question.b;
        const targetLabel = targetChoice === 0 ? question.a : question.b;
        const ownerCls  = ownerChoice === 0 ? "oni-pl-rc-a" : "oni-pl-rc-b";
        const targetCls = targetChoice === 0 ? "oni-pl-rc-a" : "oni-pl-rc-b";

        wrap.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:10px;width:100%;align-items:center;">
            <div class="oni-pl-reveal-row" style="width:100%;">
              <div class="oni-pl-reveal-card ${ownerCls}" id="oni-pl-rev-owner">
                <img src="${_ownerImg}" alt="${_actorName}">
                <div class="oni-pl-reveal-name">${_actorName}</div>
                <div class="oni-pl-reveal-choice">${ownerLabel}</div>
              </div>
              <div class="oni-pl-reveal-card ${targetCls}" id="oni-pl-rev-target">
                <img src="${_targetImg}" alt="${_targetName}">
                <div class="oni-pl-reveal-name">${_targetName}</div>
                <div class="oni-pl-reveal-choice">${targetLabel}</div>
              </div>
            </div>
            <div class="oni-pl-match-badge ${match ? "oni-pl-match" : "oni-pl-no-match"}" id="oni-pl-match-badge">
              ${match ? "✓ Match!" : "✗ No Match"}
            </div>
          </div>
        `;

        // Stagger reveal animations
        setTimeout(() => {
          document.getElementById("oni-pl-rev-owner")?.classList.add("oni-pl-show");
          _playBuf(_hoverBuf);
        }, 200);

        setTimeout(() => {
          document.getElementById("oni-pl-rev-target")?.classList.add("oni-pl-show");
          _playBuf(_hoverBuf);
        }, 700);

        setTimeout(() => {
          document.getElementById("oni-pl-match-badge")?.classList.add("oni-pl-show");

          // Token animations
          const tokOwner  = document.getElementById("oni-pl-tok-owner");
          const tokTarget = document.getElementById("oni-pl-tok-target");
          const tokWrap   = document.getElementById("oni-pl-tok-wrap-target");

          if (match) {
            _playSound(SFX.OVERWHELM, 0.8);
            if (tokOwner) {
              tokOwner.classList.remove("oni-pl-anim-bounce-flip", "oni-pl-anim-droop-flip");
              tokOwner.offsetWidth;
              tokOwner.classList.add("oni-pl-anim-bounce-flip");
            }
            if (tokTarget) {
              tokTarget.classList.remove("oni-pl-anim-bounce", "oni-pl-anim-droop");
              tokTarget.offsetWidth;
              tokTarget.classList.add("oni-pl-anim-bounce");
            }
            if (tokWrap) {
              tokWrap.querySelectorAll(".oni-pl-emote-pop").forEach(e => e.remove());
              const emote = document.createElement("div");
              emote.className = "oni-pl-emote-pop";
              emote.textContent = "✓";
              tokWrap.appendChild(emote);
              setTimeout(() => emote.remove(), 2000);
            }
          } else {
            _playSound(SFX.NEGATIVE, 0.7);
            if (tokOwner) {
              tokOwner.classList.remove("oni-pl-anim-bounce-flip", "oni-pl-anim-droop-flip");
              tokOwner.offsetWidth;
              tokOwner.classList.add("oni-pl-anim-droop-flip");
            }
            if (tokTarget) {
              tokTarget.classList.remove("oni-pl-anim-bounce", "oni-pl-anim-droop");
              tokTarget.offsetWidth;
              tokTarget.classList.add("oni-pl-anim-droop");
            }
          }
        }, 1100);
      }
    },

    // ── Stage 4: Results ────────────────────────────────────────────────────
    applyResult(actorId, targetActorId, matchCount, bonus) {
      if (_resultShown) return;
      _resultShown = true;

      document.getElementById(OVL_ID)?.remove();
      _ensureStyle();

      const actorObj  = game.actors?.get(actorId);
      const targetObj = game.actors?.get(targetActorId);

      _isOwner = _isOwnerOfActor(actorObj);

      const ownerImgSrc  = _ownerImg  || (actorObj  ? _getTokenImgFromActor(actorObj)  : "");
      const targetImgSrc = _targetImg || (targetObj ? _getTokenImgFromActor(targetObj) : "");
      const ownerName    = actorObj?.name  ?? actorId;
      const targetName   = targetObj?.name ?? targetActorId;

      const stars =
        matchCount === 3 ? "★★★" :
        matchCount === 2 ? "★★☆" :
        matchCount === 1 ? "★☆☆" :
                           "☆☆☆";

      const gradeClass = `oni-pl-grade-${matchCount}`;

      const flavorLine =
        matchCount === 3 ? "A perfect read — you think alike." :
        matchCount === 2 ? "Mostly on the same page." :
        matchCount === 1 ? "At least one instinct aligned." :
                           "Different minds… perhaps that's fine too.";

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;
      ovl.innerHTML = `
        <div class="oni-pl-result-wrap">
          <div class="oni-pl-result-title">Planning — Complete!</div>

          <div class="oni-pl-result-portraits">
            <div class="oni-pl-result-portrait">
              <img src="${ownerImgSrc}" alt="${ownerName}">
              <span>${ownerName}</span>
            </div>
            <div class="oni-pl-result-icon">⚔️</div>
            <div class="oni-pl-result-portrait">
              <img src="${targetImgSrc}" alt="${targetName}">
              <span>${targetName}</span>
            </div>
          </div>

          <div class="oni-pl-result-score ${gradeClass}">${stars}  ${matchCount}/3 Matches</div>
          <div class="oni-pl-result-grade">${flavorLine}</div>
          <div class="oni-pl-result-fx">+${bonus} to qualifying Check</div>
          <div style="font-size:.8rem;color:#c0b89a;font-style:italic;">
            Once before the next rest, ${targetName} may add +${bonus} to a Group Check (as leader) or a Check to examine someone/something.
          </div>

          <button class="oni-pl-proceed-btn" id="oni-pl-proceed" style="${_isOwner ? "" : "display:none;"}">
            Click to Proceed
          </button>
        </div>
      `;
      document.body.appendChild(ovl);

      _playSound(SFX.POSITIVE, 0.75);

      if (_isOwner) {
        const btn = ovl.querySelector("#oni-pl-proceed");
        btn?.addEventListener("click", () => {
          CAMP.Socket.send(CAMP.MSG.PLANNING_PROCEED, { actorId });
          btn.disabled = true;
        }, { once: true });
      }
    },

    resolveProceed(actorId) {
      const r = this.proceedResolvers?.[actorId];
      if (!r) return;
      delete this.proceedResolvers[actorId];
      r();
    },

    // ── Dismiss ─────────────────────────────────────────────────────────────
    hide() {
      const ovl = document.getElementById(OVL_ID);
      if (ovl) {
        ovl.classList.add("oni-pl-out");
        setTimeout(() => ovl.remove(), 320);
      }
      _clearState();
    },
  };

  // ---------------------------------------------------------------------------
  // Token image helper (standalone)
  // ---------------------------------------------------------------------------
  function _getTokenImgFromActor(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  // ---------------------------------------------------------------------------
  // Spectator channel: ally-picker cursor + "locked in" per side
  // ---------------------------------------------------------------------------
  function _markRemoteCard(targetId, cls) {
    document.querySelectorAll(`#${OVL_ID} .oni-pl-spectate .oni-pl-ally-card`).forEach(c => {
      c.classList.toggle(cls, !!targetId && c.dataset.targetId === targetId);
    });
  }

  CAMP.MG?.on?.("PLANNING", (kind, data, msg) => {
    if (!msg?.a || msg.a !== _actorId) return;
    if (kind === "hover") _markRemoteCard(data.targetId ?? null, "oni-pl-remote-hover");
    else if (kind === "pick") {
      _markRemoteCard(null, "oni-pl-remote-hover");
      _markRemoteCard(data.targetId ?? null, "oni-pl-remote-pick");
    } else if (kind === "lock") {
      _setLock(data.role, data.q);
    }
  });

  // Late join: the GM replay log re-delivers ARENA/QUESTION, but not who has
  // already locked in this round. Both pickers track both locks (own click +
  // the other's event) and answer; apply() merges them.
  CAMP.MG?.registerGame?.("PLANNING", {
    snapshot() {
      if (!_actorId || _curQ < 0 || _resultShown || !document.getElementById(OVL_ID)) return null;
      if (!_isOwner && !_isTarget) return null;
      return { actorId: _actorId, targetActorId: _targetId, q: _curQ, locks: { ..._locks } };
    },
    apply(snap) {
      if (!snap?.actorId || snap.actorId !== _actorId || snap.q !== _curQ) return;
      for (const role of ["owner", "target"]) {
        if (!snap.locks?.[role]) continue;
        _setLock(role, snap.q);
        // This page picks for that side and had already locked before reloading.
        if ((role === "owner" && _isOwner) || (role === "target" && _isTarget)) _markOwnRowLocked(role);
      }
    },
    isOpen() { return !!document.getElementById(OVL_ID); },
  });

  console.debug(TAG, "Planning UI loaded.");
})();
