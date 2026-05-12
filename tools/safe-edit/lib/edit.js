"use strict";

const crypto = require("node:crypto");
const { assertGameClosed } = require("./lock");
const { resolveUuid, embeddedKey } = require("./keys");
const { openCollection } = require("./db");
const { snapshotCollection, restoreCollection } = require("./backup");
const { validate } = require("./validate");
const { applyPatch } = require("./patch");
const journal = require("./journal");
const { DEFAULT_WORLD } = require("./paths");

function bumpStats(doc) {
  const stats = doc._stats && typeof doc._stats === "object" ? doc._stats : {};
  return { ...doc, _stats: { ...stats, modifiedTime: Date.now() } };
}

function newDocId(len = 16) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function getDoc(uuid, world = DEFAULT_WORLD) {
  const r = resolveUuid(uuid);
  const db = await openCollection(r.rootCollection, world);
  try {
    return await db.get(r.key);
  } catch (e) {
    if (e.code === "LEVEL_NOT_FOUND") return null;
    throw e;
  } finally {
    await db.close();
  }
}

async function safeEdit({ uuid, patch, note, allowSystemKeyRemoval = false, dryRun = false, world = DEFAULT_WORLD }) {
  if (!uuid) throw new Error("safeEdit: uuid required");
  if (!patch || typeof patch !== "object") throw new Error("safeEdit: patch object required");

  assertGameClosed(world);

  const r = resolveUuid(uuid);
  const { rootCollection: collection, key } = r;

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

  const result = validate({
    collection,
    key,
    before,
    after,
    allowSystemKeyRemoval,
    isEmbedded: r.isEmbedded,
    leafDocType: r.leafDocType,
    leafId: r.leafId,
  });
  if (!result.ok) {
    const err = new Error(`Validation failed:\n  - ${result.errors.join("\n  - ")}`);
    err.code = "VALIDATION_FAILED";
    err.errors = result.errors;
    throw err;
  }

  if (dryRun) {
    return { dryRun: true, uuid, collection, key, before, after, warnings: result.warnings };
  }

  let backupPath;
  try {
    backupPath = snapshotCollection(collection, world);
  } catch (e) {
    throw new Error(`Backup failed before write: ${e.message}`);
  }

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
    op: "patch",
  });

  return {
    dryRun: false, uuid, collection, key,
    entryId: entry.id, backupPath, beforeHash, afterHash,
    warnings: result.warnings,
  };
}

async function createEmbedded({ parentUuid, docType, value, note, dryRun = false, world = DEFAULT_WORLD }) {
  if (!parentUuid) throw new Error("createEmbedded: parentUuid required");
  if (!docType) throw new Error("createEmbedded: docType required (e.g. 'Item', 'ActiveEffect')");
  if (!value || typeof value !== "object") throw new Error("createEmbedded: value object required");

  assertGameClosed(world);

  const parent = resolveUuid(parentUuid);
  const childId = value._id || newDocId();
  const child = embeddedKey(parent, docType, childId);
  const { rootCollection: collection } = child;

  // Phase 1: read parent (must exist), read existing child slot (must not).
  let parentDoc;
  {
    const db = await openCollection(collection, world);
    try {
      try {
        parentDoc = await db.get(parent.key);
      } catch (e) {
        if (e.code === "LEVEL_NOT_FOUND") {
          throw new Error(`Parent not found at ${parentUuid} (key ${parent.key})`);
        }
        throw e;
      }
      try {
        const existing = await db.get(child.key);
        if (existing) throw new Error(`Embedded doc already exists at ${child.key}`);
      } catch (e) {
        if (e.code !== "LEVEL_NOT_FOUND") throw e;
      }
    } finally {
      await db.close();
    }
  }

  // Build the new child doc with required scaffolding.
  const now = Date.now();
  const newChild = bumpStats({
    ...value,
    _id: childId,
    _stats: { ...(value._stats || {}), createdTime: now, modifiedTime: now },
  });

  const result = validate({
    collection,
    key: child.key,
    before: null,
    after: newChild,
    isEmbedded: true,
    leafDocType: docType,
    leafId: childId,
  });
  if (!result.ok) {
    const err = new Error(`Validation failed:\n  - ${result.errors.join("\n  - ")}`);
    err.code = "VALIDATION_FAILED";
    err.errors = result.errors;
    throw err;
  }

  // Patch parent: append childId to parent.<parentField> (e.g. parent.items, parent.effects).
  const field = child.parentField;
  const currentList = Array.isArray(parentDoc[field]) ? parentDoc[field] : [];
  if (currentList.includes(childId)) {
    throw new Error(`Parent ${parentUuid}.${field}[] already lists id ${childId}`);
  }
  const newParent = bumpStats({ ...parentDoc, [field]: [...currentList, childId] });

  if (dryRun) {
    return {
      dryRun: true,
      parentUuid,
      childUuid: `${parentUuid}.${docType}.${childId}`,
      collection,
      parentKey: parent.key,
      childKey: child.key,
      parentField: field,
      newChild,
      newParent,
      warnings: result.warnings,
    };
  }

  let backupPath;
  try {
    backupPath = snapshotCollection(collection, world);
  } catch (e) {
    throw new Error(`Backup failed before write: ${e.message}`);
  }

  // Phase 3: write both entries in a batch, then read-back.
  let readBackChild;
  let readBackParent;
  {
    const db = await openCollection(collection, world);
    try {
      try {
        await db.batch([
          { type: "put", key: child.key, value: newChild },
          { type: "put", key: parent.key, value: newParent },
        ]);
      } catch (e) {
        throw new Error(`Write failed: ${e.message}. Backup at ${backupPath}`);
      }
      try {
        readBackChild = await db.get(child.key);
        readBackParent = await db.get(parent.key);
      } catch (e) {
        throw new Error(`Read-back failed: ${e.message}. Backup at ${backupPath}`);
      }
    } finally {
      await db.close();
    }
  }

  const childHash = journal.hash(newChild);
  const parentHash = journal.hash(newParent);
  if (journal.hash(readBackChild) !== childHash || journal.hash(readBackParent) !== parentHash) {
    restoreCollection(backupPath, collection, world);
    throw new Error(`Read-back hash mismatch — rolled back from ${backupPath}.`);
  }

  const childUuid = `${parentUuid}.${docType}.${childId}`;
  const entry = journal.append({
    uuid: childUuid,
    collection,
    key: child.key,
    beforeHash: null,
    afterHash: childHash,
    backupPath,
    patch: { _create: { docType, parentField: field, value } },
    note,
    op: "create",
    parentKey: parent.key,
    parentBeforeHash: journal.hash(parentDoc),
    parentAfterHash: parentHash,
  });

  return {
    dryRun: false,
    parentUuid,
    childUuid,
    collection,
    parentKey: parent.key,
    childKey: child.key,
    entryId: entry.id,
    backupPath,
    childHash,
    parentHash,
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

module.exports = { getDoc, safeEdit, createEmbedded, rollback, newDocId };
