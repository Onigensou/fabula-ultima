// ============================================================================
// Contest Check — the "Contest" tab of the GM's Request Check dialog
//
// File: scripts/check-requester/cr-contest-setup.js
// Spec: the setup dialog in the approved mockup (round 2-5).
//
// Sides (2-4). Each side is filled from any of:
//   source tabs  Party · In this scene · On stage (Theatre) · Recent · All actors
//   drag & drop  an actor from Foundry's Actors sidebar onto a side (or "+ Side")
//   buttons      Selected token · Targeted · Team (a side whose best roller rolls)
// "Every side rolls the same Check" (RAW default) mirrors side A's attributes.
// Mode: One-off contest, or Conflict — the winner pushes a Clock.
//
//   ONI.ContestSetup.mount(hostEl)  -> draws the tab into the dialog
//   ONI.ContestSetup.collect()      -> ONI.Contest.request options, or null
// ============================================================================
(() => {
  const ONI = globalThis.ONI ??= {};
  const TAG = "[ONI][ContestSetup]";
  if (ONI.ContestSetup) return;
  const MODULE_ID = "fabula-ultima-companion";
  const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
  const ATTRS = ["DEX", "INS", "MIG", "WLP"];
  const ICON = { MIG: `${FORGE}/Item%20Icon/asan.png`, DEX: `${FORGE}/Item%20Icon/boot.png`, WLP: `${FORGE}/Item%20Icon/stat.png`, INS: `${FORGE}/Item%20Icon/book.png` };
  const RECENT_FLAG = "contestRecent", RECENT_MAX = 8;
  const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  const STYLE_ID = "oni-ct-setup-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
.oni-cts{display:flex;flex-direction:column;gap:9px;color:#3b2a19}
.oni-cts img{border:none!important;background:none!important;box-shadow:none!important}
.oni-cts .sides{display:flex;gap:8px;align-items:stretch;overflow-x:auto;padding:4px 2px}
.oni-cts .slot{flex:1 0 140px;border:2px dashed rgba(91,63,38,.5);border-radius:12px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:5px;background:rgba(255,255,255,.25);min-width:0;position:relative;cursor:pointer}
.oni-cts .slot.sel{border-style:solid;border-color:#3b2a19;box-shadow:0 0 0 2px rgba(59,42,25,.2)}
.oni-cts .slot.drop{border-color:#14b8a6;background:rgba(20,184,166,.15)}
.oni-cts .slot img.sp{height:58px;max-width:100%;object-fit:contain}
.oni-cts .slot .sn{font-weight:700;font-size:13px;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oni-cts .slot .sh{font-size:10px;letter-spacing:.14em;font-weight:700;opacity:.6}
.oni-cts .slot .empty{height:58px;display:flex;align-items:center;justify-content:center;font-size:11px;opacity:.55;text-align:center}
.oni-cts .slot .x{position:absolute;top:2px;right:4px;border:0;background:none;cursor:pointer;font-size:13px;opacity:.5;color:#3b2a19;width:auto;line-height:1;padding:2px}
.oni-cts .slot .qa{display:flex;gap:3px;flex-wrap:wrap;justify-content:center}
.oni-cts .slot .qa button{font:600 10.5px Signika,sans-serif;padding:2px 6px;border-radius:6px;border:1px solid rgba(91,63,38,.45);background:rgba(255,255,255,.5);color:#3b2a19;cursor:pointer;width:auto;line-height:1.3}
.oni-cts .slot .qa button.on{background:#3b2a19;color:#fbe9b7}
.oni-cts .slot .team{font-size:10.5px;text-align:center;opacity:.8;line-height:1.3}
.oni-cts .slot.add{justify-content:center;opacity:.75;flex:0 0 86px;font-weight:700}
.oni-cts .vsx{align-self:center;font-family:Cinzel,Signika,serif;font-weight:900;font-size:18px;opacity:.6}
.oni-cts .pk{display:flex;gap:3px;align-items:center;flex-wrap:wrap;justify-content:center}
.oni-cts .pick{display:flex;align-items:center;gap:1px;border:1.5px solid rgba(91,63,38,.6);border-radius:8px;padding:1px 2px;background:rgba(255,255,255,.4)}
.oni-cts .pick button{border:0;background:none;cursor:pointer;font-size:9px;opacity:.6;padding:2px;color:#3b2a19;width:auto;line-height:1}
.oni-cts .pick img{width:18px;height:18px}
.oni-cts .pick span{font-size:10.5px;font-weight:700;width:26px;text-align:center}
.oni-cts .pk.locked .pick{opacity:.5}
.oni-cts .same{font-size:12px;display:flex;gap:6px;align-items:center;justify-content:center;text-align:center}
.oni-cts .src{display:flex;gap:4px;flex-wrap:wrap}
.oni-cts .tab{font:600 11.5px Signika,sans-serif;padding:4px 8px;border-radius:8px;border:1.5px solid rgba(91,63,38,.5);background:rgba(255,255,255,.35);color:#3b2a19;cursor:pointer;width:auto;line-height:1.3}
.oni-cts .tab.on{background:#3b2a19;color:#fbe9b7;border-color:#3b2a19}
.oni-cts .search{font:13px Signika,sans-serif;padding:5px 8px;border-radius:8px;border:1.5px solid rgba(91,63,38,.5);background:rgba(255,255,255,.6);color:#3b2a19;width:100%;box-sizing:border-box}
.oni-cts .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;max-height:180px;overflow:auto}
.oni-cts .card{border:1.5px solid rgba(91,63,38,.35);border-radius:10px;padding:5px;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;background:rgba(255,255,255,.3)}
.oni-cts .card:hover{border-color:rgba(91,63,38,.8)}
.oni-cts .card.in{border-color:#3b2a19;background:rgba(245,197,66,.25)}
.oni-cts .card img{height:44px;max-width:100%;object-fit:contain}
.oni-cts .card .cn{font-size:11px;font-weight:700;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oni-cts .card .cw{font-size:9.5px;opacity:.6;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oni-cts .srcnote{font-size:11.5px;opacity:.75;line-height:1.35}
.oni-cts .none{font-size:11.5px;opacity:.6;font-style:italic;padding:6px}
.oni-cts .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px}
.oni-cts .row input[type=text]{font:13px Signika,sans-serif;padding:4px 7px;border-radius:7px;border:1.5px solid rgba(91,63,38,.5);background:rgba(255,255,255,.6);color:#3b2a19;flex:1;min-width:120px;height:auto}
.oni-cts .row select{font:12.5px Signika,sans-serif;padding:3px;border-radius:6px;border:1.5px solid rgba(91,63,38,.5);background:rgba(255,255,255,.6);color:#3b2a19;max-width:100%;width:auto;height:auto}
`;
    document.head.appendChild(s);
  }

  // ── State (per dialog) ───────────────────────────────────────────────────
  let S = null;   // { host, slots:[{uuid|null, team:[uuid]|null, attrs:[A,B]}], sel, src, q, msg, same, party:[actor] }

  const actorOf = (uuid) => { try { const d = fromUuidSync(uuid); return d?.documentName === "Actor" ? d : (d?.actor ?? null); } catch (_) { return null; } };
  const imgOf = (a) => String(a?.system?.props?.sprite_standard ?? "").trim() || a?.prototypeToken?.texture?.src || a?.img || "icons/svg/mystery-man.svg";
  const getDie = (a, attr) => Math.min(Number(a?.system?.props?.[`${attr.toLowerCase()}_current`]) || 8, 12);

  async function loadParty() {
    try {
      const props = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.())?.db?.system?.props ?? {};
      const out = [];
      for (let i = 1; i <= 4; i++) { const id = String(props[`member_id_${i}`] ?? "").trim(); if (!id) continue; const a = actorOf(id.includes(".") ? id : `Actor.${id}`); if (a) out.push(a); }
      return out;
    } catch (_) { return []; }
  }
  // Actors whose Theatre portraits are on stage right now (synced to every client).
  function onStage() {
    const t = globalThis.Theatre?.instance;
    return (t?.portraitDocks ?? [])
      .filter((i) => i?.dockContainer && !i.deleting && String(i.imgId ?? "").startsWith("theatre-"))
      .map((i) => game.actors?.get(String(i.imgId).replace(/^theatre-/, ""))).filter(Boolean);
  }
  function inScene() {
    const seen = new Set(), out = [];
    for (const t of canvas?.scene?.tokens ?? []) { const a = t.actor; if (!a || seen.has(a.uuid)) continue; seen.add(a.uuid); out.push(a); }
    return out;
  }
  const recent = () => (game.user?.getFlag?.(MODULE_ID, RECENT_FLAG) ?? []).map(actorOf).filter(Boolean);
  async function remember(uuids) {
    const list = [...new Set([...uuids, ...(game.user?.getFlag?.(MODULE_ID, RECENT_FLAG) ?? [])])].slice(0, RECENT_MAX);
    try { await game.user?.setFlag?.(MODULE_ID, RECENT_FLAG, list); } catch (_) {}
  }

  const SOURCES = [
    { id: "party", name: "Party", note: "The active party.", list: () => S.party },
    { id: "scene", name: "In this scene", note: "Every token on the current map.", list: inScene },
    { id: "stage", name: "On stage", note: "Portraits up in a Theatre dialogue right now, so the NPC you are talking to is here even with no token.", list: onStage },
    { id: "recent", name: "Recent", note: "The last actors you put into a contest.", list: recent },
    { id: "all", name: "All actors", note: "Every actor in the world, including NPCs never placed on a map.", list: () => game.actors?.contents ?? [] },
  ];

  // ── Mount ────────────────────────────────────────────────────────────────
  async function mount(host) {
    if (!host) return;
    if (S?.host === host) return;
    ensureStyle();
    const party = await loadParty();
    const sel = canvas?.tokens?.controlled?.[0]?.actor ?? null;
    const tgt = game.user?.targets?.first?.()?.actor ?? null;
    const stage = onStage().find((a) => !a.hasPlayerOwner) ?? null;
    const a = sel ?? party[0] ?? null;
    const b = tgt ?? stage ?? null;
    S = { host, party, sel: 1, src: stage ? "stage" : "scene", q: "", msg: "", same: true,
          slots: [{ uuid: a?.uuid ?? null, team: null, attrs: ["DEX", "MIG"] }, { uuid: b && b.uuid !== a?.uuid ? b.uuid : null, team: null, attrs: ["DEX", "MIG"] }] };
    host.innerHTML = `<div class="oni-cts">
      <div class="sides" data-k="slots"></div>
      <label class="same"><input type="checkbox" data-k="same" checked> Every side rolls the same Check (RAW default). Untick to set dice per side.</label>
      <div class="src" data-k="tabs"></div>
      <input class="search" data-k="search" type="text" placeholder="Search every actor in the world…" style="display:none">
      <div class="srcnote" data-k="note"></div>
      <div class="grid" data-k="grid"></div>
      <div class="row"><span>Label</span><input type="text" data-k="label" value="${esc(document.getElementById("oni-creq-ctx")?.value?.trim() || "Contest")}" placeholder="Arm Wrestle"></div>
      <div class="row"><span>Stakes</span><input type="text" data-k="stakes" value="" placeholder="Optional · shown on the HUD and in chat"></div>
      <div class="row"><span>Mode</span><select data-k="mode"><option value="oneoff">One-off contest</option><option value="clock">Conflict: move a Clock by the margin</option></select><select data-k="clock" style="display:none"></select></div>
    </div>`;
    const q = (k) => host.querySelector(`[data-k="${k}"]`);
    q("same").addEventListener("change", (e) => { S.same = e.target.checked; drawSlots(); });
    q("search").addEventListener("input", (e) => { S.q = e.target.value; drawGrid(); });
    q("mode").addEventListener("change", drawClockPick);
    drawSlots(); drawTabs(); drawGrid(); drawClockPick();
  }

  const $ = (k) => S?.host?.querySelector(`[data-k="${k}"]`);

  function drawClockPick() {
    const mode = $("mode").value, sel = $("clock");
    if (mode !== "clock") { sel.style.display = "none"; return; }
    const clocks = globalThis.FUCompanion?.api?.clocks?.list?.({ state: "active" }) ?? [];
    sel.style.display = "";
    sel.innerHTML = clocks.length
      ? clocks.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${c.value}/${c.sections})</option>`).join("")
      : `<option value="">No active Clock — create one first</option>`;
    if (S.slots.length > 2) S.msg = "A Clock contest has exactly two sides.";
  }

  function drawSlots() {
    if (S.same) S.slots.forEach((s) => { s.attrs = [...S.slots[0].attrs]; });
    let h = "";
    S.slots.forEach((s, i) => {
      if (i > 0) h += `<div class="vsx">VS</div>`;
      const team = s.team?.length ? s.team.map(actorOf).filter(Boolean) : null;
      let body;
      if (team) {
        const best = team.slice().sort((x, y) => (getDie(y, s.attrs[0]) + getDie(y, s.attrs[1])) - (getDie(x, s.attrs[0]) + getDie(x, s.attrs[1])))[0];
        body = `<img class="sp" src="${esc(imgOf(best))}" alt=""><div class="sn">Team</div><div class="team">${esc(team.map((a) => a.name).join(", "))}<br>rolls: <b>${esc(best.name)}</b> (best dice)</div>`;
      } else if (s.team) {
        body = `<div class="empty">Team: pick members below</div><div class="sn">Team</div>`;
      } else {
        const a = s.uuid ? actorOf(s.uuid) : null;
        body = a ? `<img class="sp" src="${esc(imgOf(a))}" alt=""><div class="sn">${esc(a.name)}</div>` : `<div class="empty">Pick an actor below<br>or drop one here</div><div class="sn">—</div>`;
      }
      h += `<div class="slot${i === S.sel ? " sel" : ""}" data-i="${i}">${S.slots.length > 2 ? `<button class="x" data-x="1" type="button" title="Remove side">✕</button>` : ""}
        <div class="sh">SIDE ${"ABCD"[i]}</div>${body}
        <div class="pk${S.same && i > 0 ? " locked" : ""}">${s.attrs.map((a, k) => `<div class="pick" data-k2="${k}"><button type="button" data-d="-1">◀</button><img src="${ICON[a]}" alt=""><span>${a}</span><button type="button" data-d="1">▶</button></div>`).join("")}</div>
        <div class="qa"><button type="button" data-q="sel">Selected token</button><button type="button" data-q="tgt">Targeted</button><button type="button" data-q="team" class="${s.team ? "on" : ""}">Team</button></div></div>`;
    });
    if (S.slots.length < 4) h += `<div class="slot add" data-add="1">+ Side</div>`;
    const host = $("slots");
    host.innerHTML = h;
    host.querySelectorAll(".slot[data-i]").forEach((el) => {
      const i = Number(el.dataset.i);
      el.addEventListener("click", (e) => onSlotClick(e, i));
      dropZone(el, (uuid) => { setSlot(i, uuid); });
    });
    const add = host.querySelector("[data-add]");
    if (add) {
      add.addEventListener("click", () => { S.slots.push({ uuid: null, team: null, attrs: [...S.slots[0].attrs] }); S.sel = S.slots.length - 1; drawSlots(); drawGrid(); });
      dropZone(add, (uuid) => { S.slots.push({ uuid, team: null, attrs: [...S.slots[0].attrs] }); S.sel = S.slots.length - 1; drawSlots(); drawGrid(); });
    }
    drawNote();
  }

  function setSlot(i, uuid) {
    const s = S.slots[i]; if (!s) return;
    if (s.team) { if (!s.team.includes(uuid)) s.team.push(uuid); }
    else s.uuid = uuid;
    S.sel = i; S.msg = "";
    drawSlots(); drawGrid();
  }

  function onSlotClick(e, i) {
    const s = S.slots[i];
    const pb = e.target.closest(".pick button");
    if (pb) {
      if (S.same && i > 0) return;
      const k = Number(pb.closest(".pick").dataset.k2), c = ATTRS.indexOf(s.attrs[k]);
      s.attrs[k] = ATTRS[(c + Number(pb.dataset.d) + ATTRS.length) % ATTRS.length];
      drawSlots(); return;
    }
    if (e.target.closest("[data-x]")) { S.slots.splice(i, 1); S.sel = Math.min(S.sel, S.slots.length - 1); drawSlots(); drawGrid(); return; }
    const qk = e.target.closest("[data-q]")?.dataset.q;
    if (qk === "sel") {
      const a = canvas?.tokens?.controlled?.[0]?.actor;
      if (!a) { S.msg = "Select a token on the map first."; drawNote(); return; }
      s.team = null; setSlot(i, a.uuid); S.msg = `Side ${"ABCD"[i]}: ${a.name}, from your selected token.`; drawNote(); return;
    }
    if (qk === "tgt") {
      const a = game.user?.targets?.first?.()?.actor;
      if (!a) { S.msg = "Target a token on the map first (T)."; drawNote(); return; }
      s.team = null; setSlot(i, a.uuid); S.msg = `Side ${"ABCD"[i]}: ${a.name}, from your target.`; drawNote(); return;
    }
    if (qk === "team") {
      if (s.team) { s.uuid = s.team[0] ?? s.uuid; s.team = null; }
      else { s.team = s.uuid ? [s.uuid] : []; s.uuid = null; S.msg = `Side ${"ABCD"[i]} is a team: click actors below to add or remove them. The member with the best dice rolls.`; }
      S.sel = i; drawSlots(); drawGrid(); return;
    }
    S.sel = i; S.msg = ""; drawSlots(); drawGrid();
  }

  // Drops from Foundry's Actors sidebar carry {"type":"Actor","uuid":...}.
  function dropZone(el, onDrop) {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove("drop");
      let data = null;
      try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch (_) { return; }
      const uuid = data?.uuid ?? (data?.type === "Actor" && data?.id ? `Actor.${data.id}` : null);
      const a = uuid ? actorOf(uuid) : null;
      if (!a) { S.msg = "Only actors can be dropped on a side."; drawNote(); return; }
      onDrop(a.uuid);
      S.msg = `${a.name} dropped from the Actors sidebar.`; drawNote();
    });
  }

  function drawTabs() {
    const host = $("tabs");
    host.innerHTML = SOURCES.map((s) => `<button type="button" class="tab${s.id === S.src ? " on" : ""}" data-src="${s.id}">${s.name}</button>`).join("");
    host.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => { S.src = b.dataset.src; S.msg = ""; drawTabs(); drawGrid(); }));
    $("search").style.display = S.src === "all" ? "" : "none";
  }

  function drawNote() {
    const src = SOURCES.find((x) => x.id === S.src);
    $("note").textContent = S.msg || `Filling side ${"ABCD"[S.sel] ?? "A"} · ${src?.note ?? ""} You can also drag an actor from the Actors sidebar onto a side.`;
  }

  function drawGrid() {
    drawNote();
    const src = SOURCES.find((x) => x.id === S.src);
    let list = [];
    try { list = src?.list() ?? []; } catch (e) { console.warn(TAG, e); }
    const q = S.q.trim().toLowerCase();
    if (S.src === "all") {
      list = list.filter((a) => !q || a.name.toLowerCase().includes(q))
        .sort((x, y) => (x.hasPlayerOwner === y.hasPlayerOwner ? x.name.localeCompare(y.name) : x.hasPlayerOwner ? -1 : 1)).slice(0, 120);
    }
    const s = S.slots[S.sel];
    const grid = $("grid");
    if (!list.length) { grid.innerHTML = `<div class="none">${S.src === "stage" ? "No Theatre portraits are up right now." : S.src === "recent" ? "No contests yet." : "Nobody here."}</div>`; return; }
    grid.innerHTML = list.map((a) => {
      const inSide = s?.team ? s.team.includes(a.uuid) : s?.uuid === a.uuid;
      const where = a.folder?.name ?? (a.hasPlayerOwner ? "Player" : "");
      return `<div class="card${inSide ? " in" : ""}" data-u="${esc(a.uuid)}" title="${esc(a.name)}"><img src="${esc(imgOf(a))}" alt=""><div class="cn">${esc(a.name)}</div><div class="cw">${esc(where)}</div></div>`;
    }).join("");
    grid.querySelectorAll(".card").forEach((c) => c.addEventListener("click", () => {
      const u = c.dataset.u, slot = S.slots[S.sel]; if (!slot) return;
      if (slot.team) { const k = slot.team.indexOf(u); if (k >= 0) slot.team.splice(k, 1); else slot.team.push(u); drawSlots(); drawGrid(); return; }
      setSlot(S.sel, u);
    }));
  }

  // ── Collect ──────────────────────────────────────────────────────────────
  function collect() {
    if (!S?.host?.isConnected && !S) return null;
    const sides = [];
    for (const [i, s] of S.slots.entries()) {
      const attrs = S.same ? S.slots[0].attrs : s.attrs;
      if (s.team) {
        if (!s.team.length) { ui.notifications?.warn(`Contest: side ${"ABCD"[i]} is a team with no members.`); return null; }
        sides.push({ team: [...s.team], attrA: attrs[0], attrB: attrs[1] });
      } else {
        if (!s.uuid) { ui.notifications?.warn(`Contest: side ${"ABCD"[i]} has nobody in it.`); return null; }
        sides.push({ actorUuid: s.uuid, attrA: attrs[0], attrB: attrs[1] });
      }
    }
    if (sides.length < 2) { ui.notifications?.warn("Contest: it takes at least two sides."); return null; }
    const mode = $("mode")?.value ?? "oneoff";
    const clockId = mode === "clock" ? ($("clock")?.value || null) : null;
    if (mode === "clock" && !clockId) { ui.notifications?.warn("Contest: pick a Clock, or switch to a one-off contest."); return null; }
    if (mode === "clock" && sides.length !== 2) { ui.notifications?.warn("Contest: a Clock contest has exactly two sides."); return null; }
    remember(sides.flatMap((s) => s.team ?? [s.actorUuid]));
    return {
      sides, attrA: S.slots[0].attrs[0], attrB: S.slots[0].attrs[1],
      label: $("label")?.value?.trim() || "Contest", stakes: $("stakes")?.value?.trim() || "",
      clock: clockId ? { id: clockId } : null, mode: "interactive", allowInvokes: true, postChat: true,
    };
  }

  ONI.ContestSetup = { mount, collect };
})();
