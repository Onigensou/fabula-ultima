// [Diagnostic] Inspect Phantasm context
// Returns a JSON snapshot of current combat(s), summon-related actors,
// Phantasm tokens on canvas, etc. Used by Claude via test-bridge runMacro
// to debug Phantasmal Echo wiring without console paste-back.
//
// Output: posts a chat message with the snapshot AND returns the snapshot
// object (test-bridge captures the return value).

const snap = {
  scene: {
    id: canvas?.scene?.id ?? null,
    name: canvas?.scene?.name ?? null,
  },
  combats: (game.combats?.contents ?? []).map(c => ({
    id: c.id,
    sceneId: c.scene?.id ?? null,
    sceneName: c.scene?.name ?? null,
    started: !!c.started,
    round: c.round,
    turn: c.turn,
    combatantCount: c.combatants?.size ?? 0,
    combatants: (c.combatants?.contents ?? []).map(cb => ({
      id: cb.id,
      tokenId: cb.tokenId,
      tokenName: cb.token?.name ?? null,
      actorId: cb.actorId,
      actorName: cb.actor?.name ?? null,
      isPhantasm: !!cb.actor?.system?.props?.isPhantasm,
      summonedBy: cb.token?.getFlag?.("fabula-ultima-companion", "summonedBy") ?? null,
      activations: {
        max: cb.getFlag?.("lancer-initiative", "activations.max") ?? null,
        value: cb.getFlag?.("lancer-initiative", "activations.value") ?? null,
      },
    })),
  })),
  activeCombat: game.combat ? {
    id: game.combat.id,
    sceneId: game.combat.scene?.id ?? null,
    started: !!game.combat.started,
  } : null,
  canvasTokensWithFlags: (canvas?.scene?.tokens?.contents ?? [])
    .filter(t => t.getFlag?.("fabula-ultima-companion", "summonedBy"))
    .map(t => ({
      id: t.id,
      name: t.name,
      actorName: t.actor?.name ?? null,
      isPhantasm: !!t.actor?.system?.props?.isPhantasm,
      summonedBy: t.getFlag("fabula-ultima-companion", "summonedBy"),
    })),
  phantasmActorsOnCanvas: (canvas?.scene?.tokens?.contents ?? [])
    .filter(t => t.actor?.system?.props?.isPhantasm)
    .map(t => ({
      id: t.id,
      name: t.name,
      actorUuid: t.actor?.uuid,
      summonedBy: t.getFlag?.("fabula-ultima-companion", "summonedBy") ?? null,
      currentHp: t.actor?.system?.props?.current_hp ?? null,
      maxHp: t.actor?.system?.props?.max_hp ?? null,
    })),
  phantasmApiPresent: !!globalThis?.FUCompanion?.api?.phantasm?.markSummon,
  creatureDefeatedEmitterMarker: typeof Hooks !== "undefined" ? "(check console for [ONI][CreatureDefeatedEmitter] Installed)" : "?",
};

try {
  ChatMessage.create({
    content: `<pre style="font-size:0.8em">${foundry.utils.escapeHTML(JSON.stringify(snap, null, 2))}</pre>`,
    whisper: [game.user.id],
  });
} catch (e) {
  console.warn("InspectPhantasmContext: chat create failed", e);
}

return snap;
