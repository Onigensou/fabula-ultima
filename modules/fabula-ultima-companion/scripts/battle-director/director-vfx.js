// Director VFX + asset registry.
//
// Static assets the director references at runtime — AE icons, Study VFX,
// status iconography, sound cues. All of them are added to the preload
// list inside director-init.js so first-use during combat doesn't hit
// the network. (Forge-vtt URLs in particular have a noticeable first-use
// delay; pre-fetching them at battle start avoids "lag spike when Guard
// is first applied" UX.)
//
// Adding a new asset: just append to DIRECTOR_STATIC_URLS — the battle
// preload picks it up automatically the next time `runDirectorInit` runs.

import { log, warn } from "./logger.js";
import { broadcastSfx, preloadSfx, collapseSidebarAllClients } from "./director-sfx.js";
import { INVOKE_SFX_URLS } from "./invoke/invoke-hud.js";
import { emitDamageNumber } from "./damage-numbers/director-damage-numbers.js";
import { emitImpactFx } from "./damage-numbers/director-impact-fx.js";
import { emitHurtReaction } from "./damage-numbers/director-hurt-reaction.js";

export const DIRECTOR_STATIC_URLS = Object.freeze([
  // Guard / Covered AE icons (Forge-vtt — remote, slowest first-fetch).
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/shield_oath.png",
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/intervene.png",

  // Study VFX: 4s green marker on the studied token + a "computer ping"
  // sound. The JB2A file is local-to-the-module but still ~1MB; preloading
  // saves the first-Study lag.
  "modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm",
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg",

  // Resource VFX VISUALS (impact / heal auras on a token). Only the webms
  // belong here — this list is preloaded via Foundry's AudioHelper/texture
  // path, and feeding it Forge `.wav` cues makes AudioHelper.preload hang on
  // the 206 range-decode bug (which stalls the whole battle-start preload).
  // The resource cue SOUNDS are warmed separately by director-sfx's Web Audio
  // path (preloadDirectorSfx — a full 200 GET that dodges that bug), so they
  // are deliberately NOT listed here.
  "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm",
  "modules/JB2A_DnD5e/Library/2nd_Level/Misty_Step/MistyStep_01_Regular_Blue_400x400.webm",
  "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm",
  "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Blue_400x400.webm",
]);

// Study token VFX — mirrors `playStudyVfxAndWait` from
// `scripts/encyclopedia/encyclopedia-core.js`. Plays a green-marker effect
// on the studied token plus a short audio cue, then awaits the duration
// so the caller can chain (e.g. open the encyclopedia AFTER the effect).
//
// Silently no-ops if Sequencer isn't installed or the token isn't on the
// active canvas — this is a flavor moment, not a critical path.
export async function playStudyVfx({ targetTokenUuid, durationMs = 2500 } = {}) {
  // `targetTokenUuid` for linked tokens looks like `Scene.X.Token.Y`; for
  // unlinked the same. Grab the trailing token id.
  const tokenId = String(targetTokenUuid ?? "").split(".Token.").pop();
  const canvasTok = tokenId ? canvas?.tokens?.get?.(tokenId) : null;
  if (!canvasTok) {
    log("Study VFX: token not on canvas, skipping");
    return;
  }
  if (typeof Sequence === "undefined") {
    log("Study VFX: Sequencer not loaded, skipping");
    return;
  }
  try {
    new Sequence()
      .effect()
        .file("modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm")
        .atLocation(canvasTok)
        .duration(durationMs)
        .opacity(0.7)
        .scale(0.5)
      .play();
    broadcastSfx("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg", 0.6);
    // Brief tail beyond the FX duration so the green marker has time to
    // fade out before whatever the caller does next (encyclopedia open,
    // typically).
    await new Promise((r) => setTimeout(r, durationMs + 200));
  } catch (e) {
    warn("playStudyVfx threw", e);
  }
}

// ── Action namecard ─────────────────────────────────────────────────────
//
// JRPG-style title banner shown when the active actor posts an action. This
// is a director-native PORT of the legacy `runVisualFeedback` namecard path
// (scripts/action-execution-core.js). We own the TRIGGER and the
// OPTION-BUILDING here; the actual draw is delegated to the existing
// namecard renderer (`FUCompanion.api.namecardBroadcast`, defined in
// namecard-broadcast.js + namecard-receiver.js).
//
// Why delegate instead of fork: that renderer is a pure DOM + socket
// function with ZERO coupling to combat or legacy battle state — calling it
// cannot perturb the legacy pipeline, so reusing it is safe and avoids
// duplicating ~300 lines of CSS/layout. If the director ever needs a
// divergent look, the renderer can be copied at that point. The director
// stays the sole owner of *when* and *whether* a card shows.
//
// Differences from the legacy defaults (deliberate):
//   - cardScale: legacy default was 0.20, which renders the banner at ~24%
//     size with unreadable ~7px text. We use 1.0 and lean on the renderer's
//     viewport-height scaler (baselineVh/scaleMin/scaleMax) for per-client
//     responsiveness across screen sizes.
//   - Fires for ALL declared action kinds, not just spell/active/passive
//     (legacy `shouldShowDefaultNamecard` skipped attacks).

// Disposition → color theme. Mirrors legacy buildDefaultNamecardOptions.
const NAMECARD_THEMES = Object.freeze({
  hostile:  { accent: "#ff5a5a", text: ["#ffffff", "#ffd6d6"] },
  friendly: { accent: "#7fb5ff", text: ["#ffffff", "#d7e9ff"] },
  neutral:  { accent: "#ffd866", text: ["#ffffff", "#fff1b3"] },
  secret:   { accent: "#a0a4a8", text: ["#ffffff", "#e5e7ea"] },
});

function namecardThemeFor(disposition) {
  const d = Number.isFinite(disposition) ? Math.trunc(disposition) : 0;
  if (d === -2) return NAMECARD_THEMES.secret;
  if (d === -1) return NAMECARD_THEMES.hostile;
  if (d === 1) return NAMECARD_THEMES.friendly;
  return NAMECARD_THEMES.neutral;
}

// Map a director actionResult → { title, icon } for the banner. Title
// prefers the action-specific name (weapon / skill / item) and falls back
// to a kind label. Icons use emoji passed via `iconOverride` so we aren't
// limited to the renderer's built-in ACTION_ICONS set.
function namecardSpecFor(ar) {
  const kind = String(ar?.kind ?? "");
  const skillName = ar?.skillName;
  const isSpell = String(ar?.skillType ?? "").toLowerCase() === "spell";
  switch (kind) {
    case "Attack":    return { title: ar?.weapon?.name ?? "Attack", icon: "⚔️" };
    case "Guard":     return { title: "Guard", icon: "🛡️" };
    case "Study":     return { title: "Study", icon: "🔍" };
    case "Hinder":    return { title: "Hinder", icon: "💢" };
    case "Equipment": return { title: "Equip", icon: "🔄" };
    case "Item":      return { title: ar?.itemName ?? ar?.item?.name ?? "Item", icon: "🧪" };
    case "Spell":     return { title: skillName ?? "Spell", icon: "📕" };
    case "Skill":
      return isSpell
        ? { title: skillName ?? "Spell", icon: "📕" }
        : { title: skillName ?? "Skill", icon: "💥" };
    default:          return { title: skillName ?? kind ?? "Action", icon: "" };
  }
}

async function resolveTokenDisposition(tokenUuid) {
  try {
    if (!tokenUuid) return 0;
    const doc = await fromUuid(tokenUuid);
    const tok = doc?.documentName === "Token" ? doc : (doc?.token ?? null);
    return Number(tok?.disposition ?? 0);
  } catch {
    return 0;
  }
}

// Build the renderer option blob for an action. Exposed so the FSM (and
// tests) can preview/override without re-deriving the theme logic.
export async function buildActionNamecardOptions(ar) {
  const { title, icon } = namecardSpecFor(ar);
  const disp = await resolveTokenDisposition(ar?.attacker?.tokenUuid);
  const theme = namecardThemeFor(disp);
  return {
    title,
    options: {
      bg: "#000000",
      accent: theme.accent,
      text: theme.text,
      glowColor: "#ffffff",
      border: "rgba(255,255,255,.10)",
      dropShadow: "0 10px 22px rgba(0,0,0,.35)",
      maskEdges: true,
      edgeFade: 0.12,

      showIcon: !!icon,
      iconOverride: icon,
      iconScale: 0.93,
      iconGapPx: 10,

      xAlign: "center",
      offsetX: 0,
      offsetY: 64,
      fixedWidth: 640,
      autoWidth: false,
      // Sane base scale — legacy default 0.20 rendered the banner unreadably
      // small. Per-client responsiveness comes from the viewport-height
      // scaler below, not from a hard-coded shrink.
      cardScale: 1.0,

      inMs: 350,
      holdMs: 1400,
      outMs: 400,
      enterFrom: "left",

      maxFontPx: 30,
      minFontPx: 16,
      letterSpacing: 0.06,
      fontWeight: 700,
      upperCase: false,
      fontFamily: "Pixel Operator, system-ui, sans-serif",
      textShadowStrength: 0.0,
      textStrokePx: 0.1,
      textStrokeColor: "rgba(0,0,0,0.55)",

      // Multi-screen scaling: scale the whole card by viewport height
      // relative to a 900px baseline, clamped so small laptops → 4K all
      // stay legible.
      baselineVh: 900,
      scaleMin: 0.75,
      scaleMax: 1.75,
      scaleMode: "vh",
    },
  };
}

// Fire the action namecard for a posted action. Fire-and-forget by design —
// the FSM should NOT block on the ~2s banner; it plays while the action card
// comes up. Silently no-ops if the renderer isn't loaded.
export async function playActionNamecard(ar, { broadcast = true } = {}) {
  try {
    const api = window.FUCompanion?.api;
    const render = broadcast ? api?.namecardBroadcast : api?.showNameCardLocal;
    if (typeof render !== "function") {
      log("namecard: renderer API missing, skipping");
      return;
    }
    const { title, options } = await buildActionNamecardOptions(ar);
    if (broadcast) await render({ title, options });
    else await render(title, options);
  } catch (e) {
    warn("playActionNamecard threw", e);
  }
}

// ── Battle-start "broken screen" transition ──────────────────────────────
//
// Director-native PORT of the legacy "BattleInit — Battle Transition" macro:
// a full-screen orange ground-crack (the "broken screen") + a transition SFX
// played on the CURRENT (source) scene right before the director raises the
// curtain and swaps to the battle scene.
//
// Both halves broadcast to every client by design:
//   - Sequencer screen-space effects fan out to all connected clients.
//   - AudioHelper.play(data, true) broadcasts the SFX over Foundry's socket.
// Players are still on the source scene at this point (the swap happens a
// beat later in PREP), so everyone sees/hears the transition together.

const BATTLE_TRANSITION_FX_FILE = "jb2a.impact.ground_crack.orange";
const BATTLE_TRANSITION_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Random_Battle.mp3";

export async function playBattleStartTransition({ waitMs = 900, sfxVol = 0.2 } = {}) {
  try {
    // Collapse the Foundry sidebar on every client so the battlefield gets the
    // full screen for everyone as the battle scene comes up.
    try { collapseSidebarAllClients(); } catch (e) { warn("transition: sidebar collapse threw", e); }

    // SFX — Web Audio cue played on every client from its own warm cache
    // (broadcast). Warm-decoded at boot so even the first battle's transition
    // plays without a fetch hitch.
    broadcastSfx(BATTLE_TRANSITION_SFX_URL, sfxVol);

    // Visual — Sequencer broadcasts screen-space effects to all clients.
    if (typeof Sequence !== "undefined") {
      try {
        const w = canvas?.app?.renderer?.width ?? window.innerWidth ?? 1000;
        const h = canvas?.app?.renderer?.height ?? window.innerHeight ?? 700;
        new Sequence()
          .effect()
            .file(BATTLE_TRANSITION_FX_FILE)
            .atLocation({ x: Math.floor(w / 2), y: Math.floor(h / 2) })
            .scale(7)
            .screenSpaceAboveUI()
          .play();
      } catch (e) {
        warn("battle transition FX failed", e);
      }
    } else {
      log("battle transition: Sequencer not loaded, visual skipped");
    }

    // Hold so the crack is visible on the source scene before the curtain
    // raises + the scene swaps (matches legacy FX_DELAY_MS_BEFORE_SCENE).
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  } catch (e) {
    warn("playBattleStartTransition threw", e);
  }
}

// ── Battle BGM ───────────────────────────────────────────────────────────
//
// Director-native PORT of the legacy BGM start ("BattleInit — Preload Assets"):
// resolve the chosen track NAME from the payload, stop any currently-playing
// playlist sounds, then play the named track from whichever playlist holds it.
// Foundry playlist sounds are globally synchronized, so every client hears it —
// no manual broadcast needed.

function getBgmNameFromPayload(payload) {
  return (
    payload?.battleConfig?.bgm ??
    payload?.battleConfig?.battleBGM ??
    payload?.bgm ??
    payload?.battleBGM ??
    payload?.music?.bgm ??
    payload?.music?.battleBGM ??
    payload?.chosenBgm ??
    ""
  );
}

// The battle track the director started, so battle-end can stop exactly it
// (rather than nuking whatever the GM is playing). Cleared on stop.
let _currentBgm = null; // { playlistId, soundId }

export async function playBattleBgm(payload) {
  try {
    const name = String(getBgmNameFromPayload(payload) ?? "").trim();
    if (!name) {
      log("battle BGM: no track name in payload — skipping");
      return;
    }
    // Stop currently-playing playlist sounds so the new BGM doesn't layer.
    await Promise.allSettled(
      (game.playlists ?? [])
        .filter((pl) => pl.playing?.length)
        .map((pl) => pl.stopAll())
    );
    // Find the named sound across every playlist and play it (broadcasts).
    for (const pl of game.playlists) {
      const snd = pl.sounds?.getName?.(name);
      if (snd) {
        await pl.playSound(snd);
        _currentBgm = { playlistId: pl.id, soundId: snd.id };
        log(`battle BGM playing: ${pl.name} / ${snd.name}`);
        return;
      }
    }
    warn(`battle BGM track not found in any playlist: "${name}"`);
  } catch (e) {
    warn("playBattleBgm threw", e);
  }
}

// ── Resource-loss VFX (damage / drain from an outside source) ─────────────
//
// Director-native PORT of the legacy "AV feedback" path in apply-damage-core.js
// (`_resolveAV` + the Sequencer `.scrollingText()` block). When a creature
// loses HP / MP from an OUTSIDE source (an attack, a damaging skill, an MP
// drain), we float a damage number over the hit token, play a short impact
// effect on it, and fire an affinity-keyed sound.
//
// Fired from `applyDamageToTarget` (skill-effects.js) — the single write point
// for outside-source resource loss — so Attack RESOLVE, Skill RESOLVE, and any
// future damage source all get the feedback uniformly. Self-paid costs (skill
// MP cost, IP spend) do NOT route through there, so they correctly stay silent.
//
// Sequencer effects/text at a canvas location broadcast to every client by
// default, so the single shared GM screen and any player clients all see it.
// Silently no-ops if Sequencer isn't installed or the token isn't on canvas —
// this is flavor, never on the critical path.

const RESOURCE_VFX_SFX = Object.freeze({
  baseHit: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/HitSlashM.wav",
  super:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Hit_SlashingB.wav",
  resist:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Parry.ogg",
  mpSpend: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg",
});
const IMPACT_HP_FILE = "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm";
const IMPACT_MP_FILE = "modules/JB2A_DnD5e/Library/2nd_Level/Misty_Step/MistyStep_01_Regular_Blue_400x400.webm";

// Combo-aware SFX gate for the resource-feedback cues. A multi-hit / multi-target
// action commits all its damage in one synchronous loop, so N identical impact
// cues fire at once and stack into an ear-splitting blast. This collapses a burst
// of the SAME cue within a short window down to a single play — the NUMBERS still
// cascade (they self-stagger in the damage-number subsystem), but you hear one
// hit, not five. Distinct cues (e.g. a WEAK hit's "super" sound mixed into a
// normal combo) are keyed separately, so they still sound. Per-URL, per-client.
const _lastSfxAt = new Map(); // sfx url -> perf timestamp of last play
const COMBO_SFX_WINDOW_MS = 90;
function throttledSfx(url, vol) {
  if (!url) return;
  const now = performance.now();
  if (now - (_lastSfxAt.get(url) ?? 0) < COMBO_SFX_WINDOW_MS) return;
  _lastSfxAt.set(url, now);
  broadcastSfx(url, vol);
}

// Token hurt-reaction (pseudo-animated flinch) on real damage. Throttled per
// token so a multi-hit combo's synchronous calls don't fire N GPU snapshots —
// the flinch self-restarts within its own debounce anyway. "strong" tier for a
// WEAK or critical hit so it visibly hurts more.
const _lastHurtAt = new Map(); // tokenUuid -> perf timestamp
const HURT_THROTTLE_MS = 140;
function fireHurt(tokenUuid, affinity, isCrit) {
  if (!tokenUuid) return;
  const now = performance.now();
  if (now - (_lastHurtAt.get(tokenUuid) ?? 0) < HURT_THROTTLE_MS) return;
  _lastHurtAt.set(tokenUuid, now);
  try { emitHurtReaction({ tokenUuid, intensity: (affinity === "VU" || isCrit) ? "strong" : "normal" }); }
  catch (e) { warn("fireHurt threw", e); }
}

// Map (resource, affinity) → { file, color, icon, sfx } for a LOSS. Mirrors
// legacy `_resolveAV` for the damage/drain half (we only float losses here).
function resolveLossAv(resource, affinity) {
  if (resource === "mp") {
    return { file: IMPACT_MP_FILE, color: "#B32EFF", icon: "🌀", sfx: RESOURCE_VFX_SFX.mpSpend };
  }
  // HP loss — icon + sound vary by affinity.
  let icon = "⚔️", sfx = RESOURCE_VFX_SFX.baseHit;
  if (affinity === "VU") { icon = "💥"; sfx = RESOURCE_VFX_SFX.super; }
  else if (affinity === "RS") { icon = "🛡️"; sfx = RESOURCE_VFX_SFX.resist; }
  return { file: IMPACT_HP_FILE, color: "#ffffff", icon, sfx };
}

// Float a damage/drain number over a token + impact + sound.
//   tokenUuid : the hit token ("Scene.X.Token.Y")
//   resource  : "hp" | "mp"
//   amount    : the value lost (already post-clamp / post-affinity)
//   affinity  : "NE" | "VU" | "RS" | ... (HP only; ignored for MP)
export function playResourceLossVfx({ tokenUuid, resource = "hp", amount = 0, affinity = "NE", element = "elementless", isCrit = false, pierce = false } = {}) {
  try {
    if (!(amount > 0)) return;
    // Floating NUMBER → BD-native damage-number subsystem (DOM screen-space).
    // Carries the affinity (WEAK!/RESIST tag), element (numeral color), and crit
    // (gold CRITICAL banner). Renders + broadcasts on its own.
    emitDamageNumber({ kind: "loss", tokenUuid, resource, amount, affinity, element, isCrit, pierce });
    // Token hurt flinch — only for a real physical-ish hit (HP / shield), not an
    // MP drain. Strong tier on WEAK/crit.
    if (resource === "hp" || resource === "shield") fireHurt(tokenUuid, affinity, isCrit);
    // Impact burst + affinity SFX — both BD-native now (DOM <video> + Web Audio).
    const { file, sfx } = resolveLossAv(resource, affinity);
    emitImpactFx({ tokenUuid, file, durationMs: 1000 });
    if (sfx) throttledSfx(sfx, 0.6);
  } catch (e) {
    warn("playResourceLossVfx threw", e);
  }
}

// ── Resource-gain VFX (healing / restore, director-controlled) ────────────
//
// The recover counterpart to playResourceLossVfx: when the director RESTORES a
// resource on a creature — an HP/MP heal, an AB absorb-flip, or a `grant` of
// any resource (HP / MP / IP / Zenit / FP / ...) — we float a recover number
// over the token with a soft heal effect + cue. Same single-screen-friendly
// Sequencer broadcast + graceful no-op rules as the loss VFX.
//
// Fired from the director's healing write points (applyDamageToTarget AB-flip
// + the `grant` effect handler in skill-effects.js), so it stays under Battle
// Director control — losses and gains from the legacy pipeline keep their own
// numbers, exactly as the user scoped the loss VFX.

const RESOURCE_VFX_HEAL_SFX = Object.freeze({
  heal:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Heal3.ogg",
  mpAbsorb: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/AbsorbElement.ogg",
  // Coin / cash cue (same asset the shop system uses for a purchase) — fits a
  // Zenit gain better than the soft heal chime.
  coin:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/UI_SEWorldDollar.wav",
});
const HEAL_HP_FILE = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm";
const HEAL_MP_FILE = "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Blue_400x400.webm";

// Per-resource gain look. HP/MP carry the legacy heal webms; other resources
// float a colored number + a soft heal cue (no aura webm — a green burst over
// a token for gaining Zenit reads oddly). `null` file ⇒ number + sound only.
const RESOURCE_GAIN_AV = Object.freeze({
  hp:         { file: HEAL_HP_FILE, color: "#00FF00", icon: "❤️", sfx: RESOURCE_VFX_HEAL_SFX.heal },
  mp:         { file: HEAL_MP_FILE, color: "#00ABFF", icon: "💧", sfx: RESOURCE_VFX_HEAL_SFX.mpAbsorb },
  ip:         { file: null,         color: "#9be15d", icon: "🎒", sfx: RESOURCE_VFX_HEAL_SFX.heal },
  zenit:      { file: null,         color: "#ffd700", icon: "💰", sfx: RESOURCE_VFX_HEAL_SFX.coin },
  fp:         { file: null,         color: "#ffe066", icon: "✨", sfx: RESOURCE_VFX_HEAL_SFX.heal },
  zero_power: { file: null,         color: "#c792ea", icon: "⚡", sfx: RESOURCE_VFX_HEAL_SFX.heal },
  enmity:     { file: null,         color: "#ff8a65", icon: "🔥", sfx: RESOURCE_VFX_HEAL_SFX.heal },
});
const RESOURCE_GAIN_DEFAULT = Object.freeze({ file: null, color: "#9be15d", icon: "⬆️", sfx: RESOURCE_VFX_HEAL_SFX.heal });

// Float a recover number over a token + (for HP/MP) a heal aura + cue.
//   tokenUuid : the healed token ("Scene.X.Token.Y")
//   resource  : "hp" | "mp" | "ip" | "zenit" | "fp" | "zero_power" | "enmity"
//   amount    : the value restored (already clamped to what actually applied)
export function playResourceGainVfx({ tokenUuid, resource = "hp", amount = 0 } = {}) {
  try {
    if (!(amount > 0)) return;
    // Floating number → BD-native subsystem; heal aura webm + cue stay here.
    emitDamageNumber({ kind: "gain", tokenUuid, resource, amount });
    const av = RESOURCE_GAIN_AV[String(resource).toLowerCase()] ?? RESOURCE_GAIN_DEFAULT;
    if (av.file) emitImpactFx({ tokenUuid, file: av.file, durationMs: 1000 });
    if (av.sfx) throttledSfx(av.sfx, 0.6);
  } catch (e) {
    warn("playResourceGainVfx threw", e);
  }
}

// ── Resource-spend VFX (self-paid cost: casting / reaction / free action) ─
//
// The cost counterpart to the loss/gain floats. When a creature PAYS a
// resource of its own free will — a skill/spell casting cost (debitCost) or
// a reaction / free-action cost (consume_resource) — we float a `−N` number
// over the payer's token with a soft spend cue. Deliberately distinct from
// the LOSS VFX: NO orange impact webm and NO "ouch" hit sound, so paying a
// cost never reads as taking damage. Just the resource-tinted number + a
// light magical/coin cue.
//
// Same Sequencer-broadcasts-to-all-clients + graceful no-op rules as the
// other resource VFX.

// Per-resource spend look. `sfx` reuses cues already in the preload set
// (Dispel for magical spends, the coin for Zenit) so no new asset warming
// is needed. Number only — no aura webm (a burst over a token for spending
// IP/Zenit reads oddly).
const RESOURCE_SPEND_AV = Object.freeze({
  hp:         { color: "#ff5a5a", icon: "❤️", sfx: RESOURCE_VFX_SFX.mpSpend },
  mp:         { color: "#1e6cff", icon: "🌀", sfx: RESOURCE_VFX_SFX.mpSpend },
  ip:         { color: "#9be15d", icon: "🎒", sfx: RESOURCE_VFX_SFX.mpSpend },
  fp:         { color: "#ffe066", icon: "✨", sfx: RESOURCE_VFX_SFX.mpSpend },
  zenit:      { color: "#ffd700", icon: "💰", sfx: RESOURCE_VFX_HEAL_SFX.coin },
  zero_power: { color: "#c792ea", icon: "⚡", sfx: RESOURCE_VFX_SFX.mpSpend },
  enmity:     { color: "#ff8a65", icon: "🔥", sfx: RESOURCE_VFX_SFX.mpSpend },
});
const RESOURCE_SPEND_DEFAULT = Object.freeze({ color: "#cfd2da", icon: "⬇️", sfx: RESOURCE_VFX_SFX.mpSpend });

// Float a `−N` spend number over the payer's token + a soft cue.
//   tokenUuid : the payer's token ("Scene.X.Token.Y")
//   resource  : "hp" | "mp" | "ip" | "fp" | "zenit" | "zero_power" | "enmity"
//   amount    : the value spent (already resolved to what was actually debited)
export function playResourceSpendVfx({ tokenUuid, resource = "mp", amount = 0 } = {}) {
  try {
    if (!(amount > 0)) return;
    // Number-only event (no impact webm) — delegate the float, keep the soft cue.
    emitDamageNumber({ kind: "spend", tokenUuid, resource, amount });
    const av = RESOURCE_SPEND_AV[String(resource).toLowerCase()] ?? RESOURCE_SPEND_DEFAULT;
    if (av.sfx) throttledSfx(av.sfx, 0.45);
  } catch (e) {
    warn("playResourceSpendVfx threw", e);
  }
}

// ── Miss / Dodge VFX (attack or spell whiffs) ─────────────────────────────
//
// Director-native PORT of the legacy "Miss" macro's FX/SFX block
// (macros/Action Pipeline/Miss.js): a short "miss" flourish on the target
// token + a whiff sound. Fired per missed target from Attack RESOLVE and
// Skill RESOLVE (the `if (!r.hit) continue;` branch). The legacy macro also
// logged + posted a damage card; the director owns those elsewhere, so this
// port is the cinematic half only.
//
// Same Sequencer-broadcasts-to-all-clients + graceful no-op rules as the
// resource VFX above.

const MISS_SFX_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Miss.ogg";

// Float the "MISS" word (BD-native) + whiff sound.
//   tokenUuid : the token that dodged / was missed ("Scene.X.Token.Y")
export function playMissVfx({ tokenUuid } = {}) {
  try {
    // Big "MISS" word → BD-native subsystem. The whiff SOUND stays; the legacy
    // Sequencer visual (jb2a.ui.miss) is ITSELF a "MISS" text effect, so it would
    // double our word — dropped now that we own the miss feedback.
    emitDamageNumber({ kind: "miss", tokenUuid });
    throttledSfx(MISS_SFX_URL, 0.4);
  } catch (e) {
    warn("playMissVfx threw", e);
  }
}

// ── Block VFX (a HIT nullified to 0 by a defender reaction — Ninja Log) ─────
//
// The cinematic twin of playMissVfx, but for an attack that LANDED yet dealt 0
// because a defender's adjust_damage reaction (Ninja Log) soaked it. The loss
// VFX never fires (amount 0 → early-return), so the hit would otherwise land with
// no battlefield feedback. Float a steel "BLOCK" shield word + reuse the warmed
// parry/resist cue. Same broadcasts-to-all-clients + graceful no-op rules.
const BLOCK_SFX_URL = RESOURCE_VFX_SFX.resist;
export function playBlockVfx({ tokenUuid } = {}) {
  try {
    emitDamageNumber({ kind: "block", tokenUuid });
    throttledSfx(BLOCK_SFX_URL, 0.5);
  } catch (e) {
    warn("playBlockVfx threw", e);
  }
}

// ── Immune VFX (attack/spell zeroed by IM affinity) ───────────────────────
//
// Immunity forces the damage to 0, so the loss VFX never fires (it early-returns
// on amount<=0) and the hit would otherwise land with NO feedback at all. Float
// a steel "IMMUNE" tag + a parry/block cue. Text-only flourish (no webm) so it's
// robust without depending on any extra effect asset. Reuses the already-warmed
// Parry sound. Same broadcasts-to-all-clients + graceful no-op rules.
const IMMUNE_SFX_URL = RESOURCE_VFX_SFX.resist;
export function playImmuneVfx({ tokenUuid } = {}) {
  try {
    // "IMMUNE" tag → BD-native subsystem (number-only event); keep the cue.
    emitDamageNumber({ kind: "immune", tokenUuid });
    throttledSfx(IMMUNE_SFX_URL, 0.5);
  } catch (e) {
    warn("playImmuneVfx threw", e);
  }
}

// ── Absorb VFX (AB affinity flips damage to healing) ──────────────────────
//
// Distinct from a plain heal so an absorb doesn't masquerade as one: a cyan
// "ABSORB +N" over a BLUE aura + the absorb-element cue (vs the green ❤️ heal
// that playResourceGainVfx floats). Reuses the warmed AbsorbElement sound.
const ABSORB_FX_FILE = HEAL_MP_FILE;            // blue healing aura
const ABSORB_SFX_URL = RESOURCE_VFX_HEAL_SFX.mpAbsorb;
export function playAbsorbVfx({ tokenUuid, amount = 0 } = {}) {
  try {
    if (!(amount > 0)) return;
    // Green "ABSORB +N" → BD-native subsystem; blue aura + absorb cue stay here.
    emitDamageNumber({ kind: "absorb", tokenUuid, amount });
    emitImpactFx({ tokenUuid, file: ABSORB_FX_FILE, durationMs: 1000 });
    throttledSfx(ABSORB_SFX_URL, 0.6);
  } catch (e) {
    warn("playAbsorbVfx threw", e);
  }
}

// Warm-decode every resource-VFX cue into the Web Audio buffer cache so the
// FIRST hit / heal of a battle plays with no fetch+decode hitch. Called from
// runDirectorInit's preload step (while the curtain is up). Fire-and-forget;
// never throws.
export async function preloadDirectorSfx() {
  const urls = [
    ...Object.values(RESOURCE_VFX_SFX),
    ...Object.values(RESOURCE_VFX_HEAL_SFX),
    MISS_SFX_URL,                                                          // attack/spell whiff cue
    BATTLE_TRANSITION_SFX_URL,                                              // battle-start transition sting
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg", // Study cue
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/DashA.wav",     // party run-in dash cue
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav", // UI hover cue
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/switch_mode.wav",    // UI click cue
    ...INVOKE_SFX_URLS, // invoke-hud trait/bond/die/cancel/confirm cues
  ];
  try { await preloadSfx(urls); }
  catch (e) { warn("preloadDirectorSfx threw", e); }
}

// Stop the battle BGM at battle end. Stops exactly the track we started
// (tracked in _currentBgm); `fallbackName` (the payload's bgm name) covers the
// case where a mid-battle F5 cleared _currentBgm. Broadcasts via the playlist.
export async function stopBattleBgm(fallbackName) {
  try {
    if (_currentBgm) {
      const pl = game.playlists?.get?.(_currentBgm.playlistId);
      const snd = pl?.sounds?.get?.(_currentBgm.soundId);
      if (pl && snd) {
        try { await pl.stopSound(snd); log(`battle BGM stopped: ${pl.name} / ${snd.name}`); }
        catch (e) { warn("stopBattleBgm stopSound threw", e); }
      }
      _currentBgm = null;
    }
    const name = String(fallbackName ?? "").trim();
    if (name) {
      for (const pl of (game.playlists ?? [])) {
        const snd = pl.sounds?.getName?.(name);
        if (snd?.playing) { try { await pl.stopSound(snd); } catch {} }
      }
    }
  } catch (e) {
    warn("stopBattleBgm threw", e);
  }
}
