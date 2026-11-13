// Fishing v2 world data (user-approved 2026-11-13, mockup v20
// https://claude.ai/artifact/JWMB2X6uGUZJZWn4BjKNpv).
//
//   folders : "Tackle" (Item folder, inside 🔑 Key Item)
//   items   : the four starter rods — key items, given to nobody yet (the user
//             decides later where players get them). Each carries
//             flags["fabula-ultima-companion"].fishingRod = { attr, color }:
//             while fishing, that attribute counts one die size higher
//             (bonus ON TOP of the base tuning). Names user-approved.
//           + per-fish data on the 25 Fish-folder items:
//             flags["fabula-ultima-companion"].fish = { shape, size, likes }
//             shape = silhouette (std | long | round), size = within its rank,
//             likes = the bait taste it bites twice as often.
//
// Run from tools/safe-edit:  node bin/_fishing-v2-2026-11-13.js folders|items [--apply]
const { getByKey, openCollection } = require("../lib/db");
const { run } = require("./_fafnir-util");

const MOD = "fabula-ultima-companion";
const KEY_FOLDER = "3kZfXVrONQZyTxO3";      // 🔑 Key Item
const TACKLE = "FishTackleFolder";
const FISH_FOLDER = "M5VOqokm97pmFqrA";
const DONOR = "!items!";                    // + Gryphon Whistle's id, looked up by name

const RODS = [
  { id: "FishRodIronwood1", name: "Ironwood Rod",   attr: "mig", color: "#d0603e", img: "icons/tools/fishing/rod-brown-gold.webp",
    text: "While fishing, your <strong>MIG</strong> counts as one die size higher: the bar rises faster and the catch meter fills faster." },
  { id: "FishRodSwiftlin1", name: "Swiftline Rod",  attr: "dex", color: "#6fcf5a", img: "icons/tools/fishing/rod-simple-bamboo.webp",
    text: "While fishing, your <strong>DEX</strong> counts as one die size higher: a more nimble bar and a slower cast gauge." },
  { id: "FishRodSeers0001", name: "Seer's Rod",     attr: "ins", color: "#5f8fd8", img: "icons/tools/fishing/rod-wood-blue-tan.webp",
    text: "While fishing, your <strong>INS</strong> counts as one die size higher: a taller catch bar." },
  { id: "FishRodStillwat1", name: "Stillwater Rod", attr: "wlp", color: "#a77be0", img: "icons/tools/fishing/rod-simple-stick-brown-white.webp",
    text: "While fishing, your <strong>WLP</strong> counts as one die size higher: more reel time and a stronger pull toward rare fish." },
];

// name → [shape, size, likes]. The 11 mockup fish keep their mockup shape/size.
const FISH = {
  "Bolt Eel":              ["long",  1.05, "umami"],
  "Ice Pike":              ["long",  1.0,  "umami"],
  "Silt Catfish":          ["std",   1.1,  "bitter"],
  "Flame Salmon":          ["std",   0.9,  "sweet"],
  "Mudfish":               ["std",   0.9,  "bitter"],
  "Venom Jellyfish":       ["round", 0.85, "salty"],
  "Wind Bass":             ["std",   1.0,  "sour"],
  "River Trout":           ["std",   1.0,  "sweet"],
  "Fugu":                  ["round", 0.85, "salty"],
  "Lucky Loach":           ["long",  0.9,  "sweet"],
  "Shine Herring":         ["std",   0.85, "salty"],
  "Blade Angler":          ["std",   1.0,  "umami"],
  "Toxic Puffer":          ["round", 0.9,  "bitter"],
  "Shadow Sturgeon":       ["long",  1.15, "bitter"],
  "Wandering Shark":       ["std",   1.1,  "umami"],
  "Moonfish":              ["std",   0.95, "sweet"],
  "Urchin":                ["round", 0.8,  "salty"],
  "Mindful Sole":          ["round", 1.0,  "sour"],
  "Hearty Cod":            ["std",   1.1,  "umami"],
  "Keystone Ray":          ["round", 1.05, "salty"],
  "Stash Gar":             ["long",  1.1,  "sour"],
  "Golden Koi":            ["std",   1.0,  "sweet"],
  "Prophet Tuna":          ["std",   1.05, "umami"],
  "Magnificent Mahi-mahi": ["std",   1.15, "sour"],
  "Tempest Manta":         ["round", 1.1,  "salty"],
};

async function allItems() {
  const db = await openCollection("items"); const out = [];
  for await (const [k, v] of db.iterator()) if (/^!items![^.]+$/.test(k)) out.push(typeof v === "string" ? JSON.parse(v) : v);
  await db.close(); return out;
}

const which = process.argv[2];
if (which === "folders") {
  run(async ({ changes }) => {
    const k = `!folders!${TACKLE}`;
    if (await getByKey("folders", k)) { console.log("Tackle folder already there"); return; }
    const base = await getByKey("folders", `!folders!${KEY_FOLDER}`);
    if (!base || base.type !== "Item") throw new Error("Key Item folder missing");
    const f = JSON.parse(JSON.stringify(base));
    f._id = TACKLE; f.name = "Tackle"; f.folder = KEY_FOLDER; f.sort = 0; f.color = null; f.description = "";
    if (f._stats) { f._stats.createdTime = null; f._stats.modifiedTime = null; f._stats.duplicateSource = null; f._stats.compendiumSource = null; }
    changes.push([k, f, `CREATE folder "Tackle" in 🔑 Key Item`]);
  }, "Fishing v2 — Tackle folder", "folders");
} else if (which === "items") {
  run(async ({ changes }) => {
    const items = await allItems();
    const donor = items.find(i => i.name === "Gryphon Whistle" && i.system?.props?.item_type === "key");
    if (!donor) throw new Error("donor key item (Gryphon Whistle) missing");
    for (const r of RODS) {
      const k = `!items!${r.id}`;
      const existing = await getByKey("items", k);
      if (!existing && items.some(i => i.name === r.name)) throw new Error(`an item named ${r.name} already exists`);
      const d = JSON.parse(JSON.stringify(existing ?? donor));
      if (!existing) {
        d._id = r.id; d.sort = 0;
        if (d._stats) { d._stats.createdTime = null; d._stats.modifiedTime = null; d._stats.duplicateSource = null; d._stats.compendiumSource = null; }
      }
      d.name = r.name; d.img = r.img; d.folder = TACKLE;
      d.ownership = { default: 0 };
      const p = d.system.props;
      p.name = r.name; p.img = r.img; if ("id" in p) p.id = r.id; if ("uuid" in p) p.uuid = `Item.${r.id}`;
      p.item_type = "key"; p.isKey = true; p.isUnique = true; p.item_quantity = "1";
      p.item_rarity = "Uncommon"; p.category = "";
      p.description = `<ul><li><p>${r.text}</p></li></ul>`;
      p.flavor_text = "";
      p.isSet = false; p.set_name = "";
      d.flags = { ...(d.flags ?? {}), [MOD]: { ...((d.flags ?? {})[MOD] ?? {}), fishingRod: { attr: r.attr, color: r.color } } };
      changes.push([k, d, `${existing ? "update" : "CREATE"} "${r.name}" (key item, +1 ${r.attr.toUpperCase()} stage while fishing)`]);
    }
    const fish = items.filter(i => i.folder === FISH_FOLDER);
    const missing = Object.keys(FISH).filter(n => !fish.some(f => f.name === n));
    const extra = fish.filter(f => !FISH[f.name]).map(f => f.name);
    if (missing.length || extra.length) throw new Error(`fish roster drift — missing ${missing} / unlisted ${extra}`);
    for (const f of fish) {
      const [shape, size, likes] = FISH[f.name];
      const d = JSON.parse(JSON.stringify(f));
      d.flags = { ...(d.flags ?? {}), [MOD]: { ...((d.flags ?? {})[MOD] ?? {}), fish: { shape, size, likes } } };
      changes.push([`!items!${f._id}`, d, `${f.name}: ${shape}, size ${size}, likes ${likes}`]);
    }
  }, "Fishing v2 — rods + per-fish data", "items");
} else {
  console.log("usage: node bin/_fishing-v2-2026-11-13.js folders|items [--apply]");
}
