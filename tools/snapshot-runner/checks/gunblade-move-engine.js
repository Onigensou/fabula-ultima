// Gunblade animations through move-engine (2026-11-22 pilot, branch feat/move-engine): the migration result and real sim
// battles through the FSM, recording every move-engine run (which move played, the outcome BD handed it, what it drew).
// Runner only (writes to the throwaway world).
//   FVTT_GPU=true run.mjs --snapshot snap-sonic --port 30161 --code <sha> --canvas full --eval checks/gunblade-move-engine.js --dump out.json
// globalThis.__GME = { only: ["G1","T",...] } picks scenarios (default: all).
const NS = "fabula-ultima-companion";
const O = Object.assign({ only: null, pace: "fast" }, globalThis.__GME ?? {});
const want = (k) => !O.only || O.only.includes(k);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
const sim = FUCompanion.api.experimental?.sim;
if (game.paused) await game.togglePause(false, true);
const out = { scenarios: {} };

// ── 1. migrations (sonic-gunblade, then this one) ──────────────────────────────
for (let i = 0; i < 240 && !game.items.get("mODVDmjIfozcfERi")?.getFlag(NS, "moveEngine"); i++) await wait(250);
const gb = game.items.get("mODVDmjIfozcfERi"), tf = game.items.get("SnGbGunbladeTfm1");
const plain = (s) => String(s ?? "").replace(/<[^>]*>/g, "");
out.migration = {
  gunblade: { flag: gb?.getFlag(NS, "moveEngine"), forms: (gb?.flags?.[NS]?.weaponForms ?? []).map((f) => f.label), scriptLen: String(gb?.system?.props?.animation_script ?? "").length,
    header: plain(gb?.system?.props?.animation_script).split("\n")[0].slice(0, 140), timing: gb?.system?.props?.animation_damage_timing_options },
  transform: { flag: tf?.getFlag(NS, "moveEngine"), scriptLen: String(tf?.system?.props?.animation_script ?? "").length, header: plain(tf?.system?.props?.animation_script).split("\n")[0].slice(0, 140) },
  log: (() => { try { const l = game.settings.get(NS, "appliedMigrations"); const o = typeof l === "string" ? JSON.parse(l) : l; return o?.["2026-11-22-gunblade-move-engine"] ?? null; } catch (e) { return String(e); } })(),
};

// ── helpers (sonic-gunblade.js pattern) ───────────────────────────────────────
const pc = (n) => game.actors.find((a) => a.name === n && a.hasPlayerOwner && String(a.system?.props?.main_hand ?? "").trim());
const dummy = game.actors.getName("Test Target Enemy");
const ES = await import("/modules/fabula-ultima-companion/scripts/battle-director/equipment-swap.js");
async function noWellspring(actor) { const ids = actor.effects.filter((e) => e.flags?.[NS]?.innerWellspring || /wellspring/i.test(e.name ?? "")).map((e) => e.id); if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids); }
async function giveWeapon(actor, weaponId) {
  for (const o of actor.items.filter((i) => i.getFlag(NS, "gmeTest"))) { for (const k of actor.items.filter((i) => i.system?.container === o.id)) await k.delete(); await o.delete(); }
  const w = game.items.get(weaponId); const d = w.toObject(); delete d._id; d.flags = { ...(d.flags ?? {}), [NS]: { ...(d.flags?.[NS] ?? {}), gmeTest: true } };
  const [nw] = await actor.createEmbeddedDocuments("Item", [d]);
  for (const k of game.items.filter((i) => i.system?.container === weaponId)) { const kd = k.toObject(); delete kd._id; kd.system.container = nw.id; await actor.createEmbeddedDocuments("Item", [kd]); }
  await ES.applyEquipmentSwap(actor, { main: nw.id, off: null });
  if (!nw.system?.props?.isEquipped) await nw.update({ "system.props.isEquipped": true });
  return nw;
}
// one move-engine run, summarised
const KEYS = { fire: ["008_slash_fire", "003_hit_fire", "gg_fireanim02", "gunshot", "hitfire"], phys: ["006_slash_physical", "slashL"], gun: ["011_pierce_physical"], tf: ["switch1", "shing", "051_powerup_1", "equip"] };
function summary(r) {
  const t = r.trace || []; const has = (k) => t.some((e) => (e.type === "clip" || e.type === "sfx") && e.key === k);
  return { key: r.key, variant: r.variant, result: r.result, gate: r.gate, markGate: r.markGate, firstHit: r.firstHit, end: r.end, total: r.total, wallMs: r.wallMs, dryMs: r.dryMs,
    fire: KEYS.fire.filter(has), phys: KEYS.phys.filter(has), gun: KEYS.gun.filter(has), tf: KEYS.tf.filter(has),
    cues: t.filter((e) => e.type === "hit").map((e) => e.kind + "@" + e.at), warnings: r.warnings };
}
async function attackRun(label, actorName, faces, { rounds = 1, forceReactions = null } = {}) {
  const a = pc(actorName);
  await noWellspring(a);
  await giveWeapon(a, "mODVDmjIfozcfERi");
  const SM = sim.mode; const orig = SM.recordDeclaration.bind(SM);
  let n = 0;
  SM.recordDeclaration = (k, s) => { const f = faces[Math.min(n, faces.length - 1)]; n++; if (f) SM.armDice(f[0], f[1], f[2], f[3]); return orig(k, s); };
  globalThis.__MOVE_RUNS = []; globalThis.__MOVE_TRACE_ON = true;
  const nums = []; const hn = Hooks.on("createChatMessage", () => {});
  let r = null, err = null;
  try { r = await sim.run({ enemies: [{ uuid: dummy.uuid, quantity: 1 }], party: [a.uuid], pace: O.pace, maxRounds: rounds, expectedRounds: rounds, guests: false,
    scripts: [{ caster: a.uuid, skill: "Attack", attack: true, targets: "enemy", once: false }], ...(forceReactions ? { forceReactions } : {}) }); }
  catch (e) { err = String(e?.message ?? e); }
  SM.recordDeclaration = orig; Hooks.off("createChatMessage", hn);
  for (let i = 0; i < 60 && (globalThis.__MOVE_RUNS || []).some((x) => x.wallMs == null && !x.dryOnly); i++) await wait(100);
  out.scenarios[label] = { err, simOk: !!r, runs: (globalThis.__MOVE_RUNS || []).map(summary) };
  globalThis.__MOVE_RUNS = null;
}

// Blanche (DEX d12 / MIG d12), Sword form: odd total, even total, a crit, a miss. faces = [rA, dieA, rB, dieB]
if (want("G1")) await attackRun("G1 odd 5+4 → fire", "Blanche", [[5, 12, 4, 12]]);
if (want("G2")) await attackRun("G2 even 5+5 → physical", "Blanche", [[5, 12, 5, 12]]);
if (want("G3")) await attackRun("G3 crit 6+6 → fire", "Blanche", [[6, 12, 6, 12]]);
if (want("G4")) await attackRun("G4 fumble 1+1 → miss", "Blanche", [[1, 12, 1, 12]]);
if (want("G5")) await attackRun("G5 low 2+1", "Blanche", [[2, 12, 1, 12]]);
// 2 rounds, the after-action transform forced: Sword attack → transform (#gun) → Firearm attack → transform (#sword)
if (want("T")) await attackRun("T 2 rounds with transforms", "Blanche", [[9, 12, 8, 12]], { rounds: 2, forceReactions: ["Gunblade: Transform"] });
return out;
