// ═════════ Moves: Sonic Blow (Chain 8 Volley), Sonic Katar Attack (scale), Gunblade Sword / Firearm / Transform
const DIE_OPTS = ["d6", "d8", "d10", "d12"];
const dieIx = (n) => DICE.indexOf(n);
// the party's dice (actors export 2026-11-21); INS for the Gunblade's Firearm side
const PDICE = { hina: { dex: 6, mig: 8, ins: 12, acc: 0 }, zarg: { dex: 12, mig: 8, ins: 8, acc: 3 }, keren: { dex: 8, mig: 6, ins: 12, acc: 0 }, blanche: { dex: 12, mig: 12, ins: 6, acc: 0 } };

// ───────── Sonic Blow helpers
// strike results: rolled with the game's dice rule, or forced to k landed (forced = no crits, the k hits spread at random)
function sbResults(C) { const n = tv(C, "n"), mode = tv(C, "result");
  if (mode === 0) { const dA = DICE[tv(C, "dA")], dB = DICE[tv(C, "dB")], bon = tv(C, "bonus") - tv(C, "pen"), def = tv(C, "def");
    return Array.from({ length: n }, () => rollAcc(dA, dB, bon, def)); }
  const k = Math.min(n, [n, 6, 4, 2, 0][mode - 1]); const idx = new Set(); while (idx.size < k) idx.add(Math.floor(Math.random() * n));
  return Array.from({ length: n }, (_, i) => ({ hit: idx.has(i), crit: false, fum: false, forced: true })); }
const sbStrikeDmg = (C, r) => Math.max(1, Math.round(tv(C, "dmg") * tv(C, "share") * (r.crit ? tv(C, "critm") : 1)));
// one katar strike: a short alternating cut, the RO katar swing; a landed strike = RO dagger hit + the game's physical hit clip + a number;
// a miss = the game's MISS word and the target sways out of the way
const SB_ANG = [-30, 150, 20, -160, 60, -110, 100, -60, 10, 170];
async function sbStrike(C, a, t, i, r, dmg, critBannerFree) { const snd = tv(C, "snd"), c = center(t), j = { x: c.x + rnd(-18, 18) * t.s, y: c.y + rnd(-26, 18) * t.s };
  const fl = a.baseFlip; lean(a, (i % 2 ? -12 : 14) * fl, 50).catch(() => {}); slide(a, a.dx + face(a) * (i % 2 ? -6 : 8), 60, a.dy).catch(() => {});
  if (i % 2 === 0) afterimage(a, { opacity: .35, ms: 200 });
  if (snd === 0) sfx(i % 2 ? "ro_katar" : "ro_katar2", .35); else if (snd === 2) sfx(i % 2 ? "sword4" : "sword2", .3);
  const ang = (SB_ANG[i % SB_ANG.length] + rnd(-8, 8)) * Math.PI / 180;
  slashSheet(j, ang, { L: hgt(t) * (r.hit ? .62 : .45), w: (r.hit ? 18 : 12) * t.s, rgb: r.hit ? PINK : STEEL, ms: r.hit ? 220 : 180, core: .32 });
  if (r.hit) {
    if (snd === 0) sfx("ro_hitdagger", .4); else if (snd === 2) sfx("slash1", .35);
    clip("001_hit_physical", j, { scale: t.s * .55, z: 4002, rate: 1.3 }); sparks(j, nP(C, r.crit ? 14 : 6), r.crit ? GOLD : PINK, r.crit ? 1 : .6);
    if (r.crit) { flash("#fff", .25, 20, 90).catch(() => {}); impactRays(j, nP(C, 12), 18 * t.s, 200 * t.s, 200); }
    gameNum(t, dmg, { crit: r.crit, critBanner: r.crit && critBannerFree() }); hitReact(t, r.crit ? "strong" : "normal"); shake(r.crit ? 6 : 3, 90).catch(() => {});
  } else {
    gameNum(t, 0, { kind: "miss" });
    const sway = -face(t) * rnd(10, 18) * t.s; slide(t, t.dx + sway, 70, t.dy).then(() => slide(t, 0, 160, t.dy)).catch(() => {});
  }
}

def("sonicblow", { status: "approved", changes: [{ id: "v2-jump1", re: "remove the sfx Jump1 on the jump back", text: "The hop home after Sonic Blow is silent now (Jump1 removed). The other moves keep theirs." }], boss: "sonic", name: "Sonic Blow", icon: "icon_sb", tag: "Skill · 30 MP · one creature · Chain 8 Volley",
  intro: "One action card, eight katar strikes on one creature, in about a second, timed inside Ragnarok Online's own Sonic Blow sound. Every strike makes its own Accuracy Check (−2 each), so any of them can MISS. Each landed strike deals 0.25 of a normal Sonic Katar hit; if all eight land, the action is a <b>Perfect</b> and its damage is ×1.5 (3.0× in total). A critical strike deals 50% more and gives no Opportunity. No Stun (the game has no Stun).",
  rules: "Damage is the Chain Volley share: the hit's damage is counted once and split over the 8 strikes, so a missed strike loses its share. Strike results come from the game's dice rule (crit = matching dice 6+, fumble = double 1s) at the dice / bonus / DEF sliders, or can be forced to 8/8, 6/8, 4/8, 2/8 or 0/8 to look at each outcome. The Perfect bonus shows as one extra gold hit after the 8th strike.",
  tune: [TO("result", "Strike results", ["Rolled (dice, bonus, DEF below)", "Force 8/8 · Perfect", "Force 6/8", "Force 4/8", "Force 2/8", "Force 0/8"], 0),
    TO("dA", "Accuracy die 1 (DEX) · default = a d12 wielder", DIE_OPTS, 3), TO("dB", "Accuracy die 2 (DEX)", DIE_OPTS, 3),
    T("bonus", "Accuracy bonus (gear, skills)", 0, 0, 6, 1), T("pen", "Sonic Blow penalty, −X per strike", 2, 0, 4, 1), T("def", "Target DEF (median at L35+ = 12)", 12, 6, 18, 1),
    T("n", "Strikes", 8, 4, 10, 1), T("share", "Each landed strike (× one normal hit)", .25, .1, .5, .01), T("perf", "Perfect (every strike lands) ×", 1.5, 1, 3, .05),
    T("critm", "Critical strike × (no Opportunity)", 1.5, 1, 2, .05), T("dmg", "One normal Sonic Katar hit, example (HR + 5)", 16, 5, 60, 1), T("mp", "MP cost", 30, 10, 60, 5),
    T("gap", "Time between strikes (ms)", 115, 60, 260, 5), T("lead", "RO sound lead before strike 1 (ms)", 60, 0, 300, 10),
    TO("snd", "Sounds", ["RO · Sonic Blow + katar swings + dagger hits", "RO · Sonic Blow only", "Game sounds only (Sword / Slash)"], 0),
    T("fx", "RO sonicblow effect size (%)", 110, 50, 220, 5), T("parts", "Particle density (%)", 100, 0, 250, 10)],
  beats: [
    { name: "Namecard + MP", note: "plate previews then pays the MP", run: async (C) => { hudNoForm(); namecard("Sonic Blow", "💥"); sfx("decide", .35); const mp = tv(C, "mp"); hudCost(mp); await wait(850);
      hudSpendMP(mp); gameNum(WA(), mp, { kind: "spend", resource: "mp" }); await wait(420); } },
    { name: "Dash in", note: "afterimage dash to the target", run: async () => { const a = WA(); speedLines(true, { angle: face(a) > 0 ? 0 : Math.PI, alpha: .25, n: 16 });
      await stepIn(a, ORC, 430, "dash"); speedLines(false); await wait(140); } },
    { name: "8 strikes · each rolls", gate: true, note: "RO Sonic Blow sound + effect, a hit or MISS per strike", run: async (C) => { const a = WA(), t = ORC, n = tv(C, "n"), gap = tv(C, "gap"), snd = tv(C, "snd");
      const R = sbResults(C); C.R = R; let total = 0, hp = 240, banner = true; const bannerFree = () => { const b = banner; banner = false; return b; };
      if (snd < 2) sfx("ro_sonicblow", .6); else sfx("wind7", .3);
      clip("ro_sonicblow", feet(t), { scale: t.s * tv(C, "fx") / 100, z: 3990, rate: clamp(667 / Math.max(300, n * gap), .45, 1.6) });
      await wait(tv(C, "lead")); markGate();
      for (let i = 0; i < n; i++) { const r = R[i], d = r.hit ? sbStrikeDmg(C, r) : 0; total += d;
        await sbStrike(C, a, t, i, r, d, bannerFree); if (d) { npcBar(t, hp, Math.max(0, hp - d), 240); hp = Math.max(0, hp - d); }
        await wait(gap); }
      lean(a, 0, 120).catch(() => {}); const k = R.filter((r) => r.hit).length;
      C.res = { k, n, total, hp, crits: R.filter((r) => r.crit).length, rolls: R };
      RUNLOG.sb = { ...C.res, perfect: k === n, basic: tv(C, "dmg"), at: Date.now() }; renderBalance(); await wait(160); } },
    { name: "Perfect (all strikes land)", note: "only on n/n: gold flash, the RO effect again, the ×1.5 as one gold hit", run: async (C) => { const r = C.res; if (!r || r.k < r.n) { await wait(100); return; }
      const t = ORC, c = center(t), bonus = Math.max(1, Math.round(r.total * (tv(C, "perf") - 1)));
      fdim(.45, 260, "#120608").catch(() => {}); sfx("crit", .5); if (tv(C, "snd") < 2) sfx("ro_hitdagger", .55); await whiteTo(.6, 70);
      clip("ro_sonicblow", feet(t), { scale: t.s * tv(C, "fx") / 100 * 1.35, z: 4004, rate: 1.4, filter: "sepia(.6) saturate(2.2) hue-rotate(-18deg) brightness(1.25)" });
      await whiteTo(0, 160); chroma(5, 240).catch(() => {}); impactRays(c, nP(C, 30), 30 * t.s, 520 * t.s, 380, "255,236,200"); sparks(c, nP(C, 26), GOLD, 1.3);
      shake(11, 340).catch(() => {}); gameNum(t, bonus, { crit: true, critBanner: false, isHit: false }); hitReact(t, "strong"); npcBar(t, r.hp, Math.max(0, r.hp - bonus), 240);
      r.total += bonus; r.bonus = bonus; RUNLOG.sb.total = r.total; RUNLOG.sb.bonus = bonus; renderBalance(); await wait(700); fdim(0, 400).catch(() => {}); } },
    { name: "Back", note: "hop home, no sound (v2)", run: async () => { await backHome(WA(), { quiet: true }); await wait(450); } },
  ] });

def("sk_attack", { status: "approved", boss: "sonic", name: "Attack · for scale", tag: "Melee · DEX + DEX · HR + 5 · one swing",
  intro: "A plain Sonic Katar swing (one accuracy roll, no penalty) to compare Sonic Blow's pace and numbers against. The weapon also keeps Double Strike (Two-weapon Fighting with this weapon); that rule is unchanged and not shown here.",
  tune: [TO("result", "Accuracy", ["Rolled (Sonic Blow's dice sliders)", "Force hit", "Force miss"], 1), T("dmg", "Damage, example (HR + 5)", 16, 5, 60, 1)],
  beats: [
    { name: "Namecard + dash", run: async () => { hudNoForm(); namecard("Sonic Katar", "⚔️"); await wait(300); await stepIn(WA(), ORC, 480, "move1"); } },
    { name: "Swing", gate: true, run: async (C) => { const a = WA(), t = ORC, S = SK.sonicblow.tune, g = (k) => S.find((x) => x.k === k).v; let r;
      if (tv(C, "result") === 0) r = rollAcc(DICE[g("dA")], DICE[g("dB")], g("bonus"), g("def")); else r = { hit: tv(C, "result") === 1, crit: false };
      markGate(); if (r.crit) await critCutin(WIELD);
      await lean(a, -10 * a.baseFlip, 70); sfx("ro_katar", .4); await lean(a, 16 * a.baseFlip, 80); const c = center(t);
      slashSheet(c, -.5, { L: hgt(t) * .9, w: 24 * t.s, rgb: r.hit ? PINK : STEEL, ms: 280 });
      if (r.hit) { sfx("ro_hitdagger", .45); clip("006_slash_physical", c, { scale: t.s, z: 4000 }); gameNum(t, tv(C, "dmg"), { crit: r.crit }); hitReact(t, "normal"); npcBar(t, 240, 240 - tv(C, "dmg"), 240); shake(3, 120).catch(() => {}); }
      else { gameNum(t, 0, { kind: "miss" }); slide(t, -face(t) * 16 * t.s, 80, t.dy).then(() => slide(t, 0, 160, t.dy)).catch(() => {}); }
      await lean(a, 0, 120); await wait(300); } },
    { name: "Back", run: async () => { await backHome(WA()); await wait(400); } },
  ] });

// ───────── Gunblade (replaces Imperial Gunblade): Sword DEX + MIG HR + 8 · odd accuracy total → +10 and Fire; Firearm DEX + INS HR + 5
function gbRoll(C, attrB) { const p = PDICE[WIELD], mode = tv(C, "roll");
  if (mode === 0) return rollAcc(p.dex, p[attrB], p.acc, tv(C, "def"));
  if (mode === 1) return { a: 3, b: 4, tot: 7 + p.acc, hit: true, crit: false };                // odd, lands
  if (mode === 2) return { a: 4, b: 4, tot: 8 + p.acc, hit: true, crit: false };                // even, lands
  if (mode === 3) return { a: 6, b: 6, tot: 12 + p.acc, hit: true, crit: true };                // crit: matching dice = always even
  return { a: 1, b: 1, tot: 2, hit: false, crit: false, fum: true }; }
def("gb_sword", { status: "approved", boss: "gunblade", name: "Attack · Sword", icon: "icon_gb", tag: "Melee · DEX + MIG · HR + 8 · Martial",
  intro: "A Sword swing. If the accuracy total is an <b>odd</b> number (and the attack hits), the blade fires: +10 damage and the damage becomes Fire. Matching dice make a crit's dice even, so with no (or an even) accuracy bonus a crit never fires; with an odd bonus it always does. See the open call below.",
  rules: "Roll = the wielder's real DEX + MIG dice (chips above) at the DEF slider, or forced. The Fire is a damage-type change, not Vulnerable: a Fire-weak target takes ×2, a Fire-resistant one ×½, on the whole hit.",
  tune: [TO("roll", "Accuracy", ["Rolled (wielder's DEX + MIG)", "Force odd · fires", "Force even · Physical", "Force crit (even · Physical)", "Force fumble"], 1),
    T("def", "Target DEF", 12, 6, 18, 1), T("dmg", "Swing damage, example (HR + 8)", 18, 5, 60, 1), T("fb", "Odd-roll bonus damage", 10, 0, 20, 1),
    TO("aff", "Target vs Fire", ["Neutral", "Vulnerable (×2)", "Resistant (×½)"], 0)],
  beats: [
    { name: "Namecard + dash", run: async () => { hudForm(1, true); namecard("Gunblade", "⚔️"); await wait(300); await stepIn(WA(), ORC); } },
    { name: "Roll", note: "odd: the gun fires through the blade, flame on the edge", run: async (C) => { const r = gbRoll(C, "mig"); C.r = r; C.fire = r.hit && r.tot % 2 === 1;
      if (r.crit) await critCutin(WIELD);
      if (C.fire) { const a = WA(); muzzle(a, .8); sfx("gunshot", .45); igniteBlade(a); await wait(420); } else await wait(180); } },
    { name: "Cut", gate: true, run: async (C) => { const a = WA(), t = ORC, r = C.r, c = center(t); markGate();
      await lean(a, -8 * a.baseFlip, 70); sfx("sword2", .38); await lean(a, 16 * a.baseFlip, 80);
      slashSheet(c, -.42, { L: hgt(t), w: 30 * t.s, rgb: C.fire ? FIRE : STEEL, ms: 300 });
      if (!r.hit) { gameNum(t, 0, { kind: "miss" }); slide(t, -face(t) * 16 * t.s, 80, t.dy).then(() => slide(t, 0, 160, t.dy)).catch(() => {}); await wait(400); return; }
      const aff = tv(C, "aff"), base = tv(C, "dmg") + (C.fire ? tv(C, "fb") : 0); let d = base;
      if (C.fire && aff === 1) d = base * 2; if (C.fire && aff === 2) d = Math.floor(base / 2);
      clip(C.fire ? "008_slash_fire" : "006_slash_physical", c, { scale: t.s * 1.1, z: 4000 });
      if (C.fire) { sfx("hitfire", .45); clip("003_hit_fire", c, { scale: t.s * .8, z: 4002 }); bloom(c, hgt(t) * .9); } else sfx("slashL", .4);
      gameNum(t, d, { element: C.fire ? "fire" : "physical", weak: C.fire && aff === 1, crit: r.crit }); hitReact(t, C.fire ? "strong" : "normal"); npcBar(t, 240, 240 - d, 240); shake(C.fire ? 6 : 3, 160).catch(() => {});
      RUNLOG.gb = { tot: r.tot, odd: r.tot % 2 === 1, fire: C.fire, d, at: Date.now() }; renderBalance();
      await lean(a, 0, 120); await wait(320); } },
    { name: "Back", run: async () => { await backHome(WA()); await wait(400); } },
  ] });
def("gb_gun", { status: "approved", boss: "gunblade", name: "Attack · Firearm", icon: "icon_gb", tag: "Ranged · DEX + INS · HR + 5 · Martial",
  intro: "A shot from the wielder's spot: the gun fires through the blade (muzzle flash + tracer), the game's pierce hit. No ability: the value of this form is the range.",
  tune: [TO("roll", "Accuracy", ["Rolled (wielder's DEX + INS)", "Force hit", "Force hit", "Force crit", "Force fumble"], 1), T("def", "Target DEF", 12, 6, 18, 1), T("dmg", "Shot damage, example (HR + 5)", 13, 5, 60, 1)],
  beats: [
    { name: "Namecard + aim", run: async () => { hudForm(2, true); namecard("Gunblade", "⚔️"); const a = WA(); sfx("key", .35); await lean(a, -5 * a.baseFlip, 260); await wait(320); } },
    { name: "Shot", gate: true, run: async (C) => { const a = WA(), t = ORC, p = hand(a), c = center(t), r = gbRoll(C, "ins"); markGate(); if (r.crit) await critCutin(WIELD);
      muzzle(a, 1.1); sfx("gunshot", .6);
      addP("hit", { x: p.x, y: p.y, life: 140, draw: (cx, q, tt) => { cx.strokeStyle = `rgba(${GOLD},${1 - tt})`; cx.lineWidth = 3; cx.beginPath(); cx.moveTo(lerp(p.x, c.x, tt * .6), lerp(p.y, c.y, tt * .6)); cx.lineTo(c.x, c.y); cx.stroke(); } });
      slide(a, -face(a) * 12, 90, a.dy).catch(() => {}); await wait(90);
      if (r.hit) { clip("011_pierce_physical", c, { scale: t.s * .8 }); sfx("slashL", .35); gameNum(t, tv(C, "dmg"), { crit: r.crit }); hitReact(t, "normal"); npcBar(t, 240, 240 - tv(C, "dmg"), 240); }
      else { gameNum(t, 0, { kind: "miss" }); slide(t, -face(t) * 14 * t.s, 80, t.dy).then(() => slide(t, 0, 160, t.dy)).catch(() => {}); }
      await slide(a, 0, 260, a.dy); await lean(a, 0, 200); await wait(600); } },
  ] });
def("gb_tf", { status: "approved", boss: "gunblade", name: "Transform", icon: "icon_gb", tag: "Free · once per turn, before your action",
  intro: "The transform, same timing as Lionheart (free, once per turn, before your action): a mechanical click and glint, the game's buff beat, the plate badge flips between Sword and Firearm. Gunblade has no DEF change and no Shield; only the attack profile changes.",
  tune: [TO("dir", "Direction", ["Sword → Firearm", "Firearm → Sword"], 0)],
  beats: [
    { name: "Click", run: async (C) => { const to = tv(C, "dir") === 0 ? 2 : 1; hudForm(to === 2 ? 1 : 2, true); const a = WA(); sfx("key", .45); await lean(a, -6 * a.baseFlip, 120);
      sfx(to === 2 ? "switch1" : "shing", .38); twinkles(hand(a), { n: 4, r: 10, rgb: to === 2 ? STEEL : GOLD }); flashActor(a, to === 2 ? "#bfe3ff" : "#ffe1a8", 300).catch(() => {}); await lean(a, 0, 160); await wait(200); } },
    { name: "Transform", gate: true, note: "buff beat, badge flips", run: async (C) => { const a = WA(); buffBeat(a); sfx("equip", .45); await wait(330); markGate(); hudForm(tv(C, "dir") === 0 ? 2 : 1); await wait(900); } },
  ] });

// ═════════ Balance panels (live from the sliders)
const sbT = (k) => SK.sonicblow.tune.find((t) => t.k === k).v;
const gbT = (k) => SK.gb_sword.tune.find((t) => t.k === k).v;
// Sonic Blow expected multiple of ONE normal hit, at accuracy bonus `bon` (penalty already in it)
function sbExpect(dA, dB, bon, def) { const n = sbT("n"), sh = sbT("share"), pf = sbT("perf"), cm = sbT("critm"), o = accOdds(dA, dB, bon, def), q = o.hit;
  const cf = q > 0 ? 1 + (cm - 1) * o.crit / q : 1; let E = 0; const rows = [];
  for (let k = 0; k <= n; k++) { const P = binom(n, k) * Math.pow(q, k) * Math.pow(1 - q, n - k), m = k * sh * (k === n ? pf : 1); E += P * m * cf; rows.push({ k, P, m }); }
  return { E, q, crit: o.crit, P8: Math.pow(q, n), rows }; }
const pct = (x) => (x * 100 < 1 && x > 0 ? (x * 100).toFixed(1) : Math.round(x * 100)) + "%";
const fx2 = (x) => x.toFixed(2) + "×";
function renderBalance() {
  const box = $("balance"); if (box && SK.sonicblow) {
    const dA = DICE[sbT("dA")], dB = DICE[sbT("dB")], bon = sbT("bonus"), pen = sbT("pen"), def = sbT("def"), n = sbT("n"), W = sbT("dmg");
    const s = sbExpect(dA, dB, bon - pen, def), basic = accOdds(dA, dB, bon, def).hit, ratio = basic > 0 ? s.E / basic : 0;
    const tier = (k) => k === n ? "Perfect" : k >= Math.ceil(n * .75) ? "Strong" : k >= Math.ceil(n * .375) ? "Mixed" : "Low";
    const rows = s.rows.map((r) => `<tr${r.k === n ? ' class="hl"' : ""}><th>${r.k}/${n} · ${tier(r.k)}</th><td>${fx2(r.m)}</td><td>${Math.round(W * r.m)} dmg</td><td>${pct(r.P)}</td></tr>`).join("");
    const L = RUNLOG.sb;
    box.innerHTML = `<div class="bal-big"><b>${fx2(ratio)}</b><span>Sonic Blow's expected damage ÷ a basic attack's expected damage (both can miss), at ${DIE_OPTS[sbT("dA")]} + ${DIE_OPTS[sbT("dB")]}${bon ? " +" + bon : ""} vs DEF ${def}</span></div>
      <p class="muted" style="margin:0">Per strike: ${pct(s.q)} to land at −${pen} (a basic attack: ${pct(basic)}). Expected ${fx2(s.E)} of one normal hit · all ${n} land (Perfect) ${pct(s.P8)}.</p>
      <table class="bal"><thead><tr><th>Strikes landed</th><th>× one hit</th><th>at ${W}</th><th>chance</th></tr></thead>${rows}
      <tr><th>Your last run</th><td colspan="3">${L ? `${L.k}/${L.n} landed${L.crits ? ` · ${L.crits} crit` : ""}${L.perfect ? ` · Perfect +${L.bonus ?? "…"}` : ""} · ${L.total} dmg (${fx2(L.total / L.basic)})` : "play Sonic Blow"}</td></tr></table>`;
    // the accuracy-penalty read: every party member's dice × X = 0..3, at the DEF slider
    const mat = $("penmat"); if (mat) { const PCN = { keren: "Keren · 2d8", d10: "a 2d10 wielder", zarg: "Zarg · 2d12 +3", blanche: "Blanche · 2d12" };
      const head = `<tr><th>Wielder (DEX + DEX)</th>${[0, 1, 2, 3].map((x) => `<th${x === pen ? ' class="hl"' : ""}>−${x}</th>`).join("")}</tr>`;
      const body = ["zarg", "blanche", "d10", "keren"].map((id) => { const p = id === "d10" ? { dex: 10, acc: 0 } : PDICE[id], b0 = accOdds(p.dex, p.dex, p.acc, def).hit;
        return `<tr><th>${PCN[id]}</th>${[0, 1, 2, 3].map((x) => { const e = sbExpect(p.dex, p.dex, p.acc - x, def); const r = b0 > 0 ? e.E / b0 : 0;
          return `<td${x === pen ? ' class="hl"' : ""}><b>${fx2(r)}</b><br><small>land ${pct(e.q)} · 8/8 ${pct(e.P8)}</small></td>`; }).join("")}</tr>`; }).join("");
      mat.innerHTML = `<table class="bal mat">${head}${body}</table><p class="muted" style="margin:6px 0 0">Each cell: Sonic Blow ÷ that wielder's basic attack (expected), per-strike land chance, Perfect chance. DEF ${def} (move the DEF slider). 30 MP buys the multiple above 1.0×.</p>`; }
    // full damage chain: the Perfect × multiplies after weapon efficiency and affinity like every multiplier
    const aff = $("sbaff"); if (aff) { const e = s.E * W, pf = n * sbT("share") * sbT("perf") * W;
      aff.innerHTML = `<table class="bal"><tr><th>Target (Physical)</th><th>expected</th><th>Perfect</th></tr>
        ${[["Neutral", 1], ["Resistant to Physical ×½", .5], ["Vulnerable to Physical ×2", 2], ["Vulnerable + 150% weapon efficiency", 3]].map(([l, f]) => `<tr><th>${l}</th><td>${Math.round(e * f)}</td><td>${Math.round(pf * f)}</td></tr>`).join("")}</table>`; }
  }
  const gb = $("gbbal"); if (gb && SK.gb_sword) { const def = gbT("def"), W = gbT("dmg"), fb = gbT("fb");
    const PCN = { keren: "Keren · d8 + d6", hina: "Hina · d6 + d8", zarg: "Zarg · d12 + d8 +3", blanche: "Blanche · d12 + d12" };
    const rows = ["blanche", "zarg", "keren", "hina"].map((id) => { const p = PDICE[id], o = accOdds(p.dex, p.mig, p.acc, def), even = o.hit - o.oddHit;
      const ne = even * W + o.oddHit * (W + fb), vu = even * W + o.oddHit * (W + fb) * 2, rs = even * W + o.oddHit * Math.floor((W + fb) / 2);
      return `<tr><th>${PCN[id]}</th><td>${pct(o.hit)}</td><td>${pct(o.oddHit)}</td><td>${ne.toFixed(1)}</td><td>${vu.toFixed(1)}</td><td>${rs.toFixed(1)}</td></tr>`; }).join("");
    const L = RUNLOG.gb;
    gb.innerHTML = `<table class="bal"><thead><tr><th>Wielder (DEX + MIG)</th><th>hits</th><th>fires (odd + hit)</th><th>exp. dmg</th><th>Fire-weak</th><th>Fire-resist</th></tr></thead>${rows}
      <tr><th>Your last swing</th><td colspan="5">${L ? `total ${L.tot} · ${L.odd ? "odd" : "even"} · ${L.fire ? "fired" : "Physical"} · ${L.d} dmg` : "play Attack · Sword"}</td></tr></table>
      <p class="muted" style="margin:6px 0 0">Per swing at DEF ${def}, swing ${W}, odd bonus +${fb}. Forcing the damage to Fire is a gamble: a Fire-resistant target halves the whole fired hit.</p>`; }
}
