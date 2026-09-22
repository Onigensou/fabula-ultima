// [ONI] Skill Forge — draft / publish safety.
// ---------------------------------------------------------------------------
// STAGE 5. A skill being authored by a non-programmer should not be reachable
// in play until somebody has looked at what the validator says about it.
//
// The design is deliberately small, because the expensive machinery already
// exists: the validator is the gate, and `world-export`'s removal warnings are
// the loss tripwire. This adds the one thing neither provides — a state a
// half-finished skill can sit in without being pickable.
//
// WHY A FLAG AND NOT A FOLDER
//   Folder placement is already load-bearing (the Battle Director tree scopes
//   migrations, and `isHeroic` gates placement). Overloading it with draft
//   state would make "where does this live" answer two questions at once, which
//   is the same conflation that made `skill_type` unusable — see
//   docs/action-command-taxonomy-proposal.md. A flag is orthogonal.
//
// WHAT PUBLISHING DOES NOT DO
//   It does not push, commit, or touch world data beyond the one flag. Shipping
//   is the user's call and stays a separate, deliberate act.

const NS = "fabula-ultima-companion";
export const DRAFT_FLAG = "skillForgeDraft";

/** True while this document is a draft and must not be offered in play. */
export function isDraft(doc) {
  return doc?.flags?.[NS]?.[DRAFT_FLAG] === true;
}

/** The flag patch that marks a document a draft (or clears it). */
export function draftPatch(on) {
  return { [`flags.${NS}.${DRAFT_FLAG}`]: on ? true : null };
}

/**
 * Severity a finding must not exceed for publishing.
 *
 * ERRORS block; warnings do not. The split is not arbitrary — the validator's
 * severity policy already means "error = the authored intent is silently NOT
 * what the engine will do, or data is destroyed". Publishing something in that
 * state ships a skill that reads correct and behaves otherwise, which is the
 * exact failure a non-programmer cannot diagnose.
 *
 * Warnings (an uneditable column, a dead prop) are real but do not change what
 * the skill DOES, so they inform rather than block.
 */
export function canPublish(findings = []) {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    // Grouped so the UI can show one line per problem rather than one per
    // occurrence — the same finding on eight rows is one thing to fix.
    blockers: groupByCode(errors),
    advisories: groupByCode(warnings),
  };
}

function groupByCode(findings) {
  const by = new Map();
  for (const f of findings) {
    if (!by.has(f.code)) by.set(f.code, { code: f.code, title: f.title, why: f.why, fix: f.fix, where: [] });
    by.get(f.code).where.push(f.location);
  }
  return [...by.values()];
}

/**
 * A publish decision rendered for a human.
 *
 * States the consequence, not the rule id — "this will be deleted the next time
 * the template reloads" is actionable; "PROP_UNDECLARED" is not.
 */
export function explainDecision(decision, docName = "This skill") {
  const lines = [];
  if (decision.ok) {
    lines.push(`${docName} is ready to publish.`);
    if (decision.advisories.length) {
      lines.push("", "It has advisories that do not change what it does:");
      for (const a of decision.advisories) lines.push(`  · ${a.title} (${a.where.length}×)`);
    }
    return lines.join("\n");
  }
  lines.push(`${docName} cannot be published yet — ${decision.errors.length} problem(s) would`);
  lines.push("make it behave differently from how it reads:");
  for (const b of decision.blockers) {
    lines.push("", `  ${b.title}`);
    if (b.why) lines.push(`    ${b.why}`);
    if (b.fix) lines.push(`    → ${b.fix}`);
    lines.push(`    at: ${b.where.slice(0, 4).join(", ")}${b.where.length > 4 ? ` (+${b.where.length - 4} more)` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Publish, or refuse and say why.
 *
 * `write` is injected so this stays pure and testable — in game it is a
 * document update, in a test it is a spy. The caller owns persistence; this
 * owns the decision.
 */
export async function publish({ doc, findings, write, force = false }) {
  const decision = canPublish(findings);
  if (!decision.ok && !force) {
    return { ok: false, decision, message: explainDecision(decision, doc?.name) };
  }
  if (typeof write === "function") await write(draftPatch(false));
  return {
    ok: true,
    decision,
    forced: !decision.ok && force,
    message: decision.ok
      ? explainDecision(decision, doc?.name)
      // A forced publish is a decision someone made on the record, the same way
      // world-export's removal warnings are cleared deliberately rather than
      // silently. Never let it look like a clean pass.
      : `PUBLISHED WITH ${decision.errors.length} UNRESOLVED ERROR(S) — forced.\n\n` +
        explainDecision(decision, doc?.name),
  };
}

/** Send a document back to draft. Always allowed; nothing is lost. */
export async function unpublish({ write }) {
  if (typeof write === "function") await write(draftPatch(true));
  return { ok: true };
}
