(async () => {
  // 1. Grab your selected tile
  const tiles = canvas.tiles.controlled;
  if (!tiles.length) {
    return ui.notifications.error("Please select a tile first.");
  }
  const tile = tiles[0];

  // 2. Change its image to the Blank Tile
  const BLANK_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Blank_Tile.png";
  await tile.document.update({ "texture.src": BLANK_SRC });

  // 3. Play the smoke puff + door sound
  await new Sequence()
    .effect("modules/JB2A_DnD5e/Library/Generic/Smoke/SmokePuffRing01_02_Regular_White_400x400.webm")
      .atLocation(tile)
    .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Door1.ogg")
    .play();
})();
