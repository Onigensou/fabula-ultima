# Spell Fencer class — rework, automation, animations (v1.0.662, 2026-11-23)

Session to-do #6 (2026-11-22 report). Keren took Spell Fencer at the 11-21 session (Spellblade Rhapsody SL 1, Spellweave SL 2);
the whole class was text only. Balanced as GENERAL game balance (not tuned to Keren), automated, animated, shipped.

## Design (approved on the class page, rounds 1–4)
Class page: https://claude.ai/artifact/7ioWPpurkP3XtdJr5okMSz · animation review: https://claude.ai/artifact/94H4XUhvbu42SzSYknv5e7

- **Resonance** (keyword, AE with charges): switching between a weapon attack and an Offensive Spell grants 1 (free attacks count);
  start each conflict with 1; max Spellweave SL + 1; lost at scene end. Spellblade Rhapsody turns grant none.
- **Spellweave** — the rhythm above + spend up to SL Resonance on an Offensive Spell for +1 Accuracy each (an ask pill).
- **Spellblade Rhapsody** (2 Resonance) — this turn, both the Attack and the Spell action; the spell is Offensive and ≤ SL × 10 MP.
- **Bladework** — the weapon attack after an Offensive Spell deals +SL and restores SL × 2 MP.
- **Mystic Infusion** — that attack takes the spell's damage type. **Book and Blade** — two-handed arcane weapons in one hand.
- **Heroics:** Master of Duality (any spell counts), **new** Crescendo (+10 on both Rhapsody actions), **new** Encore (once per
  scene, Rhapsody costs no Resonance — kept as the capstone by the user's choice), **new** Duelist's Guard (+2 DEF/MDEF at 2+).
- The name Resonance is kept although Chanter has an official skill of that name: the mechanic keys off its charge key, and
  links to an Item are never turned into the keyword by name.
- Text: Genshin mode (feedback_game_text_style_guide), content links to the keyword and skills.

Balance sim (scratchpad sf-sim/general2.js): the approved core is on target for the hybrid fencer at mastery (+22–28% over a
fight mix; mastered-class band ≈ +25–35%); a commit class, not a dip (2 levels ≈ +8%); casters are the wrong chassis (intended);
Crescendo ≈ +10% (normal Heroic); Encore ≈ +30–35% (accepted capstone).

## Build (feat/spell-fencer)
- Migrations (one-time, in order): `2026-11-23-spell-fencer-author` (text on every copy, the 3 Heroics created + embedded on the
  class actor, the Resonance explainer), `2026-11-23-spell-fencer-rules` (move-engine export of tools/move-engine/moves/spell-fencer/skills.js),
  `2026-11-23-spell-fencer-anims` (animation_script: Rhapsody on every Spellblade Rhapsody, the +1 pulse on every Spellweave).
- Engine: `shared/hand-slots.js` (one_hand_categories AE key), keyword registry (Resonance, Next Spell, Next Attack) +
  `lookupLinkTerm` guard, `spell-fencer-cues.js` + `spell-fencer-glow.js` (four rhythm auras + a sprite outline glow; the turn glow
  wins on the acting token), skill-effects re-scan payload carries the spell fields (Mystic Infusion), `card-reaction-order.js`
  (a spell's completes_spell chains fire after its performs_action chains: exact Resonance spend at the cap), action card keeps
  mid-sentence keywords, picker shows unparsed class costs ("2 Resonance"), oni-timeline plus-lighter overlay for pixelfx light
  layers (fixed an opaque black box; `add: true` clips unchanged).
- Animations (move-engine, mockup = game): Rhapsody 3.16 s (charge → duality sigil → braid with petals/flakes → unleash at
  1480 ms), +1 Resonance pulse 0.88 s. Red Mage (FFXIV) used as a language reference only (notes: FoundryVTT/rdm-animation-reference).
  12 new clips on Forge `Animation/pixelfx/pxfx_sf_*`.

## Verified
- Unit tests: hand-slots 16, spell-fencer-cues 26, card-reaction-order 7, status-classifier 9 groups.
- `move-engine export --check`: every copy found (world, class actor, Keren), validator clean; game vs mockup trace 25/25 + 2/2.
- Headless runner behaviour tests (12 scenarios + re-tests): rhythm, cap, free attacks, Rhapsody picker + engine path, Encore,
  Bladework, Crescendo, Mystic Infusion, Duelist's Guard (DEF and MDEF), Book and Blade, the spend.
- Real-server first boot on a sandbox copy of the live world (twice): 23 migrations (20 earlier pending + these 3), 0 failed;
  boot 2 runs 0. GPU battle on Training Ground 3D: auras, glow, pulse, Rhapsody cinematic (no black box), braid ends at turn end,
  card text, cost label, spend 3 → 2. Live world hash unchanged.

## Not verified / known edges
- Keren's player casting Rhapsody from their own client; a real-table look.
- Order fix also applies to Hina Fugitive Experiment + Bimagus / Healing Power / Support Magic and Yuri Barrage + Alchemist Vial
  when both pills are accepted (reasoned harmless, not driven); Exploit not driven (no player-owned owner).
- Acceleration's end-of-turn free action can gain 1 Resonance on a Rhapsody turn (accepted). Bladework MP is per hit target.
  The spend only happens when the player presses Apply. The cinematic tail (~1.7 s) plays on after the gate, as approved.
- The glow's width is fixed at the breath peak in the game (strength breathes instead).
- Your next GM boot runs 23 migrations.
