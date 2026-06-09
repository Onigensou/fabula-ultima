// ============================================================================
// Dungeon Pathing System — Scene Configuration Extensions
//
// Injects a "Fabula" section into the Scene Configuration dialog containing
// dungeon-pathing-related per-scene settings.
//
// Layout convention:
//   Settings  — standard form-group rows (label + input).  Saved via Foundry's
//               name-attribute serialisation on form submit.
//
// Currently exposed:
//   Settings: Linked Camp Scene UUID
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
      `;

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
