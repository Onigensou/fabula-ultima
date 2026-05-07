// ============================================================================
// BattleEnd — Cleanup (Step 6) • Foundry VTT v12
// ----------------------------------------------------------------------------
// Purpose: Final cleanup after battle officially ends.
// 0) Remove temporary buffs/debuffs (Active Effects) from combatants
// 1) Clean battle scene tokens:
//    - Delete party tokens in battle scene
//    - Delete enemy tokens that still exist (failsafe)
//    - Delete SUMMON tokens (actor.system.isSummon === true) after battle
// 2) Clear payload/flags so next battle starts clean.
//
// Canonical payload storage:
//   SceneFlag scope="world" key="battleInit.latestPayload"
// Note: Canonical payload is stored on SOURCE scene (not battle scene), so we locate it
// by scanning scenes and matching step4.battleScene.id against the current/active scene
// OR using "latest" fallback.
//
// Safety notes (IMPORTANT):
// - Party tokens are deleted by ActorId match (safe).
// - Enemy token deletion uses a cautious heuristic:
//     a) If token has a known "spawned by battle system" flag -> delete
//     b) Else if disposition hostile (-1) AND no player owner -> delete
//   This avoids deleting decor/neutral tokens on a special battle map.
// - Summons: any token whose actor sheet has .isSummon true will be deleted,
//   regardless of disposition, but NEVER delete real party members.
// ============================================================================

(async () => {
  const DEBUG = false;

  // --------------------------------------------------------------------------
  // Storage keys
  // --------------------------------------------------------------------------
  const SCOPE = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";

  // Extra keys we also clear (safe housekeeping)
  const EXTRA_CLEAR_KEYS = [
    "battleEnd.latest",
    "battleEnd.latestPayload",
    "battleEnd.latestResult"
  ];

  // --------------------------------------------------------------------------
  // Token spawn marker flags (if your spawner sets any of these, we prefer them)
  // --------------------------------------------------------------------------
  const SPAWN_FLAG_CANDIDATES = [
    { scope: "world", key: "battleInit.spawned" },
    { scope: "world", key: "oniBattleInit.spawned" },
    { scope: "world", key: "oni.spawnedByBattle" },
    { scope: "world", key: "battleSpawned" }
  ];

  const tag = "[BattleEnd:Cleanup]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  const nowIso = () => new Date().toISOString();

  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: Cleanup is GM-only.");
    return;
  }
  if (!game.scenes) {
    ui.notifications?.error?.("BattleEnd: No Scenes collection.");
    return;
  }

  // --------------------------------------------------------------------------
  // Locate canonical payload scene (source scene) that matches THIS battle scene
  // --------------------------------------------------------------------------
  function pickLatestPayloadAcrossScenes() {
    let best = null;
    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const createdAtMs =
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { scene: s, payload: p, createdAtMs };
      }
    }
    return best;
  }

  function locateSourceSceneAndPayloadForThisBattle() {
    const activeSceneId = canvas?.scene?.id ?? null;

    // Prefer payload whose step4.battleScene.id matches the currently active scene
    let bestMatch = null;
    let bestMatchMs = 0;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const battleSceneIdInPayload = p?.step4?.battleScene?.id ?? null;
      if (battleSceneIdInPayload && activeSceneId && battleSceneIdInPayload === activeSceneId) {
        const ms =
          parseIsoToMs(p?.meta?.createdAt) ||
          Number(p?.step4?.transitionedAt ?? 0) ||
          0;

        if (!bestMatch || ms > bestMatchMs) {
          bestMatch = { scene: s, payload: p, from: "scene-scan-match-step4.battleScene.id" };
          bestMatchMs = ms;
        }
      }
    }

    if (bestMatch) return bestMatch;

    // Fallback: newest payload anywhere
    const best = pickLatestPayloadAcrossScenes();
    if (best) return { scene: best.scene, payload: best.payload, from: "scene-scan-latest" };

    return null;
  }

  const located = locateSourceSceneAndPayloadForThisBattle();
  if (!located?.payload || !located?.scene) {
    ui.notifications?.error?.(`BattleEnd: Cleanup couldn't find canonical payload at ${SCOPE}.${CANONICAL_KEY}.`);
    log("No canonical payload found.");
    return;
  }

  const sourceScene = located.scene;
  const payload = located.payload;

  const battleId = payload?.meta?.battleId ?? null;
  const battleSceneId = payload?.step4?.battleScene?.id ?? payload?.context?.battleSceneId ?? null;

  log("Located canonical payload ✅", {
    from: located.from,
    sourceScene: { id: sourceScene.id, name: sourceScene.name },
    battleId,
    battleSceneId
  });

  // --------------------------------------------------------------------------
  // Resolve Battle Scene doc (the scene where tokens were spawned)
  // --------------------------------------------------------------------------
  const battleScene = battleSceneId ? game.scenes.get(String(battleSceneId)) : null;
  if (!battleScene) {
    ui.notifications?.warn?.("BattleEnd: Cleanup couldn't resolve battle scene from payload. Will still clear flags.");
    warn("Battle scene not found for id:", battleSceneId);
  }

  // --------------------------------------------------------------------------
  // Build party actorId list (for deleting party tokens safely)
  // --------------------------------------------------------------------------
  const partyMembers = Array.isArray(payload?.party?.members) ? payload.party.members : [];
  const partyActorIds = partyMembers
    .map(m => String(m?.actorId ?? "").trim())
    .filter(Boolean);

  // --------------------------------------------------------------------------
  // Token classification helpers
  // --------------------------------------------------------------------------
  function tokenHasAnySpawnFlag(tokenDoc) {
    try {
      for (const f of SPAWN_FLAG_CANDIDATES) {
        const v = tokenDoc.getFlag(f.scope, f.key);
        if (v === true) return true;
      }
    } catch (e) {}
    return false;
  }

  function isPartyToken(tokenDoc) {
    const actorId = String(tokenDoc?.actorId ?? "").trim();
    return actorId && partyActorIds.includes(actorId);
  }

  function getIsSummonFromActor(actor) {
    // Your actor sheet key is "isSummon".
    // Different systems store it differently; check common safe paths.
    try {
      const v1 = actor?.system?.isSummon;
      if (typeof v1 === "boolean") return v1;

      const v2 = actor?.system?.props?.isSummon;
      if (typeof v2 === "boolean") return v2;

      const v3 = actor?.isSummon;
      if (typeof v3 === "boolean") return v3;
    } catch (_) {}
    return false;
  }

  function isSummonToken(tokenDoc) {
    // Use tokenDoc.actor when possible (covers synthetic actors on the scene)
    const a = tokenDoc?.actor ?? (tokenDoc?.actorId ? game.actors?.get(tokenDoc.actorId) : null);
    return !!getIsSummonFromActor(a);
  }

  function isEnemyTokenFailsafe(tokenDoc) {
    // SAFETY FIRST:
    // 1) If token is marked as spawned by our system -> definitely delete
    if (tokenHasAnySpawnFlag(tokenDoc)) return true;

    // 2) Else: if hostile disposition AND not owned by players -> treat as enemy spawn
    const disp = Number(tokenDoc?.disposition ?? 0);
    if (disp !== -1) return false;

    // Token actor might not be loaded if it's a synthetic; try to resolve by actorId
    const actor = tokenDoc?.actorId ? game.actors?.get(tokenDoc.actorId) : null;

    // If any player owns it, do NOT delete (prevents nuking PCs / special allied actor)
    const hasPlayerOwner = actor ? !!actor.hasPlayerOwner : false;
    if (hasPlayerOwner) return false;

    return true;
  }

  async function deleteTokenDocs(sceneDoc, tokenDocs, label) {
    if (!sceneDoc || !Array.isArray(tokenDocs) || tokenDocs.length === 0) return { ok: true, deleted: 0 };

    const ids = tokenDocs.map(t => t.id).filter(Boolean);
    if (!ids.length) return { ok: true, deleted: 0 };

    try {
      await sceneDoc.deleteEmbeddedDocuments("Token", ids);
      log(`Deleted ${ids.length} ${label} token(s) ✅`, { scene: sceneDoc.name, ids });
      return { ok: true, deleted: ids.length };
    } catch (e) {
      warn(`Failed deleting ${label} tokens (continuing)`, e);
      return { ok: false, deleted: 0, error: String(e?.message ?? e) };
    }
  }

  // --------------------------------------------------------------------------
  // 0) Remove buffs/debuffs (Active Effects) from combatants
  //
  // We do this BEFORE deleting tokens, so synthetic actors can be cleaned up
  // while they still exist.
  // --------------------------------------------------------------------------
  const EFFECT_CLEANUP = {
    enabled: true,
    clearPartyActors: true,
    clearEnemyActors: true,
    clearCombatTrackerActors: true,
    clearSummonActors: true,

    // If you ever have "permanent" Active Effects you DON'T want to wipe,
    // put their exact names here (case-insensitive exact match).
    keepEffectNames: []
  };

  const _keepNamesLower = new Set((EFFECT_CLEANUP.keepEffectNames ?? [])
    .map(n => String(n).trim().toLowerCase())
    .filter(Boolean));

  async function removeAllActiveEffectsFromActor(actor, reasonLabel) {
    try {
      if (!actor) return { ok: true, removed: 0, reason: reasonLabel };

      const effects = Array.from(actor.effects?.contents ?? []);
      if (!effects.length) return { ok: true, removed: 0, reason: reasonLabel };

      const deletable = effects.filter(e => {
        const nm = String(e?.name ?? "").trim().toLowerCase();
        return nm && !_keepNamesLower.has(nm);
      });

      if (!deletable.length) return { ok: true, removed: 0, reason: reasonLabel };

      const ids = deletable.map(e => e.id).filter(Boolean);
      if (!ids.length) return { ok: true, removed: 0, reason: reasonLabel };

      // Prefer bulk delete (faster + cleaner), fallback to per-effect delete.
      try {
        await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
        log(`Removed ${ids.length} ActiveEffect(s) ✅`, { actor: actor.name, reason: reasonLabel });
        return { ok: true, removed: ids.length, reason: reasonLabel };
      } catch (e) {
        let removed = 0;
        for (const ef of deletable) {
          try { await ef.delete(); removed += 1; } catch (_) {}
        }
        log(`Removed ${removed} ActiveEffect(s) ✅ (fallback)`, { actor: actor.name, reason: reasonLabel });
        return { ok: true, removed, reason: reasonLabel };
      }
    } catch (e) {
      warn("Effect cleanup failed (continuing)", { actor: actor?.name, reason: reasonLabel, error: e });
      return { ok: false, removed: 0, reason: reasonLabel, error: String(e?.message ?? e) };
    }
  }

  async function cleanupActiveEffectsBeforeTokenDelete() {
    if (!EFFECT_CLEANUP.enabled) return { status: "skipped", removed: 0, details: [] };

    const candidates = [];

    // A) Party actors from payload (persistent PCs)
    if (EFFECT_CLEANUP.clearPartyActors) {
      for (const actorId of partyActorIds) {
        const a = game.actors?.get(String(actorId));
        if (a) candidates.push({ actor: a, reason: "payload.party.members" });
      }
    }

    // B) Actors still in combat tracker (failsafe)
    if (EFFECT_CLEANUP.clearCombatTrackerActors) {
      const combat = game.combat;
      const combatants = Array.from(combat?.combatants ?? []);
      for (const c of combatants) {
        const a = c?.actor;
        if (a) candidates.push({ actor: a, reason: "game.combat.combatants" });
      }
    }

    // C) Enemy actors from battle-scene token docs (covers synthetic token actors)
    if (EFFECT_CLEANUP.clearEnemyActors && battleScene) {
      const step5b = payload?.spawn?.step5b ?? null;
      const enemyIdsFromSpawn = Array.isArray(step5b?.enemyTokenIds) ? step5b.enemyTokenIds.map(String) : [];

      // Prefer deterministic ID list if present
      if (enemyIdsFromSpawn.length) {
        for (const tid of enemyIdsFromSpawn) {
          const td = battleScene.tokens?.get(String(tid));
          const a = td?.actor;
          if (a) candidates.push({ actor: a, reason: "payload.spawn.step5b.enemyTokenIds" });
        }
      } else {
        // Fallback: heuristic enemy tokens (same rules as your cleanup)
        const tokenDocs = Array.from(battleScene.tokens ?? []);
        for (const td of tokenDocs) {
          if (!td) continue;
          if (isPartyToken(td)) continue;
          if (!isEnemyTokenFailsafe(td)) continue;
          const a = td.actor;
          if (a) candidates.push({ actor: a, reason: "battleScene.enemyTokens.heuristic" });
        }
      }
    }

    // D) Summon actors from battle-scene token docs (friendly/neutral summons too)
    if (EFFECT_CLEANUP.clearSummonActors && battleScene) {
      const tokenDocs = Array.from(battleScene.tokens ?? []);
      for (const td of tokenDocs) {
        if (!td) continue;
        if (isPartyToken(td)) continue;     // never touch real party members
        if (!isSummonToken(td)) continue;
        const a = td.actor;
        if (a) candidates.push({ actor: a, reason: "battleScene.summonTokens.isSummon" });
      }
    }

    // Deduplicate by UUID when possible (actors can appear multiple times)
    const seen = new Set();
    const unique = [];
    for (const entry of candidates) {
      const a = entry.actor;
      const key = a?.uuid ?? `${a?.id ?? ""}::${a?.name ?? ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(entry);
    }

    let totalRemoved = 0;
    const details = [];

    for (const { actor, reason } of unique) {
      const res = await removeAllActiveEffectsFromActor(actor, reason);
      totalRemoved += Number(res?.removed ?? 0);
      details.push({ actor: actor?.name, actorId: actor?.id, ok: res?.ok, removed: res?.removed ?? 0, reason });
    }

    return { status: "ok", removed: totalRemoved, details };
  }

  const effectCleanup = await cleanupActiveEffectsBeforeTokenDelete();

  // --------------------------------------------------------------------------
  // 1) Clean battle scene tokens (ID-first, fallback to heuristic)
  //
  // Preferred: delete EXACT token IDs created by Encounter Spawner Step5b:
  //   payload.spawn.step5b.partyTokenIds
  //   payload.spawn.step5b.enemyTokenIds
  //
  // Summons are not guaranteed to appear in these arrays, so we ALSO scan
  // battle-scene tokens for actor.system.isSummon === true and delete them.
  // --------------------------------------------------------------------------
  let tokenCleanup = {
    status: "skipped",
    method: "none",
    partyDeleted: 0,
    enemyDeleted: 0,
    summonDeleted: 0
  };

  if (battleScene) {
    const step5b = payload?.spawn?.step5b ?? null;

    const partyIdsFromSpawn = Array.isArray(step5b?.partyTokenIds) ? step5b.partyTokenIds.map(String) : [];
    const enemyIdsFromSpawn = Array.isArray(step5b?.enemyTokenIds) ? step5b.enemyTokenIds.map(String) : [];

    // Sanity: only use ID method if these arrays exist (even if empty is ok)
    const hasSpawnLists = !!step5b && (Array.isArray(step5b?.partyTokenIds) || Array.isArray(step5b?.enemyTokenIds));

    if (hasSpawnLists) {
      // Delete by ID (deterministic + safest)
      const tokenDocs = (battleScene.tokens?.contents ?? []);
      const existingIds = new Set(tokenDocs.map(t => t.id));

      const partyIds = partyIdsFromSpawn.filter(id => existingIds.has(id));
      const enemyIds = enemyIdsFromSpawn.filter(id => existingIds.has(id));

      // Summons: scan all tokens; never delete party tokens.
      const summonIds = tokenDocs
        .filter(td => td && existingIds.has(td.id))
        .filter(td => !isPartyToken(td))
        .filter(td => isSummonToken(td))
        .map(td => td.id);

      // Dedup (avoid double-deleting if somehow overlaps)
      const partySet = new Set(partyIds);
      const enemySet = new Set(enemyIds);
      const summonIdsFinal = Array.from(new Set(summonIds))
        .filter(id => !partySet.has(id) && !enemySet.has(id));

      let partyRes = { ok: true, deleted: 0 };
      let enemyRes = { ok: true, deleted: 0 };
      let summonRes = { ok: true, deleted: 0 };

      try {
        if (partyIds.length) {
          await battleScene.deleteEmbeddedDocuments("Token", partyIds);
          partyRes = { ok: true, deleted: partyIds.length };
          log("Deleted party tokens by ID ✅", { scene: battleScene.name, partyIds });
        } else {
          log("No party tokens to delete by ID (already gone or none spawned).");
        }
      } catch (e) {
        warn("Failed deleting party tokens by ID (continuing):", e);
        partyRes = { ok: false, deleted: 0, error: String(e?.message ?? e) };
      }

      try {
        if (enemyIds.length) {
          await battleScene.deleteEmbeddedDocuments("Token", enemyIds);
          enemyRes = { ok: true, deleted: enemyIds.length };
          log("Deleted enemy tokens by ID ✅", { scene: battleScene.name, enemyIds });
        } else {
          log("No enemy tokens to delete by ID (already gone or none spawned).");
        }
      } catch (e) {
        warn("Failed deleting enemy tokens by ID (continuing):", e);
        enemyRes = { ok: false, deleted: 0, error: String(e?.message ?? e) };
      }

      try {
        if (summonIdsFinal.length) {
          await battleScene.deleteEmbeddedDocuments("Token", summonIdsFinal);
          summonRes = { ok: true, deleted: summonIdsFinal.length };
          log("Deleted summon tokens by scan ✅", { scene: battleScene.name, summonIds: summonIdsFinal });
        } else {
          log("No summon tokens to delete (none found).");
        }
      } catch (e) {
        warn("Failed deleting summon tokens (continuing):", e);
        summonRes = { ok: false, deleted: 0, error: String(e?.message ?? e) };
      }

      tokenCleanup = {
        status: "ok",
        method: "spawn.step5b.tokenIds + summonScan",
        partyDeleted: partyRes.deleted ?? 0,
        enemyDeleted: enemyRes.deleted ?? 0,
        summonDeleted: summonRes.deleted ?? 0,
        partyOk: partyRes.ok ?? true,
        enemyOk: enemyRes.ok ?? true,
        summonOk: summonRes.ok ?? true
      };
    } else {
      // Fallback: heuristic cleanup (your current behavior + summon)
      const tokenDocs = Array.from(battleScene.tokens ?? []);

      const partyTokens = tokenDocs.filter(td => isPartyToken(td));
      const enemyTokens = tokenDocs.filter(td => !isPartyToken(td) && isEnemyTokenFailsafe(td));

      // Summons: delete regardless of disposition, but never delete party members
      const summonTokens = tokenDocs.filter(td => !isPartyToken(td) && isSummonToken(td));

      const partyRes = await deleteTokenDocs(battleScene, partyTokens, "party");
      const enemyRes = await deleteTokenDocs(battleScene, enemyTokens, "enemy");
      const summonRes = await deleteTokenDocs(battleScene, summonTokens, "summon");

      tokenCleanup = {
        status: "ok",
        method: "heuristic + summon",
        partyDeleted: partyRes.deleted ?? 0,
        enemyDeleted: enemyRes.deleted ?? 0,
        summonDeleted: summonRes.deleted ?? 0,
        partyOk: partyRes.ok ?? true,
        enemyOk: enemyRes.ok ?? true,
        summonOk: summonRes.ok ?? true
      };
    }
  }

  // --------------------------------------------------------------------------
  // 2) Clear flags/payload
  // --------------------------------------------------------------------------
  // We clear the canonical payload ONLY for this battle (match by battleId if present).
  // If battleId is missing, we only clear from the located source scene (safe fallback).
  const scenes = game.scenes?.contents ?? [];
  let clearedCanonicalCount = 0;
  let clearedExtraCount = 0;

  for (const s of scenes) {
    // Clear extra “latest” keys (always safe)
    for (const k of EXTRA_CLEAR_KEYS) {
      try {
        const has = s.getFlag(SCOPE, k);
        if (has !== undefined) {
          await s.unsetFlag(SCOPE, k);
          clearedExtraCount += 1;
        }
      } catch (e) {}
    }

    // Clear canonical payload if it matches this battleId
    try {
      const p = s.getFlag(SCOPE, CANONICAL_KEY);
      if (!p) continue;

      if (battleId) {
        const pBattleId = p?.meta?.battleId ?? null;
        if (pBattleId === battleId) {
          await s.unsetFlag(SCOPE, CANONICAL_KEY);
          clearedCanonicalCount += 1;
        }
      }
    } catch (e) {}
  }

  // Fallback: if we had no battleId, clear only from located source scene
  if (!battleId) {
    try {
      const p = sourceScene.getFlag(SCOPE, CANONICAL_KEY);
      if (p) {
        await sourceScene.unsetFlag(SCOPE, CANONICAL_KEY);
        clearedCanonicalCount += 1;
      }
    } catch (e) {}
  }

  // Also: optionally clear any battleEnd slice stored under canonical payload scene flags
  // (If you stored these in your own scripts, this ensures cleanup is complete.)
  try {
    const maybe = sourceScene.getFlag(SCOPE, "battleEnd.latest");
    if (maybe !== undefined) {
      await sourceScene.unsetFlag(SCOPE, "battleEnd.latest");
      clearedExtraCount += 1;
    }
  } catch (e) {}

  log("Cleanup summary ✅", {
    tokenCleanup,
    effectCleanup,
    clearedCanonicalCount,
    clearedExtraCount,
    at: nowIso()
  });

})();
