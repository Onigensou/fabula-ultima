// ═════════ move-engine · shared core (host-neutral; loaded FIRST by both the mockup page and the game runtime)
// Everything here is pure: no DOM, no timers, no Foundry. Both hosts must load it verbatim, so a move eases,
// lerps and rolls its random jitter exactly the same in the mockup and in the game.
//
// Units: every position / size a move uses is MOCKUP px on the 1682 x 788 stage. The game runtime maps them to
// the board (see game/runtime.js "mockup space").
const MOVE_ENGINE_VERSION = "1.0.0";
const W = 1682, H = 788;
const EASE = { lin: (t) => t, quad: (t) => t < .5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2, out: (t) => 1 - (1-t)*(1-t), in: (t) => t*t,
  sine: (t) => -(Math.cos(Math.PI*t) - 1)/2, outCubic: (t) => 1 - Math.pow(1-t, 3), inCubic: (t) => t*t*t, outQuart: (t) => 1 - Math.pow(1-t, 4),
  outExpo: (t) => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t), outBack: (t) => { const c = 1.6; return 1 + (c+1)*Math.pow(t-1, 3) + c*Math.pow(t-1, 2); },
  // CSS ease-out / ease-in (the old DOM cut-in's transitions)
  cssOut: (t) => cubicBez(0, 0, .58, 1, t), cssIn: (t) => cubicBez(.42, 0, 1, 1, t) };
function cubicBez(x1, y1, x2, y2, x) { let t = x; for (let i = 0; i < 8; i++) { const cx = 3*x1, bx = 3*(x2-x1)-cx, ax = 1-cx-bx; const fx = ((ax*t+bx)*t+cx)*t - x; const d = (3*ax*t+2*bx)*t+cx; if (Math.abs(d) < 1e-6) break; t -= fx/d; } const cy = 3*y1, by = 3*(y2-y1)-cy, ay = 1-cy-by; return ((ay*t+by)*t+cy)*t; }
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// ───────── Seeded randomness. A move's jitter (rnd / pick) comes from ONE seeded stream that both hosts reseed at the
// start of every run (moveSeed(seed)), so the same move draws the same jitter in the mockup and in the game.
// Per-FRAME randomness inside the engines (speed-line respawn, rumble, a portal's flames) must use rndFx instead:
// how many frames run differs between hosts, and frame-driven draws would shift the move's stream.
function makeRng(seed) { let s = seed | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let MOVE_RNG = makeRng(1);
function moveSeed(seed) { MOVE_RNG = makeRng(seed == null ? 1 : seed); }
const rnd = (a, b) => a + MOVE_RNG() * (b - a);
const pick = (arr) => arr[Math.floor(MOVE_RNG() * arr.length)];
const rndFx = (a, b) => a + Math.random() * (b - a);

// ───────── Trace: both hosts log the same events at the move's VIRTUAL time (the beat clock), so a port check is a
// diff of two traces. A host sets TRACE_ON / TRACE_NOW (its clock reader) / TRACE_REF (the caster actor).
// Positions are logged relative to the caster's home feet, x mirrored so +x always points at the target side.
const TRACE = { on: false, list: [], now: () => 0, real: null, ref: null };   // real: optional wall-clock reader (mockup), for drift checks
function traceReset(ref) { TRACE.list = []; TRACE.ref = ref || null; }
function tracePt(pt) { const r = TRACE.ref; if (!pt || !r) return null; const f = r.kind === "party" ? -1 : 1;
  return { x: Math.round((pt.x - r.x) * f * 10) / 10, y: Math.round((pt.y - r.y) * 10) / 10 }; }
function traceEv(type, data) { if (!TRACE.on) return; const ev = Object.assign({ at: Math.round(TRACE.now() * 10) / 10, type }, TRACE.real ? { real: Math.round(TRACE.real() * 10) / 10 } : {}, data || {}); TRACE.list.push(ev); return ev; }
