// Regression test for world-import's reloadCSB — the prop-preservation guard.
//
// Why this exists: CSB's reloadTemplate() PRUNES every system.props key the
// template does not declare. world-import calls it on every doc it touches, so
// the tool whose entire purpose is non-destructive merging once deleted 112
// keys across 10 docs on a co-dev merge — 3 of them real authored content
// (action_keywords on Asura / Electro Slime / Qilin). world-export reports
// "✓ No removals" straight through it, because it counts DOCUMENTS, not props.
//
// No game required: reloadCSB is extracted from the bridge payload and run
// against fakes that simulate CSB's prune. Run: node <this file>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_FILE = resolve(HERE, "../bin/world-import.js");
const raw = readFileSync(SRC_FILE, "utf8");
const m = raw.match(/const reloadCSB = async [\s\S]*?\n\};/);
if (!m) { console.error("could not extract reloadCSB from " + SRC_FILE); process.exit(2); }
// undo the template-literal escaping — this is the code the bridge actually runs
// Build the unescape patterns from char codes: a regex literal containing a
// backtick or a backslash is too easy to mangle when this file is generated.
const BT = String.fromCharCode(96), BS = String.fromCharCode(92);
const SRC = m[0].split(BS + BT).join(BT).split(BS + "$").join("$")
  .replace(/^const reloadCSB = /, "").replace(/;\s*$/, "");

function makeCtx({ apply, declared, sourceProps }) {
  const plan = { propsRestored: 0, propsRestoredDetail: [], errors: [] };
  const props = () => Object.fromEntries(declared.map((k) => [k, ""]));
  const tmpl = { templateSystem: { getAllProperties: async () => props() } };
  const game = { items: { get: () => tmpl }, actors: { get: () => null } };
  const doc = {
    name: "Asura",
    _source: { system: { props: { ...sourceProps }, template: "TMPL" } },
    templateSystem: {
      getAllProperties: async () => props(),
      // CSB behaviour: every undeclared key is dropped from storage
      reloadTemplate: async () => {
        for (const k of Object.keys(doc._source.system.props)) {
          if (!declared.includes(k)) delete doc._source.system.props[k];
        }
      },
    },
    update: async ({ system }) => { Object.assign(doc._source.system.props, system.props); },
  };
  const fn = new Function("apply", "plan", "game", `return (${SRC})`)(apply, plan, game);
  return { fn, plan, doc };
}

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

// Every call site is now ungated, so the plan must SEE the prune before it happens.
{
  const { fn, plan, doc } = makeCtx({ apply: false, declared: ["hp"], sourceProps: { hp: 1, action_keywords: "overflow" } });
  await fn(doc, { hp: 2, availability_formula: "x" }, "TMPL");
  ok("dry-run counts undeclared props (live + JSON)", plan.propsRestored === 2, JSON.stringify(plan.propsRestoredDetail));
  ok("dry-run writes nothing", doc._source.system.props.action_keywords === "overflow");
}
{
  const { fn, plan } = makeCtx({ apply: false, declared: ["hp"], sourceProps: {} });
  await fn(null, { hp: 1, action_keywords: "blitz" }, "TMPL");
  ok("dry-run predicts for a not-yet-created doc", plan.propsRestored === 1, JSON.stringify(plan.propsRestoredDetail));
}
{
  const { fn, plan, doc } = makeCtx({ apply: true, declared: ["hp"], sourceProps: { hp: 1 } });
  await fn(doc, { hp: 1, action_keywords: "pierce, overflow" }, "TMPL");
  ok("apply restores JSON prop pruned by reload", doc._source.system.props.action_keywords === "pierce, overflow");
  ok("apply counts it", plan.propsRestored === 1);
}
// The "never DELETES" contract: absent from the JSON is NOT permission to drop it.
{
  const { fn, doc } = makeCtx({ apply: true, declared: ["hp"], sourceProps: { hp: 1, reaction_effect_table: "LIVE" } });
  await fn(doc, { hp: 1 }, "TMPL");
  ok("apply restores live prop absent from JSON", doc._source.system.props.reaction_effect_table === "LIVE");
}
{
  const { fn, doc } = makeCtx({ apply: true, declared: ["hp"], sourceProps: { hp: 1, k: "old" } });
  await fn(doc, { hp: 1, k: "new" }, "TMPL");
  ok("JSON value wins over live on conflict", doc._source.system.props.k === "new");
}
{
  const { fn, plan, doc } = makeCtx({ apply: true, declared: ["hp", "mp"], sourceProps: { hp: 1, mp: 2 } });
  await fn(doc, { hp: 9, mp: 8 }, "TMPL");
  ok("declared props are never flagged at-risk", plan.propsRestored === 0);
}

// Guard the call sites too: the dry-run branch is dead code if any site is apply-gated.
{
  const gated = /if \(apply\) await reloadCSB\(/.test(raw);
  ok("no reloadCSB call site is apply-gated", !gated,
     gated ? "found `if (apply) await reloadCSB(` — dry-run would report 0 again" : "");
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall reloadCSB assertions passed");
process.exit(fails ? 1 : 0);
