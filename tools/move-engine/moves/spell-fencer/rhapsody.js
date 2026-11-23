// ═════════ Spell Fencer · Spellblade Rhapsody activation + the +1 Resonance pulse — HOST-NEUTRAL (move-engine)
// The same file runs on the mockup page (moves/spell-fencer/page.js) and in the game (Spellblade Rhapsody's
// animation_script; resonance_gain through a play_animation row). Self-only moves: no target, no damage number.
// The held auras after these moves (Rhapsody Turn braid, Next Spell / Next Attack, Resonance ready) are NOT drawn here:
// they are token status cues (battle-director/status-cues.js), driven by the class's marker AEs.

def("rhapsody", { status: "new", boss: "rhapsody", name: "Spellblade Rhapsody", icon: "icon_rh", tag: "Action · spend 2 Resonance · self",
  intro: "The turn's opening flourish. Keren takes a short guard stance; a red ribbon (the blade) and a blue ribbon (the spell) spiral up round her from opposite sides of the floor and braid into one helix. Where they meet at the top: a white flash, pixel music notes burst off, and the game's buff beat (RPG Maker MV 051_powerup_1 + Powerup.ogg). The braid turns once and thins away from the feet up, and the held <b>Rhapsody Turn</b> braid aura takes over (its own entry under Held auras; the sandbox plays the whole loop).",
  rules: "Ribbons + notes = one pixelfx effect (fu/spellblade-braid, three layers: back under the battler, front over, light added). Helix radius, note count and palette are baked per clip: each combination is its own export, picked by the selects below. Ribbon speed = the clip's play rate.",
  tune: [T("stance", "Guard stance before the ribbons (ms)", 320, 150, 900, 10), T("lean", "Guard stance lean (deg, away from the foe)", 5, 0, 14, 1),
    T("crouch", "Guard stance crouch (%)", 5, 0, 12, 1),
    T("speed", "Ribbon speed (% of the clip's 2.23 s)", 125, 70, 180, 5), T("size", "Braid height (% of Keren's drawn height)", 100, 70, 150, 5),
    TO("radius", "Helix radius (baked)", ["Narrow (14 px)", "Medium (17 px)", "Wide (20 px)"], 1),
    TO("notes", "Music notes in the burst (baked)", ["4", "7", "10"], 1),
    TO("pal", "Ribbon colours (baked)", ["Sandbox red / blue", "Deeper crimson / royal blue"], 0),
    TO("rise", "Ribbon rise sound", ["Wind7 (soft whoosh)", "Magic1", "None"], 0), T("risev", "Rise sound volume", .25, 0, .8, .05),
    TO("chime", "Chime at the meeting", ["Bell3", "Starlight", "Item3", "Saint5", "None"], 0), T("chimev", "Chime volume", .4, 0, 1, .05),
    TO("buff", "Game buff beat at the meeting (051 + Powerup)", ["On", "Off"], 0),
    T("flash", "Body glow at the meeting (ms, 0 = off)", 360, 0, 900, 20), T("hold", "Hold after the braid fades (ms)", 100, 0, 1200, 20)],
  beats: [
    { name: "Guard stance", note: "lean back + small crouch", run: async (C) => { const a = SFC(), ms = tv(C, "stance");
      sfx("guard", .3); squash(a, 1 + tv(C, "crouch") / 200, 1 - tv(C, "crouch") / 100, ms * .5).catch(() => {});
      await lean(a, tv(C, "lean") * a.baseFlip, ms * .5, EASE.sine); await wait(ms * .5); } },
    { name: "Ribbons climb · braid", gate: true, note: "red + blue spiral up and braid; flash, notes, buff beat where they meet", run: async (C) => { const a = SFC(), rate = tv(C, "speed") / 100;
      C.fx = pxfx(sfBraidKey(C), feet(a), hgt(a) * 1.8 * tv(C, "size") / 100, { rate });
      const rise = ["wind7", "magic1", null][tv(C, "rise")]; if (rise) sfx(rise, tv(C, "risev"));
      await wait(1100 / rate); markGate();
      const ch = ["bell3", "starlight", "item3", "saint5", null][tv(C, "chime")]; if (ch) sfx(ch, tv(C, "chimev"));
      if (tv(C, "buff") === 0) buffBeat(a);
      if (tv(C, "flash") > 0) flashActor(a, "#ffe6b0", tv(C, "flash")).catch(() => {});
      squash(a, 1, 1, 260, EASE.sine).catch(() => {}); lean(a, 0, 420, EASE.sine).catch(() => {});
      await wait(450 / rate); } },
    { name: "Settle · Rhapsody Turn", note: "the braid turns once and thins away; the held braid aura takes over", run: async (C) => { const rate = tv(C, "speed") / 100;
      await wait((2233 - 1550) / rate); await wait(tv(C, "hold")); } },
  ] });

def("resonance_gain", { status: "new", boss: "resonance", name: "+1 Resonance", icon: "icon_reso", tag: "Pulse · a switch grants a stack",
  intro: "Plays when a switch (weapon attack ↔ Offensive Spell) grants a Resonance stack: a small gold ring pings out from the chest, a second violet one just behind it, one pixel music note rises off, a soft chime. Short on purpose: it rides on the end of the attack or spell that earned it.",
  tune: [T("ring", "Ring size (px at Keren's size)", 34, 14, 80, 1), T("ringms", "Ring time (ms)", 520, 200, 1200, 20), T("ring2", "Second (violet) ring delay (ms, 0 = off)", 110, 0, 400, 10),
    T("note", "Note rise (px)", 46, 0, 120, 2), T("notems", "Note time (ms)", 760, 300, 1600, 20), T("cell", "Note pixel size (px)", 3, 2, 6, 1),
    TO("chime", "Chime", ["Item3", "Bell1", "Starlight", "None"], 0), T("chimev", "Chime volume", .35, 0, 1, .05),
    T("twinkle", "Twinkles", 2, 0, 6, 1), T("tail", "Wait after (ms)", 120, 0, 600, 20)],
  beats: [
    { name: "Ping", gate: true, note: "gold ring + violet ring at the chest, one note rises, chime", run: async (C) => { const a = SFC(), p = sfChest(a), k = hgt(a) / 160;
      markGate(); const ch = ["item3", "bell1", "starlight", null][tv(C, "chime")]; if (ch) sfx(ch, tv(C, "chimev"));
      ring(p, { rgb: SF_GOLD, r0: 4 * k, r1: tv(C, "ring") * k, ms: tv(C, "ringms"), sy: .92, w: 3 * k, layer: "hit" });
      addP("hit", { x: p.x, y: p.y, life: tv(C, "ringms") * .6, draw: (c, q, t) => glow(c, q.x, q.y, 22 * k * (1 - t * .5), SF_GOLD, .55 * (1 - t)) });
      if (tv(C, "twinkle") > 0) twinkles(p, { n: tv(C, "twinkle"), r: 16 * k, rgb: SF_GOLD });
      const rise = tv(C, "note") * k, u = tv(C, "cell") * Math.max(.75, k), side = -a.baseFlip * 10 * k;
      addP("hit", { x: p.x + side, y: p.y - 6 * k, life: tv(C, "notems"), draw: (c, q, t) => { const e = EASE.outCubic(t), al = t < .15 ? t / .15 : t > .7 ? 1 - (t - .7) / .3 : 1;
        const x = q.x + Math.sin(t * 6) * 3 * k, y = q.y - rise * e; glow(c, x, y - 4 * u, 9 * u, SF_GOLD, .35 * al); sfNote(c, x, y, u, SF_GOLD, al); } });
      if (tv(C, "ring2") > 0) { await wait(tv(C, "ring2")); ring(p, { rgb: SF_VIOLET, r0: 4 * k, r1: tv(C, "ring") * k * .8, ms: tv(C, "ringms"), sy: .92, w: 2 * k, layer: "hit" }); }
      await wait(Math.max(tv(C, "ringms"), tv(C, "notems")) - tv(C, "ring2") * (tv(C, "ring2") > 0 ? 1 : 0)); } },
    { name: "Tail", note: "a short wait so the next beat does not stack on it", run: async (C) => { await wait(tv(C, "tail")); } },
  ] });
