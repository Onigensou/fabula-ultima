"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORLDS_DIR = path.join(REPO_ROOT, "worlds");
const DEFAULT_WORLD = "fabula-ultima-2";

function worldDataDir(world = DEFAULT_WORLD) {
  return path.join(WORLDS_DIR, world, "data");
}

function collectionDir(collection, world = DEFAULT_WORLD) {
  return path.join(worldDataDir(world), collection);
}

function backupRoot() {
  return path.join(__dirname, "..", "backups");
}

function journalPath() {
  return path.join(__dirname, "..", "journal.jsonl");
}

module.exports = {
  REPO_ROOT,
  WORLDS_DIR,
  DEFAULT_WORLD,
  worldDataDir,
  collectionDir,
  backupRoot,
  journalPath,
};
