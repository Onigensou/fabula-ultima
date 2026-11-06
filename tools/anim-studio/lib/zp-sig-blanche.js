"use strict";
// ============================================================================
// Blanche — Zero Power: Give me tips or 5stars. Ported from the approved Zero
// Power overhaul mockup (artifact v17, 2026-11-06) onto oni.timeline; the shot is
// zp-shots/zp-blanche.inner.js. cfg below = the user's locked tuning (4 laps,
// 500 ms first leg, x1.6 speed-up, 2800 ms slow motion, 900 ms whiteout hold;
// no Shock1 sting). The gate is fired by the shot itself (oni.fireDone at the
// "Back to battle" moment, which moves with the number of customers), so the
// item timing is "default" and BD's heal + cleanse numbers land with the heal beat.
// ============================================================================
const ZP = require("./zp-signatures.js");
const { F, D4, MV, GG, snd, cue, build } = ZP;

const BLANCHE = "uJFaNQCSvwwsr2AW";
const CH = "Character/Blanche/";
const IMG = "Campaign/The Legend of Dragonslayer/Image/";
const FOOD_DIR = "Item Icon/Food/NEO The World Ends with you/";
const GENSHIN_DIR = "Item Icon/Food/Genshin/";
const FOODS = [
  "NEO_Food_001_Hachiko_Blend.webp", "NEO_Food_003_Iced_Cold_Brew.webp", "NEO_Food_005_Ice_Cream_Float.webp", "NEO_Food_006_BLT_Sandwich.webp",
  "NEO_Food_008_Chocolate_Chunk_Scone.webp", "NEO_Food_027_Fruit_Cocktail.webp", "NEO_Food_028_Dark_Chocolate_Dream.webp", "NEO_Food_029_Ruby_Chocolate_Delight.webp",
  "NEO_Food_031_Boba_Milk_Tea.webp", "NEO_Food_032_Matcha_Boba_Latte.webp", "NEO_Food_034_Mango_Boba_Latte.webp", "NEO_Food_054_Avocado_Toast.webp",
  "NEO_Food_065_Very_Berry_Bouquet.webp", "NEO_Food_067_Chocolate_Soft_Serve.webp", "NEO_Food_088_Crispylicious_Taiyaki.webp", "NEO_Food_089_Creamy_Matcha_Anmitsu.webp",
  "NEO_Food_090_Triple_Matcha_Parfait.webp", "NEO_Food_091_Fluffy_Pancake_Stack.webp", "NEO_Food_093_Creamy_Berry_Shaved_Ice.webp", "NEO_Food_095_Mango_Shaved_Ice.webp",
];
const one = (file, v) => { const c = cue(0, file, v); return { url: c.url, v: c.v }; };

function blanche() {
  const clips = {
    walkdl:  { url: F(CH + "Blanche_Walking_PLACEHOLDER.webm"), w: 291, h: 753, dur: 600, ax: 0.5, ay: 1 },
    walkul:  { url: F(CH + "Blanche_Walking_UpLeft_PLACEHOLDER.webm"), w: 291, h: 753, dur: 600, ax: 0.5, ay: 1 },
    ko:      { url: F(CH + "Blanche_KO.webm"), w: 255, h: 248, dur: 1000, ax: 0.5, ay: 1 },
    love:    { url: F("Emotes Icon/RO/Love.webm"), w: 26, h: 24, dur: 800, ax: 0.5, ay: 0.5 },
    heh:     { url: F("Emotes Icon/RO/Heh.webm"), w: 27, h: 24, dur: 1250, ax: 0.5, ay: 0.5 },
    ok:      { url: F("Emotes Icon/RO/Ok.webm"), w: 28, h: 26, dur: 400, ax: 0.5, ay: 0.5 },
    sparkle: { url: D4("pink_sparkle_burst"), w: 96, h: 80, dur: 533, ax: 0.5, ay: 0.5, add: true },
    dash:    { url: GG("dashsmoke_anim01"), w: 1024, h: 256, dur: 800, ax: 0.5, ay: 0.5 },
    heal:    { url: MV("041_heal_one_1"), w: 546, h: 548, dur: 1400, ax: 0.5, ay: 0.885 },
    cure:    { url: MV("045_cure_one_1"), w: 700, h: 754, dur: 1133, ax: 0.5, ay: 0.561 },
  };
  const images = { cut: F(IMG + "Cut-in/Blanche_Cut-in002.png"), cafe: F(IMG + "Map/Game Map/Blanche_Map001.png"),
    // the final spill's dishes: Genshin Impact wiki icons at full 256 px (user 11-06: the drawn dishes didn't match the art)
    gCake: F(GENSHIN_DIR + "Item_Cake_for_Traveler_3.png"), gDrink: F(GENSHIN_DIR + "Item_Fruity_Duet.png"), gOmurice: F(GENSHIN_DIR + "Item_Omelette_Rice.png") };
  const foods = FOODS.map((f, i) => { images["f" + i] = F(FOOD_DIR + f); return "f" + i; });
  const cfg = {
    customers: 4, laps: 4, lap1: 500, accel: 1.6, slowMs: 2800, whiteHold: 900, spill: "random", cream: true, foods,
    sfx: [cue(0, "Overdrive.wav", 0.9)],
    s: {
      bell: one("Bell3.ogg", 1), eating: one("Eating.mp3", 1), item2: one("Item2.ogg", 1), fall: one("Fall.ogg", 1), slowreel: one("slowReel.wav", 1),
      smackA: one("SE_HITNIKUA.wav", 1), smackB: one("SE_HITNIKUB.wav", 1), water3: one("Water3.ogg", 1), liquid: one("Liquid.ogg", 1), glass: one("Break.ogg", 1),
      crash: one("Crash.ogg", 1), heal1: one("Heal1.ogg", 1), powerup: one("Powerup.ogg", 1),
    },
  };
  // s.*.v is the x0.7 scale only; the shot passes the mockup volume per play and the 0.7 is applied here once
  for (const k of Object.keys(cfg.s)) cfg.s[k].v = 0.7;
  return build({ key: "blanche-tips-5stars", name: "Zero Power: Give me tips or 5stars", shot: "zp-blanche", clips, images, cfg, gate: null, timeout: 45000 });
}

const TARGETS = [{ actor: BLANCHE, item: "1D1rFRDBiIuINoei" }, { world: "5vKJb9OFFYdPK8iF" }];
module.exports = { blanche, TARGETS, FOODS };
