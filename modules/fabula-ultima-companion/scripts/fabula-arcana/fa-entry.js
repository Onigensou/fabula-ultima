// scripts/fabula-arcana/fa-entry.js
// THE WAYS IN (proximity buttons on the shared overhead row — window.oni.Interact, like Shop / Craft):
//   Card Duel  an NPC whose actor has flags.<mod>.faDuelist (set with FUCompanion.api.fabulaArcana.setDuelist).
//              Optional story gate: faDuelist.requiresSwitch = "<switch name>" (window.oni.GameState).
//              Card Duel and Challenge both need the game unlocked first (fa-const UNLOCK_SWITCH; the GM always can).
//              Who plays: walk map → the Main Controller's party member; camp → each player's own member.
//   Challenge  camp scenes only: another player's character near yours. They get an Accept / Decline prompt.
//   Watch      anyone not playing, near a dueling character (or the NPC they challenged): opens the read-only board.
// While a duel runs, a small cards icon floats over both duelists on every client.

import { TAG, MODULE_ID, FLAG_DUELIST, gp, isCampScene, cameraRuntime, hostGM, faUnlocked, Catalog } from "./fa-const.js";
import { send } from "./fa-net.js";
import { status, playUi } from "./fa-client.js";
import { showChallengeSetup } from "./fa-invite-ui.js";
import { ownedCards } from "./fa-collection.js";
import { hasBeaten, npcKeyOf } from "./fa-feedback.js";

const LAYER_ID = "fa-duel-layer", ICON_LAYER_ID = "fa-duel-icons", STYLE_ID = "fa-duel-style";
const ANIM_OUT_MS = 140;

export const duelistOf = (actor) => gp(actor, `flags.${MODULE_ID}.${FLAG_DUELIST}`, null);
const hidden = (t) => t?.document?.hidden === true;
const centerOf = (token, ov = null) => ({ x: (ov?.x ?? token?.document?.x ?? token?.x ?? 0) + (token?.w ?? 0) / 2, y: (ov?.y ?? token?.document?.y ?? token?.y ?? 0) + (token?.h ?? 0) / 2 });

// ------------------------------------------------------------------ who plays from this client
export async function controller() { try { return (await globalThis.FUCompanion?.api?.MovementControl?.getCurrentControllerUser?.()) ?? null; } catch { return null; } }
export async function partyMemberIds() {
  const ids = new Set();
  const rtm = cameraRuntime();
  if (rtm?.state?.partyMemberIds?.size) for (const id of rtm.state.partyMemberIds) ids.add(id);
  try {
    const r = await window.FUCompanion?.api?.getCurrentGameDb?.();
    if (r?.db?.id) ids.add(r.db.id);
    const props = r?.source?.system?.props ?? r?.db?.system?.props ?? {};
    for (const [k, v] of Object.entries(props)) { if (/^member_id_\d+$/i.test(k) && typeof v === "string") { const id = v.trim().replace(/^Actor\./, ""); if (id) ids.add(id); } }
  } catch {}
  return ids;
}
export async function resolveChallenger() {
  if (isCampScene(canvas?.scene) && !game.user.isGM) {
    const t = cameraRuntime()?.getFollowToken?.();
    if (t?.actor && t.document?.isOwner) return t.actor;
    return game.user.character ?? null;
  }
  const ctl = await controller();
  const ctlActor = game.actors?.get(ctl?.partyMemberActorId ?? ctl?.linkedActorId ?? "") ?? null;
  if (game.user.isGM) {
    if (ctlActor) return ctlActor;
    const ids = [...(await partyMemberIds())].map((id) => game.actors.get(id)).filter((a) => a && a.type !== "database" && a.hasPlayerOwner);
    return ids[0] ?? game.user.character ?? null;
  }
  if (!ctl || ctl.userId !== game.user.id) return null;
  return ctlActor ?? game.user.character ?? null;
}
let _canCache = { at: 0, v: false, scene: null };
async function canChallengeNpc() {
  if (game.user.isGM || isCampScene(canvas?.scene)) return true;
  const now = Date.now();
  if (_canCache.scene === canvas?.scene?.id && now - _canCache.at < 1500) return _canCache.v;
  let v = false; try { v = !!(await globalThis.FUCompanion?.api?.MovementControl?.isCurrentUserMainController?.()); } catch {}
  _canCache = { at: now, v, scene: canvas?.scene?.id };
  return v;
}
function storyOpen(cfg) {
  const sw = String(cfg?.requiresSwitch ?? "").trim();
  if (!sw) return true;
  try { return !!window.oni?.GameState?.getSwitch?.(sw); } catch { return false; }
}
const activeDuelOf = (actorId) => status.sessions.find((s) => s.actorIds.includes(actorId));
const myDuel = () => status.sessions.find((s) => s.userIds.includes(game.user.id));

// ------------------------------------------------------------------ actions
const hostId = () => hostGM()?.id ?? null;
// The challenge, FF8 / FF9 style (approved 2026-11-25): the NPC says its challenge line (its rematch line once the party
// has beaten it) over its token, then the parchment Yes / No box asks "Card duel with Willy?" with the ante and rules
// underneath. Duel! starts it; Not now gets the NPC's decline line. The box is mirrored to the table like a door prompt
// (a GM can answer for the party); at camp it stays on this player's screen.
let talking = false;
const speak = (token, text) => {
  if (!text || !token?.id) return;
  try { globalThis.FU?.Dialog?.show?.({ tokenId: token.id, text: String(text), broadcast: true }); } catch (e) { console.warn(TAG, "duel line", e); }
};
async function duelTalk(token, actor) {
  const cfg = duelistOf(token?.actor) || {};
  const beaten = hasBeaten(npcKeyOf({ actorId: token?.actor?.id }));
  speak(token, (beaten && cfg.rematchQuote) || cfg.quote || "");
  const ask = globalThis.TeleporterSystem?.askYesNo;
  if (typeof ask !== "function") return true;   // no prompt box loaded: straight in, as before
  const C = Catalog();
  const prize = cfg.prize && C?.CARDS?.[cfg.prize] && !ownedCards(actor).includes(cfg.prize) ? C.CARDS[cfg.prize].name : null;
  const bo = [3, 5].includes(Number(cfg.bestOf)) ? `Best of ${cfg.bestOf}` : "Best of 1";
  const note = `${prize ? `Ante: ${prize} card` : "Friendly match"} · Standard ${C?.CFG?.BUDGET ?? 5}★ · ${bo}`;
  const name = token?.document?.name || token?.actor?.name || "the challenger";
  const yes = await ask(["Card duel with ", name, "?"], { labels: { yes: "Duel!", no: "Not now" }, note, place: "low", mirror: !isCampScene(canvas?.scene) });
  if (!yes) speak(token, cfg.declineQuote || "");
  return !!yes;
}

export async function challengeNpc(token, { challenger = null, practice = null } = {}) {
  const actor = challenger ?? (await resolveChallenger());
  if (!actor) return ui.notifications?.warn("Fabula Arcana | Only the party leader can accept a duel here.");
  if (token && !practice) {
    if (talking) return;
    talking = true;
    let go = false;
    try { go = await duelTalk(token, actor); } catch (e) { console.warn(TAG, "duel talk", e); go = true; } finally { talking = false; }
    if (!go) return;
  }
  const h = hostId() ?? game.user.id;   // no GM online → this client hosts its own NPC duel
  send(h, "challenge-npc", { challengerActorId: actor.id, npcActorId: token?.actor?.id ?? null, npcTokenUuid: token?.document?.uuid ?? null, practice });
}
// camp challenge: the challenger first picks the match rules + Best of (the last ones used come back pre-set)
const RULES_KEY = "fa.challengeRules";
const lastRules = () => { try { const v = JSON.parse(localStorage.getItem(RULES_KEY) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
export function openChallenge(targetActor) {
  if (!targetActor) return;
  const last = lastRules();
  showChallengeSetup({ toName: targetActor.name, img: targetActor.img || "", bestOf: last.bestOf ?? 1, format: last.format ?? null, privatePick: !!last.privatePick, sound: playUi,
    onSend: ({ bestOf, format, privatePick }) => { try { localStorage.setItem(RULES_KEY, JSON.stringify({ bestOf, format, privatePick })); } catch {} challengePlayer(targetActor, { bestOf, format, privatePick }); } });
}
export async function challengePlayer(targetActor, { bestOf = 1, format = null, privatePick = false, challenger = null } = {}) {
  const me = challenger ?? (await resolveChallenger());
  if (!me || !targetActor) return;
  const h = hostId();
  if (!h) return ui.notifications?.warn("Fabula Arcana | A GM needs to be online to referee a duel between players.");
  send(h, "challenge-pvp", { fromActorId: me.id, toActorId: targetActor.id, bestOf, format, privatePick: !!privatePick });
}
export function spectate(sid) {
  // the host checks the duel exists; this client's status list may not have caught up yet
  const s = status.sessions.find((x) => x.sid === sid);
  const h = s?.hostId ?? hostId();
  if (!sid || !h) return;
  send(h, "spectate", {}, sid);
}

// ------------------------------------------------------------------ styles + layers
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${LAYER_ID}, #${ICON_LAYER_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }
#${LAYER_ID} .fa-prox-btn { pointer-events: auto; position: absolute; transform: translate(-50%, -50%) scale(0.75); opacity: 0;
  transition: transform 180ms cubic-bezier(.2,.9,.2,1), opacity 180ms cubic-bezier(.2,.9,.2,1);
  display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 999px;
  background: rgba(20,20,20,0.78); border: 1px solid rgba(255,200,100,0.4); box-shadow: 0 6px 18px rgba(0,0,0,0.35);
  cursor: pointer; user-select: none; font-size: 15px; color: #f3e2b5; }
#${LAYER_ID} .fa-prox-btn.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
#${LAYER_ID} .fa-prox-btn.is-hiding { transform: translate(-50%, -50%) scale(0.75); opacity: 0; transition-duration: ${ANIM_OUT_MS}ms; }
#${LAYER_ID} .fa-prox-btn:hover { transform: translate(-50%, -50%) scale(1.08); background: rgba(40,30,10,0.88); }
#${ICON_LAYER_ID} .fa-duel-icon { position: absolute; transform: translate(-50%, -100%); display: flex; align-items: center; gap: 3px;
  padding: 3px 7px 3px 6px; border-radius: 999px; background: rgba(251,244,220,0.95); border: 2px solid #c9a44a; color: #5a3417;
  font: 700 12px Signika, sans-serif; box-shadow: 0 4px 10px rgba(0,0,0,0.35); animation: faBob 1.6s ease-in-out infinite; }
#${ICON_LAYER_ID} .fa-duel-icon i { color: #b0473a; }
#${ICON_LAYER_ID} .fa-duel-icon.idle { padding: 2px 5px; font-size: 10px; animation: faIdleIn 220ms ease-out both; opacity: .92; }
@keyframes faIdleIn { from { opacity: 0; transform: translate(-50%, calc(-100% + 4px)); } }
@keyframes faBob { 50% { transform: translate(-50%, calc(-100% - 5px)); } }
`;
  document.head.appendChild(s);
}
function layer(id) { injectStyles(); let el = document.getElementById(id); if (!el) { el = document.createElement("div"); el.id = id; document.body.appendChild(el); } return el; }

// ------------------------------------------------------------------ one button kind per token
class ProxButtons {
  constructor({ kind, icon, title, order }) { this.kind = kind; this.icon = icon; this.title = title; this.order = order; this.btns = new Map(); this.desired = new Set(); }
  show(tokenId, run) {
    const rec = this.btns.get(tokenId);
    if (rec) { rec.run = run; if (rec.state === "hiding") { clearTimeout(rec.timer); rec.state = "shown"; rec.el.classList.remove("is-hiding"); rec.el.classList.add("is-visible"); } return; }
    const el = document.createElement("div");
    el.className = "fa-prox-btn"; el.title = this.title; el.innerHTML = `<i class="${this.icon}"></i>`; el.dataset.tokenId = tokenId; el.dataset.kind = this.kind;
    const r = { el, state: "showing", timer: null, run };
    el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); r.run?.(); });
    layer(LAYER_ID).appendChild(el);
    this.btns.set(tokenId, r);
    requestAnimationFrame(() => { if (this.btns.get(tokenId) !== r) return; el.classList.add("is-visible"); r.state = "shown"; });
  }
  hide(tokenId) {
    const rec = this.btns.get(tokenId); if (!rec || rec.state === "hiding") return;
    rec.state = "hiding"; rec.el.classList.add("is-hiding"); rec.el.classList.remove("is-visible");
    rec.timer = setTimeout(() => { if (this.desired.has(tokenId)) return; rec.el.remove(); this.btns.delete(tokenId); }, ANIM_OUT_MS + 20);
  }
  apply(map) {   // map: tokenId -> run
    this.desired = new Set(map.keys());
    for (const [id, run] of map) this.show(id, run);
    for (const id of [...this.btns.keys()]) if (!map.has(id)) this.hide(id);
  }
  place() {
    const wt = canvas?.app?.stage?.worldTransform; if (!wt) return;
    for (const [id, rec] of this.btns) { const tok = canvas.tokens?.get(id); if (!tok) continue; const c = centerOf(tok);
      rec.el.style.left = `${c.x * wt.a + wt.tx + 44}px`; rec.el.style.top = `${c.y * wt.d + wt.ty - 56}px`; }
  }
  provider() { return window.oni?.Interact?.tokenButtons?.(this.btns, { label: this.title, icon: this.icon, order: this.order, run: (tokenId) => this.btns.get(tokenId)?.run?.() }); }
}

const duelBtn = new ProxButtons({ kind: "npc", icon: "fas fa-diamond", title: "Card Duel", order: 34 });
const pvpBtn = new ProxButtons({ kind: "pvp", icon: "fas fa-chess-board", title: "Challenge to Fabula Arcana", order: 35 });
const watchBtn = new ProxButtons({ kind: "watch", icon: "fas fa-eye", title: "Watch the duel", order: 36 });

// ------------------------------------------------------------------ scanning
const pos = new Map();   // live walking positions
function near(a, b) {
  const I = window.oni?.Interact;
  const ac = centerOf(a, pos.get(a.id)), bc = centerOf(b, pos.get(b.id));
  return I?.npcInRange ? I.npcInRange(a, ac, I.rectOf(b, bc), b) : Math.hypot(ac.x - bc.x, ac.y - bc.y) <= 140;
}
// FF9's card-player mark is seen from across the street, not only at the NPC's feet (there the Card Duel button takes over)
const IDLE_MARK_GRID = 8;
function inSight(a, b) {
  const ac = centerOf(a, pos.get(a.id)), bc = centerOf(b, pos.get(b.id));
  return Math.hypot(ac.x - bc.x, ac.y - bc.y) <= IDLE_MARK_GRID * (canvas?.grid?.size || 100);
}
let queued = false;
function queue() { if (queued) return; queued = true; requestAnimationFrame(() => requestAnimationFrame(async () => { queued = false; await scan(); })); }

async function scan() {
  try {
    if (!canvas?.ready) return;
    const now = Date.now(); for (const [id, o] of pos) if (now - o.ts > 800) pos.delete(id);
    const tokens = (canvas.tokens?.placeables ?? []).filter((t) => t?.actor && !hidden(t));
    const party = await partyMemberIds();
    const camp = isCampScene(canvas.scene);
    const mine = camp && !game.user.isGM ? [cameraRuntime()?.getFollowToken?.()].filter((t) => t?.actor) : tokens.filter((t) => party.has(t.actor.id));
    const busy = !!myDuel();
    const unlocked = faUnlocked();
    const npcMap = new Map(), pvpMap = new Map(), watchMap = new Map(), markMap = new Map();

    // NPC duelists (in reach: the Card Duel button; within sight: the card-player mark)
    if (!busy && unlocked) {
      const can = await canChallengeNpc();
      for (const t of tokens) {
        const cfg = duelistOf(t.actor); if (!cfg || !storyOpen(cfg)) continue;
        if (activeDuelOf(t.actor.id)) continue;
        if (can && mine.some((m) => m.id !== t.id && near(m, t))) npcMap.set(t.id, () => challengeNpc(t));
        else if (mine.some((m) => m.id !== t.id && inSight(m, t))) markMap.set(t.id, true);
      }
    }
    // Camp: another player's character
    if (camp && !busy && unlocked && !game.user.isGM) {
      const me = mine[0];
      for (const t of tokens) {
        if (!me || t.id === me.id || !party.has(t.actor.id) || t.actor.isOwner) continue;
        const ownerOnline = game.users.some((u) => !u.isGM && u.active && u.id !== game.user.id && t.actor.testUserPermission(u, "OWNER"));
        if (!ownerOnline || activeDuelOf(t.actor.id)) continue;
        if (near(me, t)) pvpMap.set(t.id, () => openChallenge(t.actor));
      }
    }
    // Watch: duelists (and the NPC they challenged) for anyone not playing
    if (!busy) {
      for (const s of status.sessions) {
        for (const t of tokens) {
          const hit = s.actorIds.includes(t.actor.id) || (s.npcTokenUuid && t.document?.uuid === s.npcTokenUuid);
          if (!hit) continue;
          if (game.user.isGM || mine.some((m) => m.id !== t.id && near(m, t))) watchMap.set(t.id, () => spectate(s.sid));
        }
      }
    }
    duelBtn.apply(npcMap); pvpBtn.apply(pvpMap); watchBtn.apply(watchMap);
    place();
    icons(tokens, markMap);
  } catch (e) { console.error(TAG, "scan", e); }
}
function place() { duelBtn.place(); pvpBtn.place(); watchBtn.place(); placeIcons(); }

// ------------------------------------------------------------------ overhead icons (every client)
// "duel": a bobbing pair of cards over anyone dueling right now.
// "idle": FF9's card-player mark: a small still card over an NPC duelist within sight of the party (8 grid squares).
//         It gives way to the Card Duel button once the party stands at the NPC's feet.
const iconEls = new Map();   // tokenId -> el (el.dataset.kind)
function icons(tokens, idleMap = new Map()) {
  const want = new Map();
  for (const id of idleMap.keys()) want.set(id, "idle");
  for (const s of status.sessions) for (const t of tokens) {
    if (s.actorIds.includes(t.actor.id) || (s.npcTokenUuid && t.document?.uuid === s.npcTokenUuid)) want.set(t.id, "duel");
  }
  for (const [id, kind] of want) {
    const had = iconEls.get(id);
    if (had && had.dataset.kind === kind) continue;
    had?.remove();
    const el = document.createElement("div"); el.dataset.kind = kind;
    if (kind === "duel") { el.className = "fa-duel-icon"; el.title = "Playing Fabula Arcana"; el.innerHTML = `<i class="fas fa-diamond"></i><i class="fas fa-diamond" style="color:#3c6e9f"></i>`; }
    else { el.className = "fa-duel-icon idle"; el.title = "Plays Fabula Arcana"; el.innerHTML = `<i class="fas fa-diamond"></i>`; }
    layer(ICON_LAYER_ID).appendChild(el); iconEls.set(id, el);
  }
  for (const [id, el] of iconEls) if (!want.has(id)) { el.remove(); iconEls.delete(id); }
}
function placeIcons() {
  const wt = canvas?.app?.stage?.worldTransform; if (!wt) return;
  for (const [id, el] of iconEls) {
    const tok = canvas.tokens?.get(id); if (!tok) continue;
    const c = centerOf(tok, pos.get(id));
    el.style.left = `${c.x * wt.a + wt.tx}px`; el.style.top = `${(c.y - tok.h * 0.55) * wt.d + wt.ty}px`;
  }
}

// ------------------------------------------------------------------ GM: make an NPC a duelist
export async function setDuelist(actorOrUuid, cfg = {}) {
  if (!game.user?.isGM) throw new Error(`${TAG} GM only.`);
  const actor = typeof actorOrUuid === "string" ? await fromUuid(actorOrUuid) : actorOrUuid;
  if (!actor || actor.documentName !== "Actor") throw new Error(`${TAG} actor not found.`);
  if (cfg === false || cfg?.on === false) return actor.update({ [`flags.${MODULE_ID}.-=${FLAG_DUELIST}`]: null });
  const clean = {
    teams: Array.isArray(cfg.teams) ? cfg.teams : cfg.team ? [cfg.team] : [],
    diff: cfg.diff === "skilled" ? "skilled" : "casual", style: cfg.style ?? null,
    bestOf: [1, 3, 5].includes(Number(cfg.bestOf)) ? Number(cfg.bestOf) : 1,
    quote: String(cfg.quote ?? ""), prize: cfg.prize ?? null, requiresSwitch: String(cfg.requiresSwitch ?? ""),
    // the duel's dialogue (2026-11-25): Not now · NPC won · player won · greeting once the party has beaten them
    declineQuote: String(cfg.declineQuote ?? ""), npcWinQuote: String(cfg.npcWinQuote ?? ""),
    playerWinQuote: String(cfg.playerWinQuote ?? ""), rematchQuote: String(cfg.rematchQuote ?? ""),
  };
  return actor.update({ [`flags.${MODULE_ID}.${FLAG_DUELIST}`]: clean });
}

// ------------------------------------------------------------------ install
let installed = false;
export function installEntry() {
  if (installed) return; installed = true;
  for (const [id, b] of [["faDuel", duelBtn], ["faChallenge", pvpBtn], ["faWatch", watchBtn]]) { const p = b.provider(); if (p) window.oni?.Interact?.register?.(id, p); }
  Hooks.on("updateToken", (doc, ch) => { const moved = "x" in ch || "y" in ch; if (!moved && !("hidden" in ch)) return; if (moved) pos.set(doc.id, { x: ch.x ?? doc.x, y: ch.y ?? doc.y, ts: Date.now() }); queue(); });
  Hooks.on("createToken", queue); Hooks.on("deleteToken", queue);
  Hooks.on("updateActor", (a, ch) => { if (gp(ch, `flags.${MODULE_ID}`, null)) queue(); });
  Hooks.on("canvasReady", () => { _canCache.at = 0; queue(); });
  Hooks.on("canvasPan", place);
  Hooks.on("fabulaArcanaStatus", queue);
  Hooks.on("fabulaArcanaWindow", queue);
  window.addEventListener("resize", place);
  const tick = () => { if (iconEls.size) placeIcons(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(queue, 2000);   // the Main Controller can change hands without anyone moving
  queue();
}
