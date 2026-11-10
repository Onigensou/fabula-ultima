/**
 * Alter the Story — authority, network, spend, record
 *
 * File: scripts/alter-story/as-core.js
 *
 * The Main GM (FUCompanion.isPrimaryGM) holds the one open request and is the
 * only client that changes it. Every other client sends an event and redraws
 * from the state the Main GM broadcasts. GM II watches the same state and can
 * cancel (forwarded like any other event); approve / deny / revise run on the
 * Main GM only. No Foundry chat anywhere (user, 2026-11-11).
 *
 * Messages on module.fabula-ultima-companion:
 *   AS_EVENT  any client -> Main GM   { ev, userId }
 *   AS_STATE  Main GM -> everyone     { req | null, closed?: { why, by } }
 *   AS_SYNC   a client that just loaded -> Main GM (answers with AS_STATE)
 *
 * After an approval the Main GM waits for the cinematic (FATE_MS), then spends
 * 1 FP through the Fabula Ledger (its tab rolls the number down and plays the
 * point sound for the owner), writes the "Altered Fates" journal and posts one
 * Party Talk narrator line where Talk runs. Spending gives no EXP.
 *
 * API: globalThis.AlterStory.api (also FUCompanion.api.alterStory)
 */
(() => {
  const TAG = "[AlterStory]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const MSG = Object.freeze({ EVENT: "AS_EVENT", STATE: "AS_STATE", SYNC: "AS_SYNC" });
  const FP_PROP = "fabula_point";
  const FATE_MS = 7600;     // the cinematic's length (as-ui.js CINE timings)
  const DENIED_MS = 3200;
  const JOURNAL_FLAG = "alteredFates";

  const AS = globalThis.AlterStory = globalThis.AlterStory || {};
  const L = AS.Logic;
  if (!L) { console.error(TAG, "as-logic.js must load first."); return; }

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? game.user?.isGM ?? false;
  const sceneMode = (scene = canvas?.scene) =>
    String(scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? "").trim().toLowerCase();
  const fpOf = (actor) => Number(actor?.system?.props?.[FP_PROP] ?? 0) || 0;

  // ── shared state (every client) ────────────────────────────────────────────
  let current = null;
  const listeners = new Set();
  function setState(req, closed = null) {
    const prev = current;
    current = req ?? null;
    for (const fn of [...listeners]) { try { fn(current, prev, closed); } catch (e) { console.warn(TAG, "listener threw", e); } }
  }
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  function emit(type, data = {}) { try { game.socket?.emit(SOCKET_NS, { type, ...data }); } catch (e) { console.warn(TAG, "emit failed", e); } }
  function broadcast(req, closed = null) { emit(MSG.STATE, { req, closed }); setState(req, closed); }

  // ── authority (Main GM only) ───────────────────────────────────────────────
  let timer = null;
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

  function userInfo(userId) {
    const u = game.users?.get(userId);
    return { user: u, isGM: !!u?.isGM, actor: u?.character ?? null };
  }

  async function handle(ev, userId) {
    if (!isPrimaryGM() || !ev?.type) return;
    const { user, isGM, actor } = userInfo(userId);
    if (!user) return;

    if (ev.type === "open") {
      const verdict = L.canOpen({ isGM, hasCharacter: !!actor, fp: fpOf(actor), active: current, sceneMode: sceneMode() });
      if (!verdict.ok) { emit(MSG.STATE, { req: current, refused: { userId, reason: verdict.reason } }); AS._onRefused?.({ userId, reason: verdict.reason }); return; }
      const req = L.create({
        id: foundry.utils.randomID(), userId, actorId: actor.id, actorName: actor.name,
        img: AS.spriteOf?.(actor) ?? actor.img ?? "", sceneId: canvas?.scene?.id ?? null,
        sceneMode: sceneMode(), fp: fpOf(actor), now: Date.now()
      });
      broadcast(req);
      return;
    }

    if (!current || (ev.id && ev.id !== current.id)) return;
    if (!L.mayAct(current, ev, { userId, isGM })) { console.warn(TAG, "refused", ev.type, "from", user.name); return; }

    if (ev.type === "approve") {
      const actor = game.actors?.get(current.actorId);
      if (fpOf(actor) < L.COST) { AS._notifyGM?.(`${current.actorName} has no Fabula Points left.`); return; }
    }

    const { req, effect } = L.reduce(current, ev, Date.now());
    if (effect === "ignored") return;
    if (effect === "closed") {
      clearTimeout(timer);
      const why = ev.type === "cancel" ? (isGM ? "gm-cancel" : "withdrawn") : ev.type;
      broadcast(null, { why, by: user.name, actorName: current.actorName, phase: current.phase });
      return;
    }
    broadcast(req);
    if (effect === "spend") { clearTimeout(timer); timer = setTimeout(() => serial(() => settle(req)), FATE_MS); }
    if (req.phase === L.PHASE.DENIED) { clearTimeout(timer); timer = setTimeout(() => finish(req, "denied"), DENIED_MS); }
  }

  function finish(req, why) {
    if (!current || current.id !== req.id) return;
    broadcast(null, { why, actorName: req.actorName, phase: req.phase });
  }

  async function settle(req) {
    if (!current || current.id !== req.id) return;
    try {
      const actor = game.actors?.get(req.actorId);
      const fabula = globalThis.FUCompanion?.api?.fabula ?? globalThis.FabulaLedger?.api;
      if (fabula?.change) await fabula.change([actor], -L.COST, { reason: "alter-story", label: "Alter the Story" });
      else if (actor) await actor.update({ [`system.props.${FP_PROP}`]: Math.max(0, fpOf(actor) - L.COST) });
    } catch (e) { console.error(TAG, "spend failed", e); }
    try { await record(req); } catch (e) { console.error(TAG, "journal failed", e); }
    try { globalThis.oni?.PartyTalk?.narrate?.(L.recapLine(req), "action"); } catch (e) { console.warn(TAG, "party talk failed", e); }
    finish(req, "fate");
  }

  // ── the record: one journal, a page per session ────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function journal() {
    let entry = game.journal?.find(j => j.getFlag?.(MODULE_ID, JOURNAL_FLAG));
    if (!entry) {
      entry = await JournalEntry.create({
        name: "Altered Fates",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
        flags: { [MODULE_ID]: { [JOURNAL_FLAG]: true } }
      });
    }
    return entry;
  }

  function sessionKey() {
    const s = (() => { try { return globalThis.FabulaLedger?._internal?.readState?.()?.session ?? null; } catch { return null; } })();
    const at = Number(s?.openedAt) || Date.now();
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, "0");
    return { id: s?.id ?? `day-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, name: `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  }

  async function record(req) {
    const entry = await journal();
    if (!entry) return;
    const key = sessionKey();
    let page = entry.pages?.find(p => p.getFlag?.(MODULE_ID, "sessionId") === key.id);
    const scene = game.scenes?.get(req.sceneId);
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const html = `<section class="as-fate"><p><strong>${esc(req.actorName)}</strong> · ${esc(scene?.navName || scene?.name || "")} · ${esc(time)}`
      + `${req.kind === "change" ? " · changed something already there" : ""}</p>`
      + `<blockquote>${req.text ? esc(req.text) : "<em>Told at the table.</em>"}</blockquote>`
      + `${req.note ? `<p><em>GM:</em> ${esc(req.note)}</p>` : ""}`
      + `${req.involves?.length ? `<p><em>Involves:</em> ${req.involves.map(h => esc(h.name)).join(", ")}</p>` : ""}</section>`;
    if (!page) {
      await entry.createEmbeddedDocuments("JournalEntryPage", [{
        name: key.name, type: "text", text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
        flags: { [MODULE_ID]: { sessionId: key.id } }
      }]);
    } else {
      await page.update({ "text.content": `${page.text?.content ?? ""}${html}` });
    }
  }

  // ── client API ─────────────────────────────────────────────────────────────
  function send(ev) {
    if (isPrimaryGM()) return serial(() => handle(ev, game.user.id));
    emit(MSG.EVENT, { ev, userId: game.user?.id });
  }

  const api = {
    get current() { return current; },
    onChange,
    canOpenHere() {
      const actor = game.user?.character;
      return L.canOpen({ isGM: !!game.user?.isGM, hasCharacter: !!actor, fp: fpOf(actor), active: current, sceneMode: sceneMode() });
    },
    open: () => send({ type: "open" }),
    submit: (data) => send({ type: "submit", id: current?.id, ...data }),
    consent: (actorId, yes) => send({ type: "consent", id: current?.id, actorId, yes: !!yes }),
    approve: (note = "", summary = "") => send({ type: "approve", id: current?.id, note, summary }),
    deny: (reason = "") => send({ type: "deny", id: current?.id, reason }),
    revise: (reason = "") => send({ type: "revise", id: current?.id, reason }),
    cancel: () => send({ type: "cancel", id: current?.id }),
    fpOf, sceneMode, isPrimaryGM,
    FATE_MS, DENIED_MS
  };
  AS.api = api;
  AS._internal = { handle, record, sessionKey, setState };

  // ── wiring ─────────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.alterStory = api;

    game.socket?.on(SOCKET_NS, (msg) => {
      if (!msg?.type) return;
      if (msg.type === MSG.EVENT && isPrimaryGM()) serial(() => handle(msg.ev, msg.userId));
      else if (msg.type === MSG.SYNC && isPrimaryGM()) emit(MSG.STATE, { req: current });
      else if (msg.type === MSG.STATE) {
        if (msg.refused) { if (msg.refused.userId === game.user?.id) AS._onRefused?.(msg.refused); return; }
        setState(msg.req ?? null, msg.closed ?? null);
      }
    });

    // A Main GM that (re)loads holds nothing: clear every screen. Anyone else asks.
    if (isPrimaryGM()) emit(MSG.STATE, { req: null });
    else emit(MSG.SYNC, {});

    // The writer leaving closes their request (nothing was spent).
    Hooks.on("userConnected", (user, connected) => {
      if (connected || !isPrimaryGM() || !current) return;
      if (user.id === current.userId && L.OPEN_PHASES.has(current.phase)) {
        broadcast(null, { why: "left", by: user.name, actorName: current.actorName, phase: current.phase });
      }
    });
    console.debug(TAG, "ready");
  });
})();
