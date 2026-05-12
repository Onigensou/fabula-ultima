#!/usr/bin/env node
// One-shot helper: clone an existing item with a fresh _id and altered name.
// Used only to create a throwaway target for safe-edit smoke tests.
"use strict";

const crypto = require("node:crypto");
const { openCollection } = require("../lib/db");
const { uuidToKey } = require("../lib/keys");
const { assertGameClosed } = require("../lib/lock");

function newId(len = 16) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

(async () => {
  const sourceUuid = process.argv[2];
  const nameSuffix = process.argv[3] || "(safe-edit test)";
  if (!sourceUuid) {
    console.error("Usage: node _test-clone.js <source-uuid> [name-suffix]");
    process.exit(1);
  }
  assertGameClosed();
  const { collection, key } = uuidToKey(sourceUuid);
  const db = await openCollection(collection);
  try {
    const src = await db.get(key);
    const fresh = newId();
    const clone = JSON.parse(JSON.stringify(src));
    clone._id = fresh;
    clone.name = `${src.name} ${nameSuffix}`;
    if (clone.system && typeof clone.system === "object" && "uniqueId" in clone.system) {
      clone.system.uniqueId = fresh;
    }
    // Reset embedded-children lists so the clone starts isolated from the source's
    // embedded entries (those live under the source's key prefix, not the clone's).
    for (const f of ["items", "effects", "combatants"]) {
      if (Array.isArray(clone[f])) clone[f] = [];
    }
    const now = Date.now();
    clone._stats = { ...(clone._stats || {}), createdTime: now, modifiedTime: now };
    const newKey = `!${collection}!${fresh}`;
    await db.put(newKey, clone);
    console.log(JSON.stringify({
      sourceUuid,
      clonedUuid: `${sourceUuid.split(".")[0]}.${fresh}`,
      key: newKey,
      name: clone.name,
    }, null, 2));
  } finally {
    await db.close();
  }
})();
