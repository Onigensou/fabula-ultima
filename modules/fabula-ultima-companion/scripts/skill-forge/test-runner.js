// [ONI] Skill Forge — test runner.
// ---------------------------------------------------------------------------
// STAGE 4. "Does this skill actually work?", answered without launching a
// battle, and rendered in language an author can check against the skill's own
// rules text.
//
// The harness already does the hard part (`runDirectorSkillSimulate` runs
// COMPUTE then RESOLVE with every document write captured and nothing
// committed). What was missing is the half that decides whether the RESULT
// MEANS ANYTHING — and that half is the whole value, because:
//
//   ⚠ A HARNESS THAT OMITS A PAYLOAD FIELD FAILS PERMISSIVE.
//     A missing identifier resolves to 0, and for a `== 0` gate that is the
//     PASSING answer. A rig that never set `skillDuration` let an
//     instantaneous-only gate accept a Scene spell it refused in play. Green
//     meant "the gate never saw the field", and nothing in the output said so.
//
// So this module reports caveats beside every result, and will say "this run
// proves nothing" rather than let a green read as a pass.
//
// ── THE HARNESS CONTRACT, READ FROM SOURCE (2026-09-22) ─────────────────────
// The authoring guideline had two of its three documented "blind spots"
// INVERTED, and each produced the exact false negative it warned about. Both
// were corrected; the verified contract is:
//
//   accept pre-resolve reactions  `acceptReactions` — for BOTH entry points.
//                                 (`prePassives` appears nowhere in module
//                                 source; passing it is silently ignored.)
//   skill result                  `res.actionResult`  (top level, no `passes`)
//   attack result                 `res.passes[]`      (no top-level actionResult)
//
// Never re-derive these from a doc. Read the `return` statement.

const TAG = "[SkillForge/test]";

/** Entry points, with the result shape each actually returns. */
export const ENTRY_POINTS = {
  skill:  { api: "runDirectorSkillSimulate",  resultKey: "actionResult" },
  attack: { api: "runDirectorAttackSimulate", resultKey: "passes" },
};

/**
 * Pull the ActionResult out of a harness result, whichever entry point ran.
 *
 * Reading the wrong field yields `undefined`, "which looks exactly like the
 * reaction didn't fire" — so this never guesses. If neither shape is present it
 * says so rather than returning null and letting the caller read that as empty.
 */
export function extractActionResults(res, entry = "skill") {
  if (!res || typeof res !== "object") return { results: [], problem: "no result object" };
  if (entry === "attack") {
    if (!Array.isArray(res.passes)) {
      return { results: [], problem: "attack simulate returned no `passes[]` — wrong entry point?" };
    }
    return { results: res.passes.map((p) => p?.actionResult).filter(Boolean), problem: null };
  }
  if (res.actionResult) return { results: [res.actionResult], problem: null };
  if (Array.isArray(res.passes)) {
    // The guideline used to tell skill authors to read passes[0]; it is the
    // ATTACK shape. Say so instead of silently coping.
    return { results: res.passes.map((p) => p?.actionResult).filter(Boolean),
      problem: "got the ATTACK result shape (`passes[]`) from a skill run — check the entry point" };
  }
  return { results: [], problem: "no `actionResult` and no `passes[]` — the run did not produce a result" };
}

// ── caveats ─────────────────────────────────────────────────────────────────

/**
 * Everything about this run that limits what it proves.
 *
 * Ordered most-dangerous first. A caveat is not a failure — it is the sentence
 * that has to appear beside a green result so nobody reads more into it than
 * the run supports.
 */
export function auditRun({ doc, args = {}, result = null, entry = "skill" } = {}) {
  const caveats = [];
  const props = doc?.system?.props ?? {};

  // 1. Pre-resolve reactions need explicit acceptance, or they never dispatch
  //    and damage comes back identical whether the gate is true, false or 1.
  const rows = tableRows(props.reaction_config_table);
  const preResolve = rows.filter((r) =>
    ["creature_will_deal_damage", "creature_targeted_by_action", "caster_short_on_mp"]
      .includes(String(r.reaction_trigger ?? "")));
  if (preResolve.length && !args.acceptReactions) {
    caveats.push({
      severity: "blocking",
      text: `This skill has ${preResolve.length} pre-resolve reaction row(s), and the run did ` +
        `not pass acceptReactions — they never dispatched. The result is the same as if the ` +
        `gate were false, so it proves nothing about them.`,
      fix: "Re-run with acceptReactions: true.",
    });
  }
  // The arg that does NOT exist. Passing it is silently ignored, so a run that
  // looks configured is in fact unconfigured.
  if ("prePassives" in args) {
    caveats.push({
      severity: "blocking",
      text: "`prePassives` is not a harness argument — it appears nowhere in module source " +
        "and was silently ignored. The reactions did not dispatch.",
      fix: "Use acceptReactions.",
    });
  }

  // 2. COMPUTE is thin for effect rows: deal_damage / grant land in RESOLVE.
  if (args.computeOnly) {
    const resolveOnly = tableRows(props.effect_table)
      .filter((r) => ["deal_damage", "grant", "apply_ae", "summon"].includes(String(r.effect_kind ?? "")));
    if (resolveOnly.length) {
      caveats.push({
        severity: "blocking",
        text: `A COMPUTE-only run shows 0 for ${resolveOnly.length} row(s) that only land in ` +
          `RESOLVE. A working skill reads as dead.`,
        fix: "Use the simulate entry point, not compute.",
      });
    }
  }

  // 3. Target affinities. The bench dummy is air-IMMUNE and bolt-VULNERABLE, so
  //    an air skill writes 0 against it and looks broken.
  // The element lives in TWO places and the patterns use the second one: an
  // action-level `type_damage`, or `damage_element` on a deal_damage row. This
  // read only ever looked at the first, so for every skill the Forge itself
  // produces the element was "" and the affinity caveats below could not fire —
  // the check was dead on exactly the content it was written to protect.
  const rowElement = tableRows(props.effect_table)
    .map((r) => String(r.damage_element ?? "").trim())
    .find(Boolean) ?? "";
  const element = String(props.type_damage || rowElement || "").trim().toLowerCase();
  if (args.targetAffinities && element) {
    const aff = args.targetAffinities[element];
    if (aff === "IM" || aff === "AB") {
      caveats.push({
        severity: "blocking",
        text: `The target is ${aff === "IM" ? "IMMUNE" : "ABSORBING"} to ${element}, so a 0 here ` +
          `says nothing about the skill.`,
        fix: "Re-run against a neutral target.",
      });
    } else if (aff === "VU" || aff === "RS") {
      caveats.push({
        severity: "note",
        text: `The target is ${aff === "VU" ? "vulnerable" : "resistant"} to ${element}; the number ` +
          `is scaled accordingly.`,
      });
    }
  }

  // 3b. The affinity check above needs `targetAffinities`, which NOTHING
  //     currently supplies — `getDirectorTestFixtures()` returns only
  //     `{ actorUuid, tokenUuid }` per creature. Silence would be the
  //     permissive answer on a bench dummy that is documented air-IMMUNE and
  //     bolt-VULNERABLE, so say the check did not run.
  if (!args.targetAffinities && element) {
    caveats.push({
      severity: "note",
      text: `The target's affinity to ${element} was not supplied, so this run cannot tell a ` +
        `0 caused by immunity from a 0 caused by the skill doing nothing.`,
      fix: "Check the target's affinity to this element by hand.",
    });
  }

  // 4. A gate reading a field the payload never carried. THE permissive case.
  //
  // 🚨 `payloadKeys` is not something the harness returns — it exists nowhere
  // in module source outside this file. So this rule is currently ALWAYS
  // skipped, and skipping the module's headline check in silence is precisely
  // the failure it was written to catch. Until a real source is wired, an
  // affected skill is told the check did not run.
  if (!Array.isArray(args.payloadKeys)) {
    const gated = new Set();
    for (const f of gateFormulas(props)) {
      for (const ident of formulaIdentifiers(f)) if (PAYLOAD_BACKED[ident]) gated.add(ident);
    }
    if (gated.size) {
      caveats.push({
        severity: "blocking",
        text: `This skill gates on ${[...gated].join(", ")}, which read from the action payload — ` +
          `and this run cannot report what the payload carried. A missing identifier resolves to ` +
          `0, and for a "== 0" gate that is the PASSING answer, so a green here may be a gate ` +
          `that refuses in play. NOT CHECKED.`,
        fix: "Verify by hand that the gate sees the field, per guideline I4b.",
      });
    }
  }
  if (Array.isArray(args.payloadKeys)) {
    const supplied = new Set(args.payloadKeys);
    const missing = new Set();
    for (const f of gateFormulas(props)) {
      for (const ident of formulaIdentifiers(f)) {
        const needs = PAYLOAD_BACKED[ident];
        if (needs && !supplied.has(needs)) missing.add(`${ident} (needs payload.${needs})`);
      }
    }
    if (missing.size) {
      caveats.push({
        severity: "blocking",
        text: `The rig did not supply ${[...missing].join(", ")}. A missing identifier resolves ` +
          `to 0, and for a "== 0" gate that is the PASSING answer — so this run may have passed ` +
          `a gate that refuses in play.`,
        fix: "Supply the field, or treat this result as unproven.",
      });
    }
  }

  // 5. Did the harness hand back a bucket this module cannot read? That is how
  //    the last contract break hid: the renderer read key names the harness
  //    never used, found nothing, and said "NOTHING WAS WRITTEN" forever. A
  //    rename must be LOUD, because its symptom is indistinguishable from a
  //    skill that genuinely does nothing.
  if (result) {
    const unknown = unknownCaptureBuckets(result);
    if (unknown.length) {
      caveats.push({
        severity: "blocking",
        text: `The harness returned capture bucket(s) this reader does not know: ` +
          `${unknown.join(", ")}. Anything in them is NOT in the report below.`,
        fix: "Add them to CAPTURE_BUCKETS in test-runner.js and render them.",
      });
    }
  }

  // 6. Could this run have failed at all? If nothing was written and nothing
  //    was rolled, the chain probably never fired.
  if (result) {
    const writes = countWrites(result);
    if (writes === 0) {
      caveats.push({
        severity: "blocking",
        text: "The run captured ZERO document writes. Either the skill does nothing, or the " +
          "chain never dispatched — those look identical from here.",
        fix: "Neutralise the gate to a literal 1 and re-run. If the result is unchanged, the row never fired.",
      });
    }
  }

  return caveats;
}

/**
 * Identifiers whose value comes from the action PAYLOAD rather than the actor.
 * These are the ones a rig can silently omit. Names map to the payload key that
 * backs them, so the caveat can say exactly what was missing.
 */
const PAYLOAD_BACKED = {
  ACTION_DURATION: "skillDuration",
  ACTION_IS_FREE_CAST: "actionIsFreeCast",
  ACTION_COST_MP: "costMp",
  ACTION_MP_COST: "costMp",
  HR: "hr",
  HIT_MARGIN: "hitMargin",
  ATTACK_CHECK_RESULT: "checkResult",
  ATTACK_VS_DEF: "defenseResolved",
  ATTACK_VS_MDEF: "defenseResolved",
  DAMAGE_DEALT: "damageDealt",
  FINAL_DAMAGE: "finalDamage",
  RAW_DAMAGE: "rawDamage",
};

export function tableRows(t) {
  if (!t || typeof t !== "object") return [];
  return Object.values(t).filter((r) => r && typeof r === "object" && r.$deleted !== true);
}

function gateFormulas(props) {
  const out = [];
  for (const k of ["availability_formula", "target_eligibility"]) {
    if (String(props[k] ?? "").trim()) out.push(String(props[k]));
  }
  for (const t of ["effect_table", "reaction_config_table"]) {
    for (const r of tableRows(props[t])) {
      for (const k of ["condition_formula", "target_filter", "focus_max_formula"]) {
        if (String(r[k] ?? "").trim()) out.push(String(r[k]));
      }
    }
  }
  return out;
}

function formulaIdentifiers(f) {
  const stripped = String(f).replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  return [...stripped.matchAll(/\b([A-Z][A-Z0-9_]{1,})\b/g)].map((m) => m[1]);
}

// ── THE CAPTURE CONTRACT, READ FROM A LIVE RUN (2026-09-23) ─────────────────
// `runDirectorSkillSimulate` returns its captured writes under THESE keys.
//
// The first draft of this module invented `damage / resources / effects /
// items` and its own suite asserted that invention, so the two halves agreed
// by construction and 38 green assertions shipped a panel that could only ever
// print "NOTHING WAS WRITTEN" — including on a skill that demonstrably took the
// practice target from 10000 HP to 9988. The module header says "never
// re-derive these from a doc, read the `return` statement"; this is that rule
// applied to the thing the header itself got wrong.
//
// `countWrites` and `describeRun` now read this ONE list, so they cannot drift
// apart again, and an unrecognised bucket is reported rather than rendered as
// silence.
// The ENTRY shape of each bucket, copied from that same declaration — not from
// a live run. An earlier draft of this fix read two shapes off a capture and
// hand-wrote the other four "from whatever name they happen to carry", which is
// the identical mistake one level down: three of the four guesses were wrong,
// and their fixtures asserted the wrong keys, so the suite agreed with them.
//
//   actorUpdates  { actorUuid, actorName, patch }
//   itemUpdates   { itemUuid, itemName, patch, parentUuid }
//   aeUpdates     { aeId, aeName, parentUuid, patch }
//   aeCreates     { parentUuid, parentName, name, statusIds, changes, flags }
//   aeDeletes     { aeId, aeName, parentUuid }
//   freeActions   { sourceLabel, reactorActorId, actionType, presetName, request }
export const CAPTURE_BUCKETS = [
  "actorUpdates", "itemUpdates", "aeUpdates", "aeCreates", "aeDeletes", "freeActions",
];

// Props written by PLAY, never by the author. `battle_log` rides along on
// EVERY simulate, so counting it would mean the zero-writes caveat could never
// fire again — a skill that does nothing at all would still look like it wrote
// something. Judged on the patch's leaf key.
const VOLATILE_PROPS = new Set(["battle_log", "battle_log_table"]);

const RESOURCE_LABELS = {
  current_hp: "HP", current_mp: "MP", current_ip: "IP", shield_value: "shield",
};

// Match the WHOLE path, not the leaf. A leaf rule reads `battle_log` correctly
// today, but the moment the logger writes per-row
// (`system.props.battle_log_table.0.text`) the leaf becomes `text`, every
// simulate silently counts a write again, and the zero-writes caveat can never
// fire — the exact failure this filter exists to prevent.
const VOLATILE_PATH = /^system\.props\.battle_log(_table)?(\.|$)/;
const isVolatile = (path) => VOLATILE_PATH.test(String(path));

/**
 * The entries of a patch that represent something the author actually caused.
 *
 * The harness explicitly allows a NON-OBJECT patch (it stores `patch` as-is
 * when it is not an object). `Object.entries("hello")` yields five character
 * pairs, which would count as five writes and suppress the zero-writes caveat,
 * so the type is checked rather than assumed.
 */
function authoredPatchEntries(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
  return Object.entries(patch).filter(([path]) => !isVolatile(path));
}

/**
 * Capture keys this module does not know how to read, and which ACTUALLY HOLD
 * something — a harness rename shows up here.
 *
 * Narrowed to non-empty arrays deliberately. Flagging every unrecognised key
 * would mean that the day the harness adds `captures.summary` or a count, every
 * run forever carries a blocking caveat and the orange "does not prove"
 * banner — for runs where nothing was lost. A banner that is always on is
 * wallpaper, and wallpaper is not a tripwire. A DROPPED WRITE is by definition
 * a non-empty array, so this still catches the case that matters.
 *
 * ⚠ Bucket-level only. A FIELD-level rename (`actorName` -> `actorDisplayName`)
 * passes this untouched and degrades the prose instead; the fixtures in the
 * suite are the guard for that, which is why they are copied from source.
 */
export function unknownCaptureBuckets(result) {
  const c = result?.captures ?? {};
  return Object.keys(c).filter((k) =>
    !CAPTURE_BUCKETS.includes(k) && Array.isArray(c[k]) && c[k].length > 0);
}

function countWrites(result) {
  const c = result?.captures ?? {};
  let n = 0;
  for (const key of CAPTURE_BUCKETS) {
    const v = c[key];
    if (!Array.isArray(v)) continue;
    n += key === "actorUpdates"
      ? v.filter((u) => authoredPatchEntries(u?.patch).length > 0).length
      : v.length;
  }
  return n;
}

// ── plain-language rendering ────────────────────────────────────────────────

/**
 * Turn captured writes into sentences an author can check against the RAW text.
 *
 * Deliberately says what HAPPENED, never what "should" have happened — judging
 * intent is the author's job, and a tool that guesses at it hides the thing
 * they needed to see.
 */
/**
 * One captured write -> one sentence.
 *
 * Every field read below is the one `installWriteCaptures()` declares for that
 * bucket. Note the actor is named differently per bucket — `actorName` on an
 * actor update, `parentName` on an AE create, and NOTHING but `parentUuid` on
 * an AE update or delete — so each bucket is read on its own terms rather than
 * through one hopeful chain of candidate keys.
 */
function renderWrites(result, before = null) {
  const c = result?.captures ?? {};
  const out = [];

  // Truthiness, not `??`: the harness stores `itemName: data?.name ?? ""`, and
  // `??` does not skip an empty string, so a nameless item rendered as "
  // changes" with a leading gap and no subject.
  const or = (...xs) => xs.find((x) => typeof x === "string" && x.trim()) ?? null;
  // An AE update/delete carries only `parentUuid`. A uuid tail is ugly but it
  // is an identifier the author can search for; "someone" is not.
  const byUuid = (uuid) => (uuid ? `the creature ${String(uuid).split(".").pop()}` : "someone");

  // Foundry durations are expressed in rounds OR turns OR seconds. Reading only
  // `rounds` drops the duration silently, which is the one thing this module
  // must not do.
  const forDuration = (d) => {
    for (const [key, unit] of [["rounds", "round"], ["turns", "turn"], ["seconds", "second"]]) {
      const n = Number(d?.[key]);
      if (Number.isFinite(n) && n > 0) return ` for ${n} ${unit}(s)`;
    }
    return "";
  };

  for (const u of (c.actorUpdates ?? []).filter(Boolean)) {
    const who = or(u.actorName) ?? byUuid(u.actorUuid);
    for (const [path, value] of authoredPatchEntries(u.patch)) {
      const label = RESOURCE_LABELS[String(path).split(".").pop()];
      // \ud83e\udea4 F8. This printed the LANDING VALUE alone \u2014 "HP set to 9973" \u2014 on a
      // practice dummy that starts at 9999. A skill authored for 25 damage
      // reads as a four-digit number, and the reader has to know the starting
      // value AND do the subtraction to find out whether anything was
      // modified. The number the author is checking is the CHANGE.
      //
      // `before` comes from a snapshot the runner takes of the fixture actors
      // ahead of the run; when it is absent the line degrades to what it
      // always said rather than inventing a delta.
      const prior = before?.[u.actorUuid]?.[path];
      const delta = (typeof prior === "number" && typeof value === "number")
        ? value - prior : null;
      const move = delta === null ? "" :
        delta === 0 ? " (no change)" :
        ` (${delta > 0 ? "+" : ""}${delta} from ${prior})`;
      out.push(label
        ? `${who}: ${label} set to ${value}${move}`
        : `${who}: ${path} set to ${JSON.stringify(value)}${move}`);
    }
  }
  for (const a of (c.aeCreates ?? []).filter(Boolean)) {
    // 🪤 when the create came through Item.prototype.createEmbeddedDocuments,
    // `parentName` is the ITEM's name, not the actor's. Said plainly rather
    // than mis-attributed to a creature.
    const who = or(a.parentName) ?? byUuid(a.parentUuid);
    const n = or(a.name);
    out.push(n ? `${who} gains the effect "${n}"${forDuration(a.duration)}`
               : `${who} gains an active effect`);
  }
  for (const a of (c.aeDeletes ?? []).filter(Boolean)) {
    const n = or(a.aeName);
    out.push(n ? `${byUuid(a.parentUuid)} loses the effect "${n}"`
               : `${byUuid(a.parentUuid)} loses an active effect`);
  }
  for (const a of (c.aeUpdates ?? []).filter(Boolean)) {
    const n = or(a.aeName);
    const changed = authoredPatchEntries(a.patch).map(([p]) => p);
    const what = changed.length ? ` (${changed.join(", ")})` : "";
    out.push(n ? `${byUuid(a.parentUuid)}: the effect "${n}" changes${what}`
               : `${byUuid(a.parentUuid)}: an active effect changes${what}`);
  }
  for (const i of (c.itemUpdates ?? []).filter(Boolean)) {
    const n = or(i.itemName) ?? byUuid(i.itemUuid);
    const changed = authoredPatchEntries(i.patch).map(([p]) => p);
    out.push(changed.length ? `${n} changes (${changed.join(", ")})` : `${n} changes`);
  }
  for (const f of (c.freeActions ?? []).filter(Boolean)) {
    const n = or(f.sourceLabel, f.presetName, f.actionType);
    out.push(`a free action is granted${n ? ` (${n})` : ""}`);
  }
  return out;
}

export function describeRun({ result, doc, caveats = [], before = null }) {
  const lines = [];
  const name = doc?.name ?? "(unnamed)";
  lines.push(`${name}`);

  const said = renderWrites(result, before);
  if (!said.length) lines.push("  NOTHING WAS WRITTEN.");
  else for (const s of said) lines.push(`  ${s}`);

  const blocking = caveats.filter((c) => c.severity === "blocking");
  if (blocking.length) {
    lines.push("", "  ⚠ THIS RUN DOES NOT PROVE THE SKILL WORKS:");
    for (const c of blocking) lines.push(`    · ${c.text}`, `      → ${c.fix}`);
  }
  const notes = caveats.filter((c) => c.severity === "note");
  for (const c of notes) lines.push(`  note: ${c.text}`);

  return lines.join("\n");
}

/**
 * Run a skill through the harness and return result + caveats + prose.
 *
 * Thin on purpose: the harness owns the simulation, this owns the honesty.
 */
export async function runTest({
  skillUuid, casterTokenUuid, targetTokenUuids = [], force = null,
  picks = null, acceptReactions = true, entry = "skill", doc = null,
  targetAffinities = null,
} = {}) {
  const api = globalThis.FUCompanion?.api?.test;
  if (!api) return { ok: false, reason: "harness_unavailable" };
  const fn = api[ENTRY_POINTS[entry]?.api];
  if (typeof fn !== "function") return { ok: false, reason: `no entry point "${entry}"` };

  const args = { skillUuid, casterTokenUuid, targetTokenUuids, acceptReactions };
  if (force) args.force = force;
  if (picks) args.picks = picks;

  let res;
  try {
    res = await fn(args);
  } catch (e) {
    // I4a: a simulate that throws leaves the write-capture prototype patches
    // INSTALLED, and every later write is silently swallowed. Say so loudly —
    // reads taken after this point are untrustworthy too.
    console.error(`${TAG} simulate threw`, e);
    return {
      ok: false, reason: "simulate_threw", error: String(e?.message ?? e),
      caveats: [{
        severity: "blocking",
        text: "The simulate threw, which leaves the harness's write-capture patches installed. " +
          "Every document write from now on is silently swallowed, and any read is untrustworthy.",
        fix: "Reload the client before doing anything else.",
      }],
    };
  }

  // ⚠ `ok: false` means TWO different things, and conflating them loses the
  // more important one. The simulate returns `ok: !resolveError`, so a skill
  // whose RESOLVE THREW comes back ok:false WITH full captures and a
  // `resolveError` — and no `reason`/`hint` at all. Treating that as a refusal
  // printed "the harness refused to run: no reason given. Nothing was
  // simulated." directly above a list of the writes it had just made, and threw
  // away the one useful string. A mid-RESOLVE throw is the most common real
  // failure, not an edge case, so it is handled FIRST and keeps its captures.
  if (res && res.resolveError) {
    const msg = res.resolveError.message ?? String(res.resolveError);
    const caveat = {
      severity: "blocking",
      text: `The skill THREW while resolving: ${msg}. Anything listed below is only what ` +
        `happened before the throw — the rest of the chain never ran.`,
      fix: "Fix the row that threw; the message names it.",
    };
    const caveats = [caveat, ...auditRun({ doc, result: res, entry, args: { acceptReactions, targetAffinities } })];
    return { ok: false, raw: res, actionResults: [], reason: "resolve_threw", caveats,
             prose: describeRun({ result: res, doc, caveats }) };
  }

  // A genuine REFUSAL: the harness rejected the call before simulating and said
  // exactly why ("missing_args" + "skillUuid + casterTokenUuid +
  // targetTokenUuids[] all required"). An earlier version dropped both and fell
  // through to the entry-point caveat, so a null casterTokenUuid — the ordinary
  // case when the practice scene has lost its fixture tokens — told the author
  // to "check the entry point". Repeat what the harness said.
  if (res && res.ok === false) {
    const why = [res.reason, res.hint, res.missing && `missing: ${res.missing}`,
                 res.skillUuid && `skill: ${res.skillUuid}`].filter(Boolean).join(" — ");
    const caveat = {
      severity: "blocking",
      text: `The harness refused to run: ${why || "no reason given"}. The run did not start.`,
      fix: "Fix what it names above, then run again.",
    };
    return {
      ok: false,
      raw: res,
      actionResults: [],
      reason: res.reason ?? "harness_refused",
      // Not describeRun(): "NOTHING WAS WRITTEN" is the sentence that means
      // "the skill did nothing", and here the skill never ran at all.
      prose: `${doc?.name ?? "(unnamed)"}\n  THE RUN DID NOT START.\n\n  ⚠ ${caveat.text}\n      → ${caveat.fix}`,
      caveats: [caveat],
    };
  }

  const { results, problem } = extractActionResults(res, entry);
  const caveats = auditRun({
    doc, result: res, entry,
    args: { acceptReactions, targetAffinities, payloadKeys: res?.payloadKeys ?? null },
  });
  if (problem) caveats.unshift({ severity: "blocking", text: problem, fix: "Check the entry point." });

  return {
    ok: !!res?.ok && !problem,
    raw: res,
    actionResults: results,
    caveats,
    prose: describeRun({ result: res, doc, caveats }),
  };
}
