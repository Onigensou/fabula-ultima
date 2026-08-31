// Shared content definitions for the Fafnir Castle roster (final dungeon).
// Death Gazer / Dire Orc / Iron Colossus / Succubus (soldiers + one elite) and
// Hilde-Fafnir (champion, final boss). See the session plan.
//
// Sizing is against an L45-50 party (baseline DPR ~105, PE 17% -> ~158 effective
// DPR). All five are PLACEHOLDERS meant to be tuned in play, so every number
// here is a starting point, not a settled value.

const IDS = {
  // ── Death Gazer — L50 soldier, gimmick spellcaster ──────────────────────
  DG:          "fCxslZazJKtQWsKP",
  DG_BEAM:     "2ykRRsvYzAbKDjFk",
  DG_SEAR:     "hzb6hDpTEl7SkijL",
  DG_GAZE:     "guM3PAJ3LLLcuBEA",
  DG_UNBLINK:  "ba9EknTOZeIqoQOB",
  // ── Dire Orc — L50 soldier, midrange bruiser ───────────────────────────
  DO:          "rftRuHZwWx5SiNpH",
  DO_CLEAVE:   "OClwP8UL91stAV5t",
  DO_SPLIT:    "gxnIJRcVBVP8M73A",
  DO_HOWL:     "IPgB7f91GpMaQZ3k",
  DO_FURY:     "q2NIu6N6TdhdPxJ8",
  // ── Iron Colossus — L52 elite, tank ────────────────────────────────────
  IC:          "FLy3XRr40wNRmYxV",
  IC_FIST:     "kv2ZeGq61arj5dtG",
  IC_STOMP:    "tSuz5uZWJb65eZ4E",
  IC_QUAKE:    "gAfogT3m3BAMPabJ",
  IC_PLATE:    "LnTfrgzFzJbFhHMm",
  // ── Succubus — L50 soldier, debuffer ───────────────────────────────────
  SU:          "bnem1vdA6Bv3mBVx",
  SU_RAKE:     "iitlLOnNVod66GjL",
  SU_CHARM:    "X6IFQS3RflxhDvyU",
  SU_KISS:     "Mn7LzSfHjvhcLBZs",
  SU_TEMPT:    "BRCBx1Wiudbxux6L",
  // ── Hilde-Fafnir — L55 champion, final boss ────────────────────────────
  HF:          "2SFrEMqLBfqzc7Nj",
  HF_LANCE:    "fA6feEtGFrfjrMAP",
  HF_BREATH:   "7wOhRfCoYWhuVkLn",
  HF_RUIN:     "IoQn3JsHHcqGNM4U",
  HF_CROWN:    "csviMSGyPvawLkyW",
  // ── Carlbero — L50 elite, solo (Malboro parody, plant debuffer) ────────
  CB:          'B4qRdBIxFN6dZ6MT',
  CB_SLAP:     'aL8M4ZB1s4i6wgSG',
  CB_GRAB:     'b7Y9eRcNEGOUthwH',
  CB_SAP:      'sn3eTbtgsHfEm7Y9',
  CB_BREATH:   'YNV6oPSbTyywkT5r',
  // ── AEs added to the shared Debuff container ───────────────────────────
  AE_TEMPT:    "x46iKjWCaZylSb9R",   // Deadly Temptation (Charmed rider)
  AE_SPENT:    "3THoUX00A2aDDmrZ",   // Lance Spent (once-per-fight marker)
};

// New Actor folder: The Legend of Dragonslayer / Monster / Fafnir Castle.
// Named for the dungeon's ROLLTABLE folder ("Fafnir Castle", BykuRa1wHg4VliNO)
// so the two trees line up — the area the user calls the Fafnir Palace is that
// same already-built dungeon.
const FOLDER_FAFNIR = "334KROpobXWVeG1Z";
const FOLDER_MONSTER_ROOT = "Nd8LnosrPid1eX1r";

// The shared debuff/AE library every `ae_template_ref` resolves against.
const AE_CONTAINER = "XVOWOq9oUmEECGrU";

// Donors. Clone-don't-construct: an item built from scratch misses
// template-stamped props, and the CSB actor template carries ZERO props so
// there is no blank to copy either.
//
// NOTE: the equivalent comment in _dragon-lib.js calls these "deduped, ~8KB
// each". That is not true of the on-disk docs — `csbLayoutDedup` is on, but
// every one of the world's 108 NPCs still carries a full ~174KB system.body.
// It costs ~200KB per new monster, which at 130MB used of a ~496MB ceiling is
// not worth solving here.
const DONOR_ACTOR = "kAYN54Id3iTAOw1A";        // Ampere
const DONOR_ATTACK = "25CGufwQTX7ZHwW6";       // Ampere / Bubble Beam  (Attack + on-hit AE rider)
const DONOR_PASSIVE = "IQjzHjHJRozJJ4Oe";      // Ampere / Volt Counter (Passive, isReaction)
const DONOR_SPELL_ACTOR = "sTGMdYipYCG36aBO";  // Lightning Prism
const DONOR_SPELL = "pV3KgStkZyidF4uD";        // Fulgur Finis (Spell, offensive)

// ── content links (keyword-registry.js) ────────────────────────────────────
const link = (uuid, label) => {
  const type = uuid.split(".")[0];
  const tip = type === "Item" ? "Item" : "Journal Entry";
  return `<a class="content-link" data-uuid="${uuid}" data-id="${uuid.split(".").pop()}" data-type="${type}" data-tooltip="${tip}"><strong>${label}</strong></a>`;
};
const L = {
  physical: link("Item.XpKZuGo3VmT0TlTu", "Physical"),
  dark:     link("Item.vKU8UYT6DBhgOjtE", "Dark"),
  earth:    link("Item.ZyOMe6IkUTlBzfjw", "Earth"),
  multi:    link("JournalEntry.Gm3upxgpUVoLSK5u", "Multi"),
  pierce:   link("JournalEntry.2hNU23YLpCcZCCmf", "Pierce"),
  trigger:  link("JournalEntry.P7eaFojxra2gTRTG", "Trigger"),
  charm:    link("JournalEntry.x6ByoJnflDAuVn9r", "Charm"),
  shaken:   link("JournalEntry.ImFKpNNGjstom7Q9", "Shaken"),
  poison:   link("Item.tDcCWc67Ary9nVxe", "Poison"),
  grappled: link("JournalEntry.FV8JefaHsehzgXR7", "Grappled"),
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
  charm:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Buff%20Icon/Heart.png",
  domin:    SK + "Epic%207/show%20-%202025-07-20T215904.664.png",
};

// ── art ────────────────────────────────────────────────────────────────────
const BEST = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/";
const ART = {
  DG: BEST + "DeathGaze_Standard.png",
  DO: BEST + "DireOrc_Standard.png",
  IC: BEST + "IronColossus_Standard.png",
  SU: BEST + "Succubus_Standard.png",
  // No boss art yet. Princess Hilde's own portrait stands in — Hilde-Fafnir IS
  // her, wearing the dragon — rather than an svg placeholder that would render
  // as a blank mystery-man on the sheet, the token and all six BD art fields.
  // No Carlbero art on the Forge (probed 2026-08-31: Carlbero/Malboro/Morbol
  // all 404). Bandit Shroom stands in — a carnivorous-plant sprite in the right
  // Bestiary format, so all eight image fields resolve rather than rendering a
  // blank mystery-man on the sheet, the token and the four BD art fields.
  CB: BEST + "BanditShroom_Standard.png",
  HF: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Campaign/The%20Legend%20of%20Dragonslayer/Image/NPCs/Princess%20Hilde/Hilde_Standard.png",
};

// Token scales, eyeballed by the user on Training Ground 2026-08-29 against a
// row of tuned references and the party (the human yardstick sits at 1.44-1.56).
// Recorded here so a re-run reproduces the tuning instead of resetting it to 1.
//
// HF is still 1.0 on purpose — Hilde-Fafnir has no art yet and is wearing
// Princess Hilde's portrait as a stand-in, so there is nothing to size. Tune it
// with the real boss art, not before. Everything else in the champion band sits
// at 2.1-2.56 (⭐️ Wandering Flame 2.56, Gigas 2.45); the Valley's own ⭐️ Fafnir
// is the outlier at 5.0 with `width: 1.5`.
// CB 2.2 is a DELIBERATE placement in the elite band (2.1-2.5), not a tuned
// value — it is a stand-in sprite, so it needs the Training Ground eyeball pass
// once the real Carlbero art lands. Better than 1.0, which would read as chaff.
const SCALE = { DG: 1.26, DO: 1.84, IC: 2.77, SU: 1.04, HF: 1.0, CB: 2.2 };

module.exports = {
  IDS, FOLDER_FAFNIR, FOLDER_MONSTER_ROOT, AE_CONTAINER,
  DONOR_ACTOR, DONOR_ATTACK, DONOR_PASSIVE, DONOR_SPELL_ACTOR, DONOR_SPELL,
  link, L, bullets, trig, ICON, ART, SCALE,
};
