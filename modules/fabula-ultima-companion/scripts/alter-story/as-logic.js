/**
 * Alter the Story — pure rules (no Foundry calls; node-testable)
 *
 * File: scripts/alter-story/as-logic.js
 *
 * Rulebook p.98 (PDF 100-101): a player spends 1 Fabula Point to make a
 * statement about the story, adding a new element or changing one already
 * there. Changing a GM element needs the GM; touching another hero needs that
 * player. No direct mechanics. House rules (user, 2026-11-11):
 *   - every request goes to the Main GM (even brand-new elements)
 *   - the point is spent only when the GM approves; spending gives NO EXP
 *   - one request at a time for the whole table
 *   - the hold is a soft banner: no player can stop the game. The GM can
 *     cancel any request, and pauses for real with Space (pause-screen.js).
 *
 * A request moves through phases:
 *
 *   writing ──submit──> consent ──all agree──> gm ──approve──> fate ──> (done)
 *      ^                   │ refuse               │ deny ──> denied ──> (done)
 *      └───────────────────┴──────── revise ──────┘
 *   any open phase ──cancel──> (done, nothing spent)
 *
 * Everything that touches Foundry lives in as-core.js / as-ui.js.
 */
(() => {
  const PHASE = Object.freeze({
    WRITING: "writing", CONSENT: "consent", GM: "gm", FATE: "fate", DENIED: "denied"
  });
  const OPEN_PHASES = new Set([PHASE.WRITING, PHASE.CONSENT, PHASE.GM]);
  const KINDS = Object.freeze(["add", "change"]);
  const COST = 1;
  const TEXT_MAX = 400;
  const NOTE_MAX = 200;
  const REASON_MAX = 160;
  const RECAP_MAX = 110;   // Party Talk clamps at 120 units

  const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  /** May this user open a request right now? → { ok, reason } */
  function canOpen({ isGM = false, hasCharacter = false, fp = 0, active = null, sceneMode = "" } = {}) {
    if (isGM) return { ok: false, reason: "gm" };
    if (!hasCharacter) return { ok: false, reason: "no-character" };
    if (["title", "gacha"].includes(String(sceneMode).toLowerCase())) return { ok: false, reason: "scene" };
    if (active) return { ok: false, reason: "busy" };
    if ((Number(fp) || 0) < COST) return { ok: false, reason: "no-fp" };
    return { ok: true, reason: null };
  }

  /** A new request in the writing phase. */
  function create({ id, userId, actorId, actorName = "", img = "", sceneId = null, sceneMode = "", fp = 0, now = 0 }) {
    return {
      id, userId, actorId, actorName, img, sceneId, sceneMode, fpBefore: Number(fp) || 0,
      phase: PHASE.WRITING, kind: "add", text: "", spoken: false,
      involves: [],          // [{ actorId, name, img, userId|null }]
      consents: {},          // actorId -> "pending" | "yes" | "no"
      note: "", reason: "",  // GM note (approve) / reason (revise, refuse)
      createdAt: now, updatedAt: now
    };
  }

  /** Clean what the writer sent. → { ok, value | reason } */
  function validateSubmit(raw = {}) {
    const kind = KINDS.includes(raw.kind) ? raw.kind : "add";
    const spoken = !!raw.spoken;
    const text = str(raw.text, TEXT_MAX);
    if (!spoken && !text) return { ok: false, reason: "empty" };
    const seen = new Set();
    const involves = (Array.isArray(raw.involves) ? raw.involves : [])
      .filter(h => h && h.actorId && !seen.has(h.actorId) && seen.add(h.actorId))
      .slice(0, 6)
      .map(h => ({ actorId: String(h.actorId), name: str(h.name, 60), img: String(h.img ?? ""), userId: h.userId ? String(h.userId) : null }));
    return { ok: true, value: { kind, spoken, text, involves } };
  }

  const bump = (r, patch, now) => ({ ...r, ...patch, updatedAt: now ?? r.updatedAt });

  /**
   * Apply one event to a request. Returns { req, effect } where req is the new
   * request (null = closed) and effect names what the authority must do:
   *   "none" | "spend" (approved: run the cinematic, then spend) | "closed"
   * An event that does not fit the phase returns { req: same, effect: "ignored" }.
   */
  function reduce(req, ev = {}, now = 0) {
    if (!req) return { req: null, effect: "ignored" };
    const ignored = { req, effect: "ignored" };
    switch (ev.type) {
      case "submit": {
        if (req.phase !== PHASE.WRITING) return ignored;
        const v = validateSubmit(ev);
        if (!v.ok) return ignored;
        // Consent only from heroes whose player is someone else and online;
        // an offline or unowned hero falls to the GM (the GM sees the tag).
        const consents = {};
        for (const h of v.value.involves) if (h.userId && h.userId !== req.userId) consents[h.actorId] = "pending";
        const phase = Object.keys(consents).length ? PHASE.CONSENT : PHASE.GM;
        return { req: bump(req, { ...v.value, consents, phase, reason: "" }, now), effect: "none" };
      }
      case "consent": {
        if (req.phase !== PHASE.CONSENT || !(ev.actorId in req.consents)) return ignored;
        if (req.consents[ev.actorId] !== "pending") return ignored;
        const consents = { ...req.consents, [ev.actorId]: ev.yes ? "yes" : "no" };
        if (!ev.yes) {
          const who = req.involves.find(h => h.actorId === ev.actorId)?.name ?? "A hero";
          return { req: bump(req, { consents: {}, phase: PHASE.WRITING, reason: `${who} said no. Change it and send again.` }, now), effect: "none" };
        }
        const done = Object.values(consents).every(c => c === "yes");
        return { req: bump(req, { consents, phase: done ? PHASE.GM : PHASE.CONSENT }, now), effect: "none" };
      }
      case "approve": {
        if (req.phase !== PHASE.GM) return ignored;
        return { req: bump(req, { phase: PHASE.FATE, note: str(ev.note, NOTE_MAX) }, now), effect: "spend" };
      }
      case "deny": {
        if (req.phase !== PHASE.GM) return ignored;
        return { req: bump(req, { phase: PHASE.DENIED, reason: str(ev.reason, REASON_MAX) }, now), effect: "none" };
      }
      case "revise": {
        if (req.phase !== PHASE.GM) return ignored;
        return { req: bump(req, { phase: PHASE.WRITING, consents: {}, reason: str(ev.reason, REASON_MAX) || "The GM asks you to change it." }, now), effect: "none" };
      }
      case "cancel": {
        if (!OPEN_PHASES.has(req.phase)) return ignored;
        return { req: null, effect: "closed" };
      }
      case "finish": {
        if (req.phase !== PHASE.FATE && req.phase !== PHASE.DENIED) return ignored;
        return { req: null, effect: "closed" };
      }
      default: return ignored;
    }
  }

  /** Who may send this event? (the authority checks before reduce) */
  function mayAct(req, ev = {}, { userId, isGM = false } = {}) {
    if (!req) return false;
    switch (ev.type) {
      case "submit": return userId === req.userId;
      case "cancel": return isGM || userId === req.userId;
      case "consent": return req.involves.some(h => h.actorId === ev.actorId && h.userId === userId);
      case "approve": case "deny": case "revise": case "finish": return !!isGM;
      default: return false;
    }
  }

  /** The one Party Talk line after a fate (narrator, action mode). */
  function recapLine(req, spokenSummary = "") {
    const body = req.spoken ? (str(spokenSummary, TEXT_MAX) || "a new truth, told aloud") : req.text;
    const head = `Fate altered by ${req.actorName}: `;
    const room = Math.max(10, RECAP_MAX - head.length);
    const cut = body.length > room ? body.slice(0, room - 1).trimEnd() + "…" : body;
    return head + cut;
  }

  /** Statement shown in the cinematic. */
  function cineText(req) {
    if (req.spoken) return req.note ? "" : "Told at the table.";
    return `“${req.text}”`;
  }

  const Logic = { PHASE, OPEN_PHASES, KINDS, COST, TEXT_MAX, NOTE_MAX, canOpen, create, validateSubmit, reduce, mayAct, recapLine, cineText };
  globalThis.AlterStory = globalThis.AlterStory || {};
  globalThis.AlterStory.Logic = Logic;
})();
