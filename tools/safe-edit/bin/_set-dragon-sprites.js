// Point Mist Dragon + Drakoza at their real Forge art.
// "Update the image fields" means ALL EIGHT or the monster is half-dressed
// somewhere: the sidebar portrait, the canvas token, the CSB sheet, the two BD
// battle sprites and the three cut-ins. Run from tools/safe-edit; --apply to write.
const { openCollection, getByKey } = require("../lib/db");
const { snapshotCollection } = require("../lib/backup");
const journal = require("../lib/journal");

const APPLY = process.argv.includes("--apply");

// NOTE: Drakoza's asset really is spelled "Deakoza.png" on the Forge — verified
// 200/13608 bytes, while "Drakoza.png" 404s. Do not "correct" it.
const ART = {
  "8kluKkqkcGFkmXNO": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Mist%20Dragon.png",
  "H6Ubup6kmkgNQzLU": "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Deakoza.png",
};

const PROP_FIELDS = ["img", "sprite_standard", "sprite_battle",
                     "cut_in_critical", "cut_in_fumble", "cut_in_zero_power"];

(async () => {
  const changes = [];
  for (const [id, url] of Object.entries(ART)) {
    const a = await getByKey("actors", `!actors!${id}`);
    if (!a) throw new Error(`actor ${id} not found`);
    const next = JSON.parse(JSON.stringify(a));

    next.img = url;
    next.prototypeToken = next.prototypeToken ?? {};
    next.prototypeToken.texture = next.prototypeToken.texture ?? {};
    next.prototypeToken.texture.src = url;
    for (const f of PROP_FIELDS) next.system.props[f] = url;

    // Assert every one of the eight actually carries the new URL. Scope the
    // placeholder/donor check to the ART fields only: `system.body.contents`
    // carries the CSB sheet LAYOUT, whose image widget has its own
    // `defaultValue: "icons/svg/mystery-man.svg"`. That is template furniture
    // present on every actor in the world (Ampere, Skizzik, Obsidrax all carry
    // it), not this monster's portrait — a whole-doc scan false-positives on it.
    const eight = [next.img, next.prototypeToken.texture.src, ...PROP_FIELDS.map((f) => next.system.props[f])];
    if (eight.some((v) => v !== url)) throw new Error(`${a.name}: not all 8 image fields set`);
    for (const v of eight) {
      if (/mystery-man|Ampyr_Standard|_Standard\.png/.test(v)) {
        throw new Error(`${a.name}: placeholder or donor art survives in an image field: ${v}`);
      }
    }

    changes.push([`!actors!${id}`, next, `${a.name}: all 8 image fields -> ${url.split("/").pop()}`]);
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${changes.length} writes\n`);
  for (const [k, , note] of changes) console.log(`  ${k}\n    ${note}`);
  if (!APPLY) { console.log("\n(dry run — pass --apply to write)"); return; }

  const backupPath = snapshotCollection("actors");
  console.log(`\nbackup: ${backupPath}`);
  const db = await openCollection("actors");
  try { for (const [k, v] of changes) await db.put(k, v); }
  finally { await db.close(); }
  journal.append({
    uuid: "collection:actors", collection: "actors", key: changes.map((c) => c[0]).join(","),
    beforeHash: null, afterHash: null, backupPath, patch: null,
    note: `valley dragons sprites: ${changes.map((c) => c[2]).join("; ")}`,
  });
  console.log(`\nwrote ${changes.length} docs`);
})();
