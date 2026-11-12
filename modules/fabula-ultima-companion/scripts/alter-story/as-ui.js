/**
 * Alter the Story — everything on screen
 *
 * File: scripts/alter-story/as-ui.js
 *
 * A port of the approved mockup v1 (https://claude.ai/artifact/HWUJino19XLGjcHLE15jzV,
 * user 2026-11-11: "implement this vfx flow exactly"). The mockup drew a
 * 1600-wide screen; here every overlay sits in one layer of that same size,
 * scaled to the window, so sizes and spacing match it.
 *
 *   button     players only, right stack above the dice (and the Conflict
 *              Event emblem in battle); greyed with a reason when it can't open
 *   hold bar   everyone but the writer while a request is open: parchment
 *              strip top-centre + teal edge + desaturated map. A SOFT hold:
 *              nothing is locked (user, 2026-11-11: no player may hold the
 *              game hostage). GMs get Cancel on it, the writer gets Withdraw.
 *   composer   the writer: new / change, the statement, who it involves,
 *              "I'll say it on voice", Propose (cost shown, paid on approval)
 *   consent    a tagged hero's player: Agree / Refuse
 *   GM card    every GM; buttons on the Main GM only (GM II reads along)
 *   cinematic  approve: flash → dim + fate threads → rule lines → "Fate has
 *              been altered…" letter by letter → statement + GM note.
 *              deny: "The story holds." No point spent.
 *
 * No Foundry chat (user, 2026-11-11). Sounds: BattleCursor_3 (request
 * opens), BattleCursor_4 (sent / arrives), Flash2 + Saint5 (fate),
 * Cursor_Cancel (denied); the point sound comes from the Fabula tab.
 */
(() => {
  const TAG = "[AlterStory][ui]";
  const AS = globalThis.AlterStory = globalThis.AlterStory || {};
  const L = AS.Logic;
  if (!L) { console.error(TAG, "as-logic.js must load first."); return; }

  const SND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
  const SOUNDS = { ask: "BattleCursor_3.wav", send: "BattleCursor_4.wav", flash: "Flash2.ogg", fate: "Saint5.ogg", deny: "Cursor_Cancel.mp3" };
  const FONT_HREF = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&display=swap";
  const BTN_ID = "as-btn", LAYER_ID = "as-layer", STYLE_ID = "as-style";
  const W = 1600;   // the mockup's screen width
  const PLACE_MS = 400;

  const QUILL = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M25 4c-7 1.5-12 7-14.5 14.5L9 23"/><path d="M25 4c-1 6-5 11-11.5 13"/><path d="M9 23l-2.5 5"/></svg>`;
  const STAR = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.2 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>`;
  const BTN_ICON = `<svg viewBox="0 0 32 32" fill="none" stroke="#7ff0e0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M25 4c-7 1.5-12 7-14.5 14.5L9 23"/><path d="M25 4c-1 6-5 11-11.5 13"/><path d="M9 23l-2.5 5"/>
    <path d="M22 18.5l1 2.2 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z" fill="#14b8a6" stroke="none"/></svg>`;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const api = () => AS.api;

  function sfx(key, volume = 0.55) {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      AH?.play({ src: SND + SOUNDS[key], volume, autoplay: true, loop: false }, false);
    } catch { /* never load-bearing */ }
  }

  function spriteOf(actor) {
    try { const s = globalThis.FabulaLedger?._internal?.spriteOf?.(actor); if (s) return s; } catch { /* fall through */ }
    return actor?.prototypeToken?.texture?.src || actor?.img || "";
  }
  AS.spriteOf = spriteOf;

  // ── style (values from the mockup) ─────────────────────────────────────────
  const CSS = `
#${BTN_ID}{all:unset;box-sizing:border-box;position:fixed;z-index:85;width:46px;height:46px;border-radius:999px;cursor:pointer;
  background:radial-gradient(circle at 50% 38%,#20343a,#121a1f 70%);border:1px solid rgba(20,184,166,.55);
  box-shadow:0 0 0 2px rgba(10,20,22,.8),0 0 14px rgba(20,184,166,.28),0 8px 16px rgba(0,0,0,.45);display:grid;place-items:center;
  transition:transform .12s ease,opacity .3s,top .35s ease,left .35s ease}
#${BTN_ID}:hover{transform:translateY(-1px) scale(1.05)}
#${BTN_ID}:focus-visible{outline:2px solid #14b8a6;outline-offset:2px}
#${BTN_ID} svg{width:26px;height:26px}
#${BTN_ID} .cost{position:absolute;right:-5px;top:-5px;min-width:18px;height:18px;border-radius:9px;background:#14b8a6;color:#04201c;font:700 11px/18px "Signika",sans-serif;text-align:center;padding:0 4px;box-sizing:border-box;box-shadow:0 0 0 2px #0d1416}
#${BTN_ID} .tip{position:absolute;right:0;bottom:calc(100% + 10px);white-space:nowrap;background:rgba(10,10,12,.92);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 9px;font:12.5px "Signika",sans-serif;color:#eee;opacity:0;pointer-events:none;transition:opacity .15s}
#${BTN_ID}:hover .tip{opacity:1}
#${BTN_ID} .tip b{color:#7ff0e0}
#${BTN_ID}.off{opacity:.45}
#${BTN_ID}.off:hover{transform:none}
#${BTN_ID}.ping{animation:as-ping 1.2s ease-out 2}
@keyframes as-ping{0%{box-shadow:0 0 0 2px rgba(10,20,22,.8),0 0 0 0 rgba(20,184,166,.7)}100%{box-shadow:0 0 0 2px rgba(10,20,22,.8),0 0 0 22px rgba(20,184,166,0)}}

body.as-hold #board{filter:saturate(.55) brightness(.85);transition:filter .6s ease}
#${LAYER_ID}{position:fixed;left:0;top:0;width:${W}px;transform-origin:0 0;pointer-events:none;z-index:99990;font-family:"Signika","Noto Sans","Segoe UI",sans-serif}
#${LAYER_ID} .as-veil{position:absolute;inset:0;opacity:0;transition:opacity .5s;box-shadow:inset 0 0 140px 30px rgba(20,184,166,.28);background:rgba(4,14,16,.18)}
#${LAYER_ID}.hold .as-veil{opacity:1}

#${LAYER_ID} .as-holdbar{position:absolute;left:50%;top:22px;transform:translate(-50%,-140%);transition:transform .45s cubic-bezier(.2,1.2,.4,1);display:flex;align-items:center;gap:12px;
  padding:10px 18px 10px 92px;border-radius:10px;color:#3a1e06;min-width:420px;box-sizing:border-box;
  background:repeating-linear-gradient(0deg,transparent 0 11px,rgba(140,90,30,.05) 11px 12px),linear-gradient(168deg,#f8f0d4,#ede0b0);
  border:1px solid #c9a44a;box-shadow:0 0 0 2px #7a4e20,0 0 0 4px #b8865a,0 8px 18px rgba(0,0,0,.45)}
#${LAYER_ID}.hold .as-holdbar{transform:translate(-50%,0);pointer-events:auto}
#${LAYER_ID} .as-holdbar img{position:absolute;left:8px;bottom:0;height:96px;border:0!important;background:transparent;box-shadow:none;border-radius:0;object-fit:contain;object-position:bottom}
#${LAYER_ID} .as-holdbar .t1{font-size:17px;font-weight:700}
#${LAYER_ID} .as-holdbar .t2{font-size:13px;color:#7a5a2e}
#${LAYER_ID} .as-holdbar .quill{width:22px;height:22px;color:#0f766e;flex:none}
#${LAYER_ID} .as-holdbar .quill svg{width:100%;height:100%}
#${LAYER_ID} .as-holdbar .act{margin-left:auto}
#${LAYER_ID} .dots i{display:inline-block;width:5px;height:5px;margin-left:3px;border-radius:50%;background:#7a5a2e;animation:as-dot 1.2s infinite}
#${LAYER_ID} .dots i:nth-child(2){animation-delay:.2s}#${LAYER_ID} .dots i:nth-child(3){animation-delay:.4s}
@keyframes as-dot{0%,80%,100%{opacity:.25}40%{opacity:1}}

#${LAYER_ID} .as-parch{position:absolute;color:#3a1e06;border-radius:10px;box-sizing:border-box;
  background:repeating-linear-gradient(0deg,transparent 0 11px,rgba(140,90,30,.05) 11px 12px),linear-gradient(168deg,#f8f0d4,#ede0b0);
  border:1px solid #c9a44a;box-shadow:0 0 0 2px #7a4e20,0 0 0 4px #b8865a,0 10px 26px rgba(0,0,0,.55);
  opacity:0;transform:translateY(14px);transition:opacity .3s,transform .35s cubic-bezier(.2,1.1,.4,1);pointer-events:none;visibility:hidden}
#${LAYER_ID} .as-parch.on{opacity:1;transform:none;pointer-events:auto;visibility:visible}
#${LAYER_ID} .as-parch h4{margin:0;font-size:20px;font-weight:700;display:flex;align-items:center;gap:8px;border:0;color:inherit;font-family:inherit}
#${LAYER_ID} .as-parch h4 .q{width:22px;height:22px;color:#0f766e;display:inline-flex}
#${LAYER_ID} .as-parch h4 svg{width:100%;height:100%}
#${LAYER_ID} .sub{font-size:13px;color:#7a5a2e}
#${LAYER_ID} .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#${LAYER_ID} .as-b{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 14px;border-radius:6px;font-size:14px;line-height:20px;color:#f6ead0;background:linear-gradient(180deg,#7a5230,#5c3818);box-shadow:inset 0 1px 0 rgba(255,235,190,.18)}
#${LAYER_ID} .as-b:hover{filter:brightness(1.12)}
#${LAYER_ID} .as-b.ok{box-shadow:0 0 0 2px #c9a44a,0 0 8px rgba(255,215,106,.45)}
#${LAYER_ID} .as-b.ghost{background:transparent;color:#5c3818;box-shadow:inset 0 0 0 1px rgba(92,56,24,.45)}
#${LAYER_ID} .as-b.no{background:linear-gradient(180deg,#8a3a26,#62230f)}
#${LAYER_ID} .as-b:focus-visible{outline:2px solid #0f766e;outline-offset:2px}
#${LAYER_ID} .as-b[disabled]{opacity:.5;cursor:default}
#${LAYER_ID} img{border:0!important;background:transparent;box-shadow:none}

#${LAYER_ID} .as-composer{left:50%;top:150px;width:600px;margin-left:-300px;padding:18px 20px 16px;display:flex;flex-direction:column;gap:12px}
#${LAYER_ID} .kind{display:flex;gap:6px}
#${LAYER_ID} .kind span{padding:4px 10px;border-radius:99px;font-size:13px;border:1px solid rgba(92,56,24,.35);cursor:pointer}
#${LAYER_ID} .kind span.on{background:#0f766e;border-color:#0f766e;color:#eafffb}
#${LAYER_ID} .as-ta{all:unset;box-sizing:border-box;display:block;width:100%;min-height:86px;border-radius:8px;background:rgba(255,255,255,.55);border:1px solid rgba(122,78,32,.35);padding:10px 12px;
  font-family:"Cormorant Garamond",Georgia,serif;font-size:19px;line-height:1.35;color:#2c1604;white-space:pre-wrap;resize:none}
#${LAYER_ID} .as-ta:focus{border-color:#0f766e;box-shadow:0 0 0 2px rgba(15,118,110,.25)}
#${LAYER_ID} .as-ta::placeholder{color:#9a7d55;font-style:italic}
#${LAYER_ID} .as-ta.spoken{font-family:inherit;font-size:14px;color:#7a5a2e;font-style:italic;display:flex;align-items:center}
#${LAYER_ID} .touches{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
#${LAYER_ID} .chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px 2px 4px;border-radius:99px;background:rgba(122,78,32,.12);border:1px solid rgba(122,78,32,.3);cursor:pointer;user-select:none}
#${LAYER_ID} .chip img{width:20px;height:20px;object-fit:cover;object-position:top;border-radius:50%;background:#e8d9a6}
#${LAYER_ID} .chip.need{border-color:#0f766e;background:rgba(15,118,110,.12)}
#${LAYER_ID} .chip .st{color:#0f766e}
#${LAYER_ID} .rules{font-size:12.5px;color:#7a5a2e;display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;border-top:1px dashed rgba(122,78,32,.35);padding-top:8px}
#${LAYER_ID} .rules div::before{content:"◆ ";color:#c9a44a}
#${LAYER_ID} .costline{margin-left:auto;font-size:13.5px;display:flex;align-items:center;gap:5px}
#${LAYER_ID} .costline svg{width:15px;height:15px;color:#0f766e}
#${LAYER_ID} .reason{font-size:13.5px;padding:6px 10px;border-radius:6px;background:rgba(162,74,42,.12);border:1px solid rgba(162,74,42,.35);color:#6a2a12}
#${LAYER_ID} .chk{display:flex;gap:5px;align-items:center;cursor:pointer}
#${LAYER_ID} .chk input{accent-color:#0f766e;margin:0}

#${LAYER_ID} .as-consent{right:72px;top:12px;width:470px;padding:12px 14px 14px 92px;display:flex;flex-direction:column;gap:8px}
#${LAYER_ID} .as-consent img.sp{position:absolute;left:6px;bottom:0;height:104px;object-fit:contain;object-position:bottom}
#${LAYER_ID} .as-consent .q{font-family:"Cormorant Garamond",Georgia,serif;font-style:italic;font-size:16.5px;line-height:1.3}

#${LAYER_ID} .as-gm{left:50%;top:110px;width:640px;margin-left:-320px;padding:16px 20px 16px 120px;display:flex;flex-direction:column;gap:10px}
#${LAYER_ID} .as-gm img.sp{position:absolute;left:10px;bottom:16px;height:132px;max-width:104px;object-fit:contain;object-position:bottom}
#${LAYER_ID} .as-gm .q{font-family:"Cormorant Garamond",Georgia,serif;font-size:21px;line-height:1.35;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.5);border:1px solid rgba(122,78,32,.3);white-space:pre-wrap}
#${LAYER_ID} .as-gm .q.spoken{font-family:inherit;font-size:14px;font-style:italic;color:#7a5a2e}
#${LAYER_ID} .tags{display:flex;flex-wrap:wrap;gap:6px;font-size:12.5px}
#${LAYER_ID} .tag{padding:1px 8px;border-radius:99px;border:1px solid rgba(122,78,32,.35)}
#${LAYER_ID} .tag.ok{border-color:#2f7d4f;color:#1f5a37}
#${LAYER_ID} .tag.warn{border-color:#a8641c;color:#7a4510}
#${LAYER_ID} .as-in{all:unset;box-sizing:border-box;width:100%;border-radius:6px;background:rgba(255,255,255,.55);border:1px solid rgba(122,78,32,.35);padding:6px 9px;font-size:14px;color:#2c1604}
#${LAYER_ID} .as-in:focus{border-color:#0f766e}
#${LAYER_ID} .readonly{font-size:13px;color:#7a5a2e;font-style:italic}

#${LAYER_ID} .as-toast{position:absolute;left:50%;top:24px;transform:translate(-50%,-150%);transition:transform .4s cubic-bezier(.2,1.2,.4,1);padding:8px 16px;border-radius:8px;background:rgba(12,14,18,.9);border:1px solid rgba(255,255,255,.14);font-size:15px;color:#efe8d6;white-space:nowrap}
#${LAYER_ID} .as-toast.on{transform:translate(-50%,0)}
#${LAYER_ID} .as-toast b{color:#7ff0e0}

#${LAYER_ID} .as-cine{position:absolute;inset:0;display:none;transition:opacity .6s}
#${LAYER_ID} .as-cine.on{display:block}
#${LAYER_ID} .as-cine.out{opacity:0}
#${LAYER_ID} .as-cine .flash{position:absolute;inset:0;background:#fff;opacity:0}
#${LAYER_ID} .as-cine .dim{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(4,10,12,.72),rgba(0,0,0,.92));opacity:0;transition:opacity .9s ease}
#${LAYER_ID} .as-cine canvas{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 1s}
#${LAYER_ID} .as-cine .center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center}
#${LAYER_ID} .as-cine .rule{height:1px;width:0;background:linear-gradient(90deg,transparent,#7ff0e0,transparent);transition:width 1.1s cubic-bezier(.2,.8,.2,1)}
#${LAYER_ID} .as-cine .head{font-family:"Cormorant Garamond",Georgia,serif;font-weight:600;font-size:62px;letter-spacing:.04em;color:#f3fffc;text-shadow:0 0 22px rgba(20,184,166,.65),0 0 2px #000}
#${LAYER_ID} .as-cine .head span{opacity:0;display:inline-block;filter:blur(6px);transform:translateY(6px);transition:opacity .5s,filter .6s,transform .6s}
#${LAYER_ID} .as-cine .head span.in{opacity:1;filter:none;transform:none}
#${LAYER_ID} .as-cine .what{max-width:820px;font-family:"Cormorant Garamond",Georgia,serif;font-style:italic;font-size:27px;line-height:1.35;color:#e6f6f2;opacity:0;transform:translateY(8px);transition:opacity 1s,transform 1s}
#${LAYER_ID} .as-cine .who{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#7ff0e0;opacity:0;transition:opacity .8s}
#${LAYER_ID} .as-cine .note{font-size:16px;color:#d9cfb5;opacity:0;transition:opacity .8s;max-width:700px}
#${LAYER_ID} .as-cine .note b{color:#f1d58a;font-weight:600}
#${LAYER_ID} .as-cine.show .what,#${LAYER_ID} .as-cine.show .who,#${LAYER_ID} .as-cine.show .note{opacity:1;transform:none}
#${LAYER_ID} .as-cine.denied .head{font-size:44px;color:#f0e6d0;text-shadow:0 0 18px rgba(0,0,0,.8)}
@media (prefers-reduced-motion:reduce){#${LAYER_ID} *,#${BTN_ID}{transition-duration:.01s!important;animation:none!important}}
`;

  function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style"); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
    }
    if (!document.querySelector(`link[href="${FONT_HREF}"]`)) {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = FONT_HREF; document.head.appendChild(link);
    }
  }

  // ── layer (the mockup's 1600-wide screen, scaled) ──────────────────────────
  const D = {};
  function layer() {
    if (D.layer?.isConnected) return D.layer;
    ensureStyle();
    const el = document.createElement("div");
    el.id = LAYER_ID;
    el.innerHTML = `
      <div class="as-veil"></div>
      <div class="as-parch as-composer" role="dialog" aria-label="Alter the Story"></div>
      <div class="as-parch as-consent" role="dialog" aria-label="Alter the Story: your OK"></div>
      <div class="as-parch as-gm" role="dialog" aria-label="Alter the Story: GM"></div>
      <div class="as-cine"><div class="flash"></div><div class="dim"></div><canvas></canvas>
        <div class="center"><div class="who"></div><div class="rule r1"></div><div class="head"></div><div class="rule r2"></div><div class="what"></div><div class="note"></div></div></div>`;
    document.body.appendChild(el);
    D.layer = el;
    // The hold bar and toast are NOT built here: they live off the top edge when idle and
    // their edges peeked onto the screen (v1.0.585). They are spawned on call instead.
    D.veil = $(".as-veil", el); D.hold = null; D.comp = $(".as-composer", el);
    D.consent = $(".as-consent", el); D.gm = $(".as-gm", el); D.toast = null; D.cine = $(".as-cine", el);
    fit();
    return el;
  }
  function fit() {
    if (!D.layer) return;
    const s = window.innerWidth / W;
    D.layer.style.transform = `scale(${s})`;
    D.layer.style.height = `${Math.round(window.innerHeight / s)}px`;
    const cv = D.cine?.querySelector("canvas");
    if (cv) { cv.width = W; cv.height = Math.round(window.innerHeight / s); }
  }

  // ── button ─────────────────────────────────────────────────────────────────
  function isSpectator() { try { return !!globalThis.FUCompanion?.api?.Spectator?.isSpectator?.(); } catch { return false; } }
  function buttonWanted() {
    if (game.user?.isGM || !game.user?.character || isSpectator()) return false;
    return !["title", "gacha"].includes(api()?.sceneMode?.() ?? "");
  }
  function button() {
    let b = document.getElementById(BTN_ID);
    if (b) return b;
    ensureStyle();
    b = document.createElement("button");
    b.id = BTN_ID; b.type = "button";
    b.setAttribute("aria-label", "Alter the Story, 1 Fabula Point");
    b.innerHTML = `${BTN_ICON}<span class="cost">1</span><span class="tip"></span>`;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onButton(); });
    document.body.appendChild(b);
    return b;
  }
  const REFUSE_TEXT = { "no-fp": "You have no Fabula Points", busy: null, scene: "Not available here", "no-character": "You have no character" };
  function tipFor(v) {
    const cur = api()?.current;
    if (v.ok) return "<b>Alter the Story</b> · spend 1 Fabula Point";
    if (v.reason === "busy") return cur?.userId === game.user.id ? "<b>Alter the Story</b> · you're writing" : `${esc(cur?.actorName ?? "Someone")} is altering the story`;
    return esc(REFUSE_TEXT[v.reason] ?? "Not available");
  }
  function place() {
    const wanted = buttonWanted();
    let b = document.getElementById(BTN_ID);
    if (!wanted) { b?.remove(); return; }
    b = button();
    const slot = globalThis.oni?.HudDock?.rightSlot?.("alter-story");
    if (slot) { b.style.left = `${slot.left}px`; b.style.top = `${slot.top}px`; b.style.right = b.style.bottom = ""; }
    else { b.style.right = "320px"; b.style.bottom = "106px"; }
    const v = api()?.canOpenHere?.() ?? { ok: false, reason: "busy" };
    const mineOpen = v.reason === "busy" && api()?.current?.userId === game.user.id;
    b.classList.toggle("off", !v.ok && !mineOpen);
    const tip = b.querySelector(".tip"), html = tipFor(v);
    if (tip.innerHTML !== html) tip.innerHTML = html;
  }
  function onButton() {
    const v = api()?.canOpenHere?.();
    if (!v) return;
    if (v.ok) { api().open(); return; }
    if (v.reason === "busy" && api().current?.userId === game.user.id) { D.comp?.querySelector("textarea")?.focus(); return; }
    toast(tipFor(v));
  }

  // ── toast ──────────────────────────────────────────────────────────────────
  // Spawned on call, removed once it has slid back out (transition .4s). A new toast
  // during the slide-out reuses the same element and slides it back in.
  const SLIDE_OUT_MS = 600;
  function toast(html, ms = 2600) {
    layer();
    let el = D.toast;
    if (!el?.isConnected) {
      el = document.createElement("div");
      el.className = "as-toast";
      D.layer.appendChild(el);
      void el.offsetWidth;          // start from the off-screen spot so it slides in
      D.toast = el;
    }
    clearTimeout(D.toastT);
    el.innerHTML = html;
    el.classList.add("on");
    D.toastT = setTimeout(() => {
      el.classList.remove("on");
      D.toastT = setTimeout(() => { el.remove(); if (D.toast === el) D.toast = null; }, SLIDE_OUT_MS);
    }, ms);
  }

  // ── party members to tag ───────────────────────────────────────────────────
  function partyHeroes(excludeActorId) {
    const ids = (() => { try { return globalThis.FUCompanion?.api?.Spectator?.partyActorIds?.(); } catch { return null; } })()
      ?? game.users.filter(u => !u.isGM && u.character).map(u => u.character.id);
    const out = [];
    for (const id of new Set(ids ?? [])) {
      if (id === excludeActorId) continue;
      const a = game.actors?.get(id);
      if (!a) continue;
      const owner = game.users.find(u => !u.isGM && u.active && u.character?.id === id);
      out.push({ actorId: id, name: a.name, img: spriteOf(a), userId: owner?.id ?? null });
    }
    return out;
  }

  // ── composer (writer) ──────────────────────────────────────────────────────
  const draft = { reqId: null, kind: "add", text: "", spoken: false, tags: new Set() };
  function drawComposer(req) {
    if (draft.reqId !== req.id || D.comp.dataset.phaseSeen !== "writing") {
      // a fresh request, or back to writing after a revise / refusal: start from the request
      if (draft.reqId !== req.id) { draft.text = ""; draft.kind = "add"; draft.spoken = false; draft.tags = new Set(); }
      if (req.text) draft.text = req.text;
      if (req.kind) draft.kind = req.kind;
      draft.spoken = !!req.spoken;
      for (const h of req.involves ?? []) draft.tags.add(h.actorId);
      draft.reqId = req.id;
    }
    D.comp.dataset.phaseSeen = "writing";
    const fp = api().fpOf(game.actors?.get(req.actorId));
    const heroes = partyHeroes(req.actorId);
    D.comp.innerHTML = `
      <h4><span class="q">${QUILL}</span>Alter the Story</h4>
      ${req.reason ? `<div class="reason">${esc(req.reason)}</div>` : ""}
      <div class="kind"><span data-k="add" class="${draft.kind === "add" ? "on" : ""}">Add something new</span><span data-k="change" class="${draft.kind === "change" ? "on" : ""}">Change something already there</span></div>
      ${draft.spoken
        ? `<div class="as-ta spoken">Sent with no text: you'll say it on voice.</div>`
        : `<textarea class="as-ta" maxlength="${L.TEXT_MAX}" placeholder="What becomes true?"></textarea>`}
      <div class="touches"><span class="sub">Involves:</span>
        ${heroes.map(h => `<span class="chip${draft.tags.has(h.actorId) ? " need" : ""}" data-a="${esc(h.actorId)}"><img src="${esc(h.img)}" alt="">${esc(h.name)}${draft.tags.has(h.actorId) ? ` <span class="st">· ${h.userId ? "asks them first" : "player away · GM decides"}</span>` : ""}</span>`).join("")}
        ${heroes.length ? "" : `<span class="sub">no other heroes here</span>`}
      </div>
      <div class="rules">
        <div>Can't undo what anyone already said</div>
        <div>No new skills or statuses; the GM may grant an edge</div>
        <div>New characters stay with the GM</div>
        <div>The point is spent only if approved</div>
      </div>
      <div class="row">
        <button class="as-b ghost" data-do="cancel" type="button">Cancel</button>
        <label class="sub chk"><input type="checkbox" data-do="spoken" ${draft.spoken ? "checked" : ""}> I'll say it on voice</label>
        <span class="costline">${STAR}${fp} → ${Math.max(0, fp - L.COST)}</span>
        <button class="as-b ok" data-do="propose" type="button">Propose</button>
      </div>`;
    const ta = D.comp.querySelector("textarea");
    if (ta) {
      ta.value = draft.text;
      ta.addEventListener("input", () => { draft.text = ta.value; });
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();   // keep game hotkeys out of the box
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); propose(); }
      });
      ta.addEventListener("keyup", (e) => e.stopPropagation());
    }
    D.comp.querySelectorAll(".kind span").forEach(s => s.addEventListener("click", () => { draft.kind = s.dataset.k; redraw(); }));
    D.comp.querySelectorAll(".chip[data-a]").forEach(c => c.addEventListener("click", () => {
      const id = c.dataset.a; draft.tags.has(id) ? draft.tags.delete(id) : draft.tags.add(id); redraw();
    }));
    D.comp.querySelector('[data-do="spoken"]').addEventListener("change", (e) => { draft.spoken = e.target.checked; redraw(); });
    D.comp.querySelector('[data-do="cancel"]').addEventListener("click", () => api().cancel());
    D.comp.querySelector('[data-do="propose"]').addEventListener("click", propose);
    function redraw() { D.comp.dataset.phaseSeen = "writing"; drawComposer(api().current ?? req); D.comp.querySelector("textarea")?.focus(); }
  }
  function propose() {
    const req = api().current;
    if (!req) return;
    if (!draft.spoken && !draft.text.trim()) { D.comp.querySelector("textarea")?.focus(); toast("Write what becomes true, or tick “I'll say it on voice”."); return; }
    const heroes = partyHeroes(req.actorId).filter(h => draft.tags.has(h.actorId));
    sfx("send", 0.45);
    api().submit({ kind: draft.kind, text: draft.spoken ? "" : draft.text, spoken: draft.spoken, involves: heroes });
  }

  // ── consent (tagged hero's player) ─────────────────────────────────────────
  function myPendingConsent(req) {
    if (req?.phase !== L.PHASE.CONSENT) return null;
    return req.involves.find(h => h.userId === game.user.id && req.consents?.[h.actorId] === "pending") ?? null;
  }
  function drawConsent(req, hero) {
    D.consent.innerHTML = `
      <img class="sp" src="${esc(req.img)}" alt="">
      <div style="font-size:16px;font-weight:700">${esc(req.actorName)}'s change involves ${esc(hero.name)}. OK?</div>
      <div class="q">${req.spoken ? "They'll say it on voice." : `“${esc(req.text)}”`}</div>
      <div class="row"><button class="as-b ok" data-do="yes" type="button">Agree</button><button class="as-b ghost" data-do="no" type="button">Refuse</button><span class="sub" style="margin-left:auto">GM sees it after you</span></div>`;
    D.consent.querySelector('[data-do="yes"]').addEventListener("click", () => api().consent(hero.actorId, true));
    D.consent.querySelector('[data-do="no"]').addEventListener("click", () => api().consent(hero.actorId, false));
  }

  // ── GM card ────────────────────────────────────────────────────────────────
  function drawGM(req) {
    const primary = api().isPrimaryGM();
    const fp = api().fpOf(game.actors?.get(req.actorId));
    const scene = game.scenes?.get(req.sceneId);
    const mode = req.sceneMode ? req.sceneMode[0].toUpperCase() + req.sceneMode.slice(1) : "";
    const tags = [];
    if (req.kind === "change") tags.push(`<span class="tag warn">Changes something already there</span>`);
    for (const h of req.involves ?? []) {
      const c = req.consents?.[h.actorId];
      tags.push(c === "yes" ? `<span class="tag ok">${esc(h.name)} agreed</span>` : `<span class="tag warn">Involves ${esc(h.name)} (player away)</span>`);
    }
    tags.push(`<span class="tag">${esc(scene?.navName || scene?.name || "")}${mode ? ` · ${esc(mode)}` : ""}</span>`);
    const keepNote = D.gm.querySelector('[data-f="note"]')?.value ?? "";
    const keepSum = D.gm.querySelector('[data-f="sum"]')?.value ?? "";
    D.gm.innerHTML = `
      <img class="sp" src="${esc(req.img)}" alt="">
      <div class="row" style="justify-content:space-between"><h4 style="font-size:18px">${esc(req.actorName)} wants to alter the story</h4><span class="sub">${esc(req.actorName)} has ${fp} FP</span></div>
      <div class="q${req.spoken ? " spoken" : ""}">${req.spoken ? "Told on voice chat. Listen in, then rule." : `“${esc(req.text)}”`}</div>
      <div class="tags">${tags.join("")}</div>
      ${primary ? `
        ${req.spoken ? `<input class="as-in" data-f="sum" maxlength="${L.TEXT_MAX}" placeholder="One-line summary for the fate and the log (optional)">` : ""}
        <input class="as-in" data-f="note" maxlength="${L.NOTE_MAX}" placeholder="Your note: a catch shown with the fate, or why for revise / deny (optional)">
        <div class="row"><button class="as-b ok" data-do="approve" type="button">Approve</button><button class="as-b ghost" data-do="revise" type="button">Ask to revise</button><button class="as-b no" data-do="deny" type="button">Deny</button><span class="sub" style="margin-left:auto">no timer · Space pauses the table</span></div>`
      : `<div class="readonly">The Main GM is deciding. You see what they see.</div>`}`;
    if (!primary) return;
    const note = D.gm.querySelector('[data-f="note"]'), sum = D.gm.querySelector('[data-f="sum"]');
    note.value = keepNote; if (sum) sum.value = keepSum;
    for (const inp of [note, sum].filter(Boolean)) {
      inp.addEventListener("keydown", (e) => e.stopPropagation());
      inp.addEventListener("keyup", (e) => e.stopPropagation());
    }
    D.gm.querySelector('[data-do="approve"]').addEventListener("click", () => api().approve(note.value, sum?.value ?? ""));
    D.gm.querySelector('[data-do="revise"]').addEventListener("click", () => api().revise(note.value));
    D.gm.querySelector('[data-do="deny"]').addEventListener("click", () => api().deny(note.value));
  }

  // ── hold bar ───────────────────────────────────────────────────────────────
  const DOTS = `<span class="dots"><i></i><i></i><i></i></span>`;
  // Spawned when a hold starts (in its off-screen spot, so the .hold class slides it in),
  // removed after it has slid back out. A new hold during the slide-out keeps the element.
  function holdEl() {
    clearTimeout(D.holdT); D.holdT = 0;
    if (D.hold?.isConnected) return D.hold;
    const el = document.createElement("div");
    el.className = "as-holdbar"; el.setAttribute("role", "status");
    el.innerHTML = `<img alt=""><span class="quill">${QUILL}</span>
      <div><div class="t1"></div><div class="t2"></div></div><span class="act"></span>`;
    D.layer.appendChild(el);
    void el.offsetWidth;
    D.hold = el;
    return el;
  }
  function dropHold() {
    const el = D.hold;
    if (!el || D.holdT) return;
    D.holdT = setTimeout(() => {
      D.holdT = 0;
      if (D.layer?.classList.contains("hold")) return;
      el.remove(); if (D.hold === el) D.hold = null;
    }, SLIDE_OUT_MS);
  }
  function drawHold(req) {
    holdEl();
    const me = game.user, writer = req.userId === me.id, gm = me.isGM, primary = api().isPrimaryGM();
    const name = esc(req.actorName);
    let t1 = "", t2 = "Hold your actions for a moment.", act = "";
    if (writer) {
      t1 = req.phase === L.PHASE.CONSENT ? `Waiting for ${esc(req.involves.filter(h => req.consents?.[h.actorId] === "pending").map(h => h.name).join(", "))}${DOTS}` : `Waiting for the GM${DOTS}`;
      t2 = "Your point is only spent if it's approved.";
      act = `<button class="as-b ghost" data-do="withdraw" type="button">Withdraw</button>`;
    } else if (req.phase === L.PHASE.WRITING) {
      t1 = `${name} is altering the story${DOTS}`;
      if (gm) t2 = "Players are asked to wait. You'll get the card when it's sent.";
    } else if (req.phase === L.PHASE.CONSENT) {
      const mine = myPendingConsent(req);
      t1 = mine ? `${name} is asking you` : `${name} is asking ${esc(req.involves.filter(h => req.consents?.[h.actorId] === "pending").map(h => h.name).join(", "))}${DOTS}`;
    } else if (req.phase === L.PHASE.GM) {
      t1 = gm ? `${name}'s alteration is waiting` : `The GM is reading ${name}'s change${DOTS}`;
      if (gm) t2 = primary ? "Read it, then rule below." : "The Main GM rules on it.";
    }
    if (gm) act = `<button class="as-b ghost" data-do="gmcancel" type="button">Cancel request</button>`;
    const img = $("img", D.hold);
    if (img.getAttribute("src") !== req.img) img.setAttribute("src", req.img || "");
    $(".t1", D.hold).innerHTML = t1;
    $(".t2", D.hold).textContent = t2;
    const actEl = $(".act", D.hold);
    if (actEl.innerHTML !== act) {
      actEl.innerHTML = act;
      actEl.querySelector("button")?.addEventListener("click", () => api().cancel());
    }
  }

  // ── cinematic ──────────────────────────────────────────────────────────────
  const cine = { timers: [], raf: 0 };
  const later = (fn, ms) => cine.timers.push(setTimeout(fn, ms));
  function clearCine({ fade = false } = {}) {
    cine.timers.forEach(clearTimeout); cine.timers = [];
    const el = D.cine; if (!el) return;
    const reset = () => {
      cancelAnimationFrame(cine.raf);
      el.className = "as-cine";
      const f = $(".flash", el); f.style.transition = "none"; f.style.opacity = 0;
      $(".dim", el).style.opacity = 0; $("canvas", el).style.opacity = 0;
      el.querySelectorAll(".rule").forEach(r => { r.style.width = "0"; });
      $(".head", el).innerHTML = "";
    };
    if (fade && el.classList.contains("on")) { el.classList.add("out"); later(reset, 650); } else reset();
  }
  function threads() {
    const cv = $("canvas", D.cine), g = cv.getContext("2d");
    const H = cv.height;
    const lines = [...Array(26)].map(() => ({ y: Math.random() * H, a: Math.random() * 6.28, s: .3 + Math.random() * .7, amp: 20 + Math.random() * 60, w: .6 + Math.random() * 1.4 }));
    const t0 = performance.now();
    const draw = (t) => {
      const k = (t - t0) / 1000; g.clearRect(0, 0, W, H);
      for (const ln of lines) {
        g.beginPath();
        for (let x = -20; x <= W + 20; x += 20) { const y = ln.y + Math.sin(x / 180 + ln.a + k * ln.s) * ln.amp; x < 0 ? g.moveTo(x, y) : g.lineTo(x, y); }
        g.strokeStyle = `rgba(127,240,224,${.06 + .05 * Math.sin(k * 1.3 + ln.a)})`; g.lineWidth = ln.w; g.stroke();
      }
      cine.raf = requestAnimationFrame(draw);
    };
    cine.raf = requestAnimationFrame(draw);
  }
  const letters = (s) => [...s].map(ch => `<span>${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
  function playFate(req) {
    layer(); clearCine();
    const el = D.cine;
    el.classList.add("on");
    $(".who", el).textContent = `${req.actorName} spent a Fabula Point`;
    $(".what", el).textContent = L.cineText(req);
    $(".note", el).innerHTML = req.note ? `<b>GM:</b> ${esc(req.note)}` : "";
    $(".head", el).innerHTML = letters("Fate has been altered…");
    sfx("flash", 0.6);
    const f = $(".flash", el); f.style.transition = "none"; f.style.opacity = .95;
    requestAnimationFrame(() => { f.style.transition = "opacity .7s ease-out"; f.style.opacity = 0; });
    later(() => { $(".dim", el).style.opacity = 1; $("canvas", el).style.opacity = 1; threads(); sfx("fate", 0.55); }, 180);
    later(() => el.querySelectorAll(".rule").forEach(r => { r.style.width = "520px"; }), 600);
    el.querySelectorAll(".head span").forEach((s, i) => later(() => s.classList.add("in"), 900 + i * 55));
    later(() => el.classList.add("show"), 2300);
  }
  function playDenied(req) {
    layer(); clearCine();
    const el = D.cine;
    el.classList.add("on", "denied");
    $(".who", el).textContent = `${req.actorName}'s request was declined · no point spent`;
    $(".what", el).textContent = "";
    $(".note", el).innerHTML = req.reason ? `<b>GM:</b> ${esc(req.reason)}` : "";
    $(".head", el).innerHTML = letters("The story holds.");
    $(".dim", el).style.opacity = .55;
    sfx("deny", 0.5);
    el.querySelectorAll(".head span").forEach((s, i) => later(() => s.classList.add("in"), 200 + i * 35));
    later(() => el.classList.add("show"), 700);
  }

  // ── state → screen ─────────────────────────────────────────────────────────
  function render(req, prev, closed) {
    layer();
    const me = game.user, writer = req?.userId === me.id;
    const open = !!req && L.OPEN_PHASES.has(req.phase);
    const holding = open && !(writer && req.phase === L.PHASE.WRITING);
    if (holding) holdEl();          // exists in its off spot BEFORE .hold, so it slides in
    D.layer.classList.toggle("hold", holding);
    document.body.classList.toggle("as-hold", holding);
    if (holding) drawHold(req); else dropHold();

    // composer
    const showComp = open && writer && req.phase === L.PHASE.WRITING;
    if (showComp) {
      const fresh = prev?.id !== req.id || prev?.phase !== L.PHASE.WRITING;
      if (fresh) { D.comp.dataset.phaseSeen = ""; drawComposer(req); setTimeout(() => D.comp.querySelector("textarea")?.focus(), 60); }
    } else D.comp.dataset.phaseSeen = "";
    D.comp.classList.toggle("on", showComp);

    // consent
    const hero = open ? myPendingConsent(req) : null;
    if (hero && !D.consent.classList.contains("on")) drawConsent(req, hero);
    D.consent.classList.toggle("on", !!hero);

    // GM card
    const showGM = open && me.isGM && req.phase === L.PHASE.GM;
    if (showGM && (prev?.id !== req.id || prev?.phase !== L.PHASE.GM)) { D.gm.innerHTML = ""; drawGM(req); }
    D.gm.classList.toggle("on", showGM);

    // sounds + cinematics on transitions
    const was = prev?.id === req?.id ? prev?.phase : null;
    if (req && !prev) {
      sfx("ask", 0.5);
      if (writer) { const b = document.getElementById(BTN_ID); b?.classList.remove("ping"); void b?.offsetWidth; b?.classList.add("ping"); }
    }
    if (req?.phase === L.PHASE.CONSENT && was !== L.PHASE.CONSENT && hero) sfx("send", 0.45);
    if (req?.phase === L.PHASE.GM && was !== L.PHASE.GM && me.isGM) sfx("send", 0.45);
    if (req?.phase === L.PHASE.WRITING && writer && (was === L.PHASE.GM || was === L.PHASE.CONSENT)) toast(esc(req.reason || "Change it and send again."), 4200);
    if (req?.phase === L.PHASE.FATE && was !== L.PHASE.FATE) playFate(req);
    if (req?.phase === L.PHASE.DENIED && was !== L.PHASE.DENIED) playDenied(req);

    if (!req) {
      clearCine({ fade: true });
      if (closed?.why === "fate") toast(prev?.userId === me.id ? "<b>−1 Fabula Point</b> · the story continues" : "The story continues");
      else if (closed?.why === "denied") toast("The story continues · no point spent");
      else if (closed?.why === "withdrawn") toast(`${esc(closed.actorName)} withdrew the request`);
      else if (closed?.why === "gm-cancel") toast("The GM closed the request · no point spent");
      else if (closed?.why === "left") toast(`${esc(closed.actorName)}'s player left · request closed`);
    }
    place();
  }

  AS._onRefused = ({ reason }) => { if (reason !== "busy" || !api()?.current) toast(esc(REFUSE_TEXT[reason] ?? "Someone else is altering the story")); };
  AS._notifyGM = (text) => toast(esc(text), 3600);
  AS.ui = { render, place, toast, playFate, playDenied, clearCine };

  Hooks.once("ready", () => {
    try {
      ensureStyle();
      layer();
      globalThis.oni?.HudDock?.registerRight?.("alter-story", { order: 20, size: 46, present: buttonWanted });
      api()?.onChange?.(render);
      window.addEventListener("resize", fit);
      setInterval(place, PLACE_MS);
      place();
      console.debug(TAG, "ready");
    } catch (e) { console.error(TAG, "failed to start", e); }
  });
})();
