// Reaction hand — the "Card" Reaction UI (Party Menu › Config › Graphic).
//
// With Card chosen, a player's reactions on an action card stop being rows of
// Apply/Skip pills on the card and become a hand of cards standing on top of
// their plate. A card's face is the reaction at a glance — when it applies,
// whom it touches, what it costs, and why it can't be used if it can't; the
// rules text is NOT on the card. Hover singles a card out and flips the plate's
// portrait to that reaction's description (the skill picker's card). Clicking
// a card uses it (it flies onto the action card) — there is no Use button, the
// whole card is the control — and one Pass — the last card of the hand —
// answers every card left. Pass is a toggle:
// pressing it again takes the Skips back while the card is still open.
// Allies' reactions show on THEIR compact cards: the card glows and gets one
// small card per reaction while they decide, then a PASSED / DONE tag.
//
// This is a VIEW over the action card's own reaction pills, not a second
// decision path. The pills stay in the card's DOM (hidden by CSS), they remain
// the single source of truth, and every action here is a click on a pill's own
// control — so targeting, follow-up menus, the GM's ack/revert, the Confirm
// lock and the no-response nets all run exactly as they do for Button mode.
// The one addition the engine needed is "reopen" (taking a Skip back), handled
// in action-card.js next to the existing Apply/Skip intent.
//
// Reactions OUTSIDE an action card (start of conflict / round / turn — the
// standalone windows reaction-menu.js opens for your own character) are dealt
// the same way: reaction-menu.js hands them to mountHandReaction() instead of
// the plate drawer, Use calls the window's onPick and Pass its onPass. There is
// no take-back there — the window closes on the answer.
//
// Use HOLDS the card at once (it lifts, in its place) and the reaction's own
// decision — a target pick, an option menu — opens if it has one. The card
// plays (flies onto the action card) only when the host finalises it; a cancel
// drops it back into the same slot. Other cards stay usable meanwhile.
//
// Pass is for reactions that hold the action up: your own reactions on your own
// action card never gate its Confirm, so its owner gets no Pass. Once nothing
// of yours is left undecided (all used, or the rest can't be used) you count as
// passed and the tag says so.
//
// Player clients only: the GM answers from the Battle Desk and keeps the pills.
// Approved mockup: claude.ai/artifact/UJ2LxcUjvGbayKkZ6cbdrx (page "Card game").

import { getClientOption } from "../shared/client-options.js";
import { plateReactionHost, holdPlateHover } from "./director-player-hud.js";
import { htmlToCardText } from "./drawer-views.js";

const MIRROR_ROOT_ID = "fud-bf-mirror-root";
const STYLE_ID = "fud-rxh-style";
const BODY_CLASS = "fud-rx-hand";
const TAG = "[ReactionHand]";

// Hand geometry, in plate (unscaled) px. The clip box runs from CLIP_TOP above
// the plate to its bottom edge; cards stand on the plate's top edge (tucked
// CARD_TUCK px behind it) so the whole face shows.
const CARD_W = 164;
const CARD_H = 236;
const CARD_TUCK = 10;
const CLIP_TOP = 776;          // clip box top = this many px above the plate's top-left
const CARD_TOP = CLIP_TOP - CARD_H + CARD_TUCK;
const PASS_W = CARD_W;
const HAND_LEFT = 64;          // first card's left edge, clear of the portrait that stands over 0–56
const HAND_RIGHT = 664;        // the Pass slot's right edge may not pass this
const MAX_STEP = CARD_W + 8;
const PASS_GAP = 6;
const PASS_STAGGER_MS = 120;   // Pass sends one Skip per card, spaced so the host takes them in turn
const PLATE_WAIT_MS = 4000;
// Motion. Dealt cards come in from the right with a little overshoot; leaving
// ones fade off to the left quickly, so nothing lingers.
const DEAL_MS = 360, DEAL_STAGGER_MS = 70, LEAVE_MS = 240, GLOW_MS = 520;    // a standalone window waits this long for your plate before the old UI takes it

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));

// Skill descriptions are trusted actor data, but they arrive through an HTML
// attribute; parse them inert and keep only text-level markup.
function cleanDesc(html) {
  const body = new DOMParser().parseFromString(String(html ?? ""), "text/html").body;
  body.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,img,svg,.fud-bf-reaction-tip-foot")
    .forEach((el) => el.remove());
  for (const el of body.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (a.name.startsWith("on") || a.name === "style" || a.name === "href" || a.name === "src") el.removeAttribute(a.name);
  }
  return body.innerHTML;
}

// A reason short enough for the ribbon across a disabled card.
function ribbonText(reason) {
  const t = String(reason ?? "").trim();
  if (!t) return "Can't use";
  const rules = [
    [/no other target/i, "No target"],
    [/no longer deals damage|no damage/i, "No damage"],
    [/no longer targeted/i, "Not targeted"],
    [/target removed/i, "Target gone"],
    [/(?:not enough|low)\s+([a-z]+)/i, (m) => `Low ${m[1].toUpperCase()}`],
    [/conditions not met|no longer applies|can't use this now/i, "Not now"],
    [/already used|per round|per battle|once/i, "Used up"],
  ];
  for (const [re, out] of rules) {
    const m = t.match(re);
    if (m) return typeof out === "function" ? out(m) : out;
  }
  return t.length <= 14 ? t : "Can't use";
}

function actorFromUuid(uuid) {
  if (!uuid) return null;
  try { const d = fromUuidSync(uuid); return d?.actor ?? d ?? null; } catch { return null; }
}

// ── who is active ────────────────────────────────────────────────────────────
function myUnit() {
  const u = document.querySelector(".dhud-plate-root .dhud-unit");
  return u?.isConnected ? u : null;
}
function isActive() {
  if (game.user?.isGM) return false;
  if (getClientOption("reactionUi") !== "card") return false;
  return !!myUnit();
}

// ── reading the card's pills ─────────────────────────────────────────────────
function pillState(p) {
  if (p.classList.contains("is-auto")) return "auto";
  if (p.classList.contains("is-gm-set")) return "gm";
  if (p.classList.contains("is-applied")) return "applied";
  if (p.classList.contains("is-skipped")) return "skipped";
  if (p.classList.contains("is-unavailable") || p.dataset.fudReactionMoot === "1") return "off";
  if (p.classList.contains("is-submitting") || p.dataset.fudReactionSubmitting === "1") return "busy";
  if (p.dataset.fudReactionPending === "1") return "live";
  return "off";
}
function readPills(wrapper) {
  const me = game.user?.id ?? "";
  return [...(wrapper?.querySelectorAll(".fud-bf-reaction-pill") ?? [])].map((p) => ({
    el: p,
    key: `${p.dataset.fudReactionKey ?? ""}:${p.dataset.fudReactionCarrier ?? ""}`,
    rowKey: p.dataset.fudReactionKey ?? "",
    carrierUuid: p.dataset.fudReactionCarrier ?? "",
    owner: p.dataset.fudReactionOwner ?? "",
    mine: (p.dataset.fudReactionOwner ?? "") === me,
    // Third-party reactions hold the action's Confirm; the action-taker's own do not.
    gating: p.dataset.fudReactionGating === "1",
    reactorUuid: p.dataset.fudReactorUuid ?? "",
    name: p.querySelector(".fud-bf-reaction-name")?.textContent?.trim() || "Reaction",
    icon: p.querySelector("img.fud-bf-reaction-icon")?.getAttribute("src") ?? "",
    desc: p.dataset.fudEquipDesc ?? "",
    // A pill the host marked moot (GM removed its target, or the re-gate found it
    // no longer applies after another reaction) carries its reason in the chip.
    reason: p.querySelector(".fud-bf-reaction-reason")?.textContent?.trim()
      || (p.dataset.fudReactionMoot === "1"
        ? (p.querySelector('[data-fud-reaction-moot-chip="1"]')?.textContent?.trim() || "No longer applies")
        : ""),
    state: pillState(p),
  })).filter((r) => r.state !== "auto");
}

// ── the hand on your plate ───────────────────────────────────────────────────
const hand = {
  clip: null,         // .rxh-clip inside the plate unit
  pass: null,         // the Pass slot
  tag: null,          // your own PASSED tag
  cards: new Map(),   // key → { el, state, order, gating, held }
  described: null,    // the card whose description the plate's card is showing
  lastPill: new Map(),// key → last pill record seen (to act on it after it left the DOM)
};

function ensureHand(unit) {
  if (hand.clip?.isConnected && hand.clip.parentElement === unit) return;
  hand.clip?.remove();
  hand.cards.clear();
  hand.clip = document.createElement("div");
  hand.clip.className = "rxh-clip";
  // Pass is the last card of the hand, dressed like the others: name band, art
  // (a skip mark), a line saying what it does, and its button.
  hand.pass = document.createElement("div");
  hand.pass.className = "rxh-pass is-hidden";
  hand.pass.setAttribute("role", "button");
  hand.pass.tabIndex = 0;
  hand.pass.innerHTML = `<div class="rxh-face">
      <div class="rxh-name"><span class="nm">Pass</span><span class="hk">P</span></div>
      <div class="rxh-art rxh-part">${PASS_ICON}</div>
      <div class="rxh-type">Answer the rest</div>
      <div class="rxh-info"><div class="rxh-row"><span class="v ps"></span></div></div>
    </div>`;
  hand.pass.addEventListener("click", (ev) => { ev.stopPropagation(); togglePass(); });
  hand.clip.appendChild(hand.pass);
  unit.prepend(hand.clip);
  hand.tag = document.createElement("span");
  hand.tag.className = "rxh-mytag";
  hand.tag.innerHTML = `${CHECK}Passed`;
  unit.appendChild(hand.tag);
}

const PASS_ICON = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 5 7 7-7 7"></path><path d="m12 5 7 7-7 7"></path></svg>';
const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>';

function cardHtml(r, portrait) {
  return `<div class="rxh-face">
      <div class="rxh-name"><span class="nm">${esc(r.name)}</span></div>
      <div class="rxh-art">${portrait ? `<img class="bg" src="${esc(portrait)}" alt="">` : ""}${r.icon ? `<span class="emb"><img src="${esc(r.icon)}" alt=""></span>` : ""}</div>
      <div class="rxh-type">${esc(r.type || "Reaction")}</div>
      <div class="rxh-info">
        <div class="rxh-row is-when"><span class="k">When</span><span class="v">…</span></div>
        <div class="rxh-row is-target"><span class="k">Target</span><span class="v"></span></div>
        <div class="rxh-row is-cost"><span class="k">Cost</span><span class="v"></span></div>
        <div class="rxh-why"></div>
      </div>
      <div class="rxh-ribbon"></div>
    </div>`;
}

function makeCard(r) {
  const el = document.createElement("div");
  el.className = "rxh-card";
  el.dataset.key = r.key;
  const reactor = actorFromUuid(r.reactorUuid);
  const portrait = reactor?.img || myUnit()?.querySelector(".dhud-pcard img")?.getAttribute("src") || "";
  el.innerHTML = cardHtml(r, portrait);
  el.setAttribute("role", "button");
  el.addEventListener("click", (ev) => { ev.stopPropagation(); useCard(r.key); });
  el.addEventListener("pointerenter", () => showDescription(r, el));
  el.addEventListener("pointerleave", () => hideDescription(el));
  fillInfo(el, r).catch((e) => console.warn(TAG, "card face info failed", e));
  return el;
}

// ── the card face: when / target / cost, read off the reaction row ─────────
// Display only, and FAILS QUIET: a row the reader can't phrase loses that line,
// it never blocks the card. Everything comes from the carrier on this client
// (your own character's items), so no host round-trip is needed.
const TRIGGER_TEXT = {
  creature_will_deal_damage: { self: "Before your attack deals damage", other: "Before an attack deals damage" },
  creature_performs_action: { self: "When you act", other: "When a creature acts" },
  creature_targeted_by_action: { self: "When you are targeted", other: "When a creature is targeted" },
  creature_hit_by_action: { self: "When you are hit", other: "When a creature is hit" },
  creature_will_take_damage: { self: "Before you take damage", other: "Before a creature takes damage" },
  creature_took_damage: { self: "After you take damage", other: "After a creature takes damage" },
  conflict_start: "At the start of the conflict",
  conflict_end: "At the end of the conflict",
  round_start: "At the start of each round",
  round_end: "At the end of each round",
  turn_start: { self: "At the start of your turn", other: "At the start of a turn" },
  turn_end: { self: "At the end of your turn", other: "At the end of a turn" },
};
const TARGET_TEXT = {
  self: "You",
  action_targets: "The action's target",
  hit_action_targets: "The target it hits",
  trigger_subject: "The creature that set it off",
  action_source: "The acting creature",
  field: "The battlefield",
};
const RES_LABEL = { mp: "MP", hp: "HP", ip: "IP", zp: "ZP", fp: "FP" };

let _condMod = null, _fxMod = null;
const condMod = () => (_condMod ??= import("../skill-forge/condition-builder.js").catch(() => null));
const fxMod = () => (_fxMod ??= import("./skill-effects.js").catch(() => null));

function rowOf(r) {
  if (!r.carrierUuid) return { item: null, row: null };
  let item = null;
  try { item = fromUuidSync(r.carrierUuid); } catch {}
  const row = item?.system?.props?.reaction_config_table?.[r.rowKey] ?? null;
  return { item, row };
}

async function whenText(row) {
  const trig = String(row?.reaction_trigger ?? "").trim();
  const t = TRIGGER_TEXT[trig];
  const src = String(row?.reaction_source ?? "").trim().toLowerCase();
  let when = typeof t === "string" ? t : t ? (src === "self" || !src ? t.self : t.other) : "";
  const kind = String(row?.reaction_action_kind ?? "").trim();
  if (kind && /act$/.test(when)) when = `${when} (${kind})`;
  const formula = String(row?.condition_formula ?? "").trim();
  if (formula) {
    const m = await condMod();
    const model = m?.parse?.(formula);
    const said = model ? m.explain(model) : "";
    if (said && said !== "(always)") when = when ? `${when}, if ${lower1(said)}` : `If ${lower1(said)}`;
  }
  return when;
}
const lower1 = (t) => String(t).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()).replace(/  AND  /g, " and ").replace(/  OR  /g, " or ");

function targetText(item, row) {
  const table = item?.system?.props?.effect_table ?? {};
  const byLabel = new Map(Object.values(table).filter((x) => x && !x.$deleted).map((x) => [String(x.effect_label ?? "").trim(), x]));
  const seen = new Set();
  const walk = (label) => {
    const x = byLabel.get(label);
    if (!x || seen.has(label)) return null;
    seen.add(label);
    const ref = String(x.target_ref ?? "").trim();
    if (ref && String(x.effect_kind ?? "") !== "chain") return ref;
    const steps = String(x.chain_steps ?? x.menu_option_refs ?? "").split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
    for (const st of steps) { const got = walk(st); if (got) return got; }
    return null;
  };
  const ref = walk(String(row?.reaction_effect_ref ?? "").trim());
  if (ref) return TARGET_TEXT[ref] ?? "";
  const st = String(item?.system?.props?.skill_target ?? "").trim();
  return st && st !== "-" ? st : "";
}

async function costText(item, row, actor) {
  const m = await fxMod();
  if (!m?.analyzeChainCost || !item || !actor) return "";
  const ref = String(row?.reaction_effect_ref ?? "").trim();
  const c = m.analyzeChainCost(item.system?.props?.effect_table ?? {}, ref, actor, item);
  if (!c?.ok) return "";
  const parts = Object.entries(c.debit ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${RES_LABEL[k] ?? k.toUpperCase()}`);
  if (c.variable) return parts.length ? `${parts.join(" + ")} + varies` : "Varies";
  return parts.length ? parts.join(" + ") : "Free";
}

async function fillInfo(el, r) {
  const { item, row } = rowOf(r);
  const actor = actorFromUuid(r.reactorUuid) ?? item?.parent ?? null;
  const set = (cls, text) => {
    const line = el.querySelector(`.rxh-row.${cls}`);
    if (!line) return;
    line.querySelector(".v").textContent = text;
    line.hidden = !text;
  };
  set("is-target", targetText(item, row));
  set("is-when", await whenText(row));
  set("is-cost", await costText(item, row, actor));
}

// ── hover: the description on the plate's card, as the skill picker does ───
// Leaving a card does not flip the plate back at once: the pointer crossing a
// gap, a neighbour stepping aside, or the lift itself fires leave/enter in quick
// pairs, and each pair used to run a full flip out and back — sometimes landing
// on the wrong face. A short grace absorbs those; moving straight to another
// card swaps the description with no portrait in between.
const DESC_GRACE_MS = 70;      // just long enough to bridge card -> neighbour; longer reads as lag
let _descT = null;
function showDescription(r, el) {
  clearTimeout(_descT); _descT = null;
  if (hand.described === el) return;
  const unit = myUnit();
  if (!unit || unit.classList.contains("is-open")) return;   // a picker owns the plate's card
  const host = plateReactionHost(unit.dataset.actorId ?? null);
  if (!host?.setCard) return;
  const cost = el.querySelector(".rxh-row.is-cost .v")?.textContent || "";
  host.setCard({
    key: `rxh|${r.key}`, name: r.name, kind: "Reaction", img: r.icon || null, 
    chips: cost ? [{ text: cost, tone: "tag" }] : [],
    body: htmlToCardText(cleanDesc(r.desc)),
    // The pill as it is NOW (the card was dealt live and may have gone stale since).
    reason: (() => { const cur = hand.lastPill.get(r.key) ?? r; return cur.state === "off" ? (cur.reason || "Can't use this now") : null; })(),
  }, { quiet: true });
  hand.described = el;
}
function hideDescription(el, { now = false } = {}) {
  if (hand.described !== el) return;
  const go = () => {
    _descT = null;
    if (hand.described !== el) return;
    hand.described = null;
    const unit = myUnit();
    if (!unit || unit.classList.contains("is-open")) return;
    plateReactionHost(unit.dataset.actorId ?? null)?.setCard?.(null, { quiet: true });
  };
  clearTimeout(_descT);
  if (now) go(); else _descT = setTimeout(go, DESC_GRACE_MS);
}

function layoutHand() {
  // Pill order, not the order cards were (re)dealt: a cancelled card keeps its slot.
  const inHand = [...hand.cards.values()].filter((c) => !c.leaving).sort((a, b) => a.order - b.order);
  const n = inHand.length;
  const step = n > 1 ? Math.min(MAX_STEP, (HAND_RIGHT - HAND_LEFT - CARD_W - PASS_GAP - PASS_W) / (n - 1)) : 0;
  inHand.forEach((c, i) => { c.el.style.left = `${HAND_LEFT + i * step}px`; });
  const last = n ? HAND_LEFT + (n - 1) * step : HAND_LEFT - CARD_W - PASS_GAP;
  hand.pass.style.left = `${last + CARD_W + PASS_GAP}px`;
}

function syncHand(pills, wrapper) {
  const unit = myUnit();
  if (!unit) return;
  ensureHand(unit);
  const mine = pills.filter((r) => r.mine);
  const seen = new Set();
  let dealt = 0;
  // Gating cards (the ones Pass answers) this window has shown, used or not —
  // so "all of them used" can read as passed after the used ones flew away.
  const gatingSeen = mine.some((r) => r.gating || isStandaloneKey(r.key));
  mine.forEach((r, order) => {
    seen.add(r.key);
    hand.lastPill.set(r.key, r);
    let c = hand.cards.get(r.key);
    if (r.state === "gm") { if (c) leave(c); return; }
    if (r.state === "applied") { if (c) { leave(c); glowActionCard(wrapper); } return; }
    if (!c) {
      const el = makeCard(r);
      el.style.setProperty("--d", `${dealt++ * DEAL_STAGGER_MS}ms`);
      el.classList.add("is-dealt");
      // In pill order, so the later card overlaps the earlier one as before.
      const next = [...hand.cards.values()].filter((x) => !x.leaving && x.order > order).sort((a, b) => a.order - b.order)[0];
      hand.clip.insertBefore(el, next?.el ?? hand.pass);
      c = { el, state: null, leaving: false, held: false };
      hand.cards.set(r.key, c);
    }
    c.order = order;
    c.gating = !!r.gating || isStandaloneKey(r.key);
    // Undecided again while held = the decision was cancelled or the host
    // turned it down: back into its slot, still live.
    if (c.held && r.state === "live" && !isStandaloneKey(r.key)) { c.held = false; c.el.classList.remove("is-held"); }
    if (c.state !== r.state) {
      c.el.classList.remove("is-live", "is-busy", "is-off", "is-skipped");
      c.el.classList.add(`is-${r.state}`);
      // The reason IS the ribbon, in a word or two; the full sentence is on the
      // plate's description when the card is hovered.
      c.el.querySelector(".rxh-why").textContent = "";
      c.state = r.state;
    }
    // Kept current even when the state stays "off": the reason can change (a
    // re-gate after the next decision).
    const rib = c.el.querySelector(".rxh-ribbon");
    const ribText = r.state === "off" ? ribbonText(r.reason) : "";
    if (rib.textContent !== ribText) rib.textContent = ribText;
    c.reason = r.reason;
  });
  // A pill that left the card (card closed / re-posted without it): fold it
  // away — or, the one card just played from a standalone window, play it.
  for (const [key, c] of hand.cards) {
    if (seen.has(key)) continue;
    leave(c);
  }
  // Cards dealt this pass slide in under a pointer that may be resting there.
  if (dealt) holdPlateHover();

  const cards = [...hand.cards.values()].filter((c) => !c.leaving);
  const gating = cards.filter((c) => c.gating);
  const live = gating.filter((c) => c.state === "live" && !c.held).length;
  const busy = gating.filter((c) => c.state === "busy" || c.held).length;
  const skipped = gating.filter((c) => c.state === "skipped").length;
  // Nothing of yours left to answer on this card. Skips you made can be taken
  // back; cards you used (or that can't be used) leave you passed for good.
  const settled = gatingSeen && live === 0 && busy === 0;
  if (settled) for (const c of cards) if (c.state === "off") leave(c);
  hand.pass.classList.toggle("is-hidden", live + skipped === 0);
  hand.pass.classList.toggle("is-on", settled && skipped > 0);
  hand.pass.disabled = false;
  const passedNow = settled && skipped > 0;
  hand.pass.querySelector(".rxh-name .nm").textContent = passedNow ? "Passed" : "Pass";
  hand.pass.querySelector(".ps").textContent = passedNow
    ? "You passed on the rest. Click to take it back while the card is open."
    : `Skip ${live === 1 ? "the reaction" : `all ${live} reactions`} still open here.`;
  hand.pass.setAttribute("aria-label", settled && skipped > 0 ? "Passed. Click to take it back" : "Pass on every reaction left");
  hand.tag.classList.toggle("is-on", settled);
  unit.classList.toggle("rxh-has-hand", cards.length > 0);
  layoutHand();
}

// A card leaving the hand — played, passed over, or its card closed — fades off
// to the left (rxhLeave). Playing one adds nothing else: the action card takes
// a short gold glow (glowActionCard), as if it received the power.
function leave(c) {
  if (c.leaving) return;
  c.leaving = true;
  hideDescription(c.el, { now: true });
  const key = c.el.dataset.key;
  c.el.classList.add("is-leaving");
  setTimeout(() => { c.el.remove(); if (hand.cards.get(key) === c) hand.cards.delete(key); }, LEAVE_MS);
  layoutHand();
  holdPlateHover();   // the rest of the hand closes up under a resting pointer
}

function glowActionCard(wrapper) {
  const card = (wrapper ?? document.getElementById(MIRROR_ROOT_ID))?.querySelector(".fud-bf-card");
  if (!card) return;
  const base = getComputedStyle(card).boxShadow;
  const keep = base && base !== "none" ? `${base}, ` : "";
  const lit = `${keep}0 0 0 3px rgba(226,194,126,.95), 0 0 30px 8px rgba(226,194,126,.75)`;
  const rest = `${keep}0 0 0 3px rgba(226,194,126,0), 0 0 30px 8px rgba(226,194,126,0)`;
  try { card._rxhGlow?.cancel(); } catch {}
  card._rxhGlow = card.animate([{ boxShadow: rest }, { boxShadow: lit, offset: 0.2 }, { boxShadow: rest }],
    { duration: GLOW_MS, easing: "ease-out" });
}

// ── acting through the pills ─────────────────────────────────────────────────
function pillFor(key) {
  const w = document.getElementById(MIRROR_ROOT_ID);
  if (!w) return null;
  return [...w.querySelectorAll(".fud-bf-reaction-pill")]
    .find((p) => `${p.dataset.fudReactionKey ?? ""}:${p.dataset.fudReactionCarrier ?? ""}` === key) ?? null;
}
function clickPill(pill, action) {
  const btn = pill?.querySelector(`[data-fud-reaction-action="${action}"]`);
  if (btn) { btn.click(); return true; }
  return false;
}

function useCard(key) {
  const c = hand.cards.get(key);
  if (!c || c.leaving || c.held || c.state !== "live") return;
  if (isStandaloneKey(key)) {
    const sa = _standalone;
    const cand = sa?.byKey.get(key);
    if (!sa || sa.done || !cand) return;
    sa.done = true;   // one answer per window; the rest of the hand folds away
    hold(c);
    try { sa.onPick?.(cand); } catch (e) { console.warn(TAG, "standalone onPick threw", e); }
    schedule();
    return;
  }
  if (!clickPill(pillFor(key), "apply")) return;
  // Held, not played: its decision (if any) opens now, and the card leaves
  // (and the action card glows) only when the host finalises it.
  hold(c);
  schedule();
}

function hold(c) {
  c.held = true;
  c.el.classList.add("is-held");
}

function togglePass() {
  if (hand.pass?.disabled) return;
  const cards = [...hand.cards.entries()].filter(([, c]) => !c.leaving);
  const live = cards.filter(([, c]) => c.state === "live");
  const answerable = live.filter(([, c]) => c.gating && !c.held);
  if (answerable.length) {
    const sa = _standalone;
    if (sa && !sa.done && typeof sa.onPass === "function" && answerable.some(([key]) => isStandaloneKey(key))) {
      sa.done = true;
      try { sa.onPass?.(); } catch (e) { console.warn(TAG, "standalone onPass threw", e); }
    }
    answerable.filter(([key]) => !isStandaloneKey(key))
      .forEach(([key], i) => setTimeout(() => { clickPill(pillFor(key), "skip"); schedule(); }, i * PASS_STAGGER_MS));
    schedule();
    return;
  }
  // Take it back: one "reopen" per skipped card. The card has no visible
  // control for it; the mirror's delegated handler reads the action off a
  // momentary element inside the pill.
  for (const [key, c] of cards) {
    if (c.state !== "skipped") continue;
    const pill = pillFor(key);
    if (!pill) continue;
    const b = document.createElement("span");
    b.dataset.fudReactionAction = "reopen";
    b.hidden = true;
    pill.appendChild(b);
    b.click();
    b.remove();
  }
}

function onKey(ev) {
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key !== "p" && ev.key !== "P") return;
  const t = ev.target;
  if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? "")) return;
  if (!hand.pass || hand.pass.classList.contains("is-hidden") || !isActive()) return;
  if (myUnit()?.classList.contains("is-open")) return;   // a picker has the drawer
  ev.preventDefault();
  togglePass();
}

// ── standalone windows (outside an action card) ─────────────────────────────
// One window at a time per client: the reaction-menu instance for your own
// character. Records use the pill-record shape so syncHand deals them the same.
let _standalone = null;   // { records, byKey, onPick, onPass, done, targetRect }
const SA_PREFIX = "sa:";
const isStandaloneKey = (key) => String(key).startsWith(SA_PREFIX);

/**
 * Deal a standalone reaction window into the hand. Returns a ReactionMenu
 * record ({ root, cleanup, updateDisabledLabels }), or null when Card mode is
 * not on for this client — the caller then opens the plate drawer as before.
 * Auto ("on") candidates are not dealt: they happen without a choice.
 *
 * The Start of Conflict window opens before the battle HUD has built your
 * plate. The window is held for the plate (PLATE_WAIT_MS); if no plate turns
 * up, `fallback()` opens the old UI and the record forwards to it.
 */
export function mountHandReaction({ candidates, onPick, onPass, label = "Reaction", disabledLabels = null, token = null, fallback = null } = {}) {
  if (game.user?.isGM || getClientOption("reactionUi") !== "card") return null;
  if (!myUnit() && typeof fallback !== "function") return null;
  const reactorUuid = token?.actor?.uuid ?? "";
  const live = (candidates ?? []).filter((c) => c && c.mode !== "on");
  if (!live.length) return null;
  const sa = { records: [], byKey: new Map(), onPick, onPass, done: false };
  const build = (disabled) => {
    const reasons = new Map(Object.entries(disabled ?? {}));
    sa.byKey.clear();
    sa.records = live.map((c) => {
      const key = `${SA_PREFIX}${c.carrierUuid ?? ""}::${c.rowKey ?? ""}`;
      sa.byKey.set(key, c);
      const why = reasons.get(`${c.carrierUuid}::${c.rowKey}`) ?? null;
      return {
        key, rowKey: c.rowKey ?? "", carrierUuid: c.carrierUuid ?? "",
        owner: game.user?.id ?? "", mine: true, reactorUuid,
        name: c.carrierName ?? "Reaction", icon: c.carrierImg ?? "", desc: c.carrierDescription ?? "",
        type: `Reaction · ${label}`, reason: why ? String(why) : "", state: why ? "off" : "live",
      };
    });
  };
  build(disabledLabels);
  _standalone = sa;
  let fb = null;   // the old UI, when the plate never came
  if (!myUnit()) {
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (_standalone !== sa) { clearInterval(wait); return; }
      if (myUnit()) { clearInterval(wait); schedule(); return; }
      if (Date.now() - t0 < PLATE_WAIT_MS) return;
      clearInterval(wait);
      _standalone = null;
      console.warn(TAG, `no plate after ${PLATE_WAIT_MS} ms — "${label}" opens in the old UI`);
      try { fb = fallback() ?? null; } catch (e) { console.warn(TAG, "fallback threw", e); }
    }, 150);
  }
  schedule();
  return {
    root: null,
    cleanup() {
      if (fb) { try { fb.cleanup?.(); } catch {} return; }
      if (_standalone === sa) _standalone = null;
      schedule();
    },
    updateDisabledLabels(next) {
      if (fb) { fb.updateDisabledLabels?.(next); return; }
      build(next);
      schedule();
    },
  };
}

function standaloneRecords() {
  const sa = _standalone;
  if (!sa || sa.done) return [];
  return sa.records;
}

// ── allies: glow, small cards, Passed / Done ─────────────────────────────────
const allies = new Map();   // actorId → { minis: Map(key → el), had: bool, applied: bool }

function allyCardFor(actorId) {
  return actorId ? document.querySelector(`.dhud-root .dhud-card[data-actor-id="${CSS.escape(actorId)}"]`) : null;
}

function syncAllies(pills, wrapper) {
  const byActor = new Map();
  for (const r of pills) {
    if (r.mine || !r.reactorUuid || r.state === "off") continue;
    const id = actorFromUuid(r.reactorUuid)?.id;
    if (!id) continue;
    if (!byActor.has(id)) byActor.set(id, []);
    byActor.get(id).push(r);
  }
  for (const id of new Set([...allies.keys(), ...byActor.keys()])) {
    const card = allyCardFor(id);
    const rs = byActor.get(id) ?? [];
    let a = allies.get(id);
    if (!a) { a = { minis: new Map() }; allies.set(id, a); }
    if (!card) continue;
    let box = card.querySelector(":scope > .rxh-minis");
    if (!box) {
      box = document.createElement("div");
      box.className = "rxh-minis";
      card.appendChild(box);
      a.minis.clear();
    }
    let tag = card.querySelector(":scope > .rxh-tag");
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "rxh-tag";
      card.appendChild(tag);
    }
    const pending = rs.filter((r) => r.state === "live" || r.state === "busy");
    const applied = rs.some((r) => r.state === "applied");
    const seen = new Set();
    let dealt = 0;
    for (const r of pending) {
      seen.add(r.key);
      if (a.minis.has(r.key)) continue;
      const m = document.createElement("span");
      m.className = "rxh-mini is-dealt";
      m.style.setProperty("--d", `${120 + dealt++ * DEAL_STAGGER_MS}ms`);
      if (r.icon) m.innerHTML = `<img src="${esc(r.icon)}" alt="">`;
      box.appendChild(m);
      a.minis.set(r.key, m);
    }
    for (const [key, m] of a.minis) {
      if (seen.has(key)) continue;
      a.minis.delete(key);
      const r = rs.find((x) => x.key === key);
      if (r?.state === "applied") glowActionCard(wrapper);
      m.classList.add("is-leaving");
      setTimeout(() => m.remove(), LEAVE_MS);
    }
    [...a.minis.values()].forEach((m, i) => { m.style.left = `${i * 25}px`; m.style.setProperty("--r", i % 2 ? "6deg" : "-6deg"); });
    const deciding = pending.length > 0;
    const answered = rs.length > 0 && !deciding;
    card.classList.toggle("rxh-deciding", deciding);
    tag.innerHTML = `${CHECK}${applied ? "Done" : "Passed"}`;
    tag.classList.toggle("is-on", answered);
  }
}

function clearAllies() {
  for (const [id, a] of allies) {
    const card = allyCardFor(id);
    card?.classList.remove("rxh-deciding");
    card?.querySelector(":scope > .rxh-tag")?.classList.remove("is-on");
    for (const m of a.minis.values()) { m.classList.add("is-leaving"); setTimeout(() => m.remove(), LEAVE_MS); }
  }
  allies.clear();
}

// ── the loop ─────────────────────────────────────────────────────────────────
let _queued = false;
let _wrapperObs = null;
let _observed = null;
let _closeT = null;

function schedule() {
  if (_queued) return;
  _queued = true;
  requestAnimationFrame(() => { _queued = false; sync(); });
}

function observeWrapper(w) {
  if (_observed === w) return;
  _wrapperObs?.disconnect();
  _observed = w;
  if (!w) return;
  _wrapperObs = new MutationObserver(schedule);
  _wrapperObs.observe(w, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "data-fud-reaction-pending", "data-fud-reaction-submitting", "data-fud-reaction-moot"],
  });
}

function sync() {
  const active = isActive();
  document.body.classList.toggle(BODY_CLASS, active);
  const w = document.getElementById(MIRROR_ROOT_ID);
  observeWrapper(w);
  if (!active) { teardown(); return; }
  const sa = standaloneRecords();
  if (!w) {
    if (_standalone) {
      clearTimeout(_closeT); _closeT = null;
      try { syncHand(sa, null); } catch (e) { console.warn(TAG, "hand sync failed", e); }
      return;
    }
    // The card closed (or is being re-posted): give a re-post a moment to land
    // so the same reactions are not dealt twice, then fold the hand away.
    if (!_closeT) _closeT = setTimeout(() => { _closeT = null; if (!document.getElementById(MIRROR_ROOT_ID)) { syncHand(standaloneRecords(), null); clearAllies(); } }, 400);
    return;
  }
  clearTimeout(_closeT); _closeT = null;
  // The card holds itself back until the plate has settled (plateSettled); the
  // hand waits with it, so both arrive together after the drawer has folded.
  // The wrapper observer re-runs this when the card's root gains is-visible.
  const cardRoot = w.querySelector("#fud-battlefield-card-root");
  if (cardRoot && !cardRoot.classList.contains("is-visible")) return;
  const pills = readPills(w);
  try { syncHand([...pills, ...sa], w); } catch (e) { console.warn(TAG, "hand sync failed", e); }
  try { syncAllies(pills, w); } catch (e) { console.warn(TAG, "ally sync failed", e); }
}

function teardown() {
  if (hand.clip) {
    hand.clip.remove();
    hand.tag?.remove();
    hand.clip = hand.pass = hand.tag = null;
    hand.cards.clear();
    document.querySelector(".dhud-plate-root .dhud-unit")?.classList.remove("rxh-has-hand");
  }
  clearAllies();
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS_TEXT;
  document.head.appendChild(st);
}

Hooks.once("ready", () => {
  injectStyles();
  // The mirror card is a direct child of <body>; watch only that level.
  new MutationObserver(schedule).observe(document.body, { childList: true });
  Hooks.on("fuClientOptionChanged", ({ key }) => { if (key === "reactionUi") schedule(); });
  window.addEventListener("keydown", onKey);
  // The HUD rebuilds on its own schedule (resize, roster changes); a slow
  // heartbeat re-attaches the hand and ally marks to whatever is current.
  setInterval(() => { if (document.getElementById(MIRROR_ROOT_ID) || hand.clip || _standalone) schedule(); }, 1000);
  schedule();
});

const CSS_TEXT = `
/* Card mode: the action card no longer carries the reaction pills. They stay
   in the DOM (the hand acts through them), just not on screen. */
body.${BODY_CLASS} #${MIRROR_ROOT_ID} .fud-bf-reactions-row { display: none !important; }

/* ── the hand: cards tucked behind the plate, name bands peeking ── */
.rxh-clip {
  position: absolute; left: 0; right: -30px; top: -${CLIP_TOP}px; bottom: 0;
  overflow: hidden; z-index: -1; pointer-events: none;
  transition: opacity 220ms ease, transform 260ms ease;
}
.dhud-unit.is-open .rxh-clip { opacity: 0; transform: translateY(60px); }
/* The plate's card (portrait flipped to a description) draws OVER a centred
   action card rather than either one moving. */
.dhud-plate-root:has(.dhud-pcard.is-skill) { z-index: 96; }
.dhud-unit.is-open .rxh-clip * { pointer-events: none !important; }
.dhud-unit.rxh-has-hand .dhud-take, .dhud-unit.rxh-has-hand .dhud-wait { display: none !important; }
.rxh-card {
  position: absolute; top: ${CARD_TOP}px; width: ${CARD_W}px; height: ${CARD_H}px; box-sizing: border-box; padding: 4px;
  border-radius: 12px; background: #3a3228; border: 2px solid #b7935a; box-shadow: 0 10px 24px rgba(0,0,0,.5);
  transform-origin: bottom center; pointer-events: auto;
  transition: transform 220ms cubic-bezier(.2,.8,.2,1), translate 220ms ease, left 340ms cubic-bezier(.3,.7,.3,1), filter 300ms ease;
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; color: #3a3228;
}
/* A raised card reads in front of the action card (z 95), which it can reach
   at smaller window sizes; the plate goes back under it when the hover ends. */
.dhud-plate-root:has(.rxh-card:hover) { z-index: 96; }
.rxh-card:hover { z-index: 10; transform: translateY(-28px) scale(1.12); box-shadow: 0 0 0 2px #d5b67a, 0 18px 40px rgba(0,0,0,.6); }
/* The raised card keeps its old footprint as hover area: a strip below it
   reaches back down to the plate, so a pointer resting in the gap the lift
   opened doesn't drop the card (and raise it again, back and forth). Local px,
   scaled with the card: 32 x 1.12 > the 28 px lift. */
.rxh-card::after, .rxh-pass::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 0; }
.rxh-card:hover::after, .rxh-pass:hover::after { height: 32px; }
.rxh-card.is-held::after { height: 44px; }
.rxh-card:has(~ .rxh-card:hover) { translate: -22px 0; }
.rxh-card:hover ~ .rxh-card { translate: 22px 0; }
@keyframes rxhDeal {
  from { transform: translateX(64px) scale(.96); opacity: 0; }
  45%  { opacity: 1; }
  70%  { transform: translateX(-7px) scale(1.01); }
  to   { transform: none; opacity: 1; }
}
.rxh-card.is-dealt { animation: rxhDeal ${DEAL_MS}ms cubic-bezier(.2,.9,.3,1) var(--d, 0ms) backwards; }
.rxh-face {
  position: relative; height: 100%; box-sizing: border-box; border-radius: 8px; overflow: hidden;
  display: flex; flex-direction: column; background: linear-gradient(180deg, #fbf6ea, #efe5cf);
}
.rxh-face::after { content: ""; position: absolute; inset: 3px; border: 1px solid rgba(183,147,90,.55); border-radius: 6px; pointer-events: none; }
.rxh-name {
  flex: none; height: 34px; box-sizing: border-box; padding: 0 9px; display: flex; align-items: center;
  background: #3a3228; color: #f6f1e6; border-bottom: 2px solid #b7935a; font: 800 13px/1.15 "Inter", "Signika", sans-serif;
}
.rxh-name .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rxh-card.is-live .rxh-name {
  background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14); border-bottom-color: #e2c27e;
  box-shadow: inset 0 0 0 1px rgba(255,220,180,.35), 0 0 16px 3px rgba(222,66,46,.6);
}
@keyframes rxhGlow { from { box-shadow: 0 0 10px 2px rgba(222,66,46,.5); } to { box-shadow: 0 0 22px 6px rgba(232,72,50,.78); } }
.rxh-card.is-live::before {
  content: ""; position: absolute; left: -2px; right: -2px; top: -2px; height: 40px; border-radius: 12px 12px 4px 4px;
  pointer-events: none; animation: rxhGlow 3.4s ease-in-out infinite alternate;
}
.rxh-art { position: relative; flex: none; height: 52px; background: #d9c9a8; overflow: hidden; border-bottom: 1px solid rgba(122,106,85,.5); }
.rxh-art .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 18%; border: none; }
.rxh-art .emb { position: absolute; left: 7px; bottom: 6px; width: 34px; height: 34px; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 2px #b7935a, 0 2px 6px rgba(0,0,0,.35); }
.rxh-art .emb img { width: 100%; height: 100%; object-fit: cover; display: block; border: none; }
.rxh-type { flex: none; padding: 5px 10px 3px; font: 800 9px "Inter", "Signika", sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #7a6a55; }
.rxh-info { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0 9px 8px; display: flex; flex-direction: column; gap: 6px; }
.rxh-row { display: flex; flex-direction: column; gap: 1px; }
.rxh-row[hidden] { display: none; }
.rxh-row .k { font: 800 8px "Inter", "Signika", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #8a7d68; }
.rxh-row .v { font: 600 10.5px/13px "Inter", "Signika", sans-serif; color: #3a3228;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.rxh-row.is-cost .v { font-weight: 800; }
.rxh-why:empty { display: none; }
.rxh-why { margin-top: auto; font: 700 10px/13px "Inter", "Signika", sans-serif; color: #a3241b; }
.rxh-card.is-live { cursor: pointer; }
.rxh-card:not(.is-live) { cursor: default; }
/* Can't be used (no target, can't pay, no longer applies): say so on hover. */
.rxh-card.is-off, .rxh-card.is-off * { cursor: not-allowed; }
.rxh-card.is-busy { filter: saturate(.7); }
/* Used, waiting on its decision / the host: lifted in its own slot. */
.rxh-card.is-held, .rxh-card.is-held:hover { transform: translateY(-40px); z-index: 5; box-shadow: 0 0 0 2px #e2c27e, 0 0 22px 4px rgba(226,194,126,.75), 0 12px 26px rgba(0,0,0,.5); }
.rxh-card.is-busy .rxh-name::after { content: "…"; margin-left: 4px; }
/* Dim the face, not the ribbon and the reason, which now live inside it (so
   the ribbon is clipped to the card's rounded edge instead of sticking out). */
.rxh-card.is-off .rxh-face > :not(.rxh-ribbon):not(.rxh-info), .rxh-card.is-off .rxh-row { filter: grayscale(.55); opacity: .8; }
.rxh-ribbon { display: none; }
.rxh-card.is-off .rxh-ribbon {
  display: block; position: absolute; left: -20px; top: 58px; width: 196px; transform: rotate(-14deg); text-align: center; padding: 3px 0;
  background: #b3261e; color: #fff3e6; font: 800 12px "Inter", "Signika", sans-serif; letter-spacing: .14em; text-transform: uppercase;
  box-shadow: 0 2px 6px rgba(0,0,0,.35); z-index: 2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rxh-card.is-skipped, .rxh-card.is-skipped:hover { transform: translateY(150px); filter: saturate(.35) brightness(.8); box-shadow: 0 6px 14px rgba(0,0,0,.4); pointer-events: none; }
@keyframes rxhLeave { to { transform: translateX(-40px); opacity: 0; } }
.rxh-card.is-leaving { animation: rxhLeave ${LEAVE_MS}ms cubic-bezier(.4,0,.6,1) forwards; pointer-events: none; }

/* Pass: the last card of the hand */
.rxh-pass {
  position: absolute; top: ${CARD_TOP}px; width: ${PASS_W}px; height: ${CARD_H}px; box-sizing: border-box; padding: 4px; margin: 0;
  border-radius: 12px; background: #3a3228; border: 2px solid #b7935a; box-shadow: 0 10px 24px rgba(0,0,0,.5);
  pointer-events: auto; cursor: pointer; transform-origin: bottom center;
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; color: #3a3228;
  transition: left 340ms cubic-bezier(.3,.7,.3,1), transform 220ms cubic-bezier(.2,.8,.2,1), opacity 200ms ease;
}
.rxh-pass:hover { transform: translateY(-28px) scale(1.12); box-shadow: 0 0 0 2px #d5b67a, 0 18px 40px rgba(0,0,0,.6); z-index: 10; }
.rxh-pass.is-hidden { opacity: 0; pointer-events: none; }
.rxh-pass .rxh-name { justify-content: space-between; gap: 6px; }
.rxh-pass .hk { font: 700 10px "Inter", "Signika", sans-serif; padding: 2px 5px; border-radius: 3px; color: #d5c7a8; background: rgba(255,255,255,.12); }
.rxh-pass .rxh-part { display: grid; place-items: center; color: #7a6a55; background: linear-gradient(180deg, #e6dbc2, #d9c9a8); }
.rxh-pass.is-on .rxh-name { background: linear-gradient(180deg, #c9a45e, #9c7a3c); color: #2e271f; }
.rxh-pass.is-on .rxh-part { color: #9c7a3c; }
.rxh-pass.is-on .rxh-face { filter: saturate(.8); }
.rxh-pass.is-on .hk { display: none; }

/* your own PASSED tag, and the allies' */
.rxh-mytag, .rxh-tag {
  position: absolute; z-index: 6; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 6px; border-radius: 5px;
  background: #3a3228; border: 1.5px solid #b7935a; color: #f6f1e6; font: 800 10px "Inter", "Signika", sans-serif;
  letter-spacing: .12em; text-transform: uppercase; pointer-events: none;
  opacity: 0; transform: scale(1.7); transition: opacity 160ms ease, transform 260ms cubic-bezier(.3,1.6,.5,1);
}
.rxh-mytag { left: 96px; top: -13px; }
.rxh-tag { right: 10px; top: -12px; }
.rxh-mytag.is-on, .rxh-tag.is-on { opacity: 1; transform: none; }

/* allies: glow while deciding, one small card per reaction */
@keyframes rxhAlly {
  from { box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 22px rgba(0,0,0,.42), 0 0 10px 2px rgba(222,66,46,.5); }
  to   { box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 22px rgba(0,0,0,.42), 0 0 26px 8px rgba(232,72,50,.8); }
}
.dhud-card.rxh-deciding { animation: rxhAlly 3.4s ease-in-out infinite alternate; }
.rxh-minis { position: absolute; left: 156px; top: -31px; width: 60px; height: 46px; z-index: -1; pointer-events: none; }
.rxh-mini {
  position: absolute; top: 0; width: 30px; height: 44px; box-sizing: border-box; border-radius: 5px; border: 1.5px solid #e2c27e;
  background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14); box-shadow: 0 2px 6px rgba(0,0,0,.45);
  display: grid; place-items: start center; padding-top: 4px; transform: rotate(var(--r, 0deg)); transition: left 300ms ease;
}
.rxh-mini img { width: 20px; height: 20px; border-radius: 4px; box-shadow: 0 0 0 1px #e2c27e; border: none; }
@keyframes rxhMiniIn { from { transform: translateX(24px) rotate(var(--r, 0deg)); opacity: 0; } to { transform: rotate(var(--r, 0deg)); opacity: 1; } }
.rxh-mini.is-dealt { animation: rxhMiniIn 300ms cubic-bezier(.2,.9,.3,1) var(--d, 0ms) backwards; }
.rxh-mini.is-leaving { animation: rxhLeave ${LEAVE_MS}ms cubic-bezier(.4,0,.6,1) forwards; }

/* in flight, above everything */

/* Reduced motion: nothing moves — cards fade in and out, hover raises at once. */
@media (prefers-reduced-motion: reduce) {
  .rxh-card, .rxh-pass { transition: none; }
  @keyframes rxhFade { from { opacity: 0; } }
  @keyframes rxhOut { to { opacity: 0; } }
  .rxh-card.is-dealt, .rxh-mini.is-dealt { animation: rxhFade 220ms ease var(--d, 0ms) backwards; }
  .rxh-card.is-leaving, .rxh-mini.is-leaving { animation: rxhOut ${LEAVE_MS}ms ease forwards; }
  .rxh-card.is-skipped, .rxh-card.is-skipped:hover, .rxh-card.is-held { transform: none; }
  .rxh-mytag, .rxh-tag { transform: none !important; }
  .dhud-unit.is-open .rxh-clip { transform: none; }
}
`;
