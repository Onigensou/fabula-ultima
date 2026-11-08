// ============================================================================
// Place State — one place, several story states (multi-state maps)
// ----------------------------------------------------------------------------
// Ruhig Village and Ruhig Village Ruin are the SAME place at different points
// in the story. Each state is its own scene; an Event System switch decides
// which one is current (classic JRPG: separate map copies + a story flag that
// every entrance checks before sending the party in).
//
// Scene flags (Scene Config → Fabula tab → "Story State"):
//   flags.<mod>.place.id          place name shared by every state, e.g. "Ruhig Village"
//   flags.<mod>.place.activeWhen  switch that makes this state current; blank = the
//                                 starting state
//   flags.<mod>.place.stage       when several switches are ON, the highest stage
//                                 wins (default 0 for the starting state, 1 otherwise)
//
// Story BGM (any scene, e.g. a shop that stays open after the city burns):
//   flags.<mod>.storyBgm = { when, normalPlaylist, normalSound, altPlaylist, altSound }
//   The primary GM writes the scene's playlist / playlistSound from the switch.
//
// Who uses it:
//   doors        tp-api redirects any destination on a state scene to the current
//                state, same coordinates (state maps share one layout)
//   Travel       dp-scene-travel lists only the current state; a place counts as
//                visited when ANY of its states was visited
//   GM           a warning when the GM opens a state that is not current
// ============================================================================
(() => {
  const MOD = "fabula-ultima-companion";
  const TAG = "[PlaceState]";
  const KEY = "place";
  const BGM_KEY = "storyBgm";

  const str = (v) => String(v ?? "").trim();
  const placeFlags = (scene) => scene?.flags?.[MOD]?.[KEY] ?? {};
  const placeIdOf = (scene) => str(placeFlags(scene).id);
  const activeWhenOf = (scene) => str(placeFlags(scene).activeWhen);
  const stageOf = (scene) => {
    const n = Number(placeFlags(scene).stage);
    if (Number.isFinite(n) && str(placeFlags(scene).stage) !== "") return n;
    return activeWhenOf(scene) ? 1 : 0;
  };
  const placeKey = (id) => str(id).toLowerCase();

  const switchOn = (name) => {
    try { return globalThis.oni?.GameState?.getSwitch?.(name) === true; } catch { return false; }
  };

  const allScenes = () => {
    const s = game.scenes;
    return s?.contents ?? (Array.isArray(s) ? s : [...(s ?? [])]);
  };

  // ── Pure logic (node-testable) ─────────────────────────────────────────────
  /**
   * The current state among a place's scenes. A state is eligible when it has
   * no switch (the starting state) or its switch is ON; the highest stage
   * wins, ties go to the state with a switch, then to the name.
   */
  function pickCurrent(states, isOn = switchOn) {
    let best = null;
    for (const sc of states ?? []) {
      const when = activeWhenOf(sc);
      if (when && isOn(when) !== true) continue;
      if (!best) { best = sc; continue; }
      const d = stageOf(sc) - stageOf(best);
      const tie = d === 0 && (
        (!!when - !!activeWhenOf(best)) ||
        String(best.name ?? "").localeCompare(String(sc.name ?? ""))
      ) > 0;
      if (d > 0 || tie) best = sc;
    }
    // Nothing eligible (every state is switch-gated and all OFF): lowest stage.
    if (!best && states?.length) {
      best = [...states].sort((a, b) => stageOf(a) - stageOf(b))[0];
    }
    return best;
  }

  function statesOf(placeId, scenes = allScenes()) {
    const k = placeKey(placeId);
    if (!k) return [];
    return scenes.filter(sc => placeKey(placeIdOf(sc)) === k);
  }

  /** The scene the party should be on for this scene's place (itself if no place). */
  function currentSceneFor(sceneOrId, { scenes = allScenes(), isOn = switchOn } = {}) {
    const scene = typeof sceneOrId === "string" ? scenes.find(s => s.id === sceneOrId) : sceneOrId;
    if (!scene) return null;
    const id = placeIdOf(scene);
    if (!id) return scene;
    const states = statesOf(id, scenes);
    if (states.length < 2) return scene;
    return pickCurrent(states, isOn) ?? scene;
  }

  function redirectId(sceneId, opts) {
    if (!sceneId) return sceneId;
    return currentSceneFor(sceneId, opts)?.id ?? sceneId;
  }

  /** A state scene that is not its place's current state. */
  function isSuperseded(scene, opts) {
    if (!placeIdOf(scene)) return false;
    const cur = currentSceneFor(scene, opts);
    return !!cur && cur.id !== scene.id;
  }

  function samePlace(a, b) {
    if (!a || !b) return false;
    if (a.id === b.id) return true;
    const ka = placeKey(placeIdOf(a));
    return !!ka && ka === placeKey(placeIdOf(b));
  }

  /** Any state of this scene's place satisfies `pred` (e.g. "was visited"). */
  function anyState(scene, pred, scenes = allScenes()) {
    const id = placeIdOf(scene);
    if (!id) return !!pred(scene);
    return statesOf(id, scenes).some(s => !!pred(s));
  }

  // ── Story BGM (pure planning) ──────────────────────────────────────────────
  function bgmOf(scene) {
    const b = scene?.flags?.[MOD]?.[BGM_KEY];
    if (!b || !str(b.when)) return null;
    return {
      when: str(b.when),
      normal: { playlist: str(b.normalPlaylist) || null, sound: str(b.normalSound) || null },
      alt:    { playlist: str(b.altPlaylist)    || null, sound: str(b.altSound)    || null }
    };
  }

  /** The playlist/sound update this scene needs, or null when it already matches. */
  function planBgm(scene, isOn = switchOn) {
    const b = bgmOf(scene);
    if (!b) return null;
    const want = isOn(b.when) === true ? b.alt : b.normal;
    if (!want.playlist && !want.sound) return null;
    const cur = typeof scene.toObject === "function" ? scene.toObject() : scene;
    const update = {};
    if ((cur.playlist ?? null) !== want.playlist) update.playlist = want.playlist;
    if ((cur.playlistSound ?? null) !== want.sound) update.playlistSound = want.sound;
    return Object.keys(update).length ? update : null;
  }

  // ── Runtime: primary GM keeps scene BGM in line with the switches ──────────
  let _running = false, _again = false;
  async function reconcile() {
    if (!game.ready || !globalThis.FUCompanion?.isPrimaryGM?.()) return;
    if (_running) { _again = true; return; }
    _running = true;
    try {
      do {
        _again = false;
        for (const scene of allScenes()) {
          const update = planBgm(scene);
          if (update) await scene.update(update);
        }
      } while (_again);
    } catch (e) {
      console.warn(TAG, "BGM reconcile failed", e);
    } finally {
      _running = false;
    }
  }

  function warnIfSuperseded() {
    try {
      if (!game.user?.isGM) return;
      const scene = canvas?.scene;
      if (!scene || !isSuperseded(scene)) return;
      const cur = currentSceneFor(scene);
      ui.notifications?.warn?.(
        `${TAG} "${scene.name}" is not the current state of ${placeIdOf(scene)} — the story is at "${cur?.name}". Players are sent there.`
      );
    } catch (e) { console.warn(TAG, "superseded check failed", e); }
  }

  if (typeof Hooks !== "undefined") {
    Hooks.once("ready", () => { reconcile(); });
    Hooks.on("oniGameStateChanged", () => { reconcile(); });
    Hooks.on("canvasReady", () => { reconcile(); warnIfSuperseded(); });
  }

  // ── Scene Config fields ────────────────────────────────────────────────────
  function soundOptions(selectedPlaylist, selectedSound) {
    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    let html = `<option value="">— none —</option>`;
    for (const pl of game.playlists ?? []) {
      html += `<optgroup label="${esc(pl.name)}">`;
      for (const snd of pl.sounds ?? []) {
        const v = `${pl.id}|${snd.id}`;
        const sel = (pl.id === selectedPlaylist && snd.id === selectedSound) ? " selected" : "";
        html += `<option value="${v}"${sel}>${esc(snd.name)}</option>`;
      }
      html += `</optgroup>`;
    }
    return html;
  }

  function injectSceneFields(app, html) {
    if (!game.user?.isGM) return;
    const root = html?.[0] ?? html;
    const scene = app.document ?? app.object;
    if (!root || !scene || root.querySelector(".oni-place-state")) return;
    const navInput = root.querySelector('input[name$=".general.navigationName"]');
    const anchor = navInput?.closest(".form-group");
    if (!anchor) return;

    const p = placeFlags(scene);
    const b = scene.flags?.[MOD]?.[BGM_KEY] ?? {};
    const wrap = document.createElement("div");
    wrap.className = "oni-place-state";
    wrap.innerHTML = `
      <h3 style="margin:12px 0 6px;"><i class="fas fa-clock-rotate-left"></i> Story State</h3>
      <p class="notes" style="margin:0 0 8px;">
        Same place, different point in the story (Ruhig Village / Ruhig Village Ruin).
        Give every state the same <b>Place</b>. Doors and the Travel dialog always send the
        party to the current state, at the same spot.
      </p>
      <div class="form-group">
        <label>Place</label>
        <div class="form-fields"><input type="text" name="flags.${MOD}.${KEY}.id" placeholder="e.g. Ruhig Village" /></div>
      </div>
      <div class="form-group">
        <label>Current when switch ON</label>
        <div class="form-fields"><input type="text" name="flags.${MOD}.${KEY}.activeWhen" placeholder="blank = starting state" /></div>
        <p class="notes">Event System switch, e.g. <i>Ruhig Destroyed</i>. Leave blank on the starting state.</p>
      </div>
      <div class="form-group">
        <label>Stage</label>
        <div class="form-fields"><input type="number" step="1" name="flags.${MOD}.${KEY}.stage" placeholder="auto" /></div>
        <p class="notes">Only needed with three or more states: when several switches are ON, the highest stage wins.</p>
      </div>

      <h3 style="margin:12px 0 6px;"><i class="fas fa-music"></i> Story BGM</h3>
      <p class="notes" style="margin:0 0 8px;">For a scene that stays the same map but changes music with the story (a shop after the city burns).</p>
      <div class="form-group">
        <label>Switch</label>
        <div class="form-fields"><input type="text" name="flags.${MOD}.${BGM_KEY}.when" placeholder="blank = off" /></div>
      </div>
      <div class="form-group">
        <label>BGM while OFF</label>
        <div class="form-fields"><select class="oni-bgm-normal">${soundOptions(b.normalPlaylist, b.normalSound)}</select></div>
      </div>
      <div class="form-group">
        <label>BGM while ON</label>
        <div class="form-fields"><select class="oni-bgm-alt">${soundOptions(b.altPlaylist, b.altSound)}</select></div>
      </div>
      <input type="hidden" name="flags.${MOD}.${BGM_KEY}.normalPlaylist" />
      <input type="hidden" name="flags.${MOD}.${BGM_KEY}.normalSound" />
      <input type="hidden" name="flags.${MOD}.${BGM_KEY}.altPlaylist" />
      <input type="hidden" name="flags.${MOD}.${BGM_KEY}.altSound" />`;

    const set = (name, v) => { const el = wrap.querySelector(`[name="flags.${MOD}.${name}"]`); if (el) el.value = v ?? ""; };
    set(`${KEY}.id`, p.id);
    set(`${KEY}.activeWhen`, p.activeWhen);
    set(`${KEY}.stage`, str(p.stage));
    set(`${BGM_KEY}.when`, b.when);
    set(`${BGM_KEY}.normalPlaylist`, b.normalPlaylist);
    set(`${BGM_KEY}.normalSound`, b.normalSound);
    set(`${BGM_KEY}.altPlaylist`, b.altPlaylist);
    set(`${BGM_KEY}.altSound`, b.altSound);
    const bindSelect = (cls, prefix) => {
      wrap.querySelector(cls)?.addEventListener("change", (ev) => {
        const [pl, snd] = String(ev.target.value || "|").split("|");
        set(`${BGM_KEY}.${prefix}Playlist`, pl);
        set(`${BGM_KEY}.${prefix}Sound`, snd);
      });
    };
    bindSelect(".oni-bgm-normal", "normal");
    bindSelect(".oni-bgm-alt", "alt");

    anchor.after(wrap);
    app.setPosition?.({ height: "auto" });
  }

  // The Fabula tab (dungeon-configuration-ui.js) builds its fields from a
  // renderSceneConfig hook it registers at "ready"; registering ours at
  // "ready" too (later file) puts it after theirs.
  if (typeof Hooks !== "undefined") {
    Hooks.once("ready", () => {
      Hooks.on("renderSceneConfig", (app, html) => {
        try { injectSceneFields(app, html); } catch (e) { console.warn(TAG, "scene config inject failed", e); }
      });
    });
  }

  globalThis.oni ??= {};
  globalThis.oni.Place = {
    placeIdOf, activeWhenOf, stageOf, pickCurrent, statesOf, currentSceneFor, redirectId,
    isSuperseded, samePlace, anyState, bgmOf, planBgm, reconcile
  };
})();
