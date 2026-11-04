// See you later — approved mockup (v8, round 2: the comedic exit). Shared by Zarg and
// Keren (the caster is whoever uses it).
//   0     "See ya!" bubble (the only text any party shot draws)
//   650   Wind4; a short wind-up crouch toward the enemy (160 ms)
//   810   backward dash off the screen edge on the party side (420 ms ease-in, running
//         bob, motion blur to 3 px), speed lines + a GG dashsmoke kick at the feet
//   1230  gone — a beat of empty space
//   1480  Wind1; a gust of leaves blows in from the edge they left by, across their
//         spot: drag bleeds the wind, gravity vs air drag gives a slow fall, pendulum
//         sway, spin and a 3D flip; they settle on the feet line and fade
// The caster is NOT drawn again (BD removes the token after the shot).
if (!caster) { K.ready(); oni.fireDone(); return; }
const B = await boot(); const { tl, T, m, TOK, U, E } = B;
const t = cfg.t;
const dir = K.dirOf(TOK, 'c');
const side = -dir;                         // the dash direction: away from the enemy
const C = TOK.c; const cf = K.feet(tl, 'c'); const art = tl.art('c');
// the frame edge on the party side, in scene px (where the camera rests for this shot)
let edge;
try { const v = tl.camView({ cam: { cx: tl.REST.cx, cy: tl.REST.cy, zoom: 1 }, panY: 0 }); edge = side > 0 ? v.right : v.left; } catch (e) { edge = null; }
if (edge == null || !isFinite(edge)) edge = side > 0 ? tl.SCENE.x + tl.SCENE.w : tl.SCENE.x;
if ((edge - cf.x) * side < 200 * U) edge = cf.x + side * 200 * U;
const exitDx = edge + side * (C.w / 2 + 70 * U) - cf.x;

// ── "See ya!" bubble: pops from .2 to 1.1 (260 ms), holds 700, fades 250 ──
const head = { x: cf.x + side * 20 * U, y: cf.y - C.h * 0.95 - 10 * U };
m.hold(0, 1210, (e, S) => {
  const s = e < 260 ? 0.2 + 0.9 * E.outQ(e / 260) : 1.1;
  const a = e < 960 ? 1 : Math.max(0, 1 - (e - 960) / 250);
  S.world.push({ z: 80, draw: (g) => {
    const fs = 30 * U; g.save(); g.font = '700 ' + fs + 'px Signika, "Segoe UI", system-ui, sans-serif';
    const tw = g.measureText('See ya!').width; const bw = tw + 24 * U + 6 * U, bh = fs + 8 * U + 6 * U;
    g.translate(head.x, head.y - bh / 2); g.scale(s, s); g.globalAlpha = a;
    g.beginPath(); if (g.roundRect) g.roundRect(-bw / 2 + 1.5 * U, -bh / 2 + 1.5 * U, bw - 3 * U, bh - 3 * U, 15 * U); else g.rect(-bw / 2, -bh / 2, bw, bh);
    g.fillStyle = '#c0392b'; g.fill(); g.lineWidth = 3 * U; g.strokeStyle = '#2a1a0e'; g.stroke();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('See ya!', 0, 0.5 * U);
    g.restore();
  } });
});

// ── wind-up crouch (real token) ──
m.hold(t.crouch, t.dash, (e, S) => { const q = S.tok.c; if (!q) return; const u = E.outQ(Math.min(1, e / (t.dash - t.crouch))); q.dx += dir * 10 * U * u; q.dy += 4 * U * u; });

// ── the dash: painted from his own texture with motion blur; hidden from here to the end ──
const DASH = t.gone - t.dash;
m.hold(t.dash, 1e9, (e, S) => {
  if (S.tok.c) S.tok.c.hidden = true;
  if (e >= DASH || !art) return;
  const u = E.inQ(e / DASH);
  const dx = dir * 10 * U + (exitDx - dir * 10 * U) * u;
  const dy = 4 * U * (1 - u) - Math.abs(Math.sin(u * Math.PI * 6)) * 8 * U;
  S.world.push({ z: 20, draw: (g) => { g.save(); g.translate(cf.x + dx, cf.y + dy); g.scale(C.flip, 1); g.filter = 'blur(' + (u * 3 * U).toFixed(2) + 'px)'; g.drawImage(art, -C.w / 2, -C.h * C.foot, C.w, C.h); g.restore(); } });
});
// dust kick at the feet where he pushes off
m.clip('dashsmoke', t.dash, { x: cf.x + dir * 10 * U, y: cf.y + 4 * U - 8 * U, w: 1024 * 0.85 * 0.5 * U, z: 40, flip: side > 0, filter: 'brightness(.95)' });
// speed lines: 10 white streaks over his height, sliding 900 px the way he runs
{
  const r = tl.rng(31); const LM = 520; const top = cf.y + 4 * U - C.h, bot = cf.y + 4 * U; const L = [];
  for (let i = 0; i < 10; i++) L.push({ y: top + r() * (bot - top), w: (160 + r() * 220) * U, h: (2 + r() * 2) * U, x0: (-265 + r() * 400) * U, d: r() * LM * 0.4 });
  m.hold(t.dash, t.dash + LM, (e, S) => S.world.push({ z: 56, draw: (g) => {
    g.save(); g.lineCap = 'round';
    for (const l of L) {
      const k = (e - l.d) / (LM * 0.6); if (k < 0 || k > 1) continue;
      const xl = l.x0 + 900 * U * k; const xa = cf.x + side * xl, xb = cf.x + side * (xl + l.w);
      const gr = g.createLinearGradient(xa, 0, xb, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,0.9)');
      g.globalAlpha = Math.sin(k * Math.PI); g.strokeStyle = gr; g.lineWidth = l.h; g.beginPath(); g.moveTo(xa, l.y); g.lineTo(xb, l.y); g.stroke();
    }
    g.restore();
  } }));
}

// ── the leaf gust (mockup leafGust/leafFrame physics, pre-simulated at 60 Hz) ──
// The mockup's gust started 435 px from the spot; horizontal speeds are scaled so it
// crosses THIS spot from THIS edge (KX), everything vertical scales with U.
const DT = 1 / 60, STEP = 1000 / 60;
const fromX = edge + side * 18 * U;
const KX = Math.max(0.5, Math.abs(fromX - cf.x) / 435);
const COLS = ['#6f9a3a', '#8fb04a', '#b98a2e', '#c8692c', '#5d8a35', '#a7a241'];
const LEAVES = [];
{
  const r = tl.rng(57); const gb = cf.y, gy0 = gb - C.h * 0.9, gy1 = gb - 10 * U;
  for (let i = 0; i < (cfg.leaves || 14); i++) {
    const s = (10 + r() * 9) * U;
    const l = { x: fromX + side * r() * 120 * U, y: gy0 + r() * (gy1 - gy0), vx: -side * (520 + r() * 380) * KX, vy: (-40 + r() * 60) * U,
      rot: r() * 6, spin: (r() - 0.5) * 5, sw: 2 + r() * 2, ph: r() * 6, flip: 3 + r() * 4, floor: gb - r() * 30 * U, age: -i * 0.05, landed: 0, fade: 1 };
    const fr = [];
    for (let n = 0; n < 60 * 14 && l.fade > 0; n++) {
      l.age += DT;
      if (!l.landed) {
        l.vx += (-l.vx) * 1.6 * DT;
        l.vy += (60 * U - l.vy * 1.8) * DT;
        l.x += (l.vx + Math.sin(l.age * l.sw + l.ph) * 38 * U) * DT;
        l.y += (l.vy + Math.cos(l.age * l.sw * 2 + l.ph) * 12 * U) * DT;
        l.rot += (l.spin + Math.sin(l.age * l.sw + l.ph) * 2) * DT;
        if (l.y >= l.floor) { l.y = l.floor; l.landed = l.age || 0.001; }
      } else if (l.age - l.landed > 1.4) l.fade = Math.max(0, 1 - (l.age - l.landed - 1.4) / 0.8);
      fr.push([l.x, l.y, l.rot, l.landed ? 0.35 : Math.cos(l.age * l.flip + l.ph), l.fade]);
    }
    LEAVES.push({ s, col: COLS[i % COLS.length], fr });
  }
}
let leafMs = 0; for (const l of LEAVES) leafMs = Math.max(leafMs, l.fr.length * STEP);
leafMs = Math.min(leafMs, cfg.leafCapMs || 8000);
const total = t.gust + leafMs;
const leaf = (g, x, y, rot, fl, a, s, col) => {
  const w = s * 1.6, h = s;
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(fl, 1); g.globalAlpha = a;
  // border-radius 0 100% 0 100%: two opposite corners rounded fully
  g.beginPath(); g.ellipse(-w / 2, h / 2, w, h, 0, -Math.PI / 2, 0); g.ellipse(w / 2, -h / 2, w, h, 0, Math.PI / 2, Math.PI); g.closePath();
  g.fillStyle = col; g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = Math.max(1, 1.5 * U); g.beginPath(); g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2, h / 2); g.stroke();
  g.restore();
};
m.hold(t.gust, total, (e, S) => {
  const n = Math.floor(e / STEP);
  // a cap shorter than the slowest leaf fades whatever is still drifting over the last 900 ms
  const cap = Math.min(1, Math.max(0, (leafMs - e) / 900));
  S.world.push({ z: 70, draw: (g) => {
    for (const l of LEAVES) { const f = l.fr[n]; if (!f || f[4] <= 0) continue; leaf(g, f[0], f[1], f[2], f[3], f[4] * cap, l.s, l.col); }
  } });
});

// Signal the end the moment the caster is off-screen: BD then removes the token (leave_combat)
// while the leaves keep drifting, so the timeline teardown has no live token to show again.
let goneSignalled = false;
m.hold(t.gone, t.gone + 80, () => { if (!goneSignalled) { goneSignalled = true; oni.fireDone(); } });
await tl.run(T, { total: total + 60, sfx: cfg.sfx || [], onStart: K.ready });
oni.fireDone();
