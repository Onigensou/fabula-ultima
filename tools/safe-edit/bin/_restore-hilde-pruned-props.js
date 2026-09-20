// REPAIR — restore the `system.props` keys that `Actor#reloadTemplate()` pruned
// off Hilde-Fafnir. Run from tools/safe-edit; --apply to write.
//
// Cause: a live probe called `hilde.reloadTemplate()` to prove the new AI
// dropdown values survive a CSB re-stamp. They did — but reloadTemplate also
// PRUNES every `system.props` key the template does not declare, which is the
// documented trap in tools/safe-edit/WORLD-EXPORT.md (it once deleted 112 keys
// across 10 docs on a co-dev merge). It took 60 keys off this actor: defence,
// magic_defense, the attribute currents, ultima_points, enmity, id/img/uuid and
// the whole extra_damage_mod_* / damage_receiving_mod_* / check_mod_* family.
//
// `world-export report` does NOT catch this — it counts documents and embedded
// docs, not properties. The only reason it surfaced was a key-level diff of the
// export against HEAD.
//
// Source of truth = the committed export at HEAD, which predates the prune.
// Restores ONLY keys that are missing or blank now and were populated there;
// never overwrites a value this session deliberately changed.
const { execSync } = require("child_process");
const { getByKey } = require("../lib/db");
const { IDS } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const A = IDS.HF;
const EXPORT_PATH = `worlds/fabula-ultima-2/_authored-export/actors/${A}.json`;

run(async ({ changes }) => {
  const head = JSON.parse(execSync(`git show HEAD:${EXPORT_PATH}`, {
    cwd: "../..", maxBuffer: 1e9, encoding: "utf8",
  }));
  const headProps = head?.system?.props ?? {};
  const actor = await getByKey("actors", `!actors!${A}`);
  if (!actor) throw new Error("Hilde-Fafnir actor not found");
  const props = actor.system.props;

  const blank = (v) => v === undefined || v === null || v === "";
  const restored = [];
  for (const [k, v] of Object.entries(headProps)) {
    if (blank(v)) continue;
    if (!blank(props[k])) continue;          // present now → leave this session's value alone
    props[k] = v;
    restored.push(k);
  }

  if (!restored.length) { console.log("\nnothing to restore — props already intact"); return; }
  console.log(`\nrestoring ${restored.length} pruned prop(s):`);
  for (const k of restored) console.log(`   ${k} = ${JSON.stringify(headProps[k]).slice(0, 48)}`);
  changes.push([`!actors!${A}`, actor, `restore ${restored.length} props pruned by reloadTemplate`]);
}, "hilde-fafnir: restore reloadTemplate-pruned props", "actors");
