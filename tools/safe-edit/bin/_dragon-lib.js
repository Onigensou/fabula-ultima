// Shared content definitions for the Valley of the Dragon additions.
// Mist Dragon (elite) + Drakoza (soldier). See the session plan.

const IDS = {
  DRAKOZA:        "H6Ubup6kmkgNQzLU",
  DK_CLAW:        "kP5nGNoNUV2Q7AhM",
  DK_TAIL:        "h6YfA3CbD5IBMeXs",
  DK_THRASH:      "HU5v0qJ2gB1DmipK",
  DK_FURY:        "vP0c8mCKoBQY4ggP",
  DK_FURY_AE:     "QzDGD8rwdkyysoyz",
  MIST:           "8kluKkqkcGFkmXNO",
  MD_CLAW:        "crizxSUcTFdlJKpi",
  MD_BREATH:      "CtR3hgvUBHBQ8r7S",
  MD_ILLUSORY:    "vvdntvwGzqaQ3m41",
  MD_ILLUSORY_AE: "mCnN3sS8zwYPOZox",
  MD_PHANTOM:     "f6bn9d3f5NIdXbbA",
  MD_PS_STRIKE:   "Iobix2EOuXqGNH6X",
  MD_PS_SPINES:   "fecg9O0PTPyAsxVj",
  MD_PS_STINGER:  "zv0kGWfm8fpxeSC4",
};

const FOLDER_CURRENT_DUNGEON = "4gMC1IxdJlF59BSi";

// Donors (deduped — empty system.body/header, ~8KB each)
const DONOR_ACTOR = "kAYN54Id3iTAOw1A";               // Ampere
const DONOR_ATTACK = "25CGufwQTX7ZHwW6";              // Ampere / Bubble Beam  (Attack + on-hit AE rider)
const DONOR_PASSIVE = "IQjzHjHJRozJJ4Oe";             // Ampere / Volt Counter (Passive, isReaction)
const DONOR_SPELL_ACTOR = "sTGMdYipYCG36aBO";         // Lightning Prism
const DONOR_SPELL = "pV3KgStkZyidF4uD";               // Fulgur Finis (Spell, offensive)

// ── content links (keyword-registry.js) ────────────────────────────────────
const link = (uuid, label) => {
  const type = uuid.split(".")[0];
  const tip = type === "Item" ? "Item" : "Journal Entry";
  return `<a class="content-link" data-uuid="${uuid}" data-id="${uuid.split(".").pop()}" data-type="${type}" data-tooltip="${tip}"><strong>${label}</strong></a>`;
};
const L = {
  physical:   link("Item.XpKZuGo3VmT0TlTu", "Physical"),
  air:        link("Item.imkMQLnCLaFbaS6Y", "Air"),
  dark:       link("Item.vKU8UYT6DBhgOjtE", "Dark"),
  light:      link("Item.IQaK3IzvfFp4I1xB", "Light"),
  blind:      link("JournalEntry.rBnvYhLfmrVZDdoW", "Blind"),
  multi:      link("JournalEntry.Gm3upxgpUVoLSK5u", "Multi"),
  trigger:    link("JournalEntry.P7eaFojxra2gTRTG", "Trigger"),
};
const bullets = (...items) => `<ul>${items.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const trig = (cond) => `${L.trigger}&nbsp;${cond}`;

// ── icons (reference_generic_action_icons) ─────────────────────────────────
const SK = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/";
const ICON = {
  melee:    SK + "Epic%207/show%20-%202025-07-20T213340.615.png",
  range:    SK + "Epic%207/show%20-%202025-07-20T213353.399.png",
  passive:  SK + "Tree%20of%20Savior/Archer/icon_arch_burrow.png",
  reaction: SK + "Epic%207/show%20-%202025-07-20T213702.523.png",
  ospell:   SK + "Epic%207/show%20-%202025-07-20T213409.361.png",
};

module.exports = { IDS, FOLDER_CURRENT_DUNGEON, DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, DONOR_SPELL_ACTOR, DONOR_SPELL, link, L, bullets, trig, ICON };
