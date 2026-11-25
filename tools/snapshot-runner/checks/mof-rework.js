// Monster of Frankensteiner rework — data + a real sim fight + the Spark of Life save (2026-11-26,
// branch feat/frankensteiner-rework).
//   FVTT_HEADLESS=true FVTT_CANVAS=off node ../snapshot-runner/bin/run.mjs --snapshot snap-mof --port 30186 --code feat/frankensteiner-rework --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [], lines: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const KEYS = /Frankenst|Bolt Absorb|Silver Bolt|Overcharge|Spark of Life|Galvanic|sb_|lr_|mj_|gf_|sp_|absorb|takes_damage|Thunderbolt|affinity|RESOLVE|resolution|loss|Mof Hero/i;
const origLog = console.log, origErr = console.error, origWarn = console.warn;
const grab = (lvl) => (...a) => { const s = a.map((x) => (typeof x === "string" ? x : "")).join(" ");
  if (KEYS.test(s) && out.lines.length < 2500) out.lines.push(`${lvl} ${s.slice(0, 300)}`); if (lvl === "E") out.errors.push(s.slice(0, 300)); };
console.log = (...a) => { try { grab("L")(...a); } catch {} return origLog(...a); };
console.warn = (...a) => { try { grab("W")(...a); } catch {} return origWarn(...a); };
console.error = (...a) => { try { grab("E")(...a); } catch {} return origErr(...a); };

const ID = { jacket: "1RLyAV6Hx7n1PmBb", silver: "aPVUpJ1KwspTpUTV", rod: "nvsyVWdA6cevPiIL", set: "2Z502E09PMrRdWat", t2: "qKDhWuKfcffBKyAF", t3: "MofSparkOfLife01" };
for (let i = 0; i < 240 && !game.items.get(ID.t3); i++) await wait(250);
for (let i = 0; i < 240 && !FUCompanion.api.experimental?.sim?.mode; i++) await wait(250);
await wait(1000);
if (game.paused) await game.togglePause(false, true);
const W = (id) => game.items.get(id);
const P = (id) => W(id)?.system?.props ?? {};
const plain = (h) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ── 1. data ──────────────────────────────────────────────────────────────────
out.data = {
  jacket: { r: P(ID.jacket).item_rarity, cost: P(ID.jacket).item_cost, def: P(ID.jacket).item_def_bonus, mdef: P(ID.jacket).item_mdef_bonus, text: plain(P(ID.jacket).description) },
  silver: { r: P(ID.silver).item_rarity, cost: P(ID.silver).item_cost, text: plain(P(ID.silver).description) },
  rod: { r: P(ID.rod).item_rarity, cost: P(ID.rod).item_cost, hr: P(ID.rod).damage_bonus, name: W(ID.rod)?.name, text: plain(P(ID.rod).description), flavor: plain(P(ID.rod).flavor_text) },
  set: Object.values(P(ID.set).set_bonus_table ?? {}).map((r) => `${r.pieces}:${r.bonus_skill_ref}`),
  setDesc: plain(P(ID.jacket).set_description),
  t2: plain(P(ID.t2).description), t3: plain(P(ID.t3).description), t3container: W(ID.t3)?.system?.container,
};
ok("pieces Rare + prices + Jacket +1/+1 + Rod HR 6", out.data.jacket.r === "Rare" && out.data.silver.r === "Rare" && out.data.rod.r === "Rare"
  && out.data.jacket.cost === "3000" && out.data.silver.cost === "1500" && out.data.rod.cost === "2500" && out.data.rod.hr === "6"
  && out.data.jacket.def === "1" && out.data.jacket.mdef === "1", out.data);
ok("set table: 2 → Galvanic Feedback, 3 → Spark of Life (child of the set)", JSON.stringify(out.data.set) === '["2:Galvanic Feedback","3:Spark of Life"]' && out.data.t3container === ID.set, out.data.set);
const { listBanners } = await import(`/modules/${NS}/scripts/gacha-system/gacha-banners.js`);
out.banners = listBanners().map((t) => t.name);
ok("banner out of the gacha, others kept", !out.banners.includes("Monster of Frankensteiner") && out.banners.includes("Oathsworn Paladin"), { banners: out.banners, folder: game.tables.get("5vK0Z321GuAYlywn")?.folder?.name });

// ── 2. hero in all three pieces ──────────────────────────────────────────────
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const src = game.actors.getName("Hina").toObject(); delete src._id; src.name = "Mof Hero";
src.system.props.affinity_3 = "NA";
const hero = await Actor.create(src);
const ws = hero.effects.filter((e) => e.flags?.[NS]?.innerWellspring || /wellspring/i.test(e.name ?? "")).map((e) => e.id);
if (ws.length) await hero.deleteEmbeddedDocuments("ActiveEffect", ws);
// Strip Hina's own kit (Magic Mirror bounced the Thunderbolt, Absorb MP / Painful Lesson fired):
// every skill + consumable, keep only gear. The set pieces are added after this.
const noise = hero.items.filter((i) => { const p = i.system?.props ?? {}; return !i.system?.container && (!!p.skill_type || p.item_type === "consumable" || /Mirror|Life Charm/i.test(i.name)); }).map((i) => i.id);
if (noise.length) await hero.deleteEmbeddedDocuments("Item", noise);
const add = async (id) => { const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false; const [top] = await hero.createEmbeddedDocuments("Item", [s]);
  const kids = game.items.filter((i) => i.system?.container === id).map((k) => { const d = k.toObject(); delete d._id; delete d.folder; d.system.container = top.id; return d; });
  if (kids.length) await hero.createEmbeddedDocuments("Item", kids); return top; };
const rod = await add(ID.rod), silver = await add(ID.silver), jacket = await add(ID.jacket);
const acc2 = hero.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "accessory" && i.id !== silver.id)[0];
await applyEquipmentSwap(hero, { main: rod.id, off: null, accessory1: silver.id, accessory2: acc2?.id ?? null });
await hero.updateEmbeddedDocuments("Item", hero.items.filter((i) => !i.system?.container && String(i.system?.props?.item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === jacket.id })));
// Low defenses so every scripted hit lands (the check is about what the hit does).
await hero.createEmbeddedDocuments("ActiveEffect", [{ name: "Mof Test Exposed", img: "icons/svg/downgrade.svg", disabled: false, transfer: false,
  changes: [{ key: "defense", mode: 5, priority: 99, value: "0" }, { key: "magic_defense", mode: 5, priority: 99, value: "0" }] }]);
// Force the Rod's Paralyze roll to 100% on THIS copy so the on-hit path is checked deterministically.
{ const rp = hero.items.find((i) => i.name === "Lightning Rod (Passive)"); const et = foundry.utils.deepClone(rp.system.props.effect_table);
  for (const r of Object.values(et)) if (r.effect_label === "lr_para") r.ae_chance_percent = "100";
  await rp.update({ "system.props.effect_table": null }); await rp.update({ "system.props.effect_table": et }); }
await wait(2500);
out.hero = {
  worn: hero.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped).map((i) => i.name),
  setSkills: hero.items.filter((i) => ["Galvanic Feedback", "Spark of Life"].includes(i.name)).map((i) => i.name),
  def: hero.system.props.defense, mdef: hero.system.props.magic_defense,
};
ok("hero wears all three; both set skills granted", ["Stitched-Up Jacket", "Silver Bolt", "Lightning Rod"].every((n) => out.hero.worn.includes(n))
  && out.hero.setSkills.includes("Galvanic Feedback") && out.hero.setSkills.includes("Spark of Life"), out.hero);

// ── 3. the fight ─────────────────────────────────────────────────────────────
const dd = game.actors.getName("Test Target Enemy").toObject(); delete dd._id; dd.name = "Mof Dummy";
for (let n = 1; n <= 9; n++) dd.system.props[`affinity_${n}`] = "NA";
dd.system.props.current_mp = 400; dd.system.props.max_mp = 400;
const dummy = await Actor.create(dd);
for (const id of ["eMFnmNlwEks944Vk", "C6FXZJQz0HqM6ASo"]) { const s = W(id).toObject(); delete s._id; await dummy.createEmbeddedDocuments("Item", [s]); }
const bd = FUCompanion.api.experimental.battleDirector;
const ars = []; const seen = new Set(); const mp = []; const aes = []; const nums = []; const para = [];
const iv = setInterval(() => {
  const ar = bd.getActiveDirector?.()?.ctx?.actionResult;
  if (!ar || seen.has(ar) || !(ar.perTargetResults?.length)) return;
  if (!/^Mof /.test(String(ar.attacker?.name ?? ""))) return;
  seen.add(ar);
  ars.push({ by: ar.attacker?.name, kind: ar.kind, skill: ar.skillName ?? ar.weapon?.name, element: ar.damageType,
    rows: (ar.perTargetResults ?? []).map((r) => ({ name: r.name, hit: r.hit, damage: r.damage, element: r.element ?? r.damageType, affinity: r.affinity,
      parts: (r.reactionParts ?? r.damageModParts ?? []).map?.((p) => `${p.source}:${p.amount}`) })) });
}, 25);
const effName = (e) => `${e.parent?.name}:${e.name}`;
const h1 = Hooks.on("updateActor", (a, ch) => { const v = ch?.system?.props?.current_mp; if (v !== undefined && /^Mof Hero/.test(a.name)) mp.push(v); });
const h2 = Hooks.on("createActiveEffect", (e) => { if (/Mof /.test(e.parent?.name ?? "")) { aes.push(`+${effName(e)}${e.flags?.[NS]?.charges != null ? "(" + e.flags[NS].charges + ")" : ""}`); if (e.name === "Paralyzed") para.push(e.parent.name); } });
const h3 = Hooks.on("deleteActiveEffect", (e) => { if (/Mof /.test(e.parent?.name ?? "")) aes.push(`-${effName(e)}`); });
const h4 = Hooks.on("updateActiveEffect", (e, ch) => { const c = ch?.flags?.[NS]?.charges; if (c !== undefined && /Mof /.test(e.parent?.name ?? "")) aes.push(`~${effName(e)}=${c}`); });
const h5 = Hooks.on("fuDamageNumber", (p) => nums.push(`${p?.kind}:${p?.amount}:${p?.element ?? ""}:${p?.affinity ?? ""}`));
let res = null;
try {
  res = await FUCompanion.api.experimental.sim.run({
    enemies: [{ uuid: dummy.uuid, quantity: 1 }], party: [hero.uuid], maxRounds: 4, reactions: "apply", guests: false, startingZp: 0, pace: "fast",
    scripts: [
      { caster: hero.uuid, skill: "Attack", attack: true, targets: "enemy", once: true, force: "hit" },
      { caster: hero.uuid, skill: "Attack", attack: true, targets: "enemy", once: true, force: "hit" },
      { caster: hero.uuid, skill: "Attack", attack: true, targets: "enemy", once: true, force: "hit" },
      { caster: hero.uuid, skill: "Attack", attack: true, targets: "enemy", once: true, force: "hit" },
      { caster: dummy.uuid, skill: "Thunderbolt", targets: "enemy", once: true, force: "hit" },
      { caster: dummy.uuid, skill: "Fire Bolt", targets: "enemy", once: true, force: "hit" },
      { caster: dummy.uuid, skill: "Thunderbolt", targets: "enemy", once: true, force: "hit" },
      { caster: dummy.uuid, skill: "Thunderbolt", targets: "enemy", once: true, force: "hit" },
    ],
  });
} catch (e) { out.simError = String(e?.stack ?? e).slice(0, 800); }
clearInterval(iv); for (const [h, id] of [["updateActor", h1], ["createActiveEffect", h2], ["deleteActiveEffect", h3], ["updateActiveEffect", h4], ["fuDamageNumber", h5]]) Hooks.off(h, id);
out.fight = { ars, mp, aes, para, nums: nums.slice(0, 50), outcome: res?.outcome ?? res?.result ?? null, rounds: res?.rounds ?? null };
ok("sim ran", !!res && !out.simError, out.simError);
const onHero = ars.filter((a) => a.by === "Mof Dummy");
const tb = onHero.filter((a) => a.skill === "Thunderbolt");
ok("Thunderbolt absorbed by the Jacket charge", tb.length > 0 && tb[0].rows[0]?.affinity === "AB", tb);
ok("Jacket charge spent on absorb and refilled", aes.some((s) => (s.startsWith("-Mof Hero") && s.endsWith(":Bolt Absorb"))) && aes.filter((s) => (s.startsWith("+Mof Hero") && s.endsWith(":Bolt Absorb") || s.startsWith("+Mof Hero") && s.includes(":Bolt Absorb("))).length >= 2, aes);
const phys = onHero.filter((a) => a.skill === "Fire Bolt").pop();   // last snapshot = after the pill
ok("Silver Bolt converts the Fire hit to Bolt, NOT absorbed (option B)", !!phys && /bolt/i.test(String(phys.rows[0]?.element)) && phys.rows[0]?.affinity !== "AB" && phys.rows[0]?.damage > 0, phys);
ok("Strong gained", aes.some((s) => (s.startsWith("+Mof Hero") && s.endsWith(":Strong") || s.startsWith("+Mof Hero") && s.includes(":Strong("))), aes);
ok("Overcharge stacks gained", aes.filter((s) => (s.startsWith("+Mof Hero") && s.endsWith(":Overcharge") || s.startsWith("+Mof Hero") && s.includes(":Overcharge("))).length >= 2, aes);
const heroAtk = ars.filter((a) => String(a.by).startsWith("Mof Hero"));
out.rodParts = heroAtk.map((a) => (a.rows[0]?.parts ?? []).join(" "));
const hitDmg = heroAtk.map((a) => a.rows[0]).filter((r) => r?.hit).map((r) => r.damage);
out.rodDamage = hitDmg;
ok("Rod attack carries the Overcharge bonus (+5 per stack)", out.lines.some((l) => l.includes("lr_bonus")) || (Math.max(...hitDmg) - Math.min(...hitDmg) >= 5), hitDmg);
ok("Rod on-hit Paralyze lands (chance forced to 100% on the test copy)", para.includes("Mof Dummy"), { para, lines: out.lines.filter((l) => /lr_para|Paralyz/.test(l)).slice(0, 6) });
ok("2-Piece: MP recovered on absorb", out.lines.some((l) => /gf_mp/.test(l)) || mp.length > 0, { mp, gf: out.lines.filter((l) => /gf_mp/.test(l)).slice(0, 4) });
ok("3-Piece: Spark of Life gained on Bolt absorb", aes.some((s) => (s.startsWith("+Mof Hero") && s.endsWith(":Spark of Life") || s.startsWith("+Mof Hero") && s.includes(":Spark of Life(")) || /Spark of Life=/.test(s)), aes);

// ── 4. Spark of Life save, direct (resolveDamageReactions at HP-write) ────────
const SE = await import(`/modules/${NS}/scripts/battle-director/skill-effects.js`);
const sparkSrc = hero.items.find((i) => i.name === "Spark of Life")?.effects?.find((e) => e.name === "Spark of Life")?.toObject();
const old = hero.effects.filter((e) => e.name === "Spark of Life").map((e) => e.id);
if (old.length) await hero.deleteEmbeddedDocuments("ActiveEffect", old);
const mk = async (n) => { const d = foundry.utils.deepClone(sparkSrc); delete d._id; d.flags[NS].charges = n; const [e] = await hero.createEmbeddedDocuments("ActiveEffect", [d]); return e; };
await hero.update({ "system.props.current_hp": 10 });
const two = await mk(2);
const r2 = await SE.resolveDamageReactions({ target: hero, curHp: 10, rawDamage: 50 });
await two.delete();
const three = await mk(3);
const r3 = await SE.resolveDamageReactions({ target: hero, curHp: 10, rawDamage: 50 });
out.save = { two: { dealt: r2.dealtDamage, fired: r2.fired }, three: { dealt: r3.dealtDamage, fired: r3.fired, consumed: r3.consumedAeIds, followUp: (r3.followUp ?? []).map((f) => f.rows.map((r) => r.effect_label).join(",")) }, sparkId: three.id };
ok("Spark of Life reached 3 and cleared at conflict end", aes.some((s) => /Spark of Life=3/.test(s)) && aes.some((s) => (s.startsWith("-Mof Hero") && s.endsWith(":Spark of Life"))), aes.filter((s) => /Spark/.test(s)));
ok("Spark at 2: no save (lethal)", r2.dealtDamage === 50, out.save.two);
ok("Spark at 3: save fires, AE spent, follow-up sets HP to Crisis", r3.dealtDamage === 9 && (r3.consumedAeIds ?? []).includes(three.id)
  && out.save.three.followUp.some((s) => /sl_heal/.test(s)), out.save.three);

console.log = origLog; console.error = origErr; console.warn = origWarn;
for (const a of [hero, dummy]) { try { await a.delete(); } catch {} }
return out;
