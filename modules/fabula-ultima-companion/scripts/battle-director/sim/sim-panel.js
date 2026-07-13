// Sim Panel — the 🧪 dev tool. Pick an encounter, pick a party, run a hands-free
// playtest, read the verdict.
//
// Registers into the existing Developer Tools speed-dial (the 🛠️ button), next to
// Test Battle (⚔️) and the autopilot toggle (🤖) — see dev-tools-menu.js.
//
// Party selection is a CHECKLIST with no default: cloning is what keeps a sim off
// the real PCs, and ~150 actors in this world report hasPlayerOwner, so the tool
// must never guess who "the party" is. See sim-run.js.

import { log, warn } from "../logger.js";
import { registerDevTool, devToolsAnchorBottom, devToolsAnchorLeft } from "../dev-tools-menu.js";
import { run as simRun, abort as simAbort, resolveDbParty } from "./sim-run.js";
import { SimMode } from "./sim-mode.js";

const PANEL_ID = "fud-sim-panel";
const STYLE_ID = "fud-sim-style";
const LS_KEY = "fud-sim-last-config";

let _booted = false;

export function initSimPanel() {
  try {
    if (_booted) return;
    if (!game.user?.isGM) return;
    ensureStyle();
    registerDevTool({ id: "sim-playtest", icon: "🧪", label: "Auto-Playtest (sim)", onClick: openPanel });
    _booted = true;
    log("sim-panel: registered as dev tool");
  } catch (e) {
    warn("initSimPanel threw", e);
  }
}

// ── Candidate lists ─────────────────────────────────────────────────────────
// PCs: player-owned, with a main hand and some HP — that filters the ~150
// hasPlayerOwner actors down to things that can actually fight. Still a
// checklist: the dev confirms who's in.
function pcCandidates() {
  return game.actors
    .filter((a) => {
      const p = a.system?.props ?? {};
      const hp = Number(p.max_hp);
      return a.hasPlayerOwner && String(p.main_hand ?? "").trim() !== "" && Number.isFinite(hp) && hp > 0;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Enemies: CSB makes everything a "character", so NPCs are discriminated by
// props (same test test-battle-tool uses).
function enemyCandidates() {
  return game.actors
    .filter((a) => {
      const p = a.system?.props ?? {};
      return p.npc_rank != null || p.species != null;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") ?? {}; }
  catch { return {}; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
}

// ── Panel ───────────────────────────────────────────────────────────────────
async function openPanel() {
  document.getElementById(PANEL_ID)?.remove();

  const saved = loadConfig();
  const pcs = pcCandidates();
  const enemies = enemyCandidates();
  const dbParty = await resolveDbParty();   // the REAL party, per the DB actor

  const root = document.createElement("div");
  root.id = PANEL_ID;
  root.style.bottom = `${devToolsAnchorBottom()}px`;
  root.style.left = `${devToolsAnchorLeft()}px`;

  const enemyOpts = enemies
    .map((e) => `<option value="${e.uuid}">${escapeHtml(e.name)}</option>`)
    .join("");

  // Party ticks default to the DB-resolved party; a saved selection overrides.
  const preTicked = new Set(
    Array.isArray(saved.party) && saved.party.length ? saved.party : dbParty.map((m) => m.uuid)
  );
  const pcRows = pcs
    .map((p) => `
      <label class="fud-sim-pc">
        <input type="checkbox" value="${p.uuid}" ${preTicked.has(p.uuid) ? "checked" : ""}>
        <span>${escapeHtml(p.name)}</span>
        <em>${escapeHtml(String(p.system?.props?.max_hp ?? "?"))} HP</em>
      </label>`)
    .join("");

  root.innerHTML = `
    <div class="fud-sim-head">
      <span>🧪 Auto-Playtest</span>
      <div class="fud-sim-x" title="Close">✕</div>
    </div>
    <div class="fud-sim-body">
      <div class="fud-sim-note">
        Runs a REAL battle with nobody at the keyboard. The party is <b>cloned</b> —
        your actual PCs are never touched.
      </div>

      <label class="fud-sim-lbl">Encounter <em>(add as many kinds as you like)</em></label>
      <div class="fud-sim-addrow">
        <select class="fud-sim-enemy">${enemyOpts}</select>
        <input class="fud-sim-qty" type="number" min="1" max="12" value="1" title="How many">
        <div class="fud-sim-add" title="Add to the encounter">+</div>
      </div>
      <div class="fud-sim-group"></div>

      <label class="fud-sim-lbl">Party <em>(defaults to the DB party)</em></label>
      <div class="fud-sim-pcs">${pcRows || "<i>no eligible PCs found</i>"}</div>

      <label class="fud-sim-lbl">Phoenix Feathers <em>(revives the party walks in with)</em></label>
      <input class="fud-sim-feathers" type="number" min="0" max="9" value="${Number(saved.phoenixFeathers) || 0}">

      <label class="fud-sim-lbl">Zero Power / Fabula Points <em>(what they walk in with)</em></label>
      <div class="fud-sim-addrow">
        <input class="fud-sim-zp" type="number" min="0" max="10" value="${Number(saved.startingZp) || 0}" title="Zero Power each PC starts with (6 = charged)">
        <input class="fud-sim-fp" type="number" min="0" max="10" value="${saved.fabulaPoints ?? 3}" title="Fabula Points each PC starts with">
      </div>

      <label class="fud-sim-lbl">Expected rounds <em>(unresolved by here = badly designed)</em></label>
      <input class="fud-sim-exp" type="number" min="2" max="40" value="${Number(saved.expectedRounds) || 7}">

      <label class="fud-sim-lbl">Pace</label>
      <select class="fud-sim-pace">
        <option value="watch" ${saved.pace === "watch" ? "selected" : ""}>Watch — readable, like a replay</option>
        <option value="fast"  ${saved.pace !== "watch" && saved.pace !== "batch" ? "selected" : ""}>Fast — renders, no dwell</option>
        <option value="batch" ${saved.pace === "batch" ? "selected" : ""}>Batch — no card, unattended</option>
      </select>

      <label class="fud-sim-check">
        <input type="checkbox" class="fud-sim-react" ${saved.reactions === "skip" ? "" : "checked"}>
        <span>Card reactions with no policy: use them</span>
      </label>

      <div class="fud-sim-actions">
        <div class="fud-sim-btn fud-sim-run">Run</div>
        <div class="fud-sim-btn fud-sim-stop">Stop</div>
      </div>
      <div class="fud-sim-status"></div>
    </div>
  `;

  document.body.appendChild(root);

  const statusEl = root.querySelector(".fud-sim-status");
  const groupEl = root.querySelector(".fud-sim-group");
  const setStatus = (html, cls = "") => { statusEl.className = `fud-sim-status ${cls}`; statusEl.innerHTML = html; };

  // ── Encounter group (mirrors the Test Battle tool's mixed-enemy payload) ───
  let group = Array.isArray(saved.enemies) && saved.enemies.length ? [...saved.enemies] : [];

  const renderGroup = () => {
    if (!group.length) {
      groupEl.innerHTML = `<i class="fud-sim-empty">No enemies yet — pick one above and press +</i>`;
      return;
    }
    groupEl.innerHTML = group
      .map((g, i) => `
        <div class="fud-sim-grow">
          <span>${escapeHtml(g.name)}</span>
          <em>×${g.quantity}</em>
          <div class="fud-sim-del" data-i="${i}" title="Remove">✕</div>
        </div>`)
      .join("");
    groupEl.querySelectorAll(".fud-sim-del").forEach((b) => {
      b.addEventListener("click", () => { group.splice(Number(b.dataset.i), 1); renderGroup(); });
    });
  };
  renderGroup();

  root.querySelector(".fud-sim-add").addEventListener("click", () => {
    const sel = root.querySelector(".fud-sim-enemy");
    const uuid = sel.value;
    const name = sel.options[sel.selectedIndex]?.textContent ?? "?";
    const quantity = Math.max(1, Number(root.querySelector(".fud-sim-qty").value) || 1);
    if (!uuid) return;
    const existing = group.find((g) => g.uuid === uuid);
    if (existing) existing.quantity += quantity;
    else group.push({ uuid, name, quantity });
    renderGroup();
  });

  root.querySelector(".fud-sim-x").addEventListener("click", () => root.remove());

  root.querySelector(".fud-sim-stop").addEventListener("click", async () => {
    setStatus("Stopping…");
    await simAbort();
    setStatus("Stopped. Battle ended, clones swept.", "ok");
  });

  root.querySelector(".fud-sim-run").addEventListener("click", async () => {
    const party = [...root.querySelectorAll(".fud-sim-pcs input:checked")].map((i) => i.value);
    const expectedRounds = Math.max(2, Number(root.querySelector(".fud-sim-exp").value) || 7);
    const phoenixFeathers = Math.max(0, Number(root.querySelector(".fud-sim-feathers").value) || 0);
    const startingZp = Math.max(0, Number(root.querySelector(".fud-sim-zp").value) || 0);
    const fabulaPoints = Math.max(0, Number(root.querySelector(".fud-sim-fp").value) || 0);
    const pace = root.querySelector(".fud-sim-pace").value;
    const reactions = root.querySelector(".fud-sim-react").checked ? "apply" : "skip";

    if (!group.length) { setStatus("Add at least one enemy to the encounter.", "err"); return; }
    if (!party.length) { setStatus("Pick at least one party member.", "err"); return; }

    saveConfig({ enemies: group, party, expectedRounds, phoenixFeathers, startingZp, fabulaPoints, pace, reactions });
    setStatus("Running… the fight plays itself. Nothing here needs clicking.", "busy");

    const res = await simRun({ enemies: group, party, pace, reactions, expectedRounds, phoenixFeathers, startingZp, fabulaPoints });
    if (!res) { setStatus("Run failed — see the console.", "err"); return; }

    const pct = res.partyHpRemaining == null ? "?" : `${Math.round(res.partyHpRemaining * 100)}%`;
    const cls = res.outcome === "victory" ? "ok" : (res.outcome === "overtime" || res.outcome === "stalled") ? "warn" : "err";
    setStatus(`
      <b>${escapeHtml(res.outcome.toUpperCase())}</b> — ${res.rounds} round(s), party at ${pct} HP
      <div class="fud-sim-verdict">${escapeHtml(res.verdict)}</div>
      <div class="fud-sim-sub">${res.durationSec}s wall · full result in the console (<code>__simResult</code>)</div>
    `, cls);
    globalThis.__simResult = res;
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${PANEL_ID} {
  position: fixed; z-index: 82; width: 320px; max-height: 74vh; overflow-y: auto;
  background: linear-gradient(180deg,#232733,#171a21);
  border: 1px solid rgba(255,255,255,.18); border-radius: 10px;
  box-shadow: 0 8px 26px rgba(0,0,0,.6); color: #e8eaf0;
  font-size: 12px; font-family: var(--font-primary, sans-serif);
}
#${PANEL_ID} .fud-sim-head {
  display:flex; align-items:center; justify-content:space-between;
  padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.12);
  font-weight: 700; letter-spacing:.3px;
}
#${PANEL_ID} .fud-sim-x { cursor:pointer; opacity:.6; padding:0 4px; }
#${PANEL_ID} .fud-sim-x:hover { opacity:1; }
#${PANEL_ID} .fud-sim-body { padding: 10px; display:flex; flex-direction:column; gap:6px; }
#${PANEL_ID} .fud-sim-note {
  font-size: 11px; opacity:.72; line-height:1.45; margin-bottom:2px;
  border-left:2px solid rgba(255,216,102,.5); padding-left:7px;
}
#${PANEL_ID} .fud-sim-lbl { font-size:11px; opacity:.8; margin-top:4px; font-weight:600; }
#${PANEL_ID} .fud-sim-lbl em { font-style:normal; opacity:.55; font-weight:400; }
#${PANEL_ID} select, #${PANEL_ID} input[type=number] {
  width:100%; background:#11141a; color:#e8eaf0;
  border:1px solid rgba(255,255,255,.16); border-radius:5px; padding:4px 6px;
}
/* The dropdown LIST is drawn by the OS and does not inherit the select's colors —
   without this it renders as pale-on-pale and is unreadable. Style the options
   explicitly (and the disabled/selected states, which Chromium picks separately). */
#${PANEL_ID} select option {
  background:#11141a; color:#e8eaf0;
}
#${PANEL_ID} select option:checked,
#${PANEL_ID} select option:hover {
  background:#2f6d43; color:#ffffff;
}

/* Encounter builder */
#${PANEL_ID} .fud-sim-addrow { display:flex; gap:5px; align-items:center; }
#${PANEL_ID} .fud-sim-addrow .fud-sim-enemy { flex:1; min-width:0; }
#${PANEL_ID} .fud-sim-addrow .fud-sim-qty { width:52px; flex:none; }
#${PANEL_ID} .fud-sim-add {
  width:26px; height:26px; flex:none; display:flex; align-items:center; justify-content:center;
  border-radius:5px; cursor:pointer; font-weight:800; font-size:15px;
  background:#2e4a34; border:1px solid rgba(255,255,255,.18);
}
#${PANEL_ID} .fud-sim-add:hover { background:#3b6144; border-color:rgba(255,216,102,.6); }
#${PANEL_ID} .fud-sim-group {
  margin-top:5px; display:flex; flex-direction:column; gap:3px;
  border:1px solid rgba(255,255,255,.12); border-radius:5px; padding:5px; background:#11141a;
  min-height:26px;
}
#${PANEL_ID} .fud-sim-empty { opacity:.45; font-size:11px; }
#${PANEL_ID} .fud-sim-grow {
  display:flex; align-items:center; gap:6px; padding:2px 4px;
  background:rgba(255,255,255,.05); border-radius:4px;
}
#${PANEL_ID} .fud-sim-grow span { flex:1; }
#${PANEL_ID} .fud-sim-grow em { font-style:normal; opacity:.7; font-weight:700; }
#${PANEL_ID} .fud-sim-del { cursor:pointer; opacity:.5; padding:0 3px; }
#${PANEL_ID} .fud-sim-del:hover { opacity:1; color:#ff9a8f; }
#${PANEL_ID} .fud-sim-pcs {
  max-height: 132px; overflow-y:auto; border:1px solid rgba(255,255,255,.12);
  border-radius:5px; padding:4px; background:#11141a;
}
#${PANEL_ID} .fud-sim-pc { display:flex; align-items:center; gap:6px; padding:2px 3px; cursor:pointer; border-radius:3px; }
#${PANEL_ID} .fud-sim-pc:hover { background:rgba(255,255,255,.06); }
#${PANEL_ID} .fud-sim-pc span { flex:1; }
#${PANEL_ID} .fud-sim-pc em { font-style:normal; opacity:.5; font-size:10px; }
#${PANEL_ID} .fud-sim-check { display:flex; align-items:center; gap:6px; margin-top:6px; cursor:pointer; }
#${PANEL_ID} .fud-sim-actions { display:flex; gap:6px; margin-top:9px; }
#${PANEL_ID} .fud-sim-btn {
  flex:1; text-align:center; padding:6px 0; border-radius:6px; cursor:pointer; font-weight:700;
  border:1px solid rgba(255,255,255,.18); background:#2b3040;
}
#${PANEL_ID} .fud-sim-btn:hover { background:#394054; border-color:rgba(255,216,102,.6); }
#${PANEL_ID} .fud-sim-run { background:#2e4a34; }
#${PANEL_ID} .fud-sim-run:hover { background:#3b6144; }
#${PANEL_ID} .fud-sim-status { margin-top:8px; font-size:11px; line-height:1.5; min-height:14px; }
#${PANEL_ID} .fud-sim-status.busy { opacity:.8; }
#${PANEL_ID} .fud-sim-status.ok   { color:#8fe3a4; }
#${PANEL_ID} .fud-sim-status.warn { color:#ffd866; }
#${PANEL_ID} .fud-sim-status.err  { color:#ff9a8f; }
#${PANEL_ID} .fud-sim-verdict { margin-top:4px; color:#e8eaf0; opacity:.9; }
#${PANEL_ID} .fud-sim-sub { margin-top:3px; opacity:.5; font-size:10px; }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
