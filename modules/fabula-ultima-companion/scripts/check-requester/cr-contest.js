// ============================================================================
// Contest Check — engine (GM) + public API
//
// File: scripts/check-requester/cr-contest.js
// Rules: cr-contest-logic.js   HUD: cr-contest-hud.js
//
// Public API: globalThis.ONI.Contest
//   .request(options) -> Promise<ContestResult>      (GM only)
//
// options:
//   sides        [{ actor | actorUuid | team:[actor|uuid,...], attrA?, attrB?,
//                   modifiers?:[{label,value}], autoRoll?:bool }]   (2 to 4 sides)
//   attrA, attrB shared Attributes (RAW: every side rolls the same Check)   "DEX","MIG"
//   label        title on the HUD + chat                                    "Contest"
//   stakes       one line on the HUD + chat ("Loser pays for the round")    ""
//   mode         "interactive" (HUD) | "silent" (no HUD, no invokes)        "interactive"
//   allowInvokes Trait / Bond / Lucky Seven / Divination                    true
//   autoRoll     "none" | "npc" (GM-side sides roll themselves) | "all"     "none"
//   answerSeconds  seconds an answer window stays open (timeout = accept)   25
//   clock        { id } — Conflict mode: the winner pushes this Clock        null
//   checkBuffActions  equipped check_buff tags (Study, Strength...)          []
//   postChat     post the contest card                                      true
//   holdMs       how long the result stays up before the HUD closes         3500
//   context      echoed back                                                {}
//
// ContestResult:
//   { winner:{index,actorUuid,actorName,total,isCrit}, loser (2 sides) | null,
//     sides:[{index,actorUuid,actorName,attrA,attrB,dieA,dieB,rollA,rollB,total,
//             isCrit,isFumble,modifierParts,usedTrait,usedBond,usedLuckySeven,
//             usedDivination,out,place}],
//     placings, margin (null when a crit / fumble decided it), marginTier,
//     clockSections, clock:{id,from,to,resolved}|null, rounds, label, context }
// ============================================================================
(() => {
  const ONI = globalThis.ONI ??= {};
  const TAG = "[ONI][Contest]";
  const GUARD = "__ONI_CONTEST__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const MSG_EV = "CT_EV", MSG_INTENT = "CT_INTENT";
  const I = () => ONI.CheckRequester?._internal;
  const L = () => ONI.ContestLogic;
  const HUD = () => ONI.ContestHUD;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  const DEFAULTS = {
    attrA: "DEX", attrB: "MIG", label: "Contest", stakes: "", mode: "interactive", allowInvokes: true,
    autoRoll: "none", answerSeconds: 25, clock: null, checkBuffActions: [], postChat: true, holdMs: 3500, context: {},
  };

  let C = null;   // the GM's running contest

  // ── Actors ───────────────────────────────────────────────────────────────
  async function toActor(x) {
    if (!x) return null;
    if (typeof x === "string") return I().resolveActorInput(x);
    if (x.documentName === "Actor") return x;
    if (x.actor) return x.actor;
    return null;
  }
  async function partyMemberUuids() {
    try {
      const props = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.())?.db?.system?.props ?? null;
      if (!props) return null;
      const out = new Set();
      for (let i = 1; i <= 4; i++) { const id = String(props[`member_id_${i}`] ?? "").trim(); if (id) out.add(id.startsWith("Actor.") ? id : `Actor.${id}`); }
      return out;
    } catch (_) { return null; }
  }
  const isParty = (actor, party) => !!actor && (actor.hasPlayerOwner || (party?.has?.(actor.uuid) ?? false));
  const ownerIdsOf = (actor) => (game.users?.filter((u) => !u.isGM && actor?.testUserPermission?.(u, "OWNER")) ?? []).map((u) => u.id);
  const mayAct = (userId, actor) => { const u = game.users?.get(userId); return !!u && (u.isGM || !!actor?.testUserPermission?.(u, "OWNER")); };

  const divChargesOf = (actor) => { const ae = I().findDivinationAe(actor); return ae ? Number(ae.flags?.[MODULE_ID]?.charges ?? 0) : 0; };

  // ── Build one side (GM) ─────────────────────────────────────────────────
  async function buildSide(spec, opts, party) {
    const S = I();
    const members = (Array.isArray(spec.team) && spec.team.length ? await Promise.all(spec.team.map(toActor)) : [await toActor(spec.actor ?? spec.actorUuid)]).filter(Boolean);
    if (!members.length) throw new Error(`${TAG} a side has no actor`);
    const { attrA, attrB } = L().sideAttrs(opts, spec);
    let actor = members[0];
    if (members.length > 1) {
      const pick = L().pickTeamRoller(members.map((a) => ({ id: a.uuid, dA: S.getDieSize(a, attrA), dB: S.getDieSize(a, attrB), mod: 0 })));
      actor = members.find((a) => a.uuid === pick) ?? actor;
    }
    const dA = S.getDieSize(actor, attrA), dB = S.getDieSize(actor, attrB);
    // An Opposed Check: opposed-scoped bonuses apply (Guard +2, Ring of the Lion...).
    const auto = globalThis.ONI?.CheckModifiers?.resolve?.(actor, "opposed", { attributes: [attrA, attrB] }) ?? [];
    const buffs = await S.resolveEquippedCheckBuffMods(actor, opts.checkBuffActions);
    const mods = [...auto, ...buffs, ...(spec.modifiers ?? [])]
      .map((m) => ({ label: String(m?.label ?? "Modifier"), value: Number(m?.value) || 0 })).filter((m) => m.value !== 0);
    const npc = S.isNpcActor(actor);
    const res = S.getTraitResource(actor);
    const pts = S.getTraitPoints(actor);
    const bonds = npc ? [] : S.collectBonds(actor).map((b) => ({ idx: b.idx, name: b.name, bonus: b.bonus }));
    const luck = S.findLuckyState(actor);
    const p = actor.system?.props ?? {};
    const isPartySide = isParty(actor, party);
    const flip = actor.getFlag?.(MODULE_ID, "cutinFlip");
    return {
      snap: {
        actorUuid: actor.uuid, name: actor.name, img: S.getTokenImg(actor),
        ownerIds: ownerIdsOf(actor), party: isPartySide,
        ownerLabel: isPartySide ? "PLAYER" : (npc && pts > 0 ? "GM · VILLAIN" : "GM · NPC"),
        attrA, attrB, dA, dB, bonds,
        cut: String(p.cut_in_critical ?? "").trim() || null,
        cutFlip: typeof flip === "boolean" ? flip : true,          // right-entry mirrors by default (director-cutin.js)
        cutSoft: actor.getFlag?.(MODULE_ID, "cutinSoftEdge") === true,
        teamNames: members.length > 1 ? members.map((a) => a.name) : [],
        autoRoll: spec.autoRoll === true || opts.autoRoll === "all" || (opts.autoRoll === "npc" && !isPartySide),
      },
      state: {
        a: null, b: null, mods, accepted: false, out: false,
        res: { kind: pts > 0 || !npc ? (npc ? "up" : "fp") : "none", n: pts, key: res.key },
        usedTrait: false, usedBond: false, usedLucky: false, usedDiv: false,
        lucky: luck?.luckyNumber ?? null,
      },
      actor,
    };
  }

  // ── Event stream ─────────────────────────────────────────────────────────
  function publicState() {
    const s = C.state;
    return {
      sides: s.sides.map((x) => ({ a: x.a, b: x.b, mods: x.mods, accepted: x.accepted, out: x.out, res: { kind: x.res.kind, n: x.res.n },
        usedTrait: x.usedTrait, usedBond: x.usedBond, usedLucky: x.usedLucky, usedDiv: x.usedDiv, lucky: x.lucky })),
      phase: s.phase, answering: s.answering, windowSeq: s.windowSeq, windowSeconds: C.opts.answerSeconds,
      options: s.options, bench: s.bench, benchOpen: s.phase === "answer", notes: s.notes, round: s.round, rolling: s.rolling,
    };
  }
  function emit(ev, { withState = false } = {}) {
    if (!C) return Promise.resolve();
    if (withState) ev.state = publicState();
    try { game.socket.emit(SOCKET_CH, { type: MSG_EV, payload: { sid: C.sid, ev } }); } catch (e) { console.warn(TAG, "emit", e); }
    return HUD()?.event(C.sid, ev) ?? Promise.resolve();
  }
  const idle = () => HUD()?.whenIdle?.() ?? Promise.resolve();

  // ── Options for the answering side ──────────────────────────────────────
  function optionsFor(i) {
    const st = C.state.sides[i], snap = C.snap.sides[i], actor = C.actors[i];
    const L_ = L(), out = [];
    if (!C.opts.allowInvokes || st.out) return out;
    const fum = L_.isFumble(st), crit = L_.isCrit(st);
    const unit = st.res.kind === "up" ? "UP" : "FP";
    if (st.res.kind !== "none") out.push({ id: "trait", label: "🎭 Invoke Trait", sub: st.usedTrait ? "used" : `1 ${unit}`, ok: st.res.n > 0 && !st.usedTrait && !fum, used: st.usedTrait });
    if (snap.bonds.length) {
      const best = Math.max(...snap.bonds.map((b) => b.bonus));
      out.push({ id: "bond", label: "🤝 Invoke Bond", sub: st.usedBond ? "used" : `+${best}`, ok: st.res.kind === "fp" && st.res.n > 0 && !st.usedBond && !fum, used: st.usedBond });
    }
    if (st.lucky != null) out.push({ id: "lucky", label: `🍀 Lucky Seven (${st.lucky})`, sub: st.usedLucky ? "used" : "1/scene", ok: !st.usedLucky && !fum && !crit && !!I().findLuckyState(actor), used: st.usedLucky });
    if (divChargesOf(actor) > 0 || st.usedDiv) out.push({ id: "divination", label: "🔮 Divination", sub: st.usedDiv ? "used" : `${divChargesOf(actor)}`, ok: !st.usedDiv && !fum && !crit && divChargesOf(actor) > 0, used: st.usedDiv });
    return out;
  }
  // Watching actors with Divination charges (RAW: "a creature you can see").
  function benchList() {
    if (!C.opts.allowInvokes) return [];
    const inContest = new Set(C.snap.sides.map((s) => s.actorUuid));
    const targets = C.state.sides.map((s, i) => i).filter((i) => !C.state.sides[i].out && L().hasRolled(C.state.sides[i]) && !L().isCrit(C.state.sides[i]) && !L().isFumble(C.state.sides[i]));
    if (!targets.length) return [];
    const out = [];
    const present = new Set([...(C.party ?? [])]);
    for (const t of canvas?.scene?.tokens ?? []) if (t.actor) present.add(t.actor.uuid);
    for (const a of game.actors ?? []) {
      if (inContest.has(a.uuid) || !present.has(a.uuid)) continue;
      const n = divChargesOf(a); if (n <= 0) continue;
      out.push({ actorUuid: a.uuid, name: a.name, img: I().getTokenImg(a), charges: n, ownerIds: ownerIdsOf(a), targets });
    }
    return out;
  }
  // Side i may answer if it can invoke, or a watcher could still change things for it.
  const hasOptions = (i) => optionsFor(i).some((o) => o.ok) || (C.state.bench?.length ?? 0) > 0;

  // ── Phases ───────────────────────────────────────────────────────────────
  async function startRolling() {
    const s = C.state;
    s.phase = "rolling"; s.answering = null; s.rolling = {};
    await emit({ t: "state" }, { withState: true });
    // Auto-rolling sides (an NPC acting inside the director's turn, or "all").
    C.snap.sides.forEach((snap, i) => {
      if (!snap.autoRoll || s.sides[i].out) return;
      for (const die of ["a", "b"]) enqueue(() => doRoll(i, die));
    });
  }

  async function doRoll(i, die) {
    const s = C.state, st = s.sides[i], snap = C.snap.sides[i];
    if (s.phase !== "rolling" || st.out || st[die] != null) return;
    const faces = die === "a" ? snap.dA : snap.dB;
    const value = await I().rollDie(faces);
    const other = die === "a" ? st.b : st.a;
    st[die] = value;
    const both = st.a != null && st.b != null;
    const crit = both && L().isCrit(st), fumble = both && L().isFumble(st);
    const allIn = L().allRolled(s.sides);
    if (both) { if (crit) C.crits.push(i); if (fumble) C.fumbles.push({ i, a: st.a, b: st.b }); }
    await emit({ t: "roll", side: i, die, value, crit: crit && other != null, fumble, total: both ? L().total(st) : null, allIn }, { withState: true });
    if (allIn) { await idle(); await startAnswering(); }
  }

  async function startAnswering() {
    C.state.phase = "answer";
    C.state.notes = {};
    await nextStep();
  }

  async function nextStep() {
    const s = C.state;
    clearTimeout(C.timer);
    s.bench = benchList();
    s.options = {};
    s.sides.forEach((_, i) => { s.options[i] = optionsFor(i); });
    // Note the sides that are behind with nothing to spend (mockup: "Behind · nothing to spend").
    const lead = L().leaderIndex(s.sides);
    s.sides.forEach((st, i) => { if (!st.out && i !== lead && !hasOptions(i)) s.notes[i] = L().isFumble(st) ? "Fumbled · no answer possible" : "Behind · nothing to spend"; });
    const i = L().nextAnswerer(s.sides, hasOptions);
    if (i == null) { s.answering = null; await emit({ t: "state" }, { withState: true }); return resolveRound(); }
    s.answering = i; s.windowSeq = (s.windowSeq ?? 0) + 1;
    delete s.notes[i];
    await emit({ t: "state" }, { withState: true });
    const seq = s.windowSeq;
    C.timer = setTimeout(() => enqueue(async () => {
      if (!C || C.state.answering !== i || C.state.windowSeq !== seq) return;
      await emit({ t: "toast", side: i, html: `${esc(C.snap.sides[i].name)} keeps the result` });
      C.state.sides[i].accepted = true;
      await nextStep();
    }), Math.max(3, Number(C.opts.answerSeconds) || 25) * 1000);
  }

  async function changed(i) {
    L().reopenAfterChange(C.state.sides, i);
    C.state.answering = null;
    await idle();
    await nextStep();
  }

  // Reroll some dice of side i and animate it everywhere.
  async function rerollDice(i, dice, toastHtml) {
    const st = C.state.sides[i], snap = C.snap.sides[i];
    await emit({ t: "rerollMark", side: i, dice, toast: toastHtml });
    for (const d of dice) st[d] = null;
    for (const d of dice) {
      const faces = d === "a" ? snap.dA : snap.dB;
      const value = await I().rollDie(faces);
      const other = d === "a" ? st.b : st.a;
      st[d] = value;
      const both = st.a != null && st.b != null;
      const crit = both && L().isCrit(st), fumble = both && L().isFumble(st);
      if (both && crit) C.crits.push(i);
      if (both && fumble) C.fumbles.push({ i, a: st.a, b: st.b });
      await emit({ t: "roll", side: i, die: d, value, crit: crit && other != null, fumble, total: null, allIn: false });
    }
    await emit({ t: "rerollDone", side: i, total: L().total(st) }, { withState: true });
  }

  // ── Intents (GM) ─────────────────────────────────────────────────────────
  function enqueue(fn) {
    if (!C) return;
    C.chain = C.chain.then(() => (C ? fn() : null)).catch((e) => console.error(TAG, e));
  }

  async function handleIntent(userId, it) {
    if (!C || !it) return;
    const s = C.state, i = Number(it.side);
    const actor = C.actors[i];
    if (it.kind === "roll") {
      if (!mayAct(userId, actor)) return;
      return doRoll(i, it.die === "b" ? "b" : "a");
    }
    if (s.phase !== "answer") return;
    if (it.kind === "accept") {
      if (s.answering !== i || !mayAct(userId, actor)) return;
      clearTimeout(C.timer);
      s.sides[i].accepted = true; s.answering = null;
      await emit({ t: "toast", side: i, html: `${esc(C.snap.sides[i].name)} accepts` });
      return nextStep();
    }
    if (it.kind !== "invoke") return;
    if (it.what === "benchDivination") return benchDivination(userId, it.byActorUuid, i);
    if (s.answering !== i || !mayAct(userId, actor)) return;
    const opt = optionsFor(i).find((o) => o.id === it.what);
    if (!opt?.ok) return;
    clearTimeout(C.timer);
    const st = s.sides[i], snap = C.snap.sides[i], S = I();

    if (it.what === "trait") {
      const dice = it.choice === "ab" ? ["a", "b"] : [it.choice === "b" ? "b" : "a"];
      const pts = S.getTraitPoints(actor); if (pts < 1) return nextStep();
      await actor.update({ [`system.props.${st.res.key}`]: pts - 1 });
      st.res.n = pts - 1; st.usedTrait = true;
      const unit = st.res.kind === "up" ? "UP" : "FP";
      await rerollDice(i, dice, `🎭 ${esc(snap.name)} invokes a Trait · ${unit} ${pts} → ${pts - 1}`);
      return changed(i);
    }
    if (it.what === "bond") {
      const bond = snap.bonds.find((b) => String(b.idx) === String(it.choice)) ?? snap.bonds[0];
      const fp = S.getFP(actor); if (!bond || fp < 1) return nextStep();
      await actor.update({ "system.props.fabula_point": fp - 1 });
      st.res.n = fp - 1; st.usedBond = true;
      st.mods = [...st.mods, { label: `Bond: ${bond.name}`, value: bond.bonus, perCheck: true }];
      await emit({ t: "bond", side: i, toast: `🤝 Bond with ${esc(bond.name)} · +${bond.bonus} · FP ${fp} → ${fp - 1}`, total: L().total(st) }, { withState: true });
      return changed(i);
    }
    if (it.what === "lucky") {
      const luck = S.findLuckyState(actor); if (!luck) return nextStep();
      const die = it.choice === "b" ? "b" : "a";
      const old = st[die], Lnum = luck.luckyNumber;
      const api = S.chargesApi();
      if (luck.viaReady) { const spent = await api?.consume?.(luck.readyEffect, { count: 1, deleteWhenEmpty: true }); if (!spent?.ok) return nextStep(); }
      if (luck.sceneId) { try { await luck.storeEffect.update({ [`flags.${MODULE_ID}.${S.LS_USED_SCENE_FLAG}`]: luck.sceneId }); } catch (e) { console.warn(TAG, "lucky marker", e); } }
      try { await api?.set?.(luck.storeEffect, old, { deleteWhenEmpty: false }); } catch (e) { console.warn(TAG, "lucky writeback", e); }
      st[die] = Lnum; st.usedLucky = true; st.lucky = old;
      await emit({ t: "lucky", side: i, die, value: Lnum, toast: `🍀 Lucky Seven · ${old} → ${Lnum}. New lucky number: ${old}`, total: L().total(st) }, { withState: true });
      return changed(i);
    }
    if (it.what === "divination") {
      const res = await S.consumeDivinationCharge(actor); if (!res?.ok) return nextStep();
      st.usedDiv = true;
      await rerollDice(i, ["a", "b"], `🔮 ${esc(snap.name)} rerolls with Divination`);
      return changed(i);
    }
  }

  async function benchDivination(userId, byUuid, target) {
    const s = C.state;
    const by = await toActor(byUuid);
    if (!by || C.snap.sides.some((x) => x.actorUuid === by.uuid) || !mayAct(userId, by)) return;
    const st = s.sides[target];
    if (!st || st.out || !L().hasRolled(st) || L().isCrit(st) || L().isFumble(st)) return;
    const res = await I().consumeDivinationCharge(by); if (!res?.ok) return;
    clearTimeout(C.timer);
    await rerollDice(target, ["a", "b"], `🔮 ${esc(by.name)} forces ${esc(C.snap.sides[target].name)} to reroll both dice`);
    return changed(target);
  }

  // ── Resolve ──────────────────────────────────────────────────────────────
  async function resolveRound() {
    const s = C.state;
    s.phase = "resolving"; s.answering = null; clearTimeout(C.timer);
    const lead = L().leaderIndex(s.sides);
    if (lead === -1) {
      const tied = L().tiedForFirst(s.sides);
      C.roundLog.push(snapshotRound());
      await emit({ t: "draw", tied });
      L().beginRerollRound(s.sides);
      s.round += 1; s.notes = {};
      s.phase = "rolling";
      await emit({ t: "round", round: s.round, tied }, { withState: true });
      await idle();
      return startRolling();
    }
    return finish(lead);
  }
  const snapshotRound = () => C.state.sides.map((x) => ({ a: x.a, b: x.b, total: L().total(x), out: x.out }));

  async function finish(W) {
    const s = C.state, sides = s.sides;
    const R = L().runnerUp(sides, W);
    const ws = sides[W], rs = R != null ? sides[R] : null;
    const tier = L().marginTier(ws, rs), margin = L().margin(ws, rs);
    const n = sides.length;
    const wName = C.snap.sides[W].name;
    const special = L().isCrit(ws) ? "critical success" : (rs && L().isFumble(rs)) ? `${C.snap.sides[R].name} fumbled` : null;
    const headline = special ? `${wName} wins · ${special}` : (n > 2 ? `${wName} wins` : `${wName} wins by ${margin}`);
    let chips = [], clockOut = null;
    const pl = L().placings(sides);
    if (C.clock && n === 2) {
      clockOut = await moveClock(W, L().clockSections(tier));
      if (clockOut) {
        const moved = clockOut.to - clockOut.from;
        chips.push(`${clockOut.name}: ${moved >= 0 ? "+" : "−"}${Math.abs(moved)} section${Math.abs(moved) === 1 ? "" : "s"}`);
        if (tier) chips.push(special ? "crit / fumble counts as 6+" : tier === 2 ? "beat by 6+" : "beat by 3+");
      }
    } else if (n > 2) {
      chips = pl.map((p, k) => `${["1st", "2nd", "3rd", "4th"][k]} ${C.snap.sides[p.index].name} · ${L().isFumble(sides[p.index]) ? "fumble" : L().total(sides[p.index])}`)
        .concat(sides.map((x, i) => x.out ? `${C.snap.sides[i].name} · out (${L().total(x)})` : null).filter(Boolean));
    }
    await emit({ t: "win", winner: W, headline, chips, clock: clockOut ? { to: clockOut.to, sections: clockOut.sections, resolved: clockOut.resolved } : null });
    await idle();
    const result = buildResult(C, W, R, tier, margin, pl, clockOut);
    if (C.opts.postChat) await postChatCard(C, result).catch((e) => console.warn(TAG, "chat", e));
    await sleep(Math.max(0, Number(C.opts.holdMs) || 0));
    await emit({ t: "close" });
    await idle();
    const done = C; C = null;
    await afterEffects(done, result);
    done.resolve(result);
  }

  function buildResult(ctx, W, R, tier, margin, pl, clockOut) {
    const sides = ctx.state.sides.map((x, i) => {
      const sn = ctx.snap.sides[i];
      return {
        index: i, actorUuid: sn.actorUuid, actorName: sn.name, attrA: sn.attrA, attrB: sn.attrB, dieA: sn.dA, dieB: sn.dB,
        rollA: x.a, rollB: x.b, total: L().total(x), isCrit: L().isCrit(x), isFumble: L().isFumble(x),
        modifierParts: x.mods.map((m) => ({ label: m.label, value: m.value })),
        usedTrait: x.usedTrait, usedBond: x.usedBond, usedLuckySeven: x.usedLucky, usedDivination: x.usedDiv,
        out: !!x.out, place: pl.find((p) => p.index === i)?.place ?? null,
      };
    });
    const pick = (k) => (k == null ? null : { index: k, actorUuid: sides[k].actorUuid, actorName: sides[k].actorName, total: sides[k].total, isCrit: sides[k].isCrit });
    return {
      winner: pick(W), loser: sides.length === 2 ? pick(1 - W) : null, sides, placings: pl.map((p) => ({ ...p, actorUuid: sides[p.index].actorUuid })),
      margin, marginTier: tier, clockSections: L().clockSections(tier),
      clock: clockOut ? { id: clockOut.id, from: clockOut.from, to: clockOut.to, resolved: clockOut.resolved } : null,
      rounds: ctx.state.round, label: ctx.opts.label, stakes: ctx.opts.stakes, context: ctx.opts.context ?? {},
    };
  }

  // Reactions (fumble -> Fabula Ledger +1 FP, performs_check...) and crit Opportunities.
  async function afterEffects(done, result) {
    const S = I();
    try {
      for (const sd of result.sides) {
        if (sd.rollA == null) continue;
        S.emitCheckReactions({ actorUuid: sd.actorUuid, attrA: sd.attrA, attrB: sd.attrB, dl: null, rollA: sd.rollA, rollB: sd.rollB,
          total: sd.total, pass: sd.index === result.winner?.index, isCrit: sd.isCrit, isFumble: sd.isFumble, singleDie: false,
          usedTrait: sd.usedTrait, usedBond: sd.usedBond, usedDivination: sd.usedDivination, usedLuckySeven: sd.usedLuckySeven, flippedOutcome: false });
      }
      // A fumble in an earlier (drawn) round still counts as a fumble.
      for (const f of done.fumbles) {
        const sd = result.sides[f.i]; if (sd.isFumble && sd.rollA === f.a && sd.rollB === f.b) continue;
        S.emitCheckReactions({ actorUuid: sd.actorUuid, attrA: sd.attrA, attrB: sd.attrB, dl: null, rollA: f.a, rollB: f.b, total: f.a + f.b, pass: false, isCrit: false, isFumble: true, singleDie: false });
      }
    } catch (e) { console.warn(TAG, "reactions", e); }
    try {
      const crits = [...new Set(done.crits)].map((i) => result.sides[i]).filter(Boolean)
        .map((sd) => ({ actorUuid: sd.actorUuid, actorName: sd.actorName, isCrit: true, isFumble: false, total: sd.total, rollA: sd.rollA, rollB: sd.rollB, attrA: sd.attrA, attrB: sd.attrB }));
      if (crits.length) await globalThis.ONI?.OpportunitySystem?.processCheckCrits?.(crits);
    } catch (e) { console.warn(TAG, "opportunities", e); }
  }

  // ── Clock (Conflict mode) ────────────────────────────────────────────────
  function clockApi() { return globalThis.FUCompanion?.api?.clocks ?? null; }
  // Which way a side pushes: toward its own pole; with none, away from the other side's.
  function dirFor(clock, side) {
    const api = clockApi(); if (!api || !clock) return 0;
    if (side === "players") { const d = api.playerGoalDirection?.(clock); return d === "high" ? 1 : d === "low" ? -1 : 0; }
    const pole = api.poleFor?.(clock, "gm");
    if (pole === "high") return 1; if (pole === "low") return -1;
    const pd = api.playerGoalDirection?.(clock); return pd === "high" ? -1 : pd === "low" ? 1 : 0;
  }
  async function moveClock(W, sections) {
    const api = clockApi(); const id = C.clock?.id; if (!api || !id) return null;
    const clock = api.get(id); if (!clock) return null;
    const side = C.snap.sides[W].party ? "players" : "gm";
    const d = dirFor(clock, side);
    const from = clock.value;
    if (d !== 0) {
      try { await api.advance(id, { side, sections, direction: d > 0 ? "high" : "low", cause: `Contest: ${C.opts.label}`, actorUuid: C.snap.sides[W].actorUuid }); }
      catch (e) { console.warn(TAG, "clock advance", e); }
    }
    const after = api.get(id) ?? clock;
    return { id, name: after.name, from, to: after.value, sections: after.sections, resolved: after.state === "resolved" };
  }

  // ── Chat card ────────────────────────────────────────────────────────────
  async function postChatCard(ctx, r) {
    const rows = r.sides.map((sd) => {
      const sn = ctx?.snap?.sides?.[sd.index];
      const win = sd.index === r.winner?.index;
      const verdict = sd.out ? "OUT" : win ? "WINS" : sd.isFumble ? "FUMBLE" : sd.place ? (r.sides.length > 2 ? ["", "1st", "2nd", "3rd", "4th"][sd.place] : "LOSES") : "";
      const tag = sd.isCrit ? " · CRITICAL" : sd.isFumble && !sd.out ? "" : "";
      const mods = sd.modifierParts.filter((m) => m.value).map((m) => `${esc(m.label)} ${m.value > 0 ? "+" : ""}${m.value}`).join(", ");
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;margin-bottom:4px;border:1.5px solid rgba(91,63,38,.25);background:${win ? "rgba(245,197,66,.18)" : "transparent"}">
        <img src="${esc(sn?.img ?? "")}" alt="" style="width:34px;height:34px;object-fit:contain;border:none!important;background:transparent!important">
        <div style="flex:1;min-width:0"><div style="font-weight:800;font-size:.86rem">${esc(sd.actorName)}</div>
        <div style="font-size:.75rem;opacity:.75">${esc(sd.attrA)} + ${esc(sd.attrB)} · d${sd.dieA} + d${sd.dieB} · ${sd.rollA ?? "—"}, ${sd.rollB ?? "—"}${mods ? ` · ${mods}` : ""}</div></div>
        <div style="text-align:right"><div style="font-weight:900;font-size:1rem">${sd.total}</div><div style="font-weight:800;font-size:.72rem;color:${win ? "#7a5000" : "#6b5a45"}">${verdict}${tag}</div></div></div>`;
    }).join("");
    const extra = [r.stakes ? `Stakes: ${esc(r.stakes)}` : "", r.rounds > 1 ? `${r.rounds} rounds (ties rerolled)` : "",
      r.clock ? `Clock: ${r.clock.from} → ${r.clock.to}${r.clock.resolved ? " (resolved)" : ""}` : ""].filter(Boolean).join(" · ");
    await ChatMessage.create({
      content: `<div style="padding:9px 11px 7px;border-radius:10px;background:linear-gradient(180deg,#f6ebd3,#e4d0b5);border:2px solid rgba(91,63,38,.8);color:#3b2a19">
        <div style="font-weight:900;font-size:.92rem;margin-bottom:6px;border-bottom:1px solid rgba(0,0,0,.15);padding-bottom:5px">Contest — ${esc(r.label)}</div>
        ${rows}${extra ? `<div style="font-size:.75rem;opacity:.75;margin-top:4px">${extra}</div>` : ""}</div>`,
    });
  }

  // ── Silent mode (backend: no HUD, no invokes) ────────────────────────────
  async function silentContest(built, opts) {
    const S = I();
    const sides = built.map((b) => ({ ...b.state }));
    let rounds = 0; const crits = [], fumbles = [];
    while (rounds < 50) {
      rounds++;
      for (const i of L().liveIdx(sides)) {
        const sn = built[i].snap; const st = sides[i];
        if (st.a == null) st.a = await S.rollDie(sn.dA);
        if (st.b == null) st.b = await S.rollDie(sn.dB);
        if (L().isCrit(st)) crits.push(i); if (L().isFumble(st)) fumbles.push({ i, a: st.a, b: st.b });
      }
      if (L().leaderIndex(sides) !== -1) break;
      L().beginRerollRound(sides);
    }
    const ctx = { opts, snap: { sides: built.map((b) => b.snap) }, state: { sides, round: rounds }, crits, fumbles };
    const W = L().leaderIndex(sides), R = L().runnerUp(sides, W);
    const tier = L().marginTier(sides[W], R != null ? sides[R] : null), margin = L().margin(sides[W], R != null ? sides[R] : null);
    const result = buildResult(ctx, W, R, tier, margin, L().placings(sides), null);
    if (opts.postChat) await postChatCard(ctx, result).catch((e) => console.warn(TAG, "chat", e));
    await afterEffects(ctx, result);
    return result;
  }

  // ── Public ───────────────────────────────────────────────────────────────
  async function request(options = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} ONI.Contest.request must run on the GM client.`);
    if (!I() || !L()) throw new Error(`${TAG} Check Requester not ready.`);
    const opts = { ...DEFAULTS, ...options };
    opts.attrA = String(opts.attrA ?? "DEX").toUpperCase(); opts.attrB = String(opts.attrB ?? opts.attrA).toUpperCase();
    opts.checkBuffActions = Array.isArray(opts.checkBuffActions) ? opts.checkBuffActions : [];
    const specs = (opts.sides ?? []).filter(Boolean);
    if (specs.length < 2 || specs.length > 4) throw new Error(`${TAG} a contest needs 2 to 4 sides (got ${specs.length}).`);
    const party = await partyMemberUuids();
    const built = [];
    for (const sp of specs) built.push(await buildSide(sp, opts, party));

    if (opts.mode === "silent") return silentContest(built, opts);

    if (C) { console.warn(TAG, "a contest is already running; waiting for it to end"); await C.promise.catch(() => {}); }
    const sid = foundry.utils.randomID();
    let resolveFn; const promise = new Promise((r) => { resolveFn = r; });
    let clockSnap = null;
    if (opts.clock?.id && specs.length === 2) {
      const ck = clockApi()?.get?.(opts.clock.id);
      if (ck) {
        clockSnap = { id: ck.id, name: ck.name, sections: ck.sections, value: ck.value };
        built.forEach((b) => { b.snap.clockDir = dirFor(ck, b.snap.party ? "players" : "gm"); });
      }
    }
    C = {
      sid, opts, party, actors: built.map((b) => b.actor), clock: clockSnap, chain: Promise.resolve(), timer: null,
      crits: [], fumbles: [], roundLog: [], resolve: resolveFn, promise,
      snap: { sid, title: opts.label, stakes: opts.stakes, sides: built.map((b) => b.snap), clock: clockSnap },
      state: { sides: built.map((b) => b.state), phase: "intro", answering: null, windowSeq: 0, options: {}, bench: [], notes: {}, round: 1, rolling: {} },
    };
    await emit({ t: "open", snap: C.snap }, { withState: true });
    await idle();
    enqueue(startRolling);
    return promise;
  }

  // HUD clicks on THIS client: the GM handles its own, players send them to the GM.
  function onIntent(sid, intent) {
    if (game.user?.isGM) { if (C?.sid === sid) enqueue(() => handleIntent(game.user.id, intent)); return; }
    try { game.socket.emit(SOCKET_CH, { type: MSG_INTENT, payload: { sid, userId: game.user.id, intent } }); } catch (e) { console.warn(TAG, e); }
  }

  function setupSocket() {
    game.socket.on(SOCKET_CH, (msg) => {
      if (msg?.type === MSG_EV) {
        if (game.user?.isGM && C?.sid === msg.payload?.sid) return;      // the running GM already played it
        HUD()?.event(msg.payload?.sid, msg.payload?.ev);
      } else if (msg?.type === MSG_INTENT) {
        if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
        const { sid, userId, intent } = msg.payload ?? {};
        if (C?.sid === sid) enqueue(() => handleIntent(userId, intent));
      }
    });
  }

  ONI.Contest = { request, get running() { return C?.sid ?? null; } };

  Hooks.once("ready", () => {
    setupSocket();
    if (HUD()) HUD().onIntent = onIntent;
    console.debug(TAG, "Ready. ONI.Contest available.");
  });
})();
