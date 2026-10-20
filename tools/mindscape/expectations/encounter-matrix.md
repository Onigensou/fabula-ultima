# Encounter Matrix — Valley of the Dragon + Fafnir Castle

2026-10-20 · 1000 runs per fight · seed `encounter-matrix` · party policy **standard** · monster rules **data** · conflict events **auto** · party: Hina L41, Keren L41, Blanche L41, Zarg L41

Monsters play from their own reaction / effect / action-pattern tables (lib/monster-data.js) and turns alternate between sides as in the Battle Director. Each Valley row is fought under the conflict event of the battle map its floors launch onto, in proportion to the Random Battle tiles on those floors.

> Sim party plays below a human table: low-pressure numbers are reliable, high-pressure ones overstate difficulty. Numbers, not verdicts.

Party model: the **standard** policy (lib/party-policy.js) also plays Zero Power, IP items and revives, element swaps, Adoration skills, Warning Shot, Stop and Prophetic Defender. Still not modelled:
- Life Transference (Keren) — its heal formula is cut off in the item text
- For Whom the Bell Tolls (Keren) — needs Grave points, which nothing in the model grants
- phantasms never act on their own; Create Phantasm only deals its strike and adds one to the count
- Hina's Foresight trigger — she never spends Zero Power, so it cannot change a fight

Targets: normal 1.5-2 rds (long ≤ 4), boss 5.5-6 rds (long 7.5); party HP left at victory under 70%, 85%+ = trivial.

## Valley of the Dragon

| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Event | Win | Rounds p50 / p90 | HP left p50 / p10 | Lowest party HP p50 | Any PC down | Against targets | Not simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-1 | 4% | Electro Slime, Electro Slime, Electro Slime | normal | 40 | 135 | lightning-crystal 38%: win 100%, low 45%<br>lightning-storm 62%: win 100%, low 52% | 100% | 2.0 / 4.0 | 62% / 45% | 50% | 54% | on target | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 2-2 | 4% | Electro Slime, Electro Slime, Electro Slime, Electro Slime | normal | 40 | 180 | lightning-crystal 38%: win 100%, low 41%<br>lightning-storm 62%: win 100%, low 48% | 100% | 3.0 / 4.0 | 61% / 45% | 46% | 68% | rounds above 1.5-2 rds | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 3-3 | 4% | Electro Slime, Skizzik, Electro Slime | normal | 48 | 220 | lightning-crystal 38%: win 82%, low 31%<br>lightning-storm 62%: win 96%, low 44% | 91% | 3.0 / 4.0 | 68% / 44% | 41% | 69% | rounds above 1.5-2 rds | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 4-4 | 4% | Electro Slime, Lightning Prism, Electro Slime | normal | 45 | 240 | lightning-crystal 38%: win 86%, low 41%<br>lightning-storm 62%: win 54%, low 40% | 66% | 5.0 / 7.0 | 82% / 64% | 40% | 76% | unresolved in 34%; rounds above long target (4); HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 5-5 | 4% | Skizzik, Lightning Prism | normal | 48 | 280 | lightning-crystal 38%: win 87%, low 44%<br>lightning-storm 62%: win 30%, low 34% | 52% | 5.0 / 7.0 | 81% / 61% | 39% | 91% | unresolved in 46%; rounds above long target (4); HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 6-6 | 4% | Skizzik, Skizzik | normal | 48 | 260 | lightning-crystal 38%: win 90%, low 46%<br>lightning-storm 62%: win 98%, low 62% | 95% | 3.0 / 4.0 | 73% / 53% | 58% | 46% | rounds above 1.5-2 rds; HP left ≥ 70% | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 7-7 | 4% | Lightning Prism, Skizzik, Lightning Prism | normal | 48 | 430 | lightning-crystal 38%: win 18%, low 15%<br>lightning-storm 62%: win 1%, low 0% | 8% | 7.0 / 7.0 | 69% / 59% | 8% | 100% | unresolved in 49%; party loses 44%; rounds above long target (4) | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 8-8 | 4% | Skizzik, Lightning Prism, Skizzik | normal | 48 | 410 | lightning-crystal 38%: win 41%, low 28%<br>lightning-storm 62%: win 11%, low 25% | 23% | 6.0 / 7.0 | 81% / 61% | 25% | 97% | unresolved in 58%; party loses 20%; rounds above long target (4); HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 9-9 | 4% | Electro Slime, Kirin, Electro Slime | normal | 50 | 300 | lightning-crystal 38%: win 82%, low 21%<br>lightning-storm 62%: win 73%, low 25% | 77% | 4.0 / 6.0 | 65% / 37% | 23% | 88% | rounds above 1.5-2 rds | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 10-10 | 4% | Lightning Prism, Kirin, Lightning Prism | normal | 50 | 510 | lightning-crystal 38%: win 8%, low 0%<br>lightning-storm 62%: win 1%, low 0% | 3% | 7.0 / 7.0 | 61% / 40% | 0% | 100% | unresolved in 27%; party loses 70%; rounds above long target (4) | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 11-11 | 4% | Skizzik, Kirin, Skizzik | normal | 50 | 470 | lightning-crystal 38%: win 41%, low 10%<br>lightning-storm 62%: win 47%, low 16% | 45% | 5.0 / 7.0 | 61% / 32% | 14% | 91% | party loses 30%; rounds above long target (4) | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 12-12 | 4% | Kirin, Skizzik, Lightning Prism | normal | 50 | 490 | lightning-crystal 38%: win 19%, low 0%<br>lightning-storm 62%: win 4%, low 0% | 10% | 6.0 / 7.0 | 58% / 21% | 0% | 99% | unresolved in 27%; party loses 63%; rounds above long target (4) | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 13-13 | 4% | Mana Ray, Mana Ray | normal | 45 | 230 | lightning-crystal 38%: win 100%, low 69%<br>lightning-storm 62%: win 100%, low 80% | 100% | 2.0 / 2.0 | 87% / 65% | 78% | 20% | HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 14-14 | 4% | Ampere, Mana Ray | normal | 45 | 290 | lightning-crystal 38%: win 98%, low 49%<br>lightning-storm 62%: win 98%, low 49% | 98% | 3.0 / 5.0 | 68% / 40% | 49% | 60% | rounds above 1.5-2 rds | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 15-15 | 4% | Ampere, Skizzik | normal | 48 | 305 | lightning-crystal 38%: win 74%, low 31%<br>lightning-storm 62%: win 36%, low 0% | 51% | 5.0 / 6.0 | 56% / 25% | 14% | 95% | party loses 41%; rounds above long target (4) | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 16-16 | 4% | Ampere, Lightning Prism | normal | 45 | 325 | lightning-crystal 38%: win 41%, low 22%<br>lightning-storm 62%: win 10%, low 0% | 22% | 6.0 / 7.0 | 69% / 31% | 0% | 100% | unresolved in 28%; party loses 50%; rounds above long target (4) | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 17-17 | 4% | Mana Ray, Lightning Prism, Mana Ray | normal | 45 | 380 | lightning-crystal 38%: win 75%, low 40%<br>lightning-storm 62%: win 33%, low 36% | 49% | 6.0 / 7.0 | 81% / 61% | 37% | 95% | unresolved in 50%; rounds above long target (4); HP left ≥ 70% | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 18-18 | 4% | Ampere, Mana Ray, Kirin | normal | 50 | 500 | lightning-crystal 38%: win 44%, low 14%<br>lightning-storm 62%: win 20%, low 0% | 29% | 5.0 / 6.0 | 51% / 24% | 0% | 98% | party loses 56%; rounds above long target (4) | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 19-19 | 4% | Gigas, Electro Slime, Electro Slime | normal | 45 | 890 | lightning-crystal 38%: win 28%, low 18%<br>lightning-storm 62%: win 89%, low 39% | 66% | 5.0 / 6.0 | 80% / 45% | 33% | 88% | party loses 18%; rounds above long target (4); HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 20-20 | 4% | Electro Slime, Obsidrax, Lightning Prism, Electro Slime | normal | 46 | 420 | lightning-crystal 38%: win 68%, low 37%<br>lightning-storm 62%: win 35%, low 36% | 48% | 6.0 / 7.0 | 80% / 62% | 36% | 81% | unresolved in 52%; rounds above long target (4); HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 21-21 | 4% | Skizzik, Obsidrax | normal | 48 | 310 | lightning-crystal 38%: win 99%, low 56%<br>lightning-storm 62%: win 100%, low 70% | 99% | 3.0 / 4.0 | 84% / 67% | 67% | 21% | rounds above 1.5-2 rds; HP left ≥ 70% | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 22-22 | 4% | Obsidrax, Kirin, Skizzik | normal | 50 | 520 | lightning-crystal 38%: win 69%, low 22%<br>lightning-storm 62%: win 59%, low 24% | 63% | 5.0 / 6.0 | 66% / 38% | 23% | 84% | party loses 18%; rounds above long target (4) | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 23-23 | 4% | Drakoza, Drakoza | normal | 43 | 280 | lightning-crystal 38%: win 100%, low 64%<br>lightning-storm 62%: win 100%, low 75% | 100% | 2.0 / 3.0 | 85% / 62% | 73% | 9% | HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 24-24 | 4% | Drakoza, Skizzik | normal | 48 | 270 | lightning-crystal 38%: win 95%, low 48%<br>lightning-storm 62%: win 100%, low 67% | 98% | 3.0 / 4.0 | 82% / 63% | 63% | 37% | rounds above 1.5-2 rds; HP left ≥ 70% | Blanche: adjust_grant (effect); Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 25-25 | 4% | Mist Dragon, Obsidrax | normal | 46 | 380 | lightning-crystal 38%: win 100%, low 56%<br>lightning-storm 62%: win 100%, low 63% | 100% | 4.0 / 5.0 | 82% / 66% | 61% | 14% | rounds above 1.5-2 rds; HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| 26-26 | 4% | Mist Dragon, Mana Ray, Drakoza | normal | 45 | 455 | lightning-crystal 38%: win 77%, low 41%<br>lightning-storm 62%: win 85%, low 49% | 82% | 5.0 / 7.0 | 79% / 56% | 45% | 73% | rounds above long target (4); HP left ≥ 70% | Hina: identifier BOND_WITH_ANY_TARGET (formula); Blanche: adjust_grant (effect) |
| story | — | ⭐️ Fafnir | boss | 50 | 1824 | none | 0% | — / — | — / — | 0% | 100% | party loses 99% | ⭐️ Fafnir: Torment: a player decides (ask); ⭐️ Fafnir: Torment: redirect target; ⭐️ Fafnir: Condemn: a player decides (ask); ⭐️ Fafnir: Condemn: redirect target; ⭐️ Fafnir: Zero Power: Cruel Ultimatum: open action menu; Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| story | — | Rakshasa | boss | 40 | 1200 | none | 0% | — / — | — / — | 62% | 11% | unresolved in 100% | — |
| story | — | Asura | boss | 38 | 900 | none | 2% | 9.0 / 10.0 | 88% / 65% | 0% | 99% | party loses 94%; rounds above long target (7.5); HP left ≥ 85% | — |

## Fafnir Castle

| Range | Rolls | Fight | Kind | Lvl | Enemy HP | Event | Win | Rounds p50 / p90 | HP left p50 / p10 | Lowest party HP p50 | Any PC down | Against targets | Not simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-1 | 6% | Dire Orc, Dire Orc | normal | 50 | 480 | none | 100% | 3.0 / 3.0 | 100% / 100% | 100% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 2-2 | 6% | Dragon Guard, Dragon Guard | normal | 50 | 500 | none | 100% | 2.0 / 3.0 | 88% / 79% | 86% | 0% | HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 3-3 | 6% | Imp, Dire Orc, Imp | normal | 50 | 460 | none | 100% | 4.0 / 5.0 | 100% / 91% | 100% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 4-4 | 6% | Succubus, Dire Orc, Succubus | normal | 50 | 600 | none | 53% | 4.0 / 7.0 | 96% / 82% | 65% | 52% | unresolved in 47%; rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 5-5 | 6% | Dragon Guard, Death Gazer, Dragon Guard | normal | 50 | 650 | none | 100% | 3.0 / 4.0 | 89% / 78% | 75% | 16% | rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 6-6 | 6% | Dire Orc, Death Gazer, Dire Orc | normal | 50 | 630 | none | 100% | 4.0 / 5.0 | 92% / 81% | 80% | 16% | rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 7-7 | 6% | Imp, Dragon Guard, Imp | normal | 50 | 470 | none | 100% | 4.0 / 5.0 | 100% / 90% | 90% | 0% | rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 8-8 | 6% | Death Gazer, Succubus, Death Gazer | normal | 50 | 480 | none | 72% | 3.0 / 7.0 | 91% / 79% | 67% | 56% | unresolved in 27%; rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 9-9 | 6% | Dire Orc, Iron Colossus, Dire Orc | normal | 52 | 1180 | none | 0% | — / — | — / — | 71% | 2% | unresolved in 100% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 10-10 | 6% | Succubus, Iron Colossus, Succubus | normal | 52 | 1060 | none | 0% | — / — | — / — | 56% | 60% | unresolved in 100% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 11-11 | 6% | Dragon Guard, Roo, Dragon Guard | normal | 50 | 755 | none | 100% | 3.0 / 5.0 | 92% / 80% | 67% | 100% | rounds above 1.5-2 rds; HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 12-12 | 6% | Dire Orc, Death Gazer, Iron Colossus, Succubus | normal | 52 | 1270 | none | 0% | — / — | — / — | 48% | 65% | unresolved in 95% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 13-13 | 6% | Imp, Death Gazer, Roo, Imp | normal | 50 | 625 | none | 84% | 6.0 / 7.0 | 89% / 71% | 60% | 100% | rounds above long target (4); HP left ≥ 85% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 14-14 | 6% | Imp, Dragon Guard, Iron Colossus, Dragon Guard, Imp | normal | 52 | 1420 | none | 0% | — / — | — / — | 60% | 10% | unresolved in 100% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 15-15 | 6% | Death Gazer, Succubus, Iron Colossus, Succubus, Death Gazer | normal | 52 | 1360 | none | 0% | — / — | — / — | 33% | 86% | unresolved in 93% | Hina: identifier BOND_WITH_ANY_TARGET (formula) |
| 16-16 | 6% | Carlbero | boss | 50 | 640 | none | 9% | 6.0 / 9.0 | 47% / 18% | 0% | 97% | unresolved in 36%; party loses 55% | — |

Rolls = share of the table's die. "Any PC down" = runs where at least one PC hit 0 HP. Not simulated = what the sim cannot run for that monster (in data mode: a decision a person makes at the table, or an effect / trigger the interpreter does not know), so it plays weaker in the sim than at the table. Event = the conflict event and its share of the row's runs, with that event's own win rate and median lowest party HP.
