// scripts/battle-director/invoke/invoke-hud.js
// DOM-based invoke HUD — replaces Foundry Dialog popups with an in-game
// overlay that slides in to the right of the action card.
//
// Singleton: at most one HUD (trait or bond) can be alive at once.
// Mutual exclusion: opening a new type auto-dismisses the current one.
// Toggle: calling dismissActive() from outside (e.g. re-clicking the
//   invoke button on the action card) closes the active HUD.
//
// Stable import URL (no ?cb= cache-bust) so the module singleton
// persists across cache-busted invoke-worker loads.

const HUD_ID = "fud-invoke-hud";
const CSS_ID = "fud-invoke-hud-style";

const SFX = Object.freeze({
  trait:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Ougi1.ogg",
  bond:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/EXSkill.ogg",
  cancel:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav",
  hover:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
  confirm: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Fabula_Point.ogg",
});

// ── Singleton ─────────────────────────────────────────────────────────────────

let _active = null; // { type: "trait"|"bond", el: HTMLElement, _resolve: fn }

export function getActiveType() {
  return _active?.type ?? null;
}

// Called externally (action-card toggle, or cleanup on card close).
// Dismisses with cancel sound + animation; resolves the open Promise with null.
export function dismissActive() {
  if (!_active) return;
  const { el, _resolve } = _active;
  _active = null;
  playUiSfx(SFX.cancel);
  _despawn(el, () => _resolve(null));
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function playUiSfx(url, volume = 0.75) {
  try { AudioHelper?.play?.({ src: url, volume, autoplay: true, loop: false }, false); } catch {}
}

let _lastHoverMs = 0;
function playHoverSfx() {
  const now = Date.now();
  if (now - _lastHoverMs < 80) return;
  _lastHoverMs = now;
  playUiSfx(SFX.hover, 0.4);
}

// ── Styles ────────────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement("style");
  s.id = CSS_ID;
  s.textContent = `
    #${HUD_ID} {
      position: fixed;
      z-index: 96;
      width: 256px;
      pointer-events: none;
      opacity: 0;
      transform: translateX(-16px);
      transition: opacity 200ms ease-out, transform 200ms cubic-bezier(.2,.7,.2,1);
      font-family: "Inter","Signika","Segoe UI",system-ui,sans-serif;
    }
    #${HUD_ID}.is-visible {
      pointer-events: auto;
      opacity: 1;
      transform: translateX(0);
    }
    #${HUD_ID}.is-dismissing {
      opacity: 0 !important;
      transform: translateX(-14px) !important;
      pointer-events: none !important;
      transition: opacity 150ms ease-in, transform 150ms ease-in !important;
    }

    /* ── Card shell ── */
    .fud-ih-card {
      width: 100%;
      padding: 12px 13px 11px;
      border: 2px solid var(--fud-stroke,#7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top,#f6f1e6), var(--fud-parchment-bot,#ebe3d0));
      box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.45) inset;
      color: var(--fud-ink,#3a3228);
    }
    .fud-ih-header {
      font-size: 11px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase;
      opacity: .6; margin-bottom: 3px;
    }
    .fud-ih-title {
      font-size: 15px; font-weight: 900; margin-bottom: 10px; color: var(--fud-ink,#3a3228);
    }

    /* ── Trait: die cards ── */
    .fud-ih-dice-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 8px;
    }
    .fud-ih-die {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 8px 6px; border-radius: 10px; cursor: pointer; user-select: none;
      border: 2px solid rgba(87,58,33,.6);
      background: radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.4) 0%, transparent 40%),
        linear-gradient(180deg, #f6ebd3 0%, #e7d3b1 100%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.5), 0 3px 8px rgba(0,0,0,.18);
      transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .fud-ih-die:hover { filter: brightness(1.05); }
    .fud-ih-die.on {
      border-color: #e35151;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 3px 8px rgba(0,0,0,.18),
        0 0 10px rgba(227,81,81,.4);
      background: radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.6) 0%,
        rgba(255,255,255,.2) 30%, transparent 60%),
        linear-gradient(180deg, #fff3dc 0%, #e8cea0 100%);
    }
    .fud-ih-die-icon  { width:32px; height:32px; object-fit:contain; border-radius:6px; }
    .fud-ih-die-label { font-size:11px; font-weight:700; opacity:.65; line-height:1; }
    .fud-ih-die-val   { font-size:24px; font-weight:900; line-height:1; margin-top:1px; }

    /* ── Bond: row list ── */
    .fud-ih-bond-list  { display:flex; flex-direction:column; gap:5px; margin-bottom:8px; }
    .fud-ih-bond-row {
      display: grid; grid-template-columns: 1fr auto auto; align-items: center;
      gap: 7px; padding: 6px 9px;
      border: 2px solid rgba(87,58,33,.55); border-radius: 10px;
      background: linear-gradient(180deg, #f6ebd3, #e7d3b1);
      cursor: pointer; user-select: none;
      transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .fud-ih-bond-row:hover { filter: brightness(1.04); }
    .fud-ih-bond-row.sel {
      border-color: #FFBB55;
      box-shadow: 0 0 0 2px rgba(255,187,85,.28), 0 3px 8px rgba(0,0,0,.15);
    }
    .fud-ih-bond-name   { font-size:13px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fud-ih-bond-hearts { display:flex; gap:2px; align-items:center; }
    .fud-ih-bond-bonus  { font-size:17px; font-weight:400; font-style:italic; min-width:22px; text-align:right; }

    /* ── Shared ── */
    .fud-ih-hint {
      font-size: 11px; opacity: .62; margin-bottom: 10px; line-height: 1.45;
    }
    .fud-ih-btns { display: flex; gap: 6px; }
    .fud-ih-btn {
      flex: 1; padding: 7px 0; border: none; border-radius: 9px;
      font-size: 13px; font-weight: 800; letter-spacing: .2px;
      cursor: pointer; user-select: none;
      transition: filter .1s ease, transform .06s ease;
    }
    .fud-ih-btn:active { transform: translateY(1px); }
    .fud-ih-confirm {
      background: linear-gradient(180deg, #c9a24a, #a07a28);
      color: #fff8e7;
      box-shadow: 0 2px 6px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.22);
    }
    .fud-ih-confirm:hover:not(:disabled) { filter: brightness(1.09); }
    .fud-ih-confirm:disabled { opacity: .38; cursor: default; pointer-events: none; }
    .fud-ih-cancel {
      background: rgba(87,58,33,.1);
      color: var(--fud-ink,#3a3228);
      border: 1.5px solid rgba(87,58,33,.3);
    }
    .fud-ih-cancel:hover { background: rgba(87,58,33,.18); }
  `;
  document.head.appendChild(s);
}

// ── DOM lifecycle ─────────────────────────────────────────────────────────────

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );

function _positionHud(el, cardRoot) {
  const card = cardRoot?.querySelector?.(".fud-bf-card");
  if (card) {
    const r = card.getBoundingClientRect();
    const hudW = 256 + 4; // width + border
    const left = Math.min(r.right + 8, window.innerWidth - hudW - 8);
    el.style.left      = `${left}px`;
    el.style.top       = `${r.top}px`;
    el.style.maxHeight = `${window.innerHeight - r.top - 12}px`;
    el.style.overflowY = "auto";
  } else {
    el.style.left = "calc(50% + 172px)";
    el.style.top  = "20%";
  }
}

function _attachHoverSfx(el) {
  for (const b of el.querySelectorAll(".fud-ih-die, .fud-ih-btn")) {
    b.addEventListener("mouseenter", playHoverSfx);
  }
}

function _spawnEl(html, cardRoot) {
  document.getElementById(HUD_ID)?.remove();
  const el = document.createElement("div");
  el.id = HUD_ID;
  el.innerHTML = html;
  document.body.appendChild(el);
  _positionHud(el, cardRoot);
  _attachHoverSfx(el);
  // Double rAF: first frame renders at opacity:0, second triggers transition
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")));
  return el;
}

function _despawn(el, onDone) {
  if (!el?.parentNode) { onDone?.(); return; }
  el.classList.add("is-dismissing");
  const cleanup = () => { el.remove(); onDone?.(); };
  el.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 300); // safety fallback
}

function _resolveHud(el, resolveFn, result, sfxKey) {
  if (_active?.el === el) _active = null;
  if (sfxKey) playUiSfx(SFX[sfxKey]);
  _despawn(el, () => resolveFn(result));
}

// ── Trait HUD ─────────────────────────────────────────────────────────────────

const ATTR_ICONS = {
  DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
  MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
  INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
};
const iconFor = (attr) =>
  ATTR_ICONS[String(attr || "").toUpperCase()] ??
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/dice.png";

export function showTraitHUD({ roll, root }) {
  ensureStyles();
  // Mutual exclusion: close any open HUD first (silent, no cancel sfx)
  if (_active) {
    const old = _active;
    _active = null;
    _despawn(old.el, () => old._resolve(null));
  }
  playUiSfx(SFX.trait);

  const { A1, A2, dA, dB, rA, rB } = roll;
  const html = `<div class="fud-ih-card">
    <div class="fud-ih-header">Invoke Trait</div>
    <div class="fud-ih-title">Choose which die to reroll</div>
    <div class="fud-ih-dice-grid">
      <div class="fud-ih-die" data-which="A" tabindex="0" role="checkbox" aria-checked="false">
        <img class="fud-ih-die-icon" src="${iconFor(A1)}" alt="${esc(A1)}">
        <span class="fud-ih-die-label">d${esc(dA)}</span>
        <span class="fud-ih-die-val">${esc(rA)}</span>
      </div>
      <div class="fud-ih-die" data-which="B" tabindex="0" role="checkbox" aria-checked="false">
        <img class="fud-ih-die-icon" src="${iconFor(A2)}" alt="${esc(A2)}">
        <span class="fud-ih-die-label">d${esc(dB)}</span>
        <span class="fud-ih-die-val">${esc(rB)}</span>
      </div>
    </div>
    <div class="fud-ih-hint">Click one or both to select. Click again to deselect.</div>
    <div class="fud-ih-btns">
      <button class="fud-ih-btn fud-ih-confirm" data-confirm disabled>Reroll</button>
      <button class="fud-ih-btn fud-ih-cancel"  data-cancel>Cancel</button>
    </div>
  </div>`;

  const el = _spawnEl(html, root);

  return new Promise((resolve) => {
    _active = { type: "trait", el, _resolve: resolve };

    const confirmBtn = el.querySelector("[data-confirm]");
    const dieA = el.querySelector('[data-which="A"]');
    const dieB = el.querySelector('[data-which="B"]');

    const updateConfirm = () => {
      confirmBtn.disabled = !(dieA.classList.contains("on") || dieB.classList.contains("on"));
    };
    const toggle = (dieEl) => {
      const next = !dieEl.classList.contains("on");
      dieEl.classList.toggle("on", next);
      dieEl.setAttribute("aria-checked", String(next));
      updateConfirm();
    };

    for (const [dieEl, peer] of [[dieA, dieB], [dieB, dieA]]) {
      dieEl.addEventListener("click", () => toggle(dieEl));
      dieEl.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(dieEl); }
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); peer.focus(); }
      });
    }

    confirmBtn.addEventListener("click", () => {
      const aOn = dieA.classList.contains("on");
      const bOn = dieB.classList.contains("on");
      const choice = aOn && bOn ? "AB" : aOn ? "A" : bOn ? "B" : null;
      _resolveHud(el, resolve, choice, "confirm");
    });

    el.querySelector("[data-cancel]").addEventListener("click", () => {
      _resolveHud(el, resolve, null, "cancel");
    });
  });
}

// ── Bond HUD ──────────────────────────────────────────────────────────────────

function _svgHeart(state) {
  const fill = state === "pos" ? "#E85A70" : "#7B62C0";
  return `<svg viewBox="0 0 16 16" width="13" height="13" style="display:block;flex-shrink:0">
    <path d="M8 13.8s-4.8-3.3-6-5.3C1 5.7 2.1 3.4 4.1 3.2c1.2-.1 2.2.4 2.9 1.2.6-.8 1.6-1.3 2.9-1.2 2 .2 3 2.3 2.1 4.2-1.1 2-6 6.4-6 6.4z"
          fill="${fill}" stroke="#5A4637" stroke-width="1.1"/>
  </svg>`;
}

function _bondHearts(actor, bondIndex) {
  const P = actor?.system?.props ?? {};
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const SLOTS = [
    { pos: "admiration", neg: "inferiority" },
    { pos: "loyalty",    neg: "mistrust"    },
    { pos: "affection",  neg: "hatred"      },
  ];
  const hearts = [];
  for (const [i, s] of SLOTS.entries()) {
    const v = norm(P[`emotion_${bondIndex}_${i + 1}`]);
    if (v === s.pos) hearts.push("pos");
    else if (v === s.neg) hearts.push("neg");
  }
  hearts.sort((a, b) => (a === "pos" ? -1 : b === "pos" ? 1 : 0));
  return hearts;
}

function _bondRowHTML(bond, i, selIdx, actor) {
  const hearts = _bondHearts(actor, bond.index).map(_svgHeart).join("");
  return `<div class="fud-ih-bond-row${i === selIdx ? " sel" : ""}"
             data-bidx="${i}" tabindex="0" role="option"
             aria-selected="${i === selIdx ? "true" : "false"}">
    <span class="fud-ih-bond-name">${esc(bond.name)}</span>
    <span class="fud-ih-bond-hearts">${hearts}</span>
    <span class="fud-ih-bond-bonus">+${bond.bonus}</span>
  </div>`;
}

export async function showBondHUD({ bonds, attacker, root }) {
  const viable = bonds.filter((b) => (b?.bonus || 0) > 0);
  if (!viable.length) return null;
  // Skip dialog entirely for a single eligible bond
  if (viable.length === 1) return viable[0].index;

  ensureStyles();
  if (_active) {
    const old = _active;
    _active = null;
    _despawn(old.el, () => old._resolve(null));
  }
  playUiSfx(SFX.bond);

  let selectedIdx = 0;

  const buildList = () =>
    viable.map((b, i) => _bondRowHTML(b, i, selectedIdx, attacker)).join("");

  const html = `<div class="fud-ih-card">
    <div class="fud-ih-header">Invoke Bond</div>
    <div class="fud-ih-title">Choose a Bond</div>
    <div class="fud-ih-bond-list" role="listbox">${buildList()}</div>
    <div class="fud-ih-hint">Bond bonus is +1 per filled emotion (max +3).</div>
    <div class="fud-ih-btns">
      <button class="fud-ih-btn fud-ih-confirm" data-confirm>Invoke</button>
      <button class="fud-ih-btn fud-ih-cancel"  data-cancel>Cancel</button>
    </div>
  </div>`;

  const el = _spawnEl(html, root);

  return new Promise((resolve) => {
    _active = { type: "bond", el, _resolve: resolve };

    const list       = el.querySelector(".fud-ih-bond-list");
    const confirmBtn = el.querySelector("[data-confirm]");

    const refresh = () => {
      list.innerHTML = buildList();
      for (const row of list.querySelectorAll(".fud-ih-bond-row")) {
        const i = Number(row.dataset.bidx);
        row.addEventListener("mouseenter", playHoverSfx);
        row.addEventListener("click", () => { selectedIdx = i; refresh(); });
        row.addEventListener("keydown", (ev) => {
          if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
            ev.preventDefault();
            selectedIdx = Math.max(0, Math.min(viable.length - 1, selectedIdx + (ev.key === "ArrowUp" ? -1 : 1)));
            refresh();
            list.querySelector(`[data-bidx="${selectedIdx}"]`)?.focus();
          }
          if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); row.click(); }
        });
      }
    };
    refresh();

    confirmBtn.addEventListener("click", () => {
      const chosen = viable[selectedIdx];
      _resolveHud(el, resolve, chosen?.index ?? null, "confirm");
    });

    el.querySelector("[data-cancel]").addEventListener("click", () => {
      _resolveHud(el, resolve, null, "cancel");
    });
  });
}
