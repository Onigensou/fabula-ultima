# Monster Audit — Valley of the Dragon + Fafnir Castle

2026-10-21 · party Hina, Keren, Blanche, Zarg · mean PC HP 118

> Numbers against the design rules, not verdicts. Hit rates are the party's L41 averages. "Resisted hit" checks elites and bosses only. PE (≤ 33%) and the live linters are not checked here.

| Monster | Rank | Lvl | HP | Turns | DEF (party hits) | MDEF (party hits) | VU | RS / IM / AB | Basic attack · strongest (avg) | Rules broken | Design record |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ⭐️ Fafnir | champion | 50 | 1824 | 4 | 16 (26%) | 17 (20%) | light | air, bolt, fire / dark, earth / — | Rend 58 · Condemn 108 | resisted hit = 25% of PC HP (< 25%); not simulated: Torment: a player decides (ask); Torment: redirect target; Condemn: a player decides (ask); Condemn: redirect target; Zero Power: Cruel Ultimatum: open action menu | draft |
| Ampere | soldier | 43 | 175 | 1 | 10 (>58%) | 10 (>58%) | earth | bolt / — / — | Bubble Beam 29 · Bubble Splash 47 ×all | (+1 intended) | draft |
| Asura | elite | 38 | 900 | 4 | 15 (33%) | 13 (49%) | air, bolt, fire, ice | — / — / — | Elemental Slash (Enchanted) 49 | resisted hit = 21% of PC HP (< 25%) (+3 intended) | draft |
| Carlbero | elite | 50 | 640 | 4 | 11 (>58%) | 14 (41%) | fire | dark, poison / — / — | Tentacle Slap 47 ×3 · Mind Sap 57 | (+1 intended) | draft |
| Death Gazer | soldier | 50 | 150 | 1 | 8 (>58%) | 16 (26%) | light | dark, poison / — / — | Eye Beam 30 · Mind Sear 43 | (+2 intended) | draft |
| Dire Orc | soldier | 50 | 240 | 1 | 10 (>58%) | 6 (>58%) | ice | earth / — / — | Skull Splitter 66 | (+1 intended) | draft |
| Dragon Guard | soldier | 50 | 250 | 1 | 12 (58%) | 10 (>58%) | ice | fire, poison / — / — | Saber 51 | — | draft |
| Drakoza | soldier | 43 | 140 | 1 | 11 (>58%) | 10 (>58%) | light | dark / — / — | Dragon Claw 46 | — | draft |
| Electro Slime | soldier | 40 | 45 | 1 | 6 (>58%) | 6 (>58%) | earth | — / poison / bolt | Static Shot 36 | (+2 intended) | draft |
| Gigas | elite | 45 | 800 | 1 | 12 (58%) | 10 (>58%) | bolt, fire, poison | physical, air, earth / — / — | Heavy Swing 128 | (+2 intended) | draft |
| Imp | soldier | 50 | 110 | 1 | 15 (33%) | 14 (41%) | light | dark, fire / — / — | Pitchfork 49 | — | draft |
| Iron Colossus | elite | 52 | 700 | 1 | 14 (41%) | 8 (>58%) | bolt | physical, earth / poison / — | Siege Fist 42 | (+3 intended) | draft |
| Kirin | elite | 50 | 210 | 1 | 14 (41%) | 15 (33%) | poison | bolt / — / — | Horn Rush 69 | — | draft |
| Lightning Prism | soldier | 45 | 150 | 1 | 10 (>58%) | 16 (26%) | physical, earth | — / poison / bolt | Arc Spark 31 · Fulgur Finis 70 ×3 | (+3 intended) | draft |
| Mana Ray | soldier | 45 | 115 | 1 | 11 (>58%) | 10 (>58%) | earth, ice | bolt, fire / — / — | Mana Stinger 46 · Volt Stinger 62 | (+1 intended) | draft |
| Mist Dragon | elite | 45 | 200 | 1 | 14 (41%) | 13 (49%) | air | — / poison / — | Phantom Shift: Thunder Strike 38 · Mist Breath 46 ×3 | best basic attack avg 38 < 45; resisted hit = 16% of PC HP (< 25%) | draft |
| Obsidrax | soldier | 46 | 180 | 1 | 13 (49%) | 11 (>58%) | ice | earth / bolt / — | Basalt Crush 44 | best basic attack avg 44 < 45 (+1 intended) | draft |
| Rakshasa | elite | 40 | 1200 | 4 | 14 (41%) | 12 (58%) | light | dark, poison / — / — | Severing Verdict 166 | (+1 intended) | draft |
| Roo | soldier | 50 | 255 | 1 | 13 (49%) | 13 (49%) | light | dark / physical, poison / — | — | (+1 intended) | draft |
| Skizzik | soldier | 48 | 130 | 1 | 12 (58%) | 8 (>58%) | earth | — / poison / bolt | Thunder Strike 37 | (+2 intended) | draft |
| Succubus | soldier | 50 | 180 | 1 | 12 (58%) | 14 (41%) | light | dark, ice / — / — | Rake 42 · Draining Kiss 56 | best basic attack avg 42 < 45 (+1 intended) | draft |

## Design records

> From `dossiers/<monster>.md` (`node bin/dossier.js <name>` for the full brief). **Intended** findings break a rule on purpose — judge them with the reason, not the rule. **DRIFT** means the sheet no longer matches the design.

### ⭐️ Fafnir — draft · 2026-10-21
- blind spot: Mindscape cannot simulate the player choices: Torment / Condemn redirects (ask) and Cruel Ultimatum's menu.
- blind spot: The phase latch firing off the live resource ledger is verified by construction, never watched in a resolved fight.
- open: From the checkup, unchanged: Condemn's damage (can drop a healthy PC), the two IM affinities (dark + earth), dagger EF 50 stacking with IM dark.
- open: Zero Trigger: Suffering grants ZP on ANY turn start — up to 8 ZP/round at 4 activations. Intended?
- open: Deployment: also a 25% roll on Eisendrache Burning - Enemies alongside L13-15 soldiers — keep?

### Ampere — draft · 2026-10-21
- intended (unconfirmed): best basic attack avg 29 < 45 — Setup monster: Bubble Beam's job is Wet (VU bolt) for the rest of the roster, not damage. (claude 2026-08-16)
- open: Action pattern row P1 is an 'always' row with no action name — leftover?

### Asura — draft · 2026-10-21
- intended (unconfirmed): 4 VU (rule: exactly 1 for elite) — Adaptive affinity: the four elements start VU and each flips to RS when its Mark is lit — the 4 VU are the puzzle, not a legibility failure. (claude 2026-08-19)
- intended (unconfirmed): pattern: Quad-Elemental Slash costs 60 MP; the monster starts at 0 MP and must charge up first — Starting at 0 MP is the design ('enters every conflict with no MP'): Overflow and Quad must be earned through Enchants and the storm's +30 MP. (claude 2026-08-19)
- intended (unconfirmed): pattern: Elemental Slash: Overflow costs 30 MP; the monster starts at 0 MP and must charge up first — Starting at 0 MP is the design ('enters every conflict with no MP'): Overflow and Quad must be earned through Enchants and the storm's +30 MP. (claude 2026-08-19)
- blind spot: Mindscape: the sim reads Asura HARDER than live (calibration 2026-10-20: live 50% win r9 vs sim 3%) — offset not resolved.
- blind spot: Sim observation: Asura rarely casts Quad (60 MP = its whole pool; enchants lock once all Marks are lit).
- blind spot: Unverified: a free_action whose action_ref is an All Enemy item targets the whole party.
- open: Balance not settled: live samples ran 66–84% party HP vs the 40–60% target. Quad per-beat damage first, then HP?
- open: Should Quad be reachable more often (MP economy), given the sim almost never sees it?

### Carlbero — draft · 2026-10-21
- intended: resisted hit = 20% of PC HP (< 25%) — Slap is Multi 3 at 4 activations — the threat is volume across the party, not one hit; per-hit numbers are low on purpose. (user 2026-08-31)
- blind spot: The interactive save legs (Breath, Grab) dispatch to players' clients — never exercised in a real fight.
- blind spot: No real fight has been played.
- open: Real art: Bandit Shroom stands in; token scale 2.2 pending the Training Ground eyeball pass.

### Death Gazer — draft · 2026-10-21
- intended (unconfirmed): best basic attack avg 30 < 45 — Gimmick caster: Death Gaze is the threat; Eye Beam is filler. (claude 2026-08-29)
- intended: pattern: Death Gaze repeats every turn its condition holds: its 2-round cooldown never applies (no other row within 2 priority of 9) — Death Gaze firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created. (user 2026-10-21)
- blind spot: The save leg dispatches to players' clients — it hangs solo-GM, so it was never exercised.

### Dire Orc — draft · 2026-10-21
- intended: pattern: War Howl repeats every turn its condition holds: its 3-round cooldown never applies (no other row within 2 priority of 8) — War Howl firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created. (user 2026-10-21)

### Dragon Guard — draft · 2026-10-21
- open: Suppressing Sweep is still a placeholder — what is its real design?

### Drakoza — draft · 2026-10-21
- blind spot: Balance unsimulated at design time; never fought a full AI-driven turn end-to-end.

### Electro Slime — draft · 2026-10-21
- intended (unconfirmed): absorbs bolt (warning signal) — Bolt absorb makes it a deliberate Rod sponge (starves Gigas of Frightened) and keeps the roster interlock. (claude 2026-08-16)
- intended: best basic attack avg 36 < 45 — Its role is the death trigger + Paralyze, not damage (2026-10-20 balance pass raised accuracy only). (user 2026-10-20)
- blind spot: MAX_REACTION_DEPTH 2 in Mindscape: slime-chain → second-hop combos are cut.

### Gigas — draft · 2026-10-21
- intended: 3 VU (rule: exactly 1 for elite) — The world sheet is authoritative: VU bolt/fire/poison + RS physical/air/earth is intended (the 2026-08-14 'VU bolt only' note was superseded on the sheet). (user 2026-10-21)
- intended: Heavy Swing avg 128 can drop an average PC (mean HP 118) — The big hit is the threat that pushes the party to land Bolt (a PC skill or a dungeon hazard). Bolt → Frightened until the end of its next turn → Heavy Swing is blocked. Judge it WITH bolt in play. (user 2026-10-21)
- blind spot: Oaf → Frightened IS simulated in data mode (lib/monster-data.js, since 2026-10-20). Verdicts from before then (registry mode) read Gigas as always swinging — do not reuse them.
- blind spot: BD turn order ignores the Delay AE — 'acts last' is not engine-enforced (lowest DEX+INS makes autopilot pick it last).
- blind spot: Sim party brains play the Rod on purpose but ignore the Lightning Crystal, so the Crystal half's numbers (61% win) understate a party that times blasts deliberately.
- open: Arcane EF 200 is a flat DPR doubling, not a skill expression — keep, or drop to 150?

### Imp — draft · 2026-10-21
- blind spot: The interactive contest leg dispatches to players' clients — never exercised solo-GM.
- blind spot: Gauntlet continuation (stolen gear must not return on an in-place reinforce) verified by construction only.
- open: Brawling EF 175 is dead while Blanche uses a shield — keep as the 'party just lost its weapons' counter?
- open: Pitchfork's description still says 'light' after the 15→43 raise — retext?

### Iron Colossus — draft · 2026-10-21
- intended (unconfirmed): best basic attack avg 42 < 45 — Tank archetype: cheap damage, paid in denial — the escort does the killing (Gigas precedent). (claude 2026-08-29)
- intended (unconfirmed): resisted hit = 18% of PC HP (< 25%) — Same tank trade: its hits are meant to be soft. (claude 2026-08-29)
- intended: pattern: Grinding Quake repeats every turn its condition holds: its 2-round cooldown never applies (no other row within 2 priority of 9) — Grinding Quake firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created. (user 2026-10-21)
- blind spot: The party has no heavy weapon today, so the heavy-EF answer is not available in sims — rows stall.
- open: Awaiting your choice from 2026-10-20: (b) 1 escort or (c) 320 HP — both ~6 rounds; or keep the sheet as is?

### Kirin — draft · 2026-10-21
- blind spot: Mindscape used to start everyone at full MP; Kirin is authored at 0 (fixed 2026-10-20) — older verdicts overstate it.
- open: Lightning Charge income 0.2 is still the untuned starting metric — sweep 0.15 / 0.2 / 0.3?

### Lightning Prism — draft · 2026-10-21
- intended (unconfirmed): 2 VU (rule: exactly 1 for soldier) — VU physical + earth is the interlock answer (physical shatters the Prism, earth answers the bolt roster). (claude 2026-08-01)
- intended (unconfirmed): absorbs bolt (warning signal) — Bolt absorb is the roster interlock: bolt feeds Overcharge. (claude 2026-08-01)
- intended (unconfirmed): best basic attack avg 31 < 45 — Arc Spark is the empty-tank fallback; Fulgur Finis (multi-target) and Overcharge are the threat. (claude 2026-08-01)
- open: Weapon EF 25% on every family except arcane 200% — intended as 'magic is the answer', or a leftover?

### Mana Ray — draft · 2026-10-21
- intended: 2 VU (rule: exactly 1 for soldier) — 2 VU + 2 RS per the user's brief (2026-08-16). (user 2026-08-16)
- open: Still a placeholder — confirm the role it should play in its rows (the Rod refilling its pool is the stated hook).

### Mist Dragon — draft · 2026-10-21
- blind spot: The Blind riders were never observed firing in a real attack.
- blind spot: Mindscape does not simulate Phantom Shift / Illusory Form fully (Board card marks it).
- open: Best basic attack (Phantom Shift: Thunder Strike, avg 38) is under the 45 floor and its resisted hit is ~16% of PC HP — intended for an elite, or too soft?

### Obsidrax — draft · 2026-10-21
- intended: pattern: Miasma Nova repeats every turn its condition holds: its 3-round cooldown never applies (no other row within 2 priority of 11) — Miasma Nova firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created. (user 2026-10-21)
- blind spot: Lodestone Core is modelled in the storm only.
- open: Basalt Crush avg 44 sits just under the 45 basic-attack floor — leave?

### Rakshasa — draft · 2026-10-21
- intended: Severing Verdict avg 166 can drop an average PC (mean HP 118) — Telegraphed: only usable after Form Shift (Dual) visibly arms the Sword and Flail stance, and only at <= 50% HP. The stance is the warning; reading it is the counterplay. (user 2026-10-21)
- blind spot: The stance AEs live in the world status library (persistent_counter lifetime) — not checked here; if they are reaped at the next activation the telegraph vanishes before the strike.
- blind spot: Mindscape cannot simulate the Strike/Magic accuracy-class axis (classAffinity is never populated).
- blind spot: Solo boss: at real HP the modelled party rarely reaches Crisis, so the Dual/Verdict half goes unmeasured unless HP is forced.
- blind spot: Never live-tested; runReactionLint not run on it.
- blind spot: Adaptive Defense only LOWERS efficiency (25/40/60/80%, back to 100% once 4 other families have hit) — it never raises a lane above 100%. With VU light the best possible hit is ×2, never ×4.
- open: Is the stance readable enough at the table (token status icon / chat line) for the telegraph to work as counterplay?
- open: With 4 activations, does a PC always get a turn between the Dual Shift and the Verdict (BD alternates sides), or can Shift→Verdict land back-to-back?
- open: Crippled uses AE MULTIPLY on the derived defense prop — unverified that CSB honours it (else the text must stop promising a halving).
- open: HP 1200 reads as a stalemate in the current sim (0% win inside 10 rounds, 100% overtime, party's lowest HP ~62%) — but the sim party plays below human level and 58% of its actions are unmodelled. Live-test before touching HP.

### Roo — draft · 2026-10-21
- intended (unconfirmed): no damage action the sim can read — Its damage is Chef's Knife (an auto-hit Active, 9999 ignore_immunity) after a three-step Approach — not a rolled attack the audit can read. (claude 2026-09-03)
- blind spot: The turn_start reaction dispatch and Chef's Knife + the vanish were never seen in a real fight (solo-GM harness wedges at round 0).
- blind spot: Mindscape reads Zarg and Blanche at 0 damage actions (model gap) and does not model Approach — sim verdicts on the Roo are meaningless.

### Skizzik — draft · 2026-10-21
- intended (unconfirmed): absorbs bolt (warning signal) — Bolt absorb is the roster interlock — bolt-spamming feeds it (and the Rod heals it). (claude 2026-08-01)
- intended (unconfirmed): best basic attack avg 37 < 45 — Many small hits: free Thunder Strikes (Chain Reaction) and the uncapped riposte multiply its output, so the base number is low on purpose. (claude 2026-08-20)
- blind spot: Live 2026-08-20: Overload Riposte fired ~1/5 of the design rate and hit the previous action's targets instead of the attacker.
- blind spot: The sim journal does not log enemy free actions — check what a log does not record before concluding from its silence.
- open: Was the riposte mis-targeting (free action inheriting the parent's target list) ever fixed? Balance should not be re-tuned until it is.

### Succubus — draft · 2026-10-21
- intended: pattern: Charm repeats every turn its condition holds: its 2-round cooldown never applies (no other row within 2 priority of 9) — Charm firing every turn its condition holds (the cooldown never applies) is part of the design from when the monster was created. (user 2026-10-21)
- blind spot: The Charm save leg dispatches to players' clients — never exercised solo-GM.
- blind spot: Mindscape does not simulate Deadly Temptation (Board card marks it).
- open: Rake's description still says 'light' after the 18→34 raise — retext?

## Attacks per monster

**⭐️ Fafnir** — Condemn 108 (dark, vs mdef) · Rend 58 (physical, vs def)

**Ampere** — Bubble Splash 47 ×all (ice, vs def) · Bubble Beam 29 (ice, vs def)

**Asura** — Elemental Slash (Enchanted) 49 (physical, vs mdef) · Elemental Slash 49 (physical, vs def) · Elemental Slash: Overflow 27 ×all (fire, vs def) · Sword Enchant - Air 7 (physical, vs def) · Sword Enchant - Fire 7 (physical, vs def) · Sword Enchant - Bolt 7 (physical, vs def) · Sword Enchant - Ice 7 (physical, vs def)

**Carlbero** — Mind Sap 57 (dark, vs mdef) · Tentacle Slap 47 ×3 (physical, vs def) · Tentacle Grab 42 (physical, vs def)

**Death Gazer** — Mind Sear 43 (dark, vs mdef) · Eye Beam 30 (dark, vs def)

**Dire Orc** — Skull Splitter 66 (physical, vs def) · Cleaver 45 (physical, vs def)

**Dragon Guard** — Saber 51 (physical, vs def) · Flame Breath 36 ×all (fire, vs mdef) · Suppressing Sweep 32 ×2 (physical, vs def)

**Drakoza** — Dragon Claw 46 (physical, vs def) · Thrash 45 (physical, vs def) · Tail Swipe 29 ×2 (physical, vs def)

**Electro Slime** — Static Shot 36 (bolt, vs mdef) · Tackle 36 (physical, vs def)

**Gigas** — Heavy Swing 128 (physical, vs def) · Heavy Bodyslam 83 (physical, vs def)

**Imp** — Pitchfork 49 (physical, vs def)

**Iron Colossus** — Siege Fist 42 (physical, vs def) · Grinding Quake 27 ×all (earth, vs mdef) · Seismic Stomp 23 ×3 (earth, vs def)

**Kirin** — Horn Rush 69 (bolt, vs def) · Hooves 52 (physical, vs def) · Rail Stream 37 ×all (bolt, vs mdef)

**Lightning Prism** — Fulgur Finis 70 ×3 (bolt, vs mdef) · Arc Spark 31 (bolt, vs mdef)

**Mana Ray** — Volt Stinger 62 (bolt, vs def) · Mana Stinger 46 (dark, vs def)

**Mist Dragon** — Mist Breath 46 ×3 (air, vs mdef) · Phantom Shift: Thunder Strike 38 (air, vs def) · Phantom Shift: Mana Stinger 28 (air, vs def) · Mist Claw 26 (air, vs def) · Phantom Shift: Venomstone Spines 22 ×2 (air, vs def)

**Obsidrax** — Basalt Crush 44 (physical, vs def) · Venomstone Spines 28 ×3 (poison, vs def) · Tectonic Collapse 28 ×all (earth, vs def)

**Rakshasa** — Severing Verdict 166 (physical, vs def) · Saber 65 (physical, vs def) · Mace 44 (physical, vs mdef) · Chakram 27 ×3 (physical, vs mdef) · Rending Orbit 27 ×3 (physical, vs mdef) · Executioner's Volley 25 ×all (physical, vs def) · Rain of Arrows 22 ×all (physical, vs def) · Form Shift 4 (physical, vs def) · Form Shift (Dual) 4 (physical, vs def)

**Roo** — none readable

**Skizzik** — Thunder Strike 37 (bolt, vs def) · Thunder Strike (Riposte) 19 (bolt, vs def)

**Succubus** — Draining Kiss 56 (dark, vs mdef) · Rake 42 (dark, vs def)
