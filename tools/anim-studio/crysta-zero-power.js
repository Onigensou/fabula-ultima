// @desc Crysta Zero Power (Water-Moon Mirage): blackout, moonrise, pull-back, cut-in, dash, stab (oni)
"use strict";
// BEATS (the user's spec, phases 1 and 2 -- the whole cinematic through the hit):
//
//   1. the screen CUTS to black, like a switch, and holds there a beat
//   2. every token is hidden; the framing centres on the target
//   3. a bright moon (procedural disc + glow, no sprite) rises with the target's
//      BLACKENED silhouette centred inside it. Held 3 s. Crysta's blackened
//      silhouette stands BEHIND the target, facing it, OUTSIDE the moon -- black
//      on black, so she cannot be seen.
//   4. the camera pulls slowly toward her while the moon stays pinned to the
//      centre of frame (parallax), ending centred between the two of them: the
//      moon behind both, target left, Crysta revealed right.
//   5. a few seconds on that shot, then her ZERO POWER CUT-IN -- the players'
//      cut-in move, rebuilt in-scene (see beat 5 below for why not called).
//   6. she CLOSES the distance fast and stops HARD, sprites overlapping.
//   7. on that stop the screen flashes white and a single white line is drawn
//      across the WHOLE frame and gone -- the blade is never shown, only the cut.
//   8. one second later it resolves. On a MISS the blackout, the moon and both
//      silhouettes vanish in one frame, every hidden token returns in that same
//      frame, and the REAL camera pulls back out to exactly where it started.
//      The damage GATE deliberately waits for the world to come back, because
//      damage feedback is DOM pinned to the token's real map position. See the
//      note beside oni.fireDone().
//   9. on a HIT the cut reaches the moon: it parts along the same line the blade
//      drew, the top half drifting right and the bottom left, and one second
//      into that drift ripples break along the cut and spread, distorting it.
//  10. the light takes the frame mid-ripple, swallowing it. Two seconds
//      of nothing but white -- under which the composition is struck, every
//      token is put back and the real camera walks home -- then the white lifts
//      in under half a second onto the ordinary battlefield, and the damage
//      lands on that frame.
//
// ---------------------------------------------------------------------------
// FIVE DESIGN DECISIONS, each one a thing that would otherwise bite
//
// 1. THE CAMERA IS FAKE, AND THAT IS THE CORRECT CHOICE. Nothing calls
//    canvas.pan / animatePan. Instead a screen-locked container holds the whole
//    composition and the FOREGROUND slides while the moon stays put. Three
//    reasons: (a) this script runs on EVERY client via the pseudo socket, and
//    each client sits at its own pan and zoom -- a real pan would look different
//    for everyone and would leave each player's view moved when it ended;
//    (b) nothing needs restoring afterwards, so a mid-cinematic throw cannot
//    strand a player looking at the wrong corner of the map; (c) "moon pinned to
//    the centre of frame while the ground slides" IS the parallax the spec asks
//    for, and it is exactly one subtraction in this form.
//
// 2. THE COMPOSITION IS AUTHORED IN SCREEN PIXELS, NOT WORLD UNITS. oni.screen()
//    snapshots the stage transform ONCE, which is fine for a 300 ms whiteout and
//    wrong for a ~9 s cinematic: a player who pans or zooms mid-shot would drag
//    the black sheet off their own screen. Here a ticker re-syncs the root
//    container to the live stage transform every frame (position = the world
//    point under the screen centre, scale = 1/zoom), so children are placed in
//    screen px with the origin at screen centre and stay welded to the viewport
//    through any pan, zoom or resize. The guard removes itself once the
//    container is destroyed, so it cannot outlive a crash.
//
// 3. THE SILHOUETTES ARE CLONES, NOT FRESH SPRITES. oni.cloneToken shares the
//    token's already-decoded, already-playing texture, so there is NO fetch and
//    NO decode wait anywhere in this cinematic (oni.webmSprite would have cost
//    ~1.2 s of dead air before the fade could even start). tint = black turns a
//    shared texture into a silhouette without touching the original.
//
// 4. SIZE FROM THE MESH, CENTRE ON THE CONTENT BOX. The figures are drawn at
//    exactly their battle size (the token's rendered mesh in screen px), so the
//    two keep their real relative scale. But the opaque region is not centred
//    inside the frame -- Crysta's battler is 226x292 with only ~91.8% of that
//    height opaque and asymmetric padding -- so centring on the FRAME sits her
//    visibly low in the moon. The alpha scan supplies the correction, and it
//    runs before anything is on screen, so its few ms of blocked render never
//    show.
//
// 5. THE GEOMETRY IS HORIZONTAL BY CONSTRUCTION. "Behind the target" is taken as
//    the far side of the target from Crysta's real position, projected onto the
//    x axis -- a vertical stack of two silhouettes reads as nothing, and
//    "facing the target" only means anything left/right.
//
//    Whether beats 3 and 4 happen at all is decided by sepFrac, moonRadiusFrac,
//    glowScale and panFrac against the figures' BATTLE SIZE -- which is not a
//    constant at all, because it scales with the viewer's zoom. Measured live at
//    zoom 1.27 on a 1600x900 client, where Crysta's token renders 197x254 px:
//
//      beat 3, hidden:  her near edge = sepFrac*H - 98.5 = 405 px
//                       glow reach = moonRadiusFrac * glowScale * H = 361 px
//                       -> clears every lit pixel by ~44 px
//      beat 4, revealed: she ends 252 px off centre, spanning 153..350 against
//                       a disc of radius 306 -> ~77% of her width is backlit,
//                       the rest falls off the rim into black
//      the target, 131x140, sits well inside the 612 px disc throughout
//
//    That 44 px of clearance is what zoom eats: at ~1.85 and above she is drawn
//    wide enough to catch the halo during the hold. The shared fit factor
//    below exists solely to stop that, and it shrinks BOTH figures together so
//    the relative scale the battle-size rule buys is never lost.
//
//    So "inside the moon" is true of the TARGET at beat 3 and NOT true of
//    either figure at the end of beat 4 -- they straddle the rim, and because
//    both face left her lit side is her FRONT while his is his BACK. That is
//    worth keeping on purpose; it is not what "centred between them" would have
//    predicted.
//
//    The valid window for sepFrac is roughly [0.47, 0.68] at this zoom: below it
//    she is lit during the 3 s hold, above it her centre leaves the disc and the
//    reveal never happens. Change charScale, glowScale or moonRadiusFrac and
//    that window moves -- re-derive it, do not eyeball it. A WIDE caster eats
//    the same margin a high zoom does: past ~290 px of rendered width she is
//    clamped rather than shown early.
// ---------------------------------------------------------------------------
(async () => {
  const CFG = {
    // ---- beat 1: fade to black ----
    // The cut stays instant; the sound is what gives it weight. A short bell
    // (1.05 s) rather than a darkness sting -- it decays instead of hitting,
    // which is what keeps the cut from reading as a game sound effect.
    // Auditioned alternatives in the same library: Blow1..3 (a blown-out
    // candle), Close1..3, Water_Drop, Bell1 (2.78 s, still ringing under the
    // moon), Wind5, Silence. Blank to silence it entirely.
    // Folder-qualified: BOTH Sound/ and Sound/Soundboard/ carry a "Bell1", and a
    // bare name resolves by manifest array order -- which a re-scrape can flip.
    blackoutSfx: "Soundboard/Bell1",
    blackoutSfxVol: 0.9,
    // 0 = a HARD CUT, like a light switch. Anything above ~80 ms stops reading
    // as a switch and starts reading as a dissolve.
    blackFadeMs: 0,
    blackColor: "#000000",
    blackHoldMs: 1000,      // a beat of nothing before the moon arrives

    // ---- beat 3: the moon, and the two silhouettes ----
    revealMs: 900,          // moon + silhouettes fade up
    moonHoldMs: 3000,       // the spec's three seconds, AFTER the reveal settles

    // All sizes are fractions of the SCREEN HEIGHT, so the shot composes the
    // same on any resolution or window size.
    moonRadiusFrac: 0.34,
    moonYFrac: 0.0,         // + moves the moon down
    // OFF by default, and the default is the spec: compose on the canvas centre,
    // exactly where Foundry's own camera would put the target.
    //
    // Turn it on and the composition (never the black sheet) shifts to the
    // middle of what the viewer can actually SEE -- the sidebar occludes 300 px
    // of the right and the scene controls ~110 px of the left, so a canvas-
    // centred shot sits noticeably right of frame with the sidebar open.
    // Measured live per client, so a collapsed sidebar or a player layout
    // composes correctly on its own.
    // Caveat, and the reason this is not the default: no element measures the
    // painted width honestly. On this client (1600x900) #controls reports 220 px
    // of reserved flyout room while .main-controls reports 38 px of bare list,
    // and the icons actually occupy ~110 px between them -- so the offset lands
    // near the visible centre without hitting it. Left off rather than shipping
    // an approximation the spec did not ask for.
    centerOnVisible: false,
    moonCore: "#ffffff",    // centre of the disc
    moonRim: "#e8f1ff",     // its edge -- a touch cool, so it is not a flat white
    glowScale: 1.18,        // halo radius as a multiple of the disc radius
    glowColor: "#cfe4ff",
    glowAlpha: 0.5,

    // Silhouettes are drawn at EXACTLY the size their tokens are on the battle
    // map -- the token's rendered mesh, converted to screen px at the viewer's
    // zoom -- so the two keep their true relative scale (Crysta 197x254 against
    // the Lightning Prism's 131x140, measured at zoom 1.27). charScale is a
    // uniform multiplier on top if the shot reads small; 1 = battle size.
    charScale: 1,
    charYFrac: 0.02,        // + drops both silhouettes; keeps eyes off dead centre
    silhouetteTint: "#000000",
    // How far behind the target Crysta stands, and the most delicate number in
    // the file: it is squeezed from both sides at once and its valid window is
    // only about [0.47, 0.68]. Design note 5 above has the derivation and the
    // measured margins -- read it before touching this, charScale, glowScale or
    // moonRadiusFrac, because all four move the same two bounds.
    sepFrac: 0.56,
    autoFace: true,         // false = keep whatever way the tokens already face

    // ---- beat 4: the pull-back ----
    panMs: 3400,            // "slowly"
    panFrac: 0.5,           // fraction of the gap the camera travels; 0.5 = the midpoint

    // ---- beat 5: the cut-in ----
    postPanHoldMs: 2000,    // the spec's "few seconds" holding the two of them
    // Where the cut-in portrait comes from, in order. "@actor.img" is the
    // ACTOR'S OWN PORTRAIT -- for Crysta that is the illustrated bust
    // (1020x795), which is a different asset in a different Forge bucket from
    // the pixel standing sprite her cut_in_* props all point at. Those three
    // props are identical to each other and to sprite_standard, so the players'
    // ZP cut-in shows the standing sprite; this one deliberately does not.
    cutinProps: ["@actor.img", "cut_in_zero_power", "cut_in_critical", "sprite_standard"],
    // Ported from the legacy player cut-in so this READS as the same move:
    // dim, flash, slide in from the left, hold, sweep off to the right.
    // The legacy 0.9 assumes a full-body STANDING sprite. The actor portrait is
    // a landscape bust (1020x795), and at 0.9 it would be 810 tall by 1039 wide
    // -- two thirds of the screen, with her head alone filling a quarter of it.
    cutinHeightRatio: 0.72,
    cutinInsetX: 220,       // resting distance from the left edge, px
    cutinBottomMargin: 40,
    cutinOffsetY: 0,        // + lifts the portrait
    cutinFlip: false,
    cutinDim: 0.6,          // black over the moon scene, under the portrait
    cutinFlashPeak: 0.9,
    cutinSlideInMs: 650,
    cutinHoldMs: 900,
    cutinSlideOutMs: 650,
    // WHAT A ZERO POWER ACTUALLY SOUNDS LIKE IN THIS WORLD.
    // Not what the code suggests: cutin-receiver.js has an SFX_URLS table with
    // zero_power -> ChargeAttack.ogg, and that is DEAD CONFIGURATION. Nothing
    // ever passes type:"zero_power" to cutinBroadcast -- the module's only
    // caller (CreateActionCard) passes "critical" -- so that entry has never
    // played. Surveyed the 26 Zero Power macros instead: NONE of them use the
    // cut-in system at all, they play their own audio, and 12 of them OPEN on
    // Overdrive.wav (15 use it somewhere). It is the signature by usage, and
    // ChargeAttack.ogg appears in none of them.
    cutinSfx: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Overdrive.wav",
    cutinSfxVol: 0.9,

    // ---- beat 6: the closing dash ----
    preCloseMs: 300,        // a breath after the portrait leaves
    // Fast and SHARP. inQuart accelerates harder than inCubic and still has
    // nothing decelerating it, so the last frame is by far the fastest -- that
    // is the whole of what makes the stop read as an impact rather than
    // an arrival.
    closeMs: 130,
    // How far her sprite ends up INSIDE the target's, in px. The dash stops on
    // an accelerating ease and nothing decelerates it, which is what makes the
    // stop read as hard rather than as an arrival.
    closeOverlapPx: 42,

    // ---- beat 7: the stab ----
    // OUR OWN STAB -- not an asset. A single white line drawn across the whole
    // screen and gone again. The blade is never shown; you see only the cut it
    // leaves, which is what sells "unseen". Procedural also means no fetch, no
    // decode, no autoplay, and none of the video traps the JB2A lance cost.
    stabLineColor: "#ffffff",
    stabLineCorePx: 3,        // solid core thickness
    stabLineGlowPx: 13,       // soft falloff above and below the core
    stabLineSpanFactor: 1.25, // multiple of screen WIDTH, so it overruns both edges
    stabSweepMs: 55,          // time for the cut to cross the screen
    stabLineHoldMs: 45,
    stabLineFadeMs: 110,
    stabAngle: 0,             // degrees off horizontal
    // The cut's sound. A LARGE slash hit rather than a swing, because nothing
    // swings on screen -- the blade is unseen and only its impact is. Others in
    // the manifest: SE_BTL_HitSlashM/S, Slash1..5, Sword1..5, SE_SWINGA..H.
    // This does NOT stack with the damage feedback the way the normal attacks'
    // SFX did: the gate is seconds later, after the blackout lifts.
    stabSfx: "SE_BTL_HitSlashL",
    stabSfxVol: 1,
    // The white flash on the stop, fired together with the cut.
    stabFlashPeak: 0.95,
    stabFlashInMs: 40,
    stabFlashOutMs: 190,

    // ---- beat 8: the branch ----
    postStabMs: 2000,         // beat held on the aftermath before hit/miss resolves
    // "" = take the outcome the payload carries (the real roll in play, the
    // Preview Bench's Outcome selector out of it). "hit" / "miss" override it,
    // which is only needed to pin a branch while tuning from the CFG box.
    forceOutcome: "",
    // MISS: everything comes back in a single frame; the camera holds on the
    // close framing while she reacts, and only pulls out as she withdraws.
    missZoomIn: 2.1,          // how far in the cut lands, as a multiple of the start zoom
    missZoomMs: 2100,         // the pull-back itself, and it runs UNDER the retreat
    // Signed offset between the world coming back and the MISS landing. 0 puts
    // them on the SAME FRAME, which is what this wants.
    //
    // Traced 2026-09-05 (fireDone / animationEnd / reveal all timestamped in one
    // run) because two indirect measurements disagreed: oni.fireDone() reaches
    // oni:animationEnd in 0 ms -- the outer's onceHook resolves in the same tick,
    // there is no pipeline to pre-empt. At 0 the gate and the reveal measured
    // 1 ms apart; the shipped 500 measured 645. A NEGATIVE value still works
    // (fire, wait, then reveal) if the cue ever needs pulling ahead of the
    // reveal, but do not use it to chase latency that is not there -- and note
    // that a short oni.wait is only as precise as the client's timers: 170 ms
    // asked for measured ~416 ms on a headless client.
    missDamageDelayMs: 0,
    // Her reaction. Sob.webm is the sobbing emote from the world's own RO emote
    // set -- the same folder the emote hotkeys use. Any name from that folder
    // works; this is the only value to change.
    missEmoteUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Sob.webm",
    missEmoteScale: 0.62,     // emote height as a fraction of her token's height
    missEmoteFlip: true,      // mirror it left-right
    // Where it sits, in fractions of her token height from her centre. Negative
    // y is up: this puts it beside her face rather than over her body.
    missEmoteOffX: 0.20,
    missEmoteOffY: -0.46,
    missRetreatDelayMs: 1000, // after the emote starts, she withdraws
    // The dissolve-and-re-form from the Mirage Strike attacks: she fades out
    // carrying AWAY from the target, then re-forms on her own mark, arriving
    // from behind it so each half is one continuous move rather than two stills.
    // THESE ARE THE SAME NUMBERS Moonlight Blade and Crescent Cut use for the
    // identical move (departPx/arrivePx 70, fadeOut 520, fadeIn 420) -- so she
    // drifts at 135 px/s out and 167 px/s back, exactly as she does there. The
    // first pass here used 130 px over the same 520 ms, i.e. 250 px/s, and read
    // as a lurch next to her other two moves.
    missRetreatPx: 70,
    missArrivePx: 70,
    missFadeOutMs: 520,
    missFadeInMs: 420,
    stabShakeMs: 260,
    stabShakeIntensity: 9,

    // ---- beat 9 (HIT ONLY): the moon is cut in half and parts ----
    // The white line at beat 7 crossed the WHOLE frame; this is that same cut
    // reaching the one thing behind everything. splitYFrac therefore defaults to
    // charYFrac -- the exact y the line was drawn at -- so the two read as one
    // stroke rather than as two unrelated events. Set it to moonYFrac instead if
    // you want a true geometric half.
    splitYFrac: 0.02,
    splitPauseMs: 260,        // the moon holds, whole, before it lets go
    splitDriftMs: 3600,       // the drift; inOutQuad, so it eases off rather than stopping dead
    splitDriftPx: 58,         // how far EACH half travels (top right, bottom left)

    // The ripple, opening in the middle one second after the drift starts. It is
    // SCHEDULED off the drift, not sequenced after it -- the two overlap.
    //
    // This DISTORTS THE MOON rather than drawing rings over it: a displacement
    // map of horizontal bands shears the image sideways, which is a reflection
    // breaking up on disturbed water -- the skill's own name. Measured 2026-09-05:
    // radial ripple maps and ShockwaveFilter both read as a lumpy RIM here and
    // nothing else, because this moon is a flat opaque plateau and a displacement
    // filter can only show what has detail under it. The disc's edges are the
    // only signal it has, and band-shear is what moves them. Give the moon a
    // textured surface and the radial forms become available again.
    rippleDelayMs: 1000,      // the spec's one second
    rippleRiseMs: 700,        // amplitude swelling in
    rippleHoldMs: 1200,       // held at full strength
    rippleFallMs: 1900,       // and dying away
    rippleAmpPx: 30,          // peak displacement, in screen px
    rippleRings: 4,           // concentric rings from each origin out to the map's edge
    rippleFlattenY: 1,        // 1 = truly circular; <1 squashes into ellipses
    // Several disturbances struck ALONG the cut rather than one in the middle.
    // They are ordered in the direction the blade travelled and staggered, so
    // the water breaks the way the stroke ran. Each is its own displacement
    // pass, and passes COMPOSE -- where two overlap the shear adds.
    rippleOrigins: 3,
    rippleAlongFrac: 0.80,    // how far out the outermost sit, in moon radii
    rippleStaggerMs: 240,     // between one origin and the next
    // The rings TRAVEL by the map growing: the whole concentric pattern scales
    // out from its own centre, which is what a ring expanding across water is.
    // Multiples of the moon's DIAMETER.
    rippleFromFrac: 0.40,
    rippleToFrac: 2.40,
    // Where the map's own falloff begins, as a fraction of its radius. Measured
    // 2026-09-05: a falloff peaking at the CENTRE puts the displacement on the
    // flat plateau, where it cannot be seen, and leaves ~3 px of 24 at the rim,
    // which is the only edge a flat disc has. Keep the plateau out past the rim.
    rippleEdge: 0.74,
    rippleXFrac: 0,           // nudge the centre off the moon's, in screen heights
    rippleYFrac: 0,
    rippleTexSize: 512,

    // ---- beat 10 (HIT): the white-out, and the world coming back ----
    // The rise runs UNDER the whole of beat 9 and its duration IS beat 9's, by
    // construction -- so "white by the end" cannot drift out of true when the
    // drift or the ripple are retuned. Everything else then happens hidden: the
    // composition is struck, the tokens come back and the real camera walks home
    // with nothing on screen to see it.
    whiteColor: "#ffffff",
    whiteStartMs: 1600,       // measured from the DRIFT's start, so it lands 600 ms
                              // into the ripple: the rings bite, and then the light
                              // takes the frame while they are still spreading
    whiteRiseMs: 1200,        // the fade itself
    whiteHoldMs: 2000,        // the spec's two seconds of pure white
    whiteFadeOutMs: 420,      // "under half a second"
    camReturnMs: 600,         // the camera easing home, inside the white hold

    // How long an asset may take to decode before the shot gives up on it. This
    // is ALSO a term in the outer's completion budget, so the two cannot drift:
    // see the note beside toBranch for what happened when they did.
    assetSettleCapMs: 6000,

    moonTexSize: 512,
    glowTexSize: 512,
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  // hit/miss now RIDES the payload: the ANIMATION state runs after the accuracy
  // roll, so the FSM stamps payload.outcomes from the action result, and the
  // Anim Studio bench forges the same field from its Outcome selector -- which
  // is what makes the miss ending rehearsable outside combat. The live-director
  // read stays as the fallback for a payload built before that field existed.
  // The inner gets it through params either way.
  let outcomes = Array.isArray(P.outcomes) ? P.outcomes : [];
  if (!outcomes.length) {
    try {
      const dir = globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.();
      const rows = dir?.ctx?.actionResult?.perTargetResults;
      if (Array.isArray(rows)) {
        outcomes = rows.map((r) => ({ tokenUuid: r && r.tokenUuid, hit: !!(r && r.hit) }));
      }
    } catch (e) { console.warn("[ZeroPower] could not read hit/miss; assuming a hit.", e); }
  }

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  // INNER (runs on every client). No backticks and no dollar-brace in here --
  // it is a String.raw template and both would be eaten by the outer.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg || {};
    // The Preview Bench splices ITS OWN CFG box back into the script and only
    // repopulates that box on a selection change, so a box captured before this
    // file existed feeds undefined for every key it added. Unguarded that is not
    // an error, it is silence: moonRadiusFrac undefined makes moonR NaN, which
    // makes the disc, the glow and BOTH silhouettes render nothing, while
    // oni.wait(undefined) is setTimeout(fn, 0) so the 3 s hold evaporates. The
    // whole cinematic collapses to ~1.2 s of black with a clean console. Coerce
    // against defaults once, and say so out loud.
    const DEF = {
      blackFadeMs: 0, blackColor: '#000000', blackHoldMs: 1000,
      blackoutSfx: 'Soundboard/Bell1', blackoutSfxVol: 0.9,
      revealMs: 900, moonHoldMs: 3000,
      moonRadiusFrac: 0.34, moonYFrac: 0.0, moonCore: '#ffffff', moonRim: '#e8f1ff',
      glowScale: 1.18, glowColor: '#cfe4ff', glowAlpha: 0.5,
      centerOnVisible: false,
      charScale: 1, charYFrac: 0.02, silhouetteTint: '#000000',
      sepFrac: 0.56, autoFace: true,
      panMs: 3400, panFrac: 0.5,
      postPanHoldMs: 2000, cutinInsetX: 220,
      cutinBottomMargin: 40, cutinOffsetY: 0, cutinFlip: false, cutinDim: 0.6,
      cutinHeightRatio: 0.72,
      cutinFlashPeak: 0.9, cutinSlideInMs: 650, cutinHoldMs: 900, cutinSlideOutMs: 650,
      cutinProps: ['@actor.img', 'cut_in_zero_power', 'cut_in_critical', 'sprite_standard'],
      cutinSfx: '', cutinSfxVol: 0.9,
      preCloseMs: 300, closeMs: 130, closeOverlapPx: 42,
      // These MUST mirror the CFG above. DEF exists for keys a stale Bench box
      // is missing -- which is exactly the phase-2 keys -- so a DEF that has
      // drifted plays a different beat instead of the shipped one. stabAsset ''
      // in particular meant "no lance at all", silently.
      stabLineColor: '#ffffff', stabLineCorePx: 3, stabLineGlowPx: 13,
      stabLineSpanFactor: 1.25, stabSweepMs: 55, stabLineHoldMs: 45, stabLineFadeMs: 110,
      stabAngle: 0, stabSfx: 'SE_BTL_HitSlashL', stabSfxVol: 1,
      stabFlashPeak: 0.95, stabFlashInMs: 40, stabFlashOutMs: 190,
      stabShakeMs: 260, stabShakeIntensity: 9,
      postStabMs: 2000, forceOutcome: '',
      missZoomIn: 2.1, missZoomMs: 2100, missDamageDelayMs: 0,
      missEmoteUrl: 'https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/RO/Sob.webm',
      missEmoteScale: 0.62, missEmoteFlip: true, missEmoteOffX: 0.20, missEmoteOffY: -0.46,
      missRetreatDelayMs: 1000, missRetreatPx: 70, missArrivePx: 70,
      missFadeOutMs: 520, missFadeInMs: 420,
      splitYFrac: 0.02, splitPauseMs: 260, splitDriftMs: 3600,
      splitDriftPx: 58,
      rippleDelayMs: 1000, rippleRiseMs: 700, rippleHoldMs: 1200, rippleFallMs: 1900,
      rippleAmpPx: 30, rippleRings: 4, rippleFlattenY: 1,
      rippleOrigins: 3, rippleAlongFrac: 0.80, rippleStaggerMs: 240,
      whiteColor: '#ffffff', whiteStartMs: 1600, whiteRiseMs: 1200, whiteHoldMs: 2000,
      whiteFadeOutMs: 420, camReturnMs: 600,
      rippleFromFrac: 0.40, rippleToFrac: 2.40, rippleEdge: 0.74,
      rippleXFrac: 0, rippleYFrac: 0, rippleTexSize: 512,
      assetSettleCapMs: 6000, moonTexSize: 512, glowTexSize: 512,
    };
    const C = {};
    const stale = [];
    for (const k in DEF) {
      const v = cfg[k];
      let good = (typeof v === typeof DEF[k]) && (typeof v !== 'number' || isFinite(v));
      // typeof alone lets null, [], and a wrong-shaped object through as
      // 'object'. A partial stabContentBox is the dangerous one: box.w missing
      // makes anchor.set(NaN, NaN) and the lance vanishes without a word.
      if (good && DEF[k] && typeof DEF[k] === 'object') {
        if (Array.isArray(DEF[k])) good = Array.isArray(v);
        else good = !!v && !Array.isArray(v) &&
          Object.keys(DEF[k]).every((kk) => typeof v[kk] === 'number' && isFinite(v[kk]));
      }
      if (good) C[k] = v;
      else { C[k] = DEF[k]; stale.push(k); }
    }
    if (stale.length) {
      console.warn('[ZeroPower] CFG keys missing or invalid, falling back to defaults:',
        stale.join(', '),
        '-- in the Preview Bench this means a STALE CFG box: flip the item dropdown away and back.');
    }

    const caster = oni.caster;
    const target = oni.targets[0] || null;

    // The gate must fire on EVERY path. Miss it and this outer's own onceHook
    // times out, which costs preDone + 6 s of dead air before damage lands --
    // BD's 35 s failsafe never gets a look in, because the outer resolves first.
    // On the happy path it fires at the very end (see beat 7); the try/finally
    // below is what covers a throw anywhere in between.
    if (!caster || !target) {
      console.warn('[ZeroPower] needs a caster AND a target to stage the moon; nothing to show.');
      try { ui.notifications.warn('Zero Power: no target selected.'); } catch (e) {}
      oni.fireDone();
      return;
    }

    // Everything from here is inside a try/finally whose ONLY job is the gate.
    // An inner-script throw is SWALLOWED (the pseudo listener plays the inner
    // without awaiting it) and the listener's own finally then runs
    // oni.dispose(), so a crash renders as the black sheet vanishing and tokens
    // snapping back -- a visual "pop", never an error -- followed by a silent
    // stall until the outer times out. fireDone is idempotent (the outer listens
    // with Hooks.once), so the beat-accurate call at the end of the pan still
    // decides WHEN damage lands; this only decides that it lands at all.
    try {

    // ---- helpers ------------------------------------------------------------

    const hexNum = (h) => {
      const n = parseInt(String(h || '').replace('#', ''), 16);
      return isFinite(n) ? n : 0xffffff;
    };
    const rgba = (h, a) => {
      const n = hexNum(h);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    };

    // A radial gradient baked to a texture. Multi-stop, unlike oni.radialTexture
    // (two stops), because both the disc and the halo need a plateau: a plain
    // linear falloff gives a fuzzy blob, and a moon has to have an EDGE.
    // Cached for the SESSION, not for the cast. PIXI.Texture.from(canvas)
    // registers in TextureCache/BaseTextureCache, and the container teardown
    // calls destroy({children:true}) -- which frees the SPRITES but not their
    // textures (only destroy({texture:true}) would, and nothing passes that).
    // Built per cast these would leak ~2 MB of VRAM and two cache entries every
    // single time the Zero Power fires. Two fixed textures per session instead.
    const texCache = (globalThis.__ZP_TEX = globalThis.__ZP_TEX || {});
    const radialTex = (size, stops) => {
      const key = size + ':' + JSON.stringify(stops);
      const hit = texCache[key];
      if (hit && !hit.destroyed && hit.baseTexture && !hit.baseTexture.destroyed) return hit;
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const g2 = cv.getContext('2d');
      const r = size / 2;
      const grad = g2.createRadialGradient(r, r, 0, r, r, r);
      for (let i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
      g2.fillStyle = grad;
      g2.fillRect(0, 0, size, size);
      const tex = PIXI.Texture.from(cv);
      texCache[key] = tex;
      return tex;
    };

    const sourceOf = (tex) => {
      const r = tex && tex.baseTexture && tex.baseTexture.resource;
      return (r && (r.source || r.data)) || null;
    };
    const naturalOf = (tex) => {
      const bt = tex && tex.baseTexture;
      return {
        w: (bt && (bt.realWidth || bt.width)) || (tex && tex.width) || 0,
        h: (bt && (bt.realHeight || bt.height)) || (tex && tex.height) || 0,
      };
    };

    // Opaque content box as frame fractions. This walks every pixel rather than
    // breaking out of each row, because the HORIZONTAL extent is load-bearing:
    // the dash is specified as an overlap between the two figures, and a frame
    // half-width is not a figure half-width. Crysta's battler is 226x292 framed
    // but only 176 px wide opaque (77.9%), so overlapping FRAMES by 42 px
    // overlaps the visible art by about 7. A battler frame is ~66k px, single
    // digit ms, and this runs before anything is on screen.
    const scanV = (src, w, h) => {
      if (!src || !w || !h) return null;
      try {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g2 = cv.getContext('2d', { willReadFrequently: true });
        g2.drawImage(src, 0, 0, w, h);
        const d = g2.getImageData(0, 0, w, h).data;
        let minY = h, maxY = -1, minX = w, maxX = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 12) {
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (maxY < 0) return null;
        return { top: minY / h, h: (maxY - minY + 1) / h,
                 left: minX / w, w: (maxX - minX + 1) / w };
      } catch (e) { return null; }
    };

    // A texture from a URL is not measurable or drawable until it decodes, and a
    // VIDEO additionally needs a decoded FRAME. Everything this uses is created
    // during the opening fades so the decode never lands on a visible beat.
    const settle = async (spr, video, ms) => {
      if (video) {
        await new Promise((res) => {
          let fired = false;
          const fin = () => { if (fired) return; fired = true; res(); };
          if (video.readyState >= 2 && video.videoWidth > 0) return fin();
          try { video.addEventListener('loadeddata', fin, { once: true }); } catch (e) { fin(); }
          setTimeout(fin, ms);
        });
      }
      const bt = spr && spr.texture && spr.texture.baseTexture;
      if (!bt || bt.valid) return;
      await new Promise((res) => {
        let fired = false;
        const fin = () => { if (fired) return; fired = true; res(); };
        try { bt.once('loaded', fin); bt.once('update', fin); } catch (e) { fin(); }
        setTimeout(fin, ms);
      });
    };

    // Rewind a clip and start it, waiting for the SEEK to land first. Setting
    // currentTime = 0 and calling play() on the next line does not work on a
    // video that has ENDED: the seek is asynchronous, so playback resumes from
    // the end and the sprite shows its (empty) final frame.
    const restartVideo = (v, rate) => new Promise((res) => {
      if (!v) return res();
      let done = false, timer = null;
      const go = () => {
        if (done) return; done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { v.removeEventListener('seeked', go); } catch (e) {}
        try {
          v.playbackRate = rate || 1;
          const pr = v.play();
          if (pr && pr.catch) pr.catch(() => {});
        } catch (e) {}
        res();
      };
      try {
        v.pause();
        if (v.currentTime === 0) return go();
        v.addEventListener('seeked', go, { once: true });
        v.currentTime = 0;
        timer = setTimeout(go, 400);
      } catch (e) { go(); }
    });

    // The real camera, snapshotted before anything touches the screen. The
    // cinematic itself never moves it -- but the miss ending pulls back to
    // exactly this, so it has to be captured before the first frame.
    const vp = (canvas.scene && canvas.scene._viewPosition) || {};
    const cam0 = {
      x: isFinite(vp.x) ? vp.x : canvas.stage.pivot.x,
      y: isFinite(vp.y) ? vp.y : canvas.stage.pivot.y,
      scale: isFinite(vp.scale) ? vp.scale : (canvas.stage.scale.x || 1),
    };

    // ---- the screen-locked root --------------------------------------------
    // Children are placed in SCREEN PIXELS with the origin at the screen centre.
    // See design note 2: the sync runs every frame so a pan or a zoom by the
    // viewer cannot drag the composition off their own screen.

    const app = canvas.app;
    const H = app.renderer.screen.height;
    const W = app.renderer.screen.width;

    const root = oni.layer({ zIndex: 99000 });
    root.sortableChildren = true;

    // EVERY line of this runs 60x a second for ~9.7 s and reads canvas.stage and
    // app.renderer LIVE, so it must not be able to throw. PIXI's TickerListener
    // does not catch, and Ticker#_tick re-arms requestAnimationFrame only AFTER
    // update() returns -- so one exception here does not just skip a frame, it
    // aborts every lower-priority listener (PIXI's own render is LOW, i.e. after
    // this one) and schedules no next frame at all. The canvas freezes until F5.
    // A scene change or canvas teardown inside the window is all it would take.
    // Both other ticker callbacks in this stack (oni.hideToken's guard,
    // oni.tween's tick) already wrap their bodies; this one had not.
    const pt = new PIXI.Point();
    const syncRoot = () => {
      if (!root || root.destroyed) { try { app.ticker.remove(syncRoot); } catch (e) {} return; }
      try {
        const sc = app.renderer.screen;
        pt.set(sc.width / 2, sc.height / 2);
        // applyInverse writes into the second argument when given one; without
        // it PIXI allocates a fresh Point every frame (~580 over the shot). It
        // copies x/y to locals first, so aliasing pt as both in and out is safe.
        canvas.stage.worldTransform.applyInverse(pt, pt);
        const z = canvas.stage.scale.x || 1;
        root.position.set(pt.x, pt.y);
        root.scale.set(1 / z);
      } catch (e) {
        console.warn('[ZeroPower] screen-lock sync failed; dropping it rather than stalling the ticker', e);
        try { app.ticker.remove(syncRoot); } catch (e2) {}
      }
    };
    syncRoot();
    app.ticker.add(syncRoot);

    // ---- beat 1 scenery: the black sheet ------------------------------------
    // Oversized 3x so a mid-shot window resize cannot expose an edge.

    const bg = new PIXI.Graphics();
    bg.beginFill(hexNum(C.blackColor), 1);
    bg.drawRect(-1.5 * W, -1.5 * H, 3 * W, 3 * H);
    bg.endFill();
    bg.alpha = 0;
    bg.zIndex = 0;
    root.addChild(bg);

    // ---- beat 3 scenery: the moon -------------------------------------------

    // Everything that is COMPOSED lives in here, offset to the middle of the
    // visible area (see cfg.centerOnVisible). The black sheet deliberately stays
    // outside it: the sheet has to cover the whole window, not the framing.
    const visWidth = (el) => {
      if (!el) return 0;
      try {
        const r = el.getBoundingClientRect();
        return (r && r.width > 0 && r.height > 0) ? r.width : 0;
      } catch (e) { return 0; }
    };
    let visShift = 0;
    if (C.centerOnVisible) {
      // .main-controls is the icon column that is actually painted; #controls
      // measures 220 px because it reserves room for the sub-control flyout.
      const leftW = visWidth(document.querySelector('#controls .main-controls'))
                 || visWidth(document.getElementById('controls'));
      const rightW = visWidth(document.getElementById('sidebar'));
      visShift = (leftW - rightW) / 2;
    }

    const comp = new PIXI.Container();
    comp.zIndex = 1;
    comp.sortableChildren = true;
    comp.position.set(visShift, 0);
    root.addChild(comp);

    const moonWrap = new PIXI.Container();
    moonWrap.zIndex = 0;
    moonWrap.alpha = 0;
    moonWrap.position.set(0, C.moonYFrac * H);
    comp.addChild(moonWrap);

    const moonR = C.moonRadiusFrac * H;

    // Halo first, so the disc draws over its hot centre. ADD, because light on
    // black should build rather than replace.
    const glow = new PIXI.Sprite(radialTex(C.glowTexSize, [
      [0.00, rgba(C.glowColor, C.glowAlpha)],
      [0.55, rgba(C.glowColor, C.glowAlpha * 0.72)],
      [0.78, rgba(C.glowColor, C.glowAlpha * 0.22)],
      [1.00, rgba(C.glowColor, 0)],
    ]));
    glow.anchor.set(0.5);
    glow.width = moonR * 2 * C.glowScale;
    glow.height = moonR * 2 * C.glowScale;
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    moonWrap.addChild(glow);

    // The disc. Opaque to 0.985 then one stop to zero, which gives a crisp but
    // antialiased rim; a two-stop gradient here reads as a smudge, not a moon.
    // The core plateau runs most of the way out on purpose -- pulling it in to
    // ~0.6 (the first cut) shaded the disc from the centre and the whole thing
    // read as a spotlight rather than a body with an edge.
    const disc = new PIXI.Sprite(radialTex(C.moonTexSize, [
      [0.00, rgba(C.moonCore, 1)],
      [0.80, rgba(C.moonCore, 1)],
      [0.94, rgba(C.moonRim, 1)],
      [0.985, rgba(C.moonRim, 1)],
      [1.00, rgba(C.moonRim, 0)],
    ]));
    disc.anchor.set(0.5);
    disc.width = moonR * 2;
    disc.height = moonR * 2;
    moonWrap.addChild(disc);

    // ---- beat 3 subjects: the two silhouettes -------------------------------

    const fg = new PIXI.Container();
    fg.zIndex = 1;
    fg.alpha = 0;
    comp.addChild(fg);

    const renderX = (tok) => {
      const m = tok && tok.mesh;
      return (m && m.position && typeof m.position.x === 'number') ? m.position.x : tok.center.x;
    };

    // Which side of the target counts as BEHIND it: the far side from where
    // Crysta actually stands. Degenerate (self-target, or stacked tokens) falls
    // back to the right-hand side rather than dividing by a zero-length axis.
    const cx = renderX(caster);
    const tx = renderX(target);
    const sign = (Math.abs(cx - tx) < 1) ? 1 : ((cx <= tx) ? 1 : -1);
    // Positive scale.x is the LEFT-facing sense for these battler assets (the
    // convention Moonlight Blade landed on and plays correctly). Crysta stands
    // on the +sign side and looks back at the target, so she faces left exactly
    // when sign is positive -- and the target, still facing where she used to
    // be, happens to face the same way, which is what sells "behind you".
    const faceLeft = (sign > 0);

    // Battle size, in screen px. The mesh already carries whatever the token
    // actually shows (grid size, texture scale, any stretch), so taking its
    // width AND height keeps the rendered aspect rather than re-deriving one.
    const zoom0 = canvas.stage.scale.x || 1;
    const meshDim = (tok, k) => {
      const v = tok && tok.mesh ? Math.abs(tok.mesh[k]) : 0;
      return (v > 0 ? v : 100) * zoom0 * C.charScale;
    };
    const natW = (tok) => meshDim(tok, 'width');
    const natH = (tok) => meshDim(tok, 'height');

    // ONE shared shrink factor, never a per-figure one: the whole point of
    // drawing at battle size is that the two keep their real relative scale, and
    // clamping them independently would destroy exactly that.
    //
    // It exists because battle size tracks the VIEWER'S ZOOM, and the two beat
    // properties do not. Crysta is hidden only while her half-width fits inside
    // (sepFrac - glow reach); at the shipped numbers that is 143 px against her
    // 98 px, so she is fine here -- but a viewer zoomed past ~1.85 would have her
    // edge lit during the 3 s hold, which is the one thing beat 3 forbids. The
    // target has the matching bound: it has to sit inside the disc at beat 3.
    // Both are checked, the tighter one wins, and it only ever shrinks.
    const maxCasterHalfW = Math.max(1, (C.sepFrac - C.moonRadiusFrac * C.glowScale) * H * 0.92);
    const maxTargetHalf = Math.max(1, C.moonRadiusFrac * H * 0.80);
    const fit = Math.min(1,
      maxCasterHalfW / Math.max(1, natW(caster) / 2),
      maxTargetHalf / Math.max(1, natW(target) / 2),
      maxTargetHalf / Math.max(1, natH(target) / 2));
    if (fit < 1) {
      console.warn('[ZeroPower] battle-size silhouettes would break the framing at this zoom (' +
        Math.round(zoom0 * 100) / 100 + '); scaling both by ' + (Math.round(fit * 100) / 100) +
        ' to keep Crysta unlit during the hold and the target inside the moon.');
    }

    const makeSilhouette = (tok, offsetFrac) => {
      const spr = oni.cloneToken(tok, { parent: fg });
      if (!spr) return null;
      spr.tint = hexNum(C.silhouetteTint);
      spr.anchor.set(0.5, 0.5);
      // cloneToken folds in the token's rotation, which is right when the clone
      // stands where the token stands and wrong here: this composition is
      // entirely synthetic, and a target with rotation 90 would lie on its side
      // inside the moon.
      spr.angle = 0;

      const n = naturalOf(spr.texture);
      // Measured content, with Crysta's battler as the fallback if the frame
      // cannot be read (a video with no decoded frame yet, or a tainted canvas).
      // Only used to CENTRE the figure now -- the size comes from the mesh.
      const box = scanV(sourceOf(spr.texture), n.w, n.h)
        || { top: 0.0651, h: 0.9178, left: 0.1106, w: 0.7788 };  // Crysta's battler, measured
      const frameH = natH(tok) * fit;

      spr.height = frameH;
      spr.width = natW(tok) * fit;
      // PIXI's width setter preserves the sign of scale.x, so the mirror the
      // clone inherited survives to here; take the absolute and decide fresh.
      if (C.autoFace) spr.scale.x = Math.abs(spr.scale.x) * (faceLeft ? 1 : -1);

      // Centre the CONTENT on the mark, not the frame: the opaque region is not
      // centred in the frame, so anchoring on the frame sits the figure low.
      const contentOffY = (box.top + box.h / 2 - 0.5) * frameH;
      spr.position.set(offsetFrac * H, C.charYFrac * H - contentOffY);
      // Half-width of the VISIBLE art, which is what closeOverlapPx is measured
      // against. Stashed here so the dash does not have to re-scan.
      spr.__halfW = Math.abs(spr.width) * (box.w || 1) / 2;
      return spr;
    };

    const targetSil = makeSilhouette(target, 0);
    const crystaSil = makeSilhouette(caster, sign * C.sepFrac);
    // cloneToken returns null when a token's mesh has no texture yet (art still
    // loading, placeable not drawn). The shot then plays with an empty moon or
    // with no Crysta and looks like a tuning mistake, so say which one is gone.
    if (!targetSil || !crystaSil) {
      console.warn('[ZeroPower] a silhouette could not be cloned from its token mesh:',
        { target: !!targetSil, crysta: !!crystaSil });
    }

    // ---- cut-in + stab surfaces, built NOW so their decodes land in the dark --
    // Both are remote assets. The portrait is a CDN PNG and the lance a webm;
    // creating them here means the ~1 s of fetch happens under the black sheet
    // instead of stalling the beat that needs them, ~12 s later.

    const cutinDimG = new PIXI.Graphics();
    cutinDimG.beginFill(0x000000, 1);
    cutinDimG.drawRect(-1.5 * W, -1.5 * H, 3 * W, 3 * H);
    cutinDimG.endFill();
    cutinDimG.alpha = 0;
    cutinDimG.zIndex = 2;
    root.addChild(cutinDimG);

    // The real cut-in stacks dim and flash BELOW the portrait (port.zIndex 2
    // over both at 0), so the flash lights the portrait rather than washing it
    // out. Same order here: dim 2, flash 3, portrait 4.
    const cutinLayer = new PIXI.Container();
    cutinLayer.zIndex = 4;
    root.addChild(cutinLayer);

    const flashG = new PIXI.Graphics();
    flashG.beginFill(0xffffff, 1);
    flashG.drawRect(-1.5 * W, -1.5 * H, 3 * W, 3 * H);
    flashG.endFill();
    flashG.alpha = 0;
    flashG.zIndex = 3;
    root.addChild(flashG);

    let cutinSpr = null;
    let cutinReady = Promise.resolve();
    let cutinUrl = '';
    try {
      const props = (caster.actor && caster.actor.system && caster.actor.system.props) || {};
      const names = Array.isArray(C.cutinProps) ? C.cutinProps : [];
      for (let i = 0; i < names.length && !cutinUrl; i++) {
        const key = names[i];
        // "@actor.img" is the actor's portrait field rather than a CSB prop.
        const v = (key === '@actor.img') ? (caster.actor && caster.actor.img) : props[key];
        if (typeof v === 'string' && v.trim()) cutinUrl = v.trim();
      }
      console.log('[ZeroPower] cut-in art:', cutinUrl || '(none)');
    } catch (e) { console.warn('[ZeroPower] could not resolve cut-in art', e); }
    if (cutinUrl) {
      cutinSpr = new PIXI.Sprite(PIXI.Texture.from(cutinUrl));
      cutinSpr.anchor.set(0.5, 1);
      cutinSpr.alpha = 0;
      cutinLayer.addChild(cutinSpr);
      cutinReady = settle(cutinSpr, null, C.assetSettleCapMs);
    } else {
      console.warn('[ZeroPower] no cut-in art on this actor; the cut-in beat will be skipped.');
    }

    // Her reaction emote, built now for the same reason as everything else: it
    // is a remote webm, and PIXI's VideoResource autoplays on construction, so
    // it runs out long before its cue. Park it at frame 0 and it is ready.
    // It lives in a WORLD-space layer, not the screen-locked root -- by the time
    // it plays the composition is gone and it has to sit on her actual token.
    const emoteLayer = oni.layer({ zIndex: 98000 });
    let emote = null;
    let emoteVid = null;
    let emoteReady = Promise.resolve();
    if (C.missEmoteUrl) {
      const made = oni.webmSprite(C.missEmoteUrl, { loop: true, parent: emoteLayer, autoplay: false });
      emote = made.sprite;
      emoteVid = made.video;
      emote.alpha = 0;
      emote.anchor.set(0.5, 0.5);
      emoteReady = settle(emote, emoteVid, C.assetSettleCapMs).then(async () => {
        if (!emoteVid || emoteVid.readyState < 2) {
          console.warn('[ZeroPower] the sob emote never buffered a frame (readyState ' +
            (emoteVid ? emoteVid.readyState : '?') + '); the miss beat will skip it.');
          return;
        }
        try { emoteVid.pause(); } catch (e) {}
        await restartVideo(emoteVid, 1);
        try { emoteVid.pause(); emoteVid.currentTime = 0; } catch (e) {}
      });
    }

    // The cut itself: a white line with a solid core and a soft falloff, built
    // as a 1-pixel-wide gradient strip and stretched across the screen. It lives
    // in comp rather than fg, because it spans the WHOLE frame and must not
    // inherit the pull-back's offset.
    const lineH = Math.max(2, C.stabLineCorePx + C.stabLineGlowPx * 2);
    const lineTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 1; cv.height = lineH;
      const g2 = cv.getContext('2d');
      const core = C.stabLineCorePx / lineH;
      const c0 = (1 - core) / 2, c1 = (1 + core) / 2;
      const grad = g2.createLinearGradient(0, 0, 0, lineH);
      grad.addColorStop(0, rgba(C.stabLineColor, 0));
      grad.addColorStop(Math.max(0.001, c0 * 0.55), rgba(C.stabLineColor, 0.28));
      grad.addColorStop(c0, rgba(C.stabLineColor, 1));
      grad.addColorStop(c1, rgba(C.stabLineColor, 1));
      grad.addColorStop(Math.min(0.999, c1 + (1 - c1) * 0.45), rgba(C.stabLineColor, 0.28));
      grad.addColorStop(1, rgba(C.stabLineColor, 0));
      g2.fillStyle = grad;
      g2.fillRect(0, 0, 1, lineH);
      return PIXI.Texture.from(cv);
    })();
    const cutLine = new PIXI.Sprite(lineTex);
    cutLine.alpha = 0;
    cutLine.zIndex = 2;
    comp.addChild(cutLine);

    // ---- 1. the whole screen fades to black ---------------------------------

    if (C.blackoutSfx) { try { oni.sfx(C.blackoutSfx, { volume: C.blackoutSfxVol }); } catch (e) {} }
    await oni.tween({
      duration: C.blackFadeMs, ease: oni.EASE.inOutQuad,
      onUpdate: (v) => { bg.alpha = v; },
    });
    bg.alpha = 1;

    // ---- 2. set the scene: hide every token ---------------------------------
    // The sheet already covers them; this is belt AND braces, and it is what
    // makes the un-hide in the tail able to happen behind the black.

    const restores = [];
    let restoreCaster = () => {};
    const placeables = (canvas.tokens && canvas.tokens.placeables) ? canvas.tokens.placeables : [];
    for (let i = 0; i < placeables.length; i++) {
      const r = oni.hideToken(placeables[i]);
      // Hers is held back: on the miss path every OTHER token returns with the
      // world, but she stays hidden and is played by a stand-in until she has
      // finished withdrawing to her real mark.
      if (placeables[i] === caster) restoreCaster = r; else restores.push(r);
    }

    // Hold on nothing. The hide above is instantaneous and happens under an
    // already-opaque sheet, so this reads as the dark simply sitting there
    // before the moon arrives.
    await oni.wait(C.blackHoldMs);

    // ---- 3. the moon, with the target inside it -----------------------------

    await oni.tween({
      duration: C.revealMs, ease: oni.EASE.outQuad,
      onUpdate: (v) => { moonWrap.alpha = v; fg.alpha = v; },
    });
    moonWrap.alpha = 1;
    fg.alpha = 1;

    await oni.wait(C.moonHoldMs);

    // ---- 4. pull back behind the target -------------------------------------
    // The camera travels +sign; the world therefore travels -sign. The moon is
    // NOT in fg, so it stays pinned to the centre of frame: that difference is
    // the whole parallax.

    const panDist = -sign * C.sepFrac * C.panFrac * H;
    await oni.tween({
      duration: C.panMs, ease: oni.EASE.inOutQuad,
      onUpdate: (v) => { fg.x = panDist * v; },
    });
    fg.x = panDist;

    // ---- 5. hold on the two of them, then the CUT-IN ------------------------
    // A port of the players' Zero Power cut-in (cutin-receiver.js
    // playCutInFromCache): dim, flash, slide in from the left, hold, sweep off
    // the right. Rebuilt inside this composition rather than CALLED, because
    // the real one paints its own layer at z-index 100000 with its own black
    // dim -- over a cinematic that is already black, that fights this scene
    // instead of joining it, and it would not dispose with the rest.

    await oni.wait(C.postPanHoldMs);

    if (cutinSpr) {
      await cutinReady;
      const n = naturalOf(cutinSpr.texture);
      // Sprite.width divides by texture.orig.width, which is 0 on a texture that
      // never validated (404, or a decode slower than the settle cap) -- that
      // makes scale Infinity and the vertices NaN. naturalOf's fallback only
      // guards the ASPECT, not this.
      if (!(n.w > 0 && n.h > 0)) {
        console.warn('[ZeroPower] the cut-in portrait never decoded; skipping that beat.');
        cutinSpr.alpha = 0;
        cutinSpr = null;
      }
    }
    if (cutinSpr) {
      const n = naturalOf(cutinSpr.texture);
      const ar = (n.w || 1) / (n.h || 1);
      const ph = C.cutinHeightRatio * H;
      cutinSpr.height = ph;
      cutinSpr.width = ph * ar;
      if (C.cutinFlip) cutinSpr.scale.x = -Math.abs(cutinSpr.scale.x);
      // Anchored on its own centre so the mirror flips the ART and never
      // displaces the sprite; positions are therefore centre-x, bottom-y.
      const halfW = Math.abs(cutinSpr.width) / 2;
      const restX = -W / 2 + C.cutinInsetX + halfW;
      const startX = -W / 2 - halfW - 80;
      const exitX = W / 2 + halfW + 40;
      cutinSpr.position.set(startX, H / 2 - C.cutinBottomMargin - C.cutinOffsetY);
      cutinSpr.alpha = 1;

      if (C.cutinSfx) { try { oni.sfx(C.cutinSfx, { volume: C.cutinSfxVol }); } catch (e) {} }

      oni.tween({ duration: 200, ease: oni.EASE.outQuad,
        onUpdate: (v) => { cutinDimG.alpha = v * C.cutinDim; } });
      oni.tween({ duration: 320, ease: oni.EASE.outQuad,
        onUpdate: (v) => { flashG.alpha = C.cutinFlashPeak * (v < 0.25 ? v / 0.25 : (1 - v) / 0.75); } })
        .then(() => { flashG.alpha = 0; });

      await oni.tween({ duration: C.cutinSlideInMs, ease: oni.EASE.outCubic,
        onUpdate: (v) => { cutinSpr.x = startX + (restX - startX) * v; } });
      cutinSpr.x = restX;

      await oni.wait(C.cutinHoldMs);

      await Promise.all([
        oni.tween({ duration: C.cutinSlideOutMs, ease: oni.EASE.inCubic,
          onUpdate: (v) => { cutinSpr.x = restX + (exitX - restX) * v; cutinSpr.alpha = 1 - v * 0.9; } }),
        oni.tween({ duration: 300, ease: oni.EASE.inQuad,
          onUpdate: (v) => { cutinDimG.alpha = C.cutinDim * (1 - v); } }),
      ]);
      cutinSpr.alpha = 0;
      cutinDimG.alpha = 0;
    }

    // ---- 6. she closes the distance, and STOPS -------------------------------
    // inCubic accelerates the whole way and nothing decelerates it, so the last
    // frame of the dash is also its fastest: the stop reads as an impact rather
    // than as an arrival. The end position overlaps the two sprites by
    // closeOverlapPx, measured edge into edge.

    await oni.wait(C.preCloseMs);

    let contactX = 0;
    if (crystaSil) {
      const fromX = crystaSil.x;
      const tgtX = targetSil ? targetSil.x : 0;
      const halfCr = crystaSil.__halfW || Math.abs(crystaSil.width) / 2;
      const halfTg = targetSil ? (targetSil.__halfW || Math.abs(targetSil.width) / 2) : 0;
      let gap = Math.max(8, halfCr + halfTg - C.closeOverlapPx);
      // Never let the "dash" travel backwards: if the figures are so wide that
      // the resting gap exceeds where she already stands, closing in would move
      // her AWAY from the target.
      const startGap = Math.abs(fromX - tgtX);
      if (gap > startGap) gap = Math.max(8, startGap * 0.35);
      const toX = tgtX + sign * gap;
      await oni.tween({ duration: C.closeMs, ease: (t) => t * t * t * t,
        onUpdate: (v) => { crystaSil.x = fromX + (toX - fromX) * v; } });
      crystaSil.x = toX;
      contactX = tgtX;
    }

    // ---- 7. the STAB -- one white line across the whole screen --------------
    // The flash and the cut fire together, on the frame she stops. Nothing is
    // drawn of the blade itself.

    const dirRight = (sign < 0);          // she strikes toward the target
    const spanW = W * C.stabLineSpanFactor;
    cutLine.anchor.set(dirRight ? 0 : 1, 0.5);
    cutLine.height = lineH;
    cutLine.width = spanW;
    cutLine.angle = C.stabAngle * (dirRight ? 1 : -1);
    // Starts off the edge BEHIND her, so the cut enters frame already travelling
    // rather than being born at her hand.
    cutLine.position.set((dirRight ? -1 : 1) * spanW / 2, C.charYFrac * H);
    cutLine.alpha = 1;
    cutLine.scale.x = 0;
    const fullScaleX = spanW / (lineTex.orig ? lineTex.orig.width : 1);

    if (C.stabSfx) { try { oni.sfx(C.stabSfx, { volume: C.stabSfxVol }); } catch (e) {} }
    oni.screenshake({ duration: C.stabShakeMs, intensity: C.stabShakeIntensity });
    // Flash on the stop. Non-blocking: the cut has to travel underneath it.
    oni.tween({
      duration: C.stabFlashInMs, ease: oni.EASE.outQuad,
      onUpdate: (v) => { flashG.alpha = C.stabFlashPeak * v; },
    }).then(() => oni.tween({
      duration: C.stabFlashOutMs, ease: oni.EASE.inQuad,
      onUpdate: (v) => { flashG.alpha = C.stabFlashPeak * (1 - v); },
    })).then(() => { flashG.alpha = 0; });

    await oni.tween({
      duration: C.stabSweepMs, ease: oni.EASE.outQuad,
      onUpdate: (v) => { cutLine.scale.x = fullScaleX * v; },
    });
    cutLine.scale.x = fullScaleX;

    await oni.wait(C.stabLineHoldMs);
    await oni.tween({
      duration: C.stabLineFadeMs, ease: oni.EASE.outQuad,
      onUpdate: (v) => { cutLine.alpha = 1 - v; },
    });
    cutLine.alpha = 0;

    // ---- 8. one second, then it resolves ------------------------------------

    await oni.wait(C.postStabMs);

    const forced = String(C.forceOutcome || '').toLowerCase();
    let didHit = true;
    // The outcome the OUTER resolved -- payload.outcomes (the real roll in play,
    // the Preview Bench's Outcome selector out of it), falling back to the live
    // director -- handed down through params.
    const outs = (ctx.params && ctx.params.outcomes) || [];
    let source = 'no outcome data, assumed';
    if (forced === 'hit' || forced === 'miss') {
      didHit = (forced === 'hit');
      source = 'forced by CFG';
    } else {
      const tUuid = (target.document && target.document.uuid) || '';
      const row = outs.find ? outs.find((o) => o && o.tokenUuid === tUuid) : null;
      if (row) { didHit = !!row.hit; source = 'this target row'; }
      else if (outs.length) { didHit = !!outs[0].hit; source = 'first outcome row'; }
    }
    console.log('[ZeroPower] outcome:', didHit ? 'HIT' : 'MISS', '(' + source + ')');

    if (!didHit) {
      // ---- MISS ------------------------------------------------------------
      // THE HANDOFF HAS TO BE INVISIBLE, and that is the whole difficulty here.
      // The cinematic is SYNTHETIC: the two silhouettes stand next to each other
      // at the middle of the screen, while their real tokens are ~900 world
      // units apart with Crysta on the OPPOSITE side of the target. Restoring
      // the world naively therefore teleports both of them and jumps the frame.
      //
      // So the cut matches the frame instead of the map:
      //   - the silhouettes are already drawn at BATTLE SIZE, so no rescale is
      //     needed -- the cut keeps the starting zoom exactly;
      //   - the camera is panned so the target's real token lands on the exact
      //     screen pixel its silhouette occupied;
      //   - Crysta's token stays HIDDEN and a stand-in takes her place at the
      //     spot her silhouette held, which is behind the target, mid-follow-
      //     through. She only returns to her real mark by withdrawing there.
      // Nothing is written to any token; this is all local render state.

      const scale = cam0.scale;
      const tgtC = target.center || { x: cam0.x, y: cam0.y };
      // Screen offsets, in px from the centre of frame, that the composition
      // ended on. fg.x is the pull-back; crystaSil.x is her dash.
      const tgtScreenDx = fg.x;
      const cryScreenDx = fg.x + (crystaSil ? crystaSil.x : 0);
      const rowDy = C.charYFrac * H;

      // Where she has to appear in the WORLD to hold her place on screen.
      const stabX = tgtC.x + (cryScreenDx - tgtScreenDx) / scale;
      const stabY = tgtC.y;

      // Every token back, the stand-in placed and the camera panned FIRST --
      // all of it under the sheet, which is still up, so none of it is seen. It
      // also means the damage feedback (DOM, projected from the token's real
      // world centre) is placed against the FINAL camera however early it fires.
      for (let i = 0; i < restores.length; i++) { try { restores[i](); } catch (e) {} }

      // Her stand-in, placed on the frame she was just occupying -- and FACING
      // THE WAY THE SILHOUETTE FACED. cloneToken inherits the mesh's mirror,
      // which is her token's own facing out on the map; she stands on the far
      // side of the target there, so that sign is the opposite of the one the
      // composition used, and the stand-in would flip on the cut.
      // The map facing is kept so the swap back at the end is invisible too.
      const ghost = oni.cloneToken(caster, { parent: emoteLayer });
      const homeFaceSign = ghost ? (Math.sign(ghost.scale.x) || 1) : 1;
      if (ghost) {
        ghost.position.set(stabX, stabY);
        if (C.autoFace) ghost.scale.x = Math.abs(ghost.scale.x) * (faceLeft ? 1 : -1);
      }

      // Pan so the target does not move by a single pixel across the cut.
      try {
        canvas.pan({ x: tgtC.x - tgtScreenDx / scale, y: tgtC.y - rowDy / scale, scale });
      } catch (e) { console.warn('[ZeroPower] could not hold the frame across the cut.', e); }

      // Now the reveal and the miss, ordered by the sign of the beat between
      // them. Either way the number and its SFX land on the real token, on the
      // real battlefield, which is the only place either can be correct.
      const missLead = Number(C.missDamageDelayMs) || 0;
      const revealWorld = () => { root.visible = false; };
      if (missLead >= 0) {
        revealWorld();
        if (missLead > 0) await oni.wait(missLead);
        oni.fireDone();
      } else {
        oni.fireDone();
        await oni.wait(-missLead);
        revealWorld();
      }

      // Her reaction, beside the face of the stand-in (not of her real token,
      // which is still hidden a long way off).
      const tokH = Math.abs(caster.mesh && caster.mesh.height ? caster.mesh.height : 100) || 100;
      // Keeps the emote pinned to her wherever she is, so it reads as HERS
      // rather than as a bubble hanging in the air beside the target.
      const placeEmote = (x, y) => {
        if (emote) emote.position.set(x + tokH * C.missEmoteOffX, y + tokH * C.missEmoteOffY);
      };
      if (emote) {
        await emoteReady;
        const n = naturalOf(emote.texture);
        if (n.w > 0 && n.h > 0) {
          const eh = tokH * C.missEmoteScale;
          emote.height = eh;
          emote.width = eh * (n.w / n.h);
          // Mirror the bubble. Anchored on its centre, so this flips the ART
          // without shifting where it sits beside her.
          if (C.missEmoteFlip) emote.scale.x = -Math.abs(emote.scale.x);
          placeEmote(stabX, stabY);
          emote.alpha = 1;
          await restartVideo(emoteVid, 1);
        } else {
          console.warn('[ZeroPower] the sob emote never decoded; skipping it.');
          emote = null;
        }
      }

      // ---- she withdraws, and the camera pulls out with her ------------------
      await oni.wait(C.missRetreatDelayMs);

      // The pull-back starts HERE and runs underneath the retreat, ending on
      // exactly the camera the player had before any of this began.
      let camDone = Promise.resolve();
      try {
        camDone = canvas.animatePan({ x: cam0.x, y: cam0.y, scale: cam0.scale, duration: C.missZoomMs });
      } catch (e) {
        console.warn('[ZeroPower] camera pull-back failed; restoring the view directly.', e);
        try { canvas.pan({ x: cam0.x, y: cam0.y, scale: cam0.scale }); } catch (e2) {}
      }

      // Dissolve carrying AWAY from the target, then re-form on her REAL mark --
      // the Mirage Strike move in reverse, and what returns her to the map.
      const away = (stabX >= tgtC.x) ? 1 : -1;
      const homeX = caster.center.x;
      const homeY = caster.center.y;
      if (ghost) {
        await oni.tween({
          duration: C.missFadeOutMs, ease: oni.EASE.inQuad,
          onUpdate: (v) => {
            ghost.alpha = 1 - v;
            ghost.position.x = stabX + away * C.missRetreatPx * v;
            // Follow her as she withdraws, and fade on the same curve.
            placeEmote(ghost.position.x, ghost.position.y);
            if (emote) emote.alpha = 1 - v;
          },
        });
        ghost.alpha = 0;
        if (emote) emote.alpha = 0;

        // Re-form at her own mark, arriving from behind it so it reads as one
        // continuous move rather than two stills -- and turned back to her
        // TOKEN's facing, so the hand-back to the real token is seamless.
        const backDir = (homeX >= tgtC.x) ? 1 : -1;
        const inFrom = homeX + backDir * C.missArrivePx;
        ghost.position.set(inFrom, homeY);
        if (C.autoFace) ghost.scale.x = Math.abs(ghost.scale.x) * homeFaceSign;
        await oni.tween({
          duration: C.missFadeInMs, ease: oni.EASE.outCubic,
          onUpdate: (v) => {
            ghost.alpha = v;
            ghost.position.x = inFrom + (homeX - inFrom) * v;
          },
        });
        ghost.alpha = 1;
      } else if (emote) {
        emote.alpha = 0;
      }

      // Her real token is on that exact spot and identical, so the swap is
      // invisible. Then wait out whatever is left of the camera move.
      restoreCaster();
      if (ghost) ghost.alpha = 0;
      try { await camDone; } catch (e) {}
    } else {
      // ---- HIT -- beat 9: the moon comes apart ------------------------------
      // The cut crossed the whole frame; the moon is simply the last thing it
      // reaches. Two fresh copies of disc+halo, each clipped to one side of the
      // cut, replace the single moon on the frame they appear -- same textures,
      // same place, so the handoff cannot be seen. Each mask is a CHILD of the
      // half it clips, which is the whole trick: the clip travels with the half,
      // so each keeps its flat cut edge the entire way out instead of sliding
      // out through a stationary window.
      const splitY = C.splitYFrac * H;
      const yCut = splitY - C.moonYFrac * H;   // the cut, in moon-local space
      // Masks and the drift both have to outrun the HALO, not the disc -- the
      // glow reaches moonRadiusFrac * glowScale * H, well past the rim.
      const span = Math.max(W, H) * 2;

      const makeHalf = (isTop, parent) => {
        const half = new PIXI.Container();
        half.zIndex = 0;
        half.position.copyFrom(moonWrap.position);
        const g = new PIXI.Sprite(glow.texture);
        g.anchor.set(0.5);
        g.width = glow.width; g.height = glow.height;
        g.blendMode = PIXI.BLEND_MODES.ADD;
        half.addChild(g);
        const d = new PIXI.Sprite(disc.texture);
        d.anchor.set(0.5);
        d.width = disc.width; d.height = disc.height;
        half.addChild(d);
        const m = new PIXI.Graphics();
        m.beginFill(0xffffff, 1);
        m.drawRect(-span, isTop ? yCut - span : yCut, span * 2, span);
        m.endFill();
        half.addChild(m);
        half.mask = m;
        parent.addChild(half);
        return half;
      };
      // Both halves live under ONE parent so the ripple can distort them as a
      // single image. Masks stay on the CHILDREN: a filter over a masked parent
      // fights its own clip, but filter-on-parent / mask-on-child composes.
      const moonSplit = new PIXI.Container();
      moonSplit.zIndex = 0;
      comp.addChild(moonSplit);
      const moonTop = makeHalf(true, moonSplit);
      const moonBot = makeHalf(false, moonSplit);
      moonWrap.alpha = 0;

      // The displacement map: horizontal bands, strongest at the centre and
      // falling off to nothing at the edge. R is the x offset, G the y, 128 is
      // "no shift". Baked once per session like the moon's own textures.
      const rippleMap = (() => {
        // v2 in the key because the SHAPE changed (bands -> rings): texCache is
        // session-scoped, so without the bump a page that already ran the old
        // build would keep serving the old map for the rest of its life.
        const key = 'ripplemap:v2:' + C.rippleTexSize + ':' + C.rippleRings + ':' + C.rippleEdge;
        const cached = texCache[key];
        if (cached && !cached.destroyed && cached.baseTexture && !cached.baseTexture.destroyed) return cached;
        const MP = C.rippleTexSize;
        const cv = document.createElement('canvas');
        cv.width = MP; cv.height = MP;
        const g2 = cv.getContext('2d');
        const img = g2.createImageData(MP, MP);
        for (let y = 0; y < MP; y++) {
          for (let x = 0; x < MP; x++) {
            const nx = (x - MP / 2) / (MP / 2);
            const ny = (y - MP / 2) / (MP / 2);
            const r = Math.sqrt(nx * nx + ny * ny) || 1e-6;
            // Flat across the disc, then eased to nothing by the map's edge, so
            // the rings are at FULL strength where the rim is and stop cleanly
            // rather than dragging the black beyond it.
            const e = Math.max(0.05, Math.min(0.98, C.rippleEdge));
            const k = r <= e ? 1 : Math.max(0, 1 - (r - e) / (1 - e));
            const fall = k * k * (3 - 2 * k);            // smoothstep, no hard step at the rim
            // Concentric rings pushed ALONG the radius -- the offset direction
            // is the outward unit vector, which is what makes them read as rings
            // spreading from the origin rather than as a wobble in one axis.
            const wave = Math.sin(r * C.rippleRings * Math.PI * 2) * fall;
            const i = (y * MP + x) * 4;
            img.data[i] = 128 + Math.max(-127, Math.min(127, (nx / r) * wave * 127));
            img.data[i + 1] = 128 + Math.max(-127, Math.min(127, (ny / r) * wave * 127));
            img.data[i + 2] = 128;
            img.data[i + 3] = 255;
          }
        }
        g2.putImageData(img, 0, 0);
        const tex = PIXI.Texture.from(cv);
        texCache[key] = tex;
        return tex;
      })();

      // The map sprite is SAMPLED, never drawn -- it has to be in the tree for
      // its transform to be live, but renderable false keeps it off screen.
      const mapSpan0 = moonR * 2 * C.rippleFromFrac;
      const mapSpan1 = moonR * 2 * C.rippleToFrac;
      const Displacement = PIXI.DisplacementFilter
        || (PIXI.filters && PIXI.filters.DisplacementFilter) || null;

      // The origins, spread along the cut and ordered the way the blade ran, so
      // the water breaks left-to-right or right-to-left with the stroke instead
      // of blooming symmetrically out of the middle.
      const originCount = Math.max(1, Math.round(C.rippleOrigins));
      const alongHalf = C.rippleAlongFrac * moonR;
      const originXs = [];
      for (let i = 0; i < originCount; i++) {
        const f = originCount === 1 ? 0 : (i / (originCount - 1)) * 2 - 1;   // -1 .. 1
        originXs.push(f * alongHalf);
      }
      if (!dirRight) originXs.reverse();

      // Each origin gets its OWN map sprite (sampled, never drawn) and its own
      // displacement pass. Chained passes compose, so overlapping disturbances
      // add rather than replace -- which is what two ripple fronts meeting does.
      const rips = [];
      for (let i = 0; i < originCount; i++) {
        const spr = new PIXI.Sprite(rippleMap);
        spr.anchor.set(0.5);
        spr.position.set(C.rippleXFrac * H + originXs[i], splitY + C.rippleYFrac * H);
        spr.width = mapSpan0;
        spr.height = mapSpan0;
        spr.renderable = false;
        comp.addChild(spr);
        let f = null;
        if (Displacement) {
          f = new Displacement(spr, 0);
          f.scale.x = 0; f.scale.y = 0;
          // Without padding the shear is clipped at the container's own bounds
          // and the wave flattens exactly where it should be largest.
          f.padding = C.rippleAmpPx * 3;
        }
        rips.push({ spr, filter: f, delay: i * C.rippleStaggerMs, y0: spr.y });
      }
      const ripFilters = rips.map((r) => r.filter).filter(Boolean);
      if (ripFilters.length) moonSplit.filters = ripFilters;
      else console.warn('[ZeroPower] no DisplacementFilter in this PIXI; the moon parts without the ripple.');

      // The white-out. Oversized like the black sheet so a mid-shot resize
      // cannot expose an edge, and ABOVE both the composition and the black.
      const white = new PIXI.Graphics();
      white.beginFill(hexNum(C.whiteColor), 1);
      white.drawRect(-1.5 * W, -1.5 * H, 3 * W, 3 * H);
      white.endFill();
      white.alpha = 0;
      white.zIndex = 5;
      root.addChild(white);

      // The cut has landed but nothing has moved yet: the halves are sitting
      // exactly where the whole moon was, so this beat reads as the moon holding
      // together for a moment before it lets go.
      await oni.wait(C.splitPauseMs);

      // Top right, bottom left. Started, NOT awaited: the ripple is scheduled
      // one second off this moment, so the two beats have to overlap.
      const drift = oni.tween({
        duration: C.splitDriftMs, ease: oni.EASE.inOutQuad,
        onUpdate: (v) => {
          if (moonTop.destroyed || moonBot.destroyed) return;
          moonTop.x = C.splitDriftPx * v;
          moonBot.x = -C.splitDriftPx * v;
        },
      });

      // Amplitude swells, holds, then dies -- a disturbance, not a steady state.
      // Underneath it the map DRIFTS (the bands travelling outward) and GROWS
      // (the disturbed patch spreading from the middle), which is what turns a
      // static sine into moving water.
      const oneRipMs = C.rippleRiseMs + C.rippleHoldMs + C.rippleFallMs;
      const ripSpanMs = oneRipMs + (originCount - 1) * C.rippleStaggerMs;
      const ripple = (async () => {
        await oni.wait(C.rippleDelayMs);
        if (!ripFilters.length) return;
        await oni.tween({
          duration: ripSpanMs, ease: oni.EASE.linear,
          onUpdate: (v, t) => {
            const ms = t * ripSpanMs;
            for (let i = 0; i < rips.length; i++) {
              const r = rips[i];
              if (!r.filter || r.spr.destroyed) continue;
              // Each origin lives its own life, offset by its place in the cut.
              const lm = ms - r.delay;
              if (lm <= 0 || lm >= oneRipMs) { r.filter.scale.x = 0; continue; }
              const amp = lm < C.rippleRiseMs
                ? oni.EASE.outQuad(lm / C.rippleRiseMs)
                : lm < C.rippleRiseMs + C.rippleHoldMs
                  ? 1
                  : 1 - oni.EASE.inOutQuad((lm - C.rippleRiseMs - C.rippleHoldMs) / C.rippleFallMs);
              // Both axes: a radial map with y pinned to 0 would collapse the
              // rings back into a horizontal wobble.
              r.filter.scale.x = C.rippleAmpPx * amp;
              r.filter.scale.y = C.rippleAmpPx * amp * C.rippleFlattenY;
              const lt = lm / oneRipMs;
              // The rings travelling outward from their own origin. The map
              // stays centred and SCALES, so the pattern expands rather than
              // sliding. outQuad: fast at first and slowing, as a real one does.
              const grow = mapSpan0 + (mapSpan1 - mapSpan0) * oni.EASE.outQuad(lt);
              r.spr.width = grow;
              r.spr.height = grow;
            }
          },
        });
        for (const r of rips) if (r.filter) r.filter.scale.x = 0;
      })();

      // The light takes the frame WHILE the ripple is still spreading -- it runs
      // on its own clock off the drift's start rather than being pinned to the
      // end of the beat, so the rings are swallowed rather than allowed to finish.
      const whiten = (async () => {
        await oni.wait(Math.max(0, C.whiteStartMs));
        await oni.tween({
          duration: Math.max(1, C.whiteRiseMs), ease: oni.EASE.inOutQuad,
          onUpdate: (v) => { if (!white.destroyed) white.alpha = v; },
        });
      })();

      // ONLY the whiten is awaited. Once the sheet is opaque nothing behind it
      // can be seen, so waiting out the drift and the ripple would buy nothing
      // but ~3.5 s of runtime -- which this shot cannot spare (see the note on
      // the 35 s gate). Both keep running harmlessly behind the white and stop
      // on their own; every onUpdate already guards on destroyed.
      await whiten;
      white.alpha = 1;

      // ---- beat 10: everything that follows happens UNDER the white ---------
      // Which is the whole point of it. The composition is struck, every token
      // comes back and the real camera walks home -- none of it visible, so the
      // white lifts on the ordinary battlefield rather than on a handover.
      comp.visible = false;
      bg.alpha = 0;
      for (let i = 0; i < restores.length; i++) { try { restores[i](); } catch (e) {} }
      restoreCaster();
      // The cinematic camera is fake and never moved this one, but a reaction,
      // a token drag or a previous shot may have. Walk it home either way; if
      // it is already there the pan is a no-op.
      let camHome = null;
      try {
        camHome = canvas.animatePan({ x: cam0.x, y: cam0.y, scale: cam0.scale, duration: C.camReturnMs });
      } catch (e) {
        try { canvas.pan({ x: cam0.x, y: cam0.y, scale: cam0.scale }); } catch (e2) {}
      }
      await oni.wait(C.whiteHoldMs);
      try { await camHome; } catch (e) {}

      await oni.tween({
        duration: C.whiteFadeOutMs, ease: oni.EASE.inQuad,
        onUpdate: (v) => { if (!white.destroyed) white.alpha = 1 - v; },
      });
      white.alpha = 0;
      root.alpha = 0;
      // The gate fires just below, so the damage lands on the frame the white
      // clears -- on the real target, on the real battlefield.
    }

    // ---- THE DAMAGE GATE (hit path; the miss path already fired it) --------
    // Damage feedback is DOM, not canvas: the number, the impact FX and the
    // target's hurt-reaction portrait are position:fixed elements projected
    // from the TOKEN'S REAL WORLD CENTRE. This cinematic hides every token and
    // rebuilds the fight in synthetic screen space, so firing on the stab pops
    // all three wherever the target's token actually sits on the map -- an
    // arbitrary point, possibly off-screen, drawn OVER the opaque black sheet
    // (being DOM, the sheet does not hide them) and nowhere near the silhouette
    // that was just run through. Firing once the world is back puts the number
    // on the real target, on the real battlefield, which is the only place it
    // can be correct. The MISS branch fires its own, half a second after the
    // world returns, so the miss lands while she is still standing there; this
    // call is then a no-op (the outer consumed the hook with Hooks.once).
    oni.fireDone();

    } finally {
      // No-op on the happy path: the outer consumed the hook at the end of the
      // pan. On a throw it is the difference between 6 s of dead air and none.
      oni.fireDone();
    }
  `;

  game.ONI.pseudo.play({
    scriptId: "crysta/zero-power",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG, outcomes },
  });

  // The gate fires at the END of the cinematic (see the note beside
  // oni.fireDone in the inner), so this has to cover the whole thing -- and the
  // two endings are different lengths, so take the longer.
  const toBranch = CFG.blackFadeMs + CFG.blackHoldMs + CFG.revealMs
                 + CFG.moonHoldMs + CFG.panMs + CFG.postPanHoldMs
                 + CFG.cutinSlideInMs + CFG.cutinHoldMs + CFG.cutinSlideOutMs
                 + CFG.preCloseMs + CFG.closeMs
                 + CFG.stabSweepMs + CFG.stabLineHoldMs + CFG.stabLineFadeMs
                 + CFG.postStabMs
                 // The cut-in's decode is awaited INSIDE this stretch and is not
                 // a beat length, so a sum of the beats understates the real run
                 // by up to the settle cap. Measured 2026-09-05: nominal 15.1 s
                 // against ~20.5 s actual. That shortfall is not cosmetic -- once
                 // the hit tail grew past it, the onceHook TIMEOUT beat the
                 // inner's own fireDone and emitted animationEnd early, so damage
                 // landed on a fully white screen. Anything awaited in here that
                 // is not a beat has to be counted here too.
                 + CFG.assetSettleCapMs;
  // The miss tail runs damage-delay -> emote -> retreat, with the camera pull
  // overlapping the retreat, so its length is the delay plus the longer of the
  // two concurrent moves.
  // abs: missDamageDelayMs is a signed OFFSET between the reveal and the miss,
  // and either sign costs the same wall-clock before the retreat starts.
  const missTail = Math.abs(CFG.missDamageDelayMs) + CFG.missRetreatDelayMs
                 + Math.max(CFG.missZoomMs, CFG.missFadeOutMs + CFG.missFadeInMs);
  // The HIT tail is gated by the WHITE, not by the ripple: the light closes the
  // frame while the drift and the ripple are still running, and they are left
  // behind it rather than awaited. So the beat is the pause, the whiten, then
  // the hold and the lift -- the ripple's own length never enters into it.
  const hitTail = CFG.splitPauseMs + CFG.whiteStartMs + CFG.whiteRiseMs
                + CFG.whiteHoldMs + CFG.whiteFadeOutMs;
  const preDone = toBranch + Math.max(missTail, hitTail);
  await onceHook(doneHook, preDone + 6000);
  Hooks.callAll("oni:animationEnd", {
    local: true, world: false,
    sourceTokenId: String(casterUuid || "").split(".Token.").pop() || null,
  });
})();
