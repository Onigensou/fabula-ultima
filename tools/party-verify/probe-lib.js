// Step-failure reasons that mean "the RIG could not supply a precondition",
// never "the content is broken": no in-flight action card (no-sink), no combat
// to summon into (no-combat), an empty pool because an earlier rig-blocked step
// never populated it (no-candidates). Exported so merge.mjs can decide the same
// question FROM THE RECORD rather than from a timestamp.
export const RIG_BOUNDARY_REASONS = new Set(["no-sink", "no-combat", "no-candidates"]);

// Auto-prober: verify a reactor's reaction_config_table rows without hand-writing
// a payload per row.
//
// WHY THIS EXISTS. Three separate rig gaps this session each made a WORKING
// skill read as broken, and every one of them was a payload/override key the rig
// failed to supply (resource filter, reaction_source side, action intent, and an
// `override` allowlist that silently dropped unknown identifiers). Hand-written
// cases reproduce that mistake once per row. This reads the ROW and derives what
// it needs.
//
// EVERY row is probed twice: once with its gates SATISFIED and once with the
// governing identifier FLIPPED. A row that reports the same availability both
// times proves nothing — the gate never saw the pin — and is reported as
// INCONCLUSIVE rather than counted as a pass.
//
// Returns compact records; the caller renders.

// Identifiers appearing in a condition_formula, minus formula built-ins.
// 🪤 A math-builtin name can COLLIDE with a real identifier. "ROUND" is both
// round() and the COMBAT ROUND identifier, and excluding it by name meant
// `ROUND % 2 == 0 && ROUND > 0` (Prophetic Defender #1) extracted NOTHING — no
// override at all, so the row read REFUSED and looked like a broken skill.
// Exclude a name only when it is actually CALLED (followed by an open paren);
// the corpus writes builtins lowercase anyway (floor(CHAR_LEVEL / 2)).
const BUILTIN_NAMES = new Set(["AND", "OR", "NOT", "TRUE", "FALSE", "MIN", "MAX", "FLOOR", "CEIL", "ROUND", "ABS", "IF"]);
import { isCalled } from "./_is-called.js";

function extractGates(cond) {
  const out = {};
  const src = String(cond ?? "");
  if (!src.trim()) return out;
  // Pull `IDENT <op> <number>` first so the target value is derived from the
  // actual comparison — pinning 1 against `>= 3` would refuse and look like a
  // broken gate.
  const cmp = /([A-Z][A-Z0-9_]{2,})\s*(==|>=|<=|>|<|!=)\s*(-?\d+)/g;
  let m;
  while ((m = cmp.exec(src))) {
    const [, id, op, nRaw] = m;
    if (BUILTIN_NAMES.has(id) && isCalled(src, id)) continue;
    const n = Number(nRaw);
    // 🪤 FIRST occurrence wins. An identifier can appear with DIFFERENT required
    // values in each arm of a disjunction: Cataclysm gates on
    // `(ACTION_IS_FREE_CAST == 0 && ...) || (ACTION_IS_FREE_CAST == 1 && ...)`.
    // Last-wins picked 1 and therefore the harder Bimagus-charge arm, so the row
    // read REFUSED. Taking the first pins the LEADING arm, which is the one a
    // reader would satisfy.
    if (id in out) continue;
    out[id] = op === "==" ? n
      : op === ">=" ? n
      : op === ">" ? n + 1
      : op === "<=" ? n
      : op === "<" ? n - 1
      : op === "!=" ? n + 1
      : 1;
  }
  // `ID % k == r` — arithmetic the plain comparison scan cannot see. Prophetic
  // Defender #1 gates on `ROUND % 2 == 0 && ROUND > 0`; pinning ROUND=1 (the
  // bare-identifier default) fails it and the row reads REFUSED. Pin a value
  // that satisfies the congruence AND stays positive.
  const mod = /([A-Z][A-Z0-9_]{2,})\s*%\s*(\d+)\s*(==|!=)\s*(\d+)/g;
  while ((m = mod.exec(src))) {
    const [, id, kRaw, op, rRaw] = m;
    if (BUILTIN_NAMES.has(id) && isCalled(src, id)) continue;
    const k = Number(kRaw), r = Number(rRaw);
    if (!k) continue;
    out[id] = op === "==" ? (r === 0 ? k : r) : (r === 0 ? 1 : 0) || k + 1;
  }
  // `A >= B (+ N)` — an identifier compared to ANOTHER identifier. Naive pinning
  // gives both the same value and the gate fails: Cataclysm's
  // `CUR_MP >= ACTION_COST_MP + 10` became `1 >= 11`. Pin the LEFT side high and
  // the RIGHT side to 0 so the inequality holds with headroom.
  const rel = /([A-Z][A-Z0-9_]{2,})\s*(>=|>)\s*([A-Z][A-Z0-9_]{2,})/g;
  while ((m = rel.exec(src))) {
    const [, lhs, , rhs] = m;
    if (!(lhs in out)) out[lhs] = 9999;
    if (!(rhs in out)) out[rhs] = 0;
  }
  // Bare identifiers used as booleans (`SINGLE_TARGET_ATTACK &&`).
  const bare = /([A-Z][A-Z0-9_]{2,})/g;
  while ((m = bare.exec(src))) {
    const id = m[1];
    if ((BUILTIN_NAMES.has(id) && isCalled(src, id)) || id in out) continue;
    out[id] = 1;
  }
  return out;
}

// Match-filter fields decide whether a row is SCANNED at all. Absence here is
// silent: the row simply never appears, which reads as "skill is dead".
function payloadForRow(row, ctx, weaponUuid) {
  const p = {};
  const side = String(row.reaction_source ?? "").trim().toLowerCase();
  // reaction_source is matched against the payload SUBJECT, so an enemy/ally
  // -sourced row must be probed with that side as subject, not the reactor.
  if (side === "enemy" && ctx.enemy) {
    p.subjectActorUuid = ctx.enemy.actor; p.subjectTokenUuid = ctx.enemy.token;
    p.sourceActorUuid = ctx.enemy.actor;  p.sourceTokenUuid = ctx.enemy.token;
  } else if (side === "ally" && ctx.ally) {
    p.subjectActorUuid = ctx.ally.actor; p.subjectTokenUuid = ctx.ally.token;
    p.sourceActorUuid = ctx.ally.actor;  p.sourceTokenUuid = ctx.ally.token;
  }
  const res = String(row.reaction_resource_filter ?? "").trim();
  if (res) { p.resource = res; p.amount = 10; p.total = 10; }
  const cause = String(row.reaction_cause_filter ?? "").trim();
  if (cause) p.cause = cause;
  const dmgSrc = String(row.reaction_damage_source ?? "").trim().toLowerCase();
  if (dmgSrc === "enemy" && ctx.enemy) p.causeActorUuid = ctx.enemy.actor;
  else if (dmgSrc === "ally" && ctx.ally) p.causeActorUuid = ctx.ally.actor;
  else if (dmgSrc === "self" && ctx.reactor) p.causeActorUuid = ctx.reactor.actor;
  const intent = String(row.reaction_action_intent ?? "").trim();
  if (intent) p.actionIntent = intent;
  const kind = String(row.reaction_action_kind ?? "").trim();
  if (kind) p.actionKind = kind.split(",")[0].trim();
  // 🪤 reaction_status_filter matches payload.**status** (skill-effects.js ~L1000),
  // NOT statusId. Setting the wrong key silently fails the filter and the row is
  // never scanned — which reads exactly like a dead skill (Heart of Darkness #0,
  // Emergency Item #0, both filtering "Crisis").
  const status = String(row.reaction_status_filter ?? "").trim();
  if (status) p.status = status;
  // reaction_source_skill matches payload.sourceSkillName — a rider that only
  // fires after ONE named skill (Bandit Gloves waits for "Soul Steal").
  const srcSkill = String(row.reaction_source_skill ?? "").trim();
  if (srcSkill) p.sourceSkillName = srcSkill;
  // reaction_action_target ("ally"/"enemy"/"neutral") needs at least one target
  // of that disposition in payload.targetTokenUuids (skill-effects.js ~L914).
  // Absent, the row is never scanned and reads as dead.
  const at = String(row.reaction_action_target ?? "").trim().toLowerCase();
  if (at === "enemy" && ctx.enemy) p.targetTokenUuids = [ctx.enemy.token];
  else if (at === "ally" && ctx.ally) p.targetTokenUuids = [ctx.ally.token];
  // reaction_requires_weapon_used matches payload.weaponUuid against the row's
  // BACKING weapon — the carrier if it is a weapon, else its container
  // (skill-effects.js reactionWeaponUsedSatisfied ~L1616). The dump resolves it
  // the same way. Without this, every weapon-gated gear rider reads NOT_SCANNED,
  // which is indistinguishable from "the skill is broken".
  const wantsWeapon = row.reaction_requires_weapon_used;
  if (wantsWeapon === true || wantsWeapon === 1 || wantsWeapon === "true" || wantsWeapon === "1") {
    if (weaponUuid) p.weaponUuid = weaponUuid;
  }
  // Generic damage/miss context — harmless when unread, and its absence is the
  // fail-permissive case.
  p.total = p.total ?? 20;
  p.missMargin = 10;
  p.targets = p.targetTokenUuids ?? (ctx.enemy ? [ctx.enemy.token] : ["t1"]);
  p.targetTokenUuids = p.targetTokenUuids ?? (ctx.enemy ? [ctx.enemy.token] : []);
  return p;
}

export function buildCases({ rows, ctx }) {
  const cases = [];
  for (const r of rows) {
    // Gate identifiers come from the config row AND the effect row it fires.
    const gates = { ...extractGates(r.cond), ...extractGates(r.refCond) };
    const ids = Object.keys(gates);
    const payload = payloadForRow(r.raw, ctx, r.weaponUuid);
    cases.push({ key: `${r.name}#${r.row}`, name: r.name, row: r.row, trigger: r.trig,
                 cond: r.cond, gates, payload, chargeKeys: r.chargeKeys ?? [],
                 phase: "pos", override: { ...gates } });
    if (ids.length) {
      // The negative control must actually be able to REFUSE the row.
      //
      // 🪤 Flipping one identifier is only sound for a pure AND. Life
      // Transference gates on `HAS_STATUS_CRISIS == 1 || MY_FOCUS_IN_CRISIS == 1`
      // — flipping the first leaves the second satisfying the OR, availability
      // does not move, and the row scores INCONCLUSIVE even though it is fine.
      // For a disjunction every identifier has to go down together.
      const isDisjunctive = /\|\||OR/.test(String(r.cond ?? "") + " " + String(r.refCond ?? ""));
      const neg = { ...gates };
      const flipped = isDisjunctive ? ids : [ids[0]];
      for (const id of flipped) neg[id] = gates[id] === 0 ? 1 : 0;
      cases.push({ key: `${r.name}#${r.row}`, name: r.name, row: r.row, trigger: r.trig,
                   cond: r.cond, gates, payload, chargeKeys: r.chargeKeys ?? [],
                   phase: "neg", flipped, override: neg });
    }
  }
  return cases;
}

export function verdictFor(pos, neg, hasGates) {
  if (pos?.chunkFailed || neg?.chunkFailed) return { verdict: "UNMEASURED", note: `bridge chunk failed - NOT a result: ${pos?.error ?? neg?.error}` };
  if (!pos) return { verdict: "ERROR", note: "no positive result" };
  if (String(pos?.error ?? "").startsWith("probe-timeout")) return { verdict: "TIMEOUT", note: "probe hung past its deadline (open_action_menu chains gate on SimMode) - UNMEASURED, not failing" };

  if (!pos.scanned) return { verdict: "NOT_SCANNED", note: "row never reached the scan — a match filter rejected the payload" };
  // 🚨 A "pass" that CONTAINS a step failure is not a pass. Two rows scored
  // GATE_PROVEN while carrying fireReason `step-failed:botc_summon` /
  // `step-failed:botc_destroy_minion` — the gate opened and the effect chain then
  // FAILED. Availability and correctness are different questions; do not let a
  // green gate launder a broken chain.
  // ...but a step that failed because THE RIG could not supply its precondition is
  // not a broken chain either. `probeReactorTrigger` fires a synthesized trigger:
  // it has no in-flight action card and makes no combat, so any step needing one
  // fails for a reason that says nothing about the content.
  //
  // Measured 2026-08-23, once the engine started propagating the CHILD step's
  // reason (skill-effects.js applyChainEffect): `Barrage #0` and
  // `Follow my lead #0` were `add_target` → **no-sink** (no card to add to), and
  // BOTH `Birth of the Cruel` rows — carried as the top open finding for two
  // sessions — were **no-combat** / **no-candidates**. None is a defect.
  //
  // ⚠ This NARROWS a deliberate guard (STEP_FAILED exists so a green gate cannot
  // launder a broken chain), so the whitelist is exact and reason-suffixed only:
  // anything else still scores STEP_FAILED. The gate question is then answered
  // normally below, and `effectUnmeasured` records that the EFFECT was not — the
  // same honest split as a PARTIAL conformance row.
  const RIG_BOUNDARY = RIG_BOUNDARY_REASONS;
  const fr = String(pos?.fireReason ?? "");
  let effectUnmeasured = null;
  if (fr.startsWith("step-failed")) {
    const parts = fr.split(":");           // step-failed:<label>[:<reason>]
    const reason = parts.length >= 3 ? parts.slice(2).join(":").trim() : "";
    if (reason && RIG_BOUNDARY.has(reason)) {
      effectUnmeasured = { step: parts[1] ?? null, reason };
    } else {
      return { verdict: "STEP_FAILED", note: `gate opened but the effect chain FAILED: ${fr}` };
    }
  }
  const withUnmeasured = (v) => effectUnmeasured
    ? { ...v, effectUnmeasured, note: `${v.note} — EFFECT UNMEASURED: step "${effectUnmeasured.step}" needs something the trigger rig has no way to supply (${effectUnmeasured.reason}); this is a rig boundary, NOT a defect` }
    : v;
  if (!hasGates) {
    return withUnmeasured(pos.available
      ? { verdict: "AVAILABLE_UNGATED", note: "no condition_formula; availability is the whole gate" }
      : { verdict: "REFUSED", note: pos.why ?? "unavailable" });
  }
  if (!neg) return { verdict: "INCONCLUSIVE", note: "negative control did not run" };
  if (pos.available && !neg.available) return withUnmeasured({ verdict: "GATE_PROVEN", note: "flipping the gate flips availability" });
  if (!pos.available && !neg.available) return { verdict: "REFUSED", note: `unavailable even with gates pinned: ${pos.why ?? "?"}` };
  if (pos.available && neg.available) return { verdict: "INCONCLUSIVE", note: "available with the gate flipped too — the pin never reached the gate" };
  return { verdict: "INVERTED", note: "available ONLY with the gate flipped — check the condition's polarity" };
}
