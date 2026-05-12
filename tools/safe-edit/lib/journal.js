"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { journalPath } = require("./paths");

function hash(obj) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")
    .slice(0, 16);
}

function entryId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
             `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
}

function append({ uuid, collection, key, beforeHash, afterHash, backupPath, patch, note }) {
  const id = entryId();
  const entry = {
    id,
    ts: new Date().toISOString(),
    uuid,
    collection,
    key,
    beforeHash,
    afterHash,
    backupPath,
    patch,
    note: note || null,
  };
  fs.appendFileSync(journalPath(), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

function readAll() {
  const p = journalPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findById(id) {
  return readAll().find((e) => e.id === id) || null;
}

module.exports = { append, readAll, findById, hash };
