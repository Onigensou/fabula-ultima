"use strict";

const { ClassicLevel } = require("classic-level");
const { collectionDir, DEFAULT_WORLD } = require("./paths");

async function openCollection(collection, world = DEFAULT_WORLD, opts = {}) {
  const dir = collectionDir(collection, world);
  const db = new ClassicLevel(dir, { valueEncoding: "json", ...opts });
  await db.open();
  return db;
}

async function withCollection(collection, world, fn) {
  const db = await openCollection(collection, world);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function getByKey(collection, key, world = DEFAULT_WORLD) {
  return withCollection(collection, world, async (db) => {
    try {
      return await db.get(key);
    } catch (e) {
      if (e.code === "LEVEL_NOT_FOUND") return null;
      throw e;
    }
  });
}

async function putByKey(collection, key, value, world = DEFAULT_WORLD) {
  return withCollection(collection, world, async (db) => {
    await db.put(key, value);
  });
}

module.exports = { openCollection, withCollection, getByKey, putByKey };
