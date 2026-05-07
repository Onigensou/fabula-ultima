
/**
 * Fabula Initiative — Turn Bar UI/UX Library (Module Version)
 * Registers: globalThis.oniTurnBarUI.create(...)
 *
 * Notes:
 * - UI is presentation-only: it renders models and owns animation timing.
 * - It can "lock" renders while transitions play, then applies the latest deferred model.
 * - No heavy debug logging (production/lightweight build).
 */
(() => {
  if (globalThis.oniTurnBarUI?.create) return;

  globalThis.oniTurnBarUI = {
    create({ tuner, ids, callbacks }) {
      const T = tuner;
      const IDS = ids;

      // =========================================================
      // STATE
      // =========================================================
      const state = {
        isOpen: false,
        root: null,
        model: null,

        // WEBM thumb cache
        thumbCache: new Map(),
        thumbInFlight: new Map(),

        // tooltip
        tooltipEl: null,

        // Per-actor icon config cache
        iconCfgCache: new Map(), // actorId -> {x,y,scale}

        // Render lock (for animation-safe updates)
        lockCount: 0,
        pendingModel: null,
        pendingReason: null,

        // Diff tracking (grant fade-in)
        prevKeys: new Set(),
        lastAnimHint: null, // "grant" | null

        // Temporarily pin CURRENT visuals during activate animation
        // { wantedCombatantId, name, disposition, src, ix, iy, iscale, expiresAt }
        currentOverride: null,
      };

      // =========================================================
      // HELPERS
      // =========================================================
      const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

      const numOrNull = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === "string" && v.trim() === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const getProp = (obj, path) => {
        try {
          return foundry?.utils?.getProperty
            ? foundry.utils.getProperty(obj, path)
            : path.split(".").reduce((a, k) => (a ? a[k] : undefined), obj);
        } catch (_) {
          return undefined;
        }
      };

      const isWebm = (src) => typeof src === "string" && /\.webm(\?|#|$)/i.test(src);
      const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

      function resolveActorFromIcon(iconLike) {
        const actorId = iconLike?.actorId;
        const tokenId = iconLike?.tokenId;
        let actor = null;

        if (actorId && game?.actors?.get) actor = game.actors.get(actorId) ?? null;
        if (!actor && tokenId && canvas?.tokens?.get) actor = canvas.tokens.get(tokenId)?.actor ?? null;

        return actor;
      }

      function readActorIconCfg(iconLike) {
        const defX = Number.isFinite(Number(T.defaultIconOffsetX)) ? Number(T.defaultIconOffsetX) : 0;
        const defY = Number.isFinite(Number(T.defaultIconOffsetY)) ? Number(T.defaultIconOffsetY) : 0;

        let defS = numOrNull(T.defaultIconScale);
        if (!Number.isFinite(defS) || defS === 0) defS = 1;
        if (Math.abs(defS) > 10) defS = defS / 100;
        defS = clamp(defS, 0.2, 3);

        const actor = resolveActorFromIcon(iconLike);
        if (!actor) return { x: defX, y: defY, scale: defS };

        const cacheKey = actor.id ?? null;
        if (cacheKey && state.iconCfgCache.has(cacheKey)) return state.iconCfgCache.get(cacheKey);

        const rawX =
          numOrNull(getProp(actor, "system.icon_offset_x")) ??
          numOrNull(getProp(actor, "system.props.icon_offset_x"));

        const rawY =
          numOrNull(getProp(actor, "system.icon_offset_y")) ??
          numOrNull(getProp(actor, "system.props.icon_offset_y"));

        let rawS =
          numOrNull(getProp(actor, "system.icon_scale")) ??
          numOrNull(getProp(actor, "system.props.icon_scale"));

        const x = rawX ?? defX;
        const y = rawY ?? defY;

        let s = rawS ?? defS;
        if (!Number.isFinite(s) || s === 0) s = defS;
        if (Math.abs(s) > 10) s = s / 100;
        s = clamp(s, 0.2, 3);

        const cfg = { x, y, scale: s };
        if (cacheKey) state.iconCfgCache.set(cacheKey, cfg);
        return cfg;
      }

      function applyIconTransform(imgEl, iconLike) {
        if (!imgEl) return;
        const { x, y, scale } = readActorIconCfg(iconLike);
        imgEl.style.setProperty("--oni-ix", `${x}px`);
        imgEl.style.setProperty("--oni-iy", `${y}px`);
        imgEl.style.setProperty("--oni-iscale", `${scale}`);
      }

      // =========================================================
      // RENDER LOCK
      // =========================================================
      function lockRender() {
        state.lockCount++;
      }

      function unlockRender() {
        state.lockCount = Math.max(0, state.lockCount - 1);

        if (state.lockCount === 0 && state.pendingModel) {
          const m = state.pendingModel;
          const r = state.pendingReason || "deferred";
          state.pendingModel = null;
          state.pendingReason = null;
          doRender(m, r);
        }
      }

      // =========================================================
      // PUBLIC API
      // =========================================================
      const api = {
        open() {
          if (state.isOpen) return;
          state.isOpen = true;

          injectStyle();
          renderRoot();
          spawnFadeIn();
        },

        async close() {
          if (!state.isOpen) return;
          state.isOpen = false;

          const root = document.getElementById(IDS.ROOT_ID);
          if (root) {
            root.classList.add("oni-turnbar-despawn");
            await waitMs(T.despawnDurationMs);
          }

          cleanupTooltip();
          document.getElementById(IDS.ROOT_ID)?.remove();
          document.getElementById(IDS.STYLE_ID)?.remove();
          state.root = null;
        },

        render(model, reason = "render") {
          if (!state.isOpen) return;

          if (state.lockCount > 0) {
            state.pendingModel = model;
            state.pendingReason = reason;
            return;
          }

          doRender(model, reason);
        },
      };

      // =========================================================
      // INTERNAL RENDER
      // =========================================================
      function doRender(model, reason) {
        state.model = model;

        // Clear CURRENT override only when backend catches up (or it expires)
        if (state.currentOverride) {
          const now = Date.now();

          if (now > state.currentOverride.expiresAt) {
            state.currentOverride = null;
          } else {
            const wanted = state.currentOverride.wantedCombatantId;
            const modelCurId = model?.current?.combatantId ?? null;
            if (wanted && modelCurId && wanted === modelCurId) {
              state.currentOverride = null;
            }
          }
        }

        const root = state.root || document.getElementById(IDS.ROOT_ID);
        if (!root) return;

        // track prev keys for fade-in diffs
        const prevKeys = state.prevKeys;
        const nextKeys = new Set((model?.icons ?? []).map((i) => i.key));

        renderTrack(model);

        if (reason === "open") fanSpawnAllIcons();

        // Fade-in newly added icons only when last hint is "grant"
        if (state.lastAnimHint === "grant") {
          const added = [];
          for (const k of nextKeys) if (!prevKeys.has(k)) added.push(k);

          for (const k of added) {
            const el = root.querySelector(`.oni-turnbar-icon[data-key="${CSS.escape(k)}"]`);
            if (!el) continue;
            el.classList.add("oni-fadein");
            requestAnimationFrame(() => el.classList.remove("oni-fadein"));
          }

          state.lastAnimHint = null;
        }

        state.prevKeys = nextKeys;
      }

      // =========================================================
      // DOM BUILD
      // =========================================================
      function renderRoot() {
        document.getElementById(IDS.ROOT_ID)?.remove();

        const root = document.createElement("div");
        root.id = IDS.ROOT_ID;
        root.className = "oni-turnbar";
        root.dataset.anchor = T.anchor;

        const currentGap = Number.isFinite(Number(T.currentGap)) ? Number(T.currentGap) : 18;
        const overscan = Number.isFinite(Number(T.basePortraitZoom)) ? Number(T.basePortraitZoom) : 1.7;

        root.style.setProperty("--oni-x", `${T.offsetX}px`);
        root.style.setProperty("--oni-y", `${T.offsetY}px`);
        root.style.setProperty("--oni-gap", `${T.gap}px`);
        root.style.setProperty("--oni-pad", `${T.padding}px`);
        root.style.setProperty("--oni-blur", `${T.backdropBlur}px`);
        root.style.setProperty("--oni-size", `${T.iconSize}px`);
        root.style.setProperty("--oni-inset", `${T.imgInset}px`);
        root.style.setProperty("--oni-border", `${T.borderWidth}px`);
        root.style.setProperty("--oni-border-opacity", `${T.borderOpacity}`);
        root.style.setProperty("--oni-ease", `${T.easing}`);
        root.style.setProperty("--oni-remove-ms", `${T.removeDurationMs}ms`);
        root.style.setProperty("--oni-shift-ms", `${T.shiftDurationMs}ms`);
        root.style.setProperty("--oni-cur-slide-ms", `${T.currentSlideMs}ms`);
        root.style.setProperty("--oni-header-bg", `${T.headerBgOpacity}`);
        root.style.setProperty("--oni-header-text", `${T.headerTextOpacity}`);

        root.style.setProperty("--oni-spawn-ms", `${T.spawnDurationMs}ms`);
        root.style.setProperty("--oni-spawn-stagger", `${T.spawnStaggerMs}ms`);
        root.style.setProperty("--oni-spawn-from-x", `${T.spawnFromX}px`);

        root.style.setProperty("--oni-tip-ms", `${T.tooltipScaleMs}ms`);
        root.style.setProperty("--oni-tip-offy", `${T.tooltipOffsetY}px`);
        root.style.setProperty("--oni-tip-maxw", `${T.tooltipMaxWidth}px`);

        root.style.setProperty("--oni-col-enemy", T.borderColorEnemy);
        root.style.setProperty("--oni-col-ally", T.borderColorAlly);
        root.style.setProperty("--oni-col-neutral", T.borderColorNeutral);

        root.style.setProperty("--oni-current-gap", `${currentGap}px`);
        root.style.setProperty("--oni-overscan", `${overscan}`);

        root.innerHTML = `
          <div class="oni-turnbar-panel">
            <div class="oni-turnbar-header">
              <div class="oni-turnbar-title">TURN ACTIVATIONS</div>
              <button class="oni-turnbar-btn" data-action="refresh" title="Refresh">⟳</button>
              <button class="oni-turnbar-btn" data-action="close" title="Close">✕</button>
            </div>

            <div class="oni-turnbar-track" aria-label="Turn Activations"></div>
          </div>
        `;

        document.body.appendChild(root);
        state.root = root;

        root.querySelector('[data-action="refresh"]').addEventListener("click", () => callbacks?.onRequestRefresh?.());
        root.querySelector('[data-action="close"]').addEventListener("click", () => {
          if (callbacks?.onCloseRequested) callbacks.onCloseRequested();
          else api.close();
        });

        // Tooltip
        const tip = document.createElement("div");
        tip.className = "oni-turnbar-tooltip";
        tip.style.display = "none";
        document.body.appendChild(tip);
        state.tooltipEl = tip;

        // reset diff base
        state.prevKeys = new Set();
        state.lastAnimHint = null;
      }

      function renderTrack(model) {
        const root = state.root;
        const track = root?.querySelector(".oni-turnbar-track");
        if (!track) return;

        track.innerHTML = "";

        const row = document.createElement("div");
        row.className = "oni-turnbar-row oni-turnbar-row-main";
        track.appendChild(row);

        // CURRENT
        const currentWrap = document.createElement("div");
        currentWrap.className = "oni-turnbar-current-wrap";

        const currentBtn = document.createElement("button");
        currentBtn.type = "button";
        currentBtn.className = "oni-turnbar-current";
        currentBtn.title = "Current";

        // LEFT click: clear current only
        currentBtn.addEventListener("click", async () => {
          if (callbacks?.canInteract) {
            const ok = await callbacks.canInteract("clearCurrent", null);
            if (!ok) return;
          }
          return callbacks?.onClearCurrent?.();
        });

        // RIGHT click: undo current -> slide back + backend restore
        currentBtn.addEventListener("contextmenu", async (ev) => {
          ev.preventDefault();
          if (!model?.current) return;

          if (callbacks?.canInteract) {
            const ok = await callbacks.canInteract("undoCurrent", model.current);
            if (!ok) return;
          }

          // UI animation first (slide current back into queue)
          const iconsWrap = row.querySelector(".oni-turnbar-icons-wrap");
          if (iconsWrap) {
            lockRender();
            try {
              await animateCurrentBackToQueue(currentBtn, iconsWrap);
            } finally {
              unlockRender();
            }
          }

          const cur = model.current;
          await callbacks?.onUndoCurrent?.({
            key: cur.key ?? `current::${cur.combatantId}`,
            tokenId: cur.tokenId,
            actorId: cur.actorId,
            combatantId: cur.combatantId,
            name: cur.name,
            rawImg: cur.rawImg,
            isWebm: !!cur.isWebm,
            disposition: Number(cur.disposition ?? 0),
            fromCurrent: true,
          });
        });

        const curDiamond = document.createElement("span");
        curDiamond.className = "oni-turnbar-diamond oni-turnbar-diamond--current";

        const curImg = document.createElement("img");
        curImg.className = "oni-turnbar-img";
        curImg.draggable = false;

        // Prefer CURRENT visual override while backend catches up
        const effectiveCurrent = state.currentOverride
          ? {
              name: state.currentOverride.name,
              disposition: state.currentOverride.disposition,
              rawImg: state.currentOverride.src,
              isWebm: isWebm(state.currentOverride.src),
              _manualTransform: {
                ix: state.currentOverride.ix,
                iy: state.currentOverride.iy,
                iscale: state.currentOverride.iscale,
              },
            }
          : model?.current;

        if (effectiveCurrent) {
          currentBtn.dataset.name = effectiveCurrent.name;
          currentBtn.dataset.disposition = String(effectiveCurrent.disposition ?? 0);
          currentBtn.title = effectiveCurrent.name;

          curImg.src = effectiveCurrent.rawImg || "icons/svg/mystery-man.svg";

          if (state.currentOverride && effectiveCurrent._manualTransform) {
            curImg.style.setProperty("--oni-ix", effectiveCurrent._manualTransform.ix || "0px");
            curImg.style.setProperty("--oni-iy", effectiveCurrent._manualTransform.iy || "0px");
            curImg.style.setProperty("--oni-iscale", effectiveCurrent._manualTransform.iscale || "1");
          } else {
            applyIconTransform(curImg, effectiveCurrent);
          }

          curImg.style.opacity = "1";

          if (effectiveCurrent.isWebm) {
            ensureStaticImageSrc(effectiveCurrent.rawImg)
              .then((s) => {
                if (!currentBtn.isConnected) return;
                const imgNow = currentBtn.querySelector("img.oni-turnbar-img");
                if (imgNow && imgNow.src !== s) imgNow.src = s;
              })
              .catch(() => {});
          }
        } else {
          currentBtn.dataset.disposition = "0";
          curImg.src = "icons/svg/mystery-man.svg";
          curImg.style.opacity = "0";
          curImg.style.setProperty("--oni-ix", "0px");
          curImg.style.setProperty("--oni-iy", "0px");
          curImg.style.setProperty("--oni-iscale", "1");
        }

        curDiamond.appendChild(curImg);
        currentBtn.appendChild(curDiamond);

        const curLabel = document.createElement("div");
        curLabel.className = "oni-turnbar-current-label";
        curLabel.textContent = "CURRENT";

        currentWrap.appendChild(currentBtn);
        currentWrap.appendChild(curLabel);
        row.appendChild(currentWrap);

        // QUEUE WRAP
        const iconsWrap = document.createElement("div");
        iconsWrap.className = "oni-turnbar-icons-wrap";
        row.appendChild(iconsWrap);

        const icons = model?.icons ?? [];
        const total = icons.length;
        const rows = Math.max(1, Math.ceil(total / T.maxIconsPerRow));

        for (let r = 0; r < rows; r++) {
          const rr = document.createElement("div");
          rr.className = "oni-turnbar-icons-row";
          iconsWrap.appendChild(rr);
        }

        icons.forEach((icon, idx) => {
          const rowIndex = Math.floor(idx / T.maxIconsPerRow);
          const rr = iconsWrap.children[rowIndex];

          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "oni-turnbar-icon";
          btn.dataset.key = icon.key;
          btn.dataset.tokenId = icon.tokenId;
          btn.dataset.actorId = icon.actorId;
          if (icon.combatantId) btn.dataset.combatantId = icon.combatantId;
          btn.dataset.name = icon.name;
          btn.dataset.disposition = String(icon.disposition ?? 0);
          btn.title = icon.name;

          const imgEl = document.createElement("img");
          imgEl.className = "oni-turnbar-img";
          imgEl.draggable = false;
          imgEl.src = icon.rawImg || "icons/svg/mystery-man.svg";
          applyIconTransform(imgEl, icon);

          const diamond = document.createElement("span");
          diamond.className = "oni-turnbar-diamond";
          diamond.appendChild(imgEl);
          btn.appendChild(diamond);

          // Tooltip
          btn.addEventListener("pointerenter", () => showTooltip(btn, icon.name));
          btn.addEventListener("pointerleave", () => hideTooltip());

          // LEFT click => activate (UI anim first if enabled)
          btn.addEventListener("click", async (ev) => {
            ev.preventDefault();

            if (callbacks?.canInteract) {
              const ok = await callbacks.canInteract("activate", icon);
              if (!ok) return;
            }

            if (T.optimisticCurrentOnClick) {
              lockRender();
              try {
                await animateIconToCurrent(btn, currentBtn);
              } finally {
                unlockRender();
              }
            }

            await callbacks?.onActivate?.(icon);
          });

          // RIGHT click => grant +1 activation (fade-in on next render)
          btn.addEventListener("contextmenu", async (ev) => {
            ev.preventDefault();

            if (callbacks?.canInteract) {
              const ok = await callbacks.canInteract("grant", icon);
              if (!ok) return;
            }

            state.lastAnimHint = "grant";
            await callbacks?.onGrant?.(icon);
          });

          rr.appendChild(btn);

          // WEBM => static thumb
          if (icon.isWebm) {
            ensureStaticImageSrc(icon.rawImg)
              .then((staticSrc) => {
                if (!btn.isConnected) return;
                const imgNow = btn.querySelector("img.oni-turnbar-img");
                if (imgNow && imgNow.src !== staticSrc) imgNow.src = staticSrc;
              })
              .catch(() => {});
          }
        });
      }

      // =========================================================
      // ANIMATION: Queue icon -> CURRENT (fly + queue shift)
      // =========================================================
      async function animateIconToCurrent(iconBtn, currentBtn) {
        if (!iconBtn?.isConnected || !currentBtn?.isConnected) return;

        const iconsRow = iconBtn.closest(".oni-turnbar-icons-row");
        if (!iconsRow) return;

        // Capture FIRST rects for FLIP (before removing the clicked icon)
        const allBefore = Array.from(iconsRow.querySelectorAll(".oni-turnbar-icon"));
        const first = new Map();
        for (const el of allBefore) first.set(el, el.getBoundingClientRect());

        const diamond = iconBtn.querySelector(".oni-turnbar-diamond");
        const srcRect = diamond?.getBoundingClientRect();
        const dstDiamond = currentBtn.querySelector(".oni-turnbar-diamond--current");
        const dstRect = dstDiamond?.getBoundingClientRect();
        if (!srcRect || !dstRect) return;

        // capture portrait data before removal
        const clickImg = iconBtn.querySelector("img.oni-turnbar-img");
        const clickedSrc = clickImg?.src || "icons/svg/mystery-man.svg";
        const clickedIX = clickImg?.style.getPropertyValue("--oni-ix") || "0px";
        const clickedIY = clickImg?.style.getPropertyValue("--oni-iy") || "0px";
        const clickedIS = clickImg?.style.getPropertyValue("--oni-iscale") || "1";

        // Pin CURRENT visuals until combat tracker updates (prevents blink)
        state.currentOverride = {
          wantedCombatantId: iconBtn.dataset.combatantId || null,
          name: iconBtn.dataset.name || "Current",
          disposition: Number(iconBtn.dataset.disposition ?? 0),
          src: clickedSrc,
          ix: clickedIX,
          iy: clickedIY,
          iscale: clickedIS,
          expiresAt: Date.now() + 1200,
        };

        // flying clone at queue position
        const fly = diamond.cloneNode(true);
        fly.classList.add("oni-turnbar-fly");
        fly.style.position = "fixed";
        fly.style.left = `${srcRect.left}px`;
        fly.style.top = `${srcRect.top}px`;
        fly.style.width = `${srcRect.width}px`;
        fly.style.height = `${srcRect.height}px`;
        fly.style.margin = "0";
        fly.style.zIndex = "1000000";
        fly.style.pointerEvents = "none";
        fly.style.opacity = "1";
        fly.style.transform = "translate(0px, 0px)";
        document.body.appendChild(fly);

        // hide CURRENT portrait while flying
        const curImg = currentBtn.querySelector("img.oni-turnbar-img");
        if (curImg) curImg.style.opacity = "0";

        // remove clicked icon immediately so queue shifts
        iconBtn.remove();

        // Measure LAST rects after removal
        const remaining = Array.from(iconsRow.querySelectorAll(".oni-turnbar-icon"));
        const last = new Map();
        for (const el of remaining) last.set(el, el.getBoundingClientRect());

        // FLIP shift remaining
        for (const el of remaining) {
          const f = first.get(el);
          const l = last.get(el);
          if (!f || !l) continue;

          const dx = f.left - l.left;
          const dy = f.top - l.top;
          if (dx === 0 && dy === 0) continue;

          el.style.transform = `translate(${dx}px, ${dy}px)`;
          el.style.transition = "transform 0s";
          el.getBoundingClientRect();

          el.style.transition = `transform var(--oni-shift-ms) var(--oni-ease)`;
          el.style.transform = "translate(0px, 0px)";

          const cleanup = () => {
            el.style.transition = "";
            el.style.transform = "";
            el.removeEventListener("transitionend", cleanup);
          };
          el.addEventListener("transitionend", cleanup);
        }

        // Slide flying clone into CURRENT
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            const dx = dstRect.left - srcRect.left;
            const dy = dstRect.top - srcRect.top;

            fly.style.transition = `transform var(--oni-cur-slide-ms) var(--oni-ease), opacity var(--oni-cur-slide-ms) var(--oni-ease)`;
            fly.style.transform = `translate(${dx}px, ${dy}px)`;
            fly.style.opacity = "0.15";

            window.setTimeout(resolve, T.currentSlideMs);
          });
        });

        // Commit CURRENT portrait after slide
        if (curImg) {
          curImg.src = clickedSrc;
          curImg.style.setProperty("--oni-ix", clickedIX);
          curImg.style.setProperty("--oni-iy", clickedIY);
          curImg.style.setProperty("--oni-iscale", clickedIS);
          curImg.style.opacity = "1";
        }

        currentBtn.dataset.disposition = iconBtn?.dataset?.disposition ?? currentBtn.dataset.disposition ?? "0";
        currentBtn.dataset.name = iconBtn?.dataset?.name ?? currentBtn.dataset.name ?? "Current";
        currentBtn.title = currentBtn.dataset.name;

        fly.remove();
      }

      // =========================================================
      // ANIMATION: CURRENT -> Queue (slide back + queue shifts)
      // =========================================================
      async function animateCurrentBackToQueue(currentBtn, iconsWrap) {
        if (!currentBtn?.isConnected || !iconsWrap?.isConnected) return;

        const curDiamond = currentBtn.querySelector(".oni-turnbar-diamond--current");
        const curRect = curDiamond?.getBoundingClientRect();
        if (!curRect) return;

        // Destination: prepend to first row
        const firstRow = iconsWrap.querySelector(".oni-turnbar-icons-row");
        if (!firstRow) return;

        // Capture first rects
        const iconsBefore = Array.from(firstRow.querySelectorAll(".oni-turnbar-icon"));
        const first = new Map();
        for (const el of iconsBefore) first.set(el, el.getBoundingClientRect());

        // placeholder at front to reserve space
        const placeholder = document.createElement("button");
        placeholder.type = "button";
        placeholder.className = "oni-turnbar-icon oni-phantom";
        placeholder.style.pointerEvents = "none";
        placeholder.style.opacity = "0";

        const phDiamond = document.createElement("span");
        phDiamond.className = "oni-turnbar-diamond";
        placeholder.appendChild(phDiamond);
        firstRow.prepend(placeholder);

        const dstRect = phDiamond.getBoundingClientRect();

        // Measure last after insert
        const iconsAfterInsert = Array.from(firstRow.querySelectorAll(".oni-turnbar-icon:not(.oni-phantom)"));
        const last = new Map();
        for (const el of iconsAfterInsert) last.set(el, el.getBoundingClientRect());

        // flying clone from current
        const fly = curDiamond.cloneNode(true);
        fly.classList.add("oni-turnbar-fly");
        fly.style.position = "fixed";
        fly.style.left = `${curRect.left}px`;
        fly.style.top = `${curRect.top}px`;
        fly.style.width = `${curRect.width}px`;
        fly.style.height = `${curRect.height}px`;
        fly.style.margin = "0";
        fly.style.zIndex = "1000000";
        fly.style.pointerEvents = "none";
        document.body.appendChild(fly);

        // FLIP shift existing icons
        for (const el of iconsAfterInsert) {
          const f = first.get(el);
          const l = last.get(el);
          if (!f || !l) continue;

          const dx = f.left - l.left;
          const dy = f.top - l.top;
          if (dx === 0 && dy === 0) continue;

          el.style.transform = `translate(${dx}px, ${dy}px)`;
          el.style.transition = "transform 0s";
          el.getBoundingClientRect();
          el.style.transition = `transform var(--oni-shift-ms) var(--oni-ease)`;
          el.style.transform = "translate(0px, 0px)";
        }

        // Fly current -> placeholder
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            const dx = dstRect.left - curRect.left;
            const dy = dstRect.top - curRect.top;

            fly.style.transition = `transform var(--oni-cur-slide-ms) var(--oni-ease), opacity var(--oni-cur-slide-ms) var(--oni-ease)`;
            fly.style.transform = `translate(${dx}px, ${dy}px)`;
            fly.style.opacity = "1";

            window.setTimeout(resolve, T.currentSlideMs);
          });
        });

        fly.remove();
        placeholder.remove();
      }

      // =========================================================
      // FAN SPAWN / PANEL SPAWN
      // =========================================================
      function fanSpawnAllIcons() {
        const root = state.root;
        if (!root) return;

        const icons = root.querySelectorAll(".oni-turnbar-icon");
        let i = 0;
        for (const el of icons) {
          if (el.classList.contains("oni-phantom")) continue;
          el.classList.add("oni-spawn");
          el.style.transitionDelay = `${i * T.spawnStaggerMs}ms`;
          i++;
          requestAnimationFrame(() => el.classList.remove("oni-spawn"));
        }
      }

      function spawnFadeIn() {
        const root = state.root;
        if (!root) return;
        root.classList.add("oni-turnbar-spawn");
        requestAnimationFrame(() => root.classList.remove("oni-turnbar-spawn"));
      }

      // =========================================================
      // TOOLTIP
      // =========================================================
      function showTooltip(targetEl, text) {
        const tip = state.tooltipEl;
        if (!tip) return;

        tip.textContent = text;
        const r = targetEl.getBoundingClientRect();
        tip.style.left = `${r.left + r.width / 2}px`;
        tip.style.top = `${r.bottom + T.tooltipOffsetY}px`;

        tip.style.display = "block";
        tip.classList.remove("is-out");
        tip.classList.add("is-in");
      }

      function hideTooltip() {
        const tip = state.tooltipEl;
        if (!tip) return;

        tip.classList.remove("is-in");
        tip.classList.add("is-out");

        window.setTimeout(() => {
          if (!tip.classList.contains("is-out")) return;
          tip.style.display = "none";
          tip.classList.remove("is-out");
        }, T.tooltipScaleMs);
      }

      function cleanupTooltip() {
        state.tooltipEl?.remove();
        state.tooltipEl = null;
      }

      // =========================================================
      // WEBM -> STATIC THUMB
      // =========================================================
      async function ensureStaticImageSrc(rawSrc) {
        if (!rawSrc) return rawSrc;
        if (!isWebm(rawSrc)) return rawSrc;

        if (state.thumbCache.has(rawSrc)) return state.thumbCache.get(rawSrc);
        if (state.thumbInFlight.has(rawSrc)) return state.thumbInFlight.get(rawSrc);

        const p = (async () => {
          try {
            const VH = globalThis.VideoHelper;
            if (VH?.createThumbnail) {
              const out = await VH.createThumbnail(rawSrc, { width: T.webmThumbMaxPx, height: T.webmThumbMaxPx });
              const thumb = (typeof out === "string" && out) || out?.thumb || out?.src || out?.url;
              if (thumb) {
                state.thumbCache.set(rawSrc, thumb);
                return thumb;
              }
            }
          } catch (_) {}

          try {
            const thumb = await webmToCanvasThumb(rawSrc);
            if (thumb) {
              state.thumbCache.set(rawSrc, thumb);
              return thumb;
            }
          } catch (_) {}

          state.thumbCache.set(rawSrc, rawSrc);
          return rawSrc;
        })();

        state.thumbInFlight.set(rawSrc, p);
        try {
          return await p;
        } finally {
          state.thumbInFlight.delete(rawSrc);
        }
      }

      function webmToCanvasThumb(rawSrc) {
        const timeoutMs = T.webmThumbTimeoutMs;

        return new Promise((resolve, reject) => {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.preload = "auto";
          video.crossOrigin = "anonymous";
          video.src = rawSrc;

          let done = false;
          const finish = (val) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(val);
          };
          const fail = (err) => {
            if (done) return;
            done = true;
            cleanup();
            reject(err);
          };

          const t = window.setTimeout(() => fail(new Error(`Thumbnail timeout after ${timeoutMs}ms`)), timeoutMs);

          const cleanup = () => {
            window.clearTimeout(t);
            video.pause?.();
            video.removeAttribute("src");
            video.load?.();
          };

          video.addEventListener("error", () => fail(new Error("Video load error")), { once: true });

          video.addEventListener(
            "loadeddata",
            async () => {
              try {
                const snap = async () => {
                  const w = video.videoWidth || T.webmThumbMaxPx;
                  const h = video.videoHeight || T.webmThumbMaxPx;

                  const max = T.webmThumbMaxPx;
                  let tw = w, th = h;
                  if (Math.max(w, h) > max) {
                    const scale = max / Math.max(w, h);
                    tw = Math.max(1, Math.round(w * scale));
                    th = Math.max(1, Math.round(h * scale));
                  }

                  const canvas = document.createElement("canvas");
                  canvas.width = tw;
                  canvas.height = th;
                  const ctx = canvas.getContext("2d");
                  ctx.drawImage(video, 0, 0, tw, th);
                  return canvas.toDataURL("image/png");
                };

                try {
                  const out = await snap();
                  return finish(out);
                } catch (_) {}

                const onSeeked = async () => {
                  try {
                    const out = await snap();
                    finish(out);
                  } catch (e) {
                    fail(e);
                  }
                };
                video.addEventListener("seeked", onSeeked, { once: true });

                try {
                  video.currentTime = 0.001;
                } catch (e) {
                  try {
                    const out = await snap();
                    finish(out);
                  } catch (e2) {
                    fail(e2);
                  }
                }
              } catch (e) {
                fail(e);
              }
            },
            { once: true }
          );
        });
      }

      // =========================================================
      // CSS
      // =========================================================
      function injectStyle() {
        if (document.getElementById(IDS.STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = IDS.STYLE_ID;

        style.textContent = `
          .oni-turnbar {
            position: fixed;
            z-index: 100000;
            pointer-events: auto;
            user-select: none;
            font-family: var(--font-primary, sans-serif);
            transform-origin: top left;
          }

          .oni-turnbar[data-anchor="top-left"]    { top: var(--oni-y); left: var(--oni-x); }
          .oni-turnbar[data-anchor="top-right"]   { top: var(--oni-y); right: var(--oni-x); transform-origin: top right; }
          .oni-turnbar[data-anchor="bottom-left"] { bottom: var(--oni-y); left: var(--oni-x); transform-origin: bottom left; }
          .oni-turnbar[data-anchor="bottom-right"]{ bottom: var(--oni-y); right: var(--oni-x); transform-origin: bottom right; }

          /* Panel spawn/despawn */
          .oni-turnbar.oni-turnbar-spawn { opacity: 0; transform: translateX(-10px) scale(0.98); }
          .oni-turnbar { transition: opacity var(--oni-spawn-ms) var(--oni-ease), transform var(--oni-spawn-ms) var(--oni-ease); }
          .oni-turnbar.oni-turnbar-despawn { opacity: 0; transform: translateX(-6px) scale(0.98); }

          .oni-turnbar-panel {
            background: transparent;
            border: none;
            border-radius: 12px;
            padding: var(--oni-pad);
            box-shadow: none;
            min-width: 180px;
          }

          .oni-turnbar-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            padding: 6px 8px;
            border-radius: 12px;
            background: rgba(0,0,0,var(--oni-header-bg));
            ${T.showBackdropBlur ? "backdrop-filter: blur(var(--oni-blur)); -webkit-backdrop-filter: blur(var(--oni-blur));" : ""}
            box-shadow: 0 8px 26px rgba(0,0,0,0.18);
          }
          .oni-turnbar-title {
            font-size: 12px;
            letter-spacing: 0.10em;
            opacity: var(--oni-header-text);
            flex: 1;
            white-space: nowrap;
            color: rgba(255,255,255,0.92);
            text-shadow: 0 2px 10px rgba(0,0,0,0.40);
          }
          .oni-turnbar-btn {
            width: 26px;
            height: 22px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.06);
            color: rgba(255,255,255,0.85);
            cursor: pointer;
            transition: transform 120ms ease, background 120ms ease;
          }
          .oni-turnbar-btn:hover { transform: translateY(-1px); background: rgba(255,255,255,0.10); }

          .oni-turnbar-track { display: flex; flex-direction: column; gap: var(--oni-gap); }

          .oni-turnbar-row-main {
            display: flex;
            gap: var(--oni-gap);
            align-items: flex-start;
            padding: 6px;
            border-radius: 12px;
            background: rgba(0,0,0,0.10);
            ${T.showBackdropBlur ? "backdrop-filter: blur(var(--oni-blur)); -webkit-backdrop-filter: blur(var(--oni-blur));" : ""}
          }

          .oni-turnbar-current-wrap {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            margin-right: var(--oni-current-gap);
          }

          .oni-turnbar-current-label {
            font-size: 10px;
            letter-spacing: 0.12em;
            color: rgba(255,255,255,0.82);
            text-shadow: 0 2px 10px rgba(0,0,0,0.45);
            opacity: 0.9;
          }

          .oni-turnbar-icons-wrap { display: flex; flex-direction: column; gap: var(--oni-gap); }
          .oni-turnbar-icons-row { display: flex; gap: var(--oni-gap); align-items: center; flex-wrap: nowrap; }

          .oni-turnbar-icon, .oni-turnbar-current {
            width: var(--oni-size);
            height: var(--oni-size);
            border: 0;
            padding: 0;
            margin: 0;
            background: transparent;
            cursor: pointer;
            position: relative;
            transition: transform 120ms ease;
          }
          .oni-turnbar-icon:hover, .oni-turnbar-current:hover { transform: translateY(-1px) scale(1.02); }

          /* Diamond frame */
          .oni-turnbar-diamond {
            width: var(--oni-size);
            height: var(--oni-size);
            display: block;
            position: relative;
            clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
            border: var(--oni-border) solid rgba(var(--oni-col-neutral), var(--oni-border-opacity));
            box-sizing: border-box;
            overflow: hidden;
            background: rgba(0,0,0,0.18);
            box-shadow: 0 4px 12px rgba(0,0,0,0.22);
          }

          .oni-turnbar-icon[data-disposition="-1"] .oni-turnbar-diamond,
          .oni-turnbar-current[data-disposition="-1"] .oni-turnbar-diamond { border-color: rgba(var(--oni-col-enemy), var(--oni-border-opacity)); }

          .oni-turnbar-icon[data-disposition="1"] .oni-turnbar-diamond,
          .oni-turnbar-current[data-disposition="1"] .oni-turnbar-diamond { border-color: rgba(var(--oni-col-ally), var(--oni-border-opacity)); }

          .oni-turnbar-icon:not([data-disposition="-1"]):not([data-disposition="1"]) .oni-turnbar-diamond,
          .oni-turnbar-current:not([data-disposition="-1"]):not([data-disposition="1"]) .oni-turnbar-diamond { border-color: rgba(var(--oni-col-neutral), var(--oni-border-opacity)); }

          .oni-turnbar-diamond--current {
            background: rgba(0,0,0,0.10);
            box-shadow: 0 6px 16px rgba(0,0,0,0.24);
          }

          /* Portrait: enlarge square + contain, diamond masks it */
          .oni-turnbar-img {
            position: absolute;
            left: 50%;
            top: 50%;

            width: calc((var(--oni-size) - (var(--oni-inset) * 2)) * var(--oni-overscan));
            height: calc((var(--oni-size) - (var(--oni-inset) * 2)) * var(--oni-overscan));

            object-fit: contain;

            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            background: transparent !important;

            clip-path: none;
            pointer-events: none;

            transform-origin: center center;
            transform:
              translate(
                calc(-50% + var(--oni-ix, 0px)),
                calc(-50% + var(--oni-iy, 0px))
              )
              scale(var(--oni-iscale, 1));
          }

          /* spent removal */
          .oni-turnbar-icon.is-spent {
            opacity: 0;
            transform: scale(0.70);
            transition: opacity var(--oni-remove-ms) var(--oni-ease), transform var(--oni-remove-ms) var(--oni-ease);
            pointer-events: none;
          }

          /* fan spawn */
          .oni-turnbar-icon.oni-spawn {
            opacity: 0;
            transform: translateX(var(--oni-spawn-from-x)) scale(0.96);
          }

          .oni-turnbar-icon {
            transition:
              transform 120ms ease,
              opacity var(--oni-spawn-ms) var(--oni-ease),
              transform var(--oni-spawn-ms) var(--oni-ease);
          }

          /* grant fade-in */
          .oni-turnbar-icon.oni-fadein {
            opacity: 0;
            transform: scale(0.90);
          }
          .oni-turnbar-icon {
            transition:
              transform 120ms ease,
              opacity 180ms var(--oni-ease),
              transform 180ms var(--oni-ease);
          }

          .oni-turnbar-fly { will-change: transform, opacity; }

          /* tooltip */
          .oni-turnbar-tooltip {
            position: fixed;
            z-index: 1000001;
            transform: translateX(-50%);
            padding: 6px 10px;
            border-radius: 10px;
            background: rgba(0,0,0,0.72);
            color: rgba(255,255,255,0.92);
            font-size: 12px;
            max-width: var(--oni-tip-maxw);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            box-shadow: 0 10px 30px rgba(0,0,0,0.35);
            transform-origin: top center;
            opacity: 0;
            transform: translateX(-50%) scale(0.85);
            transition: opacity var(--oni-tip-ms) var(--oni-ease), transform var(--oni-tip-ms) var(--oni-ease);
            pointer-events: none;
          }

          .oni-turnbar-tooltip.is-in { opacity: 1; transform: translateX(-50%) scale(1); }
          .oni-turnbar-tooltip.is-out { opacity: 0; transform: translateX(-50%) scale(0.85); }

          /* phantom placeholder */
          .oni-turnbar-icon.oni-phantom { background: transparent; }
        `;

        document.head.appendChild(style);
      }

      return api;
    },
  };
})();
