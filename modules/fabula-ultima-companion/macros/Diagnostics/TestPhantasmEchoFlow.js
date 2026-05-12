// [Diagnostic] End-to-end test for Phantasmal Echo
//
// 1. Capture summoner's current MP
// 2. Find a previously-spawned Phantasm (or spawn a new one and mark it).
// 3. Drop its HP to 0 via doc.update (triggers preUpdateActor + updateActor).
// 4. Listen for oni:reactionPhase emits captured during the test window.
// 5. Wait a beat for the autoPassive runner to do its thing.
// 6. Report: captured events + summoner MP delta.
//
// Payload args:
//   __PAYLOAD.summonerActorUuid (default Hina: Actor.dafTLBUscCDNgq8H)
//   __PAYLOAD.phantasmTokenId   (optional; if not provided, spawns one)
//   __PAYLOAD.cleanup           (default false — leave token on scene for inspection)

const TAG = "[Diag][TestPhantasmEchoFlow]";
const payload = (typeof __PAYLOAD !== "undefined" && __PAYLOAD) ? __PAYLOAD : (globalThis.__PAYLOAD ?? {});
const summonerActorUuid = payload.summonerActorUuid ?? "Actor.dafTLBUscCDNgq8H";

console.log(`${TAG} starting`);

// ---- Helpers ----
const readMp = (actor) => Number(actor?.system?.props?.current_mp ?? 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Set up hooks listener ----
const capturedEvents = [];
const hookId = Hooks.on("oni:reactionPhase", (data) => {
  console.log(`${TAG} captured oni:reactionPhase`, data);
  capturedEvents.push({
    trigger: data?.trigger,
    defeatedTokenUuid: data?.defeatedTokenUuid,
    defeatedActorUuid: data?.defeatedActorUuid,
    source: data?.source,
    timestamp: data?.timestamp,
  });
});

try {
  // ---- Resolve summoner ----
  const summonerActor = await fromUuid(summonerActorUuid);
  if (!summonerActor) return { ok: false, reason: "no_summoner" };

  const mpBefore = readMp(summonerActor);
  console.log(`${TAG} summoner ${summonerActor.name} MP before = ${mpBefore}`);

  // ---- Find or spawn a Phantasm ----
  const scene = canvas?.scene;
  if (!scene) return { ok: false, reason: "no_scene" };

  let phantasmTokenDoc = null;
  if (payload.phantasmTokenId) {
    phantasmTokenDoc = scene.tokens.get(payload.phantasmTokenId);
  }
  if (!phantasmTokenDoc) {
    // Look for any existing Phantasm token on the scene
    for (const t of scene.tokens.contents) {
      if (t.actor?.system?.props?.isPhantasm) {
        // Use the first phantasm that has our summoner as summonedBy
        if (t.getFlag?.("fabula-ultima-companion", "summonedBy") === summonerActor.uuid) {
          phantasmTokenDoc = t;
          break;
        }
      }
    }
  }

  let spawned = false;
  if (!phantasmTokenDoc) {
    console.log(`${TAG} no existing phantasm — spawning new one`);
    const foxFireActor = await fromUuid("Actor.VLaGqwrMzpmq0whe");
    if (!foxFireActor) return { ok: false, reason: "no_fox_fire" };
    const w = scene.dimensions?.sceneWidth ?? 1000;
    const h = scene.dimensions?.sceneHeight ?? 1000;
    const gridSize = scene.grid?.size ?? 50;
    const x = Math.floor((w / 2) / gridSize) * gridSize + gridSize;
    const y = Math.floor((h / 2) / gridSize) * gridSize + gridSize;
    const proto = await foxFireActor.getTokenDocument({ x, y });
    const created = await scene.createEmbeddedDocuments("Token", [proto.toObject()]);
    phantasmTokenDoc = created?.[0];
    if (!phantasmTokenDoc) return { ok: false, reason: "spawn_failed" };
    spawned = true;
    await globalThis.FUCompanion.api.phantasm.markSummon(phantasmTokenDoc, summonerActor.uuid);
    console.log(`${TAG} spawned + marked: ${phantasmTokenDoc.uuid}`);
  } else {
    console.log(`${TAG} reusing existing phantasm: ${phantasmTokenDoc.uuid}`);
  }

  const phantasmActor = phantasmTokenDoc.actor;
  const hpBefore = Number(phantasmActor?.system?.props?.current_hp ?? 0);
  console.log(`${TAG} phantasm ${phantasmActor.name} HP before = ${hpBefore}`);

  // ---- Trigger HP -> 0 ----
  console.log(`${TAG} setting phantasm HP to 0`);
  await phantasmActor.update({ "system.props.current_hp": 0 });

  // ---- Wait for reactions to settle ----
  await sleep(2000);

  // ---- Capture summoner MP after ----
  const mpAfter = readMp(summonerActor);
  console.log(`${TAG} summoner MP after = ${mpAfter}, delta = ${mpAfter - mpBefore}`);

  // ---- Cleanup if requested ----
  if (payload.cleanup === true && spawned) {
    try {
      await phantasmTokenDoc.delete();
    } catch (e) {
      console.warn(`${TAG} cleanup failed`, e);
    }
  }

  return {
    ok: true,
    summoner: { uuid: summonerActor.uuid, name: summonerActor.name, mpBefore, mpAfter, mpDelta: mpAfter - mpBefore },
    phantasm: {
      tokenUuid: phantasmTokenDoc.uuid,
      tokenId: phantasmTokenDoc.id,
      actorName: phantasmActor.name,
      hpBefore,
      hpAfter: Number(phantasmActor.system?.props?.current_hp ?? "?"),
      summonedBy: phantasmTokenDoc.getFlag("fabula-ultima-companion", "summonedBy"),
      wasSpawned: spawned,
    },
    capturedReactionPhaseEvents: capturedEvents,
    reactionFired: capturedEvents.some(e => e?.trigger === "creature_defeated"),
    mpRestored: (mpAfter - mpBefore) > 0,
  };
} finally {
  Hooks.off("oni:reactionPhase", hookId);
}
