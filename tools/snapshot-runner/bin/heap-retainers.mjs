// heap-retainers — who keeps a set of strings alive (heap snapshot from run.mjs __runnerHeapSnapshot).
//   node --max-old-space-size=14000 bin/heap-retainers.mjs <file.heapsnapshot> "<string prefix>" [--depth 6]
// Finds string nodes whose text starts with the prefix, then walks retainers (edges pointing at them)
// up to --depth levels, printing each level grouped by (node type, name, edge name).
import { readFileSync } from "node:fs";

const [file, prefix] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const di = process.argv.indexOf("--depth");
const DEPTH = di > 0 ? Number(process.argv[di + 1]) : 6;
if (!file || !prefix) { console.error('usage: heap-retainers.mjs <file> "<prefix>" [--depth N]'); process.exit(2); }

const buf = readFileSync(file);
const at = (k) => buf.indexOf(Buffer.from(k));
const pNodes = at('"nodes":['), pEdges = at('"edges":['), pStrings = at('"strings":['), pTfi = at('"trace_function_infos":');
const m = JSON.parse(buf.subarray(0, pNodes).toString().replace(/,\s*$/, "") + "}").snapshot.meta;
const strs = JSON.parse(buf.subarray(pStrings + '"strings":'.length, buf.lastIndexOf(0x5d) + 1).toString());
const NF = m.node_fields, N = NF.length, EF = m.edge_fields, E = EF.length;
const nodeTypes = m.node_types[0], edgeTypes = m.edge_types[0];
const nodeCount = m.node_count ?? 0;

function* numbers(from, to) {
  let num = 0, inNum = false;
  for (let i = from; i < to; i++) {
    const c = buf[i];
    if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); inNum = true; continue; }
    if (inNum) { yield num; num = 0; inNum = false; }
  }
  if (inNum) yield num;
}

// nodes -> typed arrays
const cap = nodeCount || 40_000_000;
const nType = new Uint8Array(cap), nName = new Uint32Array(cap), nEdges = new Uint32Array(cap), nSize = new Uint32Array(cap);
const iT = NF.indexOf("type"), iN = NF.indexOf("name"), iE = NF.indexOf("edge_count"), iS = NF.indexOf("self_size");
let n = 0, f = 0;
for (const v of numbers(pNodes + '"nodes":['.length, pEdges)) {
  if (f === iT) nType[n] = v; else if (f === iN) nName[n] = v; else if (f === iE) nEdges[n] = v; else if (f === iS) nSize[n] = v;
  if (++f === N) { f = 0; n++; }
}
console.log(`${n} nodes`);
const targets = new Set();
for (let i = 0; i < n; i++) {
  const t = nodeTypes[nType[i]];
  if ((t === "string" || t === "concatenated string" || t === "sliced string") && String(strs[nName[i]]).startsWith(prefix)) targets.add(i);
}
let totalSize = 0; for (const i of targets) totalSize += nSize[i];
console.log(`${targets.size} target strings, ${(totalSize / 1048576).toFixed(2)} MB`);

const eT = EF.indexOf("type"), eN = EF.indexOf("name_or_index"), eTo = EF.indexOf("to_node");
const label = (i) => `${nodeTypes[nType[i]]} ${String(strs[nName[i]]).slice(0, 60)}`;
let level = targets;
const seen = new Set(targets);
for (let d = 1; d <= DEPTH && level.size; d++) {
  const next = new Set(), groups = new Map();
  let from = 0, left = nEdges[0], k = 0;
  const row = new Array(E);
  for (const v of numbers(pEdges + '"edges":['.length, pTfi > 0 ? pTfi : pStrings)) {
    row[k++] = v;
    if (k < E) continue;
    k = 0;
    while (left === 0 && from < n - 1) left = nEdges[++from];
    left--;
    const to = row[eTo] / N;
    if (!level.has(to)) continue;
    const et = edgeTypes[row[eT]];
    if (et === "weak") continue;
    const ename = et === "element" || et === "hidden" ? `[${row[eN]}]` : String(strs[row[eN]]).slice(0, 40);
    const g = `${label(from)}  --${et}:${ename}-->`;
    groups.set(g, (groups.get(g) ?? 0) + 1);
    if (!seen.has(from)) { seen.add(from); next.add(from); }
  }
  console.log(`\nlevel ${d} (${next.size} new retainers):`);
  for (const [g, c] of [...groups].sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`  ${String(c).padStart(6)}x  ${g}`);
  level = next;
}
