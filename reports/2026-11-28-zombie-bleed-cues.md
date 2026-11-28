---
id: 2026-11-28-zombie-bleed-cues
title: Heads-up — Zombie + Bleed token cues, heals-that-hurt warnings, Crysta exemption (touches your picker / compose / TARGET files)
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/token-tint, status-cues, action-card, action-profile, target-picker, drawer-views, compose-action, state-handlers, remote-pick, skill-formulas
introduced_in:
fixed_in:
---

Not a bug: a design onigensou approved on 2026-11-28 (mockup
claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX, sections "Bleed" and "Zombie"). It touches
some of your files in small, contained ways. Read-only for you unless something looks
wrong. Close it (`status: verified`) once you've had a look.

Branch `feat/zombie-bleed-cues` (4 commits on 518071f9).

## What changed

### Token cues (status-cues.js, status-cues-back.js NEW, token-tint.js, status-classifier.js)
- `STATUS_CUES` gains `zombie` and `bleed`. The cue follows the **status**: a creature
  that is Undead by species draws nothing.
- **Zombie** = a new token-tint mode `grade` (one colour matrix + gamma in one shader
  pass, plus a rim glow as two 1-D alpha blurs drawn behind the sprite) and a
  deep-purple miasma. Zombie is first in `WASH_ORDER`. Neutral grade values are the
  identity; the `mul` blend equals today's multiply wash (unit-tested).
- **New behind-the-sprite cue layer** (`status-cues-back.js`): one PIXI container per
  unit in `canvas.primary` at the mesh's own depth keys minus a hair (the
  charge-orbit-fx back-layer pattern). About a third of the miasma puffs live there,
  so they pass behind the body; the rest stay in the DOM layer. Hidden with
  `fuBattleMarksHidden`, outside battle, and while the mesh is hidden.
- **Bleed** = a pierced heart beside the head on its back side (DOM, scales with --k).
- All approved values sit in ONE constants block: `ZOMBIE_LOOK` / `BLEED_LOOK` at the
  top of status-cues.js.

### Heals that hurt (skill-formulas.js, action-profile.js, action-card.js, heal-warning.js NEW)
- `healReversalReason(actor, { row })` → `"zombie" | "effect" | "undead" | null`
  (same rule as `shouldReverseHeal`; reason order Zombie → False Idol effect → species).
- The card prints a reversed heal as **"DAMAGE 60"** in red (class `rev`, was
  `UNDEAD · HIT` in hit green, and said Undead for a Zombie'd non-undead), a Zombie /
  Undead pill, a red row wash and the line "2 of 3 targets take this heal as damage."
- **Reveal gate**: an Undead *species* is named only if the party knows it, i.e. the
  same Identity-tier Study gate that masks DEF / affinity. `makeStudiedGate` now
  delegates to `heal-warning.js speciesKnown` (identical behaviour). An unknown Undead
  previews as a normal heal (`healWarnHidden` + `healMaskAmount`); the heal still
  reverses when it lands; the applied amount (`value`) is untouched.
- **Your code, small fix**: the grant repaint delta (`grantRows`, action-card.js
  ~9466) dropped `healReversed`, so any recompute repainted a reversed heal row as a
  heal ("FULL · NO EFFECT" / "HEALED"). It now carries the reversal fields.

### Picker chip (target-picker.js, drawer-views.js, remote-pick.js, compose-action.js, state-handlers.js)
- `requestTargeting({ …, healWarn })` (new optional flag, default false). When true,
  a row the heal would hurt gets a red "Heal hurts" chip (Zombie icon for the status,
  "Heal hurts · Undead" for a known Undead). It never blocks. `healWarn` rides the
  remote-pick spec like `lockSelection`.
- Set from `restoresHp(source)` in `resolveTargetsForSource` (self, all, normal picks)
  and from `restoresHp(skill)` in `resolveActionTargets` (both picker calls).
- drawer-views `rowHTML`: the `r.status` chip slot takes an optional `statusCls` and
  `statusIcon` (default `t-tag`, unchanged for "Must target").

### Crysta (skill-formulas.js + migration)
- `flags.fabula-ultima-companion.healReversalExempt` exempts the **species** part of
  `isHealReversedActor` (mirrors `reviveKillImmune`), so Crysta heals normally and is
  no revive-kill target. A Zombie status on her still reverses.
- Migration `2026-11-28-crysta-heal-reversal-exempt` sets it on actor
  `ZPPCxB0eOJPulEHv`. **Needs a GM boot.** Battle tokens spawn from that actor, sim
  clones use `toObject()`, so copies inherit it.

### Party Status / HUD tooltip (party-menu-effects.js)
- Bleed reads "Healing ×½", Wither "MP gain ×½", Zombie "Healing hurts" (from its
  `species_override UNDEAD` stamp), False Idol "Healing hurts". Before, they showed
  raw key names ("Heal Receiving Mod All −0.5", "Species Override: UNDEAD").

## Checked in a sandbox battle (world copy, port 30021, module from the worktree)
- Zombie + Bleed on Zarg (PC) and the Reanimated Mana Ray (summon); Zombie on Keren and
  Hina; Bleed on Blanche. Cues and grade render, survive F5, back layer visible.
- Hina's Heal (60) on Mana Ray / Blanche / unstudied Nox Wraith: picker chip on Mana Ray
  only, card DAMAGE row for Mana Ray, normal heal preview for the Wraith. Applied:
  Mana Ray 115 → 55 (full 60, Bleed ignored), Blanche +30 (halved), Wraith 260 → 200.
- After Studying the Wraith (bestResult 9): chip "Heal hurts · Undead", card DAMAGE +
  Undead pill. Crysta (exempt, 10/30) → "HEALED 60 HP", landed 10 → 30.
- Wither: Grape Juice 20 MP on Keren previews "RESTORED 10 MP" and lands 30 → 40. It
  already worked before this branch (no change needed).
- Perf, 4 tokens with the grade, Training Ground, Edge GPU window: render+finish median
  1.4 ms (p90 1.7) vs 1.2 ms (1.9) with the grade filters disabled; frame rate the same
  (capped ~30 fps both ways).

## Not done / for later
- Pre-existing test failures, same on 518071f9: `crisis-keywords.test.mjs` (Hooks not
  defined in client-options.js) and `impact-offsets.test.mjs` (missing
  tools/anim-studio/nidhogg-soulflare.js).
- Possible pre-existing bug, not touched: the Armor Break / Magic Break marker comment
  says "drawn facing right unless flipped" and puts DEF on the left of an unflipped
  battler. Battle art faces LEFT (leave-exit-fx.js), so for party members that's
  the front side, not the back. The Bleed heart uses the leave-exit-fx convention.
- Out-of-combat Healing HUD still says "<name> is Undead" for a Zombie'd target
  (healing-hud-app.js ~869).
