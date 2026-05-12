"use strict";

function expandFlatKeys(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!k.includes(".")) {
      out[k] = v;
      continue;
    }
    const parts = k.split(".");
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (cursor[part] === undefined || cursor[part] === null || typeof cursor[part] !== "object") {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = v;
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(target, source) {
  if (!isPlainObject(target)) return structuredClone(source);
  const out = structuredClone(target);
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

function applyPatch(original, patch) {
  const expanded = expandFlatKeys(patch);
  return deepMerge(original, expanded);
}

module.exports = { expandFlatKeys, deepMerge, applyPatch };
