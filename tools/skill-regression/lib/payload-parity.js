// ───────────────────────────────────────────────────────────────────────────
// payload-parity — the test rig must supply every action-level identifier the
// LIVE dispatch supplies.
//
// The defect this exists to prevent (measured 2026-08-10, fixed `e9710b17`):
//
//   state-handlers.js builds a shared `actionBase` and spreads it into every
//   CONFIRM-stage trigger payload. `_test-harness-director.js` hand-rolled its
//   own payload literal instead, so every field actionBase supplies was ABSENT
//   under test — `skillDuration`, `skillTags`, `actionIsFreeCast`, `costMp`, …
//
// The direction of failure is what makes it dangerous. A missing identifier
// resolves to 0/blank, and for a `== 0` gate that is the PERMISSIVE answer:
//
//   Cataclysm: "… && ACTION_DURATION == 0 && …"
//   ACTION_DURATION reads payload.skillDuration -> undefined -> rank 0
//   => a SCENE spell PASSED an instantaneous-only gate under the harness,
//      while correctly failing in play.
//
// A test that cannot fail is worse than no test: it launders an unverified
// claim into a verified one. The live block's own comment says the same thing
// about its own history ("a field added for one trigger was simply absent under
// the others, where the gate then FAILS CLOSED") — actionBase was the fix, and
// the harness was never brought along.
//
// So: compare the two key sets statically. Any key the live base declares and
// the harness base does not is a fail. Pure source parsing — no game, no
// bridge, runs in milliseconds, so it can gate every engine turn.
// ───────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
// Reuse the existing string/template/regex-aware stripper rather than writing a
// second one. The first draft of this module rolled its own and reported a
// FALSE PASS off 4 of actionBase's ~25 keys: an apostrophe inside a comment
// ("the action's kind") opened a fake string and blanked the rest of the
// literal. A parity checker that silently under-counts is the exact bug it is
// meant to catch, so comments are removed BEFORE any brace matching now.
const { stripComments } = require("./engine-fingerprint");

const BD = path.resolve(__dirname, "../../../modules/fabula-ultima-companion/scripts/battle-director");
const LIVE_FILE = path.join(BD, "state-handlers.js");
const HARNESS_FILE = path.join(BD, "_test-harness-director.js");

// Keys that are MEANINGLESS in a harness run rather than missing, each with the
// reason. Anything not listed here must be present in both.
// defenseResolved USED to be exempt ("the harness sets its own per-scan") — only
// the targeted-by-action probe did; the creature_will_deal_damage scan never
// did, so every ATTACK_VS_DEF / ATTACK_VS_MDEF damage rider read 0 under test
// (Tincture of Strength / Spirit, 2026-09-15). buildHarnessActionBase now
// derives it, so it is checked like every other action-level field.
const HARNESS_EXEMPT = {};

// Local names either file gives a trigger payload literal. Matched by NAME and
// then narrowed by the trigger string, so the two files may name theirs
// differently (live: `performPayload`; harness: `payloadForTrigger`) without the
// checker losing track of which pairs with which.
const DECL_NAMES = ["payloadForTrigger", "performPayload"];

// Every trigger whose payload must agree between live and harness.
//
// One entry per SCAN SHAPE, not per trigger name. `creature_will_deal_damage`
// fires per target row; `creature_performs_action` fires once per action with a
// different field set (rollDieA/B, actionKind, the die attribute names). Adding
// a harness builder for a second shape without adding it here would leave that
// shape exactly as unchecked as the first one was — which is the whole defect
// this module was written for.
const TRIGGERS = ["creature_will_deal_damage", "creature_performs_action"];

/**
 * Extract the key names of the object literal assigned to `<name>` in `src`.
 * Brace-matched from the literal's opening `{`, then top-level `key:` picked
 * off — so nested literals and spreads do not leak in.
 *
 * Returns null when the literal cannot be located, which the caller reports as
 * a FAILURE rather than a pass: a silent "0 keys, all good" is exactly the
 * shape of bug this module exists to catch.
 */
function objectLiteralKeys(src, declRe, atIndex = null) {
  let open;
  if (atIndex != null) {
    // Caller already located the declaration (there are several
    // `payloadForTrigger` literals; we want a specific one).
    open = src.indexOf("{", atIndex);
  } else {
    const re = new RegExp(declRe.source, declRe.flags.replace("g", ""));
    const m = re.exec(src);
    if (!m) return null;
    open = src.indexOf("{", m.index + m[0].length - 1);
  }
  if (open < 0) return null;

  let depth = 0, end = -1, inS = null, prev = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inS) {
      if (c === inS && prev !== "\\") inS = null;
    } else if (c === '"' || c === "'" || c === "`") inS = c;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    prev = c;
  }
  if (end < 0) return null;

  const body = src.slice(open + 1, end);
  // Blank out nested braces/brackets/strings so only top-level `key:` survives.
  let flat = "", d = 0, s = null, p = "";
  for (const c of body) {
    if (s) { flat += " "; if (c === s && p !== "\\") s = null; p = c; continue; }
    if (c === '"' || c === "'" || c === "`") { s = c; flat += " "; p = c; continue; }
    if (c === "{" || c === "[" || c === "(") d++;
    if (c === "}" || c === "]" || c === ")") d--;
    flat += d === 0 ? c : " ";
    p = c;
  }
  const keys = new Set();
  for (const line of flat.split("\n")) {
    const re = /(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g;
    let k;
    while ((k = re.exec(line))) keys.add(k[1]);
  }
  return keys;
}

/**
 * Keys of the ASSEMBLED payload for one trigger — the scan's own literal PLUS
 * whatever base it spreads in.
 *
 * Comparing the two BASES alone was wrong and produced a false "missing" for
 * six keys (actionIntent, damageType, skillUuid, weaponRange, weaponType,
 * weaponUuid): the live path happens to supply them through `actionBase` while
 * the harness states them in its own literal. Both reach the payload, which is
 * the only thing a gate can see — so the payload is the unit to compare.
 *
 * The scan is located by its TRIGGER string rather than by position, so
 * reordering the scans in either file cannot silently repoint this at the wrong
 * one.
 */
function assembledPayloadKeys(src, trigger, declNames = DECL_NAMES) {
  const decl = new RegExp(`const\\s+(?:${declNames.join("|")})\\s*=\\s*\\{`, "g");
  let m;
  while ((m = decl.exec(src))) {
    // Is THIS the scan for the trigger we care about? The dispatch call follows
    // the literal closely; 6k chars covers the literal plus the call.
    const window = src.slice(m.index, m.index + 6000);
    if (!window.includes(trigger)) continue;

    const keys = objectLiteralKeys(src, null, m.index);
    if (!keys) return null;

    // Resolve `...someBase` spreads by unioning that literal's keys.
    const litStart = src.indexOf("{", m.index);
    const spreadRe = /\.\.\.([A-Za-z_$][\w$]*)/g;
    let s;
    const body = src.slice(litStart, litStart + 8000);
    while ((s = spreadRe.exec(body))) {
      const baseKeys = objectLiteralKeys(src, new RegExp(`const\\s+${s[1]}\\s*=\\s*(?:Object\\.freeze\\s*\\()?`));
      if (baseKeys) for (const k of baseKeys) keys.add(k);
    }
    return keys;
  }
  return null;
}

function checkOneTrigger(liveSrc, harnessSrc, trigger) {
  const out = { trigger, ok: true, missing: [], extra: [], live: 0, harness: 0, error: null };
  const live = assembledPayloadKeys(liveSrc, trigger);
  const harness = assembledPayloadKeys(harnessSrc, trigger);

  if (!live) { out.ok = false; out.error = `could not locate the live "${trigger}" payload in state-handlers.js — the parity check is BLIND, fix the matcher`; return out; }
  if (!harness) { out.ok = false; out.error = `could not locate the harness "${trigger}" payload in _test-harness-director.js — the parity check is BLIND, fix the matcher`; return out; }

  out.live = live.size;
  out.harness = harness.size;
  for (const k of live) {
    if (harness.has(k)) continue;
    if (k in HARNESS_EXEMPT) continue;
    out.missing.push(k);
  }
  // Not a failure, but worth surfacing: the harness inventing fields the live
  // path never sends is its own fidelity problem, in the opposite direction.
  for (const k of harness) if (!live.has(k)) out.extra.push(k);
  out.missing.sort(); out.extra.sort();
  out.ok = out.missing.length === 0;
  return out;
}

// One result per trigger, plus a roll-up. The roll-up keeps the shape callers
// already read (`ok` / `error` / `missing`), so an added trigger cannot quietly
// stop being reported by a caller that only looks at the top level.
function checkPayloadParity() {
  let liveSrc, harnessSrc;
  try {
    liveSrc = stripComments(fs.readFileSync(LIVE_FILE, "utf8"));
    harnessSrc = stripComments(fs.readFileSync(HARNESS_FILE, "utf8"));
  } catch (e) {
    return { ok: false, error: `could not read source: ${e.message}`, triggers: [], missing: [], extra: [], live: 0, harness: 0 };
  }
  const triggers = TRIGGERS.map((t) => checkOneTrigger(liveSrc, harnessSrc, t));
  const firstError = triggers.find((r) => r.error);
  return {
    ok: triggers.every((r) => r.ok),
    error: firstError?.error ?? null,
    triggers,
    // Roll-ups, deduped across triggers.
    missing: [...new Set(triggers.flatMap((r) => r.missing))].sort(),
    extra: [...new Set(triggers.flatMap((r) => r.extra))].sort(),
    live: triggers[0]?.live ?? 0,
    harness: triggers[0]?.harness ?? 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// COVERAGE CENSUS — "which trigger shapes is parity actually checking?"
//
// TRIGGERS above is a HARDCODED list of two, and this module's own comment
// warns that a shape absent from it "would leave that shape exactly as
// unchecked as the first one was". That warning was invisible in the output: a
// green `parity` run said "the harness supplies every action-level field the
// live dispatch does" while comparing 2 of the ~13 shapes live dispatches.
//
// A checker that reports PASS for the part it looked at, in language that
// sounds like it looked at everything, is the same silent-permissive failure
// parity exists to catch — one level up. So enumerate the shapes and classify
// every one. Pure source parsing, no game.
//
// The four classes, in descending danger:
//
//   unchecked-harness-built  the harness BUILDS a payload literal for this
//                            trigger and TRIGGERS omits it. Fields can be
//                            missing and nothing says so → fails PERMISSIVE.
//                            This is the defect class; it exits non-zero.
//   caller-supplied          reachable only through runDirectorPassiveTriggerTest,
//                            whose payload comes from the TEST AUTHOR's literal
//                            (`args.payload`). There is no harness literal to
//                            diff, so parity is structurally blind here and the
//                            author's hand-written keys are the contract.
//   checked                  in TRIGGERS; compared field by field.
//   live-only                live dispatches it, the harness never does. The
//                            harness simply cannot exercise that trigger, which
//                            fails VISIBLY (nothing fires) rather than
//                            permissively — worth knowing, not alarming.
// ───────────────────────────────────────────────────────────────────────────

/** Every `trigger: "..."` string a file names, deduped. */
function triggersNamedIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/trigger:\s*"([a-z_][a-z0-9_]*)"/g)) out.add(m[1]);
  return out;
}

/**
 * Triggers whose payload the HARNESS assembles from its own literal — i.e. the
 * ones parity could diff. A trigger the harness only names (passing a payload
 * it was handed) is not one of these.
 */
function harnessBuiltTriggers(harnessSrc) {
  const out = new Set();
  for (const t of triggersNamedIn(harnessSrc)) {
    if (assembledPayloadKeys(harnessSrc, t)) out.add(t);
  }
  return out;
}

/**
 * Does the harness expose a GENERIC dispatch that forwards a caller-supplied
 * trigger AND payload? `runDirectorPassiveTriggerTest` does:
 *
 *     firePassiveTriggers({ trigger: args.trigger, payload: args.payload ?? {} })
 *
 * That one line makes EVERY trigger reachable from a test with a payload the
 * author hand-writes — and `?? {}` means an omitted payload is an EMPTY object,
 * in which every identifier a gate reads folds to 0. For a `== 0` gate that is
 * the permissive answer, so such a test passes by construction.
 *
 * It also means "the harness never names this trigger" does NOT mean "the
 * harness cannot dispatch it". Reporting those as merely `live-only` would
 * understate the exposure, which is the same mistake one level up as reporting
 * 2-of-15 shapes as a clean parity pass.
 */
function hasGenericCallerDispatch(harnessSrc) {
  return /payload:\s*args\.payload/.test(harnessSrc)
    && /trigger:\s*args\.trigger/.test(harnessSrc);
}

function auditTriggerCoverage() {
  let liveSrc, harnessSrc;
  try {
    liveSrc = stripComments(fs.readFileSync(LIVE_FILE, "utf8"));
    harnessSrc = stripComments(fs.readFileSync(HARNESS_FILE, "utf8"));
  } catch (e) {
    return { ok: false, error: `could not read source: ${e.message}`, rows: [] };
  }

  const live = triggersNamedIn(liveSrc);
  const harnessNamed = triggersNamedIn(harnessSrc);
  const harnessBuilt = harnessBuiltTriggers(harnessSrc);
  const checked = new Set(TRIGGERS);
  const generic = hasGenericCallerDispatch(harnessSrc);

  const rows = [];
  for (const t of [...new Set([...live, ...harnessNamed])].sort()) {
    let cls;
    if (checked.has(t)) cls = "checked";
    else if (harnessBuilt.has(t)) cls = "unchecked-harness-built";
    else if (harnessNamed.has(t) || generic) cls = "caller-supplied";
    else cls = "live-only";
    rows.push({ trigger: t, cls, inLive: live.has(t), inHarness: harnessNamed.has(t) });
  }

  const dangerous = rows.filter((r) => r.cls === "unchecked-harness-built");
  return {
    genericCallerDispatch: generic,
    ok: dangerous.length === 0,
    error: dangerous.length
      ? `${dangerous.length} trigger shape(s) the harness BUILDS a payload for are not in TRIGGERS — ` +
        `add them to lib/payload-parity.js: ${dangerous.map((r) => r.trigger).join(", ")}`
      : null,
    rows,
    counts: rows.reduce((a, r) => { a[r.cls] = (a[r.cls] ?? 0) + 1; return a; }, {}),
  };
}

module.exports = { checkPayloadParity, auditTriggerCoverage, HARNESS_EXEMPT, TRIGGERS };

