// Propagates the _Item Template (ZoiV53VaLzeRsEps) structure to all items that
// use it — world items, actor-embedded items, and token-delta items — mirroring
// CSB TemplateSystem.reloadTemplate(): copies body/header/hidden/display +
// templateSystemUniqueVersion. Props are left untouched (sheet render creates
// missing ones; we deliberately skip CSB's orphan-prop removal offline).
//
// ⚠️ DO NOT RUN UNFILTERED. On 2026-06-12 a full run added ~53MB to the world
// payload and pushed it past V8's max string length (536,870,888 chars) —
// World.requestWorldData failed with "Invalid string length" and the world
// could not boot. The same applies to CSB's in-game "reload all templates".
// Check headroom first with _measure-world-payload.js, and filter the items
// you stamp (e.g. only item_type material/recipe) to the minimum needed.
const { openCollection } = require("./lib/db");
const { snapshotCollection } = require("./lib/backup");
const { assertGameClosed } = require("./lib/lock");

const TPL_ID = "ZoiV53VaLzeRsEps";
const DRY = process.argv.includes("--dry");

function bumpStats(doc) {
  const stats = doc._stats && typeof doc._stats === "object" ? doc._stats : {};
  return { ...doc, _stats: { ...stats, modifiedTime: Date.now() } };
}

function applyTpl(itemDoc, tpl) {
  return bumpStats({
    ...itemDoc,
    system: {
      ...itemDoc.system,
      templateSystemUniqueVersion: tpl.system.templateSystemUniqueVersion,
      hidden: structuredClone(tpl.system.hidden),
      body: structuredClone(tpl.system.body),
      header: structuredClone(tpl.system.header),
      display: structuredClone(tpl.system.display),
    },
  });
}

function usesTpl(doc) {
  return doc && doc.type === "equippableItem" && doc.system?.template === TPL_ID;
}

(async () => {
  assertGameClosed();

  // Load template
  let tpl;
  {
    const db = await openCollection("items");
    tpl = await db.get("!items!" + TPL_ID);
    await db.close();
  }
  if (!tpl?.system?.body) throw new Error("Template missing body");

  const report = { worldItems: 0, actorItems: 0, tokenDeltaItems: 0 };

  // 1. World items
  {
    if (!DRY) snapshotCollection("items");
    const db = await openCollection("items");
    const ops = [];
    for await (const [key, val] of db.iterator()) {
      if (!key.startsWith("!items!")) continue;
      if (!usesTpl(val)) continue;
      ops.push({ type: "put", key, value: applyTpl(val, tpl) });
    }
    report.worldItems = ops.length;
    if (!DRY && ops.length) await db.batch(ops);
    await db.close();
  }

  // 2. Actor-embedded items (stored in actors collection under !actors.items!)
  {
    if (!DRY) snapshotCollection("actors");
    const db = await openCollection("actors");
    const ops = [];
    for await (const [key, val] of db.iterator()) {
      if (!key.startsWith("!actors.items!")) continue;
      if (!usesTpl(val)) continue;
      ops.push({ type: "put", key, value: applyTpl(val, tpl) });
    }
    report.actorItems = ops.length;
    if (!DRY && ops.length) await db.batch(ops);
    await db.close();
  }

  // 3. Token-delta items inside scene token docs
  {
    const db = await openCollection("scenes");
    const ops = [];
    for await (const [key, val] of db.iterator()) {
      if (!key.startsWith("!scenes.tokens!")) continue;
      const items = val?.delta?.items;
      if (!Array.isArray(items)) continue;
      let touched = false;
      const newItems = items.map((it) => {
        if (!usesTpl(it)) return it;
        touched = true;
        report.tokenDeltaItems++;
        return applyTpl(it, tpl);
      });
      if (touched) {
        ops.push({ type: "put", key, value: bumpStats({ ...val, delta: { ...val.delta, items: newItems } }) });
      }
    }
    if (!DRY && ops.length) {
      snapshotCollection("scenes");
      await db.batch(ops);
    }
    await db.close();
  }

  console.log((DRY ? "[DRY RUN] " : "") + "propagated:", JSON.stringify(report));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
