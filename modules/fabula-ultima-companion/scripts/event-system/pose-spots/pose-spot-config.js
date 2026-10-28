/**
 * [ONI] Event System — Pose spot config (Tile Config, Event Config tab)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/pose-spots/pose-spot-config.js
 *
 * Adds a "Pose spot" section to a tile's Event Config tab:
 * - On / off, Sit or Sleep, Mirror, Size. Saved with the tile like the rest
 *   of the tab: flags.oni-event-system.poseSpot.{enabled, pose, mirror, scale}.
 * - Placing it, by eye, with a token standing in for the character:
 *     Test pose on selected token  - the token shows the pose (with the Sit /
 *                                    Sleep, Mirror and Size in the form now),
 *                                    so it can be dragged until it sits right
 *     Set seat from selected token - where the character goes (its centre)
 *     Set exit from selected token - where they stand up (optional)
 *     Clear test pose              - the token back to normal
 *   Seat and exit are written to the tile at once; the rest saves with the window.
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][PoseSpotConfig]";

  window.oni = window.oni || {};
  if (window.oni.PoseSpotConfig?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const ES_SCOPE = window.oni.EventSystem?.Constants?.FLAG_SCOPE ?? "oni-event-system";
  const KEY = "poseSpot";
  const POSE_FLAG = "pose";
  const FIELD = `flags.${ES_SCOPE}.${KEY}`;

  function selectedToken() {
    const controlled = canvas?.tokens?.controlled ?? [];
    if (controlled.length !== 1) {
      ui.notifications?.warn("Select exactly one token on the map first.");
      return null;
    }
    return controlled[0];
  }

  function fmt(p) {
    return (Number.isFinite(p?.x) && Number.isFinite(p?.y)) ? `${Math.round(p.x)}, ${Math.round(p.y)}` : "not set";
  }

  // What the form shows now, saved or not (for the test pose).
  function formValues(section) {
    return {
      pose: section.querySelector(`[name="${FIELD}.pose"]`)?.value === "sleep" ? "sleep" : "sit",
      mirror: !!section.querySelector(`[name="${FIELD}.mirror"]`)?.checked,
      scale: Number(section.querySelector(`[name="${FIELD}.scale"]`)?.value) || 1
    };
  }

  function build(app, root) {
    const doc = app?.document ?? app?.object;
    if (!doc || doc.documentName !== "Tile") return;
    const wrap = root.querySelector(".oni-event-wrap");
    if (!wrap || wrap.querySelector(".oni-pose-spot")) return;

    const spot = doc.flags?.[ES_SCOPE]?.[KEY] ?? {};
    const section = document.createElement("fieldset");
    section.className = "oni-pose-spot";
    section.style.cssText = "margin: 10px 0; padding: 6px 10px 10px; border: 1px solid rgba(0,0,0,0.25); border-radius: 6px;";
    section.innerHTML = `
      <legend><b>Pose spot</b> (sit / sleep)</legend>
      <div class="form-group">
        <label>Pose spot</label>
        <div class="form-fields"><input type="checkbox" name="${FIELD}.enabled" ${spot.enabled ? "checked" : ""}></div>
        <p class="notes">A seat or a bedroll. A character who walks up gets a Sit / Sleep button and keeps the pose until they move. Works with or without an event on this tile.</p>
      </div>
      <div class="form-group">
        <label>Pose</label>
        <div class="form-fields">
          <select name="${FIELD}.pose">
            <option value="sit" ${spot.pose !== "sleep" ? "selected" : ""}>Sit (on a seat)</option>
            <option value="sleep" ${spot.pose === "sleep" ? "selected" : ""}>Sleep (lying down)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Mirror</label>
        <div class="form-fields"><input type="checkbox" name="${FIELD}.mirror" ${spot.mirror ? "checked" : ""}></div>
        <p class="notes">Sit art faces left and sleep art lies head to the upper right; mirror for the other way.</p>
      </div>
      <div class="form-group">
        <label>Size</label>
        <div class="form-fields"><input type="number" name="${FIELD}.scale" data-dtype="Number" min="0.3" max="3" step="0.05" value="${Number(spot.scale) > 0 ? Number(spot.scale) : 1}"></div>
        <p class="notes">1 = the character's own size on this map. Nudge it when the seat was painted small or large.</p>
      </div>
      <div class="form-group">
        <label>Seat / exit</label>
        <div class="form-fields"><span class="oni-pose-spot-status">Seat: ${fmt(spot.place)} &nbsp;·&nbsp; Exit: ${fmt(spot.exit)}</span></div>
      </div>
      <div class="oni-pose-spot-buttons" style="display:flex; flex-wrap:wrap; gap:4px;">
        <button type="button" data-act="test"><i class="fas fa-eye"></i> Test pose on selected token</button>
        <button type="button" data-act="seat"><i class="fas fa-crosshairs"></i> Set seat from selected token</button>
        <button type="button" data-act="exit"><i class="fas fa-person-walking"></i> Set exit from selected token</button>
        <button type="button" data-act="clear"><i class="fas fa-eraser"></i> Clear test pose</button>
      </div>
      <p class="notes">Place a party member's token on the seat, Test, drag it until it looks right, then Set seat. Stand it where they should get up and Set exit.</p>
    `;
    wrap.appendChild(section);

    const status = section.querySelector(".oni-pose-spot-status");
    const refreshStatus = () => {
      const s = doc.flags?.[ES_SCOPE]?.[KEY] ?? {};
      status.textContent = `Seat: ${fmt(s.place)}  ·  Exit: ${fmt(s.exit)}`;
    };

    section.addEventListener("click", async (ev) => {
      const act = ev.target.closest("button[data-act]")?.dataset.act;
      if (!act) return;
      ev.preventDefault();
      const token = selectedToken();
      if (!token) return;
      const centre = { x: Math.round(token.document.x + token.w / 2), y: Math.round(token.document.y + token.h / 2) };
      try {
        if (act === "seat") await doc.update({ [`${FIELD}.place`]: centre });
        else if (act === "exit") await doc.update({ [`${FIELD}.exit`]: centre });
        else if (act === "test") {
          const v = formValues(section);
          const src = globalThis.FUCompanion?.api?.spriteFacing?.poseArtSrc?.(token, v.pose);
          if (!src) ui.notifications?.warn(`${token.name} has no ${v.pose === "sleep" ? "sleeping" : "sitting"} art (sprite_${v.pose}).`);
          await token.document.update({ [`flags.${MODULE_ID}.${POSE_FLAG}`]: { spotId: doc.id, pose: v.pose, mirror: v.mirror, scale: v.scale, test: true } });
        } else if (act === "clear") {
          await token.document.update({ [`flags.${MODULE_ID}.-=${POSE_FLAG}`]: null });
        }
      } catch (e) {
        console.error(INSTALL_TAG, `"${act}" failed.`, e);
      }
      refreshStatus();
    });

    app.setPosition?.({ height: "auto" });
  }

  // The Event Config tab is built asynchronously by event-configUI.js; wait for it.
  Hooks.on("renderTileConfig", (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    let tries = 0;
    const attempt = () => {
      if (root.querySelector(".oni-event-wrap")) return build(app, root);
      if (++tries < 40) setTimeout(attempt, 50);
    };
    attempt();
  });

  // ------------------------------------------------------------
  // Region Config: Bathing (a water Region the party can bathe in)
  // ------------------------------------------------------------
  // flags.fabula-ultima-companion.bath = { enabled, depth, autoColor, color },
  // next to the footstep Surface picker on the Identity tab.
  const BATH = `flags.${MODULE_ID}.bath`;
  const DEPTHS = [[0.38, "Waist"], [0.5, "Chest"], [0.62, "Shoulders"]];

  function buildBath(app, root) {
    const doc = app?.document;
    if (!doc || root.querySelector(".oni-pose-bath")) return;
    const host = root.querySelector('section[data-tab="identity"]') ?? root.querySelector("form") ?? root;
    const b = doc.getFlag(MODULE_ID, "bath") ?? {};
    const depth = Number(b.depth) > 0 ? Number(b.depth) : 0.5;
    const auto = b.autoColor !== false;
    const color = (typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color)) ? b.color : "#6fb8e8";

    const wrap = document.createElement("fieldset");
    wrap.className = "oni-pose-bath";
    wrap.innerHTML = `
      <legend>Bathing</legend>
      <div class="form-group">
        <label>Bathable</label>
        <div class="form-fields"><input type="checkbox" name="${BATH}.enabled" ${b.enabled ? "checked" : ""}></div>
        <p class="hint">At the water's edge the party gets the "!" and can step in to bathe (onsen art, or their own art when they have none). They wade freely and leave by walking out.</p>
      </div>
      <div class="form-group">
        <label>Depth</label>
        <div class="form-fields">
          <select name="${BATH}.depth" data-dtype="Number">
            ${DEPTHS.map(([v, l]) => `<option value="${v}" ${Math.abs(v - depth) < 0.01 ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Ripple colour from the map</label>
        <div class="form-fields"><input type="checkbox" name="${BATH}.autoColor" ${auto ? "checked" : ""}></div>
        <p class="hint">On: sampled from the water painted inside this Region (red springs get red ripples). Off: the colour below.</p>
      </div>
      <div class="form-group">
        <label>Ripple colour</label>
        <div class="form-fields"><input type="color" name="${BATH}.color" value="${color}"></div>
      </div>
    `;
    host.appendChild(wrap);
    app.setPosition?.({ height: "auto" });
  }

  Hooks.on("renderRegionConfig", (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (root) buildBath(app, root);
  });

  window.oni.PoseSpotConfig = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
