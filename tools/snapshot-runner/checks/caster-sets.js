// Caster banner main sets — Fey Wanderer + Sage of Destruction + both banners (2026-11-26, feat/caster-banners).
//   FVTT_HEADLESS=true FVTT_CANVAS=off node ../snapshot-runner/bin/run.mjs --snapshot snap-caster --port 30187 --code feat/caster-banners --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [], lines: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const safe = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${String(e?.stack ?? e).slice(0, 700)}`); ok(name, false, "threw"); } };
const KEYS = /Veil|Ain Soph|Overflow|Mana Return|Gevurah|gv_bonus|kr_veil|mr_mp|ov_|Fairy|Fey Light|fl_|Moondew|Sprout|Glimmerwing|summon/i;
const oL = console.log, oW = console.warn, oE = console.error;
const grab = (lvl) => (...a) => { const s = a.map((x) => (typeof x === "string" ? x : "")).join(" "); if (KEYS.test(s) && out.lines.length < 1500) out.lines.push(`${lvl} ${s.slice(0, 260)}`); if (lvl === "E") out.errors.push(s.slice(0, 260)); };
console.log = (...a) => { try { grab("L")(...a); } catch {} return oL(...a); };
console.warn = (...a) => { try { grab("W")(...a); } catch {} return oW(...a); };
console.error = (...a) => { try { grab("E")(...a); } catch {} return oE(...a); };
const ID = {
  staff: "FeyWndStaff00001", spell: "FeyWndSproutWrd1", robe: "FeyWndRobe000001", earring: "FeyWndEarring001", fairy: "FeyWndFairyAct01", feySet: "FeyWndSetDef0001",
  rod: "SageDstKeterRod1", asa: "SageDstAinSoph01", gev: "SageDstGevurah01", band: "SageDstChesed001", sageSet: "SageDstSetDef001",
};
for (let i = 0; i < 240 && !game.tables.get("CasterBnrFey0001"); i++) await wait(250);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(1000);
if (game.paused) await game.togglePause(false, true);
const W = (id) => game.items.get(id);
const P = (id) => W(id)?.system?.props ?? {};
const SE = await import(`/modules/${NS}/scripts/battle-director/skill-effects.js`);
const SNAP = await import(`/modules/${NS}/scripts/battle-director/snapshot.js`);
const TS = await import(`/modules/${NS}/scripts/battle-director/target-survey.js`);
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const scene = canvas.scene ?? game.scenes.active ?? game.scenes.contents[0];

// ── 1. data + banners ────────────────────────────────────────────────────────
await safe("data", async () => {
  const pcs = [ID.staff, ID.robe, ID.earring, ID.rod, ID.gev, ID.band].map((id) => `${W(id)?.name}:${P(id).item_rarity}:${P(id).item_cost}:${/forge-vtt/.test(W(id)?.img ?? "")}`);
  const f = game.actors.get(ID.fairy);
  out.data = { pcs,
    feySet: Object.values(P(ID.feySet).set_bonus_table ?? {}).map((r) => `${r.pieces}:${r.bonus_skill_ref}`),
    sageSet: Object.values(P(ID.sageSet).set_bonus_table ?? {}).map((r) => `${r.pieces}:${r.bonus_skill_ref}`),
    spells: [W(ID.spell)?.system?.container === ID.staff, W(ID.asa)?.system?.container === ID.rod],
    fairy: f ? { items: f.items.map((i) => i.name), def: f.system.props.defense, mdef: f.system.props.magic_defense, mp: f.system.props.max_mp, img: f.img, presence: f.effects.map((e) => e.name) } : null,
    healTags: game.items.filter((i) => ["Heal", "Regen"].includes(i.name) && i.system.props.skill_type === "Spell").map((i) => i.system.props.skill_tags),
  };
  ok("six main pieces Rare, priced, Forge icons", pcs.every((s) => /:Rare:\d+:true$/.test(s)), pcs);
  ok("set tables", JSON.stringify(out.data.feySet) === '["2:Moondew","3:Fairy\'s Sacrifice"]' && JSON.stringify(out.data.sageSet) === '["2:Mana Return","3:Overflow Rite"]', out.data);
  ok("granted spells contained", out.data.spells.every(Boolean), out.data.spells);
  ok("Fairy actor: Fey Light + Flying, DEF 10 / M.DEF 13, MP 0, presence marker", !!f && out.data.fairy.items.includes("Fey Light") && out.data.fairy.items.includes("Flying")
    && Number(out.data.fairy.def) === 10 && Number(out.data.fairy.mdef) === 13 && Number(out.data.fairy.mp) === 0 && out.data.fairy.presence.includes("Fairy Presence"), out.data.fairy);
  ok("healing spells tagged heal", out.data.healTags.length > 0 && out.data.healTags.every((t) => /\bheal\b/.test(String(t))), out.data.healTags);
  const { listBanners } = await import(`/modules/${NS}/scripts/gacha-system/gacha-banners.js`);
  const bs = listBanners();
  const pick = (n) => bs.find((b) => b.name === n);
  out.banners = ["Sage of Destruction", "Fey Wanderer"].map((n) => { const b = pick(n); return b ? { n, epithet: b.epithet, main: b.mainSet?.setName ?? b.mainSet, lead: b.lead?.name, fillers: (b.fillerSets ?? []).map((s) => s.setName ?? s) } : { n, missing: true }; });
  ok("both banners listed: epithet, main set, lead weapon, filler", out.banners.every((b) => !b.missing)
    && out.banners[0].epithet === "Beyond the Three Veils" && out.banners[1].epithet === "Moondew Lullaby"
    && JSON.stringify(out.banners).includes("Moonlight Dancer") && JSON.stringify(out.banners).includes("Eternal Traveler"), out.banners);
});

async function makeHero(name, ids, equip) {
  const src = game.actors.getName("Hina").toObject(); delete src._id; src.name = name;
  const hero = await Actor.create(src);
  const ws = hero.effects.filter((e) => e.flags?.[NS]?.innerWellspring || /wellspring/i.test(e.name ?? "")).map((e) => e.id);
  if (ws.length) await hero.deleteEmbeddedDocuments("ActiveEffect", ws);
  const got = {};
  for (const id of ids) {
    const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false;
    const [top] = await hero.createEmbeddedDocuments("Item", [s]);
    const kids = game.items.filter((i) => i.system?.container === id).map((k) => { const d = k.toObject(); delete d._id; delete d.folder; d.system.container = top.id; return d; });
    if (kids.length) await hero.createEmbeddedDocuments("Item", kids);
    got[id] = top;
  }
  await wait(1500);
  await equip(hero, got);
  await wait(2500);
  return { hero, got };
}
const equipThree = (w, a, acc) => async (hero, got) => {
  const acc2 = hero.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "accessory" && i.id !== got[acc].id)[0];
  await applyEquipmentSwap(hero, { main: got[w].id, off: null, accessory1: got[acc].id, accessory2: acc2?.id ?? null });
  await hero.updateEmbeddedDocuments("Item", hero.items.filter((i) => !i.system?.container && String(i.system?.props?.item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === got[a].id })));
};

// ── 2. Sage hero ─────────────────────────────────────────────────────────────
let sage = null;
await safe("sage hero", async () => {
  sage = await makeHero("Caster Sage Hero", [ID.rod, ID.gev, ID.band], equipThree(ID.rod, ID.gev, ID.band));
  const a = sage.hero;
  const iceberg = a.items.find((i) => i.name === "Iceberg"), finis = a.items.find((i) => i.name === "Glacies Finis");
  const plan = (sk) => sk ? TS.resolveTargetPlan({ actor: a, skill: sk, skillTargetText: sk.system.props.skill_target }) : null;
  out.sage = { granted: a.items.filter((i) => ["Mana Return", "Overflow Rite"].includes(i.name)).map((i) => i.name),
    asa: !!a.items.find((i) => i.name === "Ain Soph Aur"), extra: SNAP.getSpellExtraTargets(a),
    iceberg: plan(iceberg) && { mode: plan(iceberg).mode, count: plan(iceberg).count }, finis: plan(finis) && { mode: plan(finis).mode, count: plan(finis).count } };
  ok("Sage: both set skills granted, Ain Soph Aur on the actor", out.sage.granted.length === 2 && out.sage.asa, out.sage);
  ok("Chesed Band: +1 target (Iceberg → up to 2, Glacies Finis → up to 4)", out.sage.extra === 1
    && out.sage.iceberg?.mode === "up_to" && out.sage.iceberg?.count >= 2 && out.sage.finis?.count >= 4, out.sage);
});

await safe("veil + asa", async () => {
  const a = sage.hero;
  const rodPsv = a.items.find((i) => i.name === "Keter Rod (Passive)");
  const asa = a.items.find((i) => i.name === "Ain Soph Aur");
  const td = await a.getTokenDocument({ x: 1400, y: 1400 }); const tdo = td.toObject(); tdo.actorLink = true;
  const [tok] = await scene.createEmbeddedDocuments("Token", [tdo]);
  const ctx = { casterActor: a, reactorActor: a, reactorToken: tok, payload: {}, sourceUuid: null, skill: rodPsv };
  const gain = Object.values(rodPsv.system.props.effect_table).find((r) => r.effect_label === "kr_veil");
  for (let i = 0; i < 4; i++) await SE.applyEffectRow(gain, ctx);
  const veil = () => a.effects.find((e) => e.name === "Veil")?.flags?.[NS]?.charges ?? 0;
  out.veil = { after4: veil() };
  // skill-scope cap key: a spell name + the actor's cycle
  const k1 = SE.reactionRoundCountKey("c", "0", "skill", 1, "iceberg#0");
  out.veil.key = k1;
  // Ain Soph Aur chain: pay 3, drop, cycle +1
  for (const l of ["asa_pay", "asa_drop", "asa_cycle"]) await SE.applyEffectRow(Object.values(asa.system.props.effect_table).find((r) => r.effect_label === l), { casterActor: a, reactorActor: a, reactorToken: tok, payload: {}, skill: asa }).catch(() => null);
  await wait(500);
  out.veil.afterAsa = veil(); out.veil.cycle = a.flags?.[NS]?.skillCapCycle;
  ok("Veil caps at 3; Ain Soph Aur spends it and bumps the skill cycle", out.veil.after4 === 3 && out.veil.afterAsa === 0 && Number(out.veil.cycle) >= 1 && k1.endsWith("s:iceberg#0"), out.veil);
  const ap = asa.system.props;
  ok("Ain Soph Aur: offensive, elementless, 50 + CHAR_LEVEL, ignore_hr, pierce, Veil gate", ap.isOffensiveSpell === true && ap.type_damage === "elementless"
    && ap.damage_bonus === "50 + CHAR_LEVEL" && ap.ignore_hr === true && ap.action_keywords === "pierce" && /AE_CHARGES_VEIL >= 3/.test(ap.availability_formula), ap);
});

// ── 3. Fey hero + a short sim (Fairy summon + Fey Light) ─────────────────────
let fey = null;
await safe("fey hero", async () => {
  fey = await makeHero("Caster Fey Hero", [ID.staff, ID.robe, ID.earring], equipThree(ID.staff, ID.robe, ID.earring));
  const a = fey.hero;
  out.fey = { granted: a.items.filter((i) => ["Moondew", "Fairy's Sacrifice"].includes(i.name)).map((i) => i.name), spell: !!a.items.find((i) => i.name === "Sprout Ward"),
    companion: a.items.filter((i) => /Glimmerwing .*\(Passive\)/.test(i.name)).map((i) => i.name) };
  ok("Fey: both set skills granted, Sprout Ward + passives on the actor", out.fey.granted.length === 2 && out.fey.spell && out.fey.companion.length === 2, out.fey);
});

await safe("sprout ward", async () => {
  const a = fey.hero;
  const spell = a.items.find((i) => i.name === "Sprout Ward");
  const td = await a.getTokenDocument({ x: 1300, y: 1300 }); const tdo = td.toObject(); tdo.actorLink = true;
  const [tok] = await scene.createEmbeddedDocuments("Token", [tdo]);
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "t_sw", ae_template_ref: "Sprout Ward", ae_duplicate_mode: "replace", target_ref: "t", ae_duration_rounds: "scene" },
    { casterActor: a, reactorActor: a, payload: { _capturedTargets: { t: [tok.uuid] } }, skill: spell });
  const ae = a.effects.find((e) => e.name === "Sprout Ward");
  out.sprout = { applied: !!ae, rc: ae?.flags?.[NS]?.reactionConfig?.reaction_config_table?.[0]?.reaction_status_filter,
    heal: Object.values(ae?.flags?.[NS]?.reactionConfig?.effect_table ?? {}).find((r) => r.effect_label === "sw_heal")?.grant_amount };
  ok("Sprout Ward lands with its Crisis-triggered heal", out.sprout.applied && out.sprout.rc === "Crisis" && /30/.test(String(out.sprout.heal)), out.sprout);
  try { await tok.delete(); } catch { /* headless canvas teardown noise */ }
});

await safe("fairy sim", async () => {
  const a = fey.hero;
  const dd = game.actors.getName("Test Target Enemy").toObject(); delete dd._id; dd.name = "Caster Dummy";
  dd.system.props.max_hp = 2000; dd.system.props.current_hp = 2000;
  const dummy = await Actor.create(dd);
  const atk = game.items.get("eMFnmNlwEks944Vk")?.toObject(); if (atk) { delete atk._id; await dummy.createEmbeddedDocuments("Item", [atk]); }
  await a.update({ "system.props.current_hp": Math.floor(Number(a.system.props.max_hp) * 0.4) });
  const spawned = []; const grants = [];
  const h1 = Hooks.on("createToken", (t) => { if (t.actor?.name === "Fairy" || t.name === "Fairy") spawned.push(t.name); });
  const h2 = Hooks.on("updateActor", (act, ch) => { const v = ch?.system?.props?.current_hp; if (v !== undefined && /Caster Fey Hero/.test(act.name)) grants.push(v); });
  let res = null;
  try {
    res = await FUCompanion.api.experimental.sim.run({ enemies: [{ uuid: dummy.uuid, quantity: 1 }], party: [a.uuid], maxRounds: 3, reactions: "apply", guests: false, startingZp: 0, pace: "fast",
      scripts: [{ caster: a.uuid, skill: "Guard", targets: "self" }] });
  } catch (e) { out.simError = String(e?.stack ?? e).slice(0, 600); }
  Hooks.off("createToken", h1); Hooks.off("updateActor", h2);
  out.fairySim = { spawned, hp: grants, rounds: res?.rounds ?? null, simError: out.simError ?? null,
    lines: out.lines.filter((l) => /Fairy|fl_|Fey Light|summon/i.test(l)).slice(0, 12) };
  ok("Fairy summoned at conflict start", spawned.length >= 1 || out.lines.some((l) => /summon.*Fairy|Fairy.*summon/i.test(l)), out.fairySim);
  ok("Fey Light heals the hero on its turn end", out.lines.some((l) => /fl_heal/.test(l)) || grants.some((v, i) => i > 0 && v > grants[i - 1]), out.fairySim);
  try { await dummy.delete(); } catch {}
});

// ── 4. Fairy's Sacrifice save, direct (would-be KO on the hero, Fairy alive) ──
await safe("fairy save", async () => {
  const a = fey.hero;
  const t3 = a.items.find((i) => i.name === "Fairy's Sacrifice");
  const src = t3?.effects?.find((e) => e.name === "Fairy's Grace")?.toObject();
  if (!src) throw new Error("no Fairy's Grace template");
  delete src._id;
  const grace = (await a.createEmbeddedDocuments("ActiveEffect", [src]))[0];
  // A living Fairy in the combat is what the condition reads; without a director this is 0,
  // so check the save twice: no fairy → lethal; then the row shape.
  await a.update({ "system.props.current_hp": 10 });
  const r0 = await SE.resolveDamageReactions({ target: a, curHp: 10, rawDamage: 50 });
  const row = grace.flags?.[NS]?.reactionConfig?.reaction_config_table?.[0];
  out.save = { noFairyDealt: r0.dealtDamage, cond: row?.condition_formula, outcome: row?.reaction_damage_outcome,
    chain: Object.values(grace.flags?.[NS]?.reactionConfig?.effect_table ?? {}).map((r) => r.effect_label) };
  ok("Fairy's Grace: no Fairy alive → no save; row = would-be KO, excludes the Fairy itself", r0.dealtDamage === 50
    && /FAIRY_PRESENCE >= 1/.test(out.save.cond) && /AE_COUNT_FAIRY_PRESENCE == 0/.test(out.save.cond) && out.save.outcome === "would_reduce_to_zero"
    && ["fg_cap", "fg_heal", "fg_dismiss", "fg_clear"].every((l) => out.save.chain.includes(l)), out.save);
});

console.log = oL; console.warn = oW; console.error = oE;
for (const h of [sage, fey]) { try { await h?.hero?.delete(); } catch {} }
return out;
