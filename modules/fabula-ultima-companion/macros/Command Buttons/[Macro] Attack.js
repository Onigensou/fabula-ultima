/**
 * Macro: Attack (Router)
 * Foundry V12 — routes to:
 *   - "Attack - Player" (weapon-based, your current Attack)
 *   - "Attack - NPC"    (Attack item picker, Skill/Spell style)
 *
 * Rule: if this actor is linked as a User Character → Player
 *       otherwise → NPC
 */

const PLAYER_MACRO_NAME = "Attack - Player";
const NPC_MACRO_NAME    = "Attack - NPC";

(async () => {
  if (!canvas?.scene) return ui.notifications.error("No active scene.");

  // Resolve attacker the same way your other buttons do
  function selectedToken()        { return canvas.tokens?.controlled?.[0] ?? null; }
  function firstSelectableToken() { return canvas.tokens?.placeables?.find(t => t.actor?.isOwner) ?? null; }

  function resolveActorForUserV12() {
    if (game.user.isGM) {
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok };
    } else {
      const a = game.user.character ?? null;
      if (a) {
        const tok = canvas.tokens?.placeables?.find(t => t.actor?.id === a.id) ?? null;
        return { actor: a, token: tok };
      }
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok };
    }
  }

  const resolved = resolveActorForUserV12();
  const actor = resolved?.actor ?? null;

  if (!actor) {
    return ui.notifications.warn("Attack: Could not resolve attacker (no linked character / no valid token).");
  }

  // --- Player vs NPC detection ---
  // “Linked to a user” = this actor is set as a Character for any user.
  const isPlayerActor = game.users?.some(u => u?.character?.id === actor.id) ?? false;

  const macroName = isPlayerActor ? PLAYER_MACRO_NAME : NPC_MACRO_NAME;
  const macro = game.macros.getName(macroName);

  if (!macro) {
    return ui.notifications.error(`Attack: Macro "${macroName}" not found (create it first).`);
  }

  await macro.execute();
})();
