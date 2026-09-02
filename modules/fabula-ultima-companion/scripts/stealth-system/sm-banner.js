// ============================================================================
// Stealth Mode — phase announcer banner.
//
// A centred flash at the top of each phase: PLAYER PHASE in blue, ENEMY PHASE
// in red. Same visual language as the Battle Director's initiative flash — two
// disposition-coloured accent lines opening from the centre, a soft wash
// between them, white italic label — and the same two Forge SFX, so a stealth
// round and a combat round announce themselves identically.
//
// ── Why a port rather than an import ───────────────────────────────────────
// BD's flash lives behind its own socketlib channel and its own layer, and is
// driven from the combat's initiative result. Reaching into it would couple
// this mode to a combat that is not running. The markup and timings are copied
// so the two cannot look different; the plumbing is local and broadcasts over
// the stealth socket like everything else here.
// ============================================================================

const LAYER_ID = "oni-stealth-phase-layer";
const STYLE_ID = "oni-stealth-phase-style";

// Disposition colours — the same two the Director's initiative tracker uses.
const DISP_BLUE = "#5aaaff";
const DISP_RED  = "#ff5050";

const SFX_PLAYER = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/player_initiative.wav";
const SFX_ENEMY  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/enemy_initiative.wav";

export const PHASE_SPECS = Object.freeze({
  player: { text: "Player Phase", line: DISP_BLUE, sfx: SFX_PLAYER },
  enemy:  { text: "Enemy Phase",  line: DISP_RED,  sfx: SFX_ENEMY },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${LAYER_ID}{ position:fixed; inset:0; z-index:99; pointer-events:none; display:none; }
#${LAYER_ID}.active{ display:block; }
#${LAYER_ID} .sm-band{
  position:absolute; left:50%; top:46%; transform:translate(-50%,-50%);
  width:88vw; height:12vh; --line:${DISP_BLUE};
  display:flex; flex-direction:column; justify-content:space-between;
}
#${LAYER_ID} .sm-wash{ position:absolute; inset:0; opacity:0; }
#${LAYER_ID} .sm-line{
  position:relative; width:100%; height:3px; transform:scaleX(0);
  transform-origin:50% 50%;
  background:linear-gradient(90deg,transparent 0%,var(--line) 6%,var(--line) 94%,transparent 100%);
  box-shadow:0 0 10px var(--line), 0 0 3px var(--line);
}
#${LAYER_ID} .sm-text{
  position:absolute; left:50%; top:46%; transform:translate(-50%,-50%);
  white-space:nowrap; font-style:italic; font-weight:900;
  font-family:"Pixel Operator",system-ui,sans-serif;
  font-size:6.4vh; letter-spacing:.03em; opacity:0; color:#fff;
  /* Dark outline + halo, so the white label reads on any map. */
  -webkit-text-stroke:0.9px rgba(0,0,0,.92); paint-order:stroke fill;
  text-shadow:0 0 5px rgba(0,0,0,.9), 0 3px 16px rgba(0,0,0,.7);
}`.trim();
  document.head.appendChild(style);
}

function ensureLayer() {
  ensureStyle();
  let layer = document.getElementById(LAYER_ID);
  if (layer?.__sm) return layer;

  layer = document.createElement("div");
  layer.id = LAYER_ID;

  const band = document.createElement("div"); band.className = "sm-band";
  const wash = document.createElement("div"); wash.className = "sm-wash";
  const top = document.createElement("div"); top.className = "sm-line";
  const bot = document.createElement("div"); bot.className = "sm-line";
  band.append(top, bot);

  const text = document.createElement("div"); text.className = "sm-text";

  layer.append(wash, band, text);
  document.body.appendChild(layer);
  layer.__sm = { band, wash, top, bot, text };
  return layer;
}

async function playSfx(url) {
  try {
    foundry.audio.AudioHelper.play({ src: url, volume: 0.6, autoplay: true, loop: false }, false);
  } catch (_) {
    try { AudioHelper.play({ src: url, volume: 0.6, autoplay: true, loop: false }, false); }
    catch (_e) { /* audio locked — never let a cue block a phase */ }
  }
}

let _busy = false;

/**
 * Play the phase flash locally.
 *
 * Guarded against overlap: two banners animating at once leaves one of them
 * stuck visible when the other's cleanup runs. A second request while one is
 * playing is dropped rather than queued — by the time it would surface, the
 * phase it announces has already started.
 */
export async function playPhaseBannerLocal(kind, { holdMs = 620 } = {}) {
  const spec = PHASE_SPECS[kind];
  if (!spec || _busy) return;
  _busy = true;

  try {
    const layer = ensureLayer();
    const { band, wash, top, bot, text } = layer.__sm;

    band.style.setProperty("--line", spec.line);
    wash.style.background =
      `linear-gradient(90deg, transparent 0%, ${spec.line}22 18%, ${spec.line}3a 50%, ${spec.line}22 82%, transparent 100%)`;
    text.textContent = spec.text;

    // Reset every animated property before showing, so a re-run never inherits
    // the previous pass's end state.
    for (const el of [top, bot]) { el.style.transition = "none"; el.style.transform = "scaleX(0)"; }
    wash.style.transition = "none"; wash.style.opacity = "0";
    text.style.transition = "none"; text.style.opacity = "0";
    text.style.transform = "translate(-50%,-50%) scale(.92)";

    layer.classList.add("active");
    void layer.offsetWidth;   // force the reset to land before animating

    playSfx(spec.sfx);

    // Lines open from the centre, wash blooms, label lands.
    for (const el of [top, bot]) {
      el.style.transition = "transform 260ms cubic-bezier(.2,.8,.25,1)";
      el.style.transform = "scaleX(1)";
    }
    wash.style.transition = "opacity 260ms ease-out";
    wash.style.opacity = "1";

    await wait(90);
    text.style.transition = "opacity 200ms ease-out, transform 260ms cubic-bezier(.2,.9,.25,1)";
    text.style.opacity = "1";
    text.style.transform = "translate(-50%,-50%) scale(1)";

    await wait(holdMs);

    text.style.transition = "opacity 220ms ease-in";
    text.style.opacity = "0";
    wash.style.transition = "opacity 260ms ease-in";
    wash.style.opacity = "0";
    for (const el of [top, bot]) {
      el.style.transition = "transform 240ms ease-in";
      el.style.transform = "scaleX(0)";
    }

    await wait(280);
    layer.classList.remove("active");
  } catch (e) {
    console.warn("[Stealth] phase banner threw", e);
    try { document.getElementById(LAYER_ID)?.classList.remove("active"); } catch (_) {}
  } finally {
    _busy = false;
  }
}

export function removeBanner() {
  try { document.getElementById(LAYER_ID)?.remove(); } catch (_) {}
}
