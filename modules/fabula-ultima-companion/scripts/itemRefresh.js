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

  async function refreshOne(item) {
    if (!item) return { ok: false, reason: "no_item" };
    const ts = item.templateSystem;
    if (!ts) return { ok: false, reason: "no_template_system" };
    const tplId = item.system?.template;
    if (!tplId) return { ok: false, reason: "no_template_id" };
    const tpl = game.items?.get(tplId);
    if (!tpl) return { ok: false, reason: "template_missing", tplId };
    try {
      await ts.reloadTemplate();
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
                <p style="color:#666;font-size:12px;margin-top:.4rem;">Existing prop values (quantity, equipped, etc.) are preserved. Props newly added to the template get default values; props removed from the template are cleared.</p>`,
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
    const tplId = item.system?.template;
    if (!tplId) {
      ui.notifications?.warn(`${item.name}: no template assigned.`);
      return;
    }
    const tplName = game.items?.get(tplId)?.name ?? tplId;
    const ok = await Dialog.confirm({
      title: "Refresh Item",
      content: `<p>Refresh <b>${item.name}</b> from template <b>${tplName}</b>?</p>
                <p style="color:#666;font-size:12px;margin-top:.4rem;">Existing prop values (quantity, equipped, etc.) are preserved.</p>`,
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

  console.log(TAG, "ready");
})();
