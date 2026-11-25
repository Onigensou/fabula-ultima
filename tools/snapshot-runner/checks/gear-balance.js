// Legacy gear balance pass (runs after the authoring migration). Runner, canvas off:
//   FVTT_HEADLESS=true FVTT_CANVAS=off node bin/run.mjs --snapshot snap-roster --port 30172 --code feat/legacy-gear-authoring --eval <this> --dump results/gear-balance.json
const NS = "fabula-ultima-companion";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: {}, fails: [], errors: [] };
const ok = (name, cond, detail) => { out.steps[name] = { pass: !!cond, detail }; if (!cond) out.fails.push(name); };
const origErr = console.error;
console.error = (...a) => { out.errors.push(a.map(String).join(" ").slice(0, 300)); return origErr(...a); };
const applied = () => { try { return JSON.stringify(game.settings.get(NS, "appliedMigrations")); } catch { return ""; } };
for (let i = 0; i < 240 && !applied().includes("legacy-gear-balance"); i++) await wait(250);
ok("balance migration ran", applied().includes("2026-11-25-legacy-gear-balance"));

const W = (id) => game.items.get(id);
const P = (id) => W(id)?.system?.props ?? {};
const kid = (id) => game.items.find((i) => i.system?.container === id && i.name.endsWith("(Passive)"));
const rows = (doc, key) => Object.values(doc?.system?.props?.[key] ?? {});
const txt = (h) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Alpha Regalia: self only, Uncommon
ok("Alpha Regalia: Uncommon + self targeting", P("0b9L1O59jxijKJ1I").item_rarity === "Uncommon"
  && rows(kid("0b9L1O59jxijKJ1I"), "effect_table").find((r) => r.effect_label === "au_who")?.candidate_source === "self");
// Mana Robe: half
const mr = W("jnhWaWPLwZcPQ883").effects.find((e) => e.name === "Mana Robe");
ok("Mana Robe: half to MP", JSON.stringify(mr?.flags?.[NS]?.reactionConfig?.effect_table ?? {}).includes("floor(INCOMING_DAMAGE / 2)"));
// Gambler's Dice: crit AE gone, FP kept, Common
ok("Gambler's Dice: crit effect removed, Common", !W("fXTiW1mHRFBGSGR8").effects.some((e) => e.name === "Gambler's Dice") && P("fXTiW1mHRFBGSGR8").item_rarity === "Common");
ok("Gambler's Dice: keep_fumble_fp", rows(kid("fXTiW1mHRFBGSGR8"), "effect_table").some((r) => r.keep_fumble_fp === true));
// Copycat
const cc = rows(kid("Hurc7SbzCtjIAaC3"), "effect_table").find((r) => r.effect_label === "cc_copy");
ok("Copycat: pays IP", cc?.copy_pays_ip === true && cc?.free_of_cost === false, cc);
// Brief Respite
ok("Brief Respite: half MP", JSON.stringify(kid("6f3U2Cz826kB5ZIp")?.system?.props?.effect_table).includes("floor(ACTION_EFFECTIVE_COST_MP / 2)"));
// Dominatrix
ok("Dominatrix: Charm on crit", rows(kid("V3R1cSiLgIfXVgRj"), "reaction_config_table").some((r) => r.reaction_effect_ref === "dl_charm" && /ATTACK_IS_CRIT == 1/.test(r.condition_formula)));
// Avalon
ok("Avalon: 0/0 chassis, Legendary", String(P("vH6Q88n3beOHjxKq").item_def_bonus) === "0" && String(P("vH6Q88n3beOHjxKq").item_mdef_bonus) === "0" && P("vH6Q88n3beOHjxKq").item_rarity === "Legendary");
// Defense Matrix
ok("Defense Matrix: 5 Shield, Uncommon", rows(kid("4OH9H2YYxr9KhhBx"), "effect_table").find((r) => r.effect_label === "dm_shield")?.grant_amount === "5" && P("4OH9H2YYxr9KhhBx").item_rarity === "Uncommon");
const pool = game.actors.get("srAH3OHOoK0tvFih").getFlag(NS, "shopRoster").pool;
ok("Defense Matrix: off in Hako's pool", pool.find((e) => e.id === "4OH9H2YYxr9KhhBx")?.off === true);
const ins = await FUCompanion.shopRoster.inspect(game.actors.get("srAH3OHOoK0tvFih"));
out.blocked = Object.fromEntries(ins.rows.filter((r) => r.block).map((r) => [r.name, r.block]));
ok("inspect: Defense Matrix blocked", !!out.blocked["Defense Matrix"], out.blocked["Defense Matrix"]);
// Ball Gag
ok("Ball Gag: Uncommon", P("Ef9i1q5WWmWw0ZcI").item_rarity === "Uncommon");
// Book text
out.book = Object.fromEntries(["UbFTDlw59jKvWab2", "rp6c8fADXzWLAt68", "g0S7SNOw5EJcJd1T", "96gMkuCexILXHXyI"].map((id) => [W(id).name, txt(P(id).description).slice(0, 70)]));
ok("book text restored", /delicacy/.test(out.book["Lid Shield"]) && /As long as you have this accessory/.test(out.book["Ring of Onions"]) && /You are immune to Poisoned/.test(out.book["Slimy Jacket"]) && /You have Resistance/.test(out.book["Hekat Shield"]), out.book);
const blancheHekat = game.actors.getName("Blanche").items.find((i) => i.name === "Hekat Shield");
ok("Blanche's Hekat: book text + passive kept", /You have Resistance/.test(txt(blancheHekat?.system?.props?.description))
  && game.actors.getName("Blanche").items.some((i) => i.system?.container === blancheHekat?.id && i.name === "Hekat Shield (Passive)"));
// Hako's listing copy
const hd = game.actors.get("srAH3OHOoK0tvFih").items.find((i) => i.name === "Dominatrix Leotard");
ok("Hako's Dominatrix copy updated", hd?.getFlag(NS, "gearBalance") === true);

// Fairy Tunic on a Hina clone: no status → base; a buff → +2
const hina = game.actors.getName("Hina");
const temp = await Actor.create({ ...hina.toObject(), _id: undefined, name: "GB Temp" });
try {
  const s = W("G8fBxPWSabEzD5V6").toObject(); delete s._id; s.system.props.isEquipped = false;
  const [tunic] = await temp.createEmbeddedDocuments("Item", [s]);
  await temp.updateEmbeddedDocuments("Item", temp.items.filter((i) => String(i.system?.props?.item_type).toLowerCase() === "armor").map((i) => ({ _id: i.id, "system.props.isEquipped": i.id === tunic.id })));
  out.fxBefore = temp.effects.map((e) => `${e.name}|${JSON.stringify(e.system?.tags ?? [])}|${e.flags?.[NS]?.category ?? ""}|${e.disabled ? "off" : "on"}`);
  await temp.deleteEmbeddedDocuments("ActiveEffect", temp.effects.filter((e) => (e.system?.tags ?? []).some((t) => /buff/i.test(t)) || /buff/i.test(String(e.flags?.[NS]?.category ?? ""))).map((e) => e.id));
  out.fxAfter = temp.effects.map((e) => e.name); out.tunicFx = temp.items.get(tunic.id).effects.map((e) => `${e.name}:${e.disabled ? "off" : "on"}:${JSON.stringify(e.changes.map((c) => c.value))}`);
  await wait(400);
  const off = temp.system.props.magic_defense;
  await temp.createEmbeddedDocuments("ActiveEffect", [{ name: "GB Test Buff", changes: [], system: { tags: ["buff"] } }]);
  await wait(400);
  const on = temp.system.props.magic_defense;
  out.fairy = { off, on };
  ok("Fairy Tunic: +2 MDEF with a buff", Number(on) === Number(off) + 2, out.fairy);
} catch (e) { ok("Fairy Tunic test ran", false, String(e)); }
await temp.delete();
out.errorCount = out.errors.length;
return out;
