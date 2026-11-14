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

import { BATCH_MS, BATCH_MAX_MS, statusLines, statusSound, damageSound, flashKey, affinityTag } from "./feedback-rules.js";
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
    if (!groupDepth) { statusBatch?.touch(); for (const b of damageBatches.values()) b.touch(); }
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
globalThis.FU.Feedback = Object.freeze({ status, damage, flash, group });
