/**
 * Heroic Skill requirement parser
 * ---------------------------------------------------------------------------
 * `heroic_requirement` on a skill item is prose written for a human:
 *
 *   "you must have mastered the Arcanist Class, and your character must be
 *    level 30 or higher."
 *
 * This turns that into a structure the level-up window can gate on. It is
 * deliberately NOT a migration: the strings are static rulebook text, there are
 * ~150 of them across the class actors, and parsing a handful when a class
 * panel opens costs microseconds. Writing parsed copies back into 149 world
 * items would be pure churn for data that never changes.
 *
 * OUTPUT
 * ------
 *   { all: Clause[], unparsed: string[] }
 *
 * `all` clauses are ANDed. `unparsed` holds any sentence fragment no rule
 * claimed — it is the honesty channel: a requirement that half-parses must not
 * silently become a weaker gate, so callers treat a non-empty `unparsed` as
 * "cannot evaluate" and fall back to showing the prose.
 *
 * Clause kinds:
 *   { kind:"masteredAny", classes:string[], min:number }  N of these classes at level 10
 *   { kind:"charLevel",   min:number }                    character level >= min
 *   { kind:"skillLevel",  skill:string, min:number }      >= min levels in a named skill
 *   { kind:"hasSkill",    skill:string }                  owns the skill at all
 *   { kind:"allSkillsOf", className:string }              every non-heroic skill of a class
 *
 * All names are normalized lowercase; matching against actual class/skill names
 * is the evaluator's job, not the parser's — see requirement-eval.js.
 */

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const toInt = (raw) => {
  const s = String(raw ?? "").trim().toLowerCase();
  if (NUM_WORDS[s] !== undefined) return NUM_WORDS[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Strip tags/entities, collapse whitespace, drop a leading "Requirements:" label.
export function normalizeRequirementText(raw) {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^\s*requirements?\s*:\s*/i, "")
    .trim();
}

// The Oxford comma has to be consumed as ONE separator. Splitting on /,/ before
// / and / leaves the final item as "and Spiritist" — silently corrupting every
// list of three or more, which is most of them. Lists also come "A, B, or C",
// so both conjunctions are separators.
const LIST_SEP = /\s*,\s*(?:and|or)\s+|\s*,\s*|\s+(?:and|or)\s+/i;

// "ace of cards, fury, rogue, sharpshooter, and weaponmaster" → [...5 names]
// Also handles "commander and sharpshooter", the "the following:" preamble
// ("among the following: Guardian or Slayer"), and a trailing "class"/"classes".
function splitClassList(raw) {
  return String(raw ?? "")
    .replace(/^\s*the\s+following\s*:?\s*/i, " ")
    .replace(/\bclasses?\b/gi, " ")
    .split(LIST_SEP)
    .map((s) => s.trim().replace(/^the\s+/i, "").replace(/[.;:]+$/, "").trim())
    .filter(Boolean);
}

// "real treasure and winds of trade" → ["real treasure", "winds of trade"]
const splitSkillList = (raw) =>
  String(raw ?? "")
    .split(LIST_SEP)
    .map((s) => s.trim().replace(/^the\s+/i, "").replace(/\s+(?:skills?|spells?)$/i, "").replace(/[.;:]+$/, "").trim())
    .filter(Boolean);

// Each rule reports the span it consumed so leftovers can be detected.
const RULES = [
  // "mastered one or more Classes among A, B, and C"  /  "two or more classes among ..."
  // The list runs until a new requirement clause starts ("…, and you must…") or
  // the sentence ends — without that lookahead the trailing clause gets eaten
  // as if it were another class name.
  {
    re: /master(?:ed)?\s+(one|two|three|\d+)\s+or\s+more\s+classe?s?\s+among\s+(.+?)(?=\s*,?\s*and\s+(?:you|your|must)\b|[.;]|$)/i,
    build: (m) => ({ kind: "masteredAny", classes: splitClassList(m[2]), min: toInt(m[1]) ?? 1 }),
  },
  // "mastered the Arcanist Class"
  {
    re: /master(?:ed)?\s+the\s+(.+?)\s+class\b/i,
    build: (m) => ({ kind: "masteredAny", classes: splitClassList(m[1]), min: 1 }),
  },
  // "learned all the skills offered by the Sharpshooter class"
  {
    re: /learned\s+all\s+(?:the\s+)?skills?\s+offered\s+by\s+the\s+(.+?)\s+class\b/i,
    build: (m) => ({ kind: "allSkillsOf", className: m[1].trim() }),
  },
  // "your character must be level 30 or higher"
  {
    re: /level\s+(\d+)\s+or\s+higher/i,
    build: (m) => ({ kind: "charLevel", min: toInt(m[1]) ?? 0 }),
  },
  // "acquired 3 Skill Levels in the Magic Cards Skill"
  {
    re: /acquired\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+skill\s+levels?\s+in\s+the\s+(.+?)\s+skill\b/i,
    build: (m) => ({ kind: "skillLevel", skill: m[2].trim(), min: toInt(m[1]) ?? 1 }),
  },
  // "acquired the Lv. 3 Clarity skill"
  {
    re: /acquired\s+the\s+lv\.?\s*(\d+)\s+(.+?)\s+skill\b/i,
    build: (m) => ({ kind: "skillLevel", skill: m[2].trim(), min: toInt(m[1]) ?? 1 }),
  },
  // "acquired the Real Treasure and Winds of Trade skills"
  // "learned the Crossfire Skill"
  // "learned both the Drain Spirit and Drain Vigor spells"
  // Spells and Skills are both just items on the actor, so one clause kind
  // covers them; the evaluator searches by name across everything held.
  {
    re: /(?:acquired|learned)\s+(?:both\s+)?the\s+(.+?)\s+(?:skills?|spells?)\b/i,
    build: (m) => splitSkillList(m[1]).map((skill) => ({ kind: "hasSkill", skill })),
  },
];

/**
 * Parse one `heroic_requirement` string.
 * @returns {{ all: object[], unparsed: string[], source: string, empty: boolean }}
 */
export function parseHeroicRequirement(raw) {
  const source = normalizeRequirementText(raw);
  if (!source) return { all: [], unparsed: [], source: "", empty: true };

  // Consume matches out of a working copy; whatever prose survives is leftover.
  let rest = source;
  const all = [];

  for (const { re, build } of RULES) {
    // A rule may fire more than once ("mastered the X class ... mastered the Y class").
    for (let guard = 0; guard < 6; guard++) {
      const m = rest.match(re);
      if (!m) break;
      const built = build(m);
      for (const clause of Array.isArray(built) ? built : [built]) all.push(clause);
      rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    }
  }

  // Connective/filler words carry no requirement — strip before judging leftovers.
  const residue = rest
    .replace(/\b(you|your|character|must|have|has|had|and|also|be|the|a|an|of|at|least|or|higher|this|skill|class|classes|acquire[d]?|learn(?:ed)?|master(?:ed)?)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();

  return { all, unparsed: residue ? [rest] : [], source, empty: false };
}

/**
 * Merge a parse with a hand-authored override keyed by skill name.
 * Overrides are authoritative and mark the result parsed even when the prose
 * defeats every rule.
 */
export function resolveRequirement(raw, override = null) {
  if (override && Array.isArray(override.all)) {
    return { all: override.all, unparsed: [], source: normalizeRequirementText(raw), empty: false, overridden: true };
  }
  return { ...parseHeroicRequirement(raw), overridden: false };
}
