// ============================================================================
// Ritual System — material picker.
//
// A modal list of every material the performer may offer: their own bag plus
// the main party actor's shared inventory. Picking one reduces the ritual's
// cost by its rarity (Common 10% → Legendary 50%).
//
// Resolves to:
//     undefined  dismissed, leave the current offering alone
//     null       explicitly cleared ("Offer nothing")
//     {…}        the chosen material
//
// The three-way return is why the caller compares against `undefined` rather
// than truthiness: "cleared" and "dismissed" must not do the same thing.
//
// Keyboard: ↑/↓ move, Z choose, X dismiss — the same scheme as the window that
// opens it, which parks its own key handler while this is up.
// ============================================================================

import { RITUAL_KEYS, RARITY_COLOR, playRitualSfx } from "./ritual-const.js";
import { gatherOfferableMaterials } from "./ritual-materials.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
const keyMatch = (ev, list) => list.includes(ev.key);

function rowHtml(m, i) {
  const color = RARITY_COLOR[String(m.rarity).toLowerCase()] ?? "#7d7466";
  const where = m.source === "self" ? "carried" : escapeHtml(m.actorName);
  return `
    <div class="oni-rmp-row" data-idx="${i}">
      <img class="rmp-icon" src="${escapeHtml(m.img)}" />
      <div class="rmp-mid">
        <div class="rmp-name">${escapeHtml(m.name)}</div>
        <div class="rmp-sub"><span class="rmp-rarity" style="color:${color}">${escapeHtml(m.rarity)}</span> · ${where} · ×${m.quantity}</div>
      </div>
      <div class="rmp-off">−${Math.round(m.discount * 100)}%</div>
    </div>`;
}

/**
 * @param {object} p
 * @param {{actor: Actor, name: string}} p.performer
 * @param {object|null} p.current  the currently offered material, if any
 */
export async function openMaterialPicker({ performer, current = null } = {}) {
  const materials = await gatherOfferableMaterials(performer.actor);

  return new Promise((resolve) => {
    let index = 0;
    let done = false;

    const root = document.createElement("div");
    root.className = "oni-rmp-overlay";

    const empty = !materials.length;
    root.innerHTML = `
      <div class="oni-rmp-frame">
        <div class="oni-rmp-header">
          <div class="title">Offer Material</div>
          <div class="sub">Rarer offerings cut deeper into the cost</div>
          <div class="oni-rmp-close" title="Back (X)">✕</div>
        </div>
        <div class="oni-rmp-list">
          ${empty
            ? `<div class="oni-rmp-empty">
                 <div>Neither <b>${escapeHtml(performer.name)}</b> nor the party carries any material.</div>
                 <div class="hint">Materials drop from defeated creatures and can be traded between characters.</div>
               </div>`
            : materials.map(rowHtml).join("")}
        </div>
        <div class="oni-rmp-footer">
          <span class="hint"><b>↑↓</b> Move <b>Z</b> Choose <b>X</b> Back</span>
          <button class="oni-ritual-btn ghost" data-act="none">Offer nothing</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add("visible"));
    playRitualSfx("SELECT");

    const rows = [...root.querySelectorAll(".oni-rmp-row")];

    const paint = () => {
      rows.forEach((r, i) => r.classList.toggle("focused", i === index));
      rows[index]?.scrollIntoView({ block: "nearest" });
    };

    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener("keydown", onKey, true);
      root.classList.remove("visible");
      setTimeout(() => root.remove(), 180);
      resolve(value);
    };

    const choose = (i) => {
      const m = materials[i];
      if (!m) return;
      playRitualSfx("ARM");
      finish({
        actorUuid: m.actorUuid, itemId: m.itemId,
        name: m.name, img: m.img, rarity: m.rarity, discount: m.discount,
      });
    };

    const onKey = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (keyMatch(ev, RITUAL_KEYS.CANCEL)) { playRitualSfx("CANCEL"); finish(undefined); return; }
      if (empty) return;
      if (keyMatch(ev, RITUAL_KEYS.DOWN)) { index = (index + 1) % rows.length; playRitualSfx("MOVE"); paint(); return; }
      if (keyMatch(ev, RITUAL_KEYS.UP))   { index = (index - 1 + rows.length) % rows.length; playRitualSfx("MOVE"); paint(); return; }
      if (keyMatch(ev, RITUAL_KEYS.CONFIRM)) { choose(index); return; }
    };
    window.addEventListener("keydown", onKey, true);

    rows.forEach((r, i) => {
      r.addEventListener("mouseenter", () => { index = i; paint(); });
      r.addEventListener("click", () => choose(i));
    });
    root.querySelector(".oni-rmp-close").addEventListener("click", () => { playRitualSfx("CANCEL"); finish(undefined); });
    // "Offer nothing" is only a change when something WAS offered; otherwise it
    // is indistinguishable from backing out, and returning null either way is
    // harmless.
    root.querySelector('[data-act="none"]').addEventListener("click", () => { playRitualSfx("CANCEL"); finish(current ? null : undefined); });
    root.addEventListener("click", (ev) => { if (ev.target === root) finish(undefined); });

    paint();
  });
}
