// [Diagnostic] Test markSummon end-to-end
// Spawns a Fox fire phantasm token on the GM's current scene (or the
// payload-provided scene), then calls FUCompanion.api.phantasm.markSummon
// with a specified summoner actor UUID. Captures the result + post-call
// state so we can see whether the combat-join works.
//
// Payload args (all optional with sensible defaults):
//   __PAYLOAD.spawnActorUuid  — actor to spawn (default Actor.VLaGqwrMzpmq0whe — Fox fire)
//   __PAYLOAD.summonerActorUuid — who to record as summoner (default: first PC combatant on this scene)
//   __PAYLOAD.cleanup         — if true, delete the spawned token after the test (default false)
//
// Returns a summary object.

const TAG = "[Diag][TestMarkSummon]";
const payload = (typeof __PAYLOAD !== "undefined" && __PAYLOAD) ? __PAYLOAD : (globalThis.__PAYLOAD ?? {});
const FOX_FIRE_ACTOR_UUID = payload.spawnActorUuid ?? "Actor.VLaGqwrMzpmq0whe";

console.log(`${TAG} starting`);

const scene = canvas?.scene;
if (!scene) return { ok: false, reason: "no_active_scene" };

const combat = game.combats?.contents?.find(c => c.scene?.id === scene.id) ?? game.combat ?? null;
console.log(`${TAG} scene=${scene.id} (${scene.name}); active combat = ${combat?.id ?? "(none)"} with ${combat?.combatants?.size ?? 0} combatants`);

// Pick a summoner: explicit arg first, else first PC combatant on this scene.
let summonerActorUuid = payload.summonerActorUuid ?? null;
if (!summonerActorUuid && combat) {
  for (const cb of combat.combatants?.contents ?? []) {
    if (cb?.actor?.type === "character" && cb.actor?.hasPlayerOwner) {
      summonerActorUuid = cb.actor.uuid;
      console.log(`${TAG} auto-picked summoner: ${cb.actor.name} (${summonerActorUuid})`);
      break;
    }
  }
}
if (!summonerActorUuid) return { ok: false, reason: "no_summoner_found", combatantsOnScene: combat?.combatants?.size ?? 0 };

// Resolve the Phantasm actor to spawn.
const summonActor = await fromUuid(FOX_FIRE_ACTOR_UUID);
if (!summonActor) return { ok: false, reason: "spawn_actor_not_found", uuid: FOX_FIRE_ACTOR_UUID };
console.log(`${TAG} spawn actor: ${summonActor.name}`);

// Pick a free spot near scene center.
const w = scene.dimensions?.sceneWidth ?? 1000;
const h = scene.dimensions?.sceneHeight ?? 1000;
const gridSize = scene.grid?.size ?? 50;
const x = Math.floor((w / 2) / gridSize) * gridSize;
const y = Math.floor((h / 2) / gridSize) * gridSize;

// Spawn a token.
const tokenDocProto = await summonActor.getTokenDocument({ x, y });
const created = await scene.createEmbeddedDocuments("Token", [tokenDocProto.toObject()]);
const tokenDoc = created?.[0];
if (!tokenDoc) return { ok: false, reason: "token_create_failed" };
console.log(`${TAG} spawned token ${tokenDoc.id} (${tokenDoc.name}) at (${x}, ${y})`);

// Call markSummon.
let markResult = null;
try {
  markResult = await globalThis?.FUCompanion?.api?.phantasm?.markSummon?.(tokenDoc, summonerActorUuid);
  console.log(`${TAG} markSummon result`, markResult);
} catch (e) {
  console.error(`${TAG} markSummon threw`, e);
  markResult = { ok: false, threw: String(e?.message ?? e) };
}

// Inspect post-state.
const post = {
  tokenStillOnScene: !!scene.tokens.get(tokenDoc.id),
  tokenSummonedByFlag: tokenDoc.getFlag?.("fabula-ultima-companion", "summonedBy") ?? null,
  combatantsPostCount: combat?.combatants?.size ?? 0,
  newCombatant: null,
};
if (combat) {
  const cb = combat.combatants?.contents?.find(c => c.tokenId === tokenDoc.id) ?? null;
  if (cb) {
    post.newCombatant = {
      id: cb.id,
      tokenId: cb.tokenId,
      actorName: cb.actor?.name ?? null,
      activations: {
        max: cb.getFlag?.("lancer-initiative", "activations.max") ?? null,
        value: cb.getFlag?.("lancer-initiative", "activations.value") ?? null,
      },
    };
  }
}
console.log(`${TAG} post-state`, post);

if (payload.cleanup === true && tokenDoc) {
  try {
    await tokenDoc.delete();
    console.log(`${TAG} cleaned up spawned token`);
  } catch (e) {
    console.warn(`${TAG} cleanup failed`, e);
  }
}

return {
  ok: true,
  scene: { id: scene.id, name: scene.name },
  combat: combat ? { id: combat.id, sceneId: combat.scene?.id ?? null } : null,
  summonerActorUuid,
  spawnedTokenId: tokenDoc.id,
  markSummonResult: markResult,
  post,
};
