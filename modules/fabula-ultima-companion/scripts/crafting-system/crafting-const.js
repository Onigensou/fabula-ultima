// scripts/crafting-system/crafting-const.js
//
// Shared constants and small helpers for the Crafting System (Blueprints).
// No side effects; every other crafting file imports from here.

export const TAG = "[Crafting]";
export const MODULE_ID = "fabula-ultima-companion";
export const CHANNEL = `module.${MODULE_ID}`;

// Where the Blueprint books live: one world Item, its flag holds the whole config.
export const CONFIG_ITEM_NAME = "_Crafting Config";
export const CONFIG_FLAG = "craftingConfig";

// Actor flags on a Crafter NPC; Region flag on a crafting spot.
export const CRAFTER_FLAG = "isCrafter";
export const CRAFTER_BOOK_FLAG = "crafterBook";
export const CRAFTER_QUOTE_FLAG = "crafterQuote";
export const SPOT_FLAG = "craftSpot";

// The three ways into the crafting window. Each can carry its own cost.
export const PLACES = Object.freeze(["npc", "table", "camp"]);
export const PLACE_LABEL = Object.freeze({ npc: "Crafter NPC", table: "Crafting table", camp: "Camp" });

// List tabs, keyed by the output item's item_type.
export const CATEGORIES = Object.freeze([
  { key: "all", label: "All", icon: "fas fa-border-all" },
  { key: "weapon", label: "Weapons", icon: "fas fa-khanda" },
  { key: "armor", label: "Armor & Shields", icon: "fas fa-shield-halved" },
  { key: "accessory", label: "Accessories", icon: "fas fa-ring" },
  { key: "item", label: "Items", icon: "fas fa-flask" },
  { key: "other", label: "Other", icon: "fas fa-box" },
]);

export const MAX_QTY = 99;

export const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
export const ZENIT_ICON = `${ASSET}Item%20Icon/GP.png`;
// The Shop's own set and volumes (shopSound-manager.js) plus the Alchemist's
// "working" and "done" cues, so a sound means one thing everywhere. Local only.
export const SFX = {
  open:   [`${ASSET}Sound/Shop_Open.wav`, 0.65],          // window opens
  tab:    [`${ASSET}Sound/BattleCursor_1.wav`, 0.55],     // category tab / filter
  select: [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],     // pick a Blueprint, quantity
  cancel: [`${ASSET}Sound/BattleCursor_2.wav`, 0.55],     // close / refused
  craft:  [`${ASSET}Sound/check_start.wav`, 0.55],        // crafting…
  done:   [`${ASSET}Sound/Saint5.ogg`, 0.6],              // crafted (window + banner)
};

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
export const gp = (obj, path, fb) => { try { return foundry.utils.getProperty(obj, path) ?? fb; } catch { return fb; } };
export const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
export const int = (v, fb = 0) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : fb; };

export function playSfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}

export const readZenit = (actor) => Math.max(0, int(actor?.system?.props?.zenit, 0));
export function readIp(actor) {
  const p = actor?.system?.props ?? {};
  return { cur: Math.max(0, int(p.current_ip, 0)), max: Math.max(0, int(p.max_ip, 0)) };
}

export function rarityColor(r) {
  const k = String(r ?? "").toLowerCase();
  return k.includes("legendary") ? "#7b2fa8" : k.includes("rare") ? "#b8860b" : k.includes("uncommon") ? "#1f6fb2" : "#3a2408";
}

// Camp scene (camp twin rooms): the scene-mode flag the camp system uses.
export const isCampScene = (scene) => scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode === "camp";
export const cameraRuntime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
