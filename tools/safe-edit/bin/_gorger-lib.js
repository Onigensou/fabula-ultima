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

module.exports = {
  IDS, FOLDER_MONSTER,
  DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, DONOR_SPELL_ACTOR, DONOR_SPELL,
  link, L, bullets, trig, ICON, ART, eatenAE,
};
