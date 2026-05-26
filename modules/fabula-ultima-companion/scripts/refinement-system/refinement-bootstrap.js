// scripts/refinement-system/refinement-bootstrap.js

Hooks.once("ready", () => {
  const handler = new RefinementSocketHandler();
  game.socket.on(REFINEMENT_CHANNEL, handler._onSocket);

  const mod = game.modules.get("fabula-ultima-companion");
  if (mod) {
    mod.api ??= {};
    mod.api.refinement = {
      refine:             ({ itemUuid, actorUuid, refinerActorUuid = null }) => handler.requestRefine({ itemUuid, actorUuid, refinerActorUuid }),
      canRefine:          rfCanRefine,
      getRefineLevel:     rfGetRefineLevel,
      getMaxRefineLevel:  rfGetMaxRefineLevel,
      getSuccessRate:     rfGetSuccessRate,
      getCost:            rfGetCost,
      computeBonus:       rfComputeBonus,
      buildDisplayName:   rfBuildDisplayName,
    };
  }

  console.log("[FU Companion] Refinement system ready.");
});
