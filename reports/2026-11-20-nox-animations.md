# Nox Legion action animations (v1.0.639)

All six Nox Legion monsters (Ghoul, Hound, Priest, Wraith, Viper, Executioner) now have their own animations: 24 moves, each approved one by one in a mockup review. Every one is an `oni.timeline` animation_script built by the dungeon-animation builder, the same way as the other dungeon monsters.

## What you need to do
- Pull and restart the server (version bump). No migration: the six actors ship in the world data commit.
- Your save slots don't need patching. Only the actors changed, and slots don't store them.
- **If your Nox tuning branch also writes these six actors:** rebase onto this push and re-run your actor writes before you commit the world. LevelDB can't merge, so the second world commit has to be rebuilt on top of the first.

## What changed
- **Code:** `tools/anim-studio/lib/nox-*.js` (assets, registry, four signatures files) and `lib/nox-shots/*.inner.js` (shot kits).
  - `_build-dungeon-animations.js` loads `NOX_REGISTRY`. A job marked `optional` is skipped when its item isn't there; that covers Gravis / Gravis Alta and Revive / Resurrection, so a rename doesn't break the build.
  - `_wire-nox-passive-anims.js` adds `play_animation` rows to the passive chains. It takes a backup first and is safe to re-run.
- **World (6 actors modified, none added or removed):** animation fields, plus these chain rows:
  - **Tell, then the attack's own animation:** Counter when enemy Healed (Ghoul), On the Hunt (Hound) and Feeding Coil (Viper). These passives are free actions, so the real Grave Claw / Rending Fangs / Poison Fang plays its own animation afterwards. Their passive scripts are a short tell only, so the strike never shows twice.
  - **Parry (Executioner):** the animation lands, then the damage is halved (`py_chain`).
  - **Beheading (Executioner):** plays on the picked target at round end; the slash itself is the KO.
  - **Soul Siphon (Wraith):** plays from the soul fragment.
  - **Bile Spew (Viper):** the armour-break take (`Bile Spew#armorbreak`) plays only on targets that fail the save.
- **Assets:** already on Forge, all new files (nothing overwritten).
  - `Animation/pixelfx/nox/`: 47 effect layers.
  - `Beastiary/NoxExecutioner_{Slash,Parry}`: the Executioner's new sprite clips, from the Dullahan layers.

## Notes
- Glow and burst clips with a black background (pixelfx `_light`, GG, JB2A) go through a luma-to-alpha filter. Without it they draw as black boxes on the timeline overlay.
- Executioner shots take over the board while they play, so they paint the target's hurt and KO art themselves.
- Zombie Plague: the save is rolled after the animation, so the grave hands reach for every target. The Zombie status shows who actually turned.
- Ethereal (Wraith) has an animation but no trigger in the game, so nothing plays it yet.
- Revive → Resurrection rename: not in this push. It belongs to the Nox tuning work; the builder already accepts either name.

## Checked
- A sandbox copy of the world played each of the 24 directly with no errors. Every token was restored, and damage landed on the approved impact frame (Grave Claw 1142 ms, Gravis 2060 ms, Lux Finis ~4980 ms, Guillotine 2522 ms).
- Two watch-pace sim battles with no animation errors:
  - Executioner + Viper + Priest: Coil, Guillotine, Gravis, Zombie Plague, Gibbet; Parry three times.
  - Ghoul + Hound + Wraith + Viper: Bile Spew + armour break, Counter → Grave Claw, On the Hunt → Rending Fangs, Soul Ripper, Poison Blade, Coil.
- World export report: 6 actors modified, 0 added, 0 removed.

## Owed
- A real-table look and listen. Not yet seen inside a real battle: Beheading, Soul Siphon, Devour Soul, Soul Sever, Revive, Lux Finis, Feeding Coil (each passed the direct test).
