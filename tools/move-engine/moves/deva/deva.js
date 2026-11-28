// ═════════ Deva · every action, move-engine port of the Deva animation mockup v16 (2026-11-09) — same beats, numbers
// and sounds; host changes only (beat clock, seeded rolls, page options → TO() selects, PARTY → the host's targets).
// status "approved" = v1, approved 2026-11-09 (frozen). Fists of Fury / Focus = SHIPPED v1.0.575 (reference).
const FACING = { id: "facing", re: "Deva's sprite is flipped / on the wrong side", text: "She now stands on the left facing RIGHT at the party, mirrored like every enemy token in Battle Director. Every glide, lean, blink and form swap keeps that facing." };
const FIST_ART = { id: "fist-art", re: "New Missile Fist art (your call)", text: "The fists are fist_red turned 90° counter-clockwise (pointing at the party, fingers over the top, no mirror) with an idle float bob, standing as two summoned tokens at in-game token size." };

// ───────── Guard round
def("slap", { boss: "guard", status: "approved", icon: "deva", name: "Double Slap", tag: "Attack · Multi (2) · Physical · Shaken", changes: [],
  intro: "Filler attack for her Guard rounds. She glides across the field, backhands the first target and forehands the second. Each target spins comically on impact, then wobbles back into place.",
  rules: "Damage is a stand-in. The spin uses the target's own 8-direction walk sprites when the token has them; tokens without them (Hina here) get the Paper Mario flip.",
  tune: [T("glide", "Glide to target (ms)", 650, 300, 1400, 50), T("windup", "Slap wind-up (ms)", 220, 80, 600, 20), T("spinTurns", "Spin turns", 2, 1, 4, 1),
    T("spinStep", "Spin frame (ms)", 55, 30, 140, 5), T("spinHop", "Spin hop (px)", 16, 0, 60, 2), T("trail", "Afterimages (0 = off)", 1, 0, 1, 1),
    T("dmgA", "Backhand damage (stand-in)", 32, 1, 99, 1), T("dmgB", "Forehand damage (stand-in)", 29, 1, 99, 1),
    TO("pair", "Targets (page only; the game uses the action's two targets)", ["Keren + Zarg", "Hina + Blanche", "Zarg + Blanche"], 0),
    TO("spin", "Spin", ["8-direction sprites (fallback flip)", "Paper Mario flip for everyone"], 0)],
  beats: [
    { name: "Haughty rise", note: "lifts off the floor, chin up", run: async (C) => { const D = DV(); sfx("manto", .4); await moveActor(D, D.x, D.y, 420, EASE.sine, { hop: 14 }); } },
    { name: "Glide to the first target", note: "low hover, stance-tinted afterimages", run: async (C) => { const D = DV(), [a] = slapTargets(C); sfx("evasion", .45);
      await moveActor(D, a.x - (wid(a) * .55 + wid(D) * .35), a.y + 4, tv(C, "glide"), EASE.sine, { hop: 10, trail: tv(C, "trail") ? .14 : 0, hue: devaHue() }); } },
    { name: "Backhand", note: "slap, spin, Shaken", gate: true, run: async (C) => { const [a] = slapTargets(C); C.sp1 = await slapHit(a, C, { back: true, sound: "slapA", dmg: tv(C, "dmgA") }); } },
    { name: "Glide to the second target", note: "", run: async (C) => { const D = DV(), [, b] = slapTargets(C); sfx("evasion", .4);
      await moveActor(D, b.x - (wid(b) * .55 + wid(D) * .35), b.y + 4, tv(C, "glide") * .75, EASE.sine, { hop: 8, trail: tv(C, "trail") ? .16 : 0, hue: devaHue() }); } },
    { name: "Forehand", note: "slap, spin, Shaken", run: async (C) => { const [, b] = slapTargets(C); C.sp2 = await slapHit(b, C, { back: false, sound: "slapB", dmg: tv(C, "dmgB") }); } },
    { name: "Return", note: "glides home without looking back", run: async (C) => { const D = DV();
      await moveActor(D, D.x, D.y, tv(C, "glide") * 1.1, EASE.sine, { hop: 10, trail: tv(C, "trail") ? .2 : 0, hue: devaHue() });
      await Promise.all([C.sp1, C.sp2].filter(Boolean)); await wait(300); } },
  ] });
const SLAP_PAIRS = [["keren", "zarg"], ["hina", "blanche"], ["zarg", "blanche"]];
function slapTargets(C) { if (IN_GAME) { const t = DEVA_TARGETS(); return [t[0], t[1] || t[0]]; } return SLAP_PAIRS[tv(C, "pair")].map((k) => ACT[k]); }
async function slapHit(t, C, { back, sound, dmg }) {
  const D = DV(), dir = back ? -1 : 1;
  await lean(D, -10 * dir, tv(C, "windup"), EASE.out);          // wind-up: lean away
  sfx("swing", .5);
  await lean(D, 14 * dir, 70, EASE.in);                          // the snap
  if (back) markGate(); sfx(sound, .9); sfx("slapC", .35, 1.2);
  clip("001_hit_physical", center(t), { scale: t.s * 1.1, flip: back });
  clip("d4_flash_ring_white", center(t), { scale: 1.6 * t.s });
  flash("#fff", .18, 30, 120).catch(() => {}); shake(7, 260).catch(() => {});
  dmgNum(t.id, numAt(t), dmg, { element: "physical" }); flashActor(t, "#fff", 200).catch(() => {});
  slide(t, -face(t) * 26, 160).catch(() => {});                 // knocked a step back, then the spin
  const sp = spin(t, C).then(() => wobble(t)).then(() => slide(t, 0, 420, 0));
  await wait(260);
  clip("054_powerdown_1", feet(t), { scale: t.s * .9 }); sfx("down", .35); statusTag(t, "Shaken", GOLD);
  lean(D, 0, 380, EASE.sine).catch(() => {});
  return sp;
}

def("stance", { boss: "guard", status: "approved", icon: "deva", name: "Stance Change", tag: "Action · self · then a free action", changes: [],
  intro: "Her Guard-round roll lands on the other stance. The old glow drains out, a sigil of the new colour opens under her, and the new rim light washes up her body.",
  rules: "Plays from the stance picked below to the other one. It only happens when the roll changes her stance.",
  tune: [T("shift", "Colour wash (ms)", 700, 200, 1600, 50), T("ring", "Ring size", 2.2, 1, 4, .1), TO("from", "Stance she starts in", ["Vajra · gold", "Maya · violet"], 0)],
  beats: [
    { name: "The old stance fades", note: "rim glow drains", run: async (C) => { const D = DV(); DEVA_STATE.stance = STANCES[tv(C, "from")]; const s0 = STANCE[DEVA_STATE.stance];
      await tween(450, EASE.sine, (u) => D.media.style.filter = `${s0} brightness(${1.1 - u * .3}) saturate(${1 - u * .6})`); } },
    { name: "Shift", note: "sigil, ring, new rim light", gate: true, run: async (C) => {
      const D = DV(); markGate(); const next = STANCES[1 - tv(C, "from")]; const rgb = next === "vajra" ? GOLD : VIOLET; const hue = next === "vajra" ? 45 : 255;
      sfx(next === "vajra" ? "saint3" : "magic", .55); sfx("up", .35);
      clip("ro_efst_magiccircle__mc", feet(D), { scale: 1.7 * D.s, filter: tint(hue, 6, 1.2), blend: "screen", parent: $("fground") });
      clip("d4_flash_ring_white", center(D), { scale: tv(C, "ring") * D.s, filter: tint(hue, 5, 1.2) });
      for (let k = 0; k < 16; k++) ember("field", OX(D) + rnd(-40, 40), OY(D) - rnd(0, 30), rgb, { vy: rnd(-.18, -.08) });
      await tween(tv(C, "shift"), EASE.sine, (u) => D.media.style.filter = `${STANCE[next]} brightness(${.8 + u * .3}) saturate(${.4 + u * .6})`); DEVA_STATE.stance = next; } },
    { name: "Settle", note: "", run: async () => { await wait(700); } },
  ] });

// Standard form has no arms: a single energy hand forms for the blow
def("vajra", { boss: "guard", status: "approved", icon: "deva", name: "Vajra Fist", tag: "Attack · Physical · 45 · Vajra stance", changes: [],
  intro: "A gold energy fist burns into being at her side, draws back, and drives into one enemy. It dissolves back into gold motes.",
  rules: "Her Standard form has no arms, so the fist exists only for the blow; that keeps the Offense forms' arms special.",
  tune: [T("form", "Fist forms (ms)", 420, 150, 1200, 25), T("drive", "Drive (ms)", 240, 100, 700, 20), T("size", "Fist size (px)", 110, 60, 200, 5), T("dmg", "Damage (stand-in)", 45, 1, 99, 1)],
  beats: [
    { name: "Gold fist forms", note: "at her side", run: async (C) => { DEVA_STATE.stance = "vajra"; applyStance(); const p = handPt(1); C.f = energyFist("gold", p.x, p.y + 40, tv(C, "size"), -60); C.f.sx = C.f.sy = 0; C.f.apply();
      sfx("up", .4); motes({ x: p.x + 60, y: p.y - 40 }, { x: p.x, y: p.y }, GOLD, 10, 500); await grow(C.f, tv(C, "form")); } },
    { name: "Draw back", note: "", run: async (C) => { const f = C.f; const x0 = f.x; sfx("swing", .4); await tween(260, EASE.out, (u) => { f.x = x0 - 30 * u; f.rot = -60 - 30 * u; f.apply(); }); } },
    { name: "Drive", note: "45 Physical", gate: true, run: async (C) => { C.t = pick(DEVA_TARGETS()); await punch(C.f, C.t, tv(C, "drive")); markGate(); sfx("blowL", .9); sfx("blowA", .5);
      hitFx(C.t, tv(C, "dmg"), "physical", { tier: "strong", clipKey: "021_hit_special_1", scale: .55, filter: tint(45, 4, 1.2) }); shake(9, 300).catch(() => {}); flash("#fff", .15, 30, 140).catch(() => {}); } },
    { name: "Fist dissolves", note: "gold motes drift home", run: async (C) => { motes(propPt(C.f), handPt(1), GOLD, 8, 700); await dissolve(C.f); await wait(500); } },
  ] });
def("lance", { boss: "guard", status: "approved", icon: "deva", name: "Mudra Lance", tag: "Attack · Light · MDEF · 45 · Maya stance", changes: [],
  intro: "A violet energy hand rises beside her and forms a mudra; a lance of light leaves the palm and pierces one enemy.",
  rules: "The lance is a fast light streak (particles), not a drawn beam, and lands with the MV pierce effect tinted violet.",
  tune: [T("form", "Hand forms (ms)", 480, 150, 1200, 25), T("mudra", "Mudra hold (ms)", 500, 100, 1500, 50), T("lance", "Lance flight (ms)", 220, 80, 600, 20), T("dmg", "Damage (stand-in)", 45, 1, 99, 1)],
  beats: [
    { name: "Violet hand rises", note: "", run: async (C) => { DEVA_STATE.stance = "maya"; applyStance(); const p = handPt(1); C.f = energyFist("violet", p.x, p.y + 20, 100, 0); C.f.sx = C.f.sy = 0; C.f.apply();
      sfx("magic", .4); await Promise.all([grow(C.f, tv(C, "form")), C.f.move(p.x, p.y - 10, tv(C, "form"), EASE.sine)]); } },
    { name: "Mudra", note: "a sigil behind the hand", run: async (C) => { sfx("saint3", .45);
      clip("ro_efst_magiccircle__mc", propPt(C.f), { scale: 1.3, filter: tint(255, 6, 1.2), blend: "screen", rot: 90 }); clip("d4_flash_ring_white", propPt(C.f), { scale: 1.4, filter: tint(255, 5, 1.2) }); await wait(tv(C, "mudra")); } },
    { name: "Lance", note: "45 Light", gate: true, run: async (C) => { C.t = pick(DEVA_TARGETS()); const from = propPt(C.f), to = center(C.t); sfx("flash2", .6);
      for (let k = 0; k < 14; k++) homing("field", { x: from.x, y: from.y }, to, k % 3 ? VIOLET : "255,255,255", { ms: tv(C, "lance") * rnd(.9, 1.2), arc: 6, r: 5 });
      await wait(tv(C, "lance")); markGate(); sfx("saint", .5);
      hitFx(C.t, tv(C, "dmg"), "light", { clipKey: "027_pierce_special_2", scale: .45, filter: tint(255, 4, 1.25) }); flash("#e8dcff", .18, 30, 160).catch(() => {}); } },
    { name: "Hand fades", note: "", run: async (C) => { await dissolve(C.f, 500); await wait(500); } },
  ] });

// ───────── Missile Fist (summon, detonation, break)
const FIST_ANGLE = (C) => tv(C, "fistAngle");
def("fist", { boss: "fist", status: "approved", icon: "fistA", fists: true, name: "Missile Fist", tag: "Action · summons two Missile Fists", changes: [],
  intro: "She raises a hand and two fists burn into being at her shoulders, then rocket out to their spots on her side of the field and hover there, each showing its two-pip fuse.",
  rules: "The fists are summoned actors on her side. In the game they take their own turns: a pip drops on each, and they detonate on the turn after. Fuse pips are a stand-in for the summon's countdown display.",
  tune: [T("form", "Forming (ms)", 900, 300, 2000, 50), T("fly", "Flight to hover spot (ms)", 800, 300, 1800, 50), T("arc", "Flight arc height (px)", 110, 0, 240, 10), T("fistAngle", "Fist angle at rest (deg, 0 = at the party)", 0, -90, 90, 5)],
  beats: [
    { name: "Raise a hand", note: "red sigil under her feet", run: async (C) => { const D = DV(); fistsShow(false);
      sfx("up", .4); clip("ro_efst_magiccircle__mc", feet(D), { scale: 1.6 * D.s, filter: tint(5, 6, 1.2), blend: "screen", parent: $("fground") });
      await moveActor(D, D.x, D.y, 500, EASE.sine, { hop: 10 }); } },
    { name: "Fists burn into being", note: "embers gather at her shoulders", run: async (C) => { const D = DV(); const fs = FISTS(); fistsShow(true);
      fs.forEach((f, i) => { f.bob = false; f.lift = 0; f.rot = FIST_ANGLE(C); const sh = { x: OX(D) + (i ? 34 : -34), y: OY(D) - hgt(D) * .78 + 30 }; f.kx = f.ky = 0; f.s = tokenScaleAt(sh.y); setPos(f, sh.x - f.x, sh.y - f.y); });
      sfx("machine", .35); sfx("magic", .4);
      for (const f of fs) for (let k = 0; k < 18; k++) { const p = fistPt(f); homing("field", { x: p.x + rnd(-120, 120), y: p.y + rnd(-90, 90) }, p, RED, { ms: tv(C, "form") * .8, arc: 40, r: 3 }); }
      await tween(tv(C, "form"), EASE.outBack, (t) => fs.forEach((f) => { f.kx = f.ky = t; setPos(f, f.dx, f.dy); }));
      fs.forEach((f) => clip("d4_flash_ring_white", fistPt(f), { scale: 1.2, filter: tint(5, 5, 1.2) })); } },
    { name: "Launch", note: "they rocket out to their spots", gate: true, run: async (C) => {
      markGate(); sfx("launch", .7); sfx("wind", .35);
      await Promise.all(FISTS().map((f, i) => wait(i * 140).then(() => moveActor(f, f.x, f.y, tv(C, "fly"), EASE.quad, { hop: tv(C, "arc") }))));
      FISTS().forEach((f) => clip("gg_dashsmoke_anim01", { x: OX(f), y: OY(f) }, { scale: .25 })); } },
    { name: "Hover with the fuse", note: "two pips light up", run: async (C) => {
      FIST_BOB.t0 = performance.now(); FISTS().forEach((f) => { f.bob = true; });
      for (let k = 0; k < 2; k++) { sfx("tick", .5); FISTS().forEach((f) => { if (f.pips) f.pips[k].style.opacity = 1; }); await wait(260); }
      await wait(1200); } },
  ] });

// detonation: the fuse runs out, each fist rockets into a random enemy (in the game: each fist's own turn)
function fistsOnField(C) { fistsShow(true); FISTS().forEach((f) => { f.rot = FIST_ANGLE(C); f.bob = true; if (f.pips) f.pips[0].style.opacity = 1; setPos(f, 0, 0); }); FIST_BOB.t0 = performance.now(); }
def("boom", { boss: "fist", status: "approved", icon: "fistA", fists: true, name: "Missile Fist · detonation", tag: "Summon turn · 60 Physical to a random enemy", changes: [],
  intro: "The fuse runs out. The last pip flares, the fist shudders and turns to aim, then it rockets into a random enemy and explodes.",
  rules: "60 damage, no accuracy roll. Each fist picks its own random target; the second follows a beat behind the first.",
  tune: [T("fistAngle", "Fist angle at rest (deg, 0 = at the party)", 0, -90, 90, 5), T("aim", "Turn to aim (ms)", 520, 150, 1400, 25), T("rocket", "Rocket flight (ms)", 300, 120, 900, 20),
    T("boomScale", "Explosion size (%)", 100, 50, 200, 5), T("shakePx", "Screen shake (px)", 12, 0, 30, 1), T("dmg", "Blast damage", 60, 1, 120, 1)],
  beats: [
    { name: "Fists on the field", note: "one pip left", run: async (C) => { fistsOnField(C); await wait(700); } },
    { name: "Fuse runs out", note: "last pip flares, the fists shudder", run: async (C) => {
      sfx("tick", .6);
      await tween(500, EASE.in, (u) => FISTS().forEach((f) => { if (f.pips) { f.pips[0].style.transform = `scale(${1 + u * 1.4})`; f.pips[0].style.opacity = 1 - u * .2; } setPos(f, rndFx(-3, 3) * u, f.dy); }));
      FISTS().forEach((f) => { if (f.pips) f.pips[0].style.opacity = 0; setPos(f, 0, f.dy); if (f.media) f.media.style.filter = `drop-shadow(0 0 12px rgba(${RED},1)) brightness(1.5)`; }); } },
    { name: "Turn to aim", note: "each fist picks a random enemy", run: async (C) => {
      C.targets = FISTS().map(() => pick(DEVA_TARGETS())); sfx("machine", .3);
      await Promise.all(FISTS().map((f, i) => { const t = C.targets[i]; const p = fistPt(f), q = center(t); const ang = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI; const r0 = f.rot;
        return tween(tv(C, "aim"), EASE.outBack, (u) => { f.rot = lerp(r0, ang, u); setPos(f, f.dx, f.dy); }); })); } },
    { name: "Rocket in", note: "explosion, 60 each", gate: true, run: async (C) => {
      markGate(); await Promise.all(FISTS().map((f, i) => wait(i * 380).then(async () => {
        const t = C.targets[i]; const q = center(t); f.bob = false; sfx("launch", .55, 1.3);
        const y0 = OY(f) - (f.lift || 0); f.lift = 0; setPos(f, f.dx, y0 - f.y);
        await moveActor(f, q.x, q.y + hgt(f) * .5, tv(C, "rocket"), EASE.inCubic);
        f.gone = true; f.el.style.display = "none"; f.el.style.opacity = 0; sfx("explode", .9); sfx("explosion", .45);
        clip("ro_rl_explosion__boom", q, { scale: t.s * tv(C, "boomScale") / 100 }); clip("gg_explosion_anim01", q, { scale: .32 * t.s * tv(C, "boomScale") / 100, blend: "screen" });
        flash("#fff", .35, 30, 200).catch(() => {}); shake(tv(C, "shakePx"), 380).catch(() => {});
        dmgNum(t.id + i, numAt(t), tv(C, "dmg"), { element: "physical" }); hitReact(t, "strong"); }))); } },
    { name: "Smoke clears", note: "", run: async () => { await wait(1100); } },
  ] });

// break: the party cracks a fist (3 damaging hits), or one area attack cracks both
async function partyHitFx(f) { sfx("crack", .7); clip("001_hit_physical", fistPt(f), { scale: .8 }); f.hits = (f.hits || 0) + 1; drawCracks(f);
  if (f.media) { f.media.style.filter = `drop-shadow(0 0 6px rgba(${RED},.9)) brightness(1.8)`; const h = f.hits; wait(120).then(() => { if (!f.gone) f.media.style.filter = `drop-shadow(0 0 6px rgba(${RED},.9)) brightness(${1 - h * .08})`; }, 120 / SPEED); }
  await tween(240, EASE.lin, (u) => setPos(f, Math.sin(u * Math.PI * 6) * 6 * (1 - u), f.dy)); setPos(f, 0, f.dy); }
async function shatter(f, C) { f.gone = true; sfx("break", .9); sfx("crash", .35);
  const p = fistPt(f); flash("#fff", .25, 30, 160).catch(() => {}); clip("gg_burst_anim02", p, { scale: .32, blend: "screen", filter: tint(5, 6, 1.2) });
  shards("field", p, "255,120,90", tv(C, "shards"), .55); shards("field", p, "255,230,200", Math.round(tv(C, "shards") / 2), .4);
  await tween(160, EASE.in, (u) => { f.kx = f.ky = 1 + .3 * u; f.el.style.opacity = String(1 - u); setPos(f, f.dx, f.dy); }); f.el.style.display = "none"; }
const breakSet = (C) => (tv(C, "by") === 0 ? FISTS() : FISTS().slice(0, 1));
def("brk", { boss: "fist", status: "approved", icon: "fistA", fists: true, name: "Missile Fist · break", tag: "Party breaks it · 3 damaging hits", changes: [],
  intro: "Each damaging hit cracks the fist a little more; the third shatters it into red shards before it can blow.",
  rules: "One area attack cracks both fists at once, which is the intended answer to Missile Fist; single-target hits crack one.",
  tune: [T("fistAngle", "Fist angle at rest (deg, 0 = at the party)", 0, -90, 90, 5), T("gap", "Gap between hits (ms)", 650, 200, 1500, 50), T("shards", "Shards", 22, 6, 50, 2),
    TO("by", "The party breaks it with", ["One area attack (both fists)", "Single-target hits (one fist)"], 0)],
  beats: [
    { name: "Fists on the field", note: "", run: async (C) => { fistsOnField(C); await wait(600); } },
    { name: "First hit", note: "a crack", run: async (C) => { await Promise.all(breakSet(C).map((f) => partyHitFx(f))); await wait(tv(C, "gap")); } },
    { name: "Second hit", note: "more cracks, the glow dims", run: async (C) => { await Promise.all(breakSet(C).map((f) => partyHitFx(f))); await wait(tv(C, "gap")); } },
    { name: "Third hit", note: "it shatters", gate: true, run: async (C) => { markGate(); const tg = breakSet(C);
      await Promise.all(tg.map((f) => partyHitFx(f))); await Promise.all(tg.map((f) => shatter(f, C))); await wait(900); } },
  ] });

// ───────── Offense round
def("form", { boss: "offense", status: "approved", icon: "deva", name: "Form Change", tag: "Round start · Fury or Focus", changes: [],
  intro: "At the top of an Offense round she gathers herself; the form's colour spirals in, then the halo snaps on and the giant arms swell out of her shoulders.",
  rules: "The arms and halo are the official in-game idle clips (Deva_Fury / Deva_Focus_Battle_Idle); the swell is a scale pop on the swap.",
  tune: [T("gather", "Gather (ms)", 900, 300, 2000, 50), T("pop", "Swell (ms)", 420, 150, 1000, 20), TO("form", "Form", ["Fury · Strike Form (red)", "Focus · Magic Form (blue)"], 0)],
  beats: [
    { name: "Gather", note: "the form colour spirals in", run: async (C) => { const D = DV(), form = ["fury", "focus"][tv(C, "form")], rgb = formRgb(form); sfx("magic", .4);
      for (let k = 0; k < 26; k++) { const a = rnd(0, Math.PI * 2), r = rnd(120, 220); homing("field", { x: OX(D) + Math.cos(a) * r, y: OY(D) - hgt(D) * .55 + Math.sin(a) * r * .6 }, center(D), rgb, { ms: tv(C, "gather") * .8, arc: 50, r: 3 }); }
      await Promise.all([fdim(.3, tv(C, "gather")), moveActor(D, D.x, D.y, tv(C, "gather"), EASE.sine, { hop: 12 })]); } },
    { name: "Halo and arms", note: "the swell", gate: true, run: async (C) => { const D = DV(), form = ["fury", "focus"][tv(C, "form")]; markGate(); sfx("powerup", .7); sfx("bell", .45); setForm(form);
      flash("#fff", .3, 30, 220).catch(() => {}); clip("d4_flash_ring_white", center(D), { scale: 3.2 * D.s, filter: tint(form === "focus" ? 205 : 5, 5, 1.2) });
      await squash(D, .75, .75, 1); await squash(D, 1, 1, tv(C, "pop"), EASE.outBack);
      for (let k = 0; k < 18; k++) ember("field", OX(D) + rnd(-90, 90), OY(D) - rnd(40, 200), formRgb(form)); } },
    { name: "Settle", note: "embers drift off the arms", run: async () => { await fdim(0, 600); await wait(700); } },
  ] });

/// Enlightenment v18 (round rmwzrtftn: "keep the theming, more budget, more epic"): on Offense rounds 4, 8, 12 her first
// action swaps the form her stacks picked. Blackout + zoom onto her alone, she floats up trailing afterimages, her body
// turns radiant, the yin-yang sequence, copies of her NEW form burst out, the field fades back and the camera resets.
const ENL_V18 = { id: "enl-v18", re: "Keep the theming, more animation budget, more epic", text: "New opening: the camera zooms in on her while the field blacks out until only she is left. She floats upward trailing afterimages, then her body glows radiant gold before the same yin-yang orb, spin and reversal play. Once she has transformed, afterimages of her new form burst outward, then the field fades back in and the camera resets. Every new step has its own slider." };
def("enl", { boss: "offense", status: "approved", icon: "deva", name: "Enlightenment", tag: "Spell · self · Offense rounds 4, 8, 12… · first action", changes: [ENL_V18],
  intro: "She has just taken the form the party steered her into. The world falls away: the camera closes in and the field blacks out until only she is left. She floats upward trailing afterimages and her body turns radiant. A red-and-blue yin-yang orb forms above her and spins faster and faster; on the peak the halves trade colours and her arms flip with them (Fury becomes Focus, or Focus becomes Fury). Copies of her new form burst out from her body, then the field returns.",
  rules: "Plays on rounds 4, 8, 12 as her first action; rounds 2, 6, 10 play normally. The radiance and the burst copies are page stand-ins (CSS filter and sprite copies); the game version owes a token filter and battler copies.",
  tune: [T("zoom", "Camera zoom on her (x)", 1.7, 1, 2.6, .05), T("still", "Blackout + zoom-in (ms)", 1200, 400, 3000, 50), T("dim", "Blackout (0–1)", .96, 0, 1, .02),
    T("rise", "Float height (px)", 70, 0, 160, 5), T("riseMs", "Float up (ms)", 1300, 400, 3000, 50), T("trailEvery", "Afterimage every (ms, float)", 90, 30, 300, 10),
    T("glowMs", "Radiant glow build (ms)", 900, 200, 2500, 50),
    T("orb", "Orb radius (px)", 34, 18, 70, 2), T("spinUp", "Spin-up (ms)", 1500, 600, 3500, 100), T("turns", "Turns before the swap", 4, 1, 10, 1),
    T("burstN", "Burst copies of the new form", 6, 2, 12, 1), T("burstDist", "Burst distance (px)", 170, 40, 400, 10), T("burstMs", "Burst time (ms)", 750, 300, 1600, 50),
    T("outMs", "Fade back + camera reset (ms)", 1000, 300, 2500, 50),
    TO("from", "The form her stacks picked", ["Fury → becomes Focus", "Focus → becomes Fury"], 0)],
  beats: [
    { name: "In the steered form", note: "the form her stacks picked", run: async (C) => { setForm(["fury", "focus"][devaFrom(C)]); await wait(500); } },
    { name: "Blackout", note: "camera zooms in on her, the field and the party fade to black", run: async (C) => { const D = DV(), ms = tv(C, "still"); sfx("saint", .35);
      const c = center(D);
      await Promise.all([FCAM.to({ x: c.x, y: c.y - tv(C, "rise") * .6, z: tv(C, "zoom"), r: 0 }, ms, EASE.sine), fdim(tv(C, "dim"), ms), partyFade(0, ms * .8)]); } },
    { name: "Ascend", note: "she floats upward, afterimages trailing", run: async (C) => { const D = DV(), ms = tv(C, "riseMs"), every = tv(C, "trailEvery"); sfx("up", .3);
      const rise = liftTo(D, tv(C, "rise"), ms, EASE.sine);
      for (let el = 0; el < ms && !FAST; el += every) { afterimage(D, { hue: devaHue(), opacity: .45, ms: 520 }); await wait(every); }
      await rise; } },
    { name: "Radiance", note: "her body starts to glow", run: async (C) => { const D = DV(), ms = tv(C, "glowMs"); sfx("saint3", .45);
      clip("120_glowing_light", center(D), { scale: D.s * 1.1, blend: "screen" });
      for (let k = 0; k < 14; k++) ember("field", OX(D) + rnd(-70, 70), OY(D) - (D.lift || 0) - rnd(20, hgt(D)), RADIANT);
      await tween(ms, EASE.sine, (u) => devaGlow(u)); } },
    { name: "The orb gathers", note: "red and blue motes spiral in", run: async (C) => {
      devaGlow(1); C.orb = makeOrb(C); sfx("magic", .45); const p = C.orb.p;
      if (devaFrom(C) === 1) C.orb.swap = 1;   // the orb's red half follows her current colour
      for (let k = 0; k < 28; k++) { const a = rnd(0, Math.PI * 2), r = rnd(110, 200); homing("field", { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r * .7 }, p, k % 2 ? RED : BLUE, { ms: 900, arc: 60, r: 3 }); }
      await wait(500); await tween(700, EASE.outBack, (u) => C.orb.scale = u); } },
    { name: "Spin", note: "slow, then faster and faster", run: async (C) => {
      if (!C.orb) { C.orb = makeOrb(C); C.orb.scale = 1; if (devaFrom(C) === 1) C.orb.swap = 1; }
      const turns = tv(C, "turns"); sfx("up", .35);
      await tween(tv(C, "spinUp"), EASE.inCubic, (u) => { C.orb.rot = u * turns * Math.PI * 2; C.orb.glow = .6 + u * .9; }); } },
    { name: "Reversal", note: "halves trade places, the form flips", gate: true, run: async (C) => {
      const D = DV(); if (!C.orb) { C.orb = makeOrb(C); C.orb.scale = 1; if (devaFrom(C) === 1) C.orb.swap = 1; }
      markGate(); const to = devaFrom(C) === 0 ? "focus" : "fury"; sfx("reflection", .8); sfx("bell", .6);
      C.burst = prepBurst(to, tv(C, "burstN"));   // hidden now, so the copies are decoded when the burst fires
      flash("#fff", .35, 40, 260).catch(() => {}); clip("d4_flash_ring_white", C.orb.p, { scale: 3 });
      clip("d4_flash_ring_white", center(D), { scale: 3 * D.s, filter: tint(to === "focus" ? 205 : 5, 5, 1.2) });
      const r0 = C.orb.rot, s0 = C.orb.swap; setForm(to); devaGlow(1, formRgb(to)); await squash(D, .85, .85, 1);
      await Promise.all([tween(700, EASE.outCubic, (u) => { C.orb.swap = lerp(s0, 1 - s0, u); C.orb.rot = r0 + u * Math.PI; }), squash(D, 1, 1, 380, EASE.outBack)]);
      for (let k = 0; k < 16; k++) ember("field", OX(D) + rnd(-90, 90), OY(D) - (D.lift || 0) - rnd(40, 200), formRgb(to)); await wait(300); } },
    { name: "Burst", note: "the orb shatters, afterimages of her new form explode outward", run: async (C) => {
      const D = DV(), to = devaFrom(C) === 0 ? "focus" : "fury", p = C.orb ? C.orb.p : { x: OX(D), y: OY(D) - (D.lift || 0) - hgt(D) - 40 };
      sfx("saint", .5); sfx("powerup", .45); if (C.orb) C.orb.remove(); shake(6, 300).catch(() => {});
      clip("d4_flash_ring_white", center(D), { scale: 4.2 * D.s, filter: tint(to === "focus" ? 205 : 5, 5, 1.2) });
      for (let k = 0; k < 30; k++) { const a = rnd(0, Math.PI * 2), sp = rnd(.12, .32); addP("field", { x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: .985, life: rnd(600, 1100), r: rnd(2, 4), rgb: k % 2 ? RED : BLUE,
        draw: (c, q, t) => glow(c, q.x, q.y, q.r * 3, q.rgb, 1 - t) }); }
      await Promise.all([formBurst(to, { n: tv(C, "burstN"), dist: tv(C, "burstDist"), ms: tv(C, "burstMs"), copies: C.burst }), tween(tv(C, "burstMs"), EASE.out, (u) => devaGlow(1 - u * .6, formRgb(to)))]); } },
    { name: "Return", note: "the field fades back in, she settles, the camera resets", run: async (C) => {
      const D = DV(), ms = tv(C, "outMs"), to = devaFrom(C) === 0 ? "focus" : "fury";
      await Promise.all([fdim(0, ms), partyFade(1, ms), FCAM.to({ x: W / 2, y: H / 2, z: 1, r: 0 }, ms, EASE.sine), liftTo(D, 0, ms, EASE.sine),
        tween(ms, EASE.sine, (u) => devaGlow(.4 * (1 - u), formRgb(to)))]);
      devaGlow(0); await wait(600); } },
  ] });

// ───────── Strike Form (Fury, red)
const partyCentre = () => { const L = DEVA_TARGETS(); return L.reduce((a, t) => { const c = center(t); return { x: a.x + c.x / L.length, y: a.y + c.y / L.length }; }, { x: 0, y: 0 }); };
def("slam", { boss: "strike", status: "approved", icon: "deva_fury", name: "Ground Slam", tag: "Attack · all enemies · Earth · Slow", changes: [],
  intro: "She rises high, then drops and drives both fists into the floor. A shockwave rolls across the field into the party; whoever it catches takes Earth damage and is Slowed.",
  rules: "One roll per enemy, so some can dodge. 37 per hit (stand-in).",
  tune: [T("rise", "Rise (ms)", 600, 200, 1500, 50), T("height", "Rise height (px)", 70, 20, 160, 5), T("wave", "Shockwave travel (ms)", 650, 250, 1500, 50), T("shakePx", "Screen shake (px)", 16, 0, 30, 1),
    T("hit", "Hit chance in this preview (%)", 70, 0, 100, 5), T("dmg", "Damage (stand-in)", 37, 1, 99, 1)],
  beats: [
    inForm("fury"),
    { name: "Rise", note: "high above the floor", run: async (C) => { sfx("manto", .5); sfx("up", .3); await liftTo(DV(), tv(C, "height"), tv(C, "rise"), EASE.outCubic); } },
    { name: "Drop and slam", note: "", run: async (C) => { const D = DV(); sfx("swing", .5);
      await liftTo(D, 0, 160, EASE.inCubic); sfx("earth", .9); sfx("blowL", .6);
      shake(tv(C, "shakePx"), 520).catch(() => {}); clip("087_earth_one_2", { x: OX(D) + wid(D) * .4, y: OY(D) - 20 }, { scale: .8 }); clip("gg_dashsmoke_anim01", feet(D), { scale: .5 }); } },
    { name: "Shockwave", note: "rolls into the party · 37 Earth, Slow", gate: true, run: async (C) => {
      const D = DV(), x0 = OX(D) + 40, y0 = OY(D), ms = tv(C, "wave");
      sfx("earth2", .6);
      // the floor ring (ground canvas): 6 px warm rim with a glow, r 30 → 1050, flattened like the floor
      if (!FAST) addP("ground", { x: x0, y: y0, life: ms, draw: (c, p, t) => { const u = EASE.out(t), r = lerp(30, 1050, u); c.globalCompositeOperation = "source-over";
        c.shadowColor = "rgba(255,140,60,.8)"; c.shadowBlur = 18; c.strokeStyle = `rgba(255,200,140,${.9 * (1 - u * .6)})`; c.lineWidth = 6; c.beginPath(); c.ellipse(p.x, p.y, r, r * .32, 0, 0, 7); c.stroke();
        if (Math.random() < .5) dust("field", p.x + r * rndFx(.7, 1), p.y + rndFx(-r * .3, r * .3), "200,150,100", { life: 500, r: rndFx(2, 4) }); } });
      await wait(ms); markGate(); clip("088_earth_all_1", partyCentre(), { scale: 1.1 });
      for (const t of DEVA_TARGETS()) { if (rollHit(tv(C, "hit") / 100, t)) { sfx("blowB", .4); hitFx(t, tv(C, "dmg"), "earth", { clipKey: "086_earth_one_1", scale: .3 });
          wait(420).then(() => { clip("055_powerdown_2", feet(t), { scale: t.s * .8 }); statusTag(t, "Slow", "190,200,255"); }).catch(() => {}); } else missFx(t); await wait(90); }
      sfx("slow", .35); } },
    { name: "Dust settles", note: "", run: async () => { await wait(1200); } },
  ] });
def("surya", { boss: "strike", status: "approved", icon: "deva_fury", name: "Surya Palm", tag: "Attack · Light · Blind · 69", changes: [],
  intro: "Sunlight gathers in her palm. She glides in and plants a blazing palm on one enemy; a pillar of light erupts and leaves them Blind.",
  rules: "Her strongest single hit (69 average).",
  tune: [T("charge", "Sun gathers (ms)", 900, 300, 2000, 50), T("glide", "Glide (ms)", 520, 200, 1200, 20), T("dmg", "Damage (stand-in)", 69, 1, 120, 1)],
  beats: [
    inForm("fury"),
    { name: "Sun gathers", note: "in her palm", run: async (C) => { sfx("saint3", .5); const p = handPt(1); clip("119_ball_of_light", p, { scale: .45, blend: "screen" });
      motes({ x: p.x, y: p.y - 80 }, p, GOLD, 12, tv(C, "charge") * .8); await wait(tv(C, "charge")); } },
    { name: "Glide in", note: "", run: async (C) => { const D = DV(); C.t = pick(DEVA_TARGETS()); const t = C.t; sfx("evasion", .45);
      await moveActor(D, t.x - (wid(t) * .5 + wid(D) * .3), t.y + 4, tv(C, "glide"), EASE.sine, { hop: 8, trail: .18, hue: devaHue() }); } },
    { name: "Palm", note: "69 Light, Blind", gate: true, run: async (C) => { const D = DV(), t = C.t || pick(DEVA_TARGETS()); await lean(D, 12, 90, EASE.in); markGate(); sfx("blowL", .8); sfx("flash2", .7);
      hitFx(t, tv(C, "dmg"), "light", { tier: "strong", clipKey: "097_light_one_2", scale: .45 }); clip("117_light_pillar_1", feet(t), { scale: t.s * 1.1, blend: "screen" });
      flash("#fff6d8", .4, 30, 260).catch(() => {}); shake(10, 300).catch(() => {});
      await wait(450); clip("060_blind", head(t), { scale: t.s * .4 }); sfx("blind", .5); statusTag(t, "Blind", GOLD); } },
    { name: "Return", note: "", run: async () => { const D = DV(); lean(D, 0, 300).catch(() => {}); await moveActor(D, D.x, D.y, 650, EASE.sine, { hop: 8, trail: .2, hue: devaHue() }); await wait(500); } },
  ] });

// ───────── Magic Form (Focus, blue)
// Rahu's Eclipse on our pixelfx clip (fu/rahu-eclipse: back / front / light), impact at 3.1 s
const RAHU_IMPACT = 3100;
function rahuClips(pt, scale, fromMs = 0, fadeMs = 0) { return ["back", "front", "light"].map((l) => { const c = clip("pxfx_dark_rahu_eclipse_" + l, pt, { scale, blend: l === "light" ? "screen" : "", z: l === "light" ? 2 : 1, fadeIn: fadeMs });
  if (fromMs && c.el) c.el.currentTime = fromMs / 1000; return c; }); }
const rahuPt = () => { const L = DEVA_TARGETS(); return { x: partyCentre().x, y: Math.min(...L.map((t) => head(t).y)) + 6 }; };
// the eclipse is started by its own beat; jumping past that beat starts it here at the right point instead
function ensureEclipse(C, atMs, fadeMs = 0) { if (C.clips && (C.clips[0].el || IN_GAME)) return; C.pt = rahuPt();
  C.clips = rahuClips(C.pt, 1.1 * tv(C, "size") / 100 / .55, atMs, fadeMs); C.t0 = TRACE.now() - atMs;
  if (fadeMs) C.clips.forEach((c) => { if (!c.el) return; c.el.style.opacity = 0; tween(fadeMs, EASE.sine, (u) => c.el.style.opacity = u).catch(() => {}); }); }
def("rahu", { boss: "magic", status: "approved", icon: "deva_focus", name: "Rahu's Eclipse", tag: "Spell · all enemies · no roll · MP then Dark", changes: [],
  intro: "Night falls and Rahu's black sun fades in over the party, its violet corona brightening. Motes of the party's magic are dragged up out of them into its rim; then the corona flares white and Dark rains down on each of them in proportion to what they lost.",
  rules: "The eclipse is an original pixelfx effect (fu/rahu-eclipse), exported as back, front and light layers, in the Dark element's violet. No accuracy roll: everyone loses 40% of current MP, then takes 40% of that as Dark damage. Blue numbers are MP.",
  tune: [T("night", "Night falls (ms)", 800, 300, 2000, 50), T("fade", "Eclipse fade-in (ms)", 900, 0, 2000, 50), T("size", "Eclipse size (%)", 140, 50, 220, 5), T("dim", "Field dim (0–0.8)", .55, 0, .8, .05)],
  beats: [
    inForm("focus"),
    { name: "Night falls", note: "", run: async (C) => { const D = DV(); sfx("dark5", .5); clip("051_powerup_1", feet(D), { scale: D.s, filter: tint(270, 6, 1.1) }); await fdim(tv(C, "dim"), tv(C, "night"), "#09040f"); } },
    { name: "The black sun fades in", note: "a violet corona brightens", run: async (C) => { ensureEclipse(C, 0, tv(C, "fade")); sfx("dark", .5); await wait(1200); } },
    { name: "Magic drains away", note: "motes rise into the corona · MP lost", run: async (C) => { ensureEclipse(C, 1200); sfx("absorb", .6);
      for (const t of DEVA_TARGETS()) { motes(center(t), C.pt, VIOLET, 10, 1100); clip("058_absorb", center(t), { scale: t.s * .35, filter: tint(270, 3, 1.1) }); mpFx(t, Math.round((PC_MP[t.id] || 100) * .4)); }
      const left = RAHU_IMPACT - (TRACE.now() - C.t0); await wait(Math.max(0, left - 60)); } },
    { name: "The corona flares", note: "Dark from the lost MP", gate: true, run: async (C) => { ensureEclipse(C, RAHU_IMPACT - 40); markGate(); sfx("dark5", .85); sfx("flash2", .5);
      flash("#e2d4ff", .3, 30, 260).catch(() => {});
      for (const t of DEVA_TARGETS()) homing("field", C.pt, center(t), VIOLET, { ms: 280, arc: 10, r: 6 });
      await wait(280); for (const t of DEVA_TARGETS()) hitFx(t, Math.round((PC_MP[t.id] || 100) * .4 * .4), "dark", { clipKey: "101_darkness_one_1", scale: .4 }); shake(7, 320).catch(() => {}); } },
    { name: "Light returns", note: "the eclipse folds away", run: async () => { await wait(900); await fdim(0, 700); await wait(400); } },
  ] });
def("kala", { boss: "magic", status: "approved", icon: "deva_focus", name: "Kala Strike", tag: "Attack · Dark · MDEF · empties MP · Curse", changes: [],
  intro: "She marks the enemy with the least magic left, glides in, and brings a blackened fist down on them. Their remaining MP is torn out and they are Cursed.",
  rules: "Damage = HR+25 plus 30% of the target's missing MP (here 32 + 25). On a hit the target's MP goes to 0. The target mark is a floor ring on the ground canvas.",
  tune: [T("mark", "Mark the target (ms)", 700, 200, 1600, 50), T("glide", "Glide (ms)", 560, 200, 1200, 20), T("size", "Fist size (px)", 150, 80, 260, 5), T("dmg", "Damage (stand-in)", 57, 1, 120, 1), T("mp", "MP torn out (stand-in)", 70, 0, 200, 5)],
  beats: [
    inForm("focus"),
    { name: "Mark the drained", note: "she picks the emptiest caster", run: async (C) => { C.t = IN_GAME ? moveTarget(0) : ACT.hina; const t = C.t; sfx("dark", .4);
      const mk = C.mark = { on: true, a: 1 };
      if (!FAST) addP("ground", { x: OX(t), y: OY(t), life: 1e9, update: (p) => { if (!mk.on) p.dead = true; },
        draw: (c, p) => { c.globalCompositeOperation = "source-over"; c.shadowColor = `rgba(${BLUE},.9)`; c.shadowBlur = 14; c.strokeStyle = `rgba(${BLUE},${.9 * mk.a})`; c.lineWidth = 3; c.beginPath(); c.ellipse(p.x, p.y, 46, 18, 0, 0, 7); c.stroke(); } });
      await tween(tv(C, "mark"), EASE.sine, (u) => mk.a = .4 + .6 * Math.abs(Math.sin(u * Math.PI * 2))); } },
    { name: "Glide in", note: "", run: async (C) => { const D = DV(), t = C.t; sfx("evasion", .45); await moveActor(D, t.x - (wid(t) * .5 + wid(D) * .3), t.y + 4, tv(C, "glide"), EASE.sine, { hop: 8, trail: .18, hue: devaHue() }); } },
    { name: "Kala", note: "57 Dark, MP to 0, Curse", gate: true, run: async (C) => { const D = DV(), t = C.t || ACT.hina; const p = { x: OX(t) - 10, y: OY(t) - hgt(t) - 70 };
      const f = energyFist("blue", p.x, p.y, tv(C, "size"), 180); f.m.style.filter += " brightness(.55)"; f.sx = f.sy = 0; f.apply(); sfx("dark", .5); await grow(f, 260);
      await tween(160, EASE.inCubic, (u) => { f.y = lerp(p.y, OY(t) - hgt(t) * .2, u); f.apply(); }); f.remove(); if (C.mark) C.mark.on = false;
      markGate(); sfx("dark5", .9); sfx("blowL", .7); hitFx(t, tv(C, "dmg"), "dark", { tier: "strong", clipKey: "102_darkness_one_2", scale: .5 }); flash("#2a2a6a", .35, 30, 260).catch(() => {}); shake(10, 320).catch(() => {});
      await wait(350); sfx("absorb", .7); mpFx(t, tv(C, "mp")); motes(center(t), center(D), BLUE, 18, 700); clip("058_absorb", center(t), { scale: t.s * .45 });
      await wait(400); clip("056_powerdown_3", center(t), { scale: t.s * .45, filter: tint(275, 4, 1.1) }); statusTag(t, "Cursed", VIOLET); } },
    { name: "Return", note: "", run: async () => { const D = DV(); await moveActor(D, D.x, D.y, 650, EASE.sine, { hop: 8, trail: .2, hue: devaHue() }); await wait(500); } },
  ] });

// ───────── Fists of Fury / Fists of Focus — SHIPPED v1.0.575 (tools/anim-studio/lib/deva-shots/fists-barrage.inner.js +
// deva-signatures.js). The v16 radial cone with the user-tuned numbers, kept here as the approved reference.
// v18 (round rmwzrtftn, note on Fists of Fury, "reflect this in Fists of Focus as well")
const BARRAGE_V20 = { id: "barrage-v20", re: "Your Fury slider tuning (round rmwzti7z1) and no SE_EXPLODE2", text: "The SE_EXPLODE2 sound is gone from the final hit. Your Fury sliders are now the defaults on both Fury and Focus: her afterimage every 60 ms (was 70), opacity 0.35 (was 0.65), fade 540 ms (was 620); punch shake 3 px (was 7), 55 ms per jab (was 75), rocking 1.5° (was 3)." };
const BARRAGE_V19 = { id: "barrage-v19", re: "Polish: she should shake like someone throwing a punch barrage, stronger afterimages (like Enlightenment), a bigger wind-up and final punch; same on Focus", text: "During the barrage her body now jabs back and forth along her facing with a small rocking tilt, like someone throwing a flurry of punches, on top of the glide. Her afterimages come more often, stay brighter and longer and glow in her form colour (Enlightenment style). The ending is now its own two beats: a wind-up (she pulls back, the aura charges and the camera tightens) and a final punch (she lunges forward and throws one big fist, with an anime impact frame, before the hard closing hit). Same on Fury and Focus; every piece has a slider." };
const BARRAGE_CFG = { id: "barrage-cfg", re: "Update cfg to the current setting (Fury), reflect it on Focus", text: "Your Fury sliders are now the defaults on both moves: a fist every 15 ms (was 9) and fists grow 1.9x in flight (was 2.4)." };
const BARRAGE_GLIDE = { id: "barrage-glide", re: "She is too static during the barrage", text: "During the barrage she now tilts forward on the diagonal and glides slowly toward the party, with afterimages trailing her. Three new sliders: glide distance, forward tilt and how often an afterimage drops. Both moves." };
// v19: her barrage afterimage, brighter than the shared one: a copy tinted to her form colour with a glow, fading out where she was
function barrageGhost(a, blue, opacity = .65, ms = 620) {
  if (FAST) return; const rgb = blue ? BLUE : RED, hue = blue ? 223 : 8;
  const g = sprite(IN_GAME ? null : a.media.getAttribute("src"), $("factors"), { actor: IN_GAME ? a : null, x: OX(a), y: OY(a) - (a.lift || 0), h: hgt(a), opacity, z: Math.round(OY(a)) - 1, flip: a.flip,
    filter: `sepia(1) saturate(5) hue-rotate(${hue - 38}deg) brightness(1.5) drop-shadow(0 0 10px rgba(${rgb},1))` });
  g.set({ rot: a.rot, sx: a.kx ?? 1, sy: a.ky ?? 1 }); tween(ms, EASE.out, (u) => { g.opacity = opacity * (1 - u); g.sx = (a.kx ?? 1) * (1 + .06 * u); g.sy = (a.ky ?? 1) * (1 + .06 * u); g.apply(); }).then(() => g.remove(), () => g.remove()); }
// the page's barrage blink lands 230 px ahead of her spot (330 → 560): 642 px short of the nearest party member (Hina, 1202)
const DEVA_BLINK_GAP = 1202 - (330 + 230);
function barrageMove(color) {
  const blue = color === "blue", elem = blue ? "dark" : "physical", per = blue ? 18 : 36;
  return { boss: "shipped", status: "changes", icon: blue ? "deva_focus" : "deva_fury", name: blue ? "Fists of Focus" : "Fists of Fury", changes: [BARRAGE_V20, BARRAGE_V19, BARRAGE_CFG, BARRAGE_GLIDE],
    tag: (blue ? "Attack · all enemies · Dark · drains MP" : "Attack · all enemies · Physical") + " · SHIPPED v1.0.575",
    intro: `She blinks out and reappears in front of the party, then erupts: a wide cone of ${blue ? "blue" : "red"} fists bursts from her, each one swelling as it flies until the cone fills the whole screen. The fists that find the party land with hit sparks, and every enemy inside the cone reels under a rapid stream of hits${blue ? " and has MP torn out" : ""}. She draws back for one last wind-up, lunges and throws a single huge fist for the final impact, then she blinks home.`,
    rules: "The game still plays the v1.0.575 version (mockup v16). This v18/v19 rework (your Fury timing on both moves, the forward glide and tilt, the punch shake, stronger afterimages and the final punch) goes into the game only after you approve the whole kit. In game the blink lands 485 px in front of the nearest party member (the Training Ground formation is wider), Fury lands 12 damage cues, Focus one number at the gate.",
    tune: [T("dur", "Barrage length (ms)", 4000, 600, 6000, 100), T("rate", "A fist every (ms)", 15, 4, 60, 1), T("cone", "Cone half-angle (deg)", 66, 20, 88, 2),
      T("size", "Fist size at launch (px)", 120, 50, 260, 10), T("grow", "Fist grows in flight (x)", 1.9, 1, 4, .1),
      T("glide", "Glide toward the party during the barrage (px)", 70, 0, 200, 5), T("tilt", "Forward tilt during the barrage (deg)", 14, 0, 30, 1),
      T("ghostEvery", "Her afterimage every (ms, 0 = off)", 60, 0, 400, 10), T("ghostOp", "Her afterimage opacity", .35, .1, 1, .05), T("ghostMs", "Her afterimage fade (ms)", 540, 150, 1500, 10),
      T("jab", "Punch shake (px, 0 = off)", 3, 0, 20, 1), T("jabMs", "Punch shake rhythm (ms per jab)", 55, 30, 200, 5), T("rock", "Punch shake rocking (deg)", 1.5, 0, 10, .5), T("flight", "Fist flight to the screen edge (ms)", 410, 100, 800, 10),
      T("trail", "Afterimages per fist", 3, 0, 6, 1), T("aim", "Fists aimed at the party (%)", 10, 0, 100, 5), T("spark", "Hit spark size (x)", 1, .4, 2, .05),
      T("lines", "Speed lines", 140, 0, 200, 5), T("ticks", "Ticks per target", 30, 4, 40, 1), T("hit", "Hit chance in this preview (%)", 100, 0, 100, 5),
      T("jolt", "Camera jolt (px, 0 = off)", 5, 0, 14, 1), T("step", "Teleport distance forward (px)", 230, 0, 400, 10), T("tp", "Teleport squeeze (ms)", 220, 80, 600, 10),
      T("zoom", "Camera zoom (x, 1 = off)", 1.35, 1, 2, .05), T("zoomMs", "Zoom-in time (ms)", 450, 100, 1200, 25),
      T("windMs", "Final wind-up (ms)", 650, 200, 1500, 25), T("pull", "Final wind-up pull-back (px)", 50, 0, 120, 5), T("windTilt", "Final wind-up lean back (deg)", 16, 0, 35, 1),
      T("lunge", "Final punch lunge (px)", 120, 0, 260, 5), T("bigFist", "Final fist size (px)", 240, 100, 420, 10), T("bigMs", "Final fist flight (ms)", 170, 60, 400, 10),
      T("iframe", "Anime impact frame (0 = off, 1 = on)", 1, 0, 1, 1), T("finalZoom", "Final camera push (x)", 1.15, 1, 1.5, .01)],
    beats: [
      inForm(blue ? "focus" : "fury"),
      { name: "Teleport in", note: "fade + squeeze out, reappear in front of the party", run: async (C) => { const D = DV(); await devaBlink(D, IN_GAME ? Math.max(D.x, Math.min(...DEVA_TARGETS().map((t) => OX(t))) - DEVA_BLINK_GAP) : D.x + tv(C, "step"), D.y + 8, { ms: tv(C, "tp"), blue }); } },
      { name: "Zoom in", note: "camera pushes in on the midpoint between her and the party", run: async (C) => {
        if (tv(C, "zoom") <= 1.001) return; const pc = partyCentre(), dc = center(DV());
        await FCAM.to({ x: (dc.x + pc.x) / 2, y: (dc.y + pc.y) / 2, z: tv(C, "zoom"), r: 0 }, tv(C, "zoomMs"), EASE.outCubic); } },
      { name: "Wind-up", note: "aura flares, the arms draw back", run: async () => { const D = DV(); sfx(blue ? "magic" : "powerup", .5);
        clip("051_powerup_1", feet(D), { scale: D.s * 1.2, filter: tint(blue ? 205 : 5, 6, 1.1) }); await lean(D, -10, 420, EASE.out); } },
      { name: "The barrage", note: "a wide cone of fists filling the screen", gate: true, run: async (C) => {
        const D = DV(), targets = rollAll(C, per, tv(C, "hit") / 100), dur = tv(C, "dur"), hits = targets.filter((x) => x.hit); C.targets = targets;
        const src = () => ({ x: OX(D) + wid(D) * rndFx(.25, .6), y: OY(D) - hgt(D) * rndFx(.4, .75) }), dirTo = (t) => { const a = center(D), b = center(t); return Math.atan2(b.y - a.y, b.x - a.x); };
        const all = []; markGate(); hits.forEach((x) => holdHurt(x.t, true));
        hits.forEach((x) => { const n = x.ticks.length;   // damage ticks: each lands with a full GG hit
          for (let k = 0; k < n; k++) { const at = dur * .06 + dur * .88 * (k + rnd(.1, .9)) / n;
            all.push(wait(at).then(() => { ggImpact(x.t, dirTo(x.t) + rndFx(-.25, .25), blue, { big: tv(C, "spark") });
              if (!IN_GAME) dmgNum(x.t.id, numAt(x.t), x.ticks[k], { element: elem, cascade: (k % 4) + 1 }); if (k % 3 === 0) hitReact(x.t, "normal");
              if (k % 2) sfx(k % 4 ? "blowA" : "blowB", .4, 1.05 + (k % 5) * .07); })); } });
        if (IN_GAME && !blue) { const n = moveStrikes(moveTarget()).length || 12; for (let k = 0; k < n; k++) all.push(wait(dur * .06 + dur * .88 * (k + .5) / n).then(() => gameNum(moveTarget(), 1))); }
        const lineRgb = blue ? "170,215,255" : "255,215,190"; rumble(true, 3);
        // v18: she tilts forward on the diagonal and glides slowly at the party for the whole barrage (the fists' source follows her)
        // v19: on top of the glide her body jabs back and forth along her facing with a small rocking tilt (a punch flurry)
        const gx0 = OX(D), gy0 = OY(D), gx1 = gx0 + tv(C, "glide"), gy1 = gy0 + tv(C, "glide") * .12, r0 = D.rot, tilt = tv(C, "tilt");
        const jab = tv(C, "jab"), jabMs = tv(C, "jabMs"), rock = tv(C, "rock");
        all.push(tween(dur, EASE.lin, (u) => { const g = EASE.sine(u), tms = u * dur, ph = tms / jabMs * Math.PI * 2, env = Math.min(1, tms / 250, (dur - tms) / 200 + .15);
          const j = jab * env * (Math.sin(ph) * .75 + Math.sin(ph * 2.3 + 1.1) * .25);
          D.rot = lerp(r0, tilt, EASE.outCubic(Math.min(1, tms / 300))) + rock * env * Math.sin(ph + .6);
          const nx = lerp(gx0, gx1, g) + face(D) * j, ny = lerp(gy0, gy1, g) - Math.abs(j) * .15; D.s = tokenScaleAt(ny); setPos(D, nx - D.x, ny - D.y); }));
        const ghost = tv(C, "ghostEvery"); let lastGhost = -1e9;
        speedLines(true, { vp: FCAM.screen(src()), color: lineRgb, alpha: .55, n: tv(C, "lines") });
        const reach = Math.hypot(W, H) * 1.1, half = tv(C, "cone") * Math.PI / 180; let i = 0, lastJolt = -1e9;
        for (let el = 0; el < dur && !FAST; el += tv(C, "rate")) {   // beat clock: one fist per `rate` virtual ms
          i++; const o = src(), behind = Math.random() < .2;
          if (hits.length && Math.random() * 100 < tv(C, "aim")) {   // aimed: ends on a body, grows in proportion, lands with a spark
            const x = hits[Math.floor(Math.random() * hits.length)], c = center(x.t), to = { x: c.x + rndFx(-hgt(x.t) * .2, hgt(x.t) * .15), y: c.y + rndFx(-hgt(x.t) * .3, hgt(x.t) * .3) };
            const d = Math.hypot(to.x - o.x, to.y - o.y), ms = Math.max(90, tv(C, "flight") * d / reach * rndFx(.85, 1.15));
            all.push(barrageFist(color, o, to, C, { h: tv(C, "size") * rndFx(.7, 1.15), grow: 1 + (tv(C, "grow") - 1) * d / reach, ms, ease: EASE.inCubic, z: 4000, trail: tv(C, "trail"), hold: true, linger: 50 }));
            all.push(wait(ms).then(() => ggImpact(x.t, Math.atan2(to.y - o.y, to.x - o.x), blue, { big: .7 * tv(C, "spark") })));
          } else {
            const a = rndFx(-half, half), d = reach * rndFx(.85, 1.1);
            all.push(barrageFist(color, o, { x: o.x + Math.cos(a) * d, y: o.y + Math.sin(a) * d }, C, {
              h: tv(C, "size") * rndFx(.65, 1.2), grow: tv(C, "grow") * rndFx(.85, 1.15), ms: tv(C, "flight") * rndFx(.75, 1.25), ease: EASE.inCubic,
              z: behind ? Math.round(o.y) - 2 : 4000, peak: behind ? .6 : rndFx(.8, 1), trail: tv(C, "trail") }));
          }
          if (i % 4 === 0) sfx(i % 8 ? "blowA" : "blowB", .28, 1.1 + (i % 7) * .05);
          if (ghost && el - lastGhost >= ghost) { lastGhost = el; barrageGhost(D, blue, tv(C, "ghostOp"), tv(C, "ghostMs")); }
          if (tv(C, "jolt") && el - lastJolt > 140) { lastJolt = el; shake(tv(C, "jolt"), 110).catch(() => {}); }
          await wait(tv(C, "rate"));
        }
        await Promise.all(all); rumble(false); speedLines(false); C.hits = hits; } },
      { name: "Final wind-up", note: "she pulls back, the aura charges, the camera tightens", run: async (C) => { const D = DV(), ms = tv(C, "windMs"), rgb = blue ? BLUE : RED;
        sfx(blue ? "magic" : "powerup", .6); sfx("wind", .35); clip("051_powerup_1", feet(D), { scale: D.s * 1.5, filter: tint(blue ? 205 : 5, 6, 1.2) });
        for (let k = 0; k < 18; k++) { const a = rnd(0, Math.PI * 2), r = rnd(90, 170), c = center(D); homing("field", { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * .7 }, handPt(1), rgb, { ms: ms * .8, arc: 40, r: 3 }); }
        const x0 = OX(D), y0 = OY(D), r0 = D.rot, c = FCAM.screen ? { x: FCAM.x, y: FCAM.y, z: FCAM.z } : null;
        const cam = c ? FCAM.to({ x: lerp(c.x, OX(D), .25), y: c.y, z: c.z * tv(C, "finalZoom"), r: 0 }, ms, EASE.sine) : null;
        const ghosts = (async () => { for (let el = 0; el < ms; el += 64) { if (!FAST) barrageGhost(D, blue, tv(C, "ghostOp") * .6, 380); await wait(64); } })();
        await Promise.all([tween(ms, EASE.outCubic, (u) => { D.rot = lerp(r0, -tv(C, "windTilt"), u); D.kx = lerp(1, 1.06, u); D.ky = lerp(1, .95, u);
            setPos(D, x0 - face(D) * tv(C, "pull") * u - D.x, y0 - D.y); }), cam, ghosts]);
        await wait(90); } },
      { name: "Final punch", note: "she lunges and throws one huge fist: the closing impact", run: async (C) => { const D = DV(), hits = C.hits || [], rgb = blue ? BLUE : RED;
        const dirTo = (t) => { const a = center(D), b = center(t); return Math.atan2(b.y - a.y, b.x - a.x); };
        const x0 = OX(D), y0 = OY(D), r0 = D.rot, pc = partyCentre(), fms = tv(C, "bigMs");
        sfx("swing", .7); sfx(blue ? "dark" : "blowL", .5, .8);
        const lunge = tween(140, EASE.outExpo, (u) => { D.rot = lerp(r0, tv(C, "tilt") + 10, u); D.kx = lerp(1.06, .94, u); D.ky = lerp(.95, 1.05, u);
          setPos(D, x0 + face(D) * tv(C, "lunge") * u - D.x, y0 - D.y); });
        (async () => { for (let el = 0; el < 140; el += 20) { await wait(20); if (!FAST) barrageGhost(D, blue, tv(C, "ghostOp"), tv(C, "ghostMs")); } })();
        speedLines(true, { vp: FCAM.screen(pc), color: blue ? "170,215,255" : "255,215,190", alpha: .7, n: 120 });
        const from = handPt(1);
        await Promise.all([lunge, barrageFist(color, from, pc, C, { h: tv(C, "bigFist"), grow: 1.6, ms: fms, ease: EASE.inCubic, z: 4100, trail: 5, hold: true, linger: 160 })]);
        if (tv(C, "iframe") && hits.length) await impactFrame(hits.map((x) => x.t), 60);
        speedLines(false);
        // the closing impact lands hard on everyone the barrage connected with
        if (IN_GAME && blue) gameNum(moveTarget(), 1);
        sfx("blowL", 1); flash("#fff", .4, 25, 260).catch(() => {}); shake(16, 460).catch(() => {});
        ring(feet(hits[0] ? hits[0].t : DV()), { rgb, r1: 260, ms: 600 });
        for (const x of hits) { ggImpact(x.t, dirTo(x.t), blue, { big: 2.1 * tv(C, "spark") }); ggImpact(x.t, dirTo(x.t), blue, { big: 1.3 * tv(C, "spark") }); hitReact(x.t, "strong");
          slide(x.t, -face(x.t) * 42, 160).then(() => slide(x.t, 0, 420, 0)).catch(() => {}); }
        await tween(260, EASE.outCubic, (u) => { D.kx = lerp(.94, 1, u); D.ky = lerp(1.05, 1, u); setPos(D, D.dx, D.dy); });
        await wait(300); hits.forEach((x) => holdHurt(x.t, false));
        if (blue) await focusDrainEnd(C.targets || [], per); } },
      { name: "Zoom out", note: "camera eases back", run: async () => { await FCAM.to({ x: W / 2, y: H / 2, z: 1, r: 0 }, 600, EASE.outCubic); } },
      { name: "Teleport home", note: "fade + squeeze out, reappear at her spot", run: async (C) => { const D = DV(); await wait(250); D.kx = D.ky = 1; await lean(D, 0, 200, EASE.sine);
        await devaBlink(D, D.x, D.y, { ms: tv(C, "tp"), blue }); await wait(350); } },
    ] };
}
def("fury", barrageMove("red"));
def("focus", barrageMove("blue"));
