# Inn Camp, Short Rest & Set Out — design

**Status:** in progress on `feat/inn-camp-set-out`. Not live-tested.
Companion to `camp-rest-save-flow-design.md` — read that first; this picks up
where its `SET_OUT_LOBBY` left off.

---

## 1. Decisions (agreed 2026-10-24)

| Question | Decision |
|---|---|
| Midgard's beds are baked into the inn map | **Clone, don't toggle.** A separate camp-mode scene shows the bedroom half. The inn map itself stays exploration and stays walkable. |
| Walking into an inn room vs resting | **Both stay.** Walk-in reaches an *exploration* twin of the room; resting at the innkeeper reaches the *camp* twin and runs the full camp loop. |
| How camp mode is decided | Unchanged: a scene is camp iff its own `sceneMode` is `camp`. No runtime mode switching. |
| Inn price | `20z` per active party member, for Rest and Short Rest alike. Dungeon camp tiles stay free. |
| Who pays | Each member who holds ≥20z pays their own 20z. A member who can't is covered **whole** by the party coffer (the database actor's own `zenit`) — no split. If the coffer can't cover every short member, the rest is refused and nobody is charged. |
| Short Rest | Full HP + MP **and status ailments cured** (JRPG inn standard, and FU's own rest rule). Nothing else. |
| Set Out | Returns the party to the exact spot they entered camp from. |
| Session start | Not automatic. Set Out is often mid-session; "Start Session" stays manual. |
| Eisendrache inn room | No room art exists. Placeholder reuses Ruhig's inn-room art (`Ruhig_Map006.png`). |

### Why clone rather than toggle camp mode at runtime

A runtime toggle means ~24 files that read `sceneMode` directly must all go
through one resolver, forever — one future system that forgets walks the party
around during the bond screen, silently. Teleporter tiles, Monk's Active Tiles,
and the save system would each need to learn about the overlay too.

Cloning costs some duplicated authoring and nothing else: camp scenes keep the
exact, live-tested code path, and it is the rule dungeons already follow —
**camp is always its own scene**. The camp twin is kept deliberately bare
(background, walls, arrival point, member tokens); examine tiles and townsfolk
live on the walk-in twin, so most edits happen once.

## 2. Set Out — the return point

`campReturnPoint` (world setting, so `campState` saves it automatically):

```
{ sceneId, x, y, actorId, via, campSceneId, at }
```

`x, y` are the **centre** of the party token where it stood. It is recorded at
the real entry points only — a generic "a camp scene became active" hook would
also fire when a save is loaded.

| Entry | Recorded by | Set Out |
|---|---|---|
| Dungeon camp tile | `dungeonPathing.campStart` hook | Party token never left the dungeon scene → activate it. Token missing (e.g. a load on a changed world) → recreated at the recorded spot. |
| Innkeeper → Rest | the teleporter hook (Rest *is* a cross-scene teleport into the camp twin) | Party token teleported back to where it stood. |
| Any teleporter tile into a camp-mode scene | `teleporter.crossScene` hook | Same. |
| None of the above (old saves, GM-activated camp) | — | The GM picks from the camp scene's Scene Network, or "Stay at camp". |

Entering camp by any recorded route also **resets the camp loop to Free Roam**,
so a camp abandoned mid-cycle earlier cannot resume half-finished.

### Sequence

```
SET_OUT_LOBBY ──(GM Start)──► [no return point? GM picks one first]
                                  │
                                  ▼
                             SETTING_OUT     fade to black on every client
                                  │          primary GM moves / activates
                                  ▼
                     destination scene active → camp state reset (silent)
```

The reset runs **after** the scene switch, for the same reason as the title
branch (trap #3 in the rest-save design): writing the phase while camp is still
active fades the camp scene back in for a beat. If the move fails the phase goes
back to `SET_OUT_LOBBY` and the return point is kept, so the GM can retry.

`SETTING_OUT` lands as `SET_OUT_LOBBY` in a save (`CAMP.LANDING_PHASE`).

## 3. Inn NPC

- NPC template checkbox **`isInn`**, beside `isShop` / `isBlacksmith`.
- `scripts/inn-system/` — a clone of the refinement NPC's proximity button:
  🛏 **Rest** over the innkeeper, registered with `oni.Interact` so keyboard
  Confirm works. Hidden tokens get no button; only database-party members (and
  GMs) can use it.
- The room it opens is the **lobby scene's existing `campSceneUuid`**
  (Scene Config → Fabula → Linked Camp Scene UUID). No new field.
- Clicking opens a choice panel — **Rest** / **Short Rest** / **Cancel** — with
  the price and, when the coffer pays, the breakdown. Unaffordable → both
  options greyed with the reason.

### Rest vs Short Rest

| | Short Rest | Rest |
|---|---|---|
| HP / MP | full | full (halved by "Ouch!") |
| Status ailments (`isDebuffEffect`) | cured | cured |
| Other temporary effects | kept | cleared |
| Food buffs (`campRestCharges`) | not consumed | tick down |
| Camp activities, bonding, save prompt | — | yes |
| `party_rested`, reset-on-rest tiles, Virus spread | — | yes |

Rest = charge, then cross-scene teleport the party token into the camp twin. It
arrives at the twin's **Initial View** point (Scene Config → "Capture current
view"), or the scene centre when none is set.

## 4. World wiring

| Town | Lobby / innkeeper | Camp twin | Walk-in twin |
|---|---|---|---|
| Ruhig | `Ruhig_Village005` / Alcina | `Ruhig_Village006` (existing) | new clone of 006, exploration; the lobby's walk-in door repointed to it |
| Ancient Temple | `AncientTemple_Map002` / Innkeeper Shade | `AncientTemple_Map003` (existing) | new clone of 003; new door in the lobby |
| Midgard | `Midgard_Map005` / Freydis | **new** — bedroom half of `Valley_Map007.png` | not needed: the inn map already includes the walkable bedroom |
| Eisendrache | `Eisendrache_Map007` / Thomas | **new**, placeholder `Ruhig_Map006.png` | new clone; the door at the top of the stairs |

Twins carry `flags.<module>.campTwinOf` = the other scene's id, and are hidden
from navigation.

## 5. Build order

1. Set Out + return point (tested through a dungeon camp tile — free and unchanged).
2. `RestAPI.shortRest()`; the black fade usable outside camp.
3. Inn NPC type, payment, choice panel, keyboard.
4. World data — twins, doors, `isInn`, lobby links — then world-export.
