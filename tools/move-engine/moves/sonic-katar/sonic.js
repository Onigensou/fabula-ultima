// ═════════ Sonic Katar · Sonic Blow (Chain 8 Volley) + the plain attack for scale — HOST-NEUTRAL (move-engine)
// The approved moves of the Sonic Katar mockup v2 (round rmwqcke9s, 2026-11-21). Strike / swing results go through
// shared/results.js: the game's planned Chain strikes (with its Perfect strike) or the real Accuracy roll, else the page's
// result picker, else these moves' own sliders. v1.0.652 ships Sonic Blow's hand-made port; this file is the comparison.
const DIE_OPTS = ["d6", "d8", "d10", "d12"];
// ───────── Sonic Blow helpers
// strike results: rolled with the game's dice rule, or forced to k landed (forced = no crits, the k hits spread at random)
// (shared/results.js moveChain: the game's plan includes its Perfect strike, flagged perfect)
function sbResults(C) { const n = tv(C, "n");
  return moveChain(ORC, n, () => { const mode = tv(C, "result");
    if (mode === 0) { const dA = DICE[tv(C, "dA")], dB = DICE[tv(C, "dB")], bon = tv(C, "bonus") - tv(C, "pen"), def = tv(C, "def");
      return Array.from({ length: n }, () => rollCheck(dA, dB, bon, def)); }
    return forcedChain(n, Math.min(n, [n, 6, 4, 2, 0][mode - 1])); }); }
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
    { name: "8 strikes · each rolls", gate: true, note: "RO Sonic Blow sound + effect, a hit or MISS per strike", run: async (C) => { const a = WA(), t = ORC, gap = tv(C, "gap"), snd = tv(C, "snd");
      const ALL = sbResults(C), R = ALL.filter((x) => !x.perfect), n = R.length; C.R = R;
      // Perfect: the game's plan says so (its Perfect strike); on a page, every strike landed
      const perfect = ALL.some((x) => x.perfect) || (!ALL.some((x) => x.source === "game") && R.every((x) => x.hit)); let total = 0, hp = 240, banner = true; const bannerFree = () => { const b = banner; banner = false; return b; };
      if (snd < 2) sfx("ro_sonicblow", .6); else sfx("wind7", .3);
      clip("ro_sonicblow", feet(t), { scale: t.s * tv(C, "fx") / 100, z: 3990, rate: clamp(667 / Math.max(300, n * gap), .45, 1.6) });
      await wait(tv(C, "lead")); markGate();
      for (let i = 0; i < n; i++) { const r = R[i], d = r.hit ? sbStrikeDmg(C, r) : 0; total += d;
        await sbStrike(C, a, t, i, r, d, bannerFree); if (d) { npcBar(t, hp, Math.max(0, hp - d), 240); hp = Math.max(0, hp - d); }
        await wait(gap); }
      lean(a, 0, 120).catch(() => {}); const k = R.filter((r) => r.hit).length;
      C.res = { k, n, total, hp, crits: R.filter((r) => r.crit).length, rolls: R, perfect };
      RUNLOG.sb = { ...C.res, perfect: k === n, basic: tv(C, "dmg"), at: Date.now() }; renderBalance(); await wait(160); } },
    { name: "Perfect (all strikes land)", note: "only on n/n: gold flash, the RO effect again, the ×1.5 as one gold hit", run: async (C) => { const r = C.res; if (!r || !r.perfect) { await wait(100); return; }
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
      r = moveCheck(t, () => (tv(C, "result") === 0 ? rollCheck(DICE[g("dA")], DICE[g("dB")], g("bonus"), g("def")) : tv(C, "result") === 1 ? CHECK_PRESETS.hit(0) : CHECK_PRESETS.miss(0)));
      markGate(); if (r.crit) await critCutin(WIELD);
      await lean(a, -10 * a.baseFlip, 70); sfx("ro_katar", .4); await lean(a, 16 * a.baseFlip, 80); const c = center(t);
      slashSheet(c, -.5, { L: hgt(t) * .9, w: 24 * t.s, rgb: r.hit ? PINK : STEEL, ms: 280 });
      if (r.hit) { sfx("ro_hitdagger", .45); clip("006_slash_physical", c, { scale: t.s, z: 4000 }); gameNum(t, tv(C, "dmg"), { crit: r.crit }); hitReact(t, "normal"); npcBar(t, 240, 240 - tv(C, "dmg"), 240); shake(3, 120).catch(() => {}); }
      else { gameNum(t, 0, { kind: "miss" }); slide(t, -face(t) * 16 * t.s, 80, t.dy).then(() => slide(t, 0, 160, t.dy)).catch(() => {}); }
      await lean(a, 0, 120); await wait(300); } },
    { name: "Back", run: async () => { await backHome(WA()); await wait(400); } },
  ] });

