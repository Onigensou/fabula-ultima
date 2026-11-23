// ───────── Reset + run (the Sonic Katar page's part-ui, without its HUD / gauge / NPC bar)
const CTXS = {};
const DIM2 = document.getElementById("dim2");
function resetStage() {
  if (DIM2.parentElement !== $("shake")) $("shake").insertBefore(DIM2, $("screen"));
  RUN++; FAST = false; rumble(false); speedLines(false);
  LOOPS.forEach((a) => { try { a.pause(); } catch (e) {} }); LOOPS.length = 0;
  CLIPS.forEach((v) => { releaseVideos(v); v.remove(); }); CLIPS.length = 0;
  for (const id of ["ffx", "fground", "dactors", "dfx", "dground", "dtint"]) { releaseVideos($(id)); [...$(id).children].forEach((c) => { if (c.id !== "gparts") c.remove(); }); }
  [...$("factors").children].forEach((c) => { if (!c.classList.contains("actor")) { releaseVideos(c); c.remove(); } });
  [...$("screen").children].forEach((c) => { if (!["vig", "iris", "black", "flash", "sparts"].includes(c.id)) c.remove(); });
  DIM2.hidden = true;
  for (const k of Object.keys(PARTS)) PARTS[k].length = 0;
  TIMERS.forEach(clearInterval); TIMERS.length = 0; hcReset(); [...DNL.children].forEach((c) => { if (c.id !== "hc") c.remove(); }); DN_SLOT.clear();
  for (const a of Object.values(ACT)) { if (a.media._fl) a.media._fl.stop(); clearTimeout(a.hurtT); a.el.style.clipPath = ""; a.media.style.transform = ""; a.faded = false; a.rot = 0; a.flip = a.baseFlip; a.lift = 0; a.kx = 1; a.ky = 1;
    a.el.style.opacity = 1; a.media.style.filter = ""; a.s = tokenScaleAt(a.y); a.el.style.zIndex = Math.round(a.y); setPos(a, 0, 0); }
  $("flash").style.opacity = 0; $("black").style.opacity = 0; $("vig").style.opacity = 0; $("fdim").style.opacity = 0; $("fdim").style.background = "#000";
  $("shake").style.transform = "";
  FCAM.set({ x: W / 2, y: H / 2, z: 1, r: 0 });
  if (typeof resetExtra === "function") resetExtra();
  BEAT = -1; renderBeats();
}
let TOTAL = null;
async function play(from = 0) {
  resetStage(); const key = CUR, sk = SK[key]; const C = { cfg: Object.fromEntries(sk.tune.map((t) => [t.k, t.v])) }; CTXS[key] = C;
  const rid = RUN; GATE_AT = null; T0 = performance.now(); renderMeta();
  if (!sk.page) cueHide(true);   // the game hides status cues while an action animation plays (fuBattleMarksHidden)
  try {
    for (let i = 0; i < sk.beats.length; i++) {
      FAST = i < from; if (i === from) T0 = performance.now();
      BEAT = i; renderBeats(); await sk.beats[i].run(C); live(rid);
    }
    FAST = false; BEAT = -1; renderBeats(); TOTAL = performance.now() - T0; renderMeta();
    if (!sk.page) { afterMove(key); cueHide(false); }
    await wait(sk.page ? 0 : 600); if (rid === RUN) { const g = GATE_AT, t = TOTAL; resetStage(); GATE_AT = g; TOTAL = t; renderMeta(); }
    if (sk.page) afterMove(key);
  } catch (e) { FAST = false; cueHide(false); if (e !== ABORT) console.error(e); }
}

// ───────── UI: groups → moves
CUR = "rhapsody";
function pickSkill(k) { CUR = k; resetStage(); GATE_AT = null; TOTAL = null; renderAll(); if (CUE_REVIEW[k]) renderBalance(); else if ($("sandbox")) sbPaint(); }
function renderSkills() { const box = $("skills"); box.innerHTML = "";
  for (const [g, gname] of Object.entries(GROUPS)) { const keys = SKL.filter((k) => SK[k].boss === g); if (!keys.length) continue;
    const h = document.createElement("div"); h.className = "grp"; h.textContent = gname; box.appendChild(h);
    for (const k of keys) { const s = SK[k]; const btn = document.createElement("button"); btn.className = "skill"; btn.setAttribute("aria-current", k === CUR);
      btn.innerHTML = `<img src="${M.sprites[s.icon || "icon_rh"]}" alt=""><span><b>${s.name}</b><small>${s.tag}</small></span>`; btn.onclick = () => { const top = box.scrollTop; pickSkill(k); $("skills").scrollTop = top; play(0); }; box.appendChild(btn); } } }
function renderSheet() { const s = SK[CUR];
  $("sheet").innerHTML = `<div><div class="title"><b>${s.name}</b> <span class="muted">${GROUPS[s.boss]} · ${s.tag}</span></div><p>${s.intro}</p>${s.rules ? `<p class="muted">${s.rules}</p>` : ""}
    <h3 style="margin-top:12px">Beats · jump to any one</h3><ol class="beats" id="beats"></ol><div class="tlmeta" id="tlmeta"></div></div>
    <div><h3>Tuning</h3><div class="tune" id="tune">${s.tune.length ? "" : '<p class="muted" style="margin:0">No sliders on this one.</p>'}</div></div>`;
  const tb = $("tune"); s.tune.forEach((t) => { const id = "tn-" + CUR + "-" + t.k; const l = document.createElement("label"); l.setAttribute("for", id);
    if (t.opts) { l.innerHTML = `<span>${t.label}</span><output id="${id}-o"></output><select id="${id}" style="grid-column:1/-1;width:100%;padding:4px 6px;font:inherit">${t.opts.map((o, i) => `<option value="${i}"${i === t.v ? " selected" : ""}>${o}</option>`).join("")}</select>`;
      tb.appendChild(l); l.querySelector("select").onchange = (e) => { t.v = +e.target.value; renderBalance(); }; return; }
    l.innerHTML = `<span>${t.label}</span><output id="${id}-o">${t.v}</output><input type="range" id="${id}" min="${t.min}" max="${t.max}" step="${t.step}" value="${t.v}">`;
    tb.appendChild(l); l.querySelector("input").oninput = (e) => { t.v = +e.target.value; $(id + "-o").textContent = t.v; renderBalance(); }; });
  renderBeats(); renderMeta(); }
function renderBeats() { const ol = $("beats"); if (!ol) return; const s = SK[CUR]; ol.innerHTML = "";
  s.beats.forEach((b, i) => { const li = document.createElement("li"); if (i === BEAT) li.className = "now"; if (b.gate) li.classList.add("gatebeat");
    li.innerHTML = `<span><b>${b.name}</b>${b.note ? ` <em>· ${b.note}</em>` : ""}</span>`; const go = document.createElement("button"); go.className = "go"; go.textContent = "▶ from here"; go.onclick = () => play(i); li.appendChild(go); ol.appendChild(li); }); }
function renderMeta() { const m = $("tlmeta"); if (!m) return; const f = (v) => (v / 1000).toFixed(2) + " s";
  m.innerHTML = (GATE_AT != null ? `Effect lands at <b style="color:var(--bug)">${f(GATE_AT)}</b>` : "Effect lands at the ◆ beat") + (TOTAL != null ? ` · whole move ${f(TOTAL)} (at ${SPEED}× speed, from the chosen beat)` : ""); }
function renderAll() { renderSkills(); renderSheet(); $("stagetag").textContent = "Valley_Battlemap001 · 3D stage · Keren (Spell Fencer) in the party line"; }

{ const sk = $("skills"), panel = sk.parentElement; for (const el of [$("play"), panel.querySelector(".row2")]) if (el) panel.insertBefore(el, sk);
  Object.assign(sk.style, { maxHeight: "min(60vh, 600px)", overflowY: "auto", paddingRight: "4px" });
  Object.assign(panel.style, { position: "sticky", top: "8px", alignSelf: "start" });
  const o = $("opts"); if (o) o.remove(); }
$("play").onclick = () => play(0);
$("speed").onchange = (e) => SPEED = +e.target.value;
$("sound").onchange = (e) => SOUND = e.target.checked;
$("sway").onchange = (e) => { SWAY = e.target.checked; };
cueMount(ACT.keren);
mountSandbox();
window.__LB = { SK, SKL, pickSkill, play: (i = 0) => play(i), state: () => ({ RUN, BEAT, GATE_AT, TOTAL, CUR, SB: { ...SB }, cues: [...CUE.cues], CUE_P }), ACT, CUE };
setTimeout(() => { pickSkill(CUR); sbPaint(); }, 300);
document.querySelectorAll("img[data-icon]").forEach((i) => { i.src = M.sprites[i.dataset.icon || "icon_rh"]; });
