// scripts/shop-open/shopopen-bootstrap.js
import { ShopOpenBackend }     from "./shopopen-backend.js";
import { ShopOpenUI }          from "./shopopen-ui.js";
import { SHOPOPEN }            from "./shopopen-const.js";
import { ShopPurchaseHandler } from "./shopPurchase-handler.js";
import { ShopSoundManager }    from "./shopSound-manager.js";

Hooks.once("ready", async () => {
  const ui = new ShopOpenUI({
    DEBUG:        false,
    LAYER_Z_INDEX: 90,
    ICON_OFFSET_Y: 56,
  });

  const backend = new ShopOpenBackend({
    DEBUG:             true,
    RANGE_PX:          140,
    FORCE_CLOSE_TO_NONE: true,
  });

  const purchaseHandler = new ShopPurchaseHandler();
  const soundManager    = new ShopSoundManager();

  // Wire purchase handler into backend (BUY_REQ/BUY_RESULT route through backend._onSocket)
  backend._purchaseHandler = purchaseHandler;

  // Backend -> UI
  backend.uiSetDesiredVisible = (set) => ui.setDesiredVisible(set);

  // UI -> Backend
  ui.onClickShopToken = (tokenId) => backend.openShopByTokenId(tokenId);

  // Reposition on pan/zoom/resize
  Hooks.on("canvasPan",  () => ui.repositionAll());
  Hooks.on("canvasReady",() => ui.repositionAll());
  window.addEventListener("resize", () => ui.repositionAll());

  await backend.start();

  // ── Ensure [ItemPurchase] Manager macro exists (GM use from NPC sheet) ──
  if (game.user.isGM) {
    await _ensureShopMacro();
  }

  // Expose debug/API surface
  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.shopOpen = {
    version: "v2-player-shop",
    backend,
    ui,
    purchaseHandler,
    start: () => backend.start(),
    stop: async () => { await backend.stop(); ui.destroy(); },
    const: SHOPOPEN,
  };
  // Shorthands used by ShopWindowApp
  window.FUCompanion.shopPurchase = purchaseHandler;
  window.FUCompanion.shopSound    = soundManager;

  console.log(SHOPOPEN.TAG, "Module bootstrap loaded (ShopOpen v2 — player self-service).");
});

// ──────────────────────────────────────────────────────────────────────────────
// [ItemPurchase] Manager macro (GM tool: buy an item from the NPC sheet
//   for a specific player character without needing ShopWindowApp)
// ──────────────────────────────────────────────────────────────────────────────

async function _ensureShopMacro() {
  const MACRO_NAME = "[ItemPurchase] Manager";
  if (game.macros.getName(MACRO_NAME)) return; // already exists, don't overwrite

  const command = `
// [ItemPurchase] Manager — called by shop NPC sheet buy buttons
// args: { shopActorId, itemUuid }
const { shopActorId, itemUuid } = args ?? {};

const shopActor = game.actors.get(shopActorId);
if (!shopActor) { ui.notifications.error("Shop actor not found."); return; }

const item = shopActor.items.find(i => i.uuid === itemUuid)
  ?? shopActor.items.get(itemUuid.split(".Item.").at(-1));
if (!item) { ui.notifications.error("Item not found in shop."); return; }

const itemName  = item.name;
const itemCost  = Number(item.system?.props?.item_cost  ?? 0);
const itemStock = Number(item.system?.props?.item_quantity ?? 0);

if (itemStock <= 0) { ui.notifications.warn("This item is out of stock."); return; }

// Build buyer options from active non-GM players with a linked character
const options = game.users
  .filter(u => !u.isGM && u.active && u.character)
  .map(u => {
    const zenit = Number(u.character.system?.props?.zenit ?? 0);
    return \`<option value="\${u.character.uuid}">\${u.character.name} (\${u.name}) — 🪙 \${zenit.toLocaleString()}</option>\`;
  });

if (!options.length) { ui.notifications.warn("No active player characters online."); return; }

const buyerUuid = await new Promise(resolve => {
  new Dialog({
    title: "Purchase Item",
    content: \`
      <p>Buy <strong>\${itemName}</strong> (🪙 \${itemCost > 0 ? itemCost.toLocaleString() : "Free"}) for:</p>
      <select id="fu-shop-buyer" style="width:100%">\${options.join("")}</select>
    \`,
    buttons: {
      buy: {
        label: "Buy",
        callback: html => resolve(html.find("#fu-shop-buyer").val())
      },
      cancel: { label: "Cancel", callback: () => resolve(null) }
    },
    default: "buy",
    close: () => resolve(null)
  }).render(true);
});

if (!buyerUuid) return;

const tc = window["oni.ItemTransferCore"];
if (!tc) { ui.notifications.error("Item transfer system not ready."); return; }

const buyerActor = await fromUuid(buyerUuid);
if (!buyerActor) { ui.notifications.error("Buyer actor not found."); return; }

const buyerZenit = Number(buyerActor.system?.props?.zenit ?? 0);
if (itemCost > 0 && buyerZenit < itemCost) {
  ui.notifications.error(\`\${buyerActor.name} can't afford this — need 🪙 \${itemCost.toLocaleString()}, have 🪙 \${buyerZenit.toLocaleString()}.\`);
  return;
}

const result = await tc.transfer({
  mode: "actorToActor",
  itemUuid: item.uuid,
  quantity: 1,
  senderActorUuid: shopActor.uuid,
  receiverActorUuid: buyerUuid,
  requestedByUserId: game.user.id,
  showTransferCard: true
});

if (!result.ok) { ui.notifications.error("Transfer failed — check the console."); return; }

if (itemCost > 0) {
  await tc.adjustZenit({ actorUuid: buyerUuid,     delta: -itemCost });
  await tc.adjustZenit({ actorUuid: shopActor.uuid, delta:  itemCost });
}

ui.notifications.info(\`Purchased \${itemName} for \${buyerActor.name}.\`);
`.trim();

  try {
    await Macro.create({
      name:    MACRO_NAME,
      type:    "script",
      scope:   "global",
      command,
      img:     "icons/svg/bag.svg",
    });
    console.log(SHOPOPEN.TAG, `Created macro: "${MACRO_NAME}"`);
  } catch (e) {
    console.warn(SHOPOPEN.TAG, `Could not create macro "${MACRO_NAME}":`, e);
  }
}
