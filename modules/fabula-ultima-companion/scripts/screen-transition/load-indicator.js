// ============================================================================
// Load Indicator — the game's "Now Loading" screen
//
// Replaces Foundry's own scene load bar (#loading: "Loading <scene name> 47%",
// a spoiler, and hidden under the scene-change cover anyway) with a PS1/PS2-
// style indicator on black. Two places:
//
//   World entry  a black boot cover from `init` until `ready` (Foundry draws the
//                first scene before `ready`, with no canvasTearDown), then it
//                fades out like a scene reveal. Shows at once; its timer counts
//                from the page's navigation start.
//   Map change   inside screen-transition.js's cover, which stays black from
//                canvasTearDown to canvasReady. It shares that cover's layer
//                and fade, and never decides when the cover lifts.
//
//   map change < 2 s   nothing — a normal load never shows it
//   2 s       breathing logo, a random mascot, "Now Loading...", a timer
//   6 s       percentage and a thin bar (files done / files the draw loads)
//   8 s       tips, and "N files left · from Forge / the game host" when 3 or fewer remain
//   20 s      "Still loading — no need to refresh."
//   2 min     world entry only: "...if nothing changes, press F5."
//   textures done -> "Preparing the map..." until the scene is drawn
//
// No scene or file names on screen (spoilers): they go to the console and to
// the client-health log. Foundry's bar is not drawn while a map loads; its
// label goes to the console. Other uses of that bar (imports) still show.
//
// The timer is script-driven and the spinner is CSS: a timer that stops while
// the spinner turns means the page itself has hung.
//
// The mascot reacts to a click; each kind moves its own way. Purely cosmetic,
// it gives restless hands something other than F5. Momonga always qualifies;
// the others only once the Monster Encyclopedia has their page (no spoilers).
//
// While the screen is black, Foundry's toasts ("lost connection", "map image
// didn't load") are lifted above it; they used to be hidden underneath.
//
// Progress comes from wrapping TextureLoader#load / #loadTexture, so it knows
// which files the draw still waits on. Slow loads go to the client-health
// logger ("load-progress"), with "load-waiting" marks at 30 s and 60 s that
// survive a reload.
//
// GM switch: Configure Settings → "Loading indicator on the black screen".
// Off = Foundry's plain behaviour everywhere, world entry included.
// ============================================================================
(() => {
  const MODULE_ID   = "fabula-ultima-companion";
  const TAG         = "[FUCompanion][LoadIndicator]";
  const SETTING     = "loadIndicator";
  const OVERLAY_ID  = "fu-screen-transition";   // screen-transition.js
  const BOOT_ID     = "fu-load-boot";           // the world-entry cover, until `ready`
  const ROOT_ID     = "fu-load-indicator";
  const STYLE_ID    = "fu-load-indicator-style";
  const COVER_CLASS = "fu-nl-covered";   // on <body> while the screen is black: toasts go above it

  const SHOW_MS      = 2000;
  const PCT_MS       = 6000;
  const TIP_MS       = 8000;
  const TIP_EVERY_MS = 7000;
  const CALM_MS      = 20000;
  const LONG_MS      = 120000;   // world entry: past this, refreshing is the honest advice
  const FEW_LEFT     = 3;
  const MARKS_MS     = [30000, 60000];
  const TICK_MS      = 250;
  const FADE_MS      = 1000;   // the cover's hold + fade-out, then the indicator is cleared
  const REVEAL_HOLD_MS = 180, REVEAL_FADE_MS = 700;   // match screen-transition.js

  const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
  const LOGO  = FORGE + "Campaign/The%20Legend%20of%20Dragonslayer/Image/UI/DRG_LoadingLogo.webp";
  // Momonga is the house loading mascot (it is on the Loading Screen scene). The others show only once
  // the party has met them: a page with their name in the Monster Encyclopedia. No spoilers.
  const ENCYCLOPEDIA_ID = "PNjdkqQx1X0Rx4Eh";
  const MASCOTS = [
    { id: "momonga", name: "Momonga",      src: FORGE + "Beastiary/Momonga_Standard.png",        w: 64, pokeMs: 900, always: true },
    { id: "slime",   name: "Slime",        src: FORGE + "Beastiary/Slime_Standard.png",          w: 56, pokeMs: 800 },
    { id: "sylph",   name: "Sylph",        src: FORGE + "Beastiary/Sylph_Standard.png",          w: 66, pokeMs: 900, fx: "#8fcf6a" },
    { id: "boar",    name: "Prickle Boar", src: FORGE + "Beastiary/Prickle%20Boar_Standard.png", w: 74, pokeMs: 800, fx: "#a8957a", bonk: true },
    { id: "shroom",  name: "Shroomy",      src: FORGE + "Beastiary/Shroomy_Standard.png",        w: 60, pokeMs: 700, fx: "#efe2b0" },
  ];
  // stand-ins until the GM writes the real ones
  const TIPS = [
    "Inventory Points can be recharged as a service at a town shop.",
    "Resting at an inn costs 20 z for each party member.",
    "Use Study in battle to fill in a monster’s bestiary page.",
  ];

  let draw = null;        // the draw in progress (startDraw)
  let ticker = null;
  let pokeTimer = null;
  let lastMascot = null;
  let booted = false;     // `ready` has fired
  let bootCover = null;   // the world-entry cover, until `ready`
  const preloaded = [];   // keeps the images decoded between draws
  const pendingRecords = [];   // logged before client-health is up (the first draw)
  const ui = {};

  // ── Which files is this draw waiting on? ───────────────────────────────────

  function wrapTextureLoader() {
    const TL = typeof TextureLoader === "undefined" ? null : TextureLoader;
    const proto = TL?.prototype;
    if (!proto?.load || proto.load.fuLoadIndicator) return;
    const load = proto.load;
    const loadTexture = proto.loadTexture;
    proto.load = function (sources, options) {
      try {
        if (draw && !draw.readyAt && globalThis.canvas?.loading) {
          const t = performance.now();
          for (const src of sources ?? []) {
            if (src && !draw.files.has(src)) draw.files.set(src, { start: t, end: null });
          }
        }
      } catch (err) { /* bookkeeping must never block a load */ }
      return load.call(this, sources, options);
    };
    proto.load.fuLoadIndicator = true;
    proto.loadTexture = async function (src) {
      try { return await loadTexture.call(this, src); }
      finally {
        const f = draw?.files.get(src);
        if (f && f.end === null) f.end = performance.now();
      }
    };
  }

  // Foundry's own bar: not drawn while a map loads (it names the scene). Its
  // label still goes to the console; other progress (imports) is untouched.
  function wrapProgressBar() {
    const SN = typeof SceneNavigation === "undefined" ? null : SceneNavigation;
    if (!SN?.displayProgressBar || SN.displayProgressBar.fuLoadIndicator) return;
    const displayProgressBar = SN.displayProgressBar;
    SN.displayProgressBar = function (options = {}) {
      if (draw && !draw.readyAt && enabled()) {
        if (!draw.barLogged) {
          draw.barLogged = true;
          console.info(TAG, `${options.label ?? "Loading"} (Foundry's load bar hidden; the load indicator shows progress)`);
        }
        return;
      }
      return displayProgressBar.call(this, options);
    };
    SN.displayProgressBar.fuLoadIndicator = true;
  }

  const fileName = src => {
    const base = String(src).split("?")[0].split("/").pop() || String(src);
    try { return decodeURIComponent(base); } catch { return base; }
  };
  const origin = src => {
    if (!/^https?:\/\//i.test(src)) return "the game host";
    // a Forge file the host mirrors (scripts/forge-mirror) actually comes from the host
    if (/forge-vtt\.com/i.test(src)) return globalThis.FUCompanion?.api?.forgeMirror?.has?.(src) ? "the game host" : "Forge";
    try { return new URL(src).hostname; } catch { return "the web"; }
  };
  const clock = ms => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function counts(d) {
    let left = 0, pending = null;
    for (const [src, f] of d.files) if (f.end === null) { left++; pending ??= src; }
    const total = d.files.size;
    return { total, left, pending, pct: total ? Math.round((total - left) * 100 / total) : 0 };
  }

  // ── The draw ───────────────────────────────────────────────────────────────

  // read at every pick: the bestiary grows during a session. Before the journal is
  // available (world entry) or without access to it, only the house mascot qualifies.
  function allowedMascots() {
    let met = new Set();
    try {
      const j = game.journal?.get(ENCYCLOPEDIA_ID) ?? game.journal?.getName?.("Monster Encyclopedia");
      met = new Set((j?.pages?.map?.(p => String(p.name).trim().toLowerCase())) ?? []);
    } catch { /* no journal yet */ }
    return MASCOTS.filter(m => m.always || met.has(m.name.toLowerCase()));
  }

  function pickMascot() {
    const allowed = allowedMascots();
    const pool = allowed.length > 1 ? allowed.filter(m => m !== lastMascot) : allowed;
    lastMascot = pool[Math.floor(Math.random() * pool.length)] ?? MASCOTS[0];
    return lastMascot;
  }

  // entry: the world's first draw — times count from the page's navigation start
  function startDraw({ entry = false } = {}) {
    if (draw && !draw.reported) report(draw, "superseded");
    hide();
    const now = Date.now();
    draw = { entry, started: now, t0: entry ? now - performance.now() : now, tp0: entry ? 0 : performance.now(),
             files: new Map(), texDoneAt: null, readyAt: null, fadeAt: null, shown: false, calm: false,
             sawLoading: false, marks: new Set(), reported: false, barLogged: false, loggedPending: null, mascot: pickMascot() };
    // swap the sprite while hidden, so it has painted by the time the indicator shows
    if (ui.mascot) setMascot(draw.mascot);
    ticker ??= setInterval(tick, TICK_MS);
  }

  function finishDraw() {
    if (!draw || draw.readyAt) return;
    draw.readyAt = Date.now();
    report(draw, "ready");
  }

  // the black element the indicator lives in: the scene-change cover once it
  // exists (`ready`), the world-entry cover before that
  const coverEl = () => document.getElementById(OVERLAY_ID) ?? bootCover;

  function tick() {
    try {
      if (!draw) return stop();
      const now = Date.now();
      const e = now - draw.t0;
      const age = now - draw.started;

      if (!draw.readyAt) {
        const c = counts(draw);
        if (c.total && !c.left) draw.texDoneAt ??= now;
        // Foundry clears canvas.loading with no canvasReady on a failed or blank draw. The world-entry
        // session starts at `init`, long before its draw, so only count it once a draw was seen.
        if (globalThis.canvas?.loading) draw.sawLoading = true;
        if (draw.sawLoading && age > 1000 && globalThis.canvas?.loading === false) {
          draw.readyAt = now;
          report(draw, "no-canvasReady");
        }
        if (c.left === 1 && c.pending !== draw.loggedPending && age >= TIP_MS) {
          draw.loggedPending = c.pending;
          console.info(TAG, `waiting on ${fileName(c.pending)} from ${origin(c.pending)} (${Math.round(age / 1000)} s into this load)`);
        }
        for (const at of MARKS_MS) {
          if (age >= at && !draw.marks.has(at)) {
            draw.marks.add(at);
            record("load-waiting", { atS: at / 1000, entry: draw.entry, ...sceneInfo(), pct: c.pct, files: c.total,
              left: c.left, pending: pendingList(draw), shown: draw.shown });
          }
        }
      }

      const cover = coverEl();
      const opacity = cover ? parseFloat(cover.style.opacity || "0") : 0;
      const shatter = document.body.classList.contains("fuc-shatter-active");
      const black = !!cover && opacity >= 0.99 && !shatter;
      document.body.classList.toggle(COVER_CLASS, black && enabled() && (!draw.readyAt || (draw.entry && !booted)));

      if (draw.readyAt) {
        // world entry: the scene is drawn but the game is still finishing its boot
        if (draw.entry && black && !booted) {
          draw.texDoneAt ??= draw.readyAt;
          if (enabled()) render(cover, e);
          return;
        }
        // done: fade out with the cover, then clear
        if (!draw.shown) return finish();
        if (!black) draw.fadeAt ??= now;
        if (draw.fadeAt && now - draw.fadeAt >= FADE_MS) finish();
        return;
      }
      if (!enabled() || !black || (!draw.entry && e < SHOW_MS)) {
        if (draw.shown) setVisible(false);
        return;
      }
      render(cover, e);
    } catch (err) {
      console.warn(TAG, "tick failed, indicator off for this draw", err);
      finish();
    }
  }

  function finish() { hide(); draw = null; stop(); document.body.classList.remove(COVER_CLASS); }
  function stop() { clearInterval(ticker); ticker = null; }

  // ── The world-entry cover ──────────────────────────────────────────────────

  function showBootCover() {
    if (bootCover || booted) return;
    ensureStyle();
    bootCover = document.createElement("div");
    bootCover.id = BOOT_ID;
    Object.assign(bootCover.style, { position: "fixed", inset: "0", zIndex: "99999", background: "#000",
                                     opacity: "1", pointerEvents: "all" });
    document.body.appendChild(bootCover);
  }

  // the same reveal as a scene change: a short hold, then an ease-out fade
  function liftBootCover() {
    const el = bootCover;
    if (!el) return;
    bootCover = null;
    el.style.pointerEvents = "none";
    setTimeout(() => {
      el.style.transition = `opacity ${REVEAL_FADE_MS}ms ease-out`;
      el.style.opacity = "0";
      setTimeout(() => el.remove(), REVEAL_FADE_MS + 200);
    }, REVEAL_HOLD_MS);
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function render(cover, e) {
    if (!ensureDom(cover)) return;
    if (!draw.shown) {
      draw.shown = true;
      setMascot(draw.mascot);
    }
    setVisible(true);

    const { total, left, pending, pct } = counts(draw);
    const prep = !!draw.texDoneAt;
    const progress = total > 0 && (draw.entry || e >= PCT_MS);
    setLabel(prep ? "Preparing the map" : "Now Loading");
    setText(ui.clock, clock(e));

    show(ui.pct, !prep && progress);
    setText(ui.pct, `${pct}%`);
    show(ui.bar, prep || progress);
    ui.bar.classList.toggle("fu-nl-prep", prep);
    if (!prep) ui.fill.style.width = `${pct}%`;

    // no names on screen (spoilers): which route it comes from is the useful part
    const few = !prep && e >= TIP_MS && left > 0 && left <= FEW_LEFT;
    show(ui.left, few);
    if (few) setText(ui.left, left === 1 && pending ? `1 file left · from ${origin(pending)}` : `${left} files left`);

    show(ui.tip, e >= TIP_MS);
    if (e >= TIP_MS) setText(ui.tipText, TIPS[Math.floor((e - TIP_MS) / TIP_EVERY_MS) % TIPS.length]);

    if (e >= CALM_MS) draw.calm = true;
    show(ui.calm, draw.calm);
    if (draw.calm) setText(ui.calm, draw.entry && e >= LONG_MS
      ? "This is taking much longer than usual. If nothing changes, press F5."
      : "Still loading — no need to refresh.");
  }

  const MARKUP = `
    <div class="fu-nl-dither"></div>
    <div class="fu-nl-corner">
      <div class="fu-nl-calm" hidden>Still loading — no need to refresh.</div>
      <div class="fu-nl-row">
        <button type="button" class="fu-nl-mascot"><span class="fu-nl-fx"></span><img alt="" draggable="false"></button>
        <img class="fu-nl-logo" alt="The Legend of Dragonslayer" draggable="false" src="${LOGO}">
      </div>
      <div class="fu-nl-status">
        <span><span class="fu-nl-label"></span><span class="fu-nl-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span>
        <span class="fu-nl-pct" hidden></span>
        <span class="fu-nl-time"><span class="fu-nl-spin" aria-hidden="true"></span><span class="fu-nl-clock">0:00</span></span>
      </div>
      <div class="fu-nl-bar" hidden><div class="fu-nl-fill"></div></div>
      <div class="fu-nl-left" hidden></div>
    </div>
    <div class="fu-nl-tip" hidden><span class="fu-nl-tiplabel">Tip</span><span class="fu-nl-tiptext"></span></div>
    <div class="fu-nl-crt"></div>`;

  function ensureDom(cover) {
    if (ui.root?.isConnected && ui.root.parentElement === cover) return ui.root;
    ensureStyle();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.hidden = true;
    root.innerHTML = MARKUP;
    cover.appendChild(root);
    const q = sel => root.querySelector(sel);
    Object.assign(ui, {
      root, calm: q(".fu-nl-calm"), mascotBtn: q(".fu-nl-mascot"), mascot: q(".fu-nl-mascot img"), fx: q(".fu-nl-fx"),
      logo: q(".fu-nl-logo"), label: q(".fu-nl-label"), labelText: null, pct: q(".fu-nl-pct"), clock: q(".fu-nl-clock"),
      bar: q(".fu-nl-bar"), fill: q(".fu-nl-fill"), left: q(".fu-nl-left"), tip: q(".fu-nl-tip"), tipText: q(".fu-nl-tiptext"),
    });
    ui.mascotBtn.addEventListener("click", poke);
    return root;
  }

  function setMascot(m) {
    ui.mascot.src = m.src;
    ui.mascot.style.width = `${m.w}px`;
    ui.mascot.className = `fu-nl-${m.id}-idle`;
    ui.mascotBtn.setAttribute("aria-label", `Poke ${m.name}`);
  }

  function setLabel(text) {
    if (ui.labelText === text) return;
    ui.labelText = text;
    ui.label.replaceChildren(...[...text].map((ch, i) => {
      const s = document.createElement("span");
      s.textContent = ch === " " ? " " : ch;
      s.style.animationDelay = `${(i * 0.07).toFixed(2)}s`;
      return s;
    }));
  }

  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const show = (el, on) => { if (el && el.hidden === on) el.hidden = !on; };
  const setVisible = on => { if (ui.root) show(ui.root, on); };

  function hide() {
    clearTimeout(pokeTimer);
    if (ui.root) ui.root.hidden = true;
    ui.fx?.replaceChildren();
  }

  // ── The mascot ─────────────────────────────────────────────────────────────

  function poke() {
    const m = draw?.mascot, img = ui.mascot;
    if (!m || !img) return;
    img.className = "";
    void img.offsetWidth;   // restart the animation on every poke
    img.className = `fu-nl-${m.id}-poke`;
    if (m.fx) puff(m);
    if (m.bonk) {   // the boar charges into the logo
      setTimeout(() => {
        ui.logo?.classList.remove("fu-nl-bonk");
        void ui.logo?.offsetWidth;
        ui.logo?.classList.add("fu-nl-bonk");
      }, m.pokeMs * 0.45);
      setTimeout(() => ui.logo?.classList.remove("fu-nl-bonk"), m.pokeMs * 0.45 + 320);
    }
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => { if (draw?.mascot === m) img.className = `fu-nl-${m.id}-idle`; }, m.pokeMs);
  }

  function puff(m) {
    const dirs = m.id === "boar"  ? [[-26, -6], [-20, -14], [-32, 2], [-14, -2]]    // dust behind the charge
               : m.id === "sylph" ? [[-18, -26], [16, -30], [-6, -38], [22, -14]]   // leaves on the twirl
               :                    [[-14, -28], [12, -32], [2, -42], [-22, -18]];  // spores
    for (const [dx, dy] of dirs) {
      const p = document.createElement("i");
      p.style.setProperty("--dx", `${dx}px`);
      p.style.setProperty("--dy", `${dy}px`);
      p.style.background = m.fx;
      ui.fx.appendChild(p);
      setTimeout(() => p.remove(), 1000);
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────────

  // the world's first draw ends before client-health is up: hold those records until `ready`
  function record(kind, data) {
    const api = globalThis.FUCompanion?.api?.clientHealth;
    if (!api?.record) { if (pendingRecords.length < 20) pendingRecords.push([kind, data]); return; }
    try { api.record(kind, data); } catch { /* logger optional */ }
  }
  const sceneInfo = () => ({ sceneId: globalThis.canvas?.scene?.id ?? null, scene: globalThis.canvas?.scene?.name ?? null });
  const pendingList = d => [...d.files].filter(([, f]) => f.end === null).slice(0, 5).map(([src]) => `${fileName(src)} (${origin(src)})`);

  function report(d, reason) {
    if (d.reported) return;
    d.reported = true;
    const ms = (d.readyAt ?? Date.now()) - d.t0;
    if (reason === "ready" && ms < SHOW_MS) return;   // a normal draw: client-health's own "draw" entry has it
    try {
      const now = performance.now();
      const rows = [...d.files].map(([src, f]) => ({ file: fileName(src), from: origin(src),
        ms: Math.round((f.end ?? now) - f.start), done: f.end !== null }));
      // downloads vs building the map: when did the last file arrive? (the tick can miss it)
      const ends = [...d.files.values()].map(f => f.end);
      const texturesMs = d.texDoneAt ? d.texDoneAt - d.t0
        : ends.length && ends.every(x => x !== null) ? Math.round(Math.max(...ends) - d.tp0) : null;
      record("load-progress", {
        reason, entry: d.entry, ...sceneInfo(), ms, texturesMs,
        files: rows.length, left: rows.filter(r => !r.done).length, shown: d.shown, calm: d.calm,
        mascot: d.mascot?.id ?? null,
        slowest: rows.filter(r => r.done).sort((a, b) => b.ms - a.ms).slice(0, 5),
        pending: rows.filter(r => !r.done).slice(0, 5),
      });
    } catch (err) { console.warn(TAG, "report failed", err); }
  }

  // ── Style ──────────────────────────────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const R = `#${ROOT_ID}`;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
body.${COVER_CLASS} #notifications{z-index:100000}
${R}{position:absolute;inset:0;pointer-events:none;font-family:"Signika",sans-serif;color:#f3ead2;-webkit-font-smoothing:antialiased;animation:fuNlIn .4s steps(4) both}
${R}[hidden],${R} [hidden]{display:none!important}
${R} .fu-nl-dither{position:absolute;inset:0;background-image:conic-gradient(rgba(255,255,255,.05) 25%,transparent 0 50%,rgba(255,255,255,.05) 0 75%,transparent 0);background-size:2px 2px}
${R} .fu-nl-crt{position:absolute;inset:0;background:repeating-linear-gradient(to bottom,transparent 0,transparent 2px,rgba(0,0,0,.32) 2px,rgba(0,0,0,.32) 3px),radial-gradient(ellipse at center,transparent 58%,rgba(0,0,0,.6) 100%)}
${R} .fu-nl-corner{position:absolute;right:56px;bottom:44px;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
${R} .fu-nl-calm{font-size:15px;color:#d9d0b8;max-width:520px;text-align:right;animation:fuNlIn .4s steps(4) both}
${R} .fu-nl-row{display:flex;align-items:flex-end;gap:14px}
${R} .fu-nl-mascot,${R} .fu-nl-mascot:hover,${R} .fu-nl-mascot:focus{position:relative;pointer-events:auto;width:auto;height:auto;min-width:44px;min-height:44px;margin:0;padding:0;border:0;background:none;box-shadow:none;line-height:0;cursor:pointer;display:flex;align-items:flex-end;justify-content:center}
${R} .fu-nl-mascot:focus-visible{outline:2px solid #c9a44a;outline-offset:2px}
${R} .fu-nl-mascot img{display:block;height:auto;border:0;transform-origin:50% 100%}
${R} .fu-nl-logo{display:block;width:220px;height:auto;border:0;animation:fuNlBreathe 5s steps(25) infinite}
${R} .fu-nl-status{display:flex;align-items:center;gap:12px;font-size:18px}
${R} .fu-nl-label{text-shadow:1px 0 rgba(255,70,70,.45),-1px 0 rgba(70,150,255,.45)}
${R} .fu-nl-label span{display:inline-block;animation:fuNlWave 1.8s steps(2) infinite}
${R} .fu-nl-dots span{animation:fuNlDot 1.5s steps(1) infinite}
${R} .fu-nl-dots span:nth-child(2){animation-delay:.25s}
${R} .fu-nl-dots span:nth-child(3){animation-delay:.5s}
${R} .fu-nl-pct{color:#c9a44a;font-size:16px}
${R} .fu-nl-time{display:inline-flex;align-items:center;gap:6px;color:#bfb7a1;font-size:15px;font-variant-numeric:tabular-nums}
${R} .fu-nl-spin{display:inline-block;width:12px;height:12px;box-sizing:border-box;border:2px solid #c9a44a;border-top-color:#f3ead2;border-radius:50%;animation:fuNlSpin 1.2s steps(8) infinite}
${R} .fu-nl-bar{width:300px;height:4px;background:rgba(243,234,210,.14);overflow:hidden}
${R} .fu-nl-fill{height:100%;width:0;background:#c9a44a;transition:width .3s steps(3)}
${R} .fu-nl-bar.fu-nl-prep .fu-nl-fill{width:100%!important;transition:none;background:repeating-linear-gradient(-45deg,rgba(243,234,210,.55) 0,rgba(243,234,210,.55) 6px,rgba(243,234,210,.12) 6px,rgba(243,234,210,.12) 12px);background-size:24px 100%;animation:fuNlStripe .8s linear infinite}
${R} .fu-nl-left{font-size:14px;color:#bfb7a1;max-width:520px;text-align:right}
${R} .fu-nl-tip{position:absolute;left:56px;bottom:48px;max-width:520px;display:flex;gap:12px;align-items:baseline;animation:fuNlIn .4s steps(4) both}
${R} .fu-nl-tiplabel{color:#c9a44a;font-size:14px;font-weight:600}
${R} .fu-nl-tiptext{font-size:16px;line-height:1.45;color:#d9d0b8}
${R} .fu-nl-fx{position:absolute;left:50%;bottom:30%;width:0;height:0;overflow:visible;pointer-events:none}
${R} .fu-nl-fx i{position:absolute;left:0;top:0;width:5px;height:5px;border-radius:50%;animation:fuNlPuff .9s steps(6) forwards}
${R} .fu-nl-bonk{animation:fuNlBonk .3s steps(3) 1}
${R} .fu-nl-momonga-idle{animation:fuNlMomIdle .9s steps(1) infinite}
${R} .fu-nl-momonga-poke{animation:fuNlMomPoke .9s steps(3) 1}
${R} .fu-nl-slime-idle{animation:fuNlSlimeIdle 1.2s steps(1) infinite}
${R} .fu-nl-slime-poke{animation:fuNlSlimePoke .8s steps(3) 1}
${R} .fu-nl-sylph-idle{animation:fuNlSylphIdle 2.4s steps(4) infinite}
${R} .fu-nl-sylph-poke{animation:fuNlSylphPoke .9s steps(5) 1}
${R} .fu-nl-boar-idle{animation:fuNlBoarIdle 2.2s steps(1) infinite}
${R} .fu-nl-boar-poke{animation:fuNlBoarPoke .8s steps(3) 1}
${R} .fu-nl-shroom-idle{animation:fuNlShroomIdle 1.6s steps(2) infinite}
${R} .fu-nl-shroom-poke{animation:fuNlShroomPoke .7s steps(3) 1}
@keyframes fuNlIn{from{opacity:0}to{opacity:1}}
@keyframes fuNlBreathe{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes fuNlWave{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-3px)}}
@keyframes fuNlDot{0%,15%{opacity:0}16%,75%{opacity:1}76%,100%{opacity:0}}
@keyframes fuNlSpin{to{transform:rotate(360deg)}}
@keyframes fuNlStripe{from{background-position:0 0}to{background-position:24px 0}}
@keyframes fuNlPuff{0%{transform:translate(0,0) scale(.6);opacity:.9}100%{transform:translate(var(--dx),var(--dy)) scale(1.4);opacity:0}}
@keyframes fuNlBonk{0%,100%{transform:translateX(0)}25%{transform:translateX(3px) rotate(1deg)}50%{transform:translateX(-2px)}75%{transform:translateX(1px)}}
@keyframes fuNlMomIdle{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes fuNlMomPoke{0%{transform:translate(0,0) rotate(0)}25%{transform:translate(4px,-30px) rotate(-12deg)}55%{transform:translate(10px,-22px) rotate(6deg)}80%{transform:translate(4px,-6px) rotate(2deg)}100%{transform:translate(0,0) rotate(0)}}
@keyframes fuNlSlimeIdle{0%,100%{transform:scale(1,1)}25%{transform:scale(1.08,.92)}50%{transform:scale(.96,1.05)}75%{transform:scale(1.04,.97)}}
@keyframes fuNlSlimePoke{0%{transform:translateY(0) scale(1,1)}20%{transform:translateY(0) scale(1.3,.65)}45%{transform:translateY(-30px) scale(.85,1.2)}70%{transform:translateY(0) scale(1.2,.8)}85%{transform:translateY(0) scale(.95,1.05)}100%{transform:translateY(0) scale(1,1)}}
@keyframes fuNlSylphIdle{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-7px) rotate(3deg)}}
@keyframes fuNlSylphPoke{0%{transform:translateY(0) rotate(0)}50%{transform:translateY(-26px) rotate(180deg)}100%{transform:translateY(0) rotate(360deg)}}
@keyframes fuNlBoarIdle{0%,68%,100%{transform:translateX(0)}72%{transform:translateX(-1px)}76%{transform:translateX(1px)}80%{transform:translateX(-1px)}84%{transform:translateX(1px)}}
@keyframes fuNlBoarPoke{0%{transform:translateX(0) rotate(0)}15%{transform:translateX(-8px) rotate(2deg)}45%{transform:translateX(30px) rotate(0)}55%{transform:translateX(20px) rotate(-7deg)}75%{transform:translateX(5px) rotate(0)}100%{transform:translateX(0) rotate(0)}}
@keyframes fuNlShroomIdle{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
@keyframes fuNlShroomPoke{0%{transform:translateY(0) scale(1,1)}25%{transform:translateY(0) scale(1.12,.82)}50%{transform:translateY(-18px) scale(.95,1.08)}75%{transform:translateY(0) scale(1.06,.94)}100%{transform:translateY(0) scale(1,1)}}
@media (prefers-reduced-motion: reduce){${R} *,${R}{animation:none!important;transition:none!important}}
`;
    document.head.appendChild(style);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function enabled() {
    try { return game.settings.get(MODULE_ID, SETTING) !== false; } catch { return true; }
  }

  wrapTextureLoader();
  wrapProgressBar();
  Hooks.on("canvasTearDown", () => startDraw());
  // a draw after a failed one has no canvasTearDown (the world-entry session starts at `init`)
  Hooks.on("canvasInit", () => {
    if (!draw || draw.readyAt) startDraw({ entry: !booted });
    draw.sawLoading = true;
  });
  Hooks.on("canvasReady", finishDraw);

  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, SETTING, {
        name: "Loading indicator on the black screen",
        hint: "Shows the game's \"Now Loading\" screen when entering the world and when a map takes more than 2 seconds to load: progress, tips and a mascot, with no map names. Turn it off for Foundry's plain loading bar; nobody needs to reload.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: on => { if (!on) { hide(); liftBootCover(); document.body.classList.remove(COVER_CLASS); } },
      });
    } catch (err) { console.warn(TAG, "setting registration failed", err); }
    // load the art now, so neither world entry nor a slow map waits on it (the met mascots follow at ready)
    for (const src of [LOGO, ...MASCOTS.filter(m => m.always).map(m => m.src)]) {
      const img = new Image();
      img.decoding = "async";
      img.src = src;
      preloaded.push(img);
    }
    // The world setting is readable here (checked on v12.343); if a read ever fails, enabled() says
    // yes and `setup` takes the cover back when the switch is off. The indicator starts at once —
    // the world can set up for half a minute before its first draw, and plain black that long looks hung.
    try {
      if (enabled()) showBootCover();
      if (bootCover) { startDraw({ entry: true }); tick(); }
    } catch (err) { console.warn(TAG, "boot cover failed", err); }
  });

  Hooks.once("setup", () => { if (!enabled()) liftBootCover(); });

  Hooks.once("ready", () => {
    booted = true;
    try {
      ensureStyle();   // the toast lift must work before the indicator ever draws
      // screen-transition.js builds the cover on ready, before this runs (module.json order)
      const ov = document.getElementById(OVERLAY_ID);
      if (ov) ensureDom(ov);
      for (const [kind, data] of pendingRecords.splice(0)) record(kind, data);
      for (const m of allowedMascots()) {
        if (m.always) continue;
        const img = new Image();
        img.decoding = "async";
        img.src = m.src;
        preloaded.push(img);
      }
    } catch (err) { console.warn(TAG, "ready setup failed", err); }
    liftBootCover();
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};
    globalThis.FUCompanion.api.loadIndicator = {
      /** The draw in progress, for the console and the test bridge. */
      state: () => draw && { entry: draw.entry, elapsedMs: Date.now() - draw.t0, ...counts(draw), pending: pendingList(draw),
        texturesDone: !!draw.texDoneAt, ready: !!draw.readyAt, shown: draw.shown, mascot: draw.mascot?.id },
      /** The mascots this client may show: the house one plus those the bestiary has met. */
      mascots: () => allowedMascots().map(m => m.name),
    };
  });
})();
