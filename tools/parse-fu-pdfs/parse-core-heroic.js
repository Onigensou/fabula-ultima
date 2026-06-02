// Parse FU Core's heroic skills LIST table (Chapter 4, p.232-233 area).
//
// The LIST table is a 3-column layout:
//   <Skill Name>    <Class | comma-separated classes | blank for universal>    <Brief description>
//
// Universal heroic skills (Ambidextrous / Extra HP / Extra IP / Extra MP /
// Extra Spells) have an empty class column. Class-bound entries name one
// or more requirement classes.
//
// This parser layers heroic skill entries onto the existing skills.json
// produced by parse-core-skills.js. Class-bound entries go to
// `classes.<Class>.heroic`; multi-class entries are duplicated into each
// referenced class. Universal entries go to `universal_heroic`.
//
// Every Heroic Skill is `max_sl: 1` by RAW (acquired once on Class
// mastery; no SL progression).

const fs = require('fs');
const path = require('path');

const SRC = 'e:/tmp/fu-pdf-text/Fabula_Ultima_TTJRPG.txt';
const DEST = process.env.SKILLS_JSON ?? path.resolve(
  __dirname, '..', '..',
  'modules', 'fabula-ultima-companion', 'reference', 'skills.json'
);

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

// The LIST OF HEROIC SKILLS table spans a page break, so the marker
// appears twice. Find both segments and join them.
const tableStart = lines.findIndex(l => l.trim() === 'LIST OF HEROIC SKILLS');
if (tableStart < 0) { console.error('LIST OF HEROIC SKILLS not found'); process.exit(1); }

// End the table at the FIRST ALL-CAPS standalone line that looks
// like a detail-section heading (ADVERSITY, COMET, DEEP POCKETS,
// etc.). The table uses Title Case names; the detail section uses
// ALL CAPS — that's the reliable boundary.
let tableEnd = lines.length;
for (let i = tableStart + 1; i < Math.min(tableStart + 200, lines.length); i++) {
  const raw = lines[i];
  const stripped = raw
    .replace(/\s+\d+\s+CHAPTER\b.*$/, '')
    .replace(/\s+PRESS START\b.*$/, '')
    .trim();
  // ALL-CAPS letters + spaces only, 4-30 chars, NOT a known artifact.
  if (/^[A-Z][A-Z 0-9'!]{3,30}$/.test(stripped)
      && !stripped.includes('PIYABOOT')
      && !stripped.endsWith('SKILLS')
      && stripped !== 'LIST OF HEROIC SKILLS') {
    tableEnd = i;
    break;
  }
}

// Two sub-sections: "available to all characters" vs "with a Class
// mastery requirement". Track which by looking for the section header.
let subsection = null;  // "universal" | "class-bound"
const universal = [];
const classBound = [];  // { name, classes: ["Rogue"], brief }

// Known class names (PascalCase) for matching the class column.
const KNOWN_CLASSES = new Set([
  'Arcanist', 'Chimerist', 'Darkblade', 'Elementalist', 'Entropist',
  'Fury', 'Guardian', 'Loremaster', 'Orator', 'Rogue', 'Sharpshooter',
  'Spiritist', 'Tinkerer', 'Wayfarer', 'Weaponmaster',
]);

function stripArtifacts(line) {
  return line
    .replace(/\s+\d+\s+CHAPTER\b.*$/, '')
    .replace(/\s+PRESS START\b.*$/, '')
    .replace(/\s+W\s*$/, '')
    .replace(/^Piyaboot Pantanaviboon.*$/, '')
    .replace(/^LIST OF HEROIC SKILLS\s*$/, '')
    .trimEnd();
}

// Split a table row into name / class-column / brief.
//
// Two strategies:
//
//  (A) 2+-space gaps preserved by pdftotext — primary case. Works for
//      most rows where the PDF columns align nicely.
//  (B) Single-space collapse — happens when pdftotext mis-aligns and
//      runs the columns together (e.g. "Powerful Strike Fury or
//      Weaponmaster Deal extra damage in melee."). Fallback: find
//      the FIRST known class token in the line and split the name
//      before / classCol from-token-until-next-2-space / brief after.
function splitColumns(line) {
  const t = line.replace(/^\s+/, '');
  // Strip "W " decoration prefix (some entries have it).
  const noDecor = t.replace(/^W\s+/, '');

  // Strategy A: 2+ space gap between name and class column.
  const aGap = noDecor.match(/^([\w'!\-.: ]+?)\s{2,}(.*)$/);
  if (aGap) {
    const name = aGap[1].trim();
    const rest = aGap[2];
    // 2+ space gap between class and brief.
    const classM = rest.match(/^([A-Za-z ,]+?(?:\s+or\s+\w+)?)\s{2,}(.+)$/);
    if (classM) {
      return { name, classCol: classM[1].trim(), brief: classM[2].trim() };
    }
    // No 2-space gap. Single-space collapse between class list and
    // brief. Find the first known-class word in rest, then scan
    // forward for the brief desc start (a known class word followed
    // by something that's NOT a class continuation token).
    const splitB = scanByKnownClass(rest, { allowEmptyName: true });
    if (splitB && splitB.classCol) {
      return { name, classCol: splitB.classCol, brief: splitB.brief };
    }
    return { name, classCol: '', brief: rest.trim() };
  }

  // Strategy B: no 2+ space gap at all. Scan the whole line for the
  // first known class token; everything before it is the name.
  const splitC = scanByKnownClass(noDecor);
  if (splitC) {
    return splitC;
  }
  return null;
}

// Given a string that contains (potentially) a class token list,
// return the split into classCol / brief. classCol is the contiguous
// run of known-class tokens (separated by commas and "or"), brief is
// everything after.
//
// `allowEmptyName: true` skips the namePart-non-empty check — used
// when strategy A has already extracted the name and just needs us
// to split the rest into classCol+brief.
function scanByKnownClass(rest, { allowEmptyName = false } = {}) {
  // Tokenise. We want to identify a span [start..end] of class-list
  // tokens. Allowed inter-class tokens: ",", "or".
  const tokens = rest.split(/(\s+)/);  // keep whitespace
  const isClassTok = (tk) => {
    if (!tk) return false;
    if (KNOWN_CLASSES.has(tk)) return true;
    // Strip trailing punctuation like "Chimerist," or "Spiritist."
    const bare = tk.replace(/[,.;]+$/, '');
    return KNOWN_CLASSES.has(bare);
  };
  let firstClassIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (isClassTok(tokens[i])) { firstClassIdx = i; break; }
  }
  if (firstClassIdx < 0) return null;

  // Walk forward absorbing class-list tokens.
  let lastClassIdx = firstClassIdx;
  for (let j = firstClassIdx + 1; j < tokens.length; j++) {
    const tk = tokens[j];
    if (/^\s+$/.test(tk)) continue;  // whitespace OK between class tokens
    if (tk === ',' || tk === 'or') { lastClassIdx = j; continue; }
    if (isClassTok(tk)) { lastClassIdx = j; continue; }
    break;
  }

  // Name = everything before firstClassIdx, brief = everything after lastClassIdx.
  const namePart = tokens.slice(0, firstClassIdx).join('').trim();
  const classCol = tokens.slice(firstClassIdx, lastClassIdx + 1).join('').trim();
  const brief = tokens.slice(lastClassIdx + 1).join('').trim();
  if (!namePart && !allowEmptyName) return null;
  return { name: namePart, classCol, brief };
}

// Parse the table.
let lastClassBound = null;
for (let i = tableStart + 1; i < tableEnd; i++) {
  const raw = lines[i];
  const stripped = stripArtifacts(raw);
  const trimmed = stripped.trim();
  if (!trimmed) { lastClassBound = null; continue; }

  // Section headers.
  if (/^Heroic Skills available to all characters\s*$/i.test(trimmed)) {
    subsection = 'universal'; continue;
  }
  if (/^Heroic Skills with a Class mastery requirement/i.test(trimmed)) {
    subsection = 'class-bound'; continue;
  }
  if (/^Piyaboot|^Order #|^\d+\s*$/.test(trimmed)) continue;
  if (trimmed === 'LIST OF HEROIC SKILLS') continue;

  // If the line is heavily indented and has no name-column content,
  // it's a continuation of the previous entry. Two cases:
  //
  //  (i) Class-list continuation: the previous entry's classCol ended
  //      with a comma (incomplete list — "Chimerist, Elementalist,").
  //      The continuation line carries the rest of the class list
  //      ("Entropist or Spiritist"). Parse it as additional classes
  //      and append to the entry's classes array.
  //
  //  (ii) Brief desc continuation: normal multi-line wrapped
  //      description.
  if (/^\s{30,}/.test(stripped)) {
    if (lastClassBound && /,\s*$/.test(lastClassBound.classColRaw ?? '')) {
      // Class-list continuation. Tokens like "Entropist or Spiritist".
      const extra = trimmed
        .split(/,|\s+or\s+/)
        .map(s => s.replace(/[,.;]+$/, '').trim())
        .filter(s => KNOWN_CLASSES.has(s));
      if (extra.length) {
        lastClassBound.classes.push(...extra);
        lastClassBound.classColRaw += ' ' + trimmed;
        continue;
      }
    }
    if (lastClassBound) {
      lastClassBound.brief = (lastClassBound.brief + ' ' + trimmed).trim();
    } else if (universal.length) {
      universal[universal.length - 1].brief =
        (universal[universal.length - 1].brief + ' ' + trimmed).trim();
    }
    continue;
  }

  const cols = splitColumns(stripped);
  if (!cols) { lastClassBound = null; continue; }

  if (subsection === 'universal') {
    universal.push({ name: cols.name, brief: cols.brief });
    lastClassBound = null;
  } else if (subsection === 'class-bound') {
    // Parse classCol: PascalCase tokens separated by commas / "or".
    // E.g. "Chimerist, Elementalist," (with trailing comma — continuation)
    //  or "Fury or Weaponmaster".
    const classes = cols.classCol
      .split(/,|\s+or\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && KNOWN_CLASSES.has(s));
    // The row may have classes split across line continuation ("Chimerist,
    // Elementalist," on row 1; "Entropist or Spiritist" on row 2). Track
    // for fixup.
    lastClassBound = {
      name: cols.name,
      classes,
      classColRaw: cols.classCol,
      brief: cols.brief,
    };
    classBound.push(lastClassBound);
  }
}

// Fixup pass: some entries (Powerful Spell) span continuation lines
// with additional classes. Merge any "incomplete" class column with
// the next continuation line.
for (let i = 0; i < classBound.length; i++) {
  const e = classBound[i];
  if (e.classColRaw && /,\s*$/.test(e.classColRaw)) {
    // Next entry's name might actually be a class continuation.
    const next = classBound[i + 1];
    if (next && next.name.match(/^\w+\s+or\s+\w+$/)) {
      // "Entropist or Spiritist" -> merge into prev.
      const extra = next.name.split(/\s+or\s+/).map(s => s.trim())
        .filter(s => KNOWN_CLASSES.has(s));
      e.classes.push(...extra);
      classBound.splice(i + 1, 1);  // remove the bogus row
    }
  }
}

// Load existing skills.json and layer heroic skills in.
const skills = JSON.parse(fs.readFileSync(DEST, 'utf8'));

skills.universal_heroic = universal.map(u => ({
  name: u.name,
  max_sl: 1,
  brief: u.brief,
  source: { book: 'core', section: 'LIST OF HEROIC SKILLS — Universal' },
}));

// Class-bound heroic skills: each entry goes into every named class's
// `heroic` array. Multi-class skills get duplicated entries.
for (const cls of Object.keys(skills.classes)) {
  skills.classes[cls].heroic = [];
}
for (const entry of classBound) {
  if (!entry.classes.length) continue;
  for (const cls of entry.classes) {
    if (!skills.classes[cls]) continue;
    skills.classes[cls].heroic.push({
      name: entry.name,
      max_sl: 1,
      brief: entry.brief,
      classes: entry.classes,  // full multi-class list (informational)
      source: { book: 'core', section: 'LIST OF HEROIC SKILLS — Class-bound' },
    });
  }
}

skills._meta.phases.shipped.push('Core heroic skills (universal + class-bound, brief)');
skills._meta.phases.pending = skills._meta.phases.pending.filter(
  p => !p.toLowerCase().includes('heroic')
);

fs.writeFileSync(DEST, JSON.stringify(skills, null, 2));

console.log(JSON.stringify({
  universal_count: universal.length,
  class_bound_count: classBound.length,
  per_class_heroic: Object.fromEntries(
    Object.entries(skills.classes).map(([c, x]) => [c, x.heroic.length])
  ),
}, null, 2));
