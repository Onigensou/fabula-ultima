// ============================================================================
// Camp Activity — Combat Lesson UI
//
// Overlay lifecycle:
//   Stage 1 — Target Picker:  show(actorId, allies)
//             Owner sees ally cards to click; spectators see "Waiting for…"
//   Stage 2 — Rolling:        showRolling(actorId, targetActorId)
//             Both tokens face each other; sword speech-bubble; counters spin
//   Stage 3 — Reveal:         applyResult(actorId, targetActorId, t, t, bonus)
//             Counters snap to actual values; bonus row slides in
//
// Sync flow:
//   GM broadcasts COMBAT_LESSON_START  → all call show()          (GM direct too)
//   GM broadcasts COMBAT_LESSON_RESULT (no bonus) → all showRolling()
//   GM broadcasts COMBAT_LESSON_RESULT (with bonus) → all applyResult()
//   Owner "Click to Proceed"  → emit COMBAT_LESSON_PROCEED → GM resolvesProceed
//   GM broadcasts COMBAT_LESSON_DONE  → all hide()
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][CombatLessonUI]";
  const OVL_ID = "oni-camp-cl-ovl";
  const STYLE_ID = "oni-camp-cl-style";

  const LESSON_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/Chivalry.png";
  const SWORD_IMG   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/Chivalry.png";

  const SFX = {
    START:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_start.wav",
    SWING:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_SWINGB.wav",
    REVEAL: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    RESULT: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_3.wav",
  };

  // ── Ownership helpers ─────────────────────────────────────────────────────

  function _getOwnerUserId(actor) {
    const hit = Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    });
    return hit?.[0] ?? null;
  }

  function _isOwner(actor) {
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ── Token image ───────────────────────────────────────────────────────────

  function _getTokenImg(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  // ── Sound ─────────────────────────────────────────────────────────────────

  function _playSound(src, volume = 0.7) {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      if (AH) { AH.play({ src, volume, autoplay: true, loop: false }, false); return; }
    } catch {}
    try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let _currentTeacherActorId = null;
  let _resultShown           = false;
  let _rafId                 = null;
  let _lastFrameMs           = 0;
  let _swingTimers           = [];

  const TICK_MS  = 60;
  const ROLL_CAP = 30; // counter cycles 0–30 visually

  function _clearState() {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _swingTimers.forEach(t => clearTimeout(t));
    _swingTimers = [];
    _lastFrameMs    = 0;
    _resultShown    = false;
    _currentTeacherActorId = null;
  }

  // ── CSS ───────────────────────────────────────────────────────────────────

  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 10000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.78);
        animation: oni-cl-fadein 0.35s ease forwards;
        font-family: "Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-cl-out {
        animation: oni-cl-fadeout 0.3s ease forwards;
      }
      @keyframes oni-cl-fadein  { from { opacity:0 } to { opacity:1 } }
      @keyframes oni-cl-fadeout { from { opacity:1 } to { opacity:0 } }

      /* ── Target Picker stage ── */
      .oni-cl-picker {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        background: var(--camp-parchment-1, #f6ebd3);
        border: 2.5px solid var(--camp-wood-2, #8d5f38);
        border-radius: 14px;
        padding: 24px 28px;
        box-shadow: 0 0 0 6px rgba(90,60,34,.4), 0 20px 48px rgba(0,0,0,.7);
        min-width: 280px;
        animation: oni-cl-slideup 0.3s ease forwards;
      }
      @keyframes oni-cl-slideup {
        from { opacity:0; transform:translateY(24px) }
        to   { opacity:1; transform:translateY(0) }
      }
      .oni-cl-picker-title {
        font-size: 1.4rem; font-weight: 800; color: #6b3a1f;
        letter-spacing: .05em; text-transform: uppercase;
        display: flex; align-items: center; gap: 8px;
      }
      .oni-cl-picker-title img { width:28px; height:28px; border-radius:4px; border:none; }
      .oni-cl-picker-sub  { font-size: .95rem; color: #8a5c2c; font-style: italic; }
      .oni-cl-ally-grid   { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
      .oni-cl-ally-card   {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        background: var(--camp-parchment-2, #efdfc3);
        border: 2px solid var(--camp-wood-2, #8d5f38);
        border-radius: 10px;
        padding: 10px 14px;
        cursor: pointer;
        transition: transform .15s, box-shadow .15s;
        min-width: 88px;
      }
      .oni-cl-ally-card:hover {
        transform: translateY(-3px);
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
      }
      .oni-cl-ally-card img  { width:64px; height:64px; border:none; border-radius:0; background:transparent; object-fit:contain; }
      .oni-cl-ally-card span { font-size:.82rem; font-weight:700; color:#5a3010; text-align:center; }
      .oni-cl-waiting-txt    { font-size:1rem; color:#c8a84b; font-style:italic; }

      /* ── Rolling stage ── */
      .oni-cl-arena {
        display: flex; flex-direction: column; align-items: center; gap: 18px;
        animation: oni-cl-slideup 0.35s ease forwards;
      }
      .oni-cl-arena-title {
        font-size: 1.5rem; font-weight: 800; color: #e8dfc0;
        text-shadow: 0 2px 8px rgba(0,0,0,.8);
        letter-spacing: .08em; text-transform: uppercase;
      }
      .oni-cl-combatants {
        display: flex; align-items: center; gap: 24px;
      }
      .oni-cl-combatant {
        display: flex; flex-direction: column; align-items: center; gap: 8px;
      }
      .oni-cl-token-wrap img {
        width: 96px; height: 96px;
        border: none; border-radius: 0; background: transparent;
        object-fit: contain;
        filter: drop-shadow(0 0 10px rgba(200,168,75,.5));
      }
      .oni-cl-token-flip img {
        transform: scaleX(-1);
      }
      .oni-cl-actor-name {
        font-size: .88rem; font-weight: 700;
        color: #f6ebd3; text-shadow: 0 1px 4px rgba(0,0,0,.8);
      }
      .oni-cl-counter {
        font-size: 2.4rem; font-weight: 900;
        color: #f4d488;
        text-shadow: 0 0 18px rgba(244,212,136,.7);
        min-width: 64px; text-align: center;
        transition: color .3s;
      }
      .oni-cl-counter.locked {
        color: #fff;
        text-shadow: 0 0 24px rgba(255,255,200,.9);
      }
      .oni-cl-vs {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        color: #c8a84b;
      }
      .oni-cl-vs-sword img {
        width: 48px; height: 48px; border:none;
        animation: oni-cl-pulse 1.2s ease-in-out infinite;
        filter: drop-shadow(0 0 8px rgba(200,168,75,.7));
      }
      @keyframes oni-cl-pulse {
        0%,100% { transform: scale(1)    rotate(-10deg); }
        50%      { transform: scale(1.15) rotate(10deg);  }
      }
      .oni-cl-vs-label { font-size:1.2rem; font-weight:900; letter-spacing:.08em; color:#c8a84b; }

      /* ── Result row ── */
      .oni-cl-result-row {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        animation: oni-cl-slideup .4s ease forwards;
        text-align: center;
      }
      .oni-cl-bonus-txt {
        font-size: 1.5rem; font-weight: 900;
        color: #f4d488;
        text-shadow: 0 0 20px rgba(244,212,136,.8);
        letter-spacing: .04em;
      }
      .oni-cl-bonus-sub {
        font-size: .85rem; color: #c8c0a8; font-style: italic;
      }
      .oni-cl-proceed-btn {
        margin-top: 6px;
        padding: 8px 24px;
        background: linear-gradient(180deg,#c8a84b,#9a7a2b);
        color: #1a0e00;
        border: 2px solid #7a5c15;
        border-radius: 8px;
        font-weight: 800; font-size: .9rem; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,.4);
        transition: filter .15s;
      }
      .oni-cl-proceed-btn:hover { filter: brightness(1.15); }
      .oni-cl-proceed-btn:disabled { opacity:.5; cursor:not-allowed; }
    `;
    document.head.appendChild(s);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  CAMP.CombatLessonUI = {
    targetResolvers:  {},
    proceedResolvers: {},

    // ------------------------------------------------------------------
    // Stage 1 — Target Picker
    // ------------------------------------------------------------------
    show(actorId, allies) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _currentTeacherActorId = actorId;

      const teacherActor = game.actors?.get(actorId);
      const isOwner      = _isOwner(teacherActor);

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      if (isOwner) {
        const allyCards = (allies ?? []).map(a => `
          <div class="oni-cl-ally-card" data-target-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <span>${a.name}</span>
          </div>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-cl-picker">
            <div class="oni-cl-picker-title">
              <img src="${LESSON_ICON}" alt=""> Combat Lesson
            </div>
            <div class="oni-cl-picker-sub">Who will you teach?</div>
            <div class="oni-cl-ally-grid">${allyCards}</div>
          </div>
        `;

        ovl.querySelectorAll(".oni-cl-ally-card").forEach(card => {
          card.addEventListener("click", () => {
            const targetId = card.dataset.targetId;
            if (!targetId) return;
            if (game.user?.isGM) {
              CAMP.CombatLessonUI.resolveTarget(actorId, targetId);
            } else {
              CAMP.Socket.emit(CAMP.MSG.COMBAT_LESSON_TARGET, { actorId, targetActorId: targetId });
            }
          }, { once: true });
        });
      } else {
        const ownerUid   = _getOwnerUserId(teacherActor);
        const ownerName  = ownerUid ? (game.users?.get(ownerUid)?.name ?? "teacher") : "teacher";
        ovl.innerHTML = `
          <div class="oni-cl-picker">
            <div class="oni-cl-picker-title">
              <img src="${LESSON_ICON}" alt=""> Combat Lesson
            </div>
            <div class="oni-cl-waiting-txt">Waiting for ${ownerName} to choose a target…</div>
          </div>
        `;
      }

      document.body.appendChild(ovl);
      _playSound(SFX.START, 0.7);
    },

    resolveTarget(actorId, targetActorId) {
      const resolver = this.targetResolvers?.[actorId];
      if (!resolver) return;
      delete this.targetResolvers[actorId];
      resolver(targetActorId);
    },

    // ------------------------------------------------------------------
    // Stage 2 — Rolling (both actors)
    // ------------------------------------------------------------------
    showRolling(actorId, targetActorId) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _currentTeacherActorId = actorId;

      const teacherActor = game.actors?.get(actorId);
      const targetActor  = game.actors?.get(targetActorId);

      const teacherImg = teacherActor ? _getTokenImg(teacherActor) : "";
      const targetImg  = targetActor  ? _getTokenImg(targetActor)  : "";
      const teacherName = teacherActor?.name ?? "?";
      const targetName  = targetActor?.name  ?? "?";

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;
      ovl.innerHTML = `
        <div class="oni-cl-arena">
          <div class="oni-cl-arena-title">Combat Lesson</div>
          <div class="oni-cl-combatants">
            <div class="oni-cl-combatant">
              <div class="oni-cl-token-wrap oni-cl-token-flip">
                <img src="${teacherImg}" alt="${teacherName}">
              </div>
              <div class="oni-cl-actor-name">${teacherName}</div>
              <div class="oni-cl-counter" id="oni-cl-ctr-teacher">0</div>
            </div>

            <div class="oni-cl-vs">
              <div class="oni-cl-vs-sword"><img src="${SWORD_IMG}" alt="⚔️"></div>
              <div class="oni-cl-vs-label">VS</div>
            </div>

            <div class="oni-cl-combatant">
              <div class="oni-cl-token-wrap">
                <img src="${targetImg}" alt="${targetName}">
              </div>
              <div class="oni-cl-actor-name">${targetName}</div>
              <div class="oni-cl-counter" id="oni-cl-ctr-target">0</div>
            </div>
          </div>
          <div id="oni-cl-result-area"></div>
        </div>
      `;
      document.body.appendChild(ovl);

      // ── Spin counters ──
      let _tVal = 0, _gVal = 0;
      function _frame(ts) {
        if (_resultShown) return;
        if (ts - _lastFrameMs >= TICK_MS) {
          _lastFrameMs = ts;
          _tVal = (_tVal + 1) % (ROLL_CAP + 1);
          _gVal = (_gVal + 3) % (ROLL_CAP + 1);
          const tEl = document.getElementById("oni-cl-ctr-teacher");
          const gEl = document.getElementById("oni-cl-ctr-target");
          if (tEl) tEl.textContent = _tVal;
          if (gEl) gEl.textContent = _gVal;
        }
        _rafId = requestAnimationFrame(_frame);
      }
      _rafId = requestAnimationFrame(_frame);

      // ── SWING sfx × 3 at random intervals in 0–4 s window ──
      const swingTimes = [0, 1, 2].map(() => Math.random() * 4000);
      swingTimes.forEach(delay => {
        _swingTimers.push(setTimeout(() => _playSound(SFX.SWING, 0.55), delay));
      });
    },

    // ------------------------------------------------------------------
    // Stage 3 — Reveal
    // ------------------------------------------------------------------
    applyResult(actorId, targetActorId, teacherTotal, targetTotal, bonus) {
      if (_resultShown) return;
      _resultShown = true;

      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

      // Snap counters to actual values
      const tEl = document.getElementById("oni-cl-ctr-teacher");
      const gEl = document.getElementById("oni-cl-ctr-target");
      if (tEl) { tEl.textContent = teacherTotal; tEl.classList.add("locked"); }
      if (gEl) { gEl.textContent = targetTotal;  gEl.classList.add("locked"); }

      _playSound(SFX.REVEAL, 0.7);

      // Inject result row after a brief pause
      setTimeout(() => {
        const area = document.getElementById("oni-cl-result-area");
        if (!area) return;

        const bonusLabel =
          bonus >= 5 ? "Perfect synchrony!" :
          bonus >= 4 ? "Excellent form!"    :
          bonus >= 3 ? "Good lesson!"       :
          bonus >= 2 ? "Some progress."     :
                       "Keep practicing.";

        const teacherActor = game.actors?.get(actorId);
        const targetActor  = game.actors?.get(targetActorId);
        const targetName   = targetActor?.name ?? "?";

        area.innerHTML = `
          <div class="oni-cl-result-row">
            <div class="oni-cl-bonus-txt">Combat Lesson Bonus: +${bonus}</div>
            <div class="oni-cl-bonus-sub">${bonusLabel} — ${targetName} may add +${bonus} to their next Accuracy or offensive Magic Check.</div>
            <button class="oni-cl-proceed-btn" id="oni-cl-proceed" style="display:none;">Click to Proceed</button>
          </div>
        `;

        _playSound(SFX.RESULT, 0.7);

        // Show proceed button only to the teacher's owner
        const proceedBtn = document.getElementById("oni-cl-proceed");
        if (proceedBtn && _currentTeacherActorId) {
          if (_isOwner(teacherActor)) {
            proceedBtn.style.display = "";
            proceedBtn.addEventListener("click", () => {
              proceedBtn.disabled = true;
              if (game.user?.isGM) {
                CAMP.CombatLessonUI.resolveProceed(_currentTeacherActorId);
              } else {
                CAMP.Socket.emit(CAMP.MSG.COMBAT_LESSON_PROCEED, { actorId: _currentTeacherActorId });
              }
            }, { once: true });
          }
        }
      }, 500);
    },

    resolveProceed(actorId) {
      const resolver = this.proceedResolvers?.[actorId];
      if (!resolver) return;
      delete this.proceedResolvers[actorId];
      resolver();
    },

    // ------------------------------------------------------------------
    // Dismiss overlay
    // ------------------------------------------------------------------
    hide() {
      _clearState();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("oni-cl-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Combat Lesson UI loaded.");
})();
