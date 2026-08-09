// ============================================================================
// Dungeon Pathing — Tile Event: Dirt (Suspicious Mound)
//
// A suspicious mound of dirt. Mark the tile "Usable" so the party gets a
// "Dig" (Use) button on the confirm dialog — digging is opt-in; just landing
// (no Use) does nothing and the mound remains.
//
// On Dig:
//   1. A Group Check lobby opens on every client (ONI.GroupCheck, open mode):
//      players choose a Leader + who Participates as Helpers, then ready up.
//   2. The check runs (helpers → leader). DL is HIDDEN from players.
//   3. The leader's result maps to a tiered outcome:
//        BEST  (pass / crit)              → transform into a Treasure tile,
//                                           triggered immediately.
//        BANE  (close fail, within band)  → buried explosive detonates:
//                                           flat FIRE damage to every participant.
//        WORST (fumble / well below DL)   → spring a one-time Random Battle ambush.
//
//   Every outcome ends the same way — once resolved the mound collapses to a
//   Blank tile (type + texture):
//        BANE / WORST → cleared to blank right after the effect fires.
//        BEST         → TR.Flow blanks the tile once the winner is locked
//                       (DP.TileState.clearTile, from inside the loot flow).
//
// Defaults below are overridable per-tile via flags under
//   flags.<MODULE_ID>.dungeonPathing.dirt.*
// (attrA, attrB, dl, baneBand, baneDamage, bestType, worstType).
//
// clearAfterTrigger:false — this handler owns the tile's lifecycle (transform
// or explicit consume), so the turn loop must not blank it.
//
// GM routing mirrors tile-event-treasure.js: the Group Check, damage and
// transform all require GM authority, so a player trigger is relayed to the GM.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing;
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEvent][dirt]";
  const MSG_TYPE  = "DP_TRIGGER_DIRT";
  const SOCKET_CH = `module.${MODULE_ID}`;

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // ── Per-tile config (defaults + flag overrides) ────────────────────────────
  function readDirtConfig(tileDoc) {
    const root = `${DP.PATHING_ROOT_KEY}.dirt`;
    const get  = (k, d) => tileDoc?.getFlag?.(MODULE_ID, `${root}.${k}`) ?? d;
    return {
      attrA:      String(get("attrA", "MIG")),
      attrB:      String(get("attrB", "INS")),
      dl:         Number(get("dl",         12)),
      baneBand:   Number(get("baneBand",    5)),   // total within [dl-band, dl) → Bane
      baneDamage: Number(get("baneDamage", 15)),   // flat fire damage on Bane
      bestType:   String(get("bestType",  DP.TILE_TYPES.TREASURE)),
      worstType:  String(get("worstType", DP.TILE_TYPES.RANDOM_BATTLE)),
    };
  }

  // ── Party member resolution (mirrors tile-event-gusty.js) ──────────────────
  async function resolvePartyMembers() {
    const api = window.FUCompanion?.api;
    let partyActor = null;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.db ?? null;
    }
    if (!partyActor) { console.warn(TAG, "Party actor not resolved."); return []; }

    const props   = partyActor.system?.props ?? {};
    const members = [];
    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;
      let actor = null;
      try {
        actor = /^Actor\./i.test(rawId)
          ? await fromUuid(rawId)
          : (game.actors.get(rawId) ?? await fromUuid(`Actor.${rawId}`).catch(() => null));
      } catch {}
      if (actor) members.push(actor);
    }
    return members;
  }

  // ── Tier resolution ────────────────────────────────────────────────────────
  function resolveTier(leaderResult, cfg) {
    const lr = leaderResult;
    if (!lr || lr.isFumble) return "worst";
    if (lr.isCrit || lr.total >= cfg.dl) return "best";
    if (lr.total >= cfg.dl - cfg.baneBand) return "bane";
    return "worst";
  }

  // ── Bane: detonate on every participant (leader + helpers) ─────────────────
  async function detonate(result, cfg) {
    const dmgApi = globalThis.FUCompanion?.api?.applyDamage?.applyToActor;
    const rows   = [result.leaderResult, ...(result.helperResults ?? [])].filter(Boolean);
    const seen   = new Set();
    const victims = [];

    for (const row of rows) {
      if (!row.actorUuid || seen.has(row.actorUuid)) continue;
      seen.add(row.actorUuid);
      const doc   = await fromUuid(row.actorUuid).catch(() => null);
      const actor = doc?.actor ?? doc;
      if (!actor) continue;
      victims.push(actor.name);

      if (dmgApi) {
        await dmgApi({
          baseDamage:   cfg.baneDamage,
          elementType:  "fire",
          valueType:    "hp",
          isRecovery:   false,
          targetActor:  actor,
          attackerName: "Buried Explosive",
          sourceType:   "Tile",
          verbosity:    "silent",
        }).catch(e => console.warn(TAG, `detonate damage failed for ${actor.name}:`, e));
      }
    }
    return victims;
  }

  async function postExplosionCard(victims, cfg) {
    const names = victims.length ? victims.join(", ") : "the diggers";
    await ChatMessage.create({
      speaker: { alias: "Suspicious Mound" },
      content: `
        <div style="text-align:center;padding:9px 11px;border-radius:10px;
          background:linear-gradient(180deg,#fff0d6,#f3c08a);
          border:2px solid #b5471f;color:#5a1e0c;">
          <div style="font-size:1.5rem;line-height:1;margin-bottom:4px;">💥</div>
          <div style="font-weight:900;font-size:.95rem;margin-bottom:4px;">
            The mound was rigged!
          </div>
          <div style="font-size:.84rem;">
            A buried charge detonates — <b>${cfg.baneDamage} fire damage</b> to ${names}.
          </div>
        </div>`,
    }).catch(e => console.warn(TAG, "postExplosionCard failed:", e));
  }

  // ── Core GM-side resolution ────────────────────────────────────────────────
  async function runDirt(tileDoc, tokenDoc, scene) {
    if (!game.user?.isGM) return;

    const cfg = readDirtConfig(tileDoc);

    const actors = await resolvePartyMembers();
    if (!actors.length) {
      console.warn(TAG, "No party members found — skipping Dirt dig.");
      return;
    }

    const GC = globalThis.ONI?.GroupCheck;
    if (!GC?.request) {
      console.warn(TAG, "ONI.GroupCheck not loaded — skipping Dirt dig.");
      return;
    }

    // ── Group Check w/ lobby (open mode); DL hidden from players ──────────────
    let result;
    try {
      result = await GC.request({
        leaderUuid:      null,        // null + open mode → lobby opens
        participantMode: "open",
        allActorUuids:   actors.map(a => a.uuid),
        attrA:           cfg.attrA,
        attrB:           cfg.attrB,
        helperDl:        cfg.dl,
        leaderDl:        cfg.dl,
        helperBonus:     1,
        hiddenDl:        true,        // do not reveal DL to players
        label:           tileDoc?.name || "Dig the Mound",
        postChat:        true,
      });
    } catch (e) {
      // GM cancelled the lobby — leave the mound untouched and re-diggable.
      console.debug(TAG, "Group Check cancelled/aborted — mound left intact.", e?.message ?? e);
      return;
    }

    const tier = resolveTier(result?.leaderResult, cfg);
    console.debug(TAG, `Dig outcome → tier="${tier}" (leader total=${result?.leaderResult?.total}, dl=${cfg.dl})`);

    if (tier === "best") {
      // Strike gold — become a Treasure tile and reveal it immediately.
      await DP.TileTransform.transform(scene, tileDoc.id, cfg.bestType, {
        triggerNow: true,
        tokenDoc,
      });
      return;
    }

    if (tier === "bane") {
      // Buried explosive — flat fire damage to everyone who dug. Consume the mound.
      const victims = await detonate(result, cfg);
      await postExplosionCard(victims, cfg);
      await DP.Socket.clearTile(scene, tileDoc.id)
        .catch(e => console.warn(TAG, "clearTile (bane) failed:", e));
      return;
    }

    // worst — disturbed something. Spring a ONE-TIME ambush, then the disturbed
    // mound collapses into a blank tile (no lingering, re-triggering battle tile).
    await DP.TileTransform.transform(scene, tileDoc.id, cfg.worstType, {
      triggerNow: true,
      tokenDoc,
    });
    await DP.Socket.clearTile(scene, tileDoc.id)
      .catch(e => console.warn(TAG, "clearTile (worst) failed:", e));
  }

  // ── GM-side socket listener (installed on all clients; only GM acts) ────────
  function setupSocketListener() {
    const GUARD = "__ONI_DP_DIRT_SOCKET__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (msg?.type !== MSG_TYPE) return;
      if (!game.user?.isGM) return;
      // Multi-GM dedupe: both GMs receive the player's trigger. Gate to the
      // primary GM so the dig lobby + tier outcome (damage / transform) run once.
      if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;

      const { sceneId, tileId, tokenId } = msg.payload ?? {};
      const scene    = game.scenes.get(sceneId);
      const tileDoc  = scene?.tiles.get(tileId);
      const tokenDoc = scene?.tokens.get(tokenId);

      if (!scene || !tileDoc) {
        console.warn(TAG, "DP_TRIGGER_DIRT: could not resolve scene/tile", { sceneId, tileId });
        return;
      }

      await runDirt(tileDoc, tokenDoc, scene)
        .catch(e => console.error(TAG, "runDirt (socket) failed:", e));
    });

    console.debug(TAG, "GM socket listener installed.");
  }

  // ── Registration ───────────────────────────────────────────────────────────
  DP.TileEventRegistry.register(DP.TILE_TYPES.DIRT, {
    label:             "Dirt (Suspicious Mound)",
    clearAfterTrigger: false,   // handler owns lifecycle (transform / consume)

    async handler(tileDoc, tokenDoc, scene) {
      if (game.user?.isGM) {
        // GM can run the resolution directly.
        await runDirt(tileDoc, tokenDoc, scene);
      } else {
        // Player dug: relay to the GM, who owns the check/damage/transform.
        game.socket.emit(SOCKET_CH, {
          type:    MSG_TYPE,
          payload: { sceneId: scene.id, tileId: tileDoc.id, tokenId: tokenDoc?.id ?? null },
        });
      }
    },
  });

  Hooks.once("ready", () => { setupSocketListener(); });
})();
