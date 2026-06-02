// Generic Atlas parser — extracts class skills + class spells from a
// supplied Atlas PDF text. Layers onto skills.json under the same
// shape as Core (classes.<Class>.skills / .spells).
//
// Heroic skills from Atlases are handled by a separate pass (the
// list-table format differs across books). Each Atlas adds 3-4 new
// classes (5 skills each, RAW invariant).
//
// Configure via the `ATLASES` array — each entry: { key, file, classes }.

const fs = require('fs');
const path = require('path');

const TXT_DIR = 'e:/tmp/fu-pdf-text';
const DEST = process.env.SKILLS_JSON ?? path.resolve(
  __dirname, '..', '..',
  'modules', 'fabula-ultima-companion', 'reference', 'skills.json'
);

const ATLASES = [
  {
    key: 'atlas-hf',
    file: 'Fabula_Ultima_Atlas_High_Fantasy.txt',
    classes: ['Chanter', 'Commander', 'Dancer', 'Symbolist'],
  },
  {
    key: 'atlas-nf',
    file: 'Fabula_Ultima_-_Natural_Fantasy_Atlas_v1.0.txt',
    classes: ['Floralist', 'Gourmet', 'Invoker', 'Merchant'],
  },
  {
    key: 'atlas-tf',
    file: 'Fabula_Ultima_-_Techno_Fantasy_Atlas_v1.01.txt',
    classes: ['Esper', 'Mutant', 'Pilot'],
  },
  {
    key: 'atlas-lf',
    file: 'The_Low_Fantasy_Atlas.txt',
    classes: ['Hunter', 'Illusionist', 'Monk'],
  },
];

// ── Helpers (copied + adapted from parse-core-skills) ────────────────

function stripInlineArtifacts(line) {
  return line
    // The Atlas PDFs concatenate page-corner banners without word
    // breaks: "3 CHAPTERPROTAGONISTS" runs CHAPTER directly into the
    // next banner with no whitespace. `\b` doesn't fire there because
    // 'R' and 'P' are both word chars. Match `CHAPTER` followed by
    // letters or EOL/whitespace to soak up the whole tail.
    .replace(/\s+\d+\s+CHAPTER[A-Z]*.*$/, '')
    .replace(/\s+PRESS START[A-Z]*.*$/, '')
    .replace(/\s+PROTAGONISTS[A-Z]*.*$/, '')   // Atlas page-corner banner
    .replace(/\s+W\s*$/, '');
}

// Reject page-footer artifact lines as skill names. Two forms:
//   1. "W DANCER" — single letter W + class name pointer to next class
//   2. "W    A PILOT'S VEHICLE" — page banner for an aside section
// Both share the leading "W<whitespace>" structure that no real skill
// name starts with.
function isPageFooterW(line) {
  const t = line.trim();
  if (!/^W\s+[A-Z]/.test(t)) return false;
  return true;
}

const KNOWN_CLASSES_SUPER = new Set([
  // Core
  'ARCANIST', 'CHIMERIST', 'DARKBLADE', 'ELEMENTALIST', 'ENTROPIST',
  'FURY', 'GUARDIAN', 'LOREMASTER', 'ORATOR', 'ROGUE', 'SHARPSHOOTER',
  'SPIRITIST', 'TINKERER', 'WAYFARER', 'WEAPONMASTER',
  // HF / NF / TF / LF
  'CHANTER', 'COMMANDER', 'DANCER', 'SYMBOLIST',
  'FLORALIST', 'GOURMET', 'INVOKER', 'MERCHANT',
  'ESPER', 'MUTANT', 'PILOT',
  'HUNTER', 'ILLUSIONIST', 'MONK',
]);

function isLikelySkillName(line) {
  if (isPageFooterW(line)) return false;
  const cleaned = stripInlineArtifacts(line);
  const stripped = cleaned.replace(/\s*\([^\)]*\)\s*$/, '').trimEnd().replace(/^\s+/, '');
  if (stripped.length < 2 || stripped.length > 60) return false;
  if (!/^[A-Z][A-Z 0-9'’\-:&]+$/.test(stripped)) return false;
  if (/^\d+$/.test(stripped)) return false;
  if (stripped.endsWith(' SKILLS')) return false;
  if (stripped.endsWith(' SPELLS')) return false;
  if (stripped.endsWith(' FREE BENEFITS')) return false;
  const artifacts = [
    'PRESS START', 'CHAPTER', 'PIYABOOT PANTANAVIBOON', 'CORE RULEBOOK',
    'FABULA ULTIMA', 'PAGE', 'ALSO', 'FREE BENEFITS', 'NEW HEROIC SKILLS',
    'LIST OF NEW HEROIC', 'HEROIC SKILLS', 'HIGH FANTASY', 'NATURAL FANTASY',
    'TECHNO FANTASY', 'LOW FANTASY',
  ];
  if (artifacts.some(a => stripped.includes(a))) return false;
  const layoutLabels = ['MERGE ', 'DISMISS ', 'INVOKE ', 'SUMMON '];
  if (layoutLabels.some(l => stripped.startsWith(l))) return false;
  return true;
}

function isDescBoundary(line) {
  const t = line.trim();
  if (/^[A-Z]+ SPELLS\s*$/.test(t)) return true;
  if (/^[A-Z]+ FREE BENEFITS\s*$/.test(t)) return true;
  if (/^[A-Z]+ SKILLS\s*$/.test(t)) return true;
  if (/^SPELL\s+MP\s+TARGET/i.test(t)) return true;
  if (/^[A-Z][a-z]+ALSO:/.test(t)) return true;
  if (/^W\s+(?:[A-Z]+\s*)+$/.test(t)
      && Array.from(KNOWN_CLASSES_SUPER).some(c => t.includes(c))) return true;
  return false;
}

function isDescTerminator(line) {
  if (isLikelySkillName(line)) return true;
  if (isDescBoundary(line)) return true;
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
  const cleaned = stripInlineArtifacts(line);
  const m = cleaned.match(/\(\s*[^\)]*?(\d+)\s*\)\s*$/);
  if (m) return Number(m[1]);
  return 1;
}

function cleanLine(line) {
  return line.replace(/\s+\d+\s+CHAPTER\b/g, '')
             .replace(/\s+PRESS START\b/g, '')
             .replace(/\s+W\s*$/, '')
             .trimEnd();
}

function cleanSkillDesc(rawLines) {
  const trimmed = [];
  for (const line of rawLines) {
    if (isDescBoundary(line)) break;
    trimmed.push(line);
  }
  const paras = [];
  let current = [];
  for (const raw of trimmed) {
    const line = cleanLine(raw);
    if (!line.trim()) {
      if (current.length) { paras.push(current.join(' ')); current = []; }
      continue;
    }
    if (/^Piyaboot|^Order #|^W$|^n$|^O$|^\d+$|FABULA ULTIMA/.test(line.trim())) continue;
    current.push(line.trim());
  }
  if (current.length) paras.push(current.join(' '));

  return paras.join('\n\n')
    .replace(/([a-z]{2,})([A-Z]{2,})/g, '$1 $2')
    .replace(/(\d)([a-z]{2,})/g, '$1 $2')
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    .replace(/\b(a|an|by|to|of)([A-Z]{2,})/g, '$1 $2')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)\s*\+\s*(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Check/g, '$1 + $2 Check')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Check/g, '$1 Check')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Checks/g, '$1 Checks')
    .replace(/\bthanthe\b/g, 'than the')
    .replace(/SL([a-z])/g, 'SL $1')
    .replace(/(SL|HR|HP|MP|IP)\s*�\s*(\d+)/g, '$1 × $2');
}

// ── Atlas parse ──────────────────────────────────────────────────────

const skills = JSON.parse(fs.readFileSync(DEST, 'utf8'));
const summary = {};

for (const atlas of ATLASES) {
  const srcPath = path.join(TXT_DIR, atlas.file);
  if (!fs.existsSync(srcPath)) { summary[atlas.key] = { error: 'no text file' }; continue; }
  const text = fs.readFileSync(srcPath, 'utf8');
  const lines = text.split(/\r?\n/);

  // Register source.
  skills._meta.sources[atlas.key] = {
    title: atlas.key,
    file: atlas.file,
    phase: 'shipped',
  };

  const atlasSummary = {};

  for (const cls of atlas.classes) {
    const anchor = cls.toUpperCase() + ' SKILLS';
    const anchorRe = new RegExp('^\\s*' + anchor + '\\s*$');
    const start = lines.findIndex(l => anchorRe.test(l));
    if (start < 0) { atlasSummary[cls] = { error: 'anchor not found' }; continue; }

    // Find end of section — next class anchor or limit.
    let hardEnd = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^[A-Z]+ (SKILLS|SPELLS|FREE BENEFITS)\s*$/.test(t) && !anchorRe.test(lines[i])) {
        hardEnd = i;
        break;
      }
    }
    // Bound by spell tables / free-benefit transitions.
    let end = hardEnd;
    for (let i = start + 1; i < hardEnd; i++) {
      const t = lines[i].trim();
      if (/^[A-Z]+ SPELLS\s*$/.test(t)) { end = i; break; }
      if (/^[A-Z]+ FREE BENEFITS\s*$/.test(t)) { end = i; break; }
      if (/^SPELL\s+MP\s+TARGET/i.test(t)) { end = i; break; }
    }

    const classSkills = [];
    let i = start + 1;
    while (i < end && classSkills.length < 5) {
      const raw = lines[i];
      if (isLikelySkillName(raw)) {
        const cleaned = stripInlineArtifacts(raw);
        const name = cleaned.replace(/\s*\([^\)]*\)\s*$/, '').trim();
        const maxSl = extractMaxSL(raw);
        const descLines = [];
        let j = i + 1;
        while (j < end) {
          if (isDescTerminator(lines[j])) break;
          descLines.push(lines[j]);
          j++;
        }
        classSkills.push({
          name: name.toLowerCase().replace(/(^| )(\w)/g, (_, sp, c) => sp + c.toUpperCase()),
          max_sl: maxSl,
          description: cleanSkillDesc(descLines),
          source: { book: atlas.key, section: anchor, line: i + 1 },
        });
        i = j;
      } else {
        i++;
      }
    }

    skills.classes[cls] = skills.classes[cls] ?? {
      book: atlas.key, skills: [], heroic: [], spells: [],
    };
    skills.classes[cls].skills = classSkills;
    atlasSummary[cls] = {
      count: classSkills.length,
      skills: classSkills.map(s => s.name + '[' + s.max_sl + ']').join(', '),
    };
  }

  summary[atlas.key] = atlasSummary;
}

skills._meta.phases.shipped.push('Atlas class skills (HF + NF + TF + LF, 14 new classes)');
skills._meta.phases.pending = skills._meta.phases.pending.filter(
  p => !p.toLowerCase().includes('atlas')
);

fs.writeFileSync(DEST, JSON.stringify(skills, null, 2));
console.log(JSON.stringify(summary, null, 2));
