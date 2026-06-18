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
};

// ── Build lookup maps ──────────────────────────────────────────────────────
const _byUuid = Object.create(null);
const _byName = Object.create(null);

for (const [name, tail, icon, kind] of DATA) {
  const uuid = "JournalEntry." + tail;
  const entry = { key: uuid, label: name, icon, kind, descHtml: DESC[tail] ?? "" };
  // First write wins for a shared uuid (e.g. the elemental Shields all point at
  // the base Shield journal) so byUuid resolves to the canonical term; the
  // variant icons/labels stay reachable by name.
  if (!_byUuid[uuid]) _byUuid[uuid] = entry;
  _byName[name.toLowerCase()] = entry;
}

// Resolve a term by JournalEntry UUID (preferred — exact) or by display name
// (fallback for keywords authored as plain bold text). Returns the registry
// entry { key, label, icon, kind, descHtml } or null.
export function lookupTerm(uuidOrName) {
  if (!uuidOrName) return null;
  const s = String(uuidOrName).trim();
  return _byUuid[s] ?? _byName[s.toLowerCase()] ?? null;
}

export const KEYWORD_REGISTRY = _byUuid;
