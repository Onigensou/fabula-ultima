// Parse Atlas "LIST OF NEW HEROIC SKILLS" tables from HF/NF/TF.
//
// Atlas heroic skill tables follow the Core table shape (same parser
// can ingest them) with two adaptations:
//   • Multi-class entries with "Two of <X>, <Y>, and <Z>" (Bimagus).
//     The "Two of" phrasing is unique to Atlas — the requirement
//     reads "must have mastered any two of these classes." For the
//     reference's purposes, we record all three classes; the
//     mastery-count constraint is RAW info that goes in `requirement`.
//   • The section header is "LIST OF NEW HEROIC SKILLS" instead of
//     Core's "LIST OF HEROIC SKILLS".
//
// LF Atlas uses class-specific detail sections (HUNTER HEROIC SKILLS,
// MONK HEROIC SKILLS, etc.) — different shape, handled by a separate
// parser when needed (Phase 5.2, deferred).

const fs = require('fs');
const path = require('path');

const TXT_DIR = 'e:/tmp/fu-pdf-text';
const DEST = process.env.SKILLS_JSON ?? path.resolve(
  __dirname, '..', '..',
  'modules', 'fabula-ultima-companion', 'reference', 'skills.json'
);

const ATLASES = [
  { key: 'atlas-hf', file: 'Fabula_Ultima_Atlas_High_Fantasy.txt' },
  { key: 'atlas-nf', file: 'Fabula_Ultima_-_Natural_Fantasy_Atlas_v1.0.txt' },
  { key: 'atlas-tf', file: 'Fabula_Ultima_-_Techno_Fantasy_Atlas_v1.01.txt' },
];

const KNOWN_CLASSES = new Set([
  // Core
  'Arcanist', 'Chimerist', 'Darkblade', 'Elementalist', 'Entropist',
  'Fury', 'Guardian', 'Loremaster', 'Orator', 'Rogue', 'Sharpshooter',
  'Spiritist', 'Tinkerer', 'Wayfarer', 'Weaponmaster',
  // Atlas additions
  'Chanter', 'Commander', 'Dancer', 'Symbolist',
  'Floralist', 'Gourmet', 'Invoker', 'Merchant',
  'Esper', 'Mutant', 'Pilot',
  'Hunter', 'Illusionist', 'Monk',
  // Bonus
  'Ace of Cards', 'Necromancer',
]);

function stripArtifacts(line) {
  return line
    .replace(/\s+\d+\s+CHAPTER[A-Z]*.*$/, '')
    .replace(/\s+PRESS START[A-Z]*.*$/, '')
    .replace(/\s+PROTAGONISTS[A-Z]*.*$/, '')
    .replace(/\s+W\s*$/, '')
    .replace(/^Sarunphat Pisutvimol.*$/, '')
    .replace(/^Piyaboot Pantanaviboon.*$/, '')
    .replace(/^LIST OF NEW HEROIC SKILLS\s*$/, '')
    .replace(/^LIST OF HEROIC SKILLS\s*$/, '')
    .trimEnd();
}

const isClassTok = (tk) => {
  if (!tk) return false;
  if (KNOWN_CLASSES.has(tk)) return true;
  const bare = tk.replace(/[,.;]+$/, '');
  return KNOWN_CLASSES.has(bare);
};

function scanByKnownClass(rest, { allowEmptyName = false } = {}) {
  const tokens = rest.split(/(\s+)/);
  let firstClassIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (isClassTok(tokens[i])) { firstClassIdx = i; break; }
  }
  if (firstClassIdx < 0) return null;
  let lastClassIdx = firstClassIdx;
  for (let j = firstClassIdx + 1; j < tokens.length; j++) {
    const tk = tokens[j];
    if (/^\s+$/.test(tk)) continue;
    if (tk === ',' || tk === 'or' || tk === 'and') { lastClassIdx = j; continue; }
    if (isClassTok(tk)) { lastClassIdx = j; continue; }
    break;
  }
  const namePart = tokens.slice(0, firstClassIdx).join('').trim();
  const classCol = tokens.slice(firstClassIdx, lastClassIdx + 1).join('').trim();
  const brief = tokens.slice(lastClassIdx + 1).join('').trim();
  if (!namePart && !allowEmptyName) return null;
  return { name: namePart, classCol, brief };
}

function splitColumns(line) {
  const t = line.replace(/^\s+/, '');
  // Strip leading "W " decoration (some entries are prefixed with it).
  const noDecor = t.replace(/^W\s+/, '');
  // Strategy A: 2+ space gap between name and class column.
  const aGap = noDecor.match(/^([\w'!\-.: ]+?)\s{2,}(.*)$/);
  if (aGap) {
    const name = aGap[1].trim();
    const rest = aGap[2];
    // The class column may begin with "Two of " (Atlas multi-class
    // mastery-count requirement). Strip it for parsing then re-attach.
    let twoOfPrefix = '';
    let restForScan = rest;
    if (/^Two of\s+/i.test(rest)) {
      twoOfPrefix = 'Two of ';
      restForScan = rest.replace(/^Two of\s+/, '');
    }
    const classM = restForScan.match(/^([A-Za-z ,]+?(?:\s+(?:or|and)\s+\w+)?)\s{2,}(.+)$/);
    if (classM) {
      return {
        name,
        classCol: twoOfPrefix + classM[1].trim(),
        brief: classM[2].trim(),
      };
    }
    const splitB = scanByKnownClass(restForScan, { allowEmptyName: true });
    if (splitB && splitB.classCol) {
      return {
        name,
        classCol: twoOfPrefix + splitB.classCol,
        brief: splitB.brief,
      };
    }
    return { name, classCol: '', brief: rest.trim() };
  }
  const splitC = scanByKnownClass(noDecor);
  if (splitC) return splitC;
  return null;
}

function extractClassesFromCol(classColRaw) {
  // Strip the "Two of " prefix when present (recorded as requirement
  // separately if useful).
  const cleaned = classColRaw.replace(/^Two of\s+/i, '');
  return cleaned
    .split(/,|\s+or\s+|\s+and\s+/)
    .map(s => s.replace(/[,.;]+$/, '').trim())
    .filter(s => KNOWN_CLASSES.has(s));
}

const skills = JSON.parse(fs.readFileSync(DEST, 'utf8'));

// Idempotent re-run: drop any heroic entries previously sourced from
// an Atlas book before layering. Keep Core-sourced heroic entries
// (parse-core-heroic.js owns those).
const ATLAS_KEYS = new Set(ATLASES.map(a => a.key));
for (const cls of Object.values(skills.classes)) {
  if (!Array.isArray(cls.heroic)) continue;
  cls.heroic = cls.heroic.filter(h => !ATLAS_KEYS.has(h.source?.book));
}

const summary = {};

for (const atlas of ATLASES) {
  const srcPath = path.join(TXT_DIR, atlas.file);
  if (!fs.existsSync(srcPath)) { summary[atlas.key] = { error: 'no file' }; continue; }
  const text = fs.readFileSync(srcPath, 'utf8');
  const lines = text.split(/\r?\n/);

  // Find LIST OF NEW HEROIC SKILLS anchor. May appear twice (page break);
  // use the first one as start.
  const tableStart = lines.findIndex(l => /^\s*LIST OF NEW HEROIC SKILLS\s*$/.test(l));
  if (tableStart < 0) { summary[atlas.key] = { error: 'anchor not found' }; continue; }

  // End at the first ALL-CAPS standalone detail header (e.g. ARCANE MARK).
  // Title Case = table row; ALL CAPS = detail section start.
  let tableEnd = lines.length;
  for (let i = tableStart + 1; i < Math.min(tableStart + 250, lines.length); i++) {
    const t = stripArtifacts(lines[i]).trim();
    if (/^[A-Z][A-Z 0-9'!]{3,30}$/.test(t)
        && !t.includes('PIYABOOT') && !t.includes('SARUNPHAT')
        && !t.endsWith('SKILLS')
        && t !== 'LIST OF NEW HEROIC SKILLS'
        && t !== 'LIST OF HEROIC SKILLS') {
      tableEnd = i;
      break;
    }
  }

  const classBound = [];
  let lastEntry = null;

  for (let i = tableStart + 1; i < tableEnd; i++) {
    const raw = lines[i];
    const stripped = stripArtifacts(raw);
    const trimmed = stripped.trim();
    if (!trimmed) { lastEntry = null; continue; }

    if (/^Heroic Skills with a Class mastery requirement/i.test(trimmed)) continue;
    if (/^Heroic Skills available to all characters/i.test(trimmed)) continue;
    if (/^Piyaboot|^Sarunphat|^Order #|^\d+\s*$/.test(trimmed)) continue;

    // Heavily-indented continuation line — extend previous entry.
    if (/^\s{30,}/.test(stripped)) {
      // Two continuation modes:
      //  (a) Class-list continuation: previous classColRaw ended with
      //      a comma. The continuation line BEGINS with class tokens
      //      and may also carry brief text. Bimagus is the canonical
      //      case: line 1 "Two of Elementalist," continues as line 2
      //      "Entropist, and Spiritist saving MP." — we need
      //      ["Entropist", "Spiritist"] as classes and "saving MP."
      //      as brief continuation.
      //  (b) Brief-only continuation: just wraps the brief desc.
      if (lastEntry && /,\s*$/.test(lastEntry.classColRaw ?? '')) {
        // Take the LEADING run of class tokens (with comma / and / or
        // separators), then treat the rest of the line as brief.
        const tokens = trimmed.split(/(\s+)/);
        const extraClasses = [];
        let lastClassTok = -1;
        for (let k = 0; k < tokens.length; k++) {
          const tk = tokens[k];
          if (/^\s+$/.test(tk)) continue;
          if (tk === ',' || tk === 'and' || tk === 'or') { lastClassTok = k; continue; }
          if (isClassTok(tk)) {
            extraClasses.push(tk.replace(/[,.;]+$/, ''));
            lastClassTok = k;
            continue;
          }
          break;
        }
        if (extraClasses.length) {
          lastEntry.classes.push(...extraClasses);
          lastEntry.classColRaw += ' ' + tokens.slice(0, lastClassTok + 1).join('');
          const briefTail = tokens.slice(lastClassTok + 1).join('').trim();
          if (briefTail) {
            lastEntry.brief = (lastEntry.brief + ' ' + briefTail).trim();
          }
          continue;
        }
      }
      if (lastEntry) {
        lastEntry.brief = (lastEntry.brief + ' ' + trimmed).trim();
      }
      continue;
    }

    // Name-wrap continuation. Canonical case (NF Atlas, lines
    // 6828-6829):
    //   "Auramancer's     Arcanist, Spiritist    Improves Aura..."
    //   "Refraction                              punishes enemies..."
    // Line 1 parses cleanly; line 2 is a name + brief continuation
    // at column 0 (no 2+ space leading indent) where the FIRST WORD
    // is a name continuation, then a large gap, then the brief
    // continuation.
    //
    // Detect by: line starts at column 0 (not the "heavy indent"
    // brief-continuation case caught above), and matches the shape
    // `<short Title-Case word>\s{2,}<rest>`.
    if (lastEntry && !/^\s{2,}/.test(stripped)) {
      const m = stripped.match(/^(\S[\w']*?)\s{2,}(\S.*)$/);
      if (m) {
        const firstWord = m[1].trim();
        const rest = m[2].trim();
        // First word looks like a name continuation: short, Title
        // Case, NOT a class token, NOT a section header.
        const looksLikeName =
          /^[A-Z][a-z]/.test(firstWord)
          && firstWord.length < 40
          && !isClassTok(firstWord)
          && !/SKILLS$/.test(firstWord);
        // Rest looks like brief desc continuation: starts with a
        // lowercase word OR a "Verb + ..." that isn't a class.
        if (looksLikeName) {
          lastEntry.name = (lastEntry.name + ' ' + firstWord).trim();
          lastEntry.brief = (lastEntry.brief + ' ' + rest).trim();
          continue;
        }
      }
    }

    const cols = splitColumns(stripped);
    if (!cols) { lastEntry = null; continue; }

    // Name-wrap continuation — two PDF-layout shapes:
    //
    //  Shape A (NF Atlas): name wraps to second line with NO class
    //    repeat.
    //      "Auramancer's     Arcanist, Spiritist    Improves..."
    //      "Refraction                              punishes..."
    //    Second row parses with name="Refraction", classCol="".
    //
    //  Shape B (TF Atlas): name wraps + class is REPEATED on the
    //    continuation row, brief lives on the continuation row.
    //      "Dynamic               Mutant"
    //      "Synchronization       Mutant    Shadow Strike..."
    //    First row parses with name="Dynamic", classCol="Mutant",
    //    brief="". Second row parses as a "new" entry with the same
    //    classCol — merge it back.
    //
    // Both detect via lastEntry-side state. Shape A: cols.classCol is
    // empty. Shape B: cols.classCol matches lastEntry.classColRaw AND
    // lastEntry.brief is empty.
    if (lastEntry && !cols.classCol) {
      // Shape A.
      lastEntry.name = (lastEntry.name + ' ' + cols.name).trim();
      if (cols.brief) {
        lastEntry.brief = (lastEntry.brief + ' ' + cols.brief).trim();
      }
      continue;
    }
    if (lastEntry
        && cols.classCol
        && cols.classCol === (lastEntry.classColRaw ?? '')
        && !lastEntry.brief) {
      // Shape B.
      lastEntry.name = (lastEntry.name + ' ' + cols.name).trim();
      lastEntry.brief = cols.brief;
      continue;
    }

    const classes = extractClassesFromCol(cols.classCol);
    const requirement = /^Two of\s+/i.test(cols.classCol) ? 'two-of' : 'any-listed';
    lastEntry = {
      name: cols.name,
      classes,
      classColRaw: cols.classCol,
      requirement,
      brief: cols.brief,
    };
    classBound.push(lastEntry);
  }

  // Layer entries into skills.json. Class-bound entries go into each
  // referenced class's `heroic` array; multi-class entries duplicated.
  let layered = 0;
  for (const entry of classBound) {
    if (!entry.classes.length) continue;
    for (const cls of entry.classes) {
      if (!skills.classes[cls]) continue;
      // De-dupe: if a heroic by this name already exists on this class
      // (e.g. from a previous run), skip.
      const exists = skills.classes[cls].heroic.some(h => h.name === entry.name);
      if (exists) continue;
      skills.classes[cls].heroic.push({
        name: entry.name,
        max_sl: 1,
        brief: entry.brief,
        classes: entry.classes,
        requirement: entry.requirement,
        source: { book: atlas.key, section: 'LIST OF NEW HEROIC SKILLS' },
      });
      layered++;
    }
  }

  summary[atlas.key] = {
    unique_entries: classBound.length,
    layered_instances: layered,
    sample_names: classBound.slice(0, 6).map(e => e.name + '(' + e.classes.join(',') + ')'),
  };
}

// Mark phase shipped.
skills._meta.phases.shipped.push('Atlas heroic skills (HF + NF + TF list-tables)');
skills._meta.phases.pending = skills._meta.phases.pending.filter(
  p => !/atlas.*heroic|heroic.*atlas/i.test(p)
);
skills._meta.phases.pending.push('LF Atlas class-specific heroic detail sections (Phase 5.2)');

fs.writeFileSync(DEST, JSON.stringify(skills, null, 2));
console.log(JSON.stringify(summary, null, 2));
