// ═════════ Spell Fencer (class) · Spellblade Rhapsody + the Resonance pulse — family head, HOST-NEUTRAL (move-engine)
// Runs in the mockup page AND the game. The caster comes from the host (moveCaster): Keren on the page, the action's
// caster in the game. Both moves are self-only (no target). Rules: moves/spell-fencer/skills.js (not loaded here).
const GROUPS = { rhapsody: "Spellblade Rhapsody · Active", resonance: "Resonance · class resource" };
const SFC = () => moveCaster();
// palette (the approved class-page sandbox, sf-page/spell-fencer.html): blade red, spell blue, Resonance gold / violet
const SF_RED = "255,77,61", SF_BLUE = "77,166,255", SF_GOLD = "255,208,74", SF_VIOLET = "184,140,255";
// chest point: the Resonance pulse sits here (60% up the drawn body)
const sfChest = (a) => ({ x: OX(a), y: OY(a) - hgt(a) * .6 });
// the pixelfx braid (pixelfx fu/spellblade-braid, exported soft ×2): one clip per helix radius × note count × palette.
// Every variant key is written out so the game build's asset filter (a literal-key search) finds them; the approved
// tune picks one (port: keep only that key, see NOTES.md).
const SF_BRAIDS = ["sf_braid_r0n0c0", "sf_braid_r0n0c1", "sf_braid_r0n1c0", "sf_braid_r0n1c1", "sf_braid_r0n2c0", "sf_braid_r0n2c1",
  "sf_braid_r1n0c0", "sf_braid_r1n0c1", "sf_braid_r1n1c0", "sf_braid_r1n1c1", "sf_braid_r1n2c0", "sf_braid_r1n2c1",
  "sf_braid_r2n0c0", "sf_braid_r2n0c1", "sf_braid_r2n1c0", "sf_braid_r2n1c1", "sf_braid_r2n2c0", "sf_braid_r2n2c1"];
const sfBraidKey = (C) => SF_BRAIDS.find((k) => k === "sf_braid_r" + tv(C, "radius") + "n" + tv(C, "notes") + "c" + tv(C, "pal")) || "sf_braid_r1n1c0";
// a pixel eighth note (5 × 7 cells) drawn on a particle canvas, crisp cells; u = cell size in px
const SF_NOTE = ["..##.", "..#.#", "..#..", "..#..", "###..", "###..", ".#..."];
function sfNote(c, x, y, u, rgb, a) { c.globalCompositeOperation = "source-over"; c.fillStyle = `rgba(${rgb},${a})`;
  SF_NOTE.forEach((row, ry) => { for (let rx = 0; rx < 5; rx++) if (row[rx] === "#") c.fillRect(Math.round(x + (rx - 2.5) * u), Math.round(y + (ry - 7) * u), Math.ceil(u), Math.ceil(u)); }); }
// round 2 (Red Mage language): the mana charge at the hand, the duality sigil under the feet (+ optional crystal crown),
// the unleash burst (pixelfx fu/mana-charge, fu/duality-sigil, fu/duality-unleash). Keys written out for the asset filter.
const SF_CHARGE = "sf_charge";
const SF_SIGILS = ["sf_sigil_k1", "sf_sigil_k0"];                      // crown On / Off (tune "crown" 0 / 1)
const SF_UNLEASH = ["sf_unleash_d0", "sf_unleash_d1", "sf_unleash_d2"]; // light / full / heavy (tune "dens")
const sfSigilKey = (C) => SF_SIGILS[tv(C, "crown")] || SF_SIGILS[0];
const sfUnleashKey = (C) => SF_UNLEASH[tv(C, "dens")] || SF_UNLEASH[1];
