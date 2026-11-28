// ═════════ Deva (Valley elite, Strike vs Magic) — family head (move-engine). Ported 2026-11-28 from the Deva animation
// mockup v16 (artifact C7wZxC2jSAo15AAsJfQxRb, built on the old private Zero Power engine copy) onto move-engine.
// Actors come from the host: Deva = moveCaster() (the page: ACT.deva; the game: the action's caster). Party targets:
// PARTY / moveTarget(i). The Missile Fists are the page's ACT.fistA / ACT.fistB (in the game: the fist token casting).
// NOT game-clean yet: the energy fists / barrage fists are sprite() props, and the fuse pips, the crack overlay, the
// "Shaken" style status tags and the Enlightenment stack read are page DOM stand-ins (move-engine.js check lists them).
const GROUPS = { guard: "Guard round", fist: "Missile Fist", offense: "Offense round", strike: "Strike Form · Fury", magic: "Magic Form · Focus", shipped: "Barrages · in game, v20 tuning" };
const IN_GAME = typeof TARGETS !== "undefined";
// game host only: the caster's actor (a Missile Fist casting its own Detonate / Fuse break, else Deva) and the form she holds
const DV_GAME_ACTOR = IN_GAME ? (ctx.casterToken && ctx.casterToken.actor) || null : null;
const DV_IS_FIST = !!(DV_GAME_ACTOR && /missile fist/i.test(DV_GAME_ACTOR.name || ""));
const devaFormNow = () => { if (!DV_GAME_ACTOR) return "std"; const has = (n) => DV_GAME_ACTOR.effects.some((e) => !e.disabled && e.name === n); return has("Magic Form") ? "focus" : has("Strike Form") ? "fury" : "std"; };
// Enlightenment's starting form: the page's select; in the game the form she holds when it plays
const devaFrom = (C) => (IN_GAME ? (devaFormNow() === "focus" ? 1 : 0) : tv(C, "from"));
const DV = () => moveCaster();
const DEVA_TARGETS = () => (IN_GAME ? TARGETS : PARTY);
const RED = "255,74,58", BLUE = "58,168,255", VIOLET = "176,140,255";   // GOLD comes from shared/fx-melee.js
DN_COLOR.mp = "#6fa8ff";
// the Guard stance read on her sprite (stand-in for the stance VFX filter the game still owes)
const STANCE = { vajra: "drop-shadow(0 0 1px #ffe28a) drop-shadow(0 0 7px #e6c25a) brightness(1.1)", maya: "drop-shadow(0 0 1px #d9c8ff) drop-shadow(0 0 7px #8f8cff) brightness(1.1)" };
const STANCES = ["vajra", "maya"];
const DEVA_STATE = { stance: "vajra", form: "std" };
const PC_MP = { hina: 116, zarg: 81, keren: 111, blanche: 76 };
// afterimage hue per state (shared afterimage(): sepia + hue-rotate(hue - 38))
const devaHue = () => DEVA_STATE.form === "fury" ? 8 : DEVA_STATE.form === "focus" ? 223 : DEVA_STATE.stance === "vajra" ? 43 : 243;
function applyStance() { const D = DV(); if (!D || !D.media) return; if (IN_GAME) { D.media.style.filter = ""; return; } D.media.style.filter = (DEVA_STATE.form === "std" ? STANCE[DEVA_STATE.stance] + " " : "") + "drop-shadow(0 4px 3px rgba(0,0,0,.35))"; }
// The three idle clips share one 307 x 283 canvas (Beastiary/Deva_Battle_Idle, Deva/Deva_Fury_Battle_Idle, Deva/Deva_Focus_Battle_Idle),
// so a form change is a plain art swap at the same size. Game: the token's art swap (battler-pose), not swapArt.
const FORM_ART = { std: "deva", fury: "deva_fury", focus: "deva_focus" };
function setForm(form) { const D = DV(); DEVA_STATE.form = form; if (IN_GAME) { D.pose = form; applyStance(); return; } const src = M.sprites[FORM_ART[form]];
  if (D.media && src && D.media.getAttribute("src") !== src) { D.media.src = src; D.media.loop = true; D.media.play && D.media.play().catch(() => {}); }
  applyStance(); }
const formRgb = (form) => form === "focus" ? BLUE : RED;
const inForm = (form) => ({ name: form === "fury" ? "In Fury form" : "In Focus form", note: "Offense round, arms and halo up", run: async () => { setForm(form); await wait(400); } });
const rollHit = (p = .65, t = null) => { const r = MOVE_RNG() < p; if (IN_GAME && t) { const m = moveResult(t); if (m) return m.hit; } return r; };
const handPt = (side = 1) => { const D = DV(); return { x: OX(D) + side * wid(D) * .42, y: OY(D) - hgt(D) * .55 }; };
const mix = (a, b, t) => { const A = a.split(",").map(Number), B = b.split(",").map(Number); return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], t))).join(",")})`; };

// ───────── shared pieces
function hitFx(t, dmg, element, { tier = "normal", clipKey = "001_hit_physical", scale = 1, filter = "" } = {}) {
  if (IN_GAME) { const m = moveResult(t); if (m && !m.hit) return missFx(t); }
  clip(clipKey, center(t), { scale: t.s * scale, filter }); dmgNum(t.id, numAt(t), dmg, { element }); hitReact(t, tier); }
function missFx(t) { sfx("miss", .5); statusTag(t, "Miss", "220,220,220"); slide(t, -face(t) * 22, 160).then(() => slide(t, 0, 300, 0)).catch(() => {}); }
const mpFx = (t, n) => { if (n > 0) dmgNum(t.id + "mp", () => { const p = numAt(t)(); return { x: p.x + 26, y: p.y + 22 }; }, n, { element: "mp" }); };
function motes(from, to, rgb, n = 10, ms = 800) { for (let k = 0; k < n; k++) homing("field", { x: from.x + rnd(-14, 14), y: from.y + rnd(-14, 14) }, to, rgb, { ms, arc: 70, r: 3 }); }
// stand-in for Battle Director's own status display (the real script draws no text)
function statusTag(t, text, rgb) { if (FAST || IN_GAME) return; const p = FCAM.screen(head(t)); const n = document.createElement("div");
  Object.assign(n.style, { position: "absolute", left: p.x + "px", top: (p.y - 6) + "px", transform: "translate(-50%,-100%)", font: "700 15px Signika, sans-serif", color: `rgb(${rgb})`,
    letterSpacing: ".06em", textShadow: "0 2px 0 #000, 0 0 6px #000", whiteSpace: "nowrap", zIndex: 61, opacity: 0 });
  DNL.appendChild(n); n.textContent = text;
  tween(1500, EASE.lin, (u) => { n.style.opacity = u < .15 ? u / .15 : u > .75 ? (1 - u) / .25 : 1; n.style.top = (p.y - 6 - 18 * u) + "px"; }).catch(() => {}).then(() => n.remove()); }

// an energy fist prop (Vajra Fist, Mudra hand, Kala, the barrage). The art points DOWN; rot = travel angle (deg) - 90.
const FIST_TINT = { red: "", blue: "", gold: "sepia(1) saturate(5) hue-rotate(5deg) brightness(1.25)", violet: "hue-rotate(250deg) saturate(1.3) brightness(1.15)" };
function energyFist(color, x, y, h = 96, rot = -30, parent = $("factors")) {
  const src = color === "blue" ? M.sprites.fist_blue : M.sprites.fist; const rgb = color === "blue" ? BLUE : color === "gold" ? GOLD : color === "violet" ? VIOLET : RED;
  const f = sprite(src, parent, { x, y, h, z: Math.round(y) + 2, filter: `${FIST_TINT[color]} saturate(1.4) drop-shadow(0 0 4px rgba(${rgb},1)) drop-shadow(0 0 1px #fff)` });
  f.rot = rot; f.rgb = rgb; f.apply(); return f; }
const grow = (f, ms = 380) => tween(ms, EASE.outBack, (t) => { f.sx = f.sy = t; f.apply(); });
const propPt = (f) => ({ x: f.x + f.ox, y: f.y + f.oy - f.h * .5 });
const dissolve = (f, ms = 420) => { for (let k = 0; k < 10; k++) dust("field", f.x + rnd(-20, 20), f.y - f.h * rnd(.2, .8), f.rgb, { life: 700 }); return f.fade(0, ms).then(() => f.remove()); };
async function punch(f, t, ms) { const p0 = { x: f.x, y: f.y }, q = center(t), ang = Math.atan2(q.y - (p0.y - f.h / 2), q.x - p0.x) * 180 / Math.PI - 90, r0 = f.rot;
  await tween(ms, EASE.inCubic, (u) => { f.x = lerp(p0.x, q.x, u); f.y = lerp(p0.y, q.y + f.h * .5, u); f.rot = lerp(r0, ang, Math.min(1, u * 2)); f.z = Math.round(f.y) + 2; f.apply();
    if (Math.random() < .6) dust("field", f.x, f.y - f.h * .5, f.rgb, { life: 260, r: rndFx(2, 4) }); }); }

// ───────── the Missile Fists: three summoned actors (two until 2026-11-28) on the enemy side (page: ACT.fistA / ACT.fistB, in-game token scale 1).
// Token art = fist_red.png turned 90° counter-clockwise (points RIGHT at the party, fingers over the top), no mirror,
// with an idle float bob. In the game BD mirrors enemy tokens, so the shipped token art must point LEFT to read the same.
const FISTS = () => (IN_GAME ? (DV_IS_FIST ? [CASTER] : TARGETS) : [ACT.fistA, ACT.fistB, ACT.fistC].filter(Boolean));
const FIST_BOB = { on: false, t0: 0 };
function fistsShow(on) { if (IN_GAME) { for (const f of FISTS()) f.el.style.opacity = on ? 1 : 0; return; } for (const f of FISTS()) { f.el.style.display = on ? "" : "none"; f.flip = f.baseFlip = 1; f.gone = !on; setPos(f, f.dx, f.dy); } }
function fistBobLoop() { if (IN_GAME) return; const step = (now) => { if (FIST_BOB.on) for (const f of FISTS()) if (!f.gone && f.bob !== false) { f.lift = Math.sin((now - FIST_BOB.t0) / 520 + f.i * 1.7) * 6 + 6; setPos(f, f.dx, f.dy); }
  requestAnimationFrame(step); }; requestAnimationFrame(step); }
const fistPt = (f) => ({ x: OX(f), y: OY(f) - (f.lift || 0) - hgt(f) * .5 });
const fistAt = (f) => () => FCAM.screen({ x: OX(f), y: OY(f) - (f.lift || 0) - hgt(f) * .8 });
// fuse pips under the fist + a crack layer over it (page stand-ins: the summon's countdown display does not exist yet)
function fistDeco(f) { if (IN_GAME || f.pips) return;
  const pips = document.createElement("div"); Object.assign(pips.style, { position: "absolute", left: "50%", bottom: "-16px", transform: "translateX(-50%)", display: "flex", gap: "5px", pointerEvents: "none" });
  for (let k = 0; k < 2; k++) { const p = document.createElement("i"); Object.assign(p.style, { width: "9px", height: "9px", borderRadius: "50%", background: `rgb(${RED})`, boxShadow: `0 0 8px rgba(${RED},1)`, display: "block", opacity: 0 }); pips.appendChild(p); }
  f.el.appendChild(pips); f.pips = [...pips.children];
  const cv = document.createElement("canvas"); cv.width = 160; cv.height = 110; Object.assign(cv.style, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" });
  f.body.appendChild(cv); f.cracks = cv; }
function fistReset() { if (IN_GAME) return; FISTS().forEach((f, i) => { fistDeco(f); f.i = i; f.hits = 0; f.bob = true; f.pips.forEach((p) => { p.style.opacity = 0; p.style.transform = ""; });
  f.cracks.getContext("2d").clearRect(0, 0, 160, 110); f.kx = f.ky = 1; f.rot = 0; f.el.style.opacity = 1; f.media.style.filter = `saturate(1.5) contrast(1.15) drop-shadow(0 0 3px rgba(${RED},1)) drop-shadow(0 0 1px #fff)`; }); }
function drawCracks(f) { if (!f.cracks) return; const c = f.cracks.getContext("2d"); c.clearRect(0, 0, 160, 110); c.strokeStyle = "rgba(255,245,220,.95)"; c.lineWidth = 2.2; c.shadowColor = `rgba(${RED},1)`; c.shadowBlur = 6;
  const seeds = [[80, 52], [110, 40], [120, 70], [64, 66]]; for (let k = 0; k < f.hits * 2; k++) { const [sx, sy] = seeds[k % seeds.length]; let x = sx, y = sy; c.beginPath(); c.moveTo(x, y);
    for (let s = 0; s < 5; s++) { x += rnd(-16, 16); y += rnd(-12, 12); c.lineTo(x, y); } c.stroke(); } }

// ───────── the comedic spin (Double Slap): the target's own 8-direction walk sprites (down → down-left → up-left → up-right →
// down-right → down), mirrored for the right-hand side; no directional art → a Paper Mario flip through its own width.
const SPIN_DIRS = [["walkd", 1], ["walkdl", 1], ["walkul", 1], ["walkul", -1], ["walkdl", -1], ["walkd", 1]];
const hasDirs = (t) => (IN_GAME ? !!(TL.POSE[meRaw(t).key] && TL.POSE[meRaw(t).key].walkdl) : !!(M.sprites && M.sprites[`pose_${t.id}_walkdl`]));
async function spin(t, C) {
  const turns = tv(C, "spinTurns"), step0 = tv(C, "spinStep"), hop = tv(C, "spinHop");
  const style = tv(C, "spin") === 0 && hasDirs(t) ? "dirs" : "flip";
  const m = t.media, idle = t.src, base = t.baseFlip || 1; const lift = (u) => -Math.sin(Math.min(1, u) * Math.PI) * hop;
  if (FAST) return;
  if (style === "dirs") {
    const frames = []; for (let i = 0; i < turns; i++) frames.push(...SPIN_DIRS.slice(0, 5)); frames.push(SPIN_DIRS[5]);
    m.loop = true;
    for (let i = 0; i < frames.length; i++) {
      const [pose, flip] = frames[i];
      if (IN_GAME) t.pose = pose; else { const src = M.sprites[`pose_${t.id}_${pose}`]; if (m.getAttribute("src") !== src) { m.src = src; m.play().catch(() => {}); } }
      t.flip = base * flip; const u = i / (frames.length - 1); setPos(t, t.dx, t.dy, lift(u));
      await wait(step0 * (1 + 1.6 * u * u));   // fast, then winding down
    }
  } else {
    const ms = turns * step0 * 6 * 1.5;
    await tween(ms, EASE.outCubic, (u) => { let k = Math.cos(u * turns * Math.PI * 2); if (Math.abs(k) < .08) k = .08 * Math.sign(k || 1); t.flip = base * k; setPos(t, t.dx, t.dy, lift(u)); });
  }
  t.flip = base; setPos(t, t.dx, t.dy, 0); if (IN_GAME) { t.pose = null; return; } m.src = idle; m.loop = true; m.play().catch(() => {});
}
const wobble = (t, ms = 520) => tween(ms, EASE.lin, (u) => { t.rot = Math.sin(u * Math.PI * 3) * 6 * (1 - u); setPos(t, t.dx, t.dy); }).then(() => { t.rot = 0; setPos(t, t.dx, t.dy); });

// ───────── Enlightenment's orb, on the field particle canvas (no DOM): a red / blue yin-yang that spins and trades halves
function yinYang(ctx, r, rot, colA, colB, glowA) {
  ctx.save(); ctx.rotate(rot); ctx.shadowColor = `rgba(255,255,255,${glowA})`; ctx.shadowBlur = r * .6;
  ctx.fillStyle = colA; ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2); ctx.fill();
  ctx.fillStyle = colB; ctx.beginPath(); ctx.arc(0, 0, r, Math.PI / 2, Math.PI * 1.5); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = colA; ctx.beginPath(); ctx.arc(0, r / 2, r / 2, 0, 7); ctx.fill();
  ctx.fillStyle = colB; ctx.beginPath(); ctx.arc(0, -r / 2, r / 2, 0, 7); ctx.fill();
  ctx.fillStyle = colB; ctx.beginPath(); ctx.arc(0, r / 2, r / 7, 0, 7); ctx.fill();
  ctx.fillStyle = colA; ctx.beginPath(); ctx.arc(0, -r / 2, r / 7, 0, 7); ctx.fill();
  ctx.strokeStyle = "rgba(255,240,210,.85)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke(); ctx.restore(); }
function makeOrb(C) { const D = DV(), R = tv(C, "orb"); const o = { p: { x: OX(D), y: OY(D) - (D.lift || 0) - hgt(D) - R * 1.2 }, R, rot: 0, scale: 0, swap: 0, glow: .6, dead: false };
  addP("field", { x: o.p.x, y: o.p.y, life: 1e9, update: (p) => { if (o.dead) p.dead = true; },
    draw: (c) => { if (o.scale <= 0) return; c.globalCompositeOperation = "source-over"; c.translate(o.p.x, o.p.y); c.scale(o.scale, o.scale);
      glow(c, 0, 0, R * 1.5, GOLD, .25 * o.glow); yinYang(c, R, o.rot, mix(RED, BLUE, o.swap), mix(BLUE, RED, o.swap), o.glow); } });
  o.remove = () => { o.dead = true; }; return o; }

// ───────── Enlightenment v18 pieces (page stand-ins: the radiance is a CSS filter on her sprite, the burst copies are
// sprite() props; the game version owes a token filter + battler copies, like the other DOM pieces above)
const RADIANT = "255,236,170";
// her body glow, k = 0 (none) .. 1 (full radiance); stacks on top of the form's own filter
function devaGlow(k, rgb = RADIANT) { const D = DV(); if (!D || !D.media) return; if (k <= 0) return applyStance();
  D.media.style.filter = `brightness(${1 + .9 * k}) saturate(${1 - .35 * k}) drop-shadow(0 0 ${2 + 4 * k}px #fff) drop-shadow(0 0 ${8 + 22 * k}px rgba(${rgb},${.4 + .6 * k})) drop-shadow(0 4px 3px rgba(0,0,0,.35))`; }
// copies of her new form bursting outward from her body: each flies off on its own ray, swells and fades
// prepBurst makes the copies hidden ahead of time (a fresh <video> needs a moment to decode its first frame), formBurst flies them
function prepBurst(form, n = 6) {
  if (FAST) return null; const D = DV(), x0 = OX(D), y0 = OY(D) - (D.lift || 0), h = hgt(D), rgb = formRgb(form), hue = form === "focus" ? 223 : 8;
  // a bright copy in the new form's colour that keeps her detail (greyscale → lifted → tinted), glowing on the dark field
  return Array.from({ length: n }, () => sprite(M.sprites[FORM_ART[form]], $("factors"), { x: x0, y: y0, h, opacity: 0, z: Math.round(OY(D)) + 1, flip: D.flip,
    filter: `grayscale(1) brightness(1.5) sepia(1) hue-rotate(${hue - 53}deg) saturate(7) brightness(1.15) drop-shadow(0 0 12px rgba(${rgb},1))` })); }
function formBurst(form, { n = 6, dist = 160, ms = 700, grow = 1.35, copies = null } = {}) {
  if (FAST) { (copies || []).forEach((g) => g.remove()); return Promise.resolve(); }
  const list = copies && copies.length === n ? copies : ((copies || []).forEach((g) => g.remove()), prepBurst(form, n));
  return Promise.all(list.map((g, k) => { const a = (k / n) * Math.PI * 2 + rnd(-.2, .2);
    return tween(ms, EASE.outCubic, (u) => { g.ox = Math.cos(a) * dist * u; g.oy = Math.sin(a) * dist * .6 * u; g.sx = g.sy = lerp(1, grow, u); g.opacity = .95 * (1 - u); g.apply(); })
      .then(() => g.remove()).catch(() => g.remove()); })); }
const partyFade = (to, ms) => Promise.all(DEVA_TARGETS().map((t) => fadeActor(t, to, ms)));

// ───────── Fists of Fury / Focus (SHIPPED v1.0.575, the v16 radial cone): the page's reference copy, as approved
// barrage fist: fades in, streaks, fades out (or holds / lingers on impact); afterimages are copies inside the same element
function barrageFist(color, from, to, C, { h, ms, z = 4000, peak = 1, trail = 3, hold = false, grow: gr = 1, linger = 0, parent, ease = EASE.lin }) {
  const f = energyFist(color, from.x, from.y, h, 0, parent); f.opacity = 0; f.z = z;
  f.m.style.filter += color === "blue" ? " brightness(1.05)" : " brightness(1.25)";
  const dir = Math.atan2(to.y - from.y, to.x - from.x); f.rot = dir * 180 / Math.PI - 90;
  for (let k = 1; k <= trail; k++) { const g = f.m.cloneNode(); Object.assign(g.style, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
    transform: `translateY(${-k * 38}%)`, opacity: String(.45 / k), pointerEvents: "none" }); f.el.appendChild(g); }
  if (IN_GAME) f.trail = trail;
  f.m.style.filter += " drop-shadow(0 0 4px #fff)"; f.apply();
  return tween(ms, ease, (u) => { f.x = lerp(from.x, to.x, u); f.y = lerp(from.y, to.y, u); f.sx = f.sy = lerp(1, gr, u);
    f.opacity = peak * Math.min(1, u / .12, hold || linger ? 1 : (1 - u) / .3); f.apply();
  }).then(() => linger ? tween(linger, EASE.out, (u) => { f.sx = f.sy = gr * (1 + .12 * u); f.opacity = peak * (1 - u); f.apply(); }) : null)
    .then(() => f.remove()).catch(() => f.remove()); }
// Guilty Gear Strive hit sparks drawn from tinted mask sheets on the "hit" canvas (no <video> per impact)
const GG_DEF = { burst01: ["ggs_burst_anim01", 2, 2, 4], burst07: ["ggs_burst_anim07", 2, 2, 4], burst05: ["ggs_burst_anim05", 5, 2, 10], spark01: ["ggs_spark_anim01", 3, 2, 6] };
const GGS = {};
function ggSheet(k, color) {
  if (typeof Image === "undefined" || !M.sprites[GG_DEF[k][0]]) return null;   // no images here (the Node dry run) or no sheet given
  const d = GGS[k] || (GGS[k] = (() => { const [src, cols, rows, frames] = GG_DEF[k]; const img = new Image(); if (IN_GAME) img.crossOrigin = "anonymous"; const ready = new Promise((r) => { img.onload = r; img.onerror = r; }); img.src = M.sprites[src]; return { img, cols, rows, frames, tint: {}, ready }; })());
  if (!d.img.complete || !d.img.naturalWidth) return null;
  if (!d.tint[color]) { const c = document.createElement("canvas"); c.width = d.img.naturalWidth; c.height = d.img.naturalHeight; const x = c.getContext("2d"); x.drawImage(d.img, 0, 0);
    if (color !== "#fff") { x.globalCompositeOperation = "multiply"; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); x.globalCompositeOperation = "destination-in"; x.drawImage(d.img, 0, 0); }
    d.tint[color] = c; }
  return d; }
if (!IN_GAME) Object.keys(GG_DEF).forEach((k) => ggSheet(k, "#fff"));
else if (M.sprites.ggs_burst_anim01) ME_PRELOAD.push(...Object.keys(GG_DEF).map((k) => { ggSheet(k, "#fff"); return GGS[k].ready; }));
function ggPlay(k, pt, { color = "#fff", size = 120, rot = 0, ms = 240, comp = "lighter", alpha = 1 } = {}) {
  if (FAST) return; const d = ggSheet(k, color); if (!d) return; const cv = d.tint[color], fw = cv.width / d.cols, fh = cv.height / d.rows;
  addP("hit", { x: pt.x, y: pt.y, life: ms, comp, draw: (c, p, t) => { const f = Math.min(d.frames - 1, Math.floor(t * d.frames));
    c.translate(p.x, p.y); c.rotate(rot); c.globalAlpha = alpha * (t > .75 ? (1 - t) / .25 : 1); const w = size, h = size * fh / fw;
    c.drawImage(cv, (f % d.cols) * fw, Math.floor(f / d.cols) * fh, fw, fh, -w / 2, -h / 2, w, h); } }); }
function ggImpact(t, dir, blue, { big = 1 } = {}) {
  if (FAST) return; const col = blue ? "#4cc8ff" : "#ff6a2a", rgb = blue ? "150,220,255" : "255,200,130", H0 = hgt(t) * big, c = center(t);
  const p = { x: c.x + rndFx(-hgt(t) * .18, hgt(t) * .12), y: c.y + rndFx(-hgt(t) * .3, hgt(t) * .25) }, spike = () => Math.random() < .5 ? "burst01" : "burst07";
  ggPlay(spike(), p, { color: col, size: H0 * rndFx(.75, 1.05), rot: dir + Math.PI / 2 + rndFx(-.5, .5), ms: 210, comp: "source-over", alpha: .95 });
  ggPlay(spike(), p, { size: H0 * rndFx(.4, .55), rot: dir + Math.PI / 2 + rndFx(-.4, .4), ms: 170 });
  if (Math.random() < .5) ggPlay("burst05", { x: p.x + Math.cos(dir) * H0 * .25, y: p.y + Math.sin(dir) * H0 * .25 }, { color: col, size: H0 * 1.15, rot: dir, ms: 300, alpha: .75 });
  if (Math.random() < .18) ggPlay("spark01", p, { size: H0 * .9, rot: rndFx(0, 6.28), ms: 260 });
  for (let k = 0; k < 5; k++) { const an = dir + rndFx(-.9, .9), sp = rndFx(.7, 1.5);
    addP("hit", { x: p.x, y: p.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, drag: .9, life: rndFx(160, 280), len: rndFx(14, 34) * big,
      draw: (cx, q, u) => { const v = Math.hypot(q.vx, q.vy) || 1; cx.strokeStyle = `rgba(${rgb},${1 - u})`; cx.lineWidth = 2.6 * (1 - u) + .6;
        cx.beginPath(); cx.moveTo(q.x, q.y); cx.lineTo(q.x - q.vx / v * q.len, q.y - q.vy / v * q.len); cx.stroke(); } }); } }
// the hurt pose held for the whole barrage, released after the closing impact
function holdHurt(t, on) { const m = t.media; if (!m || m.tagName !== "VIDEO") return; const art = hurtArt(t.id), idle = t.src; if (!art || !idle) return;
  clearTimeout(t.hurtT);
  if (on && !t.hurtHold) { t.hurtHold = true; m.loop = false; m.src = art; m.play().catch(() => {}); }
  else if (!on && t.hurtHold) { t.hurtHold = false; m.src = idle; m.loop = true; m.play().catch(() => {}); } }
// her blink: fade out while squeezing into a thin vertical line, reappear at the spot by stretching back out
async function devaBlink(a, x, y, { ms = 220, blue = false } = {}) {
  const rgb = blue ? "150,215,255" : "255,190,150", squeeze = (u) => { a.kx = lerp(1, .04, u); a.ky = lerp(1, 1.45, u); a.el.style.opacity = String(1 - u); setPos(a, a.dx, a.dy); };
  sfx("teleport", .6); shards("field", center(a), rgb, 10, .5);
  await tween(ms, EASE.in, squeeze);
  a.s = tokenScaleAt(y); a.el.style.zIndex = Math.round(y); setPos(a, x - a.x, y - a.y);
  await wait(90); shards("field", center(a), rgb, 10, .5);
  await tween(ms * 1.1, EASE.outCubic, (u) => squeeze(1 - u));
  a.kx = a.ky = 1; a.el.style.opacity = "1"; setPos(a, a.dx, a.dy); }
// every enemy rolls once; a landed target's damage is split into ticks
function rollAll(C, per, chance = .65) { const targets = DEVA_TARGETS().map((t) => ({ t, hit: rollHit(chance, t) }));
  targets.forEach((x) => { x.ticks = x.hit ? splitTicks(per, tv(C, "ticks")) : []; }); targets.filter((x) => !x.hit).forEach((x) => missFx(x.t)); return targets; }
async function focusDrainEnd(targets, per) { sfx("absorb", .6); for (const x of targets) if (x.hit) { mpFx(x.t, per * 3); motes(center(x.t), center(DV()), BLUE, 8, 800); } await wait(700); }
