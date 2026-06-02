# Reaction architecture — three locked contracts

Three rules the reaction system MUST honor. Forward-compatible with the shipped pill (pre-resolve, on the action card) and menu (post-resolve / standalone, on the token) UIs.

---

## Rule 1 — Visibility ladder (4 stages)

The privacy boundary is only at stage 2; stages 1, 3, 4 are either GM-private (engine internals) or party-broadcast (table-visible outcomes).

| Stage | GM | Reactor's owner | Other party clients |
|---|---|---|---|
| 1. Candidates enumerated | Sees all | (not rendered yet) | (not rendered yet) |
| 2. **Decision pending** | All candidates actionable | **Own** candidates actionable | Opaque `[Owner] reacting…` indicator |
| 3. Decision made (Apply / Pass) | Applied chip | Applied chip | Applied chip — same content |
| 4. Effect resolves (doc writes) | Already broadcast via Foundry doc updates | Same | Same |

**Engine implications:**
- Every candidate carries `reactorActorUuid` + `reactorTokenUuid` so per-client filtering is `cand.reactorActorUuid in myOwnedActors || iAmGM`.
- The opaque stage-2 indicator (dimmed dashed pill labeled `[Owner] reacting…`) reveals only that someone is reacting, never the skill.
- Stage 3 is broadcast as `OniReactionResolved { reactorActorUuid, carrierUuid, skillName, decision, appliedEffects? }`. All clients update their stage-2 indicator to a stage-3 chip uniformly.

---

## Rule 2 — Ordering: first-to-click wins, FIFO with re-gate

FU has no canonical resolution order between simultaneous reactions. The engine adopts: **first owner to click processes first**.

**Engine contract:**
- Reaction decisions process in **arrival order**. The socket layer naturally serialises `REACTION_CHOICE` intents in the order they hit the GM client. No "wait for all reactors" barrier.
- After each applied decision, all remaining pending pills/blades **re-gate** against fresh state. A `condition_formula` that was true at offer time may now be false — that pill collapses to "no longer applicable" instead of firing on stale state.
- Each pill's formula re-evaluates against current parent state on every render. The `recomputeTargetPreviews()` Cheap Shot uses is the template; generalize it. Triggers for recompute:
  - Another pill on the same card was applied (state changed)
  - A child card resolved and popped back to parent
  - Pill first rendered

**Rules out:**
- No "global lock until all reactors decided." Each decision lands immediately + cascades.
- No fixed precedence (alphabetical, initiative, etc.). User explicitly rejected this.

Within a single reactor's matches at one trigger, passive rows resolve before manual rows (see `reaction-manager.js`). Across reactors, click order wins.

---

## Rule 3 — Stacking: child cards on top of suspended parents

A reaction may spawn a new action card (Counterattack, Retaliation, hypothetical Cross-Counter). The child **stacks visually on top** of the parent — it does not replace.

**Lifecycle:**
```
postActionCard(parent)            parent: ACTIVE
  ─ pill clicked, reaction spawns child action
  └ push child onto director.ctx.actionStack
    ─ parent → SUSPENDED  (is-suspended class: dim, pointer-events:none on pill row + Confirm)
    ─ postActionCard(child) — NEW Promise, re-entrant
      ─ child has own pill row, own reaction window, can stack further
    └ child resolves (Confirm/Cancel)
      ─ pop actionStack; child DOM tears down
      ─ parent → ACTIVE; recomputeTargetPreviews(); pill rows re-gate
parent Promise resolves
```

**Engine contract:**
- `director.ctx.actionResult` is **deprecated** as a single value. Use `director.ctx.actionStack: ActionResult[]`; `actionStack.at(-1)` is the active card.
- `postActionCard` is **re-entrant**. The Promise naturally stacks.
- Stacking depth is open-ended — don't assume depth ≤ 2.

**Visual contract:**
- Parent stays mounted at its original DOM position. `is-suspended` class adds backdrop dim + disables pointer events on pill row + Confirm.
- Child renders at higher z-index. Functionally identical to a top-level card.
- Both parent and child obey Rule 1 independently — a non-owner who can't interact with the parent's pending pill still sees the child pop on top.

---

## Authoring a new reaction skill — checklist

1. **Trigger phase?** Reads from `TRIGGER_PHASE` in `director-triggers.js`. Determines pill (pre-resolve) vs menu (post-resolve / standalone).
2. **Spawns a new action?** If yes, author it as a normal action skill the reaction effect chains into. Use `effect_kind: open_action_menu` for option pickers; direct `apply_ae` / `grant` / `add_damage` for value-modify only.
3. **State-dependent activation?** Use `condition_formula` so the engine re-gates after each applied reaction.
4. **Visibility?** Follows Rule 1 automatically — no per-skill work. `name`, `img`, `description` all surface post-decision.

---

## Force-mode exemption

Rows with `reaction_passive_mode: "force"` are exempt from stages 2/3 — auto-fire, no chip, no menu, no visible decision. Reserve for engine housekeeping (charge refills, accumulator increments). See [force-mode.md](force-mode.md).
