// Legacy gear authoring (Hako's text-only ledger items), branch feat/legacy-gear-authoring.
// Runner only (throwaway world):
//   FVTT_HEADLESS=true FVTT_CANVAS=off node bin/run.mjs --snapshot snap-gear --port 30172 --code feat/legacy-gear-authoring --eval ../../worktrees/gear-authoring/tools/snapshot-runner/checks/gear-authoring.js --dump results/gear-authoring.json
const NS = "fabula-ultima-companion";
const HAKO = "srAH3OHOoK0tvFih";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const origErr = console.error;
console.error = (...a) => { out.errors.push(a.map(String).join(" ").slice(0, 300)); return origErr(...a); };

const applied = () => { try { return JSON.stringify(game.settings.get(NS, "appliedMigrations")); } catch (e) { return ""; } };
for (let i = 0; i < 240 && !applied().includes("2026-11-25-legacy-gear-authoring"); i++) await wait(250);
const W = (id) => game.items.get(id);
const kids = (doc) => (doc.parent ? doc.parent.items : game.items).filter((i) => i.system?.container === doc.id);
const IDS = {
  manaRobe: "jnhWaWPLwZcPQ883", gambler: "fXTiW1mHRFBGSGR8", falseIdol: "L15zxS1OesPs4l2h", copycat: "Hurc7SbzCtjIAaC3",
  dominatrix: "V3R1cSiLgIfXVgRj", ballGag: "Ef9i1q5WWmWw0ZcI", biker: "HlSNO4jVVSMkSCT7", lid: "UbFTDlw59jKvWab2",
  fairy: "G8fBxPWSabEzD5V6", matrix: "4OH9H2YYxr9KhhBx", alpha: "0b9L1O59jxijKJ1I", witch: "oGop1MLCHPzdpdR5",
  brief: "6f3U2Cz826kB5ZIp", devil: "08Aj60g6ffE0XmAW", onions: "rp6c8fADXzWLAt68", avalon: "vH6Q88n3beOHjxKq",
  slimy: "g0S7SNOw5EJcJd1T", hekat: "96gMkuCexILXHXyI", yoroiOld: "Mt04b0K0gNEE9kYs", enforcer: "2MAkZpclKVJH9Hvx", cauldron: "xkeIviw9s7Ri1Vm4",
};

// 1. Migration: world items
{
  ok("migration: in the ledger", applied().includes("2026-11-25-legacy-gear-authoring"));
  const rows = {};
  for (const [k, id] of Object.entries(IDS)) {
    const it = W(id);
    rows[k] = { flagged: !!it?.getFlag(NS, "gearAuthoring"), aes: it?.effects.map((e) => e.name), kids: it ? kids(it).map((c) => c.name) : null,
      desc: String(it?.system?.props?.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) };
  }
  out.world = rows;
  const want = Object.keys(IDS).filter((k) => k !== "yoroiOld");
  ok("world: 20 items flagged (19 authored + Lid/Cauldron text)", want.every((k) => rows[k].flagged), want.filter((k) => !rows[k].flagged));
  ok("world: Yoroi Old untouched", !rows.yoroiOld.flagged);
  const passives = ["gambler", "falseIdol", "copycat", "dominatrix", "ballGag", "biker", "matrix", "alpha", "brief", "devil", "avalon", "hekat", "enforcer"];
  ok("world: passives created", passives.every((k) => rows[k].kids?.some((n) => n.endsWith("(Passive)"))), passives.filter((k) => !rows[k].kids?.some((n) => n.endsWith("(Passive)"))));
  ok("world: Biker Suit has Transform", rows.biker.kids?.includes("Transform"), rows.biker.kids);
  ok("world: transfer AEs", ["manaRobe", "gambler", "biker", "fairy", "witch", "onions", "slimy"].every((k) => rows[k].aes?.length > 0));
  const wh = kids(W(IDS.witch)).find((c) => c.name === "Cataclysm");
  ok("world: Witch Hat's Cataclysm now has rows + discount", Object.keys(wh?.system?.props?.reaction_config_table ?? {}).length > 0
    && JSON.stringify(wh.system.props.effect_table).includes("CATACLYSM_COST_DISCOUNT"));
  const lib = W("7oG8YvRYQBQAU025");
  out.cataclysmLib = Object.values(lib.system.props.effect_table).filter((r) => /adjust_cost|prompt_number/.test(r.effect_kind)).map((r) => r.cost_amount ?? r.prompt_max);
  ok("world: library Cataclysm discounted", JSON.stringify(lib.system.props.effect_table).includes("CATACLYSM_COST_DISCOUNT"));
}

// 2. Copies
{
  const copy = (actorName, itemName) => {
    const a = game.actors.getName(actorName);
    const c = a?.items.find((i) => !i.system?.container && i.name.replace(/^\+\d+\s+/, "") === itemName);
    return c ? { flagged: !!c.getFlag(NS, "gearAuthoring"), aes: c.effects.map((e) => e.name), kids: kids(c).map((k) => k.name) } : null;
  };
  out.copies = {
    blancheHekat: copy("Blanche", "Hekat Shield"), stashSlimy: copy("EXFURSION Party", "Slimy Jacket"),
    fjordDice: copy("Fjord", "Gambler's Dice"), hakoBiker: copy("Hako", "Biker Suit"), hakoWitch: copy("Hako", "Witch Hat"),
    hakoDevil: copy("Hako", "Little Devil"), reefTunic: copy("St. Reefesia", "Fairy Tunic"),
  };
  ok("copies: all flagged", Object.values(out.copies).every((c) => c?.flagged), out.copies);
  ok("copies: Blanche's Hekat has its passive", out.copies.blancheHekat?.kids.includes("Hekat Shield (Passive)"));
  ok("copies: Hako's Biker has passive + Transform", ["Biker Suit (Passive)", "Transform"].every((n) => out.copies.hakoBiker?.kids.includes(n)));
  const hc = game.actors.get(HAKO).items.find((i) => i.name === "Cataclysm");
  ok("copies: Hako Witch Hat's Cataclysm authored", Object.keys(hc?.system?.props?.reaction_config_table ?? {}).length > 0);
  const hina = game.actors.getName("Hina")?.items.find((i) => i.name === "Cataclysm");
  ok("copies: Hina's Cataclysm discounted", JSON.stringify(hina?.system?.props?.effect_table ?? {}).includes("CATACLYSM_COST_DISCOUNT"));
}

// 3. Roster pool
{
  const st = game.actors.get(HAKO).getFlag(NS, "shopRoster");
  const needing = st.pool.filter((e) => e.authoring).map((e) => game.items.get(e.id)?.name);
  const retiredNames = st.pool.filter((e) => e.retired).map((e) => game.items.get(e.id)?.name);
  out.pool = { needing, retired: st.pool.filter((e) => e.retired).map((e) => game.items.get(e.id)?.name) };
  ok("pool: only Lid Shield + Portable Cauldron still need authoring", needing.filter((n) => !out.pool.retired.includes(n)).length === 2 && needing.includes("Lid Shield") && needing.includes("Portable Cauldron"), needing);
  ok("pool: Yoroi Old retired", out.pool.retired.includes("Vengueful Yoroi Old"), out.pool.retired);
}

// 4. Stat effects on a temporary actor, equipped through the real swap
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const hina = game.actors.getName("Hina");
const temp = await Actor.create({ ...hina.toObject(), _id: undefined, name: "GA Temp", prototypeToken: { ...hina.toObject().prototypeToken, actorLink: true } });
const P = () => temp.system.props;
await wait(300);
const add = async (id) => { const s = W(id).toObject(); delete s._id; s.system.props.isEquipped = false; const [it] = await temp.createEmbeddedDocuments("Item", [s]); return it; };
const wear = async (sel) => { await applyEquipmentSwap(temp, { main: null, off: null, accessory1: null, accessory2: null, ...sel }, { allowArmor: true }); await wait(400); };
const wearArmor = async (it) => { await temp.updateEmbeddedDocuments("Item", temp.items.filter((i) => String(i.system?.props?.item_type).toLowerCase() === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === it.id }))); await wait(500); };
const snap = () => ({ def: P().defense, mdef: P().magic_defense, hp: P().max_hp, mp: P().max_mp, def: P().defense, mdef: P().magic_defense, crit: P().minimum_critical_dice, pois: P().condition_poisoned, disc: temp.flags?.[NS]?.cataclysm_cost_discount });
const base = snap();
out.hpKeys = Object.keys(P()).filter((k) => /(^|_)(hp|mp)(_|$)|health|mind/i.test(k)).map((k) => k + "=" + String(JSON.stringify(P()[k])).slice(0, 30));
out.hinaKeys = Object.entries(game.actors.getName("Hina").system.props).filter(([k]) => /max/i.test(k)).map(([k, v]) => k + "=" + String(JSON.stringify(v)).slice(0, 30));
const classes = new Set(Object.values(P().class_list ?? {}).filter((r) => r && !r.$deleted && r.class_name).map((r) => r.class_name.trim().toLowerCase())).size;
out.classes = classes;
out.temp = { base };
try {
  const ring = await add(IDS.onions), dice = await add(IDS.gambler), hat = await add(IDS.witch);
  await wear({ accessory1: ring.id }); out.temp.ring = snap();
  ok("Ring of Onions: max HP/MP +2 per class (Hina clone)", out.temp.ring.hp === base.hp + 2 * classes && out.temp.ring.mp === base.mp + 2 * classes, out.temp.ring);
  await wear({ accessory1: dice.id, accessory2: hat.id }); out.temp.diceHat = snap();
  ok("Gambler's Dice: crit on doubles from 2", Number(out.temp.diceHat.crit) === 2, out.temp.diceHat.crit);
  ok("Witch Hat: discount flag 50", Number(out.temp.diceHat.disc) === 50, out.temp.diceHat.disc);
  await wear({}); out.temp.bare = snap();
  ok("accessories off: values back", out.temp.bare.hp === base.hp && Number(out.temp.bare.crit) === Number(base.crit) && !Number(out.temp.bare.disc), out.temp.bare);
  const slimy = await add(IDS.slimy);
  await wearArmor(slimy); out.temp.slimy = snap();
  ok("Slimy Jacket: Poisoned immune", String(out.temp.slimy.pois).toUpperCase() === "IM", out.temp.slimy.pois);
  const tunic = await add(IDS.fairy);
  await wearArmor(tunic); const off = snap();
  const spell = game.items.find((i) => String(i.system?.props?.skill_type).toLowerCase() === "spell" && /scene/i.test(String(i.system?.props?.duration ?? "")) && !i.system?.container);
  await temp.createEmbeddedDocuments("ActiveEffect", [{ name: "GA Scene Spell", changes: [], flags: { [NS]: { directorAppliedBy: { skillUuid: spell?.uuid } } } }]);
  await wait(300); const on = snap();
  out.temp.fairy = { spell: spell?.name, off: off.mdef, on: on.mdef };
  ok("Fairy Tunic: +2 MDEF under a Scene spell", on.mdef === off.mdef + 2, out.temp.fairy);
  await temp.deleteEmbeddedDocuments("ActiveEffect", temp.effects.filter((e) => e.name === "GA Scene Spell").map((e) => e.id));
  const biker = await add(IDS.biker);
  await wearArmor(biker); const formless = { ...snap(), defRaw: P().defense, baseDef: P().base_defense, bonusDef: P().bonus_defense, bikerProps: ["item_def_bonus","item_mdef_bonus","isMartial","item_baseDef"].map((k) => k + "=" + JSON.stringify(temp.items.get(biker.id).system.props[k])) };
  const steel = W("GrAuBikerPsv0000").effects.find((e) => e.name === "Steel Form").toObject(); delete steel._id;
  await temp.createEmbeddedDocuments("ActiveEffect", [steel]); await wait(300); const st = snap();
  out.temp.biker = { formless, steel: st, effects: temp.items.get(biker.id)?.effects.map((e) => `${e.name}:${e.disabled ? "off" : "on"}`) };
  ok("Biker Suit: Steel Form DEF 16, Formless below", Number(st.def) === 16 && Number(formless.def) < 16, out.temp.biker);
} catch (e) { out.temp.error = String(e?.stack ?? e).slice(0, 600); ok("stat section ran", false, out.temp.error); }
// 5. False Idol math
try {
  const SF = await import(`/modules/${NS}/scripts/battle-director/skill-formulas.js`);
  const before = { hp: SF.shouldReverseHeal(temp, { resource: "hp", amount: 20 }), mp: SF.applyMpReceiving(temp, 20) };
  const tpl = W("GrAuFalseIdolPsv").effects.find((e) => e.name === "False Idol").toObject(); delete tpl._id;
  await temp.createEmbeddedDocuments("ActiveEffect", [tpl]); await wait(200);
  const after = { hp: SF.shouldReverseHeal(temp, { resource: "hp", amount: 20 }), mp: SF.applyMpReceiving(temp, 20), ignoreUndeadRow: SF.shouldReverseHeal(temp, { resource: "hp", amount: 20, row: { heal_ignore_undead: true } }) };
  out.falseIdol = { before, after };
  ok("False Idol: heals reversed, MP gain becomes loss", before.hp === false && before.mp === 20 && after.hp === true && after.mp === -20 && after.ignoreUndeadRow === true, out.falseIdol);
} catch (e) { ok("False Idol math ran", false, String(e)); }
await temp.delete();
out.errorCount = out.errors.length;
return out;
