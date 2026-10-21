# Rakshasa — the weapon reader that telegraphs its strikes

> **Status: draft.** Seeded 2026-10-21 from the 2026-09-08/09 build notes and
> `docs/rakshasa-design-proposal.md` (§12 as-built, §9 sim). Stats are read live from the
> world — the world wins. `decided_by: user` = the designer's call; `claude` = my build
> notes, awaiting confirmation.

## Identity & role

- Actor `Rk5haXsaDemonAAA`. L40 DEMON **elite**, 4 activations.
- **Standalone story elite**, counterpart to Asura (user, 2026-10-20). Not a random
  encounter; GM-spawnable from the Valley Enemies table (row 12).
- Never live-tested.

## Concept

**Asura collects elements; Rakshasa reads weapons.** Asura punishes you for NOT varying
your element; Rakshasa punishes you for REPEATING a weapon category.

## The gimmick

- **It telegraphs every strike** (user, 2026-10-21). Activations resolve **Shift → Strike →
  Shift → Strike**: Form Shift visibly arms a stance (an AE on the token), and only then can
  the matching attack fire. Every attack spends its own stance, so the next activation has
  nothing legal but another Form Shift. The party reads the stance and answers it before the
  strike lands — that is the counterplay.
- Stances: Sword (Saber, Execute — hunts the wounded) · Flail (Mace, Cripple — hunts the
  healthy) · Bow (Rain of Arrows) · Throwing (Chakram). At **≤ 50% HP** it switches to
  **Form Shift (Dual)**: Sword and Bow (Executioner's Volley), Flail and Throwing (Rending
  Orbit), **Sword and Flail → Severing Verdict**.
- **Severing Verdict** is the colossal single hit (can drop a PC). It is only reachable in
  the second half, only after a visible Sword-and-Flail stance — a telegraphed spike, not a
  surprise one-shot.
- **Adaptive Defense** (`weapon_read`): attacking with one weapon family drops that family's
  efficiency and raises the others → rotate weapons or the fight drags. Self-regulating:
  a party that does not rotate just takes longer.
- Accuracy-class split (2026-09-09): Sword/Bow vs DEF (Strike), Flail/Throwing vs MDEF
  (Magic) so one Strike-immunity item cannot blank the kit. Devour auto-hits.

## Numbers & targets

- **HP 1200 (sheet) — why so high** (2026-09-08, commit `b370c1dd`): Crisis used to carry
  *Ten Thousand Arms*, which froze the weapon read so the party's output fell to ~55% in the
  second half. That brake was retired for the dual-arm combos ("Crisis is one idea instead of
  two"); with the party keeping full output, the same 5.5–6 round shape needed a bigger bar:
  840 → 1200. Crisis still lands around round 3 because half the bar is the midpoint.
- **There is no ×4 weakness.** Only VU light (×2). Adaptive Defense only *lowers* weapon
  efficiency: the family that just hit drops to 25%, recovering 40 → 60 → 80 → 100% as other
  families hit. A party that rotates four families sits near 80%; one that repeats sits near 25%.
  Spells read as Arcane. So the passive is a damage *tax* on top of 1200 HP, not a multiplier.

- Design pacing: Crisis around round 3, fight ~5.5–6 rounds; the second half takes ~2× as
  long. The build note says 840 HP; the sheet is the authority (read the brief).
- Mindscape cannot close the fight at real HP — force pacing with
  `--set actor:max_hp=<rounds × BaselineDPR>` or the combo half goes unmeasured.

## Decision log

| Date | Change | Why | Decided by | Result |
|---|---|---|---|---|
| 2026-09-08 | Built: Form Shift cycle, Adaptive Defense, 4 activations | weapon-axis counterpart to Asura | user | not live-tested |
| 2026-09-09 | Single-target strikes raised (Saber 30→60, Mace 28→40 …); Verdict unchanged | base damage must stand alone; Execute/Cripple are spikes | claude | sim victory 65%→56% |
| 2026-09-09 | Accuracy-class split Strike/Magic | Ghostly Sheet blanked an all-Strike kit | claude | victory 56%→51% |
| 2026-10-21 | Severing Verdict's one-shot is intended: telegraphed by stance | "it telegraphs its attacks before doing it, which allows for counterplay" | user | audit one-shot → intended |
| 2026-09-08 | Ten Thousand Arms retired for dual-arm Crisis combos; HP 840 → 1200; Verdict sized to 162 | one Crisis idea; party keeps full output, so a bigger bar keeps the 5.5–6 round shape | claude | escalation 27 → 56 per hit |
| 2026-10-21 | Keep the sheet's HP 1200 | "use sheet" | user | sim stalemate — live test owed |

```json dossier
{
  "monster": "Rakshasa",
  "actorId": "Rk5haXsaDemonAAA",
  "status": "draft",
  "updated": "2026-10-21",
  "role": "standalone story elite (Asura's counterpart); GM-spawnable via Valley Enemies row 12",
  "exceptions": [
    {
      "rule": "one-shot",
      "action": "Severing Verdict",
      "why": "Telegraphed: only usable after Form Shift (Dual) visibly arms the Sword and Flail stance, and only at <= 50% HP. The stance is the warning; reading it is the counterplay.",
      "decided_by": "user",
      "date": "2026-10-21"
    }
  ],
  "invariants": [
    {
      "id": "verdict-needs-dual-stance",
      "table": "action_pattern_table",
      "where": {
        "action_pattern_name": "Severing Verdict"
      },
      "field": "action_pattern_string",
      "equals": "Sword and Flail Stance",
      "why": "The stance IS the telegraph. Without the gate the one-shot has no warning."
    },
    {
      "id": "verdict-gate-is-status",
      "table": "action_pattern_table",
      "where": {
        "action_pattern_name": "Severing Verdict"
      },
      "field": "action_pattern_condition",
      "equals": "self_has_status",
      "why": "Same gate, its condition type."
    },
    {
      "id": "verdict-spends-stance",
      "item": "Severing Verdict",
      "table": "effect_table",
      "row": "spend_combo",
      "field": "ae_template_ref",
      "equals": "Sword and Flail Stance",
      "why": "Each strike spends its stance, so the next activation must Shift again (Shift → Strike cycle)."
    },
    {
      "id": "verdict-spend-persistent",
      "item": "Severing Verdict",
      "table": "effect_table",
      "row": "spend_combo",
      "field": "include_persistent",
      "equals": true,
      "why": "Stance AEs are persistent_counter; without include_persistent the removal is a SILENT no-op and it strikes every activation."
    },
    {
      "id": "dual-shift-arms-verdict",
      "item": "Form Shift (Dual)",
      "table": "effect_table",
      "row": "fs2_draw",
      "field": "ae_name_pool",
      "contains": "Sword and Flail Stance",
      "why": "The only way to reach Severing Verdict."
    },
    {
      "id": "dual-shift-second-half",
      "table": "action_pattern_table",
      "where": {
        "action_pattern_name": "Form Shift (Dual)"
      },
      "field": "action_pattern_value_2",
      "equals": "50",
      "why": "Combos (and the Verdict) belong to the second half, at <= 50% HP."
    },
    {
      "id": "shift-below-strike",
      "table": "action_pattern_table",
      "where": {
        "action_pattern_name": "Form Shift (Dual)"
      },
      "field": "action_pattern_priority",
      "equals": "4",
      "why": "Priority gap 4 vs the strikes' 8 makes Shift and Strike mutually exclusive — the cycle is emergent from it."
    },
    {
      "id": "verdict-priority",
      "table": "action_pattern_table",
      "where": {
        "action_pattern_name": "Severing Verdict"
      },
      "field": "action_pattern_priority",
      "equals": "8",
      "why": "Other side of the same gap."
    },
    {
      "id": "adaptive-defense-reads-weapons",
      "item": "Adaptive Defense",
      "table": "effect_table",
      "row": "ad_read",
      "field": "effect_kind",
      "equals": "weapon_read",
      "why": "The weapon-axis puzzle."
    }
  ],
  "blind_spots": [
    "The stance AEs live in the world status library (persistent_counter lifetime) — not checked here; if they are reaped at the next activation the telegraph vanishes before the strike.",
    "Mindscape cannot simulate the Strike/Magic accuracy-class axis (classAffinity is never populated).",
    "Solo boss: at real HP the modelled party rarely reaches Crisis, so the Dual/Verdict half goes unmeasured unless HP is forced.",
    "Never live-tested; runReactionLint not run on it.",
    "Adaptive Defense only LOWERS efficiency (25/40/60/80%, back to 100% once 4 other families have hit) — it never raises a lane above 100%. With VU light the best possible hit is ×2, never ×4."
  ],
  "open_questions": [
    "Is the stance readable enough at the table (token status icon / chat line) for the telegraph to work as counterplay?",
    "With 4 activations, does a PC always get a turn between the Dual Shift and the Verdict (BD alternates sides), or can Shift→Verdict land back-to-back?",
    "Crippled uses AE MULTIPLY on the derived defense prop — unverified that CSB honours it (else the text must stop promising a halving).",
    "HP 1200 reads as a stalemate in the current sim (0% win inside 10 rounds, 100% overtime, party's lowest HP ~62%) — but the sim party plays below human level and 58% of its actions are unmodelled. Live-test before touching HP."
  ]
}
```
