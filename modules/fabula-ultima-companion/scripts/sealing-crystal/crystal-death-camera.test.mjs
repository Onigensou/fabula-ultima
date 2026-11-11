// Sealing Crystal — the death's camera plan, on the Great Seal's real preset (Node, no Foundry).
//   node scripts/sealing-crystal/crystal-death-camera.test.mjs [--trace]
import { DEFAULTS, resolvePreset, buildCamera, buildProjector, projectLive } from "../battle-director/battle-stage-3d-rules.js";
import { planDeathCamera, shotAt, rigAt, crystalPlacement, turnOf, partyAlpha, STAND } from "./crystal-death-camera.js";
import { DEATH, POURS } from "./crystal-death.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

// The Great Seal at the battle camera's rest framing on a 1920 x 1080 screen (the mockup's numbers)
const STAGE = { x: 439, y: 241, w: 1682, h: 788 }, grid = 110;
const cfg = resolvePreset("https://x/Valley_Battlemap003.webp");
ok(!!cfg?.stage3d, "the Great Seal has a 3D preset");
const cam = buildCamera(cfg, STAGE, grid), P = buildProjector(cfg, cam, STAGE);
const scale = 1920 / STAGE.w, rest = { x: STAGE.x + STAGE.w / 2, y: STAGE.y + STAGE.h / 2, scale }, screenH = 1080 / scale;
const party = [0, 1, 2, 3].map((i) => ({ x: STAGE.x + 1202 + 165 * (i / 3), y: STAGE.y + 162 + 330 * (i / 3) + 55 }));
const feet = { x: STAGE.x + 370, y: STAGE.y + 560 }, px = 2;
const plan = planDeathCamera({ model: { P, cfg, rest }, party, feet, px, screenH });
const toScreen = (p) => ({ x: (p.x - rest.x) * scale + 960, y: (p.y - rest.y) * scale + 540 });

// at rest nothing moves: the plan's rest rig draws the crystal where the flat token is
{
  const r = rigAt(plan, 5), c = crystalPlacement(plan, r);
  ok(Math.abs(c.x - feet.x) < 3 && Math.abs(c.y - feet.y) < 6 && Math.abs(c.k - 1) < 0.02, `rest: crystal feet at its token's feet (${c.x.toFixed(1)}, ${c.y.toFixed(1)} vs ${feet.x}, ${feet.y}; k ${c.k.toFixed(3)})`);
  ok(shotAt(plan, 5).stand === 0, "rest: no placed shot before 10.8 s");
}
// the stand: the crystal fills STAND.fill of the screen's height, centred
{
  const r = rigAt(plan, 14), c = crystalPlacement(plan, r);
  const tall = 250 * px * c.k, s = toScreen(c.heart);
  ok(Math.abs(tall / screenH - STAND.fill) < 0.02, `stand: crystal ${(100 * tall / screenH).toFixed(1)} % of the screen height (want ${STAND.fill * 100})`);
  ok(Math.abs(s.x - 960) < 40 && Math.abs(s.y - 540) < 40, `stand: heart near the screen centre (${s.x.toFixed(0)}, ${s.y.toFixed(0)})`);
  ok(Math.abs(r.C[1] - STAND.eye) < 0.05, `stand: eye ${r.C[1].toFixed(2)} m`);
  ok(partyAlpha(r) === 0 && partyAlpha(rigAt(plan, 5)) === 1, "party hidden while the camera stands, shown at rest");
}
// the pull-away shrinks it steadily and keeps speeding up (relative shrink rises), through the full white
{
  let prev = null, prevRate = 0, steady = true, accel = true;
  for (let D = 15.4; D <= DEATH.whiteFull; D += 0.4) {
    const k = crystalPlacement(plan, rigAt(plan, D)).k;
    if (prev != null) { const rate = 1 - k / prev; if (rate <= 0) steady = false; if (rate < prevRate - 0.005) accel = false; prevRate = rate; }
    prev = k;
  }
  ok(steady, "pull-away: the crystal shrinks every step");
  ok(accel, "pull-away: the relative shrink keeps rising (cubic ease-in reads as speeding up)");
}
// back to rest under the white
{
  const r = rigAt(plan, DEATH.whiteHold + 0.01);
  ok((r.stand || 0) === 0 && Math.abs(crystalPlacement(plan, r).k - 1) < 0.02, "after the white hold: back at rest");
}
// the camera only comes down and never goes behind the crystal; pours each have a pose
{
  let prevY = Infinity, down = true;
  for (let D = 10.8; D <= 13.5; D += 0.1) { const y = rigAt(plan, D).C[1]; if (y > prevY + 1e-6) down = false; prevY = y; }
  ok(down, "the camera only comes down on its way in");
  ok(plan.camPoses.length === POURS.length && plan.camPoses.every((p) => Number.isFinite(p.yaw) && Number.isFinite(p.pitch)), "a camera pose for every pour");
}

if (process.argv.includes("--trace")) for (const D of [10.8, 12, 13.5, 15, 17, 19, 19.8, 20.4]) {
  const r = rigAt(plan, D), c = crystalPlacement(plan, r), t = turnOf(r, plan);
  console.log(D, "stand", (r.stand || 0).toFixed(2), "C", r.C.map((v) => v.toFixed(1)).join(","), "tall px", (250 * px * c.k * scale).toFixed(0), "of 1080; yaw", (t.yaw * 57.3).toFixed(0), "pitch", (t.pitch * 57.3).toFixed(0));
}
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
