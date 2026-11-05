/**
 * Fabula Ledger — the record, the awards and the API
 *
 * File: scripts/fabula-ledger/fl-ledger.js
 *
 * Only the PRIMARY GM decides and writes (GM Host / dedupe pattern). Any other
 * client that sees a villain sends a report over the module socket; the primary
 * GM runs it through the rules in fl-logic.js and then:
 *   pay    -> +1 to every party member (cap respected), the tab on each player
 *   ask    -> the GM prompt (fl-gm-prompt.js); the answer is applied here
 *   ignore -> nothing (a debug line)
 *
 * What is stored (world setting `fabulaLedgerState`, so F5 never double-pays):
 *   visit       { id, sceneId, paid: [actorId] }   the party's current scene stay
 *   prevVisit   the one before (for the "followed" loop)
 *   paidTokens  { "<sceneId>.<tokenId>": spot }    this session (for "stationary")
 *   muted       same shape; a skipped loop stays quiet until the token moves
 *   undo        the last awards, newest first, each with every actor's before/after
 *   log         the last decisions, for the GM ledger panel (step 3)
 *
 * Villain status is a flag on the WORLD actor: flags.<module>.fabulaVillain
 *   "auto" (default) | "villain" | "hidden" | "never"
 *
 * API: FUCompanion.api.fabula (also globalThis.FabulaLedger.api)
 *   change(actors, delta, opts)    plain award or spend; actors = Actor[] | "party"
 *   villainEntrance(actors)        "these villains just appeared" (event command)
 *   report(appearance)             a detected appearance (token / theatre)
 *   cameo(actor) / reveal(actor) / escalate(actor)
 *   getStatus(actor) / setStatus(actor, status)
 *   undo(id?)                      reverse an award (the newest when no id)
 *   newVisit(sceneId) / resetSession()
 *   state()                        a copy of the stored record
 */
(() => {
  const TAG = "[FabulaLedger]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const FLAG = "fabulaVillain";
  const FP_PROP = "fabula_point";
  const SETTING_STATE = "fabulaLedgerState";
  const SETTING_AUTOPAY = "fabulaAutoPay";
  const MAX_UNDO = 30;
  const MAX_LOG = 60;

  const MSG = Object.freeze({
    REPORT: "FL_REPORT",   // any client -> primary GM: { appearance }
    CALL: "FL_CALL",       // a non-primary GM -> primary GM: { op, args }
    AWARD: "FL_AWARD"      // primary GM -> everyone: { changes, reason }
  });

  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const L = FL.Logic;
  if (!L) { console.error(TAG, "fl-logic.js must load first."); return; }

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? game.user?.isGM ?? false;
  const debug = (...a) => console.debug(TAG, ...a);

  // ── settings ───────────────────────────────────────────────────────────────
  const blankState = () => ({
    visit: { id: null, sceneId: null, paid: [], boss: false },
    prevVisit: { id: null, sceneId: null, paid: [], boss: false },
    paidTokens: {}, muted: {}, undo: [], log: []
  });

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_STATE, {
      scope: "world", config: false, type: Object, default: blankState()
    });
    game.settings.register(MODULE_ID, SETTING_AUTOPAY, {
      name: "Fabula Points: pay unset Champions without asking",
      hint: "Off (recommended): the first time an unset Champion appears, the GM is asked Confirm / Skip / Hidden / Never. On: they pay straight away. Suspected loops always ask.",
      scope: "world", config: true, type: Boolean, default: false
    });
  });

  const autoPay = () => { try { return game.settings.get(MODULE_ID, SETTING_AUTOPAY) === true; } catch { return false; } };

  function readState() {
    let s;
    try { s = game.settings.get(MODULE_ID, SETTING_STATE); } catch { s = null; }
    const b = blankState();
    s = foundry.utils.deepClone(s ?? {});
    return {
      visit: { ...b.visit, ...(s.visit ?? {}), paid: [...(s.visit?.paid ?? [])] },
      prevVisit: { ...b.prevVisit, ...(s.prevVisit ?? {}), paid: [...(s.prevVisit?.paid ?? [])] },
      paidTokens: s.paidTokens ?? {}, muted: s.muted ?? {},
      undo: Array.isArray(s.undo) ? s.undo : [], log: Array.isArray(s.log) ? s.log : []
    };
  }

  // Writes are serialised so two quick appearances never overwrite each other.
  let _chain = Promise.resolve();
  function mutate(fn) {
    const run = _chain.then(async () => {
      const s = readState();
      const out = await fn(s);
      await game.settings.set(MODULE_ID, SETTING_STATE, s);
      return out;
    });
    _chain = run.catch((e) => console.error(TAG, "state write failed", e));
    return run;
  }

  // ── actors ─────────────────────────────────────────────────────────────────
  function worldActor(a) {
    if (!a) return null;
    if (typeof a === "string") return game.actors?.get(a) ?? null;
    const doc = a.actor ?? a;                       // TokenDocument -> its actor
    return game.actors?.get(doc.id) ?? doc;         // synthetic token actor -> base
  }

  const rankOf = (actor) => String(actor?.system?.props?.npc_rank ?? "").trim().toLowerCase();
  const getStatus = (actor) => L.normStatus(worldActor(actor)?.getFlag?.(MODULE_ID, FLAG));

  async function setStatus(actor, status) {
    const a = worldActor(actor);
    if (!a) return false;
    if (!game.user?.isGM) return callPrimary("setStatus", [a.id, status]);
    const s = L.normStatus(status);
    if (s === L.STATUS.AUTO) await a.unsetFlag(MODULE_ID, FLAG);
    else await a.setFlag(MODULE_ID, FLAG, s);
    debug("status", a.name, "->", s);
    return true;
  }

  async function partyActors() {
    try { return (await globalThis.CampSystem?.RestAPI?.getPartyActors?.()) ?? []; }
    catch (e) { console.warn(TAG, "party lookup failed", e); return []; }
  }

  // A wildcard token path ("…/Geist/*") is not a file; skip to the next choice.
  function spriteOf(actor, tokenDoc) {
    const usable = (src) => (src && !String(src).includes("*")) ? src : "";
    return usable(tokenDoc?.texture?.src) || usable(actor?.prototypeToken?.texture?.src) || usable(actor?.img) || "";
  }

  // ── socket ─────────────────────────────────────────────────────────────────
  function emit(type, data) { try { game.socket?.emit(SOCKET_NS, { type, ...data }); } catch (e) { console.warn(TAG, "emit failed", e); } }

  // A GM who is not the primary GM sends the work over; it is not awaited.
  function callPrimary(op, args) {
    emit(MSG.CALL, { op, args, from: game.user?.id });
    return { ok: true, forwarded: true };
  }

  Hooks.once("ready", () => {
    game.socket?.on(SOCKET_NS, (msg) => {
      if (!msg?.type) return;
      if (msg.type === MSG.REPORT && isPrimaryGM()) report(msg.appearance);
      else if (msg.type === MSG.CALL && isPrimaryGM()) runCall(msg.op, msg.args);
      else if (msg.type === MSG.AWARD) FL.Tab?.onAward?.(msg);
    });
    // Best effort; report() re-checks, since primary-GM status can lag at ready.
    setTimeout(() => { if (isPrimaryGM()) newVisit(game.scenes?.active?.id ?? null, { onlyIfChanged: true }); }, 1500);
  });

  async function runCall(op, args = []) {
    const a = (id) => game.actors?.get(id) ?? null;
    switch (op) {
      case "setStatus": return setStatus(a(args[0]), args[1]);
      case "change": return change(args[0] === "party" ? "party" : (args[0] ?? []).map(a).filter(Boolean), args[1], args[2]);
      case "villainEntrance": return villainEntrance((args[0] ?? []).map(a).filter(Boolean), args[1]);
      case "cameo": return cameo(a(args[0]));
      case "reveal": return reveal(a(args[0]));
      case "escalate": return escalate(a(args[0]));
      case "bossFight": return bossFight(args[0]);
      default: console.warn(TAG, "unknown call", op);
    }
  }

  // ── visits ─────────────────────────────────────────────────────────────────
  // A visit is the party's stay on the active scene. A new one starts when the
  // active scene changes.
  async function newVisit(sceneId, { onlyIfChanged = false } = {}) {
    if (!isPrimaryGM()) return;
    await mutate((s) => {
      if (onlyIfChanged && s.visit.sceneId === sceneId) return;
      s.prevVisit = s.visit.id ? s.visit : s.prevVisit;
      s.visit = { id: foundry.utils.randomID(), sceneId, paid: [], boss: false };
      debug("new visit", sceneId);
    });
  }

  Hooks.on("updateScene", (scene, changes) => {
    if (changes?.active === true && isPrimaryGM()) newVisit(scene.id);
  });

  async function resetSession() {
    if (!isPrimaryGM()) return;
    await mutate((s) => {
      const keep = s.visit;
      Object.assign(s, blankState());
      s.visit = { id: foundry.utils.randomID(), sceneId: keep.sceneId ?? game.scenes?.active?.id ?? null, paid: [], boss: false };
    });
  }

  // ── awards ─────────────────────────────────────────────────────────────────
  /**
   * actors: Actor[] or "party". delta: +n / -n.
   * opts: { reason, label, villainIds, silent }
   */
  // Awards run one at a time: two at once (a villain sighting and the boss
  // point at battle start) would both read the same total and one +1 would be
  // lost. Found in the sandbox 2026-11-05.
  let _awardChain = Promise.resolve();
  function change(actors, delta, opts = {}) {
    const run = _awardChain.then(() => changeNow(actors, delta, opts));
    _awardChain = run.catch(() => {});
    return run;
  }

  async function changeNow(actors, delta, opts = {}) {
    const d = Math.round(Number(delta) || 0);
    if (!d) return { ok: true, changes: [] };
    if (!game.user?.isGM) { console.warn(TAG, "Fabula Point changes are GM-only."); return { ok: false }; }
    if (!isPrimaryGM()) {
      const ids = actors === "party" ? "party" : (actors ?? []).map(x => worldActor(x)?.id).filter(Boolean);
      return callPrimary("change", [ids, d, opts]);
    }

    const list = actors === "party" ? await partyActors() : (actors ?? []).map(worldActor).filter(Boolean);
    const seen = new Set();
    const targets = list.filter(a => a && !seen.has(a.id) && seen.add(a.id));
    if (!targets.length) { console.warn(TAG, "change: nobody to change"); return { ok: false, reason: "no-actors" }; }

    const changes = [];
    await Promise.all(targets.map(async (actor) => {
      const from = Number(actor.system?.props?.[FP_PROP] ?? 0) || 0;
      const { next, overflow } = L.applyCap(from, d);
      changes.push({ actorId: actor.id, name: actor.name, from, to: next, overflow });
      if (next !== from) await actor.update({ [`system.props.${FP_PROP}`]: next });
    }));

    const entry = {
      id: foundry.utils.randomID(), at: Date.now(), delta: d,
      reason: opts.reason ?? "change", label: opts.label ?? "", villainIds: opts.villainIds ?? [], bossId: opts.bossId ?? null,
      changes: changes.map(c => ({ actorId: c.actorId, before: c.from, after: c.to }))
    };
    await mutate((s) => { s.undo.unshift(entry); s.undo.length = Math.min(s.undo.length, MAX_UNDO); });

    if (!opts.silent) {
      const msg = { type: MSG.AWARD, changes, reason: entry.reason, awardId: entry.id };
      emit(MSG.AWARD, msg);
      FL.Tab?.onAward?.(msg);
      FL.Prompt?.paidNote?.(entry);
    }
    debug("change", d, entry.reason, changes);
    return { ok: true, changes, awardId: entry.id };
  }

  function undo(id = null) {
    const run = _awardChain.then(() => undoNow(id));
    _awardChain = run.catch(() => {});
    return run;
  }

  async function undoNow(id = null) {
    if (!isPrimaryGM()) return { ok: false, reason: "not-primary-gm" };
    const entry = await mutate((s) => {
      const i = id ? s.undo.findIndex(u => u.id === id) : 0;
      if (i < 0 || !s.undo[i]) return null;
      const [e] = s.undo.splice(i, 1);
      // A paid villain becomes unpaid again for this visit; same for the boss point.
      for (const vid of e.villainIds ?? []) s.visit.paid = s.visit.paid.filter(x => x !== vid);
      if (e.reason === "boss") s.visit.boss = false;
      return e;
    });
    if (!entry) return { ok: false, reason: "nothing-to-undo" };
    for (const c of entry.changes) {
      const actor = game.actors?.get(c.actorId);
      const now = Number(actor?.system?.props?.[FP_PROP] ?? 0) || 0;
      // Only reverse what this award did; points spent since then stay spent.
      const back = Math.max(0, now - (c.after - c.before));
      if (actor && back !== now) await actor.update({ [`system.props.${FP_PROP}`]: back });
    }
    debug("undo", entry);
    return { ok: true, entry };
  }

  // ── appearances ────────────────────────────────────────────────────────────
  const _pending = new Set();   // actorId+visit with a prompt open

  /**
   * appearance: { actorId, source, tokenId?, sceneId?, x?, y?, img? }
   * source: token | theatre | event | cameo | reveal | escalate
   */
  async function report(appearance) {
    const app = { ...(appearance ?? {}) };
    if (!isPrimaryGM()) { emit(MSG.REPORT, { appearance: app }); return { ok: true, forwarded: true }; }

    const actor = game.actors?.get(app.actorId);
    if (!actor) return { ok: false, reason: "no-actor" };
    app.status = getStatus(actor);
    app.rank = rankOf(actor);
    app.name = actor.name;
    app.img = app.img || spriteOf(actor, null);

    // The visit must match the active scene. At startup the ready-hook call can
    // run before this client counts as the primary GM, so check every time.
    const activeId = game.scenes?.active?.id ?? null;
    if (readState().visit.sceneId !== activeId) await newVisit(activeId, { onlyIfChanged: true });

    const state = readState();
    const decision = L.decideAppearance(app, state, { autoPay: autoPay() });
    // Players' cameras may report ordinary monsters; keep those out of the log.
    if (!["not-a-villain", "status-never"].includes(decision.reason)) logDecision(app, decision);

    if (decision.action === "pay") return payVillain(app, decision);
    if (decision.action === "ask") return ask(app, decision, state.visit.id);
    debug("ignore", actor.name, decision.reason);
    return { ok: true, decision };
  }

  async function payVillain(app, decision) {
    const paidOk = await mutate((s) => {
      // Re-check inside the write: two reports can race to here.
      if (app.source !== "escalate" && s.visit.paid.includes(app.actorId)) return false;
      if (app.source !== "escalate") s.visit.paid.push(app.actorId);
      const key = L.tokenKey(app);
      if (key) { s.paidTokens[key] = L.tokenSpot(app); delete s.muted[key]; }
      return true;
    });
    if (!paidOk) return { ok: true, decision: { action: "ignore", reason: "paid-this-visit" } };
    const res = await change("party", 1, {
      reason: app.source === "escalate" ? "escalation" : "villain",
      label: app.name, villainIds: app.source === "escalate" ? [] : [app.actorId]
    });
    return { ...res, decision };
  }

  async function ask(app, decision, visitId) {
    const key = `${app.actorId}:${visitId}:${decision.prompt}`;
    if (_pending.has(key)) return { ok: true, decision, pending: true };
    if (!FL.Prompt?.show) { console.warn(TAG, "prompt not loaded; not paying", app.name); return { ok: false }; }
    _pending.add(key);
    try {
      const answer = await FL.Prompt.show({
        kind: decision.prompt,
        name: app.name,
        img: app.img,
        reason: L.promptReason(app, decision),
        buttons: L.promptButtons(decision.prompt)
      });
      return await applyAnswer(app, decision, answer);
    } finally {
      _pending.delete(key);
    }
  }

  async function applyAnswer(app, decision, answer) {
    debug("answer", app.name, decision.prompt, answer);
    if (decision.prompt === "first") {
      if (answer === "confirm") { await setStatus(app.actorId, L.STATUS.VILLAIN); return payVillain(app, decision); }
      if (answer === "hidden") await setStatus(app.actorId, L.STATUS.HIDDEN);
      if (answer === "never") await setStatus(app.actorId, L.STATUS.NEVER);
      return { ok: true, answer };
    }
    // loop
    if (answer === "confirm") return payVillain(app, decision);
    const key = L.tokenKey(app);
    if (key) await mutate((s) => { s.muted[key] = L.tokenSpot(app); });
    return { ok: true, answer };
  }

  function logDecision(app, decision) {
    mutate((s) => {
      s.log.unshift({ at: Date.now(), actorId: app.actorId, name: app.name, source: app.source, action: decision.action, reason: decision.reason });
      s.log.length = Math.min(s.log.length, MAX_LOG);
    });
  }

  // ── explicit sources ───────────────────────────────────────────────────────
  async function villainEntrance(actors) {
    if (!game.user?.isGM) return { ok: false };
    const list = (actors ?? []).map(worldActor).filter(Boolean);
    if (!isPrimaryGM()) return callPrimary("villainEntrance", [list.map(a => a.id)]);
    const results = [];
    // One at a time so each sees the one before (visit cap, no double pay).
    for (const a of list) {
      // The event declares them villains: an unset actor becomes one, so its
      // later appearances pay too (Asura is an elite, not a Champion).
      // Hidden and Never are the GM's deliberate calls and stay.
      if (getStatus(a) === L.STATUS.AUTO) await setStatus(a, L.STATUS.VILLAIN);
      results.push(await report({ actorId: a.id, source: "event", img: spriteOf(a) }));
    }
    return { ok: true, results };
  }

  const explicit = (source) => async (actor) => {
    const a = worldActor(actor);
    if (!a || !game.user?.isGM) return { ok: false };
    if (!isPrimaryGM()) return callPrimary(source, [a.id]);
    if (source === "reveal") await setStatus(a, L.STATUS.VILLAIN);
    return report({ actorId: a.id, source, img: spriteOf(a) });
  };
  const cameo = explicit("cameo");
  const reveal = explicit("reveal");
  const escalate = explicit("escalate");

  // ── boss fight ─────────────────────────────────────────────────────────────
  /**
   * A battle started on the active scene. info: { enemyActorIds: [id] }
   * +1 to the party once per visit when any enemy is a Champion whose status
   * is not hidden / never. Called by the battle detector on whichever GM hosts
   * the Battle Director; forwarded to the primary GM.
   */
  async function bossFight(info = {}) {
    if (!game.user?.isGM) return { ok: false };
    if (!isPrimaryGM()) return callPrimary("bossFight", [info]);
    const activeId = game.scenes?.active?.id ?? null;
    if (readState().visit.sceneId !== activeId) await newVisit(activeId, { onlyIfChanged: true });

    const enemies = (info.enemyActorIds ?? []).map(id => game.actors?.get(id)).filter(Boolean)
      .map(a => ({ actorId: a.id, name: a.name, rank: rankOf(a), status: getStatus(a) }));
    const decision = L.decideBossPoint(enemies, readState());
    debug("boss fight", decision.reason, enemies.map(e => e.name));
    if (decision.action !== "pay") return { ok: true, decision };
    const claimed = await mutate((s) => { if (s.visit.boss) return false; s.visit.boss = true; return true; });
    if (!claimed) return { ok: true, decision: { action: "ignore", reason: "boss-paid-this-visit" } };
    const res = await change("party", 1, { reason: "boss", label: decision.boss.name, bossId: decision.boss.actorId });
    return { ...res, decision };
  }

  /** Cheap pre-filter for detectors: could this actor ever pay as a villain? */
  function isCandidate(actor) {
    const a = worldActor(actor);
    return !!a && L.isCandidate(rankOf(a), getStatus(a));
  }

  // ── API ────────────────────────────────────────────────────────────────────
  const api = {
    change, villainEntrance, report, cameo, reveal, escalate, bossFight, isCandidate,
    getStatus, setStatus, undo, newVisit, resetSession,
    state: () => foundry.utils.deepClone(readState()),
    STATUS: L.STATUS, MSG
  };
  FL.api = api;
  FL._internal = { worldActor, spriteOf, partyActors, isPrimaryGM };
  Hooks.once("init", () => {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.fabula = api;
  });
})();
