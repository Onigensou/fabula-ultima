"use strict";

const DOC_TYPE_TO_COLLECTION = {
  Actor: "actors",
  Item: "items",
  Scene: "scenes",
  JournalEntry: "journal",
  Macro: "macros",
  RollTable: "tables",
  Playlist: "playlists",
  Cards: "cards",
  Folder: "folders",
  User: "users",
  ChatMessage: "messages",
  Combat: "combats",
  Setting: "settings",
  FogExploration: "fog",
};

const COLLECTION_TO_DOC_TYPE = Object.fromEntries(
  Object.entries(DOC_TYPE_TO_COLLECTION).map(([k, v]) => [v, k])
);

// Embedded document type → { subKey, parentField }
//   subKey: path segment used in the LevelDB key (`!actors.<subKey>!...`)
//   parentField: name of the string[] field on the parent that lists children IDs
const SUB_DOC_TYPES = {
  Item: { subKey: "items", parentField: "items" },
  ActiveEffect: { subKey: "effects", parentField: "effects" },
  Combatant: { subKey: "combatants", parentField: "combatants" },
};

function parseUuid(uuid) {
  if (typeof uuid !== "string" || !uuid) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  if (uuid.startsWith("Compendium.")) {
    throw new Error(`Compendium UUIDs not supported by safe-edit: ${uuid}`);
  }
  const parts = uuid.split(".");
  if (parts.length < 2 || parts.length % 2 !== 0) {
    throw new Error(`Unrecognised UUID shape (expected pairs Type.id[.Type.id...]): ${uuid}`);
  }

  const [rootType, rootId, ...rest] = parts;
  const rootCollection = DOC_TYPE_TO_COLLECTION[rootType];
  if (!rootCollection) {
    throw new Error(`Unknown root document type "${rootType}" in UUID ${uuid}`);
  }

  const segments = [{
    docType: rootType,
    subKey: rootCollection,
    id: rootId,
    parentField: null,
  }];
  for (let i = 0; i < rest.length; i += 2) {
    const subType = rest[i];
    const subId = rest[i + 1];
    const mapping = SUB_DOC_TYPES[subType];
    if (!mapping) {
      throw new Error(`Unsupported embedded document type "${subType}" in UUID ${uuid}. ` +
                      `Supported: ${Object.keys(SUB_DOC_TYPES).join(", ")}`);
    }
    segments.push({
      docType: subType,
      subKey: mapping.subKey,
      id: subId,
      parentField: mapping.parentField,
    });
  }

  return { segments, rootCollection };
}

function buildKey(segments, depth = segments.length) {
  const pathSegs = segments.slice(0, depth).map((s) => s.subKey);
  const idSegs = segments.slice(0, depth).map((s) => s.id);
  return `!${pathSegs.join(".")}!${idSegs.join(".")}`;
}

function resolveUuid(uuid) {
  const { segments, rootCollection } = parseUuid(uuid);
  const isEmbedded = segments.length > 1;
  const key = buildKey(segments);
  const parentKey = isEmbedded ? buildKey(segments, segments.length - 1) : null;
  const last = segments[segments.length - 1];
  return {
    rootCollection,
    segments,
    isEmbedded,
    key,
    parentKey,
    parentField: last.parentField,        // e.g. "items", "effects" — null if top-level
    leafDocType: last.docType,
    leafId: last.id,
  };
}

// Back-compat helper used elsewhere — now just returns { collection, key } from a UUID.
function uuidToKey(uuid) {
  const r = resolveUuid(uuid);
  return { collection: r.rootCollection, key: r.key };
}

function topLevelKey(docType, id) {
  const collection = DOC_TYPE_TO_COLLECTION[docType];
  if (!collection) throw new Error(`Unknown document type: ${docType}`);
  return { collection, key: `!${collection}!${id}` };
}

function embeddedKey(parentResolved, subDocType, subId) {
  const mapping = SUB_DOC_TYPES[subDocType];
  if (!mapping) throw new Error(`Unsupported embedded document type: ${subDocType}`);
  const segments = [...parentResolved.segments, {
    docType: subDocType,
    subKey: mapping.subKey,
    id: subId,
    parentField: mapping.parentField,
  }];
  return {
    rootCollection: parentResolved.rootCollection,
    segments,
    isEmbedded: true,
    key: buildKey(segments),
    parentKey: buildKey(segments, segments.length - 1),
    parentField: mapping.parentField,
    leafDocType: subDocType,
    leafId: subId,
  };
}

module.exports = {
  DOC_TYPE_TO_COLLECTION,
  COLLECTION_TO_DOC_TYPE,
  SUB_DOC_TYPES,
  parseUuid,
  resolveUuid,
  uuidToKey,
  topLevelKey,
  embeddedKey,
  buildKey,
};
