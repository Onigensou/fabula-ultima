// scripts/fabula-arcana/fa-invite-ui.js
// The PvP challenge panel (replaces Foundry's Yes/No dialog): game-styled card that slides down from the top,
// a draining countdown bar, Accept / Decline / Block tonight. It closes itself when time runs out.
// Pure DOM, no Foundry calls: fa-client.js wires the answers + sounds; the design mockup loads this same file.
//
//   const p = showInvitePanel({ fromName, toName, bestOf, img, ms, onAnswer(answer) , sound(key) });
//     answer = "accept" | "decline" | "block" | "timeout"      p.close(reason)  // e.g. the host withdrew it

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

export function showInvitePanel({ fromName, toName, bestOf = 1, img = "", ms = 20000, onAnswer = () => {}, sound = () => {} } = {}) {
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
      <div class="fi-txt"><div class="fi-who"><b>${esc(fromName)}</b> challenges ${esc(toName)}!</div><div class="fi-sub">Fabula Arcana${esc(bo)}</div></div></div>
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
