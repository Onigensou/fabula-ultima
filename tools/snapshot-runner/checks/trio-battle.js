// Trio elite steals — formula gates + a real sim fight (2026-11-25, branch feat/trio-elite-steals).
//   FVTT_HEADLESS=true node ../snapshot-runner/bin/run.mjs --snapshot snap-trio --port 30183 --code feat/trio-elite-steals --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [], lines: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const KEYS = /Asura|Rakshasa|Mukuta|ab_|rk_bonus|mk_bonus|open_action_menu|change_damage_element|chain|Chain|PassiveCard|card reaction/;
const origLog = console.log, origErr = console.error, origWarn = console.warn;
const grab = (lvl) => (...a) => { const s = a.map((x) => (typeof x === "string" ? x : "")).join(" ");
  if (KEYS.test(s) && out.lines.length < 600) out.lines.push(`${lvl} ${s.slice(0, 280)}`); if (lvl === "E") out.errors.push(s.slice(0, 300)); };
console.log = (...a) => { try { grab("L")(...a); } catch {} return origLog(...a); };
console.warn = (...a) => { try { grab("W")(...a); } catch {} return origWarn(...a); };
console.error = (...a) => { try { grab("E")(...a); } catch {} return origErr(...a); };

for (let i = 0; i < 240 && !game.items.get("TrElAsuraBlade01"); i++) await wait(250);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(1000);
if (game.paused) await game.togglePause(false, true);
const W = (id) => game.items.get(id);
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const SF = await import(`/modules/${NS}/scripts/battle-director/skill-formulas.js`);

// ── the hero: Hina's clone in all three pieces ───────────────────────────────
const hero = await Actor.create({ ...game.actors.getName("Hina").toObject(), _id: undefined, name: "TrEl Hero" });
const ws = hero.effects.filter((e) => e.flags?.[NS]?.innerWellspring || /wellspring/i.test(e.name ?? "")).map((e) => e.id);
if (ws.length) await hero.deleteEmbeddedDocuments("ActiveEffect", ws);
// Hina's own die-swap reaction (Lucky Number) re-rolls a hit into a miss when the sim applies it blindly
const noise = hero.items.filter((i) => /Lucky Number/i.test(i.name)).map((i) => i.id);
if (noise.length) await hero.deleteEmbeddedDocuments("Item", noise);
const add = async (id) => { const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false; const [top] = await hero.createEmbeddedDocuments("Item", [s]);
  const kids = game.items.filter((i) => i.system?.container === id).map((k) => { const d = k.toObject(); delete d._id; delete d.folder; d.system.container = top.id; return d; });
  if (kids.length) await hero.createEmbeddedDocuments("Item", kids); return top; };
const blade = await add("TrElAsuraBlade01"), armor = await add("TrElRakshArmor01"), crown = await add("TrElMukutaCrown1");
const acc2 = hero.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "accessory")[1];
await applyEquipmentSwap(hero, { main: blade.id, off: null, accessory1: crown.id, accessory2: acc2?.id ?? null });
await hero.updateEmbeddedDocuments("Item", hero.items.filter((i) => !i.system?.container && String(i.system?.props?.item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === armor.id })));
await wait(500);
out.hero = { worn: hero.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped).map((i) => i.name), hp: hero.system.props.max_hp, mp: hero.system.props.max_mp,
  skills: hero.items.filter((i) => ["Asura Strike", "Iceberg"].includes(i.name)).map((i) => `${i.name}:${i.system?.container ?? "-"}`) };
ok("hero wears all three", ["Asura Blade", "Rakshasa Armor", "Mukuta"].every((n) => out.hero.worn.includes(n)), out.hero);

// ── 1. formula gates (direct) ────────────────────────────────────────────────
const rkCond = Object.values(W("TrElRakshArmPsv1").system.props.reaction_config_table)[0].condition_formula;
const ev = (expr, payload) => SF.evaluateFormula(expr, SF.buildSkillResolver({ actor: hero, payload }));
const bladeUuid = hero.items.get(blade.id).uuid;
out.gate = {
  attackWithBlade: ev(rkCond, { actionKind: "Attack", weaponUuid: bladeUuid, valueType: "hp" }),
  skillHoldingSword: ev(rkCond, { actionKind: "Skill", actionSkillType: "active", valueType: "hp" }),
  spellHoldingSword: ev(rkCond, { actionKind: "Skill", actionSkillType: "spell", valueType: "hp" }),
  itemHoldingSword: ev(rkCond, { actionKind: "Item", valueType: "hp" }),
  mpDamage: ev(rkCond, { actionKind: "Attack", weaponUuid: bladeUuid, valueType: "mp" }),
  bonusCalm: ev("5 + 5 * HAS_STATUS_CRISIS", {}),
};
ok("Rakshasa gate: attack yes, weapon skill yes, spell/item/MP no", out.gate.attackWithBlade && out.gate.skillHoldingSword && !out.gate.spellHoldingSword && !out.gate.itemHoldingSword && !out.gate.mpDamage, out.gate);
const hp0 = hero.system.props.current_hp;
await hero.update({ "system.props.current_hp": Math.floor(hero.system.props.max_hp / 2) - 1 });
await wait(1500);
out.gate.crisisStatus = hero.effects.map((e) => e.name).filter((n) => /crisis/i.test(n));
out.gate.bonusCrisis = ev("5 + 5 * HAS_STATUS_CRISIS", {});
ok("Rakshasa bonus 5 → 10 in Crisis", out.gate.bonusCalm === 5 && out.gate.bonusCrisis === 10, out.gate);
await hero.update({ "system.props.current_hp": hp0 });
await wait(800);
const abAsk = Object.values(W("TrElAsuraBldPsv1").system.props.reaction_config_table)[0].condition_formula;
out.gate.bladeAsk = { attack: ev(abAsk, { actionKind: "Attack" }), skill: ev(abAsk, { actionKind: "Skill", actionSkillType: "active" }) };
ok("Asura Blade prompt only on a basic attack", out.gate.bladeAsk.attack === 1 && out.gate.bladeAsk.skill === 0, out.gate.bladeAsk);

// ── 2. a real fight ─────────────────────────────────────────────────────────
const dd = game.actors.getName("Test Target Enemy").toObject(); delete dd._id; dd.name = "TrEl Dummy";
for (let n = 1; n <= 9; n++) dd.system.props[`affinity_${n}`] = "NA";
const dummy = await Actor.create(dd);
const bd = FUCompanion.api.experimental.battleDirector;
const ars = []; const seen = new Set(); const mp = []; const aes = []; const nums = [];
const iv = setInterval(() => {
  const ar = bd.getActiveDirector?.()?.ctx?.actionResult;
  if (!ar || seen.has(ar) || !String(ar.attacker?.name ?? "").startsWith("TrEl Hero")) return;
  if (!(ar.perTargetResults?.length || ar.chainPlan)) return;
  seen.add(ar);
  ars.push({ kind: ar.kind, skill: ar.skillName ?? ar.weapon?.name, element: ar.element ?? ar.damageType, cost: ar.costSerialized,
    chain: ar.chain ? { count: ar.chain.count, mode: ar.chain.mode, elements: ar.chain.elements } : null,
    rows: (ar.perTargetResults ?? []).map((r) => ({ name: r.name, hit: r.hit, damage: r.damage, element: r.element ?? r.damageType, affinity: r.affinity, parts: (r.damageModParts ?? r.breakdown?.parts ?? []).map?.((p) => `${p.source}:${p.op ?? ""}${p.amount}`) })),
    plan: ar.chainPlan ? { landed: ar.chainPlan.landed, strikes: ar.chainPlan.strikes.map((s) => ({ i: s.index, roll: s.roll ? `${s.roll.total}${s.roll.isCrit ? "★" : ""}` : null, o: (s.outcomes ?? []).map((o) => `${o.kind}${o.amount != null ? " " + o.amount : ""}${o.element ? " " + o.element : ""}`).join(",") })) } : null });
}, 25);
const h1 = Hooks.on("updateActor", (a, ch) => { const v = ch?.system?.props?.current_mp; if (v !== undefined && String(a.name).startsWith("TrEl Hero")) mp.push(v); });
const h2 = Hooks.on("createActiveEffect", (e) => { if (/Asura .* Edge/.test(e.name)) aes.push(`+${e.name}`); });
const h3 = Hooks.on("deleteActiveEffect", (e) => { if (/Asura .* Edge/.test(e.name)) aes.push(`-${e.name}`); });
const h4 = Hooks.on("fuDamageNumber", (p) => nums.push(`${p?.kind}:${p?.amount}:${p?.element ?? ""}:${p?.affinity ?? ""}`));
let res = null;
try {
  res = await FUCompanion.api.experimental.sim.run({
    enemies: [{ uuid: dummy.uuid, quantity: 1 }], party: [hero.uuid], maxRounds: 3, reactions: "apply", guests: false, startingZp: 0, pace: "fast",
    scripts: [
      { caster: hero.uuid, skill: "Attack", attack: true, targets: "enemy", once: true, force: "hit" },
      { caster: hero.uuid, skill: "Asura Strike", targets: "enemies", once: true },
      { caster: hero.uuid, skill: "Iceberg", targets: "enemy", once: true },
    ],
  });
} catch (e) { out.simError = String(e?.stack ?? e).slice(0, 800); }
clearInterval(iv); Hooks.off("updateActor", h1); Hooks.off("createActiveEffect", h2); Hooks.off("deleteActiveEffect", h3); Hooks.off("fuDamageNumber", h4);
out.fight = { ars, mp, aes, nums: nums.slice(0, 40), outcome: res?.outcome ?? res?.result ?? null, rounds: res?.rounds ?? null };
ok("sim ran", !!res && !out.simError, out.simError);
const atk = ars.find((a) => a.kind === "Attack");
const firstLoss = nums.find((n) => n.startsWith("loss:"));
out.paid = out.lines.filter((l) => /ab_pay/.test(l));
ok("basic attack: prompt paid MP and the hit landed as Air", !!atk && /:air:/i.test(firstLoss ?? "") && out.paid.some((l) => /debited/.test(l)), { atk, firstLoss, paid: out.paid, mp });
const strike = ars.find((a) => /Asura Strike/i.test(a.skill ?? ""));
ok("Asura Strike: chain 4 seek, four elements", !!strike && strike.chain?.count === 4 && strike.chain?.mode === "seek" && JSON.stringify(strike.chain?.elements) === '["bolt","fire","ice","air"]', strike);
const ice = ars.find((a) => /Iceberg/i.test(a.skill ?? ""));
ok("Iceberg landed (spell)", !!ice, ice);
out.parts = ars.map((a) => `${a.skill ?? a.kind}: ${a.rows.map((r) => (r.parts ?? []).join(" ")).join(" | ")}`);

console.log = origLog; console.error = origErr; console.warn = origWarn;
for (const a of [hero, dummy]) { try { await a.delete(); } catch {} }
return out;
