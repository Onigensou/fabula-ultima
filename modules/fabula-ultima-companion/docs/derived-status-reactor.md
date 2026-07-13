# Derived-Status Reactor — spec

Status: **PHASE 1 BUILT + VERIFIED** (2026-07-13; engine uncommitted). Owner: BD.
Supersedes the ad-hoc "grant a status while a condition holds" hacks (formula-stat
guards, hand-rolled `creature_status_applied` mirrors) with one supervised,
reconciled primitive. Phase 1 = authored rules (`derived-status-reactor.js`,
Prong A + B, per-actor lock; first consumer: Jetpack `Flying → Swift`). **Phase 2
Stage A DONE** — `core-crisis` built-in rule added (predicate reusing the exported
`crisisThreshold`, explicit Crisis template, `bdCrisis` flag); out-of-combat manual-
edit reconcile verified. **crisis-reactor still live (clean coexistence)** — Stage B
(retire it, §7.3) deferred until an in-combat live pass confirms parity. Truth table
(§9) verified live via the safety-net hooks.

## 1. Motivation

Many items/skills read "while you have status **X**, you also have status/effect
**Y**" — Jetpack (`Flying → Swift`), Swimsuit (`Wet → DEX 12`), and a long tail
to come (`Wet → Slow`, `Crisis → Enraged`, `≥2 admiration bonds → +DEF`, …).

Two failed approaches:

- **Stat-formula guard** (`dex_current ${and(isEquipped, ae("Flying"), not(ae("Swift"))) ? 2 : 0}$`)
  — works for a *stat* effect and is non-stacking, but never grants the real
  **status** (no icon, `ae("Swift")` can't see it) and can't express status→status.
- **Hand-rolled reaction mirror** (`creature_status_applied(Flying) → apply Swift`)
  — event-brittle: misses a pre-existing condition, and removing on
  `creature_loses_status` clobbers an independently-applied instance of the same
  status.

The engine already has the correct shape for exactly one status: **`crisis-reactor.js`**
reconciles the canonical **Crisis** AE against a *condition* (`current_hp ≤ threshold`),
idempotently, seeded at `conflict_start`. This spec **generalizes that reactor**
to data-authored rules — and, in doing so, closes the supervision gap Crisis
itself has today (see §7).

## 2. Supervision gaps this must fix (audit 2026-07-13)

`crisis-reactor` reconciles **only** on (a) BD hp-ledger events inside
`settleInstance` and (b) a `sweepCrisis()` at `conflict_start`. It therefore
MISSES:

- **Manual HP/status edits** (sheet / CSB drag / raw `actor.update`) — no ledger
  event, and there is **no `updateActor` hook for Crisis** (unlike Defeat, which
  `auto-defeat.js` catches on `updateActor` when BD is off). Confirmed: a search
  for `evaluateCrisis`/`sweepCrisis` outside the settle loop is empty.
- **Out of combat** — the reactor only exists while a BD instance runs.
- **Non-combatants during combat** — `sweepCrisis` iterates combatants only.

⇒ The derived-status reactor MUST be **two-pronged**: the settle-loop path
(cascade-aware, in-combat) **plus** an `updateActor`/`updateItem` safety net
(any actor, any time, BD or not). A settle-only clone would inherit every gap.

## 3. Data model — authoring a rule

Rules live as a flag on an **ActiveEffect** so they ship with world data and are
naturally gated by that AE's own presence (an equip-toggled gear transfer-AE is
"live" only while equipped; a passive-skill AE is live while owned). No per-item
code.

```jsonc
// flags["fabula-ultima-companion"].deriveStatus  on a carrier AE
{
  "when":  "AE_COUNT_FLYING > 0",   // condition formula (skill-formulas.js), per-actor
  "grant": "Swift",                  // canonical status name (Buff/Debuff hub, applied by name)
  "requireEquipped": true,           // (default true for gear carriers) also gate on carrier's isEquipped
  "ruleKey": "jetpack-flying-swift"  // stable id; namespaces the derived instance (auto-derived if omitted)
}
```

- **`when`** — evaluated by `skill-formulas.js evaluateFormula` with a minimal
  `buildSkillResolver({ actor })`. Status presence = `AE_COUNT_<NAME> > 0`
  (mirrors CSB `ae("<NAME>")`); value conditions use the normal prop identifiers
  (`CUR_HP`, `MAX_HP`, `crisis_hp`, …). One evaluator for both prongs → identical
  results in and out of the settle loop. [[reference_two_formula_evaluators]]
- **`grant`** — resolved by `resolveAeTemplate` (carrier's own effects → `activeEffectContainer`
  hubs), so `"Swift"`/`"Crisis"`/… resolve to the canonical templates.
- Carrier AE inactive (gear unequipped, skill removed) ⇒ rule not scanned ⇒
  derived status auto-removed on next reconcile. Equip-gating for free.

## 4. Reconcile algorithm (`evaluateDerivedStatuses(actor)`)

Idempotent, mirrors `evaluateCrisis`. For ONE actor:

1. **Collect rules**: scan `actor.appliedEffects` (active, non-disabled) for
   `flags[NS].deriveStatus`; drop rules whose `requireEquipped` is set and whose
   carrier item isn't equipped.
2. **Group by target status** `grant`. For each status **S**:
   - `wantedBy` = set of ruleKeys whose `when` evaluates truthy.
   - `derived` = the existing AE on the actor tagged `flags[NS].derivedStatus.forStatus === S`
     (the single reactor-owned instance), if any.
   - `independent` = an existing AE of status **S** that is **not** reactor-owned
     (applied directly by a spell/skill).
3. **Reconcile S** (the non-stacking core — at most ONE effective S ever):
   - `wantedBy` non-empty **and** no `independent` **and** no `derived` → **apply**
     canonical S, tag `derivedStatus:{ forStatus:S, byRules:[...wantedBy] }`.
   - `wantedBy` non-empty **and** `derived` exists → refresh `byRules` (no
     re-apply; idempotent).
   - `wantedBy` non-empty **and** `independent` exists → **do nothing** (the real
     status is already present; never add a second copy → the stat can't double).
   - `wantedBy` empty **and** `derived` exists → **remove** the derived instance.
     (Never touch `independent`.)
4. Any state change → `queueStatusEvent(director, actor, "applied"|"removed", …)`
   so the settle loop cascades (On-the-Hunt etc.), exactly as crisis does. In the
   safety-net path (no director) the write still fires the normal
   `updateActor`/status hooks.

**Non-stacking + refcount** falls out of step 3: the status is present **iff**
(`independent` ∨ `wantedBy` ≠ ∅); the reactor owns at most one derived instance;
independent applications are never clobbered; when the last rule's condition
drops, the derived instance (and only it) leaves — with a **seamless handoff**
(if a spell's Swift expires while Flying persists, the next reconcile re-adds the
derived Swift).

## 5. Prong A — settle-loop reactor

Register beside crisis/defeat (`registerBuiltinReactor`, both boot paths). Called
per ledger event; reconcile the **subject** actor when the event could change a
condition input:

```js
export async function derivedStatusReactor(director, cfg) {
  if (!director?.ctx) return;
  const actor = cfg.casterActor; if (!actor) return;
  // Reconcile on resource + status ledger events (cheap; evaluate is idempotent).
  const t = String(cfg?.trigger ?? "");
  if (!/resource|status/.test(t)) return;
  await evaluateDerivedStatuses(director, actor);
}
```

Plus `sweepDerivedStatuses(director)` at `conflict_start` (combatants) alongside
`sweepCrisis`.

## 6. Prong B — `updateActor` / `updateItem` safety net

A standing hook (installed at `ready`, **not** gated on BD), mirroring
`auto-defeat.js`'s pattern, so manual edits + out-of-combat + non-combatants
reconcile:

```js
Hooks.on("updateActor", (actor, diff) => {
  if (touchesHpOrStatusOrProps(diff)) queueReconcile(actor);   // debounced microtask
});
Hooks.on("updateItem",  (item, diff) => {                       // equip toggles, added/removed carriers
  if (item.parent?.documentName === "Actor" && touchesEquipOrEffects(diff)) queueReconcile(item.parent);
});
Hooks.on("createActiveEffect", onAeChange);   // a status landed/left → re-check dependents
Hooks.on("deleteActiveEffect", onAeChange);
```

- **GM-authority + debounce**: only the GM writes (avoid N clients double-
  applying); coalesce rapid diffs into one reconcile per actor per tick.
- **Loop guard**: the reconcile's own AE writes re-fire `updateActor`/AE hooks →
  skip when the diff is reactor-owned (`flags[NS].derivedStatus` present) or when
  `evaluate` reports `changed:false`. `evaluate` being idempotent makes a second
  pass a guaranteed no-op.
- **In-combat de-dupe**: when a BD instance is running, the same event also hits
  Prong A. Both call the same idempotent `evaluate`, so at worst one redundant
  no-op — acceptable; optionally short-circuit Prong B while `director.ctx` is
  mid-settle to avoid interleaving writes.

## 7. Crisis migration

Crisis becomes the **first rule**, which simultaneously fixes its manual-edit /
out-of-combat gap:

```jsonc
{ "when": "CUR_HP <= CRISIS_THRESHOLD", "grant": "Crisis", "ruleKey": "core-crisis" }
```

- Keep the threshold logic (`crisis_hp` else `ceil(max_hp/2)`) — expose it as a
  `CRISIS_THRESHOLD` formula identifier (thin wrapper over the existing helper),
  or special-case `core-crisis` in the reactor to call `crisisThreshold(actor)`.
- The `core-crisis` rule is engine-seeded (not authored on an AE) so it always
  applies to every actor — the reactor holds a small built-in rule list in
  addition to AE-scanned rules.
- **Phased rollout** (Crisis is load-bearing — defeat, `ae("Crisis")` gates,
  Matador Cape DEF, On-the-Hunt):
  1. Ship `derivedStatusReactor` **alongside** `crisis-reactor`, handling only
     AE-authored rules (Jetpack). Crisis stays on the old reactor. Zero risk to
     Crisis.
  2. Add the `core-crisis` built-in rule to the new reactor; run BOTH in
     shadow and assert parity (same apply/remove decisions) via the harness +
     a live pass. Both are idempotent so double-run is safe.
  3. Retire `crisisReactor` registration; keep `crisisThreshold` + the canonical
     template. The new reactor's Prong B now gives Crisis the `updateActor`
     safety net it never had.

## 8. Edge cases & guards

- **Same status, two rules** → one derived instance, `byRules` is the union;
  removed only when the union empties.
- **Duplicate-collapse** (like crisis §92): if >1 reactor-owned S exists, delete
  the extras silently.
- **Independent then rule** / **rule then independent** — §4 step 3 handles both
  (never double, never clobber).
- **Carrier removed mid-combat** (unequip / drop) → carrier AE inactive → rule
  gone → derived S removed next reconcile (settle event from the item change, or
  Prong B `updateItem`).
- **Formula errors** → treat as `false` (fail-safe: don't apply); warn once per
  ruleKey.
- **Non-terminating cascade** — `settleInstance` already caps `maxIters`;
  idempotent evaluate guarantees convergence.

## 9. Testing

- **Unit (harness / evalGM)**: `evaluateDerivedStatuses` truth table — apply,
  no-op, remove, independent-present-skip, handoff, two-rule union. Idempotency
  (run twice → `changed:false` second time).
- **Prong B**: manual `actor.update({current_hp})` out of combat → Crisis
  reconciles (the bug repro, now fixed). Manual add/remove of Flying via sheet →
  Swift follows.
- **Parity (migration §7.2)**: shadow-run new-vs-old Crisis over a scripted HP
  sweep; assert identical decisions.
- **Non-stacking**: Flying + spell-Swift → single Swift, DEX +1 stage only;
  expire spell-Swift while Flying → derived Swift takes over, still one stage.

## 10. Deliverables

- `battle-director/derived-status-reactor.js` — `evaluateDerivedStatuses`,
  `derivedStatusReactor`, `sweepDerivedStatuses`, Prong-B hook installer.
- Boot wiring in `director-boot.js` (register + sweep) and a `ready` hook for
  Prong B.
- `CRISIS_THRESHOLD` identifier (or reuse) in `skill-formulas.js`.
- Author Jetpack's `Flying → Swift` rule (replaces the stat-hack AE) as the first
  consumer; then migrate Crisis per §7.
