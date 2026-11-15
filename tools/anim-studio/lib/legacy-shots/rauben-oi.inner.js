// Rauben · Oi! Come help me now! (inner script, every client).
// Port of the approved legacy-boss mockup ("oi" def, part-b3.js): he shouts, each summoned bandit runs in from
// off-screen behind him and hops on arrival. The summon itself is the shipped logic and runs in the OUTER script
// (acting client): it creates the tokens hidden, adds them to the combat, and reveals each one when this shot
// lands it (cfg.t.reveal). Here the real (still hidden) tokens are painted while they run in; each stays painted
// until its token is revealed, so there is no gap and no double. LIVE board, camera untouched. No backticks.
if (!caster) { readyHook(); oni.fireDone(); return; }
const SUM = Array.isArray(ctx.params.summons) ? ctx.params.summons : [];
// the summoned tokens were created just before this shot was sent: wait (briefly) for their placeables
const tokOf = (u) => { try { const d = fromUuidSync(u); return (d && d.object) || null; } catch (e) { return null; } };
for (let i = 0; i < 40 && SUM.some((s) => !tokOf(s.uuid)); i++) await wait(50);
const tokens = { k: { token: caster, foot: cfg.casterFoot } };
const SK = [];
SUM.forEach((s, i) => { const t = tokOf(s.uuid); if (!t) return; const k = 's' + i; SK.push({ k, i, uuid: s.uuid, token: t }); tokens[k] = { token: t, art: s.art || undefined }; });
const tl = oni.timeline({ tokens, clips: {}, images: {}, live: true, depthRef: 'k' });
await tl.load();
const T = [];
const RK = RKit(tl, T);
const E = tl.E, seg = tl.seg, lerp = tl.lerp, TOK = tl.TOK, feet = tl.feet;
const KP = RK.KP, m = RK.m;
const K = TOK.k, kf = feet(K);
const C = cfg.t;
// the party's side (the summons are placed toward it, as the shipped formation does)
let DIR = 1;
{ const disp = Number(caster.document && caster.document.disposition) || 0;
  const o = ((canvas.tokens && canvas.tokens.placeables) || []).find((t) => t && t.actor && t.visible && !(t.document && t.document.hidden) && Number(t.document.disposition) !== disp);
  if (o) DIR = o.center.x >= caster.center.x ? 1 : -1; }
const lean = (deg) => deg * DIR * Math.PI / 180;

// ── shout: he rears back, Monster1, settles ──
m.hold(0, C.shoutEnd, (t, S) => { const d = S.tok.k; d.rot = lean(t < 160 ? -8 * E.outQ(seg(t, 0, 160)) : -8 * (1 - E.outQ(seg(t, 160, 320)))); });
RK.snd(160, 'monster1', 0.5);

// ── each summon runs in from off-screen behind him, one arc on the way, a dust puff, a hop ──
const ed = RK.edges();
SK.forEach((s) => {
  const Tk = TOK[s.k]; if (!Tk) return; const f = feet(Tk);
  const RUN = C.run0 + s.i * cfg.stagger, ARR = RUN + cfg.runMs, HOP = ARR + 170 + 150;
  const x0 = DIR > 0 ? ed.left - Tk.w * 0.6 : ed.right + Tk.w * 0.6;
  const shown = () => { const t = tokOf(s.uuid); return !!(t && t.document && !t.document.hidden); };
  RK.snd(RUN, 'move1', 0.35);
  m.hold(0, 1e9, (t, S) => {
    const d = S.tok[s.k]; if (!d) return;
    if (t < RUN) { d.hidden = true; return; }
    if (t < ARR) { const e = E.outQ(seg(t, RUN, ARR)); d.dx = lerp(x0 - f.x, 0, e); d.air = Math.sin(e * Math.PI) * cfg.runHop * KP; return; }
    if (t < HOP) { d.air = t < ARR + 170 ? cfg.hop * KP * E.outC(seg(t, ARR, ARR + 170)) : cfg.hop * KP * (1 - E.inQ(seg(t, ARR + 170, HOP))); d.dx = 0.0001; return; }
    // landed: keep painting it until its real token is revealed on this client
    if (!shown()) d.dx = 0.0001;
  });
  RK.dust(ARR, f, 6, tl.depthRatio(kf, f), null, 4);
});
const last = SK.length ? C.run0 + (SK.length - 1) * cfg.stagger + cfg.runMs + 320 : C.shoutEnd;
const total = last + cfg.tail;
RK.once(last, () => oni.fireDone());
await tl.run(T, { total, onStart: readyHook });
oni.fireDone();
