// Party Menu — who may use what.
//
// The GM (every user with the GM role, not just the acting one) sees the whole
// menu. Players see the commands the GM has opened to them in Setup; Setup
// itself is GM-only and cannot be opened to players, because it is where the
// GM decides everything else.
//
// Command access is the coarse gate. Each view still applies the document-level
// one on top: a player may LOOK at any party member, but only changes what they
// own (their character) or what the party shares through the GM relay.

import { isActingGM } from "../advancement/advancement-net.js";

export const MODULE_ID = "fabula-ultima-companion";
const SETTING = "partyMenuPlayerCommands";

/** Every command the menu knows, in menu order. `gmOnly` cannot be granted. */
export const COMMAND_DEFS = [
  { id: "item", label: "Item", hint: "Inventories — own and the party's shared bag" },
  { id: "ability", label: "Ability", hint: "Skills, and summon bindings on summon skills" },
  { id: "equip", label: "Equip", hint: "Equip and unequip gear" },
  { id: "status", label: "Status", hint: "Attributes, defenses and active effects" },
  { id: "bonds", label: "Bonds", hint: "Each character's bonds, and how the party feels about each other" },
  { id: "bestiary", label: "Bestiary", hint: "Every creature the party has met and studied" },
  { id: "setup", label: "Setup", hint: "Party roster, player access", gmOnly: true },
];

/** What players get on a fresh world: in-game data, nothing that sets the game up. */
export const DEFAULT_PLAYER_COMMANDS = ["item", "ability", "equip", "status", "bonds", "bestiary"];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING, {
    name: "Party Menu: player commands",
    hint: "Commands players may open in the Party Menu. Edited from the menu's Setup page.",
    scope: "world",
    config: false,
    type: Array,
    default: DEFAULT_PLAYER_COMMANDS,
    onChange: () => Hooks.callAll("fuPartyMenuAccessChanged"),
  });
});

// The setting is not a permission boundary on its own: this world lets players
// write world settings (measured 2026-10-11 — a player's game.settings.set
// landed). So the acting GM watches the Setting document and puts back any
// change a non-GM made, to the last value a GM set.
const SETTING_KEY = `${MODULE_ID}.${SETTING}`;
let _gmValue = null;
function guardSetting(doc, userId) {
  if (doc?.key !== SETTING_KEY) return;
  const author = game.users?.get(userId);
  // Every GM client tracks the last GM-made value, so whichever GM becomes the
  // acting one later restores THAT, not what it loaded with.
  if (author?.isGM) { _gmValue = playerCommands(); return; }
  if (!isActingGM()) return;
  const restore = _gmValue ?? DEFAULT_PLAYER_COMMANDS;
  console.warn(`[PartyMenu] ${author?.name ?? userId} changed the player-command grant; restoring it.`);
  game.settings.set(MODULE_ID, SETTING, restore);
}
Hooks.once("ready", () => {
  _gmValue = playerCommands();
  // A player edit made while no GM was online: nobody was there to revert it,
  // so the document's last writer is checked once at load.
  try {
    const doc = game.settings.storage.get("world")?.find?.((d) => d.key === SETTING_KEY);
    const by = game.users?.get(doc?._stats?.lastModifiedBy);
    if (doc && by && !by.isGM) {
      _gmValue = DEFAULT_PLAYER_COMMANDS;
      if (isActingGM()) {
        console.warn(`[PartyMenu] the player-command grant was last written by ${by.name}; resetting it to the default.`);
        game.settings.set(MODULE_ID, SETTING, DEFAULT_PLAYER_COMMANDS);
      }
    }
  } catch (e) { console.warn("[PartyMenu] grant audit failed", e); }
});
Hooks.on("createSetting", (doc, _opts, userId) => guardSetting(doc, userId));
Hooks.on("updateSetting", (doc, _change, _opts, userId) => guardSetting(doc, userId));

/** The command ids currently granted to players (never includes a gmOnly one). */
export function playerCommands() {
  let raw;
  try { raw = game.settings.get(MODULE_ID, SETTING); } catch { raw = DEFAULT_PLAYER_COMMANDS; }
  const known = new Set(COMMAND_DEFS.filter((c) => !c.gmOnly).map((c) => c.id));
  return (Array.isArray(raw) ? raw : DEFAULT_PLAYER_COMMANDS).filter((id) => known.has(id));
}

/** Can `user` open command `id`? Close is always allowed. */
export function canUseCommand(id, user = game.user) {
  if (id === "close") return true;
  const def = COMMAND_DEFS.find((c) => c.id === id);
  if (!def) return false;
  if (user?.isGM) return true;
  if (def.gmOnly) return false;
  return playerCommands().includes(id);
}

/** GM only: replace the player grant. Unknown and gmOnly ids are dropped. */
export async function setPlayerCommands(ids) {
  if (!game.user?.isGM) return { ok: false, reason: "not-gm" };
  const known = new Set(COMMAND_DEFS.filter((c) => !c.gmOnly).map((c) => c.id));
  const next = [...new Set((ids ?? []).filter((id) => known.has(id)))];
  await game.settings.set(MODULE_ID, SETTING, next);
  return { ok: true, commands: next };
}
