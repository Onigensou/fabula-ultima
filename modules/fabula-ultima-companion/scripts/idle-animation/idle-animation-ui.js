/* ============================================================================
 * FabulaUltimaCompanion — Idle Animation System (UI)
 * File: scripts/idle-animation/idle-animation-ui.js
 * Foundry VTT v12
 *
 * Injects into BOTH:
 *  - Prototype Token Config: edits ACTOR default (blueprint)
 *  - Token Config: edits TOKEN override (per token)
 * ============================================================================ */

(() => {
  const TAG = "[ONI][IdleAnim][UI]";
  const API_KEY = "__ONI_IDLE_ANIM_API__";
  const INSTALLED_KEY = "__ONI_IDLE_ANIM_UI_INSTALLED__";

  if (globalThis[INSTALLED_KEY]) return;
  globalThis[INSTALLED_KEY] = true;

  if (globalThis.ONI_IDLE_ANIM_DEBUG === undefined) globalThis.ONI_IDLE_ANIM_DEBUG = false;
  function dbg(...args) { if (globalThis.ONI_IDLE_ANIM_DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  function getAPI() {
    const api = globalThis[API_KEY];
    if (!api) warn("Logic API not found yet. Check module.json load order (logic first).");
    return api;
  }

  function ensureRoot(html, app) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
    if (app?.element instanceof HTMLElement) return app.element;
    return null;
  }

  function bindTabs(app, root) {
    try {
      const tabs = app?._tabs;
      if (!tabs) return { ok: false, reason: "no app._tabs" };
      if (Array.isArray(tabs)) tabs.forEach(t => t?.bind?.(root));
      else Object.values(tabs).forEach(t => t?.bind?.(root));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }

  function findNav($html) {
    let $nav = $html.find('nav.sheet-tabs.tabs[data-group="main"]').first();
    if ($nav.length) return $nav;
    $nav = $html.find("nav.sheet-tabs").first();
    if ($nav.length) return $nav;
    return null;
  }

  function insertPanel($html, $panel) {
    const $mainPanels = $html.find('.tab[data-group="main"]');
    if ($mainPanels.length) $mainPanels.last().after($panel);
    else $html.find("form").append($panel);
  }

  function getDoc(app) {
    return app?.document ?? app?.object?.document ?? null;
  }

  function isPrototypeTokenConfig(app) {
    return app?.constructor?.name === "TokenConfig"
      && typeof app?.id === "string"
      && app.id.startsWith("TokenConfig-Actor.");
  }

  function isNormalTokenConfig(app) {
    return app?.constructor?.name === "TokenConfig"
      && !isPrototypeTokenConfig(app);
  }

  function parseActorIdFromPrototypeAppId(appId) {
    if (typeof appId !== "string") return null;
    const prefix = "TokenConfig-Actor.";
    if (!appId.startsWith(prefix)) return null;
    return appId.slice(prefix.length) || null;
  }

  function resolveContext(app) {
    const doc = getDoc(app);

    const prototypeMode = isPrototypeTokenConfig(app);
    const normalMode = isNormalTokenConfig(app);

    const actorId =
      prototypeMode
        ? (parseActorIdFromPrototypeAppId(app?.id) ?? null)
        : (doc?.actorId ?? app?.token?.document?.actorId ?? null);

    const actor = actorId ? game.actors?.get(actorId) : null;
    const tokenId = normalMode ? (doc?.id ?? app?.token?.id ?? null) : null;

    return { prototypeMode, normalMode, actorId, actor, doc, tokenId };
  }

  function buildPanelHTML({ mode }) {
    const isProto = mode === "prototype";

    const header = isProto
      ? "Idle Animation (Prototype Token)"
      : "Idle Animation (Token Override)";

    const info = isProto
      ? `<p style="margin:0 0 10px 0; opacity:0.85;">
           This sets the <b>Actor’s default blueprint</b>. Newly spawned tokens will use these settings automatically.
         </p>`
      : `<p style="margin:0 0 10px 0; opacity:0.85;">
           This can <b>override</b> the Actor’s prototype default for <b>this token only</b>.
         </p>`;

    const extra = isProto
      ? ""
      : `<div style="display:flex; gap:8px; align-items:center; margin: 10px 0 0 0;">
           <button type="button" class="oni-idle-reset-to-proto">
             Reset to Prototype Default
           </button>
           <span style="opacity:0.75; font-size:12px;">
             Clears this token’s override, so it follows the Actor default again.
           </span>
         </div>`;

    return $(`
      <div class="tab"
           data-tab="oni-idle-animation"
           data-group="main"
           data-oni-idle-anim="panel">
        <div style="padding:10px;">
          <h3 style="margin:0 0 6px 0;">${header}</h3>
          ${info}

          <div class="form-group">
            <label>Float</label>
            <div class="form-fields">
              <input type="checkbox" name="oniIdleAnim.float" data-oni-idle-field="float"/>
            </div>
            <p class="hint">Uses TokenMagic transform filter (cos/sin oscillation).</p>
          </div>

          <div class="form-group">
            <label>Bounce</label>
            <div class="form-fields">
              <input type="checkbox" name="oniIdleAnim.bounce" data-oni-idle-field="bounce"/>
            </div>
            <p class="hint">Uses a lightweight PIXI mesh breathing effect. Synced to all clients.</p>
          </div>

          ${extra}

          <hr/>
          <p style="margin:0; font-size:12px; opacity:0.8;">
            <strong>Debug:</strong> globalThis.ONI_IDLE_ANIM_DEBUG =
            <code>${String(!!globalThis.ONI_IDLE_ANIM_DEBUG)}</code>
          </p>
        </div>
      </div>
    `);
  }

  Hooks.on("renderTokenConfig", async (app, html) => {
    const api = getAPI();
    if (!api) return;

    try {
      const $html = html instanceof jQuery ? html : $(html);
      if ($html.find('[data-oni-idle-anim="tab"]').length) return;

      const root = ensureRoot($html, app);
      const ctx = resolveContext(app);

      if (!ctx.prototypeMode && !ctx.normalMode) return;
      if (!ctx.actor) {
        dbg("No actor resolved; skipping injection.", {
          appId: app?.id,
          title: app?.title,
          prototypeMode: ctx.prototypeMode,
          normalMode: ctx.normalMode,
          actorId: ctx.actorId,
          docActorId: ctx.doc?.actorId
        });
        return;
      }

      const TAB_ID = "oni-idle-animation";
      const GROUP = "main";

      const $nav = findNav($html);
      if (!$nav?.length) {
        warn("Could not find tabs nav. Skipping.");
        return;
      }

      $nav.append($(`
        <a class="item"
           data-tab="${TAB_ID}"
           data-group="${GROUP}"
           data-oni-idle-anim="tab">
          <i class="fas fa-wand-magic-sparkles"></i> Idle Animation
        </a>
      `));

      const mode = ctx.prototypeMode ? "prototype" : "token";
      const $panel = buildPanelHTML({ mode });
      insertPanel($html, $panel);

      const res = bindTabs(app, root);
      dbg("bindTabs()", res);

      // Prefill
      let prefill;
      if (ctx.prototypeMode) {
        prefill = await api.getActorDefaultConfig(ctx.actor);
      } else {
        const token = canvas?.tokens?.get?.(ctx.tokenId) ?? null;
        const override = token ? await api.getTokenOverrideConfig(token) : null;
        prefill = override ?? (await api.getActorDefaultConfig(ctx.actor));
      }

      $panel.find('[data-oni-idle-field="float"]').prop("checked", !!prefill?.float);
      $panel.find('[data-oni-idle-field="bounce"]').prop("checked", !!prefill?.bounce);

      // Reset override
      if (ctx.normalMode) {
        $panel.find(".oni-idle-reset-to-proto").on("click", async () => {
          try {
            const token = canvas?.tokens?.get?.(ctx.tokenId) ?? null;
            if (!token) return;

            await api.clearTokenOverrideConfig(token);
            await api.applyEffectiveConfigToToken(token);
            api.emitSocketApplyToken(token.id);
          } catch (e) {
            err("Reset button failed", e);
          }
        });
      }

      // Submit
      const $form = $html.find("form");
      if ($form.length && !$form.attr("data-oni-idle-submit-bound")) {
        $form.attr("data-oni-idle-submit-bound", "1");

        $form.on("submit", async () => {
          try {
            const next = api.normalizeConfig({
              float: $panel.find('[data-oni-idle-field="float"]').is(":checked"),
              bounce: $panel.find('[data-oni-idle-field="bounce"]').is(":checked")
            });

            if (ctx.prototypeMode) {
              await api.setActorDefaultConfig(ctx.actor, next);
              await api.applyActorToAllTokens(ctx.actorId);
              api.emitSocketApplyActor(ctx.actorId);
              return;
            }

            if (ctx.normalMode) {
              const token = canvas?.tokens?.get?.(ctx.tokenId) ?? null;
              if (!token) return;

              await api.setTokenOverrideConfig(token, next);
              await api.applyEffectiveConfigToToken(token);
              api.emitSocketApplyToken(token.id);
              return;
            }
          } catch (e) {
            err("Submit handler failed", e);
          }
        });
      }
    } catch (e) {
      err("renderTokenConfig injection failed", e);
    }
  });

  dbg("Idle Animation UI loaded (prototype default + token override).");
})();
