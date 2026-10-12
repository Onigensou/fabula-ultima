// One-off: initial camera view for the Midgard / Valley of the Dragon / Fafnir Castle maps.
// These 35 scenes were created at fit-whole-map; this moves each one onto its
// forward entrance (or campfire) at the old maps' zoom yardstick: ~200 screen px
// per grid square, capped at 3, edge-clamped for a 1920x1027 window.
// Game must be closed. Usage: node bin/_set-initial-views-valley-chapter.js [--dry-run]
const { openCollection } = require('../lib/db');
const { snapshotCollection } = require('../lib/backup');
const { assertGameClosed } = require('../lib/lock');
const journal = require('../lib/journal');

// [sceneId, name, x, y, scale]
const VIEWS = [
  ["H7A94pOj6BniOQOS", "FafnirCastle_Map001", 1000, 1330, 2],
  ["ob5P49Qh7Q0arM4h", "FafnirCastle_Map002", 620, 1111, 3],
  ["KvNYZ6DkF9IK3U6h", "FafnirCastle_Map003", 820, 969, 3],
  ["EeSqDyDP1Vsr54d5", "FafnirCastle_Map004", 635, 1418, 2.85],
  ["vpQjEwSupTUWK6fV", "FafnirCastle_Map005", 500, 1374, 3],
  ["iQ026ac7nbWz8Mnr", "FafnirCastle_Map006", 320, 853, 3],
  ["M1rQfQANgPeHmMjB", "FafnirCastle_Map007", 830, 915, 3],
  ["M7tMjQIVNww5OzFw", "Midgard_Map001", 1370, 2321, 2.65],
  ["ZpMbv36000qG3wLQ", "Midgard_Map002", 623, 943, 1.65],
  ["Yiw5noqR6owuCGOD", "Midgard_Map003", 549, 961, 1.75],
  ["FGXGqPqN7LI6ZI6b", "Midgard_Map004", 625, 969, 1.8],
  ["DhpfHJUGiFSjPL6n", "Midgard_Map005", 540, 754, 1.9],
  ["nAJ9SB2Jd5sQVOvB", "Midgard_Map006", 1080, 1525, 2.85],
  ["FJIuQxT8WkTE4ZHk", "Midgard_Map007", 700, 906, 2.85],
  ["Q5xV2REbz5PqOFZ4", "Valley_Map002", 765, 655, 2],
  ["kuqgG7QW9bkZtZ7P", "Valley_Map003", 480, 1865, 2],
  ["zo6ZTpspg2C5GnP4", "Valley_Map004", 600, 470, 3],
  ["QIUobWQvzsjvZK08", "Valley_Map005", 520, 1895, 2.5],
  ["8ZqllaT165aEOEOn", "Valley_Map006", 752, 957, 2.2],
  ["YR0pYJVokhIgKQj0", "Valley_Map007", 681, 1067, 3],
  ["w0Ol6v1IYj2lG39s", "Valley_Map008", 860, 940, 3],
  ["09CApvaBfOesGfbp", "Valley_Map009", 362, 194, 2.65],
  ["52LLgHZIyAXBrbMq", "Valley_Map010", 792, 171, 3],
  ["MWQBX1ZnbjcFkvq2", "Valley_Map011", 420, 915, 3],
  ["bcg4esedBAmZTEVL", "Valley_Map012", 320, 500, 3],
  ["V1pUCPofEqLN4sze", "Valley_Map013", 1126, 2619, 1.45],
  ["QfybShj4gr9Bd2rn", "Valley_Map014", 1307, 561, 3],
  ["67ucunbbGU3GvUUX", "Valley_Map015", 1358, 1430, 2.85],
  ["fWcFHcIHLO8WOrlr", "Valley_Map016", 580, 760, 3],
  ["YnGINTK5qxtt0rnO", "Valley_Map017", 900, 935, 2.35],
  ["g8segD1wSQEHY4Jp", "Valley_Map018", 320, 1251, 3],
  ["ST03Wjy5ZaVRND4m", "Valley_Map019", 320, 1391, 3],
  ["XNTSewM1NcPG59L1", "Valley_Map020", 975, 1290, 3],
  ["EtlYqCkE1aTvbwKo", "Valley_Map021", 500, 1158, 2.85],
  ["or2XPkXT448qmdrh", "Valley_Map022", 510, 1353, 3],
];

(async () => {
  const dry = process.argv.includes('--dry-run');
  assertGameClosed();
  const backupPath = dry ? null : snapshotCollection('scenes');
  const db = await openCollection('scenes');
  let changed = 0;
  try {
    for (const [id, name, x, y, scale] of VIEWS) {
      const key = '!scenes!' + id;
      const doc = await db.get(key);
      if (!doc || doc.name !== name) throw new Error('Scene mismatch for ' + id + ': expected ' + name + ', got ' + (doc && doc.name));
      const before = journal.hash(doc);
      const was = doc.initial || {};
      doc.initial = { x, y, scale };
      console.log(name.padEnd(22), '(' + Math.round(was.x) + ',' + Math.round(was.y) + ' @' + Number(was.scale).toFixed(2) + ') -> (' + x + ',' + y + ' @' + scale + ')');
      if (dry) continue;
      await db.put(key, doc);
      const back = await db.get(key);
      if (back.initial.x !== x || back.initial.y !== y || back.initial.scale !== scale) throw new Error('Read-back mismatch on ' + name);
      journal.append({ uuid: 'Scene.' + id, collection: 'scenes', key, beforeHash: before, afterHash: journal.hash(back), backupPath, patch: { initial: doc.initial }, note: 'initial camera view (valley chapter)' });
      changed++;
    }
  } finally { await db.close(); }
  console.log(dry ? 'dry run, nothing written' : changed + ' scenes updated; backup ' + backupPath);
})().catch(e => { console.error(e); process.exit(1); });
