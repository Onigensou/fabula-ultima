# Dungeon Tile Registry
Reference file for the dungeon tile template system. No in-game functionality.

## Source
- **Template scene ID:** `cVxIhCmCguNGxAZv`  
- **Asset base URL:** `https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/`
- **All tiles:** 25×25px in the template scene (size is ignored on transform — target keeps its own size)

## Macro
- **File:** `tools/auto-link-dungeon-tiles.js`
- Transform mode applies: `texture.src`, `name` (from monks-active-tiles), and all `flags` — but preserves the target tile's width/height.

---

## Tile Templates

| # | Name | Filename | UUID | Monks Active | Triggers | fabula-ultima-companion |
|---|------|----------|------|--------------|----------|------------------------|
| 1 | Accessory | `Accessory_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.KscgqJRPii2iFUKc` | active, stop+enter | runmacro: Trigger TreasureRoulette | — |
| 2 | Advantage | `Advantage_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.H006Kgf2MkVKNFNY` | inactive | — | — |
| 3 | Alert | `Alert_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.MEntEJyVyuWkFFf9` | inactive | — | — |
| 4 | Ambush | `Ambush.png` | `Scene.cVxIhCmCguNGxAZv.Tile.Px52MtdVgMqqH12j` | inactive | — | — |
| 5 | Armor | `Armor_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.vsNtP3irIv03gtVi` | active, stop | runmacro: Trigger TreasureRoulette | — |
| 6 | Battle | `Battle_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.DZkhl2uJ8tOlewUW` | inactive | — | — |
| 7 | Blank | `Blank_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.mxeuGf5yBj4kIKNl` | active, enter | — | rangeTop:-1, noCollision:true |
| 8 | Blocked | `Blocked_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.33Klr5JSDVRr9DVp` | inactive | — | — |
| 9 | Burning | `Burning_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.ztXNEAt3GLRco1DA` | active, enter | — | persistAfterTrigger, AE: Burn, VFX: screenflash red, SFX: Fire1.ogg |
| 10 | Camp | `Camp_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.xSYAtpt9IUP2mt5C` | inactive | — | — |
| 11 | Chaos | `Chaos_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.B7bB2DPrskYDq6Xj` | inactive | — | — |
| 12 | Conditions | `Status_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.0mjLItlZguaSvO9Z` | active, stop+enter | runmacro: Global Loot (player), deactivate self | — |
| 13 | Consumable | `Consumeable_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.idSAcad7QhnKsQ52` | active, stop+enter | runmacro: Trigger TreasureRoulette | — |
| 14 | Cracked | `Crack_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.EnmUbBAAypqJ3H2h` | active, exit | runmacro: Cracked Tile (player), deactivate self | — |
| 15 | Dirt | `Dirt_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.kNxkmOhIXWX3EaBl` | active, enter | — | usable:true, rangeTop:-1, noCollision:true |
| 16 | Door | `Door_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.ghmG85s3MsKj7DGU` | active, stop+enter (player only) | teleport token to scene, play Move1.ogg | — |
| 17 | Double Down | `ArrowDoubleDown_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.TkFXGiBPHfrsqpLb` | inactive | — | — |
| 18 | Double Left | `ArrowDoubleLeft_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.qgcj6fBK0GMQR8QG` | inactive | — | — |
| 19 | Double Right | `ArrowDoubleRight_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.qrdttcjSbuSQH0PH` | inactive | — | — |
| 20 | Double Up | `ArrowDoubleUp_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.tHzW8Pbpqac8P3RP` | inactive | — | — |
| 21 | Down | `ArrowDown_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.5rMSRXfjSRIflRqT` | inactive | — | — |
| 22 | Event | `Event_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.D0CrRncjQggIZrkF` | inactive | — | — |
| 23 | Final Story | `Final_Story Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.dNrihFPvmLduSIFj` | inactive | — | — |
| 24 | Fishing | `Fishing_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.FByY4WPjidF6NaPo` | inactive | — | — |
| 25 | Freeze | `Freeze_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.TtAG30ZMVx73Qi4f` | inactive | — | — |
| 26 | Gathering | `Gathering_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.1q2iMM1MiIjALO7e` | inactive | — | — |
| 27 | Gold | `Gold_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.netIup22eWXbo7rb` | active, enter | runmacro: TR_TileTrigger_Macro | — |
| 28 | Gusty | `Gusty_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.vKYmW9XxWBQcJ2rh` | active, enter | — | persistAfterTrigger, forceMoveDirection:PUSH_BACK, forceMoveSteps:1, checkGate:{enabled, mode:group, leaderMode:players_choose, attrA:DEX, attrB:MIG, dl:10, triggerOn:failure, label:"Resist the Wind"} |
| 29 | Hazard | `Hazard_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.NVhsjf46sPmLygoG` | inactive | — | — |
| 30 | Healing | `Healing_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.KcJQJnKvqHDh0r0i` | inactive | — | — |
| 31 | Item | `Item_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.O3V12IlSCIBI1M9C` | active, stop+enter | runmacro: Trigger TreasureRoulette | — |
| 32 | Jump | `Jump_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.biomNmWcnAIvmYJV` | inactive | — | — |
| 33 | Left | `ArrowLeft_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.KTuDrC7TBu9g6Gxr` | inactive | — | — |
| 34 | Obstacle | `Onstacle_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.qmDixtECgw25jfGu` | inactive | — | — |
| 35 | Poison | `Poison_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.r0gFHdtO3gUTlQmN` | inactive | — | — |
| 36 | Random Battle | `Random_Battle_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.7u7OxArldtVs4opX` | active, stop+enter | runmacro: Random Battle (player) | — |
| 37 | Rare Monster | `RareMonster_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.B4BEMQ41fYymcmoK` | active, enter | — | — |
| 38 | Recipe | `Recipe_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.6GyiSml6E12fiwP7` | inactive | — | — |
| 39 | Right | `ArrowRight_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.i8irtWISVIMn58G2` | inactive | — | — |
| 40 | Scorched | `Scorched_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.OOU5sMtIkdP7CRvu` | active, enter | — | damage: 10 fire, VFX: screenflash orange, SFX: Condition_Burn_LP.ogg |
| 41 | Settlement | `Settlement_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.jhK8Bwe30WSMKQH9` | inactive | — | — |
| 42 | Skill Check | `SkillCheck_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.VdofQBTMzoFVxDAh` | inactive | — | — |
| 43 | Slippery | `Slippery_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.8RibGff6hH12hAbd` | inactive | — | — |
| 44 | Stealth | `Stealth_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.037GISQBRLT8H8Mn` | inactive | — | — |
| 45 | Story | `Story_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.HlH7Tppg6X9ZnZ0M` | inactive | — | — |
| 46 | Trap | `Trap_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.27NIVCVPDmnta5xa` | active, stop+enter | runmacro: Trap Damage (player) | damage: 5 physical, VFX: screenflash white, SFX: Attack2.ogg |
| 47 | Travel | `Travel_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.iT4Vk0hyZ3iTfHmY` | active, enter | — | rangeTop:-1, noCollision:true |
| 48 | Treasure | `Treasure_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.YmLsnhWf6dcJMplu` | active, stop+enter | runmacro: Trigger TreasureRoulette | — |
| 49 | Triple Down | `ArrowTripleDown_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.uWcckukbXGZnhs1J` | inactive | — | — |
| 50 | Triple Left | `ArrowTripleLeft_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.eL12cUJQKc9xyjYW` | inactive | — | — |
| 51 | Triple Right | `ArrowTripleRight_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.aiAdg9z7IYDiVqlS` | inactive | — | — |
| 52 | Triple Up | `ArrowTripleUp_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.crLAF6e6g9rKb0RA` | inactive | — | — |
| 53 | Up | `ArrowUp_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.vPJybmhRf8T8myRA` | inactive | — | — |
| 54 | Vertigo | `Vertigo_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.IKTIked6afyrIwYE` | active, enter | — | AE: Blind, SFX: emotion_down.wav |
| 55 | Water | `Water_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.7Lwvs9lDh3jRFT5R` | active, enter | — | AE: Wet, SFX: SE_BTL_FootStepWater_2.ogg, rangeTop:-1, noCollision:true |
| 56 | Weapon | `Weapon_Tile.png` | `Scene.cVxIhCmCguNGxAZv.Tile.txN0aoOqqJcS9snL` | active, enter | runmacro: TR_TileTrigger_Macro | — |

---

## Full Flag Configs (for manual imprint)

### Gusty Tile
**Sample source:** `Scene.eTcAzbSagAqMI7eM.Tile.oDiu4A2TLQBblVIi`  
**TileState initialType / currentType:** `gusty`  
**Texture:** `Gusty_Tile.png` (see Asset base URL above)

```json
{
  "flags": {
    "fabula-ultima-companion": {
      "dungeonPathing": {
        "persistAfterTrigger": true,
        "skipConfirm": false,
        "usable": false,
        "disableGoBack": false,
        "blockGoBack": false,
        "eligibleForFastTravel": false,
        "forceMoveDirection": "PUSH_BACK",
        "forceMoveSteps": 1,
        "checkGate": {
          "enabled": true,
          "mode": "group",
          "leaderMode": "players_choose",
          "attrA": "DEX",
          "attrB": "MIG",
          "dl": 10,
          "triggerOn": "failure",
          "label": "Resist the Wind"
        },
        "effectConfig": {
          "enabled": false,
          "targetMode": "all",
          "useResourceChange": false,
          "resourceType": "damage",
          "resourceValue": 0,
          "elementType": "elementless",
          "ignoreReduction": false,
          "weaponType": "none_ef",
          "useActiveEffect": false,
          "activeEffectsJson": "",
          "silent": false,
          "vfxType": "none",
          "vfxFile": "",
          "vfxFlashTint": "#ff0000",
          "vfxFlashAlpha": 0.5,
          "sfxUrl": ""
        }
      }
    }
  }
}
```

---

## Notes
- **Obstacle filename** is a typo in the source: `Onstacle_Tile.png` (not `Obstacle_Tile.png`)
- **"Up (alt)"** (ID: `2FMtLDA8AFyXux5G`) was identical to Up — dropped from macro template list
- Tiles with `rangeTop: -1` and `noCollision: true` are passthrough/terrain tiles (Blank, Burning, Dirt, Gusty, Scorched, Travel, Vertigo, Water)
- Tiles with `fabula-ultima-companion` flags configured: Burning, Dirt, Gusty, Scorched, Trap, Vertigo, Water
- Inactive tiles (most of them) are configured on a per-scene basis after placement via the transform tool
