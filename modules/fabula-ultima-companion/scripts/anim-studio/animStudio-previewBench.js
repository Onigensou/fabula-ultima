// ============================================================================
// Anim Studio — Preview Bench
//
// The testing pain-killer. Runs any animation through the REAL Battle Director
// execution core (FUCompanion.api.animStudio.preview → executeAnimationScript)
// with NO combat, NO FSM, and NO damage. Kills the "enter combat, set up an
// actor with the skill, target, fire, repeat" loop.
//
// Features:
//   - Source = a skill/weapon on the selected token (dropdown of items that
//     actually have an animation_script), OR a pasted item UUID, OR a scratch
//     script textarea.
//   - Caster = the controlled token; Targets = your current user targets
//     (re-read live at each Run so you can retarget without reopening).
//   - Outcome (hit / miss): forged onto the animation payload as
//     `payload.outcomes`, the same field the FSM fills from the accuracy roll,
//     so a script that branches on hit/miss can have EITHER ending rehearsed
//     here. The impact indicator follows it — a damage number or the real MISS
//     word + whiff.
//   - Replay + Loop.
//   - Live CFG panel: the `const CFG = {…}` block is auto-extracted into an
//     editable box; edit numbers and hit Run to see the change instantly. The
//     edited block is spliced back into the script for the preview only (never
//     written to the item).
//   - Opens the SFX Browser.
//
// Installs an "Anim Studio" button in the token scene-controls (GM only), the
// house idiom used by reload-button.js / save-bootstrap.js.
// ============================================================================
(() => {
  const TAG = "[AnimStudio][Bench]";

  function studioApi() { return globalThis.FUCompanion?.api?.animStudio ?? null; }

  let _loop = false;       // loop toggle
  let _running = false;    // guard against overlapping runs
  let _dlg = null;
  let _selItem = "";       // sticky selected item uuid — survives dropdown rebuilds
  let _casterUuid = null;  // sticky caster — locked while tuning so a run's control-bridge can't lose it

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── CFG block extraction / splice ─────────────────────────────────────────
  //
  // Finds `const CFG = { … };` and returns the exact source slice of the object
  // literal (brace-balanced). Our animation templates keep a single numeric CFG
  // block at the top by convention, so brace-counting is safe here.
  function extractCfg(script) {
    const m = /const\s+CFG\s*=\s*/.exec(script);
    if (!m) return null;
    const braceStart = m.index + m[0].length;
    if (script[braceStart] !== "{") return null;
    let depth = 0, i = braceStart;
    for (; i < script.length; i++) {
      const c = script[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    if (depth !== 0) return null;
    return { start: braceStart, end: i, text: script.slice(braceStart, i) };
  }

  function spliceCfg(script, newObjText) {
    const cfg = extractCfg(script);
    if (!cfg) return script;
    return script.slice(0, cfg.start) + newObjText + script.slice(cfg.end);
  }

  // ── Source resolution ─────────────────────────────────────────────────────

  function controlledCaster() { return canvas?.tokens?.controlled?.[0] ?? null; }
  function currentTargets() { return Array.from(game.user?.targets ?? []); }

  // List items on an actor that carry an animation_script, for the dropdown.
  function animItemsOf(actor) {
    const out = [];
    for (const item of (actor?.items?.contents ?? [])) {
      const raw = String(item?.system?.props?.animation_script ?? "").trim();
      if (!raw || /insert your sequencer animation here/i.test(raw)) continue;
      out.push({ uuid: item.uuid, name: item.name, type: item.type });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async function run(root) {
    if (_running) return;
    const api = studioApi();
    if (!api?.preview) { ui.notifications?.error?.("Anim Studio preview API missing (is the Battle Director loaded?)."); return; }

    const mode = root.querySelector('input[name="as-mode"]:checked')?.value ?? "skill";
    const caster = controlledCaster();
    if (caster) _casterUuid = caster.document.uuid;   // remember the last real selection
    const targets = currentTargets();
    const casterUuid = caster?.document?.uuid ?? _casterUuid ?? null;  // sticky — survives the control-bridge
    const targetUuids = targets.map((t) => t?.document?.uuid).filter(Boolean);

    if (!casterUuid) {
      ui.notifications?.warn?.("Anim Studio: select a caster token first (most scripts need one).");
    }

    let script = "";
    let timingMode = "default";
    let timingOffset = 0;

    if (mode === "scratch") {
      script = root.querySelector(".as-scratch")?.value ?? "";
      timingMode = root.querySelector(".as-timing-mode")?.value ?? "default";
      timingOffset = Number(root.querySelector(".as-timing-offset")?.value ?? 0) || 0;
      if (!script.trim()) { ui.notifications?.warn?.("Anim Studio: scratch script is empty."); return; }
    } else {
      const uuid = (root.querySelector(".as-item-uuid")?.value
        || _selItem || root.querySelector(".as-item-select")?.value || "").trim();
      if (!uuid) { ui.notifications?.warn?.("Anim Studio: pick or paste an item to preview."); return; }
      let spec;
      try { spec = await api.resolveSpec({ skillUuid: uuid }); }
      catch (e) { ui.notifications?.error?.("Anim Studio: failed to read the item's animation."); console.error(TAG, e); return; }
      if (!spec?.hasScript) { ui.notifications?.warn?.("Anim Studio: that item has no animation_script."); return; }
      script = spec.script;
      timingMode = spec.timingMode;
      timingOffset = spec.timingOffset;
    }

    // Apply live CFG override (preview-only; never persisted to the item).
    const cfgBox = root.querySelector(".as-cfg");
    const cfgEdited = cfgBox?.value?.trim();
    if (cfgEdited && cfgBox && !cfgBox.disabled) {
      const spliced = spliceCfg(script, cfgEdited);
      if (spliced !== script) script = spliced;
    }

    // Accuracy outcome. Forged onto the payload so a branching script takes the
    // chosen ending — the bench's whole reason for having the control. Built per
    // target; with no target we still send one anonymous row, because otherwise
    // the selector would silently mean nothing.
    const isMiss = (root.querySelector(".as-outcome")?.value ?? "hit") === "miss";
    const outcomes = (targetUuids.length ? targetUuids : [null])
      .map((u) => ({ tokenUuid: u, hit: !isMiss, crit: false }));

    // Optional impact-indicator preview config (fired at the damage gate, below).
    const dmgOn = !!root.querySelector(".as-dmg")?.checked;
    const dmgCfg = {
      amount: Number(root.querySelector(".as-dmg-amt")?.value ?? 0) || 0,
      element: root.querySelector(".as-dmg-el")?.value ?? "fire",
      affinity: root.querySelector(".as-dmg-aff")?.value ?? "NE",
      isCrit: !!root.querySelector(".as-dmg-crit")?.checked,
    };
    for (const o of outcomes) o.crit = o.hit && dmgCfg.isCrit;
    // Whom the numbers pop on: the targets, or the caster if none (self FX).
    const dmgTokens = targetUuids.length ? targetUuids : (casterUuid ? [casterUuid] : []);

    const statusEl = root.querySelector(".as-status");
    _running = true;
    if (statusEl) statusEl.textContent = "▶ playing…";
    do {
      let res;
      try {
        res = await api.preview({ script, timingMode, timingOffset, casterTokenUuid: casterUuid, targetTokenUuids: targetUuids, outcomes });
      } catch (e) {
        console.error(TAG, "preview threw", e);
        res = { ok: false, ms: 0, error: String(e?.message ?? e) };
      }
      // preview() resolves at the damage gate (impact / set timing), so firing
      // the dummy number here makes it pop exactly when a real hit would land.
      // On a miss it is the MISS word + whiff instead — the same pair RESOLVE
      // floats on a dodged attack. A cinematic that pops its OWN miss number
      // (Crysta's Zero Power does, at its own beat) wants this box UNCHECKED,
      // exactly as for a script that owns its damage number.
      if (res.ok && dmgOn && dmgTokens.length) {
        for (const t of dmgTokens) {
          if (isMiss) api.previewMissVfx?.({ tokenUuid: t });
          else api.previewDamageVfx?.({ tokenUuid: t, resource: "hp", amount: dmgCfg.amount, element: dmgCfg.element, affinity: dmgCfg.affinity, isCrit: dmgCfg.isCrit });
        }
      }
      if (statusEl) {
        statusEl.textContent = res.ok
          ? `✓ done in ${res.ms}ms${_loop ? " · looping…" : ""}`
          : `✗ error: ${res.error ?? "unknown"}`;
      }
      if (!res.ok) break;                 // don't loop a broken script
      if (_loop) await new Promise((r) => setTimeout(r, 400));
    } while (_loop && _dlg?.rendered);
    _running = false;
  }

  // Populate the CFG box + item dropdown from the currently-selected source.
  async function refreshCfg(root) {
    const mode = root.querySelector('input[name="as-mode"]:checked')?.value ?? "skill";
    const cfgBox = root.querySelector(".as-cfg");
    const cfgNote = root.querySelector(".as-cfg-note");
    let script = "";

    if (mode === "scratch") {
      script = root.querySelector(".as-scratch")?.value ?? "";
    } else {
      const uuid = (root.querySelector(".as-item-uuid")?.value
        || _selItem || root.querySelector(".as-item-select")?.value || "").trim();
      if (uuid) {
        try {
          const spec = await studioApi()?.resolveSpec({ skillUuid: uuid });
          script = spec?.script ?? "";
        } catch { /* ignore */ }
      }
    }
    const cfg = extractCfg(script);
    if (cfg && cfgBox) {
      cfgBox.value = cfg.text;
      cfgBox.disabled = false;
      if (cfgNote) cfgNote.textContent = "Edit numbers, then Run. (Preview-only — not saved to the item.)";
    } else if (cfgBox) {
      cfgBox.value = "";
      cfgBox.disabled = true;
      if (cfgNote) cfgNote.textContent = "No `const CFG = {…}` block found in this script.";
    }
  }

  function refreshCasterInfo(root) {
    // Never rebuild mid-run: a preview transiently releases/re-controls the
    // caster (control-bridge), which would otherwise wipe the dropdown selection.
    if (_running) return;
    const c = controlledCaster();
    if (c) _casterUuid = c.document.uuid;
    const targets = currentTargets();
    const el = root.querySelector(".as-caster-info");
    if (el) {
      el.innerHTML = `Caster: <b>${esc(c?.name ?? "— none selected —")}</b> · `
        + `Targets: <b>${targets.length ? targets.map((t) => esc(t.name)).join(", ") : "none"}</b>`;
    }
    // Rebuild the item dropdown from the caster's actor. Preserve the sticky
    // selection (_selItem) across rebuilds so tuning never loses the item.
    const sel = root.querySelector(".as-item-select");
    if (sel) {
      const items = animItemsOf(c?.actor);
      const keep = _selItem || sel.value;
      sel.innerHTML = `<option value="">— pick an animated item —</option>`
        + items.map((it) => `<option value="${esc(it.uuid)}">${esc(it.name)} (${esc(it.type)})</option>`).join("");
      if (items.find((it) => it.uuid === keep)) { sel.value = keep; _selItem = keep; }
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function content() {
    return `
    <div class="anim-studio-bench" style="display:flex;flex-direction:column;gap:8px;min-width:520px;">
      <div class="as-caster-info" style="font-size:.85em;padding:6px 8px;background:rgba(0,0,0,.2);border-radius:4px;"></div>

      <div style="display:flex;gap:14px;align-items:center;">
        <label><input type="radio" name="as-mode" value="skill" checked/> Item / skill</label>
        <label><input type="radio" name="as-mode" value="scratch"/> Scratch script</label>
        <button type="button" class="as-refresh" title="Re-read selected token + targets" style="margin-left:auto;">
          <i class="fas fa-rotate"></i> Refresh</button>
      </div>

      <div class="as-skill-pane">
        <div style="display:flex;gap:6px;align-items:center;">
          <select class="as-item-select" style="flex:1 1 auto;"></select>
        </div>
        <input type="text" class="as-item-uuid" placeholder="…or paste an Item UUID (overrides the dropdown)"
               style="width:100%;margin-top:4px;"/>
      </div>

      <div class="as-scratch-pane" style="display:none;">
        <textarea class="as-scratch" placeholder="Paste a full animation_script (plain JS outer script)…"
                  style="width:100%;height:140px;font-family:monospace;font-size:12px;"></textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px;font-size:.85em;">
          <label>Timing:
            <select class="as-timing-mode">
              <option value="default">default (wait oni:animationEnd)</option>
              <option value="timing_offset">offset ms after start</option>
            </select>
          </label>
          <label>offset <input type="number" class="as-timing-offset" value="0" min="0" style="width:70px;"/> ms</label>
        </div>
      </div>

      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:.85em;">CFG (live tuning)</b>
          <span class="as-cfg-note" style="font-size:.75em;opacity:.6;"></span>
        </div>
        <textarea class="as-cfg" spellcheck="false"
                  style="width:100%;height:150px;font-family:monospace;font-size:12px;"></textarea>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:.82em;
                  padding:5px 7px;background:rgba(0,0,0,.12);border-radius:4px;">
        <label title="Forged onto the animation payload as payload.outcomes — the same field the director fills from the accuracy roll. A script that branches on hit/miss takes this ending.">Outcome
          <select class="as-outcome">
            <option value="hit" selected>hit</option>
            <option value="miss">miss</option>
          </select></label>
        <label title="Pop a dummy impact indicator on the target(s) at the damage gate, like real play"><input type="checkbox" class="as-dmg"/> <span class="as-dmg-label">Damage #</span></label>
        <input type="number" class="as-dmg-amt" value="120" min="0" style="width:60px;" title="dummy amount"/>
        <select class="as-dmg-el" title="element (colour)">
          <option value="physical">physical</option><option value="fire" selected>fire</option>
          <option value="ice">ice</option><option value="bolt">bolt</option><option value="earth">earth</option>
          <option value="wind">wind</option><option value="light">light</option><option value="dark">dark</option>
          <option value="poison">poison</option><option value="elementless">none</option>
        </select>
        <select class="as-dmg-aff" title="affinity">
          <option value="NE">normal</option><option value="VU">WEAK!</option><option value="RS">resist</option>
        </select>
        <label><input type="checkbox" class="as-dmg-crit"/> crit</label>
      </div>

      <div style="display:flex;gap:8px;align-items:center;">
        <button type="button" class="as-run" style="font-weight:600;"><i class="fas fa-play"></i> Run</button>
        <label style="font-size:.85em;"><input type="checkbox" class="as-loop"/> Loop</label>
        <button type="button" class="as-brief" style="margin-left:auto;"><i class="fas fa-list-check"></i> Brief Builder</button>
        <button type="button" class="as-sfx"><i class="fas fa-music"></i> SFX Browser</button>
      </div>
      <div class="as-status" style="font-size:.82em;opacity:.8;min-height:1.2em;"></div>
    </div>`;
  }

  function wire(html) {
    const root = html[0] ?? html;

    // A miss has no amount, element, affinity or crit — grey them out rather
    // than leaving four live controls that feed nothing.
    const syncOutcome = () => {
      const miss = (root.querySelector(".as-outcome")?.value ?? "hit") === "miss";
      for (const sel of [".as-dmg-amt", ".as-dmg-el", ".as-dmg-aff", ".as-dmg-crit"]) {
        const el = root.querySelector(sel);
        if (el) { el.disabled = miss; el.style.opacity = miss ? ".4" : ""; }
      }
      const lbl = root.querySelector(".as-dmg-label");
      if (lbl) lbl.textContent = miss ? "MISS #" : "Damage #";
    };

    const syncPanes = () => {
      const mode = root.querySelector('input[name="as-mode"]:checked')?.value ?? "skill";
      root.querySelector(".as-skill-pane").style.display = mode === "skill" ? "" : "none";
      root.querySelector(".as-scratch-pane").style.display = mode === "scratch" ? "" : "none";
      refreshCfg(root);
    };

    root.querySelectorAll('input[name="as-mode"]').forEach((r) =>
      r.addEventListener("change", syncPanes));

    root.querySelector(".as-refresh")?.addEventListener("click", () => {
      refreshCasterInfo(root);
      refreshCfg(root);
    });
    root.querySelector(".as-item-select")?.addEventListener("change", (e) => {
      // Selecting from the dropdown clears the manual UUID override + sticks.
      _selItem = e.target.value || "";
      const u = root.querySelector(".as-item-uuid"); if (u) u.value = "";
      refreshCfg(root);
    });
    root.querySelector(".as-item-uuid")?.addEventListener("change", () => { _selItem = ""; refreshCfg(root); });
    let st = null;
    root.querySelector(".as-scratch")?.addEventListener("input", () => {
      clearTimeout(st); st = setTimeout(() => refreshCfg(root), 300);
    });

    root.querySelector(".as-outcome")?.addEventListener("change", syncOutcome);
    root.querySelector(".as-loop")?.addEventListener("change", (e) => { _loop = e.target.checked; });
    root.querySelector(".as-run")?.addEventListener("click", () => run(root));
    root.querySelector(".as-sfx")?.addEventListener("click", () => studioApi()?.openSfxBrowser?.());
    root.querySelector(".as-brief")?.addEventListener("click", () => studioApi()?.openBriefBuilder?.());

    refreshCasterInfo(root);
    syncOutcome();
    syncPanes();
  }

  function open() {
    if (!game.user?.isGM) { ui.notifications?.warn?.("Anim Studio is GM-only."); return; }
    if (_dlg?.rendered) { _dlg.bringToTop?.(); return _dlg; }
    _loop = false; _selItem = ""; _casterUuid = null;
    _dlg = new Dialog({
      title: "Anim Studio — Preview Bench",
      content: content(),
      buttons: { close: { icon: '<i class="fas fa-times"></i>', label: "Close" } },
      default: "close",
      render: (html) => wire(html),
      close: () => { _loop = false; _dlg = null; },
    }, { width: 560, resizable: true, classes: ["anim-studio-dialog"] });
    _dlg.render(true);
    return _dlg;
  }

  // Keep the caster/target readout + item list fresh while the bench is open —
  // but never during a run (the preview's control-bridge would wipe selection).
  Hooks.on("controlToken", () => { if (!_running && _dlg?.rendered) { const r = _dlg.element?.[0]; if (r) refreshCasterInfo(r); } });
  Hooks.on("targetToken", () => { if (!_running && _dlg?.rendered) { const r = _dlg.element?.[0]; if (r) refreshCasterInfo(r); } });

  // Access is via the Developer Tools launcher (🎬), registered in director-boot.
  // (Previously a Foundry scene-controls toolbar button; moved to declutter.)

  Hooks.once("ready", () => {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.animStudio ??= {};
    globalThis.FUCompanion.api.animStudio.openBench = open;
    console.debug(TAG, "ready.");
  });
})();
