// ============================================================================
// Clock System — resolution flourish + chat card.
//
// When a clock lands on a claimed pole the bar flashes in the winning side's
// colour, the pole's label takes over the gauge, and a chat card records what
// happened. Then the clock leaves the screen.
//
// The flourish is local (every client renders its own, driven by the diffed
// `fu-clock-resolved` hook). The chat card is written ONCE, by the active GM —
// otherwise a six-client table gets six identical cards.
// ============================================================================

import { CLOCK_TAG, OUTCOME, POLE } from "./clock-const.js";
import { playClockSfx } from "./clock-ui-styles.js";
import { isActiveGM } from "./clock-store.js";

/** How long a resolved clock stays on screen before it fades out. */
export const RESOLVE_HOLD_MS = 2600;

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The banner text: the pole's own label, else a sensible default. */
function bannerFor(clock, resolution) {
  const pole = clock.poles[resolution.pole];
  if (pole?.label) return pole.label;
  return resolution.outcome === OUTCOME.SUCCESS ? "Success" : "Failure";
}

/**
 * Flash the gauge, drop a banner under it, and dim the clock into its resolved
 * state. Purely visual — the registry already says `resolved`.
 */
export function playResolution(entry, clock, resolution) {
  const { root, flash } = entry;
  if (!root?.isConnected) return;

  const tone = resolution.outcome === OUTCOME.SUCCESS ? "resolved-success" : "resolved-failure";
  root.classList.add("resolved", tone);

  // Restart the CSS animation even if the class is already present.
  flash.classList.remove("fire");
  void flash.offsetWidth;
  flash.classList.add("fire");

  if (!root.querySelector(".oni-clock-banner")) {
    const banner = document.createElement("div");
    banner.className = "oni-clock-banner";
    banner.textContent = bannerFor(clock, resolution);
    root.appendChild(banner);
  }

  playClockSfx(resolution.outcome === OUTCOME.SUCCESS ? "SUCCESS" : "FAILURE");
}

/**
 * Post the resolution to chat. Active GM only, so the table sees exactly one
 * card. Fire-and-forget: a chat failure must never stall the bar.
 */
export async function postResolutionCard(clock, resolution) {
  if (!isActiveGM()) return;

  const success = resolution.outcome === OUTCOME.SUCCESS;
  const colour = success ? "#47b7e8" : "#d1443c";
  const verdict = success ? "Success" : "Failure";
  const pole = resolution.pole === POLE.HIGH ? "filled" : "emptied";
  const label = bannerFor(clock, resolution);

  const content = `
<div style="border-left:4px solid ${colour};padding:6px 10px;">
  <div style="font-weight:700;letter-spacing:.5px;color:${colour};">${esc(label)}</div>
  <div style="opacity:.85;margin-top:2px;">
    Clock <b>${esc(clock.name)}</b> was ${pole} — <b>${verdict}</b> for the party.
  </div>
</div>`.trim();

  try {
    await ChatMessage.create({ content, speaker: { alias: "Clock" } });
  } catch (e) {
    console.warn(CLOCK_TAG, "resolution chat card failed", e);
  }
}

/** Subscribe the chat card to resolutions. Called once, from the bar's bootstrap. */
export function wireResolutionChat() {
  Hooks.on("fu-clock-resolved", ({ clock, resolution }) => {
    postResolutionCard(clock, resolution).catch(() => {});
  });
}
