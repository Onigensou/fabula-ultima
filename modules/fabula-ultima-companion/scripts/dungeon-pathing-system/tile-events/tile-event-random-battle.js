// ============================================================================
// Dungeon Pathing — Tile Event: Random Battle
// ----------------------------------------------------------------------------
// Thin request only. Everything that decides the outcome — the encounter roll,
// the ambush/advantage roll, the group selection, the pity rate and the battle
// launch — lives GM-side in dp-random-battle.js, because:
//
//   - this handler runs on whichever client walked the turn, and the rolls now
//     drive real combat, so they must be authoritative rather than per-client;
//   - the Battle Director's start() is GM-only.
//
// Does NOT clear the tile after triggering — a Random Battle tile stays live
// for every future landing.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing;
  const TAG = "[DungeonPathing][TileEvent][random_battle]";

  if (!DP?.TileEventRegistry) {
    console.warn(TAG, "TileEventRegistry not ready.");
    return;
  }

  // ── Silent miss hold ───────────────────────────────────────────────────────
  // A hit keeps the party waiting through the GM's override window, so a miss
  // that came straight back would give the result away. Hold the turn (busy
  // stays set, so the party cannot move) for one of three fixed patterns, then
  // let the turn end; the next turn's start is the only thing that follows.
  // No sound, no text. Per client: only the walking client holds.
  let _lastHoldWasRare = false;

  function pickHoldMs() {
    const pats = DP.UI?.RANDOM_BATTLE_HOLD?.PATTERNS;
    if (!Array.isArray(pats) || !pats.length) return 0;
    let pick = pats[0];
    // A longer hold never comes twice in a row: players learn the rhythm.
    if (!_lastHoldWasRare) {
      const total = pats.reduce((s, p) => s + Math.max(0, Number(p.weight) || 0), 0) || 1;
      let r = Math.random() * total;
      for (const p of pats) { r -= Math.max(0, Number(p.weight) || 0); if (r < 0) { pick = p; break; } }
    }
    _lastHoldWasRare = pick !== pats[0];
    return Math.max(0, Number(pick.ms) || 0);
  }

  async function holdSince(t0) {
    const left = pickHoldMs() - (performance.now() - t0);
    if (left > 0) await new Promise(r => setTimeout(r, left));
  }

  // Exposed for the offline spread check (tools/) only.
  DP.RandomBattleHold = { pickHoldMs };

  DP.TileEventRegistry.register(DP.TILE_TYPES.RANDOM_BATTLE, {
    label:             "Random Battle",
    clearAfterTrigger: false,

    async handler(tileDoc, tokenDoc, scene) {
      // A STORY battle (Tile Config → "Story battle") always triggers — no pity
      // roll — and hands the GM the Battle Prompt to set the fight up by hand.
      const story = tileDoc?.flags?.[DP.MODULE_ID ?? "fabula-ultima-companion"]?.[DP.PATHING_ROOT_KEY]?.storyBattle;
      const opts  = (story === true || story === "true") ? { forced: true, verdict: "customize" } : {};
      let res = null;
      const t0 = performance.now();   // ≈ the moment the player confirmed
      try {
        res = await DP.Socket.requestRandomBattle(scene, tileDoc?.id, tokenDoc?.id, opts);
      } catch (e) {
        // A throw here would strand the player's dungeon turn — swallow it and
        // let the turn end normally instead.
        console.error(TAG, "requestRandomBattle failed:", e);
        return;
      }

      if (!res?.ok) {
        console.warn(TAG, "random battle not resolved:", res?.error ?? "(no reason given)");
        return;
      }

      // A battle is starting: the canvas is about to tear down, so tell the turn
      // loop to skip its closing graph rebuild. Without this the rebuild races
      // the scene switch and warns "party token not found" on the way out.
      if (res.launched) {
        const st = globalThis.__ONI_DUNGEON_PATHING__?.state;
        if (st) st.battleLaunching = true;
        return;
      }

      // A pity-roll miss: hide it behind the silent hold. Story, fixed and
      // already-won battles never rolled, so they end at once.
      if (res.rolled && !res.appear) await holdSince(t0);
    }
  });
})();
