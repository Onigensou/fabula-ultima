/**
 * Migration: 2026-11-17-plasma-field-world  (Multiplayer mode, first minigame)
 * ---------------------------------------------------------------------------
 * Seeds the world side of Plasma Field Dash (the Hako rescue minigame):
 *
 *  1. Scene "Valley_Map028" (navigation name "Plasma Field"), scene mode
 *     Multiplayer: the crystal field's ground art, Hako's root cradle (tile)
 *     with Hako on it (hidden once she has moved to camp), and two event
 *     tiles at the arrival point:
 *       - step-in: the arrival. First time: the party notices Hako, she
 *         calls for help, the minigame opens (full opening, rewards on), then
 *         Hako thanks them and asks to stay somewhere safe (switch
 *         HakoAtValleyCamp ON) and the party goes back to Waterfall Trail.
 *         Replays (switch PlasmaFieldCleared ON): a short pan, the minigame
 *         (no opening, time limit, no rewards), back to Waterfall Trail.
 *       - button: "Leave", a way back if the GM ended an event half-way.
 *  2. Waterfall Trail (Valley_Map007): the blank tile A8FxNTihukxgXCkZ
 *     becomes a Story tile that teleports to the field.
 *  3. Both Valley camps (Valley_Map004 surface, Valley_Map024 underground):
 *     a Hako token, shown only once HakoAtValleyCamp is ON (story gate). Her
 *     actor is a shop, so the Shop button appears beside her; her Talk line
 *     is the user's own: "Don't mind me, I like watching people sleep".
 *
 * The minigame pays its first-clear rewards itself (Start Minigame row,
 * rewards switch PlasmaFieldCleared).
 *
 * SEED-ONLY, ONE-TIME: every part is skipped when it already exists (found by
 * its flag), so a hand-edited scene, tile or token is never overwritten.
 */

export const key = "2026-11-17-plasma-field-world";
export const description =
  "Seed Plasma Field (Valley_Map028, Multiplayer scene), its Waterfall Trail story tile, " +
  "and Hako (Talk + Shop) in both Valley camps.";

const M = "fabula-ultima-companion";
const EV = "oni-event-system";
const FLAG = "plasmaField";                       // flags.<M>.plasmaField = "<part>" marks what this seeded
const WATERFALL_ID = "YR0pYJVokhIgKQj0";          // Valley_Map007 "Waterfall Trail" (dungeon)
const STORY_TILE_ID = "A8FxNTihukxgXCkZ";
const TEMPLATE_SCENE = "Valley_Map016";           // an exploration side scene of the Valley: settings to copy
const CAMP_IDS = { surface: "zo6ZTpspg2C5GnP4", underground: "MlM1tFJD6YIeOh1L" };
const HAKO_ID = "srAH3OHOoK0tvFih";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ART = `modules/${M}/assets/minigame/plasma-field/`;
const STORY_TILE_IMG = FORGE + "Fabula%20Ultima/Dungeon%20Tile/Special%20Tile/Story_Tile.png";
const STARE_SFX = FORGE + "Sound/Stare.ogg";
const HAKO_IMG = FORGE + "Character/Hako/Hako%20Standard.png";   // her prototype token is a wildcard; placed tokens use the standing art

// field layout (scene px): 1024 x 1536, the cradle at the top, the party arrives at the bottom
const W = 1024, H = 1536, GRID = 64;
const ARRIVE = { x: 512, y: 1380 };
const CRADLE = { x: 512 - 86, y: 120, w: 173, h: 341 };
const HAKO_AT = { x: 512 - 32, y: 112 };
const HAKO_LANDS = "590, 1330";
const BACK = { x: 676, y: 728 };                   // the story tile's centre on Waterfall Trail

const rid = () => foundry.utils.randomID(16);
const text = (speaker, t) => ({ type: "showText", speaker, text: t, bubbleMode: "normal", id: rid() });
const fx = (effect, seconds = 0.5, wait = true) => ({ type: "screenEffect", effect, color: "#000000", strength: effect.startsWith("letterbox") ? 0.11 : 0, seconds, wait, id: rid() });
const wait = (seconds) => ({ type: "wait", seconds, id: rid() });
const pan = (o) => ({ type: "cameraPan", dx: 0, dy: 0, name: "", zoom: 0, seconds: 1.6, motion: "smooth", wait: true, id: rid(), ...o });
const backToTrail = () => [fx("fadeOut", 0.6), { type: "changeScene", scene: WATERFALL_ID, arrival: "point", mark: "", x: BACK.x, y: BACK.y, id: rid() }, fx("fadeIn", 0.6)];

function arrivalRows() {
  const firstTime = [
    { type: "setFacing", target: "party", name: "", direction: "up", id: rid() },
    fx("letterboxIn"),
    { type: "playSound", src: STARE_SFX, volume: 0.6, wait: false, id: rid() },
    { type: "showEmote", target: "party", name: "", emote: "Exc", side: "auto", seconds: 1.2, wait: true, id: rid() },
    pan({ mode: "token", name: "Hako", seconds: 2.4 }),
    text("Hako", "Is somebody there?! Over here! Up on the roots!"),
    text("Hako", "These roots grabbed me and won't let go, and every few seconds… BZZT! Ow!"),
    text("Hako", "Whoever reaches me first gets my undying gratitude! And maybe a discount!"),
    pan({ mode: "party", seconds: 1.2 }),
    fx("letterboxOut"),
    { type: "startMinigame", game: "plasma-field", intro: "full", rewardSwitch: "PlasmaFieldCleared", id: rid() },
    // Hako, free at last, hops down beside the party
    fx("letterboxIn"),
    pan({ mode: "token", name: "Hako", seconds: 0.8 }),
    { type: "jumpTo", target: "token", name: "Hako", path: HAKO_LANDS, arcPct: 100, hopMs: 640, pauseMs: 220, face: true, takeoffSrc: "", takeoffVolume: 0.6, landSrc: "", id: rid() },
    pan({ mode: "token", name: "Hako", dy: -40, seconds: 1.2 }),
    text("Hako", "Phew… I'm free! Thank you, thank you, thank you!"),
    text("Hako", "I only came out here looking for rare crystals to sell. The storm found me first."),
    text("Hako", "This valley is far too dangerous for a humble merchant. Could I stay somewhere safe… like your camp?"),
    text("Hako", "I'll keep my shop open for you. Come and find me whenever you rest!"),
    { type: "setSwitch", scope: "story", name: "HakoAtValleyCamp", slot: "A", value: "on", id: rid() },
    fx("letterboxOut"),
    ...backToTrail(),
  ];
  const replay = [
    pan({ mode: "token", name: "Plasma Field Cradle", seconds: 1.4 }),
    wait(0.4),
    pan({ mode: "party", seconds: 0.8 }),
    { type: "startMinigame", game: "plasma-field", intro: "none", rewardSwitch: "PlasmaFieldCleared", id: rid() },
    ...backToTrail(),
  ];
  return [{
    type: "condition", condition: { kind: "switch", name: "PlasmaFieldCleared", want: "on" },
    moreConditions: [], combine: "all", hasElse: true, thenRows: replay, elseRows: firstTime, id: rid(),
  }];
}

function eventFlags(rows, { startMode, onceOnly = false, proximityPx = 0 }) {
  return { isEventTile: true, startMode, onceOnly, lockMovement: true, proximityPx, eventRows: rows, eventRowsJsonPreview: JSON.stringify(rows).slice(0, 2000) };
}

async function seedScene(game, log) {
  const existing = game.scenes.find((s) => s.getFlag(M, FLAG) === "scene");
  if (existing) { log?.(`Plasma Field scene already there (${existing.name}); left as is.`); return existing; }
  const tpl = game.scenes.getName(TEMPLATE_SCENE);
  const base = tpl ? tpl.toObject() : {};
  for (const k of ["_id", "tokens", "tiles", "walls", "lights", "sounds", "notes", "drawings", "regions", "templates", "thumb", "_stats"]) delete base[k];
  const general = { ...(base.flags?.[M]?.oniFabula?.general ?? {}), sceneMode: "minigame", navigationName: "Plasma Field", sceneVisited: false,
    spawnPoint: { x: ARRIVE.x, y: ARRIVE.y }, wellspring_bolt: true, wellspring_air: true };
  const data = foundry.utils.mergeObject(base, {
    name: "Valley_Map028", navName: "Plasma Field", navigation: false, active: false,
    width: W, height: H, padding: 0, initial: { x: ARRIVE.x, y: ARRIVE.y - 300, scale: 1 },
    background: { src: ART + "ground.webp" },
    grid: { ...(base.grid ?? {}), size: GRID },
    flags: { [M]: { [FLAG]: "scene", oniFabula: { ...(base.flags?.[M]?.oniFabula ?? {}), general },
      campSceneUuid: game.scenes.get(WATERFALL_ID)?.getFlag(M, "campSceneUuid") ?? base.flags?.[M]?.campSceneUuid ?? null } },
  }, { inplace: false });
  if (tpl?.folder) data.folder = tpl.folder.id;
  const scene = await Scene.create(data);
  log?.(`Created ${scene.name} (${scene.id}).`);

  await scene.createEmbeddedDocuments("Tile", [
    { x: CRADLE.x, y: CRADLE.y, width: CRADLE.w, height: CRADLE.h, texture: { src: ART + "pedestal.webp" }, sort: 10,
      flags: { [M]: { [FLAG]: "cradle" } } },
    { x: ARRIVE.x - 100, y: ARRIVE.y - 100, width: 200, height: 200, alpha: 0, texture: { src: null }, hidden: false,
      flags: { [M]: { [FLAG]: "arrival" }, [EV]: eventFlags(arrivalRows(), { startMode: "stepIn" }) } },
    { x: ARRIVE.x - 60, y: ARRIVE.y - 60, width: 120, height: 120, alpha: 0, texture: { src: null }, hidden: false,
      flags: { [M]: { [FLAG]: "leave" }, [EV]: eventFlags(backToTrail(), { startMode: "button", proximityPx: 120 }) } },
  ]);

  const hako = game.actors.get(HAKO_ID);
  const tokens = [{ name: "Plasma Field Cradle", x: 512 - GRID / 2, y: 260, hidden: true, width: 1, height: 1, texture: { src: "icons/svg/target.svg" },
    flags: { [M]: { [FLAG]: "cradle-mark" } } }];
  if (hako) {
    const t = (await hako.getTokenDocument({ x: HAKO_AT.x, y: HAKO_AT.y, name: "Hako" })).toObject();
    t.texture = { ...(t.texture ?? {}), src: HAKO_IMG };
    t.flags = foundry.utils.mergeObject(t.flags ?? {}, { [M]: { [FLAG]: "hako-field", storyGate: { hiddenWhen: "HakoAtValleyCamp" } } });
    tokens.push(t);
  }
  await scene.createEmbeddedDocuments("Token", tokens);
  return scene;
}

async function seedStoryTile(game, scene, log) {
  const trail = game.scenes.get(WATERFALL_ID);
  const tile = trail?.tiles.get(STORY_TILE_ID);
  if (!tile) { log?.("Waterfall Trail story tile not found; skipped."); return; }
  if (tile.getFlag(M, FLAG) === "story" || tile.getFlag(M, "teleporter")?.enabled) { log?.("Waterfall Trail tile already set up; left as is."); return; }
  const tp = foundry.utils.mergeObject(tile.getFlag(M, "teleporter") ?? {}, {
    enabled: true, confirmMode: true, twoWay: false, sfxUrl: "",
    destination: { type: "coords", x: ARRIVE.x, y: ARRIVE.y, sceneId: scene.id },
  }, { inplace: false });
  await tile.update({
    "texture.src": STORY_TILE_IMG,
    [`flags.${M}.teleporter`]: tp,
    [`flags.${M}.${FLAG}`]: "story",
    "flags.monks-active-tiles.name": "Story Tile",
  });
  log?.("Waterfall Trail: blank tile is now the Plasma Field story tile.");
}

async function seedCampHako(game, log) {
  const hako = game.actors.get(HAKO_ID);
  if (!hako) { log?.("Hako actor not found; camp tokens skipped."); return; }
  const talk = [text("This", "Don't mind me, I like watching people sleep")];
  // surface: on the rock above the bedrolls; underground: by the tent, looking over the bedrolls
  const spots = { surface: { x: 860, y: 400 }, underground: { x: 370, y: 390 } };
  for (const [where, id] of Object.entries(CAMP_IDS)) {
    const camp = game.scenes.get(id);
    if (!camp) { log?.(`${where} camp not found; skipped.`); continue; }
    if (camp.tokens.some((t) => t.getFlag(M, FLAG) === "hako-camp")) { log?.(`${camp.name}: Hako already there.`); continue; }
    const t = (await hako.getTokenDocument({ x: spots[where].x, y: spots[where].y, name: "Hako", hidden: true })).toObject();
    t.texture = { ...(t.texture ?? {}), src: HAKO_IMG };
    t.flags = foundry.utils.mergeObject(t.flags ?? {}, {
      [M]: { [FLAG]: "hako-camp", storyGate: { shownWhen: "HakoAtValleyCamp" } },
      [EV]: eventFlags(talk, { startMode: "button" }),
    });
    await camp.createEmbeddedDocuments("Token", [t]);
    log?.(`${camp.name}: Hako placed (shown once HakoAtValleyCamp is ON).`);
  }
}

export async function migrate(game, log = console.log) {
  if (!game.scenes.get(WATERFALL_ID)) return { applied: true, summary: "No Waterfall Trail in this world; nothing to seed." };
  const scene = await seedScene(game, log);
  await seedStoryTile(game, scene, log);
  await seedCampHako(game, log);
  return { applied: true, summary: `Plasma Field seeded (${scene.name}).` };
}
