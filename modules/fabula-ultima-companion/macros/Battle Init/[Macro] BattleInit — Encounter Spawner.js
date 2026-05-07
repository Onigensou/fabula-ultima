// ============================================================================
// BattleInit — Encounter Spawner (Step 5b) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Spawns tokens based on payload.layout.step5a:
// - Party tokens (friendly) on the RIGHT positions
// - Enemy tokens (hostile) on the LEFT positions
//
// This step is ONLY token creation (no entrance animations).
//
// Data sources:
// - Party: payload.layout.step5a.party[]  (actorUuid + x/y)
// - Enemies: payload.layout.step5a.enemies[] (name + x/y)
//
// Notes:
// - Uses x/y exactly as stored by Step 5a (treated as token TOP-LEFT coords)
// - Party tokens are skipped if a token with the same actorId already exists
// - Enemy tokens always spawn (duplicates allowed)
// - Adds a small flag to each spawned token for later cleanup/debug
// ============================================================================

(async () => {
  const DEBUG = false;

  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  const tag = "[BattleInit:Spawner:Step5b]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  // -----------------------------
  // Helpers
  // -----------------------------
  const nowIso = () => new Date().toISOString();

  async function safeFromUuid(uuid) {
    const u = String(uuid ?? "").trim();
    if (!u) return null;
    try { return await fromUuid(u); }
    catch (e) { console.warn(tag, "fromUuid failed:", u, e); return null; }
  }

  function pickRunId(payload) {
    const existing = payload?.meta?.runId;
    if (existing) return String(existing);
    // fallback if older payload doesn't have runId
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function findBattleInitPayloadForThisBattleScene() {
    const currentSceneId = canvas.scene?.id;
    if (!currentSceneId) return null;

    // 1) current scene
    const local = canvas.scene.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
    if (local) return { payload: local, sourceScene: canvas.scene };

    // 2) search other scenes that "own" the payload (common if you stored it on exploration scene)
    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(PAYLOAD_SCOPE, PAYLOAD_KEY);
      if (!p) continue;

      const transitionedBattleId =
        p?.step4?.battleScene?.id ??
        p?.step4?.battleSceneId ??
        null;

      if (transitionedBattleId && transitionedBattleId === currentSceneId) {
        return { payload: p, sourceScene: s };
      }
    }
    return null;
  }

        function actorByNameWorldOnly(name) {
    const n = String(name ?? "").trim();
    if (!n) return null;
    return game.actors?.getName?.(n) ?? (game.actors?.contents?.find?.(a => a.name === n) ?? null);
  }

  // -----------------------------
  // Battle Sprite helper
  // Prefer actor.system.props.sprite_battle (user-defined)
  // Fallback: whatever the prototype token already uses
  // -----------------------------
  function getBattleSpriteSrc(actor) {
    const raw = actor?.system?.props?.sprite_battle;
    const src = String(raw ?? "").trim();
    return src ? src : null;
  }

  function applyBattleSpriteToTokenObject(tokenObj, actor) {
    const src = getBattleSpriteSrc(actor);
    if (!src) return false;

    tokenObj.texture ??= {};
    tokenObj.texture.src = src;

    // Back-compat (some code paths still read token "img")
    tokenObj.img = src;

    return true;
  }

  // -----------------------------
  // Facing helpers (Default vs Battle)
  // - default_facing_direction: how the sprite art is drawn (Left/Right)
  // - battle_facing_direction: how we want it to face in the battle scene (Left/Right)
  // Rule:
  //   If default != battle => flip horizontally (mirror)
  // -----------------------------
  function normalizeFacingDir(v, fallback = "left") {
    const s = String(v ?? "").trim().toLowerCase();
    if (s.startsWith("r")) return "right";
    if (s.startsWith("l")) return "left";
    return String(fallback).trim().toLowerCase() === "right" ? "right" : "left";
  }

  function getBattleFlipFromActor(actor) {
    const def = normalizeFacingDir(actor?.system?.props?.default_facing_direction, "left");
    const bat = normalizeFacingDir(actor?.system?.props?.battle_facing_direction, def);
    return def !== bat;
  }

  function applyBattleFacingToTokenObject(tokenObj, actor) {
    const flip = getBattleFlipFromActor(actor);

    // Token texture scaling is where Foundry stores horizontal mirroring.
    // We preserve the absolute scale and only change the sign.
    tokenObj.texture ??= {};

    // Foundry v12 typically uses texture.scaleX, but we also tolerate older-ish shapes.
    let scaleX =
      Number(tokenObj.texture.scaleX) ||
      Number(tokenObj.texture?.scale?.x) ||
      1;

    scaleX = Math.abs(scaleX || 1);
    tokenObj.texture.scaleX = flip ? -scaleX : scaleX;

    // If a nested scale object exists, keep it in sync (harmless if unused).
    if (tokenObj.texture.scale && typeof tokenObj.texture.scale === "object") {
      tokenObj.texture.scale.x = tokenObj.texture.scaleX;
    }

    // (Optional) store what we decided for debugging
    tokenObj.flags ??= {};
    tokenObj.flags.world ??= {};
    tokenObj.flags.world.battleInit ??= {};
    tokenObj.flags.world.battleInit.facing = {
      default: normalizeFacingDir(actor?.system?.props?.default_facing_direction, "left"),
      battle: normalizeFacingDir(
        actor?.system?.props?.battle_facing_direction,
        normalizeFacingDir(actor?.system?.props?.default_facing_direction, "left")
      ),
      flipped: flip
    };
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: Step 5b is GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene.");
    return;
  }

  const found = findBattleInitPayloadForThisBattleScene();
  if (!found) {
    ui.notifications?.error?.("BattleInit: No payload found. Run Step 1 → Step 4 → Step 5a first.");
    return;
  }

  const { payload, sourceScene } = found;
  const runId = pickRunId(payload);

  const layout = payload?.layout?.step5a;
  if (!layout?.party || !layout?.enemies) {
    ui.notifications?.error?.("BattleInit: Layout missing. Run Step 5a (Layout Engine) first.");
    log("Missing layout:", payload?.layout);
    return;
  }

  const gateOk = (payload?.phases?.gate?.status === "ok");
  const resolveOk = (payload?.phases?.resolve?.status === "ok");
  const layoutOk = (payload?.phases?.layout?.status === "ok");

  if (!gateOk || !resolveOk || !layoutOk) {
    ui.notifications?.error?.("BattleInit: Gate/Resolve/Layout not OK. Run Step 2 + Step 3 + Step 5a first.");
    log("Blocked:", { gate: payload?.phases?.gate, resolve: payload?.phases?.resolve, layout: payload?.phases?.layout });
    return;
  }

  // Safety: you should run this on the battle scene
  if (layout?.battleScene?.id && layout.battleScene.id !== canvas.scene.id) {
    ui.notifications?.warn?.(`BattleInit: You're not on the intended battle scene (${layout.battleScene.name}). Spawning anyway.`);
  }

  // -----------------------------
  // Spawn Party Tokens
    // -----------------------------
  // Spawn Party Tokens
  // -----------------------------
  const partyToSpawn = Array.isArray(layout.party) ? layout.party : [];
  const enemyToSpawn = Array.isArray(layout.enemies) ? layout.enemies : [];

  const createdParty = [];
  const createdEnemies = [];
  const adoptedPartyTokenIds = [];
  const adoptedPartyUpdates = [];
  const warnings = [];
  const errors = [];

  // Existing token actorIds on the current battle scene
  const existingActorIds = new Set(
    (canvas.scene.tokens?.contents ?? [])
      .map(t => t.actorId)
      .filter(Boolean)
  );

  for (const p of partyToSpawn) {
    const actorUuid = String(p?.actorUuid ?? "").trim();
    if (!actorUuid) {
      warnings.push(`Party slot ${p?.slot ?? "?"}: missing actorUuid.`);
      continue;
    }

    const actor = await safeFromUuid(actorUuid);
    if (!actor || actor.documentName !== "Actor") {
      warnings.push(`Party slot ${p?.slot ?? "?"}: actorUuid not resolvable: ${actorUuid}`);
      continue;
    }

    // Spawn at layout x/y (top-left)
    const x = Number(p?.x ?? 0);
    const y = Number(p?.y ?? 0);

    // If already present: ADOPT the existing token so Entrance Animation can still reveal it.
    if (existingActorIds.has(actor.id)) {
      const existing = (canvas.scene.tokens?.contents ?? []).find(t => t.actorId === actor.id) ?? null;

      if (!existing) {
        warnings.push(`Party slot ${p?.slot ?? "?"}: actor already present but token not found (actorId=${actor.id}).`);
        continue;
      }

      const slot = Number(p?.slot ?? 0);
      const battleSpriteSrc = getBattleSpriteSrc(actor);

      // Facing (use the same rule as new spawns)
      const flip = getBattleFlipFromActor(actor);
      const curScaleX =
        Number(existing?.texture?.scaleX) ||
        Number(existing?.texture?.scale?.x) ||
        1;

      const absScaleX = Math.abs(curScaleX || 1);
      const scaleX = flip ? -absScaleX : absScaleX;

      const upd = {
        _id: existing.id,

        // Make it match our "spawn hidden" expectations so Step 5c can reveal.
        hidden: true,
        alpha: 0,

        disposition: 1,

        // Facing mirror
        "texture.scaleX": scaleX,
        "texture.scale.x": scaleX,

        // Minimal debug marker
        "flags.world.battleInit": {
          runId,
          role: "party",
          slot,
          createdAt: nowIso(),
          spawnHidden: true,
          adoptedExisting: true
        }
      };

      // ✅ Battle Sprite (only if set)
      if (battleSpriteSrc) {
        upd["texture.src"] = battleSpriteSrc;
        upd["img"] = battleSpriteSrc; // back-compat
        upd["flags.world.battleInit"].battleSprite = { src: battleSpriteSrc, used: true };
      } else {
        upd["flags.world.battleInit"].battleSprite = { src: null, used: false, reason: "empty actor.system.props.sprite_battle" };
      }

      adoptedPartyUpdates.push(upd);
      adoptedPartyTokenIds.push(existing.id);

      log("Party already on scene; adopting existing token:", { slot, actor: actor.name, tokenId: existing.id, battleSpriteSrc });

      continue;
    }

    // Not present: create a NEW token document based on prototype
    const tokenDoc = await actor.getTokenDocument({ x, y });
    const obj = tokenDoc.toObject();

    // ✅ NEW: prefer actor Battle Sprite (fallback to token image if missing)
    const battleSpriteApplied = applyBattleSpriteToTokenObject(obj, actor);

    // Apply facing direction on spawn (based on actor props)
    applyBattleFacingToTokenObject(obj, actor);

    // Spawn invisible to EVERYONE at first (even GM)
    obj.hidden = true; // GM-only normally, but keep it consistent
    obj.alpha = 0;     // this makes it invisible even to GM

    obj.disposition = 1; // friendly
    obj.flags ??= {};
    obj.flags.world ??= {};
    obj.flags.world.battleInit = {
      runId,
      role: "party",
      slot: Number(p?.slot ?? 0),
      createdAt: nowIso(),
      spawnHidden: true,
      battleSprite: battleSpriteApplied
        ? { src: obj?.texture?.src ?? obj?.img ?? null, used: true }
        : { src: null, used: false, reason: "empty actor.system.props.sprite_battle" }
    };

    createdParty.push(obj);
    existingActorIds.add(actor.id);
  }

  // -----------------------------
  // Spawn Enemy Tokens
  // -----------------------------
  for (const e of enemyToSpawn) {
    const name = String(e?.name ?? "").trim();
    if (!name) {
      warnings.push("Enemy entry missing name.");
      continue;
    }

    const actor = actorByNameWorldOnly(name);
    if (!actor) {
      warnings.push(`Enemy actor not found by name: "${name}" (world actors only).`);
      continue;
    }

    const x = Number(e?.x ?? 0);
    const y = Number(e?.y ?? 0);

    const tokenDoc = await actor.getTokenDocument({ x, y });
    const obj = tokenDoc.toObject();

    // ✅ NEW: prefer actor Battle Sprite (fallback to token image if missing)
    const battleSpriteApplied = applyBattleSpriteToTokenObject(obj, actor);

    // Apply facing direction on spawn (based on actor props)
    applyBattleFacingToTokenObject(obj, actor);

    // Spawn invisible to EVERYONE at first (even GM)
    obj.hidden = true;
    obj.alpha = 0;

    obj.disposition = -1; // hostile
    obj.flags ??= {};
    obj.flags.world ??= {};
    obj.flags.world.battleInit = {
      runId,
      role: "enemy",
      index: Number(e?.index ?? 0),
      enemyName: name,
      createdAt: nowIso(),
      spawnHidden: true,
      battleSprite: battleSpriteApplied
        ? { src: obj?.texture?.src ?? obj?.img ?? null, used: true }
        : { src: null, used: false, reason: "empty actor.system.props.sprite_battle" }
    };

    createdEnemies.push(obj);
  }

  // -----------------------------
  // Create Tokens on the CURRENT scene
  // -----------------------------
  let createdDocs = [];
  try {
    const all = [...createdParty, ...createdEnemies];
    if (!all.length) {
      ui.notifications?.warn?.("BattleInit: Nothing to spawn (all party already present, or enemies unresolved).");
    } else {
      createdDocs = await canvas.scene.createEmbeddedDocuments("Token", all);
    }
  } catch (err) {
    errors.push(`Token creation failed: ${err?.message ?? String(err)}`);
    console.error(tag, "createEmbeddedDocuments failed:", err);
  }

  // Apply "adopted" updates (existing Party tokens)
  // This keeps Step 5c (Entrance) consistent even if the party was already on the scene.
  if (adoptedPartyUpdates.length) {
    try {
      await canvas.scene.updateEmbeddedDocuments("Token", adoptedPartyUpdates);
      log("Adopted existing party tokens updated:", { count: adoptedPartyUpdates.length });
    } catch (err) {
      errors.push(`Adopted party token update failed: ${err?.message ?? String(err)}`);
      console.error(tag, "updateEmbeddedDocuments failed (adopted party):", err);
    }
  }

  // Track ids
  const createdIds = (createdDocs ?? []).map(d => d.id);

  const createdPartyIds = (createdDocs ?? [])
    .filter(d => d.getFlag("world", "battleInit")?.role === "party")
    .map(d => d.id);

  const createdEnemyIds = (createdDocs ?? [])
    .filter(d => d.getFlag("world", "battleInit")?.role === "enemy")
    .map(d => d.id);

  // IMPORTANT:
  // - partyTokenIds includes BOTH newly created + adopted existing tokens
  // - enemyTokenIds currently includes newly created only (we don’t adopt enemies yet)
  const partyIds = [...adoptedPartyTokenIds, ...createdPartyIds];
  const enemyIds = createdEnemyIds;

  // -----------------------------
  // Save results to payload (back to SOURCE scene that owns the payload)
  // -----------------------------
  payload.meta ??= {};
  payload.meta.runId ??= runId;

  payload.spawn ??= {};
  payload.spawn.step5b = {
    at: nowIso(),
    battleScene: { id: canvas.scene.id, name: canvas.scene.name, uuid: canvas.scene.uuid },
    runId,

    // Newly created token ids (this run)
    createdTokenIds: createdIds,
    createdPartyTokenIds: createdPartyIds,
    createdEnemyTokenIds: createdEnemyIds,

    // Adopted token ids (already existed on the battle scene)
    adoptedPartyTokenIds,

    // Tokens Step 5c should animate + reveal
    partyTokenIds: partyIds,
    enemyTokenIds: enemyIds,

    counts: {
      party: partyIds.length,
      enemies: enemyIds.length,
      adoptedParty: adoptedPartyTokenIds.length,
      created: createdIds.length
    },

    warnings,
    errors
  };

  payload.phases ??= {};
  payload.phases.spawn = {
    status: errors.length ? "blocked" : "ok",
    at: payload.spawn.step5b.at,
    counts: payload.spawn.step5b.counts
  };

  await sourceScene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);

    // -----------------------------
  // Report
  // -----------------------------
  if (errors.length) {
    ui.notifications?.error?.(`BattleInit: Spawn BLOCKED (${errors.length} error). Check console.`);
  } else {
    // (Removed: success confirmation popup)
  }

  log("Spawn result:", payload.spawn.step5b);
  if (warnings.length) console.warn(tag, "Warnings:", warnings);
  if (errors.length) console.error(tag, "Errors:", errors);
})();
