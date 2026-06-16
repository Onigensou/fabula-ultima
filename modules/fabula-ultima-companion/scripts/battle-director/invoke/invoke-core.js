// scripts/battle-director/invoke/invoke-core.js
// Pure logic for BD invoke — actor queries, payment, dialogs, dice math.
// No DOM coupling, no director reference. Dynamically imported by invoke-worker.js.

import { deriveCheck } from "../check.js";

// ── Resource detection ───────────────────────────────────────────────────────

function isVillainOrBoss(actor) {
  const P = actor?.system?.props ?? {};
  return !!(P.isVillain || P.isBoss);
}

export function getPointResource(actor) {
  return isVillainOrBoss(actor)
    ? { key: "ultima_point", label: "Ultima Point" }
    : { key: "fabula_point", label: "Fabula Point" };
}

export function canPay(actor) {
  const { key, label } = getPointResource(actor);
  const cur = Number(actor?.system?.props?.[key] ?? 0) || 0;
  return { ok: cur >= 1, key, label, cur };
}

export async function payPoint(actor) {
  const { key, label } = getPointResource(actor);
  const cur = Number(actor?.system?.props?.[key] ?? 0) || 0;
  if (cur < 1) return { ok: false, key, label, cur };
  try {
    await actor.update({ [`system.props.${key}`]: cur - 1 });
    return { ok: true, key, label, cur: cur - 1 };
  } catch (e) {
    console.warn("[BD][Invoke] payPoint failed:", e);
    return { ok: false, key, label, cur };
  }
}

// ── Bond reading ─────────────────────────────────────────────────────────────

export function readActorBonds(actor) {
  const P = actor?.system?.props ?? {};
  const bonds = [];
  for (let i = 1; i <= 6; i++) {
    const name = String(P[`bond_${i}`] ?? "").trim();
    if (!name) continue;
    const e1 = !!P[`emotion_${i}_1`];
    const e2 = !!P[`emotion_${i}_2`];
    const e3 = !!P[`emotion_${i}_3`];
    const filled = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
    const bonus = Math.min(3, Math.max(0, filled));
    bonds.push({ index: i, name, bonus, filled });
  }
  return bonds;
}

// ── Dice math ─────────────────────────────────────────────────────────────────

// Reroll one or both accuracy dice; keeps existing checkBonus and attributes.
// Returns a full roll object shaped like BD's rollCheck result.
export async function rerollDice({ roll, choice, actor }) {
  const dA = Number(roll.dA) || 6;
  const dB = Number(roll.dB) || 6;
  let rA = Number(roll.rA) || 0;
  let rB = Number(roll.rB) || 0;

  if (choice === "A" || choice === "AB") rA = (await new Roll(`1d${dA}`).evaluate()).total;
  if (choice === "B" || choice === "AB") rB = (await new Roll(`1d${dB}`).evaluate()).total;

  const fumbleThreshold = Math.max(1, Number(actor?.system?.props?.fumble_threshold ?? 1) || 1);
  const props      = actor?.system?.props ?? null;
  const checkBonus = Number(roll.checkBonus) || 0;
  const derived    = deriveCheck({ rA, rB, props, fumbleThreshold, checkBonus });

  return {
    ...roll,
    rA:       derived.rA,
    rB:       derived.rB,
    hr:       derived.hr,
    total:    derived.total,
    isCrit:   derived.isCrit,
    isFumble: derived.isFumble,
    opportunities: derived.isCrit && !derived.isFumble,
  };
}

// Apply a flat bond bonus (no re-roll). Returns a new roll object.
// HR, isCrit, isFumble are unchanged — bond only adds to the flat total.
export function applyBondBonus({ roll, bonus }) {
  const addBonus = Number(bonus) || 0;
  const newBonus = (Number(roll.checkBonus) || 0) + addBonus;
  const rA       = Number(roll.rA) || 0;
  const rB       = Number(roll.rB) || 0;
  return {
    ...roll,
    checkBonus: newBonus,
    total:      rA + rB + newBonus,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );

const ATTR_ICONS = {
  DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
  MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
  INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
};
const iconFor = (attr) =>
  ATTR_ICONS[(attr || "").toUpperCase()] ??
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/dice.png";

// ── Die-pick dialog ──────────────────────────────────────────────────────────

export function showTraitDialog({ roll }) {
  const { A1, A2, dA, dB, rA, rB } = roll;

  return new Promise((resolve) =>
    new Dialog({
      title: "Invoke Trait — Reroll",
      content: `<form><style>
        .fu-root{--parch-1:#f6ebd3;--parch-2:#efdfc3;--parch-3:#e7d3b1;--ink:#3b2a19;--shadow:rgba(0,0,0,.22);--accent:#e35151;}
        .fu-title{font-weight:700;margin:.25rem 0 .35rem;color:var(--ink);}
        .fu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.6rem;margin:.2rem 0 .6rem;}
        .fu-card{
          position:relative;display:flex;align-items:center;gap:.6rem;padding:.6rem .75rem;border-radius:12px;
          cursor:pointer;user-select:none;color:var(--ink);border:3px solid rgba(87,58,33,.95);
          background:radial-gradient(120% 80% at 50% 0%,rgba(255,255,255,.45) 0%,rgba(255,255,255,.15) 22%,transparent 40%),
            linear-gradient(180deg,var(--parch-1) 0%,var(--parch-2) 55%,var(--parch-3) 100%);
          box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 6px 14px var(--shadow);
          transition:filter .12s ease,transform .06s ease;
        }
        .fu-card:hover{filter:brightness(1.04);}
        .fu-card:active{transform:translateY(1px);}
        .fu-card.on{
          border-color:var(--accent);outline:2px solid rgba(227,81,81,.35);outline-offset:0;
          box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 6px 14px var(--shadow),0 0 14px rgba(227,81,81,.55);
          background:radial-gradient(120% 80% at 50% 0%,rgba(255,255,255,.65) 0%,rgba(255,255,255,.28) 22%,transparent 40%),
            linear-gradient(180deg,#fff3dc 0%,#f3e2bd 55%,#e8cea0 100%);
        }
        .fu-icon{width:40px;height:40px;object-fit:contain;border:none;background:transparent;border-radius:8px;}
        .fu-left{display:flex;align-items:center;gap:.5rem;min-width:0;}
        .fu-die{font-weight:800;white-space:nowrap;}
        .fu-spacer{flex:1 1 auto;}
        .fu-result{font-weight:900;font-size:22px;}
        .fu-hint{font-size:12px;opacity:.75;margin:.25rem 0 0;color:var(--ink);}
      </style>
      <div class="fu-root">
        <div class="fu-title">Choose which die to reroll</div>
        <div class="fu-grid">
          <button type="button" class="fu-card" data-which="A" data-sel="0" title="${esc(A1)}">
            <div class="fu-left">
              <img class="fu-icon" src="${iconFor(A1)}" alt="${esc(A1)}">
              <div class="fu-die">d${dA}</div>
            </div>
            <div class="fu-spacer"></div>
            <div class="fu-result">${rA}</div>
          </button>
          <button type="button" class="fu-card" data-which="B" data-sel="0" title="${esc(A2)}">
            <div class="fu-left">
              <img class="fu-icon" src="${iconFor(A2)}" alt="${esc(A2)}">
              <div class="fu-die">d${dB}</div>
            </div>
            <div class="fu-spacer"></div>
            <div class="fu-result">${rB}</div>
          </button>
        </div>
        <p class="fu-hint">Click one or both to select. Click again to deselect.</p>
      </div></form>`,
      buttons: {
        ok: {
          label: "Reroll",
          callback: (html) => {
            const root  = html[0];
            const aOn   = root.querySelector('[data-which="A"]')?.dataset.sel === "1";
            const bOn   = root.querySelector('[data-which="B"]')?.dataset.sel === "1";
            resolve(aOn && bOn ? "AB" : aOn ? "A" : bOn ? "B" : null);
          },
        },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "ok",
      close: () => resolve(null),
      render: (html) => {
        const root  = html[0];
        const btnA  = root.querySelector('[data-which="A"]');
        const btnB  = root.querySelector('[data-which="B"]');
        const okBtn = root.closest(".app")?.querySelector('.dialog-buttons button[data-button="ok"]');

        const toggle = (btn) => {
          btn.dataset.sel = btn.dataset.sel === "1" ? "0" : "1";
          btn.classList.toggle("on", btn.dataset.sel === "1");
          if (okBtn) okBtn.disabled = btnA.dataset.sel !== "1" && btnB.dataset.sel !== "1";
        };

        for (const b of [btnA, btnB]) {
          b.setAttribute("tabindex", "0");
          b.addEventListener("click", (ev) => { ev.preventDefault(); toggle(b); });
          b.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowLeft" || ev.key === "ArrowRight")
              (b === btnA ? btnB : btnA).focus();
            if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(b); }
          });
        }
        if (okBtn) okBtn.disabled = true;
      },
    }).render(true)
  );
}

// ── Bond-pick dialog ─────────────────────────────────────────────────────────

function svgHeart({ state = "pos", title = "" } = {}) {
  const fill = state === "pos" ? "#E85A70" : "#7B62C0";
  const t    = String(title).replace(/"/g, "&quot;");
  return `<span class="hm-heart-wrap" title="${t}">
    <svg class="hm-heart" viewBox="0 0 16 16" width="16" height="16">
      <path d="M8 13.8s-4.8-3.3-6-5.3C1 5.7 2.1 3.4 4.1 3.2c1.2-.1 2.2.4 2.9 1.2.6-.8 1.6-1.3 2.9-1.2 2 .2 3 2.3 2.1 4.2-1.1 2-6 6.4-6 6.4z"
            fill="${fill}" stroke="#5A4637" stroke-width="1.1"/>
    </svg>
  </span>`;
}

function bondHearts(actor, bondIndex) {
  const P    = actor?.system?.props ?? {};
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const SLOTS = [
    { pos: "admiration", neg: "inferiority", lp: "Admiration", ln: "Inferiority" },
    { pos: "loyalty",    neg: "mistrust",    lp: "Loyalty",    ln: "Mistrust"    },
    { pos: "affection",  neg: "hatred",      lp: "Affection",  ln: "Hatred"      },
  ];
  const vals = [norm(P[`emotion_${bondIndex}_1`]), norm(P[`emotion_${bondIndex}_2`]), norm(P[`emotion_${bondIndex}_3`])];
  const hearts = [];
  for (const [i, s] of SLOTS.entries()) {
    if (vals[i] === s.pos) hearts.push({ state: "pos", title: s.lp });
    else if (vals[i] === s.neg) hearts.push({ state: "neg", title: s.ln });
  }
  hearts.sort((a, b) => (a.state === "pos" ? -1 : b.state === "pos" ? 1 : 0));
  return hearts;
}

export async function showBondDialog({ bonds, attacker }) {
  const viable = bonds.filter((b) => (b?.bonus || 0) > 0);
  if (!viable.length) return null;
  if (viable.length === 1) return viable[0].index;

  let selectedIdx = 0;

  const rowHTML = (bond, idx, selIdx) => {
    const hearts = bondHearts(attacker, bond.index).map(svgHeart).join("");
    const sel    = idx === selIdx ? " selected" : "";
    return `<div class="hm-row${sel}" data-idx="${idx}" title="+${bond.bonus} from ${esc(bond.name)}" tabindex="0">
      <div class="hm-name">${esc(bond.name)}</div>
      <div class="hm-bar">${hearts}</div>
      <div class="hm-badge">+${bond.bonus}</div>
    </div>`;
  };

  const content = `<form class="hm"><style>
    .hm{--edge:#b79a6a;--sel:#FFBB55;--ink:#2b1f17;}
    .hm-wrap{padding:.4rem .25rem .2rem;}
    .hm-list{display:grid;gap:.35rem;max-height:420px;overflow:auto;}
    .hm-row{
      display:grid;grid-template-columns:1fr auto auto;align-items:center;
      gap:.55rem;padding:.45rem .6rem;border:2px solid var(--edge);border-radius:12px;
      background:linear-gradient(180deg,#fff5e1,#f2e2c4);cursor:pointer;user-select:none;
    }
    .hm-row:hover{filter:brightness(1.03);}
    .hm-row.selected{border-color:var(--sel);box-shadow:0 0 0 3px rgba(255,187,85,.25);}
    .hm-name{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .hm-bar{display:flex;gap:.18rem;}
    .hm-heart{width:16px;height:16px;}
    .hm-badge{font-size:18px;font-weight:400;font-style:italic;}
    .hm-foot{display:flex;justify-content:space-between;margin-top:.35rem;font-size:12px;color:#6b5b4a;}
  </style>
  <div class="hm-wrap">
    <div class="hm-list" data-list></div>
    <div class="hm-foot"><div>Bond bonus is +1 per filled emotion (max +3).</div></div>
  </div></form>`;

  return new Promise((resolve) =>
    new Dialog({
      title: "Invoke Bond — Choose a Bond",
      content,
      buttons: {
        ok: {
          label: "Invoke",
          callback: (html) => {
            const el = html[0].querySelector(".hm-row.selected");
            if (!el) return resolve(null);
            resolve(viable[Number(el.dataset.idx)]?.index ?? null);
          },
        },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "ok",
      close: () => resolve(null),
      render: (html) => {
        const root  = html[0];
        const list  = root.querySelector("[data-list]");
        const okBtn = root.closest(".app")?.querySelector('.dialog-buttons button[data-button="ok"]');

        const refresh = () => {
          list.innerHTML = viable.map((b, i) => rowHTML(b, i, selectedIdx)).join("");
          if (okBtn) okBtn.disabled = selectedIdx < 0;
          for (const el of list.querySelectorAll(".hm-row")) {
            el.addEventListener("click", () => { selectedIdx = Number(el.dataset.idx); refresh(); });
            el.addEventListener("keydown", (ev) => {
              if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
                ev.preventDefault();
                selectedIdx = Math.max(0, Math.min(viable.length - 1, selectedIdx + (ev.key === "ArrowUp" ? -1 : 1)));
                refresh();
                list.querySelector(`.hm-row[data-idx="${selectedIdx}"]`)?.focus();
              }
              if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); el.click(); }
            });
          }
        };
        refresh();
      },
    }).render(true)
  );
}
