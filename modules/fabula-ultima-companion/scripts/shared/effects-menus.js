// ============================================================================
// Effects menus — FU.EffectsMenu (GM)
//
// Two small menus a control panel opens with an action button (user's layout,
// 2026-11-14: Control Panel → action button → that API's menu). Each one only
// collects who / what / how long and hands it to the API, which keeps every
// rule; the API reports to the feedback layer, so players see the batched
// System Message line or the flash + sound + Resource Panel.
//
//   FU.EffectsMenu.damage({ source, targets, preselect, marked, anchor })
//   FU.EffectsMenu.status({ source, targets, preselect, marked, anchor })
//     source     shown under the title, and the name damage is dealt by
//     targets    Actors to offer (default: the party)
//     preselect  actor uuids ticked when it opens (default: all)
//     marked     actor uuids with a red dot (e.g. failed the check)
//     anchor     element to open beside (default: last place it was dragged to)
//   → Promise<{ applied: boolean }> when the menu closes
//
//   Damage → FUCompanion.api.applyDamage.applyToActor (feedback: "show")
//   Status → FUCompanion.api.heldStatus.applyNow / inflict / remove
//   "Full manager…" → the Active Effect Manager window, same targets.
//
// Draggable by the title; the spot is remembered per menu on this browser.
// Mockup: https://claude.ai/artifact/Ng4yf9Eiss65fjwtKRBDcs
// ============================================================================

const TAG = "[FU EffectsMenu]";
const STYLE_ID = "fu-fxm-style";
const POS_KEY = (kind) => `fu-effects-menu-pos-${kind}`;
const ELEMENTS = [["physical", "Physical"], ["fire", "Fire"], ["ice", "Ice"], ["bolt", "Bolt"], ["earth", "Earth"], ["air", "Air"],
  ["light", "Light"], ["dark", "Dark"], ["poison", "Poison"], ["elementless", "No element"]];
// The usual suspects first; the rest of the game's statuses follow A–Z.
const FIRST = ["Slow", "Dazed", "Weak", "Shaken", "Poisoned", "Blind", "Burn", "Frozen", "Wet", "Silence", "Swift", "Strong", "Focus", "Clarity", "Awake"];

// Everything one Apply reports is one batch (one line / one flash), however long the writes take.
const asOneBatch = (fn) => (globalThis.FU?.Feedback?.group ?? ((f) => f()))(fn);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.fu-fxm{position:fixed;z-index:100051;width:360px;font-family:"Signika","Noto Sans","Segoe UI",sans-serif;color:#3a1e06;
  background:linear-gradient(168deg,#f8f0d4 0%,#ede0b0 100%);border:2px solid #c9a44a;border-radius:12px;
  box-shadow:0 0 0 2px #7a4e20,0 0 0 4px #b8865a,0 10px 30px rgba(0,0,0,.5);padding:14px 16px;font-size:14px;
  opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease}
.fu-fxm.in{opacity:1;transform:none}
.fu-fxm .gm{position:absolute;right:-2px;top:-2px;background:#7a2e18;color:#f3e6c4;font-size:11px;border-radius:0 10px 0 8px;padding:1px 8px}
.fu-fxm h3{margin:0 0 2px;font-size:17px;font-weight:400;border:0;font-family:inherit;color:inherit;cursor:move;user-select:none}
.fu-fxm .sub{color:#6b4a26;font-size:12.5px;margin-bottom:10px}
.fu-fxm button{font-family:inherit;font-size:13px;background:linear-gradient(180deg,#7a5230 0%,#5c3818 100%);color:#f3e6c4;
  border:1px solid #3d2410;border-radius:6px;padding:4px 12px;cursor:pointer;width:auto;line-height:1.5;margin:0}
.fu-fxm button:hover,.fu-fxm button:focus-visible{box-shadow:0 0 0 2px #c9a44a,0 0 8px rgba(201,164,74,.6);outline:none}
.fu-fxm button.hot{box-shadow:0 0 0 2px #c9a44a}
.fu-fxm button:disabled{opacity:.45;cursor:default;box-shadow:none}
.fu-fxm .foot{display:flex;gap:6px;justify-content:flex-end;align-items:center;margin-top:12px}
.fu-fxm .link{background:none;border:0;box-shadow:none;color:#7a4e20;text-decoration:underline;padding:4px 2px;margin-right:auto}
.fu-fxm .link:hover{box-shadow:none;color:#3a1e06}
.fu-fxm .who{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.fu-fxm .who button{position:relative;padding:0;border:0;background:none;box-shadow:none;display:flex;flex-direction:column;align-items:center;gap:2px;color:#3a1e06;font-size:11.5px}
.fu-fxm .who img{width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:50% 15%;border:2px solid transparent;background:#d9cdb3}
.fu-fxm .who button.on img{border-color:#c9a44a;box-shadow:0 0 0 2px #7a4e20}
.fu-fxm .who button:not(.on) img{filter:grayscale(.9);opacity:.5}
.fu-fxm .who .x{position:absolute;right:-2px;top:-2px;width:9px;height:9px;border-radius:50%;background:#a3261b;border:1px solid #fff3df}
.fu-fxm .fld{display:grid;grid-template-columns:76px 1fr;gap:8px 10px;align-items:center}
.fu-fxm .lbl{font-size:12.5px;color:#6b4a26}
.fu-fxm input,.fu-fxm select{font-family:inherit;font-size:13px;background:#fffaf0;border:1px solid #c9a44a;border-radius:5px;color:#3a1e06;height:28px;margin:0}
.fu-fxm input[type=number]{width:70px}
.fu-fxm input[type=search]{width:100%;margin-bottom:6px}
.fu-fxm input[type=checkbox]{height:auto;width:auto;margin-right:4px}
.fu-fxm .seg{display:inline-flex;justify-self:start;border:1px solid #c9a44a;border-radius:6px;overflow:hidden}
.fu-fxm .seg button{background:#fffaf0;color:#5a3a12;border:0;border-radius:0;padding:3px 10px;box-shadow:none}
.fu-fxm .seg button + button{border-left:1px solid #c9a44a}
.fu-fxm .seg button.on{background:#7a5230;color:#f3e6c4}
.fu-fxm .icons{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:2px 0 10px;max-height:132px;overflow:auto}
.fu-fxm .icons button{display:flex;align-items:center;gap:5px;padding:2px 5px;border-radius:6px;border:1px solid transparent;background:transparent;box-shadow:none;
  line-height:1.3;color:#3a1e06;font-size:12.5px;text-align:left;min-width:0}
.fu-fxm .icons button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fu-fxm .icons img{width:22px;height:22px;border:0;flex:none}
.fu-fxm .icons button.on{border-color:#c9a44a;background:rgba(201,164,74,.35);box-shadow:0 0 0 1px #c9a44a inset}
.fu-fxm .hint{font-size:12px;color:#6b4a26;margin-top:6px}`;
  document.head.appendChild(s);
}

async function partyActors() {
  try { return ((await globalThis.CampSystem?.Party?.resolve?.()) ?? []).map((e) => e.actor).filter(Boolean); }
  catch { return []; }
}

function statusList() {
  const all = (CONFIG.statusEffects ?? []).map((s) => ({ id: s.id, name: game.i18n.localize(s.name ?? s.label ?? ""), img: s.img ?? s.icon }))
    .filter((s) => s.id && s.name);
  const rank = (n) => { const i = FIRST.indexOf(n); return i < 0 ? 999 : i; };
  return all.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function readPos(kind) {
  try { const p = JSON.parse(localStorage.getItem(POS_KEY(kind)) ?? "null"); return p && Number.isFinite(p.left) ? p : null; } catch { return null; }
}
function savePos(kind, el) {
  try { localStorage.setItem(POS_KEY(kind), JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })); } catch {}
}
function place(el, kind, anchor) {
  const saved = readPos(kind);
  let left, top;
  if (saved) ({ left, top } = saved);
  else if (anchor?.getBoundingClientRect) { const r = anchor.getBoundingClientRect(); left = r.right + 14; top = r.top; }
  else { left = 530; top = 66; }
  left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, left));
  top = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, top));
  el.style.left = `${left}px`; el.style.top = `${top}px`;
}
function makeDraggable(el, kind) {
  el.addEventListener("pointerdown", (ev) => {
    if (!ev.target.closest("h3")) return;
    ev.preventDefault();
    const dx = ev.clientX - el.offsetLeft, dy = ev.clientY - el.offsetTop;
    const move = (e) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 40, e.clientX - dx))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 30, e.clientY - dy))}px`;
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); savePos(kind, el); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

// One menu of each kind at a time; opening one again replaces it.
const open = new Map();   // kind → { el, done }

async function openMenu(kind, opts, renderBody) {
  if (!game.user?.isGM) { ui.notifications?.warn?.("Effects menus are for the GM."); return { applied: false }; }
  ensureStyle();
  open.get(kind)?.done(false);
  const actors = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : await partyActors();
  const st = {
    t: new Set(Array.isArray(opts.preselect) ? opts.preselect : actors.map((a) => a.uuid)),
    marked: new Set(opts.marked ?? []),
    busy: false,
  };
  const el = document.createElement("div");
  el.className = "fu-fxm";
  el.dataset.kind = kind;
  document.body.appendChild(el);
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  let applied = false;
  const done = (ok) => {
    if (ok) applied = true;
    open.delete(kind);
    el.classList.remove("in");
    setTimeout(() => el.remove(), 200);
    resolve({ applied });
  };
  open.set(kind, { el, done });

  const who = () => `<div class="who">${actors.map((a) => `<button type="button" data-w="${a.uuid}" class="${st.t.has(a.uuid) ? "on" : ""}"
      title="${st.marked.has(a.uuid) ? "Failed the check" : ""}">${st.marked.has(a.uuid) ? `<span class="x"></span>` : ""}<img src="${esc(a.img)}" alt="">${esc(a.name)}</button>`).join("")}</div>`;
  const ctx = {
    st, actors, el, who, opts, esc,
    targets: () => actors.filter((a) => st.t.has(a.uuid)),
    close: () => done(false),
    finish: () => done(true),
    render: () => {
      el.innerHTML = `<span class="gm">GM</span>` + renderBody(ctx);
      el.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => { st.t.has(b.dataset.w) ? st.t.delete(b.dataset.w) : st.t.add(b.dataset.w); ctx.render(); });
      el.querySelector("[data-close]")?.addEventListener("click", () => done(false));
      ctx.bind?.();
    },
  };
  ctx.render();
  place(el, kind, opts.anchor);
  makeDraggable(el, kind);
  requestAnimationFrame(() => el.classList.add("in"));
  return result;
}

// ── Deal Damage ─────────────────────────────────────────────────────────
function damage(opts = {}) {
  const d = { kind: "hp", amount: Number(opts.amount) > 0 ? Number(opts.amount) : 10, element: opts.element ?? "physical", ignoreDR: false };
  return openMenu("damage", opts, (ctx) => {
    ctx.bind = () => {
      const el = ctx.el;
      el.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { d.kind = b.dataset.k; ctx.render(); });
      el.querySelector("#fu-fxm-amt").onchange = (e) => { d.amount = Math.max(0, Number(e.target.value) || 0); };
      el.querySelector("#fu-fxm-el")?.addEventListener("change", (e) => { d.element = e.target.value; });
      el.querySelector("#fu-fxm-dr")?.addEventListener("change", (e) => { d.ignoreDR = e.target.checked; });
      el.querySelector("[data-apply]").onclick = async () => {
        const amt = el.querySelector("#fu-fxm-amt"); d.amount = Math.max(0, Number(amt.value) || 0);
        const targets = ctx.targets();
        if (!targets.length || ctx.st.busy) return;
        ctx.st.busy = true; ctx.render();
        const api = globalThis.FUCompanion?.api?.applyDamage;
        await asOneBatch(async () => {
          for (const actor of targets) {
            try {
              await api?.applyToActor?.({
                baseDamage: d.amount, valueType: d.kind === "mp" ? "mp" : "hp", isRecovery: d.kind === "heal",
                elementType: d.kind === "hp" ? d.element : "elementless", ignoreDR: d.ignoreDR,
                targetActor: actor, attackerName: ctx.opts.source || "Damage", sourceType: "Tile",
                verbosity: "silent", feedback: "show",
              });
            } catch (e) { console.warn(TAG, `damage failed on ${actor.name}`, e); }
          }
        });
        ctx.finish();
      };
    };
    return `<h3 title="Drag to move">Deal Damage</h3><div class="sub">${esc(ctx.opts.source ?? "")}</div>
      ${ctx.who()}
      <div class="fld">
        <span class="lbl">Type</span><span class="seg">${[["hp", "Damage"], ["heal", "Recovery"], ["mp", "MP loss"]]
          .map(([k, l]) => `<button type="button" data-k="${k}" class="${d.kind === k ? "on" : ""}">${l}</button>`).join("")}</span>
        <span class="lbl">Amount</span><input type="number" id="fu-fxm-amt" min="0" max="999" value="${d.amount}">
        ${d.kind === "hp" ? `<span class="lbl">Element</span><select id="fu-fxm-el">${ELEMENTS.map(([k, l]) => `<option value="${k}" ${k === d.element ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span></span><label class="lbl"><input type="checkbox" id="fu-fxm-dr" ${d.ignoreDR ? "checked" : ""}>Ignore damage reduction</label>` : ""}
      </div>
      <div class="foot"><button type="button" data-close>Cancel</button><button type="button" class="hot" data-apply ${ctx.st.busy || !ctx.st.t.size ? "disabled" : ""}>Apply</button></div>`;
  });
}

// ── Apply Status ────────────────────────────────────────────────────────
function status(opts = {}) {
  const list = statusList();
  const s = { mode: "add", timing: opts.timing === "held" ? "held" : "now", rounds: 3, q: "", picked: [] };
  return openMenu("status", opts, (ctx) => {
    ctx.bind = () => {
      const el = ctx.el;
      el.querySelectorAll("[data-s]").forEach((b) => b.onclick = () => { const id = b.dataset.s; s.picked = s.picked.includes(id) ? s.picked.filter((x) => x !== id) : [...s.picked, id]; ctx.render(); });
      el.querySelectorAll("[data-md]").forEach((b) => b.onclick = () => { s.mode = b.dataset.md; ctx.render(); });
      el.querySelectorAll("[data-tm]").forEach((b) => b.onclick = () => { s.timing = b.dataset.tm; ctx.render(); });
      el.querySelector("#fu-fxm-r")?.addEventListener("change", (e) => { s.rounds = Math.max(1, Number(e.target.value) || 3); ctx.render(); });
      const q = el.querySelector("#fu-fxm-q");
      q.oninput = () => { s.q = q.value; const pos = q.selectionStart; ctx.render(); const n = ctx.el.querySelector("#fu-fxm-q"); n.focus(); n.setSelectionRange(pos, pos); };
      el.querySelector("[data-full]")?.addEventListener("click", () => {
        globalThis.FUCompanion?.api?.activeEffectManager?.ui?.open?.({ targetActorUuids: ctx.targets().map((a) => a.uuid), source: ctx.opts.source });
        ctx.close();
      });
      el.querySelector("[data-apply]").onclick = async () => {
        const targets = ctx.targets();
        if (!targets.length || !s.picked.length || ctx.st.busy) return;
        ctx.st.busy = true; ctx.render();
        const hs = globalThis.FUCompanion?.api?.heldStatus;
        await asOneBatch(async () => {
          for (const id of s.picked) {
            try {
              if (s.mode === "remove") await hs?.remove?.({ actors: targets, status: id });
              else if (s.timing === "held") await hs?.inflict?.({ actors: targets, status: id, source: ctx.opts.source ?? "" });
              else await hs?.applyNow?.({ actors: targets, status: id, steps: s.rounds, source: ctx.opts.source ?? "" });
            } catch (e) { console.warn(TAG, `status ${id} failed`, e); }
          }
        });
        ctx.finish();
      };
    };
    const q = s.q.trim().toLowerCase();
    const shown = list.filter((x) => !q || x.name.toLowerCase().includes(q));
    const adding = s.mode === "add";
    return `<h3 title="Drag to move">Apply Status</h3><div class="sub">${esc(ctx.opts.source ?? "")}</div>
      ${ctx.who()}
      <input type="search" id="fu-fxm-q" placeholder="Search ${list.length} statuses" value="${esc(s.q)}" aria-label="Search statuses">
      <div class="icons">${shown.map((x) => `<button type="button" data-s="${esc(x.id)}" class="${s.picked.includes(x.id) ? "on" : ""}" title="${esc(x.name)}"><img src="${esc(x.img)}" alt=""><span>${esc(x.name)}</span></button>`).join("")}</div>
      <div class="fld">
        <span class="lbl">Action</span><span class="seg">${[["add", "Inflict"], ["remove", "Remove"]].map(([k, l]) => `<button type="button" data-md="${k}" class="${s.mode === k ? "on" : ""}">${l}</button>`).join("")}</span>
        ${adding ? `<span class="lbl">Lasts</span><span class="seg">${[["now", "Rounds"], ["held", "Until next battle"]].map(([k, l]) => `<button type="button" data-tm="${k}" class="${s.timing === k ? "on" : ""}">${l}</button>`).join("")}</span>
        ${s.timing === "now" ? `<span class="lbl">Rounds</span><input type="number" id="fu-fxm-r" min="1" max="9" value="${s.rounds}">` : ""}` : ""}
      </div>
      <div class="hint">${!adding ? "Removes the picked statuses, including ones held for the next battle."
        : s.timing === "held" ? "Held while exploring, counts down in the next battle. A Rest cures it." : `Counts as ${s.rounds} steps while exploring.`}</div>
      <div class="foot"><button type="button" class="link" data-full title="The full Active Effect Manager: custom effects, duplicate rules">Full manager…</button>
        <button type="button" data-close>Cancel</button><button type="button" class="hot" data-apply ${ctx.st.busy || !ctx.st.t.size || !s.picked.length ? "disabled" : ""}>${adding ? "Apply" : "Remove"}</button></div>`;
  });
}

function close(kind) {
  if (kind) open.get(kind)?.done(false);
  else for (const m of [...open.values()]) m.done(false);
}

globalThis.FU = globalThis.FU ?? {};
globalThis.FU.EffectsMenu = Object.freeze({ damage, status, close });
