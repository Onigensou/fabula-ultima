"use strict";

// csb-lint — static validator for a CSB template's component tree.
//
// CSB validates LATE and THINLY: the only hard failure on load is
// `Panel.fromJSON -> ComponentFactory.createOneComponent` throwing on an
// unrecognized `type` (ComponentFactory.js). The real rules (key pattern,
// uniqueness, required fields) live in `validateConfig`, which runs only in the
// editor UI — never on a raw DB write. So a malformed-but-known tree persists
// and then silently misbehaves. This linter reproduces those rules offline so we
// catch problems BEFORE writing.
//
// Severities: "error" (CSB will throw, or data is silently clobbered/stripped),
// "warn" (likely wrong / will misbehave), "info" (cosmetic / unknown extras).

const {
  SPEC, KEY_PATTERN, specOf, isKnownType, ownsProp,
  isRowLayoutTable, PARENT_PARSED_TYPES,
} = require("./component-spec");

function finding(severity, code, where, message) {
  return { severity, code, where, message };
}

// Lint a CsbTree. Returns an array of findings.
// opts.knownTypes: optional iterable of type names treated as valid (e.g. the
//   live componentFactory registry, fetched via the bridge) — augments the
//   static list so a module-registered type isn't a false UNKNOWN_TYPE.
function lint(tree, opts = {}) {
  const out = [];
  const propKeyPaths = new Map(); // GLOBAL (top-level) prop-owning key -> [paths]
  const extraKnown = new Set([
    ...PARENT_PARSED_TYPES,
    ...(opts.knownTypes || []),
  ]);
  const typeIsKnown = (t) => isKnownType(t) || extraKnown.has(t);

  tree.walk(({ node, path, inRowLayout }) => {
    const where = path.join(".");
    const type = node.type;

    if (typeof type !== "string" || type === "") {
      out.push(finding("error", "MISSING_TYPE", where, "component node has no `type` string"));
      return;
    }
    if (!typeIsKnown(type)) {
      out.push(finding("error", "UNKNOWN_TYPE", where,
        `unknown component type "${type}" — CSB throws "Unrecognized component type" on load`));
      return;
    }
    const spec = specOf(type);
    const key = node.key;

    // A type that's registered in the live factory but unknown to our static
    // SPEC: we accept it (not an error) but can't run semantic checks on it.
    if (!spec) {
      if (typeof key === "string" && key && !KEY_PATTERN.test(key)) {
        out.push(finding("warn", "BAD_KEY", where, `key "${key}" is not alphanumeric/underscore`));
      }
      return;
    }

    // key presence + pattern
    if (spec.requiresKey) {
      if (key === undefined || key === null || key === "") {
        out.push(finding("error", "MISSING_KEY", where, `${type} requires a key`));
      } else if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
        out.push(finding("error", "BAD_KEY", where,
          `key "${key}" must match /^[a-zA-Z0-9_]+$/ (CSB AlphanumericPatternError)`));
      }
    } else if (key && (typeof key !== "string" || !KEY_PATTERN.test(key))) {
      out.push(finding("warn", "BAD_KEY", where, `key "${key}" is not alphanumeric/underscore`));
    }

    // Track ONLY top-level (non-rowLayout) prop-owning keys for global
    // uniqueness. A rowLayout column key is scoped to its table's row data, so
    // it legitimately coexists with a same-named top-level field.
    if (typeof key === "string" && KEY_PATTERN.test(key) && key !== "" && !inRowLayout && ownsProp(type)) {
      if (!propKeyPaths.has(key)) propKeyPaths.set(key, []);
      propKeyPaths.get(key).push(where);
    }

    // required config keys
    for (const rk of spec.required || []) {
      if (node[rk] === undefined) {
        out.push(finding("warn", "MISSING_CONFIG", where, `${type} is missing config "${rk}"`));
      }
    }

    // type-specific structural checks
    if (type === "select" && node.selectedOptionType === "custom") {
      if (!Array.isArray(node.options)) {
        out.push(finding("warn", "SELECT_NO_OPTIONS", where, "custom select has no options[] array"));
      } else {
        const seen = new Map();
        node.options.forEach((o, i) => {
          if (!o || typeof o !== "object" || o.key === undefined) {
            out.push(finding("warn", "BAD_OPTION", `${where}.options.${i}`, "option must be { key, value }"));
          } else {
            seen.set(o.key, (seen.get(o.key) || 0) + 1);
          }
        });
        for (const [k, n] of seen) if (n > 1)
          out.push(finding("warn", "DUP_OPTION", where, `duplicate option key "${k}" (${n}×)`));
      }
    }

    if (isRowLayoutTable(type)) {
      if (!Array.isArray(node.rowLayout)) {
        out.push(finding("error", "TABLE_NO_ROWLAYOUT", where, `${type} requires a rowLayout[] array`));
      } else {
        const cols = new Map();
        node.rowLayout.forEach((c, i) => {
          if (!c || typeof c !== "object") {
            out.push(finding("error", "BAD_COLUMN", `${where}.rowLayout.${i}`, "column is not an object"));
            return;
          }
          if (c.key) cols.set(c.key, (cols.get(c.key) || 0) + 1);
        });
        for (const [ck, n] of cols) if (n > 1)
          out.push(finding("error", "DUP_COLUMN", where, `duplicate column key "${ck}" (${n}×) in table "${key}"`));
      }
    }

    // contents sanity for containers that should have an array
    if ((type === "panel" || type === "tab" || type === "tabbedPanel") && node.contents !== undefined
        && !Array.isArray(node.contents)) {
      out.push(finding("error", "BAD_CONTENTS", where, `${type}.contents must be an array`));
    }
  });

  // global prop-key uniqueness (a dup means instances collapse to one
  // system.props.<key> — last definition wins, the other's data is unreachable)
  for (const [key, paths] of propKeyPaths) {
    if (paths.length > 1) {
      out.push(finding("error", "DUP_PROP_KEY", paths.join(" | "),
        `prop key "${key}" defined ${paths.length}× — instances store ONE system.props.${key}; data clobbered`));
    }
  }

  return out;
}

// Cross-check authored / engine-read prop names against the template's field set.
// - stripped:   props present in instance data but with NO field -> reloadTemplate prunes them
// - uncovered:  engine-read prop names with NO field -> also vulnerable to pruning
function coverage(tree, { authoredProps = [], readProps = [] } = {}) {
  const fields = tree.propOwningKeys();
  const uniq = (a) => Array.from(new Set(a));
  return {
    fieldCount: fields.size,
    stripped: uniq(authoredProps).filter((k) => !fields.has(k)).sort(),
    uncovered: uniq(readProps).filter((k) => !fields.has(k)).sort(),
  };
}

function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

module.exports = { lint, coverage, summarize };
