// Opportunity charm accessories (2026-11-28, feat/opportunity-charms). Runner only.
//   FVTT_HEADLESS=true FVTT_CANVAS=off node ../snapshot-runner/bin/run.mjs --snapshot snap-oppcharm --port 30191 --code feat/opportunity-charms --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const safe = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${String(e?.stack ?? e).slice(0, 700)}`); ok(name, false, "threw"); } };
const ID = { hex: "OppCharmHexCoin1", bell: "OppCharmDoomBel1", ribbon: "OppCharmMendRib1", moon: "OppCharmMoonPen1", rosary: "OppCharmSaintRo1" };
const OPP = { hex: "misfortune", bell: "calamity", ribbon: "succor", moon: "calm", rosary: "sooth" };
for (let i = 0; i < 240 && !game.items.get(ID.rosary); i++) await wait(250);
for (let i = 0; i < 120 && !window["oni.OpportunityEffects"]?.sooth; i++) await wait(250);
await wait(1500);
if (game.paused) await game.togglePause(false, true);
const W = (id) => game.items.get(id);
const P = (d) => d?.system?.props ?? {};
const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const scene = canvas.scene ?? game.scenes.active ?? game.scenes.contents[0];
const made = [];

// ── 1. items ─────────────────────────────────────────────────────────────────
await safe("items", async () => {
  out.items = Object.fromEntries(Object.entries(ID).map(([k, id]) => {
    const d = W(id), p = P(d);
    return [k, { name: d?.name, type: p.item_type, rar: p.item_rarity, cost: p.item_cost, isSet: p.isSet, set: p.set_name, folder: d?.folder?.name,
      forge: /forge-vtt/.test(d?.img ?? ""), text: strip(p.description), flavor: strip(p.flavor_text),
      aes: d?.effects?.map((e) => `${e.name}|${e.transfer}|${e.changes.map((c) => `${c.key}:${c.mode}:${c.value}`).join(",")}`),
      kids: game.items.filter((i) => i.system?.container === id).length, def: p.item_def_bonus, mdef: p.item_mdef_bonus }];
  }));
  const I = out.items;
  ok("names", I.hex.name === "Hex Coin" && I.bell.name === "Doomsayer's Bell" && I.ribbon.name === "Mender's Ribbon" && I.moon.name === "Moonstone Pendant" && I.rosary.name === "Saint's Rosary", Object.values(I).map((x) => x.name));
  ok("rarity/cost: Uncommon 1500, Rare 2000", ["hex", "ribbon", "moon"].every((k) => I[k].rar === "Uncommon" && I[k].cost === "1500") && ["bell", "rosary"].every((k) => I[k].rar === "Rare" && I[k].cost === "2000"));
  ok("accessory, no set, DEF/MDEF 0, no kids, forge icon", Object.values(I).every((x) => x.type === "accessory" && !x.isSet && x.set === "" && x.def === "0" && x.mdef === "0" && !x.kids && x.forge), I);
  ok("one AE each, mode 5 opp flag", Object.entries(I).every(([k, x]) => x.aes?.length === 1 && x.aes[0].includes(`flags.${NS}.opp_${OPP[k]}:5:\${isEquipped ? 1 : 0}$`) && x.aes[0].includes("|true|")), Object.values(I).map((x) => x.aes));
  ok("texts", /new Opportunity , 【⏳ Misfortune 】 Deals 【1d100】 non-elemental damage to one enemy\./.test(I.hex.text)
    && /Calamity 】 Deals 【1d50】 non-elemental damage to all enemies\./.test(I.bell.text)
    && /Succor 】 One creature recovers 50 HP\./.test(I.ribbon.text) && /Calm 】 One creature recovers 50 MP\./.test(I.moon.text)
    && /Sooth 】 One creature recovers from all negative statuses\./.test(I.rosary.text) && Object.values(I).every((x) => x.flavor.length > 10), Object.values(I).map((x) => x.text));
});

// ── 2. tables ────────────────────────────────────────────────────────────────
await safe("tables", async () => {
  const T = { oDiuDJRoayGJwr1L: "acc", dRN7ElUZH86RVl4e: "tre", jlDJQx6WUtsw7npK: "acc", xcvyadSZsEqYvjJA: "tre", CRGj5HutohiPQnl1: "acc",
    hS4XNu1vLtWbPSne: "tre", "86Lj4WaVPFkt286A": "acc", DMeYaPoSPUxH6xVE: "tre", h2UugZ9iirGWux94: "acc", aK4ojp7R73e7cKzj: "tre" };
  out.tables = {};
  let good = true;
  for (const [tid, kind] of Object.entries(T)) {
    const t = game.tables.get(tid);
    const want = kind === "acc" ? [ID.hex, ID.ribbon, ID.moon] : [ID.bell, ID.rosary];
    const nums = t.results.contents.flatMap((r) => { const a = []; for (let n = r.range[0]; n <= r.range[1]; n++) a.push(n); return a; });
    const max = Math.max(...nums);
    const full = nums.length === max && new Set(nums).size === max;
    const has = want.every((id) => t.results.filter((r) => r.documentId === id).length === 1);
    const noOther = ![ID.hex, ID.ribbon, ID.moon, ID.bell, ID.rosary].filter((id) => !want.includes(id)).some((id) => t.results.some((r) => r.documentId === id));
    out.tables[t.name] = { formula: t.formula, rows: t.results.size, full, has, noOther, new: t.results.filter((r) => want.includes(r.documentId)).map((r) => `${r.text}@${r.range[0]}`) };
    if (!(t.formula === `1d${max}` && full && has && noOther)) good = false;
  }
  ok("10 tables: rows added once, no gaps/overlaps, formula 1d<rows>", good, out.tables);
  const draws = [];
  for (let i = 0; i < 30; i++) { const r = await game.tables.get("jlDJQx6WUtsw7npK").roll({ displayChat: false }); draws.push(r.results.length); }
  ok("Bandits Hideout - Accessory: every roll lands on a row", draws.every((n) => n === 1), draws.join(""));
});

// ── 3. Hako ──────────────────────────────────────────────────────────────────
await safe("hako", async () => {
  const st = game.actors.get("srAH3OHOoK0tvFih").flags[NS].shopRoster;
  const ent = (id) => st.pool.find((e) => e.id === id);
  out.hako = { bell: ent(ID.bell), rosary: ent(ID.rosary), uncommonIn: [ID.hex, ID.ribbon, ID.moon].filter(ent), size: st.pool.length };
  ok("Hako pool: Bell + Rosary at 2000, no Uncommons", out.hako.bell?.price === 2000 && out.hako.rosary?.price === 2000 && !out.hako.uncommonIn.length, out.hako);
});

// ── 4. config + equip flags ──────────────────────────────────────────────────
async function hero(name, ids = []) {
  const src = game.actors.getName("Test Target Ally").toObject(); delete src._id; src.name = name;
  const a = await Actor.create(src); made.push(a);
  const got = {};
  for (const id of ids) { const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false; const [top] = await a.createEmbeddedDocuments("Item", [s]); got[id] = top; }
  await wait(1200);
  return { a, got };
}
const flags = (a) => Object.fromEntries(["lucky", ...Object.values(OPP)].map((o) => [o, a.getFlag(NS, `opp_${o}`) ?? null]));
let H = null;
await safe("config", async () => {
  const opts = window["oni.OpportunityConfig"].OPTIONS;
  const o = (id) => opts.find((x) => x.id === id);
  out.config = Object.values(OPP).map((id) => ({ id, flag: o(id)?.requiresFlag, battleOnly: !!o(id)?.battleOnly, handler: !!window["oni.OpportunityEffects"][id] }));
  ok("5 options, gated + handlers; only damage ones battleOnly", out.config.every((c) => c.flag === `opp_${c.id}` && c.handler && c.battleOnly === ["misfortune", "calamity"].includes(c.id)), out.config);
});
await safe("equip flags", async () => {
  H = await hero("OC Hina", [ID.hex, ID.rosary, ID.moon]);
  const { a, got } = H;
  out.flags0 = flags(a);
  await applyEquipmentSwap(a, { main: null, off: null, accessory1: got[ID.hex].id, accessory2: got[ID.rosary].id });
  await wait(2000);
  out.flagsOn = flags(a);
  await applyEquipmentSwap(a, { main: null, off: null, accessory1: got[ID.moon].id, accessory2: null });
  await wait(2000);
  out.flagsSwap = flags(a);
  await applyEquipmentSwap(a, { main: null, off: null, accessory1: null, accessory2: null });
  await wait(2000);
  out.flagsOff = flags(a);
  const on = (f, list) => Object.entries(f).every(([k, v]) => (list.includes(k) ? Number(v) === 1 : !Number(v)));
  ok("unequipped: no opp flags", on(out.flags0, []), out.flags0);
  ok("Hex Coin + Rosary → misfortune + sooth", on(out.flagsOn, ["misfortune", "sooth"]), out.flagsOn);
  ok("swap to Moonstone → calm only", on(out.flagsSwap, ["calm"]), out.flagsSwap);
  ok("all off → cleared", on(out.flagsOff, []), out.flagsOff);
});

// ── 5. handlers (post phase, as the GM runs it) ──────────────────────────────
const fx = window["oni.OpportunityEffects"];
const ctx = (id, a) => ({ actorUuid: a.uuid, actorName: a.name, optionId: id, option: window["oni.OpportunityConfig"].OPTIONS.find((o) => o.id === id), context: {} });
const hp = (a) => Number(P(a).current_hp), mp = (a) => Number(P(a).current_mp);
const tok = async (a, i) => { const td = await a.getTokenDocument({ x: 1500 + i * 100, y: 1500 }); const o = td.toObject(); o.actorLink = true; const [t] = await scene.createEmbeddedDocuments("Token", [o]); return t; };
const madeTok = [];

await safe("misfortune", async () => {
  const { a: foe } = await hero("OC Foe A");
  const t = await tok(foe, 1); madeTok.push(t);
  const b = hp(foe);
  const r = await fx.misfortune.post(ctx("misfortune", H.a), { tokenId: t.id, tokenUuid: t.uuid });
  await wait(800);
  const rolled = Number(/= (\d+)/.exec(strip(r?.resultSummary))?.[1]);
  out.misfortune = { before: b, after: hp(foe), rolled, dr: P(foe).damage_reduction ?? null, summary: strip(r?.resultSummary) };
  ok("misfortune: 1d100 lands as rolled (to 0 floor)", rolled >= 1 && rolled <= 100 && b - hp(foe) === Math.min(b, rolled), out.misfortune);
});

await safe("calamity", async () => {
  const foes = [];
  for (const n of ["OC Foe B", "OC Foe C"]) { const { a } = await hero(n); const t = await tok(a, foes.length + 3); madeTok.push(t); foes.push({ a, t }); }
  const bd = FUCompanion.api.experimental.battleDirector;
  const real = bd.getActiveDirector;
  const stub = { ctx: { dCombat: { combatants: [
    { side: "party", actorDoc: H.a, isDefeatedLive: () => false },
    ...foes.map((f) => ({ side: "enemy", actorDoc: f.a, tokenDoc: f.t, isDefeatedLive: () => false })),
    { side: "enemy", actorDoc: game.actors.getName("Test Target Ally"), isDefeatedLive: () => true },
  ] } } };
  let stubbed = false;
  try { bd.getActiveDirector = () => stub; stubbed = bd.getActiveDirector() === stub; } catch {}
  const b = foes.map((f) => hp(f.a));
  const r = stubbed ? await fx.calamity.post(ctx("calamity", H.a), {}) : null;
  try { bd.getActiveDirector = real; } catch {}
  await wait(800);
  const rolled = Number(/= (\d+)/.exec(strip(r?.resultSummary))?.[1]);
  out.calamity = { stubbed, rolled, before: b, after: foes.map((f) => hp(f.a)), summary: strip(r?.resultSummary) };
  ok("calamity: one 1d50, every living enemy, not the party/defeated", stubbed && rolled >= 1 && rolled <= 50 && foes.every((f, i) => b[i] - hp(f.a) === Math.min(b[i], rolled)) && /all enemies \(2\)/.test(out.calamity.summary), out.calamity);
});

await safe("succor + calm", async () => {
  const a = H.a;
  await a.update({ "system.props.current_hp": 5, "system.props.current_mp": 3 }); await wait(500);
  await fx.succor.post(ctx("succor", a), { actorUuid: a.uuid }); await wait(600);
  await fx.calm.post(ctx("calm", a), { actorUuid: a.uuid }); await wait(600);
  out.heal = { hp: hp(a), mp: mp(a), maxHp: P(a).max_hp, maxMp: P(a).max_mp };
  ok("succor +50 HP, calm +50 MP (capped)", out.heal.hp === Math.min(55, Number(out.heal.maxHp)) && out.heal.mp === Math.min(53, Number(out.heal.maxMp)), out.heal);
});

await safe("sooth", async () => {
  const a = H.a;
  await a.createEmbeddedDocuments("ActiveEffect", [
    { name: "Dazed", img: "icons/svg/daze.svg", system: { tags: ["debuff"] }, changes: [] },
    { name: "Weak", img: "icons/svg/daze.svg", system: { tags: ["debuff"] }, changes: [] },
    { name: "Test Buff", img: "icons/svg/aura.svg", system: { tags: ["buff"] }, changes: [] },
  ]);
  await wait(500);
  const r = await fx.sooth.post(ctx("sooth", a), { actorUuid: a.uuid }); await wait(600);
  out.sooth = { left: a.effects.map((e) => e.name), summary: strip(r?.resultSummary) };
  ok("sooth: debuffs gone, buff kept", !out.sooth.left.includes("Dazed") && !out.sooth.left.includes("Weak") && out.sooth.left.includes("Test Buff"), out.sooth);
});

try { await scene.deleteEmbeddedDocuments("Token", madeTok.map((t) => t.id)); } catch {}
for (const a of made) { try { await a.delete(); } catch {} }
out.passed = Object.values(out.steps).filter((s) => s.pass).length;
out.total = Object.keys(out.steps).length;
return out;
