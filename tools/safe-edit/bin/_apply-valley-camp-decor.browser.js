// ============================================================================
// Valley camp decor (2026-11-06): writes the approved mockup onto
// "Valley of the Dragon - Camp" (Valley_Map004, zo6ZTpspg2C5GnP4).
// Mockup: https://claude.ai/artifact/VDvxDNgVUzCebcNrqKuDGu
//
// BROWSER script: evaluate in a GM client with the world open (CDP
// Runtime.evaluate with awaitPromise, or the test bridge's evalGM). The scene
// does not need to be viewed. The expression's value is a Promise of a summary.
//
// Idempotent. Everything it creates carries the TAG below and is replaced on a
// re-run; the one untagged wall it removes is matched by its exact coordinates
// (and reported, so it can be put back). Scene flags are SET outright, never
// deep-merged. Map px = canvas px (scene padding 0).
//
//   surfaceFx  water mode: pond ripple, firelight pools + darkness, haze
//              thinning inside the light (wispOutsideLight)
//   ambience   ember sparks off the campfire
//   regions    Pond Shallows (knee 0.25) + Pond (chest 0.5, bathable)
//   walls      shore wall (640,580)-(760,600) out; boulder edge + pond rim in
//   tiles      3 sit spots on crates (invisible pose-spot tiles)
// ============================================================================
(async () => {
  const SCENE_ID = "zo6ZTpspg2C5GnP4";
  const TAG = "claude-2026-11-06-valley-camp";
  const MOD = "fabula-ultima-companion";
  const scene = game.scenes.get(SCENE_ID);
  if (!scene) throw new Error("Valley camp scene not found");
  if (!game.user.isGM) throw new Error("run as GM");

  const DEEP = [[890,575],[930,552],[990,545],[1060,550],[1130,552],[1150,580],[1150,605],[1195,615],[1245,608],[1295,622],[1322,660],[1318,715],[1290,752],[1240,778],[1180,800],[1120,802],[1060,792],[1000,798],[940,795],[895,775],[885,700],[895,620]];
  const SHALLOW = [[705,640],[745,616],[805,612],[852,596],[890,575],[895,620],[885,700],[895,775],[860,752],[800,740],[745,730],[712,700]];
  const CUT_WALL = [760, 600, 640, 580];
  const RIM = [[640,580],[695,600],[700,690],[745,742],[870,772],[1000,808],[1130,810],[1250,784],[1325,722],[1338,640],[1300,500]];
  const SEATS = [
    // place = token centre; the sit art's hips land ~25 px below it (measured in game 11-06)
    { name: "sit-A tent crates",  tile: [430, 345, 60, 45], place: [460, 334], exit: [470, 440], mirror: true },
    { name: "sit-B pole crate",   tile: [503, 340, 47, 40], place: [526, 327], exit: [535, 430], mirror: true },
    { name: "sit-C supply crate", tile: [268, 398, 70, 50], place: [300, 390], exit: [370, 465], mirror: true },
  ];

  const surfaceFx = {
    mode: "water",
    layers: { water: true, light: true, crystal: false, wisp: true },
    crystals: [],
    wisp: 0.16,
    wispOutsideLight: true,
    darkness: 0.38,
    lights: [
      [603, 472, 340, 1.0, 0.66, 0.36, 1.0],   // campfire
      [474, 325, 110, 1.0, 0.78, 0.45, 0.7],   // tent lantern
      [1030, 680, 480, 0.70, 0.75, 1.0, 1.5],  // cool pool over the pond (user, 11-06: brighter round the pond, three times)
    ],
    lightCap: 1.8,   // lets the pond light brighten past the painting (default 1.25)
    draft: TAG,
  };
  const ambience = { spores: { preset: "ember", points: [[603, 466]] }, draft: TAG };

  const out = { removedWall: null, deleted: {}, created: {} };

  // ---- scene flags (unset then set: no deep merge with an older version)
  await scene.update({ [`flags.${MOD}.-=surfaceFx`]: null, [`flags.${MOD}.-=ambience`]: null });
  await scene.update({
    [`flags.${MOD}.surfaceFx`]: surfaceFx,
    [`flags.${MOD}.ambience`]: ambience,
    [`flags.${MOD}.oniFabula.general.surfaceFxEnabled`]: true,
  });

  // ---- remove our earlier drafts
  const ours = (d, key) => d.flags?.[MOD]?.[key] === TAG;
  const delIds = async (coll, ids) => { if (ids.length) await scene.deleteEmbeddedDocuments(coll, ids); out.deleted[coll] = ids.length; };
  await delIds("Region", scene.regions.filter((r) => ours(r, "draftRegions")).map((r) => r.id));
  await delIds("Wall", scene.walls.filter((w) => ours(w, "draftWalls")).map((w) => w.id));
  await delIds("Tile", scene.tiles.filter((t) => ours(t, "draftTiles")).map((t) => t.id));

  // ---- the one shore wall that closes the beach (untagged, matched exactly)
  const same = (c) => c.length === 4 && ((c[0] === CUT_WALL[0] && c[1] === CUT_WALL[1] && c[2] === CUT_WALL[2] && c[3] === CUT_WALL[3])
    || (c[0] === CUT_WALL[2] && c[1] === CUT_WALL[3] && c[2] === CUT_WALL[0] && c[3] === CUT_WALL[1]));
  const cut = scene.walls.find((w) => same(w.c));
  if (cut) { out.removedWall = cut.toObject(); await scene.deleteEmbeddedDocuments("Wall", [cut.id]); }

  // ---- regions (same shape as the Underground Camp pond)
  const flat = (pts) => pts.flat();
  const region = (name, pts, water) => ({
    name, color: "#28c1cc", visibility: 0, locked: false,
    shapes: [{ type: "polygon", points: flat(pts), hole: false }],
    elevation: { bottom: null, top: null },
    behaviors: [{ name: "FootstepWater", type: "executeMacro", disabled: true, system: { events: ["tokenPreMove"], uuid: "Macro.kyCFucvT7HsnPQks", everyone: false } }],
    flags: { [MOD]: { footstepSurface: "water", footstepMuted: false, water, draftRegions: TAG } },
  });
  const regs = await scene.createEmbeddedDocuments("Region", [
    region("Pond Shallows", SHALLOW, { depth: 0.25, bathable: false, autoColor: true, color: "#6fb8e8" }),
    region("Pond", DEEP, { depth: 0.5, bathable: true, autoColor: true, color: "#6fb8e8" }),
  ]);
  out.created.Region = regs.map((r) => r.id);

  // ---- walls: movement only, like the rest of this scene
  const wall = (c) => ({ c, move: 20, sight: 0, light: 0, sound: 0, door: 0, dir: 0, flags: { [MOD]: { draftWalls: TAG } } });
  const segs = [];
  for (let i = 0; i < RIM.length - 1; i++) segs.push(wall([...RIM[i], ...RIM[i + 1]]));
  const walls = await scene.createEmbeddedDocuments("Wall", segs);
  out.created.Wall = walls.length;

  // ---- seats: invisible pose-spot tiles (the 10-29 sleep spot convention)
  const tiles = await scene.createEmbeddedDocuments("Tile", SEATS.map((s) => ({
    x: s.tile[0], y: s.tile[1], width: s.tile[2], height: s.tile[3],
    texture: { src: null }, alpha: 0, hidden: false, locked: false, elevation: 0, sort: 0,
    occlusion: { mode: 0, alpha: 0 },
    flags: {
      [MOD]: { draftTiles: TAG, draftName: s.name },
      "oni-event-system": { poseSpot: { enabled: true, pose: "sit", mirror: s.mirror, scale: 1, place: { x: s.place[0], y: s.place[1] }, exit: { x: s.exit[0], y: s.exit[1] } } },
    },
  })));
  out.created.Tile = tiles.map((t) => t.id);
  return out;
})();
