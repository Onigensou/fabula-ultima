"use strict";
// ============================================================================
// Legacy boss animation pass (2026-11-16): Gryphon, Masked Girl, Jack, Jill,
// Love, Rauben, Geist. Approved mockup: claude.ai/artifact/L94fYQHEHkfasPW8fhfJ3G
// (the final per-move spec is the mockup source + its round overrides).
// Merged into _build-dungeon-animations.js's REGISTRY (actorId -> { actorName,
// items: { "<item name>": () => { script, timing, preload } } }).
// Geist's Shadowbringers runs on the full-takeover timeline (camera driven), like Rebellious Wing.
// Deferred: the "imbued by Shadow Strike" attack (generator only, needs a hook decision).
// ============================================================================

const LG = require("./legacy-gryphon-signatures.js");
const LM = require("./legacy-masked-signatures.js");
const LT = require("./legacy-twins-signatures.js");
const LR = require("./legacy-rauben-signatures.js");
const LX = require("./legacy-geist-signatures.js");
let LL = null; try { LL = require("./legacy-love-signatures.js"); } catch (e) { LL = null; }

const g = (fn, key, name, extra) => () => fn({ key: "legacy-" + key, name, ...(extra || {}) });

const LEGACY_REGISTRY = {
  VceM9tFpaVT9Z9fT: { actorName: "⭐️ Gryphon", items: {
    "Zero Power: Downburst": g(LG.downburst, "gryphon-downburst", "Zero Power: Downburst"),
    "Talon": g(LG.talon, "gryphon-talon", "Talon"),
    "Razor Plume": g(LG.razorPlume, "gryphon-razor-plume", "Razor Plume"),
    "Airdrop": g(LG.airdrop, "gryphon-airdrop", "Airdrop"),
    "Air Blast": g(LG.airBlast, "gryphon-air-blast", "Air Blast"),
    "Aerial Shockwave": g(LG.aerialShockwave, "gryphon-aerial-shockwave", "Aerial Shockwave"),
    "Turbulence Wind": g(LG.turbulenceWind, "gryphon-turbulence-wind", "Turbulence Wind"),
    "Wind Wall": g(LG.windWall, "gryphon-wind-wall", "Wind Wall"),
  } },
  LnlydRl7Ed7agd1g: { actorName: "⭐️ Masked Girl", items: {
    "Zero Power: Rebellious Wing": g(LM.rebelliousWing, "masked-rebellious-wing", "Zero Power: Rebellious Wing"),
    "Hurl Spear": g(LM.hurlSpear, "masked-hurl-spear", "Hurl Spear"),
    "Spear Rain": g(LM.spearRain, "masked-spear-rain", "Spear Rain"),
    "Piercing Talon": g(LM.piercingTalon, "masked-piercing-talon", "Piercing Talon"),
    "Wind Lance": g(LM.windLance, "masked-wind-lance", "Wind Lance"),
    "Spear": g(LM.spear, "masked-spear", "Spear"),
    "Draconic Roar": g(LM.draconicRoar, "masked-draconic-roar", "Draconic Roar"),
    "Jump": g(LM.jump, "masked-jump", "Jump"),
    "Skyfall Dive": g(LM.skyfallDive, "masked-skyfall-dive", "Skyfall Dive"),
    "Dragonfire Dive": g(LM.dragonfireDive, "masked-dragonfire-dive", "Dragonfire Dive"),
  } },
  "8nncIhGQAEJ0ABjl": { actorName: "⭐️ Jack", items: {
    "Zero Power: Apex Arrow": g(LT.apexArrow, "jack-apex-arrow", "Zero Power: Apex Arrow"),
    "Thief Bow": g(LT.thiefBow, "jack-thief-bow", "Thief Bow"),            // the skill (the weapon of the same name is skipped by the build)
    "Snaring Arrow": g(LT.snaringArrow, "jack-snaring-arrow", "Snaring Arrow"),
    "Burning Arrow": g(LT.burningArrow, "jack-burning-arrow", "Burning Arrow"),
    "Poison Arrow": g(LT.poisonArrow, "jack-poison-arrow", "Poison Arrow"),
  } },
  cPdnhK7AEVQG5ohd: { actorName: "⭐️ Jill", items: {
    "Zero Power: Temper Tantrum": g(LT.temperTantrum, "jill-temper-tantrum", "Zero Power: Temper Tantrum"),
    "Mug": g(LT.mug, "jill-mug", "Mug", { coins: 2 }),
    "Pulverize": g(LT.pulverize, "jill-pulverize", "Pulverize"),
    "Heavy Axe": g(LT.heavyAxe, "jill-heavy-axe", "Heavy Axe"),
    "Cleaving Strike": g(LT.cleave, "jill-cleaving-strike", "Cleaving Strike"),
  } },
  XsSf4Z1eAcOanCfv: { actorName: "⭐️ Rauben", items: {
    "Zero Power: Night of Hundred Bandits": g(LR.nightOfHundredBandits, "rauben-hundred-bandits", "Zero Power: Night of Hundred Bandits"),
    "Great Axe": g(LR.greatAxe, "rauben-great-axe", "Great Axe"),
    "Great Axe - Counterattack": g(LR.greatAxe, "rauben-great-axe-counter", "Great Axe - Counterattack"),
    "Mug": g(LT.mug, "rauben-mug", "Mug", { coins: 4 }),
    "Cleaving Strike": g(LT.cleave, "rauben-cleaving-strike", "Cleaving Strike"),
    "Oi! Come help me now!": g(LR.oiComeHelpMeNow, "rauben-oi", "Oi! Come help me now!"),
    "All you can take": g(LR.allYouCanTake, "rauben-all-you-can-take", "All you can take"),
    "Axe Throw": g(LR.axeThrow, "rauben-axe-throw", "Axe Throw"),
    "Bandit Raid": g(LR.banditRaid, "rauben-bandit-raid", "Bandit Raid"),
  } },
  UYAabJiUZJ1uKers: { actorName: "⭐️ Geist", items: {
    "Dark Bane": g(LX.darkBane, "geist-dark-bane", "Dark Bane"),
    "Souleater": g(LX.souleater, "geist-souleater", "Souleater"),
    "Torcleaver": g(LX.torcleaver, "geist-torcleaver", "Torcleaver"),
    "Shadow Wall": g(LX.shadowWall, "geist-shadow-wall", "Shadow Wall"),
    "Shadow Strike": g(LX.shadowStrike, "geist-shadow-strike", "Shadow Strike"),
    "Living Shadow": g(LX.livingShadow, "geist-living-shadow", "Living Shadow"),
    "Dark Missionary": g(LX.darkMissionary, "geist-dark-missionary", "Dark Missionary"),
    "Shadowbringers": g(LX.shadowbringers, "geist-shadowbringers", "Shadowbringers"),
  } },
};
if (LL) LEGACY_REGISTRY.MhEHMx4BGuLoETa8 = { actorName: "⭐️ Love", items: LL.REGISTRY_ITEMS ? LL.REGISTRY_ITEMS(g) : {} };

module.exports = { LEGACY_REGISTRY };
