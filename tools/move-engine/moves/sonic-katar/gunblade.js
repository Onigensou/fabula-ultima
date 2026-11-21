// ═════════ Gunblade (replaces Imperial Gunblade) · the three approved moves (mockup v2, round rmwqcke9s, 2026-11-21) — HOST-NEUTRAL
// The same file runs in the Sonic Katar mockup page and in the game (move-engine). Sword DEX + MIG HR + 8: an odd Accuracy
// total OR a Critical Success on a hit → +10 and Fire (the build ruling of 2026-11-21: "odd OR crit"); Firearm DEX + INS HR + 5.
// Changes from the approved page: (1) gbRoll() takes the GAME's real roll first (moveResult), the page's sliders otherwise;
// (2) the fire rule includes the crit (the page's v2 fired on odd only, before the build ruling).
// the Accuracy result: the game's real roll when the host has one, else the page's sliders (rolled with the wielder's dice, or forced)
function gbRoll(C, attrB) { const R = moveResult(ORC);
  if (R) return { tot: R.total == null ? 0 : R.total, hit: R.hit && !R.fumble, crit: R.crit, fum: R.fumble, real: true };
  const p = (typeof PDICE !== "undefined" && PDICE[WIELD]) || { dex: 8, mig: 8, ins: 8, acc: 0 }, mode = tv(C, "roll");
  if (mode === 0) return rollAcc(p.dex, p[attrB], p.acc, tv(C, "def"));
  if (mode === 1) return { a: 3, b: 4, tot: 7 + p.acc, hit: true, crit: false };                // odd, lands
  if (mode === 2) return { a: 4, b: 4, tot: 8 + p.acc, hit: true, crit: false };                // even, lands
  if (mode === 3) return { a: 6, b: 6, tot: 12 + p.acc, hit: true, crit: true };                // crit: matching dice = always even
  return { a: 1, b: 1, tot: 2, hit: false, crit: false, fum: true }; }
def("gb_sword", { status: "approved", boss: "gunblade", name: "Attack · Sword", icon: "icon_gb", tag: "Melee · DEX + MIG · HR + 8 · Martial",
  intro: "A Sword swing. If the accuracy total is an <b>odd</b> number or the hit is a <b>Critical Success</b>, the blade fires: +10 damage and the damage becomes Fire (build ruling 2026-11-21: odd OR crit).",
  rules: "Roll = the wielder's real DEX + MIG dice (chips above) at the DEF slider, or forced. The Fire is a damage-type change, not Vulnerable: a Fire-weak target takes ×2, a Fire-resistant one ×½, on the whole hit.",
  tune: [TO("roll", "Accuracy", ["Rolled (wielder's DEX + MIG)", "Force odd · fires", "Force even · Physical", "Force crit (fires: crit)", "Force fumble"], 1),
    T("def", "Target DEF", 12, 6, 18, 1), T("dmg", "Swing damage, example (HR + 8)", 18, 5, 60, 1), T("fb", "Odd-roll bonus damage", 10, 0, 20, 1),
    TO("aff", "Target vs Fire", ["Neutral", "Vulnerable (×2)", "Resistant (×½)"], 0)],
  beats: [
    { name: "Namecard + dash", run: async () => { hudForm(1, true); namecard("Gunblade", "⚔️"); await wait(300); await stepIn(WA(), ORC); } },
    { name: "Roll", note: "odd: the gun fires through the blade, flame on the edge", run: async (C) => { const r = gbRoll(C, "mig"); C.r = r; C.fire = r.hit && (r.tot % 2 === 1 || !!r.crit);
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

