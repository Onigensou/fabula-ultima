// scripts/orbment/alchemist-window.js
//
// The ATTUNEMENT window — what the Alchemist NPC opens (Orbment v3, P4). A custom
// DOM overlay in the refinement window's parchment skin (refineWindow-app.js),
// laid out like the approved mockup:
//
//   left   — the player's OWN weapons / armor / shields (accessories never hold
//            Orbments, so they never show), the Alchemist's portrait, his line
//            and his anime-style expression.
//   centre — the chosen item and its sockets. Socket FIRST, then a stone: click
//            a socket to select it, click a stone to slot it there (selection
//            moves on to the next empty socket); click the selected socket again
//            to take its stone off. Stones can also be dragged onto sockets.
//   right  — the stone tray (Rough / Polished, priced for this item), "What can
//            come out" with hover tooltips, the overwrite warning, and Attune.
//
// Attune sends every stoned socket at once (FUCompanion.api.orbment.attune →
// the primary GM rolls). Results come back per slot with a soft border tint (no
// verdict words), stars burst from each socket (a shower on a Jackpot), and the
// Alchemist reacts to the most notable result — his line + expression are LOCAL
// to this client; the rest of the party gets the announcement banner (P5).

import { readOrbment, slotCountOf, itemKindOf } from "./orbment-const.js";
import { resolveAugment, rollableAugments } from "./augment-registry.js";
import { STONES, TIERS, attunePrice } from "./orbment-roll-tables.js";
import { attuneFailText } from "./orbment-attune.js";

const WIN_ID = "fu-alchemist-window";
const STYLE_ID = "fu-alchemist-window-style";
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";

const SFX = {
  open:    [`${ASSET}Sound/Shop_Open.wav`, 0.6],
  select:  [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],
  slot:    [`${ASSET}Sound/BattleCursor_1.wav`, 0.6],        // stone into a socket
  back:    [`${ASSET}Sound/cursor_back2.wav`, 0.5],          // stone off / close
  spin:    [`${ASSET}Sound/check_start.wav`, 0.55],          // attuning
  done:    [`${ASSET}Sound/Saint5.ogg`, 0.7],                // attunement complete
  jackpot: [`${ASSET}Sound/SE_SYS_Gacha_itemget_SSR.ogg`, 0.5],
};
const ORB_IMG = { offensive: `${ASSET}Item%20Icon/rorb.png`, defensive: `${ASSET}Item%20Icon/borb.png`, enhancement: `${ASSET}Item%20Icon/yorb.png` };
const PIP = { offensive: "#b8432c", defensive: "#3d5fb0", enhancement: "#d39a1e" };
const STONE_IMG = { rough: `${ASSET}Item%20Icon/Elemental%20Stone/1000.png`, polished: `${ASSET}Item%20Icon/Crystal.png` };
const STONE_DESC = {
  rough: "Cheap. Mostly common Orbments, values lean low.",
  polished: "Better odds at rare Orbments and higher values. Same ceiling.",
};
const GP_ICON = `<img class="fu-aw-zicon" src="${ASSET}Item%20Icon/GP.png" alt="Zenit">`;
const CATS = [{ key: "weapon", label: "Weapon" }, { key: "armor", label: "Armor" }, { key: "shield", label: "Shield" }];
const TIER_COLOR = ["#5b4a36", "#1f6fb2", "#b8860b", "#a3321c"];
const EDGE = { jackpot: "#c9a44a", better: "#8db47a", sidegrade: "#cdb98f", worse: "#c4938a", new: "#93afd0" };
const MIN_SPIN_MS = 1900;

// The Alchemist's reaction, by the most notable result. One line drawn at random
// so a long session doesn't repeat the joke. Add lines freely.
//   worse → means well, lands as mockery · better → the standard line ·
//   sidegrade → deadpan · jackpot → completely loses it · new → first fill
const LINES = {
  worse: [
    "Oh! Well. The old one was nicer, wasn't it?",
    "Interesting! I've never seen someone pay to make their gear worse.",
    "Don't worry, nobody will notice. Probably.",
    "The stone chose that. I only hold the tongs.",
    "You can always try again. Your purse can, anyway.",
    "Hm. I would have kept the last one. But you didn't ask me.",
  ],
  better: ["A fine attunement. Wear it well.", "There we are. Better than it was.", "Good stone, good result.", "That'll serve you nicely."],
  sidegrade: ["It's different.", "Mm. That is an Orbment.", "Same, but not.", "Next.", "The stone changed its mind. Not its opinion."],
  jackpot: [
    "WAIT. WAIT. Do you SEE that?! I've waited my WHOLE LIFE for a stone like this!",
    "HAHA! YES! Somebody write this down! SOMEBODY WRITE IT DOWN!",
    "I'm framing the receipt. I am FRAMING it.",
    "Don't move. Don't breathe. Let me look at it AGAIN!",
  ],
  new: ["Your slot's very first Orbment. Treat it kindly.", "There. No longer empty."],
};
const IDLE_LINE = "Pick a socket, then a stone. The stones decide the rest.";
const SPIN_LINE = "Hold still… they're settling.";
// Expression per lead result (CSS classes below).
const POSE = { jackpot: "fu-aw-wiggle", better: "fu-aw-bob", worse: "fu-aw-slump", new: "fu-aw-nod", sidegrade: "" };

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pickLine = (lead) => { const pool = LINES[lead] ?? LINES.sidegrade; return pool[Math.floor(Math.random() * pool.length)]; };

let _instance = null;

// Shared with the Camp Forge window (camp-forge.js): the socket / result /
// star-burst / expression styles, and the burst itself.
export function injectAttuneStyles() { AlchemistWindow.prototype._injectStyles(); }

// An actor's sprite for a portrait panel (also used by Camp Forge / Upgrade).
// Token art can be a wildcard ("…/*", Foundry's random token image), which no
// <img> can load — skip it; a placed token's own art comes first. A video
// battler (.webm) plays muted in a <video>.
const VIDEO_RE = /\.(webm|mp4|m4v|ogv)(\?.*)?$/i;
export function spriteSrc(actor) {
  const ok = (s) => typeof s === "string" && s.length > 0 && !s.includes("*");
  return [actor?.token?.texture?.src, actor?.prototypeToken?.texture?.src, actor?.img].find(ok) ?? "icons/svg/mystery-man.svg";
}
export function spriteHTML(src, cls = "", alt = "") {
  return VIDEO_RE.test(src)
    ? `<video class="${cls}" src="${esc(src)}" autoplay loop muted playsinline aria-label="${esc(alt)}"></video>`
    : `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}">`;
}

// A ring flash + a burst of stars from one socket (`wrap` = .fu-aw-sock-wrap);
// `jack` = this socket hit a Jackpot (bigger, multicolour shower).
export function burstAtSocket(wrap, jack, anyJackpot = jack) {
  const GLYPH = ["✦", "★", "✧", "⋆"];
  const COL = anyJackpot ? ["#ffd36e", "#fff3b0", "#ff9ecb", "#9ad7ff", "#c6a2ff"] : ["#ffd36e", "#fff3b0", "#ffe9a8"];
  const layer = document.createElement("span");
  layer.className = "fu-aw-fx";
  const ring = document.createElement("span");
  ring.className = "fu-aw-ring";
  if (jack) ring.style.borderColor = "#ffd36e";
  layer.appendChild(ring);
  const n = jack ? 34 : 14;
  for (let k = 0; k < n; k++) {
    const s = document.createElement("span");
    s.className = "fu-aw-spark";
    const ang = Math.random() * Math.PI * 2;
    const dist = (jack ? 70 : 45) + Math.random() * (jack ? 140 : 70);
    s.textContent = GLYPH[k % GLYPH.length];
    s.style.cssText = `font-size:${((jack ? 12 : 10) + Math.random() * (jack ? 18 : 10)).toFixed(0)}px;color:${COL[k % COL.length]};`
      + `--dx:${(Math.cos(ang) * dist).toFixed(0)}px;--dy:${(Math.sin(ang) * dist - (jack ? 30 : 10)).toFixed(0)}px;--rot:${(Math.random() * 360 - 180).toFixed(0)}deg;`
      + `animation-duration:${(900 + Math.random() * (jack ? 1100 : 500)).toFixed(0)}ms;animation-delay:${(Math.random() * (jack ? 400 : 160)).toFixed(0)}ms`;
    layer.appendChild(s);
  }
  wrap.appendChild(layer);
  setTimeout(() => layer.remove(), jack ? 2900 : 1800);
}

export class AlchemistWindow {
  static open(alchemistUuid) {
    if (_instance) { _instance.setAlchemist(alchemistUuid); return _instance; }
    _instance = new AlchemistWindow(alchemistUuid);
    _instance._build();
    return _instance;
  }
  static close() { _instance?._destroy(); }

  constructor(alchemistUuid) {
    this._alchemistUuid = alchemistUuid;
    this._alchemist = null;
    this._actor = null;
    this._cat = "weapon";
    this._itemId = null;
    this._slot = 0;
    this._placed = new Map();     // itemId → [grade|null per socket]
    this._busy = false;
    this._results = null;          // last attune result (for the result rows)
    this._lead = null;
    this._line = IDLE_LINE;
  }

  // ── Data helpers ────────────────────────────────────────────────────────────
  _api() { return globalThis.FUCompanion?.api?.orbment ?? null; }
  _zenit() { return Math.max(0, Number(this._actor?.system?.props?.zenit ?? 0) || 0); }
  _gear(cat) { return (this._actor?.items?.contents ?? []).filter((i) => itemKindOf(i) === cat); }
  _item() { return this._itemId ? this._actor?.items?.get(this._itemId) ?? null : null; }
  _placedFor(item) {
    const n = slotCountOf(item);
    const arr = (this._placed.get(item.id) ?? []).slice(0, n);
    while (arr.length < n) arr.push(null);
    return arr;
  }
  _setPlaced(item, arr) { this._placed.set(item.id, arr); }
  _sfx(key) {
    const [src, volume] = SFX[key] ?? [];
    if (!src) return;
    try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
  }
  _npcImg() { return spriteSrc(this._alchemist); }
  _npcName() { return this._alchemist?.name ?? "Alchemist"; }

  // The acting character: the user's own; a GM falls back to a controlled token's.
  _resolveActor() {
    const own = game.user?.character ?? null;
    if (own) return own;
    if (game.user?.isGM) return canvas?.tokens?.controlled?.[0]?.actor ?? null;
    return null;
  }

  // ── Build ───────────────────────────────────────────────────────────────────
  async _build() {
    this._injectStyles();
    this._alchemist = await fromUuid(this._alchemistUuid).catch(() => null);
    this._actor = this._resolveActor();
    const first = CATS.map((c) => this._gear(c.key)).find((g) => g.length);
    if (first?.length) { this._cat = itemKindOf(first[0]); this._itemId = first[0].id; }

    const el = document.createElement("div");
    el.id = WIN_ID;
    el.innerHTML = this._shell();
    document.body.appendChild(el);
    this._el = el;
    this._makeDraggable(el.querySelector(".fu-aw-titlebar"), el);
    el.querySelector(".fu-aw-close").addEventListener("click", () => { this._sfx("back"); this._destroy(); });
    this._render();
    this._onActorUpdate = (actor) => { if (actor?.id === this._actor?.id && !this._busy) this._render(); };
    Hooks.on("updateActor", this._onActorUpdate);
    requestAnimationFrame(() => el.classList.add("is-open"));
    this._sfx("open");
  }

  async setAlchemist(uuid) {
    if (uuid === this._alchemistUuid) return;
    this._alchemistUuid = uuid;
    this._alchemist = await fromUuid(uuid).catch(() => null);
    this._render();
  }

  _shell() {
    return `
      <div class="fu-aw-titlebar">
        <img class="fu-aw-tb-orb" src="${ORB_IMG.enhancement}" alt="">
        <div class="fu-aw-tb-text"><span class="fu-aw-title">Orbment Attunement</span><span class="fu-aw-sub"></span></div>
        <span class="fu-aw-zenit"></span>
        <button type="button" class="fu-aw-close" aria-label="Close">✕</button>
      </div>
      <div class="fu-aw-body">
        <div class="fu-aw-left"></div>
        <div class="fu-aw-center"></div>
        <div class="fu-aw-right"></div>
      </div>`;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  _render() {
    const el = this._el;
    if (!el) return;
    this._actor = this._actor ? (game.actors?.get(this._actor.id) ?? this._actor) : this._resolveActor();
    el.querySelector(".fu-aw-sub").textContent = `Alchemist · ${this._npcName()}`;
    el.querySelector(".fu-aw-zenit").innerHTML = this._actor ? `${GP_ICON}<span>${this._zenit().toLocaleString()}</span>` : "";
    this._renderLeft(el.querySelector(".fu-aw-left"));
    this._renderCenter(el.querySelector(".fu-aw-center"));
    this._renderRight(el.querySelector(".fu-aw-right"));
  }

  _renderLeft(root) {
    const actor = this._actor;
    const tabs = CATS.map((c) => `<button type="button" class="fu-aw-tab${c.key === this._cat ? " is-on" : ""}" data-cat="${c.key}">${c.label}</button>`).join("");
    let grid;
    if (!actor) grid = `<div class="fu-aw-empty">Assign yourself a character to attune gear.</div>`;
    else {
      const items = this._gear(this._cat);
      grid = items.length ? items.map((it) => {
        const orb = readOrbment(it);
        const pips = orb.slots.map((s) => {
          const cat = s ? resolveAugment(s.id, s.param, s.value)?.category : null;
          return `<span class="fu-aw-pip" style="${cat ? `background:${PIP[cat] ?? "#888"}` : "background:#2b1d10;box-shadow:inset 0 0 0 1px #b5a07a"}"></span>`;
        }).join("");
        return `<button type="button" class="fu-aw-tile${it.id === this._itemId ? " is-on" : ""}" data-item="${it.id}" data-tooltip="${esc(it.name)}" aria-label="${esc(it.name)}">
          <img src="${esc(it.img)}" alt=""><span class="fu-aw-pips">${pips}</span></button>`;
      }).join("") : `<div class="fu-aw-empty">No ${this._cat === "armor" ? "armor" : `${this._cat}s`} to attune.</div>`;
    }
    const lead = this._busy ? null : this._lead;
    const pose = this._busy ? "fu-aw-sway" : (POSE[lead] ?? "");
    const emote = lead === "jackpot" ? `<span class="fu-aw-bang">!</span><span class="fu-aw-note n1">♪</span><span class="fu-aw-note n2">♫</span><span class="fu-aw-note n3">♪</span>`
      : lead === "better" ? `<span class="fu-aw-note n1 once">♪</span>`
      : lead === "sidegrade" ? `<span class="fu-aw-dots">…</span>`
      : lead === "worse" ? `<span class="fu-aw-gloom g1"></span><span class="fu-aw-gloom g2"></span><span class="fu-aw-gloom g3"></span>`
      : lead === "new" ? `<span class="fu-aw-twinkle">✦</span>` : "";
    root.innerHTML = `
      <div class="fu-aw-label">${esc(actor?.name ?? "")}${actor ? "'s gear" : ""}</div>
      <div class="fu-aw-tabs">${tabs}</div>
      <div class="fu-aw-grid">${grid}</div>
      <div class="fu-aw-grow"></div>
      <div class="fu-aw-npc">
        <span class="fu-aw-npc-fig">${spriteHTML(this._npcImg(), `fu-aw-npc-img ${pose}`, this._npcName())}<span class="fu-aw-emote" aria-hidden="true">${emote}</span></span>
        <p class="fu-aw-line${lead === "jackpot" ? " is-jack" : ""}">“${esc(this._busy ? SPIN_LINE : this._line)}”</p>
      </div>`;
    root.querySelectorAll(".fu-aw-tab").forEach((b) => b.addEventListener("click", () => {
      if (this._busy || b.dataset.cat === this._cat) return;
      this._cat = b.dataset.cat;
      this._itemId = this._gear(this._cat)[0]?.id ?? null;
      this._slot = 0; this._results = null; this._lead = null; this._line = IDLE_LINE;
      this._sfx("select"); this._render();
    }));
    root.querySelectorAll(".fu-aw-tile").forEach((b) => b.addEventListener("click", () => {
      if (this._busy || b.dataset.item === this._itemId) return;
      this._itemId = b.dataset.item; this._slot = 0; this._results = null; this._lead = null; this._line = IDLE_LINE;
      this._sfx("select"); this._render();
    }));
  }

  _renderCenter(root) {
    const item = this._item();
    if (!item) { root.innerHTML = `<div class="fu-aw-empty fu-aw-pad">Choose a weapon, armor or shield.</div>`; return; }
    const orb = readOrbment(item);
    const placed = this._placedFor(item);
    const rarity = String(item.system?.props?.item_rarity ?? "") || "Common";
    const slots = orb.slots.map((s, i) => {
      const view = s ? resolveAugment(s.id, s.param, s.value) : null;
      const stone = placed[i];
      const sel = i === this._slot && !this._busy;
      const cls = ["fu-aw-sock", stone ? `has-${stone}` : "", sel ? "is-sel" : "", this._busy && stone ? "is-spin" : ""].filter(Boolean).join(" ");
      return `<div class="fu-aw-sock-wrap" data-i="${i}">
        <button type="button" class="${cls}" data-i="${i}" aria-label="Slot ${i + 1}: ${esc(view?.label ?? "empty")}${stone ? `, ${esc(STONES[stone].label)} placed` : ""}"
          data-tooltip="${esc(view ? `${view.label}: ${view.summary}` : "Empty slot")}">
          ${view ? `<img class="fu-aw-orb" src="${ORB_IMG[view.category] ?? ORB_IMG.enhancement}" alt="">` : ""}
          ${stone ? `<span class="fu-aw-badge"><img src="${STONE_IMG[stone]}" alt=""></span>` : ""}
        </button>
        <span class="fu-aw-cap${sel ? " is-sel" : ""}">Slot ${i + 1}${stone ? ` · ${STONES[stone].label.split(" ")[0]}` : ""}</span>
      </div>`;
    }).join("");
    const cur = orb.slots[this._slot];
    const cv = cur ? resolveAugment(cur.id, cur.param, cur.value) : null;
    let lower;
    if (this._busy) {
      const n = placed.filter(Boolean).length;
      lower = `<div class="fu-aw-rolling">Attuning ${n} slot${n === 1 ? "" : "s"}…</div>`;
    } else if (this._results?.length) {
      lower = `<div class="fu-aw-results">${this._results.map((r, k) => {
        const now = r.now; const was = r.was;
        const jack = r.verdict === "jackpot";
        return `<div class="fu-aw-res${jack ? " is-jack" : ""}" style="border-color:${EDGE[r.verdict] ?? "#cdb98f"};animation-delay:${k * 120}ms" data-tooltip="${esc(now ? `${now.label}: ${now.summary}` : "")}">
          <span class="fu-aw-res-head">Slot ${r.index + 1} · ${esc(STONES[r.grade]?.label ?? "")}</span>
          <span class="fu-aw-res-line"><span class="fu-aw-old">${esc(was?.label ?? "Empty slot")}</span><span class="fu-aw-arrow">→</span>
          ${now ? `<img src="${ORB_IMG[now.category] ?? ORB_IMG.enhancement}" alt="">` : ""}<b>${esc(now?.label ?? "")}</b></span>
          <span class="fu-aw-res-text">${esc(now?.summary ?? "")}</span></div>`;
      }).join("")}</div>`;
    } else {
      const top = cv?.vals ? `+${cv.value}${cv.unit} of +${cv.vals[cv.vals.length - 1]}${cv.unit}` : "";
      lower = `<div class="fu-aw-cur">
          <div class="fu-aw-cur-head"><span>Slot ${this._slot + 1} now</span><span>${esc(top)}</span></div>
          <b>${esc(cv?.label ?? "Empty slot")}</b>
          <span>${esc(cv?.summary ?? "Nothing attuned yet. Any Orbment is a gain.")}</span>
        </div>
        <div class="fu-aw-hint">Pick a socket, then a stone. Or drag a stone onto any socket. Click the selected socket again to take its stone off.</div>`;
    }
    root.innerHTML = `
      <div class="fu-aw-item-name" style="color:${this._rarityColor(rarity)}">${esc(item.name)}</div>
      <div class="fu-aw-item-sub">${esc(rarity)} · ${esc(itemKindOf(item))} · ${orb.slots.length} slot${orb.slots.length === 1 ? "" : "s"}</div>
      <div class="fu-aw-item-icon"><img src="${esc(item.img)}" alt=""></div>
      <div class="fu-aw-stem"></div>
      <div class="fu-aw-socks">${slots}</div>
      ${lower}`;

    root.querySelectorAll(".fu-aw-sock").forEach((b) => {
      const i = Number(b.dataset.i);
      b.addEventListener("click", () => {
        if (this._busy) return;
        const arr = this._placedFor(item);
        if (i === this._slot && arr[i]) { arr[i] = null; this._setPlaced(item, arr); this._sfx("back"); }
        else { this._slot = i; this._sfx("select"); }
        this._results = null; this._lead = null; this._line = IDLE_LINE;
        this._render();
      });
      b.addEventListener("dragover", (e) => { e.preventDefault(); b.classList.add("is-over"); });
      b.addEventListener("dragleave", () => b.classList.remove("is-over"));
      b.addEventListener("drop", (e) => {
        e.preventDefault(); b.classList.remove("is-over");
        const grade = String(e.dataTransfer?.getData("text/plain") ?? "").replace(/^orbment-stone:/, "");
        if (!this._busy && STONES[grade]) this._place(item, i, grade);
      });
    });
  }

  _renderRight(root) {
    const item = this._item();
    const rarity = item?.system?.props?.item_rarity;
    const stones = Object.values(STONES).map((s) => `
      <button type="button" class="fu-aw-stone" draggable="true" data-grade="${s.id}">
        <span class="fu-aw-stone-ic"><img src="${STONE_IMG[s.id]}" alt=""></span>
        <span class="fu-aw-stone-txt"><b>${esc(s.label)}</b><span>${esc(STONE_DESC[s.id])}</span></span>
        <span class="fu-aw-price">${GP_ICON}${item ? attunePrice(rarity, s.id).toLocaleString() : "—"}</span>
      </button>`).join("");

    let pool = "";
    if (item) {
      const defs = rollableAugments(itemKindOf(item));
      pool = TIERS.map((t, ti) => {
        const rows = defs.filter((a) => a.tier === ti);
        if (!rows.length) return "";
        return `<div class="fu-aw-tier"><span class="fu-aw-tier-name" style="color:${TIER_COLOR[ti]}">${t}</span>
          ${rows.map((a) => {
            const v = resolveAugment(a.id, null, null);
            const unit = a.unit ?? "";
            const range = a.vals ? `+${a.vals[0]}${unit} to +${a.vals[a.vals.length - 1]}${unit}` : "";
            const tip = `${a.summary}${a.param ? " The choice is rolled at random." : ""}${range ? ` Rolls ${range}.` : ""}`;
            return `<div class="fu-aw-entry" tabindex="0" data-tooltip="${esc(tip)}" aria-label="${esc(`${a.label}: ${tip}`)}">
              <img src="${ORB_IMG[v?.category ?? a.category] ?? ORB_IMG.enhancement}" alt=""><span>${esc(a.label)}</span><span class="fu-aw-range">${esc(range)}</span></div>`;
          }).join("")}</div>`;
      }).join("");
    }

    const placed = item ? this._placedFor(item) : [];
    const orb = item ? readOrbment(item) : null;
    const queued = placed.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
    const total = item ? queued.reduce((t, i) => t + attunePrice(rarity, placed[i]), 0) : 0;
    const replacing = queued.filter((i) => orb?.slots[i]).map((i) => resolveAugment(orb.slots[i].id, orb.slots[i].param, orb.slots[i].value)?.label).filter(Boolean);
    const afford = this._zenit() >= total;
    const disabled = this._busy || !item || !queued.length || !afford;
    const label = this._busy ? "Attuning…" : queued.length > 1 ? `Attune ${queued.length} slots` : "Attune";
    root.innerHTML = `
      <div class="fu-aw-row"><span class="fu-aw-label">Stones · drag onto a socket</span><button type="button" class="fu-aw-mini fu-aw-clear">Clear</button></div>
      ${stones}
      <div class="fu-aw-pool"><span class="fu-aw-label">What can come out${item ? ` · ${esc(itemKindOf(item))}` : ""}</span>
        <span class="fu-aw-pool-hint">Hover an Orbment to see what it does.</span>${pool}</div>
      ${replacing.length && !this._busy ? `<div class="fu-aw-warn">Replaces <b>${esc(replacing.join(" and "))}</b>. There is no undo.</div>` : ""}
      ${queued.length && !afford && !this._busy ? `<div class="fu-aw-warn">Not enough Zenit for this attunement.</div>` : ""}
      <button type="button" class="fu-aw-attune" ${disabled ? "disabled" : ""}><span>${label}</span><span class="fu-aw-price">${GP_ICON}${total.toLocaleString()}</span></button>`;

    root.querySelectorAll(".fu-aw-stone").forEach((b) => {
      b.addEventListener("click", () => { if (!this._busy && item) this._place(item, this._slot, b.dataset.grade); });
      b.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/plain", `orbment-stone:${b.dataset.grade}`); if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy"; });
    });
    root.querySelector(".fu-aw-clear")?.addEventListener("click", () => {
      if (this._busy || !item) return;
      if (this._placedFor(item).some(Boolean)) this._sfx("back");
      this._setPlaced(item, []); this._slot = 0; this._render();
    });
    root.querySelector(".fu-aw-attune")?.addEventListener("click", () => this._attune());
  }

  _rarityColor(r) {
    const k = String(r ?? "").toLowerCase();
    return k.includes("legendary") ? "#7b2fa8" : k.includes("rare") ? "#b8860b" : k.includes("uncommon") ? "#1f6fb2" : "#3a1e06";
  }

  // Slot a stone (or move it); selection advances to the next socket with no stone.
  _place(item, i, grade) {
    const arr = this._placedFor(item);
    if (i < 0 || i >= arr.length) return;
    arr[i] = grade;
    this._setPlaced(item, arr);
    let next = i;
    for (let k = 1; k <= arr.length; k++) { const j = (i + k) % arr.length; if (!arr[j]) { next = j; break; } }
    this._slot = next;
    this._results = null; this._lead = null; this._line = IDLE_LINE;
    this._sfx("slot");
    this._render();
  }

  // ── Attune ──────────────────────────────────────────────────────────────────
  async _attune() {
    const item = this._item();
    const api = this._api();
    if (this._busy || !item || !api?.attune) return;
    const placed = this._placedFor(item);
    const slots = placed.map((g, i) => (g ? { index: i, grade: g } : null)).filter(Boolean);
    if (!slots.length) return;

    this._busy = true;
    this._results = null; this._lead = null;
    this._render();
    this._sfx("spin");
    const feedback = api.feedback ?? null;
    try { feedback?.attuning?.({ actorName: this._actor?.name, itemName: item.name, itemUuid: item.uuid, itemRarity: item.system?.props?.item_rarity, grades: slots.map((s) => s.grade) }); } catch {}

    const [res] = await Promise.all([api.attune({ itemUuid: item.uuid, slots, mode: "shop" }), wait(MIN_SPIN_MS)]);
    this._busy = false;

    if (!res?.ok) {
      ui.notifications?.warn(attuneFailText(res));
      try { feedback?.cancel?.({ itemUuid: item.uuid }); } catch {}
      this._render();
      return;
    }
    this._setPlaced(item, []);
    this._results = res.results;
    this._lead = res.lead;
    this._line = pickLine(res.lead);
    this._render();
    this._sfx(res.lead === "jackpot" ? "jackpot" : "done");
    this._burst(res.results.map((r) => ({ index: r.index, jack: r.verdict === "jackpot" })), res.lead === "jackpot");
    try { feedback?.result?.({ ...res, actorName: this._actor?.name ?? res.actorName }); } catch {}
  }

  // Stars and sparkles from every attuned socket; a shower on a Jackpot.
  _burst(list, jackpot) {
    for (const { index, jack } of list) {
      const wrap = this._el?.querySelector(`.fu-aw-sock-wrap[data-i="${index}"]`);
      if (wrap) burstAtSocket(wrap, jack, jackpot);
    }
  }

  // ── Window chrome ───────────────────────────────────────────────────────────
  _makeDraggable(handle, win) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".fu-aw-close")) return;
      e.preventDefault();
      // Pin the window where it stands BEFORE moving: drop the centring
      // transform with its transition off. Left on, the transform animated
      // away under the cursor and the window lunged to the top-left first.
      const r = win.getBoundingClientRect();
      win.style.transition = "opacity .28s ease";
      win.style.transform = "none";
      win.style.left = `${r.left}px`;
      win.style.top = `${r.top}px`;
      const ox = r.left, oy = r.top, mx = e.clientX, my = e.clientY;
      const move = (ev) => { win.style.left = `${ox + ev.clientX - mx}px`; win.style.top = `${oy + ev.clientY - my}px`; };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  _destroy() {
    if (this._onActorUpdate) Hooks.off("updateActor", this._onActorUpdate);
    const el = this._el;
    if (el) { el.classList.remove("is-open"); setTimeout(() => el.remove(), 240); }
    _instance = null;
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${WIN_ID} { position: fixed; top: 50%; left: 50%; transform: translate(-50%, calc(-50% + 18px)); opacity: 0;
  transition: opacity .28s cubic-bezier(.2,.9,.2,1), transform .28s cubic-bezier(.2,.9,.2,1);
  width: min(1180px, 96vw); height: min(760px, 92vh); z-index: 9999; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; border: 2px solid #c9a44a; box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 22px 64px rgba(0,0,0,.55);
  background: linear-gradient(180deg, #efe3c6, #e4d3ac); color: #3a1e06; font-family: inherit; }
#${WIN_ID}.is-open { opacity: 1; transform: translate(-50%, -50%); }
#${WIN_ID} img { border: none !important; box-shadow: none; background: transparent; }
.fu-aw-titlebar { display: flex; align-items: center; gap: 12px; padding: 9px 14px; background: linear-gradient(180deg, #7a4e20, #5c3818); color: #fff6dd; cursor: grab; flex-shrink: 0; }
.fu-aw-tb-orb { width: 26px; height: 26px; image-rendering: pixelated; }
.fu-aw-tb-text { display: flex; flex-direction: column; line-height: 1.15; flex: 1; }
.fu-aw-title { font-size: 17px; font-weight: 700; letter-spacing: .03em; }
.fu-aw-sub { font-size: 12px; color: #e9d3a6; }
.fu-aw-zenit { display: flex; align-items: center; gap: 6px; padding: 3px 12px; border-radius: 999px; background: rgba(0,0,0,.25); font-weight: 700; font-variant-numeric: tabular-nums; }
.fu-aw-zicon { width: 16px; height: 16px; object-fit: contain; vertical-align: middle; }
.fu-aw-close { width: 32px; height: 32px; border-radius: 8px; border: 1px solid rgba(255,246,221,.4); background: transparent; color: #fff6dd; cursor: pointer; font-size: 14px; line-height: 1; }
.fu-aw-close:hover { background: rgba(160,48,32,.75); }
.fu-aw-body { flex: 1; display: grid; grid-template-columns: 250px minmax(0,1fr) 340px; min-height: 0; }
.fu-aw-left { display: flex; flex-direction: column; padding: 12px 12px 12px 14px; border-right: 1px solid rgba(122,78,32,.25); min-height: 0; }
.fu-aw-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6b4a26; }
.fu-aw-tabs { display: flex; gap: 4px; margin-top: 8px; }
.fu-aw-tab { font: inherit; width: auto; height: auto; line-height: 1.3; font-size: 12.5px; font-weight: 600; padding: 6px 10px; border-radius: 8px 8px 0 0; border: 1px solid #b8865a; border-bottom: 0; background: #e4d3ac; color: #6b4a26; cursor: pointer; }
.fu-aw-tab.is-on { background: #faf6ee; color: #3a1e06; }
.fu-aw-grid { background: #faf6ee; border: 1px solid #b8865a; border-radius: 0 10px 10px 10px; padding: 9px; display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; align-content: start; max-height: 42%; overflow-y: auto; }
.fu-aw-tile { position: relative; aspect-ratio: 1; border-radius: 10px; border: 2px solid #c9b48a; background: #2b1d10; display: grid; place-items: center; cursor: pointer; padding: 0; }
.fu-aw-tile:hover { border-color: #c9a44a; }
.fu-aw-tile.is-on { border-color: #c9a44a; box-shadow: 0 0 0 2px #7a4e20, 0 0 12px rgba(201,164,74,.7); }
.fu-aw-tile img { width: 70%; height: 70%; object-fit: contain; }
.fu-aw-pips { position: absolute; top: 5px; left: 5px; display: flex; gap: 4px; }
.fu-aw-pip { width: 7px; height: 7px; transform: rotate(45deg); border-radius: 1.5px; box-shadow: 0 0 0 1px #1b120a; }
.fu-aw-empty { grid-column: 1 / -1; font-size: 12.5px; font-style: italic; color: #6b4a26; padding: 12px 4px; }
.fu-aw-pad { padding: 30px; text-align: center; }
.fu-aw-grow { flex: 1; }
.fu-aw-npc { display: flex; gap: 10px; align-items: flex-end; padding: 10px; border-radius: 12px; background: rgba(255,255,255,.4); border: 1px solid rgba(122,78,32,.25); }
.fu-aw-npc-fig { position: relative; display: block; width: 64px; height: 92px; flex-shrink: 0; }
.fu-aw-npc-img { width: 64px; height: 92px; object-fit: contain; object-position: bottom; transform-origin: 50% 100%; filter: drop-shadow(0 4px 6px rgba(0,0,0,.3)); }
.fu-aw-emote { position: absolute; inset: 0; pointer-events: none; }
.fu-aw-line { margin: 0; font-size: 13px; line-height: 1.4; font-style: italic; }
.fu-aw-line.is-jack { font-weight: 700; font-style: normal; color: #8a5a00; font-size: 14px; }
.fu-aw-center { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px 20px; min-height: 0; overflow-y: auto; overflow-x: hidden;
  background: radial-gradient(ellipse at 50% 30%, rgba(255,250,235,.85), rgba(228,211,172,0) 70%); }
.fu-aw-item-name { font-size: 21px; font-weight: 700; text-align: center; }
.fu-aw-item-sub { font-size: 12.5px; color: #6b4a26; margin-top: -8px; text-transform: capitalize; }
.fu-aw-item-icon { width: 100px; height: 100px; border-radius: 16px; border: 3px solid #c9a44a; background: #2b1d10; display: grid; place-items: center; box-shadow: 0 0 0 2px #7a4e20, 0 8px 18px rgba(0,0,0,.35); }
.fu-aw-item-icon img { width: 76px; height: 76px; object-fit: contain; }
.fu-aw-stem { width: 2px; height: 12px; background: linear-gradient(#c9a44a, rgba(201,164,74,0)); }
.fu-aw-socks { display: flex; gap: 26px; justify-content: center; }
.fu-aw-sock-wrap { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.fu-aw-sock { position: relative; width: 82px; height: 82px; border-radius: 50%; border: 3px solid #8d5f38; padding: 0; cursor: pointer;
  background: radial-gradient(circle at 50% 45%, #3b2a17, #1b120a 70%); display: grid; place-items: center;
  box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 0 2px #e9d9b2; transition: box-shadow .25s ease, border-color .25s ease, transform .15s ease; }
.fu-aw-sock:hover { transform: scale(1.04); }
.fu-aw-sock.is-sel { border-color: #c9a44a; box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 0 3px #c9a44a, 0 0 16px rgba(201,164,74,.75); }
.fu-aw-sock.is-over { border-color: #c9a44a; box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 0 3px #c9a44a; }
.fu-aw-sock.has-rough { border-color: #d9d4c7; box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 0 3px #d9d4c7, 0 0 16px rgba(230,226,215,.85); }
.fu-aw-sock.has-polished { border-color: #ffb547; box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 0 3px #ffb547, 0 0 18px rgba(255,181,71,.9); }
.fu-aw-sock.is-spin { animation: fu-aw-halo .9s ease-in-out infinite alternate; }
.fu-aw-sock.is-spin .fu-aw-orb, .fu-aw-sock.is-spin .fu-aw-badge img { animation: fu-aw-spin 1.7s cubic-bezier(.4,0,.2,1) infinite; }
.fu-aw-orb { width: 58px; height: 58px; image-rendering: pixelated; }
.fu-aw-badge { position: absolute; right: -8px; bottom: -8px; width: 36px; height: 36px; border-radius: 50%; background: #2b1d10; border: 2px solid #e9d9b2; display: grid; place-items: center; box-shadow: 0 2px 6px rgba(0,0,0,.5); }
.fu-aw-badge img { width: 26px; height: 26px; image-rendering: pixelated; }
.fu-aw-cap { font-size: 12px; font-weight: 600; color: #6b4a26; border-bottom: 2px solid transparent; padding-bottom: 1px; }
.fu-aw-cap.is-sel { color: #3a1e06; border-bottom-color: #c9a44a; }
.fu-aw-cur { width: 100%; box-sizing: border-box; border-radius: 12px; border: 1px solid rgba(122,78,32,.3); background: rgba(255,255,255,.6); padding: 11px 14px; display: flex; flex-direction: column; gap: 5px; font-size: 13.5px; line-height: 1.4; }
.fu-aw-cur b { font-size: 16px; }
.fu-aw-cur-head { display: flex; justify-content: space-between; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6b4a26; }
.fu-aw-hint { font-size: 12.5px; color: #6b4a26; text-align: center; }
.fu-aw-rolling { font-size: 15px; font-weight: 600; color: #6b4a26; padding-top: 10px; }
.fu-aw-results { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.fu-aw-res { box-sizing: border-box; border-radius: 14px; border: 2px solid #cdb98f; background: #faf6ee; padding: 9px 14px; display: flex; flex-direction: column; gap: 4px;
  box-shadow: 0 6px 18px rgba(0,0,0,.12); animation: fu-aw-pop .55s cubic-bezier(.2,.9,.3,1.3) both; transition: border-color .6s ease; }
.fu-aw-res.is-jack { background: linear-gradient(180deg, #fff6d6, #f3df9e); box-shadow: 0 0 0 1px #b8860b, 0 0 22px rgba(255,205,90,.65); }
.fu-aw-res-head { font-size: 12px; color: #6b4a26; }
.fu-aw-res-line { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.fu-aw-res-line img { width: 24px; height: 24px; image-rendering: pixelated; }
.fu-aw-res-line b { font-size: 16.5px; }
.fu-aw-old { font-size: 13.5px; color: #6b4a26; text-decoration: line-through; text-decoration-thickness: 1.5px; }
.fu-aw-arrow { color: #7a4e20; }
.fu-aw-res-text { font-size: 13px; line-height: 1.35; }
.fu-aw-right { display: flex; flex-direction: column; gap: 9px; padding: 12px 14px 14px; border-left: 1px solid rgba(122,78,32,.25); min-height: 0; }
.fu-aw-row { display: flex; justify-content: space-between; align-items: baseline; }
.fu-aw-mini { font: inherit; width: auto; height: auto; line-height: 1.3; font-size: 12.5px; padding: 3px 12px; border-radius: 9px; border: 1px solid #b8865a; background: transparent; color: #6b4a26; cursor: pointer; }
.fu-aw-mini:hover { background: rgba(255,255,255,.5); }
.fu-aw-stone { font: inherit; text-align: left; display: grid; grid-template-columns: 46px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 12px;
  border: 2px solid #d6c49c; background: #faf6ee; cursor: grab; color: #3a1e06; width: 100%; }
.fu-aw-stone:hover { border-color: #c9a44a; background: #fff8e4; }
.fu-aw-stone:active { cursor: grabbing; }
.fu-aw-stone-ic { width: 46px; height: 46px; border-radius: 10px; background: #2b1d10; display: grid; place-items: center; }
.fu-aw-stone-ic img { width: 34px; height: 34px; object-fit: contain; image-rendering: pixelated; }
.fu-aw-stone-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fu-aw-stone-txt b { font-size: 14.5px; }
.fu-aw-stone-txt span { font-size: 11.5px; color: #6b4a26; line-height: 1.3; }
.fu-aw-price { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; font-variant-numeric: tabular-nums; }
.fu-aw-pool { flex: 1; min-height: 0; overflow-y: auto; border-radius: 10px; background: rgba(255,255,255,.3); border: 1px solid rgba(122,78,32,.2); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.fu-aw-pool-hint { font-size: 11.5px; color: #6b4a26; margin-top: -4px; }
.fu-aw-tier { display: flex; flex-direction: column; gap: 2px; }
.fu-aw-tier-name { font-size: 11.5px; font-weight: 700; }
.fu-aw-entry { display: grid; grid-template-columns: 18px minmax(0,1fr) auto; gap: 6px; align-items: center; font-size: 12.5px; padding: 2px 4px; margin: 0 -4px; border-radius: 5px; cursor: help; }
.fu-aw-entry:hover, .fu-aw-entry:focus-visible { background: rgba(201,164,74,.25); outline: none; }
.fu-aw-entry img { width: 16px; height: 16px; image-rendering: pixelated; }
.fu-aw-entry span:nth-child(2) { text-decoration: underline dotted rgba(107,74,38,.55); text-underline-offset: 3px; }
.fu-aw-range { color: #6b4a26; font-variant-numeric: tabular-nums; }
.fu-aw-warn { border-radius: 10px; border: 1px solid #a3321c; background: rgba(163,50,28,.08); color: #7d2412; padding: 7px 10px; font-size: 12.5px; line-height: 1.35; }
.fu-aw-attune { font: inherit; font-size: 16px; font-weight: 700; letter-spacing: .04em; min-height: 50px; width: 100%; border-radius: 12px; border: 2px solid #5c3818;
  background: linear-gradient(180deg, #9a6a33, #6b4220); color: #fff6dd; cursor: pointer; box-shadow: 0 3px 0 #3d250f; display: flex; align-items: center; justify-content: center; gap: 10px; }
.fu-aw-attune:hover:not(:disabled) { filter: brightness(1.08); }
.fu-aw-attune:disabled { opacity: .45; cursor: not-allowed; }
/* stars + ring at completion */
.fu-aw-fx { position: absolute; left: 50%; top: 41px; width: 0; height: 0; overflow: visible; pointer-events: none; z-index: 3; }
.fu-aw-ring { position: absolute; width: 82px; height: 82px; margin: -41px 0 0 -41px; border-radius: 50%; border: 3px solid #fff3b0; animation: fu-aw-ringout .7s ease-out both; }
.fu-aw-spark { position: absolute; line-height: 1; transform: translate(-50%, -50%); animation-name: fu-aw-spark; animation-timing-function: cubic-bezier(.15,.7,.3,1); animation-fill-mode: both;
  text-shadow: 0 0 6px currentColor, 0 0 14px currentColor; }
/* Alchemist expressions */
.fu-aw-wiggle { animation: fu-aw-wiggle .42s ease-in-out 7; }
.fu-aw-bob { animation: fu-aw-bob .55s ease-in-out 2; }
.fu-aw-slump { animation: fu-aw-slump .9s ease-out both; }
.fu-aw-nod { animation: fu-aw-nod .45s ease-in-out 2; }
.fu-aw-sway { animation: fu-aw-sway 1.2s ease-in-out infinite; }
.fu-aw-bang { position: absolute; top: -24px; right: -12px; font-size: 28px; font-weight: 900; line-height: 1; color: #e0452a;
  text-shadow: 2px 0 #fff, -2px 0 #fff, 0 2px #fff, 0 -2px #fff; animation: fu-aw-bangin .35s cubic-bezier(.2,.9,.3,1.6) both; }
.fu-aw-note { position: absolute; top: 0; left: 34px; font-size: 19px; font-weight: 700; line-height: 1; opacity: 0; text-shadow: 1px 1px 0 #fff; animation: fu-aw-note 1.5s ease-out infinite; }
.fu-aw-note.n1 { color: #d0517a; } .fu-aw-note.n2 { left: 50px; color: #3d7fd0; animation-delay: .45s; } .fu-aw-note.n3 { left: 12px; color: #c98a10; animation-delay: .9s; }
.fu-aw-note.once { animation-iteration-count: 2; }
.fu-aw-dots { position: absolute; top: -22px; left: 30px; font-size: 16px; font-weight: 700; line-height: 16px; color: #6b4a26; background: #fffaf0; border: 1px solid #c9b48a; border-radius: 10px; padding: 1px 7px 3px; animation: fu-aw-pop .4s both; }
.fu-aw-gloom { position: absolute; top: -8px; width: 3px; border-radius: 2px; background: linear-gradient(#5b6bc4, rgba(91,107,196,0)); opacity: 0; animation: fu-aw-gloom 1.5s ease-in infinite; }
.fu-aw-gloom.g1 { left: 14px; height: 26px; } .fu-aw-gloom.g2 { left: 30px; height: 36px; animation-delay: .3s; } .fu-aw-gloom.g3 { left: 46px; height: 22px; animation-delay: .6s; }
.fu-aw-twinkle { position: absolute; top: -10px; right: -4px; font-size: 18px; color: #e6b33a; text-shadow: 0 0 6px #ffe7a0; animation: fu-aw-twinkle 1s ease-in-out 3; }
@keyframes fu-aw-spin { 0% { transform: rotate(0) scale(1); } 50% { transform: rotate(200deg) scale(1.12); } 100% { transform: rotate(360deg) scale(1); } }
@keyframes fu-aw-halo { from { box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 10px 2px rgba(201,164,74,.5); } to { box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 0 30px 10px rgba(255,214,120,.95); } }
@keyframes fu-aw-pop { from { transform: scale(.7); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes fu-aw-ringout { from { opacity: .95; transform: scale(.6); } to { opacity: 0; transform: scale(2.1); } }
@keyframes fu-aw-spark { 0% { opacity: 0; transform: translate(-50%,-50%) scale(.2) rotate(0); } 12% { opacity: 1; } 70% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1) rotate(var(--rot)); } }
@keyframes fu-aw-wiggle { 0%,100% { transform: none; } 25% { transform: translateY(-9px) rotate(-9deg); } 75% { transform: translateY(-9px) rotate(9deg); } }
@keyframes fu-aw-bob { 50% { transform: translateY(-6px); } }
@keyframes fu-aw-slump { to { transform: translateY(5px) scaleY(.93) rotate(-3deg); filter: brightness(.78) saturate(.55); } }
@keyframes fu-aw-nod { 50% { transform: rotate(7deg) translateY(2px); } }
@keyframes fu-aw-sway { 0%,100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
@keyframes fu-aw-bangin { from { transform: scale(0) rotate(-25deg); } to { transform: scale(1) rotate(10deg); } }
@keyframes fu-aw-note { 0% { opacity: 0; transform: translate(0,10px) rotate(-12deg); } 20% { opacity: 1; } 100% { opacity: 0; transform: translate(12px,-36px) rotate(16deg); } }
@keyframes fu-aw-gloom { 0% { opacity: 0; transform: translateY(-6px); } 30% { opacity: .9; } 100% { opacity: 0; transform: translateY(12px); } }
@keyframes fu-aw-twinkle { 0%,100% { transform: scale(.6) rotate(0); opacity: .4; } 50% { transform: scale(1.2) rotate(90deg); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { #${WIN_ID} *, #${WIN_ID} { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition: none !important; } }
`;
    document.head.appendChild(s);
  }
}
