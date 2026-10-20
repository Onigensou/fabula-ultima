# Encounter Matrix — Valley of the Dragon + Fafnir Castle

2026-10-20 · 1000 runs per fight · seed `encounter-matrix` · party policy **standard** · party: Hina L41, Keren L41, Blanche L41, Zarg L41

> Sim party plays below a human table: low-pressure numbers are reliable, high-pressure ones overstate difficulty. Numbers, not verdicts.

Party model: the **standard** policy (lib/party-policy.js) also plays Zero Power, IP items and revives, element swaps, Adoration skills, Warning Shot, Stop and Prophetic Defender. Still not modelled:
- Life Transference (Keren) — its heal formula is cut off in the item text
- For Whom the Bell Tolls (Keren) — needs Grave points, which nothing in the model grants
- Lightning Rod displacement in focus fire — matters only in Lightning Storm fights
- phantasms never act on their own; Create Phantasm only deals its strike and adds one to the count
- Hina's Foresight trigger — she never spends Zero Power, so it cannot change a fight

Targets: normal 1.5-2 rds (long ≤ 4), boss 5.5-6 rds (long 7.5); party HP left at victory under 70%, 85%+ = trivial.

## Valley of the Dragon

| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Win | Rounds p50 / p90 | HP left p50 / p10 | Any PC down | Against targets | Enemy actions not modelled |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-1 | 4% | Electro Slime, Electro Slime, Electro Slime | normal | 40 | 135 | 100% | 2.0 / 2.0 | 100% / 96% | 0% | HP left ≥ 85% | — |
| 2-2 | 4% | Electro Slime, Electro Slime, Electro Slime, Electro Slime | normal | 40 | 180 | 100% | 2.0 / 2.0 | 96% / 89% | 0% | HP left ≥ 85% | — |
| 3-3 | 4% | Electro Slime, Skizzik, Electro Slime | normal | 48 | 220 | 100% | 2.0 / 2.0 | 94% / 84% | 0% | HP left ≥ 85% | — |
| 4-4 | 4% | Electro Slime, Lightning Prism, Electro Slime | normal | 45 | 240 | 100% | 4.0 / 5.0 | 82% / 75% | 2% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 5-5 | 4% | Skizzik, Lightning Prism | normal | 48 | 280 | 98% | 4.0 / 6.0 | 84% / 77% | 88% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 6-6 | 4% | Skizzik, Skizzik | normal | 48 | 260 | 100% | 3.0 / 3.0 | 87% / 77% | 1% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 7-7 | 4% | Lightning Prism, Skizzik, Lightning Prism | normal | 48 | 430 | 5% | 6.0 / 7.0 | 84% / 65% | 100% | unresolved in 31%; party loses 64%; rounds above long target (4); HP left ≥ 70% | — |
| 8-8 | 4% | Skizzik, Lightning Prism, Skizzik | normal | 48 | 410 | 83% | 5.0 / 7.0 | 83% / 74% | 74% | rounds above long target (4); HP left ≥ 70% | — |
| 9-9 | 4% | Electro Slime, Kirin, Electro Slime | normal | 50 | 300 | 100% | 3.0 / 3.0 | 86% / 69% | 19% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 10-10 | 4% | Lightning Prism, Kirin, Lightning Prism | normal | 50 | 510 | 9% | 6.0 / 7.0 | 47% / 31% | 100% | unresolved in 57%; party loses 35%; rounds above long target (4) | — |
| 11-11 | 4% | Skizzik, Kirin, Skizzik | normal | 50 | 470 | 94% | 4.0 / 6.0 | 66% / 53% | 32% | rounds above 1.5-2 rds | — |
| 12-12 | 4% | Kirin, Skizzik, Lightning Prism | normal | 50 | 490 | 67% | 5.0 / 6.0 | 56% / 41% | 94% | party loses 15%; rounds above long target (4) | — |
| 13-13 | 4% | Mana Ray, Mana Ray | normal | 45 | 230 | 100% | 2.0 / 2.0 | 90% / 81% | 33% | HP left ≥ 85% | — |
| 14-14 | 4% | Ampere, Mana Ray | normal | 45 | 290 | 100% | 2.0 / 3.0 | 82% / 66% | 52% | HP left ≥ 70% | — |
| 15-15 | 4% | Ampere, Skizzik | normal | 48 | 305 | 100% | 3.0 / 3.0 | 77% / 65% | 5% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 16-16 | 4% | Ampere, Lightning Prism | normal | 45 | 325 | 65% | 4.0 / 6.0 | 67% / 54% | 100% | unresolved in 35%; rounds above 1.5-2 rds | — |
| 17-17 | 4% | Mana Ray, Lightning Prism, Mana Ray | normal | 45 | 380 | 98% | 5.0 / 6.0 | 86% / 77% | 92% | rounds above long target (4); HP left ≥ 85% | — |
| 18-18 | 4% | Ampere, Mana Ray, Kirin | normal | 50 | 500 | 100% | 4.0 / 4.0 | 72% / 52% | 99% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 19-19 | 4% | Asura | boss | 38 | 900 | 42% | 6.0 / 7.0 | 44% / 24% | 100% | party loses 58% | Asura: Quad-Elemental Slash |
| 20-20 | 4% | Gigas, Electro Slime, Electro Slime | normal | 45 | 890 | 74% | 5.0 / 6.0 | 95% / 73% | 47% | never acts: Gigas (Frightened); rounds above long target (4); HP left ≥ 85% | — |
| 21-21 | 4% | Electro Slime, Obsidrax, Lightning Prism, Electro Slime | normal | 46 | 420 | 100% | 4.0 / 6.0 | 78% / 68% | 79% | rounds above 1.5-2 rds; HP left ≥ 70% | Obsidrax: Miasma Nova |
| 22-22 | 4% | Skizzik, Obsidrax | normal | 48 | 310 | 100% | 3.0 / 4.0 | 78% / 66% | 0% | rounds above 1.5-2 rds; HP left ≥ 70% | Obsidrax: Miasma Nova |
| 23-23 | 4% | Obsidrax, Kirin, Skizzik | normal | 50 | 520 | 78% | 4.0 / 5.0 | 66% / 52% | 62% | rounds above 1.5-2 rds | Obsidrax: Miasma Nova |
| 24-24 | 4% | Drakoza, Drakoza | normal | 43 | 280 | 100% | 2.0 / 2.0 | 88% / 86% | 0% | HP left ≥ 85% | — |
| 25-25 | 4% | Drakoza, Skizzik | normal | 48 | 270 | 100% | 3.0 / 3.0 | 90% / 81% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 26-26 | 4% | Mist Dragon, Obsidrax | normal | 46 | 380 | 100% | 4.0 / 5.0 | 79% / 71% | 14% | rounds above 1.5-2 rds; HP left ≥ 70% | Obsidrax: Miasma Nova |
| 27-27 | 4% | Mist Dragon, Mana Ray, Drakoza | normal | 45 | 455 | 99% | 5.0 / 6.0 | 88% / 79% | 5% | rounds above long target (4); HP left ≥ 85% | — |
| story | — | ⭐️ Fafnir | boss | 50 | 1824 | 0% | — / — | — / — | 100% | party loses 77% | ⭐️ Fafnir: Ruinous Breath; ⭐️ Fafnir: Storm Calm; ⭐️ Fafnir: Summon Elemental Drake; ⭐️ Fafnir: Torment; ⭐️ Fafnir: Searing Brand; ⭐️ Fafnir: Draconic Domination; ⭐️ Fafnir: Zero Power: Cruel Ultimatum |
| story | — | Rakshasa | boss | 40 | 1200 | 0% | — / — | — / — | 20% | unresolved in 100% | Rakshasa: Devour |
| story | — | Flame Drake | boss | 45 | 300 | 100% | 3.0 / 4.0 | 94% / 89% | 0% | rounds below 5.5-6 rds; HP left ≥ 85% | — |
| story | — | Lightning Drake | boss | 45 | 150 | 100% | 2.0 / 2.0 | 100% / 90% | 0% | rounds below 5.5-6 rds; HP left ≥ 85% | — |

## Fafnir Castle

| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Win | Rounds p50 / p90 | HP left p50 / p10 | Any PC down | Against targets | Enemy actions not modelled |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-1 | 6% | Dire Orc, Dire Orc | normal | 50 | 480 | 100% | 3.0 / 3.0 | 87% / 81% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Dire Orc: War Howl |
| 2-2 | 6% | Dragon Guard, Dragon Guard | normal | 50 | 500 | 100% | 2.0 / 3.0 | 88% / 84% | 0% | HP left ≥ 85% | — |
| 3-3 | 6% | Imp, Dire Orc, Imp | normal | 50 | 460 | 100% | 3.0 / 3.0 | 90% / 82% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Imp: Strip Weapon; Imp: Prank; Imp: Strip Armor; Dire Orc: War Howl |
| 4-4 | 6% | Succubus, Dire Orc, Succubus | normal | 50 | 600 | 100% | 4.0 / 5.0 | 90% / 80% | 52% | rounds above 1.5-2 rds; HP left ≥ 85% | Succubus: Charm; Dire Orc: War Howl |
| 5-5 | 6% | Dragon Guard, Death Gazer, Dragon Guard | normal | 50 | 650 | 100% | 4.0 / 4.0 | 88% / 79% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Death Gazer: Death Gaze |
| 6-6 | 6% | Dire Orc, Death Gazer, Dire Orc | normal | 50 | 630 | 100% | 4.0 / 5.0 | 86% / 74% | 66% | rounds above 1.5-2 rds; HP left ≥ 85% | Dire Orc: War Howl; Death Gazer: Death Gaze |
| 7-7 | 6% | Imp, Dragon Guard, Imp | normal | 50 | 470 | 100% | 3.0 / 3.0 | 92% / 85% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Imp: Strip Weapon; Imp: Prank; Imp: Strip Armor |
| 8-8 | 6% | Death Gazer, Succubus, Death Gazer | normal | 50 | 480 | 100% | 4.0 / 4.0 | 91% / 83% | 6% | rounds above 1.5-2 rds; HP left ≥ 85% | Death Gazer: Death Gaze; Succubus: Charm |
| 9-9 | 6% | Dire Orc, Iron Colossus, Dire Orc | normal | 52 | 1180 | 0% | — / — | — / — | 62% | unresolved in 100% | Dire Orc: War Howl |
| 10-10 | 6% | Succubus, Iron Colossus, Succubus | normal | 52 | 1060 | 0% | — / — | — / — | 3% | unresolved in 100% | Succubus: Charm |
| 11-11 | 6% | Dragon Guard, Roo, Dragon Guard | normal | 50 | 755 | 80% | 4.0 / 6.0 | 89% / 85% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Roo: Karma; Roo: Chef's Knife; Roo: Empty Stare |
| 12-12 | 6% | Dire Orc, Death Gazer, Iron Colossus, Succubus | normal | 52 | 1270 | 0% | — / — | — / — | 76% | unresolved in 100% | Dire Orc: War Howl; Death Gazer: Death Gaze; Succubus: Charm |
| 13-13 | 6% | Imp, Death Gazer, Roo, Imp | normal | 50 | 625 | 51% | 6.0 / 7.0 | 95% / 86% | 0% | unresolved in 50%; rounds above long target (4); HP left ≥ 85% | Imp: Strip Weapon; Imp: Prank; Imp: Strip Armor; Death Gazer: Death Gaze; Roo: Karma; Roo: Chef's Knife; Roo: Empty Stare |
| 14-14 | 6% | Imp, Dragon Guard, Iron Colossus, Dragon Guard, Imp | normal | 52 | 1420 | 0% | — / — | — / — | 2% | unresolved in 100% | Imp: Strip Weapon; Imp: Prank; Imp: Strip Armor |
| 15-15 | 6% | Death Gazer, Succubus, Iron Colossus, Succubus, Death Gazer | normal | 52 | 1360 | 0% | — / — | — / — | 85% | unresolved in 100% | Death Gazer: Death Gaze; Succubus: Charm |
| 16-16 | 6% | Carlbero | boss | 50 | 640 | 36% | 4.0 / 6.0 | 44% / 19% | 100% | party loses 40%; rounds below 5.5-6 rds | Carlbero: Stinky Breath |

Rolls = share of the table's die. "Any PC down" = runs where at least one PC hit 0 HP. Enemy actions not modelled = the sim never uses them, so that monster is weaker in the sim than at the table.
