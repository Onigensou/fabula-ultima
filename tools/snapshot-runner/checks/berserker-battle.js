// Berserker set + Spell Fencer Hat in a real sim fight (2026-11-28, feat/berserker-gear). Runner only; slow (~minutes per round).
//   FVTT_HEADLESS=true FVTT_CANVAS=off node ../snapshot-runner/bin/run.mjs --snapshot snap-berserk --port 30189 --code feat/berserker-gear --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [], lines: [], aeLog: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const KEYS = /bk_|ax_rage|bf_bonus|ht_|Berserk|Berserker|Fencer Hat|Spell Fencer Hat/i;
const oL = console.log, oW = console.warn, oE = console.error;
const grab = (lvl) => (...a) => { const s = a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
  if (KEYS.test(s) && out.lines.length < 1200) out.lines.push(`${lvl} ${s.slice(0, 300)}`); if (lvl === "E") out.errors.push(s.slice(0, 300)); };
console.log = (...a) => { try { grab("L")(...a); } catch {} return oL(...a); };
console.warn = (...a) => { try { grab("W")(...a); } catch {} return oW(...a); };
console.error = (...a) => { try { grab("E")(...a); } catch {} return oE(...a); };
const ID = { armor: "BrskArmor0000001", axe: "BrskAxe000000001", hat: "SpFnHat000000001" };
for (let i = 0; i < 240 && !game.items.get(ID.hat); i++) await wait(250);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(1500);
if (game.paused) await game.togglePause(false, true);
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const W = (id) => game.items.get(id);
const P = (d) => d?.system?.props ?? {};

Hooks.on("createActiveEffect", (e) => { if (/Berserk|Berserker Rage|Fencer Hat/.test(e.name)) out.aeLog.push(`+ ${e.parent?.name}: ${e.name} ch=${e.flags?.[NS]?.charges ?? ""}`); });
Hooks.on("deleteActiveEffect", (e) => { if (/Berserk|Berserker Rage|Fencer Hat/.test(e.name)) out.aeLog.push(`- ${e.parent?.name}: ${e.name}`); });

async function kit(srcName, { armor, main, accs = [] }) {
  const d = game.actors.getName(srcName).toObject(); delete d._id; d.name = `BB ${srcName}`;
  const a = await Actor.create(d);
  const add = async (id) => { const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false; const [top] = await a.createEmbeddedDocuments("Item", [s]);
    const kids = game.items.filter((i) => i.system?.container === id).map((k) => { const x = k.toObject(); delete x._id; delete x.folder; x.system.container = top.id; return x; });
    if (kids.length) await a.createEmbeddedDocuments("Item", kids); return top; };
  const mainItem = main ? await add(main) : a.items.find((i) => !i.system?.container && P(i).isEquipped && String(P(i).item_type) === "weapon");
  const accItems = []; for (const id of accs) accItems.push(await add(id));
  await wait(1000);
  await applyEquipmentSwap(a, { main: mainItem?.id ?? null, off: null, accessory1: accItems[0]?.id ?? null, accessory2: accItems[1]?.id ?? null });
  if (armor) {
    const ar = await add(armor); await wait(800);
    await a.updateEmbeddedDocuments("Item", a.items.filter((i) => !i.system?.container && String(P(i).item_type).toLowerCase() === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === ar.id })));
  }
  await wait(1500);
  return a;
}

// Blanche wears the set (2pc); her HP starts at 60% so the first solid hit pushes her into Crisis.
// Keren (a Spell Fencer) wears the Hat, so its rows run beside Spellweave / Bladework.
const party = [
  await kit("Blanche", { armor: ID.armor, main: ID.axe }),
  await kit("Keren", { accs: [ID.hat] }),
];
await party[0].update({ "system.props.current_hp": Math.floor(Number(P(party[0]).max_hp) * 0.6) });
out.party = party.map((a) => ({ name: a.name, hp: `${P(a).current_hp}/${P(a).max_hp}`, worn: a.items.filter((i) => !i.system?.container && P(i).isEquipped).map((i) => i.name),
  fury: a.items.some((i) => i.name === "Berserker's Fury") }));
ok("kits worn (+ 2pc granted)", out.party[0].worn.includes("Berserker Armor") && out.party[0].worn.includes("Berserker Axe") && out.party[0].fury && out.party[1].worn.includes("Spell Fencer Hat"), out.party);

const lvl = (a) => Number(P(a).level ?? P(a).char_level ?? 0);
const phys = game.actors.filter((a) => String(P(a).npc_rank ?? "").trim() && !/test|dummy|sim/i.test(a.name) && lvl(a) >= 30 && lvl(a) <= 45)
  .sort((x, y) => Math.abs(lvl(x) - 40) - Math.abs(lvl(y) - 40));
const enemies = phys.slice(0, 2).map((a) => ({ uuid: a.uuid, quantity: 1 }));
out.enemies = phys.slice(0, 2).map((a) => `${a.name} L${lvl(a)}`);
let res = null;
try {
  res = await FUCompanion.api.experimental.sim.run({ enemies, party: party.map((a) => a.uuid), maxRounds: 4, reactions: "apply", guests: false, startingZp: 0 });
} catch (e) { out.simError = String(e?.stack ?? e).slice(0, 800); }
out.sim = res ? { outcome: res.outcome ?? res.result ?? null, rounds: res.rounds ?? null } : null;
const seen = (re) => out.lines.some((l) => re.test(l)) || out.aeLog.some((l) => re.test(l));
ok("sim ran", !!res && !out.simError, out.simError);
ok("Berserk applied by the armor in a fight", seen(/\+ .*Berserk$|bk_berserk|Berserker Rage/), out.aeLog);
ok("axe % row fired", seen(/ax_rage|Berserker Axe \(Passive\)/));
ok("2pc ×1.10 fired", seen(/bf_bonus|Berserker's Fury/));
ok("hat marker written", seen(/Fencer Hat (Blade|Spell)/), out.aeLog);
console.log = oL; console.warn = oW; console.error = oE;
for (const a of party) { try { await a.delete(); } catch {} }
out.errorCount = out.errors.length;
return out;
