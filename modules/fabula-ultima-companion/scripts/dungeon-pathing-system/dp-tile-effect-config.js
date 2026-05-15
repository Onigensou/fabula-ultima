// ============================================================================
// Dungeon Pathing — Tile Effect Config UI
//
// Appends a "Tile Effects" sub-tab to the Fabula Configuration panel built by
// dp-tile-config.js.  Must load AFTER dp-tile-config.js.
//
// Active Effects are stored as a JSON array in:
//   flags.fabula-ultima-companion.dungeonPathing.effectConfig.activeEffectsJson
//
// Each element: { source: "registry"|"custom", id?: string, json?: string, label: string }
//
// All other config fields use native Foundry name="flags.*" form inputs so
// they are saved automatically when the user clicks "Update Tile".
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

  // ── Helpers ────────────────────────────────────────────────────────────────
  const sel = (val, match) => match === val ? "selected" : "";
  const chk = bool => bool ? "checked" : "";
  const fl  = key  => `flags.${MODULE_ID}.${CFG_PATH}.${key}`;

  // ── CSS ────────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-ec h3 {
        font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
        opacity:.7;margin:12px 0 6px;padding-bottom:3px;
        border-bottom:1px solid rgba(255,255,255,0.1);
      }
      .oni-ec h3:first-child { margin-top:0; }
      .oni-ec .form-group { margin-bottom:8px; }
      .oni-ec .form-group label { min-width:130px; }
      .oni-ec .notes { font-size:11px;opacity:.6;margin:2px 0 0; }
      .oni-ec-indent {
        padding-left:10px;
        border-left:2px solid rgba(255,255,255,0.08);
        margin-left:4px;margin-bottom:4px;
      }
      .oni-ec-master {
        display:flex;align-items:center;gap:8px;padding:6px 8px;
        background:rgba(255,255,255,0.04);border-radius:5px;
        border:1px solid rgba(255,255,255,0.1);margin-bottom:10px;
      }
      .oni-ec-master label { font-weight:700;font-size:.95rem;margin:0;flex:1; }

      /* AE list */
      .oni-ec-ae-list {
        list-style:none;margin:6px 0;padding:0;
        display:flex;flex-direction:column;gap:4px;
      }
      .oni-ec-ae-row {
        display:flex;align-items:center;gap:6px;
        background:rgba(255,255,255,0.05);border-radius:4px;
        border:1px solid rgba(255,255,255,0.1);padding:4px 8px;
      }
      .oni-ec-ae-row img { width:20px;height:20px;object-fit:contain;border-radius:2px;flex-shrink:0; }
      .oni-ec-ae-row .oni-ec-ae-label { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem; }
      .oni-ec-ae-row .oni-ec-ae-src { font-size:10px;opacity:.5;flex-shrink:0;padding:1px 4px;background:rgba(0,0,0,.15);border-radius:2px; }
      .oni-ec-ae-row button { flex-shrink:0;padding:0 6px;min-height:22px; }
      .oni-ec-ae-actions { display:flex;gap:6px;margin-top:4px;flex-wrap:wrap; }

      /* Registry picker dialog */
      .oni-ae-picker-search { width:100%;margin-bottom:8px;padding:4px 8px; }
      .oni-ae-picker-list { max-height:300px;overflow-y:auto;border:1px solid rgba(255,255,255,0.15);border-radius:4px; }
      .oni-ae-picker-item {
        display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;
        border-bottom:1px solid rgba(255,255,255,0.06);
      }
      .oni-ae-picker-item:last-child { border-bottom:none; }
      .oni-ae-picker-item:hover { background:rgba(255,255,255,0.08); }
      .oni-ae-picker-item img { width:20px;height:20px;object-fit:contain;flex-shrink:0; }
      .oni-ae-picker-item .oni-ae-name { flex:1;font-size:.9rem; }
      .oni-ae-picker-item .oni-ae-cat {
        font-size:10px;padding:1px 5px;border-radius:3px;flex-shrink:0;
        background:rgba(255,255,255,0.1);
      }
      .oni-ae-picker-item .oni-ae-cat.Buff   { background:rgba(60,140,60,.3); }
      .oni-ae-picker-item .oni-ae-cat.Debuff { background:rgba(160,40,40,.3); }
      .oni-ae-picker-sep {
        padding:3px 8px;font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:.05em;opacity:.5;background:rgba(0,0,0,.1);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Registry: deduplicated entries (no actor-embedded duplicates) ──────────
  function getRegistryEntries() {
    const reg = window.FUCompanion?.api?.activeEffectRegistry;
    if (!reg?.getAll) return [];

    const all = reg.getAll({ cloneResult: false }) ?? [];

    // Source priority map — actor-embedded effects are the noisy duplicates
    const PRIORITY = {
      "world-item-effect":      100,
      "compendium-item-effect":  90,
      "config-status-effect":    80,
      "world-actor-effect":      20,
      "compendium-actor-effect": 10,
      "unknown":                  0,
    };

    // Deduplicate: per normalised name, keep highest-priority source entry
    const byNorm = new Map();
    for (const entry of all) {
      const norm = (entry.name ?? "").trim().toLowerCase();
      if (!norm) continue;
      const existing = byNorm.get(norm);
      const myPri    = PRIORITY[entry.source] ?? 0;
      const exPri    = PRIORITY[existing?.source] ?? -1;
      if (!existing || myPri > exPri) byNorm.set(norm, entry);
    }

    return Array.from(byNorm.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Registry picker dialog ─────────────────────────────────────────────────
  function openRegistryPicker(onPick) {
    const entries  = getRegistryEntries();
    const BLANK_IMG = "icons/svg/aura.svg";

    // Group by category for display
    const groups = {};
    for (const e of entries) {
      const cat = e.category ?? "Other";
      (groups[cat] ??= []).push(e);
    }
    const ORDER = ["Buff", "Debuff", "Other"];

    let rows = "";
    for (const cat of ORDER) {
      const items = groups[cat];
      if (!items?.length) continue;
      rows += `<div class="oni-ae-picker-sep">${cat}</div>`;
      for (const e of items) {
        const id  = e.registryId ?? e.id ?? e.name ?? "";
        const img = e.img ?? e.icon ?? BLANK_IMG;
        const nm  = e.name ?? id;
        rows += `<div class="oni-ae-picker-item" data-ae-id="${id}" data-ae-name="${nm.replace(/"/g,"&quot;")}" data-ae-img="${img.replace(/"/g,"&quot;")}" data-ae-cat="${cat}">
          <img src="${img}" onerror="this.src='${BLANK_IMG}'" />
          <span class="oni-ae-name">${nm}</span>
          <span class="oni-ae-cat ${cat}">${cat}</span>
        </div>`;
      }
    }

    if (!rows) {
      rows = `<div style="padding:12px;text-align:center;opacity:.6;">
        No effects found. Try refreshing the registry:
        <code>await FUCompanion.api.activeEffectRegistry.refresh()</code>
      </div>`;
    }

    const dialog = new Dialog({
      title: "Add Active Effect",
      content: `
        <div style="padding:4px 0;">
          <input type="text" class="oni-ae-picker-search" placeholder="Search effects…" />
          <div class="oni-ae-picker-list">${rows}</div>
        </div>
      `,
      buttons: { cancel: { label: "Cancel" } },
      render: html => {
        const root   = html[0] ?? html;
        const search = root.querySelector(".oni-ae-picker-search");
        const list   = root.querySelector(".oni-ae-picker-list");
        if (!search || !list) return;

        search.focus();
        search.addEventListener("input", () => {
          const q = search.value.toLowerCase();
          list.querySelectorAll(".oni-ae-picker-item").forEach(el => {
            el.style.display = el.dataset.aeName?.toLowerCase().includes(q) ? "" : "none";
          });
          // Also hide empty section headers
          list.querySelectorAll(".oni-ae-picker-sep").forEach(sep => {
            let next = sep.nextElementSibling;
            let allHidden = true;
            while (next && !next.classList.contains("oni-ae-picker-sep")) {
              if (next.style.display !== "none") { allHidden = false; break; }
              next = next.nextElementSibling;
            }
            sep.style.display = allHidden ? "none" : "";
          });
        });

        list.querySelectorAll(".oni-ae-picker-item").forEach(el => {
          el.addEventListener("click", () => {
            dialog.close();
            onPick({
              source: "registry",
              id:     el.dataset.aeId,
              label:  el.dataset.aeName,
              img:    el.dataset.aeImg,
            });
          });
        });
      },
    });
    dialog.render(true);
  }

  // ── Native builder (GM-only — creates temp draft on party actor) ───────────
  async function openNativeBuilder(onAdd) {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Creating custom Active Effects requires GM permissions.");
      return;
    }

    const nativeBuilder = window.FUCompanion?.api?.activeEffectManager?.uiParts?.nativeBuilder;
    if (!nativeBuilder?.openForQueue) {
      ui.notifications?.warn?.("Active Effect Manager native builder not available.");
      return;
    }

    // Resolve an actor to use as the draft host (party actor preferred)
    let actorUuid = null;
    try {
      const api = window.FUCompanion?.api;
      if (api?.getCurrentGameDb) {
        const res = await api.getCurrentGameDb().catch(() => null);
        actorUuid = res?.db?.uuid ?? null;
      }
    } catch {}

    if (!actorUuid) {
      // Fallback: any GM-owned actor
      const fallback = game.actors.find(a => {
        try { return game.user?.isGM || a.testUserPermission?.(game.user, "OWNER"); } catch { return false; }
      });
      actorUuid = fallback?.uuid ?? null;
    }

    nativeBuilder.openForQueue({
      actorUuid,
      onAddEffect: (effectData) => {
        onAdd({
          source: "custom",
          json:   JSON.stringify(effectData),
          label:  effectData.name ?? "Custom Effect",
          img:    effectData.img ?? effectData.icon ?? "icons/svg/aura.svg",
        });
      },
    });
  }

  // ── AE list renderer ───────────────────────────────────────────────────────
  function renderAeList(listEl, activeEffects, onRemove) {
    listEl.innerHTML = "";
    if (!activeEffects.length) {
      listEl.innerHTML = `<li style="opacity:.5;font-size:.85rem;padding:4px 2px;">No effects selected.</li>`;
      return;
    }
    for (let i = 0; i < activeEffects.length; i++) {
      const entry   = activeEffects[i];
      const img     = entry.img ?? "icons/svg/aura.svg";
      const srcTag  = entry.source === "custom" ? "custom" : "registry";
      const li      = document.createElement("li");
      li.className  = "oni-ec-ae-row";
      li.innerHTML  = `
        <img src="${img}" onerror="this.src='icons/svg/aura.svg'" />
        <span class="oni-ec-ae-label">${entry.label ?? entry.id ?? "Effect"}</span>
        <span class="oni-ec-ae-src">${srcTag}</span>
        <button type="button" data-remove-idx="${i}" title="Remove">✕</button>
      `;
      li.querySelector("[data-remove-idx]").addEventListener("click", () => onRemove(i));
      listEl.appendChild(li);
    }
  }

  // ── Panel HTML ─────────────────────────────────────────────────────────────
  function buildPanelHtml(cfg) {
    return `
      <div class="oni-ec">

        <!-- Master toggle -->
        <div class="oni-ec-master">
          <label for="oni-ec-enabled">Use Effect Logic</label>
          <input type="checkbox" id="oni-ec-enabled"
                 name="${fl("enabled")}" data-dtype="Boolean"
                 data-oni-ec="master" ${chk(cfg.enabled)} />
        </div>
        <p class="notes" style="margin:-6px 0 10px;">
          When enabled this tile applies the configured changes to party members when stepped on.
        </p>

        <div data-oni-ec-body="1" ${cfg.enabled ? "" : 'style="display:none"'}>

          <!-- Targeting -->
          <h3><i class="fas fa-users"></i> Targeting</h3>
          <div class="form-group">
            <label>Apply to</label>
            <select name="${fl("targetMode")}">
              <option value="all"    ${sel("all",    cfg.targetMode)}>All Party Members</option>
              <option value="one"    ${sel("one",    cfg.targetMode)}>One Member (chosen at random)</option>
              <option value="random" ${sel("random", cfg.targetMode)}>Random Subset</option>
            </select>
          </div>

          <!-- Skill Check -->
          <div class="form-group">
            <label>Use Skill Check</label>
            <input type="checkbox" name="${fl("useSkillCheck")}"
                   data-dtype="Boolean" data-oni-ec="skill-check-toggle"
                   ${chk(cfg.useSkillCheck)} />
            <p class="notes">Targeted actors must pass a skill check before effects apply.</p>
          </div>
          <div class="oni-ec-indent" data-oni-ec-skill-check="1"
               ${cfg.useSkillCheck ? "" : 'style="display:none"'}>
            <div class="form-group">
              <label>Attribute A</label>
              <select name="${fl("checkAttrA")}">
                <option value="DEX" ${sel("DEX", cfg.checkAttrA)}>DEX — Dexterity</option>
                <option value="MIG" ${sel("MIG", cfg.checkAttrA)}>MIG — Might</option>
                <option value="INS" ${sel("INS", cfg.checkAttrA)}>INS — Insight</option>
                <option value="WLP" ${sel("WLP", cfg.checkAttrA)}>WLP — Willpower</option>
              </select>
            </div>
            <div class="form-group">
              <label>Attribute B</label>
              <select name="${fl("checkAttrB")}">
                <option value="DEX" ${sel("DEX", cfg.checkAttrB)}>DEX — Dexterity</option>
                <option value="MIG" ${sel("MIG", cfg.checkAttrB)}>MIG — Might</option>
                <option value="INS" ${sel("INS", cfg.checkAttrB)}>INS — Insight</option>
                <option value="WLP" ${sel("WLP", cfg.checkAttrB)}>WLP — Willpower</option>
              </select>
            </div>
            <div class="form-group">
              <label>Difficulty (DL)</label>
              <input type="number" name="${fl("checkDl")}"
                     data-dtype="Number" min="1" max="40" value="${cfg.checkDl}" />
            </div>
            <div class="form-group">
              <label>Apply effect on</label>
              <select name="${fl("checkApplyOn")}">
                <option value="fail" ${sel("fail", cfg.checkApplyOn)}>Check Failure (default)</option>
                <option value="pass" ${sel("pass", cfg.checkApplyOn)}>Check Success</option>
              </select>
              <p class="notes">Effects only apply to actors who meet this condition.</p>
            </div>
          </div>

          <!-- Resource Change -->
          <h3><i class="fas fa-heartbeat"></i> Resource Change</h3>
          <div class="form-group">
            <label>Apply resource change</label>
            <input type="checkbox" name="${fl("useResourceChange")}"
                   data-dtype="Boolean" data-oni-ec="resource-toggle"
                   ${chk(cfg.useResourceChange)} />
          </div>
          <div class="oni-ec-indent" data-oni-ec-resource="1"
               ${cfg.useResourceChange ? "" : 'style="display:none"'}>
            <div class="form-group">
              <label>Type</label>
              <select name="${fl("resourceType")}" data-oni-ec="resource-type">
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
              <input type="number" name="${fl("resourceValue")}"
                     data-dtype="Number" min="0" value="${cfg.resourceValue}" />
            </div>
            <div class="form-group" data-oni-ec-damage-only="1"
                 ${cfg.resourceType === "damage" ? "" : 'style="display:none"'}>
              <label>Element</label>
              <select name="${fl("elementType")}">
                <option value="elementless" ${sel("elementless", cfg.elementType)}>— None —</option>
                <option value="physical"    ${sel("physical",    cfg.elementType)}>Physical</option>
                <option value="air"         ${sel("air",         cfg.elementType)}>Air</option>
                <option value="bolt"        ${sel("bolt",        cfg.elementType)}>Bolt</option>
                <option value="dark"        ${sel("dark",        cfg.elementType)}>Dark</option>
                <option value="earth"       ${sel("earth",       cfg.elementType)}>Earth</option>
                <option value="fire"        ${sel("fire",        cfg.elementType)}>Fire</option>
                <option value="ice"         ${sel("ice",         cfg.elementType)}>Ice</option>
                <option value="light"       ${sel("light",       cfg.elementType)}>Light</option>
                <option value="poison"      ${sel("poison",      cfg.elementType)}>Poison</option>
              </select>
            </div>
            <div class="form-group" data-oni-ec-damage-only="1"
                 ${cfg.resourceType === "damage" ? "" : 'style="display:none"'}>
              <label>Ignore Reduction</label>
              <input type="checkbox" name="${fl("ignoreReduction")}"
                     data-dtype="Boolean" ${chk(cfg.ignoreReduction)} />
              <p class="notes">Bypasses target flat and % damage reduction stats.</p>
            </div>
            <div class="form-group" data-oni-ec-damage-only="1"
                 ${cfg.resourceType === "damage" ? "" : 'style="display:none"'}>
              <label>Weapon Type</label>
              <select name="${fl("weaponType")}">
                <option value="none_ef"     ${sel("none_ef",     cfg.weaponType)}>— None —</option>
                <option value="arcane_ef"   ${sel("arcane_ef",   cfg.weaponType)}>Arcane</option>
                <option value="bow_ef"      ${sel("bow_ef",      cfg.weaponType)}>Bow</option>
                <option value="brawling_ef" ${sel("brawling_ef", cfg.weaponType)}>Brawling</option>
                <option value="dagger_ef"   ${sel("dagger_ef",   cfg.weaponType)}>Dagger</option>
                <option value="firearm_ef"  ${sel("firearm_ef",  cfg.weaponType)}>Firearm</option>
                <option value="flail_ef"    ${sel("flail_ef",    cfg.weaponType)}>Flail</option>
                <option value="heavy_ef"    ${sel("heavy_ef",    cfg.weaponType)}>Heavy</option>
                <option value="spear_ef"    ${sel("spear_ef",    cfg.weaponType)}>Spear</option>
                <option value="sword_ef"    ${sel("sword_ef",    cfg.weaponType)}>Sword</option>
                <option value="thrown_ef"   ${sel("thrown_ef",   cfg.weaponType)}>Thrown</option>
              </select>
            </div>
          </div>

          <!-- Active Effects (array) -->
          <h3><i class="fas fa-magic"></i> Active Effects</h3>
          <div class="form-group">
            <label>Apply active effect(s)</label>
            <input type="checkbox" name="${fl("useActiveEffect")}"
                   data-dtype="Boolean" data-oni-ec="ae-toggle"
                   ${chk(cfg.useActiveEffect)} />
          </div>

          <div class="oni-ec-indent" data-oni-ec-ae="1"
               ${cfg.useActiveEffect ? "" : 'style="display:none"'}>
            <ul class="oni-ec-ae-list" data-oni-ae-list="1"></ul>
            <div class="oni-ec-ae-actions">
              <button type="button" data-oni-ae-add-registry="1">
                <i class="fas fa-list"></i> Add from Registry
              </button>
              <button type="button" data-oni-ae-add-custom="1">
                <i class="fas fa-plus"></i> Create Custom
                ${!game.user?.isGM ? "<span style='opacity:.5;font-size:10px'>(GM only)</span>" : ""}
              </button>
            </div>
            <p class="notes" style="margin-top:4px;">
              Effects are applied in order.  Registry effects use the Active Effect Registry;
              custom effects open the native Foundry AE sheet (GM only).
            </p>
            <!-- Hidden input carries the JSON array — updated by JS on every change -->
            <input type="hidden" name="${fl("activeEffectsJson")}"
                   data-oni-ae-json="1"
                   value="${(cfg.activeEffectsJson ?? "").replace(/"/g, "&quot;")}" />
          </div>

          <!-- Output -->
          <h3><i class="fas fa-volume-up"></i> Output</h3>
          <div class="form-group">
            <label>Silent mode</label>
            <input type="checkbox" name="${fl("silent")}"
                   data-dtype="Boolean" data-oni-ec="silent-toggle"
                   ${chk(cfg.silent)} />
            <p class="notes">Suppresses chat card, VFX, and SFX (resource/AE still apply).</p>
          </div>

          <div data-oni-ec-output="1" ${cfg.silent ? 'style="display:none"' : ""}>

            <div class="form-group">
              <label>Visual Effect</label>
              <select name="${fl("vfxType")}" data-oni-ec="vfx-type">
                <option value="none"        ${sel("none",        cfg.vfxType)}>None</option>
                <option value="file"        ${sel("file",        cfg.vfxType)}>VFX File (on token)</option>
                <option value="screenflash" ${sel("screenflash", cfg.vfxType)}>Screen Flash</option>
              </select>
            </div>

            <div class="oni-ec-indent" data-oni-ec-vfx-file="1"
                 ${cfg.vfxType === "file" ? "" : 'style="display:none"'}>
              <div class="form-group">
                <label>VFX File URL</label>
                <input type="text" name="${fl("vfxFile")}"
                       value="${cfg.vfxFile}" placeholder="https://… or modules/…/file.webm" />
                <p class="notes">
                  .webm / .gif / .png supported.  Uses Sequencer if installed; otherwise
                  PIXI sprite overlay on the party token.  Synced to all clients.
                </p>
              </div>
            </div>

            <div class="oni-ec-indent" data-oni-ec-vfx-flash="1"
                 ${cfg.vfxType === "screenflash" ? "" : 'style="display:none"'}>
              <div class="form-group">
                <label>Flash Tint</label>
                <input type="color" name="${fl("vfxFlashTint")}" value="${cfg.vfxFlashTint}" />
              </div>
              <div class="form-group">
                <label>Flash Opacity (0–1)</label>
                <input type="number" name="${fl("vfxFlashAlpha")}"
                       data-dtype="Number" min="0" max="1" step="0.05"
                       value="${cfg.vfxFlashAlpha}" />
              </div>
            </div>

            <div class="form-group" style="margin-top:6px;">
              <label>Sound Effect URL</label>
              <input type="text" name="${fl("sfxUrl")}"
                     value="${cfg.sfxUrl}" placeholder="https://… or modules/…/sound.ogg" />
              <p class="notes">Plays on all clients when tile triggers.  Uses Sequencer if installed.</p>
            </div>

          </div><!-- /data-oni-ec-output -->
        </div><!-- /data-oni-ec-body -->
      </div><!-- /oni-ec -->
    `;
  }

  // ── Wire panel interactivity ───────────────────────────────────────────────
  function wirePanel(panel, cfg, app) {
    const $ = sel => panel.querySelector(sel);
    const resize = () => { try { app.setPosition({ height: "auto" }); } catch {} };
    const toggle = (el, show) => { if (el) el.style.display = show ? "" : "none"; };

    // In-memory AE list (populated from saved JSON)
    let activeEffects = cfg.activeEffects ?? [];
    const jsonInput   = $("[data-oni-ae-json='1']");
    const listEl      = $("[data-oni-ae-list='1']");

    function syncJson() {
      if (jsonInput) jsonInput.value = JSON.stringify(activeEffects);
    }

    function removeEffect(idx) {
      activeEffects.splice(idx, 1);
      syncJson();
      renderAeList(listEl, activeEffects, removeEffect);
      resize();
    }

    // Initial render of the AE list
    if (listEl) renderAeList(listEl, activeEffects, removeEffect);

    // "Add from Registry" button
    const addRegistryBtn = $("[data-oni-ae-add-registry='1']");
    if (addRegistryBtn) {
      addRegistryBtn.addEventListener("click", () => {
        openRegistryPicker(entry => {
          activeEffects.push(entry);
          syncJson();
          renderAeList(listEl, activeEffects, removeEffect);
          resize();
        });
      });
    }

    // "Create Custom" button → native builder
    const addCustomBtn = $("[data-oni-ae-add-custom='1']");
    if (addCustomBtn) {
      addCustomBtn.addEventListener("click", () => {
        openNativeBuilder(entry => {
          activeEffects.push(entry);
          syncJson();
          renderAeList(listEl, activeEffects, removeEffect);
          resize();
        }).catch(e => console.warn(TAG, "Native builder error:", e));
      });
    }

    // Master toggle
    const masterCb = $("[data-oni-ec='master']");
    const body     = $("[data-oni-ec-body='1']");
    masterCb?.addEventListener("change", () => { toggle(body, masterCb.checked); resize(); });

    // Skill check toggle
    const scCb   = $("[data-oni-ec='skill-check-toggle']");
    const scBody = $("[data-oni-ec-skill-check='1']");
    scCb?.addEventListener("change", () => { toggle(scBody, scCb.checked); resize(); });

    // Resource toggle
    const resCb   = $("[data-oni-ec='resource-toggle']");
    const resBody = $("[data-oni-ec-resource='1']");
    resCb?.addEventListener("change", () => { toggle(resBody, resCb.checked); resize(); });

    // Resource type → show/hide element + weapon fields (damage only)
    const resTypeSel      = $("[data-oni-ec='resource-type']");
    const damageOnlyFields = panel.querySelectorAll("[data-oni-ec-damage-only='1']");
    resTypeSel?.addEventListener("change", () => {
      const show = resTypeSel.value === "damage";
      damageOnlyFields.forEach(el => toggle(el, show));
      resize();
    });

    // AE toggle
    const aeCb   = $("[data-oni-ec='ae-toggle']");
    const aeBody = $("[data-oni-ec-ae='1']");
    aeCb?.addEventListener("change", () => { toggle(aeBody, aeCb.checked); resize(); });

    // Silent toggle
    const silentCb = $("[data-oni-ec='silent-toggle']");
    const outBody  = $("[data-oni-ec-output='1']");
    silentCb?.addEventListener("change", () => { toggle(outBody, !silentCb.checked); resize(); });

    // VFX type
    const vfxSel   = $("[data-oni-ec='vfx-type']");
    const vfxFile  = $("[data-oni-ec-vfx-file='1']");
    const vfxFlash = $("[data-oni-ec-vfx-flash='1']");
    vfxSel?.addEventListener("change", () => {
      toggle(vfxFile,  vfxSel.value === "file");
      toggle(vfxFlash, vfxSel.value === "screenflash");
      resize();
    });
  }

  // ── renderTileConfig hook ──────────────────────────────────────────────────
  Hooks.on("renderTileConfig", (app, html) => {
    try {
      ensureStyle();

      const root = html instanceof HTMLElement ? html
        : html?.[0] instanceof HTMLElement    ? html[0]
        : app?.element?.[0] ?? app?.element   ?? null;
      if (!root) return;

      const subNav     = root.querySelector("[data-oni-fabula-sub-nav='1']");
      const subContent = root.querySelector("[data-oni-fabula-sub-content='1']");
      if (!subNav || !subContent) return;
      if (subNav.querySelector("[data-sub-tab='tile-effects']")) return;

      const tileDoc = app?.document ?? app?.object ?? null;
      const raw     = tileDoc?.flags?.[MODULE_ID]?.[PATHING]?.effectConfig ?? {};
      const bool    = v => v === true || v === "true" || v === 1;

      // Parse the AE array from the saved JSON
      let activeEffects = [];
      if (raw.activeEffectsJson) {
        try { activeEffects = JSON.parse(raw.activeEffectsJson); } catch {}
      }
      // Migrate from old single-AE format
      if (!activeEffects.length && raw.activeEffectId) {
        activeEffects.push({ source: "registry", id: raw.activeEffectId, label: raw.activeEffectId });
      }
      if (!activeEffects.length && raw.customEffectJson) {
        try {
          const d = JSON.parse(raw.customEffectJson);
          activeEffects.push({ source: "custom", json: raw.customEffectJson, label: d.name ?? "Custom" });
        } catch {}
      }

      const cfg = {
        enabled:           bool(raw.enabled),
        useResourceChange: bool(raw.useResourceChange),
        resourceType:      String(raw.resourceType    ?? "damage"),
        resourceValue:     Number(raw.resourceValue   ?? 0),
        elementType:       String(raw.elementType     ?? "elementless"),
        weaponType:        String(raw.weaponType      ?? "none_ef"),
        ignoreReduction:   bool(raw.ignoreReduction),
        useActiveEffect:   bool(raw.useActiveEffect),
        activeEffects,
        activeEffectsJson: raw.activeEffectsJson ?? "",
        targetMode:        String(raw.targetMode      ?? "all"),
        useSkillCheck:     bool(raw.useSkillCheck),
        checkAttrA:        String(raw.checkAttrA      ?? "DEX"),
        checkAttrB:        String(raw.checkAttrB      ?? "MIG"),
        checkDl:           Number(raw.checkDl         ?? 10),
        checkApplyOn:      String(raw.checkApplyOn    ?? "fail"),
        silent:            bool(raw.silent),
        vfxType:           String(raw.vfxType         ?? "none"),
        vfxFile:           String(raw.vfxFile         ?? ""),
        vfxFlashTint:      String(raw.vfxFlashTint    ?? "#ff0000"),
        vfxFlashAlpha:     Number(raw.vfxFlashAlpha   ?? 0.5),
        sfxUrl:            String(raw.sfxUrl          ?? ""),
      };

      // Sub-nav button
      const navBtn             = document.createElement("a");
      navBtn.className         = "item";
      navBtn.dataset.subTab    = "tile-effects";
      navBtn.innerHTML         = `<i class="fas fa-bolt"></i> Tile Effects`;
      if (cfg.enabled) navBtn.style.fontWeight = "700";
      subNav.appendChild(navBtn);

      // Sub-panel
      const panel              = document.createElement("div");
      panel.className          = "oni-fabula-sub-panel";
      panel.dataset.subTab     = "tile-effects";
      panel.style.display      = "none";
      panel.innerHTML          = buildPanelHtml(cfg);
      subContent.appendChild(panel);

      wirePanel(panel, cfg, app);

    } catch (e) {
      console.warn(TAG, "inject failed:", e);
    }
  });

  console.debug(TAG, "renderTileConfig hook registered.");
})();
