// ============================================================================
// Session System — "Start Session" GM control
//
// A GM-only control in the bottom-left column that raises the director's
// `session_started` trigger for the whole party. That trigger carries the RAW
// "at the end of each session" / "at the beginning of each session" clauses —
// Hina's Instability decay, Keren's bodyguard Fatigue recovery, Lucky Seven's
// reset to 7.
//
// ── Why a button and not a detector ─────────────────────────────────────────
//
// A session's END cannot be observed: groups stop playing by closing the tab.
// A session's START can be guessed (an idle gap since a stored `lastSeenAt`, a
// save being loaded) but every heuristic is wrong sometimes — two sessions in
// one evening read as one, a three-week pause mid-session reads as two. Plain
// "world boot" is the worst of them: this project reloads Foundry constantly
// (tools/test-bridge-client/reload-foundry.ps1), so it would fire on reloads.
//
// So the boundary is MANUAL for now. When an automatic detector lands it can
// call `SessionSystem.startSession()` on this same path; neither the trigger
// nor the authored rows have to change.
//
// ── Why it is not idempotent ────────────────────────────────────────────────
//
// Pressing it twice runs the effects twice. That is why the confirm dialog
// exists and why it names that consequence out loud. A "once per real session"
// guard would need a session boundary to count against — which is precisely the
// thing that does not exist yet. Deliberate, not an oversight.
// ============================================================================
(() => {
  const SS        = globalThis.SessionSystem ??= {};
  const TAG       = "[SessionSystem][StartButton]";
  const MODULE_ID = "fabula-ultima-companion";

  const BTN_ID    = "fud-session-start-btn";
  const BTN_STYLE = "fud-session-start-style";
  const DLG_ID    = "fud-session-confirm";
  const DLG_STYLE = "fud-session-confirm-style";

  // Mirrors battle-director/dev-tools-menu.js so the two controls sit side by
  // side instead of on top of each other: that launcher is a 46px circle at
  // left:16 which bottom-anchors above the Players list and opens a vertical
  // child stack straight up from there. Sitting to its RIGHT (the same offset
  // its own `devToolsAnchorLeft` reports) keeps this clear of that stack.
  const DT_LEFT = 16, DT_SIZE = 46, DT_GAP = 12;
  const LEFT       = DT_LEFT + DT_SIZE + DT_GAP;   // 74
  const BOTTOM_PAD = 12;

  // Title-screen SFX set — the same three cues the Quit confirm uses, so a
  // confirm sounds like every other confirm in this world.
  const SFX_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/UI";
  const SFX = {
    navigate: `${SFX_BASE}/BattleCursor_4.wav`,
    select:   `${SFX_BASE}/file_selector_screen.wav`,
    cancel:   `${SFX_BASE}/bond_cleared.wav`,
  };
  function sfx(key) {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper ?? null;
      AH?.play({ src: SFX[key], volume: 0.45, loop: false });
    } catch { /* audio is never load-bearing */ }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  SS.startSession = async function startSession() {
    if (!game.user?.isGM) {
      console.warn(TAG, "startSession called by a non-GM — ignored.");
      return { ok: false, reason: "not-gm", fired: [] };
    }

    let actors = [];
    try {
      actors = (await globalThis.CampSystem?.RestAPI?.getPartyActors?.()) ?? [];
    } catch (e) {
      console.error(TAG, "party resolution failed:", e);
      ui.notifications?.error?.("[Session] Could not resolve the party — see console.");
      return { ok: false, reason: "party-unresolved", fired: [] };
    }
    if (!actors.length) {
      ui.notifications?.warn?.("[Session] No party actors resolved — nothing to start.");
      return { ok: false, reason: "no-party", fired: [] };
    }

    // ABSOLUTE specifier: this is a classic (non-module) script, so a relative
    // import() would resolve against the PAGE url, not against this file.
    let fired = [];
    try {
      const { dispatchForcedTriggerForActors } = await import(
        `/modules/${MODULE_ID}/scripts/battle-director/standalone-reactions.js`
      );
      fired = await dispatchForcedTriggerForActors({
        trigger: "session_started",
        actors,
        payload: { partyActorUuids: actors.map((a) => a.uuid) },
      });
    } catch (e) {
      console.error(TAG, "session_started dispatch failed:", e);
      ui.notifications?.error?.("[Session] Start Session failed — see console.");
      return { ok: false, reason: "dispatch-threw", fired: [] };
    }

    // Count what APPLIED, not what dispatched. A row can match, roll its die and
    // then write nothing (chain resolved zero targets) — reporting that as
    // "applied" turns a silent no-op into a confident false claim, and leaves a
    // bug report with no thread to pull. `applied` is set by
    // dispatchForcedTriggerForActors from the chain's own ok flag.
    const applied = fired.filter((f) => f.applied);
    const failed  = fired.filter((f) => !f.applied);
    console.debug(
      TAG, `session_started: ${fired.length} dispatched, ${applied.length} applied`,
      fired.map((f) => `${f.reactorName}: ${f.candidate?.carrierName}${f.applied ? "" : ` (NO-OP: ${f.reason ?? "unknown"})`}`),
    );

    // Surface the discrepancy rather than burying it: a row that matched and did
    // nothing is the one failure mode a GM cannot otherwise detect.
    if (failed.length) {
      ui.notifications?.warn?.(
        `[Session] ${failed.length} session effect(s) matched but applied nothing — see console.`,
      );
    }
    // Report the count even when it is zero. A forced dispatch that matched
    // nothing looks exactly like one that never ran, and the GM has no other
    // signal that the button did anything at all.
    ui.notifications?.info?.(
      applied.length
        ? `[Session] New session started — ${applied.length} effect(s) applied.`
        : "[Session] New session started — no session effects were due.",
    );
    return { ok: true, fired, applied: applied.length };
  };

  // ---------------------------------------------------------------------------
  // Confirm dialog — title-screen parchment language (see title-quit-ui.js)
  // ---------------------------------------------------------------------------
  let _dlgKeyFn = null;
  let _running  = false;   // guards the await window inside commit()

  function _closeConfirm(quiet = false) {
    const el = document.getElementById(DLG_ID);
    if (!el) return;
    if (!quiet) sfx("cancel");
    el.remove();
    if (_dlgKeyFn) {
      document.removeEventListener("keydown", _dlgKeyFn, { capture: true });
      _dlgKeyFn = null;
    }
  }

  function _openConfirm() {
    if (_running) return;
    if (document.getElementById(DLG_ID)) return;
    _ensureDialogStyle();

    const el = document.createElement("div");
    el.id = DLG_ID;
    el.innerHTML = `
      <div class="fud-ss-inner">
        <div class="fud-ss-title">&#10022;&nbsp; NEW SESSION &nbsp;&#10022;</div>
        <div class="fud-ss-sub">BEGIN A NEW SESSION?</div>
        <div class="fud-ss-note">
          Applies every start-of-session effect to the party &mdash;<br>
          Instability and bodyguard Fatigue recover, lucky numbers reset.
        </div>
        <div class="fud-ss-warn">Not undoable &mdash; pressing it twice applies it twice.</div>
        <div class="fud-ss-btns">
          <button class="fud-ss-btn is-focus" data-choice="yes">CONFIRM</button>
          <button class="fud-ss-btn" data-choice="no">&#9668; CANCEL</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    const yes = el.querySelector('[data-choice="yes"]');
    const no  = el.querySelector('[data-choice="no"]');
    const focus = (winner, loser) => {
      sfx("navigate");
      winner.classList.add("is-focus");
      loser.classList.remove("is-focus");
    };

    const commit = async () => {
      if (_running) return;
      _running = true;
      sfx("select");
      // Close FIRST. The dispatch awaits real reaction chains, and leaving the
      // modal up across that window invites a second click landing while the
      // first handler is still in flight — i.e. the exact double-apply the
      // warning line names. `_running` covers the gap either way.
      _closeConfirm(true);
      try { await SS.startSession(); }
      finally { _running = false; }
    };

    yes.addEventListener("click", commit);
    no.addEventListener("click", () => _closeConfirm());
    // Clicking the backdrop cancels, matching the other dismissable overlays.
    el.addEventListener("mousedown", (ev) => { if (ev.target === el) _closeConfirm(); });
    yes.addEventListener("mouseenter", () => focus(yes, no));
    no.addEventListener("mouseenter",  () => focus(no, yes));

    _dlgKeyFn = (e) => {
      if (!document.getElementById(DLG_ID)) return;
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        _closeConfirm();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (yes.classList.contains("is-focus")) focus(no, yes); else focus(yes, no);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (yes.classList.contains("is-focus")) commit(); else _closeConfirm();
      }
    };
    document.addEventListener("keydown", _dlgKeyFn, { capture: true });
  }

  // ---------------------------------------------------------------------------
  // Button mount
  // ---------------------------------------------------------------------------
  function _playersHeight() {
    const players = document.getElementById("players");
    return players ? (players.offsetHeight || 0) : 0;
  }

  function _reposition() {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.style.bottom = `${_playersHeight() + BOTTOM_PAD}px`;
  }

  function _mount() {
    if (!game.user?.isGM) return;
    if (document.getElementById(BTN_ID)) { _reposition(); return; }
    _ensureButtonStyle();

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "Begin a new session — applies start-of-session effects to the party";
    btn.innerHTML = '<span class="fud-ss-badge">GM</span><span class="fud-ss-label">START SESSION</span>';
    btn.addEventListener("click", () => { sfx("navigate"); _openConfirm(); });
    document.body.appendChild(btn);
    _reposition();

    // The Players list grows and shrinks as users connect and expand it; the
    // dev-tools launcher tracks it for the same reason. Without this the button
    // ends up behind that box on a busy table.
    try {
      const players = document.getElementById("players");
      if (players && typeof ResizeObserver === "function") {
        new ResizeObserver(() => _reposition()).observe(players);
      }
    } catch { /* the observer is an optimisation, not a requirement */ }

    console.debug(TAG, "Start Session button mounted.");
  }

  function _ensureButtonStyle() {
    if (document.getElementById(BTN_STYLE)) return;
    const s = document.createElement("style");
    s.id = BTN_STYLE;
    // Palette lifted from camp-ui-gm-panel.js so this reads as the same class
    // of object: a GM-only floating control, not a player-facing one.
    s.textContent = `
#${BTN_ID} {
  position: fixed;
  left: ${LEFT}px;
  bottom: ${BOTTOM_PAD}px;
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(22,14,6,0.92);
  border: 1px solid rgba(180,120,40,0.65);
  border-radius: 10px;
  padding: 6px 11px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 2px 10px rgba(0,0,0,0.55);
  font-family: "Signika","Noto Sans",system-ui,sans-serif;
  transition: background .12s ease, border-color .12s ease, transform .12s ease;
}
#${BTN_ID}:hover {
  background: rgba(38,24,10,0.96);
  border-color: rgba(220,160,60,0.85);
  transform: translateY(-1px);
}
#${BTN_ID} .fud-ss-badge {
  font-size: .62em;
  font-weight: 800;
  letter-spacing: .8px;
  text-transform: uppercase;
  color: rgba(200,140,50,.9);
  background: rgba(180,120,40,.18);
  border: 1px solid rgba(180,120,40,.35);
  border-radius: 4px;
  padding: 1px 5px;
  line-height: 1.4;
}
#${BTN_ID} .fud-ss-label {
  font-size: .74em;
  font-weight: 600;
  letter-spacing: 1.4px;
  color: #e8c870;
  white-space: nowrap;
}
    `;
    document.head.appendChild(s);
  }

  function _ensureDialogStyle() {
    if (document.getElementById(DLG_STYLE)) return;
    const s = document.createElement("style");
    s.id = DLG_STYLE;
    // Parchment confirm, matching title-screen/title-quit-ui.js.
    s.textContent = `
#${DLG_ID} {
  position: fixed; inset: 0; z-index: 100000;
  background: rgba(18, 8, 1, 0.75);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  font-family: 'Lucida Console', 'Courier New', monospace;
  user-select: none;
}
#${DLG_ID} .fud-ss-inner {
  position: relative;
  background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
  border: 2px solid #c9a44a;
  box-shadow:
    0 0 0 3px #7a4e20, 0 0 0 6px #b8865a, 0 0 0 8px #5c3210,
    0 0 80px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,245,200,0.70);
  border-radius: 4px;
  padding: 46px 46px 36px;
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  min-width: 420px; max-width: 560px;
  animation: fud-ss-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes fud-ss-in {
  from { opacity: 0; transform: translateY(-18px); }
  to   { opacity: 1; transform: translateY(0); }
}
#${DLG_ID} .fud-ss-inner::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  border-radius: 4px;
  background: repeating-linear-gradient(
    0deg, transparent, transparent 23px,
    rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
}
#${DLG_ID} .fud-ss-inner > * { position: relative; }
#${DLG_ID} .fud-ss-title { font-size: 20px; letter-spacing: 8px; color: #3a1e06; }
#${DLG_ID} .fud-ss-sub   { font-size: 11px; letter-spacing: 3px; color: #7a5428; text-align: center; }
#${DLG_ID} .fud-ss-note  {
  font-size: 10px; letter-spacing: 1.6px; color: #7a5428;
  text-align: center; line-height: 1.9; text-transform: uppercase;
}
#${DLG_ID} .fud-ss-warn  {
  font-size: 9px; letter-spacing: 2px; color: #8b2210;
  text-align: center; text-transform: uppercase;
}
#${DLG_ID} .fud-ss-btns { display: flex; gap: 12px; width: 100%; margin-top: 4px; }
#${DLG_ID} .fud-ss-btn {
  flex: 1; padding: 14px; text-align: center;
  font-family: inherit; font-size: 11px;
  letter-spacing: 4px; text-transform: uppercase;
  border: 1px solid #9b7040;
  background: linear-gradient(180deg, #6a4828 0%, #4e3014 100%);
  color: #c8a05a; cursor: pointer; transition: all .12s;
  border-radius: 8px;
  box-shadow: 0 2px 5px rgba(40,18,4,0.30), inset 0 1px 0 rgba(255,225,140,0.10);
}
#${DLG_ID} .fud-ss-btn:hover, #${DLG_ID} .fud-ss-btn.is-focus {
  border-color: #c9a22a; color: #fff8e0;
  background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
  box-shadow: 0 0 16px rgba(201,162,42,0.24), 0 2px 5px rgba(40,18,4,0.30);
}
    `;
    document.head.appendChild(s);
  }

  Hooks.once("ready", () => _mount());
  // renderPlayerList fires whenever the Players box redraws (connect, expand);
  // re-anchor then too, covering browsers without ResizeObserver.
  Hooks.on("renderPlayerList", () => _reposition());

  SS.showStartButton = _mount;

  console.debug(TAG, "Start Session control loaded.");
})();
