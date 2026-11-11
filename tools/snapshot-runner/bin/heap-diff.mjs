// heap-diff — what grew between two V8 heap snapshots (run.mjs: window.__runnerHeapSnapshot).
//   node --max-old-space-size=14000 bin/heap-diff.mjs <before.heapsnapshot> <after.heapsnapshot> [--top 30]
// Groups live objects by (type, constructor/name) and prints the groups whose count or self size grew
// most, the detached-DOM total, and the most common NEW string prefixes (which usually name the owner).
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const ti = process.argv.indexOf("--top");
const TOP = ti > 0 ? Number(process.argv[ti + 1]) : 30;
if (!a || !b) { console.error("usage: heap-diff.mjs <before> <after> [--top N]"); process.exit(2); }

// Snapshots run past 1 GB, beyond a JS string's limit, so read the buffer: parse the small sections
// (meta, strings) as JSON and the huge `nodes` number array by hand; skip `edges`.
function load(file) {
  const buf = readFileSync(file);
  const at = (k) => buf.indexOf(Buffer.from(k));
  const pNodes = at('"nodes":['), pEdges = at('"edges":['), pStrings = at('"strings":[');
  const m = JSON.parse(buf.subarray(0, pNodes).toString().replace(/,\s*$/, "") + "}").snapshot.meta;
  const strs = JSON.parse(buf.subarray(pStrings + '"strings":'.length, buf.lastIndexOf(0x5d) + 1).toString());
  const F = m.node_fields, N = F.length;
  const iType = F.indexOf("type"), iName = F.indexOf("name"), iSize = F.indexOf("self_size"), iId = F.indexOf("id"), iDet = F.indexOf("detachedness");
  const types = m.node_types[0];
  const groups = new Map(), sIds = [], sNames = [], sSizes = [];   // string nodes only: a Map caps at 16M entries
  let detached = 0, detachedSize = 0;
  const row = new Array(N); let col = 0, num = 0, inNum = false;
  for (let i = pNodes + '"nodes":['.length; i < pEdges; i++) {
    const c = buf[i];
    if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); inNum = true; continue; }
    if (!inNum) continue;
    row[col++] = num; num = 0; inNum = false;
    if (col < N) continue;
    col = 0;
    const type = types[row[iType]];
    const isStr = type === "string" || type === "concatenated string" || type === "sliced string";
    let name = isStr ? "(string)" : strs[row[iName]];
    if (!isStr && (type === "code" || type === "hidden" || type === "array")) name = `(${type}) ${String(name).slice(0, 40)}`;
    const k = `${type} | ${String(name).slice(0, 80)}`;
    const g = groups.get(k) ?? { n: 0, size: 0 };
    g.n++; g.size += row[iSize];
    groups.set(k, g);
    if (iDet >= 0 && row[iDet] === 2) { detached++; detachedSize += row[iSize]; }
    if (isStr) { sIds.push(row[iId]); sNames.push(row[iName]); sSizes.push(row[iSize]); }
  }
  const order = Float64Array.from(sIds).sort();
  return { groups, sIds, sNames, sSizes, strs, order, detached, detachedSize, total: [...groups.values()].reduce((s, g) => s + g.size, 0) };
}

const A = load(a), B = load(b);
const rows = [];
for (const [k, g] of B.groups) {
  const p = A.groups.get(k) ?? { n: 0, size: 0 };
  rows.push({ k, dn: g.n - p.n, ds: g.size - p.size });
}
const mb = (x) => (x / 1048576).toFixed(2);
console.log(`total self size: ${mb(A.total)} MB -> ${mb(B.total)} MB (${mb(B.total - A.total)} MB)`);
console.log(`detached (DOM) objects: ${A.detached} -> ${B.detached} (${mb(B.detachedSize - A.detachedSize)} MB)`);
console.log("\nby size growth:");
for (const r of rows.sort((x, y) => y.ds - x.ds).slice(0, TOP)) console.log(`  ${mb(r.ds).padStart(8)} MB  ${String(r.dn).padStart(7)} objs  ${r.k}`);
console.log("\nby count growth:");
for (const r of rows.sort((x, y) => y.dn - x.dn).slice(0, Math.min(TOP, 15))) console.log(`  ${String(r.dn).padStart(7)} objs  ${mb(r.ds).padStart(8)} MB  ${r.k}`);
const hasA = (id) => { let lo = 0, hi = A.order.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, v = A.order[mid]; if (v === id) return true; if (v < id) lo = mid + 1; else hi = mid - 1; } return false; };
const pref = new Map();
for (let i = 0; i < B.sIds.length; i++) {
  if (hasA(B.sIds[i])) continue;
  const p = String(B.strs[B.sNames[i]]).slice(0, 60).replace(/\s+/g, " ");
  pref.set(p, (pref.get(p) ?? 0) + 1);
}
console.log("\nmost common NEW strings:");
for (const [p, n] of [...pref].sort((x, y) => y[1] - x[1]).slice(0, 15)) console.log(`  ${String(n).padStart(6)}x  ${JSON.stringify(p)}`);

// the biggest strings alive in the second snapshot, grouped by their first 70 characters
const big = new Map();
for (let i = 0; i < B.sSizes.length; i++) {
  if (B.sSizes[i] < 4096) continue;
  const p = String(B.strs[B.sNames[i]]).slice(0, 70).replace(/\s+/g, " ");
  const g = big.get(p) ?? { n: 0, size: 0 }; g.n++; g.size += B.sSizes[i]; big.set(p, g);
}
console.log("\nbig strings (>= 4 KB) in the second snapshot, by prefix:");
for (const [p, g] of [...big].sort((x, y) => y[1].size - x[1].size).slice(0, 15)) console.log(`  ${mb(g.size).padStart(8)} MB  ${String(g.n).padStart(6)}x  ${JSON.stringify(p)}`);
