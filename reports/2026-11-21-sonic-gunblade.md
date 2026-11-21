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
