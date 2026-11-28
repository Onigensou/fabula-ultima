---
id: 2026-11-28-chain-range-card
title: Heads-up — random-target Chain card (ranges, keep-all targets, Protect re-draw) touches action-card + chain code
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/action-card, battle-director/chain-plan, battle-director/chain-strikes, battle-director/action-profile, battle-director/state-handlers, battle-director/invoke
introduced_in: bd66769d
fixed_in:
---

Not a bug: a card change onigensou approved on 2026-11-28 (mockup "Random-target Chain
HUD", round 7) that touches files you own. Read-only for you unless something looks
wrong. Close it (`status: verified`) once you've had a look.

## What changed, and why

A Chain whose strikes draw their targets (`seek`, `random`, `volley`) showed strike 1's
roll and a HIT/MISS on every row, which none of the other strikes share, and the
random / volley card was trimmed to the drawn creatures (the draw, given away). In the
world: Asura Strike (chain 4 seek), Thunderstorm (chain 3 seek), Tommy Gun (chain 5
volley), Sonic Blow (chain 8 volley). Every other Chain (`chain N`, `hidden`, `pick`,
`separate`) keeps today's card.

1. **Ranges priced at COMPUTE** — new `chain-preview.js`. `attachChainPreview`
   (state-handlers.js) stamps `ar.chainPreview`: accuracy (1+1 … both dice maxed, + the
   check bonus), one strike's damage (HR 1 … HR max, before the target) and each
   target's range (flat reduction → weapon efficiency → the strike element's affinity,
   spanning the strike elements; AB = "<EL> heals" note, IM = "<EL> 0" note). No
   parallel maths: each sample is a `recomputeActionProfile` call with every target
   forced to hit (`gmHitOverrides`), the HR stood in by the GM damage input
   (`useHR:false, bonus:h`) and non-crit dice, per strike element (`strikeArFor`) and,
   for a volley, the first and last shot (the flat share falls). Crits, Perfect ×1.5,
   Pierce half and card reactions are not in the range (the hover says so).
   `action-profile.js`: the primary damage effect now also carries `outgoing`
   (shareBase, the hit before the target) and `incomingBreakdown` (the target's own mod
   parts); `recomputeActionProfile({ withProfile:true })` hands the profile back as
   `delta._profile` (already on WIRE_DROP_KEYS). Neither reaches flattenRow.
2. **The card** — `paintChainRangeCard` (action-card.js) paints over what the builders
   draw: accuracy range (dice faces, crit/fumble banner and Opportunity removed; the
   note in the total's hover), damage range centred with the element word or
   "Multi-Type" (hover lists each strike's element + "Pierce: a miss deals ½"), no +HR,
   "×N hit" on the box's bottom-right border, range font 30 → 16 px when it nears the
   word (`fitChainRangeDamage`, run from `fitActionCardToViewport`), every row its own
   range in the action's element colour (Multi-Type = ink #3a3228) with a 1.15 s blink
   (reduced-motion: none), affinity pill removed (it only shows on a hit). The preview
   rides on the card element (`data-fud-chain-preview`), so every repaint path calls the
   paint LAST: `assembleActionCardRoot` (host + local mirror render),
   `applyCardTargetMutationDelta` (end), `rerenderActionCardBody`, `appendTargetRow`,
   invoke-worker `patchCardDom`, invoke-hud Bond preview/restore. Number tweens are
   defeated by swapping the node (`freshNode`). `chainPreview` is in
   ACTION_CARD_RENDER_KEYS. A creature that joins the card (Protect's protector, Magic
   Mirror, an added target) is priced on the fly in `recomputeTargetPreviews`
   (`extendChainPreview`) and the grown preview rides `delta.chainPreview`; CONFIRM does
   the same after the force add_target pre-splice. Unstudied rows stay "???".
3. **Chain bullet** — a drawn Chain's tooltip no longer lists "Strikes: Hina ×2, …".
4. **Engine** — `drawChainTargets` returns `keep: null` for every drawn mode (random /
   volley no longer narrowed; pick unchanged). `buildChainPlan`: a random / volley
   strike drawn onto a creature no longer on the card (Protect took its row) is
   re-drawn among the card targets still standing (`redrawOffCard`, chain-strikes.js);
   it used to be lost. Seek unchanged; a KO'd pick still on the card is still lost (as
   random / volley always did). The re-drawn lists also feed the volley shares.
   ANIMATION: a random / volley Chain still animates on the struck creatures (the set
   the card used to be trimmed to), not every card target.
   `director-animation.js outcomesFromDirector` and `show-hurt-rules.js rowLosesHp`: a
   Chain card target no strike went to now reads as not hit (it used strike 1's row
   verdict — already wrong for seek).
5. **Pierce label** — `resultLabelFor` / `resultClsFor`: a Pierce miss (`pierceMiss`)
   reads "PIERCE ½ n" coloured by affinity instead of "MISS"; `pierceMiss` now rides the
   redirect / defense / result-row deltas and `projectActionResultForRender`.
6. **Asura Strike animation** (tools/anim-studio, source only): cuts and bursts wear
   each strike's own element (plan outcome `element`, else `cfg.strikeOrder` Bolt Fire
   Ice Air); the approved ignite order `cfg.order` is unchanged. The world item still
   carries the old script until it is rebuilt.

## Verified

- Unit: chain-preview 46, chain-plan 100, chain-strikes 156, show-hurt 215, plus the
  rest of `scripts/**/*.test.mjs` (same 5 pre-existing failures as main: missing
  files/env in crisis-keywords, impact-offsets, soul-fx-look, return-look, return-stage).
- Sandbox battles (world copy, worktree module, sim at watch pace): Asura Strike seek,
  Thunderstorm (Magic Mirror redirect priced Kirin on the fly), Tommy Gun volley, Sonic
  Blow volley, Asura Strike as volley + forced Protect with all 4 draws forced onto Hina
  → "re-drew 4 strike(s) aimed at a creature no longer on the card", Divine Railstream
  (chain 8 hidden) unchanged, player mirror repaint after a Protect delta. Every landed
  strike fell inside its row's range.
- skill-regression `parity` + `census` clean.

## Worth knowing (not changed)

- Duplicate token rows (a protector already on the card): the result-row loop's
  `nameSpan.innerHTML = name` rewrites the FIRST matching row, which can drop the 🔄
  marker on the redirected row. Pre-existing.
- The crit cut-in at CONFIRM and the Invoke fumble lock still react to strike 1's roll
  on a drawn Chain card.
