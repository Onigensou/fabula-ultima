// Shared content definitions for the GORGER family.
//
// Gorgers are the campaign's parody of the Final Fantasy "Bomb": a low-level
// nuisance that inflates on a visible clock and pops. They are FILLER — they
// belong to no dungeon in particular and can be dropped into any of them.
//
// Two sub-families:
//   * the THIEF pair (Mana / Life Gorger) — eat something of yours, then run.
//   * the ELEMENTAL cycle — absorb their element, swell, detonate.
//
// Both are driven by ONE shared resource, the `Eaten` counter.

// ── document ids ────────────────────────────────────────────────────────────
// Existing ids are REUSED so tokens, roll tables and any other reference that
// already points at a Gorger keeps resolving. These are updates, not replacements.
const IDS = {
  // — thief pair —
  MANA:           "PgNX7yW5nxq2emWX",
  MG_CONSUME:     "VhNtcDifD3ptNgOE",
  MG_RESIDUE:     "A16EULxPG2dENY71",
  MG_RUN:         "4IrUKGEoVA4r7gls",   // was "Flee"
  MG_LOOT:        "wJJ3Jqpeol4tUqQQ",   // Mega-Elixir
  MG_EATEN_AE:    "DtmAT6t6XtnXTnbY",

  LIFE:           "nyHr1MwzRKcGUdyW",
  LG_CONSUME:     "1mFdPUJbqw75sgsR",
  LG_RESIDUE:     "HPmZBHFvEayaBTMv",
  LG_RUN:         "mDCsEDSOUSpgzWqy",   // was "Flee"
  LG_LOOT:        "xv29h2B2X7EuECAI",   // Mega-Remedy
  LG_EATEN_AE:    "YVD5skR9nSRA1Xje",

  // — elemental cycle: existing actors —
  AERO:              "9yadoDh5EhIWpevl",
  AERO_SPELL:        "xvg5HXcwBOWPWpyr",   // Ventus
  AERO_PUFF:         "lmpZ4ifOcHjilCxJ",
  AERO_CONSUME:      "KoyDVS38VutWq0aJ",
  AERO_BOOM:         "qgjWRf2it0vv2bwJ",
  AERO_LOOT:         "5MUf38xSGYoYG6WW",   // was an "Ice Stone" — Cryo copy-paste residue
  AERO_BUMP:         "08OCMi5uBPve0pPL",
  // Reuse the ORIGINAL Eaten AE id on both Aero and Geo rather than minting a
  // new one — a fresh id would leave the old AE doc orphaned at its own key,
  // invisible on the sheet but still in the store. Same id under two different
  // parent keys is fine; the key carries actor + item.
  AERO_EATEN:        "7aKcg16BaqaO9m8t",

  GEO:               "zRuXyepUutM2LY9H",
  GEO_PUFF:          "RriNRMXown9Q90wG",
  GEO_CONSUME:       "Cmf42fkwTOdFgfpb",
  GEO_BOOM:          "8PW8ypra0pBkxKrx",
  GEO_SPELL:         "mVJkZJ0N9Gsbgwx5",
  GEO_BUMP:          "iLwNpoJXRCZH6hkE",
  GEO_LOOT:          "nE7SmGSSmGl0veUL",
  GEO_EATEN:         "7aKcg16BaqaO9m8t",

  // — elemental cycle: new actors —
  PYRO_ACTOR:        "ERT7381Ood5xdrL9",
  PYRO_SPELL:        "rUSwaRzPQwHyngJt",
  PYRO_BUMP:         "GK6VDR6dOtZAlNj7",
  PYRO_PUFF:         "jKYbTFtZKMuvhOGG",
  PYRO_CONSUME:      "rOqoc6mgeyeM1CoY",
  PYRO_BOOM:         "HS2lyODnmjguYEqa",
  PYRO_EATEN:        "DhJYY64iZZjyHAN9",

  CRYO_ACTOR:        "s3PZn3F1rEEOfSKG",
  CRYO_SPELL:        "erJpUugnvfhJadQk",
  CRYO_BUMP:         "TOCIf3Gg4tftUYQH",
  CRYO_PUFF:         "rwCBTY15iElm3yq7",
  CRYO_CONSUME:      "tFl6lds8UqLbwBtt",
  CRYO_BOOM:         "lvsvAx1rI1v5UuzQ",
  CRYO_LOOT:         "qYRqJPMONFgPN1z6",
  CRYO_EATEN:        "QjlZkIflqsKTPwL1",

  ELECTRO_ACTOR:     "YSv1nNWZ5SGDJL5C",
  ELECTRO_SPELL:     "xsBJne1nNLAwbUyq",
  ELECTRO_BUMP:      "orWbZbfbtZJithJF",
  ELECTRO_PUFF:      "H0meHXZybKPWBKqR",
  ELECTRO_CONSUME:   "93jPWbWOYfEafpR4",
  ELECTRO_BOOM:      "nYxEsOZ5KJkS6NGN",
  ELECTRO_EATEN:     "yRGmfCzSFCWAEMlD",

  PHOBO_ACTOR:       "oclPc7ibfLZKdXmg",
  PHOBO_SPELL:       "ns0O6pSdImlOlp9d",
  PHOBO_BUMP:        "DAKn401jop75tKgd",
  PHOBO_PUFF:        "VeEegE0oO43KZqxU",
  PHOBO_CONSUME:     "9kqg6wZiotfqOd0n",
  PHOBO_BOOM:        "pjAMOiD4uRmpRn98",
  PHOBO_EATEN:       "GRriQ277Is9MRvCa",
};

// World items cloned as a Gorger's stealable drop. Only three of the six
// elements have a Stone authored — Fire, Bolt and Dark do not exist yet, so
// those Gorgers ship with no steal table rather than inventing an item.
const STONE = {
  air:   "W12k5UVEouxIPrDf",   // Wind Stone
  earth: "6wg3JxDlU6GD4uqq",   // Earth Stone
  ice:   "rhUHerukYc4ZY2LB",   // Ice Stone
};

// Affinity prop index (apply-damage-core ELEMENT_AFFINITY_KEY).
const AFFINITY = {
  physical: 1, air: 2, bolt: 3, dark: 4, earth: 5,
  fire: 6, ice: 7, light: 8, poison: 9,
};

// Filler monsters live in the Monster folder, NOT Current Dungeon — the latter
// rotates with the campaign and these are meant to outlive any one dungeon.
const FOLDER_MONSTER = "Nd8LnosrPid1eX1r";

// ── donors ──────────────────────────────────────────────────────────────────
// Clone-don't-construct: an item built from scratch misses template-stamped
// props. Same donors the Valley of the Dragon build used.
const DONOR_ACTOR       = "kAYN54Id3iTAOw1A";        // Ampere
const DONOR_ATTACK      = "25CGufwQTX7ZHwW6";        // Ampere / Bubble Beam
const DONOR_PASSIVE     = "IQjzHjHJRozJJ4Oe";        // Ampere / Volt Counter
const DONOR_SPELL_ACTOR = "sTGMdYipYCG36aBO";        // Lightning Prism
const DONOR_SPELL       = "pV3KgStkZyidF4uD";        // Fulgur Finis

// ── content links ───────────────────────────────────────────────────────────
const link = (uuid, label) => {
  const type = uuid.split(".")[0];
  const tip = type === "Item" ? "Item" : "Journal Entry";
  return `<a class="content-link" data-uuid="${uuid}" data-id="${uuid.split(".").pop()}" data-type="${type}" data-tooltip="${tip}"><strong>${label}</strong></a>`;
};

const L = {
  physical: link("Item.XpKZuGo3VmT0TlTu", "Physical"),
  air:      link("Item.imkMQLnCLaFbaS6Y", "Air"),
  bolt:     link("Item.5XAuMMbDPlLzhJLw", "Bolt"),
  dark:     link("Item.vKU8UYT6DBhgOjtE", "Dark"),
  earth:    link("Item.ZyOMe6IkUTlBzfjw", "Earth"),
  fire:     link("Item.0sFCVCoM6FRrQP2f", "Fire"),
  ice:      link("Item.Osq3NN3QCtiW7otU", "Ice"),
  light:    link("Item.IQaK3IzvfFp4I1xB", "Light"),
  poison:   link("Item.tDcCWc67Ary9nVxe", "Poison"),
  // keywords / statuses
  trigger:  link("JournalEntry.P7eaFojxra2gTRTG", "Trigger"),
  multi:    link("JournalEntry.Gm3upxgpUVoLSK5u", "Multi"),
  burn:     link("JournalEntry.MSRXG4jUMPFpM9sN", "Burn"),
  slow:     link("JournalEntry.HHmYmj7xffQMqtzT", "Slow"),
  dazed:    link("JournalEntry.3nmUvPei3zrOJkEt", "Dazed"),
  shaken:   link("JournalEntry.ImFKpNNGjstom7Q9", "Shaken"),
};

const bullets = (...items) => `<ul>${items.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const trig = (cond) => `${L.trigger}&nbsp;${cond}`;

// ── icons ───────────────────────────────────────────────────────────────────
const SK = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/";
const ICON = {
  melee:    SK + "Epic%207/show%20-%202025-07-20T213340.615.png",
  range:    SK + "Epic%207/show%20-%202025-07-20T213353.399.png",
  passive:  SK + "Tree%20of%20Savior/Archer/icon_arch_burrow.png",
  reaction: SK + "Epic%207/show%20-%202025-07-20T213702.523.png",
  ospell:   SK + "Epic%207/show%20-%202025-07-20T213409.361.png",
  consume:  SK + "Epic%207/show%20-%202025-07-20T215350.578.png",
  run:      SK + "Elsword/Rena/CombatRangerSkill7.png",
  puffup:   SK + "Epic%207/show%20-%202025-07-20T214820.874.png",
  residue:  SK + "FFXIVIcons%20Battle(PvE)/15_RDM/dualcast.png",
  heal:     SK + "FFXIVIcons%20Battle(PvE)/04_WHM/enhanced_healing_magic.png",
};

const ART = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/";

// ── the Eaten counter ───────────────────────────────────────────────────────
// ONE shared mechanic across the whole family. For the thief pair it is a
// boolean ("has it fed yet?") that flips the AI to flight; for the elemental
// cycle it is the detonation clock.
//
// ⚠ lifetimeMode MUST be `persistent_counter`. Any other lifetime is reaped at
// the bearer's own next turn start, which for a monster whose entire design is
// "it remembers that it ate" means the counter is gone before it can ever be
// read. (Same trap Drakoza's Fury hit.)
function eatenAE(id, actorId, itemId, flavor) {
  return {
    _id: id,
    name: "Eaten",
    img: ICON.consume,
    icon: ICON.consume,
    transfer: false,
    disabled: false,
    changes: [],
    statuses: [],
    description: `<p>${flavor}</p>`,
    duration: {},
    origin: `Actor.${actorId}.Item.${itemId}`,
    system: { tags: ["gorger_eaten"] },
    flags: {
      "fabula-ultima-companion": {
        crossScene: false,
        charges: 1,
        lifetimeMode: "persistent_counter",
      },
    },
  };
}

// ── the elemental cycle ─────────────────────────────────────────────────────
// Six Gorgers, one chassis. Each ABSORBS its own element and is VULNERABLE to
// its opposite, so the wheel closes: fire<->ice, air<->earth, dark<->light.
// Bolt has no natural opposite in FU, so Electro is grounded by earth.
//
// `spellSrc` is the world item the NPC spell is cloned from — the party's own
// basic elemental spells, reshaped for NPC use (class NPC, isFacet off,
// isOffensiveSpell + isCheck on, or the NPC attack picker will not offer it).
//
// `rider` is the status the detonation leaves behind. All six come from the
// world debuff library (Item.XVOWOq9oUmEECGrU) by bare name — nothing invented.
// Note Aero's: the old passive promised "-X Ranged accuracy", which was never
// implemented anywhere. Obscure is the real engine effect for that idea
// (disable_attack_range: ranged).
const CYCLE = [
  { key: "PYRO",    name: "Pyro Gorger",    element: "fire",  vu: "ice",   attribute: "FIRE",
    art: "Pyro%20Eater.png",     spell: "Ignis",   spellSrc: "EJ8qEpVDNMA0I1fi",
    rider: "Burn",    riderLink: "burn",
    align: "Fire-Align",  flavor: "a fat, grinning sphere of banked embers" },
  { key: "CRYO",    name: "Cryo Gorger",    element: "ice",   vu: "fire",  attribute: "ICE",
    // Glacies exists only as an actor-embedded item; there is no world copy.
    art: "Cryo%20Eater.png",     spell: "Glacies",
    spellSrc: "WhQkZuDMEraweEcP", spellSrcActor: "2oGGVHp4r8APG2Eu",
    rider: "Slow",    riderLink: "slow",
    align: "Ice-Align",   flavor: "a rime-crusted bladder that creaks as it fills" },
  { key: "AERO",    name: "Aero Gorger",    element: "air",   vu: "earth", attribute: "WIND",
    art: "Aero_Gorger_Standard.png", spell: "Ventus", spellSrc: "jLC0QzPXwRrpkY1e",
    rider: "Obscure", riderLink: null,
    align: "Wind-Align",  flavor: "a knot of hissing wind with something solid at the middle" },
  { key: "GEO",     name: "Geo Gorger",     element: "earth", vu: "air",   attribute: "EARTH",
    art: "Geo%20Eater.png",      spell: "Terra",   spellSrc: "oB6zQngnzWyl3VLx",
    rider: "Weak",    riderLink: null,
    align: "Earth-Align", flavor: "a lumpen ball of packed grit and stone" },
  { key: "ELECTRO", name: "Electro Gorger", element: "bolt",  vu: "earth", attribute: "BOLT",
    art: "Electro%20Eater.png",  spell: "Fulgur",  spellSrc: "9NedNyPRoLHZEmMX",
    rider: "Dazed",   riderLink: "dazed",
    align: "Bolt-Align",  flavor: "a crackling sac that stands every hair in the room on end" },
  { key: "PHOBO",   name: "Phobo Gorger",   element: "dark",  vu: "light", attribute: "DARK",
    art: "Phobo%20Gorger.png",   spell: "Umbra",   spellSrc: "vlUneeNRfgFVzK2E",
    rider: "Shaken",  riderLink: "shaken",
    align: "Dark-Align",  flavor: "a swollen bruise of a thing that drinks the lamplight" },
];

// ── preserveIdentity ────────────────────────────────────────────────────────
// ⚠ CALL THIS whenever blankActor REBUILDS AN ACTOR THAT ALREADY EXISTS.
//
// `blankActor` clones the DONOR wholesale, so the result carries the donor's
// `flags` and `prototypeToken` and a hard-set `ownership = { default: 0 }`. That
// is fine for a NEW actor (nothing to lose) and silently LOSSY for a rebuild:
// the 2026-08-27 Gorger pass dropped 43 prototypeToken flags off Aero alone
// (Border-Control, barbrawl resource bars), plus idle-animation flags, the GM's
// ownership entry and the actor's creation stats.
//
// It survived the first audit because that audit diffed against a local HEAD
// which already contained the rebuild — comparing the output to itself. Diff a
// rebuild against the last PUSHED baseline, not against your own work.
//
// Restores prototypeToken.**flags** only, never the whole prototypeToken: the
// art fix lives in prototypeToken.texture.src and must not be rolled back.
// Sheet-mirror lists are deliberately untouched — dropping a stale mirror row is
// usually the point of a rebuild.
function preserveIdentity(rebuilt, original) {
  if (!original) return rebuilt;
  if (original.ownership) rebuilt.ownership = JSON.parse(JSON.stringify(original.ownership));
  if (original.flags && Object.keys(original.flags).length) {
    rebuilt.flags = JSON.parse(JSON.stringify(original.flags));
  }
  const tokFlags = original.prototypeToken?.flags;
  if (tokFlags && Object.keys(tokFlags).length) {
    rebuilt.prototypeToken = rebuilt.prototypeToken ?? {};
    rebuilt.prototypeToken.flags = JSON.parse(JSON.stringify(tokFlags));
  }
  if (original._stats) {
    rebuilt._stats = rebuilt._stats ?? {};
    if (original._stats.createdTime != null) rebuilt._stats.createdTime = original._stats.createdTime;
    if (original._stats.duplicateSource != null) rebuilt._stats.duplicateSource = original._stats.duplicateSource;
  }
  return rebuilt;
}

module.exports = {
  IDS, FOLDER_MONSTER, STONE, AFFINITY, CYCLE,
  DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, DONOR_SPELL_ACTOR, DONOR_SPELL,
  link, L, bullets, trig, ICON, ART, eatenAE, preserveIdentity,
};
