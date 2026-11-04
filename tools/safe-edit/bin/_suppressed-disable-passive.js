// 2026-11-04 — Suppressed ("Disable Passive effects") had no mechanical data: its
// AE on the Debuff hub carried no changes, so it did nothing. Reaction gating
// (commit 12bc8cae, skill-effects getReactionGate) reads an AE change
// `disable_passive`; this adds it to the hub copy — the only Suppressed AE in the
// world (skills apply it by ae_template_ref, which copies from the hub).
// Idempotent: skips when the marker is already there. Keeps the AE's wording.
// Game must be CLOSED. Backs up the items store first.
//   node tools/safe-edit/bin/_suppressed-disable-passive.js [--dry]
const path = require("path");
const fs = require("fs");
const { ClassicLevel } = require(path.join(__dirname, "..", "node_modules", "classic-level"));
const { snapshotCollection } = require("../lib/backup");
const DIR = path.join(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "data", "items");
const ITEM = "XVOWOq9oUmEECGrU";            // Debuff hub
const AE = "b9CUFlPnwLKgxE30";              // its "Suppressed" AE
const ITEM_KEY = `!items!${ITEM}`;
const AE_KEY = `!items.effects!${ITEM}.${AE}`;
const MARKER = { key: "disable_passive", value: "1", mode: 5, priority: 0 };   // OVERRIDE, as the action gates
(async () => {
  const dry = process.argv.includes("--dry");
  if (!dry) console.log("backup:", snapshotCollection("items"));
  const db = new ClassicLevel(DIR, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open({ createIfMissing: false });
  try {
    const item = JSON.parse(await db.get(ITEM_KEY));
    if (item.name !== "Debuff") throw new Error(`expected the Debuff hub, got "${item.name}"`);
    if (!(item.effects ?? []).includes(AE)) throw new Error("Suppressed AE is not listed on the hub");
    const ae = JSON.parse(await db.get(AE_KEY));
    if (ae.name !== "Suppressed") throw new Error(`expected Suppressed, got "${ae.name}"`);
    console.log("before:", JSON.stringify(ae.changes));
    if ((ae.changes ?? []).some((c) => c?.key === MARKER.key)) { console.log("marker already present — nothing to do"); return; }
    ae.changes = [...(ae.changes ?? []), MARKER];
    if (dry) { console.log("dry: would write", JSON.stringify(ae.changes)); return; }
    await db.put(AE_KEY, JSON.stringify(ae));
    console.log("written; read back:", JSON.stringify(JSON.parse(await db.get(AE_KEY)).changes));
  } finally { await db.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
