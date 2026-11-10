// 2026-11-10 — Armor Break / Magic Break: two general debuff statuses.
//   DEF (Armor Break) / M.DEF (Magic Break) x0.75, result rounded UP, 3 of the bearer's
//   turns, cleansable (tag `debuff`). User-approved plan; Rakshasa's own Crippled is NOT
//   touched. No Resist/Immune column yet (reports/2026-11-10-condition-resist-table-structure.md).
//
// Writes (game must be CLOSED; backs up both stores first):
//   items   — 2 template AEs on the Debuff library Item.XVOWOq9oUmEECGrU (Bane-shaped:
//             target_turn_end, 3 charges) + their ids in the item's `effects` list.
//             Mechanism = Rakshasa's Crippled: MULTIPLY on the bare prop, priority 50 (after
//             every other DEF change), flags.<ns>.roundUp (csb-ae-round-up.js).
//   journal — 2 rules journals in folder "New Debuff" + rows on the Keyword Repository
//             "Backup" page (Advanced Debuff section, alphabetical).
// The status-list entries are NOT in the settings store: they are appended from code by
// modules/fabula-ultima-companion/scripts/csb-extensions/csb-extra-status-effects.js.
// The chips/tooltip rows live in scripts/battle-director/keyword-registry.js.
//
//   node tools/safe-edit/bin/_build-break-statuses.js            (dry run)
//   node tools/safe-edit/bin/_build-break-statuses.js --apply
const path = require("path");
const fs = require("fs");
const { ClassicLevel } = require(path.join(__dirname, "..", "node_modules", "classic-level"));

const WORLD = path.join(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "data");
const NS = "fabula-ultima-companion";
const LIB = "XVOWOq9oUmEECGrU";               // Debuff library (activeEffectContainer)
const FOLDER_NEW_DEBUFF = "AVDtqV3SorzSrnY7";
const REPO = "U16BWkb0eRaemBB0", BACKUP_PAGE = "Wnhni42OXRQdSE7U";
const GM = "JQGNzKpDPHJmcUIW";
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/";
const BF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Buff%20Icon/";
const NOW = Date.now();

const STATUSES = [
  {
    name: "Armor Break", prop: "defense", label: "DEF", example: "19 DEF becomes 15",
    aeId: "ArmrBreakAE00001", statusId: "ArmrBreakStatId1", ce: "ce-armor-break", chargeKey: "armor_break",
    journalId: "ArmrBreakStatus1", pageId: "ArmrBreakPage001",
    img: ICON + "07_MNK/rockbreaker.png",
    basic: { name: "Slow", journal: "HHmYmj7xffQMqtzT", img: BF + "DEF%20DOWN.png" },
  },
  {
    name: "Magic Break", prop: "magic_defense", label: "M.DEF", example: "15 M.DEF becomes 12",
    aeId: "MagcBreakAE00001", statusId: "MagcBreakStatId1", ce: "ce-magic-break", chargeKey: "magic_break",
    journalId: "MagcBreakStatus1", pageId: "MagcBreakPage001",
    img: ICON + "17_PCT/Role_Actions/Addle.png",
    basic: { name: "Dazed", journal: "3nmUvPei3zrOJkEt", img: BF + "MAGICDEFENSE%20DOWN.png" },
  },
];

const stats = () => ({
  compendiumSource: null, duplicateSource: null, coreVersion: "12.343",
  systemId: "custom-system-builder", systemVersion: "4.8.5",
  createdTime: NOW, modifiedTime: NOW, lastModifiedBy: GM,
});

function buildAE(s) {
  return {
    name: s.name,
    img: s.img,
    icon: s.img,
    description: `<p>Reduce <strong>${s.label}</strong> by 25% <em>(Rounded Up)</em></p>`,
    _id: s.aeId,
    type: "base",
    system: { tags: ["debuff"] },
    changes: [{ key: s.prop, value: "0.75", mode: 1, priority: 50 }],
    disabled: false,
    duration: { startTime: null, seconds: null, combat: null, rounds: 3, turns: null, startRound: null, startTurn: null },
    origin: null,
    tint: "#ffffff",
    transfer: false,
    statuses: [s.statusId],
    sort: 0,
    flags: {
      "dfreds-convenient-effects": {
        ceEffectId: s.ce, isConvenient: true, isBackup: false, isTemporary: false, isViewable: true, isDynamic: false,
      },
      statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: false },
      "custom-system-builder": {
        isPredefined: true, originalParentId: LIB, originalId: s.aeId,
        originalUuid: `Item.${LIB}.ActiveEffect.${s.aeId}`, isFromTemplate: false,
      },
      [NS]: { lifetimeMode: "target_turn_end", chargeKey: s.chargeKey, charges: 3, chargesMax: 3, roundUp: [s.prop] },
    },
    _stats: stats(),
  };
}

function buildJournal(s) {
  const content =
    `<p><img class="centered" src="${s.img}" width="25" height="25" /></p>\n<hr />\n` +
    `<p style="text-align:center">Reduce <strong>${s.label}</strong> by 25% <em>(Rounded Up)</em></p>\n<p> </p>\n` +
    `<p style="text-align:center"><em>The remaining ${s.label} is rounded up: ${s.example}.</em></p>\n<p> </p>\n` +
    `<p><strong>Basic Condition:</strong></p>\n` +
    `<p><img style="float:left" src="${s.basic.img}" width="21" height="21" /></p>\n` +
    `<p>@UUID[JournalEntry.${s.basic.journal}]{${s.basic.name}}</p>`;
  const entry = {
    folder: FOLDER_NEW_DEBUFF, name: s.name, pages: [s.pageId], sort: 0,
    ownership: { default: 2, [GM]: 3 }, flags: {}, _stats: stats(), _id: s.journalId,
  };
  const page = {
    sort: 100000, name: "Description", type: "text", _id: s.pageId,
    title: { show: true, level: 1 }, image: {},
    text: { format: 1, content, markdown: "" },
    video: { controls: true, volume: 0.5 }, src: null, system: {},
    ownership: { default: -1 }, flags: {}, _stats: stats(),
  };
  return { entry, page };
}

// Insert one "<p><img …/>@UUID[JournalEntry.x]{Name}</p>" row per status into the
// Advanced Debuff section, before the first existing row whose name sorts after it.
function addBackupRows(html) {
  const start = html.indexOf("<h3>Advanced Debuff</h3>");
  if (start < 0) throw new Error("Backup page: no 'Advanced Debuff' heading");
  const nextH = html.indexOf("<h3>", start + 5);
  const end = nextH < 0 ? html.length : nextH;
  let section = html.slice(start, end);
  for (const s of STATUSES) {
    if (section.includes(`JournalEntry.${s.journalId}]`)) continue;
    const row = `<p><img src="${s.img}" width="21" height="21" />@UUID[JournalEntry.${s.journalId}]{${s.name}}</p>\n`;
    const re = /<p>[^\n]*?@UUID\[JournalEntry\.[^\]]+\]\{([^}]+)\}<\/p>\n?/g;
    let at = -1, m;
    while ((m = re.exec(section))) {
      if (m[1].localeCompare(s.name) > 0) { at = m.index; break; }
    }
    if (at < 0) { // after the last row
      let last = -1; re.lastIndex = 0;
      while ((m = re.exec(section))) last = m.index + m[0].length;
      at = last < 0 ? section.length : last;
    }
    section = section.slice(0, at) + row + section.slice(at);
  }
  return html.slice(0, start) + section + html.slice(end);
}

function assertClosed(dir) {
  const lock = path.join(dir, "LOCK");
  if (!fs.existsSync(lock)) return;
  try { fs.renameSync(lock, lock); } catch { throw new Error(`${dir} is locked: close Foundry first`); }
}

async function open(store) {
  const dir = path.join(WORLD, store);
  assertClosed(dir);
  const db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });
  return db;
}

(async () => {
  const apply = process.argv.includes("--apply");
  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const store of ["items", "journal"]) {
      const bk = path.join(__dirname, "..", "backups", `${stamp}-fabula-ultima-2-${store}-break-statuses`);
      fs.cpSync(path.join(WORLD, store), bk, { recursive: true, filter: (p) => !/[\\/]LOCK$/.test(p) });
      console.log("backup:", bk);
    }
  }

  // ── items ──
  const items = await open("items");
  try {
    const libKey = `!items!${LIB}`;
    const lib = JSON.parse(await items.get(libKey));
    if (lib.type !== "activeEffectContainer") throw new Error("Debuff library is not an activeEffectContainer");
    const batch = items.batch();
    for (const s of STATUSES) {
      // Refuse a name clash with an existing library AE (CSB looks predefined effects up by name).
      for await (const [k, v] of items.iterator({ gte: `!items.effects!${LIB}.`, lt: `!items.effects!${LIB}.~` })) {
        const ae = JSON.parse(v);
        if (ae.name === s.name && ae._id !== s.aeId) throw new Error(`Debuff library already has "${s.name}" (${ae._id})`);
      }
      batch.put(`!items.effects!${LIB}.${s.aeId}`, JSON.stringify(buildAE(s)));
      if (!lib.effects.includes(s.aeId)) lib.effects.push(s.aeId);
      console.log(`items: AE ${s.name} (${s.aeId}) changes ${JSON.stringify(buildAE(s).changes)}`);
    }
    batch.put(libKey, JSON.stringify(lib));
    if (apply) {
      await batch.write();
      const back = JSON.parse(await items.get(libKey));
      for (const s of STATUSES) {
        const ae = JSON.parse(await items.get(`!items.effects!${LIB}.${s.aeId}`));
        console.log(`  read back ${ae.name}: listed=${back.effects.includes(s.aeId)} roundUp=${JSON.stringify(ae.flags[NS].roundUp)} charges=${ae.flags[NS].charges}`);
      }
    } else { await batch.close?.(); }
  } finally { await items.close(); }

  // ── journal ──
  const journal = await open("journal");
  try {
    const batch = journal.batch();
    for (const s of STATUSES) {
      const { entry, page } = buildJournal(s);
      batch.put(`!journal!${s.journalId}`, JSON.stringify(entry));
      batch.put(`!journal.pages!${s.journalId}.${s.pageId}`, JSON.stringify(page));
      console.log(`journal: ${s.name} (${s.journalId}) in New Debuff`);
    }
    const bpKey = `!journal.pages!${REPO}.${BACKUP_PAGE}`;
    const bp = JSON.parse(await journal.get(bpKey));
    const before = bp.text.content;
    bp.text.content = addBackupRows(before);
    console.log(`journal: Backup page ${before.length} -> ${bp.text.content.length} chars`);
    for (const s of STATUSES) {
      const i = bp.text.content.indexOf(`{${s.name}}`);
      console.log("  ", bp.text.content.slice(Math.max(0, i - 40), i + 20).replace(/\n/g, "⏎"));
    }
    batch.put(bpKey, JSON.stringify(bp));
    if (apply) {
      await batch.write();
      for (const s of STATUSES) {
        const e = JSON.parse(await journal.get(`!journal!${s.journalId}`));
        console.log(`  read back journal ${e.name}: pages ${JSON.stringify(e.pages)}`);
      }
      const back = JSON.parse(await journal.get(bpKey)).text.content;
      console.log(`  read back Backup rows: ${STATUSES.map((s) => back.includes(`JournalEntry.${s.journalId}]`)).join(",")}`);
    } else { await batch.close?.(); console.log("dry run: nothing written (pass --apply)"); }
  } finally { await journal.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
