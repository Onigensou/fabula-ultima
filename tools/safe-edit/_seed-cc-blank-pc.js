/**
 * Seed the Character Creation blank PC.
 *
 * Clones "Cherry" (the leanest PC on the CURRENT char template version,
 * 1137758910) and strips every character-specific prop back to a neutral
 * value, leaving the 207 universal defaults untouched.
 *
 * Cloning rather than Actor.create()+reloadTemplate() is deliberate: the CSB
 * template actor carries ZERO props, so a fresh stamp does not reliably
 * reproduce the dropdown/derived state a hand-made PC has. Cloning a known-good
 * PC guarantees shape parity.
 *
 *   node _seed-cc-blank-pc.js            # dry run, prints the result
 *   node _seed-cc-blank-pc.js --write    # actually write
 */
const { ClassicLevel } = require("classic-level");

const P = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/worlds/fabula-ultima-2/data";
const SOURCE_ID = "XLS7jIqK8iAToGYM";      // Cherry
const TEMPLATE_FOLDER = "Qpc6ITpm60JVdwXF"; // Actor folder "Template"
const NEW_ID = "CCBlankPC000Seed";          // 16 chars, fixed so code can hard-reference it
const NEW_NAME = "_CC Blank PC";
const BLANK_IMG = "icons/svg/mystery-man.svg";

// Props that differ between real PCs and therefore must be neutralised.
// Anything not listed here falls through to a type-based default.
const EXPLICIT = {
  // ── progression ──────────────────────────────────────────────────────────
  // TYPES MATTER. Verified identical across Cherry/Hina/Keren: user-entered
  // fields are stored as STRINGS, CSB formula outputs as NUMBERS. Writing the
  // wrong side of that split gives CSB a string to do arithmetic on.
  level: "5",
  zenit: "0",
  experience: "0",            // string
  exp_meter: 0,               // number (formula)
  experience_ui: "0",
  fabula_point: "3",          // rulebook p.96 — a new PC starts with 3
  skill_point: 5,             // number — matches what applySpend writes back
  skill_point_bonus: "0",
  class_list: {},

  // ── attributes: d8 baseline, overwritten by the wizard ───────────────────
  // `_base` is a string (attribute-api writes String(to)); `_current` is a
  // CSB-computed number.
  mig_base: "8", dex_base: "8", ins_base: "8", wlp_base: "8",
  mig_current: 8, dex_current: 8, ins_current: 8, wlp_current: 8,

  // ── derived: CSB recomputes all of these on load. Neutral placeholders ──
  max_hp: 45, current_hp: "45",   // 5 + 5×8
  max_mp: 45, current_mp: "45",
  max_ip: 6,  current_ip: "6",
  base_defense: 8, base_magic_defense: 8,
  defense: 8,      magic_defense: 8,

  // ── inventories / CSB dynamic tables ─────────────────────────────────────
  inventory_list: {}, key_list: {}, memories_list: {}, consumable_list: {},
  weapon_list: {}, normal_spell_list: {}, offensive_spell_list: {},
  skill_active_list: {}, itemContainer2: {}, itemContainer3: {},
  itemContainer4: {}, animation_table: {},

  // ── filters / display toggles: keep the template's working defaults ──────
  skill_type_filter: "All",
  skill_hideEffect: true,
  spell_hideEffect: true,

  // ── equipment slots ──────────────────────────────────────────────────────
  main_hand: "", off_hand: "Unarmed Strike",
  main_attrib_1: "DEX", main_attrib_2: "MIG",
  off_attrib_1: "DEX",  off_attrib_2: "MIG",
  weapon1_damagetype: "Physical", weapon2_damagetype: "Physical",
  rolled_atr1: "DEX", rolled_atr2: "MIG",
  shield_type: "", shield_value: "0",
  is_martialarmor: false,

  // ── magic disciplines: all off until a class grants one ──────────────────
  arcanism: false, chimerism: false, elementalism: false, entropism: false,
  illusionism: false, ritualism: false, spiritism: false,

  // ── self-reference props CSB recomputes ──────────────────────────────────
  id: NEW_ID,
  uuid: `Actor.${NEW_ID}`,
  name: NEW_NAME,
  img: BLANK_IMG,
};

// Varying props whose neutral value is a literal, by prefix.
const PREFIX_DEFAULT = [
  [/^affinity_\d+$/,        "NA"],
  [/^clock_/,               "0"],
  [/^resource_value_/,      "0"],
  [/^(bond|relationship)_/, ""],
  [/^emotion_/,             ""],
];

const typeDefault = (v) => {
  if (Array.isArray(v)) return [];
  if (v && typeof v === "object") return {};
  if (typeof v === "boolean") return false;
  if (typeof v === "number") return 0;
  // CSB stores most numerics as strings; a numeric-looking string blanks to "0"
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return "0";
  return "";
};

(async () => {
  const write = process.argv.includes("--write");
  const db = new ClassicLevel(P + "/actors", { valueEncoding: "json" });

  // Refuse to clobber an existing seed.
  let exists = null;
  try { exists = await db.get("!actors!" + NEW_ID); } catch { /* absent, good */ }
  if (exists && write) {
    console.error(`REFUSING: ${NEW_ID} already exists ("${exists.name}"). Delete it first.`);
    await db.close();
    process.exit(1);
  }

  const all = [];
  for await (const [, v] of db.iterator()) all.push(v);
  const src = all.find((a) => a._id === SOURCE_ID);
  if (!src) { console.error("source actor not found"); await db.close(); process.exit(1); }

  // Which props are character-specific? Recomputed here rather than hardcoded,
  // so the seed stays correct if the roster changes.
  const peers = all.filter(
    (a) => a.type === "character" &&
           a.system?.template === src.system.template &&
           a.system?.templateSystemUniqueVersion === src.system.templateSystemUniqueVersion &&
           Object.keys(a.system?.props ?? {}).length > 300
  );
  const srcProps = src.system.props;
  const varying = Object.keys(srcProps).filter((k) => {
    const vals = new Set(peers.map((a) => JSON.stringify(a.system.props?.[k])));
    return vals.size > 1;
  });

  const props = JSON.parse(JSON.stringify(srcProps));
  const changes = [];
  for (const k of varying) {
    let next;
    if (Object.prototype.hasOwnProperty.call(EXPLICIT, k)) next = EXPLICIT[k];
    else {
      const hit = PREFIX_DEFAULT.find(([re]) => re.test(k));
      next = hit ? hit[1] : typeDefault(srcProps[k]);
    }
    props[k] = next;
    changes.push([k, srcProps[k], next]);
  }
  // Explicit entries for keys that were identical across peers still apply.
  for (const [k, v] of Object.entries(EXPLICIT)) {
    if (!varying.includes(k) && JSON.stringify(props[k]) !== JSON.stringify(v)) {
      changes.push([k, props[k], v]);
      props[k] = v;
    }
  }

  const doc = JSON.parse(JSON.stringify(src));
  doc._id = NEW_ID;
  doc.name = NEW_NAME;
  doc.folder = TEMPLATE_FOLDER;
  doc.img = BLANK_IMG;
  doc.items = [];
  doc.effects = [];
  doc.sort = 0;
  doc.ownership = { default: 0 };
  doc.flags = {};
  doc.system.props = props;
  doc.prototypeToken = {
    ...doc.prototypeToken,
    name: NEW_NAME,
    actorLink: true,
    randomImg: false,
    texture: {
      ...(doc.prototypeToken?.texture ?? {}),
      src: BLANK_IMG, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0,
    },
    flags: {},
  };
  doc._stats = { ...(doc._stats ?? {}), compendiumSource: null, duplicateSource: null };

  console.log(`source        : ${src.name} (${SOURCE_ID})`);
  console.log(`peers compared: ${peers.map((a) => a.name).join(", ")}`);
  console.log(`varying props : ${varying.length} / ${Object.keys(srcProps).length}`);
  console.log(`props blanked : ${changes.length}`);
  console.log(`items/effects : ${src.items.length}/${src.effects.length} -> 0/0\n`);
  console.log("── resulting blank values ──");
  for (const [k, before, after] of changes.sort((a, b) => a[0].localeCompare(b[0]))) {
    const b = JSON.stringify(before) ?? "undefined";
    const a2 = JSON.stringify(after);
    console.log(`  ${k.padEnd(30)} ${b.slice(0, 34).padEnd(36)} -> ${a2.slice(0, 30)}`);
  }

  if (!write) {
    console.log("\nDRY RUN — nothing written. Re-run with --write to commit.");
    await db.close();
    return;
  }
  await db.put("!actors!" + NEW_ID, doc);
  await db.close();
  console.log(`\nWROTE Actor.${NEW_ID} ("${NEW_NAME}") into folder Template.`);
})();
