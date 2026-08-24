// ============================================================================
// Gacha System — Reveal sequence
// ----------------------------------------------------------------------------
// A treasure chest that wiggles, bursts, hands over each prize in turn, and
// then totals up. Three phases:
//
//   INTRO    chest drops in → wiggles N times → bursts → screen whites out
//   REVEAL   per prize: silhouette slides in → flashes → is revealed
//   SUMMARY  every prize as a card, held until dismissed
//
// THE WIGGLE COUNT IS THE TELL. One shake means nothing better than a 3-star is
// coming; two means a 4-star; three means a 5-star. The tension is not in the
// shake but in the PAUSE after it — each hold is longer than the last, and each
// has to feel like it might be the final one. That is lifted wholesale from the
// check-requester's die decel, whose equivalent pause is commented
// `hold: "is this it?"`.
//
// A purely honest tell would be read within a session, so FAKEOUT_CHANCE of
// rolls shake once more than they earned. It never under-promises: a 5-star
// that shook once would land as a shrug.
//
// SPLIT ENTRY. beginReveal() runs on the CLICK and playReveal() feeds in the
// outcome when the engine answers ~1-2s later. The chest's entrance covers
// exactly that gap; if the answer is slow the chest simply breathes a moment
// longer, and the player never sees a wait.
// ============================================================================

import { FX, FAKEOUT_CHANCE, RARITY, bestRarity } from "./gacha-const.js";
import {
  FX_ROOT_ID, CHEST_SRC, CHEST_OPEN_SRC, DRAMA,
  ensureFxStyle, phase, flush, emit, rankBurst, RANK_BURST, clearParticles,
  rgba, mixHex, markPixel, TIER_TINT,
} from "./gacha-fx-kit.js";

const SND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
const SFX = {
  start:   SND + "SE_SYS_Gacha_Start.ogg",       // the chest arrives
  // One per shake, escalating — the audio carries the same rising strain the
  // glow does, so a third wiggle is heard as bigger before it is seen.
  wiggle1: SND + "gacha_wiggle1.wav",
  wiggle2: SND + "gacha_wiggle2.wav",
  wiggle3: SND + "gacha_wiggle3.wav",
  whoosh:  SND + "SE_SYS_Gacha_goods_4.ogg",     // a prize slides in
  summary: SND + "SE_SYS_Gacha_ResultDef.ogg",   // the tally lands
  // One cue per rarity on the reveal. A 4-star is not the top of the table but
  // it is well clear of a 3-star, and sharing the 3-star cue flattened that.
  rare:    SND + "success2.ogg",                 // 5-star
  crystal: SND + "SE_SYS_Gacha_Crystal.ogg",     // 4-star
  normal:  SND + "ItemGet.ogg",                  // 3-star
};
const VOL = { start: 0.75, wiggle1: 0.6, wiggle2: 0.7, wiggle3: 0.85,
              whoosh: 0.6, summary: 0.75, rare: 0.8, crystal: 0.75, normal: 0.65 };

// Which reveal cue each rarity earns.
const REVEAL_CUE = { five: "rare", four: "crystal", three: "normal" };

// Local only: every client runs this animation, so broadcasting would stack one
// copy of every cue per connected player.
const sfx = (k) => sfxAt(k, VOL[k] ?? 0.7);
const sfxAt = (k, volume) => {
  try { AudioHelper?.play({ src: SFX[k], volume, loop: false }, false); } catch {}
};

/** Warm the cues so the first pull of a session is not the stuttering one. */
function preloadSfx() {
  for (const src of Object.values(SFX)) {
    try { foundry.audio?.AudioHelper?.preloadSound?.(src); }
    catch { try { fetch(src, { cache: "force-cache" }).catch(() => {}); } catch {} }
  }
}
Hooks?.once?.("ready", preloadSfx);

let _active = null;

const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

/**
 * How the chest shakes for a given best-rarity.
 *
 * `real` is the honest tell — full shakes, escalating cue, one per tier earned.
 * `fake` adds a NUDGE on the end: a stalled twitch with no escalated sound.
 *
 * The two are deliberately different in kind, not just in count. An earlier
 * build spent the fake-out on another full, fully-sounded shake, which is
 * indistinguishable from the real thing right up until the burst — that reads
 * as a lie rather than a tease, and players called it unfair. A fake-out has to
 * be legible AS a fake-out in the moment: "huh, I thought that was going to go".
 */
export function wigglePlan(best) {
  const real = best === "five" ? 3 : best === "four" ? 2 : 1;
  const fake = real < 3 && Math.random() < FAKEOUT_CHANCE;
  return { real, fake };
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Start the sequence before the outcome exists.
 * @param {number} count how many prizes are coming (unused visually — the chest
 *   is the same either way — but kept so the caller's intent is explicit)
 */
export function beginReveal(count = 1) {
  if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return null;

  stop();
  ensureFxStyle();

  const state = { skip: false, done: false, timers: [], pending: [], results: null };
  let resolveResult;
  const resultPromise = new Promise((r) => { resolveResult = r; });

  const el = document.createElement("div");
  el.id = FX_ROOT_ID;
  el.innerHTML = `
    <button class="gfx-skip" data-skip>Skip</button>
    <div class="gfx-stage">
      <div class="gfx-plinth"></div>
      <div class="gfx-chest-glow" data-glow></div>
      <img class="gfx-chest is-entering" data-chest src="${CHEST_SRC}" alt=""
           style="--in-ms:${FX.CHEST_IN}ms">
      <div class="gfx-beam" data-beam style="--burst-ms:${FX.BURST}ms"></div>
    </div>
    <div class="gfx-white" data-white style="--white-ms:${FX.WHITEOUT}ms"></div>
    <div class="gfx-counter" data-counter></div>`;

  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const onKey = (ev) => { if (ev.key === "Escape") state.onSkip?.(); };
  window.addEventListener("keydown", onKey);

  _active = {
    state, el, resolveResult,
    cleanup: () => window.removeEventListener("keydown", onKey),
  };

  run(el, state, resultPromise);
  return _active;
}

/** Feed the outcome in, or run the whole thing standalone (spectators). */
export function playReveal(payload = {}) {
  const { results } = payload;
  if (!Array.isArray(results) || !results.length) return;
  if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) return;

  if (_active && !_active.state.done && _active.resolveResult) {
    const resolve = _active.resolveResult;
    _active.resolveResult = null;
    resolve(payload);
    return;
  }

  const handle = beginReveal(results.length);
  if (!handle) return;
  const resolve = handle.resolveResult;
  handle.resolveResult = null;
  resolve?.(payload);
}

/** Tear down immediately. Safe when nothing is playing. */
export function stop() {
  if (!_active) return;
  const { state, el, cleanup } = _active;
  state.skip = true;
  state.done = true;
  flush(state);
  cleanup?.();
  el?.remove();
  _active = null;
}

// ── Sequence ────────────────────────────────────────────────────────────────

async function run(el, state, resultPromise) {
  const chest   = el.querySelector("[data-chest]");
  const glow    = el.querySelector("[data-glow]");
  const beam    = el.querySelector("[data-beam]");
  const white   = el.querySelector("[data-white]");
  const counter = el.querySelector("[data-counter]");

  // Skip lands wherever it is pressed and jumps to the summary, so you still
  // see what you got. It never aborts the whole thing.
  const onSkip = () => {
    if (state.done || state.skipping) return;
    state.skipping = true;
    state.skip = true;
    flush(state);
    if (state.results) showSummary(el, state, state.results);
    else state.jumpToSummary = true;   // outcome not in yet; summary runs on arrival
  };
  state.onSkip = onSkip;
  el.querySelector("[data-skip]").addEventListener("click", onSkip);

  // ── INTRO ───────────────────────────────────────────────────────────────
  sfx("start");
  await phase(FX.DARKEN + FX.CHEST_IN, state);
  chest.classList.remove("is-entering");
  chest.classList.add("is-idle");
  await phase(FX.CHEST_SETTLE, state);

  // Wait for the engine. Bounded, so a lost reply cannot strand the screen.
  const payload = await Promise.race([
    resultPromise,
    new Promise((r) => { state.timers.push(setTimeout(() => r(null), FX.RESULT_TIMEOUT)); }),
  ]);
  if (state.done) return;
  if (!payload) { stop(); return; }

  const results = payload.results;
  state.results = results;
  state.bannerName = payload.bannerName;   // titles the summary

  if (state.jumpToSummary || state.skip) { showSummary(el, state, results); return; }

  const best  = bestRarity(results.map((r) => r.rarity));
  const drama = DRAMA[best];
  const plan  = wigglePlan(best);

  chest.classList.remove("is-idle");

  const box = () => chest.getBoundingClientRect();

  // ── the honest shakes ──
  for (let i = 0; i < plan.real; i++) {
    if (state.skip) break;

    chest.style.setProperty("--wig-ms", `${FX.WIGGLE}ms`);
    chest.classList.remove("is-wiggling");
    void chest.offsetWidth;                 // restart the animation
    chest.classList.add("is-wiggling");

    sfx(`wiggle${Math.min(i + 1, 3)}`);

    // The glow climbs blue -> purple -> gold BY SHAKE NUMBER, never by the
    // outcome. Tinting it from the final rarity spoiled the result on shake one.
    glow.style.setProperty("--gfx-strain-tint",
      rgba(TIER_TINT[Math.min(i, TIER_TINT.length - 1)], 0.85));

    // Strain builds with each shake: the chest looks progressively more loaded,
    // which is the visual half of "surely it goes now".
    const strain = (i + 1) / 3;
    glow.style.opacity = String(0.25 + strain * 0.55);
    glow.style.transform = `translate(-50%, 0) scale(${0.85 + strain * 0.3})`;

    const r = box();
    emit(el, {
      x: r.left + r.width / 2, y: r.bottom - r.height * 0.15,
      n: 4 + i * 3, up: 90, spreadX: 130, size: [2, 5],
      tints: ["#e8d5a3", "#c6ae87", "#fff3c4"], dur: [420, 760],
    });

    // The rank climb, on top of the dust: blue stays quiet, purple pops, gold
    // detonates. Fired from the chest's middle rather than its base — this is
    // the thing inside surging, not the box scuffing the floor.
    rankBurst(el, {
      x: r.left + r.width / 2, y: r.top + r.height * 0.45,
      tint: TIER_TINT[Math.min(i, TIER_TINT.length - 1)],
      spec: RANK_BURST[Math.min(i, RANK_BURST.length - 1)],
    });

    await phase(FX.WIGGLE, state);
    chest.classList.remove("is-wiggling");
    // THE hold. Longer each time — every one has to read as possibly the last.
    await phase(FX.HOLDS[Math.min(i, FX.HOLDS.length - 1)], state);
  }

  // ── the fake-out ──
  // A stall, not a shake. No escalated cue: the climactic wiggle sound is
  // reserved for a roll that actually earned it, so hearing it always means
  // something. The nudge gets the FIRST cue at low volume — present, but
  // audibly smaller than any real shake, so it can never be misread upward.
  if (plan.fake && !state.skip) {
    chest.style.setProperty("--nudge-ms", `${FX.NUDGE}ms`);
    chest.classList.remove("is-nudging");
    void chest.offsetWidth;
    chest.classList.add("is-nudging");
    sfxAt("wiggle1", 0.15);

    // The light half-shifts toward the next tier and falls back, matching the
    // motion: it reaches for the promotion and does not get there.
    const from = TIER_TINT[Math.min(plan.real - 1, TIER_TINT.length - 1)];
    const to   = TIER_TINT[Math.min(plan.real,     TIER_TINT.length - 1)];
    const held = Number(glow.style.opacity || 0);
    glow.style.setProperty("--gfx-strain-tint", rgba(mixHex(from, to, 0.5), 0.85));
    glow.style.opacity = String(Math.min(1, held + 0.06));
    setTimeout(() => {
      glow.style.setProperty("--gfx-strain-tint", rgba(from, 0.85));
      glow.style.opacity = String(held);
    }, FX.NUDGE);

    const r = box();
    emit(el, {
      x: r.left + r.width / 2, y: r.bottom - r.height * 0.15,
      n: 3, up: 60, spreadX: 90, size: [2, 4],
      tints: ["#c6ae87", "#e8d5a3"], dur: [380, 620],
    });

    await phase(FX.NUDGE, state);
    chest.classList.remove("is-nudging");
    await phase(FX.HOLDS[Math.min(plan.real, FX.HOLDS.length - 1)], state);
  }

  if (state.skip) { showSummary(el, state, results); return; }

  // ── BURST ───────────────────────────────────────────────────────────────
  sfx(best === "five" ? "rare" : "normal");
  if (CHEST_OPEN_SRC) chest.src = CHEST_OPEN_SRC;

  const r = box();
  beam.classList.add("is-on");
  emit(el, {
    x: r.left + r.width / 2, y: r.top + r.height * 0.35,
    n: drama.particles + 20, up: 620, spreadX: 300, drift: 220,
    size: [3, 10], dur: [700, 1500],
    tints: ["#ffd479", "#fff3c4", "#ffffff", drama.tint],
  });
  chest.animate(
    [{ transform: "translateX(-50%) scale(1)" },
     { transform: "translateX(-50%) scale(1.14) translateY(6px)", offset: .3 },
     { transform: "translateX(-50%) scale(1)" }],
    { duration: FX.BURST, easing: "cubic-bezier(.2,.9,.3,1)", fill: "both" }
  );

  await phase(FX.BURST, state);
  if (state.skip) { showSummary(el, state, results); return; }

  white.classList.add("is-on");
  await phase(FX.WHITEOUT, state);
  if (state.skip) { showSummary(el, state, results); return; }

  // ── REVEAL ──────────────────────────────────────────────────────────────
  el.querySelector(".gfx-stage")?.remove();
  beam.remove();
  clearParticles(el);   // the burst spray outlives the whiteout otherwise

  for (let i = 0; i < results.length; i++) {
    if (state.skip) break;
    counter.textContent = results.length > 1 ? `${i + 1} / ${results.length}` : "";
    await revealOne(el, state, results[i], i === 0 ? white : null);
  }

  showSummary(el, state, results);
}

/** One prize: silhouette slides in, flashes, and is revealed. */
async function revealOne(el, state, prize, whiteToClear) {
  const d = DRAMA[prize.rarity] ?? DRAMA.three;
  const c = RARITY[prize.rarity] ?? RARITY.three;

  // The previous prize's spray can outlive its own slot — a 3-star holds for
  // 750ms while its particles run to 1200 — so it would rain over this one.
  clearParticles(el);

  const wrap = document.createElement("div");
  wrap.className = "gfx-reveal";
  wrap.style.setProperty("--ray", d.tint);
  wrap.style.setProperty("--rayGlow", rgba(d.tint, 0.55));
  wrap.innerHTML = `
    ${d.rays ? `<div class="gfx-rays" data-rays></div>` : ""}
    ${d.ring ? `<div class="gfx-ring" data-ring></div>` : ""}
    <div class="gfx-prize">
      <img class="gfx-prize-img is-sliding" data-img src="${prize.img}" alt=""
           style="--slide-ms:${FX.SILHOUETTE_IN}ms">
      <div class="gfx-prize-name" data-name>${esc(prize.name)}</div>
      <div class="gfx-prize-stars" data-stars>${"★".repeat(c.stars)}</div>
    </div>`;
  el.appendChild(wrap);

  const img = wrap.querySelector("[data-img]");
  markPixel(img);
  sfx("whoosh");   // rides the slide, not the flash

  // Clearing the whiteout while the silhouette is already sliding is what makes
  // the first prize feel like it came OUT of the flash rather than after it.
  if (whiteToClear) {
    whiteToClear.classList.remove("is-on");
    whiteToClear.classList.add("is-off");
    setTimeout(() => whiteToClear.remove(), 460);
  }

  await phase(FX.SILHOUETTE_IN, state);
  if (state.skip) { wrap.remove(); return; }

  // Flash: the silhouette becomes the item.
  //
  // `is-sliding` STAYS. Its animation has fill:both, so it is what holds the
  // image at centre; removing it drops the element back to the base rule's
  // translateX(-70vw) and the prize vanishes off-screen the instant it lights.
  img.classList.add("is-lit");
  wrap.querySelector("[data-rays]")?.classList.add("is-on");
  wrap.querySelector("[data-ring]")?.classList.add("is-on");
  if (d.shake) { el.classList.add("is-shaking"); setTimeout(() => el.classList.remove("is-shaking"), 400); }

  const r = img.getBoundingClientRect();
  emit(el, {
    x: r.left + r.width / 2, y: r.top + r.height / 2,
    n: d.particles, up: 240, spreadX: 420, drift: 260,
    size: [3, 9], dur: [560, 1200],
    tints: [d.tint, "#fff3c4", "#ffffff"],
  });
  sfx(REVEAL_CUE[prize.rarity] ?? "normal");

  await phase(FX.FLASH, state);
  wrap.querySelector("[data-name]")?.classList.add("is-on");
  wrap.querySelector("[data-stars]")?.classList.add("is-on");

  await phase(FX.REVEAL_HOLD[prize.rarity] ?? FX.REVEAL_HOLD.three, state);

  wrap.animate([{ opacity: 1 }, { opacity: 0 }],
    { duration: 200, easing: "ease-in", fill: "both" })
    .finished.catch(() => {}).finally(() => wrap.remove());
  await phase(180, state);
}

/** Every prize at once, held until dismissed. Terminal state. */
function showSummary(el, state, results) {
  if (state.done) return;
  state.done = true;
  flush(state);
  sfx("summary");

  el.querySelectorAll(".gfx-reveal, .gfx-stage, .gfx-white, .gfx-counter").forEach((n) => n.remove());
  el.querySelector("[data-skip]")?.remove();
  clearParticles(el, { fade: 200 });   // and nothing rains onto the summary

  // Titled with the banner it came from. Absolutely positioned rather than a
  // flex child, so it sits at the top of the SCREEN and the grid stays centred
  // on the same axis it already used — adding a row would have shunted it down.
  const title = state.bannerName
    ? `<div class="gfx-summary-title">${esc(state.bannerName)}</div>`
    : "";

  const wrap = document.createElement("div");
  wrap.className = "gfx-summary";
  wrap.innerHTML = `
    ${title}
    <div class="gfx-summary-grid${results.length > 5 ? "" : " is-few"}"
         style="--stagger:${FX.SUMMARY_STAGGER}ms">
      ${results.map((p, i) => {
        const c = RARITY[p.rarity] ?? RARITY.three;
        return `
          <div class="gfx-card" style="--i:${i};--cc:${c.color};--ccGlow:${rgba(c.color, .5)}">
            <img src="${p.img}" alt="">
            <div class="gfx-card-name">${esc(p.name)}</div>
            <div class="gfx-card-stars">${"★".repeat(c.stars)}</div>
          </div>`;
      }).join("")}
    </div>
    <div class="gfx-anykey" style="animation-delay:${results.length * FX.SUMMARY_STAGGER + 300}ms,
         ${results.length * FX.SUMMARY_STAGGER + 700}ms">— Press Any Button —</div>`;
  el.appendChild(wrap);
  wrap.querySelectorAll("img").forEach(markPixel);

  // Dismiss on anything, but not on the click that opened this — a stray
  // mouseup from the Skip press would otherwise close it instantly.
  setTimeout(() => {
    if (!_active) return;
    const bye = () => stop();
    el.addEventListener("click", bye, { once: true });
    window.addEventListener("keydown", bye, { once: true });
    _active.cleanup = (() => {
      const prev = _active.cleanup;
      return () => { prev?.(); window.removeEventListener("keydown", bye); };
    })();
  }, 420);
}
