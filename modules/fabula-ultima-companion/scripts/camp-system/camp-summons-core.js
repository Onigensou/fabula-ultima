// scripts/camp-system/camp-summons-core.js
//
// CAMP SUMMONS — a player calls their summon into camp during free time.
// Purely cosmetic: a sprite that stands with the party, follows its summoner
// and leaves when the camp moves on. No HUD, no actions, no battle state.
//
// Who can be called (campSummonsOf):
//   · the character's summons as the Party Menu lists them (companionsOf,
//     kind "summon": a persistent creature they own, or the creature of a
//     skill that allows only one at a time), guests left out;
//   · groups named on any of the character's skills by the camp-only flag
//     flags.<module>.campSummons: [[actorUuid, ...], ...] — one entry per
//     group, every actor of a group is called together (Keren's Stubborn
//     Scion: Leichi & Leilan). Nothing else reads that flag.
//
// When: Free Roam and the Sleep lobby (the two free-time slots), on the
// active camp scene. Any other phase dismisses every summon; rest does too.
// Summons out when activities start come back when the Sleep lobby opens.
// One group out per player at a time.
//
// Tokens: unlinked copies of the actors (the actor and any battle state stay
// untouched), owned by the summoning player, flagged
// flags.<module>.campSummon = { ownerActorId, ownerUserId, key, order }.
// Only the primary GM creates and deletes them (players ask over the module
// socket). Saves leave them out (save-extractors.js sceneTokenData).
//
// Walking: the walk runtime treats them as camp members (pass-through,
// facing, depth, no drag). They trail their summoner (walkCampSummon, run by
// the owner's client); Q swaps which token the player walks
// (setCampWalker). The GM drags them like any token.
//
// Optional per actor: flags.<module>.campSprite = image used at camp instead
// of the prototype token art (Crysta's token art is her battle animation).

import { companionsOf } from "../party-menu/party-menu-companions.js";
import { getPartyRoster } from "../party-menu/party-menu-core.js";

const TAG = "[CampSummons]";
export const MOD = "fabula-ultima-companion";
const CHANNEL = `module.${MOD}`;
export const FLAG = "campSummon";
export const SKILL_FLAG = "campSummons";
const SPRITE_FLAG = "campSprite";
const RETURN_FLAG = "campSummonsReturn";   // scene flag: who comes back in the Sleep lobby
export const MSG = Object.freeze({
  REQ: "campSummon:req",     // player → primary GM { op, userId, ownerActorId, key }
  RES: "campSummon:res",     // primary GM → all   { userId, ok, reason }
  FADE: "campSummon:fade",   // primary GM → all   { tokenIds } just before they are deleted
});
export const OPEN_PHASES = new Set(["free_roam", "sleep_lobby"]);
export const FADE_MS = 700;
const OFFLINE_GRACE_MS = 20000;
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
// Teleport.ogg = -15.8 LUFS at full volume; 0.3 sits ~10 dB under a normal
// voice on stream (reference_stream_audio_levels).
const SFX = { arrive: [`${ASSET}Sound/Teleport.ogg`, 0.3], leave: [`${ASSET}Sound/Teleport.ogg`, 0.2] };

const str = (v) => String(v ?? "").trim();
const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
export const isCampScene = (scene) => scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";
export const campPhase = () => { try { return globalThis.CampSystem?.State?.getPhase?.() ?? null; } catch { return null; } };
export const flagOf = (tokenOrDoc) => (tokenOrDoc?.document ?? tokenOrDoc)?.getFlag?.(MOD, FLAG) ?? null;

/** Summons may be out right now: free time, on the active camp scene. */
export function summonsOpen(scene = game.scenes?.active) {
  return !!scene && scene.active && isCampScene(scene) && OPEN_PHASES.has(campPhase());
}

export function playSfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}

// ── who can be called ───────────────────────────────────────────────────────

function actorFrom(ref) {
  const s = str(ref);
  if (!s) return null;
  let a = null;
  try { a = fromUuidSync(s); } catch {}
  if (a?.documentName === "Actor") return a;
  return game.actors?.get(s.replace(/^Actor\./, "")) ?? null;
}

/** The image a summon wears at camp. */
export function campSpriteOf(actor) {
  return str(actor?.getFlag?.(MOD, SPRITE_FLAG)) || actor?.prototypeToken?.texture?.src || actor?.img || "";
}

/**
 * The groups `owner` can call into camp, in a stable order.
 * @returns {Promise<Array<{ key, name, actors: Actor[], sprites: string[] }>>}
 */
export async function campSummonsOf(owner) {
  if (!owner) return [];
  const out = [];
  const seen = new Set();
  const add = (actors) => {
    actors = actors.filter(Boolean);
    if (!actors.length) return;
    const key = actors.map((a) => a.id).join("+");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, name: actors.map((a) => a.name).join(" & "), actors, sprites: actors.map(campSpriteOf) });
  };
  try {
    const roster = await getPartyRoster();
    for (const c of await companionsOf(roster)) {
      if (c.kind === "summon" && c.owner?.id === owner.id) add([c.actor]);
    }
  } catch (e) { console.warn(TAG, "party summons unreadable", e); }
  for (const item of owner.items ?? []) {
    const raw = item.flags?.[MOD]?.[SKILL_FLAG];
    if (!Array.isArray(raw)) continue;
    for (const group of raw) add((Array.isArray(group) ? group : [group]).map(actorFrom));
  }
  return out;
}

/** The party member this user plays (camp party entry), or null. */
export async function ownerFor(userId) {
  const entries = (await globalThis.CampSystem?.Party?.resolve?.().catch(() => [])) ?? [];
  return entries.find((e) => e.userId && e.userId === userId)?.actor ?? null;
}

/** Summon tokens on `scene` called by `userId` (all of them when userId is null). */
export function summonTokensOf(scene, userId = null) {
  return (scene?.tokens?.contents ?? []).filter((t) => {
    const f = flagOf(t);
    return f && (!userId || f.ownerUserId === userId);
  });
}

/** The summon this client walks instead of its member (Q), or null. */
export function ledToken() {
  const id = runtime()?.getCampWalker?.();
  const t = id ? canvas.tokens?.get(id) : null;
  return t && flagOf(t) ? t : null;
}

// ── player side: ask the primary GM ─────────────────────────────────────────

const _waiting = new Map();   // userId → resolve

/** Ask for a summon (op "summon" with key) or for ours to leave (op "dismiss"). */
export function request(op, { ownerActorId = null, key = null } = {}) {
  const payload = { op, userId: game.user?.id, ownerActorId, key };
  return new Promise((resolve) => {
    const done = (res) => { clearTimeout(timer); _waiting.delete(payload.userId); resolve(res); };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), 8000);
    _waiting.set(payload.userId, done);
    if (isPrimaryGM()) handleRequest(payload).then(done);
    else game.socket.emit(CHANNEL, { type: MSG.REQ, payload });
  });
}

// ── primary GM: create / delete ─────────────────────────────────────────────

const _busy = new Set();

async function handleRequest(p) {
  if (!isPrimaryGM()) return null;
  const user = game.users?.get(p?.userId);
  const scene = game.scenes?.active;
  const answer = (ok, reason = null) => {
    const res = { userId: p?.userId, ok, reason };
    game.socket.emit(CHANNEL, { type: MSG.RES, payload: res });
    return res;
  };
  if (!user) return answer(false, "no_user");
  if (_busy.has(user.id)) return answer(false, "busy");
  _busy.add(user.id);
  try {
    if (p.op === "dismiss") {
      await dismissTokens(scene, summonTokensOf(scene, user.id));
      return answer(true);
    }
    if (p.op !== "summon") return answer(false, "bad_op");
    if (!summonsOpen(scene)) return answer(false, "closed");
    const owner = await ownerFor(user.id);
    if (!owner || owner.id !== p.ownerActorId) return answer(false, "not_owner");
    if (summonTokensOf(scene, user.id).length) return answer(false, "already_out");
    const group = (await campSummonsOf(owner)).find((g) => g.key === p.key);
    if (!group) return answer(false, "unknown_summon");
    const made = await spawnGroup(scene, owner, user.id, group);
    return answer(made > 0, made > 0 ? null : "no_room");
  } catch (e) {
    console.error(TAG, "request failed", e);
    return answer(false, "error");
  } finally {
    _busy.delete(user.id);
  }
}

function memberTokenOf(scene, owner) {
  return scene.tokens.find((t) => t.actorId === owner.id && t.getFlag(MOD, "campMember"))
    ?? scene.tokens.find((t) => t.actorId === owner.id) ?? null;
}

// Free spots beside the summoner, nearest first, never through a wall. The
// first summon takes the side with more room; a second takes the other side.
function spawnSpots(scene, member, count) {
  const g = scene.grid?.size ?? 100;
  const c = { x: member.x + (member.width * g) / 2, y: member.y + (member.height * g) / 2 };
  const rect = scene.dimensions?.sceneRect ?? canvas.dimensions?.sceneRect;
  const viewing = canvas?.scene?.id === scene.id;
  const backend = CONFIG.Canvas?.polygonBackends?.move;
  const ok = (p) => {
    if (rect && (p.x < rect.x + g / 2 || p.y < rect.y + g / 2 || p.x > rect.x + rect.width - g / 2 || p.y > rect.y + rect.height - g / 2)) return false;
    if (!viewing || !backend?.testCollision) return true;
    try { return !backend.testCollision(c, p, { type: "move", mode: "any" }); } catch { return true; }
  };
  const roomRight = rect ? rect.x + rect.width - c.x : 1;
  const roomLeft = rect ? c.x - rect.x : 1;
  const first = roomRight >= roomLeft ? 1 : -1;
  const sides = [first, -first];
  const rings = [[1, 0.15], [1.1, 0.5], [0.6, 0.8], [1.6, 0.15], [1.4, -0.4]];
  const picked = [];
  for (let i = 0; i < count; i++) {
    const side = sides[i % 2];
    let spot = null;
    for (const [dx, dy] of rings) {
      for (const s of [side, -side]) {
        const p = { x: c.x + s * dx * g, y: c.y + dy * g };
        if (picked.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < g * 0.6)) continue;
        if (ok(p)) { spot = p; break; }
      }
      if (spot) break;
    }
    picked.push(spot ?? { x: c.x + side * g * 0.5, y: c.y + g * 0.2 });
  }
  return picked;
}

async function spawnGroup(scene, owner, userId, group) {
  const member = memberTokenOf(scene, owner);
  if (!member) return 0;
  const g = scene.grid?.size ?? 100;
  // The room's scale: how this member is drawn here against its own prototype.
  const protoY = Math.abs(owner.prototypeToken?.texture?.scaleY ?? 1) || 1;
  const ratio = Math.abs(member.texture?.scaleY ?? protoY) / protoY || 1;
  const spots = spawnSpots(scene, member, group.actors.length);
  const data = group.actors.map((actor, i) => {
    const d = actor.prototypeToken.toObject();
    const spot = spots[i];
    d.texture = { ...d.texture, src: campSpriteOf(actor) };
    d.name = actor.name;
    d.appendNumber = false;
    d.prependAdjective = false;
    const facing = Math.sign(member.texture?.scaleX ?? 1) || 1;
    d.texture.scaleX = Math.abs(d.texture.scaleX ?? 1) * ratio * facing;
    d.texture.scaleY = Math.abs(d.texture.scaleY ?? 1) * ratio;
    d.flags ??= {};
    d.flags.barbrawl = { resourceBars: {} };
    d.flags[MOD] = {
      ...(d.flags[MOD] ?? {}),
      [FLAG]: { ownerActorId: owner.id, ownerUserId: userId, key: group.key, order: i },
      idleAnimToken: { float: true, bounce: false },
      walkThrough: true,
    };
    Object.assign(d, {
      actorId: actor.id,
      actorLink: false,
      // The player owns this copy only; the actor itself is not shared.
      delta: { ownership: { [userId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } },
      hidden: false,
      displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
      displayName: CONST.TOKEN_DISPLAY_MODES.NONE,
      bar1: { attribute: null },
      bar2: { attribute: null },
      x: Math.round(spot.x - ((d.width ?? 1) * g) / 2),
      y: Math.round(spot.y - ((d.height ?? 1) * g) / 2),
    });
    return d;
  });
  const made = await scene.createEmbeddedDocuments("Token", data);
  return made.length;
}

/** Fade the tokens out on every client, then delete them (primary GM). */
export async function dismissTokens(scene, docs) {
  if (!isPrimaryGM() || !scene || !docs?.length) return;
  const ids = docs.map((d) => d.id);
  game.socket.emit(CHANNEL, { type: MSG.FADE, payload: { sceneId: scene.id, tokenIds: ids } });
  fadeOut(scene.id, ids);
  await new Promise((r) => setTimeout(r, FADE_MS));
  const still = ids.filter((id) => scene.tokens.get(id));
  if (still.length) await scene.deleteEmbeddedDocuments("Token", still).catch((e) => console.warn(TAG, "delete", e));
}

export async function dismissAll(scene = game.scenes?.active) {
  if (!scene) return;
  await dismissTokens(scene, summonTokensOf(scene));
}

// Remember who had a summon out when activities start; they come back in the
// Sleep lobby. Kept on the scene so a GM reload in between keeps it.
async function rememberReturning(scene) {
  const list = summonTokensOf(scene)
    .map((t) => flagOf(t))
    .filter((f, i, a) => f && a.findIndex((x) => x.ownerUserId === f.ownerUserId) === i)
    .map((f) => ({ userId: f.ownerUserId, ownerActorId: f.ownerActorId, key: f.key }));
  if (list.length) await scene.setFlag(MOD, RETURN_FLAG, list);
}

async function bringBack(scene) {
  const list = scene.getFlag(MOD, RETURN_FLAG);
  if (!Array.isArray(list) || !list.length) return;
  await scene.unsetFlag(MOD, RETURN_FLAG);
  for (const r of list) {
    if (!game.users?.get(r.userId)?.active) continue;
    await handleRequest({ op: "summon", userId: r.userId, ownerActorId: r.ownerActorId, key: r.key });
  }
}

// Leftovers: any summon on a scene that isn't the active camp in free time,
// or whose player is gone. Run by the primary GM after a reload / scene change.
async function sweep() {
  if (!isPrimaryGM()) return;
  for (const scene of game.scenes?.contents ?? []) {
    const docs = summonTokensOf(scene);
    if (!docs.length) continue;
    const open = summonsOpen(scene);
    const stale = docs.filter((d) => !open || !game.users?.get(flagOf(d)?.ownerUserId)?.active);
    if (!stale.length) continue;
    if (scene.id === game.scenes?.active?.id && canvas?.scene?.id === scene.id) await dismissTokens(scene, stale);
    else await scene.deleteEmbeddedDocuments("Token", stale.map((d) => d.id)).catch(() => {});
  }
}

let _lastPhase = null;
async function onPhase(phase) {
  if (!isPrimaryGM()) { _lastPhase = phase; return; }
  const scene = game.scenes?.active;
  const prev = _lastPhase;
  _lastPhase = phase;
  if (!scene || !isCampScene(scene)) return;
  if (OPEN_PHASES.has(phase)) {
    if (phase === "sleep_lobby" && prev !== "sleep_lobby") await bringBack(scene);
    return;
  }
  if (phase === "activity_select" && prev === "free_roam") await rememberReturning(scene);
  else if (phase !== "activity_resolve" && phase !== "bond_update" && phase !== "bond_summary") {
    if (scene.getFlag(MOD, RETURN_FLAG)) await scene.unsetFlag(MOD, RETURN_FLAG);
  }
  await dismissAll(scene);
}

// ── every client: fade in / out ─────────────────────────────────────────────

// The fade drives the sprite's own alpha and never touches its filter list:
// the idle float is a TokenMagic filter the GM writes onto the token right
// after it is created, and editing mesh.filters mid-fade dropped it on some
// clients. A token refresh resets mesh.alpha, so refreshToken puts the fade's
// value back (fading). Plus a soft glow at the feet. Local drawing only.
const fading = new Map();   // token id → current fade alpha
function animate(token, from, to, ms, done) {
  const mesh = token?.mesh;
  if (!mesh || !canvas?.app?.ticker) { done?.(); return; }
  fading.set(token.id, from);
  mesh.alpha = from;
  const glow = feetGlow(token);
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const a = from + (to - from) * e;
    fading.set(token.id, a);
    if (!mesh.destroyed) mesh.alpha = a;
    if (glow) { glow.alpha = Math.sin(Math.PI * k) * 0.85; glow.scale.set(0.6 + 0.6 * k); }
    if (k >= 1 || mesh.destroyed) {
      canvas.app.ticker.remove(tick);
      glow?.destroy();
      if (to >= 1) {
        fading.delete(token.id);
        if (!mesh.destroyed) token.renderFlags?.set?.({ refreshState: true });
      }
      done?.();
    }
  };
  canvas.app.ticker.add(tick);
}

function feetGlow(token) {
  try {
    const g = new PIXI.Graphics();
    const w = token.w * 0.9;
    for (let i = 4; i >= 1; i--) {
      g.beginFill(0xffe9b0, 0.12 * (5 - i));
      g.drawEllipse(0, 0, (w / 2) * (i / 4), (w / 7) * (i / 4));
      g.endFill();
    }
    g.position.set(token.document.x + token.w / 2, token.document.y + token.h * 0.95);
    g.alpha = 0;
    g.filters = [new PIXI.BlurFilter(6)];
    canvas.tokens.addChild(g);
    return g;
  } catch { return null; }
}

const _fadingOut = new Set();
function fadeIn(token) {
  if (!token || _fadingOut.has(token.id)) return;
  animate(token, 0, 1, FADE_MS);
}
function fadeOut(sceneId, ids) {
  if (canvas?.scene?.id !== sceneId) return;
  let any = false;
  for (const id of ids) {
    const t = canvas.tokens?.get(id);
    if (!t || _fadingOut.has(id)) continue;
    _fadingOut.add(id);
    any = true;
    // Stays at 0 (fading keeps it there) for the moment until the delete.
    animate(t, 1, 0, FADE_MS);
  }
  if (any) playSfx("leave");
}

// ── owner's client: trail the summoner ──────────────────────────────────────

const _lastCenter = new Map();   // member token id → its last centre

function trailTargets(member, from, to, count) {
  const g = canvas.grid?.size ?? 100;
  let dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  dx /= len; dy /= len;
  const px = -dy, py = dx;   // perpendicular
  if (count === 1) return [{ x: to.x - dx * 0.95 * g + px * 0.25 * g, y: to.y - dy * 0.95 * g + py * 0.25 * g }];
  return Array.from({ length: count }, (_, i) => {
    const s = i % 2 === 0 ? 1 : -1;
    return { x: to.x - dx * 0.75 * g + px * s * 0.6 * g, y: to.y - dy * 0.75 * g + py * s * 0.6 * g };
  });
}

function onMemberMoved(doc, change, options, userId) {
  if (userId !== game.user?.id || game.user?.isGM) return;
  if (!("x" in change) && !("y" in change)) return;
  if (!doc.getFlag(MOD, "campMember") || !doc.isOwner) return;
  const rt = runtime();
  const token = doc.object;
  if (!rt?.walkCampSummon || !token) return;
  const g = canvas.grid?.size ?? 100;
  const to = { x: doc.x + token.w / 2, y: doc.y + token.h / 2 };
  const drawn = { x: token.x + token.w / 2, y: token.y + token.h / 2 };
  const from = _lastCenter.get(doc.id)
    ?? (Math.hypot(drawn.x - to.x, drawn.y - to.y) < g * 6 ? drawn : null);
  if (!from) { _lastCenter.set(doc.id, to); return; }
  _lastCenter.set(doc.id, to);
  const led = rt.getCampWalker?.();
  const followers = summonTokensOf(canvas.scene, game.user.id)
    .filter((t) => t.id !== led && flagOf(t)?.ownerActorId === doc.actorId)
    .sort((a, b) => (flagOf(a)?.order ?? 0) - (flagOf(b)?.order ?? 0));
  if (!followers.length) return;
  const targets = trailTargets(doc, from, to, followers.length);
  if (!targets) return;
  const speed = (Number(options?.animation?.movementSpeed) || rt.WALK_SPEED || 3) * 1.08;
  followers.forEach((t, i) => {
    const tok = t.object;
    if (!tok) return;
    const here = { x: t.x + tok.w / 2, y: t.y + tok.h / 2 };
    if (Math.hypot(targets[i].x - here.x, targets[i].y - here.y) < g * 0.35) return;
    rt.walkCampSummon(tok, targets[i], { speed }).catch(() => {});
  });
}

// ── owner's client: Q swaps who you walk ────────────────────────────────────

function typing(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function onKey(ev) {
  if (ev.code !== "KeyQ" || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
  if (game.user?.isGM || typing(document.activeElement)) return;
  if (document.getElementById("fud-party-menu") || document.querySelector(".fu-summon-pick")) return;
  if (!canvas?.scene || !summonsOpen(canvas.scene)) return;
  const rt = runtime();
  if (!rt?.setCampWalker) return;
  const mine = summonTokensOf(canvas.scene, game.user.id)
    .filter((t) => t.isOwner && t.object)
    .sort((a, b) => (flagOf(a)?.order ?? 0) - (flagOf(b)?.order ?? 0));
  if (!mine.length) return;
  const cycle = [null, ...mine.map((t) => t.id)];
  const at = cycle.indexOf(rt.getCampWalker?.() ?? null);
  rt.setCampWalker(cycle[(at + 1) % cycle.length]);
  ev.preventDefault();
  ev.stopPropagation();
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src: `${ASSET}Sound/BattleCursor_4.wav`, volume: 0.4, autoplay: true, loop: false }, false); } catch {}
  Hooks.callAll("campSummons.walkerChanged");
}

// ── install ─────────────────────────────────────────────────────────────────

let _installed = false;
export function installCampSummons() {
  if (_installed) return;
  _installed = true;

  game.socket.on(CHANNEL, (msg) => {
    const { type, payload } = msg ?? {};
    if (type === MSG.REQ) { if (isPrimaryGM()) handleRequest(payload); return; }
    if (type === MSG.RES) { _waiting.get(payload?.userId)?.(payload); return; }
    if (type === MSG.FADE) { fadeOut(payload?.sceneId, payload?.tokenIds ?? []); }
  });

  // A new summon fades in from its first drawn frame (drawToken comes after
  // createToken, once the sprite exists); the rAF fallback covers a token
  // whose draw finished before the hook below saw it.
  const pendingIn = new Set();
  Hooks.on("createToken", (doc) => {
    if (!flagOf(doc) || doc.parent?.id !== canvas?.scene?.id) return;
    playSfx("arrive");
    pendingIn.add(doc.id);
    const start = performance.now();
    const wait = () => {
      if (!pendingIn.has(doc.id)) return;
      const t = doc.object;
      if (t?.mesh) { pendingIn.delete(doc.id); fadeIn(t); return; }
      if (performance.now() - start < 2000) requestAnimationFrame(wait);
      else pendingIn.delete(doc.id);
    };
    requestAnimationFrame(wait);
  });
  Hooks.on("drawToken", (token) => {
    if (!pendingIn.has(token.id) || !token.mesh) return;
    pendingIn.delete(token.id);
    fadeIn(token);
  });
  Hooks.on("refreshToken", (token) => {
    const a = fading.get(token.id);
    if (a !== undefined && token.mesh && !token.mesh.destroyed) token.mesh.alpha = a;
  });
  Hooks.on("deleteToken", (doc) => {
    _fadingOut.delete(doc.id);
    fading.delete(doc.id);
    _lastCenter.delete(doc.id);
    if (flagOf(doc) && runtime()?.getCampWalker?.() === doc.id) {
      runtime()?.setCampWalker?.(null);
      Hooks.callAll("campSummons.walkerChanged");
    }
  });
  Hooks.on("updateToken", onMemberMoved);
  window.addEventListener("keydown", onKey, true);

  // Phase changes (every client tracks the last phase; the primary GM acts).
  Hooks.on("updateSetting", (s) => {
    if (s?.key === `${MOD}.campPhase`) onPhase(campPhase()).catch((e) => console.warn(TAG, "phase", e));
  });
  _lastPhase = campPhase();
  Hooks.on("fabula.restPerformed", () => { if (isPrimaryGM()) dismissAll().catch(() => {}); });
  Hooks.on("canvasReady", () => {
    runtime()?.setCampWalker?.(null);
    _lastCenter.clear();
    setTimeout(() => sweep().catch((e) => console.warn(TAG, "sweep", e)), 1500);
  });
  Hooks.on("userConnected", (user, connected) => {
    if (connected || !isPrimaryGM()) return;
    setTimeout(() => {
      if (game.users?.get(user.id)?.active) return;
      for (const scene of game.scenes?.contents ?? []) {
        const docs = summonTokensOf(scene, user.id);
        if (docs.length) dismissTokens(scene, docs).catch(() => {});
      }
    }, OFFLINE_GRACE_MS);
  });
  setTimeout(() => sweep().catch((e) => console.warn(TAG, "sweep", e)), 3000);

  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  root.api = root.api ?? {};
  root.api.campSummons = {
    listFor: campSummonsOf, ownerFor, request, ledToken, summonsOpen,
    tokensOf: (userId = null) => summonTokensOf(game.scenes?.active, userId),
    // GM / test surface
    dismissAll, sweep,
  };
  console.debug(TAG, "ready.");
}
