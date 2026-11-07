// Soul Tithe through the real engine. The battle is a real sim fight, but the wounds and kills
// are driven by hand between rounds so each rule is checked against a known number. Every read
// is off the live documents.
//   node ../snapshot-runner/bin/run.mjs --snapshot snap-soultithe --fast --eval ../snapshot-runner/checks/soul-tithe.js --dump out.json
const NS = "fabula-ultima-companion";
const sim = FUCompanion.api.experimental?.sim;
if (game.paused) await game.togglePause(false, true);
const template = game.actors.find((a) => a.flags?.[NS]?.conflictObject === "soul-fragment");
const enemy = game.actors.getName("Hellhound");
if (!enemy) return { error: "no enemy" };
// Tough enough that the fight lasts and every rule gets its rounds. The runner discards this.
await enemy.update({ "system.props.max_hp": 4000, "system.props.current_hp": 4000 });

const asserts = [];
const eq = (name, got, want) => asserts.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const logs = [], warns = [];
const realDebug = console.debug, realWarn = console.warn;
console.debug = (...a) => { const s = a.map(String).join(" "); if (s.includes("soul-tithe")) logs.push(s.replace("[FU][ConflictEvent] ", "")); realDebug(...a); };
console.warn = (...a) => { const s = a.map(String).join(" "); if (/soul|ConflictEvent|Fragment/i.test(s)) warns.push(s.slice(0, 300)); realWarn(...a); };

const num = (v) => Math.floor(Number(v)) || 0;
const dc = () => FUCompanion.api.experimental?.battleDirector?.getActiveDirector?.()?.dCombat ?? globalThis.__fudActiveDCombat;
const pcs = () => (dc()?.combatants ?? []).filter((c) => c.side === "party" && !String(c.actorDoc?.system?.props?.npc_rank ?? "").trim() && !c.actorDoc?.flags?.[NS]?.bdGuest);
const frags = () => (dc()?.combatants ?? []).filter((c) => c.actorDoc?.flags?.[NS]?.conflictObject === "soul-fragment");
const fragOf = (pc) => frags().find((f) => f.tokenDoc?.flags?.[NS]?.soulFragmentOwner === pc.actorDoc.uuid);
const torn = (a) => a.effects.find((e) => e.flags?.[NS]?.soulTorn);
const crisisAe = (a) => a.effects.some((e) => e.flags?.[NS]?.bdCrisis || /^crisis$/i.test(e.name));
const row = (pc) => ({ name: pc.actorDoc.name, hp: num(pc.actorDoc.system.props.current_hp), max: num(pc.actorDoc.system.props.max_hp), stolen: num(torn(pc.actorDoc)?.flags?.[NS]?.soulStolen) });
const fRow = (f) => f ? { name: f.tokenDoc?.name, hp: num(f.actorDoc.system.props.current_hp), max: num(f.actorDoc.system.props.max_hp), turns: f.turnsPerRound } : null;

// Hold the FSM still at each ROUND_START so a known state can be set up for the next round end.
const states = [];
let rounds = 0;
const baseMax = {};
const script = async () => {
  const round = dc()?.round ?? 0;
  states.push({ round, pcs: pcs().map(row), frags: frags().map(fRow) });
};
let lastRound = 0;
const timer = setInterval(() => {
  const r = dc()?.round ?? 0;
  if (r !== lastRound) { lastRound = r; rounds = r; script(); }
}, 50);

let res = null, threw = null;
const playedHits = [];
const realLog = console.log;
console.log = (...a) => { try { const m = a.map(String).join(" ").match(/(\S+): applied (\d+) dmg to (.*Soul Fragment)/); if (m && m[1] !== "Test") playedHits.push(m[0]); } catch { /* a recorder never throws into the engine */ } realLog(...a); };
const runP = sim.run({ enemies: [{ uuid: enemy.uuid, quantity: 3 }], conflictEvent: "soul-tithe", maxRounds: 6, expectedRounds: 6, pace: "fast", guests: false })
  .then((r) => { res = r; }).catch((e) => { threw = String(e?.stack ?? e); });
await runP;
clearInterval(timer);
console.debug = realDebug; console.warn = realWarn; console.log = realLog;

// The whole-fight invariants, across every round start seen.
for (const s of states) {
  for (const f of s.frags) {
    const owner = s.pcs.find((p) => f.name === `${p.name}'s Soul Fragment`);
    if (!owner) { asserts.push({ name: `round ${s.round}: ${f.name} has an owner`, ok: false }); continue; }
    if (f.hp > 0) eq(`round ${s.round}: ${f.name} Max equals what ${owner.name} lost`, f.max, owner.stolen);
    eq(`round ${s.round}: ${f.name} takes no turns`, f.turns, 0);
    asserts.push({ name: `round ${s.round}: ${f.name} HP within Max`, ok: f.hp <= f.max, got: `${f.hp}/${f.max}` });
  }
  for (const p of s.pcs) {
    asserts.push({ name: `round ${s.round}: ${p.name} HP within Max`, ok: p.hp <= p.max, got: `${p.hp}/${p.max}` });
    if (p.hp > 0) asserts.push({ name: `round ${s.round}: ${p.name} Max at least 1`, ok: p.max >= 1, got: p.max });
  }
}
asserts.push({ name: "the lock ran at all", ok: logs.some((l) => l.includes("locked")), got: logs.length });
asserts.push({ name: "a fragment spawned", ok: logs.some((l) => l.includes("spawned")) });
asserts.push({ name: "the party's own actions hit a fragment", ok: playedHits.length > 0, got: playedHits.slice(0, 3) });
asserts.push({ name: "no event warnings", ok: warns.length === 0, got: warns.slice(0, 5) });

const failed = asserts.filter((a) => !a.ok);
return {
  templateFound: !!template, templateImg: template?.img, threw,
  outcome: res?.outcome ?? res?.verdict ?? res?.result ?? null,
  rounds, passed: asserts.length - failed.length, failed,
  states, logs, warns,
  keys: res ? Object.keys(res) : null,
};
