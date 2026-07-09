// ============================================================================
// Clock System — the finality beat + chat card.
//
// When a clock lands on a claimed pole the panel flares, the gear turns, and
// the fill takes the winning side's colour. The bar then holds for five seconds
// before sliding out — long enough for the table to read what just happened.
//
// The flourish is local (every client renders its own, driven by the diffed
// `fu-clock-resolved` hook). The chat card is written ONCE, by the active GM —
// otherwise a six-client table gets six identical cards.
//
// The card carries no speaker: a clock is not a creature. Foundry stamps a
// sender header + portrait on every message, so the card's own class hides it
// (see the `:has(.oni-clock-card)` rule in clock-ui-styles.js) and the message
// becomes just the coloured block.
// ============================================================================

import { CLOCK_TAG, OUTCOME, POLE } from "./clock-const.js";
import { playClockSfx } from "./clock-ui-styles.js";
import { isActiveGM } from "./clock-store.js";

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const TONE = Object.freeze({
  success: "#3f9fd6",
  failure: "#cf4034",
});

const CARD_STYLE_ID = "oni-clock-card-styles";

/**
 * The card's own stylesheet. Deliberately NOT part of the bar's: a card is
 * posted even when the bar is switched off (and even when no clock is on
 * screen), and the bar only injects its CSS when it builds its layer. Keeping
 * the card's styles here means it can never render naked.
 */
function injectCardStyles() {
  if (document.getElementById(CARD_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = CARD_STYLE_ID;
  s.textContent = `
/* Foundry stamps a sender header + portrait on every message. A clock has no
   speaker, so hide it — the card is the whole message. Beats core's
   \`.flexrow { display: flex }\` on specificity. */
.message:has(.oni-clock-card) .message-header { display: none; }
.message:has(.oni-clock-card) .message-content { margin: 0; }

.oni-clock-card {
  border-left: 4px solid var(--tone, #8d5f38);
  padding: 5px 9px;
  line-height: 1.35;
}
.oni-clock-card .ck-verdict {
  font-weight: 700; letter-spacing: .4px; color: var(--tone, #8d5f38);
}
.oni-clock-card .ck-line { opacity: .88; font-size: 12px; }
`;
  document.head.appendChild(s);
}

/** The banner text: the pole's own label, else a sensible default. */
function bannerFor(clock, resolution) {
  const pole = clock.poles[resolution.pole];
  if (pole?.label) return pole.label;
  return resolution.outcome === OUTCOME.SUCCESS ? "Success" : "Failure";
}

/**
 * The finality beat. Purely visual — the registry already says `resolved`. The
 * five-second hold lives in the bar's RESOLVED handler, not here.
 */
export function playResolution(entry, clock, resolution) {
  const { root } = entry;
  if (!root?.isConnected) return;

  const success = resolution.outcome === OUTCOME.SUCCESS;
  root.classList.add("resolved", success ? "resolved-success" : "resolved-failure");

  playClockSfx(success ? "SUCCESS" : "FAILURE");
}

/**
 * Post the resolution to chat. Active GM only, so the table sees exactly one
 * card. Fire-and-forget: a chat failure must never stall the bar.
 */
export async function postResolutionCard(clock, resolution) {
  if (!isActiveGM()) return;

  const success = resolution.outcome === OUTCOME.SUCCESS;
  const tone = success ? TONE.success : TONE.failure;
  const verdict = bannerFor(clock, resolution);
  const filled = resolution.pole === POLE.HIGH ? "filled" : "emptied";
  const forWhom = success ? "Success" : "Failure";

  const content = `<div class="oni-clock-card" style="--tone:${tone}">`
    + `<div class="ck-verdict">${esc(verdict)}</div>`
    + `<div class="ck-line"><b>${esc(clock.name)}</b> ${filled} — ${forWhom} for the party.</div>`
    + `</div>`;

  try {
    // No speaker: a clock has no voice, and the header is hidden by CSS.
    await ChatMessage.create({ content, speaker: {} });
  } catch (e) {
    console.warn(CLOCK_TAG, "resolution chat card failed", e);
  }
}

/** Subscribe the chat card to resolutions. Called once, from the bar's bootstrap. */
export function wireResolutionChat() {
  injectCardStyles();
  Hooks.on("fu-clock-resolved", ({ clock, resolution }) => {
    postResolutionCard(clock, resolution).catch(() => {});
  });
}
