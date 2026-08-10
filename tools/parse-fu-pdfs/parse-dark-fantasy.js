// Dark Fantasy Classes v0.2 → skills.json
//
//   Aaron Jolliffe, "Dark Fantasy Classes" v0.2 (2025), published under the
//   Fabula Ultima Third-Party Tabletop License 1.0. NOT a Need Games book.
//   Everything this parser adds is flagged `third_party: true` so it is never
//   mistaken for official RAW — treat its balance as provisional.
//
// Adds:
//   • classes.Hexer  — 5 skills + 12 Hexer spells
//   • classes.Slayer — 5 skills
//   • classes.Tamer  — 5 skills + the Negotiation subsystem
//   • lineage_traditions — the optional Lineage system's 3 Traditions
//     (Fated Bloodline / Holy Order / Outcasts), 5 skills each, plus the
//     Lineage Turn / epilogue procedure.
//
// WHY THIS ONE IS CURATED, NOT SCRAPED
// ------------------------------------
// The other parse-*.js scrape `pdftotext -layout` output. That does not work
// here: this book is a two-column zine and the Hexer spell table is printed as
// two side-by-side tables, so a single -layout line carries text from BOTH
// columns ("Acid Splash 10 One creature Instantaneous  Pressure 5×T ...").
// Worse, the "offensive spell" marker is an orange lightning-bolt glyph with no
// ToUnicode mapping — pdftotext drops it entirely, leaving "offensive ( )".
// Every offensive flag below was read off a 3x page render (pymupdf), not
// inferred from the wording.
//
// So the content is curated. To keep that honest, every `description` is
// VERIFIED verbatim against the reflowed `pdftotext -raw` extraction on each
// run (see verify() below) — the script fails loudly on any drift rather than
// silently trusting the transcription.
//
// Usage:
//   node tools/parse-fu-pdfs/parse-dark-fantasy.js [--dry-run] [--no-verify]
//                                                  [--txt <raw-extract.txt>]
//
// The raw extract is produced with:
//   pdftotext -enc UTF-8 "reference/fabula-pdfs/Dark_Fantasy_Classes_v0.2.pdf" out.txt
// (note: -raw/default flow, NOT -layout — we want one paragraph per line)
// and is regenerated automatically when pdftotext is on PATH.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DEST = process.env.SKILLS_JSON ?? path.join(
  REPO, 'modules', 'fabula-ultima-companion', 'reference', 'skills.json',
);
const PDF = path.join(REPO, 'reference', 'fabula-pdfs', 'Dark_Fantasy_Classes_v0.2.pdf');
const BOOK = 'dark-fantasy';

const SOURCE_META = {
  title: 'Dark Fantasy Classes v0.2',
  file: 'Dark_Fantasy_Classes_v0.2.pdf',
  phase: 'shipped',
  author: 'Aaron Jolliffe (https://jolliffe.itch.io/)',
  license: 'Fabula Ultima Third-Party Tabletop License 1.0',
  third_party: true,
  note:
    'Third-party homebrew at v0.2, NOT a Need Games book. Sole source for the '
    + 'Hexer, Slayer and Tamer class templates in the world. Balance is '
    + 'provisional — confirm intent with the user rather than citing it as RAW.',
};

// ── Notation ────────────────────────────────────────────────────────────────
// The book wraps mechanical values in decorative 【brackets】 (【SL × 2】) and
// marks offensive spells with a lightning-bolt glyph. Stored descriptions drop
// the brackets (matching the Core entries' plain "SL × 2") and render the glyph
// as "(⚡)" where the book prints it inline. `is_offensive` carries the
// machine-readable form.
const OFFENSIVE = '(⚡)';

// Two advice bullets overflow their text box in v0.2 and stop mid-sentence.
// That is the BOOK, not the extraction (confirmed on a page render), so the
// text is stored as printed and flagged rather than silently "completed".
const TRUNCATED_IN_BOOK = 'Ends mid-sentence in the v0.2 book — the bullet overflows its text box.';

// ── Content ─────────────────────────────────────────────────────────────────

const HEXER = {
  book: BOOK,
  third_party: true,
  also_known_as: ['Poisoner', 'Saboteur', 'Desecrator'],
  blurb:
    'Hexers are powerful spellcasters who harness the darkest facets of magic. '
    + 'They specialize in curses and toxins, weaving spells that use biting poison, '
    + 'blinding shadows, and malevolent charms to wear their foes down and render '
    + 'them vulnerable.\n\n'
    + 'Many of the Hexer\'s most potent abilities take some setup to prepare, requiring '
    + 'time or assistance from allies to perform the necessary steps. Once the pieces are '
    + 'in place, though, a hexer\'s dark magic is truly fearsome.',
  character_questions: [
    'Did you study your craft, or did something awaken it within you?',
    'Is your power a consequence of past tragedy, or an omen of future peril?',
    'What have you lost or given up in exchange for your power?',
    'What does your magic look like?',
  ],
  free_benefits: [
    'Permanently increase your maximum Mind Points by 5.',
    'You may perform Rituals whose effects fall within the Ritualism discipline.',
  ],
  skills: [
    {
      name: 'Curse Magic',
      max_sl: 10,
      skill_type: 'Passive',
      description:
        'Each time you acquire this Skill, learn one Hexer spell (see the following pages).\n\n'
        + `Offensive ${OFFENSIVE} Hexer spells use INS + WLP for the Magic Check.`,
      source: { book: BOOK, page: 1, section: 'HEXER SKILLS' },
    },
    {
      name: 'Curse Ritualism',
      max_sl: 1,
      skill_type: 'Passive',
      description:
        'You may perform rituals whose effects fall within the Spiritism discipline. '
        + 'Spiritism rituals use INS + WLP for the Magic Check. Additionally, you may '
        + 'use Spiritism to locate the sources of illnesses and curses.',
      source: { book: BOOK, page: 1, section: 'HEXER SKILLS' },
    },
    {
      name: 'Encroaching Hex',
      max_sl: 5,
      skill_type: 'Passive',
      description:
        'When you first take this Skill, you gain a Hex Clock with 4 sections. '
        + 'The Clock starts each scene empty.\n\n'
        + `When you perform an attack with an arcane weapon or cast an offensive ${OFFENSIVE} spell, `
        + 'you may spend 10 Hit Points to fill one section of your Hex Clock.\n\n'
        + 'At the start of your turn, you may spend 10 Mind Points. If you do, for each '
        + 'filled section of your Hex Clock, deal SL × 2 dark or poison damage to a '
        + 'creature you can see. You may choose a different creature for each instance of damage.',
      source: { book: BOOK, page: 1, section: 'HEXER SKILLS' },
    },
    {
      name: 'Fell Resonance',
      max_sl: 3,
      skill_type: 'Passive',
      description:
        'When you take the Hinder action and succeed on your Check, the target and each '
        + 'other enemy that has at least one status effect in common with it takes '
        + 'SL × 5 dark or poison damage (your choice).',
      source: { book: BOOK, page: 1, section: 'HEXER SKILLS' },
    },
    {
      name: 'Where Evil Treads',
      max_sl: 1,
      skill_type: 'Passive',
      description:
        'When your group journeys on the world map, you may increase the die rolled for '
        + 'your travel roll by one size (to a maximum of a d12). If you do, you will make '
        + 'a discovery in addition to the normal result of the travel roll.',
      source: { book: BOOK, page: 1, section: 'HEXER SKILLS' },
    },
  ],
  heroic: [],
  spells: [
    {
      name: 'Acid Splash',
      is_offensive: true,
      mp: '10',
      target: 'One creature',
      duration: 'Instantaneous',
      description:
        'You hurl a globule of caustic muck that splatters on impact. A target hit by '
        + 'this spell takes HR+15 poison. Whether the spell hits or misses, up to two '
        + 'creatures other than the initial target each take 5 poison damage.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Aura of Decay',
      is_offensive: false,
      mp: '10',
      target: 'One creature',
      duration: 'Scene',
      description:
        'You cloak the target in a veil of magic that is toxic to enemies. Until this '
        + 'spell ends, any creature that performs a melee attack against the target takes '
        + '5 poison damage. The attacker takes this damage even if the attack misses.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Blind',
      is_offensive: true,
      mp: '20',
      target: 'One creature',
      duration: 'Scene',
      description:
        'You cover the target\'s eyes with pitch-black shadows, blocking their sight. '
        + 'Until the spell ends, the target suffers a -2 penalty to Accuracy Checks. '
        + 'A creature targeted by this spell multiple times does not suffer an additional penalty.\n\n'
        + 'This spell has no effect on creatures that do not rely on sight. An effect that '
        + 'can remove a status effect can end this effect instead.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Deteriorate',
      is_offensive: true,
      mp: '10',
      target: 'One creature',
      duration: 'Scene',
      description:
        'You place a mark on the target\'s soul that weakens their ability to resist '
        + 'afflictions and ailments. Until this spell ends, if an effect would cause the '
        + 'target to recover from one or more status effects, you choose one of those '
        + 'status effects for the target to keep. Once that happens, this spell ends. '
        + 'If the target becomes immune to a status effect, they still recover as normal.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Muddle',
      is_offensive: true,
      mp: '20',
      target: 'One creature',
      duration: 'Scene',
      description:
        'You conjure troubling visions in the target\'s mind, wearing down their focus. '
        + 'Until the spell ends, the target suffers a -2 penalty to Magic Checks. '
        + 'A creature targeted by this spell multiple times does not suffer an additional penalty.\n\n'
        + 'An effect that can remove a status effect can end this effect instead.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Plague',
      is_offensive: true,
      mp: '15',
      target: 'One weak or shaken creature',
      duration: 'Instantaneous',
      description:
        'You cause the target\'s condition to worsen into a debilitating infection. '
        + 'The target recovers from being weak or shaken (you choose one if it has both) '
        + 'and it becomes poisoned.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Pressure',
      is_offensive: true,
      mp: '5 × T',
      target: 'Up to three creatures',
      duration: 'Instantaneous',
      description:
        'You conjure an oppressive atmosphere that amplifies strain on the target\'s mind. '
        + 'The next time a target hit by this spell would spend Mind Points, that creature '
        + 'must spend an additional 10 Mind Points or lose their intended effect.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Seething Blight',
      is_offensive: true,
      mp: '15',
      target: 'One slow or dazed creature',
      duration: 'Instantaneous',
      description:
        'You magnify the target\'s distress into blinding rage. The target recovers from '
        + 'being slow or dazed (you choose one if it has both) and it becomes enraged.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Shadow Mask',
      is_offensive: false,
      mp: '10',
      target: 'One creature',
      duration: 'Scene',
      description:
        'Light bends around your ally to keep them hidden from danger. Until this spell '
        + `ends, the target cannot be selected as a target for an attack or offensive ${OFFENSIVE} `
        + 'spell that has multiple targets.\n\n'
        + 'Additionally, until this spell ends, the target gains a +2 bonus to Checks that '
        + 'involve remaining hidden or moving undetected. A creature gains no additional '
        + 'bonus from being the target of this spell multiple times.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Symptom Shift',
      is_offensive: false,
      mp: '10',
      target: 'One creature',
      duration: 'Instantaneous',
      description:
        'The target chooses one status effect from among slow, dazed, weak, and shaken '
        + 'that they are currently suffering from. They recover from that condition and '
        + 'immediately suffer a different status effect of their choice that they do not already have.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Transfer Life',
      is_offensive: false,
      mp: '10',
      target: 'One willing creature',
      duration: 'Scene',
      description:
        'You briefly connect the threads of life between yourself and the target, allowing '
        + 'one of you to transfer a portion of their vitality to the other. Either you or '
        + 'the target may spend up to 30 Hit Points. The other creature recovers an equal '
        + 'amount of Hit Points.\n\n'
        + 'Additionally, until this spell ends, the creature who recovered Hit Points this '
        + 'way gains a +2 bonus to Checks using MIG that aren\'t Accuracy Checks or Magic '
        + 'Checks. A creature gains no additional bonus from being the target of this spell multiple times.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
    {
      name: 'Venomous Weapon',
      is_offensive: false,
      mp: '10',
      target: 'One equipped weapon',
      duration: 'Scene',
      description:
        'You imbue a weapon with poisonous energy. Until this spell ends, all damage dealt '
        + 'by the weapon becomes of the poison type. If you have that weapon equipped while '
        + 'you cast this spell, you may perform a free attack with it as part of the same action.\n\n'
        + 'This spell can only be cast on a weapon equipped by a willing creature.',
      source: { book: BOOK, page: 2, section: 'HEXER SPELLS' },
    },
  ],
  player_advice: [
    'The Hexer is a dark- and poison-based spellcaster focused on inflicting status '
    + 'effects and other ailments, and dealing small amounts of damage at regular intervals.',
    'Some of the Hexer\'s most powerful effects need some preparation and setup to really '
    + 'get going. When taking Class levels, it can be good to pair Hexer with a Class that '
    + 'work well in the early turns while also ramping up for your Hexer Skills. '
    + 'Coordinate with your teammates, too!',
    'Some of the Hexer\'s spells have additional effects that can be useful outside of '
    + 'Conflict scenes. Give them a look even if you aren\'t otherwise interested in the '
    + 'spell-slinging side of the Class!',
  ],
  gm_advice: [
    'Look to the Hexer when questions arise regarding the dark side of magic and how the '
    + 'mundane parts of the world have been twisted by the supernatural.',
    'Multiple NPC Species have innate Immunity to poison damage, which can reduce the '
    + 'Hexer\'s effectiveness in battle. If there is a significant presence of constructs, '
    + 'elementals, or undead in your campaign, consider pairing them with other species to '
    + 'keep the Hexer\'s options more viable',
    'The Hexer can generate various ongoing conditions that hinder creatures in ways that '
    + 'are different from the common status effects. Remember that NPCs can employ '
    + 'abilities like this too and turn them back on the Players! With that being said, '
    + 'make sure to work out a system for yourself to help you track these long-term effects.',
  ],
};

const SLAYER = {
  book: BOOK,
  third_party: true,
  also_known_as: ['Monster Hunter', 'Ranger', 'Exorcist'],
  blurb:
    'Slayers are skilled hunters who specialize in tracking, studying, and destroying '
    + 'monsters, and who become even more deadly when given time to observe and prepare '
    + 'against their quarry. Over time, many Slayers find themselves becoming more and '
    + 'more like the creatures they face. Some hold tight to their last threads of '
    + 'humanity, while others give into their darker impulses, determined to continue '
    + 'the hunt regardless of personal cost.',
  character_questions: [
    'How has a life of fighting monsters changed you?',
    'What\'s something most people don\'t realize about the true nature of monsters?',
    'Someone hired you, then refused to pay when the job was done. Who was it, and why?',
    'What do your weapons and fighting style look like?',
  ],
  free_benefits: [
    'Permanently increase your maximum Inventory Points by 2.',
    'Gain the ability to equip martial melee weapons and martial ranged weapons',
  ],
  skills: [
    {
      name: 'Bane Oils',
      max_sl: 5,
      skill_type: 'Active',
      description:
        'Each time you take this Skill, choose a creature Species. You may use an action '
        + 'and spend 2 Inventory Points to apply a bane oil for one of your chosen Species '
        + 'to a weapon equipped by you or a willing creature. If you have the weapon '
        + 'equipped, you may perform a free attack with it as part of the same action.\n\n'
        + 'Until the end of the scene or a different bane oil is applied to the weapon, '
        + 'when a creature of the same Species as the bane oil is hit by the weapon, that '
        + 'creature loses one of its damage Resistances and becomes weak. If you know the '
        + 'creature\'s Affinities, you may choose the damage type; otherwise, the GM chooses one at random.',
      source: { book: BOOK, page: 3, section: 'SLAYER SKILLS' },
    },
    {
      name: 'Exploit',
      max_sl: 5,
      skill_type: 'Passive',
      description:
        'When you make an Accuracy Check, Magic Check, or contested Check, you may spend '
        + '1 Fabula Point and invoke one of the target\'s Traits to add SL to your result '
        + 'against that target. A Villain may spend 2 Ultima Points to cancel out this '
        + 'effect. If the Check includes multiple targets, your result against those other '
        + 'targets is unchanged.',
      source: { book: BOOK, page: 3, section: 'SLAYER SKILLS' },
    },
    {
      name: 'Giant Killer',
      max_sl: 1,
      skill_type: 'Passive',
      description:
        'When you hit a non-soldier creature with an attack that deals damage, you deal '
        + 'extra damage equal to 2 × the number of soldiers the creature replaces.',
      source: { book: BOOK, page: 3, section: 'SLAYER SKILLS' },
    },
    {
      name: 'Lockdown',
      max_sl: 4,
      skill_type: 'Passive',
      description:
        'When you hit a creature with an attack you may spend 10 Mind Points and choose '
        + 'one of the target\'s basic attacks or spells. Until the start of your next turn, '
        + 'the target deals SL × 2 less damage with the chosen action.',
      source: { book: BOOK, page: 3, section: 'SLAYER SKILLS' },
    },
    {
      name: 'Wildlife Expert',
      max_sl: 3,
      skill_type: 'Passive',
      description:
        'When you rest in the wilderness, you may ask the Game Master up to SL questions '
        + 'about creatures in the area; the Game Master will answer truthfully.',
      source: { book: BOOK, page: 3, section: 'SLAYER SKILLS' },
    },
  ],
  heroic: [],
  spells: [],
  player_advice: [
    'The Slayer is a physical fighter that is good at combating particular Species and '
    + 'big, dangerous enemies.',
    'The Slayer excels when they have information about their opponents. When you think a '
    + 'battle might be approaching, look for opportunities to observe and study your '
    + 'enemies before the fight starts.',
    'If you choose the Bane Oils Skill, try to choose Species that you think will be '
    + 'common and prevalent throughout the campaign. If you are interested in the Skill but '
    + 'don\'t know what kinds of enemies you\'ll encounter, consider waiting to take the '
    + 'Skill until you have a better feel for the kind of threats the story will hold.',
  ],
  gm_advice: [
    'Look to the Slayer when questions arise regarding the origin, nature, and habits of monsters.',
    'A Slayer with the Bane Oils Skill chooses specific Species of adversary to excel at '
    + 'dealing with. Make sure to send enemies of those species at the Players so that the '
    + 'Slayer can shine!',
    'It costs more for Villains to negate Exploit than it costs for the Slayer to activate '
    + 'it. This is on purpose! Being able to cancel the automatic success helps portray '
    + 'Villains as powerful adversaries, but using it too much',
    'Look for opportunities to let the Slayer study an enemy before a conflict starts.',
  ],
  raw_notes: { 'gm_advice[2]': TRUNCATED_IN_BOOK },
};

const TAMER = {
  book: BOOK,
  third_party: true,
  also_known_as: ['Trainer', 'Devil Summoner', 'Handler'],
  blurb:
    'In matters of survival, one must use the tools that are available. And the world '
    + 'has no shortage of strange and deadly creatures.\n\n'
    + 'While most see them merely as nuisances or threats, Tamers have learned to '
    + 'communicate with them, choosing to understand and negotiate with them, turning '
    + 'them into powerful allies, at least for a while.\n\n'
    + 'Some Tamers even utilize their recruited creatures as more than simple attack '
    + 'dogs, using them to defend allies or even empower their own attacks.',
  character_questions: [
    'How did you learn to tame creatures? Was it by choice or necessity?',
    'How does society see you? Do you provide a valuable service, or are you a threat?',
    'Are there many practicing your art, or are you the exception?',
    'What magic or technology allows you to keep creatures under control?',
  ],
  free_benefits: [
    'Permanently increase your maximum Mind Points by 5.',
  ],
  skills: [
    {
      name: 'All-Out Attack',
      max_sl: 1,
      skill_type: 'Passive',
      description:
        'When you perform an attack, you may spend 10 Mind Points to choose one option: '
        + 'you gain a bonus to your Accuracy Check equal to the number of different '
        + 'attitudes among your recruited creatures; or the attack deals extra damage '
        + 'equal to 2 × the highest number of recruited creatures that have the same attitude.',
      source: { book: BOOK, page: 4, section: 'TAMER SKILLS' },
    },
    {
      name: 'Hybridization',
      max_sl: 1,
      skill_type: 'Passive',
      description:
        'When you rest, you can combine two of your recruited creatures into a single '
        + 'creature. The new creature has the damage Affinities of one of the original '
        + 'creatures and any combination of up to two basic attacks from the original creatures.',
      source: { book: BOOK, page: 4, section: 'TAMER SKILLS' },
    },
    {
      name: 'Interceptor',
      max_sl: 6,
      skill_type: 'Passive',
      description:
        'When another creature you can see would take damage, you may use one of your '
        + 'recruited creatures to reduce that damage by SL × 4. If the recruited creature '
        + 'has Resistance to the damage, the reduction it provides is doubled. When you use '
        + 'a recruited creature this way, you lose all access to it until the end of the scene.',
      source: { book: BOOK, page: 4, section: 'TAMER SKILLS' },
    },
    {
      name: 'Negotiate',
      max_sl: 4,
      skill_type: 'Active',
      description:
        'You may use the Objective action to attempt to recruit a soldier-rank creature of '
        + 'the demon, elemental, monster, or undead Species to join you as an ally. The full '
        + 'rules for negotiation and recruitment can be found on the next page. If you take '
        + 'this Skill at character creation, you begin play with one level 5 creature already recruited.',
      source: { book: BOOK, page: 4, section: 'TAMER SKILLS' },
      subsystem_ref: 'negotiation',
    },
    {
      name: 'Unleash',
      max_sl: 4,
      skill_type: 'Ritual',
      description:
        'You gain the ability to perform Rituals of the Ritualism discipline. Additionally, '
        + 'you may use Ritualism to summon a creature of the GM\'s choosing from the demon, '
        + 'elemental, monster, or undead Species to your location. The level of the summoned '
        + 'creature may be up to SL × 5.\n\n'
        + 'The creature is controlled by the GM and may not be Negotiated with during the '
        + 'same scene in which it was summoned. It\'s already doing you a favor by showing up!',
      source: { book: BOOK, page: 4, section: 'TAMER SKILLS' },
    },
  ],
  heroic: [],
  spells: [],
  player_advice: [
    'The Tamer is a versatile Class that gains abilities by recruiting creatures and '
    + 'turning them into allies. The Tamer can even copy some of their recruited '
    + 'creatures\' damage Affinities to help them adapt to danger during battle.',
    'You don\'t have to wait for a fight to break out to try negotiating! If you come '
    + 'across a demon, elemental, monster, or undead that you think might make for a good ally,',
    'After you learn a creature\'s attitude, keep an eye on the resource you\'ll need to '
    + 'pay to finish recruiting them. You won\'t have a chance to make adjustments once you '
    + 'fill the Negotiation Clock!',
  ],
  gm_advice: [
    'Look to the Tamer when questions arise relating to creature behavior and community.',
    'Creatures of the same type can exhibit different attitudes during negotiation. '
    + 'Remember that the Traits listed in a creature\'s description are only typical '
    + 'examples for that type of creature. For example, one imp might act scared, while '
    + 'another might act angry.',
    'The Tamer depends on having recruited creatures to perform at its best. Make sure '
    + 'they encounter demons, elementals, monsters, and undead to negotiate with!',
  ],
  raw_notes: { 'player_advice[1]': TRUNCATED_IN_BOOK },
  subsystems: {
    negotiation: {
      name: 'Negotiation',
      source: { book: BOOK, page: 5, section: 'NEGOTIATION' },
      required_by: ['Negotiate'],
      beginning: [
        'When you use the Negotiation Skill to attempt to recruit a creature, you gain a '
        + 'Negotiation Clock with 4 sections.',
        'You can only have one Negotiation Clock at a time. If you attempt to negotiate '
        + 'with a different creature, immediately erase all sections of your current Clock '
        + 'and start the new negotiation with an empty Clock.',
      ],
      progressing: [
        'You may use the Objective action (including the action used to begin negotiation) '
        + 'to attempt to fill the Negotiation Clock. Once negotiation has begun, other '
        + 'Players may use actions to help fill the Clock, as normal.',
        'The Attributes used for the negotiation Check are determined by the creature\'s '
        + 'attitude, which the GM will choose from the options below based on its Traits. '
        + 'The creature\'s attitude also determines the cost you must pay to recruit the '
        + 'creature (see Closing Negotiation below).',
        'The difficulty of the negotiation Check is equal to 10 + the creature\'s level - '
        + 'your level (minimum difficulty of 7).',
      ],
      attitudes: [
        { attitude: 'Eager', example_traits: 'Playful, excitable, fast, etc.', check: 'DEX + INS', cost: '1d6 × 5 MP' },
        { attitude: 'Angry', example_traits: 'Tough, destructive, hungry, etc.', check: 'MIT + WLP', cost: '1d6 × 5 HP' },
        { attitude: 'Sneaky', example_traits: 'Clever, curious, silent, etc.', check: 'INS + WLP', cost: '1d6 × 50 zenit' },
        { attitude: 'Scared', example_traits: 'Wary, cold, defensive, etc.', check: 'DEX + WLP', cost: '1d6 IP' },
      ],
      closing: [
        'When you fill the last section of the Negotiation Clock, the creature will demand '
        + 'a cost depending on its attitude.',
        'If you pay the cost, negotiation ends and you successfully recruit the creature. '
        + 'If you are unable or unwilling to pay the cost, the creature loses patience with '
        + 'you and leaves the scene, providing no benefit. You must pay the cost yourself, '
        + 'even if another Player filled the final section of the Clock.',
        'You decide whether or not to pay after rolling dice and seeing the final cost.',
        'When you recruit a creature, write down its name, Species, attitude, basic attacks, '
        + 'one of its damage Resistances and one of its Vulnerabilities. You must choose both '
        + 'a Resistance and a Vulnerability, unless the creature simply lacks one of those '
        + 'options, and you may not choose damage Immunities or Absorptions.',
        'You may have up to SL different creatures recruited at a time. If you recruit a '
        + 'creature but you are already at your limit, you must release one of your current '
        + 'creatures first and replace it with the new creature.',
      ],
      using_recruited_creatures: [
        'You may use an action and spend 10 MP to use one of your recruited creature\'s '
        + 'basic attacks, using your own Attributes for the Accuracy Check.',
        'After you perform an attack this way, whether you hit or miss, your damage '
        + 'Affinities change to match the Affinities chosen when you recruited the creature. '
        + 'This lasts until the start of your next turn. Only your Affinities for the '
        + 'selected elements change this way, and they cannot be changed further until this '
        + 'effect ends. Any other effects that would alter your Affinities for the chosen '
        + 'damage types are suppressed, but will resume when this effect ends.',
        'For example, if an effect makes you Vulnerable to fire damage, but you attack with '
        + 'a recruited creature that has Resistance to fire damage, your Vulnerability is '
        + 'replaced with Resistance. However, if you do not attack with the same recruited '
        + 'creature on your next turn and the other effect is still active, you will lose '
        + 'your Resistance and return to having Vulnerability.',
      ],
    },
  },
};

const LINEAGE_TRADITIONS = {
  'Fated Bloodline': {
    book: BOOK,
    third_party: true,
    also_known_as: ['Royal Family', 'Descendants', 'Legendary Heroes'],
    blurb:
      'The Fated Bloodline is a family destined to continue the fight started by their '
      + 'ancestors. Even if they try to reject it, they will inevitably be drawn into the '
      + 'war sooner or later. Characters of this tradition are trained from childhood to '
      + 'prepare them not only for the battle against evil that they will one day inherit, '
      + 'but also to protect themselves from the enemies who will come looking for them in '
      + 'hopes of snuffing out the family line once and for all.',
    summary: 'A direct family line that protects the weak.',
    character_questions: [
      'Who leads your lineage? How are they chosen?',
      'How did your family\'s fate become entwined with the battle against evil?',
      'What distinct feature or icon identifies you as a scion of the family?',
      'Which ancestor\'s legacy are you trying to live up to?',
    ],
    skills: [
      {
        name: 'Like My Father Before Me',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'Once per session when you act in a way befitting of your family and its '
          + 'reputation, you may gain 1 Fabula Point.',
        source: { book: BOOK, page: 10, section: 'FATED BLOODLINE SKILLS' },
      },
      {
        name: 'Prelude of Destiny',
        max_sl: 4,
        skill_type: 'Passive',
        description:
          'When you rest, you may choose to have your fate resonate with that of a known '
          + 'Villain. Following the rest, your group encounters evidence of their actions.\n\n'
          + 'When you make a Check to prepare for the eventual confrontation with that '
          + 'Villain, you may add SL + the strength of your bond toward that Villain to the '
          + 'result. You may only do this once per use of this Skill, and you lose your '
          + 'previous bonus if you use this Skill again.',
        source: { book: BOOK, page: 10, section: 'FATED BLOODLINE SKILLS' },
      },
      {
        name: 'Pure of Heart',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'During character creation, choose dark or poison. You have Resistance to damage '
          + 'of the chosen type.',
        source: { book: BOOK, page: 10, section: 'FATED BLOODLINE SKILLS' },
      },
      {
        name: 'Superior Cover',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'When you perform the Guard action and cover another creature, you may choose to '
          + `protect them from ranged attacks or offensive ${OFFENSIVE} spells instead of melee attacks.`,
        source: { book: BOOK, page: 10, section: 'FATED BLOODLINE SKILLS' },
      },
      {
        name: 'Unbreakable Resolve',
        max_sl: 5,
        skill_type: 'Passive',
        description:
          'When you are reduced to 0 Hit Points while an elite or champion enemy is present, '
          + 'you may choose to Stand Strong. If you do, you steel yourself and continue '
          + 'fighting despite overwhelming odds. You recover Hit Points equal to your Crisis '
          + 'value and may immediately perform the Guard action to cover up to two other '
          + 'characters. When you cover this way, you gain Immunity to all damage types '
          + 'instead of Resistance.\n\n'
          + 'Additionally, until you are reduced to 0 Hit Points again, your attacks deal SL '
          + 'extra damage to elite and champion enemies.\n\n'
          + 'You may only Stand Strong once, and you may not Stand Strong if another '
          + 'character has already chosen to Stand Strong this scene.',
        source: { book: BOOK, page: 10, section: 'FATED BLOODLINE SKILLS' },
      },
    ],
  },
  'Holy Order': {
    book: BOOK,
    third_party: true,
    also_known_as: ['Knights', 'Rebellion', 'Idealists'],
    blurb:
      'Bound by faith and doctrine, members of the Holy Order are initiated into the '
      + 'battle against darkness through sacred rites and fight in the name of a higher '
      + 'power. Warriors who represent the Holy Order tend to be motivated primarily by a '
      + 'sense of duty and responsibility to the Order and the being they serve. They face '
      + 'crises valiantly, even if they don\'t have a personal stake in solving the world\'s problems.',
    summary: 'A group devoted to a greater cause who push their goals forward.',
    character_questions: [
      'Who leads your lineage? How are they chosen?',
      'What deity, cause, or other higher power does your Order serve?',
      'How common is your faith? Is your order sanctioned by the state, or more clandestine?',
      'What sparked your devotion to the Order? What keeps it strong now?',
    ],
    skills: [
      {
        name: 'Devoted in Body and Soul',
        max_sl: 3,
        skill_type: 'Passive',
        description:
          'When you make a Check in order to fill or erase sections of a Clock, you may '
          + 'spend up to SL × 10 Hit Points or Mind Points. For every 10 Hit Points or Mind '
          + 'Points spent this way, you gain a +1 bonus to your Check.',
        source: { book: BOOK, page: 11, section: 'HOLY ORDER SKILLS' },
      },
      {
        name: 'Divine Intervention',
        max_sl: 5,
        skill_type: 'Passive',
        description:
          'When you are reduced to 0 Hit Points and at least one ally has already '
          + 'Surrendered this scene, you may choose to Stand Strong. If you do, you regain '
          + 'Hit Points equal to your Crisis value and each ally who has Surrendered this '
          + 'scene regains Hit Points equal to their Crisis value and rejoins the current scene.\n\n'
          + 'Additionally, until you are reduced to 0 Hit Points again, whenever you deal '
          + `damage with an attack or offensive ${OFFENSIVE} spell, a creature of your choice regains `
          + 'SL × 5 Hit Points.\n\n'
          + 'You may only Stand Strong once, and you may not Stand Strong if another '
          + 'character has already chosen to Stand Strong this scene.',
        source: { book: BOOK, page: 11, section: 'HOLY ORDER SKILLS' },
      },
      {
        name: 'Show of Faith',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'Once per session when you uphold the virtues of your order to your own detriment, '
          + 'you may gain 1 Fabula Point.',
        source: { book: BOOK, page: 11, section: 'HOLY ORDER SKILLS' },
      },
      {
        name: 'Vigilant Counsel',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'When you rest, you may communicate freely with one character toward whom you have a bond.',
        source: { book: BOOK, page: 11, section: 'HOLY ORDER SKILLS' },
      },
      {
        name: 'Welcoming',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'When you successfully perform a Check to fill or erase sections of a Clock, if '
          + 'your approach involved sharing your belief or appealing to emotion, fill or '
          + 'erase an additional section of the Clock.',
        source: { book: BOOK, page: 11, section: 'HOLY ORDER SKILLS' },
      },
    ],
  },
  Outcasts: {
    book: BOOK,
    third_party: true,
    also_known_as: ['Rabble', 'Troupe', 'Commoners'],
    blurb:
      'The common people are your family. Regardless of origin, faith, or standing, the '
      + 'Outcasts band together when times get tough. When something threatens one member '
      + 'of the Outcasts, it threatens the entire community, and everyone does their part '
      + 'to take care of the problem. The Outcasts share resources with those who have the '
      + 'most need, knowing that doing so ultimately benefits the entire group.',
    summary: 'Common people pooling resources to keep their community strong.',
    character_questions: [
      'Who leads your lineage? How are they chosen?',
      'What common goal, ideal, or enemy unites your people?',
      'What tensions threaten to cause a schism in your community if left untended?',
      'Were you born into this life, did you choose it, or was it forced on you?',
    ],
    skills: [
      {
        name: 'Banquet',
        max_sl: 8,
        skill_type: 'Passive',
        description:
          'When you rest, you may spend up to SL Inventory Points. For each point spend '
          + 'this way, choose a character in the scene. That character gains their choice of '
          + '5 Hit Points or 5 Mind Points, in addition to the full recovery granted by '
          + 'resting. This increases the character\'s current Hit Points or Mind Points '
          + 'beyond their maximum, but their true maximum does not change.',
        source: { book: BOOK, page: 12, section: 'OUTCAST SKILLS' },
        raw_note: '"For each point spend this way" is verbatim from the book (v0.2 typo for "spent").',
      },
      {
        name: 'Common Goods',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'When you take the Inventory action, you may spend Inventory Points from other '
          + 'characters in the scene in addition to your own. They must agree to let you '
          + 'spend their Inventory Points.',
        source: { book: BOOK, page: 12, section: 'OUTCAST SKILLS' },
      },
      {
        name: 'Leftovers',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'When you create a potion that restores that restores a single creature\'s Hit '
          + 'Points or Mind Points (such as a Remedy or Elixir), and the amount restored '
          + 'would exceed the character\'s maximum Hit Points or Mind Points, you may have '
          + 'the excess amount restored to a different character.',
        source: { book: BOOK, page: 12, section: 'OUTCAST SKILLS' },
        raw_note: 'The duplicated "that restores that restores" is verbatim from the v0.2 book.',
      },
      {
        name: 'Mess with One of Us, Mess with All of Us',
        max_sl: 3,
        skill_type: 'Passive',
        description:
          'When you are reduced to 0 Hit Points while you are in a populated area such as a '
          + 'city or town, you may choose to Stand Strong. If you do, your actions inspire '
          + 'the local citizens to intervene and help you. You recover Hit Points equal to '
          + 'your Crisis value and may immediately perform an action, even if you\'ve already '
          + 'taken a turn this round.\n\n'
          + 'Additionally, until you are reduced to 0 Hit Points again, your attacks that '
          + 'lack multi gain multi(SL+1).\n\n'
          + 'You may only Stand Strong once, and you may not Stand Strong if another '
          + 'character has already chosen to Stand Strong this scene.',
        source: { book: BOOK, page: 12, section: 'OUTCAST SKILLS' },
      },
      {
        name: 'What Goes Around Comes Around',
        max_sl: 1,
        skill_type: 'Passive',
        description:
          'Once per session when you provide aid to a character you have a lineage-level '
          + 'bond toward, you may gain 1 Fabula Point.',
        source: { book: BOOK, page: 12, section: 'OUTCAST SKILLS' },
      },
    ],
  },
};

const LINEAGE_SYSTEM = {
  name: 'Lineages',
  optional: true,
  book: BOOK,
  third_party: true,
  source: { book: BOOK, page: 7, section: 'LINEAGES' },
  overview: [
    'The battle against darkness is slow and arduous. Evil is an enemy so fearsome and so '
    + 'resilient that it cannot be defeated in a single lifetime. So the heroes of the '
    + 'world must train successors to take up their mantle and continue the fight in their stead.',
    'With this optional system, the scale of play expands from following a single group of '
    + 'heroes to spanning entire generations. Rather than play just one character for the '
    + 'duration of a campaign, each Player takes control of a Lineage and creates a new '
    + 'hero each time the story jumps forward to a new era.',
  ],
  terminology: [
    'A Lineage is like a character, but it encapsulates the bonds, items, and Skills '
    + 'belonging of an entire faction instead of a single individual.',
    'Just as a character\'s acquires Skills by gaining levels in Classes, a Lineage '
    + 'acquires Skills by gaining levels in Traditions. A Lineage\'s level is the sum of '
    + 'its total levels in all of its Traditions.',
    'When something is stored or retained by the Lineage at the end of a generation, it is archived.',
    'When something that has been archived is given to a character, it is inherited.',
  ],
  lineage_turn: {
    previous_generation: [
      'Archive one of your character\'s bonds. You may add or change up to one emotion. '
      + 'Describe how that bond has been maintained throughout the years. Your Lineage may '
      + 'have up to six archived bonds. If you try to archive a seventh, you must replace an existing one.',
      'Archive up one of your character\'s Heroic Skills, if they have any. Describe how '
      + 'that powerful technique has been remembered and passed down over time.',
      'Choose your character\'s epilogue: Press On, Retire, or Pass Away. Each option is '
      + 'described in further detail in the next section.',
      'Allocate two Tradition levels. You may put both into a single Tradition, or divide '
      + 'them between different Traditions.',
    ],
    new_generation: [
      'Each person at the table describes at least one way in which the world has changed '
      + 'since the end of the last generation. Changes can be big or small, but at least a '
      + 'few should be direct results of the previous generation\'s events.',
      'Each Player creates a new level 5 character, following the standard character creation procedure.',
      'Each new Player Character gains Lineage benefits: The character\'s maximum Hit Points '
      + 'and maximum Mind Points each increase by an amount equal to their Lineage level. '
      + 'Each new Player character gains all of the unlocked Skills from their Lineage. '
      + 'The character inherits up to one Heroic Skill from their Lineage. A character may '
      + 'take a Heroic Skill even if they do not meet the prerequisites, unless the Heroic '
      + 'Skill requires a Skill they do not have.',
    ],
  },
  epilogues: {
    'Press On': [
      'By choosing this option, you choose to retain your current character and continue '
      + 'playing as them in the next generation. A character may only Press On once.',
      'When you choose this option, recalculate your character\'s maximum Hit Points and '
      + 'Mind Points as though they were a level 5 character.',
      'Additionally, reallocate one of your Class levels to a different Skill from the same '
      + 'Class. No one goes untouched by the passing of years, no matter how hard they try. '
      + 'You may not reallocate a Skill if doing so would disqualify you from a Heroic Skill you have learned.',
      'You may choose to reallocate one additional Skill this way for every 5 levels the character has.',
      'Your character retains all of their other Skills, equipment, and other properties.',
    ],
    Retire: [
      'By choosing this option, you change your character from an active adventurer into a '
      + 'supporting NPC. Your character is still alive, but they have passed the fight '
      + 'against evil onto a successor.',
      'When you choose this option, archive a bond toward your previous character, choosing '
      + 'an emotion that reflects their reputation within the Lineage.',
      'Additionally, you decide where your previous character settles down and establishes '
      + 'their new home. This location acts like a sort of base of operations for your '
      + 'Lineage; any Check you make to find help or information near that location gains a +2 bonus.',
    ],
    'Pass Away': [
      'By choosing this option, you declare that your previous character has died, but they '
      + 'have undoubtedly left their mark on history. Their story has officially come to an '
      + 'end, leaving those who come after them to continue their quest for a better world.',
      'If your previous character Sacrificed themselves during the previous generation, you '
      + 'must choose this option.',
      'When you choose this option, work with the Game Master to determine an important task '
      + 'left unfinished due to the character\'s death. If you complete that task, you gain a '
      + 'Heroic Skill from those available to your Classes (you may even choose a Heroic '
      + 'Skill whose requirements you do not satisfy, unless they include a Skill you don\'t have).',
    ],
  },
  allocating_tradition_levels: [
    'Just as a Player Character\'s talents are described by their Classes, a Lineage\'s '
    + 'talents are described by their Traditions.',
    'After deciding your previous character\'s epilogue, allocate 2 Tradition levels however '
    + 'you wish. You may choose to put both levels into a single Tradition, or split them '
    + 'between two different Traditions.',
    'Tradition levels function similarly to Class levels, except their benefits are '
    + 'conferred to every character you make as part of the Lineage, not just one.',
    'Your next character\'s maximum Hit Points and Mind Points each increase by the sum of '
    + 'all Tradition levels held by your Lineage.',
  ],
  note: 'The book lists the three Traditions below as "< More to come! >" — v0.2 is incomplete.',
};

// ── Verification ────────────────────────────────────────────────────────────

// Normalise both the stored text and the PDF extraction to a comparable form:
// drop the book's decorative 【brackets】 and the offensive-spell glyph (which
// pdftotext emits as an empty "( )"), unify quotes/dashes, collapse whitespace.
function normalise(s) {
  return s
    .replace(/[【】]/g, '')
    .replace(/\(\s*⚡\s*\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/×/g, 'x')
    // A hyphen between two letters may be a real compound ("spell-slinging")
    // or a line-break hyphen the extractor joined away ("spellslinging") —
    // indistinguishable in the output, so ignore it. Hyphens next to a digit
    // ("-2 penalty") are kept: a dropped sign would be a real error.
    .replace(/(?<=[A-Za-z])-(?=[A-Za-z])/g, '')
    // Tight kerning makes pdftotext drop the space after some commas
    // ("humanity,while others") — re-insert it on both sides.
    .replace(/,(?=[A-Za-z])/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractRawText() {
  const out = path.join(os.tmpdir(), 'fu-dark-fantasy-raw.txt');
  if (!fs.existsSync(PDF)) return null;
  try {
    execFileSync('pdftotext', ['-enc', 'UTF-8', PDF, out], { stdio: 'pipe' });
  } catch {
    return fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  }
  return fs.readFileSync(out, 'utf8');
}

function collectVerifiable() {
  const rows = [];
  const push = (owner, kind, e) => {
    if (e.description) rows.push({ owner, kind, name: e.name, text: e.description });
  };
  for (const [n, c] of Object.entries({ Hexer: HEXER, Slayer: SLAYER, Tamer: TAMER })) {
    c.skills.forEach((s) => push(n, 'skill', s));
    (c.spells ?? []).forEach((s) => push(n, 'spell', s));
    for (const key of ['free_benefits', 'character_questions', 'player_advice', 'gm_advice']) {
      (c[key] ?? []).forEach((t, i) => rows.push({ owner: n, kind: key, name: `#${i + 1}`, text: t }));
    }
    if (c.blurb) rows.push({ owner: n, kind: 'blurb', name: '-', text: c.blurb });
  }
  for (const [n, t] of Object.entries(LINEAGE_TRADITIONS)) {
    t.skills.forEach((s) => push(n, 'tradition-skill', s));
  }
  const neg = TAMER.subsystems.negotiation;
  for (const key of ['beginning', 'progressing', 'closing', 'using_recruited_creatures']) {
    neg[key].forEach((t, i) => rows.push({ owner: 'Tamer', kind: `negotiation.${key}`, name: `#${i + 1}`, text: t }));
  }
  for (const key of ['overview', 'terminology', 'allocating_tradition_levels']) {
    LINEAGE_SYSTEM[key].forEach((t, i) => rows.push({ owner: 'Lineages', kind: key, name: `#${i + 1}`, text: t }));
  }
  for (const [ep, paras] of Object.entries(LINEAGE_SYSTEM.epilogues)) {
    paras.forEach((t, i) => rows.push({ owner: 'Lineages', kind: `epilogue.${ep}`, name: `#${i + 1}`, text: t }));
  }
  return rows;
}

function verify(raw) {
  const hay = normalise(raw);
  const misses = [];
  for (const row of collectVerifiable()) {
    // Multi-paragraph descriptions are stored with \n\n; the PDF puts each
    // paragraph on its own line, so check paragraph-by-paragraph.
    for (const para of row.text.split('\n\n')) {
      const needle = normalise(para);
      if (needle && !hay.includes(needle)) misses.push({ ...row, para: needle });
    }
  }
  return misses;
}

// ── Merge ───────────────────────────────────────────────────────────────────

function recomputeMeta(json) {
  json._meta.classes_count = Object.keys(json.classes).length;
  json._meta.total_skills = Object.values(json.classes)
    .reduce((n, c) => n + (c.skills ?? []).length, 0);
  // Parsers historically appended to phases.shipped on every run; dedupe.
  if (Array.isArray(json._meta.phases?.shipped)) {
    json._meta.phases.shipped = [...new Set(json._meta.phases.shipped)];
  }
  if (Array.isArray(json._meta.phases?.pending)) {
    json._meta.phases.pending = [...new Set(json._meta.phases.pending)];
  }
}

// skills.json is checked in with CRLF and no trailing newline (autocrlf=true
// normalises to LF in the blob). Re-emitting it with LF+\n would rewrite every
// line and bury the real change, so match whatever is already on disk.
function writePreservingStyle(dest, original, json) {
  let out = JSON.stringify(json, null, 2);
  if (/\r\n/.test(original)) out = out.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(original)) out += /\r\n/.test(original) ? '\r\n' : '\n';
  fs.writeFileSync(dest, out, 'utf8');
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const noVerify = argv.includes('--no-verify');
  const txtArg = argv.indexOf('--txt');

  if (!noVerify) {
    const raw = txtArg >= 0
      ? fs.readFileSync(argv[txtArg + 1], 'utf8')
      : extractRawText();
    if (!raw) {
      console.error('✗ Could not extract text from the PDF (pdftotext missing? PDF moved?).');
      console.error('  Pass --txt <file> with a `pdftotext -enc UTF-8` extraction, or --no-verify.');
      process.exit(2);
    }
    const misses = verify(raw);
    if (misses.length) {
      console.error(`✗ ${misses.length} passage(s) did not match the PDF text:\n`);
      for (const m of misses.slice(0, 12)) {
        console.error(`  ${m.owner} / ${m.kind} / ${m.name}`);
        console.error(`    ${m.para.slice(0, 140)}…\n`);
      }
      process.exit(1);
    }
    console.log(`✓ verified ${collectVerifiable().length} passages against the PDF text`);
  }

  const originalText = fs.readFileSync(DEST, 'utf8');
  const json = JSON.parse(originalText);

  json._meta.sources[BOOK] = SOURCE_META;
  json.classes.Hexer = HEXER;
  json.classes.Slayer = SLAYER;
  json.classes.Tamer = TAMER;
  json.lineage_traditions = LINEAGE_TRADITIONS;
  json.lineage_system = LINEAGE_SYSTEM;

  const shipped = json._meta.phases.shipped;
  const line = 'Dark Fantasy Classes v0.2 (Hexer + Slayer + Tamer, Hexer spells, Lineage Traditions)';
  if (!shipped.includes(line)) shipped.push(line);
  json._meta.phases.pending = (json._meta.phases.pending ?? [])
    .filter((p) => !/dark fantasy/i.test(p));

  recomputeMeta(json);

  const nSkills = HEXER.skills.length + SLAYER.skills.length + TAMER.skills.length;
  const nTrad = Object.values(LINEAGE_TRADITIONS).reduce((n, t) => n + t.skills.length, 0);
  console.log(`  classes  : Hexer, Slayer, Tamer (${nSkills} skills)`);
  console.log(`  spells   : Hexer ${HEXER.spells.length} (${HEXER.spells.filter((s) => s.is_offensive).length} offensive)`);
  console.log(`  traditions: ${Object.keys(LINEAGE_TRADITIONS).length} (${nTrad} skills)`);
  console.log(`  subsystem : Tamer negotiation`);
  console.log(`  totals    : ${json._meta.classes_count} classes / ${json._meta.total_skills} class skills`);

  if (dryRun) {
    console.log('\n(dry run — skills.json not written)');
    return;
  }
  writePreservingStyle(DEST, originalText, json);
  console.log(`\n✓ wrote ${path.relative(REPO, DEST)}`);
}

main();
