// Galvanic Paryashera: the two drills as one-roll Chain 6 (user, 2026-10-31). Purely
// visual: one Accuracy Check and one damage, shown as six ticks across the grind.
// Also refreshes their shot, which now cues each tick with oni.hit().
// Galvanic Drill also has Overflow (user, 2026-10-31): all enemies, one check.
//
// Idempotent. Run from tools/safe-edit; --apply to write.
const fs = require("fs");
const path = require("path");
const { getByKey } = require("../lib/db");
const { L, bullets, link } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");
const { encode } = require("../../anim-studio/lib/encode");

const A = "ym6As1q7yG1EMl9M", SPIRAL = "GpSpiralDrillI01", GALV = "F7gHvYczFw1y0OYj";
const OVERFLOW = link("JournalEntry.NUaxIAIPUu5Qnk8l", "Overflow");
const CHAIN = `${link("JournalEntry.ChnStrikeKeyw0rd", "Chain")}<strong>&nbsp;6</strong>`;
const HIDDEN = link("JournalEntry.DMaL1B3Z5Y5AUrvC", "Hidden");
const DESC = {
  [SPIRAL]: bullets(L.pierce, CHAIN) + `<p>Burst out of the steam with a spinning drill. Deal <strong>heavy</strong> ${L.physical}&nbsp;damage to one creature. Used only while ${HIDDEN}, and ends it.</p>`,
  [GALV]: bullets(OVERFLOW, L.pierce, CHAIN) + `<p>Rake a lightning-charged drill through the enemy line. Deal <strong>heavy</strong> ${L.bolt}&nbsp;damage to all enemies. Used only while <strong>Supercharged</strong>.</p>`,
};
const spiral = fs.readFileSync(path.join(__dirname, "../../anim-studio/paryashera-drill.js"), "utf8");
let galv = spiral;
for (const [from, to] of [
  ['look: "steam"', 'look: "bolt"'], ["bandColor: 0xe8e4f4", "bandColor: 0xeccbff"], ["rimColor: 0xb9a8dc", "rimColor: 0xb070ff"],
  ['trailClip: "smoke_anim12.webm"', 'trailClip: "spark_anim01.webm"'], ["trailTint: 0xd8d4e4", "trailTint: 0xc98cff"],
  ["burstTint: 0xf2eefa", "burstTint: 0xc98cff"], ["sparkTint: 0xffffff", "sparkTint: 0xe2bcff"], ['hitSfx: "Explosion2"', 'hitSfx: "Thunder7"'],
]) { if (!galv.includes(from)) throw new Error(`no "${from}"`); galv = galv.replace(from, to); }
const SRC = { [SPIRAL]: spiral, [GALV]: galv };
const clone = (o) => JSON.parse(JSON.stringify(o));
const need = async (k) => { const v = await getByKey("actors", k); if (!v) throw new Error(`missing ${k}`); return v; };
(async () => {
  await run(async ({ changes }) => {
    const a = clone(await need(`!actors!${A}`));
    for (const id of [SPIRAL, GALV]) {
      const key = `!actors.items!${A}.${id}`;
      const d = clone(await need(key));
      const target = id === GALV ? "All Enemies" : "One Creature";
      Object.assign(d.system.props, { action_keywords: id === GALV ? "overflow, pierce, chain 6" : "pierce, chain 6", skill_target: target, description: DESC[id], animation_script: encode(SRC[id]) });
      changes.push([key, d, `${d.name}: chain 6, shot cues each tick`]);
      a.system.props.attack_list[id].attack_description = DESC[id];
      a.system.props.attack_list[id].active_target = target;
    }
    changes.push([`!actors!${A}`, a, "sheet mirrors: drill text"]);
  }, "galvanic-paryashera: drills Chain 6", "actors");
})().catch((e) => { console.error(e); process.exit(1); });
