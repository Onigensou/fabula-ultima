#!/usr/bin/env node
"use strict";

// Rewrites `system.props.description` on Valley of the Dragon + Fafnir Castle
// monster actions to the house pattern:
//
//   <one plain sentence of what the creature is doing> <the effect, plainly>
//
// House rules applied:
//   - No metaphor carries mechanical weight. No "the throne room agrees with
//     it", no "blades find nothing to bite".
//   - Flat constants stay (8 per blade, +20 in Crisis, +25, 30, 10). Anything
//     that comes out of a FORMULA (ceil(), min(), per-point rates, caps)
//     becomes a plain "increases with X" — players should not be reverse-
//     engineering the sheet.
//   - Keyword content-link anchors are preserved byte-for-byte and never
//     paraphrased into rules text: the link carries the rules.
//
// TEXT ONLY. No effect_table / reaction_config_table / stat is touched.
//
// Usage:
//   node tools/safe-edit/bin/_retext-dungeon-actions.js --dry-run
//   node tools/safe-edit/bin/_retext-dungeon-actions.js --apply

const { safeEdit, getDoc } = require("../lib");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY = !APPLY;

// ---------------------------------------------------------------------------
// Keyword links — harvested from the shipped descriptions in this same world,
// so they match the existing anchors exactly.
// ---------------------------------------------------------------------------
const L = (label, uuid) => {
  const type = uuid.startsWith("Item.") ? "Item" : "JournalEntry";
  const id = uuid.split(".")[1];
  const tip = type === "Item" ? "Item" : "Journal Entry";
  return `<a class="content-link" data-uuid="${uuid}" data-id="${id}" data-type="${type}" data-tooltip="${tip}"><strong>${label}</strong></a>`;
};

const TRIGGER = L("Trigger", "JournalEntry.P7eaFojxra2gTRTG");
const FIRE = L("Fire", "Item.0sFCVCoM6FRrQP2f");
const BOLT = L("Bolt", "Item.5XAuMMbDPlLzhJLw");
const ICE = L("Ice", "Item.Osq3NN3QCtiW7otU");
const AIR = L("Air", "Item.imkMQLnCLaFbaS6Y");
const PHYS = L("Physical", "Item.XpKZuGo3VmT0TlTu");
const EARTH = L("Earth", "Item.ZyOMe6IkUTlBzfjw");
const DARK = L("Dark", "Item.vKU8UYT6DBhgOjtE");

const PARALYZED = L("Paralyzed", "JournalEntry.GqqgHkKOs0hkghdG");
const OVERFLOW = L("Overflow", "JournalEntry.NUaxIAIPUu5Qnk8l");
const DISARMED = L("Disarmed", "JournalEntry.MM2SvLRyVhazkNq3");
const SILENCE = L("Silence", "JournalEntry.Q8FTFPsXVpNj2zxT");
const MULTI = L("Multi", "JournalEntry.Gm3upxgpUVoLSK5u");
const PIERCE = L("Pierce", "JournalEntry.2hNU23YLpCcZCCmf");
const CRISIS = L("Crisis", "JournalEntry.GJevbCPM8cffm1QM");

const trig = (text) => `<ul><li><p>${TRIGGER}&nbsp;${text}</p></li></ul>`;

// The Asura's Aspect rider list — carried over verbatim from the shipped text.
const ASPECT_RIDERS =
  `<ul>` +
  `<li><p>${BOLT}&nbsp;— the target is left ${PARALYZED}.</p></li>` +
  `<li><p>${FIRE}&nbsp;— the strike gains ${OVERFLOW}.</p></li>` +
  `<li><p>${ICE}&nbsp;— the target is left ${DISARMED}.</p></li>` +
  `<li><p>${AIR}&nbsp;— the target is left ${SILENCE}d.</p></li>` +
  `</ul>`;

const ELEMENTAL_SLASH =
  `<p>Deal ${PHYS}&nbsp;damage to one creature.</p>` +
  `<p>The strike takes on the Asura's current Aspect:</p>` +
  ASPECT_RIDERS;

// ---------------------------------------------------------------------------
// The rewrites. Keyed by full embedded-item UUID.
// ---------------------------------------------------------------------------
const REWRITES = [
  // ---- Asura ------------------------------------------------------------
  {
    uuid: "Actor.0AwQ7wEDz4ISA9mA.Item.nYbYx0X2yfIdteZ7",
    label: "Asura / Elemental Aspect",
    html:
      trig("When the Asura takes elemental damage.") +
      `<p>The Asura gains the Aspect of the triggering element, replacing any Aspect it currently holds.</p>`,
  },
  {
    uuid: "Actor.0AwQ7wEDz4ISA9mA.Item.wUfS7SWAocoznK0n",
    label: "Asura / Four-Armed Fury",
    html:
      `<p>The Asura acts four times each round and enters every conflict with no MP. While in ${CRISIS}, its Elemental Slash deals <strong>20</strong> extra damage.</p>`,
  },
  {
    uuid: "Actor.0AwQ7wEDz4ISA9mA.Item.0bN7A6pXFG2cX2q9",
    label: "Asura / Ascension",
    html:
      trig(`When the Asura suffers ${FIRE}, ${BOLT}, ${ICE}&nbsp;or ${AIR}&nbsp;damage.`) +
      `<p>The Asura lights the blade of that element permanently. It is <strong>Vulnerable</strong> to each element until that blade is lit, and <strong>Resistant</strong> to it afterwards. Its Elemental Slash deals <strong>8</strong> extra damage for each lit blade.</p>` +
      `<p>Its own Sword Enchants light blades the same way an enemy's damage does. With all four blades lit, the Asura can use <strong>Quad-Elemental Slash</strong>.</p>`,
  },
  {
    uuid: "Actor.0AwQ7wEDz4ISA9mA.Item.ohrbXuZkGB4hNrPp",
    label: "Asura / Elemental Slash",
    html: ELEMENTAL_SLASH,
  },
  {
    uuid: "Actor.0AwQ7wEDz4ISA9mA.Item.NkLZkuMIVqAZJgXl",
    label: "Asura / Elemental Slash (Enchanted)",
    html: ELEMENTAL_SLASH,
  },
  {
    uuid: "Actor.0AwQ7wEDz4ISA9mA.Item.NFruWlBHrgfNSJmM",
    label: "Asura / Quad-Elemental Slash",
    html:
      `<p>The Asura's four blades fall in a single flurry. Deal <strong>devastating</strong> ${BOLT}, ${FIRE}, ${ICE}&nbsp;and ${AIR}&nbsp;damage — four separate strikes, each landing automatically on a random foe.</p>` +
      `<p>Afterwards the Asura loses all of its Aspects and lit blades, and is <strong>Vulnerable</strong> to all four elements again.</p>`,
  },

  // ---- Mist Dragon ------------------------------------------------------
  {
    uuid: "Actor.8kluKkqkcGFkmXNO.Item.f6bn9d3f5NIdXbbA",
    label: "Mist Dragon / Phantom Shift",
    html:
      `<p>The Mist Dragon copies attacks from other creatures of the valley. Every copied attack deals ${AIR}&nbsp;damage instead of its original element.</p>`,
  },
  {
    uuid: "Actor.8kluKkqkcGFkmXNO.Item.vvdntvwGzqaQ3m41",
    label: "Mist Dragon / Illusory Form",
    html:
      trig(`the Mist Dragon suffers ${AIR}&nbsp;damage`) +
      `<p>The Mist Dragon is <strong>Resistant</strong> to ${PHYS}&nbsp;damage. Suffering ${AIR}&nbsp;damage removes this until the <strong>end of the round</strong>, when it returns. It also gains this at the start of a conflict.</p>`,
  },
  {
    uuid: "Actor.8kluKkqkcGFkmXNO.Item.zv0kGWfm8fpxeSC4",
    label: "Mist Dragon / Phantom Shift: Mana Stinger",
    html:
      `<p>Deal ${AIR}&nbsp;damage to one creature and drain a portion of its MP. Bonus damage increases with the MP drained.</p>`,
  },

  // ---- Iron Colossus ----------------------------------------------------
  {
    uuid: "Actor.FLy3XRr40wNRmYxV.Item.gAfogT3m3BAMPabJ",
    label: "Iron Colossus / Grinding Quake",
    html: `<p>Deal <strong>light</strong> ${EARTH}&nbsp;damage to all enemies.</p>`,
  },
  {
    uuid: "Actor.FLy3XRr40wNRmYxV.Item.tSuz5uZWJb65eZ4E",
    label: "Iron Colossus / Seismic Stomp",
    html:
      `<ul><li><p>${MULTI}<strong>&nbsp;3</strong></p></li></ul>` +
      `<p>The Iron Colossus stamps the ground. Deal <strong>light</strong> ${EARTH}&nbsp;damage.</p>`,
  },

  // ---- Drakoza ----------------------------------------------------------
  {
    uuid: "Actor.H6Ubup6kmkgNQzLU.Item.vP0c8mCKoBQY4ggP",
    label: "Drakoza / Drako Fury",
    html:
      `<p>Whenever the Drakoza loses HP, it gains <strong>Fury</strong> equal to the damage taken.</p>`,
  },
  {
    uuid: "Actor.H6Ubup6kmkgNQzLU.Item.HU5v0qJ2gB1DmipK",
    label: "Drakoza / Thrash",
    html:
      `<p>The Drakoza thrashes around. Deal <strong>heavy</strong> ${PHYS}&nbsp;damage to one creature. This attack consumes all of its <strong>Fury</strong> to deal bonus damage.</p>`,
  },

  // ---- Skizzik ----------------------------------------------------------
  {
    uuid: "Actor.I2sSkVIQ4FCunZBE.Item.2nHv9Fvn5En9wL3S",
    label: "Skizzik / Static Buildup",
    html:
      trig("Whenever the Skizzik deals damage to an enemy") +
      `<p>The Skizzik gains 1 <strong>Static</strong>. On the <strong>third</strong>, it deals <strong>30</strong> ${BOLT}&nbsp;damage to that creature and loses all <strong>Static</strong>.</p>`,
  },
  {
    uuid: "Actor.I2sSkVIQ4FCunZBE.Item.oezr2w4m0LMEFM6F",
    label: "Skizzik / Overload Riposte",
    html:
      trig(
        "When an attack strikes the Skizzik and the Result of the attacker's Accuracy Check was an <strong>even number</strong>"
      ) +
      `<p>The Skizzik immediately performs a <strong>free</strong> ${BOLT}&nbsp;riposte against the attacker. ${BOLT}&nbsp;damage does not trigger this.</p>`,
  },

  // ---- Kirin ------------------------------------------------------------
  {
    uuid: "Actor.TvLv878yZLNUAWNN.Item.zNhzAhg1phFoHW8q",
    label: "Kirin / Rail Stream",
    html:
      `<ul><li><p>${PIERCE}</p></li><li><p>${OVERFLOW}</p></li></ul>` +
      `<p>The Kirin looses everything gathered in its horn.</p>` +
      `<p>Consume all MP, then deal ${BOLT}&nbsp;damage to all enemies with a chance to inflict ${PARALYZED}. Both the damage and that chance increase with the MP consumed.</p>`,
  },

  // ---- Hilde-Fafnir -----------------------------------------------------
  {
    uuid: "Actor.2SFrEMqLBfqzc7Nj.Item.IoQn3JsHHcqGNM4U",
    label: "Hilde-Fafnir / Lance of Ruin",
    html:
      `<p>Hilde-Fafnir levels the Lance at the party. <strong>Every enemy is reduced to 1 Hit Point.</strong></p>` +
      `<p>Usable once per conflict.</p>`,
  },

  // ---- Death Gazer ------------------------------------------------------

  // ---- Succubus ---------------------------------------------------------
  {
    uuid: "Actor.bnem1vdA6Bv3mBVx.Item.Mn7LzSfHjvhcLBZs",
    label: "Succubus / Draining Kiss",
    html:
      `<p>Deal ${DARK}&nbsp;damage to one creature. The Succubus recovers HP equal to half the damage dealt.</p>`,
  },

  // ---- Dire Orc ---------------------------------------------------------
  {
    uuid: "Actor.rftRuHZwWx5SiNpH.Item.q2NIu6N6TdhdPxJ8",
    label: "Dire Orc / Brutish Fury",
    html:
      trig("the Dire Orc is at half Hit Points or below") +
      `<p>The Dire Orc deals <strong>25</strong> extra damage with all of its attacks.</p>`,
  },
  {
    uuid: "Actor.rftRuHZwWx5SiNpH.Item.gxnIJRcVBVP8M73A",
    label: "Dire Orc / Skull Splitter",
    html:
      `<ul><li><p>${PIERCE}</p></li></ul>` +
      `<p>Deal <strong>heavy</strong> ${PHYS}&nbsp;damage to one creature.</p>`,
  },

  // ---- Mana Ray ---------------------------------------------------------
  {
    uuid: "Actor.iGc0EUHE9LKWT0Ye.Item.lK1xNxttDeXzwhVh",
    label: "Mana Ray / Mana Stinger",
    html:
      `<p>Deal <strong>light</strong> ${DARK}&nbsp;damage to one creature and drain <strong>20%</strong> of its maximum MP. Bonus damage increases with the MP drained.</p>`,
  },

  // ---- Ampere -----------------------------------------------------------
  {
    uuid: "Actor.kAYN54Id3iTAOw1A.Item.IQjzHjHJRozJJ4Oe",
    label: "Ampere / Volt Counter",
    html:
      trig(
        "When the Ampere is struck by damage and the Result of the attacker's Accuracy Check was an <strong>even number</strong>"
      ) +
      `<p>The Ampere discharges, dealing 10 ${BOLT}&nbsp;damage to every other creature in the conflict, its own allies included.</p>`,
  },

  // ---- Obsidrax ---------------------------------------------------------
  {
    uuid: "Actor.x8TBsDZaRgoSo5no.Item.blW2o4tFoB0oVzEM",
    label: "Obsidrax / Lodestone Core",
    html:
      trig(
        "At the start of the Obsidrax's turn, while it holds the <strong>Lightning Rod</strong>"
      ) +
      `<p>The Obsidrax discharges the stored charge beneath one random enemy, dealing 30 ${EARTH}&nbsp;damage. The <strong>Lightning Rod</strong> passes to that creature.</p>`,
  },
];

// ---------------------------------------------------------------------------

const strip = (h) =>
  String(h || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();

(async () => {
  console.log(`[retext] mode=${APPLY ? "APPLY" : "DRY-RUN"} targets=${REWRITES.length}\n`);
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of REWRITES) {
    const doc = await getDoc(r.uuid);
    if (!doc) {
      console.error(`✗ ${r.label} — NOT FOUND (${r.uuid})`);
      failed++;
      continue;
    }
    const before = doc.system?.props?.description || "";
    if (before === r.html) {
      console.log(`= ${r.label} — already current, skipping`);
      skipped++;
      continue;
    }

    console.log(`— ${r.label}`);
    console.log(`  OLD: ${strip(before)}`);
    console.log(`  NEW: ${strip(r.html)}`);

    if (DRY) {
      ok++;
      console.log("");
      continue;
    }

    try {
      const res = await safeEdit({
        uuid: r.uuid,
        patch: { "system.props.description": r.html },
        note: "Action text pass — house pattern (plain flavor + plain effect)",
      });
      console.log(`  OK backup=${res.backupPath}\n`);
      ok++;
    } catch (e) {
      console.error(`  FAILED: ${e.message}\n`);
      failed++;
    }
  }

  console.log(
    `\n[retext] ${APPLY ? "written" : "would write"}=${ok} skipped=${skipped} failed=${failed}`
  );
  if (failed) process.exitCode = 1;
})();
