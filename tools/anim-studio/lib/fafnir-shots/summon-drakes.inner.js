// Summon Elemental Drake — engine placement (inner script, every client). Port
// of the mockup: a fire pillar rises on the near spot and a comet falls on the
// far one; the Flame Drake walks rightward out from behind her body in three
// heavy strides, the Lightning Drake flies in from the upper left on a curve,
// overshoots and snaps back; both seated at 2.4 s where the engine then creates
// the real tokens (gate). The spots are the ENGINE's: the caster-front anchor
// (one 1.15-cell step toward the stage centre) fanned the way
// spawnLiveDirectorTokens fans, skipping occupied cells — so the stand-in and
// the token that replaces it always agree.
const cfg = ctx.params.cfg || {};
const A = ctx.params.assets || {};
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }

// ── the engine's spots ──
const sceneDoc = caster.scene || caster.document?.parent || canvas.scene;
const grid = sceneDoc?.grid?.size ?? 100;
const stage = (globalThis.FUCompanion?.api?.camera?.stageOf?.(sceneDoc)) || { x: 0, y: 0, w: canvas.dimensions.width, h: canvas.dimensions.height };
const cd = caster.document;
const casterCx = cd.x + (cd.width ?? 1) * grid / 2, casterCy = cd.y + (cd.height ?? 1) * grid / 2;
const towardCenter = (stage.x + stage.w / 2) >= casterCx ? 1 : -1;
// the engine clears the caster's RENDERED sprite (skill-effects.js summon anchor)
const meshW = Number(caster.mesh?.width) || (cd.width ?? 1) * grid;
const clear = Math.max(grid * 1.15, meshW / 2 + grid * 0.65);
const anchor = { x: casterCx + towardCenter * clear, y: casterCy };
const step = grid * 1.15;
const fanDir = anchor.x <= stage.x + stage.w / 2 ? 1 : -1;
const occupied = (sceneDoc?.tokens?.contents ?? []).map((t) => ({ x: t.x + ((t.width ?? 1) * grid) / 2, y: t.y + ((t.height ?? 1) * grid) / 2 }));
const freeCell = () => {
  for (let col = 0; col < 5; col++) for (let row = 0; row < 8; row++) {
    const x = Math.round(anchor.x) + col * step * fanDir, y = Math.round(anchor.y) + row * step;
    if (x < stage.x + grid || x > stage.x + stage.w - grid || y > stage.y + stage.h - grid) continue;
    if (occupied.some((o) => Math.abs(o.x - x) < grid * 0.7 && Math.abs(o.y - y) < grid * 0.7)) continue;
    occupied.push({ x, y }); return { x, y };
  }
  const f = { x: Math.round(anchor.x), y: Math.min(stage.y + stage.h - grid, Math.round(anchor.y)) }; occupied.push(f); return f;
};
// the drakes' token sizes from their prototype tokens (width cells × grid × texture scale), facing the party like a spawned enemy
const protoSize = async (uuid, fallbackW) => { try { const a = await fromUuid(uuid); const p = a?.prototypeToken; if (!p) return { w: fallbackW, flip: -1 }; const sx = Math.abs(Number(p.texture?.scaleX) || 1); return { w: (p.width ?? 1) * grid * sx, flip: -1 }; } catch (e) { return { w: fallbackW, flip: -1 }; } };
const fdS = await protoSize(cfg.fireDrakeActor, 215), bdS = await protoSize(cfg.boltDrakeActor, 120);
const spotF = freeCell(), spotB = freeCell();

const tokens = { faf: { token: caster, art: A.casterArt || null, shadow: A.casterShadow || null, foot: cfg.casterFoot || 0.905, nativeDir: -1, hurt: null },
  fdrake: { virtual: true, art: A.fireDrake, x: spotF.x, y: spotF.y, w: fdS.w, flip: fdS.flip, foot: 0.95, name: 'Flame Drake', hidden: true },
  bdrake: { virtual: true, art: A.boltDrake, x: spotB.x, y: spotB.y, w: bdS.w, flip: bdS.flip, foot: 0.95, name: 'Lightning Drake', hidden: true } };
const tl = oni.timeline({ tokens, clips: A.clips || {} });
await tl.load();
const E = tl.E, seg = tl.seg, lerp = tl.lerp;
const TOK = tl.TOK, feet = tl.feet, STAGE = tl.STAGE;
const T = []; const m = tl.mk(T);
const Fd = TOK.fdrake, Bd = TOK.bdrake; const ffd = feet(Fd), fbd = feet(Bd);
const inDir = fanDir; // the drakes arrive from her side and settle toward the centre

m.clip('firepillar', 0, { x: ffd.x, y: ffd.y, w: 420, z: 4 }); m.clip('comet', 300, { x: fbd.x, y: fbd.y, w: 420, z: 4 }); m.beat(0, 'heralds');
m.hold(500, 1e9, (tl2, S) => { S.tok.fdrake.hidden = false; S.tok.bdrake.hidden = false; });
const fromX = Fd.x - Fd.w * 1.6 * inDir; m.beat(500, 'walk + fly');
m.hold(500, 1910, (tl2, S) => { const stepMs = 300, settle = 170; let x = fromX, bob = 0; let t = tl2; let p = 0; for (let i = 0; i < 3; i++) { if (t < stepMs) { const v = E.outQ(t / stepMs); p = (i + v) / 3; bob = -Math.sin(v * Math.PI) * Fd.w * 0.05; break; } t -= stepMs; p = (i + 1) / 3; if (i < 2) { if (t < settle) { bob = Math.sin(t / settle * Math.PI) * Fd.w * 0.012; break; } t -= settle; } } x = lerp(fromX, Fd.x, p); S.tok.fdrake.dx = x - Fd.x; S.tok.fdrake.dy = bob; S.tok.fdrake.alpha = seg(tl2, 0, 420); });
const bFrom = { x: inDir > 0 ? STAGE.x + 40 : STAGE.x + STAGE.w - 40, y: STAGE.y + 60 }, over = { x: Bd.x + Bd.w * 0.16 * inDir, y: Bd.y - Bd.w * 0.05 }, ctrl = { x: bFrom.x + (over.x - bFrom.x) * 0.72, y: bFrom.y - Math.abs(over.y - bFrom.y) * 0.35 };
m.hold(500, 2130, (tl2, S) => { let x, y, rot; if (tl2 < 1250) { const v = E.ioQ(tl2 / 1250), u = 1 - v; x = u * u * bFrom.x + 2 * u * v * ctrl.x + v * v * over.x; y = u * u * bFrom.y + 2 * u * v * ctrl.y + v * v * over.y; rot = 14 * (1 - v); } else { const v = E.outQ((tl2 - 1250) / 380); x = lerp(over.x, Bd.x, v); y = lerp(over.y, Bd.y, v); rot = 14 * 0.35 * (1 - v); } S.tok.bdrake.dx = x - Bd.x; S.tok.bdrake.dy = y - Bd.y; S.tok.bdrake.rot = -rot * Math.PI / 180 * inDir; S.tok.bdrake.alpha = seg(tl2, 0, 520); S.tok.bdrake.noShadow = tl2 < 1500; });
m.beat(2400, 'seated · summon resolves');

await tl.run(T, { total: cfg.totalMs || 3800, sfx: cfg.sfx || [], onStart: () => { const h = ctx.params.readyHook; if (h) { try { Hooks.callAll(h); } catch (e) {} } } });
oni.fireDone();
