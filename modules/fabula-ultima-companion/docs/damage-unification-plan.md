# Damage System Unification — migrate all damage onto Gen 3

**Status:** foundation built + parity-verified; Phase 3 (the rewire) NOT yet done.
**Branch:** create off `main` (do NOT reuse `feat/bd-transaction-crisis-cascade`
unless continuing that PR). **Never stage `worlds/`.**

---

## 0. Goal & end state

ONE BD-supervised damage applier. Retire the older, unclean paths.

- **Gen 3 = the keeper:** `applyDamageToTarget` (commit) + `damage-ruleset.js`
  (compute). FSM-supervised, BD-owned display (VFX + director log), no legacy macros.
- Retire **Gen 2** (`apply-damage-core.applyToActor`) once its callers move.
- **Gen 1** (`AdvanceDamage` macro / chat-Confirm pipeline) = explicitly OUT OF
  SCOPE for now (huge, wired into many macros) — Phase 6, separate effort.

### User-locked scope decisions
- Bring **damage math + affinity** into Gen 3 → via `damage-ruleset.js` (incoming layer). ✅
- **Explicit heal: NO.** Only AB-affinity absorb→heal (already in Gen 3). Dedicated
  healing stays on the `grant`/`set_resource` → `writeResourceDelta` path.
- **Extra reactions: SKIP** (add as needed later).
- **Display / feedback: DEFER.** Migrated effect-damage loses the legacy chat
  Damage Card and surfaces via Gen 3's VFX + director log. User will re-add feedback
  later once the plumbing works.
- **Rich return: SKIP** (no current use case).
- **Self-contained port (no runtime dependency on Gen 2): YES** — the goal is to
  delete Gen 2, so Gen 3 cannot depend on it.

---

## 1. The three generations (why this exists)

| Gen | Function | Role | Callers | Born |
|---|---|---|---|---|
| 1 | `AdvanceDamage.js` macro (+ Create Damage Card / BattleLog macros, `action-execution-core`) | compute+commit+display | legacy Action Pipeline, chat-Confirm (`applyDamage-button.js`) | pre-2026-05 |
| 2 | `apply-damage-core.applyToActor` | compute+commit+**legacy display** | `deal_damage`/Burn, hazard tiles, legacy `reaction-grant` | 2026-05-15 (`49fe1162`, "Strangler Fig") |
| 3 | `applyDamageToTarget` (skill-effects.js:314) | **commit only** (takes pre-computed `{damage, affinity}`) | BD attack RESOLVE (state-handlers.js:380) | ~2026-05-27 (Battle Director) |

The Strangler-Fig (Gen 2) was never finished; the BD forked Gen 3 for attacks; effects
got stranded on Gen 2. Compute is ALSO duplicated: `action-profile` (attacks) vs
`apply-damage-core` (Gen 2). BD affinity canon lives in `snapshot.js`.

---

## 2. Architecture (the pattern to follow)

**COMPUTE → COMMIT split.** `applyDamageToTarget` is the single COMMIT; it takes a
post-affinity `{ damage, affinity }`. Whoever calls it computes first:
- **Attacks:** `action-profile.computeActionProfile` → `applyDamageToTarget`.
- **Effects (deal_damage / tiles):** `damage-ruleset.computeIncomingDamage` → `applyDamageToTarget`.

**INCOMING vs OUTGOING.** `damage-ruleset.js` owns ONLY the target-side INCOMING layer
(DR, element + class affinity, `damage_taken_mult`). The attacker-side OUTGOING layer
(sheet damage bonuses, weapon efficiency, crit) is attack-specific and stays upstream;
effect-damage bakes its base in the `damage_amount` formula. For `deal_damage`,
`apply-damage-core` only ever applied the incoming set anyway (it was passed
`attackerProps=null`, no weaponType → efficiency no-op, no crit), so this is exact parity.

---

## 3. DONE so far (foundation — verified)

### `scripts/battle-director/damage-ruleset.js` (NEW, committed-or-uncommitted: present on disk)
`export function computeIncomingDamage(actor, { base, element, range, ignoreDR, ignoreAffinity, damageClass })`
→ `{ damage, affinity, direction, breakdown }`. Order mirrors apply-damage-core:
1. DR: `resolveIncomingReduction` (from `skill-formulas.js`)
2. element affinity + forced-VU: `resolveAffinity` + `applyAffinityToDamage` (from `snapshot.js`)
3. class affinity (ported 9c — reads `flags.fabula-ultima-companion.affinity_class_{strike,magic}`; inert for element-only effect damage)
4. `damage_taken_mult` (ported 9d — `flags.fabula-ultima-companion.damage_taken_mult`; reductions only)
Either affinity layer hitting `AB` → `direction:"recover"` and `affinity:"AB"` (commit heals).

### Parity harness `tools/test-bridge-client/_probe-parity.js` — ✅ 60/60 GREEN
Compares OLD (`apply-damage-core.applyToActor`) vs NEW (`computeIncomingDamage` →
`applyDamageToTarget`) committed HP delta over affinity{NE,RS,VU,IM,AB} × DR{none,flat,%}
× mult{1,2} × base{10,37}. Cache-busts the new module (no refresh needed). Re-run after
ANY ruleset change:
`node tools/test-bridge-client/bridge-eval.mjs tools/test-bridge-client/_probe-parity.js`

Both paths read the SAME affinity keys (`affinity_1..9`, fire=`affinity_6`) → parity valid.

---

## 4. PHASE 3 — rewire `deal_damage` → ruleset → Gen 3 (THE NEXT STEP)

**File:** `scripts/battle-director/skill-effects.js`, function `applyDealDamageEffect`
(currently ~line 2303–2398).

**Add import** (top of file, with the other battle-director imports):
```js
import { computeIncomingDamage } from "./damage-ruleset.js";
```
(If a circular-import error appears at load — `skill-formulas`/`snapshot` importing
`skill-effects` — switch to a dynamic `await import("./damage-ruleset.js")` inside the
handler instead. `applyDamageToTarget` is defined in THIS file, so no import needed.)

**Replace** the `const api = globalThis.FUCompanion?.api?.applyDamage; if (!api?.applyToActor){…}`
guard (lines ~2326–2330) — delete it (Gen 3 is local, always available).

**Replace** the per-target `try { const res = await api.applyToActor({…}); … }` block
(lines ~2348–2394) with:
```js
    try {
      // BD-native incoming ruleset → BD-supervised commit (Gen 3). Replaces the
      // Gen-2 apply-damage-core path (which dragged in the legacy chat-card display).
      const ruled = computeIncomingDamage(actor, { base: amount, element, ignoreAffinity });
      const hpBefore = Number(actor.system?.props?.current_hp ?? 0);
      const res = await applyDamageToTarget({
        target: actor,
        damage: ruled.damage,
        affinity: ruled.affinity,
        resource: "hp",
        targetName: actor.name,
        tokenUuid: token.document?.uuid ?? null,
        logPrefix: `${attackerName}:`,
      });
      applied.push({ actorUuid: actor.uuid, amount, element, final: res?.finalValue ?? null, direction: res?.valueDirection });

      // Resource-ledger (cause taxonomy) from the ACTUAL hp change — Gen 3 absorbs
      // shield before HP, so the committed HP delta can be < `damage`. Re-read the
      // (now-mutated) in-memory actor.
      const _director = ctx?.director
        ?? globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.();
      if (_director) {
        const hpAfter = Number(actor.system?.props?.current_hp ?? hpBefore);
        const delta = hpAfter - hpBefore;
        if (delta !== 0) {
          fireResourceChangeTrigger({
            director: _director, actor, tokenUuid: token.document?.uuid ?? null,
            resource: "hp",
            direction: delta < 0 ? "loss" : "recover",
            amount: Math.abs(delta),
            cause: damageCause,                                  // hazard (default) | damage
            element,
            originLabel: row.attacker_name || ctx.sourceLabel || ctx.skill?.name || attackerName,
            originUuid: ctx.sourceUuid ?? ctx.skill?.uuid ?? null,
          });
        }
      }
    } catch (e) {
      warn(`skill-effects.deal_damage: applyDamageToTarget failed on ${actor.name}`, e);
    }
```

**Behavior deltas (expected, accepted):**
- Burn/effect-damage no longer emits a legacy chat Damage Card; it now fires Gen 3's
  VFX + director log (display deferred per user).
- Effect-damage now passes through Gen 3's **Mercy reaction-AE clamp**
  (`resolveDamageReactions`) — NEW for deal_damage. Desired (consistency); note it.
- Ledger fires from the real HP delta (shield-safe), not nominal `damage`.

**Known limitation to note in code/commit:** `deal_damage` was hp-only via the Gen-2
default; this rewire keeps `resource:"hp"`. If a row ever targets mp/shield, extend then.
`verbosity` (silent/numbers/fx/full) is dropped — Gen 3 has no verbosity knob yet (see
Phase 4 for tiles that need silent).

**Verify Phase 3** (cross-module edit → user must Ctrl+Shift+R first):
1. Re-run parity harness — still 60/60.
2. `node tools/test-bridge-client/bridge-eval.mjs tools/test-bridge-client/monster-accept.js '{"monster":"Hellhound"}'`
   — Flame Breath (deal_damage) + Pounce (deal_damage) + Bite still resolve clean.
3. Burn→Crisis→On-the-Hunt cascade still fires (drop a combatant below crisis via a Burn
   tick; confirm Crisis AE + Hellhound free attack — see the cascade probe pattern in the
   `project_bd_hp_change_and_crisis_trigger` memory).
4. Confirm NO chat Damage Card appears for a Burn tick (legacy display gone).

---

## 5. PHASE 4 — hazard tiles + legacy reaction-grant

- **`scripts/dungeon-pathing-system/dp-tile-effect-engine.js:134`** — calls
  `applyToActor` for hp/mp, `verbosity:"silent"`. To migrate: route hp/mp DAMAGE through
  `computeIncomingDamage` → `applyDamageToTarget`. BLOCKER: Gen 3 always fires VFX (no
  silent). FIRST add an optional `silent`/`fx` flag to `applyDamageToTarget` that gates
  `fireResourceLossVfx`/`fireAbsorbVfx`. Tiles run OUTSIDE the FSM — fine, Gen 3 just
  commits; supervision N/A. Tile HEALING (regen tiles) must stay on the grant path
  (no explicit heal in Gen 3).
- **`scripts/reaction-system/reaction-grant.js:186`** — LEGACY reaction system (suppressed
  under BD), uses `applyToActor` with `isRecovery` for hp/mp/shield, purely for the
  floating-number visual. DEFER — it's legacy + heal + visual. Retire with the whole
  legacy reaction-system later, not piecemeal.

---

## 6. PHASE 5 — retire Gen 2 (`apply-damage-core`)

After Phases 3–4, the only remaining `applyToActor` callers are legacy (reaction-grant).
Options:
- Make `applyToActor` a thin shim → `computeIncomingDamage` + `applyDamageToTarget`
  (keeps legacy callers working, removes the duplicate compute), OR
- Delete `apply-damage-core.js` once no caller remains and drop the
  `Create Damage Card` / `BattleLog: Append` macro display from the damage path.
- ⚠️ The chat Damage Card is produced ONLY by Gen 2 (attacks never made one). Retiring
  Gen 2 removes ALL chat damage cards. User accepted (display deferred) — CONFIRM before
  deleting, and re-introduce a BD-supervised card later if wanted.
- Update the burn-status-tick + guard-affinity migration JSDoc references to apply-damage-core.

---

## 7. PHASE 6 — later, OUT OF CURRENT SCOPE

- Migrate Gen 1 (`AdvanceDamage` / chat-Confirm / `action-execution-core`) — wired into
  many macros + action cards; high risk; multi-session.
- Converge `action-profile` affinity onto the shared ruleset (de-dup the BD's two compute
  paths) so attacks and effects share ONE compute. Would also surface whether attacks are
  missing weapon efficiency / class affinity / `damage_taken_mult` (apply-damage-core has
  them; action-profile appears not to — verify and reconcile).

---

## 8. Invariants / gotchas (read before any edit)

- **Cross-module edits → user must Ctrl+Shift+R** before bridge verification (the bridge
  reload does NOT bust ESM cache for static imports).
- **Never stage `worlds/`** (170+ LevelDB files; clobbers co-dev worlds). Stage module
  files explicitly; never `git add -A`.
- **Parity must stay green** after any `damage-ruleset.js` change.
- Ledger fires from **actual HP delta** (shield-safe), preserving the cause taxonomy
  (`cause: damageCause`, default "hazard"; element; originLabel/Uuid).
- `applyDamageToTarget` signature is the stable seam — do NOT change it; feed it
  `{damage, affinity}`.
- `damage-ruleset` is INCOMING-only; outgoing math stays upstream.
- Reusable BD helpers: `skill-formulas.resolveIncomingReduction`, `skill-formulas.applyCritDamage`,
  `snapshot.resolveAffinity`, `snapshot.applyAffinityToDamage`, `snapshot.readAffinities`.

## 9. File index
- NEW: `scripts/battle-director/damage-ruleset.js` (done)
- EDIT (Phase 3): `scripts/battle-director/skill-effects.js` (`applyDealDamageEffect`)
- EDIT (Phase 4): `scripts/dungeon-pathing-system/dp-tile-effect-engine.js`; add `silent` to `applyDamageToTarget`
- DEFER/legacy: `scripts/reaction-system/reaction-grant.js`
- RETIRE (Phase 5): `scripts/apply-damage-core.js`
- TOOL: `tools/test-bridge-client/_probe-parity.js` (parity harness, keep)
