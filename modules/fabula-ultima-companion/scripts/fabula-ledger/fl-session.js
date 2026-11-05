/**
 * Fabula Ledger — session open / close (step 3)
 *
 * File: scripts/fabula-ledger/fl-session.js
 *
 * No clocks (user, 2026-11-05: "catch it by in-game hook, not real time").
 * A session is a flag in the ledger record, moved by in-game moments:
 *
 *   OPENS   when a save finishes loading from the title screen and no session
 *           is open (hook fuSaveLoaded, title-screen/title-socket.js).
 *           Opening = SessionSystem.startSession() (start-of-session effects),
 *           +1 Fabula Point to every party member on 0, and a fresh loop memory.
 *   CLOSES  on the camp rest "return to title" yes (camp-rest-save-flow.js), on
 *           the session-end prompt (session-end.js) — both raise
 *           fuSessionClosing — or from the GM ledger panel.
 *   UNCLOSED  a title load while a session is still open (the tab was closed
 *           mid-night, or Foundry crashed) asks the GM: New session / Same session.
 *
 * SessionSystem.startSession() belongs to sarunphat and is manual on purpose
 * (it is not idempotent). Calling it here is gated by the open flag, so it runs
 * once per opened session. Design-call note: reports/2026-11-05-session-start-automation.md
 *
 * API: FUCompanion.api.fabula.session = { open(via), close(via), isOpen() }
 */
(() => {
  const TAG = "[FabulaLedger][Session]";
  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const I = () => FL._internal;
  const isPrimaryGM = () => I()?.isPrimaryGM?.() ?? false;
  const debug = (...a) => console.debug(TAG, ...a);
  const FP_PROP = "fabula_point";

  const isOpen = () => !!I()?.readState?.().session?.open;

  let _busy = false;   // one open at a time (a double load event must not run it twice)

  async function open(via = "gm") {
    if (!game.user?.isGM) return { ok: false };
    if (!isPrimaryGM()) return I().callPrimary("openSession", [via]);
    if (_busy) return { ok: false, reason: "busy" };
    _busy = true;
    try {
      await I().mutate((s) => {
        s.session = { open: true, id: foundry.utils.randomID(), openedAt: Date.now(), closedAt: null };
      });
      await FL.api.resetSession();
      await I().note(`Session opened (${via})`);
      debug("opened", via);

      // Anyone on 0 Fabula Points starts the night with 1.
      const party = await I().partyActors();
      const empty = party.filter(a => (Number(a.system?.props?.[FP_PROP] ?? 0) || 0) <= 0);
      if (empty.length) {
        await FL.api.change(empty, 1, { reason: "session", label: empty.map(a => a.name).join(", ") });
      }

      // Start-of-session effects (Instability decay, Fatigue, Lucky Seven).
      // NOT awaited: some wait for the GM to click a roll (Hina's Instability
      // Recovery "Roll d6"), which must not hold up the ledger. Found in the
      // sandbox 2026-11-05.
      Promise.resolve()
        .then(() => globalThis.SessionSystem?.startSession?.())
        .catch((e) => console.error(TAG, "SessionSystem.startSession failed", e));

      return { ok: true, paid: empty.map(a => a.name) };
    } finally {
      _busy = false;
    }
  }

  async function close(via = "gm") {
    if (!game.user?.isGM) return { ok: false };
    if (!isPrimaryGM()) return I().callPrimary("closeSession", [via]);
    if (!isOpen()) return { ok: true, already: true };
    await I().mutate((s) => { s.session = { ...s.session, open: false, closedAt: Date.now() }; });
    await I().note(`Session closed (${via})`);
    debug("closed", via);
    return { ok: true };
  }

  async function onSaveLoaded(info = {}) {
    if (!game.user?.isGM) return;
    if (!isPrimaryGM()) return I().callPrimary("sessionLoaded", [info]);
    if (!isOpen()) return open("save loaded");
    // The last session was never closed. Ask; the GM knows if tonight is new.
    const s = I().readState().session;
    const when = s.openedAt ? new Date(s.openedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const answer = await FL.Prompt?.show?.({
      kind: "session", title: "New session?",
      name: "last one still open", reason: when ? `since ${when}` : "",
      buttons: ["new", "same"]
    });
    if (answer === "new") return open("save loaded");
    await I().note("Session carried on after a load");
    return { ok: true, carried: true };
  }

  Hooks.on("fuSaveLoaded", (info) => { onSaveLoaded(info); });
  Hooks.on("fuSessionClosing", (info) => { if (game.user?.isGM) close(info?.via ?? "gm"); });

  Hooks.once("ready", () => {
    if (!I()) { console.error(TAG, "fl-ledger.js must load first."); return; }
    Object.assign(FL._calls, {
      openSession: (via) => open(via),
      closeSession: (via) => close(via),
      sessionLoaded: (info) => onSaveLoaded(info)
    });
    FL.api.session = { open, close, isOpen };
  });

  FL.Session = { open, close, isOpen, onSaveLoaded };
  console.debug(TAG, "installed");
})();
