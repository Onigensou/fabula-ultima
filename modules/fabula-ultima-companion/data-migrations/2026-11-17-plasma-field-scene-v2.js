/**
 * Migration: 2026-11-17-plasma-field-scene-v2  (Plasma Field, layout 2)
 * ---------------------------------------------------------------------------
 * User call (2026-11-17): the arrival and the thank-you should play on a map
 * that looks like the minigame, as if the party never left it.
 *
 *  - Background: a still of the real course (course.webp), rendered by the
 *    game itself (pf-game.js renderStill: the last stretch and Hako's cradle,
 *    1.5x the game's units, grid 128 so tokens stand at the runners' size).
 *  - One opening (user picked "a"): the event does the arrival (pan up the
 *    course to Hako, her lines) and the minigame opens straight on practice.
 *  - After the race, under the black curtain the game leaves behind, the
 *    party and Hako are put where the finale left them, beside the cradle,
 *    and she thanks them there.
 *  - Waterfall Trail's story tile lands the party at the new arrival point.
 *
 * Runs after 2026-11-17-plasma-field-world (which seeds layout 1). ONE-TIME and
 * careful: it changes the scene only while it still has layout 1's background,
 * so a scene someone has re-done by hand is left alone.
 */

export const key = "2026-11-17-plasma-field-scene-v2";
export const description = "Plasma Field: the course still as the scene, one opening, thank-you beside the cradle.";

const M = "fabula-ultima-companion";
const EV = "oni-event-system";
const FLAG = "plasmaField";
const WATERFALL_ID = "YR0pYJVokhIgKQj0";
const STORY_TILE_ID = "A8FxNTihukxgXCkZ";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ART = `modules/${M}/assets/minigame/plasma-field/`;
const STARE_SFX = FORGE + "Sound/Stare.ogg";
const BACK = { x: 676, y: 728 };

// The game's course (960 units wide) at 1.5x: Hako's cradle at (480, 445) -> (720, 667).
const S = 1.5;
const W = 1440, H = 2250, GRID = 128;
const at = (x, y) => ({ x: Math.round(x*S), y: Math.round(y*S) });
const ARRIVE = at(480, 1350);           // the party comes up the course to here
const CRADLE = at(480, 445);            // the cradle's foot (camera mark)
const HAKO_PERCH = at(480, 296);        // Hako's centre, perched in the roots
const FINISH = at(393, 515);            // where the finale leaves the winner: beside the cradle
const HAKO_FREE = at(460, 506);         // ...and Hako beside them

const rid = () => foundry.utils.randomID(16);
const text = (speaker, t) => ({ type: "showText", speaker, text: t, bubbleMode: "normal", id: rid() });
const fx = (effect, seconds = 0.5, wait = true) => ({ type: "screenEffect", effect, color: "#000000", strength: effect.startsWith("letterbox") ? 0.11 : 0, seconds, wait, id: rid() });
const wait = (seconds) => ({ type: "wait", seconds, id: rid() });
const pan = (o) => ({ type: "cameraPan", dx: 0, dy: 0, name: "", zoom: 0, seconds: 1.6, motion: "smooth", wait: true, id: rid(), ...o });
const place = (target, name, p) => ({ type: "setTokenPosition", target, name, mode: "point", mark: "", x: p.x, y: p.y, id: rid() });
const backToTrail = () => [fx("fadeOut", 0.6), { type: "changeScene", scene: WATERFALL_ID, arrival: "point", mark: "", x: BACK.x, y: BACK.y, id: rid() }, fx("fadeIn", 0.6)];

function arrivalRows() {
  const firstTime = [
    { type: "setFacing", target: "party", name: "", direction: "up", id: rid() },
    fx("letterboxIn"),
    { type: "playSound", src: STARE_SFX, volume: 0.6, wait: false, id: rid() },
    { type: "showEmote", target: "party", name: "", emote: "Exc", side: "auto", seconds: 1.2, wait: true, id: rid() },
    pan({ mode: "token", name: "Hako", seconds: 3.2 }),
    text("Hako", "Is somebody there?! Over here! Up on the roots!"),
    text("Hako", "These roots grabbed me and won't let go, and every few seconds… BZZT! Ow!"),
    text("Hako", "Whoever reaches me first gets my undying gratitude! And maybe a discount!"),
    pan({ mode: "party", seconds: 1.4 }),
    fx("letterboxOut"),
    { type: "startMinigame", game: "plasma-field", intro: "none", rewardSwitch: "PlasmaFieldCleared", id: rid() },
    // the game closes to black and holds a moment: the party and Hako are put where the finale left them
    place("party", "", FINISH),
    place("token", "Hako", HAKO_FREE),
    { type: "setFacing", target: "party", name: "", direction: "right", id: rid() },
    pan({ mode: "token", name: "Hako", dy: -40, seconds: 0.05 }),
    fx("letterboxIn", 0.3, false),
    wait(0.6),
    text("Hako", "Phew… I'm free! Thank you, thank you, thank you!"),
    text("Hako", "I only came out here looking for rare crystals to sell. The storm found me first."),
    text("Hako", "This valley is far too dangerous for a humble merchant. Could I stay somewhere safe… like your camp?"),
    text("Hako", "I'll keep my shop open for you. Come and find me whenever you rest!"),
    { type: "setSwitch", scope: "story", name: "HakoAtValleyCamp", slot: "A", value: "on", id: rid() },
    fx("letterboxOut"),
    ...backToTrail(),
  ];
  const replay = [
    pan({ mode: "token", name: "Plasma Field Cradle", seconds: 2.0 }),
    wait(0.4),
    pan({ mode: "party", seconds: 1.0 }),
    { type: "startMinigame", game: "plasma-field", intro: "none", rewardSwitch: "PlasmaFieldCleared", id: rid() },
    place("party", "", FINISH),
    pan({ mode: "party", seconds: 0.05 }),
    wait(0.8),
    ...backToTrail(),
  ];
  return [{ type: "condition", condition: { kind: "switch", name: "PlasmaFieldCleared", want: "on" },
    moreConditions: [], combine: "all", hasElse: true, thenRows: replay, elseRows: firstTime, id: rid() }];
}

const eventFlags = (rows, { startMode, proximityPx = 0 }) =>
  ({ isEventTile: true, startMode, onceOnly: false, lockMovement: true, proximityPx, eventRows: rows, eventRowsJsonPreview: JSON.stringify(rows).slice(0, 2000) });

export async function migrate(game, log = console.log) {
  const scene = game.scenes.find((s) => s.getFlag(M, FLAG) === "scene");
  if (!scene) return { applied: true, summary: "No Plasma Field scene; nothing to upgrade." };
  if ((scene.getFlag(M, "plasmaFieldLayout") ?? 1) >= 2) return { applied: true, summary: "Already layout 2." };
  if (scene.background?.src !== ART + "ground.webp") return { applied: true, summary: "Plasma Field was changed by hand; left as is." };

  await scene.update({
    "background.src": ART + "course.webp", width: W, height: H, padding: 0, "grid.size": GRID,
    initial: { x: ARRIVE.x, y: ARRIVE.y - 400, scale: 0.8 }, weather: "rain",
    [`flags.${M}.oniFabula.general.spawnPoint`]: { x: ARRIVE.x, y: ARRIVE.y },
    [`flags.${M}.plasmaFieldLayout`]: 2,
  });

  const oldTiles = scene.tiles.filter((t) => ["cradle", "arrival", "leave"].includes(t.getFlag(M, FLAG))).map((t) => t.id);
  if (oldTiles.length) await scene.deleteEmbeddedDocuments("Tile", oldTiles);
  await scene.createEmbeddedDocuments("Tile", [
    { x: ARRIVE.x - 150, y: ARRIVE.y - 150, width: 300, height: 300, alpha: 0, texture: { src: null },
      flags: { [M]: { [FLAG]: "arrival" }, [EV]: eventFlags(arrivalRows(), { startMode: "stepIn" }) } },
    { x: ARRIVE.x - 90, y: ARRIVE.y - 90, width: 180, height: 180, alpha: 0, texture: { src: null },
      flags: { [M]: { [FLAG]: "leave" }, [EV]: eventFlags(backToTrail(), { startMode: "button", proximityPx: 180 }) } },
  ]);

  const ups = [];
  for (const t of scene.tokens) {
    const part = t.getFlag(M, FLAG);
    if (part === "hako-field") ups.push({ _id: t.id, x: HAKO_PERCH.x - GRID / 2, y: HAKO_PERCH.y - GRID / 2, width: 1, height: 1 });
    if (part === "cradle-mark") ups.push({ _id: t.id, x: CRADLE.x - GRID / 2, y: CRADLE.y - GRID / 2 });
  }
  if (ups.length) await scene.updateEmbeddedDocuments("Token", ups);

  const tile = game.scenes.get(WATERFALL_ID)?.tiles.get(STORY_TILE_ID);
  const tp = tile?.getFlag(M, "teleporter");
  if (tp?.destination?.sceneId === scene.id) {
    await tile.update({ [`flags.${M}.teleporter.destination`]: { ...tp.destination, x: ARRIVE.x, y: ARRIVE.y } });
  }
  log?.(`Plasma Field upgraded to layout 2 (course still, ${W}x${H}).`);
  return { applied: true, summary: "Plasma Field: course still, one opening, thank-you beside the cradle." };
}
