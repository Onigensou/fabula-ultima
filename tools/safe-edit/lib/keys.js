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

function parseUuid(uuid) {
  if (typeof uuid !== "string" || !uuid) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  if (uuid.startsWith("Compendium.")) {
    throw new Error(`Compendium UUIDs not supported by safe-edit: ${uuid}`);
  }
  const parts = uuid.split(".");
  if (parts.length === 2) {
    const [docType, id] = parts;
    if (!DOC_TYPE_TO_COLLECTION[docType]) {
      throw new Error(`Unknown document type "${docType}" in UUID ${uuid}`);
    }
    return { docType, id, embedded: null };
  }
  if (parts.length === 4) {
    const [parentType, parentId, subType, subId] = parts;
    return { docType: parentType, id: parentId, embedded: { docType: subType, id: subId } };
  }
  throw new Error(`Unrecognised UUID shape: ${uuid}`);
}

function topLevelKey(docType, id) {
  const collection = DOC_TYPE_TO_COLLECTION[docType];
  if (!collection) throw new Error(`Unknown document type: ${docType}`);
  return { collection, key: `!${collection}!${id}` };
}

function uuidToKey(uuid) {
  const parsed = parseUuid(uuid);
  if (parsed.embedded) {
    throw new Error(
      `Embedded documents are not supported in safe-edit v1 (got ${uuid}). ` +
      `Use a macro inside Foundry for embedded edits.`
    );
  }
  return topLevelKey(parsed.docType, parsed.id);
}

module.exports = {
  DOC_TYPE_TO_COLLECTION,
  COLLECTION_TO_DOC_TYPE,
  parseUuid,
  uuidToKey,
  topLevelKey,
};
