// ============================================================================
// Gacha System — Constants & tuning
// ----------------------------------------------------------------------------
// Single source of truth for ids, socket names, rarity presentation and the
// pull-rate / pity tuning. Nothing in here touches game state.
//
// Tuning precedence: the party (database) actor's `gacha_rate_*` props win over
// the defaults below when they parse to sane numbers, so the GM can retune from
// the sheet without a reload. See resolveRates() in gacha-state.js.
// ============================================================================

export const GACHA = {
  TAG: "[FU][Gacha]",

  MODULE_ID: "fabula-ultima-companion",
  CHANNEL: "module.fabula-ultima-companion",

  // Scene mode that arms the overlay. Registered in the Scene Config dropdown
  // by scripts/custom-ui/dungeon-configuration-ui.js — keep the two in step.
  SCENE_MODE: "gacha",

  // Flag namespace for per-banner pity, stored on the party actor:
  //   flags[MODULE_ID].gacha.pity[bannerId] = { five: n, four: n }
  FLAG_NS: "fabula-ultima-companion",
  FLAG_KEY: "gacha",

  MSG: {
    // player → GM
    WISH_REQ:      "FU_GACHA_WISH_REQ_V1",
    BUY_REQ:       "FU_GACHA_BUY_REQ_V1",
    SWAP_REQ:      "FU_GACHA_SWAP_REQ_V1",
    REDEEM_REQ:    "FU_GACHA_REDEEM_REQ_V1",
    // GM → requester (paired result, resolves a pending promise)
    WISH_RESULT:   "FU_GACHA_WISH_RESULT_V1",
    BUY_RESULT:    "FU_GACHA_BUY_RESULT_V1",
    SWAP_RESULT:   "FU_GACHA_SWAP_RESULT_V1",
    REDEEM_RESULT: "FU_GACHA_REDEEM_RESULT_V1",
    // GM → everyone (spectators included)
    REVEAL:        "FU_GACHA_REVEAL_V1",
    POOL_UPDATE:   "FU_GACHA_POOL_UPDATE_V1",
  },

  // How long a client waits on a GM round-trip before giving up.
  REQ_TIMEOUT_MS: 15_000,
};

// ── Currency ────────────────────────────────────────────────────────────────
// Hako Coupon is the pull currency; the pool is the `item_quantity` on the
// PARTY actor's copy (one document, one write per spend). Purchases MINT from
// the world template rather than drawing down Hako's shop stock — a currency
// vendor that can run out of currency is a bug waiting for a session.
export const COUPON_ITEM_UUID = "Item.pcVQKM3teguaitRy";
export const COUPON_NAME      = "Hako Coupon";
export const COUPON_FALLBACK_COST = 200; // used only if item_cost is unreadable

// Event/holiday reward, granted by the GM — NOT a pity payout. Redeemable for
// any 5-star on any banner.
export const TICKET_ITEM_UUID = "Item.hZYczwkEFHoKULAL";
export const TICKET_NAME      = "5-Star Exchange Ticket";

// ── Roll tables ─────────────────────────────────────────────────────────────
// Every RollTable in BANNER_FOLDER_ID is a banner except the two shared pools.
export const BANNER_FOLDER_ID = "QGWhvmRAHt4ibvnG";
export const POOL_TABLE_IDS = {
  three: "EncLgNNVpyYXgduL", // "3 Star"
  four:  "oI62OUmrfNFLBuok", // "4 Star"
};

// ── Rarity presentation ─────────────────────────────────────────────────────
// Colours carried over from the v2.7 macro so the reveal reads identically.
export const RARITY = {
  three: { key: "three", stars: 3, color: "#3C6FF0", label: "3★" },
  four:  { key: "four",  stars: 4, color: "#A335FF", label: "4★" },
  five:  { key: "five",  stars: 5, color: "#e6a015", label: "5★" },
};

export const RARITY_ORDER = ["three", "four", "five"];

/** Highest rarity present in a batch — drives the single shared streak colour. */
export function bestRarity(keys) {
  let best = "three";
  for (const k of keys) {
    if (RARITY_ORDER.indexOf(k) > RARITY_ORDER.indexOf(best)) best = k;
  }
  return best;
}

// ── Tuning ──────────────────────────────────────────────────────────────────
export const DEFAULT_RATES = { five: 3, four: 12, three: 85 }; // percent

// 5-star hard pity. At 3% the expected pull count is ~20, so 30 is a ceiling
// that fires for roughly 40% of 5-stars rather than being the usual source.
export const PITY_FIVE = 30;

// 4-star floor — backs the "every 10 wishes guarantees a 4-star or better"
// promise on the banner card. Without it a x10 is all-3-star ~20% of the time.
export const PITY_FOUR = 10;

// Valid pull sizes. x10 is one animation with ten stars, never ten animations.
export const PULL_SIZES = [1, 10];

// ── Animation timing ────────────────────────────────────────────────────────
// The warm + hold beat is ported from the v2.7 macro (8 x 120ms lerp, then a
// 400ms hold). That cadence is what makes the anticipation land, so it is kept
// exactly — only the delivery changed, from N chat-document writes to one CSS
// keyframe. Durations are milliseconds.
export const FX = {
  DARKEN:      250,
  STREAK:      900,
  WARM:        960, // 8 x 120ms
  HOLD:        400,
  BURST:       300,
  REVEAL_STEP:  70, // per-card stagger in the x10 grid
  STAR_STAGGER: 55, // per-star stagger in the streak
  // Hard ceiling for any animationend wait. A hidden tab never fires the event,
  // so every phase races the listener against this timer.
  PHASE_FALLBACK: 4000,
};

export const log  = (...a) => console.log(GACHA.TAG, ...a);
export const warn = (...a) => console.warn(GACHA.TAG, ...a);
