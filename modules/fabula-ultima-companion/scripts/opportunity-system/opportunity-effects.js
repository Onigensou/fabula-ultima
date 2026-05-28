/**
 * [ONI] Opportunity System — Effects
 * Placeholder handlers for all 9 official opportunity options + custom.
 * Each handler receives a context object and returns a Promise.
 * Wire in real automation here as each option is implemented.
 *
 * Context shape:
 *   { actorUuid, actorName, optionId, source, actionCardId?, checkResult?, payload? }
 */
(() => {
  const TAG = "[ONI][OpportunitySystem:Effects]";

  const EFFECTS = {
    advantage: async (ctx) => {
      // TODO: Track a +4 bonus that applies to the next Check made by the actor or an ally.
      // Possible impl: apply a short-lived Active Effect with effect_kind "check_bonus" and charges=1.
      console.debug(TAG, "advantage — placeholder", ctx);
    },

    affliction: async (ctx) => {
      // TODO: Open a small picker letting the player choose dazed / shaken / slow / weak,
      // then apply the chosen status to a target via ActiveEffectManager.
      console.debug(TAG, "affliction — placeholder", ctx);
    },

    bonding: async (ctx) => {
      // TODO: Open the bond-updater UI for the actor, pre-seeded to "add emotion" or "create bond".
      console.debug(TAG, "bonding — placeholder", ctx);
    },

    faux_pas: async (ctx) => {
      // TODO: Prompt the controller of a chosen creature to type the compromising statement.
      // Could surface as a flavour ChatMessage template that the player fills in.
      console.debug(TAG, "faux_pas — placeholder", ctx);
    },

    favor: async (ctx) => {
      // TODO: Narrative only — no automation. Could post a flavour card noting the support gained.
      console.debug(TAG, "favor — placeholder", ctx);
    },

    information: async (ctx) => {
      // TODO: Narrative only — prompt GM to type the discovered detail and whisper/post it.
      console.debug(TAG, "information — placeholder", ctx);
    },

    lost_item: async (ctx) => {
      // TODO: Open item-transfer UI or flag an item for destruction / removal from inventory.
      console.debug(TAG, "lost_item — placeholder", ctx);
    },

    plot_twist: async (ctx) => {
      // TODO: Narrative only — surface a flavour card and optionally ping a location/actor.
      console.debug(TAG, "plot_twist — placeholder", ctx);
    },

    progress: async (ctx) => {
      // TODO: Open clock picker UI and fill/erase up to 2 sections on the chosen clock.
      console.debug(TAG, "progress — placeholder", ctx);
    },

    scan: async (ctx) => {
      // TODO: Reveal one Vulnerability or Trait of a chosen visible creature.
      // Could read from monster's CSB props and post as a whispered/public card.
      console.debug(TAG, "scan — placeholder", ctx);
    },

    unmask: async (ctx) => {
      // TODO: Reveal goals/motivations field from a chosen creature's actor sheet.
      console.debug(TAG, "unmask — placeholder", ctx);
    },

    custom: async (ctx) => {
      // TODO: Open a GM text-input prompt; on confirm, post the custom twist as a flavour card.
      // Requires GM approval (gmApproveNeeded = true in config).
      console.debug(TAG, "custom — placeholder", ctx);
    },
  };

  window["oni.OpportunityEffects"] = Object.freeze(EFFECTS);

  console.debug(`${TAG} Loaded ${Object.keys(EFFECTS).length} placeholder handlers.`);
})();
