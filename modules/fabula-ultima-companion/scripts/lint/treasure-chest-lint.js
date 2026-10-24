/**
 * [ONI] Treasure Chest Lint
 * ---------------------------------------------------------------------------
 * Checks the placed treasure chests (tiles with flags.oni-treasure-chest)
 * against the chest rules in docs/treasure-chest-design.md:
 *
 *   CHEST_OVER_BUDGET / CHEST_UNDER_BUDGET (warning / info)
 *     Chest count per tier in an area (the scene folder) differs from
 *     AREA_BUDGETS below. Areas with no budget are listed as info only.
 *
 *   CHEST_EMPTY (warning)       no item and no Zenit
 *   CHEST_ITEM_MISSING (warning) itemUuid does not resolve
 *   CHEST_NO_TIER (info)        a chest from before tiers, in a budgeted area
 *   CHEST_NOT_EXPLORATION (warning)
 *     chest on a scene whose mode is not "exploration" (tile-path dungeon
 *     maps use loot TILES, not chests)
 *   CHEST_RARE_NOT_UNIQUE (warning)
 *     a Rare chest's item also sits in a RollTable or a shop NPC's stock;
 *     hidden chests should hold what cannot be bought or rolled
 *   CHEST_RARE_NO_REVEAL (warning)  Rare chest with revealRadius 0 (never hidden)
 *   CHEST_ZENIT_BAND (info)
 *     Zenit outside the tier's band, measured against the area's
 *     "<Area> - Zenit" RollTable mean (mundane 25-50%, standard 100-150%,
 *     rare >= the table's max). Info: the user sets the final numbers.
 *
 * Usage:
 *   await FUCompanion.api.lint.runTreasureChestLint();
 *   // → { findings: [...], summary: { total, warnings, info, byCode, areas } }
 *
 * On demand only (no auto-run): placing chests is an authoring step.
 */

(() => {
  const TAG = "[TreasureChestLint]";
  const MODULE_ID = "fabula-ultima-companion";
  const SCOPE = "oni-treasure-chest";

  // Chest budget per area = scene folder name. Set with the user, 2026-10-24.
  const AREA_BUDGETS = {
    "Ancient Capital Midgard": { mundane: 2, standard: 1, rare: 0 },
    "Valley of the Dragon":    { mundane: 2, standard: 3, rare: 1 },
    "Fafnir Castle":           { mundane: 1, standard: 1, rare: 1 },
  };

  // Zenit band per tier, as a share of the area Zenit table's mean result.
  const ZENIT_BANDS = {
    mundane:  { min: 0.25, max: 0.5 },
    standard: { min: 1.0,  max: 1.5 },
  };

  // A town has no Zenit table; it is measured against the area it leads into.
  const ZENIT_TABLE_FOR_AREA = {
    "Ancient Capital Midgard": "Valley of the Dragon - Zenit",
  };

  const num = (v) => Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0;

  function zenitStats(tableName) {
    const t = game.tables?.getName?.(tableName);
    if (!t) return null;
    const vals = t.results.contents.map((r) => num(r.text ?? r.name)).filter((n) => n > 0);
    if (!vals.length) return null;
    return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals) };
  }

  // Names of every item a RollTable can roll or a shop NPC sells.
  function rolledOrSold() {
    const names = new Map();
    const add = (name, where) => {
      const k = String(name ?? "").trim();
      if (!k) return;
      if (!names.has(k)) names.set(k, []);
      names.get(k).push(where);
    };
    for (const t of game.tables ?? []) {
      for (const r of t.results) add(r.text ?? r.name, `table "${t.name}"`);
    }
    for (const a of game.actors ?? []) {
      if (!("shop_portrait" in (a.system?.props ?? {}))) continue;
      for (const i of a.items) add(i.name, `shop "${a.name}"`);
    }
    return names;
  }

  async function runTreasureChestLint() {
    const findings = [];
    const push = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });
    const sources = rolledOrSold();
    const areas = {};

    for (const scene of game.scenes ?? []) {
      const area = scene.folder?.name ?? "(no folder)";
      const mode = scene.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? "";

      for (const tile of scene.tiles) {
        const f = tile.flags?.[SCOPE];
        if (!f?.isTreasureChest) continue;

        const tier = String(f.tier ?? "").toLowerCase();
        const where = `${scene.name} (${scene.navName || area}) tile ${tile.id}`;
        const a = (areas[area] ??= { mundane: 0, standard: 0, rare: 0, untiered: 0, chests: [] });
        if (tier in a) a[tier] += 1; else a.untiered += 1;

        let item = null;
        if (f.itemUuid) {
          try { item = await fromUuid(f.itemUuid); } catch {}
          if (!item) push("warning", "CHEST_ITEM_MISSING", `${where}: item ${f.itemUuid} (${f.itemName}) not found`);
        }
        a.chests.push({ scene: scene.name, tileId: tile.id, tier, item: item?.name ?? f.itemName ?? "", qty: f.quantity, zenit: num(f.zenit), opened: tile.hidden });

        if (!f.itemUuid && !(num(f.zenit) > 0)) push("warning", "CHEST_EMPTY", `${where}: no item and no Zenit`);
        if (!tier && AREA_BUDGETS[area]) push("info", "CHEST_NO_TIER", `${where}: no tier set`);
        if (mode && mode !== "exploration") push("warning", "CHEST_NOT_EXPLORATION", `${where}: scene mode is "${mode}"`);

        if (tier === "rare") {
          if (!(num(f.revealRadius ?? 1.5) > 0)) push("warning", "CHEST_RARE_NO_REVEAL", `${where}: Rare chest is never hidden (revealRadius 0)`);
          const hits = item ? sources.get(item.name) : null;
          if (hits?.length) push("warning", "CHEST_RARE_NOT_UNIQUE", `${where}: Rare item "${item.name}" is also in ${hits.join(", ")}`);
        }

        const stats = zenitStats(ZENIT_TABLE_FOR_AREA[area] ?? `${area} - Zenit`);
        const z = num(f.zenit);
        if (stats && z > 0) {
          const band = ZENIT_BANDS[tier];
          if (band && (z < stats.mean * band.min || z > stats.mean * band.max)) {
            push("info", "CHEST_ZENIT_BAND", `${where}: ${z}z is outside the ${tier} band ${Math.round(stats.mean * band.min)}-${Math.round(stats.mean * band.max)}z`);
          }
          if (tier === "rare" && !f.itemUuid && z < stats.max) {
            push("info", "CHEST_ZENIT_BAND", `${where}: Rare Zenit-only chest below the area table max (${stats.max}z)`);
          }
        }
      }
    }

    for (const [area, budget] of Object.entries(AREA_BUDGETS)) {
      const a = areas[area] ?? { mundane: 0, standard: 0, rare: 0 };
      for (const tier of ["mundane", "standard", "rare"]) {
        if (a[tier] > budget[tier]) push("warning", "CHEST_OVER_BUDGET", `${area}: ${a[tier]} ${tier} chests, budget ${budget[tier]}`);
        else if (a[tier] < budget[tier]) push("info", "CHEST_UNDER_BUDGET", `${area}: ${a[tier]} ${tier} chests, budget ${budget[tier]}`);
      }
    }

    const byCode = {};
    for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    const summary = {
      total: findings.length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      info: findings.filter((f) => f.severity === "info").length,
      byCode,
      areas,
    };

    console.info(`${TAG} ${summary.total} findings — ${JSON.stringify(byCode)}`);
    for (const f of findings) (f.severity === "warning" ? console.warn : console.info)(`${TAG} [${f.code}] ${f.message}`);
    return { findings, summary };
  }

  // ── Register ──────────────────────────────────────────────────────
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint ?? {};
  globalThis.FUCompanion.api.lint.runTreasureChestLint = runTreasureChestLint;
  globalThis.FUCompanion.api.lint.TREASURE_CHEST_BUDGETS = AREA_BUDGETS;

  console.debug(`${TAG} Installed. Call FUCompanion.api.lint.runTreasureChestLint() to scan.`);
})();
