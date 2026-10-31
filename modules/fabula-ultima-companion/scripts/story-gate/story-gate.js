// ============================================================================
// Story Gate — a barrier that opens when an Event System switch turns ON
// ----------------------------------------------------------------------------
// One switch name, set on whatever makes up the barrier:
//
//   Path line       flags.<mod>.dungeonPathing.requiresSwitch (dp-worldmap.js)
//                   Not walkable and invisible to players until ON.
//   Teleporter tile flags.<mod>.teleporter.requiresSwitch (tp-bootstrap.js)
//                   Does nothing until ON.
//   Barrier tile    flags.<mod>.storyGate.openedBy (this file)
//                   Shown until ON, then hidden.
//   Barrier wall    flags.<mod>.storyGate.openedBy (this file)
//                   Blocks movement until ON, then lets tokens through.
//
// Tiles and walls are scene data, so one client has to write them: the primary
// GM reconciles every gated document against the switches, whichever scene it
// is viewing. Reconciling (not toggling) means a loaded save or a re-created
// tile ends up right without anyone remembering what state it was in.
// ============================================================================
(() => {
  const MOD = "fabula-ultima-companion";
  const TAG = "[StoryGate]";
  const KEY = "storyGate";

  const MOVE_BLOCKED = 20;   // CONST.WALL_MOVEMENT_TYPES.NORMAL
  const MOVE_OPEN    = 0;    // CONST.WALL_MOVEMENT_TYPES.NONE

  const openedBy = (doc) => String(doc?.flags?.[MOD]?.[KEY]?.openedBy ?? "").trim();

  const switchOn = (name) => {
    try { return globalThis.oni?.GameState?.getSwitch?.(name) === true; } catch { return false; }
  };

  /** A blank name is no gate. Without the game state a gate stays shut. */
  const isClosed = (name) => {
    const label = String(name ?? "").trim();
    return !!label && !switchOn(label);
  };

  /**
   * The writes needed to bring one scene in line with the switches.
   * Plain calculation: documents and the switch reader are passed in.
   */
  function planScene(scene, isOn = switchOn) {
    const tiles = [], walls = [];
    for (const tile of scene?.tiles ?? []) {
      const name = openedBy(tile);
      if (!name) continue;
      const hidden = isOn(name) === true;
      if (!!tile.hidden !== hidden) tiles.push({ _id: tile.id ?? tile._id, hidden });
    }
    for (const wall of scene?.walls ?? []) {
      const name = openedBy(wall);
      if (!name) continue;
      const move = isOn(name) === true ? MOVE_OPEN : MOVE_BLOCKED;
      if (wall.move !== move) walls.push({ _id: wall.id ?? wall._id, move });
    }
    return { tiles, walls };
  }

  // Several triggers land together (a save being loaded): one pass at a time,
  // and one more afterwards if anything asked during it.
  let _running = false, _again = false;

  async function reconcile() {
    if (!game.ready || !globalThis.FUCompanion?.isPrimaryGM?.()) return;
    if (_running) { _again = true; return; }
    _running = true;
    try {
      do {
        _again = false;
        for (const scene of game.scenes ?? []) {
          const { tiles, walls } = planScene(scene);
          if (tiles.length) await scene.updateEmbeddedDocuments("Tile", tiles);
          if (walls.length) await scene.updateEmbeddedDocuments("Wall", walls);
        }
      } while (_again);
    } catch (e) {
      console.warn(TAG, "reconcile failed", e);
    } finally {
      _running = false;
    }
  }

  Hooks.once("ready", () => { reconcile(); });
  Hooks.on("oniGameStateChanged", () => { reconcile(); });
  // Load activates its scene last, after the tiles have been re-created.
  Hooks.on("canvasReady", () => { reconcile(); });

  // ── Config fields ──────────────────────────────────────────────────────────
  function injectField(app, html, { host, placeholder, notes }) {
    if (!game.user?.isGM) return;
    const root = html?.[0] ?? html;
    const doc  = app.document ?? app.object;
    if (!root || !doc || root.querySelector(".oni-story-gate")) return;
    const parent = host(root);
    if (!parent) return;
    const wrap = document.createElement("div");
    wrap.className = "form-group oni-story-gate";
    wrap.innerHTML = `
      <label>Opened by switch</label>
      <div class="form-fields"><input type="text" placeholder="${placeholder}"
           name="flags.${MOD}.${KEY}.openedBy" /></div>
      <p class="notes">${notes}</p>`;
    wrap.querySelector("input").value = openedBy(doc);
    parent.appendChild(wrap);
    app.setPosition?.({ height: "auto" });
  }

  Hooks.on("renderTileConfig", (app, html) => {
    try {
      injectField(app, html, {
        host: (root) => root.querySelector('.tab[data-tab="basic"]') ?? root.querySelector("form"),
        placeholder: "e.g. Great Seal Open",
        notes: "Story Gate: this tile is shown until the Event System switch turns ON, then hidden. Blank = no gate."
      });
    } catch (e) { console.warn(TAG, "tile config inject failed", e); }
  });

  Hooks.on("renderWallConfig", (app, html) => {
    try {
      injectField(app, html, {
        host: (root) => root.querySelector("form"),
        placeholder: "e.g. Great Seal Open",
        notes: "Story Gate: this wall blocks movement until the Event System switch turns ON. Blank = no gate."
      });
    } catch (e) { console.warn(TAG, "wall config inject failed", e); }
  });

  globalThis.oni ??= {};
  globalThis.oni.StoryGate = { isClosed, planScene, reconcile, openedBy };
})();
