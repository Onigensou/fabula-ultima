// Monster renamed Crona -> Kurona (user, 2026-10-31). Name only, no mechanics.
//
// Encounter and Enemies rows are plain text resolved with game.actors.getName, so
// the rows have to change with the actor or the monster quietly stops spawning.
// The actor id, its items and its art do not change.
//
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const FROM = "Crona", TO = "Kurona";
const ACTOR = "vmYeN1WWIF5TSjjF", BAT_WINGS = "02FGeucT9aAnHdid";

// Every row holding the name, from a scan of the whole tables store.
const ROWS = [
  ["0LEghOv3aJyZVyVs", "EncTightenCrona1", "Crona"],
  ["DiwyiqNujJaPIH8M", "QrdvlwYfvj3rAAxj", "Crona"],
  ["E4U6ILZHRy7Bzf1m", "U1StL69O6Xoj72oo", "Crona"],
  ["EeGLxe4Px7LvkgIB", "5wt9JmtwAWiSLobv", "Crona"],
  ["FIzBIfsJT7YJZQCk", "mX2lNZOw1ZzaWGvA", "Crona"],
  ["HbOAjXR20aRMQvPJ", "vl15VttT8tpnAWA6", "Crona"],
  ["Oijx8ksubxq9pc1R", "EncTightenRow002", "Crona, Crona, Crona"],
  ["RTy0ojurW5wUNKMV", "hZ4638j4088mDqp6", "Crona"],
  ["WAfcUXEh5bJtrDIK", "a3D58JPvHEZGX2tu", "Crona"],
  ["eU0r6IDQABoFFTsf", "EmJn5aaMmQwZCmYO", "Crona"],
  ["hBupoi4SsKj1GmDM", "ccKBky045kgr71UV", "Crona"],
  ["sULKvLErNMF8JtUr", "k63QV4j2yXqLfUjf", "Crona, Obsidrax"],
  ["sULKvLErNMF8JtUr", "wSH3DNDf3hnPQoOX", "Crona, Crona, Crona"],
];

const clone = (o) => JSON.parse(JSON.stringify(o));
const swap = (s) => s.split(FROM).join(TO);
const need = async (collection, key) => {
  const v = await getByKey(collection, key);
  if (!v) throw new Error(`missing ${key}`);
  return v;
};

(async () => {
  await run(async ({ changes }) => {
    const key = `!actors!${ACTOR}`;
    const actor = clone(await need("actors", key));
    if (actor.name !== FROM || actor.prototypeToken?.name !== FROM) {
      throw new Error(`actor is "${actor.name}", token "${actor.prototypeToken?.name}"`);
    }
    actor.name = TO;
    actor.prototypeToken.name = TO;
    changes.push([key, actor, `actor + prototype token: ${FROM} -> ${TO}`]);

    const aeKey = `!actors.effects!${ACTOR}.${BAT_WINGS}`;
    const ae = clone(await need("actors", aeKey));
    if (!ae.description?.includes(FROM)) throw new Error(`Bat Wings text: ${ae.description}`);
    ae.description = swap(ae.description);
    changes.push([aeKey, ae, `Bat Wings: ${ae.description}`]);
  }, "rename Crona to Kurona: actor", "actors");

  await run(async ({ changes }) => {
    for (const [table, id, text] of ROWS) {
      const key = `!tables.results!${table}.${id}`;
      const row = clone(await need("tables", key));
      if (row.text !== text) throw new Error(`${key} is "${row.text}", expected "${text}"`);
      row.text = swap(row.text);
      changes.push([key, row, `${text} -> ${row.text}`]);
    }
  }, "rename Crona to Kurona: table rows", "tables");
})().catch((e) => { console.error(e); process.exit(1); });
