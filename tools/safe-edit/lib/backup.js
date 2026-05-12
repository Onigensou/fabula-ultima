"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { collectionDir, backupRoot, DEFAULT_WORLD } = require("./paths");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function snapshotCollection(collection, world = DEFAULT_WORLD) {
  const src = collectionDir(collection, world);
  if (!fs.existsSync(src)) throw new Error(`Collection dir not found: ${src}`);
  const ts = timestamp();
  const dst = path.join(backupRoot(), `${ts}-${world}-${collection}`);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, errorOnExist: false });
  return dst;
}

function restoreCollection(backupPath, collection, world = DEFAULT_WORLD) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup path not found: ${backupPath}`);
  }
  const dst = collectionDir(collection, world);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(backupPath, dst, { recursive: true });
  return dst;
}

module.exports = { snapshotCollection, restoreCollection, timestamp };
