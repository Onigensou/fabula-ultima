# Battle Director — Developer Guide

A concise onboarding map for working on the new Battle Director (BD) system.
Read this first; the per-topic docs below carry the depth.

---

## 1. Where things live

| Edit this | For |
|---|---|
| `worlds/fabula-ultima-2/` | Runtime data (items, actors, AEs). Templates here drive gameplay. |
| `modules/fabula-ultima-companion/scripts/battle-director/` | BD code. |
| `modules/fabula-ultima-companion/data-migrations/` | One-shot shape changes, register in `_manifest.json`. |
| `modules/fabula-ultima-companion/docs/` | Canon + reference docs. |
| `modules/fabula-ultima-companion/Game Object/Template/` | Module-shipped placeholders for **new** worlds — does NOT affect the running world. |

**Edit the master, sync the copies.** Skills live on actors as embedded copies linked to a world-Item master via `system.template`. CSB syncs *some* props automatically (`isCheck`) but not others (`rolled_atr1/2`). After editing a master, run an explicit sync sweep over actor copies. See [skill-authoring-canon.md](skill-authoring-canon.md).

**Never commit `worlds/<world>/data/**` LDB shards.** They're per-machine runtime state. Module code + docs only.

---

## 2. The state machine (10s overview)

```
PREP ─→ ROUND_START ─→ TURN_START ─→ DECLARE ─→ TARGET ─→ COMPUTE
                                                              │
                                                              ▼
                                                          CONFIRM ─→ RESOLVE
                                                                       │
                                                              CLEANUP ◄┘
                                                                 │
                                                              TURN_END ─→ TURN_START …
```

**Reaction windows (interrupts):**
- **SRW** (Standalone Reaction Window) — pre-resolve reactions fire here; can spawn free actions.
- **FAW** (Free Action Window) — drains the free-action queue; pops back to whoever opened it.

`dCombat.round` starts at **0** and bumps to 1 at ROUND_START. Conflict-start hooks read `round === 0`.

**Continuation stack.** Detours (SRW, FAW, skill-spawned free actions) push frames onto a stack (`ctx.runtimeContinuation`). `INTERNAL_DONE` pops to `top.resumeAt`. See [continuation-stack.js](../scripts/battle-director/continuation-stack.js). Persistence schema v2 captures this; v1 saves auto-migrate on load.

---

## 3. Skill authoring

**Canon: [skill-authoring-canon.md](skill-authoring-canon.md) — read it before authoring any skill or AE.**

The short version:

- **All conditional / triggered / passive behavior** lives in `system.props.reaction_config_table` rows + `effect_table` rows.
- **NEVER** add per-skill custom JS for system gaps. If the engine can't express what you need, propose an engine extension and surface the gap.
- **Author via macro spec**, not the CSB UI: write JSON, run `CreateSkillFromSpec`. See [skill-authoring-canon.md](skill-authoring-canon.md) § Authoring.
- **AE naming** = skill name verbatim ("Aura", not "Aura'd"). Multi-option uses `Skill (Option)` ("Reinforce (Dazed)").
- **AEs need a non-empty `statuses[]`** to render their token icon ring. Use `fud-<slug>` ids.
- **AEs fired via `apply_ae`** must set `transfer:false` so they don't auto-apply to the bearer on item-add.
- **Buffs/debuffs self-tag** via `system.tags: ["buff"]` / `["debuff"]`. Untagged = "Other"; doesn't count toward `TARGET_STATUS_COUNT`.

Reference:
- [reaction-config-schema.md](reaction-config-schema.md) — 29 triggers, all effect_kinds, all formula identifiers.
- [action-payload-shape.md](action-payload-shape.md) — every field a card carries; writer/reader sites.
- [battle-director-skill-roadmap.md](battle-director-skill-roadmap.md) — 31-class phase map.

---

## 4. Testing without Foundry UI

**Director test harness.** The standard tool for verifying any creature action. Available on `FUCompanion.api.test`:

```js
const fx = FUCompanion.api.test.getDirectorTestFixtures();
// fx.casterToken, fx.targetAllyToken, fx.targetEnemyToken, fx.items["Skill Name"]

await FUCompanion.api.test.runDirectorSkillSimulate({
  skillUuid: fx.items["Soul Steal"].uuid,
  casterTokenUuid: fx.casterToken.uuid,
  targetTokenUuids: [fx.targetEnemyToken.uuid],
  force: { hit: true, rA: 6, rB: 4 },       // semantic outcomes + die overrides
  picks: ["Dazed"],                          // auto-pick open_action_menu
  preApply: [{ targetActorUuid, data: aeData }],
});
// → captures.perActorWrites, perTargetResults — nothing commits
```

`runDirectorSkillCompute(...)` runs only the COMPUTE phase (no RESOLVE side effects).
`runDirectorSkillSimulate(...)` runs COMPUTE + RESOLVE with `Actor.prototype.update` / `Item.prototype.update` / AE prototypes monkey-patched to capture every write — **nothing actually commits**.

Use these BEFORE asking the user to playtest. The harness models almost everything.

**Cache-bust caveat:** the harness cache-busts the entry module per call, so single-file edits inside the harness take effect immediately. Cross-module edits (`state-handlers.js` → `skill-effects.js` via static imports) require **Ctrl+Shift+R** — Foundry's bridge reload does NOT bust the ESM cache.

---

## 5. Test-bridge — driving the running world

`worlds/<world>/test-bridge/` is a file-based IPC channel for autonomous iteration. When the game is **open**, use this instead of asking the user to paste in F12.

**The #1 bridge bug is wrong request shape.** Copy this verbatim:

```jsonc
// inbox/req-my-probe.json
{
  "id": "my-probe",            // required
  "kind": "evalGM",            // field is "kind", NOT "op" / "type"
  "auth": "<bridge-secret>",   // from bridge-secret.txt; required for evalGM
  "args": {
    "code": "return game.items.size;"   // code in args.code, NOT at root
  }
}
```

Wrong shape = silent reject (request file consumed, no res file written, no error). Bridge keeps polling fine — it just declines malformed requests.

Other useful kinds: `ping`, `query`, `updateDocument`, `runMacro`, `reload`, `screenshot`, `dryRun`.

**Activation.** Bridge is dormant by default. To wake:
- Cold start: ask user to paste `FUCompanion.api.testBridge.start()` in F12.
- After reload: bridge auto-re-arms via `bridge-activate.txt` sentinel.
- Dead mid-session: paste `start()`. If `forceHeartbeat()` 401s, Foundry login expired.

Always **clean up both req+res files** after consuming. Outbox-existence is the cross-reload dedup; stale files would re-fire.

**When the game is closed**, use `tools/safe-edit/` instead — direct LevelDB writes with backup + rollback. Bridge and safe-edit are mutually exclusive.

---

## 6. Migrations

`modules/fabula-ultima-companion/data-migrations/<key>.js`:

```js
export const key = "2026-MM-DD-short-slug";
export const description = "what this changes";

export async function migrate(game, log) {
  // do work via doc.update(); MUST be idempotent.
  // Self-check before writing. If already done, return applied:true anyway
  // so the ledger records it.
  return { applied: true, summary: "..." };
}
```

Register the entry in [`data-migrations/_manifest.json`](../data-migrations/_manifest.json). Runs on `ready`, GM-only, idempotent across re-runs. Failures don't go in the ledger so they retry next boot.

---

## 7. Common gotchas

- **CSB column gating.** Writes to `system.props.X` are silently stripped if `X` isn't a template column. Add the column to the actor/item template first.
- **No dotted-array updates.** `contents.4` replaces the whole array with `{4: value}`. Always pass full arrays.
- **AE `changes[].key`** is the bare prop name (`bonus_hp`), NOT `system.props.bonus_hp`. CSB auto-prefixes.
- **AE reading parent actor props**: use `${fetchFromParent('prop_name')}$` inside changes values. `target.X`, `ref()`, bare names — unreliable.
- **F5 doesn't re-parse module.json.** Adding new `scripts:` / `esmodules:` entries requires Setup-relaunch. Modifying existing entries is fine.
- **Foundry returns copies.** Most reads (`meta.attackerUuid` etc.) return data, not docs. `attackerUuid` is a **Token** UUID, not Actor — unwrap explicitly.
- **`new Date()` is fine, but `Date.now()` in cron/workflow contexts may not be.** Stable IDs in commits/saves should come from explicit data, not the clock.

---

## 8. Don'ts

- **Don't `ChatMessage.create` for action feedback in BD.** The director's action card is a DOM overlay, NOT chat. Use `ui.notifications`, in-card UI, journals, or token VFX.
- **Don't import legacy `scripts/reaction-system/`.** It's reference-only; the BD is a parallel director-native rebuild.
- **Don't edit module-shipped `Game Object/Template/` files to change in-game behavior.** Those are placeholders for new worlds; the running world reads from `worlds/`.
- **Don't author per-skill custom JS for missing engine features.** Surface the gap, propose an engine extension.
- **Don't drop backticks inside template-literal comments** (CSS-in-JS, etc.). Breaks module load → silent "API not loaded" survival.

---

## 9. Where to look first

| Question | File |
|---|---|
| "How does a skill turn into damage on a target?" | [state-handlers.js](../scripts/battle-director/state-handlers.js) `RESOLVE.onEnter` |
| "How do I add a new effect_kind?" | [skill-effects.js](../scripts/battle-director/skill-effects.js) — see `applyRollLootTableEffect` as a recent example |
| "How do reactions fire?" | [reaction-config-schema.md](reaction-config-schema.md) + [standalone-reactions.js](../scripts/battle-director/standalone-reactions.js) + [reaction-manager.js](../scripts/battle-director/reaction-manager.js) |
| "How do I add a new formula identifier?" | [skill-formulas.js](../scripts/battle-director/skill-formulas.js) — `buildSkillResolver` |
| "How is the FSM saved across F5?" | [persistence.js](../scripts/battle-director/persistence.js) + [continuation-stack.js](../scripts/battle-director/continuation-stack.js) |
| "Where does the action card render?" | [action-card.js](../scripts/battle-director/action-card.js) — DOM overlay, not chat |
| "How do I add a new test scenario?" | `scripts/battle-director/_test-harness-director.js` |

---

## 10. Reference quick-links

- **Canon (read first):** [skill-authoring-canon.md](skill-authoring-canon.md)
- **Design rationale:** [battle-director-design.md](battle-director-design.md)
- **Reaction schema:** [reaction-config-schema.md](reaction-config-schema.md)
- **Payload shape:** [action-payload-shape.md](action-payload-shape.md)
- **Skill roadmap:** [battle-director-skill-roadmap.md](battle-director-skill-roadmap.md)
- **Project root rules:** [/CLAUDE.md](../../../CLAUDE.md)
