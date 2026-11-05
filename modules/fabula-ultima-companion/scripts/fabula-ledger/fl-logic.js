/**
 * Fabula Ledger — pure rules (no Foundry calls; node-testable)
 *
 * File: scripts/fabula-ledger/fl-logic.js
 *
 * Decides what happens when a villain appears, and how a Fabula Point change
 * respects the cap. Everything that touches Foundry lives in fl-ledger.js.
 *
 * The villain rule (design v4, agreed with the user 2026-11-05):
 *   - A villain pays +1 to the party once per VISIT (the party arriving on a
 *     scene, until the active scene changes). At most 3 villain points per visit.
 *   - Every new visit can pay again. Two patterns look like farming and ASK the
 *     GM instead of paying, even with Auto-pay on:
 *       followed   — the villain was paid during the visit right before this one
 *       stationary — this same token already paid this session and has not moved
 *   - Status (actor flag): auto (unset) | villain | hidden | never.
 *       auto + Champion rank -> ask the GM ("first" prompt), or pay with Auto-pay
 *       auto + not Champion  -> not a villain, ignored
 *       villain              -> pays without asking
 *       hidden / never       -> never pays from detection
 *   - Explicit sources skip the questions:
 *       event    (Villain Entrance command)  pays unless never / already paid this visit
 *       cameo    (GM hotkey)                 same as event
 *       reveal   (Reveal / status command)   same as event
 *       escalate (a villain escalates)       always pays: a new villain (book p.102)
 *
 * The cap: automatic gains stop at FP_CAP. A total already above the cap is
 * left alone until spent; a spend is never clamped.
 */
(() => {
  const STATUS = Object.freeze({ AUTO: "auto", VILLAIN: "villain", HIDDEN: "hidden", NEVER: "never" });
  const STATUSES = Object.freeze(Object.values(STATUS));
  const FP_CAP = 10;
  const VISIT_VILLAIN_CAP = 3;
  // A token that moved less than this (px) counts as "still there".
  const STILL_TOLERANCE_PX = 2;

  const EXPLICIT = new Set(["event", "cameo", "reveal"]);
  const DETECTED = new Set(["token", "theatre"]);

  function normStatus(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    return STATUSES.includes(s) ? s : STATUS.AUTO;
  }

  function isChampionRank(rank) {
    return String(rank ?? "").trim().toLowerCase() === "champion";
  }

  /** Where a token stands, as stored in the ledger. */
  function tokenSpot(app) {
    if (!app?.tokenId) return null;
    return { sceneId: String(app.sceneId ?? ""), x: Number(app.x) || 0, y: Number(app.y) || 0 };
  }

  function sameSpot(a, b) {
    if (!a || !b) return false;
    return a.sceneId === b.sceneId
      && Math.abs(a.x - b.x) <= STILL_TOLERANCE_PX
      && Math.abs(a.y - b.y) <= STILL_TOLERANCE_PX;
  }

  function tokenKey(app) {
    return app?.tokenId ? `${app.sceneId}.${app.tokenId}` : null;
  }

  /**
   * appearance: { actorId, source, status, rank, tokenId?, sceneId?, x?, y? }
   * state:      { visit: { paid: [actorId] }, prevVisit: { paid: [] },
   *               paidTokens: { key: spot }, muted: { key: spot } }
   * opts:       { autoPay: boolean }
   *
   * -> { action: "pay" | "ask" | "ignore", reason, prompt?: "first" | "loop", loop?: "followed" | "stationary" }
   */
  function decideAppearance(appearance, state, opts = {}) {
    const app = appearance ?? {};
    const st = state ?? {};
    const actorId = String(app.actorId ?? "");
    const source = String(app.source ?? "token");
    const status = normStatus(app.status);
    const visitPaid = st.visit?.paid ?? [];
    const prevPaid = st.prevVisit?.paid ?? [];

    if (!actorId) return { action: "ignore", reason: "no-actor" };

    if (source === "escalate") {
      return status === STATUS.NEVER ? { action: "ignore", reason: "status-never" } : { action: "pay", reason: "escalation" };
    }

    if (status === STATUS.NEVER) return { action: "ignore", reason: "status-never" };

    if (EXPLICIT.has(source)) {
      if (visitPaid.includes(actorId)) return { action: "ignore", reason: "paid-this-visit" };
      if (visitPaid.length >= VISIT_VILLAIN_CAP) return { action: "ignore", reason: "visit-cap" };
      return { action: "pay", reason: source };
    }

    if (!DETECTED.has(source)) return { action: "ignore", reason: "unknown-source" };

    if (status === STATUS.HIDDEN) return { action: "ignore", reason: "status-hidden" };
    if (status === STATUS.AUTO && !isChampionRank(app.rank)) return { action: "ignore", reason: "not-a-villain" };
    if (visitPaid.includes(actorId)) return { action: "ignore", reason: "paid-this-visit" };
    if (visitPaid.length >= VISIT_VILLAIN_CAP) return { action: "ignore", reason: "visit-cap" };

    const key = tokenKey(app);
    const spot = tokenSpot(app);
    if (key && sameSpot(st.muted?.[key], spot)) return { action: "ignore", reason: "muted" };

    // An unset Champion is a status question first; the loop question comes
    // only once the GM has said they are a villain.
    if (status === STATUS.AUTO && !opts.autoPay) return { action: "ask", reason: "unset", prompt: "first" };

    if (key && sameSpot(st.paidTokens?.[key], spot)) {
      return { action: "ask", reason: "loop", prompt: "loop", loop: "stationary" };
    }
    if (prevPaid.includes(actorId)) {
      return { action: "ask", reason: "loop", prompt: "loop", loop: "followed" };
    }

    return { action: "pay", reason: status === STATUS.AUTO ? "auto-pay" : "villain" };
  }

  /**
   * A change to one character's Fabula Points.
   * -> { next, gained, overflow }   (gained is negative for a spend)
   */
  function applyCap(current, delta, cap = FP_CAP) {
    const cur = Math.max(0, Math.round(Number(current) || 0));
    const d = Math.round(Number(delta) || 0);
    if (d >= 0) {
      const ceiling = Math.max(cur, cap);
      const next = Math.min(ceiling, cur + d);
      return { next, gained: next - cur, overflow: d - (next - cur) };
    }
    const next = Math.max(0, cur + d);
    return { next, gained: next - cur, overflow: 0 };
  }

  /** The buttons a GM prompt shows. */
  function promptButtons(kind) {
    if (kind === "first") return ["confirm", "skip", "hidden", "never"];
    return ["confirm", "skip"];
  }

  /** The small grey text after "Award Fabula Point?". */
  function promptReason(appearance, decision) {
    const where = { token: "token", theatre: "Theatre", event: "event", cameo: "cameo", reveal: "reveal" }[appearance?.source] ?? "seen";
    if (decision?.loop === "stationary") return "again, same spot";
    if (decision?.loop === "followed") return "again, right after the last map";
    return where;
  }

  const Logic = {
    STATUS, STATUSES, FP_CAP, VISIT_VILLAIN_CAP,
    normStatus, isChampionRank, tokenKey, tokenSpot, sameSpot,
    decideAppearance, applyCap, promptButtons, promptReason
  };

  globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  globalThis.FabulaLedger.Logic = Logic;
})();
