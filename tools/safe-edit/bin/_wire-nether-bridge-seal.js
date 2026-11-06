"use strict";
// ============================================================================
// Wire the Great Seal on the Nether Bridge (scene Valley_Map025,
// sEaLbRiDgEvM0250; seal event tile YoFcKf8BDP8mlf3s).
//
// The event (built and live-tested in a sandbox 2026-11-07):
//   Dim. First visit: "A wall of green light bars the way." / "Some sort of
//   marking is carved on the circle." Then a Group Check, INS + WLP, DL 15
//   (hidden), led by the main controller's character; anyone else may help
//   (DL 10, +1 each).
//     Pass -> Self B on (decoded), Self A off, the rune lines.
//     Fail -> Self A on, "You failed to understand…", end.
//   Visit after a failure: "Study it again (1 Fabula Point)" / "Leave it";
//     the retry needs >= 1 Fabula Point on the controller's character and
//     spends it. With none: "You have nothing left to give it…", end.
//   Visit after decoding: straight to the rune lines.
//   Then "Make an offering" / "Leave it". Offer Item: 3 items, free choice,
//   GM Prompt (main GM only): Unsealed -> sound, green flash, story switch
//   "Great Seal Open" ON (the existing story gate opens the wall), "The Green
//   light vanish into thin air." / Not satisfied -> "Nothing Happened....",
//   end (the party may offer again). The items are never taken.
//
// Only flags["oni-event-system"].eventRows (+ its JSON preview) change; the
// tile keeps availableWhen (Great Seal Open is OFF) and everything else.
//
// Game must be closed. Run:  node tools/safe-edit/bin/_wire-nether-bridge-seal.js [--dry-run]
// ============================================================================

const path = require("node:path");
const crypto = require("node:crypto");
const LIB = path.join(__dirname, "..", "lib");
const { openCollection }     = require(LIB + "/db.js");
const { assertGameClosed }   = require(LIB + "/lock.js");
const { snapshotCollection } = require(LIB + "/backup.js");
const journal                = require(LIB + "/journal.js");

const COLLECTION = "scenes";
const SCENE = "sEaLbRiDgEvM0250";
const TILE = "YoFcKf8BDP8mlf3s";
const KEY = `!scenes.tiles!${SCENE}.${TILE}`;
const SCOPE = "oni-event-system";
const SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg";
const DRY = process.argv.includes("--dry-run");

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const id = () => Array.from(crypto.randomBytes(16), b => ALPHA[b % ALPHA.length]).join("");

const float = (text) => ({ id: id(), type: "floatingText", text, place: "auto", name: "", nudgeX: 0, nudgeY: 0, startFresh: false, autoSeconds: 0 });
const end = () => ({ id: id(), type: "endEvent" });
const self = (slot, value) => ({ id: id(), type: "setSwitch", scope: "self", name: "", slot, value });

const WALL = "A wall of green light bars the way.";
const RUNE = [
  "Here lies mine Adversary, forever bound to the earth.",
  "To meet with “<b>him</b>” one must offer <b>The Blood of Nemesis</b>, <b>A bone of their own kin</b> and <b>a soul bound under covenant</b>."
];

function buildRows() {
  return [
    { id: id(), type: "screenEffect", effect: "dim", color: "#000000", strength: 0.5, seconds: 0.6, wait: true },
    {
      id: id(), type: "condition",
      condition: { kind: "self", slot: "B", want: "on" }, moreConditions: [], combine: "all", hasElse: true,
      thenRows: [float(WALL), float("The rune reads the same as before."), ...RUNE.map(float)],
      elseRows: [
        {
          id: id(), type: "condition",
          condition: { kind: "self", slot: "A", want: "on" }, moreConditions: [], combine: "all", hasElse: true,
          thenRows: [
            float(WALL),
            float("The meaning of the runes yet eludes you."),
            {
              id: id(), type: "showChoices", prompt: "", roleplay: false, roleplayLabel: "Something else…",
              options: [
                {
                  id: id(), label: "Study it again (1 Fabula Point)", cancel: false,
                  rows: [{
                    id: id(), type: "condition",
                    condition: { kind: "fabula", op: ">=", value: 1 }, moreConditions: [], combine: "all", hasElse: true,
                    thenRows: [{ id: id(), type: "changeFabulaPoints", targets: [{ kind: "controller", slot: 1, name: "" }], op: "decrease", operand: "constant", amount: 1, variable: "" }],
                    elseRows: [float("You have nothing left to give it. (You need 1 Fabula Point.)"), end()]
                  }]
                },
                { id: id(), label: "Leave it", cancel: true, rows: [end()] }
              ]
            }
          ],
          elseRows: [float(WALL), float("Some sort of marking is carved on the circle.")]
        },
        {
          id: id(), type: "runCheck", label: "", attrA: "INS", attrB: "WLP", dl: 15, hiddenDl: true,
          targets: [{ kind: "party", slot: 1, name: "" }], combine: "group", groupLeader: "controller",
          useSpecial: false, storeVar: "",
          successRows: [
            self("B", "on"), self("A", "off"),
            float("You decipher the meaning of the rune."),
            float("The rune is written in Ancient Draconic Language."),
            ...RUNE.map(float)
          ],
          failureRows: [self("A", "on"), float("You failed to understand the meaning of the rune."), end()],
          critRows: [], fumbleRows: []
        }
      ]
    },
    {
      id: id(), type: "showChoices", prompt: "", roleplay: false, roleplayLabel: "Something else…",
      options: [
        {
          id: id(), label: "Make an offering", cancel: false,
          rows: [{
            id: id(), type: "offerItem", count: 3, mode: "free", names: "", itemType: "key", judge: "gm",
            title: "Offering", ask: "The seal asks for 3 offerings.",
            gmNote: "The rune asks for the Blood of Nemesis, a bone of their own kin and a soul bound under covenant. Accept anything that fits. The items are not taken.",
            presets: [
              {
                id: id(), label: "Unsealed",
                rows: [
                  { id: id(), type: "playSound", src: SFX, volume: 0.7, wait: false },
                  { id: id(), type: "screenEffect", effect: "flash", color: "#7dffa8", strength: 0, seconds: 0.8, wait: false },
                  { id: id(), type: "setSwitch", scope: "story", name: "Great Seal Open", slot: "A", value: "on" },
                  float("The Green light vanish into thin air.")
                ]
              },
              { id: id(), label: "Not satisfied", rows: [float("Nothing Happened...."), end()] }
            ],
            acceptedRows: [], refusedRows: [],
            withdrawnRows: [end()]
          }]
        },
        { id: id(), label: "Leave it", cancel: true, rows: [end()] }
      ]
    }
  ];
}

(async () => {
  assertGameClosed();

  const db = await openCollection(COLLECTION);
  let doc;
  try {
    const raw = await db.get(KEY);
    doc = typeof raw === "string" ? JSON.parse(raw) : raw;
  } finally {
    await db.close();
  }
  if (!doc?.flags?.[SCOPE]?.isEventTile) throw new Error(`${KEY} is not the seal event tile`);

  const beforeHash = journal.hash(doc);
  const before = JSON.parse(JSON.stringify(doc.flags[SCOPE]));
  const rows = buildRows();
  doc.flags[SCOPE].eventRows = rows;
  doc.flags[SCOPE].eventRowsJsonPreview = JSON.stringify(rows, null, 2);
  if (doc._stats) doc._stats.modifiedTime = Date.now();
  const afterHash = journal.hash(doc);

  console.log("tile:", KEY);
  console.log("rows before:", (before.eventRows ?? []).length, "-> after:", rows.length);
  console.log("kept:", Object.keys(before).filter(k => !["eventRows", "eventRowsJsonPreview"].includes(k)).map(k => `${k}=${JSON.stringify(before[k])}`).join(", "));
  if (DRY) { console.log("--dry-run — nothing written."); return; }

  const backupPath = snapshotCollection(COLLECTION);
  console.log("backup:", backupPath);

  const wdb = await openCollection(COLLECTION);
  try {
    await wdb.put(KEY, doc);
  } finally {
    await wdb.close();
  }

  const vdb = await openCollection(COLLECTION);
  try {
    const back = await vdb.get(KEY);
    const d = typeof back === "string" ? JSON.parse(back) : back;
    const f = d.flags[SCOPE];
    const ok = JSON.stringify(f.eventRows) === JSON.stringify(rows)
      && JSON.stringify(f.availableWhen) === JSON.stringify(before.availableWhen)
      && f.isEventTile === true;
    console.log("read-back:", ok ? "OK" : "MISMATCH");
    if (!ok) process.exitCode = 1;
  } finally {
    await vdb.close();
  }

  journal.append({ uuid: `Scene.${SCENE}.Tile.${TILE}`, collection: COLLECTION, key: KEY, beforeHash, afterHash, backupPath,
    patch: { "flags.oni-event-system.eventRows": `${rows.length} rows (Nether Bridge seal)` },
    note: "Nether Bridge seal: rune Group Check, FP retry, Offer Item (GM Prompt)" });
})().catch((e) => { console.error(e); process.exit(1); });
