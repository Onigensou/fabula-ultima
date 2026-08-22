// The LIVE row roster, derived from world data — not from any result file.
//
// Why this exists: rank-merging result files makes the corpus grow-only. A row
// that is DELETED from a skill keeps its old verdict forever, because no later
// run can contradict a row it no longer enumerates. Measured 2026-08-23:
// `Zarg / High Speed #0` and `#99` are CSB tombstones (`$deleted: true`) that
// the prober correctly stopped enumerating — yet both sat in the scorecard as
// NOT_SCANNED, inflating the denominator 95 → 97 and reading as two unverified
// rows that no longer exist.
//
// The authority is the WORLD, which the prober re-reads every run. Deriving the
// roster here reproduces the prober's enumeration exactly (95/95, zero drift in
// either direction), and cannot go stale the way a result file does.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT = resolve(HERE, "../../worlds/fabula-ultima-2/_authored-export/actors");

export const ACTORS = {
  Hina: "dafTLBUscCDNgq8H", Keren: "gdJZ1L1kv5mjTTMr",
  Blanche: "uJFaNQCSvwwsr2AW", Zarg: "Z4CFy505cD3nzl1W",
};

// 🪤 A CSB tombstone comes in TWO shapes: the string "$deleted" AND an object
// carrying a truthy $deleted property. Mirrors verify.mjs:62 — keep them in step.
const isTombstone = (r) => !r || r === "$deleted" || r.$deleted;

// Set of `<Who>|<Skill>#<row>` keys that exist in the world right now.
export function liveRows() {
  const live = new Set();
  for (const [who, id] of Object.entries(ACTORS)) {
    let a;
    try { a = JSON.parse(readFileSync(resolve(EXPORT, `${id}.json`), "utf8")); }
    catch { continue; }                       // export missing → cannot gate; caller decides
    for (const it of a.items ?? []) {
      const rct = it.system?.props?.reaction_config_table;
      if (!rct || typeof rct !== "object") continue;
      for (const [k, r] of Object.entries(rct)) {
        if (isTombstone(r)) continue;
        live.add(`${who}|${it.name}#${k}`);
      }
    }
  }
  return live;
}
