// ============================================================================
// Feedback layer — FU.Feedback
//
// One place that turns API results into what players see, so a new feature
// gets the same feedback without code of its own (the "weak spot" fix, user
// 2026-11-14). The APIs report here when their caller asks for it
// (feedback: "show"); silent callers stay silent.
//
//   FU.Feedback.status([{ actorId, actorName, status, kind }])
//       kind: "inflict" | "held" | "buff" | "immune" | "removed"
//       → batched System Message lines on every screen (feedback-rules.js)
//         + ONE sound per batch: battle's generic debuff / buff beat
//   FU.Feedback.damage([{ actor, resource, before, after, affinity }],
//                      { label, element, kind: "damage" | "heal" })
//       → one element-coloured screen flash + one sound + one Resource Panel
//         on every screen, per batch
//   FU.Feedback.items([{ receiverId, receiverName, kind: "obtain" | "lose",
//                        itemUuid, itemName, img, qty, zenit }], { chatCard })
//       → batched "Zarg obtained Moonstone!" lines (item names hoverable) +
//         ONE obtain chime; chatCard: true also posts the house "Obtain" chat
//         card (world CSS .oni-obtain-card) once per batch. The Party Bag (the
//         database actor) reads "The party".
//   FU.Feedback.flash(key)          this client only (the socket calls it)
//   await FU.Feedback.group(async () => { …several API calls… })
//       everything reported inside is ONE batch, however long the writes take
//       (an Apply with three statuses = one line, not three)
//
// Results that keep arriving less than BATCH_MS apart are one batch (closed at
// BATCH_MAX_MS at the latest): a party-wide Apply makes one set of lines, one
// flash, one sound — never one per member or per status.
// Runs on the calling client and broadcasts from there.
// ============================================================================

import { BATCH_MS, BATCH_MAX_MS, statusLines, statusSound, itemLines, ITEM_SFX, damageSound, flashKey, affinityTag } from "./feedback-rules.js";
import { ELEMENT_COLORS } from "../battle-director/damage-numbers/damage-number-style.js";
import { SFX as BATTLE_SFX, sfxUrl } from "../battle-director/action-anim-rules.js";

const NS = "fabula-ultima-companion";
const SOCKET = `module.${NS}`;
const MSG_FLASH = "FU_FEEDBACK_FLASH_V1";
const TAG = "[FU Feedback]";

// The game's element palette (bolt is PURPLE); recovery soft green, MP blue.
const FLASH_COLORS = { ...ELEMENT_COLORS, heal: "#7be38e", mpLoss: "#4f6fd8", mpGain: "#7fa3ff" };
const FLASH_PEAK = 0.32;
const FLASH_IN_MS = 90;
const FLASH_HOLD_MS = 110;
const FLASH_OUT_MS = 420;

// A batch that closes BATCH_MS after its last result (BATCH_MAX_MS cap) —
// or, inside group(), when the group ends.
let groupDepth = 0;
function makeBatch(onFlush) {
  const b = { items: [], first: Date.now(), timer: null };
  b.touch = () => {
    clearTimeout(b.timer);
    if (groupDepth > 0) return;
    const wait = Math.max(0, Math.min(BATCH_MS, b.first + BATCH_MAX_MS - Date.now()));
    b.timer = setTimeout(() => onFlush(b), wait);
  };
  return b;
}

// Every client hears it (AudioHelper push = true).
function playAll(src, volume = 0.8) {
  if (!src) return;
  try {
    const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play?.({ src, volume, autoplay: true, loop: false }, true);
  } catch (e) { console.warn(TAG, "sound failed", e); }
}

async function partyIds() {
  try {
    const p = await globalThis.CampSystem?.Party?.resolve?.();
    return (p ?? []).map((e) => e?.actor?.id).filter(Boolean);
  } catch { return []; }
}

// ── status ──────────────────────────────────────────────────────────────
let statusBatch = null;
function status(entries = []) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return;
  statusBatch ??= makeBatch(flushStatus);
  statusBatch.items.push(...list);
  statusBatch.touch();
}
async function flushStatus(batch) {
  if (statusBatch === batch) statusBatch = null;
  if (!batch?.items.length) return;
  try {
    const lines = statusLines(batch.items, await partyIds());
    if (lines.length) globalThis.FU?.SystemMessage?.broadcast?.(lines);
    const key = statusSound(batch.items.map((e) => e.kind));
    if (key) playAll(sfxUrl(key), BATTLE_SFX[key]?.vol ?? 0.35);
  } catch (e) { console.warn(TAG, "status lines failed", e); }
}

// ── items ───────────────────────────────────────────────────────────────
let itemBatch = null;
const ZENIT_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";
function items(entries = [], opts = {}) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return;
  itemBatch ??= makeBatch(flushItems);
  itemBatch.items.push(...list);
  if (opts.chatCard) itemBatch.chatCard = true;
  if (opts.sound === false) itemBatch.noSound = true;   // the caller plays its own (a chest's fanfare)
  itemBatch.touch();
}
async function partyBagId() {
  try { return (await globalThis.FUCompanion?.api?.getCurrentGameDb?.())?.db?.id ?? null; } catch { return null; }
}
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// The house "Obtain" chat card, one row per item (styled by the world's custom CSS).
function itemCardHtml(list) {
  const rows = list.map((e) => {
    const who = e.party ? "The party" : (e.receiverName ?? "");
    const verb = e.kind === "lose" ? "handed over" : "obtained";
    const zenit = Math.floor(Number(e.zenit) || 0);
    const what = zenit > 0
      ? `<span class="oni-obtain-name">${zenit}</span> Zenit`
      : `${(e.qty ?? 1) > 1 ? `${e.qty} ` : ""}${e.itemUuid
          ? `<a class="content-link" data-uuid="${escHtml(e.itemUuid)}"><span class="oni-obtain-name">${escHtml(e.itemName)}</span></a>`
          : `<span class="oni-obtain-name">${escHtml(e.itemName)}</span>`}`;
    const img = e.img ?? (zenit > 0 ? ZENIT_ICON : null);
    return `<div class="oni-obtain-row">${img ? `<img class="oni-obtain-icon" src="${escHtml(img)}" alt="">` : ""}`
      + `<div class="oni-obtain-text">${escHtml(who)} ${verb} ${what}${e.kind === "lose" ? "." : "!"}</div></div>`;
  });
  return `<div class="oni-obtain-card">${rows.join("")}</div>`;
}
async function flushItems(batch) {
  if (itemBatch === batch) itemBatch = null;
  if (!batch?.items.length) return;
  try {
    const bag = await partyBagId();
    const list = batch.items.map((e) => ({ ...e, party: e.party ?? (!!bag && e.receiverId === bag) }));
    const lines = itemLines(list);
    if (lines.length) globalThis.FU?.SystemMessage?.broadcast?.(lines);
    if (!batch.noSound && list.some((e) => e.kind !== "lose")) playAll(ITEM_SFX, 0.9);
    if (batch.chatCard) {
      await ChatMessage.create({
        user: game.user.id, speaker: null, type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        content: itemCardHtml(list), flags: { core: { cssClass: "oni-obtain-msg" } },
      });
    }
  } catch (e) { console.warn(TAG, "item feedback failed", e); }
}

// ── damage ──────────────────────────────────────────────────────────────
const damageBatches = new Map();   // key → batch { items: rows, opts }
function damage(rows = [], opts = {}) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r?.actor);
  if (!list.length) return;
  const kind = opts.kind === "heal" ? "heal" : "damage";
  const resource = list[0]?.resource === "mp" ? "mp" : "hp";
  const key = `${opts.label ?? ""}|${kind}|${resource}|${opts.element ?? ""}`;
  if (!damageBatches.has(key)) {
    const b = makeBatch((done) => flushDamage(key, done));
    b.opts = { ...opts, kind, resource };
    damageBatches.set(key, b);
  }
  const b = damageBatches.get(key);
  b.items.push(...list);
  b.touch();
}
function flushDamage(key, batch) {
  if (damageBatches.get(key) === batch) damageBatches.delete(key);
  if (!batch?.items.length) return;
  const rows = batch.items, opts = batch.opts;
  try {
    const fk = flashKey(opts);
    try { game.socket?.emit(SOCKET, { type: MSG_FLASH, key: fk }); } catch (e) {}
    flash(fk);
    playAll(damageSound({ kind: opts.kind, resource: opts.resource, affinities: rows.map((r) => r.affinity) }));
    globalThis.FU?.ResourcePanel?.broadcast?.({
      label: opts.label ?? "",
      rows: rows.map((r) => ({
        actor: r.actor, resource: r.resource === "mp" ? "mp" : "hp", before: r.before, after: r.after,
        tags: [opts.resource === "hp" && opts.kind === "damage" ? affinityTag(r.affinity) : null].filter(Boolean),
      })),
    });
  } catch (e) { console.warn(TAG, "damage feedback failed", e); }
}

async function group(fn) {
  groupDepth++;
  try { return await fn(); }
  finally {
    groupDepth = Math.max(0, groupDepth - 1);
    if (!groupDepth) { statusBatch?.touch(); itemBatch?.touch(); for (const b of damageBatches.values()) b.touch(); }
  }
}

// ── screen flash (this client) ──────────────────────────────────────────
function flash(key) {
  try {
    const c = FLASH_COLORS[String(key ?? "").toLowerCase()] ?? FLASH_COLORS[key] ?? "#ffffff";
    const d = document.createElement("div");
    d.className = "fu-feedback-flash";
    // Under the System Message box and Resource Panel (z 90), over the canvas.
    d.style.cssText = `position:fixed;inset:0;z-index:89;pointer-events:none;opacity:0;mix-blend-mode:screen;`
      + `background:radial-gradient(ellipse at 50% 45%, ${c}00 30%, ${c} 100%), ${c};transition:opacity ${FLASH_IN_MS}ms ease-out;`;
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      d.style.opacity = String(FLASH_PEAK);
      setTimeout(() => {
        d.style.transition = `opacity ${FLASH_OUT_MS}ms ease-in`;
        d.style.opacity = "0";
        setTimeout(() => d.remove(), FLASH_OUT_MS + 40);
      }, FLASH_IN_MS + FLASH_HOLD_MS);
    });
  } catch (e) { console.warn(TAG, "flash failed", e); }
}

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, (data) => {
    if (data?.type === MSG_FLASH) flash(data.key);
  });
});

globalThis.FU = globalThis.FU ?? {};
globalThis.FU.Feedback = Object.freeze({ status, damage, items, flash, group });
