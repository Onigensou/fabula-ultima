// ============================================================================
// Battle stage 3D — pure-maths regression harness.
//
//     node scripts/battle-director/battle-stage-3d-rules.test.mjs
//
// The assertions that matter: the battle band never moves (feet do not slide),
// far scenery follows the camera and near scenery opposes it, the round trip
// floor -> world -> canvas is exact, and a backdrop with no preset is left alone.
// ============================================================================

import {
  PRESETS, backdropKey, resolvePreset, buildCamera, physicalRatio, tokenScaleAt,
  floorDisparityAt, floorToWorld, worldToCanvas, parallaxUniforms, shiftUV,
  buildProjector, restPxPerMetre, rigCamera, liveBattler, stageModeFor,
} from "./battle-stage-3d-rules.js";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${label}${cond ? "" : `  ${extra}`}`);
};
const near = (label, got, want, tol = 1e-6) => ok(label, Math.abs(got - want) <= tol, `got ${got} want ${want}`);

const V2_STAGE = { x: 439, y: 241, w: 1682, h: 788 };
const LEGACY_STAGE = { x: 0, y: 0, w: 1682, h: 788 };
const FORGE = "https://assets.forge-vtt.com/x/Campaign/The%20Legend%20of%20Dragonslayer/Image/Battlemap/";

// ── Preset lookup ──────────────────────────────────────────────────────────
ok("key strips dir, ext and query", backdropKey(FORGE + "Valley_Battlemap001.webp?v=2") === "Valley_Battlemap001");
ok("key decodes %20", backdropKey("a/My%20Map.png") === "My Map");
ok("no preset -> null (scene untouched)", resolvePreset(FORGE + "Hideout_Battlemap001.png") === null);
ok("empty src -> null", resolvePreset("") === null && resolvePreset(undefined) === null);
const tg = resolvePreset(FORGE + "Eisendrache_Battlemap001_v2.webp");
ok("Training Ground resolves", tg && tg.horizon === PRESETS.Eisendrache_Battlemap001_v2.horizon);
ok("depth map path is module-local", tg.depthMap === "modules/fabula-ultima-companion/assets/battle-depth/Eisendrache_Battlemap001_v2.webp");
ok("override wins", resolvePreset(FORGE + "Valley_Battlemap001.webp", { strength: 0 }).strength === 0);
ok("all three scenes have presets", ["Eisendrache_Battlemap001_v2", "Eisendrache_Battlemap002", "Valley_Battlemap001"].every((k) => PRESETS[k]));

// ── Token scale ────────────────────────────────────────────────────────────
for (const [key, stage] of [["Eisendrache_Battlemap001_v2", V2_STAGE], ["Eisendrache_Battlemap002", LEGACY_STAGE], ["Valley_Battlemap001", V2_STAGE]]) {
  const cfg = resolvePreset(key + ".webp");
  const cam = buildCamera(cfg, stage, 100);
  const back = tokenScaleAt(stage.y + 217, cam);   // party top slot feet
  const front = tokenScaleAt(stage.y + 547, cam);  // party bottom slot feet
  near(`${key}: 1.0 at the reference row`, tokenScaleAt(cam.refY, cam), 1);
  ok(`${key}: back row smaller (${back.toFixed(3)})`, back > 0.66 && back < 0.78);
  ok(`${key}: front row only a little larger (${front.toFixed(3)})`, front > 1 && front <= cfg.maxScale);
  ok(`${key}: monotonic`, tokenScaleAt(stage.y + 300, cam) < tokenScaleAt(stage.y + 400, cam));
}
{
  const cam = buildCamera(tg, V2_STAGE, 100);
  ok("above the horizon clamps, never NaN/negative", tokenScaleAt(V2_STAGE.y, cam) === cam.minScale);
  ok("NaN foot -> 1", tokenScaleAt(NaN, cam) === 1);
  ok("strength 0 -> scale 1 everywhere", tokenScaleAt(V2_STAGE.y + 217, { ...cam, strength: 0 }) === 1);
  ok("physical ratio stays positive above the horizon", physicalRatio(0, cam) > 0);
}

// ── Metres ─────────────────────────────────────────────────────────────────
{
  const cam = buildCamera(tg, V2_STAGE, 100);
  for (const p of [{ x: 600, y: 700 }, { x: 1800, y: 1000 }, { x: 1300, y: cam.refY }]) {
    const w = floorToWorld(p, cam);
    const back = worldToCanvas({ X: w.X, Y: 0, Z: w.Z }, cam);
    near(`floor->world->canvas x (${p.x},${p.y})`, back.x, p.x, 1e-6);
    near(`floor->world->canvas y (${p.x},${p.y})`, back.y, p.y, 1e-6);
  }
  const atRef = floorToWorld({ x: cam.cx, y: cam.refY }, cam);
  near("person at refRow is grid px tall", worldToCanvas({ X: 0, Y: 0, Z: atRef.Z }, cam).y - worldToCanvas({ X: 0, Y: 1.7, Z: atRef.Z }, cam).y, 100, 1e-6);
  ok("further rows are further away", floorToWorld({ x: cam.cx, y: cam.refY - 100 }, cam).Z > atRef.Z);
  near("floor disparity: 1 at the stage bottom", floorDisparityAt(V2_STAGE.y + V2_STAGE.h, cam), 1);
  near("floor disparity: 0 at the horizon", floorDisparityAt(cam.hz, cam), 0);
}

// ── Parallax ───────────────────────────────────────────────────────────────
{
  const cam = buildCamera(tg, V2_STAGE, 100);
  const rect = { x: 0, y: 0, w: 2560, h: 1270 };
  const rest = { x: 1280, y: 635, scale: 1 };
  const at = (view, t = 0, orbit = false) => parallaxUniforms({ view, rest, t, cfg: tg, cam, sceneRect: rect, orbit });

  const still = at({ ...rest });
  ok("camera at rest, no drift -> no shift anywhere", [0, 0.1, 0.5, 1.2, 2].every((D) => shiftUV([0.5, 0.5], D, still, tg).every((s) => s === 0)));

  const panned = at({ x: 1280 - 120, y: 635, scale: 1 });
  const [dBack, dFront] = panned.band;
  const mid = (dBack + dFront) / 2;
  ok("band: back < front", dBack < dFront);
  ok("battle band is rigid under a pan", shiftUV([0.4, 0.5], mid, panned, tg).every((s) => s === 0));
  ok("band edges are rigid too", shiftUV([0.4, 0.5], dBack, panned, tg)[0] === 0 && shiftUV([0.4, 0.5], dFront, panned, tg)[0] === 0);
  const sky = shiftUV([0.4, 0.5], 0, panned, tg)[0];
  const fore = shiftUV([0.4, 0.5], 1.8, panned, tg)[0];
  ok("far scenery follows the pan (camera left -> shift left)", sky < 0);
  ok("near scenery opposes it", fore > 0);
  near("sky keeps `pan` of the camera offset", sky * rect.w, -120 * tg.pan, 1e-9);
  ok("halfway back moves less than the sky", Math.abs(shiftUV([0.4, 0.5], dBack / 2, panned, tg)[0]) < Math.abs(sky));

  const zoomed = at({ ...rest, scale: 1.5 });
  ok("zoom-in = dolly: far scenery pulls toward the pivot", shiftUV([0.9, 0.5], 0, zoomed, tg)[0] < 0 && shiftUV([0.1, 0.5], 0, zoomed, tg)[0] > 0);
  ok("zoom-in = dolly: band still rigid", shiftUV([0.9, 0.5], mid, zoomed, tg)[0] === 0);

  const drift = at({ ...rest }, tg.orbitPeriodX / 4, true);
  ok("idle drift moves far scenery", shiftUV([0.5, 0.5], 0, drift, tg)[0] > 0);
  ok("idle drift held when orbit=false", shiftUV([0.5, 0.5], 0, at({ ...rest }, tg.orbitPeriodX / 4, false), tg)[0] === 0);

  const wild = at({ x: 1280 - 5000, y: 635, scale: 1 });
  near("camera offset is clamped to maxShift", shiftUV([0.5, 0.5], 0, wild, tg)[0] * rect.w, -tg.maxShift * tg.pan, 1e-9);
}

// ── 3D camera ──────────────────────────────────────────────────────────────
{
  const cfg = resolvePreset("Eisendrache_Battlemap001_v2.webp");
  const cam = buildCamera(cfg, V2_STAGE, 110);
  const P = buildProjector(cfg, cam, V2_STAGE);
  ok("projector only where a stage3d model exists", P && buildProjector(resolvePreset("Valley_Battlemap001.webp"), cam, V2_STAGE) === null);
  ok("compressed horizon sits above the painted one", P.hz < cam.hz);
  const ratio = restPxPerMetre(V2_STAGE.y + 222, P) / restPxPerMetre(V2_STAGE.y + 547, P);
  near("back/front size ratio = painted ratio ^ strength", ratio,
    Math.pow((V2_STAGE.y + 222 - cam.hz) / (V2_STAGE.y + 547 - cam.hz), cfg.strength), 1e-9);
  near("reference row keeps the authored px per metre", restPxPerMetre(cam.refY, P), cam.ppmRef, 1e-9);

  const rest = { x: 1280, y: 635, scale: 0.9 };
  const still = rigCamera({ view: rest, rest, sway: false }, P, cfg);
  const feet = [{ x: 700, y: 470 }, { x: 1600, y: 700 }, { x: 1280, y: 980 }];
  ok("rest camera reproduces the painting (feet do not move, scale 1)", feet.every((f) => {
    const b = liveBattler(f, P, still);
    return Math.abs(b.x - f.x) < 1e-6 && Math.abs(b.y - f.y) < 1e-6 && Math.abs(b.scale - 1) < 1e-9;
  }));

  const panned = rigCamera({ view: { ...rest, x: rest.x + 300 }, rest, sway: false }, P, cfg);
  const pv = liveBattler({ x: rest.x + 300, y: rest.y }, P, panned);
  ok("pan: the floor under the view centre stays put", Math.abs(pv.x - (rest.x + 300)) < 1e-6 && Math.abs(pv.y - rest.y) < 1e-6);
  const backRow = liveBattler({ x: rest.x + 300, y: 470 }, P, panned), frontRow = liveBattler({ x: rest.x + 300, y: 980 }, P, panned);
  ok("pan: back row follows the camera, front row opposes it", backRow.x > rest.x + 300 && frontRow.x < rest.x + 300, `back ${backRow.x} front ${frontRow.x}`);
  ok("pan swings the camera", panned.yaw > 0);

  const zoomed = rigCamera({ view: { ...rest, scale: rest.scale * 1.6 }, rest, sway: false }, P, cfg);
  const zc = liveBattler({ x: rest.x, y: rest.y }, P, zoomed);
  near("zoom: framing of the view centre is kept", zc.scale, 1, 1e-6);
  ok("zoom = dolly: front grows, back shrinks", liveBattler({ x: rest.x, y: 980 }, P, zoomed).scale > 1 && liveBattler({ x: rest.x, y: 470 }, P, zoomed).scale < 1);

  const turned = rigCamera({ view: rest, rest, shot: { yaw: 20 }, sway: false }, P, cfg);
  const L = liveBattler({ x: 900, y: 640 }, P, turned), Rr = liveBattler({ x: 1660, y: 640 }, P, turned);
  ok("yaw: battlers on one side come nearer than the other", Math.abs(L.scale - Rr.scale) > 0.02, `${L.scale} ${Rr.scale}`);
  const pushed = rigCamera({ view: rest, rest, shot: { push: 0.6 }, sway: false }, P, cfg);
  ok("push: really moves in (view centre grows)", liveBattler({ x: rest.x, y: rest.y }, P, pushed).scale > 1.3);
  ok("sway moves the camera when on", rigCamera({ view: rest, rest, t: cfg.swayPeriod / 4, sway: true }, P, cfg).yaw !== 0);

  // Neutral: everything folded out = the painted camera, whatever the 2D
  // camera, the scripted shot and the clock are doing.
  const busy = { view: { x: rest.x + 300, y: rest.y - 40, scale: rest.scale * 1.6 }, rest, shot: { yaw: 18, tilt: 3, push: 0.7 }, t: cfg.swayPeriod / 4, sway: true };
  const allFeet = [...feet, { x: rest.x + 300, y: rest.y - 40 }, { x: 2000, y: 560 }];
  const held = rigCamera({ ...busy, neutral: 1 }, P, cfg);
  ok("neutral 1 = exact 2D (feet do not move, scale 1) under pan + zoom + shot + sway", allFeet.every((f) => {
    const b = liveBattler(f, P, held);
    return Math.abs(b.x - f.x) < 1e-6 && Math.abs(b.y - f.y) < 1e-6 && Math.abs(b.scale - 1) < 1e-9;
  }));
  ok("neutral 1 = no swing", held.yaw === 0 && held.tilt === 0 && held.k === 1);
  const free = rigCamera(busy, P, cfg), free0 = rigCamera({ ...busy, neutral: 0 }, P, cfg);
  ok("neutral 0 = the free camera, unchanged", free0.C.every((v, i) => v === free.C[i]) && free0.yaw === free.yaw && free0.f === free.f);
  const half = rigCamera({ ...busy, neutral: 0.5 }, P, cfg);
  const off = (r) => { const b = liveBattler({ x: 1280, y: 980 }, P, r); return Math.hypot(b.x - 1280, b.y - 980); };
  ok("neutral 0.5 sits between free and neutral", off(half) > 1e-3 && off(half) < off(free) && Math.abs(half.yaw) < Math.abs(free.yaw), `${off(half)} vs ${off(free)}`);
  ok("neutral is clamped", rigCamera({ ...busy, neutral: 3 }, P, cfg).yaw === 0 && rigCamera({ ...busy, neutral: -1 }, P, cfg).yaw === free.yaw);
}

// ── Fallback ladder: 3D -> parallax -> 2D ─────────────────────────────────
{
  const tgCfg = resolvePreset("Eisendrache_Battlemap001_v2.webp");
  const valley = resolvePreset("Valley_Battlemap001.webp");
  const plain = resolvePreset("Hideout_Battlemap001.png");
  ok("3D camera where the backdrop has a 3D model", stageModeFor("camera", tgCfg) === "camera");
  ok("3D camera falls back to parallax without a 3D model", stageModeFor("camera", valley) === "full");
  ok("3D camera on a plain 2D backdrop = untouched 2D", stageModeFor("camera", plain) === "off");
  ok("parallax / scale on a plain backdrop = untouched 2D", stageModeFor("full", null) === "off" && stageModeFor("scale", null) === "off");
  ok("Off is off everywhere", stageModeFor("off", tgCfg) === "off");
  ok("parallax setting never starts the 3D camera", stageModeFor("full", tgCfg) === "full");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
