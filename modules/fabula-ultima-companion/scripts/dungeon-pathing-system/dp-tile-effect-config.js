// ============================================================================
// Dungeon Pathing — Tile Effect Config UI
//
// Appends a "Tile Effects" sub-tab to the Fabula Configuration panel that
// dp-tile-config.js creates in the Tile Document config dialog.
//
// Load order requirement: this file MUST load AFTER dp-tile-config.js so
// the sub-nav / sub-content containers already exist when renderTileConfig
// fires.
//
// Config is stored flat in tile flags (Foundry processes name="flags.X.Y"
// inputs automatically on form submit, including nested dot-notation paths):
//   flags.fabula-ultima-companion.dungeonPathing.effectConfig.*
// ============================================================================
(() => {
  const GUARD     = "__ONI_DP_EFFECT_CONFIG__";
  if (window[GUARD]?.installed) return;
  window[GUARD]   = { installed: true };

  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEffectConfig]";
  const PATHING   = "dungeonPathing";
  const CFG_PATH  = `${PATHING}.effectConfig`;
  const STYLE_ID  = "oni-dp-effect-config-style";

  // ── CSS ────────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-ec-section {
        margin: 10px 0 6px;
        padding: 0 2px;
      }
      .oni-ec-section h3 {
        font-size: .9rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .04em;
        opacity: .7;
        margin: 10px 0 6px;
        padding-bottom: 3px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
      }
      .oni-ec-section h3:first-child { margin-top: 0; }
      .oni-ec-section .form-group { margin-bottom: 8px; }
      .oni-ec-section .form-group label { min-width: 130px; }
      .oni-ec-section .notes {
        font-size: 11px;
        opacity: .65;
        margin: 2px 0 0;
      }
      .oni-ec-indent {
        padding-left: 10px;
        border-left: 2px solid rgba(255,255,255,0.08);
        margin-left: 4px;
      }
      .oni-ec-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .oni-ec-row input[type="text"],
      .oni-ec-row input[type="number"],
      .oni-ec-row select { flex: 1; min-width: 0; }
      .oni-ec-badge {
        display: inline-block;
        padding: 1px 7px;
        border-radius: 10px;
        font-size: 11px;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.18);
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
      }
      .oni-ec-badge.has-value {
        background: rgba(80,160,80,0.25);
        border-color: rgba(80,200,80,0.35);
      }
      .oni-ec-master-toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        background: rgba(255,255,255,0.04);
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.1);
        margin-bottom: 8px;
      }
      .oni-ec-master-toggle label {
        font-weight: 700;
        font-size: .95rem;
        margin: 0;
        flex: 1;
      }
    `;
    document.head.appendChild(s);
  }

  // ── AE registry helper ─────────────────────────────────────────────────────
  async function loadAeOptions() {
    const reg = window.FUCompanion?.api?.activeEffectRegistry;
    if (reg?.getAll) {
      try {
        const all = reg.getAll({ cloneResult: false });
        if (Array.isArray(all) && all.length) return all;
      } catch {}
    }
    // Fallback: world-level active effects
    return Array.from(game.effects ?? []).map(e => ({
      id:   e.id,
      name: e.name ?? e.label ?? e.id,
    }));
  }

  async function populateAeSelect(select, currentId) {
    const entries = await loadAeOptions();

    // Group by source if available
    const groups = new Map();
    for (const entry of entries) {
      const grp = entry.source ?? entry.sourceLabel ?? "World";
      if (!groups.has(grp)) groups.set(grp, []);
      groups.get(grp).push(entry);
    }

    // Clear existing options except the placeholder
    while (select.options.length > 1) select.remove(1);

    for (const [groupName, items] of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = groupName;
      for (const item of items) {
        const opt      = document.createElement("option");
        opt.value      = item.id ?? item.name ?? "";
        opt.textContent = item.name ?? item.label ?? opt.value;
        if (opt.value === currentId) opt.selected = true;
        optgroup.appendChild(opt);
      }
      select.appendChild(optgroup);
    }

    // Restore current value if it wasn't in the list (manual ID entry)
    if (currentId && !select.value) {
      const opt      = document.createElement("option");
      opt.value      = currentId;
      opt.textContent = currentId;
      opt.selected   = true;
      select.appendChild(opt);
    }
  }

  // ── Custom effect builder dialog ───────────────────────────────────────────
  function openCustomEffectBuilder(existingJson, onSave) {
    let parsed = {};
    try { parsed = JSON.parse(existingJson); } catch {}

    const name       = parsed.name      ?? "";
    const statusKey  = (parsed.statuses ?? [])[0] ?? "";
    const img        = parsed.img       ?? "";
    const rounds     = parsed.duration?.rounds ?? 0;

    new Dialog({
      title: "Create Custom Active Effect",
      content: `
        <form style="display:flex;flex-direction:column;gap:10px;padding:4px 0;">
          <div class="form-group">
            <label>Effect Name <span style="color:#e44;">*</span></label>
            <input type="text" name="name" value="${name}" placeholder="e.g. Poisoned" autofocus />
          </div>
          <div class="form-group">
            <label>Status Key</label>
            <input type="text" name="statusKey" value="${statusKey}"
                   placeholder="e.g. poisoned (optional, links to status icon)" />
            <p class="notes" style="font-size:11px;opacity:.65;margin:2px 0 0;">
              If set, this effect is treated as a Foundry status condition.
            </p>
          </div>
          <div class="form-group">
            <label>Icon Path / URL</label>
            <input type="text" name="img" value="${img}" placeholder="icons/svg/aura.svg" />
          </div>
          <div class="form-group">
            <label>Duration (rounds)</label>
            <input type="number" name="durationRounds" value="${rounds}" min="0"
                   placeholder="0 = permanent" />
          </div>
        </form>
      `,
      buttons: {
        save: {
          icon: "<i class='fas fa-save'></i>",
          label: "Save",
          callback: (html) => {
            const effectName = html.find("[name='name']").val()?.trim();
            if (!effectName) {
              ui.notifications?.warn("Effect name is required.");
              return false;
            }
            const key    = html.find("[name='statusKey']").val()?.trim();
            const icon   = html.find("[name='img']").val()?.trim() || "icons/svg/aura.svg";
            const dur    = parseInt(html.find("[name='durationRounds']").val()) || 0;
            const data   = {
              name:     effectName,
              img:      icon,
              statuses: key ? [key] : [],
              duration: dur > 0 ? { rounds: dur } : {},
              changes:  [],
            };
            onSave(JSON.stringify(data), effectName);
          },
        },
        cancel: { icon: "<i class='fas fa-times'></i>", label: "Cancel" },
      },
      default: "save",
    }).render(true);
  }

  // ── Panel HTML builder ─────────────────────────────────────────────────────
  function buildPanelHtml(cfg, mod) {
    const sel = (val, check) => check === val ? "selected" : "";
    const chk = (bool)        => bool ? "checked" : "";
    const fl  = key           => `flags.${mod}.${CFG_PATH}.${key}`;

    return `
      <div class="oni-ec-section">

        <!-- ── Master toggle ── -->
        <div class="oni-ec-master-toggle">
          <label for="oni-ec-enabled">Use Effect Logic</label>
          <input type="checkbox"
                 id="oni-ec-enabled"
                 name="${fl("enabled")}"
                 data-dtype="Boolean"
                 data-oni-ec="master"
                 ${chk(cfg.enabled)} />
        </div>
        <p class="notes" style="margin:-4px 0 10px;">
          When enabled, this tile applies the configured resource changes and / or
          active effects to party members when stepped on.
        </p>

        <!-- ── Conditional body (hidden when master is OFF) ── -->
        <div data-oni-ec-body="1" ${cfg.enabled ? "" : 'style="display:none;"'}>

          <!-- ── Targeting ── -->
          <h3><i class="fas fa-users"></i> Targeting</h3>
          <div class="form-group">
            <label>Apply to</label>
            <select name="${fl("targetMode")}">
              <option value="all"    ${sel("all",    cfg.targetMode)}>All Party Members</option>
              <option value="one"    ${sel("one",    cfg.targetMode)}>One Member (chosen at random)</option>
              <option value="random" ${sel("random", cfg.targetMode)}>Random Subset</option>
            </select>
          </div>

          <!-- ── Resource Change ── -->
          <h3><i class="fas fa-heartbeat"></i> Resource Change</h3>
          <div class="form-group">
            <label>Apply resource change</label>
            <input type="checkbox"
                   name="${fl("useResourceChange")}"
                   data-dtype="Boolean"
                   data-oni-ec="resource-toggle"
                   ${chk(cfg.useResourceChange)} />
          </div>
          <div class="oni-ec-indent" data-oni-ec-resource="1"
               ${cfg.useResourceChange ? "" : 'style="display:none;"'}>
            <div class="form-group">
              <label>Type</label>
              <select name="${fl("resourceType")}">
                <optgroup label="HP">
                  <option value="damage"   ${sel("damage",   cfg.resourceType)}>Damage (HP loss)</option>
                  <option value="healing"  ${sel("healing",  cfg.resourceType)}>Healing (HP gain)</option>
                </optgroup>
                <optgroup label="MP">
                  <option value="mp_drain" ${sel("mp_drain", cfg.resourceType)}>MP Burn (MP loss)</option>
                  <option value="mp_gain"  ${sel("mp_gain",  cfg.resourceType)}>MP Gain</option>
                </optgroup>
                <optgroup label="IP">
                  <option value="ip_drain" ${sel("ip_drain", cfg.resourceType)}>IP Drain (IP loss)</option>
                  <option value="ip_gain"  ${sel("ip_gain",  cfg.resourceType)}>IP Gain</option>
                </optgroup>
                <optgroup label="ZP">
                  <option value="zp_drain" ${sel("zp_drain", cfg.resourceType)}>ZP Drain (ZP loss)</option>
                  <option value="zp_gain"  ${sel("zp_gain",  cfg.resourceType)}>ZP Gain</option>
                </optgroup>
              </select>
            </div>
            <div class="form-group">
              <label>Amount</label>
              <input type="number"
                     name="${fl("resourceValue")}"
                     data-dtype="Number"
                     min="0"
                     value="${cfg.resourceValue}" />
            </div>
          </div>

          <!-- ── Active Effect ── -->
          <h3><i class="fas fa-magic"></i> Active Effect</h3>
          <div class="form-group">
            <label>Apply active effect</label>
            <input type="checkbox"
                   name="${fl("useActiveEffect")}"
                   data-dtype="Boolean"
                   data-oni-ec="ae-toggle"
                   ${chk(cfg.useActiveEffect)} />
          </div>

          <div class="oni-ec-indent" data-oni-ec-ae="1"
               ${cfg.useActiveEffect ? "" : 'style="display:none;"'}>

            <!-- Source radio -->
            <div class="form-group">
              <label>Source</label>
              <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:4px;font-weight:normal;min-width:0;">
                  <input type="radio"
                         name="${fl("aeSource")}"
                         value="registry"
                         data-oni-ec="ae-source"
                         ${cfg.aeSource !== "custom" ? "checked" : ""} />
                  From Registry
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-weight:normal;min-width:0;">
                  <input type="radio"
                         name="${fl("aeSource")}"
                         value="custom"
                         data-oni-ec="ae-source"
                         ${cfg.aeSource === "custom" ? "checked" : ""} />
                  Custom Effect
                </label>
              </div>
            </div>

            <!-- Registry picker -->
            <div data-oni-ec-ae-registry="1"
                 ${cfg.aeSource === "custom" ? 'style="display:none;"' : ""}>
              <div class="form-group">
                <label>Effect</label>
                <div class="oni-ec-row">
                  <select name="${fl("activeEffectId")}"
                          data-oni-ae-select="1">
                    <option value="">— Loading effects… —</option>
                  </select>
                  <button type="button"
                          data-oni-ae-refresh="1"
                          title="Refresh effect list"
                          style="flex:0 0 auto;padding:0 8px;">↺</button>
                </div>
                <p class="notes">
                  Pulls from the Active Effect Registry (CONFIG.statusEffects, world actors, compendiums).
                </p>
              </div>
            </div>

            <!-- Custom effect -->
            <div data-oni-ec-ae-custom="1"
                 ${cfg.aeSource !== "custom" ? 'style="display:none;"' : ""}>
              <div class="form-group">
                <label>Custom Effect</label>
                <div class="oni-ec-row">
                  <span class="oni-ec-badge ${cfg.customEffectJson ? "has-value" : ""}"
                        data-oni-ae-custom-label="1">
                    ${cfg.customEffectJson
                        ? (() => { try { return JSON.parse(cfg.customEffectJson).name ?? "Custom effect"; } catch { return "Custom effect"; } })()
                        : "None defined"}
                  </span>
                  <button type="button"
                          data-oni-ae-custom-open="1"
                          style="flex:0 0 auto;">
                    <i class="fas fa-edit"></i> ${cfg.customEffectJson ? "Edit" : "Create"}
                  </button>
                  ${cfg.customEffectJson
                    ? `<button type="button" data-oni-ae-custom-clear="1"
                               style="flex:0 0 auto;" title="Clear custom effect">
                         <i class="fas fa-trash"></i>
                       </button>`
                    : ""}
                </div>
                <input type="hidden"
                       name="${fl("customEffectJson")}"
                       data-oni-ae-custom-json="1"
                       value="${cfg.customEffectJson.replace(/"/g, "&quot;")}" />
              </div>
            </div>
          </div><!-- end .oni-ec-indent AE -->

          <!-- ── Output ── -->
          <h3><i class="fas fa-volume-up"></i> Output</h3>

          <div class="form-group">
            <label>Silent mode</label>
            <input type="checkbox"
                   name="${fl("silent")}"
                   data-dtype="Boolean"
                   data-oni-ec="silent-toggle"
                   ${chk(cfg.silent)} />
            <p class="notes">
              Suppresses chat card, VFX, and SFX.  Resource changes and active effects
              still apply.
            </p>
          </div>

          <div data-oni-ec-output="1" ${cfg.silent ? 'style="display:none;"' : ""}>

            <!-- VFX -->
            <div class="form-group">
              <label>Visual Effect</label>
              <select name="${fl("vfxType")}" data-oni-ec="vfx-type">
                <option value="none"        ${sel("none",        cfg.vfxType)}>None</option>
                <option value="file"        ${sel("file",        cfg.vfxType)}>VFX File (on token)</option>
                <option value="screenflash" ${sel("screenflash", cfg.vfxType)}>Screen Flash</option>
              </select>
            </div>

            <!-- VFX file sub-fields -->
            <div class="oni-ec-indent" data-oni-ec-vfx-file="1"
                 ${cfg.vfxType === "file" ? "" : 'style="display:none;"'}>
              <div class="form-group">
                <label>VFX File URL</label>
                <input type="text"
                       name="${fl("vfxFile")}"
                       value="${cfg.vfxFile}"
                       placeholder="https://… or modules/…/file.webm" />
                <p class="notes">
                  .webm/.gif/.png supported.  Uses Sequencer if installed, otherwise a
                  PIXI sprite overlay on the party token.
                </p>
              </div>
            </div>

            <!-- Screen flash sub-fields -->
            <div class="oni-ec-indent" data-oni-ec-vfx-flash="1"
                 ${cfg.vfxType === "screenflash" ? "" : 'style="display:none;"'}>
              <div class="form-group">
                <label>Flash Tint</label>
                <input type="color"
                       name="${fl("vfxFlashTint")}"
                       value="${cfg.vfxFlashTint}" />
              </div>
              <div class="form-group">
                <label>Flash Opacity (0–1)</label>
                <input type="number"
                       name="${fl("vfxFlashAlpha")}"
                       data-dtype="Number"
                       min="0" max="1" step="0.05"
                       value="${cfg.vfxFlashAlpha}" />
              </div>
            </div>

            <!-- SFX -->
            <div class="form-group" style="margin-top:6px;">
              <label>Sound Effect URL</label>
              <input type="text"
                     name="${fl("sfxUrl")}"
                     value="${cfg.sfxUrl}"
                     placeholder="https://… or modules/…/sound.ogg" />
              <p class="notes">
                Plays on the local client when the tile triggers.  Uses Sequencer if
                installed.
              </p>
            </div>

          </div><!-- end data-oni-ec-output -->
        </div><!-- end data-oni-ec-body -->
      </div><!-- end .oni-ec-section -->
    `;
  }

  // ── Wire interactivity ─────────────────────────────────────────────────────
  function wirePanel(panel, tileDoc, app) {
    const $ = sel => panel.querySelector(sel);

    // Helper: resize the config dialog when content changes
    const resize = () => { try { app.setPosition({ height: "auto" }); } catch {} };

    // Toggle show/hide helpers
    function toggle(el, show) {
      if (el) el.style.display = show ? "" : "none";
    }

    // Master toggle
    const masterCb = $("[data-oni-ec='master']");
    const body     = $("[data-oni-ec-body='1']");
    if (masterCb && body) {
      masterCb.addEventListener("change", () => {
        toggle(body, masterCb.checked);
        resize();
      });
    }

    // Resource toggle
    const resCb   = $("[data-oni-ec='resource-toggle']");
    const resBody = $("[data-oni-ec-resource='1']");
    if (resCb && resBody) {
      resCb.addEventListener("change", () => {
        toggle(resBody, resCb.checked);
        resize();
      });
    }

    // AE toggle
    const aeCb   = $("[data-oni-ec='ae-toggle']");
    const aeBody = $("[data-oni-ec-ae='1']");
    if (aeCb && aeBody) {
      aeCb.addEventListener("change", () => {
        toggle(aeBody, aeCb.checked);
        resize();
      });
    }

    // AE source radio (registry vs custom)
    const aeRegistryDiv = $("[data-oni-ec-ae-registry='1']");
    const aeCustomDiv   = $("[data-oni-ec-ae-custom='1']");
    panel.querySelectorAll("[data-oni-ec='ae-source']").forEach(radio => {
      radio.addEventListener("change", () => {
        const isCustom = panel.querySelector("[data-oni-ec='ae-source']:checked")?.value === "custom";
        toggle(aeRegistryDiv, !isCustom);
        toggle(aeCustomDiv,    isCustom);
        resize();
      });
    });

    // AE select async load
    const aeSelect = $("[data-oni-ae-select='1']");
    if (aeSelect) {
      const currentId = aeSelect.closest("[data-oni-ec-ae-registry='1']")
        ? tileDoc?.flags?.[MODULE_ID]?.[PATHING]?.effectConfig?.activeEffectId ?? ""
        : "";

      populateAeSelect(aeSelect, currentId).catch(() => {});

      const refreshBtn = $("[data-oni-ae-refresh='1']");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          const reg = window.FUCompanion?.api?.activeEffectRegistry;
          if (reg?.refresh) reg.refresh().then(() => populateAeSelect(aeSelect, aeSelect.value)).catch(() => {});
          else populateAeSelect(aeSelect, aeSelect.value).catch(() => {});
        });
      }
    }

    // Custom effect builder
    const openBtn   = $("[data-oni-ae-custom-open='1']");
    const labelEl   = $("[data-oni-ae-custom-label='1']");
    const jsonInput = $("[data-oni-ae-custom-json='1']");

    if (openBtn && jsonInput) {
      openBtn.addEventListener("click", () => {
        openCustomEffectBuilder(jsonInput.value, (json, name) => {
          jsonInput.value = json;
          if (labelEl) {
            labelEl.textContent = name ?? "Custom effect";
            labelEl.classList.add("has-value");
          }
          // Swap Create → Edit
          openBtn.innerHTML = `<i class="fas fa-edit"></i> Edit`;

          // Add or update clear button
          let clearBtn = $("[data-oni-ae-custom-clear='1']");
          if (!clearBtn) {
            clearBtn                      = document.createElement("button");
            clearBtn.type                 = "button";
            clearBtn.dataset.oniAeCustomClear = "1";
            clearBtn.title                = "Clear custom effect";
            clearBtn.style.flex           = "0 0 auto";
            clearBtn.innerHTML            = `<i class="fas fa-trash"></i>`;
            openBtn.after(clearBtn);
            wireClearBtn(clearBtn, jsonInput, labelEl, openBtn);
          }
        });
      });
    }

    // Clear custom effect
    const clearBtn = $("[data-oni-ae-custom-clear='1']");
    if (clearBtn && jsonInput) {
      wireClearBtn(clearBtn, jsonInput, labelEl, openBtn);
    }

    // Silent toggle
    const silentCb = $("[data-oni-ec='silent-toggle']");
    const outBody  = $("[data-oni-ec-output='1']");
    if (silentCb && outBody) {
      silentCb.addEventListener("change", () => {
        toggle(outBody, !silentCb.checked);
        resize();
      });
    }

    // VFX type switcher
    const vfxSel    = $("[data-oni-ec='vfx-type']");
    const vfxFile   = $("[data-oni-ec-vfx-file='1']");
    const vfxFlash  = $("[data-oni-ec-vfx-flash='1']");
    if (vfxSel) {
      vfxSel.addEventListener("change", () => {
        toggle(vfxFile,  vfxSel.value === "file");
        toggle(vfxFlash, vfxSel.value === "screenflash");
        resize();
      });
    }
  }

  function wireClearBtn(btn, jsonInput, labelEl, openBtn) {
    btn.addEventListener("click", () => {
      jsonInput.value = "";
      if (labelEl) {
        labelEl.textContent = "None defined";
        labelEl.classList.remove("has-value");
      }
      if (openBtn) openBtn.innerHTML = `<i class="fas fa-edit"></i> Create`;
      btn.remove();
    });
  }

  // ── renderTileConfig hook ──────────────────────────────────────────────────
  Hooks.on("renderTileConfig", async (app, html) => {
    try {
      ensureStyle();

      const root = html instanceof HTMLElement ? html
        : html?.[0] instanceof HTMLElement    ? html[0]
        : app?.element?.[0] ?? app?.element   ?? null;
      if (!root) return;

      // Wait for dp-tile-config.js to have created the sub-nav/sub-content
      const subNav     = root.querySelector("[data-oni-fabula-sub-nav='1']");
      const subContent = root.querySelector("[data-oni-fabula-sub-content='1']");
      if (!subNav || !subContent) {
        console.warn(TAG, "Fabula sub-nav not found — dp-tile-config.js may not have run yet.");
        return;
      }

      // Guard: only inject once
      if (subNav.querySelector("[data-sub-tab='tile-effects']")) return;

      const tileDoc = app?.document ?? app?.object ?? null;

      // Read current config from flags
      const raw = tileDoc?.flags?.[MODULE_ID]?.[PATHING]?.effectConfig ?? {};
      const bool = v => v === true || v === "true" || v === 1;
      const cfg = {
        enabled:           bool(raw.enabled),
        useResourceChange: bool(raw.useResourceChange),
        resourceType:      String(raw.resourceType      ?? "damage"),
        resourceValue:     Number(raw.resourceValue     ?? 0),
        useActiveEffect:   bool(raw.useActiveEffect),
        aeSource:          String(raw.aeSource          ?? "registry"),
        activeEffectId:    String(raw.activeEffectId    ?? ""),
        customEffectJson:  String(raw.customEffectJson  ?? ""),
        targetMode:        String(raw.targetMode        ?? "all"),
        silent:            bool(raw.silent),
        vfxType:           String(raw.vfxType           ?? "none"),
        vfxFile:           String(raw.vfxFile           ?? ""),
        vfxFlashTint:      String(raw.vfxFlashTint      ?? "#ff0000"),
        vfxFlashAlpha:     Number(raw.vfxFlashAlpha     ?? 0.5),
        sfxUrl:            String(raw.sfxUrl            ?? ""),
      };

      // ── Sub-nav button ───────────────────────────────────────────────────
      const navBtn = document.createElement("a");
      navBtn.className        = "item";
      navBtn.dataset.subTab   = "tile-effects";
      navBtn.innerHTML        = `<i class="fas fa-bolt"></i> Tile Effects`;
      if (cfg.enabled) navBtn.style.fontWeight = "700";
      subNav.appendChild(navBtn);

      // ── Sub-panel ────────────────────────────────────────────────────────
      const panel = document.createElement("div");
      panel.className         = "oni-fabula-sub-panel";
      panel.dataset.subTab    = "tile-effects";
      panel.style.display     = "none";
      panel.innerHTML         = buildPanelHtml(cfg, MODULE_ID);
      subContent.appendChild(panel);

      // Wire interactivity
      wirePanel(panel, tileDoc, app);

    } catch (e) {
      console.warn(TAG, "inject failed:", e);
    }
  });

  console.debug(TAG, "renderTileConfig hook registered.");
})();
