// ============================================================================
// Gacha System — UI sound
// ----------------------------------------------------------------------------
// The gacha screen is a shop by another name, so it borrows the shop's cue set
// rather than inventing one. This is a thin naming layer over
// window.FUCompanion.shopSound (shop-system/shopSound-manager.js) — the assets
// and volumes stay defined in exactly one place, and that manager already
// preloads them on ready, so the first click of a session has no hitch.
//
// Mapping, matching how the shop itself uses them:
//
//   open    Shop_Open          a window arrives
//   close   BattleCursor_2     a window is dismissed or a prompt declined
//   tab     BattleCursor_1     switching between pages within a window
//   select  BattleCursor_4     picking a row or an item
//   commit  UI_SEWorldDollar   a transaction actually completed
//
// `scroll` is the one cue with no shop equivalent — the banner rail is not a
// shop interaction — so it is played directly.
//
// All of it is LOCAL only. Shop feedback has no business on other clients'
// speakers, and neither does this.
// ============================================================================

const mgr = () => window.FUCompanion?.shopSound ?? null;

// Banner rail movement. Deliberately a different blip from `tab` so browsing
// banners does not sound like changing pages inside a panel.
const SCROLL_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_3.wav";

export const sfx = {
  open()   { try { mgr()?.playShopOpen?.();   } catch {} },
  close()  { try { mgr()?.playCancel?.();     } catch {} },
  tab()    { try { mgr()?.playTabSwitch?.();  } catch {} },
  select() { try { mgr()?.playItemSelect?.(); } catch {} },
  commit() { try { mgr()?.playPurchase?.();   } catch {} },
  scroll() {
    try { AudioHelper?.play({ src: SCROLL_SRC, volume: 0.5, loop: false }, false); } catch {}
  },
};
