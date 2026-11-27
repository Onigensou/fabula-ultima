// ============================================================================
// Contest Check — HUD (every client)
//
// File: scripts/check-requester/cr-contest-hud.js
//
// THE APPROVED MOCKUP IS THE SPEC (round 5, 2026-11-27):
//   https://claude.ai/artifact/Ui9f3pgddn3pkQuP6c16Th
// Every size, colour, timing and easing below is copied from it; the stage is
// the mockup's 1280x720 stage, scaled to the viewport. Change a number here
// only with the user's OK.
//
// The HUD draws; it decides nothing. The GM's engine (cr-contest.js) sends one
// ordered stream of events; every client plays them through ONE queue, so all
// screens show the same thing in the same order. Clicks become intents that go
// back to the GM (ONI.ContestHUD.onIntent).
//
// Events (ev.t): open · state · roll · rerollMark · toast · window · draw ·
//                round · win · close
// ============================================================================
(() => {
  const ONI = globalThis.ONI ??= {};
  const TAG = "[ONI][ContestHUD]";
  if (ONI.ContestHUD) return;

  const L = () => ONI.ContestLogic;
  const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";

  // ── Spec constants (mockup round 5) ──────────────────────────────────────
  const STAGE_W = 1280, STAGE_H = 720;
  const CLASH = { windupPx: 0, windupMs: 140, approachMs: 170, hitstopMs: 0, flashPeak: .2, flashMs: 260,
                  punch: 1.16, punchMs: 420, shakePx: 4, shakeMs: 340, recoilPx: 80, recoilMs: 560 };
  const SETTLE = "cubic-bezier(.34,1.32,.64,1)";   // landing: subtle easeOutBack (~5% overshoot)
  const WIN_MS = 620;
  // Critical cut-in: director-cutin.js numbers, scaled to the stage (92vh -> 662px).
  const CUTIN = { slideInMs: 500, driftMs: 1500, slideOutMs: 450, driftPx: 38, dimAlpha: .6, flashPeak: .85,
                  enterEase: "cubic-bezier(.1,.9,.25,1)", exitEase: "cubic-bezier(.6,0,.9,.15)" };
  // Sounds: the Check Requester's set (cr-sound-manager.js volumes) + the user's picks.
  const SND = {
    begin:     [`${FORGE}/Sound/super_armor.wav`, .65],
    enter:     [`${FORGE}/Sound/participant_enter.wav`, .55],
    rollBtn:   [`${FORGE}/Sound/BattleCursor_4.wav`, .45],
    dice:      [`${FORGE}/Sound/Dice.wav`, .55],
    invoke:    [`${FORGE}/Sound/BattleCursor_1.wav`, .40],
    confirm:   [`${FORGE}/Sound/BattleCursor_4.wav`, .50],
    ready:     [`${FORGE}/Sound/check_ready.wav`, .65],
    stampCrit: [`${FORGE}/Sound/Critical_1.wav`, .65],
    stampFum:  [`${FORGE}/Sound/fumble_1.WAV`, .65],
    cutin:     [`${FORGE}/Sound/BurstMax.ogg`, .8],
    clash:     [`${FORGE}/Sound/super_armor.wav`, .65],
    winner:    [`${FORGE}/Sound/SovereignGET.ogg`, .8],
    loser:     [`${FORGE}/Sound/ME/Shock2.ogg`, .8],
  };
  const ATTR_ICONS = {
    MIG: `${FORGE}/Item%20Icon/asan.png`, DEX: `${FORGE}/Item%20Icon/boot.png`,
    WLP: `${FORGE}/Item%20Icon/stat.png`, INS: `${FORGE}/Item%20Icon/book.png`,
  };
  const PLACE = ["", "1st", "2nd", "3rd", "4th"];

  const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sfx(key) {
    const s = SND[key]; if (!s) return;
    try { (foundry?.audio?.AudioHelper ?? globalThis.AudioHelper)?.play?.({ src: s[0], volume: s[1], autoplay: true, loop: false }, false); }
    catch (e) { console.warn(TAG, "sfx", key, e); }
  }

  // ── CSS (mockup, scoped under #oni-ct-root) ──────────────────────────────
  const STYLE_ID = "oni-ct-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#oni-ct-root{position:fixed;inset:0;z-index:100010;pointer-events:none;
  --parch-1:#f6ebd3;--parch-2:#eddecb;--parch-3:#e4d0b5;--text:#3b2a19;--gold:#f5c542;
  --f-game:"Signika","Segoe UI",system-ui,sans-serif;--f-display:"Cinzel","Signika",Georgia,serif}
#oni-ct-root img{border:none!important;background:none!important;box-shadow:none!important;outline:none!important}
#oni-ct-root .ct-dim{position:absolute;inset:0;background:rgba(0,0,0,.60);opacity:0;transition:opacity .35s;pointer-events:auto}
#oni-ct-root.on .ct-dim{opacity:1}
#oni-ct-root .ct-stage{position:absolute;left:50%;top:50%;width:${STAGE_W}px;height:${STAGE_H}px;transform-origin:0 0;font-family:var(--f-game);pointer-events:none}
#oni-ct-root .ct-cam{position:absolute;inset:0}
#oni-ct-root .ct-title{position:absolute;left:50%;top:30px;transform:translateX(-50%);text-align:center;opacity:0;transition:opacity .3s;white-space:nowrap}
#oni-ct-root.on .ct-title{opacity:1}
#oni-ct-root .ct-kick{font-family:var(--f-display);font-weight:900;font-size:13px;letter-spacing:.42em;color:var(--gold);text-shadow:0 1px 6px rgba(0,0,0,.9)}
#oni-ct-root .ct-name{font-size:22px;font-weight:700;color:#f6ebd3;text-shadow:0 1px 5px rgba(0,0,0,.8);letter-spacing:.04em}
#oni-ct-root .ct-stakes{margin-top:4px;font-size:13px;color:#e8d9b8;text-shadow:0 1px 4px #000}
#oni-ct-root .ct-round{position:absolute;left:50%;top:112px;transform:translateX(-50%);font-family:var(--f-display);font-weight:700;color:#f6ebd3;font-size:14px;letter-spacing:.3em;opacity:0;transition:opacity .25s;text-shadow:0 1px 5px #000;white-space:nowrap}
#oni-ct-root .ct-round.show{opacity:.9}
#oni-ct-root .ct-turn{position:absolute;left:50%;top:640px;transform:translateX(-50%);min-width:360px;text-align:center;opacity:0;transition:opacity .25s}
#oni-ct-root .ct-turn.show{opacity:1}
#oni-ct-root .ct-turn .t{display:inline-block;background:linear-gradient(180deg,#3b2a19,#2a1d11);border:2px solid var(--gold);color:#fbe9b7;font-weight:700;font-size:14px;padding:6px 16px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.6)}
#oni-ct-root .ct-turn .bar{height:4px;margin:6px auto 0;width:220px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden}
#oni-ct-root .ct-turn .bar i{display:block;height:100%;background:var(--gold);width:100%;transform-origin:left}
#oni-ct-root .ct-vs{position:absolute;left:640px;top:330px;width:150px;height:150px;margin:-75px 0 0 -75px;opacity:0;transform:scale(2.6) rotate(-20deg)}
#oni-ct-root .ct-vs.in{animation:oniCtVsIn .5s cubic-bezier(.2,1.6,.4,1) forwards}
@keyframes oniCtVsIn{to{opacity:1;transform:scale(1) rotate(0)}}
#oni-ct-root .ct-vs svg{width:100%;height:100%;filter:drop-shadow(0 4px 10px rgba(0,0,0,.8))}
#oni-ct-root .ct-vs .lbl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--f-display);font-weight:900;font-size:44px;color:#fff6dc;text-shadow:0 0 12px rgba(245,197,66,.9),0 3px 0 #5b3f26,0 0 2px #000}
#oni-ct-root .ct-meter{position:absolute;left:640px;top:420px;width:300px;margin-left:-150px;opacity:0;transition:opacity .3s,top .45s cubic-bezier(.22,.8,.3,1);
  --ck-parch-1:#f7eed7;--ck-parch-2:#ece0c2;--ck-wood-2:#6f4526;--ck-wood-3:#4e2f19;--ck-gold:#f4e2a8;
  --ck-blue:#3f9fd6;--ck-blue-hi:#9fe0ff;--ck-red:#cf4034;--ck-red-hi:#ff9a8f;--ck-clash:#f2cf7a;--ck-spark:#f7dda0;--ck-v:50%}
#oni-ct-root .ct-meter.show{opacity:1}
#oni-ct-root .ct-meter.down{top:622px}
#oni-ct-root .ckp{position:relative;box-sizing:border-box;display:flex;align-items:flex-end;padding:17px 10px 8px;min-height:46px;
  background:linear-gradient(180deg,var(--ck-parch-1),var(--ck-parch-2));border:2px solid var(--ck-wood-2);border-radius:7px;
  box-shadow:0 0 0 1px var(--ck-wood-3),-7px 0 14px -3px rgba(207,64,52,.60),7px 0 14px -3px rgba(63,159,214,.60),0 6px 18px rgba(0,0,0,.45),inset 0 0 18px rgba(160,118,73,.20)}
#oni-ct-root .ckn{position:absolute;top:-10px;left:8px;font-size:15px;font-weight:700;letter-spacing:.3px;color:var(--ck-wood-3);white-space:nowrap;
  text-shadow:-2px -2px 0 var(--ck-gold),0 -2px 0 var(--ck-gold),2px -2px 0 var(--ck-gold),-2px 0 0 var(--ck-gold),2px 0 0 var(--ck-gold),-2px 2px 0 var(--ck-gold),0 2px 0 var(--ck-gold),2px 2px 0 var(--ck-gold),0 2px 3px rgba(0,0,0,.45)}
#oni-ct-root .ckg{position:absolute;right:-38px;top:50%;margin-top:-15px;width:30px;height:30px;display:grid;place-items:center}
#oni-ct-root .ckb{position:relative;flex:1;height:16px;border-radius:3px;border:1px solid var(--ck-wood-2);overflow:hidden;background:linear-gradient(180deg,var(--ck-red-hi),var(--ck-red))}
#oni-ct-root .ckf{position:absolute;inset:0 auto 0 0;width:var(--ck-v);background:linear-gradient(180deg,var(--ck-blue-hi),var(--ck-blue));transition:width .48s cubic-bezier(.22,.8,.3,1)}
#oni-ct-root .ckghost{position:absolute;top:0;bottom:0;opacity:0;transition:opacity .25s,left .3s,width .3s;background:repeating-linear-gradient(135deg,rgba(255,255,255,.55) 0 4px,rgba(255,255,255,.12) 4px 8px)}
#oni-ct-root .ckghost.show{opacity:1;animation:oniCtGhost 1s ease-in-out infinite}
@keyframes oniCtGhost{50%{opacity:.55}}
#oni-ct-root .ckticks{position:absolute;inset:0;pointer-events:none}
#oni-ct-root .ckticks i{position:absolute;top:0;bottom:0;width:1px;background:rgba(78,47,25,.45)}
#oni-ct-root .ckc{position:absolute;top:-2px;bottom:-2px;left:var(--ck-v);width:26px;margin-left:-13px;z-index:2;pointer-events:none;
  background:radial-gradient(closest-side,rgba(255,232,170,.62),rgba(255,232,170,0) 72%),linear-gradient(90deg,var(--ck-blue) 0%,var(--ck-clash) 46%,var(--ck-clash) 54%,var(--ck-red) 100%);
  filter:blur(.4px) saturate(1.15);animation:oniCtCkj 220ms steps(2,jump-none) infinite,oniCtCkPulse 900ms ease-in-out infinite;transition:left .48s cubic-bezier(.22,.8,.3,1)}
@keyframes oniCtCkj{0%{transform:translate(0,0) scaleY(1)}20%{transform:translate(-1.5px,.5px) scaleY(1.06)}40%{transform:translate(1.5px,-.5px) scaleY(.96)}60%{transform:translate(-1px,-.5px) scaleY(1.08)}80%{transform:translate(1px,.5px) scaleY(.98)}100%{transform:translate(0,0) scaleY(1)}}
@keyframes oniCtCkPulse{0%,100%{width:24px;margin-left:-12px}50%{width:34px;margin-left:-17px}}
#oni-ct-root .cks{position:absolute;top:50%;left:var(--ck-v);width:3px;height:3px;border-radius:50%;background:var(--ck-spark);box-shadow:0 0 4px 1px rgba(255,233,160,.7);opacity:0;z-index:3;transition:left .48s cubic-bezier(.22,.8,.3,1);animation:oniCtCksp var(--d,700ms) ease-out var(--dl,0ms) infinite}
@keyframes oniCtCksp{0%{opacity:0;transform:translate(-50%,-50%) scale(.4)}12%{opacity:1}100%{opacity:0;transform:translate(calc(-50% + var(--dx,0px)),calc(-50% + var(--dy,-10px))) scale(.15)}}
#oni-ct-root .ct-meter .lead{text-align:center;font-weight:700;font-size:13px;color:#fbe9b7;margin-top:6px;text-shadow:0 1px 4px #000;min-height:18px}
#oni-ct-root .cp{position:absolute;top:150px;width:220px;box-sizing:border-box;pointer-events:auto;
  background:radial-gradient(120% 80% at 50% 0%,rgba(255,255,255,.45) 0%,rgba(255,255,255,.15) 22%,transparent 40%),linear-gradient(180deg,var(--parch-1) 0%,var(--parch-2) 55%,var(--parch-3) 100%);
  border:2.5px solid rgba(91,63,38,.95);border-radius:16px;box-shadow:0 10px 26px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,248,232,.7);
  color:var(--text);display:flex;flex-direction:column;align-items:center;padding:14px 12px 12px;gap:7px;
  --tx:0px;--ty:0px;transform:translate(var(--tx),var(--ty));
  transition:transform .45s ${SETTLE},opacity .45s,filter .6s,box-shadow .35s;opacity:0}
#oni-ct-root .cp.in{opacity:1}
#oni-ct-root .cp.n4{width:196px;top:170px}
#oni-ct-root .cp .side{position:absolute;top:-12px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:700;letter-spacing:.16em;padding:3px 10px;border-radius:999px;color:#fff;white-space:nowrap;border:1.5px solid rgba(0,0,0,.25)}
#oni-ct-root .cp .side.c0{background:linear-gradient(180deg,#2f6fb5,#1f4f86)} #oni-ct-root .cp .side.c1{background:linear-gradient(180deg,#b5452f,#86301f)}
#oni-ct-root .cp .side.c2{background:linear-gradient(180deg,#3a9a5b,#226b3c)} #oni-ct-root .cp .side.c3{background:linear-gradient(180deg,#8e5bd6,#5f35a0)}
#oni-ct-root .cp .res{position:absolute;top:10px;right:10px;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(20,184,166,.16);color:#0d7a6f;border:1px solid rgba(20,184,166,.5)}
#oni-ct-root .cp .res.up{background:rgba(142,91,214,.16);color:#5b2fa0;border-color:rgba(142,91,214,.5)}
#oni-ct-root .cp .res.none{background:rgba(0,0,0,.06);color:#7a6a55;border-color:rgba(0,0,0,.15)}
#oni-ct-root .cp .res.bump{animation:oniCtBump .5s}
@keyframes oniCtBump{30%{transform:scale(1.35)}}
#oni-ct-root .cp .place{position:absolute;top:8px;left:10px;font-family:var(--f-display);font-weight:900;font-size:15px;color:#7a5000;opacity:0;transition:opacity .3s}
#oni-ct-root .cp .place.show{opacity:1}
#oni-ct-root .portrait{width:104px;height:104px;display:flex;align-items:flex-end;justify-content:center}
#oni-ct-root .cp.n4 .portrait{width:92px;height:92px}
#oni-ct-root .portrait img,#oni-ct-root .portrait video{max-width:100%;max-height:100%;object-fit:contain}
#oni-ct-root .nm{font-size:15px;font-weight:700;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#oni-ct-root .team{font-size:10.5px;opacity:.7;margin-top:-5px;text-align:center}
#oni-ct-root .attrs{display:flex;align-items:center;justify-content:center;gap:6px;width:100%}
#oni-ct-root .at{flex:1;display:flex;flex-direction:column;align-items:center;gap:1px}
#oni-ct-root .at img{width:30px;height:30px;object-fit:contain}
#oni-ct-root .at span{font-size:11.5px;font-weight:700;opacity:.75}
#oni-ct-root .plus{font-weight:900;opacity:.55}
#oni-ct-root .rolls,#oni-ct-root .dice{display:flex;align-items:center;justify-content:center;gap:6px;width:100%}
#oni-ct-root .rb{font:700 12.5px var(--f-game);padding:3px 10px;border-radius:8px;border:2px solid rgba(91,63,38,.85);background:linear-gradient(180deg,#f6ebd3,#d9c4a4);color:var(--text);cursor:pointer;line-height:1.3;width:auto;height:auto}
#oni-ct-root .rb:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px)}
#oni-ct-root .rb:disabled{opacity:.35;cursor:not-allowed}
#oni-ct-root .chip{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:38px;border-radius:8px;background:rgba(0,0,0,.08);border:1.5px solid rgba(0,0,0,.18);font-weight:700;font-size:18px;color:var(--text);transition:background .2s,border-color .2s}
#oni-ct-root .chip.rr{background:rgba(192,57,43,.14);border-color:rgba(192,57,43,.55)}
#oni-ct-root .chip.l7{background:rgba(46,125,50,.16);border-color:rgba(46,125,50,.6)}
#oni-ct-root .chip b{display:inline-block}
#oni-ct-root .chip b.land{animation:oniCtLand .36s cubic-bezier(.22,1,.36,1) both}
@keyframes oniCtLand{0%{opacity:.1;transform:scale(1.8)}55%{transform:scale(.88)}100%{opacity:1;transform:scale(1)}}
#oni-ct-root .chip b.crit{color:#b07a00;text-shadow:0 0 8px rgba(245,197,66,.9)}
#oni-ct-root .tot{font-size:30px;font-weight:700;line-height:1;min-height:30px;font-variant-numeric:tabular-nums}
#oni-ct-root .mods{font-size:11px;font-weight:700;color:#2a7a35;background:rgba(46,125,50,.13);border-radius:5px;padding:2px 8px;text-align:center}
#oni-ct-root .badge{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:6px;text-transform:uppercase;letter-spacing:.06em;min-height:14px}
#oni-ct-root .badge.lead{background:rgba(245,197,66,.25);color:#7a5000}
#oni-ct-root .badge.behind{background:rgba(0,0,0,.08);color:#6b5a45}
#oni-ct-root .badge.crit{background:rgba(181,124,0,.25);color:#7a5000}
#oni-ct-root .badge.fumble{background:rgba(100,0,0,.18);color:#7a0000}
#oni-ct-root .badge.stamp{animation:oniCtStamp .5s cubic-bezier(.22,1.55,.36,1) both}
@keyframes oniCtStamp{0%{opacity:0;transform:scale(2.4)}100%{opacity:1;transform:scale(1)}}
#oni-ct-root .inv{display:flex;flex-direction:column;gap:4px;width:100%}
#oni-ct-root .ib{font:600 12px var(--f-game);padding:4px 8px;border-radius:8px;border:1.5px solid rgba(91,63,38,.8);background:linear-gradient(180deg,#f6ebd3,#d9c4a4);color:var(--text);cursor:pointer;text-align:left;display:flex;justify-content:space-between;gap:6px;line-height:1.3;width:100%;height:auto;margin:0}
#oni-ct-root .ib small{opacity:.6;font-weight:700;font-size:inherit}
#oni-ct-root .ib:disabled{opacity:.33;cursor:not-allowed}
#oni-ct-root .ib.used{opacity:.33;text-decoration:line-through}
#oni-ct-root .ib.flash{animation:oniCtFlash .6s}
@keyframes oniCtFlash{0%,100%{filter:none}40%{filter:brightness(1.35) drop-shadow(0 0 6px #f5c542)}}
#oni-ct-root .ib.pass{justify-content:center;background:linear-gradient(180deg,#4caf50,#2e7d32);border-color:#2e7d32;color:#fff;font-weight:700}
#oni-ct-root .wait{font-size:12px;opacity:.6;font-style:italic;text-align:center;min-height:16px}
#oni-ct-root .cp.answering{box-shadow:0 0 0 3px var(--gold),0 0 26px 6px rgba(245,197,66,.55),0 10px 26px rgba(0,0,0,.35)}
#oni-ct-root .cp.out{filter:brightness(.55) saturate(.6);opacity:.75}
#oni-ct-root .cp.fumbled{background:linear-gradient(180deg,#e9e9e9 0%,#d2d2d2 55%,#bdbdbd 100%);border-color:#d0332a;animation:oniCtFumGlow 1.3s ease-in-out infinite}
#oni-ct-root .cp.fumbled > *{filter:grayscale(1) contrast(1.15) brightness(.92);transition:filter .5s}
#oni-ct-root .cp.fumbled .side{filter:none;background:linear-gradient(180deg,#d0332a,#8e1d16)}
@keyframes oniCtFumGlow{0%,100%{box-shadow:0 0 0 2px rgba(208,51,42,.95),0 0 18px 4px rgba(208,51,42,.55),0 10px 26px rgba(0,0,0,.4)}
  50%{box-shadow:0 0 0 3px rgba(255,70,55,1),0 0 34px 10px rgba(208,51,42,.8),0 10px 26px rgba(0,0,0,.4)}}
#oni-ct-root .cp.fumshake{animation:oniCtFumShake .6s cubic-bezier(.36,.07,.19,.97) 1,oniCtFumGlow 1.3s ease-in-out infinite}
@keyframes oniCtFumShake{
  0%{translate:0 0;rotate:0deg}10%{translate:-14px 3px;rotate:-2.5deg}20%{translate:13px -3px;rotate:2deg}
  30%{translate:-12px 2px;rotate:-2deg}40%{translate:10px -2px;rotate:1.5deg}50%{translate:-8px 1px;rotate:-1deg}
  60%{translate:6px 0;rotate:.8deg}70%{translate:-4px 0;rotate:-.5deg}80%{translate:3px 0}90%{translate:-1px 0}100%{translate:0 0;rotate:0deg}}
#oni-ct-root .bench{position:absolute;left:46px;top:430px;width:170px;display:flex;flex-direction:column;gap:6px;opacity:0;transform:translateX(-30px);transition:.35s;pointer-events:auto}
#oni-ct-root .bench.show{opacity:1;transform:none}
#oni-ct-root .bench .bc{display:flex;align-items:center;gap:8px;padding:8px;border-radius:12px;background:linear-gradient(180deg,#f6ebd3,#e4d0b5);border:2px solid rgba(91,63,38,.9);color:var(--text)}
#oni-ct-root .bench img{width:46px;height:56px;object-fit:contain}
#oni-ct-root .bench .bn{font-size:12px;font-weight:700}
#oni-ct-root .bench .ib{margin-top:4px;font-size:11px}
#oni-ct-root .toast{position:absolute;top:116px;width:260px;margin-left:-130px;text-align:center;font-size:13px;font-weight:700;color:#fff6dc;background:rgba(30,20,10,.92);border:1.5px solid var(--gold);border-radius:10px;padding:6px 8px;opacity:0;transform:translateY(8px);transition:.25s;pointer-events:none;z-index:8}
#oni-ct-root .toast.show{opacity:1;transform:none}
#oni-ct-root .cp.win{z-index:5;box-shadow:0 0 0 3px var(--gold),0 0 50px 14px rgba(245,197,66,.6),0 16px 40px rgba(0,0,0,.5)}
#oni-ct-root .cp.knock{transition:opacity .55s,filter .55s;opacity:.55}
#oni-ct-root .cp.knock:not(.fumbled){filter:grayscale(.85) brightness(.75)}
#oni-ct-root .rays{position:absolute;width:520px;height:520px;margin:-260px 0 0 -260px;border-radius:50%;background:repeating-conic-gradient(rgba(245,197,66,.28) 0 9deg,transparent 9deg 22deg);-webkit-mask:radial-gradient(circle,#000 20%,transparent 68%);mask:radial-gradient(circle,#000 20%,transparent 68%);opacity:0;transition:opacity .4s;animation:oniCtSpin 14s linear infinite;pointer-events:none}
#oni-ct-root .rays.show{opacity:1}
@keyframes oniCtSpin{to{rotate:360deg}}
#oni-ct-root .big{position:absolute;left:640px;top:330px;transform:translate(-50%,-50%) scale(2.6);font-family:var(--f-display);font-weight:900;font-size:64px;letter-spacing:.04em;opacity:0;pointer-events:none;white-space:nowrap;color:#fff6dc;-webkit-text-stroke:2px #3b2a19;text-shadow:0 4px 0 #3b2a19,0 0 24px rgba(0,0,0,.7);z-index:9}
#oni-ct-root .big.go{animation:oniCtBigIn .55s cubic-bezier(.22,1.55,.36,1) forwards}
@keyframes oniCtBigIn{to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
#oni-ct-root .big.out{transition:opacity .3s;opacity:0!important;animation:none;transform:translate(-50%,-50%) scale(1)}
#oni-ct-root .win-stamp{position:absolute;top:-30px;left:50%;transform:translateX(-50%) scale(2.4) rotate(-8deg);font-family:var(--f-display);font-weight:900;font-size:34px;color:var(--gold);-webkit-text-stroke:1.5px #3b2a19;text-shadow:0 3px 0 #3b2a19;opacity:0;pointer-events:none}
#oni-ct-root .cp.win .win-stamp{animation:oniCtWst .5s .15s cubic-bezier(.22,1.55,.36,1) forwards}
@keyframes oniCtWst{to{opacity:1;transform:translateX(-50%) scale(1) rotate(-8deg)}}
#oni-ct-root .margin{position:absolute;left:640px;top:556px;transform:translateX(-50%);text-align:center;opacity:0;transition:opacity .35s .3s;white-space:nowrap}
#oni-ct-root .margin.show{opacity:1}
#oni-ct-root .margin .m1{font-family:var(--f-display);font-weight:700;color:#fbe9b7;font-size:18px;text-shadow:0 2px 6px #000}
#oni-ct-root .margin .m2{display:inline-flex;gap:6px;margin-top:6px}
#oni-ct-root .margin .m2 span{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(20,184,166,.18);border:1px solid rgba(20,184,166,.6);color:#9ff3e8}
#oni-ct-root .ct-fx{position:absolute;inset:0;pointer-events:none;z-index:7}
#oni-ct-root .ct-hitflash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:15}
#oni-ct-root .ct-cut{position:absolute;inset:0;pointer-events:none;z-index:20;display:none;overflow:hidden}
#oni-ct-root .ct-cut.active{display:block}
#oni-ct-root .ct-cut .cdim{position:absolute;inset:0;background:#000;opacity:0}
#oni-ct-root .ct-cut .cflash{position:absolute;inset:0;background:#fff;opacity:0}
#oni-ct-root .ct-cut img{position:absolute;bottom:0;right:77px;height:662px;width:auto;transform:translateX(1536px)}
@media (prefers-reduced-motion:reduce){#oni-ct-root *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;
    document.head.appendChild(s);
  }

  // ── State ────────────────────────────────────────────────────────────────
  let H = null;   // { sid, snap, root, stage, cam, sides:[render state], queue, busy, parts, raf, ... }

  const $q = (sel) => H?.root?.querySelector(sel);
  const P = (i) => H?.root?.querySelector(`.cp[data-i="${i}"]`);
  const Z = (i, z) => P(i)?.querySelector(`[data-z="${z}"]`);
  const nSides = () => H?.snap?.sides?.length ?? 0;
  function centers(n) { if (n === 2) return [360, 920]; const m = 150, step = (STAGE_W - 2 * m) / (n - 1); return Array.from({ length: n }, (_, i) => m + step * i); }
  const cardW = () => (nSides() > 2 ? 196 : 220);

  function fit() {
    if (!H?.stage) return;
    const k = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
    H.scale = k;
    H.stage.style.transform = `translate(${-STAGE_W * k / 2}px, ${-STAGE_H * k / 2}px) scale(${k})`;
  }
  const onResize = () => fit();

  // ── Particles (mockup canvas FX) ─────────────────────────────────────────
  function sparks(x, y, n = 46) { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * 9; H.parts.push({ k: "spark", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 1, dec: .022 + Math.random() * .02, c: Math.random() < .5 ? "#fff6dc" : "#f5c542" }); } }
  function burst(x, y) { for (let i = 0; i < 34; i++) { const a = Math.random() * Math.PI * 2, v = 1.5 + Math.random() * 4; H.parts.push({ k: "spark", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, life: 1, dec: .012 + Math.random() * .01, c: "#f5c542" }); } }
  function ring(x, y) { H.parts.push({ k: "ring", x, y, r: 20, life: 1, dec: .05 }); H.parts.push({ k: "ring", x, y, r: 6, life: 1, dec: .035, thin: 1 }); }
  function streaks(x, y, n) { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2; H.parts.push({ k: "streak", x, y, a, d: 30 + Math.random() * 30, v: 18 + Math.random() * 16, len: 60 + Math.random() * 90, life: 1, dec: .06 }); } }
  function fxLoop() {
    if (!H) return;
    const fx = H.fx;
    fx.clearRect(0, 0, STAGE_W, STAGE_H);
    H.parts = H.parts.filter((p) => p.life > 0);
    for (const p of H.parts) {
      p.life -= p.dec;
      if (p.k === "spark") { p.vy += .25; p.x += p.vx; p.y += p.vy; fx.strokeStyle = p.c; fx.globalAlpha = Math.max(0, p.life); fx.lineWidth = 2.4; fx.beginPath(); fx.moveTo(p.x, p.y); fx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); fx.stroke(); }
      else if (p.k === "ring") { p.r += p.thin ? 14 : 22; fx.strokeStyle = p.thin ? "#fff6dc" : "#f5c542"; fx.globalAlpha = Math.max(0, p.life); fx.lineWidth = (p.thin ? 3 : 7) * p.life + 1; fx.beginPath(); fx.arc(p.x, p.y, p.r, 0, Math.PI * 2); fx.stroke(); }
      else if (p.k === "streak") { p.d += p.v; const c = Math.cos(p.a), s = Math.sin(p.a); fx.strokeStyle = "#ffffff"; fx.globalAlpha = Math.max(0, p.life) * .85; fx.lineWidth = 3 * p.life + .5; fx.beginPath(); fx.moveTo(p.x + c * p.d, p.y + s * p.d); fx.lineTo(p.x + c * (p.d + p.len), p.y + s * (p.d + p.len)); fx.stroke(); }
    }
    fx.globalAlpha = 1;
    H.raf = requestAnimationFrame(fxLoop);
  }

  // ── Build ────────────────────────────────────────────────────────────────
  const VS_SVG = `<svg viewBox="0 0 150 150" aria-hidden="true">
    <path d="M28 28 L122 122" stroke="#3b2a19" stroke-width="22" stroke-linecap="round"/><path d="M122 28 L28 122" stroke="#3b2a19" stroke-width="22" stroke-linecap="round"/>
    <path d="M28 28 L122 122" stroke="#2f6fb5" stroke-width="14" stroke-linecap="round"/><path d="M122 28 L28 122" stroke="#b5452f" stroke-width="14" stroke-linecap="round"/>
    <circle cx="75" cy="75" r="34" fill="#3b2a19"/><circle cx="75" cy="75" r="30" fill="#f5c542"/><circle cx="75" cy="75" r="25" fill="#5b3f26"/></svg><div class="lbl">VS</div>`;
  const GEAR_SVG = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="#1d1109" stroke="#f4e2a8" stroke-width="1" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.3 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.3 2.6h4l.3-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>`;
  const SPARKS = [[-14, -9, 640, 0], [12, -11, 720, 130], [-9, 10, 600, 260], [15, 10, 700, 390], [-16, -3, 760, 520]];

  function media(src) {
    const isVid = /\.(webm|mp4)(\?|$)/i.test(src ?? "");
    return isVid ? `<video src="${esc(src)}" autoplay loop muted playsinline></video>` : `<img src="${esc(src)}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">`;
  }
  function resPill(s) {
    if (s.res?.kind === "fp") return `<div class="res" data-res>★ FP ${s.res.n}</div>`;
    if (s.res?.kind === "up") return `<div class="res up" data-res>✦ UP ${s.res.n}</div>`;
    return `<div class="res none" data-res>no points</div>`;
  }
  function panelHtml(i) {
    const s = H.snap.sides[i], st = H.state.sides[i];
    const at = (attr, d) => `<div class="at"><img src="${ATTR_ICONS[attr] ?? ATTR_ICONS.DEX}" alt=""><span>${attr} d${d}</span></div>`;
    const tag = nSides() > 2 ? s.ownerLabel : `${i === 0 ? "SIDE A" : "SIDE B"} · ${s.ownerLabel}`;
    return `<div class="side c${i % 4}">${esc(tag)}</div><div class="place" data-z="place"></div>${resPill(st)}
      <div class="win-stamp">WIN!</div>
      <div class="portrait">${media(s.img)}</div>
      <div class="nm">${esc(s.name)}</div>
      ${s.teamNames?.length ? `<div class="team">Team: ${esc(s.teamNames.join(", "))}</div>` : ""}
      <div class="attrs">${at(s.attrA, s.dA)}<div class="plus">+</div>${at(s.attrB, s.dB)}</div>
      <div class="rolls" data-z="rolls"><button class="rb" data-die="a" type="button">d${s.dA}</button><div class="plus">+</div><button class="rb" data-die="b" type="button">d${s.dB}</button></div>
      <div class="dice" data-z="dice" hidden style="display:none"><div class="chip" data-c="a"><b>—</b></div><div class="plus">+</div><div class="chip" data-c="b"><b>—</b></div></div>
      <div class="mods" data-z="mods" style="display:none"></div>
      <div class="tot" data-z="tot"></div>
      <div class="badge" data-z="badge"></div>
      <div class="inv" data-z="inv" style="display:none"></div>
      <div class="wait" data-z="wait"></div>`;
  }

  function build(snap, state) {
    ensureStyle();
    destroy();
    const root = document.createElement("div");
    root.id = "oni-ct-root";
    root.innerHTML = `<div class="ct-dim"></div><div class="ct-stage"><div class="ct-cam">
        <div class="rays"></div>
        <div class="ct-title"><div class="ct-kick">CONTEST</div><div class="ct-name"></div><div class="ct-stakes"></div></div>
        <div class="ct-round">ROUND 1</div>
        <div class="ct-panels"></div>
        <div class="ct-vs">${VS_SVG}</div>
        <div class="ct-meter"><div class="ckp"><div class="ckn"></div>
          <div class="ckb"><div class="ckf"></div><div class="ckghost"></div><div class="ckticks"></div><div class="ckc"></div>
          ${SPARKS.map(([dx, dy, d, dl]) => `<div class="cks" style="--dx:${dx}px;--dy:${dy}px;--d:${d}ms;--dl:${dl}ms"></div>`).join("")}</div>
          <div class="ckg">${GEAR_SVG}</div></div><div class="lead"></div></div>
        <canvas class="ct-fx" width="${STAGE_W}" height="${STAGE_H}"></canvas>
        <div class="big"></div>
        <div class="margin"><div class="m1"></div><div class="m2"></div></div>
        <div class="ct-turn"><div class="t"></div><div class="bar"><i></i></div></div>
        <div class="ct-toasts"></div>
        <div class="bench"></div>
      </div><div class="ct-hitflash"></div>
      <div class="ct-cut"><div class="cdim"></div><div class="cflash"></div><img alt=""></div></div>`;
    document.body.appendChild(root);
    H = {
      sid: snap.sid, snap, state, root, stage: root.querySelector(".ct-stage"), cam: root.querySelector(".ct-cam"),
      fx: root.querySelector(".ct-fx").getContext("2d"), parts: [], queue: Promise.resolve(), pending: 0, closed: false,
      picking: null,
    };
    fit(); window.addEventListener("resize", onResize);
    H.raf = requestAnimationFrame(fxLoop);

    $q(".ct-name").textContent = snap.title || "Contest";
    $q(".ct-stakes").textContent = snap.stakes ? `Stakes: ${snap.stakes}` : "";
    const n = snap.sides.length, cs = centers(n), w = cardW();
    $q(".ct-panels").innerHTML = snap.sides.map((s, i) => `<div class="cp${n > 2 ? " n4" : ""}" data-i="${i}" style="left:${cs[i] - w / 2}px"></div>`).join("");
    $q(".ct-toasts").innerHTML = snap.sides.map((s, i) => `<div class="toast" data-t="${i}" style="left:${cs[i]}px"></div>`).join("");
    snap.sides.forEach((s, i) => { P(i).innerHTML = panelHtml(i); });
    root.addEventListener("click", onClick);
    if (snap.clock && n === 2) drawClock(snap.clock);
  }

  function destroy() {
    if (!H) { document.getElementById("oni-ct-root")?.remove(); return; }
    try { cancelAnimationFrame(H.raf); } catch (_) {}
    try { clearTimeout(H.turnTimer); } catch (_) {}
    window.removeEventListener("resize", onResize);
    H.root?.remove();
    H = null;
  }

  // ── Who am I, for this contest ───────────────────────────────────────────
  // canAct(i): this client may click for side i (its owner, or the GM).
  const canAct = (i) => !!H?.snap?.sides?.[i] && (game.user?.isGM || (H.snap.sides[i].ownerIds ?? []).includes(game.user?.id));
  const isMineForSting = (i) => !game.user?.isGM && (H.snap.sides[i].ownerIds ?? []).includes(game.user?.id);

  // ── Rendering from state ────────────────────────────────────────────────
  function applyState(state) {
    if (!H) return;
    H.state = state;
    const two = nSides() === 2;
    const sides = state.sides;
    const order = L().placings(sides);
    const lead = L().leaderIndex(sides);
    const allIn = L().allRolled(sides);
    sides.forEach((st, i) => {
      const el = P(i); if (!el) return;
      // resource pill
      const pill = el.querySelector("[data-res]");
      const html = resPill(st);
      if (pill && pill.outerHTML.replace(/ bump/, "") !== html) { pill.outerHTML = html; el.querySelector("[data-res]")?.classList.add("bump"); }
      // roll buttons
      const rolled = st.a != null && st.b != null;
      const rz = Z(i, "rolls");
      if (rz) {
        rz.style.display = rolled ? "none" : "";
        rz.querySelectorAll(".rb").forEach((b) => { const d = b.dataset.die; b.disabled = st[d] != null || !canAct(i) || st.out || !!state.rolling?.[i]?.[d]; });
      }
      // mods
      const mz = Z(i, "mods");
      const mods = (st.mods ?? []).filter((m) => Number(m.value) !== 0);
      if (mz) { if (rolled && mods.length) { mz.style.display = ""; mz.textContent = mods.map((m) => `${m.label} ${m.value > 0 ? "+" : ""}${m.value}`).join(" · "); } else mz.style.display = "none"; }
      el.classList.toggle("out", !!st.out);
      if (st.out) Z(i, "wait").textContent = "Out of the running";
      // badges + placings
      if (allIn && !st.out) {
        const z = Z(i, "badge"); let cls, txt;
        if (L().isCrit(st)) { cls = "crit"; txt = "Critical"; }
        else if (L().isFumble(st)) { cls = "fumble"; txt = "Fumble"; }
        else if (lead === -1 && L().score(st) === L().score(sides[order[0]?.index])) { cls = "behind"; txt = "Level"; }
        else if (lead === i) { cls = "lead"; txt = "Ahead"; }
        else { cls = "behind"; txt = "Behind"; }
        if (z && z.dataset.t !== txt) { z.className = `badge ${cls} stamp`; z.textContent = txt; z.dataset.t = txt; }
        if (!two) { const p = order.find((o) => o.index === i)?.place; const pz = Z(i, "place"); if (pz && p) { pz.textContent = PLACE[p] ?? ""; pz.classList.add("show"); } }
      } else if (!st.out) {
        const z = Z(i, "badge"); if (z && st.a == null) { z.className = "badge"; z.textContent = ""; z.dataset.t = ""; }
      }
    });
    renderWindow(state);
    renderBench(state);
    if (two && H.snap.clock) clockPreview(state);
  }

  // Answer window: the answering side shows its options to whoever can act for it.
  function renderWindow(state) {
    const a = state.answering;
    H.state.sides.forEach((st, i) => {
      const el = P(i); if (!el) return;
      el.classList.toggle("answering", a === i);
      const inv = Z(i, "inv");
      if (a === i && canAct(i) && !H.picking) {
        inv.style.display = "";
        const opts = (state.options?.[i] ?? []);
        inv.innerHTML = opts.map((o) => `<button class="ib${o.used ? " used" : ""}" data-o="${o.id}" type="button" ${o.ok ? "" : "disabled"}>${esc(o.label)}<small>${esc(o.sub ?? "")}</small></button>`).join("")
          + `<button class="ib pass" data-o="pass" type="button">Accept result</button>`;
      } else if (H.picking?.side !== i) { inv.style.display = "none"; inv.innerHTML = ""; }
      const w = Z(i, "wait");
      if (w && !st.out) {
        if (a != null && a !== i) w.textContent = H.snap.sides[a].party ? "Waiting for the player…" : "Waiting for the GM…";
        else if (a === i && !canAct(i)) w.textContent = H.snap.sides[i].party ? "Waiting for the player…" : "Waiting for the GM…";
        else if (a == null && state.phase === "rolling" && (st.a == null || st.b == null)) w.textContent = canAct(i) ? "Roll your dice" : (H.snap.sides[i].party ? "Waiting for the player…" : "Waiting for the GM…");
        else if (state.notes?.[i]) w.textContent = state.notes[i];
        else w.textContent = "";
      }
    });
    const t = $q(".ct-turn"), bar = $q(".ct-turn .bar i");
    if (a == null) { t.classList.remove("show"); H.windowKey = null; return; }
    const key = `${a}:${state.windowSeq}`;
    $q(".ct-turn .t").textContent = `${H.snap.sides[a].name}'s answer · invoke or accept`;
    if (H.windowKey !== key) {
      H.windowKey = key;
      bar.style.transition = "none"; bar.style.transform = "scaleX(1)"; void bar.offsetWidth;
      bar.style.transition = `transform ${state.windowSeconds}s linear`; bar.style.transform = "scaleX(0)";
    }
    t.classList.add("show");
  }

  // Bench: actors THIS client controls that hold Divination charges and are not
  // in the contest. Each lists the sides it may force to reroll.
  function renderBench(state) {
    const bench = $q(".bench"); if (!bench) return;
    const open = state.answering != null || state.benchOpen;
    const list = (state.bench ?? []).filter((b) => game.user?.isGM || (b.ownerIds ?? []).includes(game.user?.id));
    if (!open || !list.length) { bench.classList.remove("show"); bench.innerHTML = ""; return; }
    bench.innerHTML = list.map((b) => `<div class="bc"><img src="${esc(b.img)}" alt=""><div style="min-width:0"><div class="bn">${esc(b.name)} <span style="opacity:.6;font-weight:600">(watching)</span></div>
      ${(b.targets ?? []).map((t) => `<button class="ib" data-div="${esc(b.actorUuid)}" data-tg="${t}" type="button">🔮 ${esc(H.snap.sides[t].name)} <small>${b.charges}</small></button>`).join("")}</div></div>`).join("");
    bench.classList.add("show");
  }

  // ── Clicks -> intents ───────────────────────────────────────────────────
  function send(intent) { try { ONI.ContestHUD.onIntent?.(H.sid, intent); } catch (e) { console.error(TAG, e); } }
  function onClick(ev) {
    if (!H) return;
    const card = ev.target.closest(".cp");
    const i = card ? Number(card.dataset.i) : null;
    const rb = ev.target.closest(".rb");
    if (rb && i != null && canAct(i) && !rb.disabled) { rb.disabled = true; sfx("rollBtn"); send({ kind: "roll", side: i, die: rb.dataset.die }); return; }
    const div = ev.target.closest("[data-div]");
    if (div) { sfx("invoke"); div.disabled = true; send({ kind: "invoke", what: "benchDivination", byActorUuid: div.dataset.div, side: Number(div.dataset.tg) }); return; }
    const pick = ev.target.closest("[data-pick]");
    if (pick && i != null && H.picking?.side === i) {
      const p = H.picking; H.picking = null;
      if (pick.dataset.pick === "cancel") { applyState(H.state); return; }
      sfx("invoke"); send({ kind: "invoke", what: p.what, side: i, choice: pick.dataset.pick }); return;
    }
    const ib = ev.target.closest(".ib[data-o]");
    if (ib && i != null && canAct(i) && !ib.disabled) {
      const o = ib.dataset.o;
      if (o === "pass") { sfx("confirm"); ib.classList.add("flash"); send({ kind: "accept", side: i }); return; }
      const st = H.state.sides[i], s = H.snap.sides[i];
      // Inline sub-choices (mockup free play): which die / which Bond.
      const inv = Z(i, "inv");
      if (o === "trait" || o === "lucky") {
        H.picking = { side: i, what: o };
        const lbl = o === "trait" ? "Reroll which die?" : `Replace which die with ${st.lucky}?`;
        inv.innerHTML = `<div class="wait" style="opacity:.8">${lbl}</div>
          <button class="ib" data-pick="a" type="button">${s.attrA} die (${st.a})</button>
          <button class="ib" data-pick="b" type="button">${s.attrB} die (${st.b})</button>
          ${o === "trait" ? `<button class="ib" data-pick="ab" type="button">Both dice</button>` : ""}
          <button class="ib" data-pick="cancel" type="button">Back</button>`;
        return;
      }
      if (o === "bond") {
        const bonds = s.bonds ?? [];
        if (bonds.length === 1) { sfx("invoke"); send({ kind: "invoke", what: "bond", side: i, choice: String(bonds[0].idx) }); return; }
        H.picking = { side: i, what: "bond" };
        inv.innerHTML = `<div class="wait" style="opacity:.8">Invoke which Bond?</div>`
          + bonds.map((b) => `<button class="ib" data-pick="${b.idx}" type="button">${esc(b.name)}<small>+${b.bonus}</small></button>`).join("")
          + `<button class="ib" data-pick="cancel" type="button">Back</button>`;
        return;
      }
      sfx("invoke"); ib.classList.add("flash"); send({ kind: "invoke", what: o, side: i });
    }
  }

  // ── Animation primitives (mockup) ───────────────────────────────────────
  async function tickDie(i, die, value, faces, { crit = false, fumble = false } = {}) {
    const el = P(i); if (!el) return;
    const dz = Z(i, "dice"); dz.hidden = false; dz.style.display = "";
    const b = el.querySelector(`[data-c="${die}"] b`);
    sfx("dice");
    for (let k = 0; k < (crit ? 6 : 9); k++) { b.textContent = 1 + Math.floor(Math.random() * faces); await sleep(60); }
    if (crit) {
      // the number keeps spinning under the cut-in and lands after the portrait leaves
      let spin = true; (async () => { while (spin && H) { b.textContent = 1 + Math.floor(Math.random() * faces); await sleep(70); } })();
      try { await critCutin(H.snap.sides[i]); } finally { spin = false; }
    }
    b.textContent = value; b.classList.remove("land", "crit"); void b.offsetWidth; b.classList.add("land");
    if (crit) { el.querySelectorAll(".chip b").forEach((x) => x.classList.add("crit")); sfx("stampCrit"); }
    if (fumble) await fumbleShake(i);
  }

  async function critCutin(side) {
    // Same as the battle crit system: no cut_in_critical art -> no cut-in at all.
    if (!side?.cut) return;
    const cut = $q(".ct-cut"), dim = cut.querySelector(".cdim"), flash = cut.querySelector(".cflash"), img = cut.querySelector("img");
    await new Promise((r) => { img.onload = img.onerror = () => r(); img.src = side.cut; if (img.complete) r(); });
    const mir = side.cutFlip ? " scaleX(-1)" : "";
    if (side.cutSoft) { const m = "linear-gradient(to right,transparent 0%,#000 6%,#000 94%,transparent 100%)"; img.style.webkitMaskImage = m; img.style.maskImage = m; }
    else { img.style.webkitMaskImage = "none"; img.style.maskImage = "none"; }
    cut.classList.add("active"); sfx("cutin");
    dim.animate([{ opacity: 0 }, { opacity: CUTIN.dimAlpha }], { duration: 200, easing: "ease-out", fill: "forwards" });
    flash.animate([{ opacity: 0 }, { opacity: CUTIN.flashPeak }, { opacity: 0 }], { duration: 320, easing: "ease-out", fill: "forwards" });
    await img.animate([{ transform: "translateX(1536px)" + mir }, { transform: "translateX(0)" + mir }], { duration: CUTIN.slideInMs, easing: CUTIN.enterEase, fill: "forwards" }).finished.catch(() => {});
    await img.animate([{ transform: "translateX(0)" + mir }, { transform: `translateX(${-CUTIN.driftPx}px)` + mir }], { duration: CUTIN.driftMs, easing: "linear", fill: "forwards" }).finished.catch(() => {});
    await Promise.all([
      dim.animate([{ opacity: CUTIN.dimAlpha }, { opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished.catch(() => {}),
      img.animate([{ transform: `translateX(${-CUTIN.driftPx}px)` + mir }, { transform: "translateX(-1536px)" + mir }], { duration: CUTIN.slideOutMs, easing: CUTIN.exitEase, fill: "forwards" }).finished.catch(() => {}),
    ]);
    cut.classList.remove("active");
  }

  async function fumbleShake(i) {
    const el = P(i); if (!el) return;
    sfx("stampFum");
    el.classList.add("fumbled", "fumshake");
    await sleep(650);
    el.classList.remove("fumshake");
  }

  async function countUp(i, to) {
    const z = Z(i, "tot"); if (!z) return;
    const from = Number(z.textContent) || 0;
    for (let k = 1; k <= 8; k++) { z.textContent = Math.round(from + (to - from) * k / 8); await sleep(28); }
    z.textContent = to;
  }

  function toast(i, html, ms = 1900) {
    const t = $q(`.toast[data-t="${i}"]`); if (!t) return;
    t.innerHTML = html; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
  }

  // stage-space centre of a card
  function cardCy(i) {
    const r = P(i).getBoundingClientRect(), sr = H.stage.getBoundingClientRect(), k = STAGE_W / sr.width;
    return ((r.top + r.bottom) / 2 - sr.top) * k;
  }

  function impact(x, y) {
    const cam = H.cam;
    if (nSides() === 2) $q(".ct-vs")?.animate([{ opacity: 1, scale: "1" }, { opacity: 0, scale: "2.2" }], { duration: 200, easing: "ease-out", fill: "forwards" });
    $q(".ct-hitflash").animate([{ opacity: CLASH.flashPeak }, { opacity: CLASH.flashPeak, offset: .22 }, { opacity: 0 }], { duration: CLASH.flashMs, easing: "ease-out" });
    cam.style.transformOrigin = `${x}px ${y}px`;
    cam.animate([{ scale: "1" }, { scale: String(CLASH.punch), offset: .16 }, { scale: "1" }], { duration: CLASH.punchMs, easing: "cubic-bezier(.2,.8,.3,1)" });
    const k = 9, a = CLASH.shakePx, kf = [];
    for (let j = 0; j <= k; j++) { const f = 1 - j / k; kf.push({ translate: j === k ? "0px 0px" : `${((j % 2 ? 1 : -1) * a * f).toFixed(1)}px ${((Math.random() - .5) * a * .6 * f).toFixed(1)}px` }); }
    cam.animate(kf, { duration: CLASH.shakeMs, easing: "linear" });
    sparks(x, y, 90); sparks(x, y - 100, 22); sparks(x, y + 100, 22); ring(x, y); streaks(x, y, 22);
  }

  // Wind-up then rush into the contact offsets; resolves on the frame they touch.
  async function approach(offs) {
    const tot = CLASH.windupMs + CLASH.approachMs, anims = [];
    for (const [i, dx] of offs) {
      const dir = Math.sign(dx) || 1;
      anims.push(P(i).animate([
        { translate: "0px 0px", scale: "1", rotate: "0deg" },
        { translate: `${-dir * CLASH.windupPx}px 0px`, scale: ".95", rotate: `${-dir * 2}deg`, offset: CLASH.windupMs / tot, easing: "cubic-bezier(.6,0,1,.5)" },
        { translate: `${dx}px 0px`, scale: "1.05", rotate: "0deg" },
      ], { duration: tot, fill: "forwards" }));
    }
    // fire on the animation itself, not a timer (a timer lands ~1 frame early)
    await Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => {}))), sleep(tot + 500)]);
  }

  async function collide(idx) {
    const n = nSides(), cs = centers(n), w = cardW();
    const sorted = [...idx].sort((a, b) => cs[a] - cs[b]);
    const mid = (cs[sorted[0]] + cs[sorted[sorted.length - 1]]) / 2, gap = w * 0.94;
    const offs = sorted.map((i, k) => [i, (mid + (k - (sorted.length - 1) / 2) * gap) - cs[i]]);
    const y = cardCy(sorted[0]);
    await approach(offs);
    sfx("clash");
    for (let k = 0; k < sorted.length - 1; k++) impact(mid + (k + .5 - (sorted.length - 1) / 2) * gap, y);
    await sleep(CLASH.hitstopMs);
    for (const [i, dx] of offs) {
      const dir = Math.sign(dx) || 1;
      P(i).animate([
        { translate: `${dx}px 0px`, scale: "1.05", rotate: "0deg", easing: "cubic-bezier(.2,.8,.3,1)" },
        { translate: `${-dir * CLASH.recoilPx}px -6px`, scale: ".97", rotate: `${-dir * 5}deg`, offset: .42, easing: SETTLE },
        { translate: "0px 0px", scale: "1", rotate: "0deg" },
      ], { duration: CLASH.recoilMs, fill: "forwards" });
    }
    await sleep(CLASH.recoilMs);
  }

  // ── Clock (Conflict mode; the middle bar IS the linked clock) ───────────
  function drawClock(c) {
    const m = $q(".ct-meter"); if (!m) return;
    m.querySelector(".ckn").textContent = c.name ?? "Clock";
    m.style.setProperty("--ck-v", `${(c.value / c.sections) * 100}%`);
    m.querySelector(".ckticks").innerHTML = Array.from({ length: Math.max(0, c.sections - 1) }, (_, k) => `<i style="left:${(k + 1) / c.sections * 100}%"></i>`).join("");
    m.querySelector(".lead").textContent = `${c.value}/${c.sections} · the winner pushes this Clock`;
  }
  function clockPreview(state) {
    const c = H.snap.clock, ghost = $q(".ckghost"), lead = $q(".ct-meter .lead");
    const sides = state.sides;
    if (!L().allRolled(sides)) { ghost.classList.remove("show"); return; }
    const li = L().leaderIndex(sides);
    if (li === -1) { ghost.classList.remove("show"); lead.textContent = "Level · nobody pushes yet"; return; }
    const W = sides[li], Lo = sides[1 - li];
    const secs = L().clockSections(L().marginTier(W, Lo));
    const dir = H.snap.sides[li].clockDir ?? (H.snap.sides[li].party ? 1 : -1);
    const to = Math.max(0, Math.min(c.sections, c.value + dir * secs));
    const a = Math.min(c.value, to) / c.sections * 100, b = Math.max(c.value, to) / c.sections * 100;
    ghost.style.left = `${a}%`; ghost.style.width = `${b - a}%`; ghost.classList.add("show");
    const moved = Math.abs(to - c.value);
    const m = L().margin(W, Lo);
    lead.textContent = `${H.snap.sides[li].name} ahead${L().isCrit(W) ? " · critical" : L().isFumble(Lo) ? " · fumble" : ` by ${m}`} → ${dir > 0 ? "+" : "−"}${moved} section${moved === 1 ? "" : "s"}`;
  }

  // ── Sting (local, by priority) ──────────────────────────────────────────
  function sting(winner) {
    const sides = H.snap.sides.map((s, i) => ({ mine: isMineForSting(i), party: !!s.party }));
    sfx(L().stingFor(sides, winner) === "winner" ? "winner" : "loser");
  }

  // ── Event players ───────────────────────────────────────────────────────
  const PLAY = {
    async open(ev) {
      build(ev.snap, ev.state);
      const n = nSides();
      for (let i = 0; i < n; i++) { const el = P(i); el.style.transition = "none"; el.style.setProperty(n === 2 ? "--tx" : "--ty", n === 2 ? `${i === 0 ? -560 : 560}px` : "560px"); }
      void H.root.offsetWidth;
      H.root.classList.add("on");
      await sleep(250);
      for (let i = 0; i < n; i++) { const el = P(i); el.style.transition = ""; el.classList.add("in"); el.style.setProperty("--tx", "0px"); el.style.setProperty("--ty", "0px"); sfx("enter"); await sleep(150); }
      await sleep(250);
      if (n === 2) $q(".ct-vs").classList.add("in");
      sfx("begin");
      await sleep(500);
      $q(".ct-round").classList.add("show");
      if (H.snap.clock && n === 2) $q(".ct-meter").classList.add("show");
      applyState(ev.state);
    },
    async state(ev) { applyState(ev.state); },
    async roll(ev) {
      const s = H.snap.sides[ev.side];
      await tickDie(ev.side, ev.die, ev.value, ev.die === "a" ? s.dA : s.dB, { crit: !!ev.crit, fumble: !!ev.fumble });
      if (ev.state) applyState(ev.state);
      if (ev.total != null) await countUp(ev.side, ev.total);
      if (ev.allIn) sfx("ready");
    },
    async rerollMark(ev) {
      for (const d of ev.dice) { const c = P(ev.side)?.querySelector(`[data-c="${d}"]`); c?.classList.add("rr"); c?.querySelector("b")?.classList.remove("crit"); }
      if (ev.toast) toast(ev.side, ev.toast);
    },
    async rerollDone(ev) {
      if (ev.total != null) await countUp(ev.side, ev.total);
      await sleep(300);
      P(ev.side)?.querySelectorAll(".chip").forEach((c) => c.classList.remove("rr"));
      if (ev.state) applyState(ev.state);
    },
    async lucky(ev) {
      const c = P(ev.side)?.querySelector(`[data-c="${ev.die}"]`); if (!c) return;
      c.classList.add("l7");
      const b = c.querySelector("b"); b.textContent = ev.value; b.classList.remove("land"); void b.offsetWidth; b.classList.add("land");
      if (ev.toast) toast(ev.side, ev.toast);
      if (ev.total != null) await countUp(ev.side, ev.total);
      if (ev.state) applyState(ev.state);
    },
    async bond(ev) {
      if (ev.toast) toast(ev.side, ev.toast);
      if (ev.state) applyState(ev.state);
      if (ev.total != null) await countUp(ev.side, ev.total);
    },
    async toast(ev) { toast(ev.side, ev.html, ev.ms ?? 1900); },
    async draw(ev) {
      await collide(ev.tied);
      const big = $q(".big"); big.textContent = "DRAW!"; big.className = "big go";
      await sleep(1100); big.classList.add("out");
    },
    async round(ev) {
      $q(".ct-vs")?.getAnimations().filter((a) => !(a instanceof CSSAnimation)).forEach((a) => a.cancel());
      $q(".ct-round").textContent = `ROUND ${ev.round} · REROLL`;
      $q(".ckghost")?.classList.remove("show");
      for (const i of ev.tied) {
        const el = P(i); if (!el) continue;
        const keep = el.className.replace(/\b(fumbled|answering|fumshake)\b/g, "").replace(/\s+/g, " ").trim();
        el.getAnimations().filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).forEach((a) => a.cancel());
        el.innerHTML = panelHtml(i); el.className = keep;
      }
      applyState(ev.state);
      sfx("ready");
      await sleep(450);
    },
    async win(ev) {
      const W = ev.winner, n = nSides(), cs = centers(n), w = cardW();
      const y0 = cardCy(W);
      let hx;
      if (n === 2) {
        const Lo = 1 - W, dirW = W === 0 ? 1 : -1;
        const cW = 640 - dirW * w / 2 - cs[W], cL = 640 + dirW * w / 2 - cs[Lo];
        await approach([[W, cW], [Lo, cL]]);
        hx = 640;
        sting(W); impact(hx, y0);
        P(W).classList.add("win"); P(Lo).classList.add("knock");
        await sleep(CLASH.hitstopMs);
        P(W).animate([{ translate: `${cW}px 0px`, scale: "1.05", rotate: "0deg" }, { translate: `${640 - cs[W]}px 24px`, scale: "1.18", rotate: "0deg" }], { duration: WIN_MS, easing: SETTLE, fill: "forwards" });
        P(Lo).animate([{ translate: `${cL}px 0px`, scale: "1.05", rotate: "0deg" }, { translate: `${dirW * 250}px 82px`, scale: ".84", rotate: `${dirW * 16}deg` }], { duration: WIN_MS, easing: SETTLE, fill: "forwards" });
      } else {
        const offs = []; H.state.sides.forEach((s, i) => { if (i !== W && !s.out) offs.push([i, (cs[W] > cs[i] ? 1 : -1) * 46]); });
        await approach(offs);
        hx = cs[W];
        sting(W); impact(hx, y0);
        P(W).classList.add("win"); H.state.sides.forEach((s, i) => { if (i !== W && !s.out) P(i).classList.add("knock"); });
        await sleep(CLASH.hitstopMs);
        P(W).animate([{ translate: "0px 0px", scale: "1" }, { translate: "0px -26px", scale: "1.12" }], { duration: WIN_MS, easing: SETTLE, fill: "forwards" });
        for (const [i, dx] of offs) { const dir = -Math.sign(dx); P(i).animate([{ translate: `${dx}px 0px`, scale: "1.05", rotate: "0deg" }, { translate: `${dir * 44}px 92px`, scale: ".84", rotate: `${dir * 9}deg` }], { duration: WIN_MS, easing: SETTLE, fill: "forwards" }); }
      }
      const r = $q(".rays"); r.style.left = `${hx}px`; r.style.top = `${n === 2 ? 330 : 300}px`; r.classList.add("show");
      burst(hx, 300);
      await sleep(520);
      $q(".margin .m1").textContent = ev.headline ?? "";
      $q(".margin .m2").innerHTML = (ev.chips ?? []).map((c) => `<span>${esc(c)}</span>`).join("");
      if (ev.clock && n === 2) {
        const m = $q(".ct-meter"); m.classList.add("down"); await sleep(480);
        $q(".ckghost")?.classList.remove("show");
        m.style.setProperty("--ck-v", `${(ev.clock.to / ev.clock.sections) * 100}%`);
        sparks(640 - 150 + 10 + (ev.clock.to / ev.clock.sections) * 268, 653, 26);
        m.querySelector(".lead").textContent = `${ev.clock.to}/${ev.clock.sections}${ev.clock.resolved ? " · resolved" : ""}`;
      }
      $q(".margin").classList.add("show");
    },
    async close() { H?.root?.classList.remove("on"); await sleep(350); destroy(); },
  };

  // ── Public ───────────────────────────────────────────────────────────────
  // Every client (GM included) feeds the GM's events here, in order.
  // ONE queue for the whole client: events play strictly in arrival order.
  let Q = Promise.resolve();
  let currentSid = null;
  function event(sid, ev) {
    if (ev.t === "open") currentSid = sid;
    else if (sid !== currentSid) return Q;           // a stale / unknown contest
    Q = Q.then(async () => {
      if (ev.t !== "open" && (!H || H.sid !== sid)) return;
      try { await PLAY[ev.t]?.(ev); } catch (e) { console.error(TAG, `event ${ev.t}`, e); }
    });
    return Q;
  }
  // Resolves when this client has played every event queued so far.
  const whenIdle = () => Q;

  ONI.ContestHUD = { event, whenIdle, destroy, onIntent: null, CLASH, SND,
    get active() { return H?.sid ?? null; } };
})();
