// scripts/fabula-arcana/fa-invite-ui.js
// The PvP challenge panel (replaces Foundry's Yes/No dialog): game-styled card that slides down from the top,
// a draining countdown bar, Accept / Decline / Block tonight. It closes itself when time runs out.
// Pure DOM, no Foundry calls: fa-client.js wires the answers + sounds; the design mockup loads this same file.
//
//   const p = showInvitePanel({ fromName, toName, bestOf, img, ms, onAnswer(answer) , sound(key) });
//     answer = "accept" | "decline" | "block" | "timeout"      p.close(reason)  // e.g. the host withdrew it
//
//   const c = showChallengeSetup({ toName, img, bestOf, format, onSend({ bestOf, format }), onCancel(), sound(key) });
//     the challenger's own panel before a camp challenge: match rules (Standard / Open / Constellation, mirror cards,
//     character cards) + Best of. It opens with the last rules used (fa-entry.js keeps them).

const CSS = `
#fa-invite{position:fixed;left:50%;top:14px;z-index:10001;width:min(440px,calc(100vw - 32px));transform:translateX(-50%);font-family:"Signika","Lexend",system-ui,sans-serif;color:#3a1e06;
  animation:faInvIn .42s cubic-bezier(.2,1.25,.35,1) both;filter:drop-shadow(0 14px 22px #000a)}
#fa-invite.out{animation:faInvOut .3s ease-in forwards}
#fa-invite .fi-card{position:relative;border-radius:12px;overflow:hidden;border:2px solid #c9a44a;box-shadow:0 0 0 3px #3a1e06,inset 0 0 0 1px #fff6;
  background:repeating-linear-gradient(0deg,transparent 0 25px,#7a4e200d 25px 26px),linear-gradient(180deg,#fbf4dc,#ede0b0)}
#fa-invite .fi-rib{display:flex;align-items:center;gap:8px;padding:7px 12px;background:linear-gradient(180deg,#7a4e20,#4f2f10);color:#f8e3a8;
  font-weight:800;font-size:13px;letter-spacing:.18em;text-transform:uppercase;text-shadow:0 1px 0 #2a1404;border-bottom:2px solid #c9a44a}
#fa-invite .fi-rib .fi-ico{width:22px;height:22px;flex:0 0 22px;position:relative}
#fa-invite .fi-rib .fi-ico i{position:absolute;width:13px;height:18px;border-radius:2px;border:1.5px solid #f8e3a8;background:#8a3420;top:2px}
#fa-invite .fi-rib .fi-ico i:first-child{left:1px;transform:rotate(-14deg)} #fa-invite .fi-rib .fi-ico i:last-child{left:8px;transform:rotate(12deg);background:#c9a44a}
#fa-invite .fi-body{display:flex;gap:12px;align-items:center;padding:12px 14px 8px}
#fa-invite .fi-por{width:64px;height:64px;flex:0 0 64px;border-radius:10px;border:2px solid #c9a44a;background:#3a1e06 center/cover no-repeat;box-shadow:0 2px 4px #0005;animation:faInvPor 1.6s ease-in-out infinite}
#fa-invite .fi-txt{flex:1;min-width:0}
#fa-invite .fi-txt .fi-who{font-size:19px;font-weight:700;line-height:1.15}
#fa-invite .fi-txt .fi-who b{color:#8a3420}
#fa-invite .fi-txt .fi-sub{font-size:13.5px;color:#7f6140;margin-top:3px}
#fa-invite .fi-txt .fi-rules{font-size:12.5px;color:#5a3417;font-weight:600}
#fa-invite .fi-time{margin:4px 14px 0;height:8px;border-radius:5px;background:#3a1e0622;box-shadow:inset 0 1px 2px #0004;overflow:hidden}
#fa-invite .fi-time i{display:block;height:100%;width:100%;border-radius:5px;transform-origin:0 50%;background:linear-gradient(90deg,#c08a1a,#f4c95d);box-shadow:0 0 8px #f4c95d}
#fa-invite.low .fi-time i{background:linear-gradient(90deg,#b8321f,#ff7a5a);box-shadow:0 0 10px #ff5b4b;animation:faInvPulse .5s ease-in-out infinite}
#fa-invite .fi-btns{display:flex;gap:8px;padding:10px 14px 12px;align-items:center}
#fa-invite button{width:auto;min-width:0;margin:0;height:auto;font-family:inherit;cursor:pointer;border-radius:8px;font-weight:700;font-size:15px;padding:8px 10px;line-height:1.1;transition:transform .08s,filter .15s}
#fa-invite button:hover{filter:brightness(1.08);transform:translateY(-1px)} #fa-invite button:active{transform:translateY(1px)}
#fa-invite .fi-yes{flex:1.3;color:#fff6dc;border:2px solid #3a1e06;background:linear-gradient(180deg,#5aa04a,#2f6f2a);box-shadow:inset 0 1px 0 #fff5,0 2px 0 #1f3f10;text-shadow:0 1px 0 #1f3f10}
#fa-invite .fi-no{flex:1;color:#f8e3a8;border:2px solid #3a1e06;background:linear-gradient(180deg,#8a5a2a,#5a3410);box-shadow:inset 0 1px 0 #fff3,0 2px 0 #2a1404}
#fa-invite .fi-blk{flex:0 0 auto;max-width:34%;white-space:nowrap;background:none;border:1px dashed #a07a50;color:#7f6140;font-size:12.5px;font-weight:600;padding:7px 8px}
#fa-invite .fi-blk.armed{border-style:solid;border-color:#b8321f;color:#fff;background:#b8321f}
@keyframes faInvIn{0%{transform:translate(-50%,-130%) scale(.96);opacity:0}100%{transform:translate(-50%,0) scale(1);opacity:1}}
@keyframes faInvOut{to{transform:translate(-50%,-120%);opacity:0}}
@keyframes faInvPulse{50%{filter:brightness(1.4)}}
@keyframes faInvPor{50%{box-shadow:0 2px 4px #0005,0 0 0 3px #f4c95d66}}
@media (prefers-reduced-motion: reduce){ #fa-invite,#fa-invite *{animation-duration:.01s !important} }
`;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

let current = null;

export function showInvitePanel({ fromName, toName, bestOf = 1, rules = "", img = "", ms = 20000, onAnswer = () => {}, sound = () => {} } = {}) {
  if (current) current.close("replaced");
  if (!document.getElementById("fa-invite-css")) {
    const st = document.createElement("style"); st.id = "fa-invite-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.id = "fa-invite"; el.setAttribute("role", "alertdialog"); el.setAttribute("aria-label", "Card duel challenge");
  const bo = Number(bestOf) > 1 ? ` · Best of ${Number(bestOf)}` : "";
  el.innerHTML = `<div class="fi-card">
    <div class="fi-rib"><span class="fi-ico"><i></i><i></i></span>Card Duel Challenge</div>
    <div class="fi-body"><div class="fi-por" style="${img ? `background-image:url('${esc(img)}')` : ""}"></div>
      <div class="fi-txt"><div class="fi-who"><b>${esc(fromName)}</b> challenges ${esc(toName)}!</div><div class="fi-sub">Fabula Arcana${esc(bo)}</div>${rules ? `<div class="fi-sub fi-rules">${esc(rules)}</div>` : ""}</div></div>
    <div class="fi-time"><i></i></div>
    <div class="fi-btns"><button type="button" class="fi-yes">Accept</button><button type="button" class="fi-no">Decline</button>
      <button type="button" class="fi-blk" title="No more challenges from ${esc(fromName)} until the party rests">Block tonight</button></div></div>`;
  document.body.appendChild(el);
  sound("appear");

  const bar = el.querySelector(".fi-time i");
  const t0 = performance.now();
  let done = false, raf = 0, armT = 0;
  const frame = () => {
    if (done) return;
    const left = Math.max(0, ms - (performance.now() - t0));
    bar.style.transform = `scaleX(${(left / ms).toFixed(4)})`;
    el.classList.toggle("low", left < 5000);
    if (left <= 0) return finish("timeout");
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  function close(reason = "closed") {
    if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(armT);
    el.classList.add("out"); setTimeout(() => el.remove(), 320);
    if (current === api) current = null;
    return reason;
  }
  function finish(answer) {
    if (done) return;
    close(answer);
    sound(answer === "accept" ? "accept" : answer === "timeout" ? "timeout" : "decline");
    try { onAnswer(answer); } catch (e) { console.error("[Fabula Arcana] invite answer", e); }
  }
  el.querySelector(".fi-yes").onclick = () => finish("accept");
  el.querySelector(".fi-no").onclick = () => finish("decline");
  const blk = el.querySelector(".fi-blk");
  blk.onclick = () => {
    if (!blk.classList.contains("armed")) { blk.classList.add("armed"); blk.textContent = "Click to confirm"; sound("cursor");
      armT = setTimeout(() => { blk.classList.remove("armed"); blk.textContent = "Block tonight"; }, 3000); return; }
    finish("block");
  };
  const api = { close, el };
  current = api;
  return api;
}

export const closeInvitePanel = (reason) => current?.close(reason);

// ------------------------------------------------------------------ challenge setup (the challenger's match rules)
const CUPS = [
  { name: "Commoner's Cup", pat: [1, 1, 1], sub: "Commons only" },
  { name: "Vanguard", pat: [1, 1, 2], sub: "Two commons + one elite" },
  { name: "Elite Cup", pat: [2, 2, 2], sub: "Elites only" },
  { name: "Boss Rush", pat: [3, 3, 3], sub: "Three bosses" },
];
const SETUP_CSS = `
#fa-chsetup{position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;padding:16px;background:#1a0e0499;font-family:"Signika","Lexend",system-ui,sans-serif;color:#3a1e06}
#fa-chsetup.in{animation:faChFade .2s ease-out}
#fa-chsetup .fc-card{width:min(470px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:12px;border:2px solid #c9a44a;box-shadow:0 0 0 3px #3a1e06,inset 0 0 0 1px #fff6,0 18px 34px #000b;
  background:repeating-linear-gradient(0deg,transparent 0 25px,#7a4e200d 25px 26px),linear-gradient(180deg,#fbf4dc,#ede0b0)}
#fa-chsetup.in .fc-card{animation:faChIn .32s cubic-bezier(.2,1.2,.35,1)}
#fa-chsetup .fc-rib{display:flex;align-items:center;gap:8px;padding:7px 12px;background:linear-gradient(180deg,#7a4e20,#4f2f10);color:#f8e3a8;font-weight:800;font-size:13px;letter-spacing:.18em;text-transform:uppercase;border-bottom:2px solid #c9a44a}
#fa-chsetup .fc-head{display:flex;gap:12px;align-items:center;padding:12px 14px 4px}
#fa-chsetup .fc-por{width:52px;height:52px;flex:0 0 52px;border-radius:10px;border:2px solid #c9a44a;background:#3a1e06 center/cover no-repeat}
#fa-chsetup .fc-who{font-size:18px;font-weight:700} #fa-chsetup .fc-who b{color:#8a3420}
#fa-chsetup .fc-sec{padding:6px 14px}
#fa-chsetup .fc-lbl{font-size:11.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a6a3a;margin:6px 0 5px}
#fa-chsetup .fc-seg{display:flex;gap:6px;flex-wrap:wrap}
#fa-chsetup button{font-family:inherit;cursor:pointer;margin:0;width:auto;height:auto;line-height:1.15}
#fa-chsetup .fc-seg button{flex:1;min-width:110px;text-align:left;padding:7px 9px;border-radius:7px;border:1px solid #9a7046;background:#f3e6c2;color:#3a1e06;font-size:14px;font-weight:700}
#fa-chsetup .fc-seg button small{display:block;font-weight:400;font-size:11.5px;color:#8a6a3a}
#fa-chsetup .fc-seg button.on{background:linear-gradient(180deg,#7a5230,#5c3818);color:#f8f0d4;border-color:#3a1e06} #fa-chsetup .fc-seg button.on small{color:#e8d6a8}
#fa-chsetup .fc-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
#fa-chsetup .fc-chip{font-size:12.5px;padding:3px 10px;border-radius:999px;border:1px solid #c9a44a;background:#fffaf0;color:#5a3417}
#fa-chsetup .fc-chip.on{background:linear-gradient(180deg,#7a5230,#5c3818);color:#f8f0d4;border-color:#3a1e06}
#fa-chsetup .fc-pat{display:flex;gap:6px;align-items:center;margin-top:7px}
#fa-chsetup .fc-pat span{font-size:12px;color:#7f6140}
#fa-chsetup .fc-pat button{flex:1;height:42px;border-radius:8px;border:2px solid #9a7046;background:#fffaf0;color:#b0473a;font-size:14px;display:flex;flex-direction:column;align-items:center;justify-content:center}
#fa-chsetup .fc-pat button small{font-size:10px;color:#9a7a50} #fa-chsetup .fc-pat b{color:#5a3417}
#fa-chsetup .fc-btns{display:flex;gap:8px;padding:12px 14px 14px}
#fa-chsetup .fc-go{flex:1.4;color:#fff6dc;border:2px solid #3a1e06;border-radius:8px;font-weight:700;font-size:15px;padding:9px 10px;background:linear-gradient(180deg,#5aa04a,#2f6f2a);box-shadow:inset 0 1px 0 #fff5,0 2px 0 #1f3f10}
#fa-chsetup .fc-no{flex:1;color:#f8e3a8;border:2px solid #3a1e06;border-radius:8px;font-weight:700;font-size:15px;padding:9px 10px;background:linear-gradient(180deg,#8a5a2a,#5a3410)}
#fa-chsetup button:focus-visible{outline:2px solid #f4c95d;outline-offset:1px}
@keyframes faChFade{from{opacity:0}} @keyframes faChIn{from{transform:translateY(-14px) scale(.97);opacity:0}}
@media (prefers-reduced-motion: reduce){ #fa-chsetup,#fa-chsetup *{animation:none !important} }
`;
let setupOpen = null;
export function showChallengeSetup({ toName, img = "", bestOf = 1, format = null, privatePick = false, onSend = () => {}, onCancel = () => {}, sound = () => {} } = {}) {
  if (setupOpen) setupOpen.close();
  if (!document.getElementById("fa-chsetup-css")) { const st = document.createElement("style"); st.id = "fa-chsetup-css"; st.textContent = SETUP_CSS; document.head.appendChild(st); }
  const f0 = format || {};
  const st = { bo: [1, 3, 5].includes(Number(bestOf)) ? Number(bestOf) : 1,
    mode: ["standard", "open", "cup"].includes(f0.mode) ? f0.mode : "standard",
    pat: Array.isArray(f0.pat) && f0.pat.length === 3 ? f0.pat.map((n) => [0, 1, 2, 3].includes(Number(n)) ? Number(n) : 0) : [1, 1, 2],
    mirror: f0.mirror !== false, chars: f0.chars !== false, priv: !!privatePick };
  const el = document.createElement("div"); el.id = "fa-chsetup"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Card duel challenge setup");
  const seg = (key, opts) => `<div class="fc-seg">${opts.map(([v, l, s]) => `<button type="button" class="${st[key] === v ? "on" : ""}" data-k="${key}" data-v="${v}">${l}<small>${s}</small></button>`).join("")}</div>`;
  const draw = () => {
    el.innerHTML = `<div class="fc-card">
      <div class="fc-rib">Card Duel Challenge</div>
      <div class="fc-head"><div class="fc-por" style="${img ? `background-image:url('${esc(img)}')` : ""}"></div><div class="fc-who">Challenge <b>${esc(toName)}</b></div></div>
      <div class="fc-sec"><div class="fc-lbl">Match rules</div>
        ${seg("mode", [["standard", "Standard", "5★ budget"], ["open", "Open", "No budget, any 3 cards"], ["cup", "Constellation", "Each side matches a star pattern"]])}
        ${st.mode === "cup" ? `<div class="fc-chips">${CUPS.map((c, i) => `<button type="button" class="fc-chip ${c.pat.join() === st.pat.join() ? "on" : ""}" data-cup="${i}" title="${esc(c.sub)}">${esc(c.name)}</button>`).join("")}</div>
          <div class="fc-pat"><span>Slots</span>${st.pat.map((p, i) => `<button type="button" data-pat="${i}" title="Click to change: ★ → ★★ → ★★★ → Any">${p ? "★".repeat(p) : "<b>Any</b>"}<small>slot ${i + 1}</small></button>`).join("")}</div>` : ""}</div>
      <div class="fc-sec"><div class="fc-lbl">Mirror cards</div>${seg("mirror", [[true, "Allowed", "Both may field the same card"], [false, "Not allowed", "A shared card clashes: both pick again"]])}</div>
      <div class="fc-sec"><div class="fc-lbl">Character cards</div>${seg("chars", [[true, "Allowed", "Hina, Zarg and friends can play"], [false, "Banned", "Monster cards only"]])}</div>
      <div class="fc-sec"><div class="fc-lbl">Series</div>${seg("bo", [[1, "Best of 1", "One game"], [3, "Best of 3", "First to 2 wins"], [5, "Best of 5", "First to 3 wins"]])}</div>
      <div class="fc-sec"><div class="fc-lbl">Spectators during team pick</div>${seg("priv", [[false, "See picks live", "Watchers see both teams as they're built"], [true, "Private team pick", "Picks stay hidden until the duel starts"]])}</div>
      <div class="fc-btns"><button type="button" class="fc-go">Send challenge</button><button type="button" class="fc-no">Cancel</button></div></div>`;
    el.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { const k = b.dataset.k, v = b.dataset.v;
      st[k] = k === "bo" ? Number(v) : (v === "true" ? true : v === "false" ? false : v); sound("cursor"); draw(); });
    el.querySelectorAll("[data-cup]").forEach((b) => b.onclick = () => { st.pat = [...CUPS[+b.dataset.cup].pat]; sound("cursor"); draw(); });
    el.querySelectorAll("[data-pat]").forEach((b) => b.onclick = () => { const i = +b.dataset.pat, cyc = [1, 2, 3, 0]; st.pat = [...st.pat]; st.pat[i] = cyc[(cyc.indexOf(st.pat[i]) + 1) % 4]; sound("cursor"); draw(); });
    el.querySelector(".fc-go").onclick = () => { close(); sound("accept");
      try { onSend({ bestOf: st.bo, format: { mode: st.mode, pat: st.pat, mirror: st.mirror, chars: st.chars }, privatePick: st.priv }); } catch (e) { console.error("[Fabula Arcana] challenge send", e); } };
    el.querySelector(".fc-no").onclick = () => cancel();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } };
  function close() { if (!el.isConnected) return; el.remove(); document.removeEventListener("keydown", onKey, true); if (setupOpen === api) setupOpen = null; }
  function cancel() { close(); sound("decline"); try { onCancel(); } catch (e) { console.error(e); } }
  el.addEventListener("pointerdown", (e) => { if (e.target === el) cancel(); });
  document.addEventListener("keydown", onKey, true);
  el.classList.add("in"); setTimeout(() => el.classList.remove("in"), 400);
  draw(); document.body.appendChild(el); sound("appear");
  const go = el.querySelector(".fc-go"); if (go) go.focus();
  const api = { close, el }; setupOpen = api; return api;
}
