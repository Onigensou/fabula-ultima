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
  const element = String(props.type_damage ?? "").trim().toLowerCase();
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

  // 4. A gate reading a field the payload never carried. THE permissive case.
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

  // 5. Could this run have failed at all? If nothing was written and nothing
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

function tableRows(t) {
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

function countWrites(result) {
  const c = result?.captures ?? {};
  let n = 0;
  for (const v of Object.values(c)) if (Array.isArray(v)) n += v.length;
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
export function describeRun({ result, doc, caveats = [] }) {
  const lines = [];
  const name = doc?.name ?? "(unnamed)";
  lines.push(`${name}`);

  const captures = result?.captures ?? {};
  const damage = (captures.damage ?? []).filter(Boolean);
  const resources = (captures.resources ?? []).filter(Boolean);
  const effects = (captures.effects ?? []).filter(Boolean);
  const items = (captures.items ?? []).filter(Boolean);

  if (!damage.length && !resources.length && !effects.length && !items.length) {
    lines.push("  NOTHING WAS WRITTEN.");
  } else {
    for (const d of damage) {
      lines.push(`  ${d.targetName ?? "target"} takes ${d.amount} ${d.element ?? ""} damage`.trimEnd()
        + (d.cause ? ` (${d.cause})` : ""));
    }
    for (const r of resources) {
      const verb = Number(r.delta) >= 0 ? "gains" : "loses";
      lines.push(`  ${r.targetName ?? "target"} ${verb} ${Math.abs(Number(r.delta))} ${String(r.resource ?? "").toUpperCase()}`);
    }
    for (const e of effects) {
      lines.push(`  ${e.targetName ?? "target"} gains the effect "${e.name}"` +
        (e.rounds ? ` for ${e.rounds} round(s)` : ""));
    }
    for (const i of items) lines.push(`  ${i.action ?? "changes"} ${i.name ?? "an item"}`);
  }

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
