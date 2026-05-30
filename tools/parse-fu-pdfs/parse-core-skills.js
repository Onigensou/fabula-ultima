// Parse Fabula Ultima Core book's class skill sections into structured data.
//
// Per-class skill format (from extracted text):
//   <SKILL NAME>                                              (◆N)
//
//   <description paragraphs...>
//
// Where ◆ is rendered as `�` in the pdftotext output. Skills with no
// `(◆N)` marker are max SL 1 (e.g. SEE YOU LATER).
//
// Heroic skills in Core use a similar format but live in their own
// chapter ("HEROIC SKILLS" — line 9416 marker found earlier).
//
// Output: { classes: {<class>: [...skills]}, heroic: [...] }

const fs = require('fs');
const path = require('path');

const SRC = 'e:/tmp/fu-pdf-text/Fabula_Ultima_TTJRPG.txt';
const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

// Class section anchors — these mark "<CLASS> SKILLS" sublines we found.
const CLASS_ANCHORS = [
  'ARCANIST SKILLS',
  'CHIMERIST SKILLS',
  'DARKBLADE SKILLS',
  'ELEMENTALIST SKILLS',
  'ENTROPIST SKILLS',
  'FURY SKILLS',
  'GUARDIAN SKILLS',
  'LOREMASTER SKILLS',
  'ORATOR SKILLS',
  'ROGUE SKILLS',
  'SHARPSHOOTER SKILLS',
  'SPIRITIST SKILLS',
  'TINKERER SKILLS',
  'WAYFARER SKILLS',
  'WEAPONMASTER SKILLS',
];

// Section boundaries: each class section ends when the NEXT class section
// begins OR when we hit a non-skills section. The class section is
// generally followed by the next class chapter intro page, so look for
// lines that look like a class chapter marker.

function findLineNum(needle, startFrom = 0) {
  for (let i = startFrom; i < lines.length; i++) {
    if (lines[i].trim() === needle) return i;
  }
  return -1;
}

// Locate each class section's [start, end) line range.
//
// A class section ends at the FIRST of:
//   (a) the next class's "<CLASS> SKILLS" header,
//   (b) a "<CLASS> SPELLS" / "SPELL  MP  TARGET" header (spell tables
//       interrupt the skill flow for casting classes),
//   (c) a "<CLASS> FREE BENEFITS" header (class-intro pages between
//       skills sections).
// Whichever comes first.
function endOfClassSection(start, hardEnd) {
  for (let i = start + 1; i < hardEnd; i++) {
    const line = lines[i].trim();
    if (/^[A-Z]+ SKILLS\s*$/.test(line)) return i;
    if (/^[A-Z]+ SPELLS\s*$/.test(line)) return i;
    if (/^[A-Z]+ FREE BENEFITS\s*$/.test(line)) return i;
    if (/^SPELL\s+MP\s+TARGET/i.test(line)) return i;
  }
  return hardEnd;
}

const sectionRanges = [];
for (let i = 0; i < CLASS_ANCHORS.length; i++) {
  const start = findLineNum(CLASS_ANCHORS[i]);
  if (start < 0) { console.error(`MISSING: ${CLASS_ANCHORS[i]}`); continue; }
  const hardEnd = i + 1 < CLASS_ANCHORS.length
    ? findLineNum(CLASS_ANCHORS[i + 1], start + 1)
    : lines.length;
  const end = endOfClassSection(start, hardEnd > 0 ? hardEnd : lines.length);
  sectionRanges.push({
    class: CLASS_ANCHORS[i].replace(' SKILLS', ''),
    start,
    end,
  });
}

// ── Skill parser ─────────────────────────────────────────────────────
//
// Within a class section, skills are demarcated by:
//   - ALL-CAPS skill name (possibly with spaces) on its own line
//   - Optionally followed by `(◆N)` on the SAME line at column 60+
//   - Then a blank line, then description lines
//
// Pitfalls:
//   - Page-break artifacts: "Piyaboot Pantanaviboon (Order #...)"
//   - Chapter markers like "3 CHAPTER", "PRESS START"
//   - Page numbers (3-digit standalone)
//   - Decorative letters (single "W", "n", etc.)

// Strip inline page-break / chapter / decoration artifacts that can
// appear ANYWHERE on a skill-name line (before or after the SL marker).
function stripInlineArtifacts(line) {
  return line
    // Page chapter markers like "3 CHAPTER" or "PRESS START" appear
    // wherever the PDF layout floats a corner banner over a skill row.
    .replace(/\s+\d+\s+CHAPTER\b.*$/, '')
    .replace(/\s+PRESS START\b.*$/, '')
    .replace(/\s+PRESS\s+START\b.*$/, '')
    // Right-edge single "W" decoration.
    .replace(/\s+W\s*$/, '');
}

function isLikelySkillName(line) {
  // Strip inline artifacts FIRST so a name line with "PRESS START"
  // appended (or chapter markers in the middle) can still be detected.
  const cleaned = stripInlineArtifacts(line);
  // Strip the (◆N) suffix if present.
  const stripped = cleaned.replace(/\s*\([^\)]*\)\s*$/, '').trimEnd();
  // Empty or short.
  if (stripped.length < 2 || stripped.length > 60) return false;
  // Must be MOSTLY uppercase letters + spaces + a few allowed punct.
  // Allow words like "SEE YOU LATER", "DARK BLOOD", "HEART OF DARKNESS".
  // Reject artifacts like "Piyaboot Pantanaviboon (Order #38008384)".
  if (!/^[A-Z][A-Z 0-9'’\-:&]+$/.test(stripped)) return false;
  // Reject pure-numeric (page number).
  if (/^\d+$/.test(stripped)) return false;
  // Reject our class section anchors.
  if (stripped.endsWith(' SKILLS')) return false;
  // Reject common artifact strings.
  const artifacts = [
    'PRESS START', 'CHAPTER', 'PIYABOOT PANTANAVIBOON', 'CORE RULEBOOK',
    'FABULA ULTIMA', 'PAGE', 'ALSO', 'FREE BENEFITS',
  ];
  if (artifacts.some(a => stripped.includes(a))) return false;
  // Reject Arcanum-table layout artifacts. Arcanist's class section
  // also contains a layout table of Arcanums ("MERGE   ARCANUM OF THE
  // FORGE", "DISMISS Domains: ...") which my naive ALL-CAPS detector
  // would pick up. The skills proper never start with these label words.
  const layoutLabels = ['MERGE ', 'DISMISS ', 'INVOKE ', 'SUMMON '];
  if (layoutLabels.some(l => stripped.startsWith(l))) return false;
  return true;
}

// Description terminator — a superset of isLikelySkillName. The inner
// description-scanning loop uses this to stop bleed past the skill,
// including chapter-level headings (PROLOGUES, EXPERIENCE AND LEVELS,
// THE QUESTIONS, etc.) that aren't skill names but DO end the
// surrounding skill's description in the PDF layout.
function isDescTerminator(line) {
  if (isLikelySkillName(line)) return true;
  if (isDescBoundary(line)) return true;
  // Standalone ALL-CAPS heading not previously caught: typically a
  // Chapter-4 layout heading appearing after the LAST class section.
  const cleaned = stripInlineArtifacts(line).trim();
  if (cleaned.length >= 5 && cleaned.length <= 60
      && /^[A-Z][A-Z 0-9'’\-:&]+$/.test(cleaned)
      && !/^(MERGE|DISMISS|INVOKE|SUMMON) /.test(cleaned)
      && !/^\d+$/.test(cleaned)) {
    return true;
  }
  return false;
}

function extractMaxSL(line) {
  // `(◆N)` — ◆ in PDF is rendered as � (U+FFFD) or similar junk byte.
  // Strip inline artifacts first so any trailing "PRESS START" doesn't
  // shove the `(◆N)` away from the end of the line.
  const cleaned = stripInlineArtifacts(line);
  const m = cleaned.match(/\(\s*[^\)]*?(\d+)\s*\)\s*$/);
  if (m) return Number(m[1]);
  return 1;  // unmarked = max SL 1
}

function cleanLine(line) {
  // Remove decorative single-letter chapter markers etc.
  return line.replace(/\s+\d+\s+CHAPTER\b/g, '')
             .replace(/\s+PRESS START\b/g, '')
             .replace(/\s+W\s*$/, '')
             .trimEnd();
}

// Detect description-bleed boundaries — class-intro headings and
// other layout artifacts that interrupt a skill description.
const KNOWN_CLASSES = [
  'ARCANIST', 'CHIMERIST', 'DARKBLADE', 'ELEMENTALIST', 'ENTROPIST',
  'FURY', 'GUARDIAN', 'LOREMASTER', 'ORATOR', 'ROGUE', 'SHARPSHOOTER',
  'SPIRITIST', 'TINKERER', 'WAYFARER', 'WEAPONMASTER',
];
function isDescBoundary(line) {
  const t = line.trim();
  if (/^[A-Z]+ SPELLS\s*$/.test(t)) return true;
  if (/^[A-Z]+ FREE BENEFITS\s*$/.test(t)) return true;
  if (/^[A-Z]+ SKILLS\s*$/.test(t)) return true;
  if (/^SPELL\s+MP\s+TARGET/i.test(t)) return true;
  // The class-intro pages between class sections look like:
  //   "SharpshooterALSO: Archer, Gunslinger, Sniper"
  //   "TinkererALSO: Alchemist, Magitech Engineer, Mechanic"
  if (/^[A-Z][a-z]+ALSO:/.test(t)) return true;
  // Page-break decoration that prefixes the NEXT class's chapter
  // banner: "W           SHARPSHOOTER", "W       TINKERER".
  if (/^W\s+(?:[A-Z]+\s*)+$/.test(t)
      && KNOWN_CLASSES.some(c => t.includes(c))) return true;
  return false;
}

function cleanSkillDesc(rawLines) {
  // First pass: trim lines past a description-bleed boundary.
  const trimmed = [];
  for (const line of rawLines) {
    if (isDescBoundary(line)) break;
    trimmed.push(line);
  }
  // Second pass: strip page-break artifacts and join with spaces.
  // Preserve paragraph breaks at blank lines.
  const paras = [];
  let current = [];
  for (const raw of trimmed) {
    const line = cleanLine(raw);
    if (!line.trim()) {
      if (current.length) { paras.push(current.join(' ')); current = []; }
      continue;
    }
    // Drop artifact lines.
    if (/^Piyaboot|^Order #|^W$|^n$|^O$|^\d+$|FABULA ULTIMA/.test(line.trim())) continue;
    current.push(line.trim());
  }
  if (current.length) paras.push(current.join(' '));

  // Final text normalisation. The pdftotext output crushes spaces
  // around the bracketed game-term tokens (SL, HR, DEX, etc.) that
  // FU uses inline.
  return paras.join('\n\n')
    // Insert space between a lower-case word and an uppercase game
    // term: "toSL" → "to SL", "bySL" → "by SL", "recoverSL" → "recover SL",
    // "aDEX" → "a DEX", "thanthe" → "than the" (not handled here).
    .replace(/([a-z]{2,})([A-Z]{2,})/g, '$1 $2')
    // Insert space between a digit and a following lowercase word:
    // "SL × 2extra" → "SL × 2 extra", "10Mind" → "10 Mind".
    .replace(/(\d)([a-z]{2,})/g, '$1 $2')
    // Digit followed by an Upper+lower mix: "5Hit" → "5 Hit",
    // "10Mind" (caught above too).
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    // Replace the PDF's "junk byte" rendering of ✕ / ◆ / etc. that
    // sits inside descriptions. The most common is `SL � 5` for the
    // multiplication sign — only triggers in formula-shaped context
    // (token \s+ junk \s+ digit).
    .replace(/(SL|HR|HP|MP|IP)\s*�\s*(\d+)/g, '$1 × $2')
    // Single-char "a" / "an" / "to" / "by" prefixed directly to an
    // uppercase game term — the broader rule above misses 1-2 char
    // function words.
    .replace(/\b(a|an|by|to|of)([A-Z]{2,})/g, '$1 $2')
    // Specific common joins.
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)\s*\+\s*(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Check/g, '$1 + $2 Check')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Check/g, '$1 Check')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Checks/g, '$1 Checks')
    .replace(/\bthanthe\b/g, 'than the')
    .replace(/SL([a-z])/g, 'SL $1')
    .replace(/SL\s*�\s*2/g, 'SL × 2');
}

// ── Run extractor per class ─────────────────────────────────────────

const out = { _meta: {}, classes: {} };

for (const sec of sectionRanges) {
  const skills = [];
  let i = sec.start + 1;
  // RAW invariant: every FU base class has exactly 5 skills. Stop after
  // we've captured 5 — anything past that in the same section is
  // layout-bleed from the next chapter (Chapter 4 character-creation
  // pages, spell tables that slipped past the boundary detector, etc.).
  while (i < sec.end && skills.length < 5) {
    const raw = lines[i];
    if (isLikelySkillName(raw)) {
      // Name = artifacts-stripped + SL-suffix-stripped + trimmed.
      const cleaned = stripInlineArtifacts(raw);
      const name = cleaned.replace(/\s*\([^\)]*\)\s*$/, '').trim();
      const maxSl = extractMaxSL(raw);
      // Read description until next skill name or section end.
      const descLines = [];
      let j = i + 1;
      while (j < sec.end) {
        if (isDescTerminator(lines[j])) break;
        descLines.push(lines[j]);
        j++;
      }
      skills.push({
        name,
        max_sl: maxSl,
        description: cleanSkillDesc(descLines),
        source: { book: 'Core', section: sec.class + ' SKILLS', line: i + 1 },
      });
      i = j;
    } else {
      i++;
    }
  }
  out.classes[sec.class] = skills;
}

// Normalize class names: ROGUE → Rogue, etc. The BD-tree folder
// convention is PascalCase, so the reference matches what the lint
// rule will diff against.
function pascalCase(allCaps) {
  // "ROGUE" → "Rogue", "WEAPONMASTER" → "Weaponmaster" (single word).
  // Multi-word class names don't exist in Core but the helper handles
  // them just in case.
  return allCaps.toLowerCase().replace(/(^| )(\w)/g, (_, sp, c) => sp + c.toUpperCase());
}
function titleCase(allCaps) {
  // "CHEAP SHOT" → "Cheap Shot", "DEX + WLP" → "Dex + Wlp" (not great
  // but we mostly use this for skill names which are fine in Title Case).
  return allCaps.toLowerCase().replace(/(^| )(\w)/g, (_, sp, c) => sp + c.toUpperCase());
}

const finalOut = {
  _meta: {
    schema_version: '1.0',
    generated_at: '2026-05-30',
    parser: 'tools/parse-fu-pdfs/parse-core-skills.js',
    sources: {
      core: {
        title: 'Fabula Ultima Core Rulebook',
        file: 'Fabula_Ultima_TTJRPG.pdf',
        phase: 'shipped',
      },
    },
    phases: {
      shipped: ['Core class skills (15 × 5)'],
      pending: [
        'Core heroic skills',
        'Core spells (class spell lists)',
        'Atlas additions (High/Natural/Techno/Low Fantasy)',
        'Bonus additions (Necromancer, Halloween x2, Ace, Arcane)',
        'Playtest patches (chronological — newest wins)',
      ],
    },
  },
  classes: {},
  universal_heroic: [],
};

for (const [allCaps, skillList] of Object.entries(out.classes)) {
  const cls = pascalCase(allCaps);
  finalOut.classes[cls] = {
    book: 'core',
    skills: skillList.map(s => ({
      name: titleCase(s.name),
      max_sl: s.max_sl,
      description: s.description,
      source: { book: 'core', section: s.source.section, line: s.source.line },
    })),
    heroic: [],   // Phase 2
    spells: [],   // Phase 2
  };
}

finalOut._meta.classes_count = Object.keys(finalOut.classes).length;
finalOut._meta.total_skills = Object.values(finalOut.classes).reduce((s, c) => s + c.skills.length, 0);

// Default to the repo location. Override with `SKILLS_JSON=<path>` env
// var when iterating outside the repo (e.g. during parser dev).
const dest = process.env.SKILLS_JSON
  ?? path.resolve(__dirname, '..', '..',
       'modules', 'fabula-ultima-companion', 'reference', 'skills.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(finalOut, null, 2));
console.log(JSON.stringify({
  classes_count: finalOut._meta.classes_count,
  total_skills: finalOut._meta.total_skills,
  per_class_counts: Object.fromEntries(Object.entries(finalOut.classes).map(([c, x]) => [c, x.skills.length])),
  dest,
}, null, 2));
