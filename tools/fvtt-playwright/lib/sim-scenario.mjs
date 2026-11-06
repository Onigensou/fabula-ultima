// sim-scenario — run a REAL hands-free Battle Director battle (the auto-playtest
// sim: real FSM, real reactions, real CheckRequester, real TARGET pin, real turn
// ticks) as a scripted scenario, observe it, and assert on what happened.
//
// Why: the isolated director harness (runDirectorSkill*/probe*) fakes the director,
// so everything that only exists in a real turn — standalone lifecycle triggers
// (turn_start / round_*), the Enraged turn tick, an enemy's autopilot honouring a
// Provoked pin, a committed apply_ae read by a later chain step — is structurally
// out of its reach. `sim.testSkill` reaches all of it, but a sim battle outlives
// the bridge's ~290 s per-call cap, so it has to be driven kick -> poll -> collect
// -> cleanup, with the lent documents remembered ON A GLOBAL (the kick call's scope
// is gone by cleanup). This file is that pattern, once.
//
// What it records (page-side, into globalThis.__simScn.events):
//   ae+ / ae-   every ActiveEffect create/delete (actor, name, applier, riderOf)
//   trg         selected director triggers via the `fu-director-trigger` hook —
//               for creature_performs_action: performer, action, TARGET NAMES,
//               actionPinKind (who a Provoked creature actually attacked)
//   act         every declared action with its FINAL targets (`fu-director-action`,
//               state-handlers CONFIRM) — performer, action, pin kind, target names
//   end         fu.battleEnd / fu-director-stopped (the teardown sweep follows)
//   res         current_hp / current_mp changes (updateActor)
// plus the sim's own result (outcome, rounds, transcript) when it finishes.
//
// A scenario = { name, setup, sim, assert, cleanup, triggers?, logFilter?, timeoutMin? }:
//   logFilter  regex source; matching console.log/warn lines become k:"log" events
//              (for effects with no document trace: accuracy bonuses, elements).
//   setup    page code (string). Runs BEFORE the battle; it may lend documents to
//            SOURCE actors (party casters are CLONED at battle start, so the clone
//            inherits them) and must record every created id in `S.lent`.
//   sim      args for FUCompanion.api.experimental.sim.testSkill (or `run` with
//            `simFn: "run"`).
//   assert   page code (string) with `S` in scope; returns [{ name, pass, detail }].
//   cleanup  page code (string) with `S` in scope; deletes exactly S.lent.
// The runner ALWAYS calls cleanup, even when the scenario throws or times out.
import { evalGM } from "../scripts/bridge.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(code, timeoutMs = 120000) {
  const r = await evalGM(code, timeoutMs);
  if (!r.ok) throw new Error(`page error: ${r.error}\n${(r.errorStack ?? "").slice(0, 600)}`);
  return r.result;
}

const RUNTIME = (name, triggers, logFilter) => `
if (globalThis.__simScn && !globalThis.__simScn.done) throw new Error("a sim scenario is already running: " + globalThis.__simScn.name);
if (FUCompanion.api.experimental?.sim == null) throw new Error("sim API missing");
const S = globalThis.__simScn = { name: ${JSON.stringify(name)}, events: [], lent: {}, done: false, t0: Date.now(), hooks: [] };
const NS = "fabula-ultima-companion";
const nm = (a) => a?.name ?? "?";
const nameOf = (u) => { try { const d = u ? fromUuidSync(u) : null; return d?.name ?? d?.actor?.name ?? null; } catch { return null; } };
const T = () => Date.now() - S.t0;
const WANT = new Set(${JSON.stringify(triggers)});
S.hooks.push(["createActiveEffect", Hooks.on("createActiveEffect", (e) => { try { S.events.push({ t: T(), k: "ae+", on: nm(e.parent), name: e.name,
  applier: nameOf(e.flags?.[NS]?.directorAppliedBy?.reactorActorUuid), rider: e.flags?.[NS]?.riderOf ?? null,
  changes: (e.changes ?? []).map((c) => c.key.split(".").pop() + "=" + c.value).join("|") }); } catch {} })]);
S.hooks.push(["deleteActiveEffect", Hooks.on("deleteActiveEffect", (e) => { try { S.events.push({ t: T(), k: "ae-", on: nm(e.parent), name: e.name }); } catch {} })]);
S.hooks.push(["updateActor", Hooks.on("updateActor", (a, ch) => { try { const p = ch?.system?.props ?? {};
  for (const key of ["current_hp", "current_mp", "current_ip"]) if (key in p) S.events.push({ t: T(), k: "res", on: a.name, key, value: p[key] }); } catch {} })]);
S.logRe = ${logFilter ? `new RegExp(${JSON.stringify(logFilter)}, "i")` : "null"};
if (S.logRe) { S.origLog = console.log; S.origWarn = console.warn;
  const wrap = (f, tag) => (...a) => { try { const t = a.map((x) => typeof x === "string" ? x : "").join(" "); if (S.logRe.test(t)) S.events.push({ t: T(), k: "log", tag, text: t.slice(0, 300) }); } catch {} return f.apply(console, a); };
  console.log = wrap(S.origLog, "L"); console.warn = wrap(S.origWarn, "W"); }
for (const h of ["fu.battleEnd", "fu-director-stopped"]) S.hooks.push([h, Hooks.on(h, () => { try { S.events.push({ t: T(), k: "end", hook: h }); } catch {} })]);
S.hooks.push(["fu-director-action", Hooks.on("fu-director-action", (a) => { try { S.events.push({ t: T(), k: "act", src: a.actorName ?? nameOf(a.actorUuid),
  action: a.actionName, kind: a.actionKind, pin: a.pinKind || null, element: a.element ?? null, targets: (a.targetNames ?? []).map((n, i) => n ?? nameOf(a.targetTokenUuids?.[i])) }); } catch {} })]);
S.hooks.push(["fu-director-trigger", Hooks.on("fu-director-trigger", ({ casterActor, trigger, payload }) => { try {
  if (!WANT.has(trigger)) return;
  const p = payload ?? {};
  S.events.push({ t: T(), k: "trg", trigger, reactor: nm(casterActor), src: nameOf(p.sourceActorUuid), subject: nameOf(p.subjectActorUuid),
    action: p.actionName ?? p.sourceSkillName ?? null, kind: p.actionKind ?? null, pin: p.actionPinKind ?? null,
    targets: (p.targetTokenUuids ?? p.targets ?? []).map((u) => nameOf(u)) }); } catch {} })]);
`;

const summarizeResult = `(r) => { try { return { outcome: r?.outcome ?? r?.verdict ?? null, rounds: r?.rounds ?? r?.finalRound ?? null,
  stalled: r?.stalled ?? null, error: r?.error ?? null, keys: Object.keys(r ?? {}),
  transcript: (r?.transcript ?? []).slice(-60).map((x) => (x.kind ?? "") + ": " + String(x.text ?? "").slice(0, 160)) }; } catch (e) { return { summarizeError: String(e) }; } }`;

export async function runSimScenario(sc, { log = console.log } = {}) {
  const triggers = sc.triggers ?? ["creature_performs_action", "turn_start", "creature_defeated"];
  const simFn = sc.simFn ?? "testSkill";
  const out = { name: sc.name, ok: false, assertions: [], events: null, result: null, error: null, cleanup: null };
  let kicked = false;
  try {
    // 1. kick: runtime + setup + fire-and-forget battle
    await page(`${RUNTIME(sc.name, triggers, sc.logFilter ?? null)}
const __setup = async () => { ${sc.setup ?? ""} };
await __setup();
const __args = ${JSON.stringify(sc.sim)};
S.simArgs = __args;
const __sum = ${summarizeResult};
FUCompanion.api.experimental.sim.${simFn}(__args)
  .then((r) => { S.result = __sum(r); S.done = true; })
  .catch((e) => { S.error = String(e?.stack ?? e); S.done = true; });
return { kicked: true, lent: S.lent };`);
    kicked = true;
    log(`[sim-scenario] ${sc.name}: kicked`);

    // 2. poll
    const deadline = Date.now() + (sc.timeoutMin ?? 12) * 60000;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(10000);
      last = await page(`const S = globalThis.__simScn; return { done: S?.done ?? null, n: S?.events?.length ?? 0, secs: Math.round((Date.now() - (S?.t0 ?? Date.now())) / 1000), error: S?.error ?? null };`, 30000);
      log(`[sim-scenario] ${sc.name}: ${last.secs}s, ${last.n} events${last.done ? " — DONE" : ""}`);
      if (last.done) break;
    }
    // A timeout is reported, NOT a reason to throw the evidence away: the events so
    // far are collected and asserted like a finished run (checks that never got the
    // chance simply fail or read NOT EXERCISED).
    if (!last?.done) out.timedOut = `timed out after ${sc.timeoutMin ?? 12} min (sim still running; partial evidence below)`;

    // 3. collect + assert
    const collected = await page(`const S = globalThis.__simScn;
const __assert = async () => { ${sc.assert ?? "return [];"} };
let assertions; try { assertions = await __assert(); } catch (e) { assertions = [{ name: "assert threw", pass: false, detail: String(e) }]; }
return { assertions, events: S.events, result: S.result ?? null, error: S.error ?? null };`, 60000);
    Object.assign(out, collected);
    out.ok = !out.timedOut && !collected.error && (collected.assertions ?? []).every((a) => a.pass);
  } catch (e) {
    out.error = String(e?.message ?? e);
  } finally {
    // 4. cleanup — always (also stops a still-running sim if we timed out)
    try {
      out.cleanup = await page(`const S = globalThis.__simScn;
if (!S) return { skipped: "no scenario state" };
const report = { stoppedSim: false };
if (!S.done) { try { await FUCompanion.api.experimental.sim.abort?.(); report.stoppedSim = true; } catch (e) { report.stopError = String(e); } }
for (const [h, id] of S.hooks ?? []) { try { Hooks.off(h, id); } catch {} }
if (S.origLog) { console.log = S.origLog; console.warn = S.origWarn; }
const __cleanup = async () => { ${sc.cleanup ?? ""} };
try { report.user = await __cleanup(); } catch (e) { report.userError = String(e); }
report.simLeftovers = game.actors.filter((a) => a.name.includes("[SIM]")).map((a) => a.name);
delete globalThis.__simScn;
return report;`, 120000);
    } catch (e) { out.cleanup = { error: String(e?.message ?? e), kicked }; }
  }
  return out;
}

export function printScenario(res) {
  const mark = (b) => (b ? "PASS" : "FAIL");
  console.log(`\n=== ${res.name}: ${res.ok ? "OK" : "NOT OK"}${res.timedOut ? " — " + res.timedOut : ""}${res.error ? " — " + res.error : ""}`);
  for (const a of res.assertions ?? []) console.log(`  ${String(a.detail ?? "").startsWith("NOT EXERCISED") ? "SKIP" : mark(a.pass)}  ${a.name}${a.detail != null ? "  — " + (typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail)) : ""}`);
  console.log(`  sim: ${JSON.stringify({ outcome: res.result?.outcome, rounds: res.result?.rounds, stalled: res.result?.stalled })}`);
  console.log(`  cleanup: ${JSON.stringify(res.cleanup)}`);
}
