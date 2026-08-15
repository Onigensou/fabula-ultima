// Guest Roster — sheet UI.
//
// The CSB template gives us the DATA surface (a `guest_table` dynamic table with
// Name / Actor ID / In Party columns). What CSB cannot give us is a decent way
// to PUT an actor in it: its only affordance is a text field you paste an id
// into, which is how the neighbouring bench_id_* / away_id_* fields work and is
// the worst part of that sheet. So this layer adds the two things a Foundry user
// expects — drag an actor onto the panel, or pick one from a list — and shows a
// portrait per row so the roster is readable at a glance.
//
// Everything here is additive decoration over CSB's own render: the table still
// works untouched if this script never runs (paste an id, tick the box), which
// matters because CSB re-renders the sheet on every prop write.

import { addGuest, syncGuestRoster, readGuestRows, getRosterActor } from "./guest-roster-core.js";

const TAG = "[GuestRoster]";

// Actor names are user data and land inside innerHTML below.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]
));
const PANEL_CLASS = "fud-guest-roster";
const STYLE_ID = "fud-guest-roster-style";
const MARK = "fudGuestEnhanced";

// ── Styles ──────────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.${PANEL_CLASS} { position: relative; }
.${PANEL_CLASS}.fud-guest-dragover { outline: 2px dashed rgba(120,190,255,.9); outline-offset: 3px; border-radius: 6px; }
.fud-guest-bar { display: flex; align-items: center; gap: 8px; margin: 4px 0 6px; flex-wrap: wrap; }
.fud-guest-bar button { flex: 0 0 auto; width: auto; line-height: 1.6; padding: 0 10px; }
.fud-guest-hint { font-size: 11px; opacity: .7; font-style: italic; }
.fud-guest-portrait {
  width: 26px; height: 26px; border-radius: 4px; object-fit: cover;
  border: 1px solid rgba(0,0,0,.35); vertical-align: middle; margin-right: 6px;
}
.fud-guest-picker { max-height: 60vh; overflow-y: auto; }
.fud-guest-picker .fud-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 6px;
  border-radius: 4px; cursor: pointer;
}
.fud-guest-picker .fud-row:hover { background: rgba(120,190,255,.18); }
.fud-guest-picker img { width: 32px; height: 32px; object-fit: cover; border-radius: 4px; }
.fud-guest-search { width: 100%; margin-bottom: 6px; }
.fud-guest-count { font-size: 11px; opacity: .65; margin: 0 0 6px; }
.fud-guest-group {
  font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase;
  opacity: .6; font-weight: 700; margin: 10px 0 3px; padding: 0 6px;
  border-bottom: 1px solid rgba(0,0,0,.12);
}
.fud-guest-group:first-child { margin-top: 0; }
.fud-guest-empty-row { display: none; opacity: .7; padding: 8px 6px; font-style: italic; }
.fud-guest-none {
  opacity: .75; font-style: italic; padding: 6px 2px 2px; font-size: 12px;
}
.fud-guest-tally { font-size: 12px; font-weight: 400; opacity: .7; margin-left: 8px; }
tr.custom-system-dynamicRow.fud-guest-benched .fud-guest-portrait {
  filter: grayscale(1); opacity: .45;
}
tr.custom-system-dynamicRow.fud-guest-benched input[type="text"] {
  opacity: .55; font-style: italic;
}
`;
  document.head.appendChild(el);
}

// ── Actor picker ────────────────────────────────────────────────────────────
// Deliberately a plain searchable list rather than a compendium browser: the
// candidates are world actors, and the one the GM wants is nearly always one
// they can name.
async function openGuestPicker(rosterActor) {
  const rostered = new Set(
    readGuestRows(rosterActor).map((r) => r.id.replace(/^Actor\./i, ""))
  );
  const candidates = (game.actors?.contents ?? [])
    .filter((a) => a.id !== rosterActor.id)
    .filter((a) => !a.system?.props?.isParty_boolean)   // other party sheets are not creatures
    // CSB scaffolding: `_template` docs live in game.actors alongside real
    // creatures, and this world also keeps character-type blanks ("_CC Blank
    // PC", "_FabU Char Template v3.fire") that are authoring fixtures, not
    // anything you could field as a guest. Both are conventionally "_"-prefixed.
    .filter((a) => a.type !== "_template")
    .filter((a) => !a.name.startsWith("_"))
    .filter((a) => !rostered.has(a.id));

  if (!candidates.length) {
    ui.notifications?.info("Every eligible actor is already on the Guest roster.");
    return;
  }

  // Group by the GM's OWN folder tree. At this list length the sidebar folders
  // are the index they already think in, and a flat list throws that away.
  const folderPath = (a) => {
    const parts = [];
    for (let f = a.folder; f; f = f.folder) parts.unshift(f.name);
    return parts.length ? parts.join(" / ") : "No folder";
  };
  // Names starting with punctuation ("???") otherwise sort above everything,
  // so the first thing in the picker is junk.
  const sortKey = (n) => (/^[\p{L}\p{N}]/u.test(n) ? "0" : "1") + n.toLocaleLowerCase();
  const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name));

  const groups = new Map();
  for (const a of candidates) {
    const k = folderPath(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const groupNames = [...groups.keys()].sort((a, b) => {
    if (a === "No folder") return 1;          // ungrouped last
    if (b === "No folder") return -1;
    return a.localeCompare(b);
  });

  const rows = groupNames.map((g) => `
    <div class="fud-guest-group" data-group="${esc(g)}">${esc(g)}</div>
    ${groups.get(g).sort(byName).map((a) => `
      <div class="fud-row" data-actor-id="${a.id}" data-group="${esc(g)}">
        <img src="${esc(a.img ?? "icons/svg/mystery-man.svg")}" alt="${esc(a.name)}" />
        <span>${esc(a.name)}</span>
      </div>`).join("")}`).join("");

  const content = `
    <input type="text" class="fud-guest-search" placeholder="Search actors…" autofocus />
    <div class="fud-guest-count"><span class="fud-n">${candidates.length}</span> of ${candidates.length} actors</div>
    <div class="fud-guest-picker">${rows}
      <div class="fud-guest-empty fud-guest-empty-row"><i>No actor matches that search.</i></div>
    </div>`;

  const dlg = new Dialog({
    title: "Add Guest",
    content,
    buttons: { close: { label: "Cancel" } },
    default: "close",
    render: (html) => {
      const root = html[0] ?? html;
      const search = root.querySelector(".fud-guest-search");
      const list = [...root.querySelectorAll(".fud-row")];
      const empty = root.querySelector(".fud-guest-empty");
      const groupEls = [...root.querySelectorAll(".fud-guest-group")];
      const counter = root.querySelector(".fud-guest-count .fud-n");
      search?.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        const liveGroups = new Set();
        for (const r of list) {
          const hit = !q || r.textContent.toLowerCase().includes(q);
          r.style.display = hit ? "" : "none";
          if (hit) { shown++; liveGroups.add(r.dataset.group); }
        }
        // A group heading with no surviving rows under it is a lie.
        for (const g of groupEls) g.style.display = liveGroups.has(g.dataset.group) ? "" : "none";
        if (counter) counter.textContent = String(shown);
        if (empty) empty.style.display = shown ? "none" : "block";
        // Hiding rows does not resize the window, so a filtered list leaves a
        // tall dead area under the results. Re-fit to the visible content.
        dlg.setPosition({ height: "auto" });
      });
      for (const r of list) {
        r.addEventListener("click", async () => {
          const actor = game.actors.get(r.dataset.actorId);
          if (!actor) return;
          const res = await addGuest(actor);
          if (res.ok) ui.notifications?.info(`${actor.name} added as a Guest.`);
          else ui.notifications?.warn(`Could not add ${actor.name}: ${res.reason}`);
          // Close the dialog by its own header button — Dialog instances differ
          // across the app/appv2 split, so do not reach for an internal handle.
          r.closest(".app")?.querySelector("a.header-button.close")?.click();
        });
      }
    },
  }, { width: 420 });
  // Assign before rendering: the render callback closes over `dlg`, and a
  // chained `.render(true)` would leave it in the temporal dead zone.
  dlg.render(true);
}

// ── Panel enhancement ───────────────────────────────────────────────────────
function buildBar(rosterActor) {
  const bar = document.createElement("div");
  bar.className = "fud-guest-bar";

  const add = document.createElement("button");
  add.type = "button";                       // never submit the sheet form
  add.innerHTML = `<i class="fas fa-user-plus"></i> Add Guest`;
  add.addEventListener("click", (ev) => { ev.preventDefault(); openGuestPicker(rosterActor); });

  const sync = document.createElement("button");
  sync.type = "button";
  sync.innerHTML = `<i class="fas fa-rotate"></i> Sync`;
  sync.title = "Re-apply the Guest flag from this roster and refresh names.";
  sync.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const r = await syncGuestRoster();
    ui.notifications?.info(r?.ok
      ? `Guest roster synced — ${r.rostered} on roster, ${r.flagged} flagged, ${r.cleared} cleared.`
      : `Guest sync failed: ${r?.reason}`);
  });

  // No hint text here. It used to duplicate, near-verbatim, the line the
  // template already prints 20px below — and "how to add one" is day-one
  // information that belongs in the empty state, not in permanent chrome.
  // Drag is an accelerator; the dragover highlight teaches it.
  bar.append(add, sync);
  return bar;
}

// Portraits + deployed/benched state.
//
// The row cell carries the class "<tableKey>.<row>.<col>", so the actor id and
// the Deployed checkbox are both readable straight off the rendered row.
//
// Why state gets a VISUAL and not just the checkbox: everything loud in a row
// (portrait, name, id) is identical between deployed and benched, so the only
// difference was a 14px control at the far right edge — the quietest pixel on
// the panel carrying the most important fact about the row.
async function decorateRows(panel) {
  const rows = panel.querySelectorAll("tr.custom-system-dynamicRow");
  let deployed = 0;
  let benched = 0;

  for (const tr of rows) {
    const cellFor = (col) => [...tr.querySelectorAll("[class]")].find((el) =>
      [...el.classList].some((c) => c.startsWith("guest_table.") && c.endsWith(`.${col}`)));
    const idCell = cellFor("guest_id");
    const nameCell = cellFor("guest_name");
    const activeCell = cellFor("guest_active");
    if (!idCell || !nameCell) continue;

    const raw = (idCell.querySelector("input")?.value ?? idCell.textContent ?? "").trim();
    const actor = raw ? (game.actors?.get(raw.replace(/^Actor\./i, "")) ?? null) : null;

    const isDeployed = !!activeCell?.querySelector('input[type="checkbox"]')?.checked;
    tr.classList.toggle("fud-guest-benched", !isDeployed);
    if (raw) { if (isDeployed) deployed++; else benched++; }

    if (!tr.querySelector(".fud-guest-portrait")) {
      const img = document.createElement("img");
      img.className = "fud-guest-portrait";
      img.src = actor?.img ?? "icons/svg/mystery-man.svg";
      img.alt = actor?.name ?? "";
      // An actor-less row is what the table widget's own "+" button produces:
      // it looks structurally identical to a real guest but resolves to nothing.
      // Say so on the row rather than letting it pass for healthy.
      img.title = !raw ? "No actor — paste an ID, drop an actor, or delete this row"
        : actor ? actor.name : `Actor not found: ${raw}`;
      if (!actor) img.style.filter = "grayscale(1) brightness(.6)";
      nameCell.prepend(img);
    }
    if (!raw && !tr.querySelector(".fud-guest-none")) {
      const warn = document.createElement("div");
      warn.className = "fud-guest-none";
      warn.textContent = "No actor on this row — drop one here or delete it.";
      nameCell.appendChild(warn);
    }
  }
  return { deployed, benched };
}

// A live tally on the section header. Its siblings collapse by default and tell
// you nothing about what is inside; a count is what makes collapsing safe.
function setHeaderTally(panel, { deployed, benched }) {
  const details = panel.closest("details") ?? panel.parentElement?.closest("details");
  const title = details?.querySelector("summary .custom-system-panel-title")
    ?? details?.querySelector(".custom-system-panel-title")
    ?? panel.parentElement?.querySelector(".custom-system-panel-title");
  if (!title) return;

  title.querySelector(".fud-guest-tally")?.remove();
  const span = document.createElement("span");
  span.className = "fud-guest-tally";
  span.textContent = !deployed && !benched
    ? "— none yet"
    : `— ${deployed} deployed${benched ? `, ${benched} benched` : ""}`;
  title.appendChild(span);
}

// The empty state carries the "how do I add one" job, which is exactly where it
// is needed and exactly where it stops being noise once there are rows.
function setEmptyState(panel, hasRows) {
  const existing = panel.querySelector(".fud-guest-firstrun");
  if (hasRows) { existing?.remove(); return; }
  if (existing) return;
  const el = document.createElement("div");
  el.className = "fud-guest-firstrun";
  el.style.cssText = "opacity:.8; font-style:italic; padding:10px 2px 4px; font-size:12.5px;";
  el.textContent = "No guests yet — press Add Guest, or drag an actor from the sidebar onto this panel.";
  panel.appendChild(el);
}

function wireDropTarget(panel, rosterActor) {
  panel.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    panel.classList.add("fud-guest-dragover");
  });
  panel.addEventListener("dragleave", (ev) => {
    // Only clear when the pointer actually left the panel, not on every child
    // boundary crossing — otherwise the outline strobes while dragging across.
    if (!panel.contains(ev.relatedTarget)) panel.classList.remove("fud-guest-dragover");
  });
  panel.addEventListener("drop", async (ev) => {
    panel.classList.remove("fud-guest-dragover");
    let data = null;
    try { data = TextEditor.getDragEventData(ev); } catch { /* not a Foundry drag */ }
    if (!data || data.type !== "Actor") return;
    ev.preventDefault();
    ev.stopPropagation();

    const actor = await fromUuid(data.uuid).catch(() => null);
    if (!actor) { ui.notifications?.warn("Could not resolve the dropped actor."); return; }
    const res = await addGuest(actor);
    if (res.ok) {
      ui.notifications?.info(res.existed
        ? `${actor.name} was already a Guest — re-activated.`
        : `${actor.name} added as a Guest.`);
    } else {
      ui.notifications?.warn(`Could not add ${actor.name}: ${res.reason}`);
    }
  });
}

async function enhance(app, html) {
  if (!game.user?.isGM) return;
  if (!app.actor?.system?.props?.isParty_boolean) return;

  const rosterActor = await getRosterActor();
  if (!rosterActor || app.actor.id !== rosterActor.id) return;

  const root = html?.[0] ?? html;
  const panel = root?.querySelector?.(`.${PANEL_CLASS}`);
  if (!panel) return;   // template not yet applied on this sheet — nothing to do

  ensureStyles();
  const tally = await decorateRows(panel);
  setHeaderTally(panel, tally);
  setEmptyState(panel, tally.deployed + tally.benched > 0);

  // The bar and the listeners are per-RENDER: CSB rebuilds this DOM on every
  // prop write, so a guard flag on the element is enough and no teardown is
  // needed — the old node is already gone.
  if (panel.dataset[MARK] === "1") return;
  panel.dataset[MARK] = "1";
  panel.prepend(buildBar(rosterActor));
  wireDropTarget(panel, rosterActor);
}

Hooks.once("ready", () => {
  Hooks.on("renderActorSheet", (app, html) => {
    enhance(app, html).catch((e) => console.warn(TAG, "enhance failed", e));
  });
  console.debug(TAG, "sheet UI registered.");
});
