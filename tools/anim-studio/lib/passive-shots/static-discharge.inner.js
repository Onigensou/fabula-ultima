// Skizzik · Static Buildup discharge (inner script, every client). Approved mockup:
// claude.ai/artifact/GmHAYWhV8rCRHVigfTc4bw. Plays on the THIRD charge, from the passive's own chain
// (play_animation before the 30 Bolt).
// Beats: the two-ball orbit (charge-orbit-fx.js, hidden while this plays) becomes three balls spinning
// faster at Skizzik's waist (pxfx_bolt_static_orbit3) | the three balls fly to the victim on arcs,
// rescaled by depth along the way | they whirl in round the victim and blow (pxfx_bolt_static_burst);
// the damage gate fires as they meet (cfg.burstImpactMs into the burst).
// The orbit spin runs while the charge cue is hidden; the charge itself is cleared by the chain after the hit.
// No backticks and no dollar-brace in this file.
const cfg = ctx.params.cfg || {};
const caster = ctx.casterToken;
const target = (ctx.targetTokens || []).filter((t) => t && t.center)[0] || null;
if (!caster || !target) { oni.fireDone(); return; }

// Where a body is DRAWN (3D stage aware): feet, height, the camera scale m.
const drawn = (t) => {
  const st = globalThis.__ONI_BATTLE_STAGE_3D__;
  const b = st && st.drawnMeshBounds ? st.drawnMeshBounds(t) : null;
  const meshH = Math.abs((t.mesh && t.mesh.height) || t.h || 100);
  if (b && Number.isFinite(b.x)) {
    const W = canvas.stage.worldTransform;
    const feet = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y + b.height));
    const top = W.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y));
    return { feet: feet, h: feet.y - top.y, meshH: meshH, m: b.width / Math.abs(t.mesh.width || b.width) };
  }
  return { feet: { x: t.center.x, y: t.y + t.h }, h: meshH, meshH: meshH, m: 1 };
};
const A = drawn(caster), B = drawn(target);
// clip px -> world px for each body (the clips were drawn around bodies cfg.casterBodyPx / cfg.victimBodyPx tall)
const kA = A.meshH / cfg.casterBodyPx, kB = B.meshH / cfg.victimBodyPx;
const sA = kA * A.m, sB = kB * B.m;     // drawn world px per clip px

// 1. Three balls spin up at the waist.
oni.sfx(cfg.sfxCharge, { volume: cfg.volume * cfg.sfxChargeVol });
const spin = await oni.pxfx(cfg.orbit3, { token: caster, k: kA });
await oni.wait(cfg.spinMs);
const phase = performance.now() / 1000 * cfg.spinTurnsPerSec * Math.PI * 2;
if (spin) for (const f of spin.parts) { try { f.video.pause(); f.sprite.destroy(); } catch (e) {} }

// 2. They fly to the victim: each from its spot on Skizzik's orbit to the matching spot on the victim's.
oni.sfx(cfg.sfxFly, { volume: cfg.volume * cfg.sfxFlyVol });
const flights = [0, 1, 2].map(async (i) => {
  const ang = phase + i * Math.PI * 2 / 3 + 0.4;
  const p0 = { x: A.feet.x + Math.cos(ang) * cfg.orbitRx * sA, y: A.feet.y + (cfg.orbitCy + Math.sin(ang) * cfg.orbitRy) * sA };
  const p1 = { x: B.feet.x + Math.cos(ang) * cfg.burstRx * sB, y: B.feet.y + (cfg.burstCy + Math.sin(ang) * cfg.burstRy) * sB };
  await oni.wait(i * cfg.staggerMs);
  const ball = await oni.pxfx(cfg.ball, { x: p0.x, y: p0.y, k: kA * A.m, layers: ['front', 'light'] });
  if (!ball) return;
  for (const f of ball.parts) { try { f.video.loop = true; } catch (e) {} }
  const arc = (cfg.arcPx + i * cfg.arcStepPx) * (sA + sB) / 2;
  const w0 = ball.parts[0] ? ball.parts[0].sprite.width : 0;
  await oni.tween({ duration: cfg.flyMs, ease: (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2), onUpdate: (u) => {
    const x = p0.x + (p1.x - p0.x) * u, y = p0.y + (p1.y - p0.y) * u - Math.sin(u * Math.PI) * arc;
    const sc = (sA + (sB - sA) * u) / sA;
    for (const f of ball.parts) { f.sprite.position.set(x, y); if (w0) { const r = f.sprite.height / (f.sprite.width || 1); f.sprite.width = w0 * sc; f.sprite.height = w0 * sc * r; } }
  } });
  for (const f of ball.parts) { try { f.video.loop = false; f.video.pause(); f.sprite.destroy(); } catch (e) {} }
});
await oni.wait(cfg.flyMs + 2 * cfg.staggerMs - cfg.burstLeadMs);

// 3. The burst on the victim; damage as the balls meet.
const burst = await oni.pxfx(cfg.burst, { token: target, k: kB });
await Promise.all(flights);
await oni.wait(Math.max(0, cfg.burstImpactMs - cfg.burstLeadMs));
oni.sfx(cfg.sfxBlow, { volume: cfg.volume * cfg.sfxBlowVol });
oni.hit();
oni.fireDone();
await oni.hitstop(cfg.hitstopMs);
if (burst && burst.ended) await burst.ended;
