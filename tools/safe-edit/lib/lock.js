"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { collectionDir, worldDataDir, DEFAULT_WORLD } = require("./paths");

const COLLECTIONS = [
  "actors", "items", "scenes", "journal", "macros",
  "tables", "playlists", "cards", "folders", "users",
  "messages", "combats", "settings", "fog",
];

function isLocked(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const fd = fs.openSync(file, "r+");
    try {
      fs.closeSync(fd);
    } catch { /* ignore */ }
    return false;
  } catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES") return true;
    throw e;
  }
}

function collectionLocked(collection, world = DEFAULT_WORLD) {
  const lockFile = path.join(collectionDir(collection, world), "LOCK");
  return isLocked(lockFile);
}

function gameRunning(world = DEFAULT_WORLD) {
  const dataDir = worldDataDir(world);
  if (!fs.existsSync(dataDir)) {
    throw new Error(`World data dir not found: ${dataDir}`);
  }
  const locked = [];
  for (const c of COLLECTIONS) {
    if (collectionLocked(c, world)) locked.push(c);
  }
  return { running: locked.length > 0, lockedCollections: locked };
}

function assertGameClosed(world = DEFAULT_WORLD) {
  const { running, lockedCollections } = gameRunning(world);
  if (running) {
    const msg = `Foundry appears to be running (LOCK held on: ${lockedCollections.join(", ")}). ` +
                `Close the world before running safe-edit writes.`;
    const err = new Error(msg);
    err.code = "GAME_RUNNING";
    throw err;
  }
}

module.exports = { gameRunning, collectionLocked, assertGameClosed };
