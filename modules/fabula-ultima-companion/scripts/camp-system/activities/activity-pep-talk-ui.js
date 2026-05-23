// ============================================================================
// Camp Activity — Pep Talk UI
//
// Stages:
//   1 — Ally Picker   : owner picks target; spectators wait
//   2 — Quiz Builder  : target writes 3 topics; owner waits; spectators wait
//   3 — Quiz Arena    : two tokens face each other; speech bubble; choices
//   4 — Results       : final score + grade + "Click to Proceed"
//
// Sync flow:
//   GM broadcasts PEP_TALK_START          → all call show()
//   Owner picks ally → emits PEP_TALK_TARGET → GM resolves target
//   GM broadcasts PEP_TALK_QUIZ_BUILD     → all call showQuizBuild()
//   Target submits topics → emits PEP_TALK_QUIZ_READY → GM
//   GM broadcasts PEP_TALK_QUESTION       → all call showQuestion()
//   Owner picks answer → emits PEP_TALK_ANSWER → all sync; GM resolves answer
//   GM broadcasts PEP_TALK_Q_RESULT       → all call showQResult()
//   (loop × 3)
//   GM broadcasts PEP_TALK_RESULT         → all call applyResult()
//   Owner clicks Proceed → emits PEP_TALK_PROCEED → GM resolves
//   GM broadcasts PEP_TALK_DONE           → all call hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][PepTalkUI]";
  const OVL_ID    = "oni-camp-pt-ovl";
  const STYLE_ID  = "oni-camp-pt-style";

  const PEP_TALK_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Ain/EEPassive1.png";

  const SFX = {
    BOOK_OPEN:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Book1.ogg",
    CURSOR_NAV: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    TOPIC_UP:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav",
    OVERWHELM:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    POSITIVE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
    NEGATIVE:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/participant_exit.wav",
  };

  const PRESET_TOPICS = [
    "Tell me about today's adventure!",
    "Eaten anything good today?",
    "How are you feeling right now?",
    "Is anything weighing on your mind?",
    "What are you working towards lately?",
    "How do you feel about our group?",
  ];

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId       = null;
  let _actorName     = null;
  let _targetId      = null;
  let _targetName    = null;
  let _ownerImg      = null;
  let _targetImg     = null;
  let _isOwner       = false;
  let _isTarget      = false;
  let _resultShown   = false;
  let _answerLocked  = false;

  // Quiz builder state (target's client only)
  let _builtTopics   = [];
  let _usedPresets   = new Set();
  let _currentBuild  = 0; // 0, 1, 2

  // Web Audio
  let _audioCtx      = null;
  let _hoverBuf      = null;
  let _navBuf        = null;

  function _clearState() {
    _actorId      = null;
    _actorName    = null;
    _targetId     = null;
    _targetName   = null;
    _ownerImg     = null;
    _targetImg    = null;
    _isOwner      = false;
    _isTarget     = false;
    _resultShown  = false;
    _answerLocked = false;
    _builtTopics  = [];
    _usedPresets  = new Set();
    _currentBuild = 0;
  }

  // ---------------------------------------------------------------------------
  // Ownership helpers
  // ---------------------------------------------------------------------------
  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _isOwnerOfActor(actor) {
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ---------------------------------------------------------------------------
  // Audio helpers
  // ---------------------------------------------------------------------------
  async function _initWebAudio() {
    try {
      _audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
      const [hBuf, nBuf] = await Promise.all([
        fetch(SFX.CURSOR_NAV).then(r => r.arrayBuffer()).then(b => _audioCtx.decodeAudioData(b)),
        fetch(SFX.CURSOR_NAV).then(r => r.arrayBuffer()).then(b => _audioCtx.decodeAudioData(b)),
      ]);
      _hoverBuf = hBuf;
      _navBuf   = nBuf;
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
        background: rgba(0,0,0,0.80);
        animation: oni-pt-fadein 0.35s ease forwards;
        font-family: "Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-pt-out { animation: oni-pt-fadeout 0.3s ease forwards; }
      @keyframes oni-pt-fadein  { from { opacity:0 } to { opacity:1 } }
      @keyframes oni-pt-fadeout { from { opacity:1 } to { opacity:0 } }
      @keyframes oni-pt-slideup {
        from { opacity:0; transform:translateY(20px) }
        to   { opacity:1; transform:translateY(0) }
      }

      /* ── Shared panel styles ── */
      .oni-pt-panel {
        background: var(--camp-parchment-1, #f6ebd3);
        border: 2.5px solid var(--camp-wood-2, #8d5f38);
        border-radius: 14px;
        padding: 24px 28px;
        box-shadow: 0 0 0 6px rgba(90,60,34,.4), 0 20px 48px rgba(0,0,0,.7);
        animation: oni-pt-slideup 0.3s ease forwards;
        min-width: 300px; max-width: 560px;
      }
      .oni-pt-panel-title {
        font-size: 1.4rem; font-weight: 800; color: #6b3a1f;
        letter-spacing: .05em; text-transform: uppercase;
        display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
      }
      .oni-pt-panel-title img { width:28px; height:28px; border-radius:4px; border:none; }
      .oni-pt-panel-sub { font-size: .95rem; color: #8a5c2c; font-style: italic; margin-bottom: 14px; }
      .oni-pt-waiting   { font-size: 1rem; color: #c8a84b; font-style: italic; text-align:center; padding: 10px 0; }

      /* ── Ally picker ── */
      .oni-pt-ally-grid { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
      .oni-pt-ally-card {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        background: var(--camp-parchment-2, #efdfc3);
        border: 2px solid var(--camp-wood-2, #8d5f38);
        border-radius: 10px; padding: 10px 14px;
        cursor: pointer; transition: transform .15s, box-shadow .15s;
        min-width: 88px;
      }
      .oni-pt-ally-card:hover { transform: translateY(-3px); box-shadow: 0 6px 18px rgba(0,0,0,.35); }
      .oni-pt-ally-card img  { width:64px; height:64px; border:none; border-radius:0; background:transparent; object-fit:contain; }
      .oni-pt-ally-card span { font-size:.82rem; font-weight:700; color:#5a3010; text-align:center; }

      /* ── Quiz builder ── */
      .oni-pt-build-wrap { display:flex; flex-direction:column; gap:12px; }
      .oni-pt-build-progress {
        font-size:.88rem; color:#8a5c2c; font-weight:700; text-align:right; margin-bottom:-4px;
      }
      .oni-pt-build-topic-row { display:flex; flex-direction:column; gap:6px; }
      .oni-pt-build-label { font-size:.82rem; font-weight:700; color:#6b3a1f; }
      .oni-pt-build-preset {
        width:100%; padding:7px 10px; border:1.5px solid #8d5f38;
        border-radius:6px; background:#fff8ee; color:#3a1a00; font-size:.88rem;
        margin-bottom:4px;
      }
      .oni-pt-build-custom {
        width:100%; padding:7px 10px; border:1.5px solid #8d5f38;
        border-radius:6px; background:#fff8ee; color:#3a1a00; font-size:.88rem;
        box-sizing:border-box;
      }
      .oni-pt-build-custom::placeholder { color:#b8966a; }
      .oni-pt-build-choices { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
      .oni-pt-build-choice-row { display:flex; align-items:center; gap:8px; }
      .oni-pt-build-badge {
        width:28px; height:28px; border-radius:50%; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
        font-size:.85rem; font-weight:900;
      }
      .oni-pt-badge-2 { background:#c8a84b; color:#1a0a00; }
      .oni-pt-badge-1 { background:#3a7a35; color:#fff; }
      .oni-pt-badge-0 { background:#666; color:#fff; }
      .oni-pt-build-choice-input {
        flex:1; padding:6px 10px; border:1.5px solid #8d5f38;
        border-radius:6px; background:#fff8ee; color:#3a1a00; font-size:.85rem;
        box-sizing:border-box;
      }
      .oni-pt-build-choice-input::placeholder { color:#b8966a; }
      .oni-pt-build-footer { display:flex; justify-content:space-between; align-items:center; margin-top:8px; gap:10px; }
      .oni-pt-skip-btn {
        padding:7px 14px; border:1.5px solid #999; border-radius:7px;
        background:#eee; color:#555; font-size:.82rem; font-weight:700; cursor:pointer;
        transition:filter .15s;
      }
      .oni-pt-skip-btn:hover { filter:brightness(.92); }
      .oni-pt-submit-btn {
        padding:8px 20px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00; border:2px solid #7a5c15; border-radius:8px;
        font-weight:800; font-size:.9rem; cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.35); transition:filter .15s;
      }
      .oni-pt-submit-btn:hover { filter:brightness(1.12); }

      /* ── Quiz arena ── */
      .oni-pt-arena-wrap {
        display:flex; flex-direction:column; align-items:center; gap:16px;
        animation: oni-pt-slideup 0.35s ease forwards;
      }
      .oni-pt-q-header {
        font-size:1.4rem; font-weight:800; color:#e8dfc0;
        text-shadow:0 2px 8px rgba(0,0,0,.8); letter-spacing:.08em; text-transform:uppercase;
      }
      .oni-pt-stage {
        display:flex; align-items:flex-end; gap:18px;
        position:relative;
      }
      .oni-pt-side { display:flex; flex-direction:column; align-items:center; gap:6px; }
      .oni-pt-token-wrap { position:relative; }
      .oni-pt-token {
        width:100px; height:100px;
        border:none; border-radius:0; background:transparent; object-fit:contain;
        filter:drop-shadow(0 0 10px rgba(200,168,75,.4));
        transition:transform .2s ease;
      }
      .oni-pt-token-flip { transform:scaleX(-1); }
      .oni-pt-side-name {
        font-size:.85rem; font-weight:700;
        color:#f6ebd3; text-shadow:0 1px 4px rgba(0,0,0,.8);
      }
      .oni-pt-center-col {
        display:flex; flex-direction:column; align-items:center; gap:10px; padding-bottom:4px;
      }
      .oni-pt-bubble {
        position:relative; background:#fff8ee;
        border:2px solid #8d5f38; border-radius:12px;
        padding:10px 16px; max-width:260px; min-width:160px;
        font-size:.95rem; color:#3a1a00; font-weight:600;
        box-shadow:0 4px 12px rgba(0,0,0,.35);
        text-align:center;
        animation:oni-pt-bubble-in .4s ease forwards;
      }
      .oni-pt-bubble::after {
        content:""; position:absolute; right:-12px; top:50%;
        transform:translateY(-50%);
        border:6px solid transparent;
        border-left-color:#8d5f38;
      }
      .oni-pt-bubble::before {
        content:""; position:absolute; right:-9px; top:50%;
        transform:translateY(-50%);
        border:6px solid transparent;
        border-left-color:#fff8ee; z-index:1;
      }
      @keyframes oni-pt-bubble-in {
        from { opacity:0; transform:scale(.85) translateY(-6px) }
        to   { opacity:1; transform:scale(1) translateY(0) }
      }
      .oni-pt-score-hud {
        font-size:1rem; font-weight:800; color:#c8a84b;
        text-shadow:0 0 8px rgba(200,168,75,.5);
      }

      /* ── Choice buttons ── */
      .oni-pt-choices {
        display:flex; flex-direction:column; gap:8px; width:460px; max-width:90vw;
      }
      .oni-pt-choice {
        display:flex; align-items:center; gap:10px;
        padding:10px 16px;
        border-radius:10px; border:2px solid;
        cursor:pointer; font-size:.9rem; font-weight:700;
        text-align:left; transition:transform .12s, filter .12s;
      }
      .oni-pt-choice:hover:not(:disabled) { transform:translateY(-2px); filter:brightness(1.1); }
      .oni-pt-choice:disabled { opacity:.45; cursor:not-allowed; transform:none !important; }
      .oni-pt-c-positive2,
      .oni-pt-c-positive1,
      .oni-pt-c-negative  { background:rgba(255,248,238,.95); border-color:#8d5f38; color:#3a1a00; }
      .oni-pt-choice:hover:not(:disabled) { background:#fff8ee; }
      .oni-pt-c-badge { font-size:.85rem; font-weight:900; flex-shrink:0; width:22px; text-align:center; color:#8d5f38; }
      .oni-pt-c-skip { background:rgba(60,60,60,.3); border-color:#555; color:#aaa; font-style:italic; justify-content:center; }

      /* ── Token reaction animations ── */
      @keyframes oni-pt-bounce {
        0%   { transform:translateY(0); }
        20%  { transform:translateY(-14px); }
        40%  { transform:translateY(0); }
        60%  { transform:translateY(-10px); }
        80%  { transform:translateY(0); }
        100% { transform:translateY(-6px); }
      }
      @keyframes oni-pt-sway {
        0%   { transform:rotate(0deg); }
        25%  { transform:rotate(6deg); }
        50%  { transform:rotate(-6deg); }
        75%  { transform:rotate(4deg); }
        100% { transform:rotate(0deg); }
      }
      @keyframes oni-pt-droop {
        0%   { transform:translateY(0); }
        40%  { transform:translateY(8px); }
        70%  { transform:translateY(6px); }
        100% { transform:translateY(0); }
      }
      .oni-pt-anim-bounce { animation:oni-pt-bounce 0.9s ease forwards !important; }
      .oni-pt-anim-sway   { animation:oni-pt-sway   0.7s ease forwards !important; }
      .oni-pt-anim-droop  { animation:oni-pt-droop  0.8s ease forwards !important; }

      /* ── Emote pop ── */
      .oni-pt-emote-pop {
        position:absolute; top:-32px; right:-10px;
        font-size:1.6rem; font-weight:900;
        pointer-events:none;
        animation:oni-pt-emote-in .5s ease forwards;
      }
      @keyframes oni-pt-emote-in {
        0%   { opacity:0; transform:scale(.6) translateY(8px); }
        60%  { opacity:1; transform:scale(1.2) translateY(-4px); }
        100% { opacity:1; transform:scale(1) translateY(0); }
      }
      .oni-pt-emote-fade {
        animation:oni-pt-emote-out .5s ease 1.4s forwards;
      }
      @keyframes oni-pt-emote-out {
        from { opacity:1; }
        to   { opacity:0; }
      }

      /* ── Result panel ── */
      .oni-pt-result-wrap {
        display:flex; flex-direction:column; align-items:center; gap:14px; text-align:center;
        animation:oni-pt-slideup .4s ease forwards;
      }
      .oni-pt-result-title {
        font-size:1.5rem; font-weight:800; color:#e8dfc0;
        text-shadow:0 2px 8px rgba(0,0,0,.8); text-transform:uppercase; letter-spacing:.1em;
      }
      .oni-pt-result-portraits { display:flex; align-items:center; gap:24px; }
      .oni-pt-result-portrait { display:flex; flex-direction:column; align-items:center; gap:4px; }
      .oni-pt-result-portrait img {
        width:80px; height:80px; border:none; border-radius:0; background:transparent; object-fit:contain;
        filter:drop-shadow(0 0 10px rgba(200,168,75,.5));
      }
      .oni-pt-result-portrait span { font-size:.8rem; font-weight:700; color:#f6ebd3; }
      .oni-pt-result-heart { font-size:2.2rem; }
      .oni-pt-result-score { font-size:2rem; font-weight:900; }
      .oni-pt-result-grade { font-size:1rem; color:#c0b89a; font-style:italic; margin-top:-6px; }
      .oni-pt-result-fx    { font-size:.9rem; font-weight:700; color:#c8a84b; }
      .oni-pt-grade-high     { color:#c8a84b; text-shadow:0 0 16px rgba(200,168,75,.8); }
      .oni-pt-grade-standard { color:#7acc70; text-shadow:0 0 12px rgba(58,180,53,.5); }
      .oni-pt-grade-low      { color:#c0a080; }

      /* ── Proceed button ── */
      .oni-pt-proceed-btn {
        margin-top:4px; padding:9px 26px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00; border:2px solid #7a5c15; border-radius:8px;
        font-weight:800; font-size:.9rem; cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.4); transition:filter .15s;
      }
      .oni-pt-proceed-btn:hover { filter:brightness(1.15); }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Internal: build quiz-builder form for one topic slot
  // ---------------------------------------------------------------------------
  function _buildTopicForm(slotIdx) {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;
    ovl.innerHTML = "";

    const availablePresets = PRESET_TOPICS.filter(p => !_usedPresets.has(p));

    const presetOptions = availablePresets
      .map(p => `<option value="${p}">${p}</option>`)
      .join("");

    const panel = document.createElement("div");
    panel.className = "oni-pt-panel";
    panel.style.maxWidth = "500px";
    panel.innerHTML = `
      <div class="oni-pt-panel-title">
        <img src="${PEP_TALK_ICON}" alt=""> Let's Talk!
      </div>
      <div class="oni-pt-panel-sub">Create a question for your companion.</div>
      <div class="oni-pt-build-progress">Topic ${slotIdx + 1} of 3</div>

      <div class="oni-pt-build-wrap">
        <div class="oni-pt-build-topic-row">
          <div class="oni-pt-build-label">Choose a topic or write your own:</div>
          ${availablePresets.length > 0 ? `
            <select class="oni-pt-build-preset" id="oni-pt-preset-sel">
              <option value="">— Write your own topic… —</option>
              ${presetOptions}
            </select>
          ` : ""}
          <input class="oni-pt-build-custom" id="oni-pt-custom-topic"
                 type="text" maxlength="120"
                 placeholder="Type a topic here…">
        </div>

        <div class="oni-pt-build-choices" id="oni-pt-choice-wrap">
          <div class="oni-pt-build-label">Write 3 possible answers:</div>
          <div class="oni-pt-build-choice-row">
            <div class="oni-pt-build-badge oni-pt-badge-2">★★</div>
            <input class="oni-pt-build-choice-input" id="oni-pt-ans-0" type="text" maxlength="100"
                   placeholder="Overwhelmingly positive response…">
          </div>
          <div class="oni-pt-build-choice-row">
            <div class="oni-pt-build-badge oni-pt-badge-1">★</div>
            <input class="oni-pt-build-choice-input" id="oni-pt-ans-1" type="text" maxlength="100"
                   placeholder="Positive response…">
          </div>
          <div class="oni-pt-build-choice-row">
            <div class="oni-pt-build-badge oni-pt-badge-0">…</div>
            <input class="oni-pt-build-choice-input" id="oni-pt-ans-2" type="text" maxlength="100"
                   placeholder="Negative response…">
          </div>
        </div>

        <div class="oni-pt-build-footer">
          <button class="oni-pt-skip-btn" id="oni-pt-skip-btn">I don't want to talk</button>
          <button class="oni-pt-submit-btn" id="oni-pt-submit-btn">Submit Topic ➜</button>
        </div>
      </div>
    `;

    ovl.appendChild(panel);
    _playSound(SFX.BOOK_OPEN, 0.7);

    // Preset → auto-fill custom topic field
    const presetSel   = panel.querySelector("#oni-pt-preset-sel");
    const customInput = panel.querySelector("#oni-pt-custom-topic");

    if (presetSel) {
      presetSel.addEventListener("change", () => {
        _playBuf(_navBuf);
        customInput.value = presetSel.value;
      });
    }

    // Submit
    panel.querySelector("#oni-pt-submit-btn").addEventListener("click", () => {
      const topicText = customInput.value.trim();
      if (!topicText) {
        customInput.style.border = "2px solid #c0392b";
        setTimeout(() => { customInput.style.border = ""; }, 1200);
        return;
      }
      const a0 = panel.querySelector("#oni-pt-ans-0")?.value.trim();
      const a1 = panel.querySelector("#oni-pt-ans-1")?.value.trim();
      const a2 = panel.querySelector("#oni-pt-ans-2")?.value.trim();
      if (!a0 || !a1 || !a2) {
        [0,1,2].forEach(i => {
          const el = panel.querySelector(`#oni-pt-ans-${i}`);
          if (el && !el.value.trim()) { el.style.border = "2px solid #c0392b"; setTimeout(() => { el.style.border = ""; }, 1200); }
        });
        return;
      }

      // Track used preset
      if (presetSel?.value && presetSel.value === topicText) {
        _usedPresets.add(topicText);
      }

      _builtTopics.push({
        topic:   topicText,
        choices: [
          { text: a0, pts: 2 },
          { text: a1, pts: 1 },
          { text: a2, pts: 0 },
        ],
        skip: false,
      });

      _currentBuild++;
      if (_currentBuild < 3) {
        _buildTopicForm(_currentBuild);
      } else {
        _submitQuiz();
      }
    });

    // Skip
    panel.querySelector("#oni-pt-skip-btn").addEventListener("click", () => {
      _builtTopics.push({
        topic:   "…",
        choices: [],
        skip:    true,
      });
      _currentBuild++;
      if (_currentBuild < 3) {
        _buildTopicForm(_currentBuild);
      } else {
        _submitQuiz();
      }
    });
  }

  function _submitQuiz() {
    const ovl = document.getElementById(OVL_ID);
    if (ovl) {
      ovl.innerHTML = `
        <div class="oni-pt-panel" style="text-align:center;">
          <div class="oni-pt-panel-title" style="justify-content:center;">
            <img src="${PEP_TALK_ICON}" alt=""> All done!
          </div>
          <div class="oni-pt-waiting">Topics submitted. Get ready…</div>
        </div>
      `;
    }
    CAMP.Socket.emit(CAMP.MSG.PEP_TALK_QUIZ_READY, {
      actorId:      _actorId,
      targetActorId: _targetId,
      topics:       _builtTopics,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: build arena layout (q = 0 only; subsequent calls just update it)
  // ---------------------------------------------------------------------------
  function _buildArena() {
    document.getElementById(OVL_ID)?.remove();
    _ensureStyle();

    const ovl = document.createElement("div");
    ovl.id = OVL_ID;
    ovl.innerHTML = `
      <div class="oni-pt-arena-wrap">
        <div class="oni-pt-q-header" id="oni-pt-q-header">Pep Talk &middot; Question 1/3</div>

        <div class="oni-pt-stage">
          <div class="oni-pt-side">
            <div class="oni-pt-token-wrap">
              <img class="oni-pt-token oni-pt-token-flip" id="oni-pt-tok-owner"
                   src="${_ownerImg}" alt="${_actorName}">
            </div>
            <div class="oni-pt-side-name">${_actorName}</div>
          </div>

          <div class="oni-pt-center-col">
            <div class="oni-pt-bubble" id="oni-pt-bubble">
              <span id="oni-pt-bubble-txt">…</span>
            </div>
            <div class="oni-pt-score-hud">Score: <span id="oni-pt-score">0</span>/6</div>
          </div>

          <div class="oni-pt-side">
            <div class="oni-pt-token-wrap" id="oni-pt-tok-wrap-target" style="position:relative;">
              <img class="oni-pt-token" id="oni-pt-tok-target"
                   src="${_targetImg}" alt="${_targetName}">
            </div>
            <div class="oni-pt-side-name">${_targetName}</div>
          </div>
        </div>

        <div class="oni-pt-choices" id="oni-pt-choices"></div>

        <button class="oni-pt-proceed-btn" id="oni-pt-proceed" style="display:none;">
          Click to Proceed
        </button>
      </div>
    `;

    document.body.appendChild(ovl);
  }

  // Populate choices for one question
  function _renderChoices(topic) {
    const wrap = document.getElementById("oni-pt-choices");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (topic.skip) {
      const noTalk = document.createElement("div");
      noTalk.className = "oni-pt-choice oni-pt-c-skip";
      noTalk.style.pointerEvents = "none";
      noTalk.textContent = "I don't want to talk about this…";
      wrap.appendChild(noTalk);
      return;
    }

    const configs = [
      { cls: "oni-pt-c-positive2", badge: "A", idx: 0 },
      { cls: "oni-pt-c-positive1", badge: "B", idx: 1 },
      { cls: "oni-pt-c-negative",  badge: "C", idx: 2 },
    ];

    configs.forEach(({ cls, badge, idx }) => {
      const btn = document.createElement("button");
      btn.className = `oni-pt-choice ${cls}`;
      btn.dataset.idx = idx;
      btn.innerHTML = `<span class="oni-pt-c-badge">${badge}</span><span>${topic.choices[idx]?.text ?? "?"}</span>`;

      if (!_isOwner) {
        btn.disabled = true;
        btn.style.pointerEvents = "none";
      } else {
        btn.addEventListener("mouseenter", () => _playBuf(_hoverBuf));
        btn.addEventListener("click", () => {
          if (_answerLocked) return;
          _answerLocked = true;
          wrap.querySelectorAll(".oni-pt-choice").forEach(b => b.disabled = true);

          if (game.user?.isGM) {
            CAMP.PepTalkUI.resolveAnswer(_actorId, idx);
          } else {
            CAMP.Socket.emit(CAMP.MSG.PEP_TALK_ANSWER, {
              actorId:  _actorId,
              answerIdx: idx,
            });
          }
        }, { once: true });
      }
      wrap.appendChild(btn);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.PepTalkUI = {
    targetResolvers:    {},
    quizReadyResolvers: {},
    answerResolvers:    {},
    proceedResolvers:   {},
    choiceResolvers:    {},

    // ── Stage 1: Ally Picker ────────────────────────────────────────────────
    show(actorId, actorName, allies) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _initWebAudio();

      _actorId   = actorId;
      _actorName = actorName;

      const actorObj = game.actors?.get(actorId);
      _isOwner = _isOwnerOfActor(actorObj);
      _isTarget = false;

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      if (_isOwner) {
        const cards = (allies ?? []).map(a => `
          <div class="oni-pt-ally-card" data-target-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <span>${a.name}</span>
          </div>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-pt-panel">
            <div class="oni-pt-panel-title">
              <img src="${PEP_TALK_ICON}" alt=""> Pep Talk
            </div>
            <div class="oni-pt-panel-sub">Who would you like to cheer up?</div>
            <div class="oni-pt-ally-grid">${cards}</div>
          </div>
        `;

        ovl.querySelectorAll(".oni-pt-ally-card").forEach(card => {
          card.addEventListener("click", () => {
            const tid = card.dataset.targetId;
            if (!tid) return;
            if (game.user?.isGM) {
              CAMP.PepTalkUI.resolveTarget(actorId, tid);
            } else {
              CAMP.Socket.emit(CAMP.MSG.PEP_TALK_TARGET, { actorId, targetActorId: tid });
            }
          }, { once: true });
        });
      } else {
        const ownerUid  = _getOwnerUserId(actorObj);
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? actorName) : actorName;
        ovl.innerHTML = `
          <div class="oni-pt-panel" style="text-align:center;">
            <div class="oni-pt-panel-title" style="justify-content:center;">
              <img src="${PEP_TALK_ICON}" alt=""> Pep Talk
            </div>
            <div class="oni-pt-waiting">Waiting for ${ownerName} to choose a target…</div>
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

    // ── Stage 2: Quiz Builder ───────────────────────────────────────────────
    showQuizBuild(actorId, actorName, targetActorId, targetActorName, targetImg, ownerImg) {
      document.getElementById(OVL_ID)?.remove();
      _ensureStyle();

      _actorId    = actorId;
      _actorName  = actorName;
      _targetId   = targetActorId;
      _targetName = targetActorName;
      _targetImg  = targetImg;
      _ownerImg   = ownerImg;

      const actorObj  = game.actors?.get(actorId);
      const targetObj = game.actors?.get(targetActorId);

      _isOwner  = _isOwnerOfActor(actorObj);
      _isTarget = _isOwnerOfActor(targetObj);

      // Reset build state
      _builtTopics  = [];
      _usedPresets  = new Set();
      _currentBuild = 0;

      if (_isTarget) {
        // Target player builds the quiz
        const ovl = document.createElement("div");
        ovl.id = OVL_ID;
        document.body.appendChild(ovl);
        _buildTopicForm(0);
      } else if (_isOwner) {
        // Owner waits
        const ovl = document.createElement("div");
        ovl.id = OVL_ID;
        ovl.innerHTML = `
          <div class="oni-pt-panel" style="text-align:center;">
            <div class="oni-pt-panel-title" style="justify-content:center;">
              <img src="${PEP_TALK_ICON}" alt=""> Pep Talk
            </div>
            <div class="oni-pt-panel-sub">${targetActorName} is preparing the questions…</div>
            <div class="oni-pt-waiting">
              <img src="${targetImg}" style="width:64px;height:64px;border:none;border-radius:0;object-fit:contain;opacity:.85;display:block;margin:8px auto;">
              Please wait…
            </div>
          </div>
        `;
        document.body.appendChild(ovl);
        _playSound(SFX.BOOK_OPEN, 0.5);
      } else {
        // Spectator
        const ovl = document.createElement("div");
        ovl.id = OVL_ID;
        ovl.innerHTML = `
          <div class="oni-pt-panel" style="text-align:center;">
            <div class="oni-pt-panel-title" style="justify-content:center;">
              <img src="${PEP_TALK_ICON}" alt=""> Pep Talk
            </div>
            <div class="oni-pt-waiting">${targetActorName} is preparing a quiz for ${actorName}…</div>
          </div>
        `;
        document.body.appendChild(ovl);
      }
    },

    resolveQuizReady(actorId, topics) {
      const r = this.quizReadyResolvers?.[actorId];
      if (!r) return;
      delete this.quizReadyResolvers[actorId];
      r(topics);
    },

    // ── Stage 3: Show one question ──────────────────────────────────────────
    showQuestion(actorId, targetActorId, q, topic) {
      _actorId  = actorId;
      _targetId = targetActorId;

      const actorObj  = game.actors?.get(actorId);
      const targetObj = game.actors?.get(targetActorId);

      _isOwner  = _isOwnerOfActor(actorObj);
      _isTarget = _isOwnerOfActor(targetObj);

      _answerLocked = false;

      // If this is q=0 (or arena not yet built), build it from scratch
      if (q === 0 || !document.getElementById(OVL_ID)) {
        _buildArena();
      }

      // Update header
      const header = document.getElementById("oni-pt-q-header");
      if (header) header.textContent = `Pep Talk · Question ${q + 1}/3`;

      // Animate bubble text in
      const bubble    = document.getElementById("oni-pt-bubble");
      const bubbleTxt = document.getElementById("oni-pt-bubble-txt");
      if (bubble && bubbleTxt) {
        bubble.style.animation = "none";
        bubble.offsetWidth; // reflow
        bubble.style.animation = "";
        bubbleTxt.textContent = topic.skip ? "…" : topic.topic;
        _playSound(SFX.TOPIC_UP, 0.75);
      }

      // Render choices
      _renderChoices(topic);

      // If skip, auto-resolve after a brief pause
      if (topic.skip) {
        setTimeout(() => {
          if (game.user?.isGM) {
            CAMP.PepTalkUI.resolveAnswer(_actorId, 2);
          } else if (_isOwner) {
            CAMP.Socket.emit(CAMP.MSG.PEP_TALK_ANSWER, {
              actorId:   _actorId,
              answerIdx: 2,
            });
          }
        }, 1600);
      }
    },

    resolveAnswer(actorId, idx) {
      const r = this.answerResolvers?.[actorId];
      if (!r) return;
      delete this.answerResolvers[actorId];
      r(idx);
    },

    // ── Stage 3: Per-question result + reaction ─────────────────────────────
    showQResult(actorId, targetActorId, q, answerIdx, pts, totalScore) {
      // Update score HUD
      const scoreEl = document.getElementById("oni-pt-score");
      if (scoreEl) scoreEl.textContent = totalScore;

      // Highlight chosen button
      const choices = document.querySelectorAll(".oni-pt-choice");
      choices.forEach((btn, i) => {
        btn.disabled = true;
        if (i === answerIdx) btn.style.opacity = "1";
        else                  btn.style.opacity = "0.35";
      });

      // Token reaction
      const tok      = document.getElementById("oni-pt-tok-target");
      const tokWrap  = document.getElementById("oni-pt-tok-wrap-target");

      if (tok) {
        tok.classList.remove("oni-pt-anim-bounce", "oni-pt-anim-sway", "oni-pt-anim-droop");
        tok.offsetWidth; // reflow
        if (pts === 2)      { tok.classList.add("oni-pt-anim-bounce"); _playSound(SFX.OVERWHELM, 0.8); }
        else if (pts === 1) { tok.classList.add("oni-pt-anim-sway");   _playSound(SFX.POSITIVE, 0.75); }
        else                { tok.classList.add("oni-pt-anim-droop");   _playSound(SFX.NEGATIVE, 0.7); }
      }

      // Emote pop on target wrap
      if (tokWrap) {
        tokWrap.querySelectorAll(".oni-pt-emote-pop").forEach(e => e.remove());
        const emote     = document.createElement("div");
        emote.className = "oni-pt-emote-pop oni-pt-emote-fade";
        emote.textContent =
          pts === 2 ? "💕" :
          pts === 1 ? "😊" :
                      "💭";
        tokWrap.appendChild(emote);
        setTimeout(() => emote.remove(), 2000);
      }
    },

    // ── Stage 4: Results ────────────────────────────────────────────────────
    applyResult(actorId, targetActorId, totalScore, grade) {
      if (_resultShown) return;
      _resultShown = true;

      // Replace arena content with result panel
      document.getElementById(OVL_ID)?.remove();
      _ensureStyle();

      const actorObj  = game.actors?.get(actorId);
      const targetObj = game.actors?.get(targetActorId);

      _isOwner = _isOwnerOfActor(actorObj);

      const ownerImgSrc  = _ownerImg  || (actorObj  ? _getTokenImgFromActor(actorObj)  : "");
      const targetImgSrc = _targetImg || (targetObj ? _getTokenImgFromActor(targetObj) : "");
      const ownerName    = actorObj?.name  ?? actorId;
      const targetName   = targetObj?.name ?? targetActorId;

      const gradeClass =
        grade === "high"     ? "oni-pt-grade-high" :
        grade === "standard" ? "oni-pt-grade-standard" :
                               "oni-pt-grade-low";

      const gradeLabel =
        grade === "high"     ? "Overwhelmed with joy!" :
        grade === "standard" ? "Felt genuinely heard." :
                               "Appreciated the effort…";

      const multLabel =
        grade === "high"     ? "×3 MP Recovery" :
        grade === "standard" ? "×2 MP Recovery" :
                               "×1.5 MP Recovery";

      const stars =
        grade === "high"     ? "★★★" :
        grade === "standard" ? "★★☆" :
                               "★☆☆";

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;
      ovl.innerHTML = `
        <div class="oni-pt-result-wrap">
          <div class="oni-pt-result-title">Pep Talk — Complete!</div>

          <div class="oni-pt-result-portraits">
            <div class="oni-pt-result-portrait">
              <img src="${ownerImgSrc}" alt="${ownerName}">
              <span>${ownerName}</span>
            </div>
            <div class="oni-pt-result-heart">💬</div>
            <div class="oni-pt-result-portrait">
              <img src="${targetImgSrc}" alt="${targetName}">
              <span>${targetName}</span>
            </div>
          </div>

          <div class="oni-pt-result-score ${gradeClass}">${stars}  ${totalScore}/6</div>
          <div class="oni-pt-result-grade">${gradeLabel}</div>
          <div class="oni-pt-result-fx">${multLabel}</div>
          <div style="font-size:.8rem;color:#c0b89a;font-style:italic;">
            Once before the next rest, ${targetName} may use this bonus when recovering MP.
          </div>

          <button class="oni-pt-proceed-btn" id="oni-pt-proceed" style="${_isOwner ? "" : "display:none;"}">
            Click to Proceed
          </button>
        </div>
      `;
      document.body.appendChild(ovl);

      if (_isOwner) {
        const btn = ovl.querySelector("#oni-pt-proceed");
        btn?.addEventListener("click", () => {
          if (game.user?.isGM) {
            CAMP.PepTalkUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.PEP_TALK_PROCEED, { actorId });
          }
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

    // ── In-combat choice (target's owner client only) ───────────────────────
    onChoiceRequest(payload) {
      const { actorId, actorName, delta, grade, multiplier, aeId, targetUserId } = payload;
      if (targetUserId !== game.user?.id) return;

      const actor     = game.actors?.get(actorId);
      const maxMp     = actor?.system?.props?.max_mp ?? 0;
      const currentMp = parseInt(actor?.system?.props?.current_mp) || 0;
      const boosted   = Math.floor(delta * multiplier);
      const label     = multiplier === 1.5 ? "×1.5" : `×${multiplier}`;

      Dialog.confirm({
        title:   "Pep Talk",
        content: `<p><strong>${actorName}</strong> is about to recover <strong>${delta} MP</strong>.<br>Use <strong>Pep Talk</strong> to multiply that by <strong>${label}</strong>, recovering <strong>${boosted} MP</strong> instead?</p>`,
        yes: () => {
          CAMP.Socket.emit(CAMP.MSG.PEP_TALK_CHOICE_RESPONSE, {
            actorId, aeId, boostedDelta: boosted, accepted: true, maxMp, currentMp,
          });
        },
        no: () => {
          CAMP.Socket.emit(CAMP.MSG.PEP_TALK_CHOICE_RESPONSE, {
            actorId, aeId, boostedDelta: boosted, accepted: false, maxMp, currentMp,
          });
        },
        defaultYes: true,
      });
    },

    // ── Dismiss ─────────────────────────────────────────────────────────────
    hide() {
      const ovl = document.getElementById(OVL_ID);
      if (ovl) {
        ovl.classList.add("oni-pt-out");
        setTimeout(() => ovl.remove(), 320);
      }
      _clearState();
    },
  };

  // ---------------------------------------------------------------------------
  // Token image helper (standalone, no closured state)
  // ---------------------------------------------------------------------------
  function _getTokenImgFromActor(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  console.debug(TAG, "Pep Talk UI loaded.");
})();
