/**
 * [ONI] Event System — story actions
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-story.js
 *
 * What this does (built for the Eisendrache prologue, all generic):
 * - Start Battle   a fight from inside an event. The Battle Director runs it on
 *                  its battle map; the event waits, comes back with the party
 *                  and runs Victory or Defeat. "Story loss": a defeat does not
 *                  end the event (the tournament, Fafnir). "Recover after a
 *                  defeat": the party is back to full HP and MP.
 * - Change Scene   move the party to another scene, at a marker token or a
 *                  point, and carry on with the rest of this event there. A
 *                  theatre scene (no party token) is fine.
 * - Move Token     walk the party or a named token through markers / points,
 *                  animated, at a set speed, and wait until it arrives.
 * - Name Input     the main controller types a name in a JRPG name panel; it is
 *                  stored as a text variable, and can rename the party.
 * - Recover All    whole party to full HP and MP, ailments cured, quietly.
 *
 * How it fits together:
 * - Start Battle and Change Scene move the GM's canvas. An event normally ends
 *   when its GM leaves the scene; these mark it travelling (Flow.travel) and
 *   hand it to the new scene once the GM's canvas is there (Flow.arrive).
 * - Start Battle waits on the Director's own "fu.battleEnd" hook, fired once the
 *   fight is over and the party is back on the scene it came from.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js,
 *   event-gameState.js, event-rows-token.js (marker lookup copy below)
 * - Battle Director API, camp-system/rest-api.js, teleporter-system/tp-api.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsStory]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsStory?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const flow = () => window.oni.EventSystem.Flow;
  const gameState = () => window.oni.EventSystem.GameState;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ------------------------------------------------------------
  // Plain helpers (node-testable through RowsStory)
  // ------------------------------------------------------------
  // "Ape, Wolf x2, Voidog ×3" -> [{ name, quantity }]
  function parseEnemyList(text) {
    const out = [];
    for (const part of String(text ?? "").split(/[,\n]/)) {
      const raw = part.trim();
      if (!raw) continue;
      const m = raw.match(/^(.*?)\s*[x×*]\s*(\d+)$/i);
      const name = (m ? m[1] : raw).trim();
      const quantity = m ? Math.max(1, Math.min(9, Number(m[2]))) : 1;
      if (!name) continue;
      const same = out.find(e => e.name.toLowerCase() === name.toLowerCase());
      if (same) same.quantity += quantity; else out.push({ name, quantity });
    }
    return out;
  }

  // "Kid Start; 1030, 900; Crowd Spot" -> [{ mark } | { x, y }]
  function parseWaypoints(text) {
    const out = [];
    for (const part of String(text ?? "").split(/[;\n]/)) {
      const raw = part.trim();
      if (!raw) continue;
      const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      out.push(m ? { x: Number(m[1]), y: Number(m[2]) } : { mark: raw });
    }
    return out;
  }

  // Which list runs after a fight.
  function battleBranch(outcome, storyLoss) {
    if (outcome === "victory") return { key: "victory", stop: false };
    if (outcome === "escaped") return { key: "defeat", stop: !storyLoss };
    return { key: "defeat", stop: !storyLoss };
  }

  // ------------------------------------------------------------
  // Shared lookups
  // ------------------------------------------------------------
  function tokensNamed(scene, name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return (scene?.tokens?.contents ?? []).filter(t =>
      String(t.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted);
  }

  function centerOf(doc, scene) {
    const g = scene?.grid?.size ?? 100;
    return { x: doc.x + (doc.width * g) / 2, y: doc.y + (doc.height * g) / 2 };
  }

  function sceneByRef(ref) {
    const raw = String(ref ?? "").trim();
    if (!raw) return null;
    const id = raw.startsWith("Scene.") ? raw.slice(6) : raw;
    return game.scenes?.get(id)
      ?? game.scenes?.find(s => s.name === raw)
      ?? game.scenes?.find(s => String(s.flags?.[MODULE_ID]?.oniFabula?.general?.navigationName ?? "") === raw)
      ?? null;
  }

  function worldActorByName(name) {
    const want = String(name ?? "").trim().toLowerCase().replace(/^⭐️\s*/, "");
    if (!want) return null;
    const plain = (a) => String(a.name ?? "").trim().toLowerCase().replace(/^⭐️\s*/, "");
    return game.actors?.find(a => plain(a) === want) ?? null;
  }

  async function partyMembers() {
    const fromDp = globalThis.DungeonPathing?.RandomBattle?._internals?.resolvePartyMembers;
    if (fromDp) return fromDp();
    return [];
  }

  // The GM's canvas has finished drawing this scene (or the time is up).
  function waitForCanvas(sceneId, ms = 20000) {
    if (canvas?.ready && canvas.scene?.id === sceneId) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => { Hooks.off("canvasReady", hookId); clearTimeout(timer); resolve(ok); };
      const hookId = Hooks.on("canvasReady", (c) => { if (c?.scene?.id === sceneId) done(true); });
      const timer = setTimeout(() => done(canvas?.scene?.id === sceneId), ms);
    });
  }

  async function recoverParty() {
    try { return await globalThis.CampSystem?.RestAPI?.recoverParty?.(); }
    catch (e) { console.warn(INSTALL_TAG, "Recover failed.", e); return 0; }
  }

  // ------------------------------------------------------------
  // Start Battle
  // ------------------------------------------------------------
  // "preemptive" is kept as the saved key (existing rows use it); the Battle
  // Director reads it as "advantage".
  const ENGAGEMENTS = [["normal", "Normal"], ["ambush", "Ambush: enemies get a Free Round"], ["preemptive", "Advantage: party gets a Free Round"]];
  let battleSeq = 0;

  function prepareBattle(row) {
    row.enemies = String(row.enemies ?? "");
    row.battleMap = String(row.battleMap ?? "");
    row.bgm = String(row.bgm ?? "");
    row.isBoss = row.isBoss === true;
    row.engagement = ENGAGEMENTS.some(([k]) => k === row.engagement) ? row.engagement : "normal";
    row.storyLoss = row.storyLoss === true;
    row.recoverOnDefeat = row.recoverOnDefeat === true;
    if (!Array.isArray(row.victoryRows)) row.victoryRows = [];
    if (!Array.isArray(row.defeatRows)) row.defeatRows = [];
  }

  async function executeBattle(row, context) {
    const id = String(context?.tileId || "");
    const f = flow();
    const api = globalThis.FUCompanion?.api?.experimental?.battleDirector;
    if (!api?.start) return { ok: false, reason: "noBattleDirector" };

    const list = parseEnemyList(row.enemies);
    const picks = [];
    for (const e of list) {
      const actor = worldActorByName(e.name);
      if (!actor) { console.warn(INSTALL_TAG, `Start Battle: no actor named "${e.name}".`); continue; }
      picks.push({ actorUuid: actor.uuid, name: actor.name, quantity: e.quantity, isNew: false });
    }
    if (!picks.length) return { ok: false, reason: "noEnemies" };

    const battleScene = sceneByRef(row.battleMap);
    if (!battleScene) return { ok: false, reason: "noBattleMap" };

    const source = canvas?.scene;
    const members = await partyMembers();
    if (!members.length) return { ok: false, reason: "noParty" };

    const tag = `event-battle-${id}-${++battleSeq}-${Date.now()}`;
    const payload = {
      context: { battleSceneUuid: battleScene.uuid, sourceSceneId: source?.id, sourceSceneUuid: source?.uuid, return: { enabled: true } },
      encounterPlan: { mode: "manual", manualPicks: picks },
      party: { members },
      battlePlan: { type: "default", isBoss: row.isBoss, initiativeMode: "rolled", engagement: row.engagement },
      battleConfig: { bgm: row.bgm, battleSceneUuid: battleScene.uuid },
      options: { battleSystem: "director" },
      meta: { source: "event-start-battle", tag, sceneId: source?.id, eventId: id }
    };

    f?.hold?.(id);
    f?.travel?.(id);
    Client.setMarker(id, "battle", "in battle");
    let hookId = null, offAbort = null;
    try {
      const ended = new Promise((resolve) => {
        hookId = Hooks.on("fu.battleEnd", (info) => { if (info?.meta?.tag === tag) resolve(info); });
        offAbort = f?.onAbort?.(id, () => resolve(null));
      });

      const before = api.getActiveDirector?.() ?? null;
      const started = await api.start({ payload });
      if (!started || started === before) {
        console.warn(INSTALL_TAG, "Start Battle: the Battle Director refused (a battle is already running).");
        return { ok: false, reason: "directorBusy" };
      }

      const info = await ended;
      if (!info) return { ok: true, type: "startBattle", aborted: true };

      // fu.battleEnd fires after the transition home; wait for the GM's canvas.
      if (source?.id) await waitForCanvas(source.id);
      await f?.arrive?.(id);

      const branch = battleBranch(info.outcome, row.storyLoss);
      if (branch.key === "defeat" && row.recoverOnDefeat) await recoverParty();

      const rows = branch.key === "victory" ? row.victoryRows : row.defeatRows;
      const result = await context.runRows(rows ?? []);
      if (branch.stop && !result?.stop) return { ok: true, type: "startBattle", outcome: info.outcome, stop: true };
      return { ...result, type: "startBattle", outcome: info.outcome };
    } finally {
      if (hookId !== null) Hooks.off("fu.battleEnd", hookId);
      offAbort?.();
      Client.setMarker(id, "battle", null);
      f?.release?.(id);
    }
  }

  EventRegistry.register({
    type: "startBattle",
    label: "Start Battle",
    category: "Story",
    defaultData: { type: "startBattle", enemies: "", battleMap: "", bgm: "", isBoss: false, engagement: "normal", storyLoss: false, recoverOnDefeat: false, victoryRows: [], defeatRows: [] },
    prepare: prepareBattle,
    childLists: (row) => [{ label: "Victory", rows: row.victoryRows }, { label: "Defeat", rows: row.defeatRows }],
    summary: (row) => `${String(row?.enemies || "(no enemies)").slice(0, 40)}${row?.storyLoss ? " · story loss" : ""}`,
    execute: executeBattle,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field("Enemies", `<input type="text" class="oni-sb-enemies oni-grow" value="${kit.escapeHTML(row.enemies)}" placeholder="Ape, Wolf x2" />`,
          "World actors by name, comma separated; \"x2\" for several of one."),
        kit.field("Battle map", `<input type="text" class="oni-sb-map oni-grow" value="${kit.escapeHTML(row.battleMap)}" placeholder="Scene name or id, e.g. Eisendrache_Battlemap001" />`),
        kit.field("BGM", `<input type="text" class="oni-sb-bgm oni-grow" value="${kit.escapeHTML(row.bgm)}" placeholder="Battle BGM name (blank = the map's default)" />`),
        kit.field("Fight", `<div class="oni-event-inline-row">
            <select class="oni-sb-engagement">${kit.options(ENGAGEMENTS, row.engagement)}</select>
            <label><input type="checkbox" class="oni-sb-boss" ${row.isBoss ? "checked" : ""} /> boss fight</label>
          </div>`),
        kit.field("If the party loses", `<div class="oni-event-inline-row">
            <label><input type="checkbox" class="oni-sb-storyloss" ${row.storyLoss ? "checked" : ""} /> story loss: carry on with Defeat</label>
            <label><input type="checkbox" class="oni-sb-recover" ${row.recoverOnDefeat ? "checked" : ""} /> recover the party (full HP / MP)</label>
          </div>`, "Without story loss a defeat ends the event after the Defeat rows.")
      );
      body.appendChild(kit.subList("victory", "Victory", row.victoryRows));
      body.appendChild(kit.subList("defeat", "Defeat", row.defeatRows));
      return body;
    },
    collectFields: (rowEl, kit) => ({
      enemies: kit.readText(rowEl, ".oni-sb-enemies", "").trim(),
      battleMap: kit.readText(rowEl, ".oni-sb-map", "").trim(),
      bgm: kit.readText(rowEl, ".oni-sb-bgm", "").trim(),
      engagement: kit.readText(rowEl, ".oni-sb-engagement", "normal"),
      isBoss: !!kit.own(rowEl, ".oni-sb-boss")?.checked,
      storyLoss: !!kit.own(rowEl, ".oni-sb-storyloss")?.checked,
      recoverOnDefeat: !!kit.own(rowEl, ".oni-sb-recover")?.checked,
      victoryRows: kit.readSubList(rowEl, "victory"),
      defeatRows: kit.readSubList(rowEl, "defeat")
    })
  });

  // ------------------------------------------------------------
  // Change Scene
  // ------------------------------------------------------------
  const ARRIVALS = [["token", "On a marker token"], ["point", "At a point"], ["spawn", "The scene's spawn point"], ["theatre", "Theatre scene (no party token)"]];

  function prepareScene(row) {
    row.scene = String(row.scene ?? "");
    row.arrival = ARRIVALS.some(([k]) => k === row.arrival) ? row.arrival : "token";
    row.mark = String(row.mark ?? "");
    row.x = Logic.toNumber(row.x, 0);
    row.y = Logic.toNumber(row.y, 0);
  }

  function arrivalPoint(row, dest) {
    if (row.arrival === "point") return { x: row.x, y: row.y };
    if (row.arrival === "token") {
      const mark = tokensNamed(dest, row.mark)[0];
      return mark ? centerOf(mark, dest) : null;
    }
    const sp = dest.flags?.[MODULE_ID]?.oniFabula?.general?.spawnPoint;
    if (sp && Number.isFinite(sp.x)) return { x: sp.x, y: sp.y };
    return { x: (dest.width ?? 1000) / 2, y: (dest.height ?? 1000) / 2 };
  }

  async function executeScene(row, context) {
    const id = String(context?.tileId || "");
    const f = flow();
    const dest = sceneByRef(row.scene);
    if (!dest) return { ok: false, reason: "noScene" };
    if (dest.id === canvas?.scene?.id) return { ok: true, type: "changeScene", same: true };

    const at = arrivalPoint(row, dest);
    if (!at) return { ok: false, reason: "noMarker" };

    const party = context?.partyToken?.document ?? canvas?.scene?.tokens?.get(context?.tokenId) ?? null;
    // Leaving a theatre scene there is no party token: the party is the
    // database actor, whose prototype token the teleporter places.
    const actorId = party?.actorId ?? context?.actorId ?? gameState()?.partyActor?.()?.id ?? null;
    const fromId = canvas?.scene?.id ?? null;

    f?.travel?.(id);
    try {
      const TP = globalThis.TeleporterSystem?.api;
      if (row.arrival === "theatre" || !actorId || !TP?.executeCrossSceneTeleport) {
        // No token on a theatre scene: take the party token off the old one.
        if (actorId && fromId) {
          const old = game.scenes.get(fromId)?.tokens?.filter?.(t => t.actorId === actorId) ?? [];
          if (old.length) await game.scenes.get(fromId).deleteEmbeddedDocuments("Token", old.map(t => t.id)).catch(() => {});
        }
        await dest.activate();
      } else {
        await TP.executeCrossSceneTeleport(actorId, fromId, dest.id, at.x, at.y);
      }
      const ok = await waitForCanvas(dest.id);
      if (!ok) return { ok: false, reason: "sceneNotReady" };
      await f?.arrive?.(id);
      return { ok: true, type: "changeScene", sceneId: dest.id };
    } catch (e) {
      console.warn(INSTALL_TAG, "Change Scene failed.", e);
      return { ok: false, reason: "changeSceneError", error: e };
    }
  }

  EventRegistry.register({
    type: "changeScene",
    label: "Change Scene",
    category: "Story",
    critical: true,
    defaultData: { type: "changeScene", scene: "", arrival: "token", mark: "", x: 0, y: 0 },
    prepare: prepareScene,
    summary: (row) => `→ ${row?.scene || "(no scene)"}${row?.arrival === "token" && row?.mark ? ` at ${row.mark}` : ""}`,
    execute: executeScene,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field("Scene", `<input type="text" class="oni-cs-scene oni-grow" value="${kit.escapeHTML(row.scene)}" placeholder="Scene name or id" />`,
          "The rest of this event carries on there."),
        kit.field("Arrive", `<select class="oni-cs-arrival">${kit.options(ARRIVALS, row.arrival)}</select>`),
        kit.field("Marker token", `<input type="text" class="oni-cs-mark oni-grow" value="${kit.escapeHTML(row.mark)}" placeholder="Name of a (hidden) token on that scene" />`),
        kit.field("Point", `<div class="oni-event-inline-row">${kit.numberInput("oni-cs-x", row.x, { step: 1 })}${kit.numberInput("oni-cs-y", row.y, { step: 1 })}</div>`)
      );
      const sel = body.querySelector(".oni-cs-arrival");
      const markF = body.querySelector(".oni-cs-mark").closest(".oni-event-inline-grid");
      const ptF = body.querySelector(".oni-cs-x").closest(".oni-event-inline-grid");
      const sync = () => { if (markF) markF.hidden = sel.value !== "token"; if (ptF) ptF.hidden = sel.value !== "point"; };
      sel.addEventListener("change", sync); sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      scene: kit.readText(rowEl, ".oni-cs-scene", "").trim(),
      arrival: kit.readText(rowEl, ".oni-cs-arrival", "token"),
      mark: kit.readText(rowEl, ".oni-cs-mark", "").trim(),
      x: kit.readNumber(rowEl, ".oni-cs-x", 0),
      y: kit.readNumber(rowEl, ".oni-cs-y", 0)
    })
  });

  // ------------------------------------------------------------
  // Move Token
  // ------------------------------------------------------------
  const MOVE_TARGETS = [["party", "The party"], ["source", "This event's token"], ["token", "A named token"]];

  function prepareMove(row) {
    row.target = MOVE_TARGETS.some(([k]) => k === row.target) ? row.target : "token";
    row.name = String(row.name ?? "");
    row.path = String(row.path ?? "");
    row.speed = Math.max(40, Math.min(2000, Logic.toNumber(row.speed, 240)));
    row.wait = row.wait !== false;
  }

  function moveDoc(row, scene, context) {
    if (row.target === "party") return scene?.tokens?.get(context?.tokenId) ?? null;
    if (row.target === "source") return context?.sourceDoc?.documentName === "Token" ? context.sourceDoc : null;
    return tokensNamed(scene, row.name)[0] ?? null;
  }

  async function executeMove(row, context) {
    const scene = canvas?.scene;
    const doc = moveDoc(row, scene, context);
    if (!doc) return { ok: false, reason: "noToken" };
    const g = scene.grid.size;
    const w = doc.width * g, h = doc.height * g;

    let cur = centerOf(doc, scene);
    const steps = [];
    for (const wp of parseWaypoints(row.path)) {
      let to = null;
      if (wp.mark) { const m = tokensNamed(scene, wp.mark).find(t => t.id !== doc.id); to = m ? centerOf(m, scene) : null; }
      else to = { x: wp.x, y: wp.y };
      if (!to) { console.warn(INSTALL_TAG, `Move Token: no marker "${wp.mark}".`); continue; }
      steps.push(to);
    }
    if (!steps.length) return { ok: false, reason: "noPath" };

    const run = async () => {
      for (const to of steps) {
        const dist = Math.hypot(to.x - cur.x, to.y - cur.y);
        const duration = Math.max(80, Math.round(dist / row.speed * 1000));
        await doc.update({ x: Math.round(to.x - w / 2), y: Math.round(to.y - h / 2) },
          { animate: true, animation: { duration }, dungeonPathing: true, teleporter: true, oniEventMove: true, pan: false });
        await sleep(duration + 40);
        cur = to;
      }
    };
    if (row.wait) await run(); else run().catch(e => console.warn(INSTALL_TAG, "Move Token failed.", e));
    return { ok: true, type: "moveToken", steps: steps.length };
  }

  EventRegistry.register({
    type: "moveToken",
    label: "Move Token",
    category: "Token",
    defaultData: { type: "moveToken", target: "token", name: "", path: "", speed: 240, wait: true },
    prepare: prepareMove,
    summary: (row) => `${row?.target === "party" ? "the party" : row?.target === "source" ? "this token" : (row?.name || "(no token)")} → ${String(row?.path || "").slice(0, 40)}`,
    execute: executeMove,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field("Who", `<div class="oni-event-inline-row">
            <select class="oni-mt-target">${kit.options(MOVE_TARGETS, row.target)}</select>
            <input type="text" class="oni-mt-name oni-grow" value="${kit.escapeHTML(row.name)}" placeholder="Token name" />
          </div>`),
        kit.field("Path", `<input type="text" class="oni-mt-path oni-grow" value="${kit.escapeHTML(row.path)}" placeholder="Kid Start; 1030, 900; Crowd Spot" />`,
          "Marker token names or x, y points, separated by ;. Walks them in order."),
        kit.field("Speed", `<div class="oni-event-inline-row">${kit.numberInput("oni-mt-speed", row.speed, { min: 40, max: 2000, step: 10 })}
            <span>px per second (240 walk, 600+ run)</span>
            <label><input type="checkbox" class="oni-mt-wait" ${row.wait ? "checked" : ""} /> wait until it arrives</label></div>`)
      );
      const sel = body.querySelector(".oni-mt-target"), nm = body.querySelector(".oni-mt-name");
      const sync = () => { nm.hidden = sel.value !== "token"; };
      sel.addEventListener("change", sync); sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      target: kit.readText(rowEl, ".oni-mt-target", "token"),
      name: kit.readText(rowEl, ".oni-mt-name", "").trim(),
      path: kit.readText(rowEl, ".oni-mt-path", "").trim(),
      speed: kit.readNumber(rowEl, ".oni-mt-speed", 240),
      wait: !!kit.own(rowEl, ".oni-mt-wait")?.checked
    })
  });

  // ------------------------------------------------------------
  // Name Input
  // ------------------------------------------------------------
  const KIND_NAME_OPEN = "story.name.open";
  const KIND_NAME_CLOSE = "story.name.close";
  const REQUEST_NAME = "story.name";
  const STYLE_ID = "oni-story-name-style";
  const pendingNames = new Map();

  function injectNameStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#oni-story-name { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 100050;
  width: min(560px, 92vw); background: linear-gradient(#1d2a4a, #121a33); border: 3px solid #d9c690; border-radius: 10px;
  padding: 14px 16px; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,.6); font-family: "Signika", sans-serif; }
#oni-story-name h4 { margin: 0 0 8px; font: 700 18px "Cinzel", serif; color: #f4e3a6; border: 0; }
#oni-story-name .f { display: flex; gap: 10px; align-items: center; background: rgba(255,255,255,.08); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
#oni-story-name input { flex: 1; background: transparent; border: 0; border-bottom: 2px solid #f4e3a6; color: #fff;
  font: 700 22px "Cinzel", serif; letter-spacing: .08em; height: auto; box-shadow: none; }
#oni-story-name .g { display: grid; grid-template-columns: repeat(13, 1fr); gap: 3px; margin-bottom: 10px; }
#oni-story-name .g button, #oni-story-name .r button { background: none; border: 0; color: #fff; padding: 3px 0; border-radius: 4px; font: 600 14px "Signika"; cursor: pointer; line-height: 1.2; }
#oni-story-name .g button:hover { background: rgba(244,227,166,.25); }
#oni-story-name .r { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #c9c3b0; align-items: center; }
#oni-story-name .r button { background: #f4e3a6; color: #1d2a4a; padding: 6px 16px; font-weight: 700; }
#oni-story-name.watch input, #oni-story-name.watch .g, #oni-story-name.watch .r button { pointer-events: none; opacity: .75; }`;
    document.head.appendChild(s);
  }

  function closeNamePanel() { document.getElementById("oni-story-name")?.remove(); }

  Client.register(KIND_NAME_OPEN, (data, info) => {
    injectNameStyle();
    closeNamePanel();
    const mayType = game.user?.isGM || !!flow()?.isLocalUserInteractor?.();
    const el = document.createElement("div");
    el.id = "oni-story-name";
    if (!mayType) el.classList.add("watch");
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("");
    el.innerHTML = `<h4></h4>
      <div class="f"><input type="text" maxlength="${data.max ?? 16}" /></div>
      <div class="g">${letters.map(l => `<button type="button" data-l="${l}">${l}</button>`).join("")}</div>
      <div class="r"><span class="who"></span><span><button type="button" data-del>Del</button> <button type="button" data-ok>OK</button></span></div>`;
    el.querySelector("h4").textContent = data.prompt || "Please enter a name";
    el.querySelector(".who").textContent = mayType ? "Type with the keyboard or pick letters" : "The main controller is typing…";
    const inp = el.querySelector("input");
    inp.value = data.initial ?? "";
    const send = () => {
      const v = inp.value.trim() || String(data.initial ?? "").trim();
      if (!v) return;
      flow()?.request?.(REQUEST_NAME, { sourceId: info.sourceId, name: v });
    };
    el.addEventListener("click", (ev) => {
      const t = ev.target;
      if (t.dataset?.l && inp.value.length < (data.max ?? 16)) inp.value += t.dataset.l;
      if (t.hasAttribute?.("data-del")) inp.value = inp.value.slice(0, -1);
      if (t.hasAttribute?.("data-ok")) send();
    });
    inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") send(); });
    document.body.appendChild(el);
    if (mayType) setTimeout(() => inp.focus(), 50);
    Client.addCleanup(info.sourceId, "story.name", () => closeNamePanel());
  });

  Client.register(KIND_NAME_CLOSE, (data, info) => {
    closeNamePanel();
    Client.removeCleanup(info.sourceId, "story.name");
  });

  Hooks.once("ready", () => flow()?.onRequest?.(REQUEST_NAME, async (data, userId) => {
    if (!(await flow()?.isUserInteractor?.(userId))) return;
    pendingNames.get(String(data?.sourceId || ""))?.(String(data?.name ?? "").slice(0, 32));
  }));

  function prepareName(row) {
    row.prompt = String(row.prompt ?? "Please enter your party's name");
    row.variable = String(row.variable ?? "Party Name");
    row.initialFrom = row.initialFrom === "blank" ? "blank" : "party";
    row.renameParty = row.renameParty === true;
    row.suffix = String(row.suffix ?? " Party");
    row.max = Math.max(1, Math.min(32, Math.round(Logic.toNumber(row.max, 16))));
  }

  function currentPartyName(suffix) {
    const name = String(gameState()?.partyActor?.()?.name ?? "");
    return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  }

  async function executeName(row, context) {
    const id = String(context?.tileId || "");
    const f = flow();
    if (!id || !f) return { ok: false, reason: "noFlow" };
    const stored = String(gameState()?.getVariableText?.(row.variable) ?? "").trim();
    const initial = stored || (row.initialFrom === "party" ? currentPartyName(row.suffix) : "");

    f.hold(id);
    let offAbort = null;
    const name = await new Promise((resolve) => {
      pendingNames.set(id, resolve);
      offAbort = f.onAbort(id, () => resolve(null));
      Client.run(id, KIND_NAME_OPEN, { prompt: row.prompt, initial, max: row.max });
    });
    offAbort?.();
    pendingNames.delete(id);
    f.release(id);
    Client.run(id, KIND_NAME_CLOSE);
    if (name === null) return { ok: true, type: "nameInput", aborted: true };

    await gameState()?.setVariableText?.(row.variable, name);
    if (row.renameParty) {
      const party = gameState()?.partyActor?.();
      if (party) await party.update({ name: `${name}${row.suffix}` });
    }
    return { ok: true, type: "nameInput", name };
  }

  EventRegistry.register({
    type: "nameInput",
    label: "Name Input",
    category: "Party",
    defaultData: { type: "nameInput", prompt: "Please enter your party's name", variable: "Party Name", initialFrom: "party", renameParty: true, suffix: " Party", max: 16 },
    prepare: prepareName,
    summary: (row) => `→ {var:${row?.variable || "?"}}${row?.renameParty ? " + rename party" : ""}`,
    execute: executeName,
    buildFields: (row, kit) => kit.fields(
      kit.field("Prompt", `<input type="text" class="oni-ni-prompt oni-grow" value="${kit.escapeHTML(row.prompt)}" />`),
      kit.field("Store in", kit.nameInput("oni-ni-var", row.variable, "variable"), "A text variable; print it in any line with {var:Party Name}."),
      kit.field("Start from", `<select class="oni-ni-initial">${kit.options([["party", "The party's current name"], ["blank", "Blank"]], row.initialFrom)}</select>`),
      kit.field("Party", `<div class="oni-event-inline-row">
          <label><input type="checkbox" class="oni-ni-rename" ${row.renameParty ? "checked" : ""} /> rename the party database actor to the name +</label>
          <input type="text" class="oni-ni-suffix" value="${kit.escapeHTML(row.suffix)}" style="max-width:8em" /></div>`),
      kit.field("Max letters", kit.numberInput("oni-ni-max", row.max, { min: 1, max: 32, step: 1 }))
    ),
    collectFields: (rowEl, kit) => ({
      prompt: kit.readText(rowEl, ".oni-ni-prompt", "").trim(),
      variable: kit.readText(rowEl, ".oni-ni-var", "Party Name").trim(),
      initialFrom: kit.readText(rowEl, ".oni-ni-initial", "party"),
      renameParty: !!kit.own(rowEl, ".oni-ni-rename")?.checked,
      suffix: kit.readText(rowEl, ".oni-ni-suffix", " Party"),
      max: kit.readNumber(rowEl, ".oni-ni-max", 16)
    })
  });

  // ------------------------------------------------------------
  // Recover All
  // ------------------------------------------------------------
  EventRegistry.register({
    type: "recoverAll",
    label: "Recover All",
    category: "Party",
    defaultData: { type: "recoverAll" },
    summary: () => "Full HP / MP, ailments cured",
    execute: async () => {
      const n = await recoverParty();
      return { ok: true, type: "recoverAll", members: n };
    },
    buildFields: (row, kit) => kit.fields(`<div class="oni-event-row-notes">Every party member back to full HP and MP, status ailments cured. No curtain or sound: put a Screen Effect around it if you want one.</div>`),
    collectFields: () => ({})
  });

  // ------------------------------------------------------------
  // Loop / Break Loop (RPG Maker style): a question menu that comes back
  // until the player picks "No more questions".
  // ------------------------------------------------------------
  const LOOP_MAX = 60;

  // One pass's result -> what the loop does next.
  function loopStep(result) {
    if (!result?.stop) return "again";
    if (result.breakLoop) return "break";
    return "stop";
  }

  EventRegistry.register({
    type: "loop",
    label: "Loop",
    category: "Flow",
    defaultData: { type: "loop", rows: [] },
    prepare: (row) => { if (!Array.isArray(row.rows)) row.rows = []; },
    childLists: (row) => [{ label: "Repeat", rows: row.rows }],
    summary: (row) => `${(row?.rows ?? []).length} row(s), until Break Loop`,
    execute: async (row, context) => {
      for (let i = 0; i < LOOP_MAX; i += 1) {
        const result = await context.runRows(row.rows ?? []);
        const next = loopStep(result);
        if (next === "break") return { ok: true, type: "loop", passes: i + 1 };
        if (next === "stop") return { ...result, type: "loop" };
      }
      console.warn(INSTALL_TAG, `Loop: stopped after ${LOOP_MAX} passes (no Break Loop ran).`);
      return { ok: true, type: "loop", passes: LOOP_MAX };
    },
    buildFields: (row, kit) => {
      const body = kit.fields(`<div class="oni-event-row-notes">The rows below repeat until a Break Loop row runs (put one under a choice). End Event still ends everything.</div>`);
      body.appendChild(kit.subList("loop", "Repeat", row.rows));
      return body;
    },
    collectFields: (rowEl, kit) => ({ rows: kit.readSubList(rowEl, "loop") })
  });

  EventRegistry.register({
    type: "breakLoop",
    label: "Break Loop",
    category: "Flow",
    defaultData: { type: "breakLoop" },
    summary: () => "leave the loop",
    execute: async () => ({ ok: true, type: "breakLoop", stop: true, breakLoop: true }),
    buildFields: (row, kit) => kit.fields(`<div class="oni-event-row-notes">Leaves the nearest Loop; the event carries on after it. Outside a loop it ends the event.</div>`),
    collectFields: () => ({})
  });

  window.oni.EventSystem.RowsStory = { installed: true, parseEnemyList, parseWaypoints, battleBranch, loopStep };
  console.debug(INSTALL_TAG, "Installed.");
})();
