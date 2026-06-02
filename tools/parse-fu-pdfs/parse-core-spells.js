// Parse FU Core's per-class spell tables (Elementalist, Entropist,
// Spiritist). Layers spell entries onto skills.json under
// `classes.<Class>.spells`.
//
// Spell row format (from pdftotext -layout):
//
//   <Spell Name> [r]                 <MP>  <Target description>   <Duration>
//   [blank]
//   <description paragraph(s)>
//   [blank]
//
// The "r" marker denotes an offensive spell (requires Magic Check).
// Multi-target spells show "<MP> × T" in the MP column.
//
// Casting classes in Core: Elementalist, Entropist, Spiritist.
// Arcanist (Arcanums), Chimerist (Spell Mimic), Darkblade (specific
// spells via skills) don't have a flat spell table.

const fs = require('fs');
const path = require('path');

const SRC = 'e:/tmp/fu-pdf-text/Fabula_Ultima_TTJRPG.txt';
const DEST = process.env.SKILLS_JSON ?? path.resolve(
  __dirname, '..', '..',
  'modules', 'fabula-ultima-companion', 'reference', 'skills.json'
);

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

const CLASS_ANCHORS = [
  { cls: 'Elementalist', anchor: 'ELEMENTALIST SPELLS' },
  { cls: 'Entropist',    anchor: 'ENTROPIST SPELLS' },
  { cls: 'Spiritist',    anchor: 'SPIRITIST SPELLS' },
];

// Each spell table runs from `<CLASS> SPELLS` until the next page-spread
// boundary. We detect end-of-table by finding the next `<CLASS> SKILLS`
// or `<CLASS> SPELLS` header, OR a "Press Start"-style chapter banner.
function findClassSection(anchor) {
  const start = lines.findIndex(l => l.trim() === anchor);
  if (start < 0) return null;
  // End at next class section start.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^[A-Z]+ (SPELLS|SKILLS|FREE BENEFITS)\s*$/.test(t) && t !== anchor) {
      end = i;
      break;
    }
    // Also a heading like the next class's `WClassName` decorated line.
    if (/^W\s+[A-Z]+\s*$/.test(t)) { end = i; break; }
  }
  return { start, end };
}

// A spell row looks like:
//   Aura                                      5 × T Up to three creatures  Scene
//
// Strategy: detect lines starting with a Title-Case spell name that
// have an integer MP cost in the first or second column gap. The name
// may end with " r" (offensive marker, single lowercase r).
function parseSpellRowHead(line) {
  const t = line.replace(/^\s+/, '');
  if (!t) return null;

  // Match: <name (Title Case + optional space + r)>  <gap>  <number>
  const m = t.match(
    /^([A-Z][\w']*(?:\s+[\w'][\w']*)*\s*r?)\s{2,}(\d+(?:\s*[�×x]\s*T)?)\s+(.+?)\s{2,}(\S.*)$/
  );
  if (!m) return null;

  let name = m[1].trim();
  let isOffensive = false;
  if (/\sr$/.test(name)) {
    isOffensive = true;
    name = name.replace(/\sr$/, '').trim();
  }

  return {
    name,
    isOffensive,
    mp: m[2].trim().replace(/[�×x]\s*T/, '× T'),
    target: m[3].trim(),
    duration: m[4].trim(),
  };
}

function isLikelySpellSubHeader(line) {
  const t = line.trim();
  return /^SPELL\s+MP\s+TARGET/i.test(t);
}

function stripArtifacts(line) {
  return line
    .replace(/\s+\d+\s+CHAPTER\b.*$/, '')
    .replace(/\s+PRESS START\b.*$/, '')
    .replace(/^Piyaboot Pantanaviboon.*$/, '')
    .replace(/^\s*\d+\s*$/, '')
    .replace(/^c Spells marked.*$/, '')
    .replace(/^\s+W\s*$/, '')
    .trimEnd();
}

function cleanDesc(rawLines) {
  // Filter and rejoin description paragraphs.
  const paras = [];
  let current = [];
  for (const raw of rawLines) {
    const line = stripArtifacts(raw);
    if (!line.trim()) {
      if (current.length) { paras.push(current.join(' ')); current = []; }
      continue;
    }
    if (/^Piyaboot|^Order #|FABULA ULTIMA|^c Spells/.test(line.trim())) continue;
    if (isLikelySpellSubHeader(line)) continue;
    current.push(line.trim());
  }
  if (current.length) paras.push(current.join(' '));
  return paras.join('\n\n')
    .replace(/([a-z]{2,})([A-Z]{2,})/g, '$1 $2')
    .replace(/(\d)([a-z]{2,})/g, '$1 $2')
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Checks?/g, '$1 Checks')
    .replace(/SL([a-z])/g, 'SL $1')
    .replace(/(HR|SL)\s*\+\s*(\d+)/g, '$1 + $2');
}

const skills = JSON.parse(fs.readFileSync(DEST, 'utf8'));
const out = { _summary: {} };

for (const { cls, anchor } of CLASS_ANCHORS) {
  const sec = findClassSection(anchor);
  if (!sec) { out._summary[cls] = { error: 'anchor not found' }; continue; }
  const spells = [];
  let i = sec.start + 1;
  while (i < sec.end) {
    const raw = lines[i];
    const head = parseSpellRowHead(raw);
    if (head) {
      // Collect description lines until next spell row OR next subheader.
      const descLines = [];
      let j = i + 1;
      while (j < sec.end) {
        if (parseSpellRowHead(lines[j])) break;
        if (isLikelySpellSubHeader(lines[j])) { j++; continue; }
        descLines.push(lines[j]);
        j++;
      }
      spells.push({
        name: head.name,
        is_offensive: head.isOffensive,
        mp: head.mp,
        target: head.target,
        duration: head.duration,
        description: cleanDesc(descLines),
        source: { book: 'core', section: anchor, line: i + 1 },
      });
      i = j;
    } else {
      i++;
    }
  }
  skills.classes[cls] = skills.classes[cls] ?? { book: 'core', skills: [], heroic: [], spells: [] };
  skills.classes[cls].spells = spells;
  out._summary[cls] = { spell_count: spells.length, names: spells.map(s => s.name) };
}

skills._meta.phases.shipped.push('Core spells (Elementalist + Entropist + Spiritist tables)');
skills._meta.phases.pending = skills._meta.phases.pending.filter(
  p => !p.toLowerCase().includes('spell')
);

fs.writeFileSync(DEST, JSON.stringify(skills, null, 2));
console.log(JSON.stringify(out._summary, null, 2));
