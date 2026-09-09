"use strict";
//
// Rakshasa — action animations.
//
// Kept separate from dungeon-signatures.js because these are one monster's kit
// and share a private fragment library that nothing else wants. They ride the
// same `shell` / `inner` plumbing, so storage, the done-gate and the pseudo
// broadcast behave identically to every other shipped animation.
//
// ── WHY FRAGMENTS ───────────────────────────────────────────────────────────
// The Crisis combos are, by design, their two component moves played at once.
// Concatenating two finished animation bodies does NOT produce that: each one
// independently calls oni.layer(), oni.cloneToken() and oni.hideToken(), so you
// would get two host layers, two caster clones and two hide/restore pairs
// fighting each other — and duplicate `const host` / `clone` / `t` that will not
// even compile in one scope.
//
// So the shared stage is owned ONCE and the moves are phases inside it:
//   one host layer · one caster clone · one hide/restore · one done()
// Every action below is assembled from the same fragments, which is also what
// makes "a combo is its components" true in the code and not just in the design
// doc — a tuning fix to the dash reaches all six actions instead of one.
//
// ⚠ NO BACKTICKS ANYWHERE IN A FRAGMENT — not even inside a // comment. The
// inner is embedded in a String.raw`…` template by shell(), so one stray
// backtick closes the template early and breaks the outer parse. Use single
// quotes in inner comments. encode.validate() asserts the file has exactly two.

const { shell, inner } = require("./dungeon-templates.js");

// JB2A impact clips. Named here rather than in the build script because these
// are the kit's signature hits, not per-action dressing: Saber and the combo
// that contains Saber have to show the same steel, and that only holds if both
// read the URL from one place.
const JB = "modules/JB2A_DnD5e/Library/Generic/Impact/";
const FX = {
  slash:   JB + "Impact_04_Regular_Blue_400x400.webm",
  blunt:   JB + "Impact_05_Regular_Orange_400x400.webm",
  verdict: JB + "ImpactFire01_01_Regular_Orange_600x600.webm",
};

/* ── Fragments ───────────────────────────────────────────────────────────── */

// Everything the rest of the body depends on. `clone: false` for a move that
// never leaves home (the plain Chakram throw), so no clone/hide pair is created
// and nothing has to be restored.
const openStage = ({ clone = true, z = 93000 } = {}) => [
  "const host = oni.layer({ zIndex: " + z + " });",
  "const shakes = [];",
  "// Geometry, resolved once. 't' is the primary target and 'land' the point the",
  "// dash stops at — short of the target, so the clone never sits on top of it.",
  "const t = prime ? ctr(prime) : { x: home.x + 200, y: home.y };",
  "const dx = t.x - home.x, dy = t.y - home.y;",
  "const land = { x: home.x + dx * cfg.standoff, y: home.y + dy * cfg.standoff };",
  clone ? "const clone = oni.cloneToken(caster, { parent: host });" : "const clone = null;",
  clone ? "const restoreCaster = oni.hideToken(caster);" : "const restoreCaster = () => {};",
];

const dashIn = () => [
  "await oni.tween({ from: 0, to: 1, duration: cfg.lungeMs, ease: E.inOutQuad, onUpdate: (v) => {",
  "  if (clone) clone.position.set(home.x + (land.x - home.x) * v, home.y + (land.y - home.y) * v);",
  "} });",
];

const dashHome = () => [
  "await oni.tween({ from: 0, to: 1, duration: cfg.returnMs, ease: E.inOutQuad, onUpdate: (v) => {",
  "  if (clone) clone.position.set(land.x + (home.x - land.x) * v, land.y + (home.y - land.y) * v);",
  "} });",
];

// A short squash on the CLONE, so a heavy hit moves the body that threw it.
// Split out because it belongs to the weight of a blow, not to the clip: the
// flail and the Verdict both want it, the sword cut does not.
const cloneSquash = () => [
  "  if (clone) {",
  "    const sy = clone.scale.y, sx = clone.scale.x;",
  "    oni.tween({ from: 0, to: 1, duration: 260, ease: E.outQuad, onUpdate: (v) => {",
  "      const k = Math.sin(v * Math.PI);",
  "      clone.scale.set(sx * (1 + k * 0.10), sy * (1 - k * 0.12));",
  "    }, onComplete: () => { try { clone.scale.set(sx, sy); } catch (e) {} } });",
  "  }",
];

// The point of contact. One fragment for every impact in the kit — the drawn
// streaks and the expanding ring that used to live here read as placeholder
// geometry beside the rest of the shot, so both are now library clips.
//
// The size is a SCREEN length fed through S.wLen, so the clip keeps its
// apparent scale at any zoom. Its "ended" promise is parked in the shakes
// array, which closeStage already awaits, so the host layer is never torn down
// part-way through playback — the gate has already opened by then, so waiting
// the clip out costs the fight nothing.
const impactWebm = (urlKey, sizeKey, { squash = false } = {}) => [
  "{",
  "  const fx = await fxWebm(cfg." + urlKey + ", t.x, t.y, {",
  "    size: S.wLen(cfg." + sizeKey + "), parent: host, z: 96000 });",
  "  if (fx && fx.ended) shakes.push(fx.ended);",
  ...(squash ? cloneSquash() : []),
  "}",
];

const slashAt = () => impactWebm("slashWebm", "slashWebmSize");
const bluntAt = () => impactWebm("bluntWebm", "bluntWebmSize", { squash: true });

// Severing Verdict only. Sword and flail land as ONE blow there, so it shows a
// single larger clip rather than the blue-and-orange pair the other combos
// stack — the point of the shot is that it does not look like a Mace hit.
const verdictAt = () => impactWebm("verdictWebm", "verdictWebmSize", { squash: true });

const impactBurst = () => [
  "oni.particles({ x: t.x, y: t.y, count: cfg.particles, color: cfg.color,",
  "  size: cfg.particleSize, radius: S.wLen(cfg.particleRadius), life: 760,",
  "  gravity: S.wLen(40), blend: PIXI.BLEND_MODES.ADD, parent: host });",
  "shakes.push(shakeTarget(prime, cfg.shakeMs, S.wLen(cfg.shakeAmp)));",
];

// Volleys falling along a FIXED screen-space diagonal, so every arrow in every
// volley is visibly parallel. Spawn points come from S2W screen fractions read
// live: "from the top of the screen" has to mean the viewport, and a camera move
// mid-volley would otherwise rain arrows into empty map.
//
// Returns a promise array the caller awaits — the whole point of a combo is that
// this runs WHILE the melee half plays.
const arrowVolleys = () => [
  "function dropArrow(landX, landY, delayMs) {",
  "  const dirW = S.S2W(cfg.fallDx, cfg.fallDy);",
  "  const zeroW = S.S2W(0, 0);",
  "  const vx = dirW.x - zeroW.x, vy = dirW.y - zeroW.y;",
  "  const vlen = Math.hypot(vx, vy) || 1;",
  "  const ux = vx / vlen, uy = vy / vlen;",
  "  const travel = Math.abs(S.hPx(1 - cfg.originY));",
  "  const startX = landX - ux * travel, startY = landY - uy * travel;",
  "  const ang = Math.atan2(uy, ux);",
  "  const L = S.wLen(cfg.arrowLen);",
  "  const g = new PIXI.Graphics();",
  "  g.blendMode = PIXI.BLEND_MODES.ADD;",
  "  host.addChild(g);",
  "  const draw = (x, y, a) => {",
  "    g.clear();",
  "    g.lineStyle({ width: S.wLen(cfg.arrowWidth) * 2.4, color: cfg.arrowGlow, alpha: 0.35 * a, cap: 'round' });",
  "    g.moveTo(x - Math.cos(ang) * L, y - Math.sin(ang) * L); g.lineTo(x, y);",
  "    g.lineStyle({ width: S.wLen(cfg.arrowWidth), color: cfg.arrowColor, alpha: a, cap: 'round' });",
  "    g.moveTo(x - Math.cos(ang) * L, y - Math.sin(ang) * L); g.lineTo(x, y);",
  "  };",
  "  return (async () => {",
  "    if (delayMs) await wait(delayMs);",
  "    await oni.tween({ from: 0, to: 1, duration: cfg.arrowMs, ease: E.inQuad, onUpdate: (v) => {",
  "      draw(startX + (landX - startX) * v, startY + (landY - startY) * v, 1);",
  "    } });",
  "    oni.particles({ x: landX, y: landY, count: cfg.hitParticles, color: cfg.arrowColor,",
  "      size: cfg.hitSize, radius: S.wLen(cfg.hitRadius), life: 520,",
  "      blend: PIXI.BLEND_MODES.ADD, parent: host });",
  "    try { g.destroy(); } catch (e) {}",
  "  })();",
  "}",
  "async function runVolleys() {",
  "  const flights = [];",
  "  const aim = tgts.length ? centroid(tgts) : t;",
  "  for (let v = 0; v < cfg.volleys; v++) {",
  "    playSfx('sfxVolley', 'sfxVolleyVol');",
  "    for (let i = 0; i < cfg.perVolley; i++) {",
  "      const tg = tgts.length ? tgts[(v * cfg.perVolley + i) % tgts.length] : null;",
  "      const base = tg ? ctr(tg) : aim;",
  "      const jx = (Math.random() * 2 - 1) * S.wLen(cfg.spreadX * 120);",
  "      const jy = (Math.random() * 2 - 1) * S.wLen(40);",
  "      flights.push(dropArrow(base.x + jx, base.y + jy, i * cfg.arrowStaggerMs));",
  "    }",
  "    for (const tg of tgts) shakes.push(shakeTarget(tg, cfg.shakeMs, S.wLen(cfg.shakeAmp)));",
  "    if (v < cfg.volleys - 1) await wait(cfg.volleyGapMs);",
  "  }",
  "  await Promise.all(flights);",
  "}",
];

// The bouncing ring. `originExpr` is a JS expression for where it launches —
// `home` for the plain throw, `land` for the combo, where the Rakshasa is
// already in melee and the rings spin out of him. Launching from an empty home
// square during a combo would read as a second, invisible caster.
const ringFlight = (originExpr) => [
  "const ring = new PIXI.Graphics();",
  "ring.blendMode = PIXI.BLEND_MODES.ADD;",
  "host.addChild(ring);",
  "const R = S.wLen(cfg.ringRadius);",
  "let spin = 0;",
  "function drawRing(x, y) {",
  "  ring.clear();",
  "  // Squashing the vertical axis with the spin reads as a disc seen at a",
  "  // shallow angle, which is what sells 'thrown ring' over 'floating bubble'.",
  "  const sq = cfg.ringSquash + (1 - cfg.ringSquash) * Math.abs(Math.cos(spin));",
  "  ring.lineStyle({ width: S.wLen(cfg.ringWidth) * 2.2, color: cfg.ringGlow, alpha: 0.35 });",
  "  ring.drawEllipse(x, y, R, R * sq);",
  "  ring.lineStyle({ width: S.wLen(cfg.ringWidth), color: cfg.ringColor, alpha: 1 });",
  "  ring.drawEllipse(x, y, R, R * sq);",
  "}",
  "function arcPoint(a, b, v, lift) {",
  "  const x = a.x + (b.x - a.x) * v;",
  "  const y = a.y + (b.y - a.y) * v;",
  "  const d = Math.hypot(b.x - a.x, b.y - a.y);",
  "  return { x: x, y: y - Math.sin(v * Math.PI) * d * lift };",
  "}",
  "let lastTrail = 0;",
  "function trailAt(x, y) {",
  "  if (!cfg.trail) return;",
  "  const now = performance.now();",
  "  if (now - lastTrail < cfg.trailEveryMs) return;",
  "  lastTrail = now;",
  "  const g = new PIXI.Graphics();",
  "  g.blendMode = PIXI.BLEND_MODES.ADD;",
  "  g.lineStyle({ width: S.wLen(cfg.ringWidth) * 0.8, color: cfg.ringGlow, alpha: 0.5 });",
  "  g.drawEllipse(x, y, R * 0.9, R * 0.9 * cfg.ringSquash);",
  "  host.addChild(g);",
  "  oni.tween({ from: 0.5, to: 0, duration: cfg.trailLife, ease: E.linear,",
  "    onUpdate: (v) => { g.alpha = v; }, onComplete: () => { try { g.destroy(); } catch (e) {} } });",
  "}",
  "async function flyRing(a, b, ms) {",
  "  await oni.tween({ from: 0, to: 1, duration: ms, ease: E.inOutQuad, onUpdate: (v) => {",
  "    spin += 0.35;",
  "    const p = arcPoint(a, b, v, cfg.arc);",
  "    drawRing(p.x, p.y);",
  "    trailAt(p.x, p.y);",
  "  } });",
  "}",
  "async function runRing() {",
  "  const origin = " + originExpr + ";",
  "  drawRing(origin.x, origin.y);",
  "  const hops = tgts.slice(0, 3);",
  "  let from = { x: origin.x, y: origin.y };",
  "  for (let i = 0; i < hops.length; i++) {",
  "    const c = ctr(hops[i]);",
  "    await flyRing(from, c, i === 0 ? cfg.outMs : cfg.betweenMs);",
  "    playSfx('sfxHit', 'sfxHitVol');",
  "    oni.particles({ x: c.x, y: c.y, count: cfg.hitParticles, color: cfg.ringColor,",
  "      size: cfg.hitSize, radius: S.wLen(cfg.hitRadius), life: 620,",
  "      blend: PIXI.BLEND_MODES.ADD, parent: host });",
  "    shakes.push(shakeTarget(hops[i], cfg.shakeMs, S.wLen(cfg.shakeAmp)));",
  "    from = c;",
  "  }",
  "  await flyRing(from, { x: origin.x, y: origin.y }, cfg.backMs);",
  "  try { ring.destroy(); } catch (e) {}",
  "}",
];

const closeStage = () => [
  "restoreCaster();",
  "await Promise.all(shakes);",
  "done();",
];

/* ── Shared cfg defaults ─────────────────────────────────────────────────── */
// One table so a combo inherits the same numbers its components use; a shot that
// never touches a given fragment simply ignores that fragment's keys.
const BASE = {
  standoff: 0.62,
  color: 0xffe9c4, particles: 20, particleRadius: 120, particleSize: 11,
  shakeMs: 460, shakeAmp: 9,
  lungeMs: 400, holdMs: 110, returnMs: 500,
  // Impact clips. ringColor/ringWidth stay because ringFlight still draws the
  // thrown chakram itself — only the IMPACTS became library clips.
  slashWebm: FX.slash, slashWebmSize: 300,
  bluntWebm: FX.blunt, bluntWebmSize: 330,
  ringColor: 0xffd9a0, ringWidth: 7,
  ringGlow: 0x6fd8ff, ringRadius: 34, ringSquash: 0.42,
  outMs: 420, betweenMs: 300, backMs: 480, arc: 0.18,
  trail: true, trailEveryMs: 28, trailLife: 260,
  hitParticles: 14, hitRadius: 90, hitSize: 9,
  volleys: 4, perVolley: 7, volleyGapMs: 260, arrowMs: 420, arrowStaggerMs: 45,
  arrowLen: 46, arrowWidth: 3, arrowColor: 0xffe6b0, arrowGlow: 0xffb347,
  fallDx: 0.26, fallDy: 1.15, spreadX: 0.55, originY: -0.12,
  totalTimeoutMs: 14000,
};
const mk = (extra, opts) => Object.assign({}, BASE, extra, opts.cfg || {});
const build = (opts, cfg, lines) =>
  shell({ key: opts.key, name: opts.name, cfg, inner: inner(lines.join("\n")) });

/* ── Singles ─────────────────────────────────────────────────────────────── */

// Saber and Mace: dash in, strike, dash home. Same shot, different impact.
function dashStrike(opts = {}) {
  const cfg = mk({ impact: "slash", donePhase: "impact" }, opts);
  return build(opts, cfg, [
    "if (!caster || !prime) { done(); return; }",
    ...openStage(),
    "playSfx('sfx', 'sfxVol');",
    ...dashIn(),
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "if (cfg.impact === 'blunt') {",
    ...bluntAt(),
    "} else {",
    ...slashAt(),
    "}",
    ...impactBurst(),
    "// Damage lands on the hit, not after the walk home.",
    "if (cfg.donePhase === 'impact') done();",
    "await wait(cfg.holdMs);",
    ...dashHome(),
    ...closeStage(),
  ]);
}

// Chakram: a pure throw, no dash — the ring leaves from home and returns there.
function chakramBounce(opts = {}) {
  const cfg = mk({}, opts);
  return build(opts, cfg, [
    "if (!caster || !tgts.length) { done(); return; }",
    ...openStage({ clone: false }),
    "playSfx('sfxThrow', 'sfxThrowVol');",
    ...ringFlight("home"),
    "await runRing();",
    "done();",
    ...closeStage(),
  ]);
}

// Rain of Arrows: step forward, then volleys. Overflow is one check for the
// whole line, so damage lands once, after the last arrow comes down.
function arrowRain(opts = {}) {
  const cfg = mk({ standoff: 0.16, lungeMs: 320, returnMs: 460 }, opts);
  return build(opts, cfg, [
    "if (!caster) { done(); return; }",
    ...openStage(),
    "playSfx('sfxDraw', 'sfxDrawVol');",
    ...dashIn(),
    ...arrowVolleys(),
    "await runVolleys();",
    "done();",
    ...dashHome(),
    ...closeStage(),
  ]);
}

/* ── Crisis combos ───────────────────────────────────────────────────────── */
//
// A combo is its two components playing AT ONCE, not one after the other. Each
// starts its ranged half without awaiting it, plays the melee half over the top,
// and only then awaits both — so the two overlap instead of queueing, and the
// whole shot stays near the length of a single.

// Sword + Bow. Dash in and cut the primary while arrows fall across the line.
// No origin conflict: the arrows come from off-screen, so the caster being in
// melee does not fight the volley.
function comboVolley(opts = {}) {
  const cfg = mk({ lungeMs: 360, volleys: 3, perVolley: 6 }, opts);
  return build(opts, cfg, [
    "if (!caster) { done(); return; }",
    ...openStage(),
    "playSfx('sfx', 'sfxVol');",
    ...arrowVolleys(),
    "// Volleys start NOW and run under everything below.",
    "const volleying = runVolleys();",
    ...dashIn(),
    "playSfx('sfxImpact', 'sfxImpactVol');",
    ...slashAt(),
    ...impactBurst(),
    "await wait(cfg.holdMs);",
    ...dashHome(),
    "// Overflow is ONE check for the whole line, so damage lands once — after",
    "// the last arrow, not on the melee cut, which is early and cosmetic here.",
    "await volleying;",
    "done();",
    ...closeStage(),
  ]);
}

// Flail + Throwing. Dash in, blunt impact, and the rings spinning out of the
// LANDED position — he is in melee, so launching from an empty home square
// would read as a second, invisible caster.
function comboOrbit(opts = {}) {
  const cfg = mk({ lungeMs: 380, outMs: 360, betweenMs: 280, backMs: 420 }, opts);
  return build(opts, cfg, [
    "if (!caster || !tgts.length) { done(); return; }",
    ...openStage(),
    "playSfx('sfx', 'sfxVol');",
    ...dashIn(),
    "playSfx('sfxImpact', 'sfxImpactVol');",
    ...ringFlight("land"),
    "const ringing = runRing();",
    ...bluntAt(),
    ...impactBurst(),
    "// Every target has to have been struck before damage lands.",
    "await ringing;",
    "done();",
    "await wait(cfg.holdMs);",
    ...dashHome(),
    ...closeStage(),
  ]);
}

// Sword + Flail. Both impacts on the SAME target on the same frame, with weight
// the other two do not get: this is the ~166 kill, and it must not look like an
// ordinary Mace hit.
function comboVerdict(opts = {}) {
  const cfg = mk({
    lungeMs: 420, holdMs: 220, returnMs: 520,
    // Roughly twice the single-weapon clips, which is the whole read: one blow,
    // bigger than either weapon lands on its own.
    verdictWebm: FX.verdict, verdictWebmSize: 620,
    particles: 34, particleRadius: 170,
    shakeMs: 620, shakeAmp: 18,
    // Raised from 520/14. The combined clip is a much larger event than the two
    // it replaced, and the old shake was reading as ambient under it.
    shakeScreenMs: 620, shakeScreenAmp: 20,
    flashMs: 90, flashAlpha: 0.55,
  }, opts);
  return build(opts, cfg, [
    "if (!caster || !prime) { done(); return; }",
    ...openStage(),
    "playSfx('sfx', 'sfxVol');",
    ...dashIn(),
    "playSfx('sfxImpact', 'sfxImpactVol');",
    "// Sword and flail resolve as a single blow, so this is ONE clip and not the",
    "// two the other combos stack — see verdictAt.",
    ...verdictAt(),
    ...impactBurst(),
    "// The extra weight. A short white flash and a hard screenshake, fired but",
    "// NOT awaited: the gate opens on the impact, and the flash is a tail.",
    "oni.screenshake({ duration: cfg.shakeScreenMs, intensity: cfg.shakeScreenAmp });",
    "oni.whiteout({ fadeIn: cfg.flashMs, hold: 40, fadeOut: cfg.flashMs * 2, alpha: cfg.flashAlpha });",
    "done();",
    "await wait(cfg.holdMs);",
    ...dashHome(),
    ...closeStage(),
  ]);
}

module.exports = {
  dashStrike, chakramBounce, arrowRain,
  comboVolley, comboOrbit, comboVerdict,
  formShift: require("./rakshasa-formshift.js").formShift,
};
