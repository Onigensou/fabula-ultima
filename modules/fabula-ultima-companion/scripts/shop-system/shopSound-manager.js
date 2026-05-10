// scripts/shop-system/shopSound-manager.js
//
// Centralized sound effects for the shop system.
// All sounds are local-only (AudioHelper push=false) — shop UI feedback
// should never broadcast to other clients.
//
// Call preloadAll() once on ready so CDN assets are cached before first use.

const SOUNDS = {
  shopOpen:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Shop_Open.wav",
  purchase:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/UI_SEWorldDollar.wav",
  tabSwitch:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
  itemSelect: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
  cancel:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
};

const VOLUME = {
  shopOpen:   0.65,
  purchase:   0.75,
  tabSwitch:  0.55,
  itemSelect: 0.45,
  cancel:     0.55,
};

export class ShopSoundManager {

  // Preload all shop sounds from CDN so first-use latency is eliminated.
  // Fire-and-forget — called once from bootstrap on the ready hook.
  preloadAll() {
    for (const src of Object.values(SOUNDS)) {
      try {
        if (typeof AudioHelper?.preloadSound === "function") {
          AudioHelper.preloadSound(src);
        } else {
          // Fallback: warm the browser HTTP cache silently
          fetch(src, { cache: "force-cache" }).catch(() => {});
        }
      } catch (_) {}
    }
  }

  // Called when the buy window first opens (buy window only).
  playShopOpen()   { this._play(SOUNDS.shopOpen,   VOLUME.shopOpen);   }

  // Called on successful item purchase.
  playPurchase()   { this._play(SOUNDS.purchase,   VOLUME.purchase);   }

  // Called when the player switches category tabs.
  playTabSwitch()  { this._play(SOUNDS.tabSwitch,  VOLUME.tabSwitch);  }

  // Called when the player clicks / highlights an item row.
  playItemSelect() { this._play(SOUNDS.itemSelect, VOLUME.itemSelect); }

  // Called when the player closes the shop (Leave Shop button or X).
  playCancel()     { this._play(SOUNDS.cancel,     VOLUME.cancel);     }

  _play(src, volume = 0.6) {
    if (!src) return;
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch (e) {
      console.warn("[ShopSound] AudioHelper.play failed:", e);
    }
  }
}
