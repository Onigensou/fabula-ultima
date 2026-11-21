// ============================================================================
// Reaction drag: the held card's geometry, the drop zone, the comet colours,
// and the guards that keep a "hold" signal from ever becoming a Skip.
//
//     node scripts/battle-director/reaction-drag.test.mjs
//
// Bare Node, no Foundry.
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _geom } from "./reaction-drag.js";
import { cometRamp } from "./reaction-landing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ok   ${name}`); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.11, `${msg}: ${a} vs ${b}`);

// Apply the CSS function list xf() writes, right to left, to a local point.
function world(transform, p) {
  const nums = (s) => s.split(",").map((v) => parseFloat(v));
  const fns = [...transform.matchAll(/(translate|rotate|scale)\(([^)]*)\)/g)].map((m) => [m[1], nums(m[2])]);
  let { x, y } = p;
  for (const [fn, a] of fns.reverse()) {
    if (fn === "translate") { x += a[0]; y += a[1]; }
    else if (fn === "scale") { x *= a[0]; y *= a[0]; }
    else { const r = (a[0] * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); [x, y] = [x * c - y * s, x * s + y * c]; }
  }
  return { x, y };
}

const { xf, homeT, inZone, DRAG_SLOP, ZONE_PAD } = _geom;

ok("a card at rest sits exactly on its hand slot, at the hand's scale", () => {
  const home = { x: 1200, y: 700 }, L = { x: 40, y: 70 }, k = 0.8;
  const t = xf(homeT(home, L, k), L, 0, k);
  for (const p of [{ x: 0, y: 0 }, { x: 164, y: 236 }, { x: 40, y: 70 }]) {
    const w = world(t, p);
    near(w.x, home.x + k * p.x, "x"); near(w.y, home.y + k * p.y, "y");
  }
});

ok("the point you grabbed stays under the pointer, whatever the tilt and size", () => {
  const L = { x: 52, y: 90 }, ptr = { x: 900, y: 500 };
  for (const [rot, s] of [[0, 1], [14, 0.9], [-14, 1.08], [7, 0.72]]) {
    const w = world(xf({ x: ptr.x - L.x, y: ptr.y - L.y }, L, rot, s), L);
    near(w.x, ptr.x, `x @${rot}/${s}`); near(w.y, ptr.y, `y @${rot}/${s}`);
  }
});

ok("the drop zone is the action card plus its give, and nothing else", () => {
  const z = { left: 800, right: 1120, top: 272, bottom: 808 };
  assert.ok(inZone(z, { x: 960, y: 500 }));
  assert.ok(inZone(z, { x: 800 - ZONE_PAD, y: 272 - ZONE_PAD }));
  assert.ok(!inZone(z, { x: 800 - ZONE_PAD - 1, y: 500 }));
  assert.ok(!inZone(z, { x: 1300, y: 760 }), "your own hand is not the target");
  assert.ok(!inZone(null, { x: 960, y: 500 }), "no action card, no target");
});

ok("a press only becomes a drag after Fabula Arcana's 7 px", () => {
  assert.equal(DRAG_SLOP, 7);
});

ok("the magnet is the 'Light' strength the host picked live", () => {
  assert.equal(_geom.MAGNET, 0.12);
});

ok("a dropped card tucks with its icon exactly on the slot, at the slot's size", () => {
  const rect = { left: 610, top: 712, width: 32, height: 32 };
  const ic = { x: 26, y: 30, w: 30 }, L = { x: 52, y: 90 };
  const s = rect.width / ic.w;
  const t = xf(_geom.tuckT(rect, ic, L, s), L, 0, s);
  const c = world(t, ic), edge = world(t, { x: ic.x + ic.w / 2, y: ic.y });
  near(c.x, rect.left + 16, "icon centre x"); near(c.y, rect.top + 16, "icon centre y");
  near(edge.x - c.x, rect.width / 2, "icon half-width = slot half-width");
});

ok("the comet runs white → light → the player's colour → a dark rim", () => {
  const r = cometRamp("#62c4ff");
  assert.equal(r.length, 4);
  assert.equal(r[0], "#ffffff");
  assert.equal(r[2], "#62c4ff");
  for (const c of r) assert.match(c, /^#[0-9a-f]{6}$/);
  assert.equal(cometRamp("not a colour")[2], "#e2c27e", "falls back to the game's gold");
});

// The trap this feature walks next to: the reaction-pill code treats any action it
// doesn't know as a Skip. These read the source, so a refactor that moves the
// guard below the Skip fallback fails here instead of at the table.
const card = fs.readFileSync(path.join(here, "action-card.js"), "utf8");
ok("every pill click handler returns on hold / unhold BEFORE its Skip fallback", () => {
  const FALLBACK = 'const decision = reactionBtn.dataset.fudReactionAction === "apply" ? "apply" : "skip";';
  const GUARD = 'holdAct === "hold" || holdAct === "unhold"';
  let at = card.indexOf(FALLBACK), n = 0;
  assert.ok(at > 0, "the fallback is still there");
  while (at > 0) {
    // The guard sits in the same handler, a few lines above (≤ 1500 chars).
    const g = card.lastIndexOf(GUARD, at);
    assert.ok(g > 0 && at - g < 1500, `fallback #${n + 1} at char ${at} has no hold guard just above it`);
    n++;
    at = card.indexOf(FALLBACK, at + 1);
  }
  assert.equal(n, 2, "host card + player mirror");
});
ok("holding travels as its own message types, never as a reaction choice", () => {
  assert.match(card, /type: INTENTS\.REACTION_HOLD,/);
  assert.match(card, /kind: "action-card-pill-hold"/);
  assert.doesNotMatch(card, /decision: "holding"/, "a pill-update with an unknown decision falls through to skip");
  const intents = fs.readFileSync(path.join(here, "intents.js"), "utf8");
  assert.match(intents, /REACTION_HOLD: "REACTION_HOLD"/);
});

console.log(`\n${passed} passed`);
