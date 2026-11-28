// ═════════ move-engine · GAME host runtime (runs inside a pseudo.play inner script: ctx, canvas, PIXI, loadTexture, oni, …)
// Load order (build/game-build.js): shared/core.js, THIS, shared/fx-core.js, shared/common.js, shared/fx-melee.js,
// game/overrides.js, family parts, moves, then `await MOVE_PLAY(key)`.
//
// HOW A MOVE RUNS IN THE GAME
//  1. DRY RUN: the move's own beats run on a VIRTUAL clock (wait / tween resolve in time order, one per task, no real
//     waiting). Every command is recorded at its virtual ms: tweens (their own callbacks, replayed later), clips, sounds,
//     particles (their own draw code), screen state, hit cues, the damage gate. Direct state changes outside a tween
//     (setPos, a.rot = 0, …) are recorded too (actors are Proxies while recording).
//  2. PLAYBACK: oni.timeline on the LIVE board plays the recording: each frame re-applies the tweens in start order, steps
//     the particles, and paints the actors that moved (the others stay the real tokens: idle, depth, 3D).
//  So the planned ms of every event equals the mockup's (the mockup runs the same move on the same beat clock).
//
// MOCKUP SPACE: a move works in mockup px on the 1682 x 788 stage. Here, mockup px = board px / KP (KP = battle stage width
// / 1682), origin = the battle stage's top-left. An actor's s (depth size) = the board's perspective factor where it stands.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const MOVE_HOST = "game";
const ME_CFG = (ctx && ctx.params && ctx.params.cfg) || {};
const ME_ASSETS = (ctx && ctx.params && ctx.params.assets) || {};
const M = { clips: ME_ASSETS.clips || {}, sfx: ME_ASSETS.sfx || {}, sprites: ME_ASSETS.sprites || {} };
const ME_WARN = new Set();
const meWarn = (k, ...a) => { if (ME_WARN.has(k)) return; ME_WARN.add(k); console.warn("[move-engine]", k, ...a); };

// ───────── mockup-engine globals a move / shared part may read
let RUN = 1, FAST = false, SPEED = 1, SOUND = true;
const ABORT = new Error("abort");
const live = () => {};
const TIMERS = [], LOOPS = [], CLIPS = [];
const OPT = {}, SK = {};
const DN_COLOR = { physical: "#ffffff", fire: "#e25822", ice: "#5ab3d4", air: "#48c774", earth: "#b5793f", bolt: "#b06cc9", light: "#d4bb5f", dark: "#8c6cff", poison: "#3fae6c" };
const HC = { hits: 0, dmg: 0, t: 0 };
let GATE_AT = null, T0 = 0, BEAT = -1, CUR = null, SWAY = true, SHAKE = 0, WIELD = "caster";
const ME_DUMMY_EL = () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector: () => null, remove() {}, setAttribute() {} });
const $ = (id) => { const e = ME_DUMMY_EL(); e.id = id; return e; };   // page DOM does not exist here: parent: $("fground") still says "under"

// ───────── the board
const ME_CASTER_TOK = ctx.casterToken;
const ME_TARGET_TOKS = (ctx.targetTokens || []).filter((t) => t && t.center && t !== ME_CASTER_TOK);
if (!ME_CASTER_TOK) { oni.fireDone(); return; }
const meTexReady = (t) => { const tx = t && t.mesh && t.mesh.texture; return !!(tx && tx.valid && tx.baseTexture && tx.baseTexture.resource && tx.baseTexture.resource.source); };
for (let i = 0; i < 40 && [ME_CASTER_TOK, ...ME_TARGET_TOKS].some((t) => !meTexReady(t)); i++) await new Promise((r) => setTimeout(r, 50));
const meArtUrl = (t) => (meTexReady(t) ? undefined : (t.document && t.document.texture && t.document.texture.src) || undefined);
const ME_TOKENS = { k: { token: ME_CASTER_TOK, art: meArtUrl(ME_CASTER_TOK) } };
ME_TARGET_TOKS.forEach((t, i) => { ME_TOKENS["t" + i] = { token: t, foot: ME_CFG.partyFoot, art: meArtUrl(t) }; });
// engine 1.3.0: cfg.poses { name: url } = extra art for the CASTER a move swaps to (a form's idle); cfg.camera = the move drives
// the camera (FCAM): the timeline then owns the board (not LIVE: every token painted, the camera follows S.cam, the 3D stage
// flattens for the shot, like the shipped v1.0.575 Deva barrage). Without it the camera is left alone (FCAM.to = a wait).
const ME_POSES = ME_CFG.poses ? { k: Object.fromEntries(Object.entries(ME_CFG.poses).map(([p, url]) => [p, { url }])) } : {};
// cfg.targetPoses { pose: sheetProp } (1.3.0): each target's own sheet art as poses (a.pose = name), e.g. its walk clips
if (ME_CFG.targetPoses) ME_TARGET_TOKS.forEach((t, i) => { ME_POSES["t" + i] = Object.fromEntries(Object.entries(ME_CFG.targetPoses).map(([p, prop]) => [p, { prop }])); });
const ME_CAM = !!ME_CFG.camera;
const TL = oni.timeline({ tokens: ME_TOKENS, clips: M.clips, images: {}, poses: ME_POSES, live: !ME_CAM, depthRef: "k" });
await TL.load();
const TRK = [];                       // timeline tracks
const TM = TL.mk(TRK);
const KP = (TL.STAGE.w || W) / W;
const ORG = { x: TL.STAGE.x || 0, y: TL.STAGE.y || 0 };
const toW = (p) => ({ x: ORG.x + p.x * KP, y: ORG.y + p.y * KP });
const toM = (p) => ({ x: (p.x - ORG.x) / KP, y: (p.y - ORG.y) / KP });
const ME_BOT = (k) => ({ x: TL.TOK[k].x, y: TL.TOK[k].y + TL.TOK[k].h / 2 });   // art box bottom (mockup OY)
const ME_REF = ME_BOT("k");
// depth size = the board's own perspective factor (depth map x 3D stage), like the mockup's tokenScaleAt (1 at its reference row)
const meDepth = (wx, wy) => TL.depthS(wx, wy) || 1;
// mockup tokenScaleAt(y): the depth size at a mockup row (x = the caster's home column)
const tokenScaleAt = (y) => meDepth(ME_REF.x, ORG.y + y * KP);
const TG = { stage: { x: 0, y: 0, w: W, h: H }, scene: { w: W, h: H } };

// ───────── recording (dry run). Actors / screen state are Proxies: a write outside a tween callback becomes a timed step.
let VT = 0, PHASE = "dry", REC_ON = false, IN_TW = 0;
const STEPS = [], TWS = [], ME_Q = []; let ME_QSEQ = 0;
const ME_RAW = new WeakMap();
function meRec(obj) { const p = new Proxy(obj, { set(o, k, v) { if (REC_ON && !IN_TW && PHASE === "dry") STEPS.push({ at: VT, o, k, v }); o[k] = v; return true; } }); ME_RAW.set(p, obj); return p; }
const meRaw = (p) => ME_RAW.get(p) || p;

// the camera: the mockup's makeCam maths (focus x/y in mockup px at the screen centre, zoom z, zoom moved in log space).
// Played through S.cam when cfg.camera; otherwise a no-op that keeps the beat's length.
const FCAM = (() => { const raw = { x: W / 2, y: H / 2, z: 1, r: 0 };
  if (!ME_CAM) return Object.assign(raw, { to: (p, ms) => wait(ms), set() {}, screen: (p) => p, apply() {} });
  const c = meRec(raw);
  raw.to = (p, ms, ease = EASE.sine) => { const s = { x: c.x, y: c.y, z: c.z, r: c.r }; const e = { ...s, ...p };
    return tween(ms, ease, (t) => { c.x = lerp(s.x, e.x, t); c.y = lerp(s.y, e.y, t); c.r = lerp(s.r, e.r, t); c.z = Math.exp(lerp(Math.log(s.z), Math.log(e.z), t)); }); };
  raw.set = (p) => { for (const k of Object.keys(p)) c[k] = p[k]; };
  raw.screen = (p) => { const a = c.r * Math.PI / 180, dx = (p.x - c.x) * c.z, dy = (p.y - c.y) * c.z; return { x: W / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: H / 2 + dx * Math.sin(a) + dy * Math.cos(a) }; };
  raw.apply = () => {};
  return c; })(), DCAM = FCAM;

// the caster faces its first target (else the friendly side, else its art); mockup face(): party -1 (left), enemy +1
const ME_DIR = (() => { const K = TL.TOK.k; if (ME_TARGET_TOKS.length) return TL.TOK.t0.x >= K.x ? 1 : -1;
  const pcs = ((canvas.tokens && canvas.tokens.placeables) || []).filter((t) => t && t.document && t.document.disposition === 1 && t !== ME_CASTER_TOK);
  if (pcs.length) return (pcs.reduce((s, t) => s + t.center.x, 0) / pcs.length) >= K.x ? 1 : -1; return K.dir || 1; })();
function meActor(key, id, dir) {
  const T = TL.TOK[key], bot = toM(ME_BOT(key)), s = meDepth(ME_BOT(key).x, ME_BOT(key).y), kind = dir < 0 ? "party" : "enemy";
  const style = meRec({ opacity: "", zIndex: 0, filter: "", transform: "" }), mstyle = meRec({ filter: "", transform: "", transformOrigin: "" });
  const raw = { id, key, kind, on: true, x: bot.x, y: bot.y, cx: bot.x, cy: bot.y - T.h / KP / 2, dx: 0, dy: 0, rot: 0, s, hb: T.h / KP / s, wb: T.w / KP / s,
    flip: kind === "party" ? 1 : -1, baseFlip: kind === "party" ? 1 : -1, lift: 0, bob: 0, kx: 1, ky: 1, pose: null,
    el: { style }, body: { style: mstyle }, media: { style: mstyle, tagName: "IMG", getAttribute: () => null, play: () => Promise.resolve(), pause() {} }, src: null, resize() {} };
  return meRec(raw);
}
const CASTER = meActor("k", "caster", ME_DIR);
const TARGETS = ME_TARGET_TOKS.map((t, i) => meActor("t" + i, "target" + i, -ME_DIR));
const TARGET = TARGETS[0] || null;
const ACT = { caster: CASTER }; TARGETS.forEach((a, i) => { ACT["target" + i] = a; });
const PARTY = [CASTER, ...TARGETS].filter((a) => a.kind === "party"), ENEMIES = [CASTER, ...TARGETS].filter((a) => a.kind === "enemy");
const SCR = meRec({ white: 0, black: 0, dim: 0, dimC: "#000", vig: 0, rumble: 0 });
const ME_ACTORS = [CASTER, ...TARGETS];

// ───────── host roles (the same names the mockup host gives a move)
const moveCaster = () => CASTER;
const moveTarget = (i = 0) => TARGETS[i] || TARGETS[0] || null;
// the action's real Accuracy result for a target: { hit, crit, total, fumble, kind } (BD's payload.outcomes; a Chain's
// per-strike results are moveStrikes()). null when the game did not say (a bench preview without an outcome).
const meUuidOf = (t) => { const tok = t && ME_TARGET_TOKS[TARGETS.indexOf(t)]; return tok && tok.document && tok.document.uuid; };
// RESULT-like (shared/results.js makes the final shape): hit / crit / total / fumble + the PLANNED amount, element, affinity
function moveResult(t) {
  const list = Array.isArray(ctx.params.outcomes) ? ctx.params.outcomes : null; if (!list || !list.length) return null;
  const uuid = meUuidOf(t); const o = list.find((x) => x && x.tokenUuid === uuid) || list[0]; if (!o) return null;
  return { kind: o.hit === false ? "miss" : "hit", hit: o.hit !== false, crit: !!o.crit, total: o.total == null ? null : Number(o.total), fumble: !!o.fumble,
    amount: o.amount == null ? null : Number(o.amount), element: o.element || null, affinity: o.affinity || null };
}
// a Chain's planned strikes on target t, in order (BD: { index, roll, outcomes: [{ tokenUuid, kind, amount, isCrit }], perfect? })
function moveStrikes(t) {
  const list = Array.isArray(ctx.params.strikes) ? ctx.params.strikes : []; const uuid = meUuidOf(t);
  return list.map((s) => { const o = (s.outcomes || []).find((x) => x && x.tokenUuid === uuid) || (s.outcomes || [])[0] || {};
    return { kind: o.kind || "hit", crit: !!o.isCrit, amount: o.amount == null ? null : Number(o.amount), perfect: !!s.perfect, total: s.roll && s.roll.total != null ? Number(s.roll.total) : null }; });
}
const movePick = () => null;   // mockup pages only (result picker)
const moveVariant = () => ctx.params.variant || null;
// the active form of the caster's equipped form weapon (Lionheart / Gunblade weaponForms), 0 when none
function meWeaponForm() {
  try { const a = ME_CASTER_TOK.actor; const NS = "fabula-ultima-companion";
    const w = a.items.find((i) => i.flags && i.flags[NS] && Array.isArray(i.flags[NS].weaponForms) && i.system && i.system.props && i.system.props.isEquipped)
      || a.items.find((i) => i.flags && i.flags[NS] && Array.isArray(i.flags[NS].weaponForms));
    return w ? Number(w.flags[NS].activeForm || 0) || 0 : 0; } catch (e) { return 0; } }

// ───────── the beat clock (virtual). wait / tween register a resolve at their target ms; the driver releases them in
// time order, one per task, so every continuation runs with VT = its own ms.
function wait(ms) { const target = VT + Math.max(0, ms || 0); return new Promise((res) => ME_Q.push({ target, seq: ME_QSEQ++, res })); }
function tween(ms, ease, fn) {
  const tw = { start: VT, ms: Math.max(0, ms || 0), ease, fn, fin: false }; TWS.push(tw);
  return new Promise((res) => ME_Q.push({ target: VT + tw.ms, seq: ME_QSEQ++, res: () => { tw.dryFin = true; IN_TW++; try { fn(ease(1)); } catch (e) { console.warn("[move-engine] tween threw", e); } IN_TW--; res(); } }));
}
// advance the tweens still running to the virtual now, so a move that READS state mid-tween sees what the mockup would
function meAdvance() { IN_TW++; for (const tw of TWS) { if (tw.dryFin || tw.start > VT) continue; const u = tw.ms > 0 ? (VT - tw.start) / tw.ms : 1; if (u < 1) { try { tw.fn(tw.ease(Math.max(0, u))); } catch (e) {} } } IN_TW--; }
const ME_MC = new MessageChannel(); let ME_MC_RES = null; ME_MC.port1.onmessage = () => { const r = ME_MC_RES; ME_MC_RES = null; if (r) r(); };
const meYield = () => new Promise((r) => { ME_MC_RES = r; ME_MC.port2.postMessage(0); });
async function meDrive(main, { maxMs = 60000, tailMs = 8000 } = {}) {
  let done = false, err = null, endVT = null;
  main().then(() => { done = true; endVT = VT; }, (e) => { done = true; err = e; });
  for (let n = 0; n < 200000; n++) {
    await meYield();
    if (err) throw err;
    meProbeOpen();
    if (!ME_Q.length) { if (done) break; throw new Error("move stalled at " + VT + " ms: it awaits something the game runtime never resolves"); }
    ME_Q.sort((a, b) => a.target - b.target || a.seq - b.seq);
    if (done && ME_Q[0].target > endVT + tailMs) break;      // a forgotten loop after the move ended
    if (ME_Q[0].target > maxMs) throw new Error("move runs past " + maxMs + " ms");
    const d = ME_Q.shift(); VT = d.target; meAdvance(); d.res();
  }
  meProbeOpen();
  return endVT == null ? VT : endVT;
}

// ───────── recorded effects
const ME_ONCE = [];                    // [{ at, fn }]
const ME_SFX = [];                     // oni.timeline sfx list
const ME_PARTS = [];                   // particles { t0, layer, p }
// open-ended particles (life 1e9) that die on a flag the move flips later (speed lines, a shadow, a ground mark): the dry
// run flips the flag long before playback starts, so they died on playback's first frame. The flag is read in virtual time
// instead (meProbeOpen, every scheduler step): the particle's life ends at the ms it was switched off, then the flag is ignored.
const ME_OPEN = [];
function meProbeOpen() { for (let i = ME_OPEN.length - 1; i >= 0; i--) { const e = ME_OPEN[i], p = e.p; const c = Object.assign({}, p, { dead: false });
  try { p.update(c, 0); } catch (er) {} if (!c.dead) continue; ME_OPEN.splice(i, 1); p.life = Math.max(1, VT - e.t0);
  const up = p.update; p.update = (q, dt) => { up(q, dt); q.dead = false; }; } }
const ME_AFTER = [];                   // afterimages
let ME_GATE = null;
const meOnce = (fn) => { if (PHASE === "dry") ME_ONCE.push({ at: VT, fn }); };
function sfx(key, vol = .55, rate = 1, stopAfter = 0) {
  traceEv("sfx", { key, vol, rate, ...(stopAfter ? { stopAfter } : {}), ...(M.sfx[key] ? {} : { missing: true }) });
  const url = M.sfx[key]; if (PHASE !== "dry" || !url) return null; const v = Math.min(1, vol * .75);
  if (rate !== 1 || stopAfter) meOnce(() => oni.sfx(url, { volume: v, rate, fadeAfter: stopAfter || 0, fadeMs: 300 })); else ME_SFX.push({ at: VT, url, v });
  return { pause() {}, play() {}, volume: v };
}
function addP(layer, p) { if (PHASE !== "dry") return; const q = Object.assign({ t: 0, life: 1000, vx: 0, vy: 0, g: 0, drag: 1 }, p);
  const e = { t0: VT, layer, p: q }; ME_PARTS.push(e); if (q.update && q.life >= 1e8) ME_OPEN.push(e);
  if (q.onDie) { const life = q.life; ME_Q.push({ target: VT + life, seq: ME_QSEQ++, res: () => { const c = meSimParticle(Object.assign({}, q), life); try { q.onDie(c); } catch (e) { console.warn("[move-engine] onDie threw", e); } } }); } }
function meStepParticle(p, dt) { if (p.update) p.update(p, dt); else { p.vy += p.g * dt; p.vx *= Math.pow(p.drag, dt / 16); p.vy *= Math.pow(p.drag, dt / 16); p.x += p.vx * dt; p.y += p.vy * dt; } }
function meSimParticle(c, life) { let t = 0; while (t < life) { const dt = Math.min(16, life - t); c.t += dt; t += dt; meStepParticle(c, dt); } return c; }
const ME_CLIP_DUMMY = { done: Promise.resolve(), impact: Promise.resolve(), el: null, stop() { return Promise.resolve(); } };
// fadeIn (1.3.0): the clip's opacity rises over its first fadeIn ms (the mockup fades its <video> element instead)
function clip(key, pt, { scale = 1, filter = "", blend = "", rate = 1, flip = false, rot = 0, opacity = 1, parent = null, loop = false, z = 0, sy = 1, fadeIn = 0 } = {}) {
  const c = M.clips[key];
  traceEv("clip", { key, at2: tracePt(pt), scale: Math.round(scale * 1000) / 1000, rate, ...(filter ? { filter } : {}), ...(flip ? { flip } : {}), ...(rot ? { rot } : {}), ...(loop ? { loop } : {}), ...(c ? {} : { missing: true }) });
  if (PHASE !== "dry" || !c) { if (!c) meWarn("clip missing: " + key); return ME_CLIP_DUMMY; }
  const k = scale * (c.k != null ? c.k : (c.ro ? 1.1 : .55)), wp = toW(pt), at = VT, dur = (c.dur || 1000) / (rate || 1);
  const under = !!(parent && parent.id === "fground");
  const o = { x: wp.x, y: wp.y, w: c.w * k * KP, rate, flip, rot: rot * Math.PI / 180, filter: filter || undefined, add: (c.add || /plus-lighter/.test(blend || "")) ? "plus" : /screen|lighter/.test(blend || ""), depth: false,
    z: under ? 3 : 26 + clamp((z || 0) / 10000, 0, 2.9), sy: sy !== 1 ? sy : undefined, loop, hold: loop ? 1e9 : undefined, alpha: fadeIn > 0 ? (u) => opacity * Math.min(1, u * (loop ? 1e9 : dur) / fadeIn) : opacity !== 1 ? () => opacity : undefined };
  TM.clip(key, at, o); const tr = TRK[TRK.length - 1];
  return { done: loop ? new Promise(() => {}) : wait(dur), impact: wait((c.impact != null ? c.impact : (c.dur || 1000) * .4) / (rate || 1)), el: null,
    stop: (ms = 300) => { const ts = VT, span = loop ? 1e9 : dur; o.alpha = (u) => { const t = at + u * span; return t < ts ? opacity : opacity * Math.max(0, 1 - (t - ts) / ms); }; tr.t1 = Math.min(tr.t1, ts + ms); return wait(ms); } };
}
// screen effects (the mockup's DOM layers -> the timeline state)
function flash(color = "#fff", peak = 1, inMs = 40, outMs = 160) { traceEv("flash", { color, peak, inMs, outMs }); if (PHASE === "dry") TM.flash(VT, inMs, outMs, color, peak); return wait(inMs + outMs); }
const whiteTo = (o, ms, ease = EASE.sine) => { traceEv("white", { to: o, ms }); const s = SCR.white; return tween(ms, ease, (t) => { SCR.white = lerp(s, o, t); }); };
const blackTo = (o, ms) => { traceEv("black", { to: o, ms }); const s = SCR.black; return tween(ms, EASE.sine, (t) => { SCR.black = lerp(s, o, t); }); };
const fdim = (o, ms = 500, color = "#000") => { traceEv("dim", { to: o, ms, color }); const s = SCR.dim; return tween(ms, EASE.sine, (t) => { SCR.dimC = color; SCR.dim = lerp(s, o, t); }); };
const vignette = (o, ms) => { traceEv("vignette", { to: o, ms }); const s = SCR.vig; return tween(ms, EASE.sine, (t) => { SCR.vig = lerp(s, o, t); }); };
function shake(px = 10, ms = 320) { traceEv("shake", { px, ms }); if (PHASE === "dry") TM.shake(VT, ms, px * KP); return wait(ms); }
function rumble(on, px = 3) { traceEv("rumble", { on: !!on, px }); SCR.rumble = on ? px : 0; }
// The damage gate. The game shows the action's numbers AT the gate, while a mockup shows them where the move calls gameNum():
// so the gate is the move's FIRST hit number when it has one (what was approved on screen), else its markGate().
let ME_MARK = null, ME_FIRST_HIT = null;
function markGate() { traceEv("gate"); if (PHASE === "dry" && ME_MARK == null) ME_MARK = VT; }
// hit cues: the game's own number / MISS / flinch / HP bar ride oni.hit (Chain) and the damage gate (BD)
function meHitCue(kind, data) { traceEv("hit", Object.assign({ kind }, data || {})); if (PHASE === "dry" && ME_FIRST_HIT == null) ME_FIRST_HIT = VT; meOnce(() => oni.hit({ paced: true })); }
function gameNum(t, amount, { kind = "loss", resource = "hp", element = "physical", crit = false, isHit = true } = {}) { if (kind === "loss" && resource === "hp") meHitCue(isHit ? "hit" : "bonus", { amount, element, crit }); else if (kind === "miss") meHitCue("miss"); }
// engine 1.3.0, cfg.gateOnNum: a non-Chain move's numbers land where the mockup shows them. The gate (BD writes + shows the
// numbers) is the move's FIRST number; every other target's first number is reported as its impact offset (oni.impactOffsets),
// so BD shows it at its own moment. No Chain cue here: a Chain move cues its strikes itself (gameNum).
const ME_NUM_AT = new Map();
function dmgNum(key, at, amount, { element = "physical" } = {}) { traceEv("num", { who: key, amount, element });
  const num = amount > 0 && !["mp", "ip", "heal", "self"].includes(element); if (!num) return;
  if (ME_CFG.gateOnNum) { if (PHASE !== "dry") return; if (ME_FIRST_HIT == null) ME_FIRST_HIT = VT;
    const a = ME_ACTORS.find((x) => String(key).startsWith(meRaw(x).id)); const u = a && meUuidOf(a); if (u && !ME_NUM_AT.has(u)) ME_NUM_AT.set(u, VT); return; }
  meOnce(() => oni.hit({ paced: true })); }
const numAt = (a) => () => ({ x: OX(a), y: OY(a) - hgt(a) * .5 });
// the mockup's replicas of game UI: the game draws its own (namecard = the action card, cut-in = BD's crit cut-in BEFORE the
// animation). They keep the mockup's awaited length where the move awaits them, so the beats line up.
async function namecard(title) { traceEv("namecard", { title }); return wait(350); }
async function critCutin(id) { traceEv("critCutin", { id, note: "game: BD plays the crit cut-in before the animation" }); }
async function cutin(src, { slideIn = 650, hold = 850, slideOut = 650 } = {}) { traceEv("cutin", { note: "game: not drawn by the move" }); return wait(slideIn + hold + slideOut); }
function hitReact() {} function npcBar() {} function npcBarReset() {} function hcAdd() {} function hcReset() {} function hcDmg() {} function pop() {}
function hudForm() {} function hudNoForm() {} function hudCost() {} function hudSpendMP() {} function renderBalance() {} function renderMeta() {} function releaseVideos() {}
// not available in the game runtime (DOM-only mockup helpers). The build refuses moves that call them; at run time: warn, no-op.
const meUnsupported = (name) => (...a) => { meWarn("not in the game runtime: " + name + "()"); traceEv("unsupported", { name }); return Promise.resolve(); };
// ───────── sprite props (engine 1.3.0): the mockup's DOM sprite() as a recorded canvas prop. Same fields and maths as the
// mockup's (feet-anchored at x/y, h drawn height, translate(ox, oy) rotate(rot) scale(sx * flip, sy) about the bottom centre,
// opacity, a CSS filter, mix-blend). Its state is recorded like an actor's (writes outside tweens = timed steps, tweens
// replayed), its image is drawn by the painter with the filter baked once. Extras the game needs because it has no DOM:
//   { actor: a }  the image is that actor's art in its current pose (the mockup's sprite(a.media.src) copies of a battler)
//   o.trail = n   n copies behind it along its local -y, alpha .45 / k (the mockup's cloned <img> trail, barrage fists)
const ME_PROPS = [];
const ME_PRELOAD = [];   // promises a family part pushes (images it reads during the dry run); MOVE_PLAY awaits them
const ME_PROP_SRC = new Set();
function sprite(src, parent, { x = 0, y = 0, h = 170, flip = 1, filter = "", opacity = 1, z = 1, blend = "", actor = null } = {}) {
  const raw = { x, y, h, w: h * .6, flip, rot: 0, sx: 1, sy: 1, opacity, ox: 0, oy: 0, z, src: src || null, filter: filter || "", blend: blend || "",
    actor: actor ? meRaw(actor) : null, pose: actor ? meRaw(actor).pose : null, under: !!(parent && parent.id === "fground"), dead: false, trail: 0, trailStep: .38, trailA: .45 };
  const o = meRec(raw);
  // the mockup reads / appends to f.m.style.filter: route it to the recorded field
  raw.m = { style: { get filter() { return o.filter; }, set filter(v) { o.filter = v; } }, cloneNode: () => ({ style: {} }), getAttribute: () => o.src };
  raw.el = { style: {}, appendChild() {} };
  raw.apply = () => {}; raw.set = (p) => { for (const k of Object.keys(p)) o[k] = p[k]; return o; };
  raw.swap = (s2) => { o.src = s2; if (s2) ME_PROP_SRC.add(s2); };
  raw.move = (x2, y2, ms, ease = EASE.quad, hop = 0, steps = 1) => { const x0 = o.x, y0 = o.y;
    return tween(ms, ease, (t) => { o.x = lerp(x0, x2, t); o.y = lerp(y0, y2, t); o.oy = -Math.abs(Math.sin(t * Math.PI * steps)) * hop; }); };
  raw.fade = (to, ms) => { const f = o.opacity; return tween(ms, EASE.sine, (t) => { o.opacity = lerp(f, to, t); }); };
  raw.headPt = () => ({ x: o.x, y: o.y - o.h * .86 }); raw.mid = () => ({ x: o.x, y: o.y - o.h * .5 });
  raw.remove = () => { o.dead = true; };
  if (PHASE === "dry") { const init = {}; for (const k of Object.keys(raw)) if (typeof raw[k] !== "function" && k !== "m" && k !== "el") init[k] = raw[k];
    ME_PROPS.push({ t0: VT, raw, init }); if (src) ME_PROP_SRC.add(src); }
  return o;
}
const battlerCopy = (a, parent, x, y, opt = {}) => sprite(null, parent, { x, y, actor: a, ...opt });
const silhouette = meUnsupported("silhouette"), swapArt = meUnsupported("swapArt"), restoreArt = meUnsupported("restoreArt"), setLineup = meUnsupported("setLineup");
const groundPortal = (...a) => { meUnsupported("groundPortal")(); return { close: () => Promise.resolve() }; };
// impactFrame (engine 1.3.0): the mockup's two-frame anime impact: a black screen with white rays + white silhouettes of the
// targets, then white with black rays + black silhouettes. Same rnd() draws in the same order as the mockup (2 x 46 rays).
async function impactFrame(targets, ms = 70) {
  traceEv("impactFrame", { ms, n: targets.length }); if (FAST) return;
  const list = targets.map(meRaw), cen = list.reduce((a, t) => { const p = FCAM.screen(center(t)); return { x: a.x + p.x / list.length, y: a.y + p.y / list.length }; }, { x: 0, y: 0 });
  const rays = () => Array.from({ length: 46 }, () => ({ a: rnd(0, Math.PI * 2), w: rnd(.006, .03), r0: rnd(90, 220) }));
  const A = rays(), at = VT; const B = (await wait(ms), rays());
  if (PHASE !== "dry") return wait(ms);
  const snaps = list.map((t) => meSnap(t));
  const paint = (g, bg, fg, R, silF) => {
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.fillStyle = bg; g.fillRect(0, 0, g.canvas.width, g.canvas.height); g.restore();
    g.save(); g.translate(ORG.x, ORG.y); g.scale(KP, KP); g.fillStyle = fg;
    for (const r of R) { g.beginPath(); g.moveTo(cen.x + Math.cos(r.a) * r.r0, cen.y + Math.sin(r.a) * r.r0); g.lineTo(cen.x + Math.cos(r.a - r.w) * 1900, cen.y + Math.sin(r.a - r.w) * 1900); g.lineTo(cen.x + Math.cos(r.a + r.w) * 1900, cen.y + Math.sin(r.a + r.w) * 1900); g.fill(); }
    g.restore();
    list.forEach((t, i) => mePaint(g, t, snaps[i], meBaked(t.key, silF, snaps[i].pose), 1)); };
  TM.hold(at, at + ms, (e, S) => { S.world.push({ z: 45, draw: (g) => paint(g, "#000", "#fff", A, "brightness(0) invert(1)") }); });
  TM.hold(at + ms, at + 2 * ms, (e, S) => { S.world.push({ z: 45, draw: (g) => paint(g, "#fff", "#000", B, "brightness(0)") }); });
  return wait(ms);
}
const castFocus = (keep, ms = 350) => { traceEv("unsupported", { name: "castFocus" }); return wait(ms); };
const castUnfocus = (ms = 500) => wait(ms);
const hurtArt = () => null;

// ───────── actors (the mockup engine's formulas, verbatim)
function setPos(a, dx, dy = a.dy, bob = 0) { a.dx = dx; a.dy = dy; a.bob = bob; }
const hgt = (a) => a.hb * a.s, wid = (a) => a.wb * a.s;
const OX = (a) => a.x + a.dx, OY = (a) => a.y + a.dy;
const center = (a) => ({ x: OX(a), y: OY(a) - hgt(a) * .5 });
const feet = (a) => ({ x: OX(a), y: OY(a) - 4 });
const head = (a) => ({ x: OX(a), y: OY(a) - hgt(a) * .92 });
const face = (a) => a.kind === "party" ? -1 : 1;
async function slide(a, dx, ms = 420, dy = a.dy, ease = EASE.quad) { const x0 = a.dx, y0 = a.dy; await tween(ms, ease, (t) => setPos(a, lerp(x0, dx, t), lerp(y0, dy, t))); }
const stepOut = (a, d = 40) => slide(a, face(a) * d, 380);
const stepBack = (a) => slide(a, 0, 460, 0);
// flashActor: the mockup's CSS glow (drop-shadow 14 px → 0 + brightness 2.3 → 1). The game paints it WITHOUT a per-frame canvas
// filter (a blur filter on the art every frame is a 100+ ms hitch, found by `move-engine parity`): the glow of each colour is
// rendered once before playback (meGlow), then drawn with the fading strength glowK, plus an additive brighten of the art.
const ME_GLOWS = new Set();
function flashActor(a, color = "#fff", ms = 260) { const m = a.media; if (PHASE === "dry") ME_GLOWS.add(meRaw(a).key + "|" + color);
  return tween(ms, EASE.out, (t) => { m.style.filter = `drop-shadow(0 0 ${14*(1-t)}px ${color}) brightness(${1 + 1.3*(1-t)})`; a.glowC = color; a.glowK = 1 - t; })
    .then(() => { m.style.filter = ""; a.glowK = 0; }); }
async function hurt(a, color) { flashActor(a, color).catch(() => {}); const d = -face(a); await tween(300, EASE.lin, (t) => setPos(a, d * Math.sin(t * Math.PI * 4) * 7 * (1 - t), a.dy)); setPos(a, 0, a.dy); }
function buffBeat(a) { clip("051_powerup_1", feet(a), { scale: tokenScaleAt(OY(a)) }); sfx("powerup", .35 / .75); }
// afterimage (replaces shared/common.js's DOM version in game/overrides.js): the actor's pose is read when it shows
function meAfterimage(a, { opacity = .5, ms = 380, hue = null } = {}) { if (PHASE !== "dry") return;
  const f = hue == null ? "brightness(1.6) saturate(.4)" : `sepia(1) saturate(5) hue-rotate(${hue - 38}deg) brightness(1.35)`;
  ME_AFTER.push({ t0: VT, ms, op: opacity, filter: f, a: meRaw(a), snap: null }); }

// ───────── chroma (replaces shared/fx-melee.js's DOM version): the same SVG filter on the board view + the timeline overlay
const ME_CHROMA = "oni-me-chroma";
function meChromaFilter() { try { if (document.getElementById(ME_CHROMA)) return true; const ns = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(ns, "svg"); svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.style.position = "absolute"; svg.style.pointerEvents = "none";
  svg.innerHTML = '<filter id="' + ME_CHROMA + '" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset id="' + ME_CHROMA + '-r" in="r" dx="0" result="r2"/><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/><feOffset id="' + ME_CHROMA + '-b" in="b" dx="0" result="b2"/><feBlend in="r2" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b2" mode="screen"/></filter>';
  document.body.appendChild(svg); return true; } catch (e) { return false; } }
function meChroma(px, ms = 180, punch = 1.25) { traceEv("chroma", { px, ms, punch }); if (PHASE !== "dry" || px <= 0) return Promise.resolve();
  const at = VT, els = () => [canvas.app && canvas.app.view, document.querySelector(".oni-timeline-overlay")].filter(Boolean);
  const clear = () => { for (const el of els()) el.style.filter = ""; };
  TM.hold(at, at + ms, (e) => { if (!meChromaFilter()) return; const r = document.getElementById(ME_CHROMA + "-r"), b = document.getElementById(ME_CHROMA + "-b"); if (!r || !b) return;
    const k = 1 - EASE.out(Math.min(1, e / ms)), view = canvas.app && canvas.app.view, sc = view ? view.getBoundingClientRect().width / W : 1;
    r.setAttribute("dx", (px * k * sc).toFixed(2)); b.setAttribute("dx", (-px * k * sc).toFixed(2));
    const fl = "url(#" + ME_CHROMA + ") contrast(" + (1 + (punch - 1) * k).toFixed(3) + ") saturate(" + (1 + (punch - 1) * 1.6 * k).toFixed(3) + ")"; for (const el of els()) el.style.filter = fl; });
  ME_ONCE.push({ at: at + ms, fn: clear }); ME_CLEANUP.push(clear);
  return wait(ms); }
const ME_CLEANUP = [];

// ───────── playback painter
const ME_BLANK = document.createElement("canvas"); ME_BLANK.width = 2; ME_BLANK.height = 2;
// the "blank" pose: an actor the runtime paints itself (glow, filter) sets pose "blank" so the timeline does not ALSO draw the token
// art (unregistered, drawTok fell back to the art: the token was drawn twice, a double-bright glint)
for (const k of Object.keys(ME_TOKENS)) (TL.POSE[k] = TL.POSE[k] || {}).blank = { img: ME_BLANK, foot: 1, w: 0.01, h: 0.01 };
const ME_LAYER_Z = { ground: 2, field: 4, dim: 3, hit: 30 };
const ME_BAKE = new Map();
function meBaked(key, filter, pose = null) { const img = meArt(key, pose); if (!filter || !img) return img; const id = key + "|" + (pose || "") + "|" + filter; let c = ME_BAKE.get(id); if (c) return c;
  const w = img.videoWidth || img.naturalWidth || img.width, h = img.videoHeight || img.naturalHeight || img.height; if (!w || !h) return img;
  c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.filter = filter.replace(/([\d.]+)px/g, (m0, n) => (Number(n) * w / Math.max(1, TL.TOK[key].w / KP)).toFixed(2) + "px"); x.drawImage(img, 0, 0, w, h); ME_BAKE.set(id, c); return c; }
// flipR (1.3.0): the mockup's a.flip relative to the actor's resting facing (a Paper Mario spin writes flip), folded into kx
function meSnap(a) { const o = parseFloat(a.el.style.opacity), fr = a.baseFlip ? (a.flip == null ? 1 : a.flip / a.baseFlip) : 1;
  return { dx: a.dx, dy: a.dy, air: (a.lift || 0) - (a.bob || 0), rot: a.rot || 0, kx: (a.kx == null ? 1 : a.kx) * fr, ky: a.ky == null ? 1 : a.ky, alpha: Number.isFinite(o) ? o : 1, filter: a.media.style.filter || "", glowK: a.glowK || 0, glowC: a.glowC || null, pose: a.pose || null }; }
// the art an actor shows now: its pose (cfg.poses) or the token's own art
const meArt = (key, pose) => (pose && TL.POSE[key] && TL.POSE[key][pose] && TL.POSE[key][pose].img) || TL.art(key);
// a prop image (URL or data: URI), loaded before playback
const ME_PIMG = new Map();
async function meLoadProps() { for (const s of ME_PROP_SRC) { if (ME_PIMG.has(s)) continue; let img = null;
  try { if (/^data:/.test(s)) img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = s; });
    else { const tex = await loadTexture(s); img = tex && tex.baseTexture && tex.baseTexture.resource && tex.baseTexture.resource.source || null; } } catch (e) { img = null; }
  if (!img) meWarn("prop image failed: " + String(s).slice(0, 80)); ME_PIMG.set(s, img); } }
// a prop image with its CSS filter baked once (px lengths are drawn px: scaled to the image's own pixels by the first drawn h)
const ME_PBAKE = new Map();
function mePropBaked(img, id, filter, h) { if (!img) return null; if (!filter) return { c: img, pad: 0 };
  const k0 = id + "|" + filter; let b = ME_PBAKE.get(k0); if (b) return b;
  const w = img.videoWidth || img.naturalWidth || img.width, ih = img.videoHeight || img.naturalHeight || img.height; if (!w || !ih) return { c: img, pad: 0 };
  const sc = ih / Math.max(1, h), f = filter.replace(/([\d.]+)px/g, (m0, n) => (Number(n) * sc).toFixed(2) + "px");
  const pad = Math.ceil(Math.max(0, ...[...filter.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]))) * sc * 2.5) + 2;
  const c = document.createElement("canvas"); c.width = w + 2 * pad; c.height = ih + 2 * pad; const x = c.getContext("2d"); x.filter = f; x.drawImage(img, pad, pad, w, ih);
  try { x.getImageData(0, 0, 1, 1); } catch (e) {}
  b = { c, pad: pad / sc }; ME_PBAKE.set(k0, b); return b; }
function mePaintProp(g, p) {
  let img, id;
  if (p.actor) { img = meArt(p.actor.key, p.pose); id = "actor:" + p.actor.key + ":" + (p.pose || ""); } else { img = ME_PIMG.get(p.src); id = p.src; }
  if (!img || !(p.opacity > 0)) return;
  const iw = img.videoWidth || img.naturalWidth || img.width || 1, ih = img.videoHeight || img.naturalHeight || img.height || 1, w = p.h * iw / ih, h = p.h;
  const b = mePropBaked(img, id, p.filter, h); if (!b) return;
  g.save(); g.translate(ORG.x, ORG.y); g.scale(KP, KP);
  g.translate(p.x + p.ox, p.y + p.oy); if (p.rot) g.rotate(p.rot * Math.PI / 180); g.scale(p.sx * p.flip, p.sy);
  if (p.blend) g.globalCompositeOperation = /screen/.test(p.blend) ? "screen" : /plus-lighter|lighter/.test(p.blend) ? "lighter" : /multiply/.test(p.blend) ? "multiply" : "source-over";
  for (let k = p.trail; k >= 1; k--) { g.globalAlpha = p.opacity * p.trailA / k; g.drawImage(b.c, -w / 2 - b.pad, -h - b.pad - k * p.trailStep * h, w + 2 * b.pad, h + 2 * b.pad); }
  g.globalAlpha = Math.min(1, p.opacity); g.drawImage(b.c, -w / 2 - b.pad, -h - b.pad, w + 2 * b.pad, h + 2 * b.pad);
  g.restore(); }
// the glow of an actor's art in one colour, rendered once at a few sizes: a colour silhouette blurred like CSS
// drop-shadow(0 0 R px) (σ = R / 2). flashActor's CSS glow SHRINKS at full strength (R = 14 → 0); each frame draws the two
// pre-rendered sizes around the current R, blended, behind the art (engine 1.2.1; 1.2.0 faded one 14 px glow = softer).
const ME_GLOW = new Map(), ME_GLOW_R = [14, 10, 7, 4.5, 2.5, 1];
function meGlow(key, color) {
  const id = key + "|" + color; if (ME_GLOW.has(id)) return ME_GLOW.get(id);
  const img = TL.art(key), T = TL.TOK[key]; let res = null;
  try { const w = img && (img.videoWidth || img.naturalWidth || img.width), h = img && (img.videoHeight || img.naturalHeight || img.height);
    if (w && h) { const k = w / Math.max(1, T.w), pad = Math.ceil(ME_GLOW_R[0] / 2 * KP * k * 3);
      const sil = document.createElement("canvas"); sil.width = w + 2 * pad; sil.height = h + 2 * pad; const s = sil.getContext("2d");
      s.drawImage(img, pad, pad, w, h); s.globalCompositeOperation = "source-in"; s.fillStyle = color; s.fillRect(0, 0, sil.width, sil.height);
      // HALF resolution (a blur looks the same, a quarter of the pixels) and FLUSHED now: canvas drawing is lazy, so without the
      // 1-pixel read the six blurs ran on the glint's first frame (a 140-200 ms hitch in 1.2.1, found by a clean parity run)
      const levels = ME_GLOW_R.map((R) => { const out = document.createElement("canvas"); out.width = Math.ceil(sil.width / 2); out.height = Math.ceil(sil.height / 2);
        const o = out.getContext("2d"); o.filter = "blur(" + (R / 4 * KP * k).toFixed(2) + "px)"; o.drawImage(sil, 0, 0, out.width, out.height);
        try { o.getImageData(0, 0, 1, 1); } catch (e) {} return { R, c: out }; });
      res = { levels, padW: pad / k }; } } catch (e) { res = null; }
  ME_GLOW.set(id, res); return res;
}
// the pre-rendered sizes for glow radius R: [[level, weight], …] (between the two nearest; none below the smallest)
function meGlowMix(levels, R) {
  if (!(R > 0.05)) return [];
  const L = levels; if (R >= L[0].R) return [[L[0], 1]];
  for (let i = 0; i < L.length - 1; i++) if (R <= L[i].R && R >= L[i + 1].R) { const w = (L[i].R - R) / (L[i].R - L[i + 1].R); return [[L[i], 1 - w], [L[i + 1], w]]; }
  return [[L[L.length - 1], R / L[L.length - 1].R]];
}
function mePaintGlow(g, a, st, alpha) {
  const T = TL.TOK[a.key], img = TL.art(a.key); if (!img) return; const f = TL.feet(T), wx = T.x + st.dx * KP, wy = f.y + st.dy * KP;
  const r = (st.dx || st.dy) ? TL.depthRatio(f, { x: f.x + st.dx * KP, y: wy }) : 1, gl = meGlow(a.key, st.glowC), k = st.glowK;
  g.save(); g.translate(wx, wy - st.air * KP); if (st.rot) g.rotate(st.rot * Math.PI / 180); g.scale(T.flip * st.kx * r, st.ky * r);
  const x0 = -T.w / 2, y0 = -T.h * T.foot;
  // drop-shadow(0 0 14k px): full-strength colour behind the art, its radius shrinking with k
  if (gl) { g.globalCompositeOperation = "source-over"; for (const [lv, wgt] of meGlowMix(gl.levels, 14 * k)) { g.globalAlpha = alpha * wgt; g.drawImage(lv.c, x0 - gl.padW, y0 - gl.padW, T.w + 2 * gl.padW, T.h + 2 * gl.padW); } }
  g.globalCompositeOperation = "source-over"; g.globalAlpha = alpha; g.drawImage(img, x0, y0, T.w, T.h);
  // brightness(1 + 1.3 k) ≈ the art added on top 1.3 k times
  let extra = 1.3 * k; g.globalCompositeOperation = "lighter"; while (extra > 0.01) { g.globalAlpha = alpha * Math.min(1, extra); g.drawImage(img, x0, y0, T.w, T.h); extra -= 1; }
  g.restore(); }
// liveFilter: a CSS filter that changes every frame (flashActor's fading glow) is applied while drawing instead of baked: a bake
// per frame is a new full-size canvas each frame (a 100 ms hitch on Gunblade's transform glint, found by `move-engine parity`).
// Its px are mockup px: canvas filter lengths ignore the current transform, so they scale by KP and the transform's scale.
function mePaint(g, a, st, img, alpha, liveFilter) {
  const T = TL.TOK[a.key]; if (!img) return; const f = TL.feet(T), wx = T.x + st.dx * KP, wy = f.y + st.dy * KP;
  const r = (st.dx || st.dy) ? TL.depthRatio(f, { x: f.x + st.dx * KP, y: wy }) : 1;
  g.save();
  if (liveFilter) { let sc = 1; try { sc = Math.abs(g.getTransform().a) || 1; } catch (e) {} g.filter = liveFilter.replace(/([\d.]+)px/g, (m0, n) => (Number(n) * KP * sc).toFixed(2) + "px"); }
  g.translate(wx, wy - st.air * KP); if (st.rot) g.rotate(st.rot * Math.PI / 180); g.scale(T.flip * st.kx * r, st.ky * r); g.globalAlpha = alpha;
  g.drawImage(img, -T.w / 2, -T.h * T.foot, T.w, T.h); g.restore(); }
function meFrame(t, S) {
  // test hook (inert unless a test sets both globals): globalThis.__MOVE_SHOT_AT = [{ at, name }], __MOVE_SHOT(shot) is called at
  // the start of the first frame AFTER the one that passed `at`, while the board + overlay still show that frame
  const SA = globalThis.__MOVE_SHOT_AT;
  if (Array.isArray(SA) && typeof globalThis.__MOVE_SHOT === "function") for (const s of SA) {
    if (s.pending && !s.taken) { s.taken = true; s.frameT = s.seenT; try { globalThis.__MOVE_SHOT(s); } catch (e) { console.warn("[move-engine] shot threw", e); } }
    else if (!s.pending && t >= s.at) { s.pending = true; s.seenT = Math.round(t); } }
  REC_ON = false; IN_TW++;
  while (ME_STEP_I < STEPS.length && STEPS[ME_STEP_I].at <= t) { const s = STEPS[ME_STEP_I++]; s.o[s.k] = s.v; }
  for (const tw of TWS) { if (tw.start > t) break; const u = tw.ms > 0 ? (t - tw.start) / tw.ms : 1;
    if (u >= 1) { if (!tw.fin) { tw.fin = true; try { tw.fn(tw.ease(1)); } catch (e) {} } } else { try { tw.fn(tw.ease(Math.max(0, u))); } catch (e) {} } }
  IN_TW--;
  // actors: plain moves go through the timeline's own token painting; a filtered one (flashActor) is painted here
  for (const a of ME_ACTORS) { const st = meSnap(a), q = S.tok[a.key]; if (!q) continue;
    q.dx = st.dx * KP; q.dy = st.dy * KP; q.air = st.air * KP; q.rot = st.rot * Math.PI / 180; q.sx = st.kx; q.sy = st.ky; q.alpha = st.alpha;
    if (st.pose) q.pose = st.pose;
    if (st.glowK > 0 && st.glowC) { q.pose = "blank"; const ra = meRaw(a); S.world.push({ z: 20, draw: (g) => mePaintGlow(g, ra, st, st.alpha) }); }
    else if (st.filter) { q.pose = "blank"; const ra = meRaw(a); S.world.push({ z: 20, draw: (g) => mePaint(g, ra, st, meArt(ra.key, st.pose), st.alpha, st.filter) }); } }
  // sprite props (1.3.0): alive between their creation and remove(); the mockup's z-index decides above / below the battlers
  const props = ME_PROPS.filter((e) => t >= e.t0 && !e.raw.dead);
  if (props.length) { const capZ = Math.round(OY(meRaw(CASTER)));
    const under = props.filter((e) => e.raw.under), back = props.filter((e) => !e.raw.under && e.raw.z < capZ), front = props.filter((e) => !e.raw.under && e.raw.z >= capZ);
    const byZ = (L) => L.slice().sort((a, b) => a.raw.z - b.raw.z || a.t0 - b.t0);
    if (under.length) S.world.push({ z: 3.5, draw: (g) => { for (const e of byZ(under)) mePaintProp(g, e.raw); } });
    if (back.length) S.world.push({ z: 19.5, draw: (g) => { for (const e of byZ(back)) mePaintProp(g, e.raw); } });
    if (front.length) S.world.push({ z: 21, draw: (g) => { for (const e of byZ(front)) mePaintProp(g, e.raw); } }); }
  // the camera (cfg.camera): FCAM's focus point in mockup px → world, relative to the rest view
  if (ME_CAM) { const f = toW({ x: FCAM.x, y: FCAM.y }), c0 = toW({ x: W / 2, y: H / 2 }); S.cam = { cx: TL.REST.cx + (f.x - c0.x), cy: TL.REST.cy + (f.y - c0.y), zoom: FCAM.z }; }
  // afterimages (pose read the first frame they show)
  const live = ME_AFTER.filter((x) => t >= x.t0 && t < x.t0 + x.ms);
  if (live.length) { for (const x of live) if (!x.snap) x.snap = meSnap(x.a);
    S.world.push({ z: 19, draw: (g) => { for (const x of live) mePaint(g, x.a, x.snap, meBaked(x.a.key, x.filter, x.snap.pose), x.op * (1 - EASE.sine((t - x.t0) / x.ms)) * x.snap.alpha); } }); }
  // particles: their own draw code, in mockup px
  const dt0 = t - ME_LAST_T; ME_LAST_T = t;
  const byLayer = {};
  for (const e of ME_PARTS) { if (t < e.t0 || e.dead) continue; const p = e.p; const dt = Math.min(50, e.seen ? dt0 : t - e.t0); e.seen = true; p.t += dt;
    if (p.t >= p.life || p.dead) { e.dead = true; continue; } meStepParticle(p, dt); (byLayer[e.layer] = byLayer[e.layer] || []).push(p); }
  for (const L in byLayer) { const list = byLayer[L];
    if (L === "screen") { S.screen.push({ draw: (g) => { const k = g.H / H; g.save(); g.translate((g.W - W * k) / 2, 0); g.scale(k, k); for (const p of list) { g.save(); g.globalCompositeOperation = p.comp || "lighter"; p.draw(g, p, p.t / p.life); g.restore(); } g.restore(); } }); continue; }
    S.world.push({ z: ME_LAYER_Z[L] || 30, draw: (g) => { g.save(); g.translate(ORG.x, ORG.y); g.scale(KP, KP); for (const p of list) { g.save(); g.globalCompositeOperation = p.comp || "lighter"; p.draw(g, p, p.t / p.life); g.restore(); } g.restore(); } }); }
  // screen state
  if (SCR.white > S.flash.a) S.flash = { a: SCR.white, c: "#ffffff" };
  if (SCR.black > 0) S.black = Math.max(S.black, SCR.black);
  if (SCR.dim > 0 && SCR.dim > S.dim) { S.dim = SCR.dim; const h = String(SCR.dimC || "#000").replace("#", ""); const hx = h.length === 3 ? h.split("").map((c) => c + c).join("") : h; S.dimRGB = [0, 2, 4].map((i) => parseInt(hx.slice(i, i + 2), 16) || 0).join(","); }
  if (SCR.rumble) S.shake = Math.max(S.shake, SCR.rumble * KP);
}
let ME_STEP_I = 0, ME_LAST_T = 0;

// ───────── run a move: dry run, then play it on the board
// opts: { tune: { key: value } } (approved slider values), { beats: [indexes to skip] }
// opts.byForm: [move for form 0, move for form 1, …] — picks by the caster's weapon form (one script for a form weapon)
// opts.variantTune: { variant: { key: value } } — tune by the play_animation row's #variant (Gunblade: Transform#gun)
async function MOVE_PLAY(key, opts = {}) {
  if (Array.isArray(opts.byForm) && opts.byForm.length) { const f = meWeaponForm(); key = opts.byForm[Math.min(f, opts.byForm.length - 1)] || key; }
  if (opts.byVariant && moveVariant() && opts.byVariant[moveVariant()]) key = opts.byVariant[moveVariant()];
  await Promise.all(ME_PRELOAD);
  const spec = SK[key]; if (!spec) { console.error("[move-engine] no move", key); oni.fireDone(); return; }
  const C = { cfg: {} }; for (const t of spec.tune || []) C.cfg[t.k] = t.v; Object.assign(C.cfg, (opts.tune && opts.tune[key]) || opts.tune || ME_CFG.tune || {});
  const vt = opts.variantTune && moveVariant() && opts.variantTune[moveVariant()]; if (vt) Object.assign(C.cfg, vt);
  const sk0 = opts.skip || ME_CFG.skip || []; const skip = new Set(Array.isArray(sk0) ? sk0 : (sk0[key] || []));   // skip: [beat i] or { moveKey: [beat i] }
  // snapshot of the initial state, restored before playback (the dry run leaves the end state)
  const init = ME_ACTORS.map((a) => { const r = meRaw(a); return [r, Object.assign({}, r), Object.assign({}, meRaw(r.el.style)), Object.assign({}, meRaw(r.media.style))]; });
  const initScr = Object.assign({}, meRaw(SCR));
  TRACE.on = !!(ME_CFG.trace || globalThis.__MOVE_TRACE_ON); TRACE.now = () => VT; traceReset(meRaw(CASTER)); moveSeed(ME_CFG.seed);
  PHASE = "dry"; REC_ON = true; VT = 0;
  const t0 = performance.now();
  const end = await meDrive(async () => { for (let i = 0; i < spec.beats.length; i++) { if (skip.has(i)) continue; const b = spec.beats[i]; BEAT = i; traceEv("beat", { i, name: b.name }); await b.run(C); } traceEv("end"); });
  const dryMs = Math.round(performance.now() - t0);
  REC_ON = false; PHASE = "play";
  for (const [r, v, es, ms] of init) { for (const k of Object.keys(r)) if (!(k in v)) delete r[k]; Object.assign(r, v); Object.assign(meRaw(r.el.style), es); Object.assign(meRaw(r.media.style), ms); }
  Object.assign(meRaw(SCR), initScr);
  for (const tw of TWS) tw.fin = false;
  for (const e of ME_PROPS) Object.assign(e.raw, e.init);   // props back to their creation state (steps + tweens replay the rest)
  if (ME_CAM) Object.assign(meRaw(FCAM), { x: W / 2, y: H / 2, z: 1, r: 0 });
  let total = end;
  for (const tw of TWS) total = Math.max(total, tw.start + tw.ms);
  for (const e of ME_PARTS) if (e.p.life < 1e8) total = Math.max(total, e.t0 + e.p.life);
  for (const x of ME_AFTER) total = Math.max(total, x.t0 + x.ms);
  for (const tr of TRK) if (tr.clip && tr.t1 < 1e8) total = Math.max(total, tr.t1);
  total = Math.min(total + (ME_CFG.tailMs || 0), end + 4000);
  ME_GATE = ME_FIRST_HIT != null ? ME_FIRST_HIT : ME_MARK != null ? ME_MARK : end;
  const report = { key, engine: MOVE_ENGINE_VERSION, host: MOVE_HOST, dryMs, end, total, gate: ME_GATE, markGate: ME_MARK, firstHit: ME_FIRST_HIT, variant: moveVariant(), result: moveResult(moveTarget()), events: TRACE.list.length, trace: TRACE.list, warnings: [...ME_WARN] };
  globalThis.__MOVE_LAST = report; if (Array.isArray(globalThis.__MOVE_RUNS)) globalThis.__MOVE_RUNS.push(report);   // tests collect every run
  if (ME_CFG.dryOnly) { oni.fireDone(); return report; }
  // the glows this move uses, rendered now (before frame 0) so playback never renders one
  await meLoadProps();
  for (const id of ME_GLOWS) { const i = id.indexOf("|"); meGlow(id.slice(0, i), id.slice(i + 1)); }
  TM.hold(0, total, (t, S) => meFrame(t, S));
  for (const o of ME_ONCE) { let did = false; TRK.push({ t0: o.at, t1: 1e9, fn: () => { if (did) return; did = true; try { o.fn(); } catch (e) { console.warn("[move-engine] cue threw", e); } } }); }
  { let did = false; TRK.push({ t0: ME_GATE, t1: 1e9, fn: () => { if (did) return; did = true;
    if (ME_NUM_AT.size && typeof oni.impactOffsets === "function") { const map = {}; for (const [u, at] of ME_NUM_AT) map[u] = Math.max(0, Math.round(at - ME_GATE)); try { oni.impactOffsets(map); } catch (e) {} }
    oni.fireDone(); } }); }
  const wall0 = performance.now();
  try { await TL.run(TRK, { total, sfx: ME_SFX, onStart: () => { report.wall0 = performance.now(); const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } }); }
  finally { for (const f of ME_CLEANUP) { try { f(); } catch (e) {} } }
  report.wallMs = Math.round(performance.now() - wall0);
  oni.fireDone();
  return report;
}
