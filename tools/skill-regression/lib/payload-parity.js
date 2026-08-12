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
const HARNESS_EXEMPT = {
  // Derived from live combat/roll state the isolated harness does not model.
  defenseResolved: "derived from ar.canMiss + defenseTargetType at CONFIRM; the harness sets its own per-scan",
};

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

module.exports = { checkPayloadParity, HARNESS_EXEMPT, TRIGGERS };
