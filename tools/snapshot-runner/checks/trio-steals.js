// Trio elite steals (2026-11-25, branch feat/trio-elite-steals): migration data, steal wiring,
// stat effects on PC clones, item cards, steal hand-over. Runner only (writes to the throwaway world).
//   node ../snapshot-runner/bin/run.mjs --snapshot snap-trio --port 30181 --code feat/trio-elite-steals --eval <this> --dump <out>
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const origErr = console.error;
console.error = (...a) => { try { out.errors.push(a.map((x) => (typeof x === "string" ? x : x?.message ?? "")).join(" ").slice(0, 300)); } catch {} return origErr(...a); };

for (let i = 0; i < 240 && !game.items.get("TrElAsuraBlade01"); i++) await wait(250);
await wait(1500);
const it = (id) => game.items.get(id);
const P = (doc) => doc?.system?.props ?? {};
const kids = (id) => game.items.filter((i) => i.system?.container === id).map((i) => i.name).sort();

// ── 1. documents ──────────────────────────────────────────────────────────────
const blade = it("TrElAsuraBlade01"), bPsv = it("TrElAsuraBldPsv1"), strike = it("TrElAsuraStrike1");
const armor = it("TrElRakshArmor01"), aPsv = it("TrElRakshArmPsv1"), crown = it("TrElMukutaCrown1"), cPsv = it("TrElMukutaPsv001");
out.blade = { name: blade?.name, img: blade?.img, ...["item_type", "category", "hand_slots", "weapon_range", "isMartial", "rolled_atr1", "rolled_atr2", "check_bonus", "damage_bonus", "type_damage", "item_rarity", "item_cost", "isSet", "set_name"].reduce((o, k) => ({ ...o, [k]: P(blade)[k] }), {}), kids: kids("TrElAsuraBlade01"), folder: blade?.folder?.name };
ok("blade stats", blade && P(blade).category === "Sword" && P(blade).hand_slots === "Two-handed" && String(P(blade).damage_bonus) === "10" && String(P(blade).check_bonus) === "0"
  && P(blade).rolled_atr1 === "DEX" && P(blade).rolled_atr2 === "MIG" && P(blade).item_rarity === "Legendary" && P(blade).isMartial === true, out.blade);
ok("blade children", JSON.stringify(out.blade.kids) === JSON.stringify(["Asura Blade (Passive)", "Asura Strike"]), out.blade.kids);
out.strike = { flags: strike?.flags?.[NS], ...["skill_type", "cost", "skill_target", "isCheck", "rolled_atr1", "rolled_atr2", "check_bonus", "damage_bonus", "type_damage", "defense_target_type", "action_keywords", "on_activate_effect_ref"].reduce((o, k) => ({ ...o, [k]: P(strike)[k] }), {}), rows: Object.keys(P(strike).effect_table ?? {}).length };
ok("strike data", strike && P(strike).cost === "30 MP" && P(strike).action_keywords === "pierce, chain 4 seek" && P(strike).defense_target_type === "mdef"
  && String(P(strike).damage_bonus) === "10" && JSON.stringify(strike.flags?.[NS]?.chainElements) === '["bolt","fire","ice","air"]' && out.strike.rows === 0, out.strike);
out.bladePsv = { effects: bPsv?.effects.map((e) => `${e.name}/${e.transfer}`), rows: Object.keys(P(bPsv).effect_table ?? {}).length, rc: Object.values(P(bPsv).reaction_config_table ?? {}).map((r) => `${r.reaction_trigger}:${r.reaction_passive_mode}:${r.reaction_effect_ref}`) };
ok("blade passive", bPsv?.effects.size === 0 && out.bladePsv.rows === 10 && out.bladePsv.rc.length === 1 && out.bladePsv.rc[0] === "creature_will_deal_damage:ask:ab_offer", out.bladePsv);
out.armor = { ...["item_type", "isMartial", "item_baseDef", "item_baseMdef", "item_rarity", "item_cost"].reduce((o, k) => ({ ...o, [k]: P(armor)[k] }), {}), effects: armor?.effects.map((e) => e.name), kids: kids("TrElRakshArmor01"), rc: Object.values(P(aPsv).reaction_config_table ?? {}).map((r) => r.condition_formula) };
ok("armor data", armor && String(P(armor).item_baseDef) === "13" && String(P(armor).item_baseMdef) === "12" && P(armor).isMartial === true && out.armor.effects.length === 2 && out.armor.kids.length === 1, out.armor);
out.crown = { ...["item_type", "item_rarity", "item_cost"].reduce((o, k) => ({ ...o, [k]: P(crown)[k] }), {}), effects: crown?.effects.map((e) => `${e.name} ${JSON.stringify(e.changes)} ${JSON.stringify(e.flags?.[NS])}`), kids: kids("TrElMukutaCrown1") };
ok("crown data", crown && P(crown).item_type === "accessory" && crown.effects.size === 2 && out.crown.kids.length === 1, out.crown);
ok("text has no set fields", [blade, armor, crown].every((d) => P(d).isSet === false && !P(d).set_name), null);

// ── 2. steal tables ───────────────────────────────────────────────────────────
const STEAL = { "0AwQ7wEDz4ISA9mA": ["Asura Blade", "TrElAsuraLoot001", "TrElAsuraBlade01"], "Rk5haXsaDemonAAA": ["Rakshasa Armor", "TrElRakshLoot001", "TrElRakshArmor01"], "amxILxU7mqQ0jKhZ": ["Mukuta", "TrElDevaLoot0001", "TrElMukutaCrown1"] };
out.steal = {};
for (const [aid, [name, lootId, worldId]] of Object.entries(STEAL)) {
  // the STORED catalog: the derived props keep a deleted key until the next load (CSB)
  const a = game.actors.get(aid); const p = a?._source?.system?.props ?? {};
  const shell = a?.items.get(lootId);
  const rows = Object.values(p.steal_percentage_table ?? {}).filter((r) => !r?.$deleted);
  out.steal[a?.name] = { rows, loot: Object.values(p.stealable_loot ?? {}).map((e) => `${e.name} -> ${e.uuid}`), shell: shell ? { cs: shell._stats?.compendiumSource, equipped: P(shell).isEquipped, kids: a.items.filter((i) => i.system?.container === lootId).length } : null, flag: a?.getFlag(NS, "trioSteals") };
  ok(`steal ${name}`, rows.length === 1 && rows[0].loot_id === name && String(rows[0].loot_percentage) === "100"
    && Object.values(p.stealable_loot ?? {}).length === 1 && shell && shell._stats?.compendiumSource === `Item.${worldId}` && P(shell).isEquipped === false, out.steal[a?.name]);
}
ok("Asura keeps its Demongrin item", !!game.actors.get("0AwQ7wEDz4ISA9mA")?.items.find((i) => i.name === "Demongrin"));

// ── 3. steal hand-over (the transferLootToCaster path: resolve world item, copy subtree) ──
const core = window["oni.ItemTransferCore"];
const temp = await Actor.create({ ...game.actors.getName("Hina").toObject(), _id: undefined, name: "TrEl Hina" });
out.handover = {};
for (const [aid, [name, lootId, worldId]] of Object.entries(STEAL)) {
  const entry = Object.values(P(game.actors.get(aid)).stealable_loot)[0];
  const emb = await fromUuid(entry.uuid);
  const src = await fromUuid(emb._stats.compendiumSource);
  const same = src && src.name === emb.name;
  const data = core.prepareItemCopyData(src);
  const [made] = await temp.createEmbeddedDocuments("Item", [data]);
  await core.copySubItemTree({ sourceItem: src, receiverActor: temp, receiverParent: made });
  const got = temp.items.filter((i) => i.system?.container === made.id).map((i) => i.name).sort();
  out.handover[name] = { resolvedTo: src?.uuid, same, children: got };
  ok(`hand-over ${name}`, same && src.id === worldId && got.length === kids(worldId).length, out.handover[name]);
}

// ── 4. stats on clones ───────────────────────────────────────────────────────
const { applyEquipmentSwap } = await import(`/modules/${NS}/scripts/battle-director/equipment-swap.js`);
const stat = (a) => ({ hp: P(a).max_hp, mp: P(a).max_mp, def: P(a).defense, mdef: P(a).magic_defense, bdef: P(a).base_defense, bmdef: P(a).base_magic_defense });
// Mukuta on Hina's clone (accessory 1, keep accessory 2)
const before = stat(temp);
const crownOn = temp.items.find((i) => i.name === "Mukuta" && !i.system?.container);
const accs = temp.items.filter((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "accessory");
const wpn = temp.items.find((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "weapon");
const off = temp.items.find((i) => !i.system?.container && i.system?.props?.isEquipped && i.system.props.item_type === "shield");
await applyEquipmentSwap(temp, { main: wpn?.id ?? null, off: off?.id ?? null, accessory1: crownOn.id, accessory2: accs[1]?.id ?? accs[0]?.id ?? null });
await wait(400);
const after = stat(temp);
// expected: the multiply runs after flat adds; take accessory 1's flat HP/MP out of the base if it had any
out.mukuta = { before, after, removedAcc: accs[0]?.name, ratioHp: after.hp / before.hp, ratioMp: after.mp / before.mp };
ok("Mukuta raises Max HP and MP ~12% (whole numbers)", Number.isInteger(after.hp) && Number.isInteger(after.mp) && after.hp > before.hp && after.mp > before.mp
  && Math.abs(out.mukuta.ratioHp - 1.12) < 0.06 && Math.abs(out.mukuta.ratioMp - 1.12) < 0.06, out.mukuta);
await applyEquipmentSwap(temp, { main: wpn?.id ?? null, off: off?.id ?? null, accessory1: accs[0]?.id ?? null, accessory2: accs[1]?.id ?? null });
await wait(400);
out.mukutaOff = stat(temp);
ok("Mukuta off restores stats", out.mukutaOff.hp === before.hp && out.mukutaOff.mp === before.mp, out.mukutaOff);

// Rakshasa Armor on Blanche's clone
const tb = await Actor.create({ ...game.actors.getName("Blanche").toObject(), _id: undefined, name: "TrEl Blanche" });
const bBefore = stat(tb);
const s = armor.toObject(); delete s._id; s.system.props.isEquipped = false;
const [ra] = await tb.createEmbeddedDocuments("Item", [s]);
await tb.updateEmbeddedDocuments("Item", tb.items.filter((i) => !i.system?.container && String(i.system?.props?.item_type) === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === ra.id })));
await wait(400);
out.rakshasaArmor = { before: bBefore, after: stat(tb) };
ok("Rakshasa Armor sets base DEF 13 / M.DEF 12", out.rakshasaArmor.after.bdef === 13 && out.rakshasaArmor.after.bmdef === 12, out.rakshasaArmor);

// ── 5. formula identifiers used by the passives ────────────────────────────────
const SF = await import(`/modules/${NS}/scripts/battle-director/skill-formulas.js`);
out.sfExports = Object.keys(SF).filter((k) => /eval|resolve|formula/i.test(k)).slice(0, 12);

// ── 6. item cards (what players see) ──────────────────────────────────────────
try {
  const T = await import(`/modules/${NS}/scripts/linked-text/lt-terms.js`);
  const C = await import(`/modules/${NS}/scripts/linked-text/lt-itemcard.js`);
  out.cards = {};
  for (const d of [blade, armor, crown]) {
    const term = T.resolveUuid(d.uuid, d.name);
    const html = C.cardHTML(term, {});
    out.cards[d.name] = { len: html.length, grants: /Grants/.test(html), strike: /Asura Strike/.test(html), legendaryColor: /#7a3fb5/i.test(html), text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 420) };
  }
  ok("blade card lists Asura Strike under Grants", out.cards["Asura Blade"]?.grants && out.cards["Asura Blade"]?.strike, out.cards["Asura Blade"]);
} catch (e) { out.cardError = String(e?.stack ?? e).slice(0, 500); ok("cards render", false, out.cardError); }

for (const a of [temp, tb]) { try { await a.delete(); } catch {} }
console.error = origErr;
out.migLog = (() => { try { const l = game.settings.get(NS, "appliedMigrations"); return JSON.stringify(l).match(/trio-elite-steals[^}]{0,400}/)?.[0] ?? null; } catch (e) { return "ERR " + e.message; } })();
return out;
