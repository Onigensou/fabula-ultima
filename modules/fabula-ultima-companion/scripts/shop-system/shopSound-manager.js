// scripts/shop-system/shopSound-manager.js
//
// Centralized sound effects for the shop system.
// All sounds are local-only (AudioHelper push=false) — shop UI feedback
// should never broadcast to other clients.

const SOUNDS = {
  purchase: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/UI_SEWorldDollar.wav",
};

const VOLUME = {
  purchase: 0.75,
};

export class ShopSoundManager {

  // Called on successful item purchase.
  playPurchase() {
    this._play(SOUNDS.purchase, VOLUME.purchase);
  }

  _play(src, volume = 0.7) {
    if (!src) return;
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch (e) {
      console.warn("[ShopSound] AudioHelper.play failed:", e);
    }
  }
}
