// scripts/fabula-arcana/fa-const.js
// Shared constants + small helpers for the Fabula Arcana card minigame (Foundry side).
// The rules live in fa-catalog.js / fa-engine.js (classic scripts on globalThis.FabulaArcana).

export const MODULE_ID = "fabula-ultima-companion";
export const TAG = "[Fabula Arcana]";
export const SOCKET = `module.${MODULE_ID}`;
export const MSG = "ONI_FABULA_ARCANA_V1";

// Item flag on a card: { cid }.  NPC actor flag: duelist config (see fa-entry.js setDuelist).
export const FLAG_CARD = "faCard";
export const FLAG_DUELIST = "faDuelist";
export const SETTING_SESSIONS = "faSessions";

export const ASSET_BASE = `modules/${MODULE_ID}/assets/fabula-arcana/`;
export const GEAR_TEMPLATE = "ZoiV53VaLzeRsEps";   // CSB "_Item Template" (every carried item)

export const Engine = () => globalThis.FabulaArcana?.Engine ?? null;
export const Catalog = () => globalThis.FabulaArcana?.Catalog ?? null;

export const gp = (obj, path, fb) => { try { return foundry.utils.getProperty(obj, path) ?? fb; } catch { return fb; } };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
export const isCampScene = (scene) => scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode === "camp";
export const cameraRuntime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
export const uid = () => foundry.utils.randomID(16);

// The ONE GM client that hosts duels (main GM; fails over automatically). null = no GM online.
export function hostGM() {
  const a = game.users?.activeGM ?? null;
  if (a) return a;
  return game.users?.filter?.((u) => u.isGM && u.active)?.sort?.((x, y) => String(x.id).localeCompare(String(y.id)))?.[0] ?? null;
}
export const isHostGM = () => !!game.user?.isGM && hostGM()?.id === game.user.id;

// Forge art for a card (same files the duel window shows).
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ART = {   // exact library paths (matched by content hash to the duel window art)
  skizzik: "Beastiary/Skizzik_Standard.png",
  pyrefly: "Beastiary/Pyrefly_Standard.png",
  salamander: "Beastiary/Salamander_Standard.png",
  manaray: "Beastiary/Mana Ray_Standard.png",
  hellhound: "Beastiary/Hellhound_Standard.png",
  scorpion: "Beastiary/BanditScorpion_Standard.png",
  archer: "Beastiary/BanditArcher_Standard.png",
  wolf: "Beastiary/Wolf_Standard.png",
  obsidrax: "Beastiary/Obsidrax_Standard.png",
  fulgimite: "Beastiary/Fulgimite_Standard.png",
  kirin: "Beastiary/Kirin_Standard.png",
  cryo: "Beastiary/Cryo Eater.png",
  inferex: "Beastiary/Inferex_Standard.png",
  roper: "Beastiary/Roper_Standard.png",
  gigas: "Beastiary/Gigas_Standard.png",
  flame: "Beastiary/WanderingFlame_Standard.png",
  roo: "Beastiary/Wraith.png",
  walrog: "Beastiary/Walrog.png",
  gorger: "Beastiary/Aero_Gorger_Standard.png",
  sylph: "Beastiary/Sylph_Standard.png",
  succubus: "Beastiary/Succubus_Standard.png",
  rgolem: "Beastiary/Rock Golem_Standard.png",
  broo: "Beastiary/BanditRoo_Standard.png",
  carlbero: "Beastiary/Carlbero_Standard.png",
  life: "Beastiary/Life Eater.png",
};
export const artUrl = (cid) => (ART[cid] ? FORGE + ART[cid].split("/").map(encodeURIComponent).join("/") : "icons/svg/card-joker.svg");
export const setArtPaths = (map) => { for (const [k, p] of Object.entries(map || {})) ART[k] = p; };
