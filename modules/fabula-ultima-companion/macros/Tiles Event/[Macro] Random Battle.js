/*------------------------------------------------------------------
  Random-Battle Tile  (auto-scaling encounter rate) – Foundry VTT v12
  MULTI-GAME UPDATE:
    - Reads DB id/uuid from Actor.DMpK5Bi119jIrCFZ → system.props.game_id
    - Token override supported (placed token with DB actor's name)
------------------------------------------------------------------*/
(async () => {

  /* ---------- 0. Identify the triggering tile ------------------- */
  const tileDoc =
          typeof _tile     !== "undefined" ? _tile
        : typeof tile      !== "undefined" ? tile
        : typeof thisTile  !== "undefined" ? thisTile
        : null;
  if (!tileDoc) return ui.notifications.error("Random Battle | No tile context.");

  /* ---------- 1. Multi-game DB resolver ------------------------- */
  const CURRENT_GAME_ACTOR_UUID = "Actor.DMpK5Bi119jIrCFZ";
  async function resolveDb() {
    const cg = await fromUuid(CURRENT_GAME_ACTOR_UUID).catch(() => null);
    if (!cg) { ui.notifications.error("Random Battle | 'Current Game' sheet not found."); return {}; }

    const raw = getProperty(cg, "system.props.game_id")?.trim();
    if (!raw) { ui.notifications.error("Random Battle | Set the Current Game Database ID on the 'Current Game' sheet."); return {}; }

    let dbActor = null, normalizedUuid = raw;
    if (/^\s*Actor\./i.test(raw)) dbActor = await fromUuid(raw).catch(() => null);
    else { dbActor = game.actors?.get(raw) ?? await fromUuid(`Actor.${raw}`).catch(() => null); normalizedUuid = `Actor.${raw}`; }

    if (!dbActor) { ui.notifications.error(`Random Battle | Database actor not found: ${normalizedUuid}`); return {}; }

    // Optional token override (per-scene custom props)
    const dbToken  = canvas.tokens?.placeables.find(t => t.name === dbActor.name);
    const dbSource = dbToken?.actor ?? dbActor;

    return { dbSource, dbWriteTarget: dbSource };
  }

  const { dbSource: dbActor, dbWriteTarget } = await resolveDb();
  if (!dbActor) return;

  /* ---------- 2. Helper to coerce stored strings into % --------- */
  const props = dbActor.system?.props ?? {};
  const toPct = (v, dflt = 0) => {
    const n = parseFloat(v);
    if (isNaN(n)) return dflt;
    return n > 1 ? Math.min(n, 100) : n * 100;       // allow 0-1 or 0-100
  };

  const pctEncounter = toPct(props.random_battle_percentage, 0);
  const pctAmbush    = toPct(props.ambush_percentage,        0);
  const pctAdvantage = toPct(props.advantage_percentage,     0);
  const pctNormal    = toPct(props.normal_percentage,       100);
  const pctMinimum   = toPct(props.minimum_encounter_percentage, 5); // default 5 %

  /* ---------- 3. Check if anything appears ---------------------- */
  const d100   = () => Math.floor(Math.random() * 100) + 1;
  const appear = d100() <= pctEncounter;

  let outcome = "Nothing appears…";
  let bgColor = "";
  let sfx     = "";

  if (appear) {
    /* ---------- 4. Decide battle type (weighted) ---------------- */
    const pool    = pctAmbush + pctAdvantage + pctNormal || 1;
    const rollVal = Math.random() * pool;

    if (rollVal < pctAmbush) {                          // Enemy Ambush
      outcome = "ENEMY AMBUSH!";
      bgColor = "#b80022";
      sfx     = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Down2.ogg";
    } else if (rollVal < pctAmbush + pctAdvantage) {    // Player Advantage
      outcome = "PLAYER ADVANTAGE!";
      bgColor = "#0a61c8";
      sfx     = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up4.ogg";
    } else {                                            // Normal
      outcome = "A WILD ENEMY APPEARS!";
      bgColor = "#3a3a3a";
      sfx     = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Monster1.ogg";
    }
  }

  /* ---------- 5. Post the chat card ----------------------------- */
  const style = bgColor
      ? `font-size:2rem;font-weight:bold;text-align:center;
         padding:10px;border:3px solid #000;color:#fff;background:${bgColor};`
      : `font-size:1.4rem;font-style:italic;text-align:center;padding:6px;`;

  await ChatMessage.create({ speaker:{alias:"System"}, content:`<div style="${style}">${outcome}</div>` });

  /* ---------- 6. Play SFX -------------------------------------- */
  if (sfx) {
    try {
      if (game.modules.get("sequencer")?.active) await new Sequence().sound(sfx).play();
      else AudioHelper.play({ src:sfx, volume:0.8, autoplay:true });
    } catch(e){ console.warn("Random Battle | SFX error", e); }
  }

  /* ---------- 7. Adjust & write back encounter-rate ------------- */
  let newPct = pctEncounter;

  if (!appear) {
    // Missed encounter → +20-30 %
    const inc = 20 + Math.random() * 10;                 // 20-30
    newPct = Math.min(100, pctEncounter + inc);
  } else {
    // Got encounter → halve, but not below minimum
    newPct = Math.max(pctMinimum, Math.round(pctEncounter * 0.5));
  }

  // Update only if something changed
  if (newPct !== pctEncounter) {
    await dbWriteTarget.update({ "system.props.random_battle_percentage": String(Math.round(newPct)) });
  }

  /* ---------- 8. Debug info ------------------------------------ */
  console.log(`Random Battle | ${appear ? "Encounter!" : "No encounter"}  •  Old%:${pctEncounter} → New%:${newPct}`);

  /* ---------- 9. Keep tile unchanged --------------------------- */
  // Intentionally do nothing here so the tile remains the same
  // and can trigger again when stepped on later.

})();
