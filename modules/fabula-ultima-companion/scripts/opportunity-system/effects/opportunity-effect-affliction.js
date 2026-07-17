// ============================================================================
// Opportunity Effect — Affliction
//
// Flow (pre/post):
//   pre  — debuff picker (from AE registry) + target picker
//          Returns { registryId, tokenId, tokenUuid } — serializable for socket.
//   post — resolves token, clones AE from registry, applies it, plays FX + sound.
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Affliction]";
  const MODULE_ID = "fabula-ultima-companion";

  const SFX_APPLY = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_down.wav";

  function playSound(url, vol = 0.65) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, false); }
    catch (_) {}
  }

  // ── PIXI debuff FX — three blue lines descending through the token ──────────
  function playDebuffFX(token) {
    if (!canvas?.app?.ticker || !token) return;

    const gridSize = canvas.scene?.grid?.size ?? 100;
    const tw = (token.document?.width  ?? 1) * gridSize;
    const th = (token.document?.height ?? 1) * gridSize;
    const tx = token.x ?? 0;
    const ty = token.y ?? 0;

    const BLUE     = 0x44AAFF;
    const ICE      = 0xAADDFF;
    const DURATION = 900;
    const LINE_LEN = th * 0.55;

    const container = new PIXI.Container();
    canvas.tokens.addChild(container);

    // Three lines at left-quarter, centre, right-quarter of token width
    const xPositions = [tx + tw * 0.25, tx + tw * 0.50, tx + tw * 0.75];
    const delays     = [0, 85, 170];

    const lines = xPositions.map((xPos, i) => ({
      gfx:     container.addChild(new PIXI.Graphics()),
      xPos,
      elapsed: -delays[i],
    }));

    const { ticker } = canvas.app;

    function tick() {
      if (lines.every(l => l.elapsed >= DURATION)) {
        ticker.remove(tick);
        container.parent?.removeChild(container);
        container.destroy({ children: true });
        return;
      }

      for (const line of lines) {
        line.elapsed += ticker.deltaMS;
        if (line.elapsed < 0) continue;

        const t = Math.min(line.elapsed / DURATION, 1);

        // Fade in 0–20%, hold 20–75%, fade out 75–100%
        const alpha = t < 0.20 ? t / 0.20
                    : t < 0.75 ? 1
                    : 1 - (t - 0.75) / 0.25;

        // topY sweeps from token top down to (bottom − LINE_LEN) via smoothstep
        const eased = t * t * (3 - 2 * t);
        const topY  = ty + eased * (th - LINE_LEN);
        const botY  = topY + LINE_LEN;

        line.gfx.clear();
        line.gfx.lineStyle(2.2, BLUE, alpha * 0.90);
        line.gfx.moveTo(line.xPos,     topY);
        line.gfx.lineTo(line.xPos,     botY);
        line.gfx.lineStyle(0.8, ICE,   alpha * 0.50);
        line.gfx.moveTo(line.xPos + 1, topY);
        line.gfx.lineTo(line.xPos + 1, botY);
      }
    }

    ticker.add(tick);
  }

  // ── Debuff picker dialog ────────────────────────────────────────────────────
  const PICKER_STYLE_ID = "oni-affliction-picker-css";

  function ensurePickerStyles() {
    if (document.getElementById(PICKER_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = PICKER_STYLE_ID;
    s.textContent = `
      .oni-affl-list {
        list-style: none; margin: 4px 0 0; padding: 0;
        max-height: 260px; overflow-y: auto;
        border: 1px solid rgba(91,63,38,.40);
        border-radius: 5px;
        background: rgba(255,252,245,.75);
      }
      .oni-affl-list li {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 10px; cursor: pointer;
        border-bottom: 1px solid rgba(91,63,38,.12);
        font-size: 0.88rem; color: #3b2a19;
        transition: background 0.1s;
        user-select: none;
      }
      .oni-affl-list li:last-child { border-bottom: none; }
      .oni-affl-list li:hover      { background: rgba(252,212,112,.25); }
      .oni-affl-list li.selected   { background: rgba(68,170,255,.22); font-weight: 700; }
      .oni-affl-list img {
        width: 24px; height: 24px; object-fit: contain; border-radius: 3px; flex-shrink: 0;
      }
      .oni-affl-empty {
        color: #888; font-style: italic; padding: 8px 10px; font-size: 0.85rem;
      }
    `;
    document.head.appendChild(s);
  }

  function showDebuffPicker(debuffs, actorName) {
    ensurePickerStyles();
    const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

    return new Promise(resolve => {
      let selectedId = null;

      const rows = debuffs.length
        ? debuffs.map(e => `
            <li data-id="${esc(e.registryId)}">
              <img src="${esc(e.img ?? e.icon ?? "icons/svg/aura.svg")}" alt="">
              <span>${esc(e.name)}</span>
            </li>`).join("")
        : `<li class="oni-affl-empty">No debuffs found in registry.</li>`;

      const dlg = new Dialog({
        title:   "Affliction — Choose Debuff",
        content: `
          <p style="margin:4px 0 6px;font-size:.9rem;">
            <strong>${esc(actorName)}</strong> inflicts a debuff. Which one?
          </p>
          <ul class="oni-affl-list">${rows}</ul>`,
        buttons: {
          apply:  { label: "Apply",  callback: () => resolve(selectedId) },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "apply",
        close:   () => resolve(null),
        render:  html => {
          // Disable Apply until a row is selected
          const applyBtn = html.closest(".dialog").find("[data-button='apply']");
          applyBtn.prop("disabled", true).css("opacity", "0.45");

          html.find(".oni-affl-list li[data-id]").on("click", function () {
            html.find(".oni-affl-list li").removeClass("selected");
            $(this).addClass("selected");
            selectedId = $(this).data("id");
            applyBtn.prop("disabled", false).css("opacity", "1");
          });
        },
      }, { width: 340 });

      dlg.render(true);
    });
  }

  // ── Token resolver ──────────────────────────────────────────────────────────
  function resolveToken({ tokenId, tokenUuid }) {
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
    ) ?? null;
  }

  // ── Registry helper ─────────────────────────────────────────────────────────

  // Returns true only when the entry carries an explicit "debuff" tag — rules out
  // entries that landed in the Debuff group purely via name inference or parent-item
  // name fallback (e.g. an AE called "Crisis" inside an item named "Debuff").
  function hasExplicitDebuffTag(entry) {
    return (entry.tags ?? []).some(t =>
      String(t).toLowerCase().replace(/[\s_-]+/g, "") === "debuff"
    );
  }

  // Secondary dedup by normalised name — catches actor-instance duplicates that
  // slip past the registry's UUID/fingerprint dedup (each actor copy gets its own
  // UUID, so fingerprints may differ even when the AE is logically the same).
  function dedupeByName(entries) {
    const seen = new Set();
    return entries.filter(e => {
      const key = String(e.name ?? "").trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function getDebuffs() {
    const reg = globalThis.FUCompanion?.api?.activeEffectRegistry;
    if (!reg) return [];
    if (!reg._internal?.cache?.ready) {
      await reg.refresh({ scanCompendiums: false }).catch(() => {});
    }
    // Source exclusively from CONFIG.statusEffects — the same list the native
    // Foundry token status HUD uses — then require an explicit "debuff" tag.
    // This excludes manually-created world/actor AEs and near-duplicate entries
    // (Suppress vs Suppressed, etc.) that have no authoritative status entry.
    const all = reg.getAll({ cloneResult: false })
      .filter(e => e.sourceType === "config-status-effect" && hasExplicitDebuffTag(e));
    return dedupeByName(all);
  }

  // ── Effect handler (pre/post split) ─────────────────────────────────────────
  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("affliction", {

      // ── Pre phase: debuff picker → target picker ─────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        // Step 1: load registry + show debuff picker
        console.debug(TAG, "[pre] loading debuff registry...");
        const debuffs = await getDebuffs();
        console.debug(TAG, "[pre] debuffs available:", debuffs.length);

        const registryId = await showDebuffPicker(debuffs, ctx.actorName);
        console.debug(TAG, "[pre] debuff picked:", registryId);
        if (!registryId) { console.debug(TAG, "[pre] debuff picker cancelled"); return null; }

        // Step 2: pick target
        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({
          title:           "Affliction — Choose Target",
          skillTarget:     "One Enemy",
          sourceActorUuid: ctx.actorUuid,
        });
        console.debug(TAG, "[pre] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        return { registryId, tokenId: token.id, tokenUuid: token.document?.uuid ?? null };
      },

      // ── Post phase: AE application + FX ─────────────────────────────────
      async post(ctx, preResult) {
        const { registryId, tokenId, tokenUuid } = preResult ?? {};

        const token = resolveToken({ tokenId, tokenUuid });
        if (!token?.actor) {
          console.error(TAG, "[post] token not found on canvas", { tokenId, tokenUuid });
          return;
        }

        const targetActor = token.actor;

        const reg = globalThis.FUCompanion?.api?.activeEffectRegistry;
        if (!reg) { console.error(TAG, "[post] activeEffectRegistry not available"); return; }

        const { ok, effectData } = reg.cloneEffectDataForApplication(registryId) ?? {};
        if (!ok || !effectData) {
          console.error(TAG, "[post] cloneEffectDataForApplication failed for:", registryId);
          return;
        }

        // Condition-affinity gate (shared/condition-affinity.js): IM targets
        // refuse the affliction outright; RS targets take it clamped to 1
        // charge (or 1-unit native duration for chargeless AEs).
        const condApi = globalThis.FUCompanion?.api?.conditionAffinity;
        const condAffinity = condApi?.getConditionAffinity?.(targetActor, {
          statuses: effectData.statuses,
          name: effectData.name
        }) ?? null;
        if (condAffinity === "IM") {
          console.debug(TAG, "[post] target immune to", effectData.name, "— affliction nullified");
          ui.notifications?.info?.(`${targetActor.name} is immune to ${effectData.name}.`);
          return;
        }
        if (condAffinity === "RS") {
          condApi.clampEffectDataForResist?.(effectData);
        }

        // Pre-stamp identity so CSB's _onCreateOperation skips its 4 extra setFlag calls
        const effectId   = foundry.utils.randomID();
        const effectUuid = `${targetActor.uuid}.ActiveEffect.${effectId}`;

        effectData._id    = effectId;
        effectData.flags ??= {};
        effectData.flags[MODULE_ID] = {
          ...(effectData.flags[MODULE_ID] ?? {}),
          activeEffectManager: { optimizedCreate: true },
          showTokenIcon:       true,
        };
        effectData.flags["custom-system-builder"] = {
          ...(effectData.flags["custom-system-builder"] ?? {}),
          originalParentId: targetActor.id,
          originalId:       effectId,
          originalUuid:     effectUuid,
          isFromTemplate:   false,
        };

        console.debug(TAG, "[post] applying", effectData.name, "to", targetActor.name);

        const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData])
          .catch(e => { console.error(TAG, "[post] AE creation failed:", e); return null; });

        if (!created) return;
        console.debug(TAG, "[post] AE created:", created.map(e => e.id));

        // Audio + visual feedback
        playSound(SFX_APPLY, 0.75);
        playDebuffFX(token);

        console.debug(TAG, "[done]");
      },
    });
  });
})();
