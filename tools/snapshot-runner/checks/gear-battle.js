// Legacy gear authoring — real-fight check (sim). Runner, canvas ON:
//   FVTT_HEADLESS=true node bin/run.mjs --snapshot snap-roster --port 30173 --code feat/legacy-gear-authoring --eval <this> --dump results/gear-battle.json
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [], lines: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const KEYS = /Mana Robe|Gambler|False Idol|Copycat|Dominatrix|Ball Gag|Biker|Steel Form|Mana Form|Defense Matrix|Alpha Regalia|Brief Respite|Little Devil|Avalon|Hekat|Enforcer|trigger_item|check_reroll|heal_reversed|Cataclysm|\(Passive\)|au_apply|dm_shield|br_|bg_|hk_|ld_|dl_|eu_|bk_|ar_double|mr_soak|Transform/i;
const origLog = console.log, origErr = console.error, origWarn = console.warn;
const grab = (lvl) => (...a) => { const s = a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
  if (KEYS.test(s) && out.lines.length < 800) out.lines.push(`${lvl} ${s.slice(0, 260)}`); if (lvl === "E") out.errors.push(s.slice(0, 300)); };
console.log = (...a) => { grab("L")(...a); return origLog(...a); };
console.warn = (...a) => { grab("W")(...a); return origWarn(...a); };
console.error = (...a) => { grab("E")(...a); return origErr(...a); };
for (let i = 0; i < 240 && !JSON.stringify(game.settings.get(NS, "appliedMigrations") ?? "").includes("legacy-gear-authoring"); i++) await wait(250);

const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const W = (id) => game.items.get(id);
const ID = { manaRobe: "jnhWaWPLwZcPQ883", gambler: "fXTiW1mHRFBGSGR8", copycat: "Hurc7SbzCtjIAaC3", dominatrix: "V3R1cSiLgIfXVgRj",
  ballGag: "Ef9i1q5WWmWw0ZcI", biker: "HlSNO4jVVSMkSCT7", matrix: "4OH9H2YYxr9KhhBx", alpha: "0b9L1O59jxijKJ1I", brief: "6f3U2Cz826kB5ZIp",
  devil: "08Aj60g6ffE0XmAW", avalon: "vH6Q88n3beOHjxKq", hekat: "96gMkuCexILXHXyI", enforcer: "2MAkZpclKVJH9Hvx", falseIdol: "L15zxS1OesPs4l2h" };

async function kit(srcName, { armor, accs = [], off }) {
  const src = game.actors.getName(srcName);
  const d = src.toObject(); delete d._id; d.name = `GA ${srcName}`;
  const a = await Actor.create(d);
  const add = async (id) => { const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false; const top = (await a.createEmbeddedDocuments("Item", [s]))[0];
    const kids = game.items.filter((i) => i.system?.container === id).map((k) => { const d = k.toObject(); delete d._id; delete d.folder; d.system.container = top.id; return d; });
    if (kids.length) await a.createEmbeddedDocuments("Item", kids);
    return top; };
  const accItems = []; for (const id of accs) accItems.push(await add(id));
  const offItem = off ? await add(off) : null;
  const cur = a.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped);
  const main = cur.find((i) => ["weapon"].includes(String(i.system.props.item_type).toLowerCase()));
  await applyEquipmentSwap(a, { main: main?.id ?? null, off: offItem?.id ?? null, accessory1: accItems[0]?.id ?? null, accessory2: accItems[1]?.id ?? null });
  if (armor) {
    const ar = await add(armor);
    await a.updateEmbeddedDocuments("Item", a.items.filter((i) => String(i.system?.props?.item_type).toLowerCase() === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === ar.id })));
  }
  await wait(300);
  return a;
}

const party = [
  await kit("Hina", { armor: ID.manaRobe, accs: [ID.brief, ID.devil] }),
  await kit("Keren", { armor: ID.biker, accs: [ID.matrix, ID.alpha] }),
  await kit("Blanche", { armor: ID.enforcer, accs: [ID.gambler, ID.copycat], off: ID.avalon }),
  await kit("Zarg", { armor: ID.dominatrix, accs: [ID.ballGag], off: ID.hekat }),
];
out.party = party.map((a) => ({ name: a.name, worn: a.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped).map((i) => i.name) }));

// Enemies: NPCs that own a damaging spell AND an attack, mid level.
const isSpell = (i) => String(i.system?.props?.skill_type ?? "").toLowerCase() === "spell" && JSON.stringify(i.system?.props?.effect_table ?? {}).includes("damage");
const lvl = (a) => Number(a.system?.props?.level ?? a.system?.props?.char_level ?? 0);
const cands = game.actors.filter((a) => String(a.system?.props?.npc_rank ?? "").trim() && a.items.some(isSpell) && !/test|dummy|sim/i.test(a.name)).sort((x, y) => Math.abs(lvl(x) - 20) - Math.abs(lvl(y) - 20));
out.npcTotal = game.actors.filter((a) => String(a.system?.props?.npc_rank ?? "").trim()).length;
out.enemyPool = cands.slice(0, 6).map((a) => `${a.name} L${lvl(a)}`);
const enemies = cands.filter((a) => lvl(a) >= 30 && a.name !== "Roselie").slice(0, 2).map((a) => ({ uuid: a.uuid, quantity: 1 }));

const sim = FUCompanion.api.experimental.sim;
let res = null;
try {
  res = await sim.run({ enemies, party: party.map((a) => a.uuid), maxRounds: 5, reactions: "apply", guests: false, startingZp: 0 });
} catch (e) { out.simError = String(e?.stack ?? e).slice(0, 800); }
out.sim = res ? { outcome: res.outcome ?? res.result ?? null, rounds: res.rounds ?? null, keys: Object.keys(res).slice(0, 20) } : null;

const seen = (re) => out.lines.some((l) => re.test(l));
ok("sim ran", !!res && !out.simError, out.simError);
const checks = {
  "Defense Matrix fired": /Defense Matrix/i, "Avalon aura applied": /Avalon/i, "Alpha Regalia aura applied": /Alpha Regalia/i,
  "Biker Suit reacted": /Biker|Steel Form|Mana Form/i, "Brief Respite fired": /Brief Respite/i, "Mana Robe soaked": /Mana Robe/i,
  "Ball Gag silenced": /Ball Gag|Silence/i, "Hekat reacted": /Hekat/i,
};
for (const [n, re] of Object.entries(checks)) ok(n, seen(re));
out.errorCount = out.errors.length;
console.log = origLog; console.error = origErr; console.warn = origWarn;
for (const a of party) { try { await a.delete(); } catch {} }
return out;
