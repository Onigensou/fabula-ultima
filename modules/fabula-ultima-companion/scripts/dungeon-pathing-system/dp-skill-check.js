// ============================================================================
// Dungeon Pathing — Skill Check tile runner (GM side)
//
// Landing on a Skill Check tile:
//   1. The party is held (the walking client awaits this runner's reply, as a
//      Random Battle does). Players see nothing yet.
//   2. The main GM gets the picker: this dungeon's PRESET events, unplayed
//      first, played ones greyed with their count (picking one again asks
//      first), a tile's PINNED preset preselected. The last row of every list
//      is "Custom Event" (the GM improvises: spark ideas + the GM chip).
//      Buttons: Random new one, Skip tile, Play.
//   3. Trip: the dungeon map's theatre scene (first theatre entry in its Scene
//      Network) is activated. The dungeon's party token is NOT touched, so the
//      board comes back exactly where it was. Scene activation already plays
//      the game's black fade on every client (screen-transition.js).
//   4. The event: a preset is an ordinary event authored in Event Config on a
//      hidden "slate" tile on that theatre scene (Fabula tab → Skill Check
//      preset). Custom Event = the GM narrates; a GM chip requests the check and
//      offers quick consequences.
//   5. Finish: EXP to the whole party (1 by default, pass or fail unless the
//      preset says pass-only) and a row in the played log on the party database
//      actor (saved per slot). Then back to the map; once everyone sees it, the
//      tile clears to Blank with the Clear Tile macro's smoke puff + door sound.
//      Ending early: no EXP, no log, the tile stays.
//   No theatre scene for this map: the same thing runs in place on the map.
//
// Data:
//   theatre slate tile   flags.<MOD>.dungeonPathing.skillCheckSlate  (Boolean)
//                        flags.<MOD>.dungeonPathing.skillCheckExp    (Number, 1)
//                        flags.<MOD>.dungeonPathing.skillCheckPassOnly (Boolean)
//   dungeon tile pin     flags.<MOD>.dungeonPathing.skillCheckPreset (slate tile id)
//   played log           party DB actor flags.<MOD>.skillCheckLog [ … ]
//   spark lists          theatre scene flags.<MOD>.skillCheckSparks
//                        { hazard: [], stakes: [], twist: [] } (optional;
//                        generic lists otherwise)
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const MOD = "fabula-ultima-companion";
  const TAG = "[DungeonPathing][SkillCheck]";
  const KEY = () => DP.PATHING_ROOT_KEY ?? "dungeonPathing";
  const LOG_FLAG = "skillCheckLog";
  const LOG_CAP = 300;
  const EXP_HOLD_MS = 3800;      // let the EXP panel play before leaving the theatre
  const PLAYER_DRAW_WAIT_MS = 20000;
  const CLEAR_SETTLE_MS = 900;   // players' canvases draw after viewedScene flips
  const CUSTOM_ID = "__custom";
  // The manual "Clear Tile" macro's feedback (Macro pfssndYCmaliG6Wn).
  const CLEAR_FX  = "modules/JB2A_DnD5e/Library/Generic/Smoke/SmokePuffRing01_02_Regular_White_400x400.webm";
  const CLEAR_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Door1.ogg";

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── theatre + presets ──────────────────────────────────────────────────────
  function sceneMode(scene) {
    return scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode ?? null;
  }

  function theatreFor(scene) {
    let net = scene?.flags?.[MOD]?.oniFabula?.sceneNetwork ?? "[]";
    try { net = typeof net === "string" ? JSON.parse(net) : net; } catch { net = []; }
    for (const entry of Array.isArray(net) ? net : []) {
      const raw = String(entry?.id ?? entry ?? "").replace(/^Scene\./, "");
      const s = game.scenes?.get(raw);
      if (s && sceneMode(s) === "theatre") return s;
    }
    return null;
  }

  // The first Run Check anywhere in the rows (branches included).
  function firstCheck(rows) {
    for (const row of rows ?? []) {
      if (row?.type === "runCheck") return row;
      for (const k of ["successRows", "failureRows", "critRows", "fumbleRows", "rows", "victoryRows", "defeatRows"]) {
        const hit = firstCheck(row?.[k]);
        if (hit) return hit;
      }
      for (const c of row?.choices ?? row?.options ?? []) { const hit = firstCheck(c?.rows); if (hit) return hit; }
    }
    return null;
  }

  function checkSummary(row) {
    if (!row) return "No check row";
    const who = row.combine === "group" ? "Group" : (row.targets?.length === 1 && row.targets[0].kind !== "party") ? "One" : row.combine === "any" ? "Any" : "Each";
    return `${who} · ${row.attrA} + ${row.attrB} · DL ${row.dl}`;
  }

  function presetsOn(theatre) {
    if (!theatre) return [];
    const core = window.oni?.EventSystem?.Core;
    const out = [];
    for (const t of theatre.tiles ?? []) {
      const f = t.flags?.[MOD]?.[KEY()] ?? {};
      if (!(f.skillCheckSlate === true || f.skillCheckSlate === "true")) continue;
      const data = core?.readEventData?.(t);
      const rows = Array.isArray(data?.eventRows) ? data.eventRows : [];
      out.push({
        id: t.id,
        title: String(t.flags?.["monks-active-tiles"]?.name ?? "").trim() || `Preset ${t.id.slice(0, 4)}`,
        exp: Number.isFinite(Number(f.skillCheckExp)) && f.skillCheckExp !== "" ? Math.max(0, Number(f.skillCheckExp)) : 1,
        passOnly: f.skillCheckPassOnly === true || f.skillCheckPassOnly === "true",
        summary: checkSummary(firstCheck(rows)),
        hasRows: rows.length > 0,
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  // ── played log (party database actor) ──────────────────────────────────────
  async function dbActor() {
    return (await globalThis.FUCompanion?.api?.getCurrentGameDb?.().catch(() => null))?.db ?? null;
  }
  async function readLog() {
    const db = await dbActor();
    const log = db?.flags?.[MOD]?.[LOG_FLAG];
    return Array.isArray(log) ? log : [];
  }
  async function appendLog(entry) {
    const db = await dbActor();
    if (!db) return;
    const log = [...(Array.isArray(db.flags?.[MOD]?.[LOG_FLAG]) ? db.flags[MOD][LOG_FLAG] : []), entry].slice(-LOG_CAP);
    await db.update({ [`flags.${MOD}.${LOG_FLAG}`]: log });
  }
  function playsOf(log, theatreId, presetId) {
    return log.filter(r => r.presetId === presetId && r.theatreId === theatreId);
  }

  // ── sparks ─────────────────────────────────────────────────────────────────
  const SPARKS = {
    hazard: ["A boulder breaks loose", "The floor gives way", "Darts hiss from the walls", "A rope bridge frays", "Poison gas seeps in",
             "A rockslide blocks the way", "The ground starts to flood", "A trapped chest", "A sealed door with a riddle", "Something watches from the dark",
             "A narrow ledge over a drop", "A swarm of vermin"],
    stakes: ["Someone could get hurt", "A pack of supplies could be lost", "The noise could wake something", "The way back could close",
             "Someone gets separated", "Time runs short", "A treasure could break", "Someone's nerve is tested", "A lead could go cold", "An old wound reopens"],
    twist:  ["A shortcut opens below", "A monster is roused", "An old message is revealed", "It was a test all along", "Someone else was here first",
             "The danger saves them from worse", "A strange item turns up", "The path changes behind them", "A familiar sign appears", "It happens twice"],
  };
  function sparkLists(theatre) {
    const own = theatre?.flags?.[MOD]?.skillCheckSparks ?? {};
    const pick = (k) => (Array.isArray(own[k]) && own[k].length ? own[k] : SPARKS[k]);
    return { hazard: pick("hazard"), stakes: pick("stakes"), twist: pick("twist") };
  }
  const deal = (list) => list[Math.floor(Math.random() * list.length)];

  // ── party ──────────────────────────────────────────────────────────────────
  async function partyActors() {
    const p = await globalThis.CampSystem?.Party?.resolve?.().catch(() => []) ?? [];
    return p.map(e => e.actor).filter(Boolean);
  }

  // ── UI (GM only; the game's parchment system skin) ─────────────────────────
  const PANEL_ID = "oni-scx-panel";
  function ensureStyle() {
    if (document.getElementById("oni-scx-style")) return;
    const s = document.createElement("style");
    s.id = "oni-scx-style";
    s.textContent = `
#${PANEL_ID}{position:fixed;z-index:100050;font-family:"Signika","Noto Sans","Segoe UI",sans-serif;color:#3a1e06;
  background:linear-gradient(168deg,#f8f0d4 0%,#ede0b0 100%);border:2px solid #c9a44a;border-radius:12px;
  box-shadow:0 0 0 2px #7a4e20,0 0 0 4px #b8865a,0 10px 30px rgba(0,0,0,.5);padding:14px 16px;font-size:14px;
  opacity:0;transform:translateX(-18px);transition:opacity .25s ease,transform .25s ease}
#${PANEL_ID}.in{opacity:1;transform:none}
#${PANEL_ID}.picker{left:50%;top:50%;width:min(560px,calc(100vw - 340px));margin-left:calc(min(560px,calc(100vw - 340px)) / -2);translate:0 -50%}
#${PANEL_ID}.chip{left:124px;top:96px;width:340px}
#${PANEL_ID} .gm{position:absolute;right:-2px;top:-2px;background:#7a2e18;color:#f3e6c4;font-size:11px;border-radius:0 10px 0 8px;padding:1px 8px}
#${PANEL_ID} h3{margin:0 0 2px;font-size:17px;font-weight:400;border:0;font-family:inherit;color:inherit}
#${PANEL_ID} .sub{color:#6b4a26;font-size:12.5px;margin-bottom:8px}
#${PANEL_ID} .list{display:flex;flex-direction:column;gap:3px;max-height:46vh;overflow:auto;margin-bottom:8px}
#${PANEL_ID} .row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:5px 8px;border-radius:7px;border:1px solid transparent;cursor:pointer}
#${PANEL_ID} .row:hover{background:rgba(201,164,74,.12)}
#${PANEL_ID} .row.sel{border-color:#c9a44a;background:rgba(201,164,74,.22)}
#${PANEL_ID} .row.played{opacity:.6}
#${PANEL_ID} .row .att{color:#6b4a26;font-size:12.5px;font-variant-numeric:tabular-nums}
#${PANEL_ID} .tag{font-size:11.5px;border-radius:999px;padding:0 8px;white-space:nowrap;border:1px solid}
#${PANEL_ID} .tag.new{background:#e5d6a3;color:#5a3a12;border-color:#c9a44a}
#${PANEL_ID} .tag.pl{background:#d8d0c0;color:#6c6355;border-color:#b5ab98}
#${PANEL_ID} .tag.pin{background:#cfe0ef;color:#24425a;border-color:#7d9fbb;margin-left:6px}
#${PANEL_ID} .foot{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
#${PANEL_ID} button{font-family:inherit;font-size:13px;background:linear-gradient(180deg,#7a5230 0%,#5c3818 100%);color:#f3e6c4;
  border:1px solid #3d2410;border-radius:6px;padding:4px 12px;cursor:pointer;width:auto;line-height:1.5}
#${PANEL_ID} button:hover,#${PANEL_ID} button:focus-visible{box-shadow:0 0 0 2px #c9a44a,0 0 8px rgba(201,164,74,.6);outline:none}
#${PANEL_ID} button.red{background:linear-gradient(180deg,#7a2e18 0%,#5a1c08 100%)}
#${PANEL_ID} button.hot{box-shadow:0 0 0 2px #c9a44a}
#${PANEL_ID} button:disabled{opacity:.45;cursor:default;box-shadow:none}
#${PANEL_ID} .warn{background:rgba(122,46,24,.1);border:1px solid #b5471f;border-radius:7px;padding:6px 9px;margin:0 0 8px;font-size:13px}
#${PANEL_ID} .spark{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:4px 0 8px}
#${PANEL_ID} .spark div{border:1px dashed #b8865a;border-radius:6px;padding:4px 7px;background:rgba(255,255,255,.35);font-size:13px}
#${PANEL_ID} .spark b{display:block;font-size:11px;color:#6b4a26;font-weight:600}
#${PANEL_ID} .grid{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:8px}
#${PANEL_ID} input,#${PANEL_ID} select{font-family:inherit;font-size:13px;background:#fffaf0;border:1px solid #c9a44a;border-radius:5px;color:#3a1e06;height:26px}
#${PANEL_ID} input[type=number]{width:60px}
#${PANEL_ID} .inl{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#${PANEL_ID} .res{margin:4px 0 8px;font-size:13.5px}
#${PANEL_ID} .res b.ok{color:#2e6a2a}#${PANEL_ID} .res b.no{color:#8a2416}
#${PANEL_ID} hr{border:0;border-top:1px solid rgba(122,82,48,.35);margin:8px 0}
#${PANEL_ID} .lbl{font-size:12px;color:#6b4a26}
#${PANEL_ID} .btns{display:flex;flex-wrap:wrap;gap:6px}
#${PANEL_ID} .btns + .btns{margin-top:6px}
#${PANEL_ID} .state{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #b8865a;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.35);margin:2px 0 4px}
#${PANEL_ID} .state span{text-align:center;font-size:12.5px;padding:3px 0;color:#6b4a26;cursor:pointer;user-select:none}
#${PANEL_ID} .state span + span{border-left:1px solid rgba(122,82,48,.3)}
#${PANEL_ID} .state span:focus-visible{outline:2px solid #c9a44a;outline-offset:-2px}
#${PANEL_ID} .state span.on{font-weight:700;color:#fff3df}
#${PANEL_ID} .state span.on.pend{background:#8a7a62} #${PANEL_ID} .state span.on.pass{background:#2e6a2a} #${PANEL_ID} .state span.on.fail{background:#8a2416}
#${PANEL_ID} .rolled{font-size:12px;color:#6b4a26;margin-bottom:10px}`;
    document.head.appendChild(s);
  }
  function openPanel(cls, html) {
    ensureStyle();
    document.getElementById(PANEL_ID)?.remove();
    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.className = cls;
    el.innerHTML = `<span class="gm">GM</span>${html}`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
    return el;
  }
  function closePanel() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    el.classList.remove("in");
    setTimeout(() => el.remove(), 260);
  }


  // Picker → { action: "play", preset } | { action: "freeform", form } | { action: "skip" }
  // Every list ends with the Custom Event row (CUSTOM_ID); Play on it opens the
  // custom setup panel.
  function pick({ scene, tileDoc, theatre, presets, pinId, log }) {
    return new Promise((resolve) => {
      const plays = (p) => playsOf(log, theatre?.id, p.id);
      const ordered = [...presets].sort((a, b) => (plays(a).length > 0) - (plays(b).length > 0));
      let selId = presets.some(p => p.id === pinId) ? pinId : (ordered.find(p => !plays(p).length)?.id ?? ordered[0]?.id ?? CUSTOM_ID);
      let confirmReplay = false;
      const area = scene.navName || scene.name;
      const unplayed = presets.filter(p => !plays(p).length).length;

      const renderList = (el) => {
        const sel = presets.find(p => p.id === selId);
        const ps = sel ? plays(sel) : [];
        const last = ps[ps.length - 1];
        el.innerHTML = `<span class="gm">GM</span>
          <h3>Skill Check · <b>${esc(area)}</b></h3>
          <div class="sub">${theatre ? `${presets.length} preset${presets.length === 1 ? "" : "s"} on <b>${esc(theatre.name)}</b> · ${unplayed} not played on this save` : "This map has no theatre scene: the event runs here on the map."}</div>
          <div class="list">${ordered.map(p => {
            const n = plays(p).length;
            return `<div class="row ${n ? "played" : ""} ${p.id === selId ? "sel" : ""}" data-id="${p.id}">
              <span>${esc(p.title)}${p.id === pinId ? `<span class="tag pin">Pinned to this tile</span>` : ""}</span>
              <span class="att">${esc(p.summary)}${p.exp !== 1 ? ` · ${p.exp} EXP` : ""}</span>
              <span class="tag ${n ? "pl" : "new"}">${n ? `Played ${n}×` : "New"}</span></div>`;
          }).join("")}
            <div class="row ${selId === CUSTOM_ID ? "sel" : ""}" data-id="${CUSTOM_ID}">
              <span>Custom Event</span><span class="att">you run it: spark ideas, your own check</span><span></span></div></div>
          ${confirmReplay && last ? `<div class="warn">Already played on this save${last.mapName ? ` (${esc(last.mapName)}` : " ("}${last.result ? `, ${esc(last.result === "success" ? "Pass" : last.result === "failure" ? "Fail" : last.result)}` : ""}). Play it again?</div>` : ""}
          <div class="foot">
            ${presets.length ? `<button data-a="random" ${unplayed ? "" : "disabled"}>Random new one</button>` : ""}
            <button data-a="skip" class="red">Skip tile</button>
            ${confirmReplay ? `<button data-a="back">No</button><button data-a="play" class="hot">Play again</button>` : `<button data-a="play" class="hot" ${sel || selId === CUSTOM_ID ? "" : "disabled"}>Play</button>`}
          </div>`;
        el.querySelectorAll(".row").forEach(r => r.addEventListener("click", () => { selId = r.dataset.id; confirmReplay = false; renderList(el); }));
        el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => act(b.dataset.a, el)));
      };

      const renderFree = (el, form) => {
        const sp = sparkLists(theatre);
        form.sparks ??= { hazard: deal(sp.hazard), stakes: deal(sp.stakes), twist: deal(sp.twist) };
        el.innerHTML = `<span class="gm">GM</span>
          <h3>Skill Check · <b>Custom Event</b></h3>
          <div class="sub">${esc(area)} · you narrate; the check is set in Request Check · the title is only for the played log</div>
          <div class="spark"><div><b>Hazard</b>${esc(form.sparks.hazard)}</div><div><b>Stakes</b>${esc(form.sparks.stakes)}</div><div><b>Twist</b>${esc(form.sparks.twist)}</div></div>
          <div class="grid">
            <span class="lbl">Title</span><input type="text" id="scx-title" value="${esc(form.title)}" placeholder="e.g. Crumbling Floor" />
            <span class="lbl">EXP</span><span class="inl"><input type="number" id="scx-exp" min="0" max="9" value="${form.exp}" /><label class="lbl"><input type="checkbox" id="scx-passonly" ${form.passOnly ? "checked" : ""} style="height:auto" /> only on a pass</label></span>
          </div>
          <div class="foot"><button data-a="reroll">Deal new sparks</button><button data-a="list">Back to list</button><button data-a="skip" class="red">Skip tile</button><button data-a="start" class="hot">Start</button></div>`;
        const read = () => {
          form.title = el.querySelector("#scx-title").value.trim();
          form.exp = Math.max(0, Number(el.querySelector("#scx-exp").value) || 0);
          form.passOnly = el.querySelector("#scx-passonly").checked;
        };
        el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
          read();
          if (b.dataset.a === "reroll") { form.sparks = null; renderFree(el, form); return; }
          if (b.dataset.a === "list") { mode = "list"; renderList(el); return; }
          if (b.dataset.a === "skip") { finish({ action: "skip" }); return; }
          if (b.dataset.a === "start") finish({ action: "freeform", form });
        }));
      };

      let mode = "list";
      const freeForm = { title: "", exp: 1, passOnly: false, sparks: null };
      const finish = (v) => { closePanel(); resolve(v); };
      const act = (a, el) => {
        if (a === "skip") return finish({ action: "skip" });
        if (a === "back") { confirmReplay = false; return renderList(el); }
        if (a === "random") {
          const pool = presets.filter(p => !plays(p).length);
          if (!pool.length) return;
          return finish({ action: "play", preset: pool[Math.floor(Math.random() * pool.length)] });
        }
        if (a === "play") {
          if (selId === CUSTOM_ID) { mode = "free"; return renderFree(el, freeForm); }
          const sel = presets.find(p => p.id === selId);
          if (!sel) return;
          if (plays(sel).length && !confirmReplay) { confirmReplay = true; return renderList(el); }
          return finish({ action: "play", preset: sel });
        }
      };

      const el = openPanel("picker", "");
      renderList(el);
    });
  }

  // ── trip helpers ───────────────────────────────────────────────────────────
  async function waitForCanvas(sceneId, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (canvas?.ready && canvas.scene?.id === sceneId) return true;
      await sleep(150);
    }
    return false;
  }
  async function waitForPlayers(sceneId) {
    const end = Date.now() + PLAYER_DRAW_WAIT_MS;
    const behind = () => (game.users?.players ?? []).filter(u => u.active && u.viewedScene !== sceneId);
    while (behind().length && Date.now() < end) await sleep(200);
  }

  // Clear the tile with the Clear Tile macro's smoke puff + door sound
  // (Sequencer plays it on every client).
  async function clearWithFx(scene, tileId) {
    await DP.Socket.clearTile(scene, tileId).catch(e => console.warn(TAG, "clearTile failed", e));
    try {
      const tileObj = canvas?.scene?.id === scene.id ? canvas.tiles?.get(tileId) : null;
      if (!tileObj || !globalThis.Sequence) return;
      await new Sequence().effect().file(CLEAR_FX).atLocation(tileObj).sound().file(CLEAR_SFX).play();
    } catch (e) { console.warn(TAG, "clear FX failed", e); }
  }

  // ── freeform: GM chip ──────────────────────────────────────────────────────
  // Resolves { finished: bool, outcome: "success"|"failure"|null }.
  // Request check opens the Request Check dialog (ONI.CheckRequester.openDialog,
  // check-requester/cr-sidebar-button.js) — the GM sets attributes, DL, Single or
  // Group there — and fills the Result switch (Not rolled / Passed / Failed),
  // which the GM can also flip by hand. Deal damage… and Apply status… open the
  // small FU.EffectsMenu menus beside the panel (shared/effects-menus.js), with
  // those who failed ticked and marked; the APIs report to FU.Feedback.
  function runFreeform(form, actors) {
    return new Promise((resolve) => {
      const st = { outcome: null, failers: [], rolled: null, how: "", busy: false, note: "" };
      const title = form.title || "Custom Event";
      const el = openPanel("chip", "");

      // The event's state is a switch, not buttons (user 11-14): Request check
      // sets it from the roll; the GM can flip it by hand.
      const RESULT = [[null, "Not rolled", "pend"], ["success", "Passed", "pass"], ["failure", "Failed", "fail"]];
      const render = () => {
        const how = st.outcome == null ? (st.note || "No roll yet")
          : `${st.how || "Set by the GM"}${st.failers.length ? ` · failed: ${st.failers.map(a => a.name).join(", ")}` : ""}`;
        el.innerHTML = `<span class="gm">GM</span>
          <h3>Custom Event · <b>${esc(title)}</b></h3>
          <div class="sub">${st.rolled ? `${esc(st.rolled)} · ` : ""}${form.exp} EXP${form.passOnly ? " on a pass" : ""}</div>
          <div class="lbl">Result</div>
          <div class="state" role="radiogroup" aria-label="Result">${RESULT.map(([v, l, c]) =>
            `<span role="radio" tabindex="0" aria-checked="${st.outcome === v}" data-r="${c}" class="${c} ${st.outcome === v ? "on" : ""}">${l}</span>`).join("")}</div>
          <div class="rolled">${esc(how)}</div>
          <div class="btns"><button data-a="check" ${st.busy ? "disabled" : ""} class="${st.outcome == null ? "hot" : ""}">${st.outcome == null ? "Request check" : "Roll again"}</button></div>
          <div class="btns"><button data-a="dmg" ${st.busy ? "disabled" : ""}>Deal damage…</button><button data-a="status" ${st.busy ? "disabled" : ""}>Apply status…</button></div>
          <hr>
          <div class="foot"><button data-a="end" class="red" title="No EXP; the tile stays">End</button><button data-a="finish" class="hot" ${st.busy ? "disabled" : ""}>Finish</button></div>`;
        el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => act(b.dataset.a).catch(e => console.error(TAG, e))));
        el.querySelectorAll("[data-r]").forEach(r => {
          const pick = () => {
            const v = RESULT.find(x => x[2] === r.dataset.r)?.[0] ?? null;
            if (v === st.outcome) return;
            st.outcome = v; st.how = "Set by the GM";
            if (v !== "failure") st.failers = [];
            render();
          };
          r.addEventListener("click", pick);
          r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
        });
      };
      // The menus open beside this panel, with those who failed ticked + marked.
      const menuOpts = () => ({
        source: title, targets: actors, anchor: el,
        preselect: (st.failers.length ? st.failers : actors).map(a => a.uuid),
        marked: st.failers.map(a => a.uuid),
      });

      const act = async (a) => {
        if (a === "end") { globalThis.FU?.EffectsMenu?.close?.(); closePanel(); return resolve({ finished: false, outcome: st.outcome }); }
        if (a === "finish") { globalThis.FU?.EffectsMenu?.close?.(); closePanel(); return resolve({ finished: true, outcome: st.outcome }); }
        if (a === "check") {
          const openDialog = globalThis.ONI?.CheckRequester?.openDialog;
          if (!openDialog) { st.note = "Request Check is not loaded."; return render(); }
          st.busy = true; st.note = "Waiting on the check…"; render();
          try {
            const r = await openDialog({ label: title, actorUuids: actors.map(x => x.uuid) });
            const passed = (x) => !x?.isFumble && (x?.isCrit === true || x?.pass === true);
            if (!r) {
              st.note = "The check was cancelled.";
            } else if (r.mode === "group-check") {
              const lr = r.results?.leaderResult;
              if (lr) {
                st.outcome = (r.results.leaderPass === true || lr.isCrit) && !lr.isFumble ? "success" : "failure";
                st.failers = [];
                st.rolled = `Group Check · ${lr.attrA} + ${lr.attrB} · DL ${lr.dl}`;
                st.how = `${lr.actorName ?? "The leader"} led, rolled ${lr.total ?? "?"}`;
              }
              st.note = "";
            } else {
              const results = Array.isArray(r.results) ? r.results : [];
              if (results.length) {
                st.failers = actors.filter(a => { const x = results.find(y => y.actorUuid === a.uuid); return x && !passed(x); });
                st.outcome = st.failers.length ? "failure" : "success";
                const x0 = results[0];
                st.rolled = `${results.length === 1 ? x0.actorName : `${results.length} roll`} · ${x0.attrA} + ${x0.attrB} · DL ${x0.dl}`;
                st.how = results.length === 1 ? `${x0.actorName} rolled ${x0.total ?? "?"}` : `${results.length - st.failers.length} of ${results.length} passed`;
              }
              st.note = "";
            }
          } catch (e) { st.note = "The check was cancelled."; console.debug(TAG, "custom event check aborted", e); }
          st.busy = false; return render();
        }
        if (a === "dmg" || a === "status") {
          const menu = globalThis.FU?.EffectsMenu;
          if (!menu) { ui.notifications?.warn?.("Skill Check: the effects menus are not loaded."); return; }
          if (a === "dmg") menu.damage(menuOpts()); else menu.status(menuOpts());
          return;
        }
      };
      render();
    });
  }

  // ── preset ─────────────────────────────────────────────────────────────────
  async function runPresetEvent(theatre, preset, requesterId) {
    const core = window.oni?.EventSystem?.Core;
    if (!core?.runPreset) return { finished: false, outcome: null, error: "Event System not loaded" };
    let outcome = null;
    const res = await core.runPreset({
      sceneId: theatre.id, tileId: preset.id, requesterId,
      onRowResult: (row, result) => { if (row?.type === "runCheck" && result?.outcome) outcome = result.outcome; },
    });
    if (!res?.ok) return { finished: false, outcome, error: res?.reason ?? "event failed" };
    return { finished: !res.endedEarly, outcome };
  }

  // ── the run ────────────────────────────────────────────────────────────────
  let _active = null;

  async function run({ sceneId, tileId, tokenId, userId = null } = {}) {
    if (!game.user?.isGM) return { ok: false, error: "Not GM" };
    if (_active) return { ok: false, error: "A skill check is already running" };
    const scene = game.scenes?.get(sceneId);
    const tileDoc = scene?.tiles?.get(tileId);
    if (!scene || !tileDoc) return { ok: false, error: "Scene or tile not found" };

    _active = { sceneId, tileId };
    let replied = false;
    let reply;
    const replyP = new Promise(r => { reply = (v) => { if (!replied) { replied = true; r(v); } }; });

    (async () => {
      let travelled = false;
      let clearIt = false;
      try {
        const theatre = theatreFor(scene);
        const presets = presetsOn(theatre);
        const pinId = String(tileDoc.flags?.[MOD]?.[KEY()]?.skillCheckPreset ?? "");
        const log = await readLog();
        const choice = await pick({ scene, tileDoc, theatre, presets, pinId, log });
        if (choice.action === "skip") { reply({ ok: true, skipped: true }); return; }

        const actors = await partyActors();
        if (theatre) {
          // Tell the walking client first: it must skip its closing rebuild
          // before the canvas tears down under it.
          reply({ ok: true, travelling: true });
          await sleep(200);
          await theatre.activate();
          travelled = true;
          await waitForCanvas(theatre.id);
          await waitForPlayers(theatre.id);
        }

        let result;
        let title, exp, passOnly, presetId = null;
        if (choice.action === "play") {
          ({ title, exp, passOnly } = choice.preset);
          presetId = choice.preset.id;
          result = await runPresetEvent(theatre, choice.preset, userId);
          if (result.error) ui.notifications?.warn?.(`Skill Check: the preset "${title}" did not run (${result.error}).`);
        } else {
          ({ title, exp, passOnly } = choice.form);
          title = title || "Custom Event";
          result = await runFreeform(choice.form, actors);
        }

        if (result.finished) {
          const pass = result.outcome === "success" || result.outcome === "crit";
          if (exp > 0 && (!passOnly || pass)) {
            await globalThis.FUCompanion?.api?.expAwarder?.awardExp?.({
              targets: actors.map(a => a.uuid), amount: exp, source: `Skill Check · ${title}`, playUi: true,
            });
            await sleep(EXP_HOLD_MS);
          }
          clearIt = true;
          await appendLog({
            presetId, theatreId: theatre?.id ?? null, title, freeform: choice.action !== "play",
            result: result.outcome ?? null, exp: exp > 0 && (!passOnly || pass) ? exp : 0,
            mapId: scene.id, mapName: scene.navName || scene.name, tileId,
            at: new Date().toISOString(),
          }).catch(e => console.warn(TAG, "log write failed", e));
        }
      } catch (e) {
        console.error(TAG, "skill check failed", e);
        ui.notifications?.error?.("Skill Check: something went wrong. See console.");
      } finally {
        closePanel();
        if (travelled) {
          await scene.activate().catch(e => console.error(TAG, "could not return to the map", e));
        }
        // The tile clears in front of everyone, back on the map.
        if (clearIt) {
          if (travelled) {
            await waitForCanvas(scene.id);
            await waitForPlayers(scene.id);
            await sleep(CLEAR_SETTLE_MS);
          }
          await clearWithFx(scene, tileId);
        }
        _active = null;
        reply({ ok: true, travelling: travelled });
      }
    })();

    return replyP;
  }

  DP.SkillCheck = { run, theatreFor, presetsOn, readLog, isRunning: () => !!_active };
})();
