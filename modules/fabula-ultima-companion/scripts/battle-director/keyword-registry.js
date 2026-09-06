// scripts/battle-director/keyword-registry.js
// Static registry of in-game Action Keywords and Statuses, used by the Action
// Card's Effect section to:
//   - promote Action Keywords (e.g. "Unleash") to a prominent badge,
//   - render status terms (e.g. "Bleed") as small chips,
//   - show each term's rules text in the click tooltip (keyword-tooltip.js).
//
// HARVEST SOURCE (one-time, NOT read at runtime): the "Keyword Repository"
// journal (JournalEntry.U16BWkb0eRaemBB0, "Backup" page) pairs each term with
// its icon + UUID; folder classifies it (`Skill Keyword` → keyword,
// `New Debuff` → status). `descHtml` is each term journal's text page, with the
// redundant leading icon stripped. We deliberately bake this in rather than
// resolve journals live (the journal layout is brittle and async).
//
// To regenerate after adding/editing a keyword in the repository journal,
// re-harvest the journal and rewrite the DATA / DESC tables below (manual —
// keywords change rarely).

// Icon URL bases (every term icon lives under one of these).
const SK = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/";
const BF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Buff%20Icon/";

// [ name, uuidTail, iconUrl, kind ]   (uuid = "JournalEntry." + uuidTail)
// Order mirrors the repository's Backup page.
const DATA = [
  // ── Action Keywords (Skill Keyword folder) ──
  ["Multi",            "Gm3upxgpUVoLSK5u", SK + "10_SAM/way_of_the_samurai.png", "keyword"],
  ["Chain",            "noUOPxPoZq65yYxV", SK + "14_SMN/gouge.png",              "keyword"],
  ["Overflow",         "NUaxIAIPUu5Qnk8l", SK + "15_RDM/verflare.png",           "keyword"],
  ["Pierce",           "2hNU23YLpCcZCCmf", SK + "GNB/sonic_break.png",           "keyword"],
  ["Drain",            "CRPjA4dHUYLSAh0M", SK + "BLU/blood_drain.png",           "keyword"],
  ["Trigger",          "P7eaFojxra2gTRTG", SK + "GNB/abdomen_tear.png",          "keyword"],
  ["Mana Burn",        "NI69hHt2XDbzuxGV", SK + "BLU/water_cannon.png",          "keyword"],
  ["Crush",            "U76k25jMlkIFIVB9", SK + "02_WAR/primal_rend.png",        "keyword"],
  ["Backstab",         "7PQDwyX0RPf0djPL", SK + "09_NIN/assassinate.png",        "keyword"],
  ["Blitz",            "vBUBQbu92bWBozgN", SK + "10_SAM/tenka_goken.png",        "keyword"],
  ["Benign",           "N1c190b6J1kKS6Vf", SK + "04_WHM/holy_III.png",           "keyword"],
  ["Massive",          "VCBaZfA3PZzN4sx3", SK + "BLU/magic_hammer.png",          "keyword"],
  ["Roulette",         "1TyH5hsRlBx4xYDs", SK + "BLU/level_5_petrify.png",       "keyword"],
  ["Unleash",          "UqXGUQM31kWc7BTc", SK + "02_WAR/inner_release.png",      "keyword"],
  ["Desperation",      "0XjR7LzG6oiU74Lj", SK + "BLU/basic_instinct.png",        "keyword"],
  ["Innate",           "FbwTycwFuAdCfXi7", SK + "07_MNK/purification.png",       "keyword"],
  ["Shield",           "wrw2ENSwzCBjztvt", SK + "SGE/taurochole.png",            "keyword"],
  ["Ice Shield",       "wrw2ENSwzCBjztvt", SK + "13_BLM/blizzard.png",           "keyword"],
  ["Fire Shield",      "wrw2ENSwzCBjztvt", SK + "13_BLM/fire_III.png",           "keyword"],
  ["Earth Shield",     "wrw2ENSwzCBjztvt", SK + "04_WHM/stone_ii.png",           "keyword"],
  ["Poison Shield",    "wrw2ENSwzCBjztvt", SK + "14_SMN/bio.png",                "keyword"],
  ["Air Shield",       "wrw2ENSwzCBjztvt", SK + "15_RDM/veraero.png",            "keyword"],
  ["Lightning Shield", "wrw2ENSwzCBjztvt", SK + "13_BLM/thunder_iii.png",        "keyword"],
  ["Dark Shield",      "wrw2ENSwzCBjztvt", SK + "SGE/eukrasian_dosis.png",       "keyword"],
  ["Light Shield",     "wrw2ENSwzCBjztvt", SK + "01_PLD/clemency.png",           "keyword"],
  ["Flying",           "q6keqwDWUsEgSWDw", SK + "14_SMN/summon_garuda_II.png",   "keyword"],

  // ── Statuses (New Debuff folder) ──
  ["Hidden",      "DMaL1B3Z5Y5AUrvC", SK + "09_NIN/shade_shift.png",     "status"],
  ["Quicken",     "c8cDHzP0hJzChgz6", SK + "14_SMN/summon_topaz.png",    "status"],
  ["Slow",        "HHmYmj7xffQMqtzT", BF + "DEF%20DOWN.png",             "status"],
  ["Dazed",       "3nmUvPei3zrOJkEt", BF + "MAGICDEFENSE%20DOWN.png",    "status"],
  ["Weak",        "KYehgac3Pw1fKC9S", BF + "ATK%20DOWN.png",             "status"],
  ["Shaken",      "ImFKpNNGjstom7Q9", BF + "MAGIC%20ATTACK%20DOWN.png",  "status"],
  ["Enraged",     "XkuOy0BFvKJTewGS", BF + "DEFENSE%20DOUBLE%20DOWN.png","status"],
  ["Poisoned",    "JltwIqzHbBKhkD45", BF + "ATK%20DOUBLE%20DOWN.png",    "status"],
  ["Bane",        "SNK1IJTKfxjAy2NS", SK + "BLU/basic_instinct.png",     "status"],
  ["Berserk",     "aPF9gzkqnUkcQmIC", SK + "02_WAR/infuriate.png",       "status"],
  ["Bleed",       "GePNxftPupElcCWp", SK + "RPR/cross_reaping.png",      "status"],
  ["Blind",       "rBnvYhLfmrVZDdoW", BF + "Blind.png",                  "status"],
  ["Break",       "MziQo5K1cu829GIU", SK + "BLU/faze.png",              "status"],
  ["Burn",        "MSRXG4jUMPFpM9sN", BF + "Burn.png",                   "status"],
  ["Charm",       "x6ByoJnflDAuVn9r", BF + "Heart.png",                  "status"],
  ["Confused",    "e9wABGGGFg7b9OMD", BF + "Wet.png",                    "status"],
  ["Crisis",      "GJevbCPM8cffm1QM", SK + "08_DRG/blood_for_blood.png", "status"],
  ["Curse",       "V8mKI3BdXusfSBLq", SK + "BLU/doom.png",              "status"],
  ["Death",       "1OVRzhqPZpnm89s9", BF + "Death.png",                  "status"],
  ["Disarmed",    "MM2SvLRyVhazkNq3", SK + "12_MCH/dismantle.png",       "status"],
  ["Delay",       "0RscV9vkJNM9dVKQ", SK + "14_SMN/summon_carbuncle.png","status"],
  ["Despair",     "mINm5XmNcnbSzgrN", SK + "BLU/condensed_libra.png",    "status"],
  ["Doom",        "Do0VLf6wW9uCSLwD", SK + "BLU/level_5_death.png",      "status"],
  ["Envenomed",   "XRlyg27yLgoQUOXZ", BF + "Poison.png",                 "status"],
  ["Fatigue",     "J4fv0XKFy678UIn8", SK + "BLU/feculent_flood.png",     "status"],
  ["Frightened",  "TOF8epes1eGHwx5J", BF + "Fear.png",                   "status"],
  ["Frozen",      "p0XupN5rieyjMNaI", SK + "13_BLM/blizzard.png",        "status"],
  ["Grappled",    "FV8JefaHsehzgXR7", BF + "Bludgeon.png",               "status"],
  ["Hypothermia", "QgECPH7ZhbRhag3K", SK + "BLU/northerlies.png",        "status"],
  ["Isolate",     "yE84jvVXyebDulAP", SK + "RPR/enshroud.png",           "status"],
  ["KO",          "Fes171ebnXnTSVdd", BF + "Incapacitate.png",           "status"],
  ["Obscure",     "ZdBbIFKzxQQcY71T", SK + "BLU/cold_fog.png",           "status"],
  ["Oil",         "Vnd1QB9lYQMYvIDF", SK + "BLU/self-destruct.png",      "status"],
  ["Panic",       "vf421bQSPCjLAvBW", BF + "Stun.png",                   "status"],
  ["Provoked",    "c4sYPClmvld4TEK8", SK + "02_WAR/TankRollAction/provoke.png", "status"],
  ["Paralyzed",   "GqqgHkKOs0hkghdG", BF + "Paralyze.png",               "status"],
  ["Petrify",     "thBevyZDOURijH8I", SK + "BLU/peripheral_synthesis.png","status"],
  ["Silence",     "Q8FTFPsXVpNj2zxT", BF + "Silence.png",                "status"],
  ["Stagger",     "IBN7DtvWLFDo8jNh", BF + "Dark.png",                   "status"],
  ["Suppress",    "NTvswy65a5N2fh09", SK + "05_SCH/art_of_war.png",      "status"],
  ["Turbulence",  "vzkQ7MNkmqRDJIXV", SK + "BLU/alpine_draft.png",       "status"],
  ["Wet",         "2rh5lyMNU5yL8Btk", SK + "BLU/flying_sardine.png",     "status"],
  ["Wither",      "7nqnFPcHG5ZzNfC0", SK + "BLU/ink_jet.png",            "status"],
  ["Zombie",      "RZIAnKw95vY6yh2W", BF + "Zombie.png",                 "status"],
];

// ── Damage Types (Damage Type section) ──────────────────────────────────────
// These resolve to Item documents (not JournalEntry), so they carry a full
// "Item.<id>" key. Rendered inline (kind "status") when they appear as a link.
// [ name, itemIdTail, iconFile (under BF) ]
const DAMAGE = [
  ["Physical", "XpKZuGo3VmT0TlTu", "Bludgeon.png"],
  ["Air",      "imkMQLnCLaFbaS6Y", "Wind.png"],
  ["Bolt",     "5XAuMMbDPlLzhJLw", "Paralyze.png"],
  ["Dark",     "vKU8UYT6DBhgOjtE", "Zombie.png"],
  ["Earth",    "ZyOMe6IkUTlBzfjw", "Earth.png"],
  ["Fire",     "0sFCVCoM6FRrQP2f", "Burn.png"],
  ["Ice",      "Osq3NN3QCtiW7otU", "Freeze.png"],
  ["Light",    "IQaK3IzvfFp4I1xB", "Holy.png"],
  ["Poison",   "tDcCWc67Ary9nVxe", "Poison.png"],
];

// ── Additional Action Keywords (new Keyword-section terms) ───────────────────
// [ name, journalIdTail, iconFile (under SK) | null ]
const KW_EXTRA = [
  ["Channel",       "1jxZfHZ3dh5grylN", "13_BLM/manafont.png"],
  ["Conquer",       "Cz6U0ps98sYN8jMH", "03_DRK/unleash.png"],
  ["Cripple",       "qXBYN6c9FMZzmS2n", "10_VPR/Reaving_Fangs.png"],
  ["Execute",       "KHCaZjNmClkp7yfM", "10_VPR/Swiftskin%27s_Sting.png"],
  ["Exploit",       "YojfVwJv8ABa45c6", "10_VPR/Flanksbane_Fang.png"],
  ["Feint",         "OMu8IfxHBIMXJseJ", "10_VPR/Steel_Fangs.png"],
  ["Homing",        "tQE9WGDt0bNhgxXw", "12_MCH/spread_shot.png"],
  ["Thievery",      "KjziTkOpdzd99KZa", "09_NIN/mug.png"],
  ["Snipe",         "2JlZwoTU5Ql7sUyS", "12_MCH/heartbreak.png"],
  ["Trick",         "1v5xrozP0fHlnjQj", "09_NIN/trick_attack.png"],
  // Authored 2026-09-07, NOT harvested from the repository journal like the rest
  // — the journal entry is created alongside it by
  // tools/safe-edit/_author-fickle-keyword.js and carries this same text.
  ["Fickle",        "FicKLeKeyWord001", "BLU/peculiar_light.png"],
  ["Strike Damage", "ZunRGiMDSgAapm5G", null],
  ["Magic Damage",  "XYQUsuXPU0CQjEYa", null],
  ["Melee",         "10LjF01NAYNKpRvn", null],
  ["Range",         "Fcq1HgCEh3jxxELa", null],
];

// ── Equipment Keywords (Equipment Keyword section) ──────────────────────────
// [ name, journalIdTail, iconFile (under SK) ]
const EQUIP = [
  ["Double Strike", "T8FOTz5J8Ys7sbya", "10_VPR/Twinfang.png"],
  ["Transform",     "EYcZ6QkAqiGBAxLB", "GNB/lightning_shot.png"],
  ["Versatile",     "RJqcUnjSTQeMiA7Z", "09_NIN/throwing_dagger.png"],
  ["Quickchange",   "scBCSpHipSeXcOYa", "10_VPR/Second_Generation.png"],
  ["Weighted",      "ljKBtlzPVvhhmdHW", "02_WAR/butcher%27s_block.png"],
];

// ── Action Types (System → Action Type section) ─────────────────────────────
// These are NOT content-links — they're plain bracketed dev-syntax the GM types
// constantly (e.g. 【⚔️Attack】). Accepting one inserts that literal text, and
// the emoji is its dropdown icon. [ name, emoji ]
const ACTION_TYPES = [
  ["Attack",              "⚔️"],
  ["Skill",               "💥"],
  ["Passive",             "📜"],
  ["Guard",               "🛡️"],
  ["Spell",               "📕"],
  ["Offensive Spell",     "⚡"],
  ["Non-Offensive Spell", "✨"],
  ["Inventory",           "⚗️"],
  ["Equipment",           "🥋"],
  ["Study",               "🔎"],
  ["Hinder",              "🚫"],
  ["Objective",           "❗️"],
];

// Rules text per term, keyed by uuid tail. Harvested from each term journal's
// text page (leading icon stripped). Filled by the harvest; terms missing here
// show a graceful "No description available." in the tooltip.
const DESC = {
  // Action Keywords
  "Gm3upxgpUVoLSK5u": "<ul><li><p><strong>Multi (x)</strong> allow the attacks to have up to X target, however, they cannot target a unit that has already been targeted</p></li></ul>",
  "noUOPxPoZq65yYxV": "<ul><li><p>Similar to <strong>Multi (x)</strong> Chains indicate that this attacks can hits multiple time and target. This attack do not take penalty to HR</p></li><li><p>Unlike <strong>Overflow, </strong>Chain attacks hits multiple time, so multiple Accuracy Checks are rolled for each targets.</p></li></ul>",
  "NUaxIAIPUu5Qnk8l": "<ul><li><p>This skill deals damage to all enemies all at once.</p></li><li><p>The Difference between <strong>Overflow </strong>to <strong>Chain</strong> and <strong>Multi</strong> is that Accuracy check is calculated only one time at the beginning and apply to all target at once.</p></li></ul>",
  "2hNU23YLpCcZCCmf": "<ul><li><p>This attack deals 50% damage if the Accuracy check is lower than the target defense.</p></li></ul>",
  "CRPjA4dHUYLSAh0M": "<ul><li><p>This attacks drains 50% of its damage as HP to the user</p></li></ul>",
  "P7eaFojxra2gTRTG": "<ul><li><p>Trigger skills are performed automatically under a specific condition (e.g if 'xxx' happens). </p></li><li><p>Additionally, Trigger skills can be performed outside of one own turn.</p></li></ul>",
  "NI69hHt2XDbzuxGV": "<p>This skill does damage to <strong>MP</strong> instead of <strong>HP</strong></p>",
  "U76k25jMlkIFIVB9": "<p><strong>Damage Dealt </strong>by this action cannot be <strong>Reduce</strong> and ignore <strong>immunity</strong></p>",
  "7PQDwyX0RPf0djPL": "<ul><li>This action deals <strong>X</strong> bonus <strong>damage</strong> to creature who hasn't taken a turn yet this round</li><li>Attacking while Hidden always trigger Backstab regardless if the target has already taken their turn this round</li></ul>",
  "vBUBQbu92bWBozgN": "<p>This action do not trigger any <strong>Reaction</strong></p><p><em>(For example: Protect, Counterattack, Crossfire etc.)</em></p>",
  "N1c190b6J1kKS6Vf": "<p>If this attack would reduce a creature to <strong>0 HP</strong>, they hold on at <strong>1 HP</strong> instead</p>",
  "VCBaZfA3PZzN4sx3": "<ul><li><p>Ally of the target can help bolster the defense against this attack before the attack lands, if they choose to do so, the original target gain +1 to DEF and MDEF, but if the attack still hit, all the participants divides the total damage equally.</p></li><li><strong>Massive</strong> attack cannot be <strong>Negated</strong></li></ul>",
  "1TyH5hsRlBx4xYDs": "<ul><li>This skill choose its target randomly from all legal target on the battlefield</li></ul>",
  "UqXGUQM31kWc7BTc": "<ul><li><p><strong>Unleash</strong> ability automatically activates once at the start of the conflicts, and is not usable again under any condition.</p></li></ul>",
  "0XjR7LzG6oiU74Lj": "<ul><li><p>This skill is only usable in <strong>Crisis</strong></p></li></ul>",
  "FbwTycwFuAdCfXi7": "<p>This skill cannot be disable <em>(Effects which disable skills includes Paralyzed, Berserk etc.)</em></p>",
  "wrw2ENSwzCBjztvt": "<ul><li><p>Shield are temporary HP that soak up damage until it is used up. (unless state otherwise)</p></li><li><p>Damage taken will be subtracted from your Shield before affecting your HP. The vulnerability of the shield may be different from the user wielding it.</p><p><em>(Fire Shield, Air Shield etc…)</em></p></li><li>When you have an Elemental Shield active, your normal affinity are <strong>replaced </strong>by the <strong>Shield Affinity</strong></li><li><p>Shield only overrides <strong>Vulnerability </strong>and <strong>Resistance, </strong>but do not overrides <strong>Immunity </strong>and <strong>Absorbtion</strong></p></li><li><p>When a Shield is used up, the remaining damage is dealt to your HP as normal.</p></li><li><p>While a creature is holding an Elemental Shield, it <strong>Attribute</strong> becomes the same type as the <strong>Shield</strong>.</p></li></ul>",
  "q6keqwDWUsEgSWDw": "<p>Your NPC has the ability to fly or levitate. In addition to the obvious narrative benefits, creatures on the ground cannot reach your NPC with melee attacks as long as your NPC is in mid-air (but your NPC can perform melee attacks against targets who are on the ground). If the NPC suffers damage of a type they are Vulnerable to, they are immediately forced to land and lose the benefits of this Skill until the end of the round, when they will automatically resume flight. Your NPC may also be forced to land by spending an opportunity. As long as it is in Crisis, the NPC loses all benefits granted by this Skill.</p>",
  // Statuses
  "DMaL1B3Z5Y5AUrvC": "<ul><li><p>Unable to be target by <strong>single-target action.</strong><em>(AOE and Multi-targeted action are still able to target you)</em></p></li><li><p>You can use an <strong>Objective Action </strong>to remove the <strong>Hidden </strong>status from target creature.</p></li></ul>",
  "c8cDHzP0hJzChgz6": "<p>This creature take its turn in the <strong>Quicken</strong> initiative.</p><p><em>The Quicken initiative is another initiative list which take place before the regular initiative and the Delayed initiative, to put it simply, Quicken creature will usually take its turn before everybody else.</em></p>",
  "HHmYmj7xffQMqtzT": "<p>Decrease this creature <strong>【DEX】</strong> die by one stage.</p><table border=\"1\"><tbody><tr><td><strong>Advance Condition</strong></td></tr><tr><td> Paralyzed</td></tr><tr><td> Fatigue</td></tr><tr><td> Delayed</td></tr></tbody></table>",
  "3nmUvPei3zrOJkEt": "<p>Decrease this creature <strong>【INS】</strong>die size by one stage.</p><table border=\"1\"><tbody><tr><td><strong>Advance Condition</strong></td></tr><tr><td>Silence</td></tr><tr><td>Confused</td></tr><tr><td>Charm</td></tr></tbody></table>",
  "KYehgac3Pw1fKC9S": "<p>Decrease this creature <strong>【MIG】</strong>die size by one stage.</p><table border=\"1\"><tbody><tr><td><strong>Advance Condition</strong></td></tr><tr><th>Bane</th></tr><tr><td>Frightened</td></tr><tr><td>Stagger</td></tr></tbody></table>",
  "ImFKpNNGjstom7Q9": "<p>Decrease this creature <strong>【WLP】</strong>die size by one stage.</p><table border=\"1\"><tbody><tr><td><strong>Advance Condition</strong></td></tr><tr><th>Wither</th></tr><tr><td>Despair</td></tr><tr><td>Panic</td></tr></tbody></table>",
  "XkuOy0BFvKJTewGS": "<p>Decrease this creature <strong>【DEX】</strong>and <strong>【INS】</strong>by one stage.</p><table border=\"1\"><tbody><tr><td><strong>Advance Condition</strong></td></tr><tr><th> Berserk</th></tr><tr><td> Burn</td></tr><tr><td> Blind</td></tr></tbody></table>",
  "JltwIqzHbBKhkD45": "<p>Decrease this creature 【<strong>MIG】</strong> and 【<strong>WLP】</strong> die by one stage.</p><table border=\"1\"><tbody><tr><td><strong>Advance Condition</strong></td></tr><tr><th> Bleed</th></tr><tr><td><strong>Envenomed</strong></td></tr><tr><td><strong>Curse</strong></td></tr></tbody></table>",
  "SNK1IJTKfxjAy2NS": "<p>Reduce all damage dealt by <strong>Basic Attacks</strong> by 50% <em>(Rounded Down)</em></p><p><em>Reduction is calculated after Damage resistance and Immunity.</em></p><p><strong>Basic Condition:</strong></p><p>Weak</p>",
  "aPF9gzkqnUkcQmIC": "<p>Increase all damage dealt by this creature by <strong>2 times</strong> but disable all action except for the <strong>【Attack】</strong>action.</p><p><strong>Basic Condition:</strong></p><p>Enraged</p>",
  "GePNxftPupElcCWp": "<p>Reduce effectiveness of healing effects on this creature by 50%</p><p><strong>Basic Condition:</strong></p><p>Poisoned</p>",
  "rBnvYhLfmrVZDdoW": "<p>Reduce all Accuracy check made by this creature by <strong>3</strong></p><p><strong>Basic Condition:</strong></p><p>Enraged</p>",
  "MziQo5K1cu829GIU": "<ul><li><p>Gain <strong>Vulnerability</strong> to all damage type.</p></li><li><p>Loses all turns activation.</p></li></ul>",
  "MSRXG4jUMPFpM9sN": "<ul><li>At the start of the turn, Deal 10% of the afflicted unit Maximum HP as damage. Reduce to 5% on <strong>Champion </strong>ranked creature.</li></ul><p><strong>Basic Condition:</strong></p><p>Enraged</p>",
  "x6ByoJnflDAuVn9r": "<ul><li><p>Can't target the <strong>charmer </strong>or include them as the target of actions.</p></li><li><p>Reduce <strong>opposed check</strong> against the <strong>charmer</strong> by 2</p></li></ul><p><em>(Charmer is the source of the charm)</em></p><p><strong>Basic Condition:</strong></p><p>Dazed</p>",
  "e9wABGGGFg7b9OMD": "<p>❌ This creature cannot use the <strong>【Objective】</strong>Action.</p><p><strong>Basic Condition:</strong></p><p>Dazed</p>",
  "GJevbCPM8cffm1QM": "<p>This creature has less than 50% HP</p>",
  "V8mKI3BdXusfSBLq": "<p>Curse creatures lose <strong>20% </strong>of their MaxMP at the starts of their turn, Decrease to <strong>10% </strong>against <strong>Champion-rank </strong>creature</p><p><strong>Basic Condition:</strong></p><p>Poisoned</p>",
  "1OVRzhqPZpnm89s9": "<p>This Creature has pass on….</p><p><sub>There is nothing you can do….You have to move on…</sub></p>",
  "MM2SvLRyVhazkNq3": "<p>Disable the use of <strong>【Equipment】</strong>action, and prevents the change of Equipments</p><p><strong>Basic Condition:</strong></p><p>Dazed</p>",
  "0RscV9vkJNM9dVKQ": "<p>This creature take its turn in the <strong>Delay</strong> initiative.</p><p><sub><em>The delay initiative is another initiative list which take place after the regular initiative and the Quicken initiative, to put it simply, Delayed creature will usually take its turn after everybody else.</em></sub></p><p><strong>Basic Condition:</strong></p><p>Slow</p>",
  "mINm5XmNcnbSzgrN": "<p>Unable to use or gain <strong>【Zero Power】</strong></p><p><strong>Basic Condition:</strong></p><p>Shaken</p>",
  "Do0VLf6wW9uCSLwD": "<p>When the countdown for this status reach 0. This creature immediately falls to 0 HP.</p>",
  "XRlyg27yLgoQUOXZ": "<p>This creature takes <strong>15 poison</strong> damage after it perform any <strong>【Action】</strong></p><p><strong>Basic Condition:</strong></p><p>Poisoned</p>",
  "J4fv0XKFy678UIn8": "<p>Allows only single target actions.</p><p><strong>Basic Condition:</strong></p><p>Weak</p>",
  "TOF8epes1eGHwx5J": "<p>❌This creature cannot use the <strong>【Attack】</strong>Action.</p><p><strong>Basic Condition:</strong></p><p>Weak</p>",
  "p0XupN5rieyjMNaI": "<p>You gain <strong>X Shield</strong> (this shield cannot be replaced).</p><ul><li><strong>Freeze―</strong>While this shield is active: <ul><li>You have <strong>Vulnerability</strong> to<strong> Fire, Physical, and Earth</strong> damage.</li><li>You <strong>cannot perform Actions</strong>.</li></ul></li><li><strong>Shatter―</strong>At the start of your next turn: <ul><li>Remove all remaining <strong>Shield</strong>.</li><li>You take Ice <strong>Damage</strong> equal to the amount of <strong>Shield</strong> removed this way.</li><li>Remove this Debuff</li></ul></li></ul><blockquote><p><em>If you already have a Shield when affected by this debuff:</em><em>○ Compare the values of your current Shield and the new <strong>Shield</strong>.</em><em>○ Subtract the lower value from the higher one.</em><em>○ The shield with the <strong>higher remaining value</strong> is the one that stays active.</em><em>○ The other shield is removed.</em></p></blockquote><p><strong>Basic Condition:</strong></p><p>Slow</p>",
  "FV8JefaHsehzgXR7": "<ul><li><p>Grappled units are treated as being in the same space as the grappler, if the Grappler is targeted by an effects that originates from other than the Grappled unit, that effects also target the Grappled units too.</p></li><li><p>If the Grappled unit is performing <strong>Guard-Cover </strong>action for another unit, the action immediately ends. (The Grappled unit still receives benefits from <strong>Guard</strong> action).</p></li><li><p>As a free action at the start of their turn, the Grappled unit may perform a <strong>DC10 </strong>skill check with any combination, as long as it contains at least one <strong>【DEX】</strong>or<strong>【MIG】</strong>die.</p></li><li><p>Additionally, the grappled unit may choose to use the Objective action in their turn to reattempt the check if they do not break free at the start of their turn.</p></li></ul>",
  "QgECPH7ZhbRhag3K": "<p>Gain vulnerability to <strong>Ice</strong> damage.</p><p><em>(This debuff cannot overrides Immunity or Absorption)</em></p>",
  "yE84jvVXyebDulAP": "<ul><li><p><strong>Isolated </strong>creature can only be targeted by creature who are also <strong>Isolated </strong>by the same effect</p></li><li><p>As a free action at the start of their turn, the Isolated unit may perform a <strong>DL10 </strong>skill check with any combination, as long as it contains at least one <strong>【DEX】</strong>or<strong>【MIG】</strong>die, on a success they break free from Isolation.</p></li><li>Additionally, the isolated unit may choose to use the Objective action in their turn to reattempt the check if they do not break free at the start of their turn.</li></ul>",
  "Fes171ebnXnTSVdd": "<p>This creature is incapacitated and cannot perform any actions until they are heal.</p><p><sub>You don't necessary need to be unconscious, but something has render you unable to fight, either the battle has taken its tolls or your fatigue has catch up to you.</sub></p>",
  "ZdBbIFKzxQQcY71T": "<p>Prevents the uses of 【<strong>Range】</strong> action.</p>",
  "Vnd1QB9lYQMYvIDF": "<p>Gain vulnerability to <strong>Fire</strong> damage.</p>",
  "vf421bQSPCjLAvBW": "<p>❌ This creature cannot use the <strong>【Inventory】</strong>Action and cannot spend any Inventory Points.</p><p><strong>Basic Condition:</strong></p><p>Shaken</p>",
  "c4sYPClmvld4TEK8": "<p>Must include the provoker as the target of their <strong>attack</strong> and <strong>spell.</strong></p><p><strong>Basic Condition:</strong></p><p>Enraged</p>",
  "GqqgHkKOs0hkghdG": "<p>❌ Disable the use of <strong>【Skill】</strong>Action</p><p><strong>Basic Condition:</strong></p><p>Slow</p>",
  "thBevyZDOURijH8I": "<p>Gain vulnerability to <strong>Earth</strong> damage. This creature is treated as <strong>Construct.</strong></p><p><em>(This debuff cannot overrides Immunity or Absorption)</em></p>",
  "Q8FTFPsXVpNj2zxT": "<p>❌ This creature cannot use the <strong>【Spell】</strong>Action.</p><p><strong>Basic Condition:</strong></p><p>Dazed</p>",
  "IBN7DtvWLFDo8jNh": "<p>❌This creature cannot use the <strong>【Guard】</strong>Action.</p><p><strong>Basic Condition:</strong></p><p>Weak</p>",
  "NTvswy65a5N2fh09": "<p>Disable the effect of <strong>Passive </strong>Skill</p><p><em>(Skill which grant you benefit without the need to perform any Action or Attack are considered Passive eg. Melee Weapon Mastery, Resourceful, Dark Blood etc.)</em></p><p><strong>Basic Condition:</strong></p><p>Shaken</p>",
  "vzkQ7MNkmqRDJIXV": "<p>Gain vulnerability to <strong>Air</strong> damage.</p><p><em>(This debuff cannot overrides Immunity or Absorption)</em></p>",
  "2rh5lyMNU5yL8Btk": "<p>Gain vulnerability to <strong>Bolt</strong> damage</p><p><em>(This debuff cannot overrides Immunity or Absorption)</em></p>",
  "7nqnFPcHG5ZzNfC0": "<p>Reduce effectiveness of Mana gaining effects by <strong>50%</strong></p><p><strong>Basic Condition:</strong></p><p>Shaken</p>",
  "RZIAnKw95vY6yh2W": "<ul><li><p>Convert any healing effects on this creature into damage instead.</p></li><li><p>Gain vulnerability to <strong>light</strong> damage</p></li><li><p>The spell <strong>Hope </strong>or other Revive effects kills you instead.</p></li></ul>",
  // New Action Keywords
  "1jxZfHZ3dh5grylN": "<ul><li><p>This Ability effects only trigger after a certain amounts of time has passed.</p></li><li><p>If Channeling in <strong>Rounds.</strong> The Ability triggers at the beginning of the creature next turn after the number of rounds have passed.</p></li><li><p>If Channeling in <strong>Turns.</strong> The Ability triggers immediately upon the countdown finish. Countdown go down each turns.</p></li><li>Channeling consumes the user <strong>Action</strong> when it activates.</li></ul>",
  "Cz6U0ps98sYN8jMH": "<ul><li>This action triggers additional effects when its Accuracy check exceed the target Defense by <strong>X</strong></li></ul>",
  "qXBYN6c9FMZzmS2n": "<p>This attack deals 200% damage to creature who are not in <strong>Crisis</strong></p>",
  "KHCaZjNmClkp7yfM": "<p>This attack deals 200% damage to creature who are in <strong>Crisis</strong></p>",
  "YojfVwJv8ABa45c6": "<p>This action <strong>Accuracy Check</strong> will target whichever is lower between <strong>DEF</strong> or <strong>MDEF</strong></p>",
  "OMu8IfxHBIMXJseJ": "<ul><li>When you <strong>misses</strong> with this attack, you may perform it again on the <strong>original target.</strong></li><li>If the attack targets multiple enemies and at least one target is missed, you may perform <strong>Feint</strong> as a <strong>single-target attack</strong> against each of the missed targets.</li></ul>",
  "tQE9WGDt0bNhgxXw": "<ul><li><p>This attack ignores <strong>【Protect】</strong> and <strong>【Cover】</strong> or any similar effects.</p></li></ul>",
  "KjziTkOpdzd99KZa": "<ul><li>This Action reduce the target <strong>Inventory Point</strong> by X on hit</li><li>If your Max IP is more than 0, you also gain Inventory Points equal to the amount the target loss as well (You cannot gain more IP than your max IP)</li></ul>",
  "2JlZwoTU5Ql7sUyS": "<p>This <strong>Action</strong> grant additional effects when the Accuracy check is equal to or more than X.</p>",
  "FicKLeKeyWord001": "<ul><li><p>The <strong>Accuracy Check</strong> for this action is hidden. Its dice are not shown, and its total is shown only as the range it could fall in.</p></li><li><p>Against each target, the result is shown as a <strong>chance to hit</strong> instead of a hit or a miss.</p></li><li><p>A <strong>Critical Hit</strong> is the exception &mdash; it always reveals itself, and the action resolves in the open as normal.</p></li><li><p>Nothing else changes: the Check is rolled normally and decides the outcome normally &mdash; you simply do not get to see it.</p></li></ul>",
  "1v5xrozP0fHlnjQj": "<ul><li><p><strong>Actions</strong> with this keyword will have their success conditions reversed: an accuracy check result <strong>lower</strong> than the target's defense counts as a <strong>hit</strong>, while a result <strong>higher</strong> than the target's defense counts as a <strong>miss</strong>.</p></li></ul>",
  "ZunRGiMDSgAapm5G": "<ul><li>Any damage that targeted the target's Defense is consider \"Strike Damage\"</li></ul>",
  "XYQUsuXPU0CQjEYa": "<ul><li>Any damage that targeted the target Magic Defense is considered <strong>\"Magic Damage\"</strong></li></ul>",
  "10LjF01NAYNKpRvn": "<p>Melee Attacks are closed ranged attacks, it lacks the ability to target Flying creature but are often more powerful than range attacks</p>",
  "Fcq1HgCEh3jxxELa": "<p>Range Attacks are attacks from a greater distance, they can target Flying or Elusive creatures, but are often weaker than Melee Attacks</p>",
  // Equipment Keywords
  "T8FOTz5J8Ys7sbya": "<ul><li>You may perform <strong>Two-weapon Fighting</strong> with this weapon</li><li>This effect does not stack with other source of <strong>Two-weapon Fighting</strong> (Dual wielding two Double Strike weapon do not allows you to attack four times)</li></ul>",
  "EYcZ6QkAqiGBAxLB": "<ul><li>This Equipment has a two form</li><li>While you have one of the two forms equipped, you can equip the other form whenever you want; during a conflict scene, you can only do so during your turn, <strong>before or after an action</strong>, and only <strong>once per turn</strong>. If one or both the forms are <strong>martial</strong>, remember that you must have the appropriate Classes to equip them</li></ul>",
  "RJqcUnjSTQeMiA7Z": "<p>This ability can be used even if you don't have this item equipped</p><p><em>*This keyword is only use for Equipment only</em></p>",
  "scBCSpHipSeXcOYa": "<p>This effects triggers immediately when this Equipment become equipped</p><p><em>*This keyword is only use for Equipment only</em></p>",
  "ljKBtlzPVvhhmdHW": "<ul><li>You can only perform one attack per turn with this weapon</li><li>You cannot perform attacks without <strong>HR</strong> with this weapon</li></ul><p><em>*This keyword is only use for Equipment only</em></p>",
};

// ── Category metadata ───────────────────────────────────────────────────────
// `category` is the fine-grained classification (drives the suggest-dropdown
// badge); `kind` is the back-compat render hint the Action Card already keys on
// (only "keyword" → headline badge and "status" → inline chip are special-cased
// there, everything else flattens to text). Each new category maps to one of
// those two render kinds.
export const CATEGORY_META = {
  keyword:    { label: "Keyword",   kind: "keyword", bg: "rgba(201,138,42,.22)",  fg: "#7a4e12" },
  status:     { label: "Status",    kind: "status",  bg: "rgba(154,59,143,.18)",  fg: "#6e1f66" },
  damage:     { label: "Damage",    kind: "status",  bg: "rgba(176,58,46,.18)",   fg: "#8a2d22" },
  equipment:  { label: "Equipment", kind: "keyword", bg: "rgba(36,118,128,.18)",  fg: "#185a62" },
  actionType: { label: "Action",    kind: "keyword", bg: "rgba(70,92,60,.18)",    fg: "#33502f" },
};

// ── Build the unified term list ─────────────────────────────────────────────
// One entry per row: { key, label, icon, category, kind, descHtml, insert?,
// emoji? }. `insert` (action types) overrides content-link insertion with
// literal text; `emoji` is a text-glyph icon for terms without an image URL.
function _mk(key, label, icon, category, tail, extra = {}) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.keyword;
  return {
    key, label, icon,
    category,
    kind: meta.kind,                       // back-compat render hint
    descHtml: tail ? (DESC[tail] ?? "") : "",
    ...extra,
  };
}

const _allEntries = [
  // Existing keywords + statuses (category === kind for these).
  ...DATA.map(([name, tail, icon, kind]) =>
    _mk("JournalEntry." + tail, name, icon, kind, tail)),
  // Damage types — Item documents.
  ...DAMAGE.map(([name, tail, file]) =>
    _mk("Item." + tail, name, BF + file, "damage", tail)),
  // Additional action keywords.
  ...KW_EXTRA.map(([name, tail, file]) =>
    _mk("JournalEntry." + tail, name, file ? SK + file : null, "keyword", tail)),
  // Equipment keywords.
  ...EQUIP.map(([name, tail, file]) =>
    _mk("JournalEntry." + tail, name, SK + file, "equipment", tail)),
  // Action types — plain-text dev syntax, emoji icon, no journal/desc.
  ...ACTION_TYPES.map(([name, emoji]) =>
    _mk("ActionType." + name, name, null, "actionType", null,
        { emoji, insert: `【${emoji}${name}】` })),
];

// ── Lookup maps ─────────────────────────────────────────────────────────────
const _byUuid = Object.create(null);
const _byName = Object.create(null);
for (const entry of _allEntries) {
  // First write wins for a shared uuid (e.g. the elemental Shields all point at
  // the base Shield journal) so byUuid resolves to the canonical term; the
  // variant icons/labels stay reachable by name.
  if (!_byUuid[entry.key]) _byUuid[entry.key] = entry;
  _byName[entry.label.toLowerCase()] = entry;
}

// Resolve a term by document UUID (preferred — exact) or by display name
// (fallback for keywords authored as plain bold text). Returns the registry
// entry { key, label, icon, category, kind, descHtml, … } or null.
export function lookupTerm(uuidOrName) {
  if (!uuidOrName) return null;
  const s = String(uuidOrName).trim();
  return _byUuid[s] ?? _byName[s.toLowerCase()] ?? null;
}

// Rank-search terms by display name for the editor autocomplete. Returns up to
// `limit` entries. With `prefixOnly` (the default for the suggestion tool), only
// exact/prefix name matches qualify — so ordinary prose words don't trigger the
// dropdown. Without it, substring matches are included (looser). `categories`
// (optional Set/array) restricts the result to those categories.
export function searchTerms(query, { limit = 8, prefixOnly = false, categories = null } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q.length < 2) return [];
  const catSet = categories ? new Set(categories) : null;
  const scored = [];
  for (const e of _allEntries) {
    if (catSet && !catSet.has(e.category)) continue;
    const name = e.label.toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (!prefixOnly && name.includes(q)) score = 40;
    else continue;
    scored.push({ e, score });
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    a.e.label.length - b.e.label.length ||
    a.e.label.localeCompare(b.e.label));
  return scored.slice(0, limit).map((s) => s.e);
}

export const KEYWORD_REGISTRY = _byUuid;
