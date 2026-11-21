// ── Lux Finis (spec luxfinis.md, default "Finis" style only): darkness + camera on the Priest, gold charge, suns over the
// targets, lances pin each one (each lance's Saint3 and flash on its brightest frame), then the three-way detonation (gate),
// white-out, camera punch, spark showers, afterglow. Full-takeover timeline (cfg.live === false): the camera is S.cam.
// A Zombie'd target (the real Zombie status) gets the bigger lance (x1.35), blast (x1.5) and shock ring (x1.5).
// Sync: clip peaks (cfg.vpeak, ms on the clip) and sound peaks (cfg.speak, ms into the sound): a sound cued on a clip
// starts at clipStart + vpeak - speak (mockup part-r4 sfxOn / cue).
const VP = cfg.vpeak || {}, SP = cfg.speak || {};
const sfxOn = (clipAt, vpk, key, v, rate) => S_(clipAt + Math.max(0, vpk - (SP[key] || 0) * (rate || 1)), key, v, rate);
const TG = FOES.slice(0, 3);
const zomOf = (k) => { const n = Number(k.slice(1)); return hasStatus(RAW[n], 'zombie'); };
const c = PARTY_C();
// ── camera keys (mockup FCAM.to: log-space zoom), REST = the whole stage ──
const REST = { cx: tl.REST.cx, cy: tl.REST.cy, z: 1 };
const CAMS = [];
const camTo = (at, ms, p, ease) => CAMS.push([at, ms, p, ease || X.sine]);
// Beat 1: Darkness falls: Saint1 (x.8), dim .72 + vignette .55 over 800, camera on the Priest x zoom over 900
S_(0, 'saint1', 0.4, 0.8);
const T1 = 900;
camTo(0, 900, { cx: kf.x + DIR * 120 * KP, cy: kf.y - hgtK('k') * 0.6, z: cfg.zoom });
// Beat 2: Gathering light: Saint4, gold glow, motes spiral into the tome for 'charge' ms; at 45% the Ray of Genesis cast
// + Magic3 + twinkles; at the end a warm flash, Saint3 and a flashActor on the Priest (which clears the glow)
const CH = cfg.charge;
S_(T1, 'saint4', 0.45); glowOn(T1, GOLD, 10);
const H0 = handAt(0);
for (let e = 0; e < CH; e += 45) for (let i = 0; i < 3; i++) { const an = rnd(0, 6.28), r = rnd(90, 220) * KP; homing(T1 + e, { x: H0.x + Math.cos(an) * r, y: H0.y + Math.sin(an) * r * 0.7 }, H0, GOLD, { ms: rnd(500, 800), arc: 60, r: rnd(2, 4) }); }
const CAST = T1 + CH * 0.45;
fx('ro_new_rayofgenesis_cast', CAST, H0, { scale: 0.55, filter: cfg.goldF, z: 6001 });
S_(CAST, 'magic3', 0.4); twinkles(CAST, H0, { n: 10, r: 60, rgb: GOLD });
const T3 = CAST + CH * 0.55;
flashC(T3, '#fff3c8', 0.5, 40, 280); S_(T3, 'saint3', 0.45); flashActor(T3, '#fff2c0', 300);
// Beat 3: The sky opens: camera to the party (x1.08), a sun (pixelfx lux pillar) over each target 140 ms apart, Saint1 (x1.2)
camTo(T3, 650, { cx: c.x - DIR * 40 * KP, cy: c.y - 120 * KP, z: 1.08 });
TG.forEach((k, i) => pxClip('pxfx_nox_luxpillar', T3 + i * 140, ftOf(k), { scale: sOf(k) * 1.9, z: 1000 }));
const T4 = T3 + TG.length * 140 + 520;
S_(T4 - 520, 'saint1', 0.4, 1.2);
// Beat 4: Lances of light: gold stars fall; per target an Adoramus lance, the Judex hammer on the lance's peak - Judex peak,
// and on the lance's peak: Saint3 (peak-aligned), a flash, a shake, a gold floor ring. Then the pin: rumble, Saint4, 30 motes.
if (cfg.stars > 0) pxClip('pxfx_nox_goldstarfall', T4, { x: c.x + DIR * 20 * KP, y: c.y + 10 * KP }, { scale: cfg.stars, z: 5900 });
const GAP = Math.max(150, cfg.gap * 0.65);
TG.forEach((k, i) => { const at = T4 + i * GAP, zom = zomOf(k), sc = sOf(k) * cfg.lance * (zom ? 1.35 : 1), f = ftOf(k);
  fx('ro_new_adoramus', at, f, { scale: sc * 0.45, filter: cfg.goldF, z: 1006 });
  sfxOn(at, VP.ro_new_adoramus, 'saint3', 0.45);
  fx('ro_new_judex_target', at + VP.ro_new_adoramus - VP.ro_new_judex_target, f, { scale: sc * 0.3, filter: cfg.goldF, z: 1008 });
  const pk = at + VP.ro_new_adoramus;
  flashC(pk, '#fff6d0', 0.22, 30, 160); shake(pk, 5, 160); ring(pk, f, { rgb: GOLD, r0: 20, r1: 90 * sOf(k), ms: 500, w: 4 }); });
const PIN = T4 + TG.length * GAP + 250;
const T5 = PIN + cfg.pin;
rumble(PIN, T5, 3); S_(PIN, 'saint4', 0.45);
for (let i = 0; i < 30; i++) { const an = rnd(0, 6.28), r = rnd(160, 320) * KP; homing(PIN, { x: c.x + Math.cos(an) * r, y: c.y - 60 * KP + Math.sin(an) * r * 0.5 }, { x: c.x, y: c.y - 60 * KP }, GOLD, { ms: 700, arc: 40, r: 3 }); }
// Beat 5: Detonation: on each target the solar burst (pixelfx), the GG starburst and the JB2A radiant blast (screen), one
// GG shard burst over the party; sounds on the burst's clock; the camera punches in 40 ms before its peak, the white-out
// reaches .9 on the peak = the damage gate.
const B = cfg.boom;
TG.forEach((k) => { const zom = zomOf(k), kk = sOf(k) * B * (zom ? 1.5 : 1), mid = centerOf(k);
  pxClip('pxfx_nox_solarburst', T5, ftOf(k), { scale: kk * 0.9, z: 1009 });
  fx('gg_burst_anim02', T5, mid, { scale: kk * 0.75, filter: cfg.goldF, z: 6100 });
  fx('jb_expl03', T5, mid, { scale: kk * 1.25, filter: 'sepia(.6) saturate(2) hue-rotate(-10deg) brightness(1.15)', blend: 'screen', z: 6050 }); });
fx('gg_burst_anim05', T5, { x: c.x, y: c.y - 60 * KP }, { scale: 2.2 * B / 1.6, filter: cfg.goldF, z: 6150 });
sfxOn(T5, VP.pxfx_nox_solarburst, 'saint5', 0.6); sfxOn(T5, VP.jb_expl03, 'flash2', 0.5); sfxOn(T5, VP.pxfx_nox_solarburst, 'break', 0.35);
const PUNCH = T5 + VP.pxfx_nox_solarburst - 40, GATE = PUNCH + 40;
camTo(PUNCH, 60, { cx: c.x - DIR * 20 * KP, cy: c.y - 100 * KP, z: 1.2 }, X.outCubic);
const WOUT = GATE + 160, WEND = WOUT + 520;
whiteTrack(tw(0, [[PUNCH, 40, 0.9, X.sine], [WOUT, 520, 0, X.sine]]), WEND + 20);
// the blast lands: one contact (all targets at once), shock rings, a shake, 60 gold sparks, the gold spark showers
once(GATE, () => oni.hit());
TG.forEach((k) => { const zom = zomOf(k); ring(GATE, ftOf(k), { rgb: GOLD, r0: 30, r1: 260 * sOf(k) * (zom ? 1.5 : 1), ms: 650, w: 8 }); });
shake(GATE, 20, 520);
ring(GATE, c, { rgb: '255,245,210', r0: 40, r1: 1000, ms: 800, w: 12 });
ring(GATE, c, { layer: 'field', rgb: GOLD, r0: 40, r1: 1200, ms: 900, sy: 0.5, w: 6 });
for (let i = 0; i < 60; i++) { const an = rnd(Math.PI, Math.PI * 2), r = rnd(1.5, 3.5);
  part({ t0: GATE, life: rnd(700, 1300), x: c.x + rnd(-200, 200) * KP, y: c.y - rnd(0, 80) * KP, vx: Math.cos(an) * rnd(0.2, 0.6), vy: Math.sin(an) * rnd(0.3, 0.8), g: 0.0012, drag: 0.98, layer: 'hit',
    draw: (g, x, y, u) => glw(g, x, y, r * 4 * KP, GOLD, 1 - u) }); }
if (cfg.fw > 0) TG.forEach((k) => pxClip('pxfx_nox_goldfirework', GATE, { x: OXk(k), y: OYk(k) - hgtK(k) * 0.6 }, { scale: sOf(k) * cfg.fw * 0.7, z: 6200 }));
camTo(WEND, 400, { cx: c.x - DIR * 40 * KP, cy: c.y - 120 * KP, z: 1.08 });
// Beat 6: Afterglow: 40 gold embers drift down; camera home, dim + vignette out over 900. Opportunity Blind: not shown here
// (it is decided by the roll after the gate; the game shows the Blind status itself).
const T6 = WEND + 400 + 700;
for (let i = 0; i < 40; i++) { const r = rnd(1.5, 3.2);
  part({ t0: T6, life: rnd(1200, 2000), x: c.x + rnd(-260, 260) * KP, y: c.y - rnd(150, 420) * KP, vy: rnd(0.03, 0.07), vx: rnd(-0.01, 0.01), layer: 'hit',
    draw: (g, x, y, u) => glw(g, x, y, r * 4 * KP, GOLD, 0.8 * Math.sin(u * Math.PI)) }); }
camTo(T6, 900, { cx: REST.cx, cy: REST.cy, z: 1 });
dimTrack(tw(0, [[0, 800, 0.72, X.sine], [T6, 900, 0, X.sine]]), T6 + 900);
vignetteTrack(tw(0, [[0, 800, 0.55, X.sine], [T6, 900, 0, X.sine]]), T6 + 900);
glowOff(T6);
const END = Math.max(T6 + 1000, GATE + (CL.pxfx_nox_goldfirework_front ? CL.pxfx_nox_goldfirework_front.dur : 0), T6 + 2000);
// camera: each key eases from wherever the camera is when it starts
CAMS.sort((a, b) => a[0] - b[0]);
const camX = tw(REST.cx, CAMS.map((k) => [k[0], k[1], k[2].cx, k[3]]));
const camY = tw(REST.cy, CAMS.map((k) => [k[0], k[1], k[2].cy, k[3]]));
const camZ = tw(0, CAMS.map((k) => [k[0], k[1], Math.log(k[2].z), k[3]]));
m.hold(0, END, (t, S) => { S.cam = { cx: camX(t), cy: camY(t), zoom: Math.exp(camZ(t)) }; });
await runShot(END, GATE);
