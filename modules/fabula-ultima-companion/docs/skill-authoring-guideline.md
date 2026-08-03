# Skill & Equipment Authoring Guideline

A distilled, reviewable rule list for authoring skills and equipment in this
world, derived from the verified skills/equipment already shipped. This is the
**quick checklist**; the deep rationale lives in
[skill-authoring-canon.md](skill-authoring-canon.md) (structure/canon) and
[battle-director-dev-guide.md](battle-director-dev-guide.md) (onboarding). Read
this before authoring; consult those two when a rule needs its "why".

Each rule names a real, verified example so it stays grounded.

## Corpus snapshot (measured 2026-08-02, `_authored-export`)

What the house actually ships — use it to check that a design is *ordinary* before
inventing something. 590 configured skills, 416 reaction rows, 1808 effect rows.

- **effect_kind** — `apply_ae` 481, `chain` 322, `targeting` 165, `grant` 152,
  `open_action_menu` 101, `deal_damage` 71, `adjust_damage` 55, `remove_tagged_ae`
  48, `consume_resource` 48, `free_action` 42, `consume_charge` 41, `adjust_cost`
  36, `change_damage_element` 30. If your design needs a kind outside this set,
  re-read H1 before adding one.
- **reaction_trigger** — `conflict_start` 57, `creature_deals_damage` 51,
  `creature_will_deal_damage` 49, `creature_performs_action` 40, `turn_start` 31,
  `creature_targeted_by_action` 26, `creature_lose_resource` 20,
  `creature_defeated` 18, `turn_end` 16.
- **passive_mode** — `ask` 183, `force` 129, `on` 104. `ask` is the default
  posture: give the player the choice unless the rule is mandatory (`force`) or a
  silent always-on (`on`).
- `chain` being the #2 kind is the composition idiom: build a multi-step effect as
  a chain of small rows, not one bespoke kind.

---

## A. Where behavior lives (structure)

- **A1 — All conditional / triggered / passive behavior goes in
  `reaction_config_table` + `effect_table` rows, never top-level
  `system.props.*` fields.** The Skill Effects panel exposes only
  `On-Activate Effect Ref`. Deprecated homes: `post_damage_effect_ref`,
  `passive_check_bonus_formula`, `passive_damage_bonus`, `<class>_passive: true`.
  ⚠ **"Deprecated" here means "closed to NEW authoring", not "dead".**
  `post_damage_effect_ref` is still honored at runtime — `skill-effects.js` reads
  `ctx.firePoints.post_damage_effect_ref` with a legacy raw-prop fallback, and
  `skill-picker.js` still detects it — and **7 shipped skills still depend on it**
  (Drain Spirit across 5 actors, Fling, Muleta). Don't "clean up" those props
  expecting a no-op; migrating one means moving the behavior to a reaction row and
  re-verifying the skill.

- **A2 — Walk the decision tree to pick the home.** Turn-menu activation →
  `on_activate_effect_ref`; external event → reaction row; buff/debuff on
  another creature → AE with `reactionConfig`; N-uses / duration → AE with
  charges; always-on-while-owned → `transfer:true` AE, no reaction.
  *(Dodge's `bonus_defense += ${level}$` is a pure transfer-AE passive.)*

- **A3 — A true passive is an AE that just BE's, not a `turn_start` force-reaction
  that re-applies a self-AE.** Spending a trigger dispatch on an always-on bonus
  is a canon violation.

- **A4 — Scope a skill row to its own item with
  `reaction_source_skill: "<exact name>"` when it should fire ONLY when that
  skill/weapon acts.** Without it the row is *ambient* and fires on every
  qualifying action (it will leak onto basic attacks). `skill_type` does NOT
  gate reactions.

  **Ambient is the majority case and usually correct — don't "fix" it reflexively.**
  180 shipped rows carry neither `reaction_source_skill` nor a `condition_formula`,
  and most should: Counterattack (`creature_hit_by_action`), Undead
  (`conflict_start`), Curse (`creature_defeated`) are *about the event*, not about
  a skill the owner used. Ask "does this describe something the OWNER did, or
  something that HAPPENED to them?" — only the former needs scoping. The test for a
  leak is behavioral: does it fire on a basic attack where the RAW text wouldn't?

## B. Cost / resources

- **B1 — One cost source of truth, never two.** Either legacy
  `system.props.cost = "10 MP"` (parsed at CONFIRM) **or** a `consume_resource`
  row in the chain — never both, or the player is charged twice. There is no
  engine guard.

- **B2 — On a reaction skill, `cost` is display-only.** Reactions never reach the
  action-card debit phase; the real debit is `consume_resource` in the chain.
  *(High Speed: `cost:"10 MP"` for the tooltip, `consume_resource` does the work.)*

- **B3 — A rider that BUYS something on someone else's action bills with
  `adjust_cost`, not `consume_resource`.** "Spend 10 MP to target one additional
  creature" is part of what THAT action costs: an `adjust_cost` row
  (`cost_resource`/`cost_operation: add`/`cost_amount`) folds into the action's
  cost, shows on the card's cost bullet, and is debited once at RESOLVE. A
  `consume_resource` row debits immediately when the reaction fires, so the player
  pays before the action commits and the card never shows the real total. A
  POSITIVE delta may seed a resource the action doesn't natively charge (a
  surcharge on a free Attack); a discount / waive still can't conjure one.
  *(Barrage; Cataclysm's overcharge; Hypercognition's discount is the same row
  with a negative amount.)* Affordability for such a purchase is gated where the
  player commits to it, since no in-chain debit remains to abort on an empty pool.

## C. Reactions & UI phase

- **C1 — The trigger's phase picks the UI, not the author.** Pre-resolve
  (manipulates the pending action) → pills on the action card. Post-resolve
  (Counterattack, Absorb MP, Painful Lesson) and standalone (turn/round
  start/end) → token-anchored menu.

- **C1a — There are exactly TWO surfaces, and no third.** (1) Action-card
  pills, while an action is IN FLIGHT, to manipulate that action's outcome;
  (2) token-anchored pill list, when NO action is pending. The deciding
  question is *"is there a pending action whose outcome this changes?"* — not
  *"when does it fire"*. A reaction that changes what an in-flight action does
  to you belongs on the CARD even though nothing has landed yet.

- **C1b — Incoming `adjust_damage` has TWO homes; choosing the wrong one is a
  silent behavior change, not a preference.** `creature_targeted_by_action` →
  card pill, soak previewed BEFORE Apply
  (`card-mutations.applyAdjustDamageMutation`). `creature_takes_damage` →
  opt-in prompt at HP-write (`skill-effects.resolveDamageReactions`, the Mercy
  family). Keren's Stubborn Scion is the FIRST and must stay there — moving it
  would cost the pre-Apply preview, the pill UI and its interactive d6 roll.
  Note `creature_targeted_by_action` is not in `TRIGGER_PHASE` at all, so C1's
  phase map does not classify it. Full rule:
  [skill-authoring-canon.md](skill-authoring-canon.md) → "The two-surface rule".

- **C2 — Add a missing trigger as a new canonical trigger** (with subject side +
  filter matrix + template dropdown entry) rather than hardcoding behavior in the
  engine.

## D. Player choices & UX

- **D1 — A choice that feeds an effect AMOUNT must be captured pre-card
  (`pre_activate_effect_ref`), never mid-chain.** Pre-card picks are frozen with
  the dice, so preview == commit; a mid-chain `VAR_` read at COMPUTE resolves to
  0 and the engine throws. *(Elemental Shard / Meteor Shower:
  `prompt_element` → pre_activate.)*

- **D2 — Options / pickers surface before the action card**
  (`open_action_menu`, element/number prompts). Mid-chain prompts are allowed
  ONLY when their value never feeds an effect amount.

- **D3 — AE naming = skill name verbatim; multi-option uses `Skill (Option)`.**
  "Aura" not "Aura'd"; "Reinforce (Dazed)".

## E. Active Effects

- **E1 — AEs fired via `apply_ae` set `transfer:false`;** only always-on passives
  use `transfer:true`.

- **E2 — `statuses` is decided by the AE's CLASS, not by "do I want an icon".**
  The corpus is emphatic: of 529 `transfer:true` AEs, **521 carry NO `statuses`**.
  - **Always-on passive (`transfer:true`, no duration, no reactionConfig) → OMIT
    `statuses`.** The token ring is signal-to-noise; a permanent part of the
    character's loadout must not claim an icon slot. *(Dodge, Adversity, Magical
    Artillery, "Air Pendant".)* The `changes[]` still apply — an icon is not what
    makes an AE work.
  - **Transient / director-applied (`transfer:false`) → REQUIRE a non-empty
    `statuses:["fud-<slug>"]`**, else no icon ring *and* no charges badge (E6
    depends on it). *(Reinforce (Dazed); Elemental Weapon (Fire).)*
  - Counter-case that still needs an icon despite being "passive": an AE that
    ARMS a reaction (Heart of Darkness Ready, Mercy's ready-charge) — the icon is
    how the player knows the reaction is loaded.

- **E3 — Buffs/debuffs self-tag `system.tags:["buff"|"debuff"]`, and the tag is
  load-bearing for FOUR consumers, not one.** Untagged = "Other" and therefore
  invisible to: (1) **cleanse removal** — `healing-cleanse.js` matches the
  cleansing *item* by name but decides WHAT to strip with
  `tags.includes("debuff")`; (2) the **`STATUS_COUNT` / `TARGET_STATUS_COUNT`**
  identifier family; (3) **`remove_tagged_ae`** rows, which filter on
  `system.tags`; (4) the **player HUD**, which is opt-in by tag. Ten modules read
  `system.tags` — treat it as API, not decoration.

- **E3a — NEVER hand-roll an AE named after a canonical condition; apply the hub's
  copy by name.** Canonical conditions live on the `Debuff` (`XVOWOq9oUmEECGrU`,
  51 effects) and `Buff` (`0rfKFWTyPt7TfUvl`, 6) hub items, already carrying the
  right tags. A locally-authored "Slow" / "Poisoned" / "Envenomed" AE looks
  identical on the token but is inert to every consumer in E3 — the player drinks
  a Super Tonic and the debuff stays. **Live backlog: 57 local copies of a hub
  condition currently carry no tags** (Flying ×17, Envenomed ×5, Bane ×3, and
  Jack's Snaring Arrow "Slow" / Burning Arrow "Burn" / Poison Arrow "Poisoned"),
  against only 14 tagged. If a genuinely new condition is needed, add it to the
  hub — don't fork it onto the skill.

- **E4 — Read actor stats with `${fetchFromParent('prop')}$`; read the bearing
  skill's SL with bare `${level}$`.** `target.X` / `ref()` / bare names are
  unreliable for actor props.

- **E5 — Limited-use behavior uses the existing `charges` / `chargesMax` /
  `chargeKey` + `consume_charge`,** never a per-skill counter prop. The AE
  auto-deletes at 0.

- **E6 — To SHOW a charge count on the token, rely on the AEM charges-badge —
  do NOT touch the `statuscounter` module.** `ActiveEffectManager-charges-badge.js`
  auto-renders `flags["fabula-ultima-companion"].charges` as a number in the
  **top-right** of the AE's token icon whenever `chargesMax !== 1` (hidden for
  `chargesMax === 1`, an on/off effect). So a count-carrying AE just needs
  `chargeKey` + `charges` + `chargesMax (>1 or unset)` **and** a non-empty
  `statuses` (E2 — no icon, no badge). Setting `flags.statuscounter.visible:true`
  renders a SECOND, duplicate badge in the **bottom-right** — never do this for a
  charge count. (The statuscounter module also resets its own flag to defaults
  inside preCreate, so seeding it via create data doesn't stick anyway.) Store a
  rolled/derived value as a charge with `apply_ae` + `ae_initial_charges: "<formula>"`
  (formulas allowed; reads chain VARs), then read it back as `AE_CHARGES_<NAME>`.
  *(Geist's Shadow Strike: roll d12 → apply "Shadow Strike" AE with
  `ae_initial_charges: "VAR_MIG_DIE"` → the roll shows top-right, read later as
  `AE_CHARGES_SHADOW_STRIKE`.)*

## F. Equipment / gear

- **F1 — Gear (weapon / armor / shield / accessory) NEVER carries
  `reaction_config_table` / `effect_table` on its own `system.props`.** Behavior
  lives on a carried `transfer:true` AE (the Ninja Log pattern) **or** a linked
  `_skill` (`system.container = <gearId>`). This holds for weapons too. Sheet
  editors are now visibility-gated off gear item types.

- **F2 — A weapon-scoped `_skill` row sets `reaction_requires_weapon_used:true`**
  so it fires only when that weapon is the acting one (covers the two-weapon and
  monster-attack cases; monsters are `isEquipped:false`).

- **F3 — Never call `reloadTemplate()` after `-=` prop deletions on a
  stored-props gear item** — it re-projects to template defaults and wipes stored
  props. The `-=` update alone removes the key cleanly.

- **F4 — A gear `_skill` is INERT until its container is EQUIPPED. Budget for
  this when you test, or you will misdiagnose a correct skill as broken.**
  `containerReactionInPlay` gates every `_skill` whose `system.container` is an
  `accessory` / `armor` / `shield` / `weapon` on that container's
  `isEquipped === true`. It fails OPEN for a missing/dangling container or a
  non-gear container, so ordinary skills are never gated — but a gear `_skill`
  sitting in a shared stash fires nothing at all. *(Dragonslayer Pendant: gate and
  effect both correct, `isEquipped:false` on the party stash, so zero observable
  behavior. It has to be moved onto a PC and equipped before it can be tested.)*
  Two documented bypasses: a WEAPON container that was the acting weapon counts as
  in-play even when `isEquipped` is false (NPC weapons are almost never flagged —
  this is what F2 rides on), and the item being unequipped counts as in-play for
  its own unequip trigger.

## G. Formulas & previews

- **G1 — In `deal_damage`, victim-relative ids (`MAX_HP` / `CUR_HP` / affinity)
  resolve against the TARGET; in `grant`, against the CASTER.** Preview must use
  the same resolver per kind, or the card shows one number and apply deals
  another. *(Flame Claw once previewed 22 and dealt 11.)*

- **G2 — Two formula evaluators exist** (BD = `skill-formulas.js`; passive AE =
  `oni.ReactionFormula`). Authoring a formula on the wrong side silently yields 0.

## H. Engine philosophy

- **H1 — Prefer reusing / generalizing an existing primitive over a new narrow
  engine field.** Decision order: (1) existing effect_kind / AE / identifier via
  authoring alone; (2) generalize an existing mechanism by one knob; (3) last
  resort, a new field — and then grep EVERY seam that reads the concept (display
  headline AND mechanics AND downstream payload). *(Ripples' `element_override`
  had a second headline seam that silently diverged.)*

- **H2 — No-hardcode test:** if you can't build a similar skill without engine
  edits, build the declarative knob first. No per-skill custom JS, no engine
  branching on skill name / UUID.

## I. Process

- **I1 — RAW text comes from `reference/skills.json` first** — never re-grep the
  PDFs; surface any drift back into the JSON.

- **I2 — Author via a data migration** (idempotent, BD-tree, edit master → sync
  copies) or `CreateSkillFromSpec` — not the CSB UI.

- **I2a — When you CLONE a `_skill` and rewrite its tables, write the FULL key set
  for every row.** A CSB `update()` on `system.props.*_table` **deep-merges** into
  the source's rows, so any key you don't overwrite survives from whatever you
  cloned. This is silent and produces behavior nobody authored. *(Cloning Poisoned
  Dagger to build Frozen Envy leaked `condition_formula: "chance(50)"` onto the
  Slow row and a weapon-gate onto an accessory — cost a full rebuild.)* Safest
  shape: build the row object literally and assign the whole table, rather than
  patching row fields one at a time.

- **I3 — Add template columns before writing new props** (writes to undeclared
  columns are silently stripped): one line in `template-field-registry.js`, with
  the mandatory CSB version bump.

- **I4 — Verify with the director harness before asking for a playtest**
  (`runDirectorSkillCompute` / `runDirectorSkillSimulate`). Don't launch a combat
  for what the harness can model. **But know the harness's three blind spots — each
  one reports a WORKING skill as dead, which is the expensive direction of wrong:**
  - **Pre-resolve reactions need `prePassives`.** `runDirectorAttackSimulate`
    applies `creature_will_deal_damage` rows only when you pass
    `prePassives: true` (or `["<carrierName>"]`) — see
    `_test-harness-director.js`, `applyPrePassivesToActionResult`. Omit it and the
    reaction never dispatches: damage comes back identical with the gate true,
    false, or literally `1`.
  - **COMPUTE is thin for effect rows.** `deal_damage` / `grant` land in RESOLVE,
    so a COMPUTE-only run shows `damage: 0` for a skill that works. Use simulate
    for anything whose payload is an `effect_table` row.
  - **The bench dummy has real affinities.** `Test Target Enemy` is
    `affinity_2: "IM"` (air-IMMUNE) and `affinity_3: "VU"` (bolt). An air skill
    tested against it writes 0 and looks broken. Pick a neutral target (Fjord) or
    read the affinity before trusting the number.

  Corollary: when a skill measures identical WITH and WITHOUT the thing you added,
  suspect the harness before the data — neutralize the gate to a literal `1` and
  re-run. If it's *still* identical, the row never dispatched.

- **I4a — 🚨 A simulate that ERRORS OR TIMES OUT leaves the harness's write-capture
  prototype patches INSTALLED, and every write you make afterwards is silently
  swallowed.** `runDirectorSkillSimulate` patches Actor/Item/AE prototypes and
  restores them in its `finally`; a hang (see I4) never reaches it. Symptoms:
  `item.update()` returns success and changes nothing — not even a plain string
  field — and `toObject()` shows the OLD value, so it isn't a derived-projection
  problem. Cleanup deletes get captured too, so temp test docs appear to survive
  deletion. **Any read taken in this state is also untrustworthy** (an item count
  looked wrong to me until I re-read it on a clean client). **Recovery: kill and
  relaunch the client** — a fresh page is the only reliable reset. Kill the OLD hold
  client first; a second one cannot take the GM II seat while the first holds it
  (Playwright fails with "option being selected is not enabled").

- **I5 — Set `level:1`, an explicit `max_level`, and `isHeroic:true` for
  heroics** — never rely on template defaults.

- **I6 — Share by pushing world data on the USER's call, not via migrations;** run
  `world-export report` before any `worlds/` commit.

---

## J. Known open violations (audited 2026-08-02)

Kept visible so nobody "discovers" these as new bugs, and so a rule isn't assumed
100% enforced when it isn't. Each is a migration, not a rule change.

| Rule | Count | What |
|------|-------|------|
| **E3a / E3** | **57** | Local copies of a hub condition with NO tags — invisible to cleanse, `STATUS_COUNT`, `remove_tagged_ae`, HUD. Worst: Flying ×17, Envenomed ×5. Jack's Snaring Arrow "Slow", Burning Arrow "Burn", Poison Arrow "Poisoned" are all uncleansable. **Highest-value fix in this table** — it silently breaks a player-facing promise (drink a Super Tonic, keep the debuff). |
| **A1** | 7 | `post_damage_effect_ref` still in use (Drain Spirit ×5, Fling, Muleta). Still honored by the engine; migrating means moving to a reaction row + re-verifying. |
| **F1** | 1 | `Centimare :: Poisoned Dagger` (weapon) still carries `reaction_config_table` + `effect_table` on its own props. The last of the three known non-PC weapons. |
| **B1** | ~~1~~ **FIXED** | `Zarg :: See you later` — **confirmed** double-charge, now repaired. See the worked example below. |

Re-run the audit by walking `_authored-export` for these four shapes; it needs no
running game.

### Worked example — the B1 double-charge, and why the fix wasn't "delete one line"

`See you later` (1 FP, leave the battle) carried BOTH `cost: "1 Fabula Point"` and a
chain `syl_cost: consume_resource fp 1`. Proven live, not inferred:
`parseSkillCost("1 Fabula Point")` → `[{resource:"fp", amount:1}]` → `resolveCost` →
`Map{fp→1}` → `computeEffectiveCost` → `{fp:1}` — which is exactly the map
`state-handlers.js` hands to `debitCost` at RESOLVE. `"fabula point"` is a registered
alias, so the card path debits it; the chain then debited a second time.

**The abort path was worse than the overcharge.** Resolve order is *1. debit cost →
2. fire `on_activate`*, and `syl_cost` carried `on_empty: "abort"`. So a character
holding exactly 1 FP paid the native cost (1 → 0), then the chain's consume found an
empty pool and aborted — `syl_leave` never ran. **They spent their Fabula Point and
stayed in combat.** With the confirm living *inside* the chain, cancelling also
charged, because the debit had already happened at step 1.

**Fix (all three parts were needed):**
1. `pre_activate_effect_ref: "syl_confirm"` — the gate moves BEFORE the card, where a
   cancel is "back to Action Menu (nothing spent)" and no card is ever built.
2. `syl_root.chain_steps` → `"syl_leave"` only.
3. Delete the `syl_cost` row — the native `cost` is now the single source (B1).

Generalise: **when a skill's cost is flat, keep the legacy `cost` string and put any
confirmation in `pre_activate`.** Putting a confirm inside the on_activate chain is
always wrong for a costed skill, because the debit precedes the chain.
