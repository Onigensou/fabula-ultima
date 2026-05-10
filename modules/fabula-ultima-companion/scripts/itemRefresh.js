// scripts/itemRefresh.js — Foundry VTT v12 (CSB)
// Refresh owned CSB items from their world-Item template.
// - Header button on character actor sheets (owner/GM only)
// - Right-click "Refresh from Template" on owned-item content links
//
// Behavior:
// - Calls item.templateSystem.reloadTemplate(), which preserves existing prop
//   values (item_quantity, equipped, etc.), fills in props newly added to the
//   template, and removes props the template no longer defines.
//
// Public API:
//   FUCompanion.api.itemRefresh.refreshOne(item)
//   FUCompanion.api.itemRefresh.refreshAll(actor)
//   FUCompanion.api.itemRefresh.confirmAndRefreshOne(item)
//   FUCompanion.api.itemRefresh.confirmAndRefreshAll(actor)

(() => {
  const TAG = "[fu-itemRefresh]";

  function isCsbActor(actor) {
    return !!actor && actor.documentName === "Actor"
      && (actor.type === "character" || actor.type === "_template");
  }

  function userCanRefresh(actor) {
    return !!(game.user?.isGM || actor?.isOwner);
  }

  // Dynamic-table-style components: their authored content lives on the
  // component definition itself (`predefinedLines` in the body JSON), NOT in
  // `template.system.props`. CSB's render-time `_synchronizePredefinedLines`
  // only adds new lines and merges existing ones — it never overwrites a
  // row's data with the template's newer values, so authored edits like
  // changed cell content or removed rows would otherwise stay stale on the
  // player's copy.
  const PREDEFINED_LINE_TYPES = new Set([
    "dynamicTable",
    "compactDynamicTable" // FU companion extension; same storage as dynamicTable
  ]);

  // Components whose data DOES live in `template.system.props[key]` and
  // should be copied verbatim from there. Item-container rows (lists of
  // referenced items) sit here.
  const TPL_PROP_TYPES = new Set([
    "itemContainer"
  ]);

  // Plain scalar prop keys that are template-authored even though the
  // component is a textArea/textField/etc. CSB preserves player-edited
  // scalars by default, which would strand older script content on the
  // copy. Refresh forces these to follow the template. Add keys as the
  // skill template grows.
  const TEMPLATE_OWNED_KEYS = new Set([
    "custom_logic_action",
    "custom_logic_resolution"
  ]);

  function buildPredefinedRows(predefinedLines) {
    // Materialize predefinedLines (array on body component) into the row-dict
    // shape CSB stores in entity.system.props[tableKey] — numeric string keys
    // mapping to row objects. Each line carries its own $predefinedIdx so
    // CSB's later sync logic can match rows back to their template source.
    const rows = {};
    let idx = 0;
    for (const line of predefinedLines) {
      if (!line || line.$deleted) continue;
      rows[String(idx++)] = foundry.utils.deepClone(line);
    }
    return rows;
  }

  async function applyTemplateOwnedOverwrites(item, tpl) {
    // Use the instantiated component tree rather than walking raw JSON: it
    // gives us reliable type names via constructor.getTechnicalName() and
    // exposes `predefinedLines` / `defaultValue` directly on the instance.
    try { tpl.templateSystem?.prepareData?.(); } catch (e) { /* non-fatal */ }
    const ts = tpl.templateSystem;
    const componentMap = {
      ...(ts?.customHeader?.getComponentMap?.() ?? {}),
      ...(ts?.customBody?.getComponentMap?.() ?? {})
    };

    const tplProps = tpl.system?.props ?? {};
    const overwrites = {};

    for (const [key, comp] of Object.entries(componentMap)) {
      if (!key) continue;
      const techName = comp?.constructor?.getTechnicalName?.();

      if (PREDEFINED_LINE_TYPES.has(techName)) {
        // Two valid authoring patterns for table rows on the master skill:
        //   a) Opened in applied mode, "+ Add row" → rows live in
        //      tpl.system.props[key] as {rowIdx: rowObj}.
        //   b) Opened in builder mode (or template type) → rows live as
        //      `predefinedLines` on the component definition.
        // Prefer (a) when present and non-empty, since it represents the
        // actual authored data on this specific skill.
        const fromProps = tplProps[key];
        const propsHasRows = fromProps && typeof fromProps === "object"
          && !Array.isArray(fromProps) && Object.keys(fromProps).length > 0;
        if (propsHasRows) {
          overwrites[key] = foundry.utils.deepClone(fromProps);
          continue;
        }
        const lines = (Array.isArray(comp?.predefinedLines) ? comp.predefinedLines : [])
          .filter((l) => l && !l.$deleted);
        if (lines.length) {
          overwrites[key] = buildPredefinedRows(lines);
        }
        // Both sources empty → leave the copy alone, don't wipe its rows.
        continue;
      }

      if (TPL_PROP_TYPES.has(techName)) {
        if (tplProps[key] !== undefined) {
          overwrites[key] = foundry.utils.deepClone(tplProps[key]);
        }
        continue;
      }
    }

    // Allowlist scalars (textArea / textField / etc. that are
    // template-authored rather than player-edited).
    for (const key of TEMPLATE_OWNED_KEYS) {
      if (overwrites[key] !== undefined) continue;
      const fromProps = tplProps[key];
      if (fromProps !== undefined && fromProps !== null && fromProps !== "") {
        overwrites[key] = foundry.utils.deepClone(fromProps);
        continue;
      }
      // Fallback: textArea/textField components carry a `defaultValue` on
      // the body component itself — that's where a script lives if the
      // template was authored in builder mode.
      const dv = componentMap[key]?.defaultValue;
      if (typeof dv === "string" && dv.length) {
        overwrites[key] = dv;
      }
    }

    if (!Object.keys(overwrites).length) return;

    // Phase-1 deletes run in their own update before phase-2 writes.
    // Without this, Foundry's mergeObject merges numeric-keyed row
    // sub-objects instead of replacing them, leaving stale rows behind.
    const deletes = {};
    const sets = {};
    for (const [k, v] of Object.entries(overwrites)) {
      deletes[`-=${k}`] = null;
      sets[k] = v;
    }
    await item.update({ system: { props: deletes } });
    await item.update({ system: { props: sets } });
  }

  // FU companion convention:
  //   system.template = structural definition (e.g. "_Skill Template",
  //                     an _equippableItemTemplate)
  //   system.uniqueId = content master for this specific skill (e.g. the
  //                     world's authored "Protect", an equippableItem)
  // Refresh pulls structure (body/header/prop schema) from the structural
  // template via CSB's reloadTemplate, then pulls authored content (table
  // rows, scripts, active effects) from the per-skill master via custom
  // sync logic. system.template is left untouched — pointing it at the
  // master would trigger CSB's "Item template has been deleted" warning,
  // since CSB only accepts _equippableItemTemplate as a valid template.
  function resolveRefreshSources(item) {
    const tplId = item.system?.template;
    if (!tplId) return null;
    const tpl = game.items?.get(tplId);
    if (!tpl) return null;

    let contentSource = tpl;
    const masterId = item.system?.uniqueId;
    if (masterId) {
      const master = game.items?.get(masterId);
      if (master && master.id !== item.id) contentSource = master;
    }
    return { tpl, tplId, contentSource };
  }

  // Mirror of CSB's reloadTemplate effect-sync block (TemplateSystem.js
  // ~702-732), but sourced from `source` instead of system.template's
  // entity. Effects on `source` carry an originalUuid flag set when they
  // were first created (CustomActiveEffect._onCreateOperation); copies
  // previously synced from `source` carry that same originalUuid, plus
  // an originalParentId === source.id so we can identify them for delete.
  async function syncTemplateEffects(item, source) {
    if (!source?.effects?.size) {
      // No effects on source: only delete copies that originated from
      // this source but were since removed. (No-op if there are none.)
    }
    const sysId = game.system.id;
    const effectsToCreate = [];
    const effectsToUpdate = [];
    const effectsToDelete = [];

    const existingByOriginal = new Map();
    for (const e of item.effects) {
      const orig = e.getFlag(sysId, "originalUuid");
      if (orig) existingByOriginal.set(orig, e);
    }

    for (const effect of source.effects) {
      const matched = existingByOriginal.get(effect.uuid);
      if (matched) {
        effectsToUpdate.push({ ...effect.toJSON(), _id: matched.id });
      } else {
        effectsToCreate.push(effect.toJSON());
      }
    }

    for (const e of item.effects) {
      const originalParentId = e.getFlag(sysId, "originalParentId");
      if (originalParentId !== source.id) continue;
      const originalId = e.getFlag(sysId, "originalId");
      const stillExists = Array.from(source.effects).some(
        (se) => se.getFlag(sysId, "originalId") === originalId
      );
      if (!stillExists) effectsToDelete.push(e.id);
    }

    await Promise.allSettled([
      effectsToUpdate.length ? item.updateEmbeddedDocuments("ActiveEffect", effectsToUpdate) : null,
      effectsToCreate.length ? item.createEmbeddedDocuments("ActiveEffect", effectsToCreate) : null,
      effectsToDelete.length ? item.deleteEmbeddedDocuments("ActiveEffect", effectsToDelete) : null
    ].filter(Boolean));
  }

  async function refreshOne(item) {
    if (!item) return { ok: false, reason: "no_item" };
    const ts = item.templateSystem;
    if (!ts) return { ok: false, reason: "no_template_system" };
    const sources = resolveRefreshSources(item);
    if (!sources) return { ok: false, reason: "no_template_id" };
    const { tpl, contentSource } = sources;
    try {
      // Structure: body/header/prop-schema/display from _Skill Template.
      // CSB also syncs effects from this template (typically none on the
      // structural template itself).
      await ts.reloadTemplate();
      // Content: table rows, scripts, active effects from the per-skill
      // master. Skipped if there's no separate master (uniqueId absent).
      if (contentSource !== tpl) {
        await syncTemplateEffects(item, contentSource);
      }
      await applyTemplateOwnedOverwrites(item, contentSource);
      return { ok: true };
    } catch (e) {
      console.warn(TAG, "reloadTemplate failed for", item.uuid, e);
      return { ok: false, reason: "exception", error: e };
    }
  }

  async function refreshAll(actor) {
    if (!actor?.items) return { total: 0, refreshed: 0, skipped: 0, failed: 0, failures: [] };
    const items = Array.from(actor.items);
    let refreshed = 0, skipped = 0, failed = 0;
    const failures = [];
    for (const item of items) {
      const res = await refreshOne(item);
      if (res.ok) refreshed++;
      else if (res.reason === "no_template_id" || res.reason === "no_template_system") skipped++;
      else { failed++; failures.push({ name: item.name, uuid: item.uuid, reason: res.reason }); }
    }
    return { total: items.length, refreshed, skipped, failed, failures };
  }

  async function confirmAndRefreshAll(actor) {
    if (!isCsbActor(actor)) {
      ui.notifications?.warn("Refresh Items: not a CSB actor.");
      return;
    }
    if (!userCanRefresh(actor)) {
      ui.notifications?.warn("Refresh Items: you don't own this actor.");
      return;
    }
    const items = Array.from(actor.items).filter(i => i?.system?.template);
    if (!items.length) {
      ui.notifications?.info(`${actor.name}: no template-based items to refresh.`);
      return;
    }
    const ok = await Dialog.confirm({
      title: "Refresh Owned Items",
      content: `<p>Refresh <b>${items.length}</b> item${items.length === 1 ? "" : "s"} on <b>${actor.name}</b> from their world templates?</p>
                <p style="color:#666;font-size:12px;margin-top:.4rem;">Player-edited fields (name, quantity, equipped, etc.) are preserved. Dynamic tables and item-container lists are replaced with the template's contents. Props newly added to the template get default values; props removed from the template are cleared.</p>`,
      defaultYes: false
    });
    if (!ok) return;

    const res = await refreshAll(actor);
    let msg = `${actor.name}: refreshed ${res.refreshed} of ${res.total}`;
    if (res.skipped) msg += ` (skipped ${res.skipped} without templates)`;
    if (res.failed) msg += ` — ${res.failed} failed`;
    if (res.failed) ui.notifications?.warn(msg);
    else ui.notifications?.info(msg);
    if (res.failures?.length) console.warn(TAG, "Failures:", res.failures);
  }

  async function confirmAndRefreshOne(item) {
    if (!item) return;
    if (!userCanRefresh(item.actor)) {
      ui.notifications?.warn("Refresh Item: you don't own this item.");
      return;
    }
    const sources = resolveRefreshSources(item);
    if (!sources) {
      ui.notifications?.warn(`${item.name}: no template assigned.`);
      return;
    }
    const tplName = sources.contentSource?.name ?? sources.tpl.name ?? sources.tplId;
    const ok = await Dialog.confirm({
      title: "Refresh Item",
      content: `<p>Refresh <b>${item.name}</b> from <b>${tplName}</b>?</p>
                <p style="color:#666;font-size:12px;margin-top:.4rem;">Player-edited fields (name, quantity, equipped, etc.) are preserved. Dynamic tables and item-container lists are replaced with the template's contents.</p>`,
      defaultYes: false
    });
    if (!ok) return;
    const res = await refreshOne(item);
    if (res.ok) ui.notifications?.info(`Refreshed: ${item.name}`);
    else ui.notifications?.warn(`Could not refresh ${item.name}: ${res.reason}`);
  }

  // ---------------- Public API ----------------
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.itemRefresh = {
    refreshOne,
    refreshAll,
    confirmAndRefreshOne,
    confirmAndRefreshAll
  };

  // ---------------- v1 ActorSheet header button ----------------
  Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
    const actor = sheet?.actor;
    if (!isCsbActor(actor) || !userCanRefresh(actor)) return;
    buttons.unshift({
      label: "Refresh Items",
      class: "fu-refresh-items",
      icon: "fa-solid fa-arrows-rotate",
      onclick: () => confirmAndRefreshAll(actor)
    });
  });

  // ---------------- v2 ActorSheet header button (DOM injection) ----------------
  function injectHeaderButtonV2(rootEl, actor) {
    if (!rootEl || !isCsbActor(actor) || !userCanRefresh(actor)) return;
    if (rootEl.querySelector(".fu-refresh-items")) return;
    const headerBar = rootEl.querySelector(".window-header");
    if (!headerBar) return;
    const closeBtn = headerBar.querySelector('button[data-action="close"]');
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "header-control fa-solid fa-arrows-rotate fu-refresh-items";
    btn.dataset.tooltip = "Refresh items from world templates";
    btn.setAttribute("aria-label", "Refresh items from world templates");
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      confirmAndRefreshAll(actor);
    });
    if (closeBtn) headerBar.insertBefore(btn, closeBtn);
    else headerBar.appendChild(btn);
  }

  Hooks.on("renderActorSheetV2", (sheet, html) => {
    const el = (html instanceof HTMLElement) ? html : html?.[0];
    const root = el?.closest?.(".window-app") || el;
    injectHeaderButtonV2(root, sheet?.actor || sheet?.document);
  });

  // ---------------- Per-item context menu ("Refresh from Template") ----------------
  // CSB renders owned-item references as <a class="content-link" data-uuid="Actor.<id>.Item.<id>">.
  function bindItemContext(htmlOrEl) {
    const root = (htmlOrEl instanceof HTMLElement) ? htmlOrEl : (htmlOrEl?.[0] ?? null);
    if (!root) return;
    try {
      new ContextMenu($(root), "a.content-link[data-uuid*='.Item.']", [
        {
          name: "Refresh from Template",
          icon: '<i class="fa-solid fa-arrows-rotate fu-refresh-ctx-icon"></i>',
          condition: (li) => {
            const uuid = li[0]?.dataset?.uuid || "";
            // Only owned items: uuid contains Actor.<id>.Item.<id>
            return /Actor\.[^.]+\.Item\./.test(uuid);
          },
          callback: async (li) => {
            const uuid = li[0]?.dataset?.uuid;
            const item = await fromUuid(uuid).catch(() => null);
            if (!item) {
              ui.notifications?.warn("Refresh Item: could not resolve item.");
              return;
            }
            await confirmAndRefreshOne(item);
          }
        }
      ]);
    } catch (e) {
      console.warn(TAG, "Could not bind item ContextMenu:", e);
    }
  }

  Hooks.on("renderActorSheet",   (_sheet, html) => bindItemContext(html));
  Hooks.on("renderActorSheetV2", (_sheet, html) => bindItemContext(html));

  // ---------------- One-time style: keep our context-menu label readable ----------------
  function installStyles() {
    if (document.getElementById("fu-item-refresh-styles")) return;
    const style = document.createElement("style");
    style.id = "fu-item-refresh-styles";
    style.textContent = `
      /* Widen any Foundry ContextMenu that contains our refresh entry,
         without affecting unrelated context menus. Marker is on the icon. */
      #context-menu:has(.fu-refresh-ctx-icon),
      .context-menu:has(.fu-refresh-ctx-icon) {
        min-width: 260px;
      }
      #context-menu:has(.fu-refresh-ctx-icon) .context-item,
      .context-menu:has(.fu-refresh-ctx-icon) .context-item {
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }
  if (document.head) installStyles();
  else Hooks.once("ready", installStyles);

  console.debug(TAG, "ready");
})();
