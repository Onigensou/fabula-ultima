# Encounter Matrix — Valley of the Dragon + Fafnir Castle

2026-10-20 · 1000 runs per fight · seed `encounter-matrix` · party policy **standard** · monster rules **data** · conflict events **auto** · party: Hina L41, Keren L41, Blanche L41, Zarg L41

Monsters play from their own reaction / effect / action-pattern tables (lib/monster-data.js) and turns alternate between sides as in the Battle Director. Each Valley row is fought under the conflict event of the battle map its floors launch onto, in proportion to the Random Battle tiles on those floors.

> Sim party plays below a human table: low-pressure numbers are reliable, high-pressure ones overstate difficulty. Numbers, not verdicts.

Party model: the **standard** policy (lib/party-policy.js) also plays Zero Power, IP items and revives, element swaps, Adoration skills, Warning Shot, Stop and Prophetic Defender. Still not modelled:
- Life Transference (Keren) — its heal formula is cut off in the item text
- For Whom the Bell Tolls (Keren) — needs Grave points, which nothing in the model grants
- Lightning Rod displacement in focus fire — matters only in Lightning Storm fights
- phantasms never act on their own; Create Phantasm only deals its strike and adds one to the count
- Hina's Foresight trigger — she never spends Zero Power, so it cannot change a fight

Targets: normal 1.5-2 rds (long ≤ 4), boss 5.5-6 rds (long 7.5); party HP left at victory under 70%, 85%+ = trivial.

## Valley of the Dragon

| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Event | Win | Rounds p50 / p90 | HP left p50 / p10 | Lowest party HP p50 | Any PC down | Against targets | Not simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-1 | 4% | Electro Slime, Electro Slime, Electro Slime | normal | 40 | 135 | lightning-crystal 38%: win 100%, low 44%<br>lightning-storm 62%: win 100%, low 52% | 100% | 2.0 / 3.0 | 61% / 44% | 49% | 53% | on target | — |
| 2-2 | 4% | Electro Slime, Electro Slime, Electro Slime, Electro Slime | normal | 40 | 180 | lightning-crystal 38%: win 98%, low 40%<br>lightning-storm 62%: win 99%, low 48% | 99% | 3.0 / 4.0 | 60% / 44% | 45% | 64% | rounds above 1.5-2 rds | — |
| 3-3 | 4% | Electro Slime, Skizzik, Electro Slime | normal | 48 | 220 | lightning-crystal 38%: win 82%, low 33%<br>lightning-storm 62%: win 94%, low 42% | 89% | 3.0 / 5.0 | 69% / 45% | 40% | 72% | rounds above 1.5-2 rds | — |
| 4-4 | 4% | Electro Slime, Lightning Prism, Electro Slime | normal | 45 | 240 | lightning-crystal 38%: win 83%, low 38%<br>lightning-storm 62%: win 42%, low 35% | 58% | 5.0 / 7.0 | 79% / 61% | 36% | 80% | unresolved in 42%; rounds above long target (4); HP left ≥ 70% | — |
| 5-5 | 4% | Skizzik, Lightning Prism | normal | 48 | 280 | lightning-crystal 38%: win 79%, low 43%<br>lightning-storm 62%: win 25%, low 31% | 46% | 5.0 / 7.0 | 81% / 60% | 37% | 91% | unresolved in 52%; rounds above long target (4); HP left ≥ 70% | — |
| 6-6 | 4% | Skizzik, Skizzik | normal | 48 | 260 | lightning-crystal 38%: win 89%, low 44%<br>lightning-storm 62%: win 98%, low 59% | 94% | 3.0 / 4.0 | 71% / 48% | 56% | 53% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 7-7 | 4% | Lightning Prism, Skizzik, Lightning Prism | normal | 48 | 430 | lightning-crystal 38%: win 8%, low 9%<br>lightning-storm 62%: win 1%, low 0% | 4% | 7.0 / 7.0 | 79% / 59% | 0% | 100% | unresolved in 43%; party loses 53%; rounds above long target (4); HP left ≥ 70% | — |
| 8-8 | 4% | Skizzik, Lightning Prism, Skizzik | normal | 48 | 410 | lightning-crystal 38%: win 39%, low 26%<br>lightning-storm 62%: win 9%, low 22% | 20% | 6.0 / 7.0 | 79% / 61% | 22% | 98% | unresolved in 55%; party loses 25%; rounds above long target (4); HP left ≥ 70% | — |
| 9-9 | 4% | Electro Slime, Kirin, Electro Slime | normal | 50 | 300 | lightning-crystal 38%: win 81%, low 21%<br>lightning-storm 62%: win 71%, low 23% | 75% | 4.0 / 6.0 | 65% / 37% | 22% | 92% | rounds above 1.5-2 rds | — |
| 10-10 | 4% | Lightning Prism, Kirin, Lightning Prism | normal | 50 | 510 | lightning-crystal 38%: win 4%, low 0%<br>lightning-storm 62%: win 1%, low 0% | 2% | 7.0 / 7.0 | 56% / 21% | 0% | 100% | party loses 74%; rounds above long target (4) | — |
| 11-11 | 4% | Skizzik, Kirin, Skizzik | normal | 50 | 470 | lightning-crystal 38%: win 36%, low 5%<br>lightning-storm 62%: win 37%, low 11% | 37% | 4.0 / 7.0 | 62% / 27% | 9% | 93% | party loses 42%; rounds above 1.5-2 rds | — |
| 12-12 | 4% | Kirin, Skizzik, Lightning Prism | normal | 50 | 490 | lightning-crystal 38%: win 14%, low 0%<br>lightning-storm 62%: win 4%, low 0% | 8% | 6.0 / 7.0 | 58% / 22% | 0% | 100% | party loses 71%; rounds above long target (4) | — |
| 13-13 | 4% | Mana Ray, Mana Ray | normal | 45 | 230 | lightning-crystal 38%: win 100%, low 69%<br>lightning-storm 62%: win 100%, low 81% | 100% | 2.0 / 3.0 | 87% / 65% | 78% | 22% | HP left ≥ 85% | — |
| 14-14 | 4% | Ampere, Mana Ray | normal | 45 | 290 | lightning-crystal 38%: win 100%, low 49%<br>lightning-storm 62%: win 97%, low 49% | 98% | 3.0 / 5.0 | 68% / 41% | 49% | 58% | rounds above 1.5-2 rds | — |
| 15-15 | 4% | Ampere, Skizzik | normal | 48 | 305 | lightning-crystal 38%: win 69%, low 32%<br>lightning-storm 62%: win 35%, low 0% | 48% | 5.0 / 6.0 | 56% / 26% | 13% | 97% | party loses 40%; rounds above long target (4) | — |
| 16-16 | 4% | Ampere, Lightning Prism | normal | 45 | 325 | lightning-crystal 38%: win 37%, low 22%<br>lightning-storm 62%: win 13%, low 0% | 22% | 6.0 / 7.0 | 65% / 35% | 10% | 99% | unresolved in 33%; party loses 45%; rounds above long target (4) | — |
| 17-17 | 4% | Mana Ray, Lightning Prism, Mana Ray | normal | 45 | 380 | lightning-crystal 38%: win 67%, low 38%<br>lightning-storm 62%: win 26%, low 33% | 42% | 6.0 / 7.0 | 79% / 60% | 35% | 95% | unresolved in 56%; rounds above long target (4); HP left ≥ 70% | — |
| 18-18 | 4% | Ampere, Mana Ray, Kirin | normal | 50 | 500 | lightning-crystal 38%: win 41%, low 10%<br>lightning-storm 62%: win 21%, low 0% | 29% | 5.0 / 6.0 | 46% / 22% | 0% | 98% | party loses 56%; rounds above long target (4) | — |
| 19-19 | 4% | Gigas, Electro Slime, Electro Slime | normal | 45 | 890 | lightning-crystal 38%: win 22%, low 16%<br>lightning-storm 62%: win 88%, low 36% | 62% | 5.0 / 6.0 | 78% / 44% | 29% | 94% | party loses 18%; rounds above long target (4); HP left ≥ 70% | — |
| 20-20 | 4% | Electro Slime, Obsidrax, Lightning Prism, Electro Slime | normal | 46 | 420 | lightning-crystal 38%: win 50%, low 34%<br>lightning-storm 62%: win 30%, low 34% | 38% | 6.0 / 7.0 | 80% / 62% | 34% | 83% | unresolved in 59%; rounds above long target (4); HP left ≥ 70% | — |
| 21-21 | 4% | Skizzik, Obsidrax | normal | 48 | 310 | lightning-crystal 38%: win 98%, low 55%<br>lightning-storm 62%: win 99%, low 62% | 98% | 4.0 / 4.0 | 82% / 65% | 60% | 34% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 22-22 | 4% | Obsidrax, Kirin, Skizzik | normal | 50 | 520 | lightning-crystal 38%: win 61%, low 22%<br>lightning-storm 62%: win 46%, low 15% | 52% | 5.0 / 7.0 | 64% / 32% | 18% | 87% | party loses 27%; rounds above long target (4) | — |
| 23-23 | 4% | Drakoza, Drakoza | normal | 43 | 280 | lightning-crystal 38%: win 100%, low 65%<br>lightning-storm 62%: win 100%, low 75% | 100% | 2.0 / 3.0 | 86% / 65% | 73% | 13% | HP left ≥ 85% | — |
| 24-24 | 4% | Drakoza, Skizzik | normal | 48 | 270 | lightning-crystal 38%: win 96%, low 48%<br>lightning-storm 62%: win 98%, low 59% | 97% | 3.0 / 5.0 | 81% / 61% | 57% | 53% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 25-25 | 4% | Mist Dragon, Obsidrax | normal | 46 | 380 | lightning-crystal 38%: win 99%, low 56%<br>lightning-storm 62%: win 100%, low 63% | 100% | 4.0 / 5.0 | 84% / 66% | 61% | 17% | rounds above 1.5-2 rds; HP left ≥ 70% | — |
| 26-26 | 4% | Mist Dragon, Mana Ray, Drakoza | normal | 45 | 455 | lightning-crystal 38%: win 66%, low 40%<br>lightning-storm 62%: win 78%, low 47% | 73% | 5.0 / 7.0 | 79% / 55% | 45% | 75% | rounds above long target (4); HP left ≥ 70% | — |
| story | — | ⭐️ Fafnir | boss | 50 | 1824 | none | 0% | — / — | — / — | 0% | 100% | party loses 99% | ⭐️ Fafnir: Torment: a player decides (ask); ⭐️ Fafnir: Torment: redirect target; ⭐️ Fafnir: Condemn: a player decides (ask); ⭐️ Fafnir: Condemn: redirect target; ⭐️ Fafnir: Zero Power: Cruel Ultimatum: open action menu |
| story | — | Rakshasa | boss | 40 | 1200 | none | 0% | — / — | — / — | 62% | 10% | unresolved in 100% | — |
| story | — | Asura | boss | 38 | 900 | none | 1% | 10.0 / 10.0 | 98% / 79% | 0% | 99% | party loses 95%; rounds above long target (7.5); HP left ≥ 85% | — |

## Fafnir Castle

| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Event | Win | Rounds p50 / p90 | HP left p50 / p10 | Lowest party HP p50 | Any PC down | Against targets | Not simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-1 | 6% | Dire Orc, Dire Orc | normal | 50 | 480 | none | 100% | 3.0 / 3.0 | 100% / 100% | 100% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 2-2 | 6% | Dragon Guard, Dragon Guard | normal | 50 | 500 | none | 100% | 2.0 / 3.0 | 88% / 79% | 86% | 0% | HP left ≥ 85% | — |
| 3-3 | 6% | Imp, Dire Orc, Imp | normal | 50 | 460 | none | 100% | 4.0 / 5.0 | 100% / 91% | 100% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 4-4 | 6% | Succubus, Dire Orc, Succubus | normal | 50 | 600 | none | 53% | 4.0 / 7.0 | 95% / 82% | 68% | 40% | unresolved in 47%; rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 5-5 | 6% | Dragon Guard, Death Gazer, Dragon Guard | normal | 50 | 650 | none | 100% | 3.0 / 4.0 | 90% / 79% | 76% | 14% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 6-6 | 6% | Dire Orc, Death Gazer, Dire Orc | normal | 50 | 630 | none | 100% | 4.0 / 5.0 | 92% / 79% | 80% | 24% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 7-7 | 6% | Imp, Dragon Guard, Imp | normal | 50 | 470 | none | 100% | 4.0 / 5.0 | 100% / 90% | 90% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 8-8 | 6% | Death Gazer, Succubus, Death Gazer | normal | 50 | 480 | none | 72% | 4.0 / 7.0 | 93% / 78% | 69% | 56% | unresolved in 28%; rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 9-9 | 6% | Dire Orc, Iron Colossus, Dire Orc | normal | 52 | 1180 | none | 0% | — / — | — / — | 70% | 2% | unresolved in 100% | — |
| 10-10 | 6% | Succubus, Iron Colossus, Succubus | normal | 52 | 1060 | none | 0% | — / — | — / — | 59% | 53% | unresolved in 100% | — |
| 11-11 | 6% | Dragon Guard, Roo, Dragon Guard | normal | 50 | 755 | none | 100% | 3.0 / 5.0 | 92% / 81% | 67% | 100% | rounds above 1.5-2 rds; HP left ≥ 85% | — |
| 12-12 | 6% | Dire Orc, Death Gazer, Iron Colossus, Succubus | normal | 52 | 1270 | none | 0% | — / — | — / — | 49% | 68% | unresolved in 98% | — |
| 13-13 | 6% | Imp, Death Gazer, Roo, Imp | normal | 50 | 625 | none | 74% | 6.0 / 7.0 | 91% / 73% | 61% | 100% | unresolved in 26%; rounds above long target (4); HP left ≥ 85% | — |
| 14-14 | 6% | Imp, Dragon Guard, Iron Colossus, Dragon Guard, Imp | normal | 52 | 1420 | none | 0% | — / — | — / — | 59% | 11% | unresolved in 100% | — |
| 15-15 | 6% | Death Gazer, Succubus, Iron Colossus, Succubus, Death Gazer | normal | 52 | 1360 | none | 0% | — / — | — / — | 40% | 86% | unresolved in 98% | — |
| 16-16 | 6% | Carlbero | boss | 50 | 640 | none | 9% | 7.0 / 9.0 | 47% / 19% | 0% | 98% | unresolved in 37%; party loses 54%; rounds above 5.5-6 rds | — |

Rolls = share of the table's die. "Any PC down" = runs where at least one PC hit 0 HP. Not simulated = what the sim cannot run for that monster (in data mode: a decision a person makes at the table, or an effect / trigger the interpreter does not know), so it plays weaker in the sim than at the table. Event = the conflict event and its share of the row's runs, with that event's own win rate and median lowest party HP.
