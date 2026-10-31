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
  PRESETS, backdropKey, resolvePreset, buildCamera, physicalRatio, tokenScaleAt, battlerScaleAt,
  floorDisparityAt, floorToWorld, worldToCanvas, parallaxUniforms, shiftUV,
  buildProjector, restPxPerMetre, rigCamera, liveBattler, projectNearFoot, stageModeFor,
  reliefDepth, reliefPoint, floorDepth, projectLive, paintedLive, paintedParallax,
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
  ok("projector only where a stage3d model exists", P && buildProjector(resolvePreset("Hideout_Battlemap001.png"), cam, V2_STAGE) === null
    && buildProjector({ ...resolvePreset("Valley_Battlemap001.webp"), stage3d: undefined }, cam, V2_STAGE) === null);
  ok("Training Ground keeps its floor + wall model", P.relief === false && P.wallY > V2_STAGE.y);
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

  // Arena points near a battler (entrance paths)
  const f0 = { x: 1500, y: 700 }, ppm0 = restPxPerMetre(f0.y, P);
  const n0 = projectNearFoot(f0, { x: 0, h: 0, z: 0 }, P, still), lb = liveBattler(f0, P, still);
  ok("near: zero offset = the battler's own drawn feet", Math.abs(n0.x - lb.x) < 1e-6 && Math.abs(n0.y - lb.y) < 1e-6 && Math.abs(n0.s - 1) < 1e-9 && n0.fx === n0.x);
  const nx = projectNearFoot(f0, { x: 100 }, P, still), nh = projectNearFoot(f0, { h: 100 }, P, still);
  near("near: at rest an offset along X is drawn 1:1 on the battler's row", nx.x - f0.x, 100, 1e-6);
  near("near: at rest a height is drawn 1:1 straight up", f0.y - nh.y, 100, 1e-6);
  ok("near: at rest a height does not drift sideways", Math.abs(nh.x - f0.x) < 1e-6);
  const nz = projectNearFoot(f0, { z: 100 }, P, still), nb = projectNearFoot(f0, { z: -100 }, P, still);
  ok("near: toward the camera = lower and larger, away = higher and smaller", nz.y > f0.y && nz.s > 1 && nb.y < f0.y && nb.s < 1, `${nz.y} ${nz.s} ${nb.y} ${nb.s}`);
  ok("near: z on the floor lands where a battler standing there is drawn", (() => {
    const b = liveBattler(floorPointNearer(f0, 100, P, ppm0), P, still);
    return Math.abs(b.x - nz.x) < 1e-6 && Math.abs(b.y - nz.y) < 1e-6;
  })());
  const swung = rigCamera({ view: rest, rest, shot: { yaw: -57 }, sway: false }, P, cfg);
  const sx = projectNearFoot(f0, { x: 100 }, P, swung), sz = projectNearFoot(f0, { z: 100 }, P, swung);
  ok("near: swung camera foreshortens X and turns depth sideways", Math.abs(sx.x - sx.fx) < 90 && Math.abs(sz.x - sz.fx) > 40, `${sx.x - sx.fx} ${sz.x - sz.fx}`);
  ok("near: size factor is clamped", projectNearFoot(f0, { z: 1e6 }, P, still).s <= 4);
}

// ── Relief model (open scenery) ───────────────────────────────────────────
for (const [file, stage] of [["Eisendrache_Battlemap002.png", LEGACY_STAGE], ["Valley_Battlemap001.webp", V2_STAGE]]) {
  const cfg = resolvePreset(file);
  const cam = buildCamera(cfg, stage, 100);
  const P = buildProjector(cfg, cam, stage);
  const tag = cfg.key;
  const row = (r) => stage.y + r * (stage.h / 788);
  const Dfloor = (y) => floorDisparityAt(y, cam);
  ok(`${tag}: relief model`, P.relief === true && P.wallY === null);
  ok(`${tag}: horizon is a finite distance once compressed`, Number.isFinite(P.farZ) && P.farZ > floorDepth(row(222), P));
  const rows = [row(120), row(170), row(300), row(500), row(700), row(780)].filter((y) => y > cam.hz + 2);
  ok(`${tag}: plain floor stays the floor`, rows.every((y) => Math.abs(reliefDepth(y, Dfloor(y), P) - floorDepth(y, P)) < 1e-6 * floorDepth(y, P)));
  const band = [row(200), row(400), row(590)];
  ok(`${tag}: battle band is rigid floor whatever the depth map says`, band.every((y) => [0, 0.2, 2].every((D) => Math.abs(reliefDepth(y, D, P) - floorDepth(y, P)) < 1e-9)));
  const yb = row(110);
  const stand = reliefDepth(yb, Dfloor(row(260)), P);
  ok(`${tag}: something standing above the band comes forward of the floor`, stand < Math.min(floorDepth(yb, P), P.farZ) && reliefPoint({ x: 800, y: yb }, stand, P).Y > 0);
  ok(`${tag}: never sinks below the ground`, Math.abs(reliefDepth(row(700), 0, P) - floorDepth(row(700), P)) < 1e-9);
  ok(`${tag}: sky sits at the horizon distance, above the ground`, Math.abs(reliefDepth(stage.y + 5, 0, P) - P.farZ) < 1e-9 && reliefPoint({ x: 800, y: stage.y + 5 }, P.farZ, P).Y > 0);
  const zs = []; for (let y = row(120); y <= row(200); y += 2) zs.push(reliefDepth(y, 0, P));
  ok(`${tag}: no step into the band (eased)`, zs.every((z, i) => i === 0 || Math.abs(z - zs[i - 1]) < 0.08 * P.farZ), JSON.stringify(zs.slice(0, 5)));
  const rest = { x: stage.x + stage.w / 2, y: row(420), scale: 1 };
  const still = rigCamera({ view: rest, rest, sway: false }, P, cfg);
  const pts = [{ x: stage.x + 100, y: stage.y + 10 }, { x: stage.x + 900, y: row(130) }, { x: stage.x + 1500, y: row(700) }];
  ok(`${tag}: at rest the relief reproduces the painting`, pts.every((p) => {
    const q = projectLive(reliefPoint(p, reliefDepth(p.y, 0.3, P), P), still);
    return Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6;
  }));
}

// ── Battler size follows the 3D model's projector ─────────────────────────
{
  const cfg = resolvePreset("Eisendrache_Battlemap001_v2.webp");
  const cam = buildCamera(cfg, V2_STAGE, 110), P = buildProjector(cfg, cam, V2_STAGE);
  const rows = [V2_STAGE.y + 217, V2_STAGE.y + 327, V2_STAGE.y + 437, V2_STAGE.y + 547];
  // drawn height / the projector's px-per-metre = a battler's height in metres: equal for all rows
  const hM = rows.map((y) => battlerScaleAt(y, cam, P) / restPxPerMetre(y, P));
  ok("battler scale = projector ratio (same height in metres on every row, inside the clamps)",
    hM.slice(0, 3).every((h) => Math.abs(h / hM[1] - 1) < 1e-9), JSON.stringify(hM));
  near("battler scale is 1 at the reference row", battlerScaleAt(cam.refY, cam, P), 1);
  ok("battler scale keeps the clamps", battlerScaleAt(V2_STAGE.y, cam, P) === cam.minScale);
  ok("no model = tokenScaleAt", battlerScaleAt(rows[0], cam, null) === tokenScaleAt(rows[0], cam));
  ok("NaN foot -> 1", battlerScaleAt(NaN, cam, P) === 1);
}

// ── Fallback ladder: 3D -> parallax -> 2D ─────────────────────────────────
{
  const tgCfg = resolvePreset("Eisendrache_Battlemap001_v2.webp");
  const valley = resolvePreset("Valley_Battlemap001.webp");
  const plain = resolvePreset("Hideout_Battlemap001.png");
  ok("3D camera where the backdrop has a 3D model", stageModeFor("camera", tgCfg) === "camera");
  ok("3D camera falls back to parallax without a 3D model", stageModeFor("camera", { ...valley, stage3d: undefined }) === "full");
  ok("Valley + Overworld battles get the 3D camera", stageModeFor("camera", valley) === "camera" && stageModeFor("camera", resolvePreset("Eisendrache_Battlemap002.png")) === "camera");
  ok("3D camera on a plain 2D backdrop = untouched 2D", stageModeFor("camera", plain) === "off");
  ok("parallax / scale on a plain backdrop = untouched 2D", stageModeFor("full", null) === "off" && stageModeFor("scale", null) === "off");
  ok("Off is off everywhere", stageModeFor("off", tgCfg) === "off");
  ok("parallax setting never starts the 3D camera", stageModeFor("full", tgCfg) === "full");
}

// ── Objects pinned to the painting (battle-stage-ambient) ────────────────────
{
  const cfg = resolvePreset(FORGE + "Valley_Battlemap002.webp?v=2");
  ok("Underground battle map has a relief and scene effects", !!cfg?.stage3d?.relief && cfg.ambient?.crystals?.length === 15 && cfg.ambient?.pools?.length === 2);
  const cam = buildCamera(cfg, V2_STAGE, 110), P = buildProjector(cfg, cam, V2_STAGE);
  const rest = { x: 1280, y: 635, scale: 1.1415 }, rect = { x: 0, y: 0, w: 2560, h: 1270 };
  const crystal = { x: 948, y: 225 }, D = 0.05;
  const rigAt = (shot = {}, view = rest) => rigCamera({ view, rest, shot, t: 0, sway: false, neutral: 0 }, P, cfg);
  const atRest = paintedLive(crystal, D, P, rigAt());
  near("a painted point sits on itself at rest (x)", atRest.x, crystal.x, 1e-6);
  near("a painted point sits on itself at rest (y)", atRest.y, crystal.y, 1e-6);
  near("... at its rest size", atRest.s, 1, 1e-6);
  const fold = paintedLive(crystal, D, P, rigCamera({ view: { ...rest, x: rest.x + 150 }, rest, shot: { yaw: 18, tilt: 3, push: 0.9 }, t: 0, sway: false, neutral: 1 }, P, cfg));
  near("neutral camera folds a painted point back to 2D (x)", fold.x, crystal.x, 1e-6);
  near("neutral camera folds a painted point back to 2D (y)", fold.y, crystal.y, 1e-6);
  // The same world point the relief mesh draws, so an object can't part from its paint.
  const Z = reliefDepth(crystal.y, D, P), swung = rigAt({ yaw: 18, tilt: 3, push: 0.9 });
  const mesh = projectLive(reliefPoint(crystal, Z, P), swung), pin = paintedLive(crystal, D, P, swung);
  ok("under a swing the pin moves with the relief", Math.abs(pin.x - crystal.x) > 50 && pin.x === mesh.x && pin.y === mesh.y);

  const u = parallaxUniforms({ view: { ...rest, x: rest.x + 100 }, rest, t: 0, cfg, cam, sceneRect: rect, orbit: false });
  const farP = paintedParallax(crystal, 0, u, cfg, rect);
  const uv = [crystal.x / rect.w, crystal.y / rect.h], s = shiftUV(uv, 0, u, cfg);
  near("parallax pin is the mesh's own shift", farP.x - crystal.x, s[0] * rect.w, 1e-9);
  ok("far scenery shifts under a pan", Math.abs(farP.x - crystal.x) > 1);
  const bandD = (u.band[0] + u.band[1]) / 2, floorP = paintedParallax({ x: 1280, y: 600 }, bandD, u, cfg, rect);
  ok("the battle band stays rigid", floorP.x === 1280 && floorP.y === 600);
}

// The canvas foot point `dzPx` rest px (at `f`'s row) nearer the camera along the floor.
function floorPointNearer(f, dzPx, P, ppm) {
  const Z0 = floorDepth(f.y, P), Z = Z0 - dzPx / ppm;
  return { x: P.cx + ((f.x - P.cx) * Z0) / Z, y: P.hz + (P.f * P.Hp) / Z };
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
