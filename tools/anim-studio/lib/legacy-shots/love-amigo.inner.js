// Love: Come! My Amigo! (inner script). Port of the approved Legacy boss mockup (part-b3.js "amigo").
// The SUMMON LOGIC is untouched and runs in the outer script (legacy-love-signatures.js, amigoLogic):
// it creates the three hidden tokens + combatants before this plays and passes them in cfg.spawn
// [{ id, src, cx, cy, boxH, artH, flipX }]. Here: he points, the three bandits run in from off-screen
// (behind him) to their real spots with dust and a hop on arrival. The outer reveals each real token
// (hidden: false + the arrival chat card) at cfg.t.arrive[i], the frame its runner arrives.
// A summon is the real token when this client can draw it (GM), else a virtual copy of its art placed
// where the 3D stage draws its feet. Each copy stays painted to the end so the reveal never pops.
if (!caster) { K.ready(); oni.fireDone(); return; }
const t = cfg.t || {}; const SP = Array.isArray(cfg.spawn) ? cfg.spawn : [];
const SIDES = LV.sides();
// gate: the last runner's arrival hop is done (mockup markGate), or just the call when nobody came
const GATE = SP.length ? t.call + (SP.length - 1) * 180 + 650 + 320 : t.call + 160;
const extra = {}; const SK = [];
SP.forEach((sp, i) => {
  const k = 's' + i; SK.push(k);
  const tok = canvas.tokens && canvas.tokens.get ? canvas.tokens.get(sp.id) : null;
  const tex = tok && tok.mesh && tok.mesh.texture;
  const ok = tok && tok.visible && tex && tex.valid && tex.baseTexture && tex.baseTexture.resource && tex.baseTexture.resource.source;
  if (ok) { extra[k] = { token: tok }; return; }
  let p = null; try { p = oni.depthAt({ x: sp.cx, y: sp.cy + sp.boxH / 2 }); } catch (e) { p = null; }
  const s = p ? p.s : 1, fx = p ? p.x : sp.cx, fy = p ? p.y : sp.cy + sp.boxH / 2;
  extra[k] = { virtual: true, art: sp.src, x: fx, y: fy - (sp.boxH / 2) * s, h: sp.artH * s, flip: sp.flipX ? -1 : 1, hidden: false, name: sp.name || k };
});
const { tl, T, m, TOK } = await boot(extra);
LV.init(tl, TOK, SIDES.foes);
const U = LV.U, DIR = LV.DIR;
const FX = LV.layer(m, 3);
// the off-screen edge behind him (the mockup's x = -80 on a 1682 px stage)
const CV = tl.camView(tl.makeState());
const KS = (CV.right - CV.left) / 1682;
const edgeX = DIR > 0 ? CV.left - 80 * KS : CV.right + 80 * KS;

// he points (lean toward the party), shouts
LV.keys(m, 'c', 'rot', [[0, 0], [160, 8, 'outQ'], [GATE, 8], [GATE + 160, 0, 'outQ']]);
LV.S(160, 'monster1', 0.4);
const total = GATE + 300;
SK.forEach((k, i) => {
  if (!TOK[k]) return;
  const RUN = t.call + i * 180, ARR = RUN + 650;
  const home = tl.feet(TOK[k]); const dx0 = edgeX - TOK[k].x;
  // not there before its run; painted (alpha 0.999 keeps it a painted copy) from the run to the end
  m.hold(0, RUN, (e, S) => { S.tok[k].hidden = true; });
  m.hold(RUN, total + 50, (e, S) => { S.tok[k].alpha = 0.999; });
  LV.S(RUN, 'move1', 0.3);
  // moveActor(a, home, 650, EASE.out, { hop: 10 })
  m.hold(RUN, ARR, (e, S) => { const u = Math.min(1, e / 650); const q = S.tok[k]; q.dx += dx0 * (1 - tl.E.outQ(u)); q.air += Math.sin(u * Math.PI) * 10 * U; });
  LV.dust(FX, ARR, home, 6, 1);
  LV.keys(m, k, 'air', LV.hopKeys(ARR, 22, 1));
});
LV.gate(m, GATE);
await tl.run(T, { total, sfx: LV.sfx, onStart: K.ready });
oni.fireDone();
