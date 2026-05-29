// Passive Manager — parchment overlay listing every Passive skill on an
// actor with a tri-state mode toggle (on / ask / off) per skill.
//
// Opens from:
//   - Turn UI's "Passive" command button (System page, second tab) —
//     non-FSM intercept: the menu click does NOT dispatch
//     DECLARE_COMMAND, it just spawns this overlay.
//   - Eventually: token HUD button (planned follow-up).
//
// Each radio writes `system.props.passive_mode` immediately on click —
// no Save/Apply button. Closing the overlay just hides it. Mode meanings:
//   on  → fire automatically every time conditions match
//   ask → prompt GM with Apply/Skip dialog (RAW "may" default)
//   off → never fire (lets the GM temporarily disable an intrusive
//         passive without deleting the skill)
//
// The displayed list is `actor.items` filtered by `skill_type === "Passive"`
// — actor copies, NOT world masters (the master is irrelevant here; this
// is per-actor configuration).

import { log, warn } from "./logger.js";

const CSS_ID  = "fud-passive-mgr-style";
const ROOT_ID = "fud-passive-mgr-root";

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      z-index: 97;
      pointer-events: none;
      transition: transform 180ms cubic-bezier(.2,.7,.2,1), opacity 180ms ease-out;
    }
    #${ROOT_ID}.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    #${ROOT_ID}.is-resolving { transform: translate(-50%, -50%) scale(0.96); opacity: 0; }

    .fud-passive-mgr-card {
      pointer-events: auto;
      width: 460px;
      max-width: 92vw;
      max-height: 72vh;
      display: flex; flex-direction: column;
      padding: 12px 14px 10px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }
    .fud-passive-mgr-title {
      font-size: 13.5px; font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid var(--fud-stroke, #5a6a85);
      margin-bottom: 8px;
    }
    .fud-passive-mgr-subtitle {
      font-size: 11px;
      text-align: center;
      color: var(--fud-ink-soft, #4b4338);
      opacity: 0.82;
      margin-bottom: 10px;
    }
    .fud-passive-mgr-list {
      display: flex; flex-direction: column; gap: 6px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      padding-right: 2px;
    }
    .fud-passive-mgr-row {
      display: grid; grid-template-columns: 40px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border-radius: 9px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      background: linear-gradient(180deg, #f3e8d0, #e7d6b4);
    }
    .fud-passive-mgr-row .icon img {
      width: 36px; height: 36px;
      border-radius: 6px; object-fit: cover;
      border: 0 !important; outline: 0 !important; background: transparent !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.30) !important;
    }
    .fud-passive-mgr-row .info { min-width: 0; overflow: hidden; }
    .fud-passive-mgr-row .primary {
      font-weight: 900; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fud-passive-mgr-row .secondary {
      font-size: 10.5px; opacity: 0.75; font-weight: 500;
      margin-top: 2px;
      line-height: 1.35;
      max-height: 2.7em;
      overflow: hidden;
    }
    .fud-passive-mgr-row .mode-group {
      display: flex;
      gap: 4px;
      border-radius: 8px;
      border: 1px solid rgba(40, 30, 18, 0.32);
      background: rgba(40, 30, 18, 0.10);
      padding: 2px;
    }
    .fud-passive-mgr-row .mode-btn {
      cursor: pointer;
      user-select: none;
      font-size: 10.5px; font-weight: 800;
      text-transform: uppercase; letter-spacing: 0.4px;
      padding: 4px 8px;
      border-radius: 5px;
      border: 1px solid transparent;
      color: #3a3228;
      transition: background 100ms ease, color 100ms ease, border-color 100ms ease;
    }
    .fud-passive-mgr-row .mode-btn:hover { background: rgba(255,255,255,0.40); }
    .fud-passive-mgr-row .mode-btn.is-on    { color: #194c19; border-color: rgba(40, 100, 40, 0.55); }
    .fud-passive-mgr-row .mode-btn.is-on.is-active   { background: rgba(40, 100, 40, 0.32); }
    .fud-passive-mgr-row .mode-btn.is-ask   { color: #4a3208; border-color: rgba(110, 80, 20, 0.55); }
    .fud-passive-mgr-row .mode-btn.is-ask.is-active  { background: rgba(180, 130, 40, 0.32); }
    .fud-passive-mgr-row .mode-btn.is-off   { color: #6b1e1e; border-color: rgba(110, 30, 30, 0.55); }
    .fud-passive-mgr-row .mode-btn.is-off.is-active  { background: rgba(110, 30, 30, 0.30); }

    .fud-passive-mgr-empty {
      font-style: italic;
      text-align: center;
      color: var(--fud-ink-soft, #4b4338);
      padding: 18px 8px;
      opacity: 0.75;
    }
    .fud-passive-mgr-close {
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      user-select: none;
      flex-shrink: 0;
      box-shadow: 0 3px 0 var(--fud-shadow, rgba(24, 28, 41, 0.55)), 0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
    }
    .fud-passive-mgr-close:hover { filter: brightness(1.05); }
  `;
  document.head.appendChild(css);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function stripHtml(html) {
  if (!html) return "";
  try {
    const div = document.createElement("div");
    div.innerHTML = String(html);
    return (div.textContent ?? div.innerText ?? "").trim();
  } catch { return String(html).replace(/<[^>]*>/g, "").trim(); }
}

// Return the first toggleable (non-force) row in the item's
// reaction_config_table marked `reaction_isPassive: true`, with its
// dict-key. Used to read/write the canonical `reaction_passive_mode`
// field. Returns null if the item has no toggleable passive row —
// either (a) no passive rows at all (legacy props-level skills), or
// (b) every passive row is mode="force" (engine-mandatory; not the
// user's call). See [[force-mode-for-engine-mandatory-reactions]].
function findPassiveRow(item) {
  const rc = item.system?.props?.reaction_config_table;
  if (!rc || typeof rc !== "object") return null;
  for (const key of Object.keys(rc)) {
    const row = rc[key];
    if (!row || row.$deleted) continue;
    if (row.reaction_isPassive !== true) continue;
    const mode = String(row.reaction_passive_mode ?? "").trim().toLowerCase();
    if (mode === "force") continue;  // engine-mandatory — invisible to UI
    return { key, row };
  }
  return null;
}

function readMode(item) {
  // Canonical path: reaction_config_table row's reaction_passive_mode.
  // The legacy top-level passive_mode / passive_optional fallback was
  // dropped 2026-05-30 along with the template columns. Items with
  // a stored ghost passive_mode value (from before the column was
  // removed) read as "ask" — the engine default. Re-author the
  // canonical row to fix.
  const passive = findPassiveRow(item);
  if (!passive) return "ask";
  const m = String(passive.row.reaction_passive_mode ?? "").trim().toLowerCase();
  // findPassiveRow already filters out "force", so we never see it
  // here. Tri-state ask/on/off only.
  if (m === "on" || m === "ask" || m === "off") return m;
  return "ask";
}

// Write a new mode. Canonical path only — the legacy top-level
// `passive_mode` fallback was dropped 2026-05-30 (CSB silently strips
// writes to non-template columns anyway). Items without a canonical
// row are filtered out of showPassiveManager, so this should never be
// called for one.
async function writeMode(item, next) {
  const passive = findPassiveRow(item);
  if (!passive) {
    warn(`PassiveManager: writeMode skipped — no canonical passive row on "${item.name}"`);
    return;
  }
  // Deep-merge the dict — write only the modified row, keep others.
  const rc = foundry.utils.deepClone(item.system.props.reaction_config_table ?? {});
  rc[passive.key] = { ...rc[passive.key], reaction_passive_mode: next };
  await item.update({ "system.props.reaction_config_table": rc });
}

function despawn() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.classList.remove("is-visible");
  root.classList.add("is-resolving");
  setTimeout(() => root.remove(), 200);
}

function buildRow({ item, container }) {
  const safeImg = item.img && !/['"<>\n\r]/.test(item.img) ? item.img : "icons/svg/aura.svg";
  const desc = stripHtml(item.system?.props?.description ?? "");
  const row = document.createElement("div");
  row.className = "fud-passive-mgr-row";
  row.innerHTML = `
    <div class="icon"><img src="${escapeHtml(safeImg)}" alt=""></div>
    <div class="info">
      <div class="primary">${escapeHtml(item.name)}</div>
      <div class="secondary">${escapeHtml(desc)}</div>
    </div>
    <div class="mode-group" role="radiogroup" aria-label="Passive mode for ${escapeHtml(item.name)}">
      <div class="mode-btn is-on"  data-mode="on"  role="radio" tabindex="0" title="Always fire">On</div>
      <div class="mode-btn is-ask" data-mode="ask" role="radio" tabindex="0" title="Prompt GM">Ask</div>
      <div class="mode-btn is-off" data-mode="off" role="radio" tabindex="0" title="Never fire">Off</div>
    </div>
  `;
  const refresh = () => {
    const cur = readMode(item);
    for (const btn of row.querySelectorAll(".mode-btn")) {
      btn.classList.toggle("is-active", btn.dataset.mode === cur);
      btn.setAttribute("aria-checked", btn.dataset.mode === cur ? "true" : "false");
    }
  };
  refresh();
  row.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.(".mode-btn");
    if (!btn) return;
    ev.stopPropagation();
    const next = btn.dataset.mode;
    if (next === readMode(item)) return;
    try {
      await writeMode(item, next);
      refresh();
      log(`PassiveManager: "${item.name}" → mode="${next}"`);
    } catch (e) { warn("PassiveManager: update failed", e); }
  });
  container.appendChild(row);
}

export function showPassiveManager({ actor }) {
  if (!actor) { warn("PassiveManager: called with no actor"); return; }
  // If one's already open, replace it (cheaper than animating-out first).
  despawn();
  ensureStyles();

  // Per [[force-mode-for-engine-mandatory-reactions]]: an item whose
  // ONLY passive rows are mode="force" has nothing toggleable — exclude
  // it from the manager. Items with at least one non-force passive row
  // still show. findPassiveRow already skips force rows, so a non-null
  // return means the item has at least one toggleable canonical row.
  // The legacy top-level passive_mode / passive_optional fallback was
  // dropped 2026-05-30 along with the template columns.
  const passives = (actor.items?.contents ?? []).filter((it) => {
    if (String(it.system?.props?.skill_type ?? "").toLowerCase() !== "passive") return false;
    return !!findPassiveRow(it);
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), game.i18n?.lang));

  const root = document.createElement("div");
  root.id = ROOT_ID;
  const card = document.createElement("div");
  card.className = "fud-passive-mgr-card";
  card.innerHTML = `
    <div class="fud-passive-mgr-title">Passives — ${escapeHtml(actor.name ?? "Actor")}</div>
    <div class="fud-passive-mgr-subtitle">Click a mode to change how each passive fires. Changes save instantly.</div>
    <div class="fud-passive-mgr-list" data-fud-pm-list></div>
    <div class="fud-passive-mgr-close" role="button" tabindex="0">Close</div>
  `;
  root.appendChild(card);
  document.body.appendChild(root);

  const list = card.querySelector("[data-fud-pm-list]");
  if (!passives.length) {
    list.innerHTML = `<div class="fud-passive-mgr-empty">No passive skills on this actor.</div>`;
  } else {
    for (const it of passives) buildRow({ item: it, container: list });
  }

  requestAnimationFrame(() => root.classList.add("is-visible"));

  // Close behaviour — Escape, click on Close, click outside the card.
  const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
  const onRoot = (ev) => { if (ev.target === root) close(); };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    root.removeEventListener("click", onRoot);
    despawn();
  };
  card.querySelector(".fud-passive-mgr-close").addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  root.addEventListener("click", onRoot);
  // Live-refresh when any of these items update from another surface
  // (e.g. CSB sheet edit). Foundry's updateItem hook fires globally;
  // we filter to items on this actor.
  const hookId = Hooks.on("updateItem", (item) => {
    if (item?.parent?.uuid !== actor.uuid) return;
    // Find this item's row and reapply the radio state.
    const row = list.querySelectorAll(".fud-passive-mgr-row")[
      passives.findIndex((p) => p.id === item.id)
    ];
    if (!row) return;
    const cur = readMode(item);
    for (const btn of row.querySelectorAll(".mode-btn")) {
      btn.classList.toggle("is-active", btn.dataset.mode === cur);
    }
  });
  const wrapClose = close;
  card.querySelector(".fud-passive-mgr-close").addEventListener("click", () => {
    Hooks.off("updateItem", hookId);
    wrapClose();
  });

  log(`PassiveManager: opened for ${actor.name} (${passives.length} passive${passives.length === 1 ? "" : "s"})`);
}

export const PassiveManager = {
  show: showPassiveManager,
  despawn,
};

// ── Token HUD button ────────────────────────────────────────────────────
//
// Injects a control-icon into the token HUD's right column. Click opens
// the same parchment overlay scoped to the token's actor — same surface
// as the in-turn "Passive" command button, available out of turn (and
// out of combat) too.
//
// Gated on:
//   - actor.isOwner (GMs always; players on PCs they own). Non-owners
//     can't write `item.update` anyway, so showing the button to them
//     would just produce permission errors on click.
//   - actor present + has at least one Passive-typed skill
//
// Idempotent: runs once on `renderTokenHUD`, which Foundry fires on
// every HUD render. We inject a fresh button each time (Foundry rebuilds
// the HUD DOM, so old buttons don't accumulate).

Hooks.on("renderTokenHUD", (hud, html) => {
  try {
    const actor = hud?.object?.actor;
    if (!actor) return;
    if (!actor.isOwner) return;
    const hasPassive = (actor.items?.contents ?? []).some((it) =>
      String(it.system?.props?.skill_type ?? "").toLowerCase() === "passive"
    );
    if (!hasPassive) return;

    // Foundry V12's HUD HTML may arrive as either a jQuery object or a
    // raw DOM element depending on the active app shim. Support both.
    const rootEl = html?.[0] ?? html;
    if (!rootEl?.querySelector) return;

    const rightCol = rootEl.querySelector(".col.right");
    if (!rightCol) return;

    const btn = document.createElement("div");
    btn.className = "control-icon fud-token-hud-passive";
    btn.setAttribute("data-action", "fud-passive-manager");
    btn.setAttribute("title", "Manage Passives");
    btn.setAttribute("aria-label", "Manage Passives");
    btn.innerHTML = `<i class="fa-solid fa-bolt-lightning"></i>`;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { PassiveManager.show({ actor }); }
      catch (e) { warn("token-HUD passive button: show failed", e); }
    });
    rightCol.appendChild(btn);
  } catch (e) { warn("renderTokenHUD passive injector threw", e); }
});
