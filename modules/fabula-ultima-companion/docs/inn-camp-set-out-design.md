# Inn Camp, Short Rest & Set Out — design

**Status:** built on `feat/inn-camp-set-out` (2026-10-24). Live-tested on ONE GM
client — see §6. Not yet tested with a player client or two GMs.
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
| Midgard | `Midgard_Map005` / Freydis | **new** `Midgard_Map008` | not needed: the inn map already includes the walkable bedroom |
| Eisendrache | `Eisendrache_Map007` / Thomas | **new** `Eisendrache_Map019`, placeholder `Ruhig_Map006.png` | **new** `Eisendrache_Map020`; door at the top of the stair lane |

(Ruhig walk-in = `Ruhig_Village012`, Temple walk-in = `AncientTemple_Map011`.)

Twins carry `flags.<module>.campTwinOf` = the other scene's id, and are hidden
from navigation. Camp twins carry `flags.<module>.campArrival {x, y}`.

**Midgard's room is the full inn image with the lobby half masked** by a locked
black Drawing. Foundry V12 always fits a scene background to the scene rect:
`background.offsetX` moves the *scene rect* over the image (canvas coords then
start at the offset) and `scaleX` is ignored, so a background cannot be
cropped in place. A cropped image upload would replace the mask.

## 6. Live test (2026-10-24, one GM client, state restored afterwards)

- Freydis (unhidden for the test — the Midgard NPCs are hidden staging) shows
  the 🛏 button only within the shared Talk/Shop feet range.
- Short Rest: black curtain + jingle, 20z × 4 charged, debuff cured, food buff
  and the Swift Swimmers set-bonus Wet kept, HP restored.
- Rest: 80z, teleported into `Midgard_Map008` at the arch, area banner shown,
  loop at Free Roam, return point = Freydis' spot. Set Out → back on that spot,
  camp reset, return point cleared.
- Dungeon camp tile hook (Wyrmwood_Map003 → its camp) → Set Out reactivated the
  dungeon; the waiting party token was untouched.
- No return point → picker listed the camp's Scene Network + Stay.

Not covered: a save → title → load round trip (the landing-phase check covers
the rule offline), walking through the new doors as a player, two GMs.

## 5. Build order

1. Set Out + return point (tested through a dungeon camp tile — free and unchanged).
2. `RestAPI.shortRest()`; the black fade usable outside camp.
3. Inn NPC type, payment, choice panel, keyboard.
4. World data — twins, doors, `isInn`, lobby links — then world-export.

## 7. Roster-driven camp members (2026-10-24)

Camp rooms no longer carry pre-placed party member tokens. `camp-members.js`
spawns the ACTIVE party (database `member_id_1..4`, the roster the Rest uses)
and removes them again on Set Out, so a bench swap, a guest or another party's
run shows the right faces at camp.

**Not a performance change.** Foundry 12 walks every token of an actor on every
update (`Actor#_updateDependentTokens`), but a LINKED token off the viewed scene
does nothing there; only UNLINKED tokens rebuild a synthetic actor each time.
The members were linked. The world's real duplicate cost is unlinked template
NPCs (Bandit (Overworld) 29, Generic NPC 28, Villager 13, Eisendrachian
Knight 11), and only when those base actors are edited.

- **Spots:** `flags.<module>.campMemberSpots` — token centre, the authored
  token's look (texture incl. scale/mirror, sort, flags), its `scaleRatio`
  against that actor's prototype, and `mirror`. The authored member gets the
  look verbatim; another member in that slot gets their own art at the room's
  scale and facing; extras line up beside the arrival point.
- **When:** `ensure()` on camp entry (before the scene draws — no pop-in) and
  whenever the ACTIVE camp scene is drawn (F5, a loaded save, a camp the GM
  activates by hand). Merely *viewing* a camp room does not spawn. `clear()`
  after Set Out. Primary GM, idempotent, serialised per scene.
- **Ownership:** only tokens flagged `campMember` are ever removed; a member
  token placed by hand is left alone (and counts as present).
- **Bars:** spawned tokens clear Bar Brawl bars AND core bar1/bar2/displayBars —
  Bar Brawl falls back to core bars, which the camp UI hider does not reach.
- **Authoring:** place member tokens in a room, then
  `CampSystem.Members.captureSpots(scene)` turns them into spots.
- Migrated: 9 rooms × 4 spots. `Valley_Map004` has none (members line up by its
  arrival point); `Wyrmwood_Map012`'s four spots nearly overlap, as authored.
