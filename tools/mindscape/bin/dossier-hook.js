#!/usr/bin/env node
"use strict";
//
// Mindscape — Claude Code UserPromptSubmit hook: when a prompt names a monster, inject its
// design record (dossiers/<name>.md) into Claude's context, so recall never depends on
// remembering to run `node bin/dossier.js <name>`.
//
// Configured in C:\Users\Oni\AppData\Local\FoundryVTT\.claude\settings.json. Reads only the
// dossier files (no world load) so it costs milliseconds. Any failure prints nothing and
// exits 0 — a broken hook must never block a prompt.
//
// Matching: the monster's name (⭐️ stripped) and its optional `aliases`, on word
// boundaries, case-insensitive; phrases in `match_exclude` (e.g. "Fafnir Castle") are
// removed from the prompt before that dossier is matched.
//
//   echo '{"prompt":"tune gigas"}' | node bin/dossier-hook.js     # try it

const DS = require("../lib/dossier");

const MAX_FULL = 4;           // monsters given a full record; the rest are named only
const s = (v) => String(v ?? "").trim();
const plain = (x) => s(x).replace(/\*\*|`/g, "").replace(/\s+/g, " ");
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clip = (x, n) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

function matches(prompt, d) {
  let text = prompt;
  for (const ex of d.data.match_exclude ?? []) text = text.replace(new RegExp(esc(ex), "gi"), " ");
  const names = [d.data.monster.replace(/^⭐️?\s*/u, ""), ...(d.data.aliases ?? [])].map(s).filter(Boolean);
  return names.some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

function record(d) {
  const x = d.data;
  const o = [`## ${x.monster} — design record (${x.status}${x.updated ? `, ${x.updated}` : ""})`];
  if (x.role) o.push(`Role: ${plain(x.role)}`);
  const concept = plain((d.sections.Concept ?? "").split(/\r?\n\s*\r?\n/)[0]);
  if (concept) o.push(`Concept: ${clip(concept, 320)}`);
  for (const e of x.exceptions) {
    o.push(`Intended (${e.decided_by === "user" ? "designer's call" : "unconfirmed"}): ${e.rule}${e.action ? ` on ${e.action}` : ""} — ${plain(e.why)}`);
  }
  if (x.invariants.length) o.push(`Invariants the gimmick depends on: ${x.invariants.map((i) => i.id).join(", ")}`);
  for (const b of x.blind_spots.slice(0, 3)) o.push(`Blind spot: ${clip(plain(b), 220)}`);
  for (const q of x.open_questions) o.push(`Open: ${clip(plain(q), 260)}`);
  return o.join("\n");
}

function main(raw) {
  const prompt = s(JSON.parse(raw || "{}").prompt);
  if (!prompt) return;
  const hits = DS.loadDossiers().filter((d) => matches(prompt, d));
  if (!hits.length) return;
  const full = hits.slice(0, MAX_FULL);
  const rest = hits.slice(MAX_FULL).map((d) => d.data.monster);
  const ctx = [
    "Monster design records (tools/mindscape/dossiers) for monsters named in this prompt.",
    "Before any balance verdict or change: quote the intent back, treat 'Intended' findings as deliberate, and run `node bin/dossier.js <name>` (in Data/tools/mindscape) for the live sheet and drift. Stats: the world sheet wins over any number here.",
    "",
    ...full.map(record).join("\n\n").split("\n"),
    ...(rest.length ? ["", `Also named (records not shown): ${rest.join(", ")} — run their briefs.`] : []),
  ].join("\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } }));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => { try { main(buf); } catch { /* never block a prompt */ } });
