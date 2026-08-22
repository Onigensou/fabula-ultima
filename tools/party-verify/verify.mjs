// node tools/party-verify/verify.mjs <ActorName> [--enemy X] [--ally Y] [--chunk N]
// Game must be OPEN (bridge). Announces nothing; the caller reports.
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCases, verdictFor } from "./probe-lib.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const BRIDGE = resolve(ROOT, "worlds/fabula-ultima-2/test-bridge");
const SECRET = readFileSync(resolve(BRIDGE, "bridge-secret.txt"), "utf8").trim();
const OUT = resolve(HERE, "results");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const who = argv[0];
if (!who) { console.error("usage: verify.mjs <ActorName> [--enemy N] [--ally N] [--chunk N]"); process.exit(2); }
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const ENEMY = arg("--enemy", "Test Target Enemy");
const ALLY = arg("--ally", "Test Target Ally");
const CHUNK = Number(arg("--chunk", "6"));
const PROBE_MS = Number(arg("--probe-ms", "45000"));
// --only <substr>: re-run just the rows whose skill name matches, so a targeted
// retry (e.g. the conflict_start rows that need a longer deadline) costs minutes
// instead of a whole sweep. merge.mjs unions the runs.
const ONLY = arg("--only", null);

let seq = 0;
async function evalGM(code, args, timeoutMs = 280000) {
  const id = `pv${Date.now().toString(36)}${seq++}`;
  const req = resolve(BRIDGE, `inbox/req-${id}.json`);
  const res = resolve(BRIDGE, `outbox/res-${id}.json`);
  const wrapped = `const ARGS = ${JSON.stringify(args ?? null)};\n${code}`;
  writeFileSync(req, JSON.stringify({ id, kind: "evalGM", auth: SECRET, timeoutMs, args: { code: wrapped } }));
  const deadline = Date.now() + timeoutMs + 30000;
  try {
    while (Date.now() < deadline) {
      if (existsSync(res)) {
        const body = JSON.parse(readFileSync(res, "utf8"));
        return body;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("bridge timeout");
  } finally {
    for (const f of [req, res]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  }
}

const DUMP = `
const a = game.actors.getName(ARGS.who);
if (!a) return { err: "actor not found" };
const g = (n) => { const t = canvas.tokens.placeables.find(x => x.actor?.name === n); return t ? { actor: t.actor.uuid, token: t.document.uuid } : null; };
const rows = [];
for (const it of a.items) {
  const tbl = it.system?.props?.reaction_config_table ?? {};
  for (const [k, r] of Object.entries(tbl)) {
    // 🪤 A CSB tombstone comes in TWO shapes: the string "$deleted" AND an
    // OBJECT carrying a truthy $deleted property. Checking only the string
    // counted removed rows as real — Zarg's High Speed #0/#99 are tombstones,
    // and they showed up as two spurious NOT_SCANNED verdicts.
    if (!r || r === "$deleted" || r.$deleted) continue;
    // Resolve the row's BACKING weapon exactly as reactionWeaponUsedSatisfied
    // does, so the payload can satisfy reaction_requires_weapon_used.
    let weaponUuid = null, containerEquipped = null;
    const isWeapon = (d) => String(d?.system?.props?.item_type ?? "").toLowerCase() === "weapon";
    if (isWeapon(it)) weaponUuid = it.uuid;
    else if (it.system?.container) {
      const c = a.items.get(it.system.container);
      if (c) { containerEquipped = c.system?.props?.isEquipped === true; if (isWeapon(c)) weaponUuid = c.uuid; }
    }
    // Availability can ALSO depend on the referenced EFFECT row's own
    // condition_formula, not just the config row's. Cognitive Focus rows 1/2/3
    // share ANY_TARGET_HAS_MY_FOCUS == 1 yet 2/3 refused, because their effect
    // rows cf_heal_hp / cf_heal_mp gate on TARGET_HAS_MY_FOCUS (per target, a
    // DIFFERENT identifier). Pin both or the row reads broken.
    // NOTE: no backticks in this comment -- it lives inside a template literal.
    const ref = String(r.reaction_effect_ref ?? "").trim();
    let refCond = "";
    if (ref) {
      for (const er of Object.values(it.system?.props?.effect_table ?? {})) {
        if (!er || er === "$deleted" || er.$deleted) continue;
        if (String(er.effect_label ?? "").trim() === ref) {
          const c = String(er.condition_formula ?? "").trim();
          if (c) refCond += (refCond ? " && " : "") + c;
        }
      }
    }
    // Charge gates are NOT part of condition_formula: estimateChainCost walks
    // the chain's consume_charge rows into chargeDebit, then sums real
    // charge-bearing AEs (findChargeAEsOnActor). A pinned identifier can never
    // satisfy that, so the row refuses with badge "No Charge". Collect the
    // charge_key(s) so the probe can seed a real AE via preApply.
    const chargeKeys = [];
    for (const er of Object.values(it.system?.props?.effect_table ?? {})) {
      if (!er || er === "$deleted" || er.$deleted) continue;
      const ck = String(er.charge_key ?? "").trim();
      if (ck && !chargeKeys.includes(ck)) chargeKeys.push(ck);
    }
    rows.push({ name: it.name, row: k, trig: r.reaction_trigger ?? "", refCond, ref, chargeKeys,
      cond: String(r.condition_formula ?? ""), mode: r.reaction_passive_mode ?? "",
      gearLinked: !!it.system?.container, weaponUuid, containerEquipped, raw: r });
  }
}
return { rows, ctx: { reactor: g(ARGS.who), enemy: g(ARGS.enemy), ally: g(ARGS.ally) },
         onCanvas: !!g(ARGS.who) };
`;

const RUN = `
const T = FUCompanion.api.test;
const guard = T.harnessWriteCaptureState ? T.harnessWriteCaptureState() : null;
const out = [];
for (const c of ARGS.cases) {
  let r;
  // PER-PROBE TIMEOUT. Zarg has open_action_menu chains whose list-picker gates
  // on SimMode (not __FU_HARNESS_HEADLESS__), so a probe can hang until the
  // bridge watchdog fires -- taking its whole chunk with it, then the retry.
  // One stuck probe must cost ONE line, not the run.
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("probe-timeout:" + label)), ms)),
  ]);
  try {
    const preApply = (c.chargeKeys ?? []).map((key) => ({
      targetActorUuid: ARGS.reactorUuid,
      data: { name: "PV Charge " + key,
              flags: { "fabula-ultima-companion": { chargeKey: key, charges: 9, chargesMax: 9 } } },
    }));
    r = await withTimeout(T.probeReactorTrigger({ reactorName: ARGS.who, trigger: c.trigger,
      payloadExtra: c.payload, override: c.override, depsToken: ARGS.tok,
      preApply: preApply.length ? preApply : null }), ARGS.probeMs ?? 45000, c.key);
  } catch (e) { out.push({ key: c.key, phase: c.phase, error: String(e?.message ?? e) }); continue; }
  const hit = (r.candidates ?? []).find(x => x.carrierName === c.name && String(x.rowKey) === String(c.row));
  out.push({ key: c.key, phase: c.phase, scanned: !!hit,
    available: hit?.available ?? null, why: hit?.unavailableReason ?? null,
    fired: hit?.fired ?? null, fireReason: hit?.fireReason ?? null,
    mode: hit?.mode ?? null,
    writes: (hit?.writes ?? []).map(w => \`\${w.actorName}\${JSON.stringify(w.propPatches ?? {})}\${(w.aeApplied ?? []).map(x => "+AE[" + x.name + "]").join("")}\${(w.aeRemoved ?? []).map(x => "-AE[" + x.name + "]").join("")}\`),
    scannedCount: (r.candidates ?? []).length });
}
return { guard, out };
`;

// Sweep stray probe seeds before starting. A killed run never gets to run its
// preApply cleanup, so its "PV Charge <key>" AEs persist on the actor and leak
// into the next run's evidence (and into world-export as authored content).
// Scoped to the PV prefix only -- never delete by a broad predicate.
const SWEEP = `
const removed = [];
for (const a of game.actors) for (const e of [...a.effects]) {
  if (/^PV Charge /.test(e.name ?? "")) { await e.delete(); removed.push(a.name + "/" + e.name); }
}
return { removed };
`;
const sw = await evalGM(SWEEP, null);
const swept = (sw.result ?? sw)?.removed ?? [];
if (swept.length) console.error(`  swept ${swept.length} stray probe AE(s) from a previous run: ${swept.join(", ")}`);

const d = await evalGM(DUMP, { who, enemy: ENEMY, ally: ALLY });
if (d.error || d.result?.err) { console.error("dump failed:", d.error ?? d.result?.err); process.exit(1); }
const { rows, ctx, onCanvas } = d.result ?? d;
// 🚨 HARD ABORT on an empty canvas. probeReactorTrigger resolves reactors from
// canvas.tokens.placeables, so with no tokens EVERY row degrades to NOT_SCANNED
// — a full sweep of silent false negatives that looks exactly like real data.
// Hit three times now; the last one also produced bogus STEP_FAILED rows, and
// because STEP_FAILED deliberately outranks a pass in merge.mjs, writing that
// run would have POISONED verdicts earned by good runs.
// Refuse to write results at all rather than record a sweep we cannot trust.
if (!onCanvas) {
  console.error(`!! ABORT: ${who} has no token on the CANVAS scene.`);
  console.error(`   canvas.tokens.placeables is empty, so every row would read NOT_SCANNED.`);
  console.error(`   Fix: activate the scene, run tools/test-bridge-client/_restore-training-roster.js,`);
  console.error(`   then RELAUNCH the client (tokens only become placeables after a real boot).`);
  process.exit(2);
}
const rowsFiltered = ONLY ? rows.filter((r) => r.name.toLowerCase().includes(ONLY.toLowerCase())) : rows;
if (ONLY) console.log(`--only "${ONLY}" -> ${rowsFiltered.length} of ${rows.length} row(s)`);
const cases = buildCases({ rows: rowsFiltered, ctx });
console.log(`${who}: ${rows.length} config row(s) -> ${cases.length} probe(s) (positive + negative control)`);

const results = new Map();
let guardSeen = null;
// A DROPPED CHUNK IS NOT A RESULT. v1 did `for (const rec of body.out ?? [])`
// and moved on, so a bridge timeout silently lost a whole chunk and its rows
// were then reported "ERROR: no positive result" -- indistinguishable from a
// real defect. It mis-scored a row that had been GATE_PROVEN minutes earlier.
// Retry once, then record the loss explicitly as UNMEASURED.
const chunkFailures = [];
for (let i = 0; i < cases.length; i += CHUNK) {
  const slice = cases.slice(i, i + CHUNK);
  let body = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // The bridge window must EXCEED the worst case a chunk can take, or a slow
      // chunk is reported UNMEASURED for a rig reason rather than a real one.
      // Worst case = every probe in the chunk burning its full deadline.
      const chunkBudget = slice.length * PROBE_MS + 60000;
      const r = await evalGM(RUN, { who, cases: slice, tok: "pv-" + who, reactorUuid: ctx.reactor?.actor ?? null, probeMs: PROBE_MS }, chunkBudget);
      const b = r.result ?? r;
      if (Array.isArray(b?.out)) { body = b; break; }
      lastErr = r?.error ?? b?.error ?? "no `out` array in bridge reply";
    } catch (e) { lastErr = String(e?.message ?? e); }
    if (attempt === 1) console.error(`  !! chunk ${i}-${i + slice.length} failed (${lastErr}) - retrying once`);
  }
  if (!body) {
    chunkFailures.push({ from: i, to: i + slice.length, error: String(lastErr) });
    for (const c of slice) results.set(`${c.key}|${c.phase}`, { key: c.key, phase: c.phase, chunkFailed: true, error: String(lastErr) });
    console.error(`  !! chunk ${i}-${i + slice.length} FAILED TWICE - ${slice.length} probe(s) UNMEASURED: ${lastErr}`);
    continue;
  }
  if (body.guard) guardSeen = body.guard;
  for (const rec of body.out) results.set(`${rec.key}|${rec.phase}`, rec);
  process.stdout.write(`  ran ${Math.min(i + CHUNK, cases.length)}/${cases.length}
`);
}
if (chunkFailures.length) console.error(`!! ${chunkFailures.length} chunk(s) failed - those rows are UNMEASURED, not failing`);
if (guardSeen?.poisoned) console.error("!! harness reported POISONED during this run — results are suspect");

const report = [];
for (const r of rowsFiltered) {
  const key = `${r.name}#${r.row}`;
  const pos = results.get(`${key}|pos`), neg = results.get(`${key}|neg`);
  const gates = Object.keys(buildCases({ rows: [r], ctx })[0].gates);
  const v = verdictFor(pos, neg, gates.length > 0);
  report.push({ name: r.name, row: r.row, trigger: r.trig, mode: r.mode, gearLinked: r.gearLinked,
    containerEquipped: r.containerEquipped, weaponBacked: !!r.weaponUuid,
    gates, cond: r.cond, ...v,
    pos: pos && { available: pos.available, fired: pos.fired, fireReason: pos.fireReason, why: pos.why, writes: pos.writes },
    neg: neg && { available: neg.available, why: neg.why } });
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(resolve(OUT, `${who}-${stamp}.json`), JSON.stringify({ who, rows, report }, null, 1));

const tally = {};
for (const r of report) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
console.log("\n" + JSON.stringify(tally));
for (const r of report.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.name.localeCompare(b.name))) {
  console.log(`\n[${r.verdict}] ${r.name} #${r.row}  (${r.trigger}${r.mode ? ", " + r.mode : ""}${r.gearLinked ? ", gear" : ""})`);
  console.log(`    ${r.note}`);
  if (r.gates.length) console.log(`    gates pinned: ${r.gates.join(", ")}`);
  if (r.containerEquipped === false) console.log(`    !! container is NOT EQUIPPED — containerReactionInPlay gates this out; equip it to probe`);
  if (r.pos?.fireReason) console.log(`    fireReason: ${r.pos.fireReason}`);
  if (r.pos?.writes?.length) console.log(`    writes: ${r.pos.writes.join(" ; ").slice(0, 160)}`);
}
