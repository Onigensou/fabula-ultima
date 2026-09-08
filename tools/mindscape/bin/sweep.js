#!/usr/bin/env node
"use strict";
//
// Mindscape — spec dial sweep.
//
// Runs one enemy spec repeatedly with a `mindscape_*` dial overridden, so the
// question "what value lands this fight in the target band" is answered by
// measurement instead of by argument. Writes nothing; prints a table.
//
//   node bin/sweep.js --enemy-file specs/rakshasa.json \
//     --dial mindscape_read_curve --on "Adaptive Defense" \
//     --values "25,40,60,80|40,60,80,100|50,70,90,100" --runs 400
//
// The dial is applied to the ITEM named by --on, which is how the tuning
// reaches the reaction registry (reactions.applyTuning).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

function parseArgs(argv) {
  const out = { runs: 400, seed: "sweep", expected: 12 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--enemy-file" || a === "-f") out.file = next();
    else if (a === "--dial") out.dial = next();
    else if (a === "--on") out.on = next();
    else if (a === "--values") out.values = next().split("|");
    else if (a === "--runs" || a === "-n") out.runs = Number(next());
    else if (a === "--seed") out.seed = next();
    else if (a === "--expected") out.expected = Number(next());
    else if (a === "--extra") (out.extra = out.extra ?? []).push(next());
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.file || !args.dial || !args.on || !args.values?.length) {
  console.error("usage: sweep.js -f <spec> --dial <prop> --on <item name> --values \"a|b|c\" [-n runs] [--extra k=v]");
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(args.file, "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mindscape-sweep-"));
const cli = path.join(__dirname, "mindscape.js");

console.log(`\nSweeping ${args.dial} on "${args.on}"  ·  ${args.runs} runs each\n`);
console.log("value".padEnd(22) + "rounds".padEnd(9) + "partyHP".padEnd(10) + "DPR".padEnd(8) + "outcome");
console.log("─".repeat(72));

for (const v of args.values) {
  const doc = JSON.parse(JSON.stringify(base));
  // --on "actor" targets the actor sheet itself (max_hp, defense, ...), which is
  // the most common dial of all and used to require hand-editing the spec.
  const item = args.on === "actor" ? { props: doc.system.props } : (doc.items ?? []).find((i) => i.name === args.on);
  if (!item) { console.error(`no item named "${args.on}" in the spec`); process.exit(1); }
  item.props[args.dial] = v;
  for (const kv of args.extra ?? []) {
    const [k, ...rest] = kv.split("=");
    const val = rest.join("=");
    // `Item:key=value` targets another item; bare `key=value` targets --on.
    if (k.includes(":")) {
      const [iname, ikey] = k.split(":");
      const t = doc.items.find((i) => i.name === iname);
      if (t) t.props[ikey] = val;
    } else item.props[k] = val;
  }

  const file = path.join(tmp, `spec-${Buffer.from(v).toString("hex").slice(0, 12)}.json`);
  fs.writeFileSync(file, JSON.stringify(doc));

  let out = "";
  try {
    out = execFileSync(process.execPath,
      [cli, "--enemy-file", file, "--runs", String(args.runs), "--seed", `${args.seed}:${v}`,
       "--force", "--expected", String(args.expected)],
      { encoding: "utf8" });
  } catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }

  const rounds = /rounds\s+min \d+\s+p25 \S+\s+median (\S+)/.exec(out)?.[1] ?? "?";
  const hp = /party HP\s+p25 \S+\s+median (\S+)/.exec(out)?.[1] ?? "?";
  const dpr = /BaselineDPR\s+(\S+)/.exec(out)?.[1] ?? "?";
  const win = /victory\s+(\S+)/.exec(out)?.[1] ?? "0%";
  const over = /overtime\s+(\S+)/.exec(out)?.[1] ?? "0%";
  const def = /defeat\s+(\S+)/.exec(out)?.[1] ?? "0%";
  const outcome = `win ${win} · over ${over} · loss ${def}`;

  console.log(String(v).padEnd(22) + String(rounds).padEnd(9) + String(hp).padEnd(10) + String(dpr).padEnd(8) + outcome);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log();
