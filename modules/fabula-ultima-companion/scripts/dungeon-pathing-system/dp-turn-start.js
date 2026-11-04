// ============================================================================
// Dungeon Pathing — Turn Start (count, HUD chip, walkable-tile pulse)
// ----------------------------------------------------------------------------
// The quiet beat that opens every dungeon turn (host design, 2026-11-04,
// replacing an earlier full-width banner as "too prominent"):
//
//   · the TURN CHIP in the Party Status HUD ticks up ("Turn 12"), lights for a
//     moment, then rests dimmed. It takes the slot the Vertigo chip already
//     uses: party-level, above the member rows. On the first turn after the
//     party arrives on a scene it also names the area.
//   · the WALKABLE tiles next to the party pulse once: one thin ring outward.
//     Subtle by design. It never blocks input and stops the moment the party
//     moves.
//
// No turn-start cue plays when a battle launches: only the shatter means a
// battle (see dp-random-battle.js).
//
// ── The count ────────────────────────────────────────────────────────────────
// Turns since the last Rest. A Rest usually closes the session, so in practice
// it is the night's turn count. One turn = one CONFIRMED step:
//   · Go Back never reaches turnEnd, so it never counts;
//   · Force Move / Slippery / Push Back chains run inside one turn → one count;
//   · Vertigo auto-confirms and Use both count;
//   · the step that starts a battle counts (silently).
// Stored party-wide in a world setting, NOT on a scene, so leaving, changing
// floors or a second dungeon the same night keep counting. Only the GM writes
// it; every client reacts through the setting's onChange, which is also what
// fires the cue — so every screen gets it at the same moment.
//
// A world setting rather than the Database actor: other systems listen to
// updates on that actor, and a write per step would wake them all.
//
// Reset: `fabula.restPerformed` (camp-system/rest-api.js), which runs on the
// GM that performed the Rest.
// ============================================================================
(() => {
  const DP      = globalThis.DungeonPathing ??= {};
  const TAG     = "[DungeonPathing][TurnStart]";
  const MOD     = DP.MODULE_ID ?? "fabula-ultima-companion";
  const SETTING = "dpTurnCount";
  const CHIP_ID = "oni-dp-hud-turn";
  const STYLE_ID = "oni-dp-turn-start-styles";

  const cfgPulse = () => DP.UI?.TURN_PULSE ?? {};
  const cfgChip  = () => DP.UI?.TURN_CHIP ?? {};
  const bootstrap = () => globalThis.__ONI_DUNGEON_PATHING__;

  // ── Setting ────────────────────────────────────────────────────────────────
  // { count, seq, reason: "step" | "battle" | "rest" }. `seq` makes every write
  // a change, so onChange fires even when two writes carry the same count.
  Hooks.once("init", () => {
    try {
      game.settings.register(MOD, SETTING, {
        scope: "world", config: false, type: Object,
        default: { count: 0, seq: 0, reason: "init" },
        onChange: (v) => onCountChanged(v),
      });
    } catch (e) { console.warn(TAG, "settings.register failed", e); }
  });

  function readCount() {
    try { return game.settings.get(MOD, SETTING) ?? { count: 0, seq: 0 }; }
    catch { return { count: 0, seq: 0 }; }
  }
  const turnNumber = () => (Number(readCount().count) || 0) + 1;

  // ── GM writes ──────────────────────────────────────────────────────────────
  // Serialised: two steps resolved back to back must not read the same count.
  let _writeChain = Promise.resolve();
  function gmWrite(fn) {
    if (!game.user?.isGM) return Promise.resolve();
    _writeChain = _writeChain.then(async () => {
      const cur = readCount();
      await game.settings.set(MOD, SETTING, { ...fn(cur), seq: (Number(cur.seq) || 0) + 1 });
    }).catch(e => console.warn(TAG, "count write failed", e));
    return _writeChain;
  }
  const gmStep  = ({ battle = false } = {}) =>
    gmWrite(cur => ({ count: (Number(cur.count) || 0) + 1, reason: battle ? "battle" : "step" }));
  const gmReset = () => gmWrite(() => ({ count: 0, reason: "rest" }));

  // The Rest API runs on exactly one GM and fires this hook there only.
  Hooks.on("fabula.restPerformed", () => {
    if (!game.user?.isGM) return;
    gmReset();
  });

  // ── Player-side request (called by the turn loop) ──────────────────────────
  async function stepTaken({ battle = false } = {}) {
    try {
      if (game.user?.isGM) return await gmStep({ battle });
      await DP.Socket?.requestTurnStep?.({ battle });
    } catch (e) {
      // Never let the counter break a turn — e.g. no GM online.
      console.warn(TAG, "turn step not counted:", e?.message ?? e);
    }
  }

  // ── Reaction on every client ───────────────────────────────────────────────
  function inDungeon() {
    const st = bootstrap()?.state;
    return !!(st?.active && !st.battleLaunching && canvas?.ready);
  }

  function onCountChanged(v) {
    renderChipNumber(true);
    if (!inDungeon()) return;
    if (v?.reason === "step") { cue({ roll: true }); return; }
    if (v?.reason === "rest") wakeChip(false);
    // "battle": the shatter is coming — no cue, the number just moves on.
  }

  // The first turn after arriving on a scene (dp-bootstrap activate()).
  // Coming back to the same scene from a battle is not an arrival: no name.
  let _lastSceneId = null;
  function onEnterScene(scene) {
    const arrived = scene?.id !== _lastSceneId;
    _lastSceneId = scene?.id ?? null;
    renderChipNumber(false);
    cue({ roll: false, named: arrived, scene });
  }

  function cue({ roll = false, named = false, scene = canvas?.scene } = {}) {
    wakeChip(named, scene);
    pulse();
    const c = cfgPulse();
    if (c.SOUND && DP.SOUNDS?.[c.SOUND]) {
      try { AudioHelper.play({ src: DP.SOUNDS[c.SOUND], volume: c.VOLUME ?? 0.3, autoplay: true, loop: false }, false); }
      catch (e) { console.warn(TAG, "tick failed", e); }
    }
  }

  // ── The chip ───────────────────────────────────────────────────────────────
  // One persistent element. The HUD rebuilds its innerHTML on every render, so
  // it re-attaches this node (DP.StatusHUD) instead of drawing its own: the
  // number roll and the light survive a re-render.
  let _chip = null, _restTimer = null, _nameTimer = null;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${CHIP_ID} {
  display: flex; align-items: center; gap: 6px; align-self: flex-start;
  padding: 3px 11px 3px 9px; border-radius: 8px;
  border: 1px solid rgba(200,160,80,0.32);
  background: rgba(14,10,4,0.88); backdrop-filter: blur(6px);
  box-shadow: 0 2px 10px rgba(0,0,0,0.5);
  color: #e8d6a8;
  font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  font-size: 12px; font-weight: 700; letter-spacing: 0.06em; white-space: nowrap;
  text-shadow: 0 0 6px rgba(0,0,0,0.8);
  opacity: 0.62;
  transition: opacity 600ms ease, border-color 900ms ease, box-shadow 900ms ease;
}
#${CHIP_ID}.lit {
  opacity: 1; border-color: rgba(232,200,112,0.85);
  box-shadow: 0 0 0 1px rgba(232,200,112,0.18), 0 2px 12px rgba(0,0,0,0.5), 0 0 14px rgba(232,200,112,0.22);
  transition-duration: 160ms;
}
#${CHIP_ID} .area {
  overflow: hidden; max-width: 0; opacity: 0;
  color: #c9b27a; font-weight: 400; font-style: italic;
  transition: max-width 520ms cubic-bezier(.4,0,.2,1), opacity 380ms ease;
}
#${CHIP_ID}.named .area { max-width: 16em; opacity: 1; }
#${CHIP_ID} .lab { color: #b89a5a; font-size: 0.85em; letter-spacing: 0.14em; text-transform: uppercase; }
#${CHIP_ID} .num {
  position: relative; display: inline-block; min-width: 1.4em; height: 1.2em;
  overflow: hidden; font-variant-numeric: tabular-nums; color: #fff1cc;
}
#${CHIP_ID} .num b { position: absolute; left: 0; top: 0; font-weight: 700; }`;
    document.head.appendChild(s);
  }

  function chipEl() {
    if (cfgChip().ENABLED === false) return null;
    if (_chip) return _chip;
    injectStyles();
    _chip = document.createElement("div");
    _chip.id = CHIP_ID;
    _chip.title = "Turns since the last Rest";
    _chip.innerHTML = `<span class="area"></span><span class="lab">Turn</span><span class="num"><b class="old"></b><b class="new"></b></span>`;
    _chip.querySelector(".new").textContent = String(turnNumber());
    return _chip;
  }

  function renderChipNumber(roll) {
    const el = _chip;
    if (!el) return;
    const oldB = el.querySelector(".old"), newB = el.querySelector(".new");
    const v = String(turnNumber());
    if (newB.textContent === v) return;
    if (!roll) { oldB.textContent = ""; newB.textContent = v; return; }
    oldB.textContent = newB.textContent; newB.textContent = v;
    const o = { duration: 420, easing: "cubic-bezier(.3,.7,.3,1)", fill: "both" };
    try {
      const out = oldB.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], o);
      // Drop the outgoing number once it has rolled away, so the chip never
      // holds two numbers (its textContent read "Turn45" after a battle).
      out.onfinish = () => { if (oldB.textContent !== newB.textContent) { oldB.textContent = ""; out.cancel(); } };
      newB.animate([{ transform: "translateY(100%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], o);
    } catch { /* no WAAPI: the number just changes */ }
  }

  function areaName(scene) {
    const g = scene?.flags?.[MOD]?.[DP.FABULA_ROOT_KEY ?? "oniFabula"]?.[DP.GENERAL_KEY ?? "general"] ?? {};
    // Authored player-facing names only (the Area Name Panel's areaName, then
    // the travel dialog's navigationName). The scene's own name is a working
    // title and must never reach the players.
    return String(g.areaName || g.navigationName || "").trim();
  }

  function wakeChip(named, scene = canvas?.scene) {
    const el = _chip;
    if (!el) return;
    const c = cfgChip();
    clearTimeout(_restTimer); clearTimeout(_nameTimer);
    const name = named && c.SHOW_AREA ? areaName(scene) : "";
    el.querySelector(".area").textContent = name ? `${name} ·` : "";
    el.classList.add("lit");
    el.classList.toggle("named", !!name);
    _restTimer = setTimeout(() => el.classList.remove("lit"), name ? (c.NAMED_LIT_MS ?? 3400) : (c.LIT_MS ?? 1800));
    if (name) _nameTimer = setTimeout(() => el.classList.remove("named"), c.NAME_MS ?? 3000);
  }

  // ── The pulse ──────────────────────────────────────────────────────────────
  // One PIXI.Graphics on the stage, just under the hover highlight (999997),
  // redrawn by the canvas ticker for the ~1s the pulse lasts, then removed.
  let _g = null, _tick = null;

  function stopPulse() {
    if (_tick) { try { canvas.app.ticker.remove(_tick); } catch {} _tick = null; }
    if (_g) { try { _g.parent?.removeChild(_g); _g.destroy(); } catch {} _g = null; }
  }

  function pulse() {
    stopPulse();
    const c = cfgPulse();
    if (c.ENABLED === false || !canvas?.stage || !canvas?.app?.ticker) return;
    const st = bootstrap()?.state;
    const nodes = (st?.graph?.nodes ?? []).filter(n => st.neighborIds?.has(n.nodeId) && n.bounds);
    if (!nodes.length) return;
    nodes.sort((a, b) => a.bounds.left - b.bounds.left);   // a left-to-right sweep

    const g = new PIXI.Graphics();
    g.name = "ONI DungeonPathing TurnPulse";
    g.zIndex = 999996;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(g);
    _g = g;

    const k       = c.STRENGTH ?? 0.4;
    const color   = c.COLOR ?? 0xffe08c;
    const delay   = c.DELAY_MS ?? 120;
    const stagger = c.STAGGER_MS ?? 90;
    const dur     = c.DURATION_MS ?? 950;
    const grow    = c.GROW ?? 0.4;              // × the tile's smaller half-size
    // Dungeon tile art is round tokens in square bounds, so a square ring reads
    // boxy (seen on Valley_Map009). ROUND hugs the art: full corner radius gives
    // a circle on square tiles and a pill on oblong ones.
    const round   = c.ROUND !== false;
    const corner  = DP.UI?.HOVER_HIGHLIGHT?.CORNER_R ?? 6;
    const t0      = performance.now();
    const ease    = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

    _tick = () => {
      const now = performance.now();
      // Keep lines ~2px on screen whatever the zoom.
      const px = 1 / (canvas.stage.scale?.x || 1);
      g.clear();
      let live = false;
      nodes.forEach((n, j) => {
        const u = (now - t0 - delay - j * stagger) / dur;
        if (u < 0) { live = true; return; }
        if (u >= 1) return;
        live = true;
        const b = n.bounds, w = b.right - b.left, h = b.bottom - b.top;
        const out = ease(u * 1.15) * grow * Math.min(w, h) / 2;
        const cr  = (extra) => round ? Math.min(w, h) / 2 + extra : corner + extra;
        // the ring, travelling outward and fading
        g.lineStyle(2.2 * px, color, k * 0.85 * Math.pow(1 - u, 1.6));
        g.drawRoundedRect(b.left - out, b.top - out, w + out * 2, h + out * 2, cr(out));
        // a brief brightening of the tile's own edge
        const rim = k * 0.6 * Math.sin(Math.PI * Math.min(1, u * 1.6));
        if (rim > 0.01) {
          g.lineStyle(2 * px, color, rim);
          g.drawRoundedRect(b.left, b.top, w, h, cr(0));
        }
      });
      if (!live) stopPulse();
    };
    canvas.app.ticker.add(_tick);
  }

  // The party moved: the pulse belongs to the turn that just ended.
  Hooks.on(DP.HOOKS?.TURN_START ?? "dungeonPathing.turnStart", stopPulse);
  Hooks.on("canvasTearDown", () => { stopPulse(); });

  DP.TurnStart = { stepTaken, gmStep, gmReset, onEnterScene, chipEl, stopPulse, turnNumber, _cue: cue };
  console.debug(TAG, "Loaded.");
})();
