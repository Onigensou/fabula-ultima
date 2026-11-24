// Shop roster (Hako rerolls her equipment at Rest), branch feat/hako-roster.
// Runner only (writes to the throwaway world):
//   FVTT_HEADLESS=true FVTT_CANVAS=off node bin/run.mjs --snapshot snap-roster --port 30171 --code feat/hako-roster --eval checks/shop-roster.js --dump results/shop-roster.json
const NS = "fabula-ultima-companion";
const HAKO = "srAH3OHOoK0tvFih";
const EQ = ["weapon", "armor", "shield", "accessory"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const origErr = console.error;
console.error = (...a) => { out.errors.push(a.map(String).join(" ").slice(0, 300)); return origErr(...a); };

for (let i = 0; i < 240 && !game.actors.get(HAKO)?.flags?.[NS]?.shopRoster; i++) await wait(250);
const hako = game.actors.get(HAKO);
const R = FUCompanion.shopRoster;
const type = (i) => String(i.system?.props?.item_type ?? "").toLowerCase();
const top = () => hako.items.filter((i) => !i.system?.container);
const equip = () => top().filter((i) => EQ.includes(type(i)));
const byType = () => Object.fromEntries(EQ.map((t) => [t, equip().filter((i) => type(i) === t).length]));
const names = () => equip().map((i) => i.name).sort();
const fixedSnap = () => top().filter((i) => !EQ.includes(type(i))).map((i) => `${i.name}:${i.system.props.item_quantity}`).sort();

// 1. migration
{
  const st = R.getState(hako);
  const log = (() => { try { return JSON.stringify(game.settings.get(NS, "appliedMigrations")).includes("2026-11-25-hako-shop-roster"); } catch (e) { return String(e); } })();
  const rar = (n) => game.items.find((i) => i.name === n && !i.system?.container)?.system?.props?.item_rarity;
  const cons = top().filter((i) => type(i) === "consumable").map((i) => [i.name, i.flags?.[NS]?.baseQty]);
  out.migration = { log, pool: st?.pool?.length, authoring: st?.pool?.filter((e) => e.authoring).length, retired: st?.pool?.filter((e) => e.retired).length, current: st?.current?.length, cons, biker: rar("Biker Suit"), heat: rar("Heat HANDS Replica") };
  ok("migration: recorded in the ledger", log === true, log);
  ok("migration: pool seeded", st?.enabled && st.pool.length >= 75, out.migration.pool);
  ok("migration: current = Ch4 equipment", st?.current?.length === equip().length, [st?.current?.length, equip().length]);
  ok("migration: consumables have baseQty", cons.length > 0 && cons.every(([, q]) => q > 0), cons);
  ok("migration: rarities set", rar("Biker Suit") === "Rare" && rar("Heat HANDS Replica") === "Rare");
}

// 2. inspect
let ins = await R.inspect(hako);
{
  const by = (f) => ins.rows.filter(f).map((r) => r.name);
  out.inspect = {
    rows: ins.rows.length, missing: ins.missing.length,
    canAppear: by((r) => !r.block).length, owned: by((r) => !r.block && r.owned.length),
    blocked: Object.fromEntries(ins.rows.filter((r) => r.block).map((r) => [r.name, r.block])),
    perRarity: ins.perRarity,
  };
  ok("inspect: Giants Belt blocked as stealable", /Stealable/.test(out.inspect.blocked["Giants Belt"] ?? ""), out.inspect.blocked["Giants Belt"]);
  ok("inspect: set pieces blocked", /Set piece/.test(out.inspect.blocked["Swimsuit"] ?? ""));
  ok("inspect: needs authoring blocked", out.inspect.blocked["Little Devil"] === "Needs authoring");
  ok("inspect: owned detected (Golden Apple → Hina)", ins.rows.find((r) => r.name === "Golden Apple")?.owned.includes("Hina"), ins.rows.find((r) => r.name === "Golden Apple")?.owned);
}

// 3. reroll
const fixedBefore = fixedSnap();
const before = names();
let res = await R.reroll(hako, { reason: "Reroll", refill: false });
{
  const st = R.getState(hako);
  const card = game.messages.get(st.lastCardId);
  out.reroll1 = { byType: byType(), names: names(), warnings: res.warnings, sig: res.picks.find((p) => p.why === "signature")?.id, card: !!card, cardButtons: (card?.content.match(/data-roster=/g) ?? []).length, whisper: card?.whisper?.length };
  ok("reroll: quotas 8/4/2/5", JSON.stringify(byType()) === JSON.stringify({ weapon: 8, armor: 4, shield: 2, accessory: 5 }), byType());
  ok("reroll: fixed listings untouched", JSON.stringify(fixedSnap()) === JSON.stringify(fixedBefore));
  ok("reroll: roster changed", JSON.stringify(names()) !== JSON.stringify(before));
  ok("reroll: listings carry rosterSource + qty 1", equip().every((i) => i.flags?.[NS]?.rosterSource && String(i.system.props.item_quantity) === "1"));
  ok("reroll: no blocked/authoring item on sale", !equip().some((i) => out.inspect.blocked[i.name]), names().filter((n) => out.inspect.blocked[n]));
  ok("reroll: signature Legendary", !!out.reroll1.sig);
  ok("reroll: GM card with 4 buttons", card && out.reroll1.cardButtons === 4 && card.whisper.length > 0);
  const sub = equip().filter((i) => hako.items.some((k) => k.system?.container === i.id));
  out.reroll1.withSubitems = sub.map((i) => i.name);
  const orphans = hako.items.filter((i) => i.system?.container && !hako.items.get(i.system.container));
  ok("reroll: no orphaned sub-items", orphans.length === 0, orphans.map((i) => i.name));
}

// 4. a purchase makes it owned (copy the listing like a buy does)
{
  const hina = game.actors.getName("Hina");
  const listing = equip().find((i) => type(i) === "weapon");
  const data = listing.toObject(); delete data._id;
  await hina.createEmbeddedDocuments("Item", [data]);
  await listing.update({ "system.props.item_quantity": "0" });
  ins = await R.inspect(hako);
  const row = ins.rows.find((r) => r.id === listing.flags[NS].rosterSource);
  out.purchase = { item: listing.name, owned: row?.owned, tier: row?.tier };
  ok("purchase: bought item becomes owned (tier 1)", row?.owned.includes("Hina") && row.tier === 1, out.purchase);
}

// 5. never run out: the party owns every shield
{
  const stash = (await FUCompanion.api.getCurrentGameDb()); const db = stash.source ?? stash.db;
  const shieldIds = ins.rows.filter((r) => r.type === "shield" && !r.block && !r.owned.length).map((r) => r.id);
  for (const id of shieldIds) { const d = game.items.get(id).toObject(); delete d._id; await db.createEmbeddedDocuments("Item", [d]); }
  res = await R.reroll(hako, { reason: "Reroll", refill: false });
  const sh = res.picks.filter((p) => game.items.get(p.id)?.system?.props?.item_type === "shield");
  out.allShieldsOwned = { stashed: shieldIds.length, shields: sh.map((p) => [game.items.get(p.id).name, p.tier]), byType: byType() };
  ok("fallback: shields still stocked, all REPEAT", sh.length === 2 && sh.every((p) => p.tier === 1), out.allShieldsOwned);
  ok("fallback: card says REPEAT", game.messages.get(R.getState(hako).lastCardId)?.content.includes("REPEAT"));
}

// 6. undo
{
  const st = R.getState(hako);
  const prevNames = st.previous.map((e) => game.items.get(e.id).name).sort();
  await R.undo(hako);
  ok("undo: previous roster back", JSON.stringify(names()) === JSON.stringify(prevNames), { now: names(), prevNames });
  ok("undo: previous cleared", R.getState(hako).previous === null);
}

// 7. lock: Rest keeps equipment, refills consumables
{
  const vac = top().find((i) => i.name === "Vaccine");
  await vac.update({ "system.props.item_quantity": "1" });
  await R.setLocked(hako, true);
  await R.patchState(hako, { lastRestockAt: 0 });
  const eq = names();
  await R.onRest();
  ok("lock: equipment kept", JSON.stringify(names()) === JSON.stringify(eq));
  ok("lock: consumable refilled", String(top().find((i) => i.name === "Vaccine").system.props.item_quantity) === "5", top().find((i) => i.name === "Vaccine").system.props.item_quantity);
}

// 8. cooldown: a second Rest within 12 h keeps everything
{
  await R.setLocked(hako, false);
  await R.patchState(hako, { lastRestockAt: Date.now() - 3600e3 });
  const eq = names();
  await R.onRest();
  ok("cooldown: second Rest keeps roster", JSON.stringify(names()) === JSON.stringify(eq));
}

// 9. the real Rest path (RestAPI.perform awaits the restock)
{
  await R.patchState(hako, { lastRestockAt: 0 });
  const eq = names();
  const t0 = Date.now();
  await CampSystem.RestAPI.perform();
  const st = R.getState(hako);
  out.restPath = { ms: Date.now() - t0, lastReason: st.history.at(-1)?.reason, changed: JSON.stringify(names()) !== JSON.stringify(eq) };
  ok("rest: perform() restocked before returning", st.history.at(-1)?.reason === "Rest" && Date.now() - st.lastRestockAt < 60e3 && out.restPath.changed, out.restPath);
}

// 10. console + shop window button
{
  const c = await FUCompanion.shopRosterConsole.open(hako);
  for (let i = 0; i < 40 && !document.querySelector(".fu-rc-tbl tbody tr"); i++) await wait(100);
  const rows = document.querySelectorAll(".fu-rc-tbl tbody tr").length;
  document.querySelector('.fu-rc [data-filter="auth"]')?.click();
  const authRows = document.querySelectorAll(".fu-rc-tbl tbody tr").length;
  document.querySelector('.fu-rc [data-tab="rules"]')?.click();
  const rulesInputs = document.querySelectorAll(".fu-rc [data-cfg]").length;
  // price edit through the UI
  document.querySelector('.fu-rc [data-tab="pool"]')?.click();
  document.querySelector('.fu-rc [data-filter="all"]')?.click();
  const pr = document.querySelector(".fu-rc-tbl tbody tr input[data-act=price]");
  const prId = pr?.closest("tr")?.dataset.id;
  if (pr) { pr.value = "1234"; pr.dispatchEvent(new Event("change", { bubbles: true })); }
  for (let i = 0; i < 40 && R.getState(hako).pool.find((e) => e.id === prId)?.price !== 1234; i++) await wait(100);
  out.console = { rows, authRows, rulesInputs, priceSaved: R.getState(hako).pool.find((e) => e.id === prId)?.price };
  ok("console: pool table renders", rows >= 75, rows);
  ok("console: authoring filter", authRows >= 15 && authRows < rows, authRows);
  ok("console: rules inputs", rulesInputs >= 10, rulesInputs);
  ok("console: price edit saves", out.console.priceSaved === 1234);
  await c.dlg.close();

  const { ShopWindowApp } = await import(`/modules/${NS}/scripts/shop-system/shopWindow-app.js`);
  const dlg = await ShopWindowApp.open(hako.uuid, { spectate: true });
  for (let i = 0; i < 40 && !dlg.element?.[0]?.querySelector(".fu-shop-roster-dlg-btn"); i++) await wait(100);
  ok("shop window: GM Roster button", !!dlg.element?.[0]?.querySelector(".fu-shop-roster-dlg-btn"));
  await dlg.close();
}

console.error = origErr;
out.errors = out.errors.filter((e) => /roster|shop/i.test(e));
out.summary = `${Object.keys(out.steps).length - out.fails.length}/${Object.keys(out.steps).length} passed`;
return out;
