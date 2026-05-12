"use strict";

const { assertGameClosed } = require("./lock");
const { uuidToKey } = require("./keys");
const { openCollection } = require("./db");
const { snapshotCollection, restoreCollection } = require("./backup");
const { validate } = require("./validate");
const { applyPatch } = require("./patch");
const journal = require("./journal");
const { DEFAULT_WORLD } = require("./paths");

async function getDoc(uuid, world = DEFAULT_WORLD) {
  const { collection, key } = uuidToKey(uuid);
  const db = await openCollection(collection, world);
  try {
    return await db.get(key);
  } catch (e) {
    if (e.code === "LEVEL_NOT_FOUND") return null;
    throw e;
  } finally {
    await db.close();
  }
}

function bumpStats(doc) {
  const stats = doc._stats && typeof doc._stats === "object" ? doc._stats : {};
  return { ...doc, _stats: { ...stats, modifiedTime: Date.now() } };
}

async function safeEdit({ uuid, patch, note, allowSystemKeyRemoval = false, dryRun = false, world = DEFAULT_WORLD }) {
  if (!uuid) throw new Error("safeEdit: uuid required");
  if (!patch || typeof patch !== "object") throw new Error("safeEdit: patch object required");

  assertGameClosed(world);

  const { collection, key } = uuidToKey(uuid);

  // Phase 1: read `before` and close the DB so the dir isn't locked.
  let before;
  {
    const db = await openCollection(collection, world);
    try {
      before = await db.get(key);
    } catch (e) {
      if (e.code === "LEVEL_NOT_FOUND") {
        throw new Error(`Document not found at ${uuid} (key ${key})`);
      }
      throw e;
    } finally {
      await db.close();
    }
  }

  const merged = applyPatch(before, patch);
  const after = bumpStats(merged);

  const result = validate({ collection, key, before, after, allowSystemKeyRemoval });
  if (!result.ok) {
    const err = new Error(`Validation failed:\n  - ${result.errors.join("\n  - ")}`);
    err.code = "VALIDATION_FAILED";
    err.errors = result.errors;
    throw err;
  }

  if (dryRun) {
    return {
      dryRun: true,
      uuid,
      collection,
      key,
      before,
      after,
      warnings: result.warnings,
    };
  }

  // Phase 2: backup while DB is closed (Windows requires this for cpSync over LOCK).
  let backupPath;
  try {
    backupPath = snapshotCollection(collection, world);
  } catch (e) {
    throw new Error(`Backup failed before write: ${e.message}`);
  }

  // Phase 3: reopen, write, read-back, close.
  let readBack;
  {
    const db = await openCollection(collection, world);
    try {
      try {
        await db.put(key, after);
      } catch (e) {
        throw new Error(`Write failed: ${e.message}. Backup at ${backupPath}`);
      }
      try {
        readBack = await db.get(key);
      } catch (e) {
        throw new Error(`Read-back failed: ${e.message}. Backup at ${backupPath}`);
      }
    } finally {
      await db.close();
    }
  }

  const beforeHash = journal.hash(before);
  const afterHash = journal.hash(after);
  const readBackHash = journal.hash(readBack);

  if (readBackHash !== afterHash) {
    restoreCollection(backupPath, collection, world);
    throw new Error(
      `Read-back hash mismatch — rolled back from ${backupPath}. ` +
      `Expected ${afterHash}, got ${readBackHash}.`
    );
  }

  const entry = journal.append({
    uuid, collection, key,
    beforeHash, afterHash,
    backupPath, patch, note,
  });

  return {
    dryRun: false,
    uuid,
    collection,
    key,
    entryId: entry.id,
    backupPath,
    beforeHash,
    afterHash,
    warnings: result.warnings,
  };
}

async function rollback(entryId, world = DEFAULT_WORLD) {
  assertGameClosed(world);
  const entry = journal.findById(entryId);
  if (!entry) throw new Error(`Journal entry not found: ${entryId}`);
  restoreCollection(entry.backupPath, entry.collection, world);
  return { restored: entry.collection, from: entry.backupPath, entry };
}

module.exports = { getDoc, safeEdit, rollback };
