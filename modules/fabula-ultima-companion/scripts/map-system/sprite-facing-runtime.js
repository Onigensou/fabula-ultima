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
 *
 * Only runs on walk maps. Battle scenes keep their own facing rules.
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

  // Sideways share of a frame's movement needed to turn. Walking almost
  // straight up or down keeps the facing it had.
  const TURN_SIDEWAYS_SHARE = 0.3;

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

  // A talking NPC turns back when the talk ends, when the party walks this many
  // grid squares away, or after this long, whichever comes first.
  const TALK_LEAVE_GRIDS = 3;
  const TALK_MAX_MS = 180000;

  const VIDEO_EXTENSIONS = ["webm", "mp4", "m4v", "ogv"];

  const state = {
    installed: true,
    enabled: ENABLED,
    active: false,

    partyActorId: null,
    partyTokenId: null,

    lastX: null,
    lastY: null,
    lastMoveAt: 0,
    walking: false,
    walkDistance: 0,
    lastMoverIsMe: false,
    saveTimer: null,

    // tokenId -> { facing, turnFrom, turnStart, baseAbs, lastApplied }
    tokens: new Map(),
    // tokenId (NPC) -> { facingBefore, startedAt }
    talks: new Map(),

    // walk art: src -> { kind, texture, frames, video, failed }
    walkArt: new Map(),
    walkOverrideSrc: null,
    sourceBySrc: new Map(), // texture src -> actor id
    sway: null, // { tokenId, dx, dy, lastX, lastY }
    walkShown: null, // { tokenId, src, art, idleTexture }

    tickerFn: null
  };

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

  // ------------------------------------------------------------
  // Whose art is this token wearing
  // ------------------------------------------------------------
  // The party token shows the controlling player's character, so the walk art
  // and the "drawn facing right" mark belong to that character, found by the
  // image the token is showing.
  function sourceActorFor(token) {
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

  // ------------------------------------------------------------
  // Facing
  // ------------------------------------------------------------
  function entryFor(token) {
    let entry = state.tokens.get(token.id);
    if (!entry) {
      const saved = token.document?.getFlag?.(MODULE_ID, FACING_FLAG);
      entry = {
        facing: (saved === "left" || saved === "right") ? saved : drawnFacing(token),
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

  function faceToward(token, point) {
    const dx = point.x - (token.x + (token.w / 2));
    if (Math.abs(dx) < LOOK_DEADZONE_PX) return;
    setFacing(token, dx > 0 ? "right" : "left");
  }

  // Hold the mesh on the token's facing. Foundry sets the mesh width, and its
  // sign from the token's own texture.scaleX, every time it refreshes the
  // token; a facing other than the drawn one flips that sign.
  function applyFacing(token) {
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

    const docSign = (Number(token.document?.texture?.scaleX) || 1) < 0 ? -1 : 1;
    const drawn = drawnFacing(token);
    const signFor = (facing) => docSign * (facing === drawn ? 1 : -1);

    let width = entry.baseAbs;
    let sign = signFor(entry.facing);

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
  function walkSrcFor(token) {
    if (state.walkOverrideSrc) return state.walkOverrideSrc;
    return cleanString(sourceActorFor(token)?.system?.props?.sprite_walk);
  }

  function isVideoSrc(src) {
    const path = src.split("?")[0].split("#")[0].toLowerCase();
    return VIDEO_EXTENSIONS.some(ext => path.endsWith("." + ext));
  }

  function loadWalkArt(src, idleTexture) {
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
    applyFacing(token);
  }

  function showWalkArt(token) {
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;

    const src = walkSrcFor(token);
    if (!src) return;

    const shown = state.walkShown;
    if (shown && shown.tokenId === token.id && shown.src === src) {
      advanceWalkArt(token);
      return;
    }
    if (shown) hideWalkArt();

    const idleTexture = mesh.texture;
    const art = loadWalkArt(src, idleTexture);
    if (!art.ready || art.failed) return;

    const frame = art.kind === "strip" ? art.frames[0] : art.texture;
    if (!frame?.valid) return;

    state.walkShown = { tokenId: token.id, src, art, idleTexture };
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
    const shown = state.walkShown;
    const mesh = token?.mesh;
    if (!shown || !mesh || mesh.destroyed) return;

    if (shown.art.kind === "strip") {
      const frames = shown.art.frames;
      const cycle = (canvas.dimensions?.size || 100) * WALK_CYCLE_GRIDS;
      const index = Math.floor(((state.walkDistance % cycle) / cycle) * frames.length) % frames.length;
      setMeshTexture(token, frames[index]);
    } else {
      // If Foundry put the standing art back (a redraw), take the walk art again.
      setMeshTexture(token, shown.art.texture);
    }
  }

  function hideWalkArt() {
    const shown = state.walkShown;
    if (!shown) return;
    state.walkShown = null;

    if (shown.art.kind === "video" && shown.art.video) {
      try { shown.art.video.pause(); } catch (_) {}
    }

    const token = canvas?.tokens?.get(shown.tokenId);
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;

    if (shown.idleTexture?.valid) setMeshTexture(token, shown.idleTexture);
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

    let sway = state.sway;
    if (!sway || sway.tokenId !== token.id) {
      clearSway();
      sway = state.sway = { tokenId: token.id, dx: 0, dy: 0, lastX: null, lastY: null };
    }

    const ours = sway.lastX !== null
      && Math.abs(mesh.position.x - sway.lastX) < 1e-6
      && Math.abs(mesh.position.y - sway.lastY) < 1e-6;
    const baseX = ours ? mesh.position.x - sway.dx : mesh.position.x;
    const baseY = ours ? mesh.position.y - sway.dy : mesh.position.y;

    const cycle = (canvas.dimensions?.size || 100) * WALK_CYCLE_GRIDS;
    const phase = (state.walkDistance / cycle) * Math.PI * 2;
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

  function clearSway() {
    const sway = state.sway;
    if (!sway) return;
    state.sway = null;

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
    if (hasArt) clearSway();
    else applySway(token);
  }

  function hideWalk() {
    hideWalkArt();
    clearSway();
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

  function scheduleSaveFacing(token) {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    if (!state.lastMoverIsMe) return;

    const tokenId = token.id;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      if (state.walking) return;

      const live = canvas?.tokens?.get(tokenId);
      const doc = live?.document;
      if (!doc?.isOwner) return;

      // Only at rest: any update that lands during a walk makes Foundry
      // restart the walk animation with its own timing.
      if (Math.abs(doc.x - doc._source.x) > 0.5 || Math.abs(doc.y - doc._source.y) > 0.5) return;

      const facing = state.tokens.get(tokenId)?.facing;
      if (!facing || doc.getFlag(MODULE_ID, FACING_FLAG) === facing) return;

      doc.setFlag(MODULE_ID, FACING_FLAG, facing).catch(() => {});
    }, SAVE_FACING_AFTER_MS);
  }

  function tickParty(now) {
    const token = findPartyToken();
    if (!token) {
      state.lastX = null;
      state.lastY = null;
      state.walking = false;
      return;
    }

    // token.x/y is the drawn position; the document can read the destination
    // for an instant while Foundry prepares a move.
    const x = token.x;
    const y = token.y;

    if (state.lastX === null) {
      state.lastX = x;
      state.lastY = y;
      entryFor(token);
      return;
    }

    const dx = x - state.lastX;
    const dy = y - state.lastY;
    const moved = Math.hypot(dx, dy);
    state.lastX = x;
    state.lastY = y;

    const grid = canvas.dimensions?.size || 100;

    if (moved < 0.01 || moved > (grid * 2)) {
      if (state.walking && (now - state.lastMoveAt) > WALK_END_MS) {
        state.walking = false;
        state.walkDistance = 0;
        hideWalk();
        scheduleSaveFacing(token);
      }
      return;
    }

    state.lastMoveAt = now;
    state.walking = true;
    state.walkDistance += moved;

    if (Math.abs(dx) >= (moved * TURN_SIDEWAYS_SHARE)) {
      setFacing(token, dx > 0 ? "right" : "left");
    }

    showWalk(token);
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

    faceToward(party, target);

    if (npc && npc.id !== party.id) {
      if (!state.talks.has(npc.id)) {
        state.talks.set(npc.id, { facingBefore: getFacing(npc), startedAt: performance.now() });
      }
      faceToward(npc, { x: party.x + (party.w / 2), y: party.y + (party.h / 2) });
    }
  }

  function endTalk(npcId) {
    const talk = state.talks.get(npcId);
    if (!talk) return;
    state.talks.delete(npcId);

    const npc = canvas?.tokens?.get(npcId);
    if (npc) setFacing(npc, talk.facingBefore);
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
    tickParty(now);
    tickTalks(now);

    // Hold every tracked sprite on its facing. Foundry rewrites the mesh
    // scale whenever it refreshes a token, which would undo a mirror.
    for (const [tokenId, entry] of state.tokens) {
      const token = canvas.tokens?.get(tokenId);
      if (!token) {
        state.tokens.delete(tokenId);
        continue;
      }
      if (entry.facing !== drawnFacing(token) || entry.turnFrom !== null) applyFacing(token);
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
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = null;

    hideWalk();
    state.tokens.clear();
    state.talks.clear();

    state.partyTokenId = null;
    state.lastX = null;
    state.lastY = null;
    state.walking = false;
    state.walkDistance = 0;
    state.lastMoverIsMe = false;
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
        <legend>Facing (walk maps)</legend>
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
    setFacing(token, facing, options) { if (token) setFacing(token, facing, options); },
    faceToward(token, point) { if (token && point) faceToward(token, point); },

    // Testing: play this walk art for the party token on this client,
    // whatever the character sheet says. Pass nothing to clear it.
    sourceActorFor(token) { return token ? sourceActorFor(token) : null; },

    setWalkOverride(src) {
      hideWalk();
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
    state.active = sceneIsWalkMap(canvas?.scene);
    if (!state.active) {
      detachTicker();
      return;
    }

    await refreshPartyActor();

    // Tokens whose facing was saved start out on it.
    for (const token of canvas.tokens?.placeables ?? []) {
      const saved = token.document?.getFlag?.(MODULE_ID, FACING_FLAG);
      if (saved === "left" || saved === "right") {
        entryFor(token);
        applyFacing(token);
      }
    }

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
    const active = sceneIsWalkMap(scene);
    if (active !== state.active) start();
  });

  Hooks.on("createToken", () => { state.partyTokenId = null; });

  Hooks.on("deleteToken", (doc) => {
    state.partyTokenId = null;
    state.tokens.delete(doc.id);
    state.talks.delete(doc.id);
    if (state.walkShown?.tokenId === doc.id) state.walkShown = null;
    if (state.sway?.tokenId === doc.id) state.sway = null;
  });

  Hooks.on("refreshToken", (token) => {
    if (!state.active) return;
    if (state.tokens.has(token.id)) applyFacing(token);
  });

  Hooks.on("updateToken", (doc, change, options, userId) => {
    if (!state.active || doc.parent?.id !== canvas?.scene?.id) return;

    if (doc.id === state.partyTokenId && (("x" in change) || ("y" in change))) {
      state.lastMoverIsMe = userId === game.user?.id;

      // Placed, not walked: do not read a facing out of the jump.
      if (options?.animate === false || options?.teleport === true) {
        state.lastX = null;
        state.lastY = null;
      }
    }

    // The standing art changed (control passed to another player).
    if (change?.texture && ("src" in change.texture) && state.walkShown?.tokenId === doc.id) {
      state.walkShown = null;
    }

    // Another client saved the facing its walk ended on.
    const saved = change?.flags?.[MODULE_ID]?.[FACING_FLAG];
    if ((saved === "left" || saved === "right") && !(doc.id === state.partyTokenId && state.walking)) {
      const token = doc.object;
      if (token) setFacing(token, saved);
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
