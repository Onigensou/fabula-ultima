// Caster banner fillers — Eternal Traveler + Moonlight Dancer authoring (2026-11-26, branch feat/caster-banners).
//   FVTT_HEADLESS=true FVTT_CANVAS=off node ../snapshot-runner/bin/run.mjs --snapshot snap-caster --port 30187 --code feat/caster-banners --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const safe = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${String(e?.stack ?? e).slice(0, 600)}`); ok(name, false, "threw"); } };
const ID = {
  knives: "gmnCyBBh5qJNb8HM", cloak: "dHS9b0tj8FnO0aOQ", pack: "FU3mR0UB7xuX9ZPu", etSet: "SDyXwtWF0CgO7hIe", readyPack: "fR29CoH9EQ9ySXTs",
  chakram: "nJXcfE31UpQ0rGJI", robe: "roafy3ui2JMXHqsa", ornament: "nYQMIXsVeTZzPvhd", mdSet: "MoonDncSetDef001",
  mdT2: "MoonDncStepSkl01", mdT3: "MoonDncWaltzSk01", chakPsv: "MoonDncChakPsv01", robePsv: "MoonDncRobePsv01",
  hunterBoots: "duaQp4cjNOboR9Gk", debuffLib: "XVOWOq9oUmEECGrU",
};
for (let i = 0; i < 240 && !game.items.get(ID.mdT3); i++) await wait(250);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(1000);
const W = (id) => game.items.get(id);
const P = (id) => W(id)?.system?.props ?? {};
const plain = (h) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const SE = await import(`/modules/${NS}/scripts/battle-director/skill-effects.js`);
const DR = await import(`/modules/${NS}/scripts/battle-director/damage-ruleset.js`);
const { aliasCategories } = await import(`/modules/${NS}/scripts/battle-director/weapon-alias.js`);
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);

// ── 1. data ──────────────────────────────────────────────────────────────────
await safe("data", async () => {
  const pieces = ["knives", "cloak", "pack", "chakram", "robe", "ornament"].map((k) => ({ k, r: P(ID[k]).item_rarity, cost: P(ID[k]).item_cost, img: W(ID[k])?.img, text: plain(P(ID[k]).description) }));
  out.data = { pieces,
    etSet: Object.values(P(ID.etSet).set_bonus_table ?? {}).map((r) => `${r.pieces}:${r.bonus_ae_ref || r.bonus_skill_ref}`),
    readyPack: Object.values(P(ID.readyPack).reaction_config_table ?? {}).map((r) => `${r.reaction_max_per_round}/${r.reaction_max_scope}`),
    mdSet: Object.values(P(ID.mdSet).set_bonus_table ?? {}).map((r) => `${r.pieces}:${r.bonus_skill_ref}`),
    passives: [ID.chakPsv, ID.robePsv, ID.mdT2, ID.mdT3].map((id) => `${W(id)?.name}<${W(id)?.system?.container}`),
    rodTags: [...(W(ID.debuffLib)?.effects?.find((e) => e.name === "Lightning Rod")?.system?.tags ?? [])],
    bootsAe: W(ID.hunterBoots)?.effects?.map((e) => e.name),
  };
  ok("all six pieces Rare, priced", pieces.every((p) => p.r === "Rare") && pieces.map((p) => p.cost).join() === "1800,1800,1800,1800,2700,1320", pieces);
  ok("Moonlight icons on Forge", pieces.filter((p) => ["chakram", "robe", "ornament"].includes(p.k)).every((p) => /assets\.forge-vtt\.com/.test(p.img)), pieces.map((p) => p.img));
  ok("ET set: 2 → rest AE, 3 → Ready Pack; Ready Pack once per battle", JSON.stringify(out.data.etSet) === '["2:Eternal Traveler: Rest","3:Ready Pack"]' && out.data.readyPack.every((s) => s === "1/battle"), out.data);
  ok("MD set doc: 2 → Moonlit Step, 3 → Waltz; passives contained", JSON.stringify(out.data.mdSet) === '["2:Moonlit Step","3:Waltz"]'
    && out.data.passives.join() === `Moon Dancer Chakram (Passive)<${ID.chakram},Moonlight Dancer Robe (Passive)<${ID.robe},Moonlit Step<${ID.mdSet},Waltz<${ID.mdSet}`, out.data);
  ok("Lightning Rod tagged hazard; Hunter Boots hazard AE", out.data.rodTags.includes("hazard") && (out.data.bootsAe ?? []).includes("Hunter Boots — Hazards"), out.data);
});

// helper: clone a PC, strip skills/consumables, add + equip pieces (children copied)
const scene = canvas.scene ?? game.scenes.active ?? game.scenes.contents[0];
async function makeHero(srcName, name, ids, equip) {
  const src = game.actors.getName(srcName).toObject(); delete src._id; src.name = name;
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
  await equip(hero, got);
  await wait(2500);
  const td = await hero.getTokenDocument({ x: 1200, y: 1200 });
  const [tok] = await scene.createEmbeddedDocuments("Token", [td.toObject()]);
  return { hero: tok.actor ?? hero, base: hero, tok, got };
}
const ctxFor = (h, extra = {}) => ({ casterActor: h.hero, reactorActor: h.hero, reactorToken: h.tok, payload: { _capturedTargets: { t: [h.tok.uuid] } }, sourceUuid: null, skill: null, ...extra });
const hp = (a) => Number(a.system.props.current_hp);

// ── 2. Eternal Traveler hero ─────────────────────────────────────────────────
let et = null;
await safe("et hero", async () => {
  et = await makeHero("Hina", "Caster ET Hero", [ID.knives, ID.cloak, ID.pack], async (hero, got) => {
    const acc2 = hero.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "accessory" && i.id !== got[ID.pack].id)[0];
    await applyEquipmentSwap(hero, { main: got[ID.knives].id, off: null, accessory1: got[ID.pack].id, accessory2: acc2?.id ?? null });
    await hero.updateEmbeddedDocuments("Item", hero.items.filter((i) => !i.system?.container && String(i.system?.props?.item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === got[ID.cloak].id })));
  });
  const a = et.hero;
  const f = a.flags?.[NS] ?? {};
  out.et = { worn: a.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped).map((i) => i.name),
    granted: a.items.filter((i) => i.name === "Ready Pack").map((i) => i.name), setAes: a.effects.filter((e) => /Eternal Traveler/.test(e.name)).map((e) => e.name),
    hazardPct: f.hazard_damage_reduction_pct, restPct: f.rest_ip_recover_pct, ipRed: a.system.props.ip_reduction_value,
    alias: aliasCategories(a, "dagger", "melee") };
  ok("ET: wears 3, Ready Pack + rest AE granted", out.et.granted.length === 1 && out.et.setAes.includes("Eternal Traveler: Rest"), out.et);
  ok("ET: hazard 50 / rest IP 50 / IP −1 / knives alias", Number(out.et.hazardPct) === 50 && Number(out.et.restPct) === 50 && Number(out.et.ipRed) === 1
    && ["sword", "spear", "thrown"].every((c) => out.et.alias.includes(c)), out.et);
});

// ── 3. hazard math ───────────────────────────────────────────────────────────
await safe("hazard", async () => {
  const a = et.hero;
  const r = (hz, kw = null) => DR.computeIncomingDamage(a, { base: 100, element: "elementless", ignoreDR: true, ignoreAffinity: true, hazard: hz, keywords: kw }).damage;
  out.hazard = { plain: r(false), hazard: r(true) };
  ok("computeIncomingDamage: hazard halves (100 → 50)", out.hazard.plain === 100 && out.hazard.hazard === 50, out.hazard);
  // deal_damage path: a Burn-carried tick (canonical status AE) vs the same row with no carrier.
  const lib = W(ID.debuffLib).effects.find((e) => e.name === "Burn").toObject(); delete lib._id;
  const [burn] = await a.createEmbeddedDocuments("ActiveEffect", [lib]);
  const row = { effect_kind: "deal_damage", effect_label: "t_burn", damage_amount: "40", damage_element: "fire", damage_ignore_affinity: true, target_ref: "self", damage_verbosity: "silent" };
  await a.update({ "system.props.current_hp": 300, "system.props.max_hp": 400 });
  let h0 = hp(a); await SE.applyEffectRow(row, ctxFor(et, { sourceUuid: burn.uuid })); const tick = h0 - hp(a);
  h0 = hp(a); await SE.applyEffectRow(row, ctxFor(et)); const bare = h0 - hp(a);
  h0 = hp(a); await SE.applyEffectRow({ ...row, damage_keywords: "crush" }, ctxFor(et, { sourceUuid: burn.uuid })); const crushed = h0 - hp(a);
  out.hazard.dealDamage = { tick, bare, crushed };
  ok("deal_damage: Burn-carried tick halved; no carrier / crush untouched", tick === 20 && bare === 40 && crushed === 40, out.hazard.dealDamage);
  // dungeon path: applyToActor isHazard
  const api = FUCompanion.api.applyDamage;
  h0 = hp(a); await api.applyToActor({ baseDamage: 40, valueType: "hp", targetActor: a, sourceType: "Tile", isHazard: true, ignoreDR: true, verbosity: "silent" }); const tile = h0 - hp(a);
  h0 = hp(a); await api.applyToActor({ baseDamage: 40, valueType: "hp", targetActor: a, sourceType: "Tile", ignoreDR: true, verbosity: "silent" }); const gm = h0 - hp(a);
  out.hazard.tile = { tile, gm };
  ok("applyToActor: isHazard halves, GM-menu style hit does not", tile === 20 && gm === 40, out.hazard.tile);
});

// ── 4. Moonlight Dancer hero ─────────────────────────────────────────────────
let md = null;
await safe("md hero", async () => {
  md = await makeHero("Zarg", "Caster MD Hero", [ID.chakram, ID.robe, ID.ornament], async (hero, got) => {
    await applyEquipmentSwap(hero, { main: got[ID.chakram].id, off: null, accessory1: got[ID.ornament].id, accessory2: null });
    await hero.updateEmbeddedDocuments("Item", hero.items.filter((i) => !i.system?.container && String(i.system?.props?.item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === got[ID.robe].id })));
  });
  const a = md.hero;
  out.md = { worn: a.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped).map((i) => i.name),
    granted: a.items.filter((i) => ["Moonlit Step", "Waltz"].includes(i.name)).map((i) => i.name),
    passives: a.items.filter((i) => /\(Passive\)$/.test(i.name) && /Moon/.test(i.name)).map((i) => i.name),
    trade: SE.statusTradePairs(a) };
  ok("MD: wears 3, Moonlit Step + Waltz granted, passives present", out.md.granted.length === 2 && out.md.passives.length === 2, out.md);
  ok("MD: status trade pairs live", out.md.trade.length === 4, out.md.trade);
});

await safe("status trade", async () => {
  const a = md.hero; const c = ctxFor(md);
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "t_sw", ae_template_ref: "Swift", ae_duplicate_mode: "replace", target_ref: "t" }, c);
  const hadSwift = !!a.effects.find((e) => e.name === "Swift");
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "t_sl", ae_template_ref: "Slow", ae_duplicate_mode: "replace", target_ref: "t" }, c);
  out.trade = { hadSwift, swiftAfter: !!a.effects.find((e) => e.name === "Swift"), slow: !!a.effects.find((e) => e.name === "Slow") };
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "t_sl2", ae_template_ref: "Slow", ae_duplicate_mode: "replace", target_ref: "t" }, c);
  out.trade.slowNoBuff = !!a.effects.find((e) => e.name === "Slow");
  ok("Ornament: Slow blocked by spending Swift; lands when no Swift", out.trade.hadSwift && !out.trade.swiftAfter && !out.trade.slow && out.trade.slowNoBuff, out.trade);
});

await safe("dance memory", async () => {
  const a = md.hero;
  const dance = a.items.find((i) => i.name === "Dance");
  const step = a.items.find((i) => i.name === "Moonlit Step");
  const waltz = a.items.find((i) => i.name === "Waltz");
  // base Dance's marker, remembering "Angel Dance"
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "t_dm", ae_template_ref: "Dancing", ae_duplicate_mode: "replace", target_ref: "self", ae_remember_action: true, ae_remember_value: "Angel Dance" }, ctxFor(md, { skill: dance }));
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "ms_snap", ae_template_ref: "Last Turn Dance", ae_duplicate_mode: "replace", target_ref: "self", ae_remember_from: "Dancing", ae_duration_rounds: "scene" }, ctxFor(md, { skill: step }));
  const ltd = a.effects.find((e) => e.name === "Last Turn Dance");
  out.dance = { dancing: a.effects.find((e) => e.name === "Dancing")?.flags?.[NS]?.rememberedAction, ltd: ltd?.flags?.[NS]?.rememberedAction };
  ok("Last Turn Dance copies Dancing's remembered dance", out.dance.ltd === "Angel Dance", out.dance);
  const gain = { effect_kind: "apply_ae", effect_label: "wz_gain", ae_template_ref: "Waltz Point", ae_duplicate_mode: "add_charges", ae_initial_charges: "1", ae_initial_charges_max: "999", target_ref: "self" };
  for (let i = 0; i < 6; i++) await SE.applyEffectRow(gain, ctxFor(md, { skill: waltz }));
  out.dance.waltz6 = a.effects.find((e) => e.name === "Waltz Point")?.flags?.[NS]?.charges;
  await SE.applyEffectRow({ effect_kind: "adjust_charges", effect_label: "wz_reset", charge_ae_name: "Waltz Point", charge_operation: "set", charge_amount: "0", target_ref: "self" }, ctxFor(md, { skill: waltz }));
  out.dance.waltzReset = a.effects.find((e) => e.name === "Waltz Point")?.flags?.[NS]?.charges ?? "gone";
  ok("Waltz Point stacks past 5 (no cap) and resets to 0", Number(out.dance.waltz6) === 6 && Number(out.dance.waltzReset) === 0, out.dance);
  await SE.applyEffectRow({ effect_kind: "apply_ae", effect_label: "ms_guard", ae_template_ref: "Moonlit Step", ae_duplicate_mode: "replace", target_ref: "self", ae_lifetime_mode: "target_turn_start", ae_duration_rounds: "1" }, ctxFor(md, { skill: step }));
  out.dance.guard = a.effects.find((e) => e.name === "Moonlit Step")?.changes?.map((c) => `${c.key}+${c.value}`);
  ok("Moonlit Step buff applies (+2 DEF / M.DEF)", (out.dance.guard ?? []).length === 2, out.dance.guard);
});

for (const h of [et, md]) { try { await h?.tok?.delete(); } catch {} try { await h?.base?.delete(); } catch {} }
return out;
