// nox-batch — Sealed Cavern balance fights on a WARM runner (checks/nox-fight.js per fight).
//
//   # once: snapshot + daemon (GPU: software GL takes minutes per round on the Valley map)
//   node ../snapshot-runner/bin/build-snapshot.mjs --profile nox --snapshot snap-nox
//   RUNNER_CODE=<branch> FVTT_GPU=true node ../snapshot-runner/bin/warm.mjs start --snapshot snap-nox --port 30111 --fast
//   # then, as often as you like (from tools/fvtt-playwright):
//   node ../snapshot-runner/bin/nox-batch.mjs --port 30111 --runs 2 [--rows 2,6,9] [--tag X] [--out <dir>]
//
// Rows are the 13 Sealed Cavern groups (1-based). Every fight starts from the warm baseline (the runner
// resets the world before each test). Prints one line per fight and a per-row summary; JSON per fight in --out.
// PC HP = Hina/Zarg/Keren/Blanche current over base max (guest Kalina's HP left out on purpose).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
export const ROWS = [
  "Nox Ghoul, Nox Ghoul, Nox Hound, Nox Hound",
  "Nox Hound, Nox Viper, Nox Hound",
  "Nox Ghoul, Nox Wraith, Nox Ghoul",
  "Nox Ghoul, Nox Viper, Nox Ghoul",
  "Nox Hound, Nox Wraith, Nox Ghoul",
  "Nox Hound, Nox Priest, Nox Hound",
  "Nox Ghoul, Nox Priest, Nox Hound",
  "Nox Hound, Nox Executioner, Nox Hound",
  "Nox Ghoul, Nox Executioner, Nox Ghoul",
  "Obsidrax, Nox Viper, Obsidrax",
  "Nox Hound, Kurona, Kurona, Nox Hound",
  "Nox Ghoul, Roo, Nox Ghoul",
  "Carlbero",
];
const port = val("--port", "30111");
const runs = Number(val("--runs", "2"));
const rows = (val("--rows") ?? ROWS.map((_, i) => i + 1).join(",")).split(",").map(Number);
const tag = val("--tag", "run");
const out = resolve(val("--out", join(TOOL, "results", "nox")));
const timeoutS = Number(val("--timeout", "240"));
mkdirSync(out, { recursive: true });
const check = readFileSync(join(TOOL, "checks", "nox-fight.js"), "utf8");
const tmp = join(os.tmpdir(), `nox-batch-${port}.js`);
const summary = {};
const t0 = Date.now();
for (const row of rows) {
  for (let k = 1; k <= runs; k++) {
    const file = join(out, `${tag}-r${String(row).padStart(2, "0")}-${k}.json`);
    if (existsSync(file)) { console.log("skip", file); continue; }
    writeFileSync(tmp, `globalThis.__NOX_OPTS = ${JSON.stringify({ group: ROWS[row - 1], seed: null, timeoutS })};\n${check}`);
    const t = Date.now();
    let line;
    try {
      execFileSync(process.execPath, [join(HERE, "warm.mjs"), "eval", tmp, "--port", port, "--dump", file], { stdio: ["ignore", "ignore", "pipe"], timeout: (timeoutS + 120) * 1000 });
      const j = JSON.parse(readFileSync(file, "utf8"));
      (summary[row] ??= []).push(j);
      line = j.hung ? `HUNG in ${j.hung.state} (round ${j.hung.round})` : `${j.outcome} r${j.rounds} pcHp ${Math.round((j.pcHp ?? 0) * 100)}% down ${j.pcsDown}`;
    } catch (e) { line = `FAILED ${String(e.stderr ?? e.message).slice(0, 200)}`; }
    console.log(`${tag} row ${row} #${k}: ${line} (${Math.round((Date.now() - t) / 1000)} s)`);
  }
}
console.log(`\n${tag}: ${rows.length} rows x ${runs} in ${Math.round((Date.now() - t0) / 60000)} min`);
for (const row of rows) {
  const xs = (summary[row] ?? []).filter((j) => !j.hung && j.outcome);
  if (!xs.length) continue;
  const avg = (f) => xs.reduce((s, j) => s + f(j), 0) / xs.length;
  console.log(`row ${String(row).padStart(2)}  ${ROWS[row - 1].padEnd(42)}  rounds ${avg((j) => j.rounds).toFixed(1)}  pcHp ${Math.round(avg((j) => j.pcHp ?? 0) * 100)}%  wins ${xs.filter((j) => j.outcome === "victory").length}/${xs.length}`);
}
