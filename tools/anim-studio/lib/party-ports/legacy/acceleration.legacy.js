// ONI — Clockwork Blades (polished: X-only sidestep, no Y drift)
(async () => {
  const TAG = "[ONI][FX]";
  // --- Assets ---
  const SFX_MOVE   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Beginspell.mp3";
  const FX_TARGET  = "modules/boss-loot-assets-free/artwork/07-steampunk/clock/Clockwork_Blades_1_1200x1200.webm";
  const SFX_TARGET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Haste.ogg";
  // --- Checks ---
  if (!game.modules.get("sequencer")?.active) {
    ui.notifications.error(`${TAG} Sequencer module is not active.`);
    return;
  }
  const caster = canvas.tokens.controlled?.[0];
  if (!caster) {
    ui.notifications.warn(`${TAG} Please SELECT exactly 1 token (the caster).`);
    return;
  }
  const targets = Array.from(game.user.targets ?? []);
  if (targets.length !== 1) {
    ui.notifications.warn(`${TAG} Please TARGET exactly 1 token.`);
    return;
  }
  const target = targets[0];
  // --- X-only movement using DOCUMENT coords (top-left) ---
  const original = { x: caster.document.x, y: caster.document.y };
  const disp = caster.document.disposition;
  const squares = 0.35; // tweak distance here
  const offsetPx = canvas.grid.size * squares;
  // Hostile (-1) => move RIGHT, else => move LEFT
  const dx = (disp === -1) ? +offsetPx : -offsetPx;
  // IMPORTANT: Y stays EXACTLY original.y (no touching Y)
  const destOut  = { x: original.x + dx, y: original.y };
  const destBack = { x: original.x,      y: original.y };
  // ✅ animation start hook
  Hooks.callAll("oni:animationStart", { tag: "ClockworkBlades", tokenId: caster.id });
  const seq = new Sequence()
    // Movement sound
    .sound()
      .file(SFX_MOVE)
      .volume(0.9)
    // Move out (X-only destination)
    .animation()
      .on(caster)
      .moveTowards(destOut)
      .duration(350)
      .waitUntilFinished()
    // wait 0.5s
    .wait(500)
    // Target SFX + FX
    .sound()
      .file(SFX_TARGET)
      .volume(0.9)
    .effect()
      .file(FX_TARGET)
      .atLocation(target)
      .scaleToObject(2.15)
      .anchor({ x: 0.5, y: 0.5 })
      .opacity(1.0)
      .belowTokens(false)
      .waitUntilFinished()
    // wait 0.5s
    .wait(500)
    // Move back (exact original)
    .animation()
      .on(caster)
      .moveTowards(destBack)
      .duration(350)
      .waitUntilFinished();
  await seq.play();
  // Hard guarantee: snap back exactly (still does not change Y beyond original)
  if (caster.document.x !== original.x || caster.document.y !== original.y) {
    await caster.document.update({ x: original.x, y: original.y });
  }
  // ✅ animation end hook
  Hooks.callAll("oni:animationEnd", { tag: "ClockworkBlades", tokenId: caster.id });
})();