// ═════════ move-engine · mockup SKILL PANEL (page UI; after the engine, the family's skills.js and the moves)
// What the GAME ITEM will hold for the move on screen, live: each skill block of moves/<family>/skills.js whose `move` is
// the current one, with its slider-bound fields recomputed from the sliders as they move (the same `bind` the export uses),
// changes from the approved values marked, and "Copy my changes" for the review. Under it, the game's own numbers: a PACK
// measured in real Battle Director sim battles (`move-engine.js pack`), flagged stale when the sliders no longer match it.
//   mountSkillPanel(afterElement)   renderSkillPanel()   (MOVE_SKILLS + MOVE_PACKS are page globals)
const MSP = { approved: {}, el: null };
function mspTune(key) { const s = SK[key]; const T = {}; for (const t of (s && s.tune) || []) T[t.k] = t.v; return T; }
function mspBound(block, T) {
  const out = [];
  for (const [k, b] of Object.entries(block.bind || {})) { if (!(k in T)) continue; out.push({ slider: k, value: T[k], path: b.path, set: b.to ? b.to(T[k], T) : T[k] }); }
  return out;
}
function mspEsc(v) { return String(typeof v === "string" ? v : JSON.stringify(v)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function mountSkillPanel(after) {
  if (!after || document.getElementById("me-skill") || typeof MOVE_SKILLS === "undefined") return null;
  for (const k of Object.keys(SK)) MSP.approved[k] = mspTune(k);
  const sec = document.createElement("section"); sec.className = "card"; sec.id = "me-skill";
  after.insertAdjacentElement("afterend", sec); MSP.el = sec; renderSkillPanel(); return sec;
}
function renderSkillPanel() {
  const sec = MSP.el; if (!sec) return;
  const blocks = Object.entries(MOVE_SKILLS).filter(([, b]) => b.move === CUR);
  if (!blocks.length) { sec.innerHTML = `<h2>Game item</h2><p class="muted" style="margin:0">${mspEsc(SK[CUR] ? SK[CUR].name : CUR)} has no skill block: its rules are not exported from this page.</p>`; return; }
  const T = mspTune(CUR), A = MSP.approved[CUR] || {};
  let html = "", changes = [];
  for (const [key, b] of blocks) {
    const now = mspBound(b, T), was = mspBound(b, A);
    const rows = now.map((x, i) => { const ch = JSON.stringify(x.set) !== JSON.stringify(was[i].set);
      if (ch) changes.push(`${b.doc.name}: slider ${x.slider} ${was[i].value} → ${x.value}  ⇒  ${x.path} = ${JSON.stringify(x.set)} (was ${JSON.stringify(was[i].set)})`);
      return `<tr${ch ? ' class="hl"' : ""}><th>${mspEsc(x.path)}<br><small>slider ${mspEsc(x.slider)} = ${mspEsc(x.value)}</small></th><td>${ch ? `<span class="was">${mspEsc(was[i].set)}</span> ` : ""}<b>${mspEsc(x.set)}</b></td></tr>`; }).join("");
    const fixed = Object.entries(b.props || {}).filter(([p]) => !now.some((x) => x.path === "props." + p)).map(([p, v]) => `${mspEsc(p)} <b>${mspEsc(v)}</b>`).join(" · ");
    const tables = [(b.effects || []).length ? `${b.effects.length} effect row(s): ${b.effects.map((r) => mspEsc(r.effect_label || r.effect_kind)).join(", ")}` : "",
      (b.reactions || []).length ? `${b.reactions.length} reaction row(s): ${b.reactions.map((r) => mspEsc(r.reaction_trigger)).join(", ")}` : "",
      Object.keys(b.flags || {}).length ? `flags: ${Object.keys(b.flags).map(mspEsc).join(", ")}` : ""].filter(Boolean).join("<br>");
    html += `<h3 style="margin-top:12px">${mspEsc(b.doc.name)} <span class="muted" style="font-weight:400">· block ${mspEsc(key)}</span></h3>
      <table class="bal"><tbody>${rows || '<tr><th>No slider-bound fields</th><td></td></tr>'}</tbody></table>
      <p class="muted" style="margin:6px 0 0;font-size:13px">Fixed fields: ${fixed || "none"}${tables ? "<br>" + tables : ""}</p>`;
    html += mspPack(key, b, now);
  }
  sec.innerHTML = `<h2>Game item · what the export writes</h2>
    <p class="muted" style="margin-top:0">Fields tied to a slider follow it live. A highlighted row differs from the approved value; send it with your review and the export writes it to the game item.</p>
    ${html}
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="chip" id="me-skill-copy"${changes.length ? "" : " disabled"}>Copy my changes</button>
    <span class="muted" style="font-size:13px">${changes.length ? changes.length + " field(s) changed" : "Every field at its approved value"}</span></div>`;
  const btn = document.getElementById("me-skill-copy");
  if (btn && changes.length) btn.onclick = () => { const t = changes.join("\n"); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { btn.textContent = "Copied"; }, () => { window.prompt("Copy:", t); }); };
}
function mspPack(key, b, now) {
  const P = (typeof MOVE_PACKS !== "undefined" && MOVE_PACKS[key]) || null;
  if (!P) return `<p class="muted" style="margin:8px 0 0;font-size:13px">No game numbers yet: <code>move-engine.js pack</code> measures them in real battles.</p>`;
  // only sliders that change the numbers (a binding marked `numbers: false`, e.g. the MP cost, never makes them stale)
  const stale = now.filter((x) => (b.bind[x.slider] || {}).numbers !== false && P.bound && x.slider in P.bound && P.bound[x.slider] !== x.value);
  const runs = P.runs || [], n = runs.length;
  const avg = (f) => n ? (runs.reduce((s, r) => s + f(r), 0) / n) : 0;
  const rowsHtml = runs.map((r, i) => `<tr><th>Battle ${i + 1}${r.perfect ? " · Perfect" : ""}${r.crit ? " · crit" : ""}${r.element ? `<br><small>${mspEsc(r.element)} vs ${mspEsc(r.affinity)}</small>` : ""}</th><td style="text-align:left;font-weight:400">${(r.strikes || []).map((s) => s == null ? '<span class="muted">miss</span>' : s).join(" · ")}${(r.extra || []).length ? ` <b>+ ${r.extra.join(" + ")}</b>${r.perfect ? " Perfect" : ""}` : ""}</td><td>${r.total}</td></tr>`).join("");
  return `<h3 style="margin-top:14px">In the game · ${n} real battle${n === 1 ? "" : "s"}</h3>
    <p class="muted" style="margin:0 0 6px;font-size:13px">${mspEsc(P.setup.actor)} with ${mspEsc(P.setup.weapon)} vs ${mspEsc(P.setup.target)} · Battle Director sim, real dice · measured ${mspEsc(P.measuredAt)} on ${mspEsc(P.code)}.
    Landed ${avg((r) => (r.strikes || []).filter((s) => s != null).length).toFixed(1)} of ${(runs[0] && runs[0].strikes || []).length} strikes, ${avg((r) => r.total).toFixed(1)} damage on average.</p>
    ${stale.length ? `<p style="margin:0 0 6px;color:var(--bug);font-size:13px">Measured at ${stale.map((x) => `${mspEsc(x.slider)} = ${mspEsc(P.bound[x.slider])}`).join(", ")}: these numbers are from before your slider change.</p>` : ""}
    <div class="tablewrap"><table class="bal"><thead><tr><th>Battle</th><th style="text-align:left">Strikes (damage each)</th><th>Total</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
}
