// ============================================================================
// Dungeon Pathing — Tile Event: Gathering
//
// On landing, the party harvests materials from the local flora/fauna. Flow:
//   1. Every party member is prompted for a DEX + INS Check (ONI.CheckRequester,
//      interactive, DL hidden — the reward tiers are a backend formula players
//      don't see).
//   2. After all checks resolve, each member's roll TOTAL determines how many
//      Material items they pull from the scene's Material Table (oniDungeon.loot.material):
//        base 1  •  total >= 10 → +1  •  then +1 per additional 5 (15→+2, 20→+3…)
//   3. A 15% per-member chance also drops 25–250 Zenit.
//   4. Members who own the "Resourceful" skill (Item.EO5v5UChnByyIVGp) recover
//      [SL] Inventory Points (SL = the skill's level, capped at its max 4).
//   5. A bond-summary-styled reveal (ONI.GatheringSummaryUI) animates every
//      member's haul in sequence, then the tile is cleared.
//
// GM routing mirrors tile-event-dirt/fishing: the whole flow (checks, rolltable
// draws, item/zenit/IP grants, tile clear) needs GM authority, so a player-
// triggered landing is relayed to the primary GM. clearAfterTrigger:false — the
// GM clears the tile itself when the flow finishes (honours "reset on rest").
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing;
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEvent][gathering]";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const MSG_TRIGGER = "DP_TRIGGER_GATHERING";
  const MSG_SHOW    = "DP_GATHERING_SHOW";
  const MSG_DONE    = "DP_GATHERING_DONE";

  const RESOURCEFUL_ID = "EO5v5UChnByyIVGp";   // Item.EO5v5UChnByyIVGp

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // Tiles whose gathering flow is currently running (re-entry guard, GM-side).
  const _busy = new Set();

  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  // ── Party resolution (member_id_1..4 on the DB actor) ──────────────────────
  async function resolvePartyMembers() {
    const api = window.FUCompanion?.api;
    let partyActor = null;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.db ?? res?.source ?? null;
    }
    if (!partyActor) { console.warn(TAG, "Party/DB actor not resolved."); return []; }

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

  function getTokenImg(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || proto || actor?.img || "icons/svg/mystery-man.svg";
  }

  // ── Reward formula ─────────────────────────────────────────────────────────
  // base 1; total >= 10 → +1; then +1 per additional 5 above 10.
  function computeMaterialCount(total) {
    let c = 1;
    if (total >= 10) c += 1 + Math.floor((total - 10) / 5);
    return c;
  }

  // ── Material Table resolution (scene oniDungeon.loot.material) ──────────────
  async function resolveMaterialTable(scene) {
    let uuid = "";
    try {
      const dungeon = window.oni?.FabulaConfig?.readDungeon?.(scene)
                   ?? scene?.getFlag?.(MODULE_ID, "oniDungeon")
                   ?? {};
      uuid = String(dungeon?.loot?.material ?? "").trim();
    } catch {}
    if (!uuid) return null;
    const byId = game.tables?.get(uuid);
    if (byId) return byId;
    try {
      const doc = await fromUuid(uuid);
      if (doc?.documentName === "RollTable") return doc;
    } catch {}
    return null;
  }

  // Roll `count` times (with replacement) and tally linked Item results by uuid.
  async function drawMaterials(table, count) {
    const bag = new Map(); // uuid → { uuid, name, img, qty }
    for (let i = 0; i < count; i++) {
      let picked = null;
      try {
        const rolled = await table.roll({ displayChat: false });
        picked = rolled?.results?.[0] ?? null;
      } catch (e) { console.warn(TAG, "material roll failed:", e); }
      if (!picked) continue;

      let uuid = null;
      let name = picked.text || "Material";
      let img  = picked.img  || "icons/svg/item-bag.svg";
      if (picked.documentCollection && picked.documentId) {
        try {
          const linked = await picked.getDocument?.();
          if (linked) { name = linked.name ?? name; img = linked.img ?? img; uuid = linked.uuid; }
          else uuid = `${picked.documentCollection}.${picked.documentId}`;
        } catch { uuid = `${picked.documentCollection}.${picked.documentId}`; }
      }
      if (!uuid) continue; // text-only row — nothing to grant

      const entry = bag.get(uuid) ?? { uuid, name, img, qty: 0 };
      entry.qty += 1;
      bag.set(uuid, entry);
    }
    return [...bag.values()];
  }

  // ── Resourceful (Wayfarer) — recover [SL] Inventory Points ─────────────────
  function findResourceful(actor) {
    return actor?.items?.find(it =>
      it.name === "Resourceful" ||
      String(it.flags?.core?.sourceId ?? "").includes(RESOURCEFUL_ID) ||
      String(it.system?.props?.id ?? "") === RESOURCEFUL_ID
    ) ?? null;
  }

  async function awardResourcefulIP(actor) {
    const skill = findResourceful(actor);
    if (!skill) return null;
    const maxLv = Math.max(1, safeInt(skill.system?.props?.max_level, 4));
    const sl    = Math.max(1, Math.min(maxLv, safeInt(skill.system?.props?.level, 1)));

    // IP path varies by sheet template — prefer system.actor.props, fall back to system.props.
    const hasNested = actor.system?.actor?.props?.current_ip !== undefined;
    const curPath   = hasNested ? "system.actor.props.current_ip" : "system.props.current_ip";
    const cur = safeInt(hasNested ? actor.system?.actor?.props?.current_ip : actor.system?.props?.current_ip, 0);
    const max = Math.max(0, safeInt(hasNested ? actor.system?.actor?.props?.max_ip : actor.system?.props?.max_ip, 0));
    if (max <= 0) return { sl, applied: 0 };

    const newCur  = Math.min(max, cur + sl);
    const applied = Math.max(0, newCur - cur);
    if (applied > 0) {
      await actor.update({ [curPath]: newCur })
        .catch(e => console.warn(TAG, `Resourceful IP update failed for ${actor.name}:`, e));
    }
    return { sl, applied };
  }

  // ── Main flow (GM only) ────────────────────────────────────────────────────
  async function runGathering(scene, tileDoc, tokenDoc) {
    if (!game.user?.isGM) return;
    if (!scene || !tileDoc) return;
    if (_busy.has(tileDoc.id)) { console.debug(TAG, "Already running for this tile; ignoring."); return; }
    _busy.add(tileDoc.id);

    try {
      const CR  = globalThis.ONI?.CheckRequester;
      const itc = window["oni.ItemTransferCore"];
      if (!CR?.request) { ui.notifications?.warn("Gathering | Check Requester not loaded."); return; }
      if (!itc?.transfer) { ui.notifications?.warn("Gathering | ItemTransferCore not loaded."); return; }

      const members = await resolvePartyMembers();
      if (!members.length) { ui.notifications?.warn("Gathering | No party members found."); return; }

      const matTable = await resolveMaterialTable(scene);
      if (!matTable) {
        ui.notifications?.warn("Gathering | No Material Table configured on this scene (Dungeon Configuration → Loot → Material). Tile left active.");
        return; // leave tile so it can be retried once configured
      }

      // 1 — DEX + INS Check for every member (DL hidden; reward is backend-only).
      let results;
      try {
        results = await CR.request(members, {
          attrA:    "DEX",
          attrB:    "INS",
          dl:       10,
          label:    tileDoc?.name || "Gathering",
          mode:     "interactive",
          hiddenDl: true,
          postChat: false,
        });
      } catch (e) {
        console.debug(TAG, "Check cancelled — tile left active.", e?.message);
        return;
      }
      const byUuid = new Map((results ?? []).map(r => [r.actorUuid, r]));

      // 2 — Resolve + grant each member's haul.
      const summary = [];
      for (const member of members) {
        const total = safeInt(byUuid.get(member.uuid)?.total, 0);
        const count = computeMaterialCount(total);

        const materials = await drawMaterials(matTable, count);
        for (const e of materials) {
          await itc.transfer({
            mode:              "gmToActor",
            itemUuid:          e.uuid,
            quantity:          e.qty,
            receiverActorUuid: member.uuid,
            requestedByUserId: game.user?.id,
            showTransferCard:  false,
          }).catch(err => console.warn(TAG, `grant ${e.name} → ${member.name} failed:`, err));
        }

        let zenit = 0;
        if (Math.random() < 0.15) {
          zenit = randInt(25, 250);
          await itc.adjustZenit({
            actorUuid:         member.uuid,
            delta:             zenit,
            requestedByUserId: game.user?.id,
          }).catch(err => { console.warn(TAG, `zenit → ${member.name} failed:`, err); zenit = 0; });
        }

        const resourceful = await awardResourcefulIP(member);

        summary.push({
          actorUuid:  member.uuid,
          actorName:  member.name,
          tokenImg:   getTokenImg(member),
          materials:  materials.map(e => ({ name: e.name, img: e.img, qty: e.qty })),
          zenit,
          resourceful,   // { sl, applied } | null
        });
      }

      // 3 — Animated reveal on every client, then clear the tile.
      const UI = globalThis.ONI?.GatheringSummaryUI;
      game.socket.emit(SOCKET_CH, { type: MSG_SHOW, payload: { summary } });
      if (UI?.show) await UI.show(summary).catch(e => console.warn(TAG, "reveal (GM) failed:", e));
      game.socket.emit(SOCKET_CH, { type: MSG_DONE });
      UI?.hide?.();

      await DP.TileState.clearTile(scene, tileDoc.id)
        .catch(e => console.warn(TAG, "clearTile failed:", e));
    } finally {
      _busy.delete(tileDoc.id);
    }
  }

  // ── Socket listener (installed on all clients; GM acts on trigger) ──────────
  function setupSocketListener() {
    const GUARD = "__ONI_DP_GATHERING_SOCKET__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (!msg?.type) return;

      if (msg.type === MSG_TRIGGER) {
        if (!game.user?.isGM) return;
        // Multi-GM dedupe: gate to the primary GM so one flow runs.
        if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;
        const { sceneId, tileId, tokenId } = msg.payload ?? {};
        const scene    = game.scenes.get(sceneId);
        const tileDoc  = scene?.tiles.get(tileId);
        const tokenDoc = scene?.tokens.get(tokenId);
        if (!scene || !tileDoc) {
          console.warn(TAG, "DP_TRIGGER_GATHERING: could not resolve scene/tile", { sceneId, tileId });
          return;
        }
        runGathering(scene, tileDoc, tokenDoc)
          .catch(e => console.error(TAG, "runGathering (socket) failed:", e));
        return;
      }

      // Reveal / dismiss are driven by the GM for every client (incl. spectators).
      if (msg.type === MSG_SHOW && !game.user?.isGM) {
        globalThis.ONI?.GatheringSummaryUI?.show?.(msg.payload?.summary ?? [])
          .catch?.(e => console.warn(TAG, "reveal (client) failed:", e));
        return;
      }
      if (msg.type === MSG_DONE && !game.user?.isGM) {
        globalThis.ONI?.GatheringSummaryUI?.hide?.();
        return;
      }
    });

    console.debug(TAG, "GM socket listener installed.");
  }

  // ── Registration ───────────────────────────────────────────────────────────
  DP.TileEventRegistry.register(DP.TILE_TYPES.GATHERING, {
    label:             "Gathering",
    clearAfterTrigger: false,   // GM clears the tile itself after the flow completes

    async handler(tileDoc, tokenDoc, scene) {
      if (game.user?.isGM) {
        runGathering(scene, tileDoc, tokenDoc);
      } else {
        game.socket.emit(SOCKET_CH, {
          type:    MSG_TRIGGER,
          payload: { sceneId: scene?.id, tileId: tileDoc?.id, tokenId: tokenDoc?.id ?? null },
        });
      }
    },
  });

  Hooks.once("ready", () => { setupSocketListener(); });
})();
