// node scripts/fabula-arcana/fa-drops.test.mjs
import { DROP, speciesOf, decideDrops, matchCard } from "./fa-drops-core.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

// species: one roll per card, highest rank kept
const sp = speciesOf([{ cid: "wolf", rank: "soldier" }, { cid: "wolf", rank: "elite" }, { cid: "roper", rank: "sol" }, { cid: null }]);
ok(sp.length === 2 && sp.find((s) => s.cid === "wolf").rank === "elite" && sp.find((s) => s.cid === "roper").rank === "soldier", "species fold: one per card, highest rank, unknown rank = soldier");

// chance boundaries
let r = decideDrops([{ cid: "wolf", rank: "soldier" }], [{ id: "a", owned: [], pity: {} }], seq(0.24));
ok(r.drops.length === 1 && r.drops[0].pity === false, "soldier roll 0.24 < 25% drops");
r = decideDrops([{ cid: "wolf", rank: "soldier" }], [{ id: "a", owned: [], pity: {} }], seq(0.25));
ok(r.drops.length === 0 && r.pity.a.wolf === 1, "soldier roll 0.25 misses, pity 1");
r = decideDrops([{ cid: "roper", rank: "elite" }], [{ id: "a", owned: [], pity: {} }], seq(0.39));
ok(r.drops.length === 1, "elite roll 0.39 < 40% drops");
r = decideDrops([{ cid: "flame", rank: "champion" }], [{ id: "a", owned: [], pity: {} }], seq(0.999));
ok(r.drops.length === 1 && r.drops[0].pity === false, "champion always drops (not a pity drop)");

// pity: soldier on the 4th eligible fight, elite on the 3rd
r = decideDrops([{ cid: "wolf", rank: "soldier" }], [{ id: "a", owned: [], pity: { wolf: 3 } }], seq(0.99));
ok(r.drops.length === 1 && r.drops[0].pity === true && !("wolf" in r.pity.a), "soldier pity fires on the 4th fight and resets");
r = decideDrops([{ cid: "wolf", rank: "soldier" }], [{ id: "a", owned: [], pity: { wolf: 2 } }], seq(0.99));
ok(r.drops.length === 0 && r.pity.a.wolf === 3, "soldier 3rd miss only counts");
r = decideDrops([{ cid: "roper", rank: "elite" }], [{ id: "a", owned: [], pity: { roper: 2 } }], seq(0.99));
ok(r.drops.length === 1 && r.drops[0].pity === true, "elite pity fires on the 3rd fight");

// owned: no roll, pity cleared
r = decideDrops([{ cid: "wolf", rank: "soldier" }], [{ id: "a", owned: ["wolf"], pity: { wolf: 2 } }], seq(0));
ok(r.drops.length === 0 && !("wolf" in r.pity.a), "owned card: no roll, pity cleared");

// each character rolls on their own; RNG order = recipient, then species
r = decideDrops([{ cid: "wolf", rank: "soldier" }, { cid: "roper", rank: "elite" }],
  [{ id: "a", owned: [], pity: {} }, { id: "b", owned: [], pity: { other: 1 } }], seq(0.1, 0.9, 0.9, 0.3));
ok(r.drops.map((d) => d.actorId + ":" + d.cid).join(",") === "a:wolf,b:roper", "each character rolls per species");
ok(r.pity.b.other === 1 && r.pity.b.wolf === 1 && r.pity.a.roper === 1, "unrelated pity kept, misses counted");

// rates over many fights (pity included): soldier expected ~1 drop per ~3.0 fights
let fights = 0, got = 0; let pity = {}; let s = 7;
const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
for (let i = 0; i < 20000; i++) { const x = decideDrops([{ cid: "wolf", rank: "soldier" }], [{ id: "a", owned: [], pity }], rng); fights++; pity = x.pity.a; if (x.drops.length) got++; }
const per = fights / got;
ok(per > 2.6 && per < 3.2, `soldier: one drop per ${per.toFixed(2)} fights (pity caps it at 4)`);

// matching
const cards = { wolf: { name: "Wolf" }, flame: { name: "Wandering Flame" }, carlbero: { name: "Carlbero", future: true }, broo: { name: "Bandit Roo", retired: true } };
const art = { wolf: "Beastiary/Wolf_Standard.png", flame: "Beastiary/WanderingFlame_Standard.png", carlbero: "Beastiary/Carlbero_Standard.png", broo: "Beastiary/BanditRoo_Standard.png" };
ok(matchCard({ images: ["https://assets.forge-vtt.com/x/Beastiary/WanderingFlame_Standard.png?v=2"], name: "⭐️ Wandering Flame" }, cards, art) === "flame", "art file match (URL, query string)");
ok(matchCard({ images: ["x/Wolf%20Pack.png"], name: "Wolf" }, cards, art) === "wolf", "name fallback");
ok(matchCard({ images: [], name: "⭐️ Wandering Flame" }, cards, art) === "flame", "name match ignores symbols");
ok(matchCard({ flag: false, name: "Wolf" }, cards, art) === null, "flag false = no card");
ok(matchCard({ flag: "flame", name: "Wolf" }, cards, art) === "flame", "flag picks the card");
ok(matchCard({ images: ["a/Carlbero_Standard.png"], name: "Carlbero" }, cards, art) === null, "future cards never drop");
ok(matchCard({ images: ["a/BanditRoo_Standard.png"] }, cards, art) === null, "retired cards never drop");
ok(matchCard({ images: ["a/Bandit_Standard.png"], name: "Bandit" }, cards, art) === null, "no card for an unmatched monster");
ok(DROP.chance.soldier === 0.25 && DROP.pityAt.elite === 3, "tunables");

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
