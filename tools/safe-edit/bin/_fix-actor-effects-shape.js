// Repair actor docs whose `effects` field holds full ActiveEffect OBJECTS.
//
// An actor's ActiveEffects live at their OWN keys — `!actors.effects!<actorId>.<aeId>`
// — exactly like embedded items (`!actors.items!`). The `effects` field on the
// actor doc is an array of id STRINGS, nothing more.
//
// _restore-gorger-scope.js got this wrong: it copied `effects` out of the
// authored EXPORT, where the exporter has already INFLATED each id into the full
// AE object, and wrote that array straight back onto 26 actor docs.
//
// Why nothing caught it: `world-export report` resolves AEs from the real
// `!actors.effects!` keys, which were untouched — so the regenerated export was
// byte-identical and the tripwire read "4 modified". A malformed field that the
// export does not read is invisible to the export. Verified against the live DB
// instead: getByKey showed objects where ids belong.
//
// Repair: rebuild each actor's `effects` from the AE keys that actually exist.
// Run from tools/safe-edit; --apply to write.
const { openCollection } = require("../lib/db");
const { run } = require("./_dragon-util");

run(async ({ changes }) => {
  const db = await openCollection("actors");
  const actors = new Map();
  const aeIdsByActor = new Map();
  try {
    for await (const [k, v] of db.iterator()) {
      if (k.startsWith("!actors.effects!")) {
        const actorId = k.slice("!actors.effects!".length).split(".")[0];
        if (!aeIdsByActor.has(actorId)) aeIdsByActor.set(actorId, []);
        aeIdsByActor.get(actorId).push(v._id);
      } else if (k.startsWith("!actors!")) {
        actors.set(v._id, v);
      }
    }
  } finally { await db.close(); }

  for (const [id, doc] of actors) {
    const eff = doc.effects;
    if (!Array.isArray(eff) || !eff.length) continue;
    const malformed = eff.some((e) => e && typeof e === "object");
    if (!malformed) continue;

    const real = aeIdsByActor.get(id) ?? [];
    const fixed = JSON.parse(JSON.stringify(doc));
    fixed.effects = real.slice();
    changes.push([
      `!actors!${id}`, fixed,
      `${doc.name} — effects [${eff.length} object(s)] -> [${real.length} id(s)]`,
    ]);
  }

  if (!changes.length) console.log("  no malformed actor.effects found");
}, "fix-actor-effects-shape");
