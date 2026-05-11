// ============================================================================
// Dungeon Pathing — Tile Event: Random Battle
// Auto-scaling encounter rate.  Ported from:
//   macros/Tiles Event/[Macro] Random Battle.js
//
// Does NOT clear the tile after triggering (the tile remains active for
// future landings).
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][random_battle]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  async function resolveDb() {
    const CURRENT_GAME_UUID = "Actor.DMpK5Bi119jIrCFZ";

    const api = window.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      try {
        const res = await api.getCurrentGameDb();
        if (res?.db) return { dbSource: res.db, dbWriteTarget: res.db };
      } catch {}
    }

    // Legacy fallback
    const cg = await fromUuid(CURRENT_GAME_UUID).catch(() => null);
    if (!cg) {
      ui.notifications?.error?.("Random Battle | 'Current Game' sheet not found.");
      return {};
    }
    const raw = foundry.utils.getProperty(cg, "system.props.game_id")?.trim();
    if (!raw) {
      ui.notifications?.error?.("Random Battle | Set the Current Game Database ID on the 'Current Game' sheet.");
      return {};
    }

    let dbActor = null;
    if (/^\s*Actor\./i.test(raw)) {
      dbActor = await fromUuid(raw).catch(() => null);
    } else {
      dbActor = game.actors?.get(raw) ?? await fromUuid(`Actor.${raw}`).catch(() => null);
    }

    if (!dbActor) {
      ui.notifications?.error?.(`Random Battle | Database actor not found: ${raw}`);
      return {};
    }

    const dbToken  = canvas.tokens?.placeables.find(t => t.name === dbActor.name);
    const dbSource = dbToken?.actor ?? dbActor;
    return { dbSource, dbWriteTarget: dbSource };
  }

  const toPct = (v, dflt = 0) => {
    const n = parseFloat(v);
    if (isNaN(n)) return dflt;
    return n > 1 ? Math.min(n, 100) : n * 100;
  };

  DP.TileEventRegistry.register(DP.TILE_TYPES.RANDOM_BATTLE, {
    label:             "Random Battle",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      const { dbSource: dbActor, dbWriteTarget } = await resolveDb();
      if (!dbActor) return;

      const props       = dbActor.system?.props ?? {};
      const pctEnc      = toPct(props.random_battle_percentage, 0);
      const pctAmbush   = toPct(props.ambush_percentage, 0);
      const pctAdv      = toPct(props.advantage_percentage, 0);
      const pctNormal   = toPct(props.normal_percentage, 100);
      const pctMinimum  = toPct(props.minimum_encounter_percentage, 5);

      const d100   = () => Math.floor(Math.random() * 100) + 1;
      const appear = d100() <= pctEnc;

      let outcome = "Nothing appears…", bgColor = "", sfx = "";

      if (appear) {
        const pool   = pctAmbush + pctAdv + pctNormal || 1;
        const roll   = Math.random() * pool;

        if (roll < pctAmbush) {
          outcome = "ENEMY AMBUSH!";   bgColor = "#b80022";
          sfx = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Down2.ogg";
        } else if (roll < pctAmbush + pctAdv) {
          outcome = "PLAYER ADVANTAGE!"; bgColor = "#0a61c8";
          sfx = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up4.ogg";
        } else {
          outcome = "A WILD ENEMY APPEARS!"; bgColor = "#3a3a3a";
          sfx = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Monster1.ogg";
        }
      }

      const style = bgColor
        ? `font-size:2rem;font-weight:bold;text-align:center;padding:10px;border:3px solid #000;color:#fff;background:${bgColor};`
        : `font-size:1.4rem;font-style:italic;text-align:center;padding:6px;`;

      // Fire-and-forget: don't block the turn flow waiting for the chat message
      ChatMessage.create({ speaker: { alias: "System" }, content: `<div style="${style}">${outcome}</div>` })
        .catch(e => console.warn(TAG, "ChatMessage.create failed:", e));

      if (sfx) {
        try {
          if (game.modules.get("sequencer")?.active) new Sequence().sound(sfx).play();
          else AudioHelper.play({ src: sfx, volume: 0.8, autoplay: true });
        } catch (e) { console.warn(TAG, "SFX error", e); }
      }

      // Adjust encounter rate
      let newPct = pctEnc;
      if (!appear) {
        newPct = Math.min(100, pctEnc + 20 + Math.random() * 10);
      } else {
        newPct = Math.max(pctMinimum, Math.round(pctEnc * 0.5));
      }

      console.debug(TAG, appear ? "Encounter!" : "No encounter", `Old%:${pctEnc} → New%:${newPct}`);

      // Fire-and-forget: encounter % persists asynchronously; turn flow continues immediately
      if (newPct !== pctEnc && dbWriteTarget) {
        dbWriteTarget.update({ "system.props.random_battle_percentage": String(Math.round(newPct)) })
          .catch(e => console.warn(TAG, "encounter % update failed:", e));
      }
    }
  });
})();
