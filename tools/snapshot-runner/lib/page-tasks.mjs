// page-tasks — what run.mjs (one boot per run) and warm.mjs (one page, many runs) both do
// to a booted runner page: warp its timers, run the skill-regression collector in it, and
// compare fingerprints with a reference.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../../..");

// Key-order-blind JSON: skill-regression goldens are written key-sorted, the collector's live result is not.
const stable = (v) => Array.isArray(v) ? v.map(stable) : (v && typeof v === "object") ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
export const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/**
 * Run the page's timers F times faster (setTimeout / setInterval delays divided by F);
 * `clocks` also speeds performance.now / Date.now up. The real ones stay on __timeWarp.real.
 */
export async function applyTimeWarp(page, F, clocks = false) {
  return page.evaluate(({ F, clocks }) => {
    if (!(F > 0)) throw new Error(`--time-warp must be a positive number, got ${F}`);
    const W = (globalThis.__timeWarp ??= { real: { st: globalThis.setTimeout, si: globalThis.setInterval, pn: performance.now.bind(performance), dn: Date.now } });
    W.F = F; W.clocks = clocks;
    const scale = (ms) => Math.max(0, (Number(ms) || 0) / W.F);
    globalThis.setTimeout = function (fn, ms, ...a) { return W.real.st.call(globalThis, fn, scale(ms), ...a); };
    globalThis.setInterval = function (fn, ms, ...a) { return W.real.si.call(globalThis, fn, Math.max(1, scale(ms)), ...a); };
    if (clocks) {
      const p0 = W.real.pn(), d0 = W.real.dn();
      performance.now = () => p0 + (W.real.pn() - p0) * W.F;
      Date.now = () => d0 + (W.real.dn() - d0) * W.F;
    }
    return { factor: F, clocks };
  }, { F, clocks });
}

/** skill-regression's skip list for a mode (RESOLVE-only human gates are skipped in simulate only). */
export function skipList(mode) {
  const skipFile = resolve(DATA, "tools/skill-regression/skip.json");
  const sj = existsSync(skipFile) ? JSON.parse(readFileSync(skipFile, "utf8")) : {};
  return [...(sj.skip ?? []), ...(mode === "simulate" ? sj.skipSimulate ?? [] : [])];
}

/** Run skill-regression's collector (lib/collect.js) in the page with these OPTS. */
export async function runCollector(page, opts) {
  const collectSrc = readFileSync(resolve(DATA, "tools/skill-regression/lib/collect.js"), "utf8");
  return page.evaluate(`(async () => { const OPTS = ${JSON.stringify(opts)};\n${collectSrc}\n})()`);
}

/** Build the Regression Bench in the page (skill-regression's own lib/build-bench.js). */
export async function buildBench(page, bopts) {
  const benchSrc = readFileSync(resolve(DATA, "tools/skill-regression/lib/build-bench.js"), "utf8");
  const b = await page.evaluate(`(async () => { const OPTS = ${JSON.stringify(bopts)};\n${benchSrc}\n})()`);
  return b?.ok ? { ok: true, scene: b.scene, created: b.created?.length, actors: b.backboneActors, skills: b.skillTotal, fullRoster: !!b.fullRoster } : { ok: false, error: b?.error ?? "bench build failed" };
}

/** Fingerprint diff: { summary counts, diffs[] }. `only` restricts the reference to these keys. */
export function compareFingerprints(ref, mine, { only = null } = {}) {
  const refSkills = only ? Object.fromEntries(Object.entries(ref.skills).filter(([k]) => only.has(k))) : ref.skills;
  const keys = new Set([...Object.keys(refSkills), ...Object.keys(mine.skills ?? {})]);
  const diffs = []; let nSame = 0;
  for (const k of [...keys].sort()) {
    const a = refSkills[k], b = mine.skills?.[k];
    if (!a || !b) { diffs.push({ key: k, only: a ? "reference" : "this run" }); continue; }
    if (same(a, b)) { nSame++; continue; }
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => !same(a[f], b[f]));
    diffs.push({ key: k, fields, reference: Object.fromEntries(fields.map((f) => [f, a[f]])), thisRun: Object.fromEntries(fields.map((f) => [f, b[f]])) });
  }
  // which part of the fingerprint moved: COMPUTE's fields (roll, perTarget …) or RESOLVE's (writes, cardHtml)
  const byField = {}; for (const d of diffs) for (const f of d.fields ?? [`only in ${d.only}`]) byField[f] = (byField[f] ?? 0) + 1;
  return { total: keys.size, identical: nSame, different: diffs.length, byField, diffs };
}
