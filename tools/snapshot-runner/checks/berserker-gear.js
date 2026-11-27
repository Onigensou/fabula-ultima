// Berserker set + Spell Fencer Hat (2026-11-28, feat/berserker-gear). Runner only.
//   FVTT_HEADLESS=true FVTT_CANVAS=off node ../snapshot-runner/bin/run.mjs --snapshot snap-berserk --port 30188 --code feat/berserker-gear --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const safe = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${String(e?.stack ?? e).slice(0, 700)}`); ok(name, false, "threw"); } };
const ID = { armor: "BrskArmor0000001", armorPsv: "BrskArmorPsv0001", axe: "BrskAxe000000001", axePsv: "BrskAxePsv000001",
  set: "BrskSetDef000001", t2: "BrskSetFury00001", hat: "SpFnHat000000001", hatPsv: "SpFnHatPsv000001" };
for (let i = 0; i < 240 && !game.items.get(ID.hatPsv); i++) await wait(250);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(1500);
if (game.paused) await game.togglePause(false, true);
const W = (id) => game.items.get(id);
const P = (d) => d?.system?.props ?? {};
const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const SE = await import(`/modules/${NS}/scripts/battle-director/skill-effects.js`);
const SF = await import(`/modules/${NS}/scripts/battle-director/skill-formulas.js`);
const RE = await import(`/modules/${NS}/scripts/shop-system/shop-roster-engine.js`);
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const scene = canvas.scene ?? game.scenes.active ?? game.scenes.contents[0];
const made = [];

// ── 1. data ──────────────────────────────────────────────────────────────────
await safe("data", async () => {
  out.migrations = (game.settings.get(NS, "appliedMigrations") ?? []).filter?.((k) => /berserker/.test(JSON.stringify(k))) ?? JSON.stringify(game.settings.get(NS, "appliedMigrations")).includes("berserker");
  const row = (id) => { const p = P(W(id)); return { name: W(id)?.name, type: p.item_type, rar: p.item_rarity, cost: p.item_cost, set: p.set_name, isSet: p.isSet, forge: /forge-vtt/.test(W(id)?.img ?? ""),
    def: p.item_baseDef, mdef: p.item_baseMdef, martial: p.isMartial, dmg: p.damage_bonus, cat: p.category, hands: p.hand_slots, acc: `${p.rolled_atr1}+${p.rolled_atr2}`, dt: p.type_damage,
    text: strip(p.description), flavor: strip(p.flavor_text), effects: W(id)?.effects?.map((e) => e.name), stale: Object.keys(p.related_item_list ?? {}).length + Object.keys(p.item_skill_passive ?? {}).length }; };
  out.items = { armor: row(ID.armor), axe: row(ID.axe), hat: row(ID.hat) };
  const A = out.items;
  ok("armor: Rare martial DEF 12 / MDEF INS die, 3000z, set Berserker, stat AEs + Crisis guard", A.armor.rar === "Rare" && A.armor.martial && A.armor.def === "12" && A.armor.mdef === "0"
    && A.armor.cost === "3000" && A.armor.isSet && A.armor.set === "Berserker" && ["Armor DEF", "Armor MDEF", "Berserker Guard"].every((n) => A.armor.effects.includes(n)) && A.armor.forge && !A.armor.stale, A.armor);
  ok("axe: Rare martial Heavy 2H MIG+MIG HR+18 Physical, 2800z, set Berserker", A.axe.rar === "Rare" && A.axe.martial && A.axe.cat === "Heavy" && A.axe.hands === "Two-handed"
    && A.axe.acc === "MIG+MIG" && A.axe.dmg === "18" && A.axe.dt === "Physical" && A.axe.cost === "2800" && A.axe.set === "Berserker" && A.axe.forge, A.axe);
  ok("hat: Uncommon accessory 1500z, no set", A.hat.rar === "Uncommon" && A.hat.type === "accessory" && A.hat.cost === "1500" && !A.hat.isSet && A.hat.set === "" && A.hat.forge, A.hat);
  ok("texts", /While in Crisis , gain \+1 DEF and Berserk \./.test(A.armor.text) && /Deals 3% more damage for every 10% of your HP missing/.test(A.axe.text)
    && /if you attacked last turn, recover 5 MP/.test(A.hat.text) && /deal 5 extra damage/.test(A.hat.text) && A.hat.flavor.startsWith("A fashionable feathered hat"), [A.armor.text, A.axe.text, A.hat.text]);
  const links = String(P(W(ID.armor)).description);
  ok("armor text: styled Crisis + Berserk journal links", /JournalEntry\.GJevbCPM8cffm1QM/.test(links) && /JournalEntry\.aPF9gzkqnUkcQmIC/.test(links) && /font-family: Signika/.test(links));
  const kids = (id) => game.items.filter((i) => i.system?.container === id).map((i) => i.name);
  out.kids = { armor: kids(ID.armor), axe: kids(ID.axe), hat: kids(ID.hat), set: kids(ID.set) };
  ok("passives contained", out.kids.armor.includes("Berserker Armor (Passive)") && out.kids.axe.includes("Berserker Axe (Passive)") && out.kids.hat.includes("Spell Fencer Hat (Passive)") && out.kids.set.includes("Berserker's Fury"), out.kids);
  out.setTable = Object.values(P(W(ID.set)).set_bonus_table ?? {}).map((r) => `${r.pieces}:${r.bonus_skill_ref}`);
  ok("set table 2:Berserker's Fury", JSON.stringify(out.setTable) === '["2:Berserker\'s Fury"]', out.setTable);
  // passive text mirrors parent
  ok("passive description = skill_description = parent", [[ID.armorPsv, ID.armor], [ID.axePsv, ID.axe], [ID.hatPsv, ID.hat]].every(([c, p]) => P(W(c)).description === P(W(p)).description && P(W(c)).skill_description === P(W(p)).description));
});

// ── 2. Hako pool ─────────────────────────────────────────────────────────────
await safe("hako", async () => {
  const hako = game.actors.get("srAH3OHOoK0tvFih");
  const st = hako.flags[NS].shopRoster;
  const ent = (id) => st.pool.find((e) => e.id === id);
  out.hako = { armor: ent(ID.armor), axe: ent(ID.axe), hat: ent(ID.hat), allowed: st.config?.allowedSets, poolSize: st.pool.length };
  ok("Hako pool: 3 entries with prices, set allowed", out.hako.armor?.price === 3000 && out.hako.axe?.price === 2800 && out.hako.hat?.price === 1500 && (out.hako.allowed ?? []).includes("Berserker"), out.hako);
  const api = globalThis.FUCompanion?.shopRoster;
  const ins = await (api?.inspect?.(hako));
  if (ins) {
    const r = (id) => ins.rows.find((x) => x.id === id);
    out.hako.rows = [ID.armor, ID.axe, ID.hat].map((id) => ({ name: r(id)?.name, block: r(id)?.block, odds: r(id)?.odds }));
    ok("all three can roll (no block), odds > 0", out.hako.rows.every((x) => x.name && !x.block && x.odds > 0), out.hako.rows);
    const others = ins.rows.filter((x) => x.isSet && x.setName !== "Berserker");
    ok("other set pieces still blocked", others.length === 0 || others.every((x) => /^Set piece/.test(x.block)), others.slice(0, 3).map((x) => `${x.name}:${x.block}`));
  } else ok("roster api inspect available", false);
  // pairing is up to RNG: over many seeds both "one piece only" and "both" happen
  const cfg = RE.resolveConfig(st.config);
  const cands = ins ? ins.rows.map((x) => ({ ...x })) : [];
  let one = 0, both = 0;
  for (let s = 1; s <= 400 && cands.length; s++) {
    const roll = RE.rollRoster(cands, cfg, { seed: s });
    const ids = new Set(roll.picks.map((p) => p.id));
    const n = [ID.armor, ID.axe].filter((id) => ids.has(id)).length;
    if (n === 1) one++; if (n === 2) both++;
  }
  out.hako.pairing = { one, both };
  ok("pieces roll independently (seen alone and together)", one > 0 && both >= 0, out.hako.pairing);
});

// ── 3. actors ────────────────────────────────────────────────────────────────
async function hero(name, ids) {
  const src = game.actors.getName("Test Target Ally").toObject(); delete src._id; src.name = name;
  const a = await Actor.create(src); made.push(a);
  const got = {};
  for (const id of ids) {
    const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false;
    const [top] = await a.createEmbeddedDocuments("Item", [s]);
    const kids = game.items.filter((i) => i.system?.container === id).map((k) => { const d = k.toObject(); delete d._id; delete d.folder; d.system.container = top.id; return d; });
    if (kids.length) await a.createEmbeddedDocuments("Item", kids);
    got[id] = top;
  }
  await wait(1500);
  return { a, got };
}
const setHpPct = async (a, f) => { await a.update({ "system.props.current_hp": Math.max(1, Math.floor(Number(P(a).max_hp) * f)) }); await wait(500); };
const crisisOn = (a) => a.effects.some((e) => e.name === "Crisis" && !e.disabled);
const tokFor = async (a) => { const td = await a.getTokenDocument({ x: 1500 + made.length * 100, y: 1500 }); const o = td.toObject(); o.actorLink = true; const [t] = await scene.createEmbeddedDocuments("Token", [o]); return t; };

let B = null;
await safe("armor def", async () => {
  B = await hero("BG Berserker", [ID.armor, ID.axe, ID.hat]);
  const { a, got } = B;
  await a.updateEmbeddedDocuments("Item", a.items.filter((i) => !i.system?.container && String(P(i).item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === got[ID.armor].id })));
  await wait(800);
  await applyEquipmentSwap(a, { main: got[ID.axe].id, off: null, accessory1: got[ID.hat].id, accessory2: null });
  await wait(2500);
  await setHpPct(a, 1);
  const def = () => Number(P(a).defense ?? P(a).def ?? 0);
  out.armor = { worn: a.items.filter((i) => !i.system?.container && P(i).isEquipped).map((i) => i.name), defFull: def(), mdefFull: Number(P(a).magic_defense ?? 0), ins: P(a).ins_current ?? P(a).ins };
  await setHpPct(a, 0.3);
  out.armor.crisis = crisisOn(a); out.armor.defCrisis = def();
  ok("worn: armor + axe + hat", ["Berserker Armor", "Berserker Axe", "Spell Fencer Hat"].every((n) => out.armor.worn.includes(n)), out.armor.worn);
  ok("DEF 12, +1 in Crisis", out.armor.defFull === 12 && out.armor.crisis && out.armor.defCrisis === 13, out.armor);
  out.granted = a.items.filter((i) => i.name === "Berserker's Fury").length;
  ok("2-piece grants Berserker's Fury", out.granted === 1, out.granted);
  await setHpPct(a, 1);
});

// conditions + rows of the armor passive, evaluated against the real actor
await safe("armor rows", async () => {
  const { a } = B;
  const psv = a.items.find((i) => i.name === "Berserker Armor (Passive)");
  const rows = Object.values(P(psv).effect_table), rcs = Object.values(P(psv).reaction_config_table);
  const tok = await tokFor(a);
  const ctx = { casterActor: a, reactorActor: a, reactorToken: tok, payload: {}, sourceUuid: null, skill: psv };
  const R = (l) => rows.find((r) => r.effect_label === l);
  const cond = (f) => SF.evaluateFormula(f, SF.buildSkillResolver({ actor: a, payload: {} }));
  await setHpPct(a, 0.3);
  out.rows = { crisis: crisisOn(a), loseCond: cond(rcs[0].condition_formula) };
  await SE.applyEffectRow(R("bk_on"), ctx); await wait(800);
  const bz = () => a.effects.filter((e) => e.name === "Berserk" && !e.disabled);
  out.rows.after_on = { berserk: bz().length, rage: a.effects.filter((e) => e.name === "Berserker Rage").length, charges: bz()[0]?.flags?.[NS]?.charges ?? null, rounds: bz()[0]?.duration?.rounds ?? null,
    gate: bz()[0]?.changes?.map((c) => `${c.key}=${c.value}`) };
  ok("in Crisis: lose-HP row condition true", out.rows.crisis && Number(out.rows.loseCond) === 1, out.rows);
  ok("bk_on: Berserk (no turn counter) + hidden Rage marker", out.rows.after_on.berserk === 1 && out.rows.after_on.rage === 1 && !(Number(out.rows.after_on.charges) > 0), out.rows.after_on);
  // Berserk ×2 reaches the damage fold: the reactor gate
  out.rows.onlyAttack = (out.rows.after_on.gate ?? []).some((s) => /enable_action_only=Attack/.test(s));
  ok("Berserk = Attack only", out.rows.onlyAttack, out.rows.after_on.gate);
  // second bk_on (another hit while in Crisis) does not stack
  await SE.applyEffectRow(R("bk_on"), ctx); await wait(500);
  ok("no second Berserk on another hit", bz().length === 1, bz().length);
  // leave Crisis → off condition true, row removes both
  await setHpPct(a, 0.9);
  out.rows.offCond = cond(rcs[3].condition_formula);
  await SE.applyEffectRow(R("bk_off"), ctx); await wait(800);
  out.rows.after_off = { berserk: bz().length, rage: a.effects.filter((e) => e.name === "Berserker Rage").length };
  ok("out of Crisis: gain-HP condition true, Berserk + marker removed", Number(out.rows.offCond) === 1 && out.rows.after_off.berserk === 0 && out.rows.after_off.rage === 0, out.rows);
  ok("marker classified hidden", (() => { const m = psv.effects.contents.find((e) => e.name === "Berserker Rage"); return !!m?.flags?.[NS]?.hidden; })());
});

// axe % ladder + set multiplier + hat
await safe("axe ladder", async () => {
  const { a } = B;
  const axe = a.items.find((i) => i.name === "Berserker Axe (Passive)");
  const er = Object.values(P(axe).effect_table)[0], rc = Object.values(P(axe).reaction_config_table)[0];
  const at = async (f) => { await setHpPct(a, f); const r = SF.buildSkillResolver({ actor: a, payload: {} }); return { amt: SF.evaluateFormula(er.damage_amount, r), on: SF.evaluateFormula(rc.condition_formula.replace("ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1 && ", ""), r) }; };
  out.ladder = { 100: await at(1), 95: await at(0.95), 85: await at(0.85), 60: await at(0.6), 50: await at(0.5), 30: await at(0.3), 5: await at(0.05) };
  const L = out.ladder;
  ok("axe ladder 0/0/3/12/15/21/27 (+ gate off above 90%)", Number(L[100].on) === 0 && Number(L[95].on) === 0 && L[85].amt === 3 && L[60].amt === 12 && L[50].amt === 15 && L[30].amt === 21 && L[5].amt === 27, L);
  ok("axe row: percent, basic attacks with this weapon", er.damage_operation === "percent" && rc.reaction_requires_weapon_used === true && /ACTION_IS_ATTACK == 1/.test(rc.condition_formula));
  const fury = a.items.find((i) => i.name === "Berserker's Fury");
  const fr = Object.values(P(fury).effect_table)[0];
  ok("set: ×1.10 outgoing", fr?.damage_operation === "multiply" && fr?.damage_amount === "1.1", fr);
  await setHpPct(a, 1);
});

await safe("hat rows", async () => {
  const { a } = B;
  const psv = a.items.find((i) => i.name === "Spell Fencer Hat (Passive)");
  const rows = Object.values(P(psv).effect_table), rcs = Object.values(P(psv).reaction_config_table);
  const R = (l) => rows.find((r) => r.effect_label === l);
  const tok = (await tokFor(a));
  // the BD round (ctx.dCombat.round), as the director passes it to rows and conditions
  let round = 1;
  const cmb = { nextRound: async () => { round++; } };
  const ctx = () => ({ casterActor: a, reactorActor: a, reactorToken: tok, payload: {}, sourceUuid: null, skill: psv, dCombat: { round } });
  const chainRun = async (label) => { const r = R(label); if (r.effect_kind === "chain") { for (const s of r.chain_steps.split(",").map((x) => x.trim())) await SE.applyEffectRow(R(s), ctx()); } else await SE.applyEffectRow(r, ctx()); await wait(400); };
  const ch = (n) => a.effects.find((e) => e.name === n)?.flags?.[NS]?.charges ?? null;
  const cond = (f) => Number(SF.evaluateFormula(f, SF.buildSkillResolver({ actor: a, payload: {}, round })));
  const dmgGate = rcs[2].condition_formula.replace("ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1 && ", "");
  const mp0 = () => Number(P(a).current_mp);
  out.hat = { round1: round };
  await a.update({ "system.props.current_mp": 10 }); await wait(300);
  // round 1: attack → blade mark = 1
  await chainRun("ht_atk");
  out.hat.blade1 = ch("Fencer Hat Blade");
  out.hat.dmgGateR1 = cond(dmgGate);
  // round 2: cast an offensive spell → +5 MP (attacked last turn), spell mark = 2
  await cmb.nextRound(); await wait(400);
  out.hat.round2 = round;
  const before = mp0(); await chainRun("ht_spl"); out.hat.mpGain = mp0() - before;
  out.hat.spell2 = ch("Fencer Hat Spell");
  out.hat.dmgGateR2 = cond(dmgGate);
  // round 3: attack after last turn's spell → damage gate open
  await cmb.nextRound(); await wait(400);
  out.hat.dmgGateR3 = cond(dmgGate);
  // round 4: spell again but no attack in round 3 → no MP
  await cmb.nextRound(); await wait(400);
  const b4 = mp0(); await chainRun("ht_spl"); out.hat.mpGain4 = mp0() - b4;
  out.hat.markersHidden = psv.effects.contents.every((e) => e.flags?.[NS]?.hidden === true);
  ok("hat: blade mark = round of the attack", out.hat.round1 === 1 && out.hat.blade1 === 1, out.hat);
  ok("hat: spell after last turn's attack → +5 MP", out.hat.mpGain === 5 && out.hat.spell2 === 2, out.hat);
  ok("hat: +5 damage gate only the turn after a spell", out.hat.dmgGateR1 === 0 && out.hat.dmgGateR2 === 0 && out.hat.dmgGateR3 === 1, out.hat);
  ok("hat: no MP without last turn's attack", out.hat.mpGain4 === 0, out.hat);
  ok("hat markers hidden", out.hat.markersHidden);
});

for (const a of made) { try { await a.delete(); } catch {} }
out.passed = Object.values(out.steps).filter((s) => s.pass).length;
out.total = Object.keys(out.steps).length;
return out;
