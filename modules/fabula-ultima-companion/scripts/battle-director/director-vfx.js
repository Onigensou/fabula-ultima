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

export const DIRECTOR_STATIC_URLS = Object.freeze([
  // Guard / Covered AE icons (Forge-vtt — remote, slowest first-fetch).
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/shield_oath.png",
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/intervene.png",

  // Study VFX: 4s green marker on the studied token + a "computer ping"
  // sound. The JB2A file is local-to-the-module but still ~1MB; preloading
  // saves the first-Study lag.
  "modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm",
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg",
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
    new Sequence()
      .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg")
      .play();
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
    // SFX — broadcast to all clients.
    try {
      const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      AH?.play?.({ src: BATTLE_TRANSITION_SFX_URL, volume: sfxVol, autoplay: true, loop: false }, true);
    } catch (e) {
      warn("battle transition SFX failed", e);
    }

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
