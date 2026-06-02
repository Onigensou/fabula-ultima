// Bonus-book parser. Each Bonus PDF adds different content:
//   • Ace of Cards — adds the "Ace of Cards" class (5 skills)
//   • Necromancer — adds the "Necromancer" class (5 skills)
//   • Arcane Whispers — adds new Arcanums (Arcanist extension) — skipped
//     for now; not class skills.
//   • Halloween 2023 / 2024 — Halloween-themed heroic skills.
//
// This parser handles the class additions. Heroic skills from Halloween
// PDFs are tracked in `_meta.phases.pending` as a separate Phase 5.1.

const fs = require('fs');
const path = require('path');

const TXT_DIR = 'e:/tmp/fu-pdf-text';
const DEST = process.env.SKILLS_JSON ?? path.resolve(
  __dirname, '..', '..',
  'modules', 'fabula-ultima-companion', 'reference', 'skills.json'
);

const BONUS_CLASSES = [
  {
    key: 'bonus-ace-of-cards',
    file: 'Fabula-Bonus-Ace-of-Cards.txt',
    className: 'Ace of Cards',
    anchor: 'ACE OF CARDS SKILLS',
  },
  {
    key: 'bonus-necromancer',
    file: 'Fabula-Ultima-Bonus-01-Necromancer.txt',
    className: 'Necromancer',
    anchor: 'NECROMANCER SKILLS',
  },
];

// ── Shared helpers (copy from parse-atlas-skills.js) ─────────────────

function stripInlineArtifacts(line) {
  return line
    .replace(/\s+\d+\s+CHAPTER[A-Z]*.*$/, '')
    .replace(/\s+PRESS START[A-Z]*.*$/, '')
    .replace(/\s+PROTAGONISTS[A-Z]*.*$/, '')
    .replace(/\s+W\s*$/, '');
}

function isPageFooterW(line) {
  return /^W\s+[A-Z]/.test(line.trim());
}

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
  const artifacts = ['MERGE ', 'DISMISS ', 'INVOKE ', 'SUMMON ', 'PIYABOOT', 'CHAPTER', 'PRESS', 'CORE RULEBOOK'];
  if (artifacts.some(a => stripped.includes(a))) return false;
  return true;
}

function isDescTerminator(line) {
  if (isLikelySkillName(line)) return true;
  const cleaned = stripInlineArtifacts(line).trim();
  if (cleaned.length >= 5 && cleaned.length <= 60
      && /^[A-Z][A-Z 0-9'’\-:&]+$/.test(cleaned)
      && !/^(MERGE|DISMISS|INVOKE|SUMMON) /.test(cleaned)) {
    return true;
  }
  return false;
}

function extractMaxSL(line) {
  const cleaned = stripInlineArtifacts(line);
  const m = cleaned.match(/\(\s*[^\)]*?(\d+)\s*\)\s*$/);
  return m ? Number(m[1]) : 1;
}

function cleanLine(line) {
  return line.replace(/\s+\d+\s+CHAPTER[A-Z]*/g, '')
             .replace(/\s+PRESS START[A-Z]*/g, '')
             .replace(/\s+W\s*$/, '')
             .trimEnd();
}

function cleanSkillDesc(rawLines) {
  const paras = [];
  let current = [];
  for (const raw of rawLines) {
    const line = cleanLine(raw);
    if (!line.trim()) {
      if (current.length) { paras.push(current.join(' ')); current = []; }
      continue;
    }
    if (/^Piyaboot|^Sarunphat|^Order #|^W$|^n$|^O$|^\d+$|FABULA ULTIMA/.test(line.trim())) continue;
    current.push(line.trim());
  }
  if (current.length) paras.push(current.join(' '));
  return paras.join('\n\n')
    .replace(/([a-z]{2,})([A-Z]{2,})/g, '$1 $2')
    .replace(/(\d)([a-z]{2,})/g, '$1 $2')
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    .replace(/(DEX|INS|MIG|WLP|HP|MP|IP|HR|SL)Check/g, '$1 Check')
    .replace(/SL([a-z])/g, 'SL $1')
    .replace(/(SL|HR|HP|MP|IP)\s*�\s*(\d+)/g, '$1 × $2');
}

// ── Run ─────────────────────────────────────────────────────────────

const skills = JSON.parse(fs.readFileSync(DEST, 'utf8'));
const summary = {};

for (const bonus of BONUS_CLASSES) {
  const srcPath = path.join(TXT_DIR, bonus.file);
  if (!fs.existsSync(srcPath)) { summary[bonus.key] = { error: 'no text file' }; continue; }
  const text = fs.readFileSync(srcPath, 'utf8');
  const lines = text.split(/\r?\n/);

  skills._meta.sources[bonus.key] = { title: bonus.key, file: bonus.file, phase: 'shipped' };

  const anchorRe = new RegExp('^\\s*' + bonus.anchor + '\\s*$');
  const start = lines.findIndex(l => anchorRe.test(l));
  if (start < 0) { summary[bonus.key] = { error: 'anchor not found' }; continue; }

  // End at next section heading or EOF.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^[A-Z]+ (SKILLS|SPELLS|FREE BENEFITS)\s*$/.test(t) && !anchorRe.test(lines[i])) {
      end = i;
      break;
    }
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
        source: { book: bonus.key, section: bonus.anchor, line: i + 1 },
      });
      i = j;
    } else {
      i++;
    }
  }

  skills.classes[bonus.className] = {
    book: bonus.key, skills: classSkills, heroic: [], spells: [],
  };
  summary[bonus.key] = {
    className: bonus.className,
    count: classSkills.length,
    skills: classSkills.map(s => s.name + '[' + s.max_sl + ']').join(', '),
  };
}

skills._meta.phases.shipped.push('Bonus class additions (Ace of Cards + Necromancer)');
skills._meta.phases.pending.push('Bonus Halloween + Arcane Whispers heroic skills + Arcanums (Phase 5.1)');

fs.writeFileSync(DEST, JSON.stringify(skills, null, 2));
console.log(JSON.stringify(summary, null, 2));
