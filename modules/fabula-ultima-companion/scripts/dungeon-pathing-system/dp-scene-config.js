// ============================================================================
// Dungeon Pathing System — Scene Configuration Extensions
//
// Injects a "Fabula" section into the Scene Configuration dialog containing
// dungeon-pathing-related per-scene settings.
//
// Layout convention:
//   Settings  — standard form-group rows (label + input).  Saved via Foundry's
//               name-attribute serialisation on form submit.
//   Actions   — full-width buttons under a divider.  Wired via JS event
//               listeners; never participate in form submission (type="button").
//
// Currently exposed:
//   Settings: Linked Camp Scene UUID
//   Actions:  Reset All Shroud Reveals
// ============================================================================
(() => {
  const GLOBAL_KEY  = "oni.DungeonSceneConfig";
  if (window[GLOBAL_KEY]?.installed) return;
  window[GLOBAL_KEY] = { installed: true };

  const MODULE_ID = "fabula-ultima-companion";
  const STYLE_ID  = "oni-dp-scene-config-style";
  const TAG       = "[DungeonPathing][SceneConfig]";

  // ── CSS ────────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* Outer wrapper */
      .oni-dp-scene-section {
        padding: 10px 8px 4px;
        border-top: 1px solid rgba(153,153,153,0.3);
        margin-top: 8px;
      }
      .oni-dp-scene-section > h3 {
        margin: 0 0 10px;
        font-size: 0.95rem;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* Settings block — standard form-group rows */
      .oni-dp-scene-settings .form-group {
        margin-bottom: 8px;
      }
      .oni-dp-scene-uuid-input {
        font-family: monospace;
        font-size: 11px;
      }

      /* Actions block */
      .oni-dp-scene-actions-header {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 10px 0 6px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        opacity: 0.55;
      }
      .oni-dp-scene-actions-header hr {
        flex: 1;
        margin: 0;
        border: none;
        border-top: 1px solid rgba(153,153,153,0.3);
      }

      /* Each action row: full-width button + description beneath it */
      .oni-dp-scene-action {
        margin-bottom: 8px;
      }
      .oni-dp-scene-action button {
        width: 100%;
        cursor: pointer;
        text-align: left;
        padding: 5px 10px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .oni-dp-scene-action .notes {
        margin-top: 3px;
        padding-left: 2px;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Main injection ─────────────────────────────────────────────────────────
  Hooks.on("renderSceneConfig", (app, html) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;

      if (root.querySelector("[data-oni-dp-scene-config]")) return;

      ensureStyle();

      const sceneDoc = app?.document ?? app?.object;
      const campUuid = sceneDoc?.getFlag(MODULE_ID, "campSceneUuid") ?? "";

      const form      = root.querySelector("form") ?? root;
      const footer    = form.querySelector("footer, .sheet-footer, .form-footer");
      const insertRef = footer ?? null;

      const section = document.createElement("div");
      section.className = "oni-dp-scene-section";
      section.setAttribute("data-oni-dp-scene-config", "1");
      section.innerHTML = `
        <h3><i class="fas fa-dungeon"></i> Dungeon Pathing — Fabula</h3>

        <!-- ── Settings ── -->
        <div class="oni-dp-scene-settings">

          <div class="form-group">
            <label>Linked Camp Scene</label>
            <div class="form-fields">
              <input class="oni-dp-scene-uuid-input"
                     type="text"
                     name="flags.${MODULE_ID}.campSceneUuid"
                     value="${campUuid}"
                     placeholder="Scene.xxxxxxxxxxxxxxxx"
                     title="UUID of the camp scene for this dungeon" />
            </div>
            <p class="notes">
              UUID of the scene players are transported to when they <b>Use</b> a Camp tile.
              Right-click a scene in the sidebar and choose <em>Copy UUID</em> to get it.
            </p>
          </div>

        </div>

        <!-- ── Actions ── -->
        <div class="oni-dp-scene-actions-header">
          <span>Actions</span><hr />
        </div>

        <div class="oni-dp-scene-action">
          <button type="button" data-oni-reset-all-shrouds="1">
            <i class="fas fa-eye-slash"></i> Reset All Shroud Reveals
          </button>
          <p class="notes">
            Clears every <b>Shroud</b> tile's revealed state on this scene.
            Does <em>not</em> affect tile types, textures, or visited tiles.
            Use when preparing the dungeon for a new group.
          </p>
        </div>
      `;

      // Wire: Reset All Shroud Reveals
      section.querySelector("[data-oni-reset-all-shrouds]")?.addEventListener("click", async () => {
        const DP = globalThis.DungeonPathing;
        const revealedMap = sceneDoc?.flags?.[MODULE_ID]?.dungeonPathing?.fogRevealed ?? {};
        const count = Object.keys(revealedMap).length;
        if (!count) {
          ui.notifications?.warn?.("No shroud reveals to reset on this scene.");
          return;
        }
        const confirmed = await Dialog.confirm({
          title: "Reset All Shroud Reveals",
          content: `<p>Clear <b>${count}</b> shroud reveal(s) on <b>${sceneDoc.name}</b>?<br>
                    Tile states and visited tiles are not affected.</p>`,
          yes: { label: "Reset", icon: '<i class="fas fa-eye-slash"></i>' },
        });
        if (!confirmed) return;
        try {
          await DP?.TileState?.resetAllFogRevealed?.(sceneDoc);
          ui.notifications?.info?.(`${count} shroud reveal(s) cleared on ${sceneDoc.name}.`);
        } catch (e) {
          console.warn(TAG, "resetAllFogRevealed failed:", e);
          ui.notifications?.error?.("Failed to reset shroud reveals — see console.");
        }
      });

      if (insertRef) {
        form.insertBefore(section, insertRef);
      } else {
        form.appendChild(section);
      }

      try { app.setPosition({ height: "auto" }); } catch {}
    } catch (e) {
      console.warn(TAG, "inject failed:", e);
    }
  });

  console.debug(TAG, "renderSceneConfig hook registered.");
})();
