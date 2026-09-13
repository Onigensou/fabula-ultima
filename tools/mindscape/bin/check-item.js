#!/usr/bin/env node
"use strict";
//
// Mindscape — check ONE designed item against its rarity budget (equipment guide Part 5).  READ-ONLY.
//
//   node bin/check-item.js --item <spec.json | item:<name>> [--slot main|off|armor|acc1|acc2]
//        [--wearer striker|caster|tank|support|ranger|most-hit|most-hit-def|most-hit-mdef]
//        [--rarity common|uncommon|rare|legendary] [--encounter-set specs/encounters/house-set.json]
//        [--base-levels 20,50] [--presets standard,...] [--runs 500] [--seed check-item] [--out <file.json>]
//
// Defaults read the spec: slot from item_type (weapon main, shield off, armor armor, accessory
// acc1), rarity from item_rarity. Default wearer: a weapon on the Striker, a shield on the Tank,
// armor on whoever takes the most DEF-rolled damage, an accessory on whoever takes the most.
// Choose the wearer the item is FOR — a spell accessory belongs on the caster.
//
// Every archetype preset fights every house spawn group and the rulebook base levels twice —
// basic gear, then basic gear + the item — on the same seed. No world data changes; the game
// must be CLOSED (world items and monsters are read from LevelDB).

const fs = require("fs");
const path = require("path");
const { loadWorldItems } = require("../lib/world-items");
const { loadWorldFolders, basicCatalogue } = require("../lib/baseline-gear");
const { PRESETS, DEFAULT_SKILL_LAYER_K } = require("../lib/archetype-party");
const RS = require("../lib/reference-set");
const IC = require("../lib/item-check");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean);
const f1 = (x) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(1));
const signed = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`);

const SLOT_BY_TYPE = { weapon: "main", shield: "off", armor: "armor", accessory: "acc1" };
const WEARER_BY_SLOT = { main: "striker", off: "tank", armor: "most-hit-def", acc1: "most-hit", acc2: "most-hit" };

async function main() {
  const item = arg("--item", null);
  if (!item) throw new Error("--item <spec.json | item:<name>> is required");
  let spec = null;
  if (!item.startsWith("item:") && !item.startsWith("own:")) spec = JSON.parse(fs.readFileSync(path.resolve(item), "utf8"));
  const type = String(spec?.system?.props?.item_type ?? "").trim().toLowerCase();
  const slot = arg("--slot", SLOT_BY_TYPE[type] ?? null);
  if (!slot) throw new Error("--slot is required for a world item (main, off, armor, acc1, acc2)");
  const wearer = arg("--wearer", WEARER_BY_SLOT[slot]);
  const rarity = String(arg("--rarity", spec?.system?.props?.item_rarity ?? "")).trim().toLowerCase() || null;
  const budget = rarity ? IC.RARITY_BUDGET[rarity] ?? null : null;
  if (rarity && budget == null) throw new Error(`unknown --rarity "${rarity}" (${Object.keys(IC.RARITY_BUDGET).join(", ")})`);
  const runs = Number(arg("--runs", 500));
  const seed = arg("--seed", "check-item");
  const power = arg("--power", "table");
  const presets = list(arg("--presets", Object.keys(PRESETS).join(",")));
  const encounterSet = arg("--encounter-set", "specs/encounters/house-set.json");
  const baseLevels = list(arg("--base-levels", "20,50")).map(Number);
  const out = arg("--out", null);

  const scopes = [
    ...(encounterSet === "none" ? [] : (await RS.loadEncounterSet(encounterSet)).map((s) => ({ ...s, kind: "house" }))),
    ...RS.neutralScopes(baseLevels, { defense: null }).map((s) => ({ ...s, kind: "base", group: `rulebook L${s.level}` })),
  ];
  const worldItems = await loadWorldItems();
  const catalogue = basicCatalogue(worldItems, await loadWorldFolders());

  const t0 = Date.now();
  const { rows, coverage } = IC.measureItem({ item: spec ?? item, slot, wearer, scopes, presets, runs, seed, power, catalogue, worldItems });
  const sum = IC.summarize(rows, budget);

  const name = spec?.name ?? item;
  console.log(`\nItem check — ${name}${rarity ? ` (${rarity}, budget ${budget}%)` : ""} · slot ${slot} · wearer ${wearer}`);
  console.log(`${power} power (k ${DEFAULT_SKILL_LAYER_K}), presets ${presets.join("/")}, ${runs} runs per arm, seed "${seed}"`);
  console.log(`Value % = offense (extra damage per wearer action / BA) + defense (party damage prevented per round / HP-per-BA).\n`);

  console.log(`### What the model sees of this item`);
  const block = (label, xs) => console.log(`- ${label}: ${xs.length ? xs.join(" · ") : "none"}`);
  console.log(`- measured against (0%): ${coverage?.chassis ? `basic weapon ${coverage.chassis} on the wearer` : "the preset's basic kit, slot as the role wears it"}`);
  block("modelled gear skills", coverage?.modelled ?? []);
  block("⚠ passives NOT modelled (read as 0%)", coverage?.unmodelledPassives ?? []);
  block("⚠ actives NOT modelled (read as 0%)", coverage?.unmodelledActions ?? []);
  block("⚠ effects the loadout parser could not read", coverage?.unreadEffects ?? []);
  block("state-gated effects (evaluated once, before the fight)", coverage?.situational ?? []);
  block("notes", coverage?.warnings ?? []);
  console.log("");

  for (const [kind, label] of [["house", "House roster — the live environment"], ["base", "Rulebook base"]]) {
    const gs = sum.byGroup.filter((g) => g.kind === kind);
    if (!gs.length) continue;
    console.log(`### ${label}\n`);
    console.log(`| Encounters | L | Value % [presets] | Offense | Defense | Party offense | Kept standing | Wearer KO pts | Party loss pts | Rounds | Won in 1 |`);
    console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const g of gs) {
      console.log(`| ${g.group} | ${g.levels.join("/")} | **${f1(g.value)}** [${f1(g.min)}–${f1(g.max)}] | ${f1(g.offense)} | ${f1(g.defense)} `
        + `| ${f1(g.partyOffense)} | ${signed(g.actionsKept)}% | ${signed(g.koPts)} | ${signed(g.lossPts)} `
        + `| ${f1(g.roundsBase)} → ${f1(g.roundsItem)} | ${f1(g.wonInOneBase)} → ${f1(g.wonInOneItem)}% |`);
    }
    console.log("");
  }

  console.log(`### Verdict`);
  const v = sum.verdict;
  if (!v) {
    console.log(`- No rarity given: house mean ${f1(sum.house)}%, L20 end ${f1(sum.early.house ?? sum.early.base)}%, L50 end ${f1(sum.late.house ?? sum.late.base)}%.`);
  } else {
    const mark = (okv) => (okv == null ? "—" : okv ? "✓" : "✗");
    console.log(`- House roster mean ${f1(v.house)}% vs budget ${v.budget}% ${mark(v.houseOk)}`);
    console.log(`- Level check, L20 end ≤ budget: ${f1(v.early)}% (${v.earlySource === "house" ? "house groups ≤ L25" : "rulebook base — no house groups ≤ L25 in the set"}) ${mark(v.earlyOk)}`);
    console.log(`- Level check, L50 end ≥ ½ budget: ${f1(v.late)}% (${v.lateSource === "house" ? "house groups ≥ L46" : "rulebook base"}) ${mark(v.lateOk)}`);
  }
  const skipped = rows.filter((r) => r.skipped);
  console.log(`\n${rows.length - skipped.length} measured arms, ${skipped.length} skipped${skipped.length ? ` (${[...new Set(skipped.map((r) => r.skipped))].join("; ")})` : ""} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`A guide, not a verdict: archetypes carry no class skills, and model rounds read about one long vs live.`);

  if (out) {
    fs.writeFileSync(path.resolve(out), `${JSON.stringify({
      id: "check-item", capturedAt: new Date().toISOString().slice(0, 10), item: name, source: item, slot, wearer, rarity, budget,
      runs, seed, power, k: DEFAULT_SKILL_LAYER_K, presets, encounterSet, baseLevels, coverage, summary: sum, rows,
    }, null, 2)}\n`);
    console.log(`wrote ${path.resolve(out)}`);
  }
}

main().catch((e) => { console.error(`\ncheck-item failed: ${e.message}\n`); process.exit(1); });
