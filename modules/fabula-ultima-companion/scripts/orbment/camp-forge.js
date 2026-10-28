// scripts/orbment/camp-forge.js
//
// CAMP FORGE → FIELD ATTUNE (Orbment v3). The camp activity a Merchant /
// Tinkerer / Pilot can pick for a rest:
//   • one piece of the attuner's OWN gear, one attempt, free;
//   • mark any number of its sockets (Goldsmith-hammer mark — no stones here);
//   • every marked socket rolls at once, each with its own HIDDEN DEX + INS
//     check that decides Polished- or Rough-grade odds (orbment-attune "field");
//   • then the activity is over for this rest.
// The rulebook's Repair / Craft basic gear / Salvage options show greyed out and
// locked ("Soon") until they're built.
//
// OPERATOR + SPECTATORS (the camp minigame rule): the attuning player drives the
// window; everyone else sees the same window live, read-only — marks landing,
// the spin, results, stars, sounds, and the attuner's own reactions (their
// sprite takes the Alchemist's place). That shared view IS the party moment, so
// Camp Forge sends no banner.
//
// Flow (the primary GM drives; messages on the module channel):
//   start   GM → all     open the window (operator / spectator)
//   state   op → all     chosen item + marks, mirrored by spectators
//   attune  op → GM      the request (or a skip); GM broadcasts `rolling`,
//   result  GM → all     rolls, then sends the per-slot results
//   proceed op → GM      "Click to Proceed"
//   done    GM → all     close
//   hello   any → GM     a client that (re)loaded mid-activity; the GM replays
//                        start / state / rolling / result to that user only.
// A secondary GM (dual-GM setup) only waits for `done`, so nothing runs twice.

import { readOrbment, itemKindOf } from "./orbment-const.js";
import { resolveAugment } from "./augment-registry.js";
import { rarityKey } from "./orbment-roll-tables.js";
import { executeAttune, attuneFailText } from "./orbment-attune.js";
import { injectAttuneStyles, burstAtSocket, spriteSrc, spriteHTML } from "./alchemist-window.js";

const TAG = "[Orbment][CampForge]";
const CHANNEL = "module.fabula-ultima-companion";
const P = "orbment:forge:";
const WIN_ID = "fu-campforge-window";
const STYLE_ID = "fu-campforge-style";
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const MARK_IMG = `${ASSET}Skill%20Icon/FFXIVIcons%20Gatherer-Crafter/06_GSM/basic_touch.png`;
const ORB_IMG = { offensive: `${ASSET}Item%20Icon/rorb.png`, defensive: `${ASSET}Item%20Icon/borb.png`, enhancement: `${ASSET}Item%20Icon/yorb.png` };
const PIP = { offensive: "#b8432c", defensive: "#3d5fb0", enhancement: "#d39a1e" };
const EDGE = { jackpot: "#c9a44a", better: "#8db47a", sidegrade: "#cdb98f", worse: "#c4938a", new: "#93afd0" };
const RARITY_COLOR = { common: "#1b1b1b", uncommon: "#1f6fb2", rare: "#b8860b", legendary: "#a3321c" };
const SFX = {
  open:    [`${ASSET}Sound/Shop_Open.wav`, 0.6],
  select:  [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],
  mark:    [`${ASSET}Sound/BattleCursor_1.wav`, 0.6],
  unmark:  [`${ASSET}Sound/cursor_back2.wav`, 0.5],
  spin:    [`${ASSET}Sound/check_start.wav`, 0.55],
  done:    [`${ASSET}Sound/Saint5.ogg`, 0.7],
  jackpot: [`${ASSET}Sound/SE_SYS_Gacha_itemget_SSR.ogg`, 0.5],
};
const KINDS = ["weapon", "armor", "shield"];
const OPTIONS = [
  { key: "attune", name: "Field Attune", tag: "New", icon: ORB_IMG.enhancement,
    desc: "Attune any number of sockets on one piece of your gear, by your own hand. One attempt, free." },
  // Placeholders: greyed out and locked until they're built.
  { key: "repair", name: "Repair", tag: "Soon", soon: true, icon: "icons/svg/shield.svg", desc: "Repair a damaged item." },
  { key: "create", name: "Craft basic gear", tag: "Soon", soon: true, icon: "icons/svg/sword.svg", desc: "Create a basic weapon, armor or shield without paying its cost." },
  { key: "salvage", name: "Salvage", tag: "Soon", soon: true, icon: `${ASSET}Item%20Icon/Crystal.png`, desc: "Destroy equipment to obtain a material of equal value." },
];
// The attuner reacts like the shop Alchemist does, in their own voice.
const LINES = {
  worse: ["…That was supposed to go the other way.", "Okay. Nobody saw that.", "Ugh. My hands slipped."],
  better: ["Nice. That's better.", "There we go!"],
  sidegrade: ["Huh. Different.", "…Sure."],
  jackpot: ["WAIT. I DID THAT?!", "No way. NO WAY!"],
  new: ["There. Not empty anymore."],
};
const IDLE_LINE = "Mark the sockets I want to work on.";
const SPIN_LINE = "Steady… steady…";
const POSE = { jackpot: "fu-aw-wiggle", better: "fu-aw-bob", worse: "fu-aw-slump", new: "fu-aw-nod", sidegrade: "" };
const HAMMER_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ffd27a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9"/><path d="M17.6 6.4 14 10l-2-2 3.6-3.6a1.4 1.4 0 0 1 2 0 1.4 1.4 0 0 1 0 2z"/><path d="M20 4 18 6"/></svg>`;
const EYE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd27a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const MIN_SPIN_MS = 1900;
const WAIT_MS = 10 * 60 * 1000;

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const emit = (kind, payload) => { try { game.socket.emit(CHANNEL, { type: P + kind, payload }); } catch (e) { console.warn(TAG, "emit", e); } };
function sfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}
// The actor's ACTIVE player owner (non-GM, OWNER level). null → the GM operates
// (solo play, or the player is offline — never leave the camp stuck waiting).
// Never actor.testUserPermission here: a GM always passes it.
function ownerUserIdOf(actor) {
  return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
    const u = game.users?.get(id);
    return id !== "default" && lvl === 3 && u && !u.isGM && u.active;
  })?.[0] ?? null;
}
// The hidden grade never leaves the GM: results go out without it.
const publicResult = (res) => (res?.ok ? { ...res, results: res.results.map(({ grade, ...r }) => r) } : res);

// ── GM side ──────────────────────────────────────────────────────────────────
const _waiters = new Map();     // `${kind}:${opId}` → resolve
function waitFor(kind, opId, ms) {
  return new Promise((resolve) => {
    const key = `${kind}:${opId}`;
    const t = setTimeout(() => { if (_waiters.delete(key)) resolve(null); }, ms);
    _waiters.set(key, (v) => { clearTimeout(t); _waiters.delete(key); resolve(v); });
  });
}
const resolveWaiter = (kind, opId, value) => _waiters.get(`${kind}:${opId}`)?.(value ?? true);
const _doneWaiters = new Map(); // actorId → resolve (secondary GM)
function waitForDone(actorId) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { _doneWaiters.delete(actorId); resolve(); }, 2 * WAIT_MS + 60000);
    _doneWaiters.set(actorId, () => { clearTimeout(t); _doneWaiters.delete(actorId); resolve(); });
  });
}
// The activity in progress, kept by the primary GM so a reloaded client can rejoin.
let _live = null;               // { start, state, phase: "pick"|"rolling"|"done", result }

// Run the activity for one actor (activity-camp-forge.js → api.orbment.campForge).
export async function runCampForge(actor) {
  if (!actor) return;
  if (!isPrimaryGM()) return waitForDone(actor.id);
  const opId = foundry.utils.randomID();
  const start = { opId, actorId: actor.id, actorName: actor.name, ownerUserId: ownerUserIdOf(actor) };
  _live = { start, state: null, phase: "pick", result: null };
  try {
    emit("start", start);
    CampForgeWindow.open(start);

    const req = await waitFor("attune", opId, WAIT_MS);
    if (req?.itemUuid && Array.isArray(req.slots) && req.slots.length) {
      _live.phase = "rolling";
      emit("rolling", { opId });
      CampForgeWindow.rolling({ opId });
      const [res] = await Promise.all([
        executeAttune({ itemUuid: req.itemUuid, slots: req.slots.map((i) => ({ index: Number(i) })), mode: "field", requesterUserId: start.ownerUserId ?? game.user.id }),
        wait(MIN_SPIN_MS),
      ]);
      const pub = publicResult(res);
      _live.phase = "done";
      _live.result = pub;
      emit("result", { opId, result: pub });
      CampForgeWindow.result({ opId, result: pub });
      await waitFor("proceed", opId, WAIT_MS);
    }
  } catch (e) {
    console.error(TAG, "Camp Forge failed", e);
  } finally {
    _live = null;
    emit("done", { opId, actorId: actor.id });
    CampForgeWindow.close(opId);
  }
}

// Replay the live activity to one (re)joining user.
function replayTo(userId) {
  if (!_live || !userId) return;
  const { start, state, phase, result } = _live;
  const to = { toUserId: userId };
  emit("start", { ...start, ...to });
  if (state) emit("state", { ...state, ...to, restore: true });
  if (phase === "rolling") emit("rolling", { opId: start.opId, ...to });
  if (phase === "done") emit("result", { opId: start.opId, result, ...to });
}

// ── Socket ───────────────────────────────────────────────────────────────────
function onSocket(msg) {
  const type = String(msg?.type ?? "");
  if (!type.startsWith(P)) return;
  const kind = type.slice(P.length);
  const p = msg.payload ?? {};
  if (p.toUserId && p.toUserId !== game.user?.id) return;
  try {
    switch (kind) {
      case "start":   CampForgeWindow.open(p); break;
      case "state":
        if (isPrimaryGM() && _live?.start.opId === p.opId && !p.restore) _live.state = p;
        CampForgeWindow.applyState(p);
        break;
      case "rolling": CampForgeWindow.rolling(p); break;
      case "result":  CampForgeWindow.result(p); break;
      case "done":    CampForgeWindow.close(p.opId); _doneWaiters.get(p.actorId)?.(); break;
      case "attune":  if (isPrimaryGM()) resolveWaiter("attune", p.opId, p); break;
      case "proceed": if (isPrimaryGM()) resolveWaiter("proceed", p.opId, true); break;
      case "hello":   if (isPrimaryGM()) replayTo(p.userId); break;
    }
  } catch (e) { console.warn(TAG, kind, e); }
}

let _installed = false;
export function installCampForgeSocket() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
  // A client that loads mid-activity asks to be caught up (no-op otherwise).
  if (!game.user?.isGM) emit("hello", { userId: game.user?.id });
}

// ── The window (operator / spectator) ───────────────────────────────────────
class CampForgeWindow {
  static _cur = null;

  static open(start) {
    if (!start?.opId) return;
    if (this._cur?.op.opId === start.opId) return;
    this._cur?.destroy(true);
    this._cur = new CampForgeWindow(start);
    this._cur.build();
  }
  static applyState(p) { if (this._cur?.op.opId === p.opId) this._cur.mirror(p); }
  static rolling(p) { if (this._cur?.op.opId === p.opId && this._cur.phase === "pick") this._cur.toRolling(); }
  static result(p) { if (this._cur?.op.opId === p.opId && this._cur.phase !== "done") this._cur.toResult(p.result); }
  static close(opId) {
    if (!this._cur || (opId && this._cur.op.opId !== opId)) return;
    this._cur.destroy();
    this._cur = null;
  }

  constructor(start) {
    this.op = start;
    this.actor = game.actors?.get(start.actorId) ?? null;
    // Operator = the actor's player owner; with no active player owner, the GM.
    this.isOperator = start.ownerUserId ? game.user?.id === start.ownerUserId : !!game.user?.isGM && isPrimaryGM();
    this.itemId = this.gear()[0]?.id ?? null;
    this.marks = new Map();       // itemId → [bool per socket]
    this.phase = "pick";           // pick | rolling | done
    this.sent = false;             // operator already submitted / proceeded
    this.results = null;
    this.lead = null;
    this.failText = null;
    this.line = IDLE_LINE;
  }

  // All of the attuner's weapons, armor and shields (accessories take no Orbments).
  gear() {
    const items = this.actor?.items?.contents ?? [];
    return KINDS.flatMap((k) => items.filter((i) => itemKindOf(i) === k));
  }
  item() { return this.itemId ? this.actor?.items?.get(this.itemId) ?? null : null; }
  marksFor(item) {
    const n = readOrbment(item).slots.length;
    const arr = (this.marks.get(item.id) ?? []).slice(0, n);
    while (arr.length < n) arr.push(false);
    return arr;
  }
  markCount() { const it = this.item(); return it ? this.marksFor(it).filter(Boolean).length : 0; }
  sprite() { return spriteSrc(this.actor); }

  build() {
    injectAttuneStyles();
    injectCampForgeStyles();
    const name = esc(this.op.actorName);
    const el = document.createElement("div");
    el.id = WIN_ID;
    el.className = this.isOperator ? "" : "is-spectator";
    el.innerHTML = `
      <div class="fu-cf-panel" role="dialog" aria-label="Camp Forge">
        <div class="fu-cf-titlebar">
          ${HAMMER_SVG}
          <div class="fu-cf-tb-text"><span class="fu-cf-title">Camp Forge</span>
            <span class="fu-cf-sub">${this.isOperator ? `Camp activity · Merchant, Tinkerer, Pilot · ${name}'s pick for this rest` : `${name} is using the Camp Forge · you're watching`}</span></div>
          ${this.isOperator ? "" : `<span class="fu-cf-watch">${EYE_SVG}Watching ${name}</span>`}
        </div>
        <div class="fu-cf-body"><div class="fu-cf-left"></div><div class="fu-cf-main"></div></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.render();
    requestAnimationFrame(() => el.classList.add("is-open"));
    sfx("open");
  }

  render() {
    if (!this.el) return;
    this.actor = game.actors?.get(this.op.actorId) ?? this.actor;
    this.renderLeft(this.el.querySelector(".fu-cf-left"));
    this.renderMain(this.el.querySelector(".fu-cf-main"));
  }

  renderLeft(root) {
    const opts = OPTIONS.map((o) => `
      <button type="button" class="fu-cf-opt${o.key === "attune" ? " is-on" : ""}" ${o.soon ? "disabled" : ""}>
        <span class="fu-cf-opt-ic"><img src="${esc(o.icon)}" alt=""></span>
        <span class="fu-cf-opt-txt"><span class="fu-cf-opt-head"><b>${esc(o.name)}</b><span class="fu-cf-tag${o.soon ? " is-soon" : ""}">${esc(o.tag)}</span></span>
          <span>${esc(o.desc)}</span></span>
      </button>`).join("");
    const lead = this.phase === "done" ? this.lead : null;
    const pose = this.phase === "rolling" ? "fu-aw-sway" : (POSE[lead] ?? "");
    const emote = lead === "jackpot" ? `<span class="fu-aw-bang">!</span><span class="fu-aw-note n1">♪</span><span class="fu-aw-note n2">♫</span><span class="fu-aw-note n3">♪</span>`
      : lead === "better" ? `<span class="fu-aw-note n1 once">♪</span>`
      : lead === "sidegrade" ? `<span class="fu-aw-dots">…</span>`
      : lead === "worse" ? `<span class="fu-aw-gloom g1"></span><span class="fu-aw-gloom g2"></span><span class="fu-aw-gloom g3"></span>`
      : lead === "new" ? `<span class="fu-aw-twinkle">✦</span>` : "";
    const line = this.phase === "rolling" ? SPIN_LINE : this.line;
    root.innerHTML = `
      <span class="fu-aw-label">Choose one</span>
      ${opts}
      <div class="fu-aw-grow"></div>
      <div class="fu-aw-npc">
        <span class="fu-aw-npc-fig">${spriteHTML(this.sprite(), `fu-aw-npc-img ${pose}`, this.op.actorName)}<span class="fu-aw-emote" aria-hidden="true">${emote}</span></span>
        <p class="fu-aw-line${lead === "jackpot" ? " is-jack" : ""}">“${esc(line)}”</p>
      </div>`;
  }

  renderMain(root) {
    const op = this.isOperator;
    const name = esc(this.op.actorName);
    const picking = this.phase === "pick";
    const gear = this.gear();
    const item = this.item();
    const tiles = gear.map((it) => {
      const pips = readOrbment(it).slots.map((s) => {
        const cat = s ? resolveAugment(s.id, s.param, s.value)?.category : null;
        return `<span class="fu-aw-pip" style="${cat ? `background:${PIP[cat] ?? "#888"}` : "background:#2b1d10;box-shadow:inset 0 0 0 1px #b5a07a"}"></span>`;
      }).join("");
      const locked = (!op || !picking) && it.id !== this.itemId;
      return `<button type="button" class="fu-aw-tile${it.id === this.itemId ? " is-on" : ""}" data-item="${it.id}" ${locked ? "disabled" : ""}
        data-tooltip="${esc(it.name)}" aria-label="${esc(it.name)}"><img src="${esc(it.img)}" alt=""><span class="fu-aw-pips">${pips}</span></button>`;
    }).join("");

    let panel = "", lower = "";
    if (item) {
      const orb = readOrbment(item);
      const marks = this.marksFor(item);
      const n = marks.filter(Boolean).length;
      const rk = rarityKey(item.system?.props?.item_rarity);
      // After the roll, sockets show the result itself — never a stale item that
      // hasn't caught up with the GM's write yet.
      const rolled = new Map((this.phase === "done" ? this.results ?? [] : []).map((r) => [r.index, r.now]));
      const socks = orb.slots.map((s, i) => {
        const v = rolled.has(i) ? rolled.get(i) : s ? resolveAugment(s.id, s.param, s.value) : null;
        const marked = marks[i] && this.phase !== "done";
        const cls = ["fu-aw-sock", marked ? "has-mark" : "", this.phase === "rolling" && marks[i] ? "is-spin" : ""].filter(Boolean).join(" ");
        return `<div class="fu-aw-sock-wrap" data-i="${i}">
          <button type="button" class="${cls}" data-i="${i}" ${op && picking ? "" : "disabled"} data-tooltip="${esc(v ? `${v.label}: ${v.summary}` : "Empty slot")}"
            aria-label="Slot ${i + 1}: ${esc(v?.label ?? "empty")}${marked ? ", marked to attune" : ""}">
            ${v ? `<img class="fu-aw-orb" src="${ORB_IMG[v.category] ?? ORB_IMG.enhancement}" alt="">` : ""}
            ${marked ? `<span class="fu-aw-badge"><img src="${MARK_IMG}" alt="Marked to attune"></span>` : ""}
          </button>
          <span class="fu-aw-cap">${esc(v?.label ?? "Empty")}</span>
        </div>`;
      }).join("");
      panel = `
        <div class="fu-cf-item">
          <div class="fu-cf-item-name">
            <b style="color:${RARITY_COLOR[rk]}">${esc(item.name)}</b>
            <span>${esc(rk[0].toUpperCase() + rk.slice(1))} · ${orb.slots.length} slot${orb.slots.length === 1 ? "" : "s"}</span>
            <span class="fu-cf-count">${rolled.size ? `${rolled.size} socket${rolled.size > 1 ? "s" : ""} attuned`
              : n ? `${n} socket${n > 1 ? "s" : ""} marked · Free` : "No sockets marked"}</span>
          </div>
          <div class="fu-aw-socks">${socks}</div>
        </div>`;
    }
    if (this.phase === "rolling") lower = `<div class="fu-aw-rolling">${name} works the stones by the fire…</div>`;
    else if (this.phase === "done" && this.results?.length) {
      lower = `<div class="fu-aw-results">${this.results.map((r, k) => `
        <div class="fu-aw-res${r.verdict === "jackpot" ? " is-jack" : ""}" tabindex="0" style="border-color:${EDGE[r.verdict] ?? EDGE.sidegrade};animation-delay:${k * 120}ms"
          data-tooltip="${esc(r.now ? `${r.now.label}: ${r.now.summary}` : "")}" aria-label="Slot ${r.index + 1}: ${esc(r.now?.label ?? "")}. ${esc(r.now?.summary ?? "")}">
          <span class="fu-aw-res-head">Slot ${r.index + 1}</span>
          <span class="fu-aw-old">${esc(r.was?.label ?? "Empty slot")}</span><span class="fu-aw-arrow" aria-hidden="true">→</span>
          ${r.now ? `<img src="${ORB_IMG[r.now.category] ?? ORB_IMG.enhancement}" alt="">` : ""}<b>${esc(r.now?.label ?? "")}</b>
        </div>`).join("")}</div>`;
    } else if (this.phase === "done") lower = `<div class="fu-aw-warn">${esc(this.failText ?? `${this.op.actorName} left the forge without attuning.`)}</div>`;
    else if (!gear.length) lower = `<div class="fu-aw-hint">${name} has no weapon, armor or shield to attune.</div>`;
    else lower = `<div class="fu-aw-hint">${op ? "Click a socket to mark it for attuning, click again to unmark it." : `Everyone at camp sees this window as ${name} works. Only they can touch it.`}</div>`;

    const n = this.markCount();
    let button = "", skip = "";
    if (picking && op && gear.length) {
      button = `<button type="button" class="fu-aw-attune fu-cf-go" ${n && !this.sent ? "" : "disabled"}>Attune ${n ? `${n} ` : ""}${n === 1 ? "slot" : "slots"} · Free</button>`;
      skip = `<button type="button" class="fu-cf-skip" ${this.sent ? "disabled" : ""}>Leave without attuning</button>`;
    } else if (picking && op) button = `<button type="button" class="fu-aw-attune fu-cf-skip-main" ${this.sent ? "disabled" : ""}>Click to Proceed</button>`;
    else if (picking) button = `<button type="button" class="fu-aw-attune" disabled>${name} is choosing…</button>`;
    else if (this.phase === "rolling") button = `<button type="button" class="fu-aw-attune" disabled>Attuning…</button>`;
    else if (op) button = `<button type="button" class="fu-aw-attune fu-cf-proceed" ${this.sent ? "disabled" : ""}>Click to Proceed</button>`;
    else button = `<button type="button" class="fu-aw-attune" disabled>Camp Forge done for this rest</button>`;

    root.innerHTML = `
      <div class="fu-cf-head"><b>Field Attune</b><span>One piece of your own gear, one attempt, free. Mark as many of its sockets as you like and attune them all at once by your own hand. That ends the activity for this rest.</span></div>
      ${gear.length ? `<div class="fu-cf-tiles">${tiles}</div>` : ""}
      ${panel}
      ${lower}
      <div class="fu-aw-grow"></div>
      ${button}${skip}`;

    if (!op) return;
    root.querySelectorAll(".fu-aw-tile").forEach((b) => b.addEventListener("click", () => {
      if (!picking || this.sent || b.dataset.item === this.itemId) return;
      this.itemId = b.dataset.item;
      sfx("select"); this.sync(); this.render();
    }));
    root.querySelectorAll(".fu-aw-sock").forEach((b) => b.addEventListener("click", () => {
      const it = this.item();
      if (!picking || this.sent || !it) return;
      const arr = this.marksFor(it);
      const i = Number(b.dataset.i);
      arr[i] = !arr[i];
      this.marks.set(it.id, arr);
      sfx(arr[i] ? "mark" : "unmark");
      this.sync(); this.render();
    }));
    root.querySelector(".fu-cf-go")?.addEventListener("click", () => this.submit());
    root.querySelectorAll(".fu-cf-skip, .fu-cf-skip-main").forEach((b) => b.addEventListener("click", () => this.submit(true)));
    root.querySelector(".fu-cf-proceed")?.addEventListener("click", () => {
      if (this.sent) return;
      this.sent = true;
      if (isPrimaryGM()) resolveWaiter("proceed", this.op.opId, true);
      else emit("proceed", { opId: this.op.opId });
      this.render();
    });
  }

  // Operator → everyone: what's chosen and marked right now.
  sync() {
    const it = this.item();
    const state = { opId: this.op.opId, itemId: this.itemId, marks: it ? this.marksFor(it) : [] };
    if (isPrimaryGM() && _live?.start.opId === state.opId) _live.state = state;   // a GM operator's own emit never echoes back
    emit("state", state);
  }

  // Spectators mirror the operator, with the same little sounds. A reloaded
  // operator gets its own last state back (`restore`).
  mirror(p) {
    if (this.isOperator && !p.restore) return;
    const before = this.markCount();
    if (p.itemId && this.actor?.items?.get(p.itemId)) this.itemId = p.itemId;
    const it = this.item();
    if (it) this.marks.set(it.id, Array.isArray(p.marks) ? p.marks.map(Boolean) : []);
    if (!p.restore) {
      const after = this.markCount();
      sfx(after > before ? "mark" : after < before ? "unmark" : "select");
    }
    this.render();
  }

  // Attune the marked sockets (or, with `skip`, leave the forge untouched).
  submit(skip = false) {
    if (this.phase !== "pick" || this.sent) return;
    const it = this.item();
    const slots = it && !skip ? this.marksFor(it).map((m, i) => (m ? i : -1)).filter((i) => i >= 0) : [];
    if (!skip && !slots.length) return;
    this.sent = true;
    const req = skip ? { opId: this.op.opId, skip: true } : { opId: this.op.opId, itemUuid: it.uuid, slots };
    if (isPrimaryGM()) resolveWaiter("attune", this.op.opId, req);
    else emit("attune", req);
    if (skip) sfx("unmark");
    this.render();
  }

  toRolling() {
    this.phase = "rolling";
    sfx("spin");
    this.render();
  }

  toResult(res) {
    this.phase = "done";
    this.sent = false;
    if (!res?.ok) {
      this.failText = attuneFailText(res);
      this.line = "…Huh. That didn't work.";
      this.render();
      return;
    }
    this.itemId = this.actor?.items?.find((i) => i.uuid === res.itemUuid)?.id ?? this.itemId;
    this.results = res.results;
    this.lead = res.lead;
    // Same line on every screen: seed the pick with the operation id.
    const pool = LINES[res.lead] ?? LINES.sidegrade;
    const seed = [...String(this.op.opId)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    this.line = pool[seed % pool.length];
    this.render();
    sfx(res.lead === "jackpot" ? "jackpot" : "done");
    for (const r of res.results) {
      const wrap = this.el?.querySelector(`.fu-aw-sock-wrap[data-i="${r.index}"]`);
      if (wrap) burstAtSocket(wrap, r.verdict === "jackpot", res.lead === "jackpot");
    }
  }

  destroy(instant = false) {
    const el = this.el;
    this.el = null;
    if (!el) return;
    if (instant) { el.remove(); return; }
    el.classList.remove("is-open");
    setTimeout(() => el.remove(), 280);
  }
}

function injectCampForgeStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${WIN_ID} { position: fixed; inset: 0; z-index: 9998; display: grid; place-items: center; background: rgba(12,8,4,.45); opacity: 0; transition: opacity .28s ease; }
#${WIN_ID}.is-open { opacity: 1; }
#${WIN_ID} img { border: none !important; box-shadow: none; background: transparent; }
.fu-cf-panel { width: min(1080px, 96vw); height: min(720px, 92vh); display: flex; flex-direction: column; overflow: hidden; transform: translateY(18px);
  transition: transform .28s cubic-bezier(.2,.9,.2,1);
  border-radius: 16px; border: 2px solid #c9a44a; box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 22px 64px rgba(0,0,0,.55);
  background: linear-gradient(180deg, #efe3c6, #e4d3ac); color: #3a1e06; font-family: inherit; }
#${WIN_ID}.is-open .fu-cf-panel { transform: none; }
.fu-cf-titlebar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: linear-gradient(180deg, #7a4e20, #5c3818); color: #fff6dd; flex-shrink: 0; }
.fu-cf-tb-text { display: flex; flex-direction: column; line-height: 1.15; flex: 1; }
.fu-cf-title { font-size: 18px; font-weight: 700; }
.fu-cf-sub { font-size: 12px; color: #e9d3a6; }
.fu-cf-watch { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; background: rgba(0,0,0,.28); font-size: 13px; font-weight: 600; }
.fu-cf-body { flex: 1; display: grid; grid-template-columns: 380px minmax(0,1fr); min-height: 0; }
.fu-cf-left { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-right: 1px solid rgba(122,78,32,.25); min-height: 0; }
.fu-cf-opt { font: inherit; text-align: left; display: grid; grid-template-columns: 40px minmax(0,1fr); gap: 12px; align-items: center; padding: 12px 14px; min-height: 72px;
  border-radius: 12px; border: 2px solid #d6c49c; background: #faf6ee; color: #3a1e06; width: 100%; cursor: default; }
.fu-cf-opt.is-on { border-color: #c9a44a; background: #fff8e4; box-shadow: 0 0 0 2px #7a4e20; }
.fu-cf-opt:disabled { opacity: .5; filter: grayscale(1); cursor: not-allowed; background: #ece4d2; }
.fu-cf-opt-ic { width: 40px; height: 40px; border-radius: 10px; background: #2b1d10; display: grid; place-items: center; }
.fu-cf-opt-ic img { width: 30px; height: 30px; object-fit: contain; image-rendering: pixelated; }
.fu-cf-opt-txt { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; line-height: 1.35; color: #6b4a26; }
.fu-cf-opt-head { display: flex; gap: 8px; align-items: center; color: #3a1e06; }
.fu-cf-opt-head b { font-size: 15px; }
.fu-cf-tag { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; background: #2f7a2a; color: #fff8e4; }
.fu-cf-tag.is-soon { background: #8a8178; }
.fu-cf-main { display: flex; flex-direction: column; gap: 14px; padding: 18px 24px; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.fu-cf-head { display: flex; flex-direction: column; gap: 4px; font-size: 14px; line-height: 1.45; }
.fu-cf-head b { font-size: 22px; }
.fu-cf-tiles { display: flex; flex-wrap: wrap; gap: 10px; max-height: 164px; overflow-y: auto; padding: 2px; }
.fu-cf-tiles .fu-aw-tile { width: 72px; height: 72px; aspect-ratio: auto; }
.fu-cf-tiles .fu-aw-tile img { width: 50px; height: 50px; }
.fu-cf-tiles .fu-aw-tile:disabled { cursor: not-allowed; opacity: .5; }
.fu-cf-item { display: flex; align-items: center; gap: 22px; padding: 14px 16px; border-radius: 14px; background: rgba(255,255,255,.5); border: 1px solid rgba(122,78,32,.25); }
.fu-cf-item-name { display: flex; flex-direction: column; gap: 2px; min-width: 170px; font-size: 12.5px; color: #6b4a26; }
.fu-cf-item-name b { font-size: 17px; }
.fu-cf-count { color: #2f7a2a; font-weight: 600; margin-top: 4px; }
#${WIN_ID} .fu-aw-socks { gap: 20px; justify-content: flex-start; }
#${WIN_ID} .fu-aw-cap { font-size: 11.5px; max-width: 110px; text-align: center; line-height: 1.25; }
#${WIN_ID} .fu-aw-sock.has-mark { border-color: #ffb547; box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 0 3px #e9a645, 0 0 16px rgba(255,170,70,.7); }
#${WIN_ID} .fu-aw-sock:disabled { cursor: default; }
#${WIN_ID} .fu-aw-sock:disabled:hover { transform: none; }
#${WIN_ID} .fu-aw-badge img { width: 30px; height: 30px; border-radius: 6px; image-rendering: auto; }
#${WIN_ID} .fu-aw-hint, #${WIN_ID} .fu-aw-rolling { text-align: left; }
#${WIN_ID} .fu-aw-res { flex-direction: row; align-items: center; gap: 10px; flex-wrap: wrap; border-radius: 12px; padding: 10px 14px; cursor: help; }
#${WIN_ID} .fu-aw-res:hover, #${WIN_ID} .fu-aw-res:focus-visible { outline: 2px solid #c9a44a; outline-offset: 1px; }
#${WIN_ID} .fu-aw-res img { width: 26px; height: 26px; image-rendering: pixelated; }
#${WIN_ID} .fu-aw-res b { font-size: 17px; }
#${WIN_ID} .fu-aw-old { font-size: 14px; }
#${WIN_ID}.is-spectator .fu-aw-tile, #${WIN_ID}.is-spectator .fu-aw-sock { cursor: default; }
.fu-cf-skip { font: inherit; width: auto; height: auto; line-height: 1.3; font-size: 12.5px; align-self: center; margin-top: -6px; padding: 4px 12px; border: none; background: transparent; color: #6b4a26;
  text-decoration: underline dotted; text-underline-offset: 3px; cursor: pointer; }
.fu-cf-skip:hover:not(:disabled) { color: #3a1e06; }
.fu-cf-skip:disabled { opacity: .45; cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) { #${WIN_ID} *, #${WIN_ID} { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition: none !important; } }
`;
  document.head.appendChild(s);
}
