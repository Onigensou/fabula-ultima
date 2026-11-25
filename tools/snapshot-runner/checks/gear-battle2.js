// Legacy gear authoring — real-fight check (sim). Runner, canvas ON:
//   FVTT_HEADLESS=true node bin/run.mjs --snapshot snap-roster --port 30173 --code feat/legacy-gear-authoring --eval <this> --dump results/gear-battle.json
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [], lines: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const KEYS = /Mana Robe|Gambler|False Idol|Copycat|Dominatrix|Ball Gag|Biker|Steel Form|Mana Form|Defense Matrix|Alpha Regalia|Brief Respite|Little Devil|Avalon|Hekat|Enforcer|trigger_item|check_reroll|heal_reversed|Cataclysm|\(Passive\)|au_apply|dm_shield|br_|bg_|hk_|ld_|dl_|eu_|bk_|ar_double|mr_soak|Transform/i;
const origLog = console.log, origErr = console.error, origWarn = console.warn;
const grab = (lvl) => (...a) => { const s = a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
  if ((KEYS.test(s) || /[BD] (DECLARE|TARGET|CONFIRM|RESOLVE|free_action|[SIM])/.test(s)) && out.lines.length < 3000) out.lines.push(`${lvl} ${s.slice(0, 260)}`); if (lvl === "E") out.errors.push(s.slice(0, 300)); };
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
  await kit("Keren", { accs: [ID.falseIdol] }),
  await kit("Blanche", { accs: [ID.copycat], off: ID.avalon }),
  await kit("Zarg", { accs: [ID.gambler], off: ID.hekat }),
];
const potion = game.items.find((i) => !i.system?.container && String(i.system?.props?.item_type).toLowerCase() === "consumable" && /^(elixir|potion|hi-potion|remedy)$/i.test(i.name));
if (potion) { const d = potion.toObject(); delete d._id; d.system.props.item_quantity = 2; const top = (await party[1].createEmbeddedDocuments("Item", [d]))[0];
  const kids = game.items.filter((i) => i.system?.container === potion.id).map((k) => { const c = k.toObject(); delete c._id; delete c.folder; c.system.container = top.id; return c; });
  if (kids.length) await party[1].createEmbeddedDocuments("Item", kids); }
out.potion = potion?.name;
out.party = party.map((a) => ({ name: a.name, worn: a.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped).map((i) => i.name) }));
const isSpell = (i) => String(i.system?.props?.skill_type ?? "").toLowerCase() === "spell" && JSON.stringify(i.system?.props?.effect_table ?? {}).includes("damage");
const lvl = (a) => Number(a.system?.props?.level ?? 0);
const hpOf = (a) => Number(a.system?.props?.max_hp ?? 0);
const enemyA = game.actors.filter((a) => String(a.system?.props?.npc_rank ?? "").trim() && a.items.some(isSpell) && !/test|dummy|hako|roselie/i.test(a.name) && hpOf(a) <= 900).sort((x, y) => hpOf(y) - hpOf(x))[0];
const enemySpell = enemyA.items.find(isSpell);
const hinaSpell = party[0].items.find((i) => isSpell(i) && !i.system?.container);
const weaponOf = (a) => a.items.find((i) => !i.system?.container && i.system?.props?.isEquipped && String(i.system.props.item_type).toLowerCase() === "weapon");
out.plan = { enemy: enemyA.name, enemySpell: enemySpell?.name, hinaSpell: hinaSpell?.name, hinaWeapon: weaponOf(party[0])?.name, zargWeapon: weaponOf(party[3])?.name };
const enemies = [{ uuid: enemyA.uuid, quantity: 2 }];
out.enemyHp = hpOf(enemyA);
const scripts = [
  { caster: party[0].name, skill: hinaSpell?.name, targets: "enemy", once: true },
  { caster: party[1].name, skill: potion?.name, targets: "self", once: true },
].filter((d) => d.skill);
out.scripts = scripts;
const sim = FUCompanion.api.experimental.sim;
let res = null;
try {
  res = await Promise.race([sim.run({ enemies, party: party.map((a) => a.uuid), maxRounds: 2, reactions: "apply", guests: false, scripts }), wait(600000).then(() => ({ outcome: "TIMEOUT" }))]);
  if (res?.outcome === "TIMEOUT") { out.tail = out.lines.slice(-40); try { const d = FUCompanion.api.experimental.battleDirector?.getActiveDirector?.(); out.dirState = d?.state ?? null; const ar = d?.ctx?.actionResult; out.stuck = { kind: ar?.kind, skill: ar?.skillName, attacker: ar?.attacker?.name ?? ar?.attacker?.actorName, targets: (ar?.targets ?? []).map((t) => t.name ?? t.tokenUuid), roll: ar?.roll ? { rA: ar.roll.rA, rB: ar.roll.rB, fumble: ar.roll.isFumble, crit: ar.roll.isCrit } : null, freeTop: JSON.stringify(d?.ctx?.freeActionStack ?? d?.ctx?._freeStack ?? null)?.slice(0, 300), ctxKeys: Object.keys(d?.ctx ?? {}).filter((k) => /pend|prompt|wait|await|ask/i.test(k)) }; out.cardR = (d?.ctx?.cardReactions ?? []).map((c) => `${c.carrierName ?? c.skillName}:${c.mode ?? c.passiveMode}:${c.reactorActorName}`).slice(0, 20); out.windows = Object.values(ui.windows).map((w) => w.title ?? w.constructor.name); out.ar = JSON.stringify(Object.fromEntries(Object.entries(ar ?? {}).filter(([k, v]) => typeof v !== "object"))).slice(0, 600); out.ctxTop = Object.keys(d?.ctx ?? {}).slice(0, 80); out.allBD = out.lines.filter((l) => /[BD] (DECLARE|CONFIRM|[SIM] scripted)/.test(l)).slice(-15); } catch (e) { out.stuckErr = String(e); } }
} catch (e) { out.simError = String(e?.stack ?? e).slice(0, 800); }
out.sim = res ? { outcome: res.outcome, rounds: res.rounds, journal: res.journalPath } : null;
const seen = (re) => out.lines.some((l) => re.test(l));
ok("sim ran", !!res && !out.simError, out.simError);
const checks = {
  "Brief Respite fired": /auto-fired "Brief Respite/i, "Mana Robe soaked": /Mana Robe/i, "Little Devil ZP": /auto-fired "Little Devil|row "ld_zp"/i,
  "False Idol aura": /applied "False Idol"/i, "Copycat offered/fired": /Copycat/i, "Gambler reroll": /check_reroll/i, "Hekat MP or resist": /Hekat Shield (Passive)[^]*(acted|auto-fired)|hk_mp|hk_resist/i,
};
for (const [n, re] of Object.entries(checks)) ok(n, seen(re));
out.errorCount = out.errors.length;
console.log = origLog; console.error = origErr; console.warn = origWarn;
for (const a of party) { try { await a.delete(); } catch {} }
return out;
