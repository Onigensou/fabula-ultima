/**
 * Status — open the attribute / status window.
 *
 * Drag this to your hotbar. It shows your attributes and derived stats at any
 * time; the arrows to raise an attribute only appear when you have actually
 * earned an advance (character level 20 and 40) and are somewhere you may spend
 * it — resting at camp, or on the title screen.
 *
 * Targets your selected token if you have one, otherwise your assigned
 * character, so a GM can open a PLAYER's Status by selecting their token.
 *
 * Player characters only. Monsters carry levels and attributes too, and this
 * window is not where their dice are edited — selecting one opens nothing.
 */

const api = globalThis.FUCompanion?.api?.attributes;
if (!api?.app) {
  ui.notifications?.warn?.("Attribute system is not loaded.");
} else {
  const selected = canvas?.tokens?.controlled?.[0]?.actor ?? null;
  const actor = selected ?? game.user?.character ?? null;
  if (!actor) {
    ui.notifications?.warn?.("Select a token, or have a character assigned to your user.");
  } else if (api.isSubject && !api.isSubject(actor.uuid)) {
    ui.notifications?.warn?.(`${actor.name} is not a player character.`);
  } else {
    api.app.toggle(actor.uuid);
  }
}
