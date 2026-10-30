/**
 * sprite-facing-runtime.js
 * Fabula Ultima Companion - Sprite facing and walk sprites (walk maps)
 * Foundry VTT v12
 *
 * Purpose:
 * - The party token faces the way it walks
 * - On an examine point it turns to the object; on a talk, the party token
 *   and the NPC turn to each other, and the NPC turns back afterwards
 * - While the party token walks, its sprite is swapped for the controlling
 *   character's walk art, when that character has any
 *
 * How it works:
 * - Sprites are side-view and drawn facing LEFT (the same convention the
 *   battle setup uses), so facing is left or right: a mirror of the sprite.
 *   A token or prototype token can be marked as drawn facing right, or as
 *   never turning (a portrait, or art with writing on it).
 * - Everything is drawn locally on each client from what that client sees,
 *   like the footsteps. A turn is not written to the token: Foundry tweens a
 *   texture change over the whole walk, which reads as a slow squash. The
 *   facing a walk ends on is saved once, at rest, so a reload shows it.
 * - A character with no walk art sways gently from side to side as it
 *   walks. With walk art, that plays instead.
 * - Walk art is read from the character sheet: system.props.sprite_walk.
 *   A .webm / .mp4 loops while walking. Anything else is a horizontal strip
 *   of frames, each the shape of the standing sprite, stepped by distance.
 * - Eight directions. Five are drawn (down, down-left, left, up-left, up), all
 *   facing left; the right-hand three are mirrors. Each has a walk field and a
 *   standing field on the sheet; down-left is the original pair (sprite_walk,
 *   sprite_standard). A direction with no art borrows the nearest one that
 *   exists: front views when moving down, back views when moving up, then the
 *   side view, then the other half. So a character with only sprite_walk
 *   behaves exactly as before. Straight down and up art is never mirrored.
 *
 * Camp scenes: every party member walks at once (each player walks their
 * own, movementControl-cameraRuntime.js), so each member token is a walker
 * with its own walk, walk art and standing art, exactly as the party token
 * is on a walk map.
 *
 * Runs on walk maps, camps and dungeon maps. On a dungeon map the party token steps
 * from tile to tile: dp-movement.js slides a copy of the sprite and asks here
 * for the step's walk art. Only the copy walks; the token itself never turns
 * there and always stands in its own idle art, facing the camera. Battle
 * scenes keep their own facing rules.
 *
 * Globals:
 *   globalThis.__ONI_SPRITE_FACING_RUNTIME__
 *
 * API:
 *   FUCompanion.api.spriteFacing
 */

(() => {
  const GLOBAL_KEY = "__ONI_SPRITE_FACING_RUNTIME__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const FABULA_ROOT_KEY = "oniFabula";

  const FACING_FLAG = "facing";               // token: "left" | "right", saved at rest
  const DRAWN_RIGHT_FLAG = "spriteFacesRight"; // token / prototype token: art is drawn facing right
  const LOCKED_FLAG = "facingLocked";          // token / prototype token: never mirrored at all

  const ENABLED = true;

  // How long a turn takes. 0 is an instant snap, which is what this game
  // uses. Above 0 the sprite narrows to nothing and opens mirrored.
  const TURN_MS = 0;

  // An object closer than this, sideways, is not worth turning for.
  const LOOK_DEADZONE_PX = 6;

  // Standing still this long ends the walk: walk art off, facing saved.
  const WALK_END_MS = 140;
  const SAVE_FACING_AFTER_MS = 600;

  // One pass through a strip of walk frames covers this many grid squares:
  // two footsteps' worth.
  const WALK_CYCLE_GRIDS = 1.8;

  // A character with no walk art sways as it walks: a lean from side to side
  // about the feet and a small hop, once each per footstep.
  const SWAY_LEAN_RADIANS = 0.05;
  const SWAY_HOP_SHARE = 0.035; // of the sprite's height on the map

  // Dungeon maps: at rest the party token walks in place, like the units of a
  // tactics game, in its down-left walk art (sprite_walk, the same pose as its
  // standing art), slower than a real walk. A character with no sprite_walk
  // just stands. The rate is a share of the clip's own speed: the
  // placeholders walk at 150 ms a frame, so 0.5 is 300 ms a frame in place.
  const DUNGEON_IDLE_WALK_RATE = 0.5;
  // The same pace for walk art made as a strip of frames.
  const DUNGEON_IDLE_STRIP_FRAME_MS = 300;

  // A talking NPC turns back when the talk ends, when the party walks this many
  // grid squares away, or after this long, whichever comes first.
  const TALK_LEAVE_GRIDS = 3;
  const TALK_MAX_MS = 180000;

  const VIDEO_EXTENSIONS = ["webm", "mp4", "m4v", "ogv"];

  // ------------------------------------------------------------
  // Directions
  // ------------------------------------------------------------
  // The five drawn directions and the sheet fields that hold their art.
  const DIR_FIELDS = {
    down:     { walk: "sprite_walk_down",    stand: "sprite_stand_down" },
    downLeft: { walk: "sprite_walk",         stand: "sprite_standard" },
    left:     { walk: "sprite_walk_left",    stand: "sprite_stand_left" },
    upLeft:   { walk: "sprite_walk_up_left", stand: "sprite_stand_up_left" },
    up:       { walk: "sprite_walk_up",      stand: "sprite_stand_up" }
  };

  // Where a direction with no art looks next: the same half first (front
  // views when moving down, back views when moving up), then the side view,
  // then the other half.
  const DIR_FALLBACK = {
    down:     ["down", "downLeft", "left", "upLeft", "up"],
    downLeft: ["downLeft", "down", "left", "upLeft", "up"],
    left:     ["left", "downLeft", "upLeft", "down", "up"],
    upLeft:   ["upLeft", "up", "left", "downLeft", "down"],
    up:       ["up", "upLeft", "left", "downLeft", "down"]
  };

  // Straight-on art faces the camera or away from it, so it is never mirrored.
  const NEVER_MIRRORED = new Set(["down", "up"]);

  // Movement split into eight 45-degree slices, counting clockwise from
  // "right" on screen: the drawn direction to show, and which side it faces
  // (null = keep the side it had).
  const SECTORS = [
    { dir: "left",     side: "right" },
    { dir: "downLeft", side: "right" },
    { dir: "down",     side: null },
    { dir: "downLeft", side: "left" },
    { dir: "left",     side: "left" },
    { dir: "upLeft",   side: "left" },
    { dir: "up",       side: null },
    { dir: "upLeft",   side: "right" }
  ];

  // A direction by name (Event System's Set Facing): the drawn one, and its side.
  const NAMED_DIRECTIONS = {
    up:        { dir: "up",       side: null },
    down:      { dir: "down",     side: null },
    left:      { dir: "left",     side: "left" },
    right:     { dir: "left",     side: "right" },
    upLeft:    { dir: "upLeft",   side: "left" },
    upRight:   { dir: "upLeft",   side: "right" },
    downLeft:  { dir: "downLeft", side: "left" },
    downRight: { dir: "downLeft", side: "right" }
  };

  // Where an event's tile keeps its settings (event-constants.js).
  const EVENT_FLAG_SCOPE = "oni-event-system";

  // A new slice must be entered this far (about 8 degrees) before the
  // direction changes, so a winding path does not flicker between two.
  const SECTOR_STICKY_RADIANS = 0.14;

  const DIR_FLAG = "facingDir"; // token: the drawn direction a walk ended on, saved at rest

  // Pose spots (event-system/pose-spots): a token resting on a seat or a
  // bedroll carries flags.<module>.pose = { spotId, pose, mirror, scale }, and
  // wears its character's pose art instead of walking or standing art.
  const POSE_FLAG = "pose";
  const POSE_FIELDS = { sit: "sprite_sit", sleep: "sprite_sleep", bath: "sprite_onsen" };

  // Bathing: the character stands in the water up to `depth` (share of the art's
  // height hidden, from the bottom), wearing onsen art or, with none, their own
  // standing art. The cut edge sits where their feet were, so they sink into
  // the water; they bob gently and face the way they wade.
  const BATH_DEPTH_DEFAULT = 0.5;
  const BATH_BOB_PX = 1.5;
  const BATH_BOB_MS = 2200;
  // The part under the water stays visible, faint and tinted the water's
  // colour (pose-bath-fx.js samples it), as a body seen through water. It
  // fades out going down, gone before the feet: bathers have no walk
  // animation, and feet gliding over the floor read as sliding.
  const BATH_UNDER_ALPHA = 0.35;
  const BATH_UNDER_BANDS = 8;          // fade steps (PS1-style banding)
  const BATH_UNDER_FADE_SHARE = 0.65;  // share of the submerged height the fade takes; below it, nothing

  const state = {
    installed: true,
    directedIds: new Set(),
    enabled: ENABLED,
    active: false,
    dungeon: false, // a dungeon map: steps come from dp-movement.js, not from watching the token
    camp: false,    // a camp: every party member is a walker

    partyActorId: null,
    partyTokenId: null,
    campWalkerIds: null, // camp member token ids, worked out again when tokens come or go

    // tokenId -> the walk of one walking token (see newWalker)
    walkers: new Map(),

    // tokenId -> { src, art, applied } for a token holding a pose
    poses: new Map(),

    // tokenId -> { facing, turnFrom, turnStart, baseAbs, lastApplied }
    tokens: new Map(),
    // tokenId (NPC) -> { facingBefore, startedAt }
    talks: new Map(),

    // walk art: src -> { kind, texture, frames, video, failed }
    walkArt: new Map(),
    walkOverrideSrc: null,
    sourceBySrc: new Map(), // texture src -> actor id

    tickerFn: null
  };

  // The walk of one walking token: the party token on a walk map, each
  // party member in a camp.
  function newWalker(tokenId) {
    return {
      tokenId,
      lastX: null,
      lastY: null,
      lastMoveAt: 0,
      walking: false,
      walkDistance: 0,
      lastMoverIsMe: false,
      saveTimer: null,
      sway: null,       // { tokenId, dx, dy, lastX, lastY }
      walkShown: null,  // { tokenId, src, slot, art, idleTexture }
      standShown: null, // { tokenId, src, slot, art, idleTexture }
      standDirty: true, // its standing art needs choosing (again); a new walker stands the way its last walk ended
      walkIntent: null, // the keyboard direction of the last move, { x, y }, or null
      walkRate: 1,      // walk-art playback speed for the last move (a run plays faster)
      dirSector: null   // the movement slice the current walk is in
    };
  }

  function walkerFor(token) {
    let w = state.walkers.get(token.id);
    if (!w) {
      w = newWalker(token.id);
      state.walkers.set(token.id, w);
    }
    return w;
  }

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function sceneIsWalkMap(scene) {
    const general = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY]?.general;
    const mode = general?.sceneMode ?? null;
    if (mode === "exploration") return true;
    if (mode) return false;

    // Older walk maps carry only the camera-follow switch.
    const legacy = general?.cameraFollowToken;
    return legacy === true || legacy === "true" || legacy === 1 || legacy === "1";
  }

  function sceneIsDungeon(scene) {
    return scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY]?.general?.sceneMode === "dungeon";
  }

  function sceneIsCamp(scene) {
    return scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY]?.general?.sceneMode === "camp";
  }

  // A party member standing in a camp (the same rule the walk uses).
  function isCampMember(token) {
    const rt = globalThis.FUCompanion?.api?.MovementControlCameraRuntime;
    if (rt?.isCampMemberToken) return rt.isCampMemberToken(token);
    const doc = token?.document;
    return !!doc?.getFlag?.(MODULE_ID, "campMember")
      || (!!doc?.actorId && !!game.users?.some(u => !u.isGM && u.character?.id === doc.actorId));
  }

  // ------------------------------------------------------------
  // Whose art is this token wearing
  // ------------------------------------------------------------
  // The party token shows the controlling player's character, so the walk art
  // and the "drawn facing right" mark belong to that character, found by the
  // image the token is showing.
  function sourceActorFor(token) {
    // A camp member is its own character (a linked token), not a stand-in.
    if (state.camp && token?.actor && isCampMember(token)) return token.actor;

    const src = cleanString(token?.document?.texture?.src);
    if (!src) return token?.actor ?? null;

    const wears = (actor) =>
      !!actor && (
        cleanString(actor.prototypeToken?.texture?.src) === src
        || cleanString(actor.system?.props?.sprite_standard) === src
      );

    // The movement system puts the controller's character art on the party
    // token, so its list of controllers is the first place to look.
    const rows = globalThis.FUCompanion?.api?.MovementControl?.getLastSnapshot?.()?.eligibleControllers ?? [];
    for (const row of rows) {
      const actor = row?.linkedActor ?? row?.user?.character ?? null;
      if (wears(actor)) return actor;
    }

    for (const user of game.users ?? []) {
      if (wears(user.character)) return user.character;
    }

    // A controller who is offline, or art set by hand: any actor that owns it.
    if (!state.sourceBySrc.has(src)) {
      state.sourceBySrc.set(src, game.actors?.find(a => wears(a))?.id ?? null);
    }
    const cachedId = state.sourceBySrc.get(src);
    return (cachedId ? game.actors?.get(cachedId) : null) ?? token?.actor ?? null;
  }

  function isDrawnFacingRight(token) {
    const own = token?.document?.getFlag?.(MODULE_ID, DRAWN_RIGHT_FLAG);
    if (own === true || own === false) return own;
    return !!sourceActorFor(token)?.prototypeToken?.flags?.[MODULE_ID]?.[DRAWN_RIGHT_FLAG];
  }

  function isFacingLocked(token) {
    const own = token?.document?.getFlag?.(MODULE_ID, LOCKED_FLAG);
    if (own === true || own === false) return own;
    return !!sourceActorFor(token)?.prototypeToken?.flags?.[MODULE_ID]?.[LOCKED_FLAG];
  }

  function drawnFacing(token) {
    return isDrawnFacingRight(token) ? "right" : "left";
  }

  // A token flipped on the map (a negative texture.scaleX: Foundry's mirror,
  // or a module's flip hotkey) is set to look the other way. Facing here is
  // absolute, left is left on screen, so a flipped token simply starts out
  // facing the other way; it does not turn every facing round.
  function isDocFlipped(token) {
    return (Number(token?.document?.texture?.scaleX) || 1) < 0;
  }

  function restFacing(token) {
    const drawn = drawnFacing(token);
    if (!isDocFlipped(token)) return drawn;
    return drawn === "left" ? "right" : "left";
  }

  // ------------------------------------------------------------
  // Facing
  // ------------------------------------------------------------
  function entryFor(token) {
    let entry = state.tokens.get(token.id);
    if (!entry) {
      // A dungeon token always stands facing the camera, whatever was saved.
      const saved = state.dungeon ? null : token.document?.getFlag?.(MODULE_ID, FACING_FLAG);
      const savedDir = state.dungeon ? null : token.document?.getFlag?.(MODULE_ID, DIR_FLAG);
      entry = {
        facing: (saved === "left" || saved === "right") ? saved : restFacing(token),
        dir: DIR_FIELDS[savedDir] ? savedDir : "downLeft",
        shownSlot: null, // the drawn direction whose art is on the mesh (null = the token's own art)
        turnFrom: null,
        turnStart: 0,
        baseAbs: null,
        lastApplied: null
      };
      state.tokens.set(token.id, entry);
    }
    return entry;
  }

  function getFacing(token) {
    return entryFor(token).facing;
  }

  function setFacing(token, facing, { instant = false } = {}) {
    if (facing !== "left" && facing !== "right") return;
    if (isFacingLocked(token)) return;

    const entry = entryFor(token);
    if (entry.facing === facing) return;

    entry.turnFrom = instant ? null : entry.facing;
    entry.turnStart = performance.now();
    entry.facing = facing;
    applyFacing(token);
  }

  // Which of the eight slices a direction falls in (0 = right, clockwise).
  function sectorOf(dx, dy) {
    return ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  }

  // The way a token faces, as a unit vector (the art is drawn facing left;
  // "right" mirrors it), or null when it has no direction yet.
  const DIRECTION_VECTORS = {
    left: [1, 0], downLeft: [Math.SQRT1_2, Math.SQRT1_2], down: [0, 1],
    up: [0, -1], upLeft: [Math.SQRT1_2, -Math.SQRT1_2]
  };

  function facingVector(token) {
    const entry = entryFor(token);
    const v = DIRECTION_VECTORS[entry.dir];
    if (!v) return null;
    const side = entry.facing === "right" ? 1 : -1;
    return { x: v[0] === 0 ? 0 : v[0] * side, y: v[1] };
  }

  /**
   * Turn the party to face a way without moving: a tap of an arrow, or
   * walking into a wall, as in a JRPG. Shown here at once; the other clients
   * see it through the saved facing, the same way a walk's end is shared.
   */
  function turnTo(token, dx, dy) {
    if (!token || isFacingLocked(token) || Math.hypot(dx, dy) < 1e-6) return;

    const sector = sectorOf(dx, dy);
    const { dir, side } = SECTORS[sector];
    const entry = entryFor(token);

    const w = walkerFor(token);
    if (side) setFacing(token, side, { instant: true });
    if (entry.dir !== dir) {
      entry.dir = dir;
      if (!w.walking) w.standDirty = true;
    }

    w.lastMoverIsMe = true;
    scheduleSaveFacing(token);
  }

  /**
   * Face a named direction (Event System's Set Facing). Works on any token: one
   * that isn't a walker yet starts wearing standing art like one. Art comes from
   * pickSlot, so a direction the character has no art for shows the nearest one
   * that exists, and a character with no direction art at all keeps its own image
   * and only mirrors. Shown here; the event writes it to the token for reloads.
   */
  function setDirection(token, name) {
    const named = NAMED_DIRECTIONS[name];
    if (!state.active || state.dungeon || !token || !named || isFacingLocked(token)) return false;

    state.directedIds.add(token.id);
    const w = walkerFor(token);
    if (w.walking) {
      // Mid-step: the walk would overwrite it. Applied when the walk ends.
      w.forcedDirection = named;
      return true;
    }
    applyNamedDirection(token, named);
    return true;
  }

  function applyNamedDirection(token, named) {
    if (named.side) setFacing(token, named.side, { instant: true });
    entryFor(token).dir = named.dir;
    walkerFor(token).standDirty = true;
  }

  function faceToward(token, point) {
    const dx = point.x - (token.x + (token.w / 2));
    if (Math.abs(dx) < LOOK_DEADZONE_PX) return;

    // Turning to talk or examine: a party token that stood with its back to
    // the camera turns round to its usual front view first.
    const w = state.walkers.get(token.id);
    if (w) {
      entryFor(token).dir = "downLeft";
      clearStandArt(w);
    }
    setFacing(token, dx > 0 ? "right" : "left");
  }

  // Hold the mesh on the token's facing. Foundry sets the mesh width, and its
  // sign from the token's own texture.scaleX, every time it refreshes the
  // token; a facing other than the drawn one flips that sign.
  function applyFacing(token) {
    // A pose sets its own mirror (holdPose).
    if (state.poses.has(token?.id)) return;
    const mesh = token?.mesh;
    const entry = state.tokens.get(token?.id);
    if (!mesh || mesh.destroyed || !entry) return;

    // A width that is not the one written here last came from Foundry, so it
    // is the true width. (Mid-turn the mesh holds a narrowed one of ours.)
    const current = Math.abs(mesh.scale.x);
    const ours = entry.lastApplied === null ? null : Math.abs(entry.lastApplied);
    if ((ours === null || Math.abs(current - ours) > 1e-6) && current > 0.0001) {
      entry.baseAbs = current;
    }
    if (entry.baseAbs === null) return;

    const now = performance.now();
    const turning = entry.turnFrom !== null && (now - entry.turnStart) < TURN_MS;
    if (!turning) entry.turnFrom = null;

    // Absolute: the sign that shows this facing on screen, whatever the
    // token's own flip (see restFacing).
    const drawn = drawnFacing(token);
    const signFor = (facing) => (facing === drawn ? 1 : -1);

    let width = entry.baseAbs;
    let sign = signFor(entry.facing);

    // Straight down or up art is shown as drawn, whichever side the token faces.
    if (entry.shownSlot && NEVER_MIRRORED.has(entry.shownSlot)) sign = 1;

    if (turning) {
      const t = (now - entry.turnStart) / TURN_MS;
      // First half closes on the old side, second half opens on the new one.
      if (t < 0.5) {
        sign = signFor(entry.turnFrom);
        width *= 1 - (t * 2);
      } else {
        width *= (t - 0.5) * 2;
      }
    }

    entry.lastApplied = sign * Math.max(width, 0.0001);
    mesh.scale.x = entry.lastApplied;
  }

  // ------------------------------------------------------------
  // Walk art
  // ------------------------------------------------------------
  // The art for a direction: its own field, or the nearest direction that has
  // art. kind is "walk" or "stand". Art that failed to load counts as missing.
  function pickSlot(token, kind, dir) {
    if (kind === "walk" && state.walkOverrideSrc) return { slot: "downLeft", src: state.walkOverrideSrc };

    const props = sourceActorFor(token)?.system?.props ?? {};
    for (const slot of DIR_FALLBACK[dir] ?? DIR_FALLBACK.downLeft) {
      const src = cleanString(props[DIR_FIELDS[slot][kind]]);
      if (src && !state.walkArt.get(src)?.failed) return { slot, src };
    }
    return null;
  }

  function walkSrcFor(token) {
    return pickSlot(token, "walk", entryFor(token).dir)?.src ?? "";
  }

  function isVideoSrc(src) {
    const path = src.split("?")[0].split("#")[0].toLowerCase();
    return VIDEO_EXTENSIONS.some(ext => path.endsWith("." + ext));
  }

  // Foundry's texture cache destroys images it has not drawn for a while; the
  // GM, who loads far more of them, loses them first. The Texture object kept
  // here outlives its base (`valid` still reads true) but draws nothing, so a
  // walk in that direction made the token vanish on the GM's screen (seen
  // live: 6 of 9 images gone on the GM, all 9 fine on the player).
  function isArtDead(art) {
    if (!art?.ready) return false;
    const base = art.kind === "strip" ? art.frames?.[0]?.baseTexture : art.texture?.baseTexture;
    return !base || base.destroyed;
  }

  // Forget art whose image was destroyed, so the next use loads it again.
  function dropIfDead(key) {
    const art = state.walkArt.get(key);
    if (!art || !isArtDead(art)) return;
    try { art.video?.pause(); } catch (_) {}
    state.walkArt.delete(key);
  }

  function loadWalkArt(src, idleTexture) {
    dropIfDead(src);
    let art = state.walkArt.get(src);
    if (art) return art;

    art = { kind: null, texture: null, frames: null, video: null, failed: false, ready: false };
    state.walkArt.set(src, art);

    Promise.resolve(loadTexture(src)).then((texture) => {
      if (!texture?.valid) throw new Error("texture not valid");

      art.texture = texture;

      if (isVideoSrc(src)) {
        art.kind = "video";
        art.video = texture.baseTexture?.resource?.source ?? null;
        if (art.video) {
          art.video.loop = true;
          art.video.muted = true;
          try { art.video.pause(); } catch (_) {}
        }
      } else {
        art.kind = "strip";

        // Each frame has the shape of the standing sprite, so the strip is
        // that many standing sprites wide.
        const idleAspect = (idleTexture?.width && idleTexture?.height)
          ? idleTexture.width / idleTexture.height
          : 1;
        const count = Math.max(1, Math.round(texture.width / (texture.height * idleAspect)));
        const frameWidth = texture.width / count;

        art.frames = [];
        for (let i = 0; i < count; i++) {
          art.frames.push(new PIXI.Texture(
            texture.baseTexture,
            new PIXI.Rectangle(
              texture.frame.x + Math.round(i * frameWidth),
              texture.frame.y,
              Math.floor(frameWidth),
              texture.height
            )
          ));
        }
      }

      art.ready = true;
    }).catch((err) => {
      art.failed = true;
      console.warn("[SpriteFacing] Could not load walk art", src, err);
    });

    return art;
  }

  // Put a texture on the mesh and let Foundry size the mesh to it, the same
  // way it sizes the standing art: fitted to the token's box. Walk art drawn
  // on the same canvas size as the standing sprite therefore shows at the
  // same size on the map.
  function setMeshTexture(token, texture) {
    const mesh = token.mesh;
    if (mesh.texture === texture) return;
    mesh.texture = texture;
    try {
      token._refreshSize();
    } catch (_) {}
    reapplyDepth(token);
    applyFacing(token);
  }

  // _refreshSize() re-fits the mesh from the document, at full size, and no
  // refreshToken follows it, so the depth scale of a walk map
  // (depth-index.js) is lost. Mid-walk the next position frame puts it back;
  // a token that has just stopped has no next frame, and its standing art
  // showed at full size wherever it stood. Put the depth scale back here.
  function reapplyDepth(token) {
    try { globalThis.__ONI_DEPTH_INDEX__?.reapply?.(token); } catch (_) {}
  }

  // The token's own image as it is now. Control can pass to another player
  // mid-walk, so the image taken when a walk began may be the last character's.
  function ownTexture(token, fallback) {
    const own = token?.texture;
    return own?.valid ? own : (fallback?.valid ? fallback : null);
  }

  function showWalkArt(token) {
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;

    const pick = pickSlot(token, "walk", entryFor(token).dir);
    const src = pick?.src;
    if (!src) return;

    const w = walkerFor(token);
    const shown = w.walkShown;
    if (shown && shown.src === src && !isArtDead(shown.art)) {
      advanceWalkArt(token);
      return;
    }
    // A change of direction mid-walk, or the art on show was destroyed: put
    // the standing art back, then take the new (or reloaded) walk.
    if (shown) hideWalkArt(w);

    const idleTexture = mesh.texture;
    const art = loadWalkArt(src, idleTexture);
    if (!art.ready || art.failed) return;

    const frame = art.kind === "strip" ? art.frames[0] : art.texture;
    if (!frame?.valid) return;

    w.walkShown = { tokenId: token.id, src, slot: pick.slot, art, idleTexture };
    entryFor(token).shownSlot = pick.slot;
    setMeshTexture(token, frame);

    if (art.kind === "video" && art.video) {
      try {
        art.video.currentTime = 0;
        const playing = art.video.play();
        if (playing?.catch) playing.catch(() => {});
      } catch (_) {}
    }
  }

  function advanceWalkArt(token) {
    const w = state.walkers.get(token?.id);
    const shown = w?.walkShown;
    const mesh = token?.mesh;
    if (!shown || !mesh || mesh.destroyed) return;

    if (shown.art.kind === "strip") {
      const frames = shown.art.frames;
      const cycle = (canvas.dimensions?.size || 100) * WALK_CYCLE_GRIDS;
      const index = Math.floor(((w.walkDistance % cycle) / cycle) * frames.length) % frames.length;
      setMeshTexture(token, frames[index]);
    } else {
      // If Foundry put the standing art back (a redraw), take the walk art again.
      setMeshTexture(token, shown.art.texture);
      const video = shown.art.video;
      if (video && video.playbackRate !== w.walkRate) video.playbackRate = w.walkRate;
    }
  }

  function hideWalkArt(w) {
    const shown = w?.walkShown;
    if (!shown) return;
    w.walkShown = null;

    if (shown.art.kind === "video" && shown.art.video) {
      try {
        shown.art.video.pause();
        shown.art.video.playbackRate = 1; // the clip is shared (dungeon steps)
      } catch (_) {}
    }

    const entry = state.tokens.get(shown.tokenId);
    if (entry) entry.shownSlot = null;

    const token = canvas?.tokens?.get(shown.tokenId);
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;

    const own = ownTexture(token, shown.idleTexture);
    if (own) setMeshTexture(token, own);
  }

  // The walk-in-place clip of a dungeon map gets a video of its own, so its
  // slower rate does not slow the same clip on a step, and a step ending does
  // not stop it. Strips have no playback of their own and are shared.
  function loadIdleWalk(src, idleTexture) {
    if (!isVideoSrc(src)) return loadWalkArt(src, idleTexture);

    const key = "idle:" + src;
    dropIfDead(key);
    let art = state.walkArt.get(key);
    if (art) return art;

    art = { kind: "video", texture: null, frames: null, video: null, failed: false, ready: false };
    state.walkArt.set(key, art);

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.defaultPlaybackRate = DUNGEON_IDLE_WALK_RATE;
    video.addEventListener("loadeddata", () => {
      try {
        video.playbackRate = DUNGEON_IDLE_WALK_RATE;
        art.texture = PIXI.Texture.from(video, { resourceOptions: { autoPlay: false } });
        art.video = video;
        art.ready = true;
      } catch (err) {
        art.failed = true;
        console.warn("[SpriteFacing] Could not use walk-in-place art", src, err);
      }
    }, { once: true });
    video.addEventListener("error", () => {
      art.failed = true;
      console.warn("[SpriteFacing] Could not load walk-in-place art", src);
    }, { once: true });
    video.src = src;

    return art;
  }

  // ------------------------------------------------------------
  // Standing art for the direction a walk ended on
  // ------------------------------------------------------------
  // Down-left standing art is the token's own image, so nothing is swapped
  // for it. Any other direction is laid on the mesh locally, like walk art.
  function showStandArt(token) {
    if (!token?.mesh || token.mesh.destroyed || isFacingLocked(token)) return;
    const w = walkerFor(token);
    clearStandArt(w);

    const entry = entryFor(token);

    // Dungeon map: walk in place, when the character has the walk art for it.
    const idleSrc = state.dungeon
      ? cleanString(sourceActorFor(token)?.system?.props?.[DIR_FIELDS.downLeft.walk])
      : "";
    const idleArt = idleSrc ? loadIdleWalk(idleSrc, token.mesh.texture) : null;
    if (idleArt && !idleArt.failed) {
      w.standShown = {
        tokenId: token.id, src: idleSrc, slot: "downLeft", art: idleArt, idle: true,
        idleTexture: token.mesh.texture, ownSrc: cleanString(token.document?.texture?.src)
      };
      holdStandArt(token);
      return;
    }

    const pick = pickSlot(token, "stand", entry.dir);
    if (!pick || pick.slot === "downLeft") {
      entry.shownSlot = null;
      const own = ownTexture(token);
      if (own) setMeshTexture(token, own);
      applyFacing(token);
      return;
    }

    const idleTexture = token.mesh.texture;
    const art = loadWalkArt(pick.src, idleTexture);
    const ownSrc = cleanString(token.document?.texture?.src);
    w.standShown = { tokenId: token.id, src: pick.src, slot: pick.slot, art, idleTexture, ownSrc };
    holdStandArt(token);
  }

  // Put the standing art on (again): once it has loaded, and after Foundry
  // redraws the token with its own image.
  function holdStandArt(token) {
    const w = state.walkers.get(token?.id);
    const shown = w?.standShown;
    if (!shown || !token.mesh || token.mesh.destroyed) return;
    // Control passed to another player after this art was chosen (the token's
    // image can change more than once in a hand-over): choose for the new character.
    if (shown.ownSrc !== cleanString(token.document?.texture?.src)) {
      clearStandArt(w);
      w.standDirty = true;
      return;
    }
    if (shown.art.failed) {
      clearStandArt(w);
      w.standDirty = true; // choose again: the next direction on the list
      return;
    }
    if (isArtDead(shown.art)) {
      clearStandArt(w);
      w.standDirty = true; // choose again, which loads the image afresh
      return;
    }
    if (!shown.art.ready) return;

    const frames = shown.art.frames;
    const frame = shown.art.kind !== "strip" ? shown.art.texture
      : shown.idle ? frames[Math.floor(performance.now() / DUNGEON_IDLE_STRIP_FRAME_MS) % frames.length]
      : frames[0];
    if (!frame?.valid) return;

    // Not during a pause: pause-screen.js freezes map videos on purpose.
    if (shown.art.kind === "video" && shown.art.video?.paused && !game.paused) {
      try {
        const playing = shown.art.video.play();
        if (playing?.catch) playing.catch(() => {});
      } catch (_) {}
    }

    entryFor(token).shownSlot = shown.slot;
    if (token.mesh.texture !== frame) setMeshTexture(token, frame);
  }

  function clearStandArt(w) {
    const shown = w?.standShown;
    if (!shown) return;
    w.standShown = null;

    if (shown.art.kind === "video" && shown.art.video) {
      try { shown.art.video.pause(); } catch (_) {}
    }

    const entry = state.tokens.get(shown.tokenId);
    if (entry) entry.shownSlot = null;

    const token = canvas?.tokens?.get(shown.tokenId);
    if (!token?.mesh || token.mesh.destroyed) return;
    const own = ownTexture(token, shown.idleTexture);
    if (own) setMeshTexture(token, own);
  }

  // ------------------------------------------------------------
  // Poses: seated or asleep on a pose spot
  // ------------------------------------------------------------
  function poseOf(token) {
    const p = token?.document?.getFlag?.(MODULE_ID, POSE_FLAG);
    return p && POSE_FIELDS[p.pose] ? p : null;
  }

  function poseSrcFor(token, pose) {
    return cleanString(sourceActorFor(token)?.system?.props?.[POSE_FIELDS[pose]]);
  }

  // Pose art: a still image, or a looping clip (a sleeper breathing) on a
  // <video> of its own, so walk art sharing the file is not stopped by it.
  function loadPoseArt(src) {
    const key = "pose:" + src;
    dropIfDead(key);
    let art = state.walkArt.get(key);
    if (art) return art;

    art = { kind: null, texture: null, frames: null, video: null, failed: false, ready: false };
    state.walkArt.set(key, art);

    if (isVideoSrc(src)) {
      art.kind = "video";
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.addEventListener("loadeddata", () => {
        try {
          art.texture = PIXI.Texture.from(video, { resourceOptions: { autoPlay: false } });
          art.video = video;
          art.ready = true;
        } catch (err) {
          art.failed = true;
          console.warn("[SpriteFacing] Could not use pose art", src, err);
        }
      }, { once: true });
      video.addEventListener("error", () => {
        art.failed = true;
        console.warn("[SpriteFacing] Could not load pose art", src);
      }, { once: true });
      video.src = src;
      return art;
    }

    art.kind = "still";
    Promise.resolve(loadTexture(src)).then((texture) => {
      if (!texture?.valid) throw new Error("texture not valid");
      art.texture = texture;
      art.ready = true;
    }).catch((err) => {
      art.failed = true;
      console.warn("[SpriteFacing] Could not load pose art", src, err);
    });
    return art;
  }

  // How Foundry fits a texture into the token box (Token#_refreshMesh).
  function fitScale(fit, boxW, boxH, w, h) {
    const sx = boxW / w, sy = boxH / h;
    switch (fit) {
      case "fill": return [sx, sy];
      case "cover": { const s = Math.max(sx, sy); return [s, s]; }
      case "width": return [sx, sx];
      case "height": return [sy, sy];
      default: { const s = Math.min(sx, sy); return [s, s]; }   // contain
    }
  }

  /**
   * Lay the token's pose art on its mesh, the way battler-pose.js lays battle
   * poses: at the idle art's pixel size (a wide sleeper is not shrunk into the
   * token box), its bottom-centre where the idle art's is, mirrored when the
   * spot says. Foundry re-fits the mesh on every refresh; a scale that is not
   * the one written here last is Foundry's, and the fix is laid on it again.
   * Returns false when the token has no pose to show (no flag, no art).
   */
  function holdPose(token) {
    const p = poseOf(token);
    const mesh = token?.mesh;
    if (!p || !mesh || mesh.destroyed) return false;
    const bath = p.pose === "bath";
    // A bather with no onsen art bathes in their own standing art.
    const src = poseSrcFor(token, p.pose) || (bath ? cleanString(token.document?.texture?.src) : "");
    if (!src) return false;

    let rec = state.poses.get(token.id);
    if (!rec || rec.src !== src) {
      if (rec) releasePoseArt(rec);
      rec = { src, art: loadPoseArt(src), applied: null, crop: null, faceRight: !!p.mirror, lastX: null };
      state.poses.set(token.id, rec);
      const w = state.walkers.get(token.id);
      if (w) { hideWalk(w); clearStandArt(w); w.walking = false; }
    }

    const art = rec.art;
    if (art.failed) return false;
    if (isArtDead(art)) { state.walkArt.delete("pose:" + src); rec.art = loadPoseArt(src); rec.crop = null; return true; }
    if (!art.ready || !art.texture?.valid) return true;   // loading: keep what is on show

    const tex = bath ? bathTexture(rec, art.texture, p) : art.texture;
    if (mesh.texture !== tex) {
      mesh.texture = tex;
      try { token._refreshSize(); } catch (_) {}
      reapplyDepth(token);   // the size fix below is laid on the depth scale
      rec.applied = null;
      if (art.video?.paused && !game.paused) {
        try { const playing = art.video.play(); if (playing?.catch) playing.catch(() => {}); } catch (_) {}
      }
    }

    const own = token.texture;
    if (!own?.valid) return true;
    if (rec.applied && mesh.scale.x === rec.applied.sx && mesh.scale.y === rec.applied.sy) return true;

    const { width, height } = token.getSize();
    const fit = token.document?.texture?.fit;
    const [ix, iy] = fitScale(fit, width, height, own.width, own.height);
    const [px, py] = fitScale(fit, width, height, tex.width, tex.height);
    const k = Number(p.scale) > 0 ? Number(p.scale) : 1;
    const sx = Math.abs(mesh.scale.x) * (ix / px) * k;
    const sy = Math.abs(mesh.scale.y) * (iy / py) * k;
    // Art faces left; a bather faces the way they last waded.
    const mirror = bath ? rec.faceRight : p.mirror;
    mesh.scale.set(mirror ? -sx : sx, sy);

    const t = token.document?.texture ?? {};
    const base = { x: Number(t.anchorX ?? 0.5), y: Number(t.anchorY ?? 0.5) };
    mesh.anchor.set(
      0.5 - ((0.5 - base.x) * own.width / tex.width),
      1 - ((1 - base.y) * own.height / tex.height)
    );
    rec.applied = { sx: mesh.scale.x, sy: mesh.scale.y };
    return true;
  }

  // The part of the art above the waterline: the same image, its frame cut
  // short from the bottom. Its bottom edge is then laid where the feet were
  // (holdPose's anchor), which sinks the character into the water.
  function bathTexture(rec, full, p) {
    const depth = Number.isFinite(Number(p.depth)) ? Math.min(0.85, Math.max(0.1, Number(p.depth))) : BATH_DEPTH_DEFAULT;
    if (rec.crop && rec.crop.full === full && rec.crop.depth === depth && rec.crop.tex.valid) return rec.crop.tex;
    const f = full.frame;
    const h = Math.max(1, Math.round(f.height * (1 - depth)));
    const tex = new PIXI.Texture(full.baseTexture, new PIXI.Rectangle(f.x, f.y, f.width, h));
    rec.crop = { full, depth, tex };
    rec.applied = null;
    return tex;
  }

  // The submerged part: the rest of the art below the cut, as a child of the
  // mesh (so it follows its size, mirror and bob), hanging from the waterline.
  function holdUnderwater(token, rec, p) {
    const mesh = token.mesh;
    const crop = rec.crop;
    if (!mesh || mesh.destroyed || !crop?.tex?.valid) return;
    const f = crop.full.frame, top = crop.tex.height, below = f.height - top;
    if (below < 1) return;

    // A container of horizontal bands of the art below the cut, each fainter
    // than the one above, down to nothing.
    let s = rec.under;
    if (!s || s.destroyed || s.parent !== mesh || rec.underFor !== crop.tex) {
      dropUnderwater(rec);
      s = new PIXI.Container();
      const fadeH = Math.max(1, Math.round(below * BATH_UNDER_FADE_SHARE));
      const bandH = Math.max(1, Math.ceil(fadeH / BATH_UNDER_BANDS));
      for (let i = 0, y = 0; y < fadeH; i++, y += bandH) {
        const h = Math.min(bandH, fadeH - y);
        const band = new PIXI.Sprite(new PIXI.Texture(crop.full.baseTexture, new PIXI.Rectangle(f.x, f.y + top + y, f.width, h)));
        band.y = y;
        band.alpha = BATH_UNDER_ALPHA * (1 - (i / BATH_UNDER_BANDS));
        s.addChild(band);
      }
      mesh.addChild(s);
      rec.under = s;
      rec.underFor = crop.tex;
      rec.underTint = null;
    }
    s.x = -mesh.anchor.x * crop.tex.width;
    s.y = (1 - mesh.anchor.y) * crop.tex.height;
    const c = window.oni?.PoseBathFx?.colorsFor?.(p.regionId)?.base;
    if (Number.isFinite(c) && rec.underTint !== c) {
      for (const band of s.children) band.tint = c;
      rec.underTint = c;
    }
  }

  function dropUnderwater(rec) {
    const s = rec?.under;
    if (!s) return;
    rec.under = null;
    rec.underFor = null;
    try { s.parent?.removeChild(s); s.destroy({ children: true, texture: false }); } catch (_) {}
  }

  function releasePoseArt(rec) {
    dropUnderwater(rec);
    try { rec?.art?.video?.pause(); } catch (_) {}
  }

  // The pose ended (or its token left): the token's own image, sized and
  // faced by Foundry and applyFacing again, standing the way it was placed.
  function dropPose(tokenId) {
    const rec = state.poses.get(tokenId);
    if (!rec) return;
    state.poses.delete(tokenId);
    releasePoseArt(rec);

    const token = canvas?.tokens?.get(tokenId);
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;
    try { mesh.pivot.set(0, 0); } catch (_) {}   // a bather's bob
    const own = ownTexture(token);
    if (own) mesh.texture = own;
    try { token._refreshSize(); } catch (_) {}
    const t = token.document?.texture ?? {};
    try { mesh.anchor.set(Number(t.anchorX ?? 0.5), Number(t.anchorY ?? 0.5)); } catch (_) {}
    reapplyDepth(token);
    const entry = state.tokens.get(tokenId);
    if (entry) { entry.lastApplied = null; entry.shownSlot = null; }
    applyFacing(token);
    const w = state.walkers.get(tokenId);
    if (w) { w.standDirty = true; w.lastX = null; w.lastY = null; }
  }

  // A bather: faces the way they wade (re-laid on the next hold), and bobs on
  // the mesh pivot, which Foundry never sets.
  function tickBather(token, now) {
    const rec = state.poses.get(token.id);
    const mesh = token.mesh;
    if (!rec || !mesh || mesh.destroyed) return;
    if (rec.lastX !== null) {
      const dx = token.x - rec.lastX;
      if (Math.abs(dx) > 0.5 && (dx > 0) !== rec.faceRight) {
        rec.faceRight = dx > 0;
        // Only the sign turns: the size fix is already on this scale, and
        // laying it again would multiply it.
        if (rec.applied && mesh.scale.x === rec.applied.sx) {
          const sx = Math.abs(mesh.scale.x);
          mesh.scale.x = rec.faceRight ? -sx : sx;
          rec.applied = { sx: mesh.scale.x, sy: mesh.scale.y };
        }
      }
    }
    rec.lastX = token.x;
    const sy = Math.abs(mesh.scale.y) || 1;
    mesh.pivot.y = (Math.sin((now / BATH_BOB_MS) * Math.PI * 2) * BATH_BOB_PX) / sy;
    holdUnderwater(token, rec, poseOf(token));
  }

  // Every frame: hold each pose, drop the ones that ended.
  function tickPoses() {
    const now = performance.now();
    for (const token of canvas.tokens?.placeables ?? []) {
      const p = poseOf(token);
      if (p) {
        if (!holdPose(token) && state.poses.has(token.id)) dropPose(token.id);
        else if (p.pose === "bath") tickBather(token, now);
      } else if (state.poses.has(token.id)) {
        dropPose(token.id);
      }
    }
    for (const id of [...state.poses.keys()]) if (!canvas.tokens?.get(id)) state.poses.delete(id);
  }

  // Which of the eight slices a step falls in, kept on the current one until
  // the movement is clearly inside the next.
  function updateDirection(token, dx, dy) {
    const step = Math.PI / 4;
    const angle = Math.atan2(dy, dx);
    let sector = ((Math.round(angle / step) % 8) + 8) % 8;

    const w = walkerFor(token);
    const current = w.dirSector;
    if (current !== null && current !== sector) {
      const fromCentre = Math.atan2(Math.sin(angle - current * step), Math.cos(angle - current * step));
      if (Math.abs(fromCentre) < (step / 2) + SECTOR_STICKY_RADIANS) sector = current;
    }
    w.dirSector = sector;

    const { dir, side } = SECTORS[sector];
    entryFor(token).dir = dir;
    if (side) setFacing(token, side);
  }

  // ------------------------------------------------------------
  // Sway: the walk of a character with no walk art
  // ------------------------------------------------------------
  // Foundry places the mesh on the token every time the token moves, so the
  // sway is an offset laid over wherever Foundry last put it. A position that
  // is not the one written here last is Foundry's, and the offset starts from it.
  function applySway(token) {
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;

    const w = walkerFor(token);
    let sway = w.sway;
    if (!sway) {
      sway = w.sway = { tokenId: token.id, dx: 0, dy: 0, lastX: null, lastY: null };
    }

    const ours = sway.lastX !== null
      && Math.abs(mesh.position.x - sway.lastX) < 1e-6
      && Math.abs(mesh.position.y - sway.lastY) < 1e-6;
    const baseX = ours ? mesh.position.x - sway.dx : mesh.position.x;
    const baseY = ours ? mesh.position.y - sway.dy : mesh.position.y;

    const cycle = (canvas.dimensions?.size || 100) * WALK_CYCLE_GRIDS;
    const phase = (w.walkDistance / cycle) * Math.PI * 2;
    const height = Math.abs(mesh.height) || token.h;

    const lean = Math.sin(phase) * SWAY_LEAN_RADIANS;
    const hop = Math.abs(Math.sin(phase)) * height * SWAY_HOP_SHARE;

    // The skew turns about the middle of the sprite; shifting the mesh by
    // what the feet would move keeps the feet planted.
    const feet = (1 - (mesh.anchor?.y ?? 0.5)) * height;

    mesh.skew.x = lean;
    sway.dx = -Math.sin(lean) * feet;
    sway.dy = -hop;
    sway.lastX = baseX + sway.dx;
    sway.lastY = baseY + sway.dy;
    mesh.position.set(sway.lastX, sway.lastY);
  }

  function clearSway(w) {
    const sway = w?.sway;
    if (!sway) return;
    w.sway = null;

    const mesh = canvas?.tokens?.get(sway.tokenId)?.mesh;
    if (!mesh || mesh.destroyed) return;

    mesh.skew.x = 0;
    if (sway.lastX !== null
      && Math.abs(mesh.position.x - sway.lastX) < 1e-6
      && Math.abs(mesh.position.y - sway.lastY) < 1e-6) {
      mesh.position.set(sway.lastX - sway.dx, sway.lastY - sway.dy);
    }
  }

  // Walk art when the character has it, otherwise the sway.
  function showWalk(token) {
    if (isFacingLocked(token)) return;

    showWalkArt(token);

    // A character with walk art never sways, not even for the moment the art
    // takes to load; only art that failed to load falls back to the sway.
    const src = walkSrcFor(token);
    const hasArt = !!src && !state.walkArt.get(src)?.failed;
    if (hasArt) clearSway(walkerFor(token));
    else applySway(token);
  }

  function hideWalk(w) {
    hideWalkArt(w);
    clearSway(w);
  }

  // ------------------------------------------------------------
  // Party token: facing from movement, walk art, save at rest
  // ------------------------------------------------------------
  async function refreshPartyActor() {
    try {
      const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
      state.partyActorId = res?.db?.id ?? null;
    } catch {
      state.partyActorId = null;
    }
    state.partyTokenId = null;
  }

  function findPartyToken() {
    if (!canvas?.ready) return null;

    const cached = state.partyTokenId ? canvas.tokens?.get(state.partyTokenId) : null;
    if (cached) return cached;

    const tokens = canvas.tokens?.placeables ?? [];
    const token =
      (state.partyActorId ? tokens.find(t => t.document?.actorId === state.partyActorId) : null)
      ?? tokens.find(t => t.actor?.system?.props?.isParty_boolean === true)
      ?? null;

    state.partyTokenId = token?.id ?? null;
    return token;
  }

  // Every token that walks here: the party token on a walk map, each party
  // member in a camp.
  function walkerTokens() {
    return [...new Set([...movingWalkerTokens(), ...directedTokens()])];
  }

  // Tokens an event has turned to a direction, which wear its standing art.
  function directedTokens() {
    const out = [];
    for (const id of state.directedIds) {
      const token = canvas.tokens?.get(id);
      if (token) out.push(token);
      else state.directedIds.delete(id);
    }
    return out;
  }

  function movingWalkerTokens() {
    if (!state.camp) {
      const party = findPartyToken();
      return party ? [party] : [];
    }
    if (!state.campWalkerIds) {
      state.campWalkerIds = (canvas.tokens?.placeables ?? []).filter(isCampMember).map(t => t.id);
    }
    const out = [];
    for (const id of state.campWalkerIds) {
      const token = canvas.tokens?.get(id);
      if (token) out.push(token);
    }
    return out;
  }

  function isWalkerTokenId(tokenId) {
    if (!tokenId) return false;
    if (state.directedIds.has(tokenId)) return true;
    if (!state.camp) return tokenId === state.partyTokenId;
    return walkerTokens().some(t => t.id === tokenId);
  }

  function scheduleSaveFacing(token) {
    const w = walkerFor(token);
    if (w.saveTimer) clearTimeout(w.saveTimer);
    if (!w.lastMoverIsMe) return;

    const tokenId = token.id;
    w.saveTimer = setTimeout(() => {
      w.saveTimer = null;
      if (w.walking) return;

      const live = canvas?.tokens?.get(tokenId);
      const doc = live?.document;
      if (!doc?.isOwner) return;

      // Only at rest: any update that lands during a walk makes Foundry
      // restart the walk animation with its own timing.
      if (Math.abs(doc.x - doc._source.x) > 0.5 || Math.abs(doc.y - doc._source.y) > 0.5) return;

      const entry = state.tokens.get(tokenId);
      const facing = entry?.facing;
      const dir = entry?.dir;
      if (!facing) return;
      if (doc.getFlag(MODULE_ID, FACING_FLAG) === facing && doc.getFlag(MODULE_ID, DIR_FLAG) === dir) return;

      doc.update({
        [`flags.${MODULE_ID}.${FACING_FLAG}`]: facing,
        [`flags.${MODULE_ID}.${DIR_FLAG}`]: dir
      }).catch(() => {});
    }, SAVE_FACING_AFTER_MS);
  }

  function tickWalker(token, now) {
    const w = walkerFor(token);

    // token.x/y is the drawn position; the document can read the destination
    // for an instant while Foundry prepares a move.
    const x = token.x;
    const y = token.y;

    if (w.lastX === null) {
      w.lastX = x;
      w.lastY = y;
      entryFor(token);
      return;
    }

    const dx = x - w.lastX;
    const dy = y - w.lastY;
    const moved = Math.hypot(dx, dy);
    w.lastX = x;
    w.lastY = y;

    const grid = canvas.dimensions?.size || 100;

    if (moved < 0.01 || moved > (grid * 2)) {
      if (w.walking && (now - w.lastMoveAt) > WALK_END_MS) {
        w.walking = false;
        w.walkDistance = 0;
        w.dirSector = null;
        hideWalk(w);
        if (w.forcedDirection) {
          applyNamedDirection(token, w.forcedDirection);
          w.forcedDirection = null;
        }
        showStandArt(token);
        scheduleSaveFacing(token);
      }
      return;
    }

    w.lastMoveAt = now;
    if (!w.walking) clearStandArt(w); // walk art is laid over the token's own image
    w.walking = true;
    w.walkDistance += moved;

    const intent = w.walkIntent;
    if (intent) updateDirection(token, intent.x, intent.y);
    else updateDirection(token, dx, dy);

    showWalk(token);
  }

  // Forget a walker: its art comes off, its pending save is dropped.
  function dropWalker(tokenId) {
    const w = state.walkers.get(tokenId);
    if (!w) return;
    if (w.saveTimer) clearTimeout(w.saveTimer);
    hideWalk(w);
    clearStandArt(w);
    state.walkers.delete(tokenId);
  }

  // ------------------------------------------------------------
  // Dungeon steps
  // ------------------------------------------------------------
  // On a dungeon map the party token does not walk where this file can see
  // it: dp-movement.js hides it, slides a copy of its sprite to the next tile
  // and then puts the token there in one jump. The copy asks here for the
  // step's walk art. The token itself is left alone: on landing it shows its
  // own idle art again, facing the camera, whichever way it stepped.

  // Load every walk and standing image of the character, so the first step in
  // a new direction is not shown in the standing art while its walk loads.
  function preloadArt(token) {
    const props = sourceActorFor(token)?.system?.props ?? {};
    for (const fields of Object.values(DIR_FIELDS)) {
      for (const field of [fields.walk, fields.stand]) {
        const src = cleanString(props[field]);
        if (src) loadWalkArt(src, token.mesh?.texture);
      }
    }
  }

  // A step is one move on its own, so its direction is the plain slice it
  // falls in (no stickiness). Returns what the sliding copy shows:
  //   art   - the walk art, loaded and ready, or null
  //   sway  - true when the character has no walk art at all
  //   sign  - the sign of the copy's x scale while it shows the walk art
  // or null for a token that never turns (the copy slides as it is).
  // Straight up or down has no side; the copy then faces the drawn way.
  function dungeonStepBegin(token, dx, dy) {
    if (!token?.mesh || isFacingLocked(token) || Math.hypot(dx, dy) < 1) return null;

    const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    const { dir, side } = SECTORS[sector];
    const drawn = drawnFacing(token);
    const facing = side ?? drawn;

    const pick = pickSlot(token, "walk", dir);
    const art = pick ? loadWalkArt(pick.src, token.mesh.texture) : null;

    // Absolute, like applyFacing: a token flipped on the map still steps the
    // way it moves. Straight up or down art is shown as drawn.
    const sign = (pick && NEVER_MIRRORED.has(pick.slot))
      ? 1
      : (facing === drawn ? 1 : -1);

    return {
      art: (art?.ready && !art.failed) ? art : null,
      sway: !art || art.failed,
      sign,
      cycle: (canvas.dimensions?.size || 100) * WALK_CYCLE_GRIDS,
      swayLean: SWAY_LEAN_RADIANS,
      swayHop: SWAY_HOP_SHARE
    };
  }

  // ------------------------------------------------------------
  // Examine and talk
  // ------------------------------------------------------------
  function centerOfSource(source) {
    const doc = source?.document ?? source;
    if (!doc) return null;

    if (doc.documentName === "Token") {
      const token = doc.object;
      if (token) return { x: token.x + (token.w / 2), y: token.y + (token.h / 2) };
      const size = canvas.dimensions?.size || 100;
      return { x: doc.x + ((doc.width * size) / 2), y: doc.y + ((doc.height * size) / 2) };
    }

    return { x: doc.x + ((doc.width ?? 0) / 2), y: doc.y + ((doc.height ?? 0) / 2) };
  }

  function onEventStart({ sceneId, sourceId } = {}) {
    if (!state.active || !canvas?.scene || sceneId !== canvas.scene.id) return;

    const party = findPartyToken();
    if (!party) return;

    const npc = canvas.tokens?.get(sourceId) ?? null;
    const tile = npc ? null : (canvas.scene.tiles?.get(sourceId) ?? null);
    const target = centerOfSource(npc ?? tile);
    if (!target) return;

    // A tile the party walked into isn't something they turned to look at: they
    // keep the direction they were walking. A Set Facing row can turn them.
    if (tile?.flags?.[EVENT_FLAG_SCOPE]?.startMode === "stepIn") return;

    faceToward(party, target);

    if (npc && npc.id !== party.id) {
      if (!state.talks.has(npc.id)) {
        state.talks.set(npc.id, { facingBefore: getFacing(npc), dirBefore: entryFor(npc).dir, startedAt: performance.now() });
      }
      faceToward(npc, { x: party.x + (party.w / 2), y: party.y + (party.h / 2) });
    }
  }

  function endTalk(npcId) {
    const talk = state.talks.get(npcId);
    if (!talk) return;
    state.talks.delete(npcId);

    const npc = canvas?.tokens?.get(npcId);
    if (!npc) return;
    setFacing(npc, talk.facingBefore);
    // Back to the direction an event had set it to, if any.
    if (state.directedIds.has(npcId) && talk.dirBefore) {
      entryFor(npc).dir = talk.dirBefore;
      walkerFor(npc).standDirty = true;
    }
  }

  function onEventDone({ sourceId } = {}) {
    endTalk(sourceId);
  }

  function tickTalks(now) {
    if (!state.talks.size) return;

    const party = findPartyToken();
    const leave = (canvas.dimensions?.size || 100) * TALK_LEAVE_GRIDS;

    for (const [npcId, talk] of state.talks) {
      const npc = canvas.tokens?.get(npcId);
      const gone = !npc || !party
        || Math.hypot(party.x - npc.x, party.y - npc.y) > leave
        || (now - talk.startedAt) > TALK_MAX_MS;
      if (gone) endTalk(npcId);
    }
  }

  // ------------------------------------------------------------
  // Frame loop
  // ------------------------------------------------------------
  function tick() {
    if (!state.enabled || !state.active || !canvas?.ready) return;

    const now = performance.now();
    if (!state.dungeon) tickPoses();
    const walkers = walkerTokens();

    // A walker that left (its token is gone, or no longer the party token).
    if (state.walkers.size > walkers.length) {
      const live = new Set(walkers.map(t => t.id));
      for (const id of [...state.walkers.keys()]) if (!live.has(id)) dropWalker(id);
    }

    for (const token of walkers) {
      // Seated or asleep: the pose is on show, not walking or standing art.
      if (state.poses.has(token.id)) continue;
      // A dungeon step is a jump of the token; reading it as a walk would flash
      // the walk art on the token. The steps come from dp-movement.js instead.
      if (!state.dungeon) tickWalker(token, now);

      // At rest, a walker wears the standing art of its direction.
      const w = walkerFor(token);
      if (w.walking) continue;
      if (w.standDirty) {
        w.standDirty = false;
        if (state.dungeon) preloadArt(token);
        showStandArt(token);
      } else {
        holdStandArt(token);
      }
    }
    tickTalks(now);

    // Hold every tracked sprite on its facing. Foundry rewrites the mesh
    // scale whenever it refreshes a token, which would undo a mirror.
    for (const [tokenId, entry] of state.tokens) {
      const token = canvas.tokens?.get(tokenId);
      if (!token) {
        state.tokens.delete(tokenId);
        continue;
      }
      if (entry.facing !== drawnFacing(token) || isDocFlipped(token) || entry.turnFrom !== null || entry.shownSlot) applyFacing(token);
    }
  }

  function attachTicker() {
    if (state.tickerFn || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    canvas.app.ticker.add(state.tickerFn, undefined, PIXI.UPDATE_PRIORITY.LOW);
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
  }

  function reset() {
    state.directedIds.clear();
    for (const id of [...state.poses.keys()]) dropPose(id);
    for (const id of [...state.walkers.keys()]) dropWalker(id);
    state.tokens.clear();
    state.talks.clear();

    state.partyTokenId = null;
    state.campWalkerIds = null;
  }

  // ------------------------------------------------------------
  // Token config: the two marks an artist or GM may need
  // ------------------------------------------------------------
  function injectTokenConfig(app, html) {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root || root.querySelector(".oni-sprite-facing")) return;

      const doc = app?.token ?? app?.document ?? app?.object;
      const flags = doc?.flags?.[MODULE_ID] ?? {};

      const host =
        root.querySelector('.tab[data-tab="appearance"]')
        ?? root.querySelector("form")
        ?? root;

      const wrap = document.createElement("fieldset");
      wrap.className = "oni-sprite-facing";
      wrap.innerHTML = `
        <legend>Facing (walk and dungeon maps)</legend>
        <div class="form-group">
          <label>Art is drawn facing right</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.${DRAWN_RIGHT_FLAG}" ${flags[DRAWN_RIGHT_FLAG] ? "checked" : ""}>
          </div>
          <p class="hint">Leave off for art drawn facing left, which is the usual way.</p>
        </div>
        <div class="form-group">
          <label>Never turns</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.${LOCKED_FLAG}" ${flags[LOCKED_FLAG] ? "checked" : ""}>
          </div>
          <p class="hint">For art that should not be mirrored: a portrait, a name plate, or anything with writing on it.</p>
        </div>
      `;

      host.appendChild(wrap);
      app.setPosition?.({ height: "auto" });
    } catch (err) {
      console.warn("[SpriteFacing] Failed to add the Facing section to the Token config", err);
    }
  }

  const api = {
    installed: true,
    state,
    FACING_FLAG,
    DRAWN_RIGHT_FLAG,
    LOCKED_FLAG,

    getFacing(token) { return token ? getFacing(token) : null; },
    // The drawn direction a token is on: down, downLeft, left, upLeft or up.
    getDirection(token) { return token ? entryFor(token).dir : null; },
    setFacing(token, facing, options) { if (token) setFacing(token, facing, options); },
    // Event System's Set Facing: up, down, left, right, upLeft, upRight, downLeft, downRight.
    setDirection(token, name) { return setDirection(token, name); },
    NAMED_DIRECTIONS,
    faceToward(token, point) { if (token && point) faceToward(token, point); },

    // Keyboard walking (movementControl-cameraRuntime.js): which way the
    // party faces, and turning it without a step.
    facingVector(token) { return token ? facingVector(token) : null; },
    sectorOf(dx, dy) { return sectorOf(dx, dy); },
    turnTo(token, dx, dy) { if (state.active && !state.dungeon) turnTo(token, dx, dy); },

    // Dungeon steps (dp-movement.js): the walk art for a step of dx, dy.
    dungeonStepBegin(token, dx, dy) { return state.active && state.dungeon ? dungeonStepBegin(token, dx, dy) : null; },

    // Pose spots (event-system/pose-spots): the pose art a token's character
    // has for "sit" or "sleep" ("" when none), and whether a pose is on show.
    poseArtSrc(token, pose) { return token && POSE_FIELDS[pose] ? poseSrcFor(token, pose) : ""; },
    isPosed(token) { return !!poseOf(token); },
    POSE_FLAG,

    // Testing: play this walk art for the party token on this client,
    // whatever the character sheet says. Pass nothing to clear it.
    sourceActorFor(token) { return token ? sourceActorFor(token) : null; },

    setWalkOverride(src) {
      for (const w of state.walkers.values()) hideWalk(w);
      state.walkOverrideSrc = cleanString(src) || null;
    },

    setEnabled(value) {
      state.enabled = !!value;
      if (!state.enabled) reset();
    }
  };

  globalThis[GLOBAL_KEY] = api;

  async function start() {
    reset();
    state.dungeon = sceneIsDungeon(canvas?.scene);
    state.camp = sceneIsCamp(canvas?.scene);
    state.active = state.dungeon || state.camp || sceneIsWalkMap(canvas?.scene);
    if (!state.active) {
      detachTicker();
      return;
    }

    await refreshPartyActor();

    // Tokens whose facing was saved start out on it (not on a dungeon map).
    for (const token of (state.dungeon ? [] : canvas.tokens?.placeables ?? [])) {
      const saved = token.document?.getFlag?.(MODULE_ID, FACING_FLAG);
      if (saved === "left" || saved === "right") {
        entryFor(token);
        applyFacing(token);
      }
      // An event turned this token (Set Facing): back on that direction's art.
      const savedDir = token.document?.getFlag?.(MODULE_ID, DIR_FLAG);
      if (DIR_FIELDS[savedDir] && savedDir !== "downLeft") state.directedIds.add(token.id);
    }

    // Walkers stand the way their last walk ended: a new walker record
    // starts with its standing art to choose (newWalker).

    attachTicker();
  }

  Hooks.on("renderTokenConfig", injectTokenConfig);

  Hooks.on("canvasReady", () => { start(); });

  Hooks.on("canvasTearDown", () => {
    detachTicker();
    reset();
    state.active = false;
  });

  Hooks.on("updateScene", (scene) => {
    if (!canvas?.scene || scene.id !== canvas.scene.id) return;
    const dungeon = sceneIsDungeon(scene);
    const camp = sceneIsCamp(scene);
    const active = dungeon || camp || sceneIsWalkMap(scene);
    if (active !== state.active || dungeon !== state.dungeon || camp !== state.camp) start();
  });

  Hooks.on("createToken", () => {
    state.partyTokenId = null;
    state.campWalkerIds = null;
  });

  Hooks.on("deleteToken", (doc) => {
    state.partyTokenId = null;
    state.campWalkerIds = null;
    state.tokens.delete(doc.id);
    state.talks.delete(doc.id);
    // The token is gone: forget its walk without touching its (destroyed) mesh.
    const rec = state.poses.get(doc.id);
    if (rec) { releasePoseArt(rec); state.poses.delete(doc.id); }
    const w = state.walkers.get(doc.id);
    if (w?.saveTimer) clearTimeout(w.saveTimer);
    state.walkers.delete(doc.id);
  });

  Hooks.on("refreshToken", (token) => {
    if (!state.active) return;
    // A refresh re-fits the mesh; lay the pose back on at once (no frame at the wrong size).
    if (state.poses.has(token.id)) { holdPose(token); return; }
    if (state.tokens.has(token.id)) applyFacing(token);
  });

  Hooks.on("updateToken", (doc, change, options, userId) => {
    if (!state.active || doc.parent?.id !== canvas?.scene?.id) return;

    const walker = isWalkerTokenId(doc.id) && doc.object ? walkerFor(doc.object) : null;

    if (walker && (("x" in change) || ("y" in change))) {
      walker.lastMoverIsMe = userId === game.user?.id;

      // A keyboard walk says which way the key points. Sliding along a wall
      // or stepping round a corner, the party still faces that way, as in a
      // JRPG. It rides on the update, so every client faces the same way.
      const intent = options?.oniWalkFacing;
      walker.walkIntent = (intent && Number.isFinite(intent.x) && Number.isFinite(intent.y))
        ? { x: intent.x, y: intent.y }
        : null;

      // Walk art plays faster on a run and slower on a steep slide.
      const rate = Number(options?.oniWalkRate);
      walker.walkRate = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;

      // Placed, not walked: do not read a facing out of the jump.
      if (options?.animate === false || options?.teleport === true) {
        walker.lastX = null;
        walker.lastY = null;
      }
    }

    // The standing art changed (control passed to another player): the new
    // character's art is chosen again for the same direction.
    if (change?.texture && ("src" in change.texture)) {
      const w = state.walkers.get(doc.id);
      if (w) {
        w.walkShown = null;
        w.standShown = null;
      }
      const entry = state.tokens.get(doc.id);
      if (entry) entry.shownSlot = null;
      if (walker) walker.standDirty = true;
    }

    // Another client saved the facing and direction its walk ended on.
    const saved = change?.flags?.[MODULE_ID]?.[FACING_FLAG];
    const savedDir = change?.flags?.[MODULE_ID]?.[DIR_FLAG];
    if (!state.dungeon && !walker?.walking) {
      const token = doc.object;
      if (token && (saved === "left" || saved === "right")) setFacing(token, saved);
      if (token && DIR_FIELDS[savedDir] && entryFor(token).dir !== savedDir) {
        entryFor(token).dir = savedDir;
        if (walker) walker.standDirty = true;
      }
    }
  });

  Hooks.on("oniEventExecuteStart", onEventStart);
  Hooks.on("oniEventExecuteDone", onEventDone);

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.spriteFacing = api;
    } catch (err) {
      console.warn("[SpriteFacing] Failed to attach API to FUCompanion.api", err);
    }

    if (canvas?.ready) start();
  });
})();
