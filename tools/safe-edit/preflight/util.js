"use strict";

/**
 * preflight/util — shared helpers for checks: severity constants, a finding
 * factory, order-insensitive deep compare (CSB tables are objects keyed by row
 * id, so key order is noise), and an "is this automation payload empty?" test.
 */

const SEVERITY = { FAIL: "FAIL", WARN: "WARN", INFO: "INFO" };
const SEVERITY_RANK = { FAIL: 0, WARN: 1, INFO: 2 };

/**
 * Build one finding.
 *   suite    - which suite produced it (refs|scenes|tiles|automation|...)
 *   severity - SEVERITY.*
 *   message  - human sentence
 *   ref      - clickable-ish locator ({ doc, id, extra }) for the report
 */
function finding(suite, severity, message, ref = {}) {
  return { suite, severity, message, ref };
}

// Recursively sort object keys so JSON.stringify is order-independent.
function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stableSort(value[k]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSort(value));
}

// Deep, order-insensitive equality.
function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Is an automation value "empty" — i.e. carries no wiring?
 * Covers the shapes automation fields take: "" (animation_script), {} / []
 * (CSB dynamic tables), null/undefined.
 */
function isEmptyAutomation(v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

module.exports = {
  SEVERITY, SEVERITY_RANK, finding,
  stableSort, stableStringify, deepEqual, isEmptyAutomation,
};
