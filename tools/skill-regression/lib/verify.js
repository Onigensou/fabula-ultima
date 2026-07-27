// ───────────────────────────────────────────────────────────────────────────
// skill-regression — expectation/verify runner (runs inside Foundry via the
// test-bridge evalGM, driven by `bin/skill-regression.js verify`).
//
// The golden diff answers "did behaviour CHANGE"; this answers "is it CORRECT".
// It runs a hand-authored set of scenarios (expectations/*.json) through the real
// director test harness and checks INVARIANTS — facts that must hold regardless
// of balance tuning (no resolve error, affinity routing, a heal raises HP, a crit
// sets the crit flag). Invariants deliberately avoid exact damage/heal numbers so
// they don't churn on every rebalance — the golden already tracks numbers.
//
// Spec schema (one array per file):
//   {
//     "name":   "Heal raises a wounded ally's HP",
//     "caster": "Test Caster",          // actor name; defaults to fixtures.caster
//     "skill":  "Heal",                 // skill item name on the caster
//     "target": "ally",                 // "self" | "ally" | "enemy" | <actor name>
//     "mode":   "simulate",             // "compute" (default) | "simulate"
//     "force":  { "crit": true },       // same semantics as the harness
//     "override": { "SL": 5 },          // formula-identifier pins
//     "acceptPassives": false,
//     "picks": ["Dazed"],
//     "assert": [
//       { "signal": "ok",          "op": "eq",       "value": true },
//       { "signal": "targetHpUp",  "op": "truthy" },
//       { "signal": "affinity0",   "op": "eq",       "value": "vu" },
//       { "signal": "aeApplied",   "op": "contains", "value": "Dazed" }
//     ]
//   }
//
// Derived SIGNALS available to assertions:
//   ok, hit0, crit, fumble, hr, damage0, affinity0(lowercased), resource0,
//   hasDamage, hasHealing, targetHpUp/targetHpDown/targetHpDelta,
//   casterHpUp/casterHpDown/casterHpDelta (simulate only), aeApplied[] (names),
//   aeRemoved[] (names), reason (when ok is false).
// ───────────────────────────────────────────────────────────────────────────

const opts = (typeof OPTS !== "undefined" && OPTS) ? OPTS : {};
const specs = Array.isArray(opts.specs) ? opts.specs : [];

const api = globalThis.FUCompanion?.api?.test;
if (!api?.getDirectorTestFixtures) return { ok: false, error: "director test harness not registered" };
const fx = await api.getDirectorTestFixtures();
if (!fx?.caster?.tokenUuid) return { ok: false, error: "no director test fixtures (Test Caster/Ally/Enemy) on the active scene" };

const scene = game.scenes.get(fx.scene?.id) || game.scenes.find((s) => s.active);
const tokensByActorName = {};
for (const t of scene.tokens) if (t.actor) (tokensByActorName[t.actor.name] ||= t);

function casterTokenFor(spec) {
  if (!spec.caster || spec.caster === "Test Caster") return fx.caster;
  const t = tokensByActorName[spec.caster];
  return t ? { tokenUuid: t.uuid, actorUuid: t.actor.uuid } : null;
}
function targetTokenUuidFor(spec, casterUuid) {
  const r = spec.target || "enemy";
  if (r === "self") return casterUuid;
  if (r === "ally") return fx.ally.tokenUuid;
  if (r === "enemy") return fx.enemy.tokenUuid;
  const t = tokensByActorName[r];
  return t ? t.uuid : null;
}
function skillUuidFor(casterActor, name) {
  const it = casterActor.items.find((i) => i.name === name &&
    ["Active", "Spell"].includes(i.system?.props?.skill_type));
  return it ? it.uuid : null;
}
function hpOf(uuid) {
  const tok = fromUuidSync ? fromUuidSync(uuid) : null;
  const actor = tok?.actor || tok;
  return Number(actor?.system?.props?.current_hp);
}
function actorNameOfTokenUuid(uuid) {
  const tok = fromUuidSync ? fromUuidSync(uuid) : null;
  return tok?.actor?.name || null;
}

function deriveSignals(spec, r, targetUuid, casterUuid, preTargetHp, preCasterHp) {
  const s = { ok: !!r.ok, reason: r.reason || (r.ok ? null : "not_ok") };
  const ar = r.actionResult || {};
  s.crit = !!ar.roll?.isCrit;
  s.fumble = !!ar.roll?.isFumble;
  s.hr = ar.roll?.hr ?? null;
  s.hasDamage = !!ar.hasDamage;
  s.hasHealing = !!ar.hasHealing;
  const pt0 = (ar.perTargetResults || [])[0] || {};
  s.hit0 = !!pt0.hit;
  s.damage0 = Number.isFinite(pt0.damage) ? pt0.damage : 0;
  s.affinity0 = pt0.affinity != null ? String(pt0.affinity).toLowerCase() : null;
  s.resource0 = pt0.resource ?? null;
  // simulate-only write signals
  const writes = r.perActorWrites || [];
  const targetName = actorNameOfTokenUuid(targetUuid);
  const casterName = actorNameOfTokenUuid(casterUuid);
  const hpWrite = (name) => {
    const w = writes.find((x) => x.actorName === name);
    const v = w?.propPatches?.["system.props.current_hp"];
    return Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : null);
  };
  const tHp = hpWrite(targetName), cHp = hpWrite(casterName);
  s.targetHpDelta = (tHp != null && Number.isFinite(preTargetHp)) ? tHp - preTargetHp : null;
  s.casterHpDelta = (cHp != null && Number.isFinite(preCasterHp)) ? cHp - preCasterHp : null;
  s.targetHpUp = s.targetHpDelta != null && s.targetHpDelta > 0;
  s.targetHpDown = s.targetHpDelta != null && s.targetHpDelta < 0;
  s.casterHpUp = s.casterHpDelta != null && s.casterHpDelta > 0;
  s.casterHpDown = s.casterHpDelta != null && s.casterHpDelta < 0;
  const aeNames = (arr) => [].concat(...writes.map((w) => (w[arr] || []).map((a) => a.name)));
  s.aeApplied = aeNames("aeApplied");
  s.aeRemoved = aeNames("aeRemoved");
  return s;
}

function evalAssert(sig, a) {
  const have = sig[a.signal];
  const val = a.value;
  switch (a.op) {
    case "eq": return have === val;
    case "ne": return have !== val;
    case "gt": return Number(have) > Number(val);
    case "gte": return Number(have) >= Number(val);
    case "lt": return Number(have) < Number(val);
    case "lte": return Number(have) <= Number(val);
    case "truthy": return !!have;
    case "falsy": return !have;
    case "contains": return Array.isArray(have)
      ? have.some((x) => String(x).includes(val))
      : String(have ?? "").includes(val);
    default: return false;
  }
}

const results = [];
for (const spec of specs) {
  const res = { name: spec.name || spec.skill || "(unnamed)", pass: true, failures: [] };
  try {
    const c = casterTokenFor(spec);
    if (!c) throw new Error(`caster "${spec.caster}" not on scene`);
    const casterActor = (fromUuidSync ? fromUuidSync(c.tokenUuid) : null)?.actor;
    const skillUuid = casterActor ? skillUuidFor(casterActor, spec.skill) : null;
    if (!skillUuid) throw new Error(`skill "${spec.skill}" not found on ${spec.caster || "Test Caster"}`);
    const targetUuid = targetTokenUuidFor(spec, c.tokenUuid);
    if (!targetUuid) throw new Error(`target "${spec.target}" unresolved`);
    const mode = spec.mode === "simulate" ? "simulate" : "compute";
    const preTargetHp = hpOf(targetUuid);
    const preCasterHp = hpOf(c.tokenUuid);
    const runFn = mode === "simulate" ? api.runDirectorSkillSimulate : api.runDirectorSkillCompute;
    const call = {
      skillUuid, casterTokenUuid: c.tokenUuid, targetTokenUuids: [targetUuid],
      force: spec.force || { rA: 5, rB: 6 },
      override: spec.override || { SL: 5, CHAR_LEVEL: 50, BOND_COUNT: 4, BOND_STRENGTH: 4 },
    };
    if (Array.isArray(spec.picks)) call.picks = spec.picks;
    if (spec.acceptPassives !== undefined) call.acceptPassives = spec.acceptPassives;
    const r = await runFn(call);
    const sig = deriveSignals(spec, r, targetUuid, c.tokenUuid, preTargetHp, preCasterHp);
    for (const a of (spec.assert || [])) {
      if (!evalAssert(sig, a)) {
        res.pass = false;
        res.failures.push(`${a.desc ? a.desc + " — " : ""}expected ${a.signal} ${a.op} ${JSON.stringify(a.value)}, got ${JSON.stringify(sig[a.signal])}`);
      }
    }
    res.signals = sig;
  } catch (e) {
    res.pass = false;
    res.failures.push("threw: " + (e?.message || String(e)));
  }
  results.push(res);
}

return {
  ok: true,
  total: results.length,
  pass: results.filter((r) => r.pass).length,
  fail: results.filter((r) => !r.pass).length,
  engineVersion: game.modules.get("fabula-ultima-companion")?.version || null,
  results,
};
