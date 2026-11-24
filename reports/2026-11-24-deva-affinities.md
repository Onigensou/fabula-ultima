# Deva: form-bound Light/Dark affinity, weapon efficiency, HP 1550 (to-do #15, 2026-11-24)

From the 2026-11-22 session report: Deva had no affinities at all (all elements Neutral, no attribute,
Strike/Magic Neutral), and the elite rule asks for 1 Vulnerability. Design picked by the user: her
affinity follows her two forms.

## What players see now
- **Fury** (red arms): resists Light, vulnerable to Dark, attribute LIGHT.
- **Focus** (blue arms): vulnerable to Light, resists Dark, attribute DARK.
- **Guard rounds** (odd rounds, no arms): Neutral, no attribute.
- The form is set at round start, so the arm colour shows the weakness before the party acts.
  Enlightenment (rounds 4, 8, 12) swaps the form, and the weakness flips with it mid-round.
- The form status text now names it: "Fury: her arms burn red. Resists Light. Vulnerable to Dark."
- **Weapon efficiency:** spear 150, brawling 50 (shields count as brawling), everything else 100.
  Arcane stays 100 on purpose: every spell uses it.
- **HP 1400 → 1550.** The weakness shortens the fight; this puts it back on the 5–6 round target.

## Build
- Data only on Deva (`amxILxU7mqQ0jKhZ`): the 4 form AE templates (Celestial Discipline + Enlightenment,
  "Strike Form" / "Magic Form") carry the changes (`affinity_8` / `affinity_4` via `aeAffinityFloor`,
  `attribute` OVERRIDE). Holding the form AE is the affinity; the Guard row's `deva_offense` clear
  removes it. Script `tools/safe-edit/bin/_deva-affinity-ef.js`; `_build-deva.js` carries the same values.
- **Engine fix, `skill-effects.js` `apply_ae`:** the apply-time formula bake treated an all-caps
  `attribute` value as an identifier and baked `"LIGHT"` to `"0"`. `attribute` now gets the same
  exemption as `affinity_N` and `condition_*`. No other content changes `attribute` at runtime (Walrog
  only reads it), so nothing else changes behaviour.

## Checked
- Snapshot runner, story setup (Valley_Battlemap007, Lightning Storm, guest Kalina), 10 fights each:
  HP 1400 → median 4 rounds; HP 1550 → median 5 rounds, ~82% party HP left, 0.2 KO per fight.
- Deva's affinity logged at every resolved action in 19 fights: 0 mismatches (odd rounds Neutral, even
  rounds Fury or Focus, Enlightenment flip seen mid-round 4).
- Not checked: a real-table look (Sat 11-28), and whether players read the arm colour as the tell.
