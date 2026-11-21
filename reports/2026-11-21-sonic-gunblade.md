# Sonic Blow rework + Gunblade (branch feat/sonic-gunblade, not pushed)

Approved mockup: `E:\Art(New Com)\DND\Fabula Ultima\Resource\Animation\Sonic Katar\sonic-katar-mockup.html` (v2).

## World data: one migration, no LevelDB
`data-migrations/2026-11-21-sonic-gunblade.js` (seed-only, flag `sonicGunblade`, new docs `SnGb…`):
- **Sonic Katar** (`3ZV5drjroWrvXqkw`): text only; its old "Sonic Blow (Attacks)" multiAttackGrant effect is deleted; the passive `rSdCKOYJzRyfFcVe` loses its 3 rows (text mirrors the parent).
- **Sonic Blow** (`f3QKcoZ4HwrR607a`): 30 MP, One creature, Melee, `chain 8 volley`, −2, carrier attack (`attack_with_carrier` + `flags.carrierAttack` = damage ×2 shared, crit ×1.5 no Opportunity, Perfect ×1.5). Old marker AE and free_action chain removed. Icon = the mockup's skill icon (already on Forge). The stray Rogue "Sonic Blow" `QjQmFdbuvlv6DBKJ` is untouched (nothing references it).
- **Imperial Gunblade → Gunblade** (`mODVDmjIfozcfERi`): Uncommon 1800z, Martial, forms Sword (DEX+MIG HR+8) / Firearm (DEX+INS HR+5 Ranged); icon `Item Icon/Weapon/Gunblade_Revolver.webp`. New children: **Gunblade (Passive)** (odd total or crit → +10 and Fire), **Gunblade: Transform** (turn_end ask → `transform_weapon`, gated `WEAPON_TRANSFORM_FREE`; play_animation rows on `creature_transforms_weapon`). The "Arm of the Law" set fields are kept (open question).
- Actor copies: none exist; the code updates any by name.

## Engine (shared files)
- New `carrier-attack.js`: a skill that IS an attack with its weapon (one Attack card; DECLARE rewrite, TARGET pseudo-weapon from the carrier snapshot, printed cost charged like an NPC attack item).
- `action-profile.js`: carrier damage ×M (Volley: ×M/N per shot, flats ×M shared); carrier crit multiplier per hit.
- `chain-strikes.js` / `chain-plan.js`: Perfect bonus strike when every strike landed.
- `snapshot.js`: carrier `noCritOpportunity`.
- `skill-effects.js`: `transform_weapon` effect kind; **fix** — the will_deal_damage subject re-scan now carries the roll (checkTotal / isCrit / hitMargin / hr). Before, every row gated on ATTACK_CHECK_RESULT / ATTACK_IS_CRIT / HIT_MARGIN matched at CONFIRM and then "0 hit targets" (affects any Snipe / Conquer-style rider).
- `skill-formulas.js`: `WEAPON_TRANSFORM_FREE`. `equipment-swap.js`: `weaponSlotOfItem`, `weaponFormCount`. `director-animation.js`: a carrier attack plays the skill's script.

## Tested (snapshot runner, headless, canvas off; checks/sonic-gunblade.js)
- Sonic Blow: ONE card, 30 MP (MP 65 → 35), Chain 8 volley; 8/8 → Perfect +29 gold strike; 5/8 with misses per hit + one crit (3★ vs 2), no Perfect; 8/8 all crits → crit ×1.5 per hit, Perfect +37, **no Opportunity** (plan wanted one, RESOLVE denied). Per hit at HR 10: floor(15 × 0.25) = 3 (a normal Katar hit = 15).
- Gunblade Sword: total 9 → 46 (23 = 5+8+10, ×2 target VU); total 10 even → 26 (13, no bonus); crit 7/7 → 50, crit 6/6 → 48. Firearm round 2: DEX/INS Ranged Firearm HR+5 → 14, no bonus.
- Transform after the action: turn_end ask fires, Sword → Firearm (round 1), Firearm → Sword (round 2), stamped once per round; second turn_end of the round reads WEAPON_TRANSFORM_FREE = 0.

## Not done / open
- **Fire element not proven**: Training Ground's Wellspring (bolt) retypes all damage to bolt in the runner, masking Fire. The +10 rides the same reaction chain.
- "Before the action" path: not re-run here (Lionheart's Equipment-chip code, unchanged); the shared once-per-round gate is the same flag.
- **Sonic Blow animation**: ported from the approved mockup (tools/anim-studio/lib/sonic-signatures.js + sonic-shots/sonic-blow.inner.js, constants copied from spec/sonic-blow-mockup-timeline.json), written into the migration via _sonic-gunblade-anims.js. GPU runner: plays with the real per-strike hit/miss/crit, no animation errors. Diff vs mockup: spec/sonic-blow-game-diff.json; side-by-sides spec/side-by-side/. Open: the Perfect gold hit lands ~0.5 s late (render stall after the filtered RO clip starts); strikes 3/5 drift ~25 ms; chroma split not ported; numbers/flinch/namecard are BD's own.
- Gunblade attack / transform animations: not ported (no existing game equivalent); default attack animation plays.
- Real-server first boot: deletes are guarded (skip missing ids, swallow "does not exist").

## DEFERRED to after the session
- The full timeline diff and side-by-sides. A first pass is committed in `spec/`. Still to do: fix the Perfect beat's ~0.5 s late gold hit, port the chroma split, and capture the target token, HUD and dim in the game shots on a 3D Valley map.
- Gunblade Sword / Firearm attack and transform animations: port the mockup moves gb_sword, gb_gun and gb_tf, then check them in game.
- Gunblade Fire proof on a map without the Bolt Wellspring, since Training Ground retypes all damage to bolt.
- The before-action transform through the real Equipment card on a player client. Then confirm the turn_end ask does not fire in that round.
- Edge playtests:
  - Sonic Blow with a flat damage bonus (Powerful Shot-style, shared ×2).
  - Sonic Blow vs a Resistant / Vulnerable target, and the Perfect bonus killing.
  - Sonic Blow on a player client, where the skill menu rewrites it into an Attack card.
  - Gunblade on an NPC.
  - The turn_end ask prompt on a real player client.

## Round 2 (11-22, after the session)

### 1. The Perfect beat's late gold hit: test-harness artifact, not a render stall
Four GPU runs since (frame gaps + long tasks recorded): no frame gap over 50 ms, no long task, and the gold hit within 0–15 ms of the spec. The +509 ms in the first run came from the check itself: the sim returned while the hop home was still playing, and the next scenario's setup (weapon swap, document writes) blocked the page. The check now waits 2.5 s after each sim.

### 2. Chroma split ported
The mockup's #lhCA SVG filter: red +5 px, blue −5 px, contrast/saturate punch 1.25, 240 ms ease-out, at Perfect +243.1. It goes on the board view and the timeline overlay, and is cleared afterwards.

### 3. Valley 3D side-by-sides (full-page frames) + timing diff
- Valley_Battlemap001 (3D "camera" stage), Keren vs Dire Orc as in the mockup.
- Full-page screenshots through a new runner hook `window.__runnerShot` (worktree `tools/snapshot-runner/bin/run.mjs`).
- Diff, timing-only run (no screenshots, they perturb timing): `spec/sonic-blow-game-diff.json`. Every beat, all 8 strikes, the Perfect hit, the chroma split and the hop end are within ±20 ms. Sound sequence + volumes and clip scales / rates / filters are identical.
- Side-by-sides (mockup stage left, game frame right): `spec/side-by-side/sb-8of8-{strike3,strike8,perfect,hophome}.jpg`, `sb-miss.jpg`; raw game frames in `spec/game-shots/`.
- Remaining differences, all owned by other systems:
  - the game frame is the GM's view (GM tool strip, AI panel instead of the player HUD);
  - BD's hurt tint on the target;
  - BD's own damage numbers (the Dire Orc reads WEAK! in the game);
  - the camera framing of the live 3D stage;
  - the namecard + MP beat is the action card;
  - the hop home uses the measured 545.7 ms (nominal 520).

### 4. Gunblade animations: dropped (another session's pilot); the default attack animation plays
Gunblade item ids and fields are unchanged in this round.

### 5. Fire conversion proved (Inner Wellspring removed: its ask retypes every hit to bolt on this snapshot)
| Roll | Result |
|---|---|
| 5/4 = 9 (odd) | 23 **fire** (5 + 8 + 10) |
| 5/5 = 10 (even) | 13 Physical |
| 6/6 crit | 24 **fire** (shown 48 VU) |

Note: the Gunblade's Fire and an Inner Wellspring retype are both element ops on the same hit; the last one folded wins (the wellspring, when its holder accepts it).

### 6. Before-action transform through the real Equipment card / turn-end ask on a player client
Not possible in the runner: it has one client, and broadcasts / player-routed prompts are dropped (runner README). It needs a real Foundry server (Staging World or Planning World) and the `tools/fvtt-playwright` multiclient rig with a player user. The GM-side ask (sim auto-accept) and the shared once-per-round gate are proven (round-1 notes).

### 7. Edge playtests (Blanche, Inner Wellspring removed, so the hits stay Physical; dice 10/9 ×8)
| Case | Hits | Perfect | Total |
|---|---|---|---|
| Baseline | 3 each (= floor(15 × 0.25)) | +12 | 36 |
| +10 melee flat bonus | 6,6,6,6,5,5,5,5 (20 = 2 × 10 shared) | +22 | 66 |
| vs Resistant (Physical) | 2 each | +8 | 24 |
| vs Vulnerable | 6 each | +24 | 72 |
| Perfect kills (target HP set to 30 at declaration) | 8 hits leave 6 HP | the gold hit drops it (30 → 0) | — |

- Player-client cast: not runnable here (see 6). The DECLARE rewrite runs on the GM for any bundle, player or AI.
- Gunblade on an NPC: NPCs attack with attack items, not equipped weapons, so it does not apply.

### 8. Review of 4ae73480 (will_deal_damage subject re-scan now carries the roll)
Rows on `creature_will_deal_damage` gated on the roll, world-wide:

| Item | Gate | Mode |
|---|---|---|
| Arcana Avant (Passive) | ATTACK_CHECK_RESULT ≥ 20 | force |
| Gae Bolg (Passive) | ATTACK_IS_CRIT | on; held by Blacksmith Shade |
| Lucky Mallet (Passive) | ATTACK_IS_CRIT | on |
| Minotaurus Axe (Passive) | HIT_MARGIN ≥ 5 | on |

(The old Sonic Katar row is removed by the migration.)

Runner, base `8a41eb0e` vs branch, same forced dice:
- **Damage was already right on main.** The ops fold at the card: Lucky Mallet crit 27, Minotaurus 50, Gae Bolg crit 54, before affinity, the same on both.
- **What changes is the RESOLVE fire.** Main logs `card reaction "…" not fired — 0 hit targets (no cost/effect)` for all four. The branch fires each (the passive card shows "on-hit bonus"), so any cost and non-damage step in those chains now runs.
  - None of the four has a cost.
  - Lucky Mallet's Crush and Arcana Avant's ignore_absorption are keyword ops folded at the card either way.
  - Visible effect for players: the passive cards now appear.
- **Data/text mismatch, not touched:** Gae Bolg's text says "200% damage", its row multiplies ×3.

## Round 3 (11-22): rebased check, real-server first boot, player client
On the rebased branch (`e4bce690` = origin/main `8fdffb7b` + this branch).

### 1. Runner check against the rebased code
Headless, canvas off, `--code e4bce690`; all scenarios as in round 2:
- Sonic Blow:
  - 8/8 → Perfect +29, total 87;
  - 5/8 with a crit (3★), no Perfect;
  - all crits → +37 Perfect;
  - no Opportunity in any run;
  - MP −30.
- Gunblade: odd 23 Fire, even 13, crit 24 Fire (with the Inner Wellspring removed). Firearm profile: DEX/INS, Ranged, HR+5. Transform after the action, once per round.
- Edge cases: Resistant 24, Vulnerable 72, Perfect kill 30 → 0.
- One flaky case: the +10 flat bonus did not apply in one combined run (36). It gave 66 when run alone in round 2.
  - The action card's COMPUTE still saw the bonus (the "Volley: bonuses shared" part is present).
  - The strikes did not: the test AE on the actor's prop seems to be lost before CONFIRM.
  - Looks like a harness artifact, but not confirmed.

### 2. Real V12 server first boot (sandbox, real world copy, branch code)
- Setup: own sandbox dataPath + headless Foundry server on :30152, per the sandbox-test notes.
  - Copy of the current real world `fabula-ultima-2` (data, packs, assets, cutscene-data, world.json; 57 MB).
  - `Data/modules/*` as junctions to the real modules, except `fabula-ultima-companion` → this worktree; `systems` junctioned.
  - The Staging World could not be used: its `Data` is a junction to the real `Data/`, so it serves whatever module code is checked out there.
- GM joined headless with the console attached before join (`tools/fvtt-playwright/scripts/sandbox-boot-log.mjs`, 12,013 lines kept).
- Boot console:
  - `1 migration(s) to run: [2026-11-21-sonic-gunblade]`
  - `- Sonic Katar: old 'Sonic Blow (Attacks)' effect` (MRNqlSDgr9sHwLUh deleted)
  - `- Sonic Blow: old marker effect` (R6nXJ0cWiEaXA3RX deleted)
  - `… complete — 1 ran, 0 failed, 178 total`
- 0 page errors, no error lines during the migration. Ledger on the second boot: 179 entries.

### 3. Player client (same sandbox; GM headless, the player Blumairwen = Keren on a visible GPU client)
Driven through the real UI: `scripts/sandbox-repl.mjs`.
- **Sonic Blow from the player's own menu:**
  - Steps: Skill → "⚔️ Sonic Blow 30 MP" (listed as an item-granted skill) → target picker → Psychokinesis die-swap prompt → the action card's Confirm on the player client.
  - GM log: `DECLARE: winner=remote, command=Skill` → `TARGET — command: Attack` → `pseudo-weapon "Sonic Blow"` → `Chain 8 (volley): MISS / 3 / MISS / MISS / MISS / MISS / 4★ / MISS`, applied 7.
  - MP 72 → 42. No Opportunity despite the crit.
  - Problem: ANIMATION ended by its state timeout (~33 s) instead of the gate. The GM here ran headless with the canvas off, so the GM-side cinematic most likely never ran. Not seen in the runner's canvas-on GPU runs; needs a real GM look.
- **Before-action transform through the real Equipment card:**
  - Equipment → TRANSFORM row "Main-hand form · Gunblade" → Firearm chip → "Free Action — won't end your turn" → Done.
  - GM log: `CONFIRM equipment economy: FREE (return to menu)`, form 1, transformFreeUsedRound = 1, back to the Octopath.
  - The Attack menu then showed "Gunblade · Physical · Ranged · DEX + INS · HR + 5"; dice DEX d8 + INS d12; applied 20.
- **Turn-end ask after a before-action transform:** not offered (`WEAPON_TRANSFORM_FREE == 1 → 0`), so one transform per round holds across both paths.
- **Turn-end ask on the player client (round 2, no transform before):** "Gunblade: Transform · When at the end of your turn · Target Self · Cost Free" appeared on the player's reaction hand. Clicking it used it: `transform_weapon: Keren's Gunblade → Sword (changed)`, form 0, stamp round 2.
- Evidence shots: `spec/player-client/` (skill-menu, sonic-blow-targets, equipment-card-firearm-chip, firearm-attack-dex-ins).
- Small UI note: in the Skill menu the left preview card kept showing "Birth of the Cruel: Dismiss" after Sonic Blow was selected. Probably stale preview from the programmatic row click; not checked with a mouse.

Teardown: sandbox server stopped, junctions removed (0 reparse points left), sandbox folder deleted, browsers closed.
