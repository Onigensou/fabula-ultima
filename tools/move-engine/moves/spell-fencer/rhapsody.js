// ═════════ Spell Fencer · Spellblade Rhapsody activation + the +1 Resonance pulse — HOST-NEUTRAL (move-engine)
// The same file runs on the mockup page (moves/spell-fencer/page.js) and in the game (Spellblade Rhapsody's
// animation_script; resonance_gain through a play_animation row). Self-only moves: no target, no damage number.
// The held auras after these moves (Rhapsody Turn braid, Next Spell / Next Attack, Resonance ready) are NOT drawn here:
// they are token status cues (battle-director/status-cues.js), driven by the class's marker AEs.

def("rhapsody", { status: "approved", boss: "rhapsody", name: "Spellblade Rhapsody", icon: "icon_rh", tag: "Action · spend 2 Resonance · self",
  changes: [{ id: "v2-magical", re: "This is the ultimate move, so I want a more intense vfx, show red and blue particle being unleashed together. I do like the vfx motion, but is it possible to make it more 'magical'?",
    text: "Kept the approved motion (guard stance + the braid climb) and built a Red Mage-style spell around it, all new pixelfx: a violet mana orb charges at Keren's hand (red and blue motes drawn in); a two-tone magic circle blooms under her feet (red outer ring with rose thorns, blue inner ring with crystal ticks, turning apart, runes lighting red / blue) with a small crystal sigil above her head; rose petals ride the red ribbon and crystal flakes the blue one; at the meeting both manas UNLEASH together: crimson petals and blue crystal shards burst out of her body in one spray (the shards shatter into flakes), a white-violet starburst behind her, light streaks sweeping arcs, a white-violet light column out of the circle, a short scene dim + soft flash, the buff beat, a chime and a heavier magic sound (selects). Then petals and flakes drift down and the circle dissolves into motes. About 3.3 s." }],
  intro: "The class's ultimate turn. Keren gathers both manas into a violet orb at her hand and takes a short guard stance while a red-and-blue magic circle blooms under her feet. The red ribbon (blade, rose petals riding it) and the blue ribbon (spell, crystal flakes riding it) spiral up and braid; where they meet both manas are unleashed together: crimson petals and blue crystal shards burst out of her, a white-violet starburst opens behind her, light streaks sweep round, a light column fires out of the circle, plus the game's buff beat. Then petals and flakes drift down, the circle dissolves into motes, and the held <b>Rhapsody Turn</b> braid aura takes over.",
  rules: "Every hero piece is pixelfx (three layers each: back under the battler, front over, light added): fu/mana-charge, fu/duality-sigil, fu/spellblade-braid (now with petal / flake riders), fu/duality-unleash. Baked choices (radius, notes, palette, crown, burst density) are pre-made exports picked by selects. The sigil is started so its light column fires on the meeting. Red Mage reference: the language, not the art.",
  tune: [T("stance", "Guard stance (ms)", 330, 150, 900, 10), T("lean", "Guard stance lean (deg, away from the foe)", 5, 0, 14, 1),
    T("crouch", "Guard stance crouch (%)", 5, 0, 12, 1),
    T("climb", "Ribbons start at (ms; the charge plays before)", 600, 300, 1200, 20), T("charge", "Mana orb size (%)", 50, 50, 200, 5),
    T("speed", "Ribbon speed (% of the clip's 2.23 s)", 125, 70, 180, 5), T("size", "Braid height (% of Keren's drawn height)", 100, 70, 150, 5),
    TO("radius", "Helix radius (baked)", ["Narrow (14 px)", "Medium (17 px)", "Wide (20 px)"], 1),
    TO("notes", "Music notes in the braid's burst (baked)", ["4", "7", "10"], 1),
    TO("pal", "Ribbon colours (baked)", ["Sandbox red / blue", "Deeper crimson / royal blue"], 0),
    T("sigil", "Magic circle size (%)", 120, 50, 160, 5), TO("crown", "Crystal sigil above the head (baked)", ["On", "Off"], 0),
    TO("dens", "Unleash: petals + shards (baked)", ["Light (14 + 10)", "Full (22 + 16)", "Heavy (32 + 24)"], 1),
    T("burst", "Unleash size (%)", 120, 60, 170, 5), T("brate", "Unleash speed (%)", 135, 70, 160, 5),
    T("dim", "Scene dim at the unleash (0 = off)", .35, 0, .8, .05), T("dimms", "Dim hold (ms)", 700, 0, 2000, 50),
    T("wflash", "Screen flash peak (0 = off)", .3, 0, 1, .05), T("shake", "Shake (px, 0 = off)", 3, 0, 12, 1),
    TO("csnd", "Charge sound", ["Beginspell", "ChargingA", "Cast1", "None"], 0), T("csndv", "Charge sound volume", .35, 0, 1, .05),
    TO("rise", "Ribbon rise sound", ["Wind7 (soft whoosh)", "Magic1", "None"], 0), T("risev", "Rise sound volume", .25, 0, .8, .05),
    TO("heavy", "Unleash · heavy magic sound", ["SE_SYS_Gacha_Crystal", "Saint3", "EXSkill", "Magic4", "None"], 0), T("heavyv", "Heavy sound volume", .45, 0, 1, .05),
    TO("petal", "Unleash · petal sound", ["Flower", "None"], 0), T("petalv", "Petal sound volume", .3, 0, 1, .05),
    TO("chime", "Chime at the unleash", ["Bell3", "Starlight", "Item3", "Saint5", "None"], 0), T("chimev", "Chime volume", .35, 0, 1, .05),
    TO("buff", "Game buff beat at the unleash (051 + Powerup)", ["On", "Off"], 0),
    T("flash", "Body glow at the unleash (ms, 0 = off)", 420, 0, 900, 20), T("hold", "Hold after it settles (ms)", 100, 0, 1200, 20)],
  beats: [
    { name: "Charge · guard stance", note: "violet mana orb at the hand; the magic circle starts drawing", run: async (C) => { const a = SFC(), ms = tv(C, "stance"), rate = tv(C, "speed") / 100;
      pxfx(SF_CHARGE, hand(a), hgt(a) * 80 / 60 * tv(C, "charge") / 100);
      const cs = ["beginspell", "charginga", "cast1", null][tv(C, "csnd")]; if (cs) sfx(cs, tv(C, "csndv"));
      sfx("guard", .3); squash(a, 1 + tv(C, "crouch") / 200, 1 - tv(C, "crouch") / 100, ms * .5).catch(() => {});
      lean(a, tv(C, "lean") * a.baseFlip, ms * .5, EASE.sine).catch(() => {});
      // the circle's light column fires 1200 ms into its clip: start it so that lands on the ribbons' meeting
      const climb = tv(C, "climb"), sig = Math.max(0, climb + 1100 / rate - 1200);
      if (sig < climb) { await wait(sig); pxfx(sfSigilKey(C), feet(a), hgt(a) * 220 / 60 * tv(C, "sigil") / 100); await wait(climb - sig); }
      else { await wait(climb); C.sigLate = sig - climb; } } },
    { name: "Ribbons climb · braid", note: "red ribbon with rose petals, blue ribbon with crystal flakes", run: async (C) => { const a = SFC(), rate = tv(C, "speed") / 100;
      pxfx(sfBraidKey(C), feet(a), hgt(a) * 1.8 * tv(C, "size") / 100, { rate });
      const rise = ["wind7", "magic1", null][tv(C, "rise")]; if (rise) sfx(rise, tv(C, "risev"));
      if (C.sigLate != null) { await wait(C.sigLate); pxfx(sfSigilKey(C), feet(a), hgt(a) * 220 / 60 * tv(C, "sigil") / 100); await wait(1100 / rate - C.sigLate); }
      else await wait(1100 / rate); } },
    { name: "UNLEASH", gate: true, note: "petals + crystal shards burst out together, starburst, streaks, light column, buff beat", run: async (C) => { const a = SFC(), br = tv(C, "brate") / 100;
      markGate();
      pxfx(sfUnleashKey(C), feet(a), hgt(a) * 200 / 60 * tv(C, "burst") / 100, { rate: br });
      if (tv(C, "dim") > 0) fdim(tv(C, "dim"), 120, "#0a0614").then(() => wait(tv(C, "dimms"))).then(() => fdim(0, 600)).catch(() => {});
      if (tv(C, "wflash") > 0) flash("#f4e8ff", tv(C, "wflash"), 40, 260).catch(() => {});
      if (tv(C, "shake") > 0) shake(tv(C, "shake"), 260).catch(() => {});
      const hv = ["gacha_crystal", "saint3", "exskill", "magic4", null][tv(C, "heavy")]; if (hv) sfx(hv, tv(C, "heavyv"));
      if (tv(C, "petal") === 0) sfx("flower", tv(C, "petalv"));
      const ch = ["bell3", "starlight", "item3", "saint5", null][tv(C, "chime")]; if (ch) sfx(ch, tv(C, "chimev"));
      if (tv(C, "buff") === 0) buffBeat(a);
      if (tv(C, "flash") > 0) flashActor(a, "#f0d0ff", tv(C, "flash")).catch(() => {});
      squash(a, 1, 1, 260, EASE.sine).catch(() => {}); lean(a, 0, 420, EASE.sine).catch(() => {});
      await wait(500); } },
    { name: "Settle · Rhapsody Turn", note: "petals + flakes drift down, the circle dissolves into motes; the braid aura takes over", run: async (C) => { const br = tv(C, "brate") / 100;
      await wait(Math.max(0, 2133 / br - 500)); await wait(tv(C, "hold")); } },
  ] });

def("resonance_gain", { status: "approved", boss: "resonance", name: "+1 Resonance", icon: "icon_reso", tag: "Pulse · a switch grants a stack",
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
