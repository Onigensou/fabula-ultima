"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("./paths");
const { COLLECTION_TO_DOC_TYPE } = require("./keys");

const SYSTEM_JSON = path.join(REPO_ROOT, "systems", "custom-system-builder", "system.json");

let _systemJson = null;
function loadSystemJson() {
  if (_systemJson) return _systemJson;
  if (!fs.existsSync(SYSTEM_JSON)) {
    throw new Error(`system.json not found at ${SYSTEM_JSON}`);
  }
  _systemJson = JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"));
  return _systemJson;
}

const CORE_REQUIRED_FIELDS = {
  Actor: ["_id", "name", "type"],
  Item: ["_id", "name", "type"],
  Scene: ["_id", "name"],
  JournalEntry: ["_id", "name"],
  Macro: ["_id", "name", "type"],
  RollTable: ["_id", "name"],
  Playlist: ["_id", "name"],
  Cards: ["_id", "name", "type"],
  Folder: ["_id", "name", "type"],
  User: ["_id", "name"],
  ChatMessage: ["_id"],
  Combat: ["_id"],
  Setting: ["_id", "key"],
  FogExploration: ["_id"],
  // Embedded:
  ActiveEffect: ["_id", "name"],
  Combatant: ["_id"],
};

const IMMUTABLE_FIELDS = ["_id", "type"];

function flatten(obj, prefix = "", out = new Map()) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    out.set(prefix, obj);
    return out;
  }
  let hasKey = false;
  for (const [k, v] of Object.entries(obj)) {
    hasKey = true;
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  if (!hasKey && prefix) out.set(prefix, obj);
  return out;
}

function expectedIdFromKey(key, isEmbedded) {
  // Top-level: `!collection!id`           → expectedId is the only segment after `!...!`
  // Embedded:  `!coll.sub!parentId.childId` → expectedId is the LAST dot-separated segment
  const tail = key.split("!").pop();
  return isEmbedded ? tail.split(".").pop() : tail;
}

function validate({ collection, key, before, after, allowSystemKeyRemoval = false, isEmbedded = false, leafDocType = null, leafId = null }) {
  const errors = [];
  const warnings = [];

  if (!after || typeof after !== "object") {
    errors.push("Document is not an object");
    return { ok: false, errors, warnings };
  }

  // Determine the effective document type.
  // - Top-level: derived from the collection name (actors → Actor, items → Item, etc.)
  // - Embedded: passed in by the caller (leafDocType).
  const docType = isEmbedded ? leafDocType : COLLECTION_TO_DOC_TYPE[collection];
  if (!docType) {
    errors.push(`Unknown document type for collection=${collection} isEmbedded=${isEmbedded} leafDocType=${leafDocType}`);
    return { ok: false, errors, warnings };
  }

  for (const f of CORE_REQUIRED_FIELDS[docType] || []) {
    if (after[f] === undefined || after[f] === null) {
      errors.push(`Missing required core field "${f}" on ${docType}`);
    }
  }

  const expectedId = leafId || expectedIdFromKey(key, isEmbedded);
  if (after._id !== expectedId) {
    errors.push(`_id mismatch: doc._id=${after._id} but key id=${expectedId}`);
  }

  if (before) {
    for (const f of IMMUTABLE_FIELDS) {
      if (before[f] !== undefined && after[f] !== before[f]) {
        errors.push(`Immutable field "${f}" changed: ${before[f]} -> ${after[f]}`);
      }
    }
  }

  // Top-level Actor/Item types must be declared in system.json.
  // Embedded sub-types (ActiveEffect, Combatant, embedded Items) aren't gated this way
  // — embedded Item types still come from CSB's documentTypes.Item, so we still check
  // those, but ActiveEffect/Combatant `type` values are core Foundry sub-types.
  if (!isEmbedded || docType === "Item" || docType === "Actor") {
    const sys = loadSystemJson();
    const declared = sys.documentTypes?.[docType];
    if (declared && after.type && !Object.prototype.hasOwnProperty.call(declared, after.type)) {
      errors.push(`type "${after.type}" not declared in system.json for ${docType}. ` +
                  `Declared: ${Object.keys(declared).join(", ")}`);
    }
  }

  if (before && before.system && typeof before.system === "object" && !allowSystemKeyRemoval) {
    const beforeKeys = flatten(before.system);
    const afterKeys = flatten(after.system || {});
    const removed = [];
    for (const k of beforeKeys.keys()) {
      if (!afterKeys.has(k)) removed.push(k);
    }
    if (removed.length > 0) {
      errors.push(
        `Patch would remove system keys: ${removed.slice(0, 5).join(", ")}` +
        `${removed.length > 5 ? ` (+${removed.length - 5} more)` : ""}. ` +
        `Pass allowSystemKeyRemoval=true to permit.`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validate, loadSystemJson, CORE_REQUIRED_FIELDS, IMMUTABLE_FIELDS };
