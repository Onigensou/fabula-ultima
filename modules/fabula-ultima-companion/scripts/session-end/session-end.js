/**
 * scripts/session-end/session-end.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Ends the session for players. The GM sends each player a parchment prompt with
 * a bell: "Leave now" logs them out, otherwise a countdown does it for them.
 * Closing the tab works too.
 *
 * Why: players who aren't on voice and aren't comfortable with the browser still
 * get a clear "we're done" and leave on their own (first use: the 2026-10-29
 * forge-mirror test).
 *
 * GM API — FUCompanion.api.sessionEnd:
 *   start(userIds?, { seconds = 180, text? })  omit userIds = every active player;
 *                                              text = string or [before, bold, after]
 *   cancel(userIds?)                           closes the prompt, nobody is logged out
 *   log                                        [{ userId, name, how, at }] from players
 *                                              as they leave; how = "button" | "timeout"
 */
(() => {
  const TAG = "[FUCompanion][SessionEnd]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const MSG_START = "FU_SESSION_END";
  const MSG_CANCEL = "FU_SESSION_END_CANCEL";
  const MSG_LEAVING = "FU_SESSION_END_LEAVING";
  // RPG Maker bell, 2.8 s. It's in forge-mirror, so it plays at once for players on slow Forge routes.
  const BELL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Bell1.ogg";
  const BELL_VOLUME = 0.8;
  const DEFAULT_SECONDS = 180;
  const REMIND_AT_S = 60;          // the bell rings again when this much is left
  const DEFAULT_TEXT = "The session has ended. Thank you for playing!";
  const LOGOUT_DELAY_MS = 400;     // lets the "leaving" message reach the GM before the socket closes
  const OUT_MS = 280;              // keep in step with #oni-session-end.se-leaving

  const AH = () => foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? game.user?.isGM ?? false;
  const record = (kind, data) => { try { globalThis.FUCompanion?.api?.clientHealth?.record?.(kind, data); } catch { /* logger optional */ } };
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const log = [];
  let open = null;                 // { finish } of the prompt on screen
  let leaving = false;

  // ── prompt ─────────────────────────────────────────────────────────────────
  // Same skin as the teleporter prompt (tp-bootstrap.js #oni-tp-prompt), which follows
  // the Save/Load confirm panel. It sits above the load indicator's black cover (z 99999).
  function ensureStyle() {
    if (document.getElementById("oni-session-end-style")) return;
    const s = document.createElement("style");
    s.id = "oni-session-end-style";
    s.textContent = `
#oni-session-end {
  position: fixed;
  left: 50%;
  top: 42%;
  z-index: 100002;
  box-sizing: border-box;
  min-width: 420px;
  max-width: min(820px, 90vw);
  padding: 30px 46px 40px;
  border: 2px solid #c9a44a;
  border-radius: 14px;
  background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 0 28px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,245,200,0.70);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif;
  color: #3a1e06;
  user-select: none;
  pointer-events: auto;
  opacity: 0;
  transform: translate(calc(-50% - 32px), -50%);   /* enters from the left */
  transition: opacity 360ms cubic-bezier(.25,.46,.45,.94),
              transform 360ms cubic-bezier(.25,.46,.45,.94);
}
#oni-session-end::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 12px;
  background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
}
#oni-session-end.se-visible { opacity: 1; transform: translate(-50%, -50%); }
#oni-session-end.se-leaving {
  opacity: 0;
  transform: translate(calc(-50% + 32px), -50%);   /* leaves to the right */
  transition: opacity 280ms cubic-bezier(.55,.085,.68,.53),
              transform 280ms cubic-bezier(.55,.085,.68,.53);
  pointer-events: none;
}
#oni-session-end .se-msg {
  position: relative; margin: 0; padding: 0; text-align: center;
  font-size: 20px; font-weight: 400; line-height: 1.5; letter-spacing: .3px; color: #3a1e06;
}
#oni-session-end .se-msg strong { font-weight: 700; }
#oni-session-end .se-count {
  position: relative; margin: 6px 0 0; text-align: center;
  font-size: 14px; font-style: italic; color: #6b4a22; opacity: .85;
}
#oni-session-end .se-actions { position: absolute; right: 18px; bottom: -22px; display: flex; gap: 12px; }
#oni-session-end .se-leave {
  position: relative; box-sizing: border-box; min-width: 112px; height: 40px; margin: 0; padding: 0 26px;
  border: 1px solid #f4d488; border-radius: 8px;
  background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%);
  color: #fff8e0; font-family: inherit; font-size: 16px; font-weight: 400; line-height: 1; letter-spacing: .8px;
  cursor: pointer;
  box-shadow: 0 0 0 2px #f4d488, 0 0 18px rgba(244,212,136,0.55), 0 2px 6px rgba(40,18,4,0.38), inset 0 1px 0 rgba(255,225,140,0.22);
}
#oni-session-end .se-leave:focus { outline: none; }
    `;
    document.head.appendChild(s);
  }

  function bell() {
    try { AH()?.play({ src: BELL, volume: BELL_VOLUME, autoplay: true, loop: false }, false); } catch { /* audio optional */ }
  }

  function show(seconds, text) {
    open?.finish();
    ensureStyle();
    const deadline = Date.now() + seconds * 1000;
    const el = document.createElement("div");
    el.id = "oni-session-end";
    el.setAttribute("role", "alertdialog");
    el.innerHTML = `
      <p class="se-msg"></p>
      <p class="se-count"></p>
      <div class="se-actions"><button type="button" class="se-leave">Leave now</button></div>`;
    const msg = el.querySelector(".se-msg");
    if (Array.isArray(text)) {
      const strong = document.createElement("strong");
      strong.textContent = text[1] ?? "";
      msg.append(text[0] ?? "", strong, text[2] ?? "");
    } else {
      msg.textContent = text;
    }
    const count = el.querySelector(".se-count");
    const title = document.title;
    let reminded = seconds <= REMIND_AT_S;
    let flash = false;
    let timer = null;

    const entry = {
      finish() {
        if (open !== entry) return;
        open = null;
        clearInterval(timer);
        window.removeEventListener("keydown", onKey, true);
        document.title = title;
        el.classList.remove("se-visible");
        el.classList.add("se-leaving");
        setTimeout(() => el.remove(), OUT_MS + 40);
      },
    };
    // Wall-clock countdown: timers in a hidden tab run late, the deadline doesn't move.
    const tick = () => {
      if (open !== entry) return;
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      count.textContent = `Logging you out in ${mmss(left)}`;
      if (!reminded && left <= REMIND_AT_S) { reminded = true; bell(); }
      // A hidden tab shows the bell in its title, so a player in another tab sees it.
      flash = document.hidden ? !flash : false;
      document.title = flash ? "🔔 Session ended" : title;
      if (left <= 0) leave("timeout");
    };
    function onKey(ev) {
      // Leave typing alone (chat box, sheet fields).
      if (ev.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      leave("button");
    }

    // pointerdown is swallowed so the click never reaches the canvas underneath
    el.addEventListener("pointerdown", ev => ev.stopPropagation());
    el.querySelector(".se-leave").addEventListener("click", () => leave("button"));
    window.addEventListener("keydown", onKey, true);
    open = entry;
    tick();
    timer = setInterval(tick, 1000);
    document.body.appendChild(el);
    // Two frames so the starting (hidden, offset) state is painted before the transition.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (open === entry) el.classList.add("se-visible"); }));
    bell();
    record("session-end-shown", { seconds });
  }

  function leave(how) {
    if (leaving) return;
    leaving = true;
    open?.finish();
    record("session-end", { how });
    try { game.socket.emit(SOCKET_NS, { type: MSG_LEAVING, userId: game.userId, how }); } catch { /* best effort */ }
    setTimeout(() => game.logOut(), LOGOUT_DELAY_MS);
  }

  // ── GM API ─────────────────────────────────────────────────────────────────
  const targets = userIds => (Array.isArray(userIds) && userIds.length
    ? userIds
    : game.users.filter(u => u.active && !u.isGM).map(u => u.id));

  const api = ((globalThis.FUCompanion ??= {}).api ??= {});
  api.sessionEnd = {
    log,
    start(userIds, { seconds = DEFAULT_SECONDS, text = null } = {}) {
      if (!game.user?.isGM) return null;
      const to = targets(userIds);
      game.socket.emit(SOCKET_NS, { type: MSG_START, to, seconds, text });
      console.info(TAG, `prompt sent to ${to.length} player(s), ${seconds} s`);
      return to;
    },
    cancel(userIds) {
      if (!game.user?.isGM) return null;
      const to = targets(userIds);
      game.socket.emit(SOCKET_NS, { type: MSG_CANCEL, to });
      return to;
    },
  };

  // ── wiring ─────────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    game.socket.on(SOCKET_NS, payload => {
      if (!payload?.type) return;
      if (payload.type === MSG_LEAVING) {
        if (!game.user.isGM) return;
        const entry = { userId: payload.userId, name: game.users.get(payload.userId)?.name ?? null, how: payload.how, at: Date.now() };
        log.push(entry);
        if (isPrimaryGM()) record("session-end", entry);
        return;
      }
      if (game.user.isGM || !Array.isArray(payload.to) || !payload.to.includes(game.userId)) return;
      if (payload.type === MSG_START) show(Number(payload.seconds) > 0 ? Math.max(1, Math.round(Number(payload.seconds))) : DEFAULT_SECONDS, payload.text ?? DEFAULT_TEXT);
      else if (payload.type === MSG_CANCEL) open?.finish();
    });
    // Loaded ahead so the bell rings the moment the prompt opens.
    if (!game.user.isGM) { try { AH()?.preloadSound?.(BELL); } catch { /* audio optional */ } }
  });
})();
