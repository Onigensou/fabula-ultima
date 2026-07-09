// ───────────────────────────────────────────────────────────────────────────
// skill-regression — in-world collector (runs inside Foundry via test-bridge
// evalGM). The Node driver (bin/skill-regression.js) prepends
//   const OPTS = { ...runtime options... };
// then this body, and sends the whole thing as the evalGM `code`. It returns a
// deterministic fingerprint map that the driver diffs against committed goldens.
//
// Paging: the driver calls this repeatedly with OPTS.offset/OPTS.pageSize over a
// FLAT, deterministic (caster, skill) task list, because the bridge caps a
// single evalGM at 5 min. `hasMore`/`nextOffset` tell the driver when to stop.
//
// COMPUTE mode (default) is READ-ONLY — no prototype patching, safe mid-battle.
// SIMULATE mode captures RESOLVE writes + card HTML but monkey-patches document
// prototypes for the call window; it is gated on a quiescent director here.
//
// Per-skill guard: each harness call races a timeout so one interactive skill
// (an open_action_menu that would PROMPT at COMPUTE with no auto-pick) can't
// wedge the whole batch. On timeout the skill is recorded as ok:false /
// reason:"timeout" (a STABLE, diffable state) and any dialog the harness spawned
// is closed. Interactive skills therefore fingerprint consistently rather than
// hanging — pass OPTS.picks or add them to a skip list to exercise them for real.
//
// Reproducibility: same engine + same actor state + same OPTS => identical
// fingerprints. Formula identifiers (SL/level/bonds) are pinned via `override`.
// ───────────────────────────────────────────────────────────────────────────

const opts = (typeof OPTS !== "undefined" && OPTS) ? OPTS : {};
const mode = opts.mode === "simulate" ? "simulate" : "compute";
const sceneName = opts.sceneName || null;
const includeTypes = Array.isArray(opts.includeTypes) && opts.includeTypes.length
  ? opts.includeTypes : ["Active", "Spell"];
const onlyCaster = opts.onlyCaster || null;
const offset = Number(opts.offset) || 0;
const pageSize = Number(opts.pageSize) || 0;          // 0 = no paging (all in one call)
const perSkillMs = Number(opts.perSkillMs) || 12000;  // guard per harness call
const skipNames = Array.isArray(opts.skip) ? opts.skip : [];
const force = opts.force || { rA: 5, rB: 6 };
const override = opts.override || { SL: 5, CHAR_LEVEL: 50, BOND_COUNT: 4, BOND_STRENGTH: 4 };

const api = globalThis.FUCompanion?.api?.test;
if (!api?.runDirectorSkillCompute) {
  return { ok: false, error: "director test harness not registered (FUCompanion.api.test missing)" };
}

const scene = (sceneName && game.scenes.find((s) => s.name === sceneName))
  || game.scenes.find((s) => s.active)
  || game.scenes.find((s) => s.name === "Training Ground");
if (!scene) return { ok: false, error: "no roster scene (pass sceneName, or activate one)" };

const toks = Array.from(scene.tokens).filter((t) => t.actor);
const enemyTokens = toks.filter((t) => (t.disposition ?? 0) < 0);
const allyTokens = toks.filter((t) => (t.disposition ?? 0) >= 0);
const enemyTarget = enemyTokens[0] || allyTokens[0] || toks[0] || null;
if (!enemyTarget) return { ok: false, error: `roster scene "${scene.name}" has no usable tokens` };

let casters = allyTokens.slice().sort((a, b) =>
  (a.actor.name || "").localeCompare(b.actor.name || "") || a.id.localeCompare(b.id));
if (onlyCaster) casters = casters.filter((t) => t.actor.name === onlyCaster);
if (!casters.length) return { ok: false, error: onlyCaster ? `no caster token named "${onlyCaster}"` : "no ally-disposition caster tokens" };

if (mode === "simulate") {
  const st = globalThis.FUCompanion?.api?.experimental?.battleDirector?.status?.();
  const busy = ["COMPUTE", "RESOLVE", "CONFIRM", "TARGET"];
  if (st?.running && busy.includes(st.state) && !opts.forceSimulate) {
    return { ok: false, error: `simulate mode refused: director is mid-action (state=${st.state}). Pass forceSimulate:true only if certain no live action is resolving.` };
  }
}

function isOffensive(p) {
  if (p.type_damage) return true;
  const dtt = String(p.defense_target_type || "").toLowerCase();
  return dtt === "def" || dtt === "mdef" || dtt === "m.def" || dtt === "magic" || dtt === "magic_defense";
}

// Build the FLAT deterministic task list across all casters, then window it.
const tasks = [];
for (const cTok of casters) {
  const items = cTok.actor.items
    .filter((i) => includeTypes.includes(i.system?.props?.skill_type))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.id.localeCompare(b.id));
  for (const skill of items) tasks.push({ cTok, skill });
}
const total = tasks.length;
// Pre-compute which (caster, skillName) pairs are non-unique across the WHOLE
// task list so duplicates get a stable id-suffixed key regardless of which page
// they land in (each page rebuilds the full task list, so this is deterministic).
const nameCounts = {};
for (const { cTok, skill } of tasks) {
  const nk = `${cTok.actor.name} / ${skill.name}`;
  nameCounts[nk] = (nameCounts[nk] || 0) + 1;
}
const window = pageSize ? tasks.slice(offset, offset + pageSize) : tasks.slice(offset);
const nextOffset = offset + window.length;
const hasMore = nextOffset < total;

function fingerprint(skill, actor, offensive, targets, r) {
  const p = skill.system?.props || {};
  const fp = { skill: skill.name, skillType: p.skill_type || null, caster: actor.name, offensive, targets: targets.length, ok: !!r.ok };
  if (!r.ok) { fp.reason = r.reason || "not_ok"; return fp; }
  const ar = r.actionResult || {};
  fp.roll = ar.roll ? { hr: ar.roll.hr ?? null, crit: !!ar.roll.isCrit, fumble: !!ar.roll.isFumble } : null;
  fp.hasDamage = !!ar.hasDamage;
  fp.hasHealing = !!ar.hasHealing;
  fp.element = ar.damage?.element ?? p.type_damage ?? null;
  fp.perTarget = (ar.perTargetResults || []).map((t) => ({
    hit: !!t.hit,
    damage: Number.isFinite(t.damage) ? t.damage : 0,
    resource: t.resource ?? null,
    affinity: t.affinity ?? null,
    grant: (typeof t.grantAmount === "number") ? t.grantAmount : null,
    grantRes: t.grantResource ?? null,
  }));
  if (mode === "simulate") {
    fp.writes = (r.perActorWrites || []).map((w) => ({
      actor: w.actorName || null,
      props: Object.keys(w.propPatches || {}).sort().map((k) => `${k}=${JSON.stringify(w.propPatches[k])}`),
      aeApplied: (w.aeApplied || []).map((a) => `${a.name}[${(a.changes || []).join(",")}]`).sort(),
      aeRemoved: (w.aeRemoved || []).map((a) => a.name).sort(),
    })).sort((a, b) => (a.actor || "").localeCompare(b.actor || ""));
    fp.cardHtml = Array.isArray(r.cardHtmlNormalized) ? r.cardHtmlNormalized : null;
    if (r.resolveError) fp.resolveError = r.resolveError.message || String(r.resolveError);
  }
  return fp;
}

// Run one harness call with a timeout guard. On timeout, close any dialog the
// harness newly opened (interactive open_action_menu) so nothing lingers on the
// GM's screen, and return a stable "timeout" fingerprint.
async function guardedRun(runFn, callArgs) {
  const before = new Set(Object.keys(ui.windows || {}));
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), perSkillMs); });
  let r;
  try { r = await Promise.race([runFn(callArgs), timeout]); }
  catch (e) { clearTimeout(timer); return { ok: false, reason: "threw", threw: String(e?.message || e) }; }
  clearTimeout(timer);
  if (r && r.__timeout) {
    for (const [id, w] of Object.entries(ui.windows || {})) {
      if (!before.has(id)) { try { await w.close(); } catch {} }
    }
    return { ok: false, reason: "timeout" };
  }
  return r;
}

const skills = {};
const errors = [];
const timings = [];
let n = 0;
const started = Date.now();
const runFn = mode === "simulate" ? api.runDirectorSkillSimulate : api.runDirectorSkillCompute;

for (const { cTok, skill } of window) {
  const actor = cTok.actor;
  const p = skill.system?.props || {};
  // Disambiguate same-named skills on one caster (e.g. a gear _skill sharing its
  // container's name) so no fingerprint is silently overwritten. Stable + page
  // independent: suffix the id only when the name is non-unique for this caster.
  const baseKey = `${actor.name} / ${skill.name}`;
  const key = nameCounts[baseKey] > 1 ? `${baseKey} #${skill.id.slice(0, 6)}` : baseKey;
  if (skipNames.includes(skill.name) || skipNames.includes(key)) {
    skills[key] = { skill: skill.name, skillType: p.skill_type || null, caster: actor.name, ok: false, reason: "skipped" };
    n++; continue;
  }
  const offensive = isOffensive(p);
  const targets = offensive ? [enemyTarget.uuid] : [cTok.uuid];
  const t0 = Date.now();
  const r = await guardedRun(runFn, {
    skillUuid: skill.uuid, casterTokenUuid: cTok.uuid, targetTokenUuids: targets,
    force, override, ...(Array.isArray(opts.picks) ? { picks: opts.picks } : {}),
  });
  timings.push({ key, ms: Date.now() - t0 });
  skills[key] = fingerprint(skill, actor, offensive, targets, r);
  if (!r.ok) errors.push({ key, reason: r.reason || "not_ok" });
  n++;
}

// Slowest few, to surface interactive/heavy skills for a skip list.
timings.sort((a, b) => b.ms - a.ms);

return {
  ok: true,
  mode,
  scene: scene.name,
  casters: casters.map((t) => t.actor.name),
  enemyTarget: enemyTarget.actor?.name || null,
  total,
  offset,
  count: n,
  nextOffset,
  hasMore,
  errorCount: errors.length,
  tookMs: Date.now() - started,
  slowest: timings.slice(0, 5),
  engineVersion: game.modules.get("fabula-ultima-companion")?.version || null,
  override,
  force,
  errors,
  skills,
};
