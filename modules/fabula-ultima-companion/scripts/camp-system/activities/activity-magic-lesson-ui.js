// ============================================================================
// Camp Activity — Magic Lesson UI
//
// Overlay lifecycle:
//   Stage 1 — Ally Picker:   show(actorId, allies)
//             Owner sees ally cards; spectators see "Waiting for…"
//   Stage 2 — Spell Picker:  showSpellPick(actorId, targetActorId, spells[])
//             Owner sees spell grid; spectators see "Waiting for…"
//   Stage 3 — Rolling:       showRolling(actorId, targetActorId, spellName, spellImg)
//             Both tokens; spell icon center; counters spin
//   Stage 4 — Reveal:        applyResult(actorId, targetActorId, spellName, spellImg, t, t, usages)
//             Counters snap; usages row slides in
//
// Sync flow:
//   GM broadcasts MAGIC_LESSON_START  → all call show()           (GM direct too)
//   GM broadcasts MAGIC_LESSON_RESULT (spells[])     → all showSpellPick()
//   GM broadcasts MAGIC_LESSON_RESULT (spellName)    → all showRolling()
//   GM broadcasts MAGIC_LESSON_RESULT (usages)       → all applyResult()
//   Owner "Click to Proceed" → emit MAGIC_LESSON_PROCEED → GM resolvesProceed
//   GM broadcasts MAGIC_LESSON_DONE  → all hide()
// ============================================================================
(() => {
  const CAMP     = globalThis.CampSystem ??= {};
  const TAG      = "[CampSystem][MagicLessonUI]";
  const OVL_ID   = "oni-camp-ml-ovl";
  const STYLE_ID = "oni-camp-ml-style";

  const LESSON_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Aisha/EM.png";

  const SFX = {
    START:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_start.wav",
    TEACHING: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Beginspell.mp3",
    REVEAL:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    RESULT:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_3.wav",
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

  const TICK_MS  = 60;
  const ROLL_CAP = 30;

  function _clearState() {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
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
        animation: oni-ml-fadein 0.35s ease forwards;
        font-family: "Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-ml-out {
        animation: oni-ml-fadeout 0.3s ease forwards;
      }
      @keyframes oni-ml-fadein  { from { opacity:0 } to { opacity:1 } }
      @keyframes oni-ml-fadeout { from { opacity:1 } to { opacity:0 } }

      /* ── Parchment card (shared by stage 1 & 2) ── */
      .oni-ml-card {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        background: var(--camp-parchment-1, #f6ebd3);
        border: 2.5px solid var(--camp-wood-2, #8d5f38);
        border-radius: 14px;
        padding: 24px 28px;
        box-shadow: 0 0 0 6px rgba(90,60,34,.4), 0 20px 48px rgba(0,0,0,.7);
        min-width: 300px; max-width: 480px;
        animation: oni-ml-slideup 0.3s ease forwards;
      }
      @keyframes oni-ml-slideup {
        from { opacity:0; transform:translateY(24px) }
        to   { opacity:1; transform:translateY(0) }
      }
      .oni-ml-card-title {
        font-size: 1.4rem; font-weight: 800; color: #6b3a1f;
        letter-spacing: .05em; text-transform: uppercase;
        display: flex; align-items: center; gap: 8px;
      }
      .oni-ml-card-title img { width:28px; height:28px; border-radius:4px; border:none; }
      .oni-ml-card-sub  { font-size: .95rem; color: #8a5c2c; font-style: italic; }
      .oni-ml-waiting-txt { font-size:1rem; color:#c8a84b; font-style:italic; }

      /* ── Stage 1: ally grid ── */
      .oni-ml-ally-grid { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
      .oni-ml-ally-card {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        background: var(--camp-parchment-2, #efdfc3);
        border: 2px solid var(--camp-wood-2, #8d5f38);
        border-radius: 10px; padding: 10px 14px;
        cursor: pointer; transition: transform .15s, box-shadow .15s;
        min-width: 88px;
      }
      .oni-ml-ally-card:hover { transform: translateY(-3px); box-shadow: 0 6px 18px rgba(0,0,0,.35); }
      .oni-ml-ally-card img  { width:64px; height:64px; border:none; border-radius:0; background:transparent; object-fit:contain; }
      .oni-ml-ally-card span { font-size:.82rem; font-weight:700; color:#5a3010; text-align:center; }

      /* ── Stage 2: spell grid ── */
      .oni-ml-spell-grid {
        display: flex; flex-direction: column; gap: 6px;
        max-height: 340px; overflow-y: auto; width: 100%;
        padding-right: 2px;
      }
      .oni-ml-spell-grid::-webkit-scrollbar { width: 6px; }
      .oni-ml-spell-grid::-webkit-scrollbar-thumb { background: rgba(120,78,20,.4); border-radius: 3px; }
      .oni-ml-spell-section-title {
        font-size: .75rem; font-weight: 800; text-transform: uppercase;
        letter-spacing: .04em; color: #8a5c2c;
        padding: 2px 0 2px 2px; margin-top: 4px;
      }
      .oni-ml-spell-btn {
        display: flex; align-items: center; gap: 8px;
        width: 100%; padding: 7px 12px;
        background: var(--camp-parchment-2, #efdfc3);
        border: 2px solid var(--camp-wood-2, #8d5f38);
        border-radius: 8px; cursor: pointer;
        font-size: .88rem; font-weight: 700; color: #5a3010;
        text-align: left; transition: filter .1s, transform .1s;
      }
      .oni-ml-spell-btn:hover { filter: brightness(1.05); transform: translateX(2px); }
      .oni-ml-spell-btn img { width:24px; height:24px; border:none; border-radius:3px; flex-shrink:0; object-fit:contain; }

      /* ── Stage 3 & 4: arena ── */
      .oni-ml-arena {
        display: flex; flex-direction: column; align-items: center; gap: 18px;
        animation: oni-ml-slideup 0.35s ease forwards;
      }
      .oni-ml-arena-title {
        font-size: 1.5rem; font-weight: 800; color: #e8dfc0;
        text-shadow: 0 2px 8px rgba(0,0,0,.8);
        letter-spacing: .08em; text-transform: uppercase;
      }
      .oni-ml-combatants { display: flex; align-items: center; gap: 24px; }
      .oni-ml-combatant  { display: flex; flex-direction: column; align-items: center; gap: 8px; }
      .oni-ml-token-wrap img {
        width: 96px; height: 96px;
        border: none; border-radius: 0; background: transparent;
        object-fit: contain;
        filter: drop-shadow(0 0 10px rgba(140,100,200,.5));
      }
      .oni-ml-token-flip img { transform: scaleX(-1); }
      .oni-ml-actor-name {
        font-size: .88rem; font-weight: 700;
        color: #f6ebd3; text-shadow: 0 1px 4px rgba(0,0,0,.8);
      }
      .oni-ml-counter {
        font-size: 2.4rem; font-weight: 900;
        color: #c8a8f4;
        text-shadow: 0 0 18px rgba(200,168,244,.7);
        min-width: 64px; text-align: center;
        transition: color .3s;
      }
      .oni-ml-counter.locked {
        color: #fff;
        text-shadow: 0 0 24px rgba(220,200,255,.9);
      }
      .oni-ml-vs { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .oni-ml-vs-spell img {
        width: 52px; height: 52px; border: none;
        animation: oni-ml-pulse 1.4s ease-in-out infinite;
        filter: drop-shadow(0 0 10px rgba(180,140,255,.8));
      }
      @keyframes oni-ml-pulse {
        0%,100% { transform: scale(1)    rotate(-5deg); }
        50%      { transform: scale(1.18) rotate(5deg);  }
      }
      .oni-ml-vs-label { font-size:1.2rem; font-weight:900; letter-spacing:.08em; color:#c8a8f4; }

      /* ── Result row ── */
      .oni-ml-result-row {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        animation: oni-ml-slideup .4s ease forwards;
        text-align: center;
      }
      .oni-ml-spell-taught {
        display: flex; align-items: center; gap: 8px;
        font-size: 1rem; font-weight: 700; color: #e8dfc0;
      }
      .oni-ml-spell-taught img { width:28px; height:28px; border:none; border-radius:4px; object-fit:contain; }
      .oni-ml-usages-txt {
        font-size: 1.4rem; font-weight: 900;
        color: #c8a8f4;
        text-shadow: 0 0 20px rgba(200,168,244,.8);
        letter-spacing: .04em;
      }
      .oni-ml-usages-sub { font-size: .85rem; color: #c8c0a8; font-style: italic; }
      .oni-ml-proceed-btn {
        margin-top: 6px; padding: 8px 24px;
        background: linear-gradient(180deg,#9a78e0,#6a4ab0);
        color: #f0eaff;
        border: 2px solid #5a3a9a;
        border-radius: 8px;
        font-weight: 800; font-size: .9rem; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,.4);
        transition: filter .15s;
      }
      .oni-ml-proceed-btn:hover { filter: brightness(1.15); }
      .oni-ml-proceed-btn:disabled { opacity:.5; cursor:not-allowed; }
    `;
    document.head.appendChild(s);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  CAMP.MagicLessonUI = {
    targetResolvers:  {},
    spellResolvers:   {},
    proceedResolvers: {},

    // ------------------------------------------------------------------
    // Stage 1 — Ally Picker
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
          <div class="oni-ml-ally-card" data-target-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <span>${a.name}</span>
          </div>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-ml-card">
            <div class="oni-ml-card-title">
              <img src="${LESSON_ICON}" alt=""> Magic Lesson
            </div>
            <div class="oni-ml-card-sub">Who will you teach?</div>
            <div class="oni-ml-ally-grid">${allyCards}</div>
          </div>
        `;

        ovl.querySelectorAll(".oni-ml-ally-card").forEach(card => {
          card.addEventListener("click", () => {
            const targetId = card.dataset.targetId;
            if (!targetId) return;
            if (game.user?.isGM) {
              CAMP.MagicLessonUI.resolveTarget(actorId, targetId);
            } else {
              CAMP.Socket.emit(CAMP.MSG.MAGIC_LESSON_TARGET, { actorId, targetActorId: targetId });
            }
          }, { once: true });
        });
      } else {
        const ownerUid  = _getOwnerUserId(teacherActor);
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? "teacher") : "teacher";
        ovl.innerHTML = `
          <div class="oni-ml-card">
            <div class="oni-ml-card-title">
              <img src="${LESSON_ICON}" alt=""> Magic Lesson
            </div>
            <div class="oni-ml-waiting-txt">Waiting for ${ownerName} to choose a target…</div>
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
    // Stage 2 — Spell Picker
    // ------------------------------------------------------------------
    showSpellPick(actorId, targetActorId, spells) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _currentTeacherActorId = actorId;

      const teacherActor = game.actors?.get(actorId);
      const targetActor  = game.actors?.get(targetActorId);
      const isOwner      = _isOwner(teacherActor);
      const targetName   = targetActor?.name ?? "your ally";

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      if (isOwner) {
        const spellRows = (spells ?? []).map(s => `
          <button class="oni-ml-spell-btn"
                  data-uuid="${s.uuid}"
                  data-name="${s.name.replace(/"/g, '&quot;')}"
                  data-img="${(s.img ?? "").replace(/"/g, '&quot;')}">
            <img src="${s.img || "icons/svg/explosion.svg"}" alt="">
            ${s.name}
          </button>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-ml-card">
            <div class="oni-ml-card-title">
              <img src="${LESSON_ICON}" alt=""> Magic Lesson
            </div>
            <div class="oni-ml-card-sub">Which spell will you teach ${targetName}?</div>
            <div class="oni-ml-spell-grid">${spellRows}</div>
          </div>
        `;

        ovl.querySelectorAll(".oni-ml-spell-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const spellUuid = btn.dataset.uuid;
            const spellName = btn.dataset.name;
            const spellImg  = btn.dataset.img;
            if (!spellUuid) return;
            if (game.user?.isGM) {
              CAMP.MagicLessonUI.resolveSpell(actorId, spellUuid, spellName, spellImg);
            } else {
              CAMP.Socket.emit(CAMP.MSG.MAGIC_LESSON_SPELL, { actorId, spellUuid, spellName, spellImg });
            }
          }, { once: true });
        });
      } else {
        const ownerUid  = _getOwnerUserId(teacherActor);
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? "teacher") : "teacher";
        ovl.innerHTML = `
          <div class="oni-ml-card">
            <div class="oni-ml-card-title">
              <img src="${LESSON_ICON}" alt=""> Magic Lesson
            </div>
            <div class="oni-ml-waiting-txt">Waiting for ${ownerName} to choose a spell…</div>
          </div>
        `;
      }

      document.body.appendChild(ovl);
    },

    resolveSpell(actorId, spellUuid, spellName, spellImg) {
      const resolver = this.spellResolvers?.[actorId];
      if (!resolver) return;
      delete this.spellResolvers[actorId];
      resolver({ spellUuid, spellName, spellImg });
    },

    // ------------------------------------------------------------------
    // Stage 3 — Rolling
    // ------------------------------------------------------------------
    showRolling(actorId, targetActorId, spellName, spellImg) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _currentTeacherActorId = actorId;

      const teacherActor = game.actors?.get(actorId);
      const targetActor  = game.actors?.get(targetActorId);
      const teacherImg   = teacherActor ? _getTokenImg(teacherActor) : "";
      const targetImg    = targetActor  ? _getTokenImg(targetActor)  : "";
      const teacherName  = teacherActor?.name ?? "?";
      const targetName   = targetActor?.name  ?? "?";
      const centerIcon   = spellImg || LESSON_ICON;

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;
      ovl.innerHTML = `
        <div class="oni-ml-arena">
          <div class="oni-ml-arena-title">Magic Lesson — ${spellName ?? ""}</div>
          <div class="oni-ml-combatants">
            <div class="oni-ml-combatant">
              <div class="oni-ml-token-wrap oni-ml-token-flip">
                <img src="${teacherImg}" alt="${teacherName}">
              </div>
              <div class="oni-ml-actor-name">${teacherName}</div>
              <div class="oni-ml-counter" id="oni-ml-ctr-teacher">0</div>
            </div>

            <div class="oni-ml-vs">
              <div class="oni-ml-vs-spell"><img src="${centerIcon}" alt="✨"></div>
              <div class="oni-ml-vs-label">VS</div>
            </div>

            <div class="oni-ml-combatant">
              <div class="oni-ml-token-wrap">
                <img src="${targetImg}" alt="${targetName}">
              </div>
              <div class="oni-ml-actor-name">${targetName}</div>
              <div class="oni-ml-counter" id="oni-ml-ctr-target">0</div>
            </div>
          </div>
          <div id="oni-ml-result-area"></div>
        </div>
      `;
      document.body.appendChild(ovl);

      _playSound(SFX.TEACHING, 0.7);

      // Spin counters
      let _tVal = 0, _gVal = 0;
      function _frame(ts) {
        if (_resultShown) return;
        if (ts - _lastFrameMs >= TICK_MS) {
          _lastFrameMs = ts;
          _tVal = (_tVal + 1) % (ROLL_CAP + 1);
          _gVal = (_gVal + 3) % (ROLL_CAP + 1);
          const tEl = document.getElementById("oni-ml-ctr-teacher");
          const gEl = document.getElementById("oni-ml-ctr-target");
          if (tEl) tEl.textContent = _tVal;
          if (gEl) gEl.textContent = _gVal;
        }
        _rafId = requestAnimationFrame(_frame);
      }
      _rafId = requestAnimationFrame(_frame);
    },

    // ------------------------------------------------------------------
    // Stage 4 — Reveal
    // ------------------------------------------------------------------
    applyResult(actorId, targetActorId, spellName, spellImg, teacherTotal, targetTotal, usages) {
      if (_resultShown) return;
      _resultShown = true;

      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

      const tEl = document.getElementById("oni-ml-ctr-teacher");
      const gEl = document.getElementById("oni-ml-ctr-target");
      if (tEl) { tEl.textContent = teacherTotal; tEl.classList.add("locked"); }
      if (gEl) { gEl.textContent = targetTotal;  gEl.classList.add("locked"); }

      _playSound(SFX.REVEAL, 0.7);

      setTimeout(() => {
        const area = document.getElementById("oni-ml-result-area");
        if (!area) return;

        const usagesLabel =
          usages >= 3 ? "Perfect resonance!" :
          usages >= 2 ? "Good attunement!"   :
                        "Partial transfer.";

        const targetActor   = game.actors?.get(targetActorId);
        const teacherActor  = game.actors?.get(actorId);
        const targetName    = targetActor?.name ?? "?";
        const centerIcon    = spellImg || LESSON_ICON;

        area.innerHTML = `
          <div class="oni-ml-result-row">
            <div class="oni-ml-spell-taught">
              <img src="${centerIcon}" alt="">
              ${spellName ?? ""}
            </div>
            <div class="oni-ml-usages-txt">${usages} use${usages > 1 ? "s" : ""} granted</div>
            <div class="oni-ml-usages-sub">${usagesLabel} — ${targetName} may cast this spell ${usages > 1 ? `${usages} times` : "once"} before the next rest.</div>
            <button class="oni-ml-proceed-btn" id="oni-ml-proceed" style="display:none;">Click to Proceed</button>
          </div>
        `;

        _playSound(SFX.RESULT, 0.7);

        const proceedBtn = document.getElementById("oni-ml-proceed");
        if (proceedBtn && _currentTeacherActorId) {
          if (_isOwner(teacherActor)) {
            proceedBtn.style.display = "";
            proceedBtn.addEventListener("click", () => {
              proceedBtn.disabled = true;
              if (game.user?.isGM) {
                CAMP.MagicLessonUI.resolveProceed(_currentTeacherActorId);
              } else {
                CAMP.Socket.emit(CAMP.MSG.MAGIC_LESSON_PROCEED, { actorId: _currentTeacherActorId });
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
      el.classList.add("oni-ml-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Magic Lesson UI loaded.");
})();
