// ============================================================================
// Dungeon Pathing — Areas (Foundry v12 Regions as world-map regions)
// ----------------------------------------------------------------------------
// A world map is ONE scene but many lands. Paint a Foundry Region over a land
// and give it the "Fabula Area" behavior (Region Config → Behaviors): its
// fields override the scene's Dungeon Configuration for everything that
// happens on a tile inside it —
//
//   threat           Travel roll die for Travel tiles without their own threat
//   encounterTable   ┐
//   enemiesTable     │ Random Battle / travel Danger fights
//   battleMap        │
//   battleBGM        ┘
//   loot.*           Treasure Roulette, fishing (fish) and gathering (material)
//
// Blank fields inherit the scene. Overlapping Areas: the SMALLEST one wins, so
// a painted village inside a painted forest is the village.
//
// Read through oni.FabulaConfig.readDungeon(scene, { tile }) — every table
// consumer already goes through it, so passing the tile is all a caller needs.
//
// The point test reads the Region DOCUMENT's shapes, not the canvas placeable:
// the GM resolves encounters for a scene it may not be viewing, and Foundry's
// own Region#testPoint lives on the canvas object.
// ============================================================================
(() => {
  const DP   = globalThis.DungeonPathing ??= {};
  const MOD  = "fabula-ultima-companion";
  const TYPE = `${MOD}.area`;
  const TAG  = "[DungeonPathing][Areas]";

  const LOOT_KEYS = Object.freeze({
    treasure: "Treasure", zenit: "Zenit", weapon: "Weapon", armor: "Armor",
    accessory: "Accessory", consumable: "Consumable", item: "Item (IP)",
    fish: "Fish", material: "Material",
  });

  // ── Behavior type ──────────────────────────────────────────────────────────
  Hooks.once("init", () => {
    const Base = foundry.data.regionBehaviors?.RegionBehaviorType;
    if (!Base) { console.warn(TAG, "RegionBehaviorType missing — Fabula Areas unavailable"); return; }
    const f = foundry.data.fields;
    const table = (label) => new f.DocumentUUIDField({ type: "RollTable", label });

    class FabulaAreaBehavior extends Base {
      static defineSchema() {
        return {
          threat: new f.StringField({
            label: "Travel Threat", blank: true, initial: "",
            hint: "Travel roll die on Travel tiles inside this area that have no threat of their own. Blank = the scene's Threat Level.",
            choices: { "": "— Scene default —", minimal: "Minimal — d6", low: "Low — d8",
                       medium: "Medium — d10", high: "High — d12", very_high: "Very High — d20" },
          }),
          encounterTable: table("Encounter Table"),
          enemiesTable:   table("Enemies Table"),
          battleMap:      new f.DocumentUUIDField({ type: "Scene", label: "Battle Map" }),
          battleBGM:      new f.StringField({ label: "Battle BGM", blank: true, initial: "" }),
          loot: new f.SchemaField(
            Object.fromEntries(Object.entries(LOOT_KEYS).map(([k, label]) => [k, table(`${label} Table`)])),
            { label: "Loot Tables", hint: "Blank tables use the scene's." }),
        };
      }
    }

    CONFIG.RegionBehavior.dataModels[TYPE] = FabulaAreaBehavior;
    CONFIG.RegionBehavior.typeLabels[TYPE] = "Fabula Area";
    CONFIG.RegionBehavior.typeIcons[TYPE]  = "fa-solid fa-map-location-dot";
  });

  // ── Document-level point test ──────────────────────────────────────────────
  function inShape(s, x, y) {
    const rot = -(Number(s.rotation) || 0) * Math.PI / 180;
    const rotate = (cx, cy) => {
      if (!rot) return [x - cx, y - cy];
      const dx = x - cx, dy = y - cy;
      return [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot)];
    };
    switch (s.type) {
      case "rectangle": {
        const [dx, dy] = rotate(s.x + s.width / 2, s.y + s.height / 2);
        return Math.abs(dx) <= s.width / 2 && Math.abs(dy) <= s.height / 2;
      }
      case "circle":
        return Math.hypot(x - s.x, y - s.y) <= s.radius;
      case "ellipse": {
        const [dx, dy] = rotate(s.x, s.y);
        return (dx * dx) / (s.radiusX * s.radiusX) + (dy * dy) / (s.radiusY * s.radiusY) <= 1;
      }
      case "polygon": {
        const p = s.points ?? [];
        let inside = false;
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      }
      default: return false;
    }
  }

  function shapeArea(s) {
    switch (s.type) {
      case "rectangle": return s.width * s.height;
      case "circle":    return Math.PI * s.radius * s.radius;
      case "ellipse":   return Math.PI * s.radiusX * s.radiusY;
      case "polygon": {
        const p = s.points ?? []; let a = 0;
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += (p[j] + p[i]) * (p[j + 1] - p[i + 1]);
        return Math.abs(a / 2);
      }
      default: return 0;
    }
  }

  /** Inside any solid shape and no hole. */
  function regionContains(region, x, y) {
    const shapes = region.shapes ?? [];
    if (shapes.some(s => s.hole && inShape(s, x, y))) return false;
    return shapes.some(s => !s.hole && inShape(s, x, y));
  }

  const regionArea = (region) => (region.shapes ?? []).reduce((a, s) => a + (s.hole ? -1 : 1) * shapeArea(s), 0);

  function areaBehavior(region) {
    return region.behaviors?.find?.(b => b.type === TYPE && !b.disabled) ?? null;
  }

  function pointOf({ tile, point } = {}) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
    if (tile) return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
    return null;
  }

  /**
   * The Fabula Area at a tile or point: { region, behavior } or null.
   * Smallest containing area wins.
   */
  function areaAt(scene, where = {}) {
    const p = pointOf(where);
    if (!scene || !p) return null;
    let best = null;
    for (const region of scene.regions ?? []) {
      const behavior = areaBehavior(region);
      if (!behavior || !regionContains(region, p.x, p.y)) continue;
      const area = regionArea(region);
      if (!best || area < best.area) best = { region, behavior, area };
    }
    return best ? { region: best.region, behavior: best.behavior } : null;
  }

  /**
   * Overlay the Area's non-blank fields onto a scene's dungeon config.
   * Returns a NEW object; `data` is never mutated. Adds `areaName` when an
   * Area applied.
   */
  function overlay(scene, data, where) {
    const hit = areaAt(scene, where);
    if (!hit) return data;
    const sys = hit.behavior.system ?? {};
    const out = foundry.utils.deepClone(data ?? {});
    const set = (k, v) => { if (v != null && String(v).trim()) out[k] = v; };
    set("threatLevel",    sys.threat);
    set("encounterTable", sys.encounterTable);
    set("enemiesTable",   sys.enemiesTable);
    set("battleMap",      sys.battleMap);
    set("battleBGM",      sys.battleBGM);
    for (const k of Object.keys(LOOT_KEYS)) {
      const v = sys.loot?.[k];
      if (v != null && String(v).trim()) (out.loot ??= {})[k] = v;
    }
    out.areaName = hit.region.name;
    return out;
  }

  DP.Areas = { TYPE, LOOT_KEYS, areaAt, overlay, _internals: { inShape, regionContains, regionArea } };
})();
