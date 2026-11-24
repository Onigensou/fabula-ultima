// Late-join resync — the pure half (no Foundry globals; unit-tested in
// late-join-core.test.mjs). The wiring lives in late-join-resync.js.
//
// Why this exists: Foundry core fetches the world snapshot at the very start of
// a boot but only starts listening for document changes after `ready`
// (foundry.js `this.ready = true; this.activateSocketListeners()`). Every
// create / update / delete broadcast in between is dropped without an error. A
// player who loads while a battle is being set up can therefore keep missing
// statuses, tokens or summons, or keep ghosts of removed ones, until the next
// reload. See tools/handoffs/late-join-hunt-2026-11-24.md (root cause 2).
//
// Digest (built the same way on the host and on the joining client):
//   { v, active, sceneId, settled,
//     tokens: { [tokenId]: { a: actorId, l: actorLink, x, y, h: hidden,
//                            fx, hp, mp } },      // fx/hp/mp: unlinked tokens only
//     actors: { [actorId]: { fx, hp, mp } | null } } // every token's base actor + the Field
//   fx = sorted ["<effectId>:<1 enabled|0 disabled>"], or null when no actor resolves.

export const DIGEST_VERSION = 1;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Effect list of an actor-like ({ effects }) as sorted "id:1|0" strings. */
export function fxList(actor) {
  if (!actor) return null;
  const out = [];
  for (const e of actor.effects ?? []) out.push(`${e.id ?? e._id}:${e.disabled ? 0 : 1}`);
  return out.sort();
}

function vitalsOf(actor) {
  const p = actor?.system?.props ?? {};
  return { hp: num(p.current_hp), mp: num(p.current_mp) };
}

function actorEntry(actor) {
  if (!actor) return null;
  return { fx: fxList(actor), ...vitalsOf(actor) };
}

/**
 * Build a digest from documents (or plain look-alikes).
 * @param {object} p
 * @param {object|null} p.scene        has .id and iterable .tokens (TokenDocument-like:
 *                                     id, actorId, actorLink, x, y, hidden, actor)
 * @param {string[]} [p.actorIds]      extra actor ids to include (the Field actor; the host's list on a client)
 * @param {(id:string)=>object|null} p.getActor  world actor lookup
 */
export function buildDigest({ scene, actorIds = [], getActor, settled = null }) {
  if (!scene) return { v: DIGEST_VERSION, active: false };
  const tokens = {};
  const ids = new Set(actorIds.filter(Boolean));
  for (const t of scene.tokens ?? []) {
    const id = t.id ?? t._id;
    const entry = { a: t.actorId ?? null, l: !!t.actorLink, x: num(t.x), y: num(t.y), h: !!t.hidden };
    if (!entry.l) {
      const a = t.actor ?? null;
      entry.fx = fxList(a);
      Object.assign(entry, a ? vitalsOf(a) : { hp: null, mp: null });
    }
    tokens[id] = entry;
    if (entry.a) ids.add(entry.a);
  }
  const actors = {};
  for (const id of ids) actors[id] = actorEntry(getActor(id));
  return { v: DIGEST_VERSION, active: true, sceneId: scene.id ?? scene._id, settled, tokens, actors };
}

const setDiff = (a = [], b = []) => { const s = new Set(b); return a.filter((x) => !s.has(x)); };

function fxDelta(want, have) {
  const W = new Map((want ?? []).map((s) => s.split(":")));
  const H = new Map((have ?? []).map((s) => s.split(":")));
  const missing = [...W.keys()].filter((id) => !H.has(id));
  const extra = [...H.keys()].filter((id) => !W.has(id));
  const changed = [...W.keys()].filter((id) => H.has(id) && H.get(id) !== W.get(id));
  return { missing, extra, changed };
}

/**
 * Differences between the host's digest and this client's. Each issue has a
 * stable `k` (kind + id) so two reads can be intersected.
 */
export function compareDigests(host, local) {
  const issues = [];
  if (!host?.active || !local?.active) return issues;
  for (const [aid, want] of Object.entries(host.actors ?? {})) {
    if (!want) continue;                                   // the host can't resolve it either
    const have = local.actors?.[aid] ?? null;
    if (!have) { issues.push({ k: `actor-missing:${aid}`, kind: "actor-missing", actorId: aid }); continue; }
    const d = fxDelta(want.fx, have.fx);
    if (d.missing.length || d.extra.length || d.changed.length) issues.push({ k: `actor-fx:${aid}`, kind: "actor-fx", actorId: aid, ...d });
    if (want.hp !== have.hp || want.mp !== have.mp) issues.push({ k: `actor-vitals:${aid}`, kind: "actor-vitals", actorId: aid, want: [want.hp, want.mp], have: [have.hp, have.mp] });
  }
  for (const [tid, want] of Object.entries(host.tokens ?? {})) {
    const have = local.tokens?.[tid];
    if (!have) { issues.push({ k: `token-missing:${tid}`, kind: "token-missing", tokenId: tid, actorId: want.a }); continue; }
    const fields = ["x", "y", "h"].filter((f) => want[f] !== have[f]);
    if (fields.length) issues.push({ k: `token-fields:${tid}`, kind: "token-fields", tokenId: tid, fields });
    if (want.l) continue;
    if (want.fx && !have.fx) { issues.push({ k: `token-no-actor:${tid}`, kind: "token-no-actor", tokenId: tid, actorId: want.a }); continue; }
    if (!want.fx) continue;
    const d = fxDelta(want.fx, have.fx);
    if (d.missing.length || d.extra.length || d.changed.length) issues.push({ k: `token-fx:${tid}`, kind: "token-fx", tokenId: tid, ...d });
    if (want.hp !== have.hp || want.mp !== have.mp) issues.push({ k: `token-vitals:${tid}`, kind: "token-vitals", tokenId: tid, want: [want.hp, want.mp], have: [have.hp, have.mp] });
  }
  for (const tid of Object.keys(local.tokens ?? {})) {
    if (!host.tokens?.[tid]) issues.push({ k: `token-extra:${tid}`, kind: "token-extra", tokenId: tid });
  }
  return issues;
}

const FX_LISTS = ["missing", "extra", "changed"];

/**
 * Issues present in BOTH reads (same key). An event still in flight shows up only once.
 * Per ID, not per key: for an effect issue only the ids that are missing / extra /
 * changed in BOTH reads survive, so an AE that arrived (or went) live between the
 * reads is not carried along by its neighbours.
 */
export function stableIssues(first, second) {
  const byKey = new Map((first ?? []).map((i) => [i.k, i]));
  const out = [];
  for (const i of second ?? []) {
    const f = byKey.get(i.k);
    if (!f) continue;
    if (!FX_LISTS.some((l) => Array.isArray(i[l]))) { out.push(i); continue; }
    const m = { ...i };
    for (const l of FX_LISTS) {
      const other = new Set(f[l] ?? []);
      m[l] = (i[l] ?? []).filter((id) => other.has(id));
    }
    if (FX_LISTS.some((l) => m[l].length)) out.push(m);
  }
  return out;
}

const ACTOR_KINDS = new Set(["actor-missing", "actor-fx", "actor-vitals", "token-no-actor"]);

/**
 * What to fetch from the server for a set of issues. Actor-level issues are
 * fixed first, alone, because token-level fixes read through the base actor.
 */
export function fetchPlan(issues, hostDigest) {
  const actorPhase = issues.some((i) => ACTOR_KINDS.has(i.kind));
  const actorIds = new Set();
  let scene = false;
  for (const i of issues) {
    if (actorPhase) {
      if (ACTOR_KINDS.has(i.kind) && i.actorId) actorIds.add(i.actorId);
      continue;
    }
    scene = true;
    const a = hostDigest?.tokens?.[i.tokenId]?.a;
    if (a && (i.kind === "token-fx" || i.kind === "token-missing")) actorIds.add(a);
  }
  return { phase: actorPhase ? "actors" : "tokens", actorIds: [...actorIds], scene };
}

/** The synthetic actor's effects as the server holds them: base effects overlaid by the delta. */
export function effectiveDeltaEffects(baseEffects = [], deltaEffects = []) {
  const m = new Map(baseEffects.map((e) => [e._id, e]));
  for (const e of deltaEffects ?? []) {
    if (e._tombstone) m.delete(e._id);
    else m.set(e._id, { ...(m.get(e._id) ?? {}), ...e });
  }
  return m;
}

const fxMapOf = (list) => new Map((list ?? []).map((s) => s.split(":")));

/**
 * Turn issues + server data into replay operations for core's modifyDocument
 * handler. Server data is the truth; the host digest only says where to look.
 *
 * @param {object[]} issues   stable issues from compareDigests
 * @param {object} ctx
 * @param {object} ctx.local          this client's digest
 * @param {string} ctx.sceneId
 * @param {object|null} ctx.serverScene   raw Scene source ({ tokens: [...] }), when fetched
 * @param {Object<string,object>} ctx.serverActors  raw Actor sources by id, when fetched
 * @param {(tokenId:string)=>string|null} ctx.localDeltaId  this client's ActorDelta id for a token
 * @returns {{ ops: object[], unfixable: object[] }}
 *   op = { type, action: "create"|"update"|"delete"|"reset-token", parentUuid, result, tokenId? }
 */
export function planReconcile(issues, { local, sceneId, serverScene = null, serverActors = {}, localDeltaId = () => null }) {
  const ops = [];
  const unfixable = [];
  const sceneUuid = `Scene.${sceneId}`;
  const srvTokens = new Map((serverScene?.tokens ?? []).map((t) => [t._id, t]));
  const actorPhase = issues.some((i) => ACTOR_KINDS.has(i.kind));
  const created = new Set();

  // Per id: a create only for an id the issue names as missing (absent here in
  // every read AND still absent), a delete only for an id it names as extra, an
  // update only for one it names as changed. The server list is only the source
  // of the data -- never diffed whole against the local list (that read may be
  // older than a live event this client already handled).
  const fxOps = (parentUuid, serverFx, haveList, deltaMode = null, issue = null) => {
    const have = fxMapOf(haveList);
    const scoped = issue && FX_LISTS.some((l) => Array.isArray(issue[l]));
    const want = (l) => (scoped ? new Set(issue[l] ?? []) : null);
    const wMissing = want("missing"), wExtra = want("extra"), wChanged = want("changed");
    const creates = [], updates = [], deletes = [];
    for (const [id, src] of serverFx) {
      if (!have.has(id)) {
        if (wMissing && !wMissing.has(id)) continue;
        if (deltaMode && !deltaMode.inDelta(id)) { unfixable.push({ why: "missing base-actor effect on a token", parentUuid, id }); continue; }
        creates.push(src);
      } else if (have.get(id) !== (src.disabled ? "0" : "1")) {
        if (wChanged && !wChanged.has(id)) continue;
        updates.push(src);
      }
    }
    for (const id of have.keys()) {
      if (serverFx.has(id)) continue;
      if (wExtra && !wExtra.has(id)) continue;
      deletes.push(id);
    }
    if (creates.length) ops.push({ type: "ActiveEffect", action: "create", parentUuid, result: creates });
    if (updates.length) ops.push({ type: "ActiveEffect", action: "update", parentUuid, result: updates });
    if (deletes.length) ops.push({ type: "ActiveEffect", action: "delete", parentUuid, result: deletes });
  };

  for (const i of issues) {
    if (actorPhase !== ACTOR_KINDS.has(i.kind)) continue;     // the other phase runs next round
    switch (i.kind) {
      case "actor-missing":
      case "token-no-actor": {
        const src = serverActors[i.actorId];
        if (!src) { unfixable.push({ why: "actor not on the server", ...i }); break; }
        if (!created.has(i.actorId) && !local.actors?.[i.actorId]) {
          created.add(i.actorId);
          ops.push({ type: "Actor", action: "create", parentUuid: null, result: [src] });
        }
        if (i.kind === "token-no-actor") ops.push({ type: "Token", action: "reset-token", parentUuid: sceneUuid, tokenId: i.tokenId, result: [] });
        break;
      }
      case "actor-fx": {
        const src = serverActors[i.actorId];
        if (!src) { unfixable.push({ why: "actor not on the server", ...i }); break; }
        fxOps(`Actor.${i.actorId}`, new Map((src.effects ?? []).map((e) => [e._id, e])), local.actors?.[i.actorId]?.fx, null, i);
        break;
      }
      case "actor-vitals": {
        const src = serverActors[i.actorId];
        if (!src) { unfixable.push({ why: "actor not on the server", ...i }); break; }
        // Only the two vitals: replaying the whole `system` re-runs sprite / sheet hooks for nothing.
        const sp = src.system?.props ?? {};
        ops.push({ type: "Actor", action: "update", parentUuid: null, result: [{ _id: i.actorId, system: { props: { current_hp: sp.current_hp, current_mp: sp.current_mp } } }] });
        break;
      }
      case "token-missing": {
        const t = srvTokens.get(i.tokenId);
        if (!t) { unfixable.push({ why: "token not on the server", ...i }); break; }
        ops.push({ type: "Token", action: "create", parentUuid: sceneUuid, result: [t] });
        break;
      }
      case "token-extra": {
        if (srvTokens.has(i.tokenId)) { unfixable.push({ why: "token still on the server", ...i }); break; }
        ops.push({ type: "Token", action: "delete", parentUuid: sceneUuid, result: [i.tokenId] });
        break;
      }
      case "token-fields": {
        const t = srvTokens.get(i.tokenId);
        if (!t) { unfixable.push({ why: "token not on the server", ...i }); break; }
        ops.push({ type: "Token", action: "update", parentUuid: sceneUuid, result: [{ _id: t._id, x: t.x, y: t.y, hidden: t.hidden }] });
        break;
      }
      case "token-fx": {
        const t = srvTokens.get(i.tokenId);
        const base = t ? serverActors[t.actorId] : null;
        const deltaId = localDeltaId(i.tokenId);
        if (!t || !base || !deltaId) { unfixable.push({ why: "token, base actor or delta missing", ...i }); break; }
        const delta = t.delta ?? {};
        const inDelta = new Set((delta.effects ?? []).filter((e) => !e._tombstone).map((e) => e._id));
        fxOps(`${sceneUuid}.Token.${i.tokenId}.ActorDelta.${deltaId}`,
          effectiveDeltaEffects(base.effects ?? [], delta.effects ?? []),
          local.tokens?.[i.tokenId]?.fx, { inDelta: (id) => inDelta.has(id) }, i);
        break;
      }
      case "token-vitals": {
        const t = srvTokens.get(i.tokenId);
        const deltaId = localDeltaId(i.tokenId);
        if (!t || !deltaId) { unfixable.push({ why: "token or delta missing", ...i }); break; }
        ops.push({ type: "ActorDelta", action: "update", parentUuid: `${sceneUuid}.Token.${i.tokenId}`, result: [{ _id: deltaId, system: t.delta?.system ?? {} }] });
        break;
      }
      default: break;
    }
  }
  // Order: actors, then tokens, then what lives under them.
  const rank = { Actor: 0, Token: 1, ActorDelta: 2, ActiveEffect: 3 };
  const act = { create: 0, "reset-token": 1, update: 2, delete: 3 };
  ops.sort((a, b) => (rank[a.type] - rank[b.type]) || (act[a.action] - act[b.action]));
  return { ops, unfixable };
}

/** The modifyDocument response core's socket handler expects, for one replay op. */
export function toSocketResponse(op, { userId, now = Date.now() } = {}) {
  // animate:false on EVERY replay: a create would otherwise float one scrolling
  // status text per effect (14 at once in the measured case) for old news.
  const operation = { action: op.action, modifiedTime: now, render: true, renderSheet: false, animate: false, lateJoinResync: true };
  if (op.parentUuid) operation.parentUuid = op.parentUuid;
  if (op.action === "update") Object.assign(operation, { diff: false, recursive: true });
  return { type: op.type, action: op.action, operation, result: op.result, userId, broadcast: true };
}

/**
 * Drop create entries whose id this client already holds (belt and braces for
 * an event that arrived normally after the plan was built: core does not guard
 * an existing id, so a second create would run _onCreate + create* hooks twice).
 * @param {object[]} ops
 * @param {(op:object, id:string)=>boolean} has   does the op's target collection hold this id?
 * @returns {{ ops: object[], dropped: string[] }}
 */
export function dropExistingCreates(ops, has) {
  const out = [];
  const dropped = [];
  for (const op of ops ?? []) {
    if (op.action !== "create") { out.push(op); continue; }
    const keep = [];
    for (const src of op.result ?? []) {
      const id = src?._id ?? src?.id;
      if (id && has(op, id)) dropped.push(`${op.type}:${id}`);
      else keep.push(src);
    }
    if (keep.length) out.push({ ...op, result: keep });
  }
  return { ops: out, dropped };
}

/**
 * Re-check one op against the live collections immediately before it is applied
 * (the plan was built before awaits). Returns the op to run, or null when nothing
 * is left of it. Creates keep only ids not held yet; deletes keep only ids still
 * held (`has(op, id)` = does the op's target collection hold this id right now?).
 */
export function recheckOp(op, has) {
  if (op.action === "create") return dropExistingCreates([op], has).ops[0] ?? null;
  if (op.action === "delete") {
    const keep = (op.result ?? []).filter((id) => has(op, typeof id === "string" ? id : (id?._id ?? id?.id)));
    return keep.length ? { ...op, result: keep } : null;
  }
  return op;
}

// ── Reload fallback: is this the moment? ────────────────────────────────────

// The FSM waits on a human here (director-player-hud's SETTLED_STATES minus the
// reaction window: a reload there can cost a reaction).
export const SETTLED_STATES = new Set(["TURN_START", "DECLARE", "TARGET", "CONFIRM"]);

/**
 * Host side: is the battle settled enough for THIS user's page to reload?
 * Busy = ANY menu cached for the user on the intent channel (whatever it is, a
 * reload would replay it mid-decision), or CONFIRM while the user owns the action.
 * @param {object} p
 * @param {string|null} p.state           director FSM state
 * @param {object[]|null} p.cached        intent-channel cache entries for the user ({ menuSpec })
 * @param {string|null} p.userId
 * @param {string|null} [p.actingOwnerId] owner of the acting creature, if known
 */
export function hostSettledFor({ state, cached = null, userId = null, actingOwnerId = null }) {
  if (!SETTLED_STATES.has(state)) return false;
  if ((cached?.length ?? 0) > 0) return false;
  if (state === "CONFIRM" && userId) {
    if (actingOwnerId && actingOwnerId === userId) return false;
    if ((cached ?? []).some((p) => p?.menuSpec?.ownerUserId === userId)) return false;
  }
  return true;
}

// What on this page means the player is in the middle of something. Class names
// from reaction-hand.js (ensureHand / card build), action-card.js (the mirror
// wrapper and its confirm owner), remote-pick.js (open picker count).
export const BUSY_SELECTORS = Object.freeze({
  reactionCard: ".rxh-clip .rxh-card:not(.is-leaving)",
  reactionPass: ".rxh-clip .rxh-pass:not(.is-hidden)",
  reactionMenu: '[id^="fud-react-menu-"]',
  mirror: "#fud-bf-mirror-root",
});

/**
 * Client side: is this page busy right now?
 * @param {(sel:string)=>Element|null} q   querySelector
 * @param {object} p
 * @param {string|null} p.userId
 * @param {number} [p.picksOpen]           remote pickers open here
 * @returns {string|null}  the reason, or null when free
 */
export function pageBusyReason(q, { userId = null, picksOpen = 0 } = {}) {
  if (picksOpen > 0) return "remote-pick";
  if (q(BUSY_SELECTORS.reactionCard)) return "reaction-hand";
  if (q(BUSY_SELECTORS.reactionPass)) return "reaction-pass";
  if (q(BUSY_SELECTORS.reactionMenu)) return "reaction-menu";
  const m = q(BUSY_SELECTORS.mirror);
  if (m && userId && m.dataset?.fudConfirmUserId === userId) return "action-card";
  return null;
}
