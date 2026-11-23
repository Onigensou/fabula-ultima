// ═════════ Spell Fencer page: the four held cues as reviewable entries (page-only, NOT game moves: in the game they are
// status cues driven by the marker AEs) + the turn-loop sandbox that switches them the way the game will.
GROUPS.cues = "Held auras · token status cues";
const CUE_REVIEW = {};   // cue key -> the sandbox state that shows it alone
function cueDef(key, name, tag, state, intro, tune, apply, changes) {
  CUE_REVIEW[key] = state;
  def(key, { status: "new", boss: "cues", page: true, name, icon: key === "cue_reso" || key === "cue_braid" ? "icon_reso" : "icon_rh", tag, intro, changes,
    rules: "A loop, not a one-shot: it holds on Keren for as long as its marker lasts. Particles: the game's status-cue technique (status-cues.js, a DOM layer docked to the drawn sprite, sized by sprite height / 250). Outline glow (v2): in the game a PIXI glow + outline filter on the token, like the acting-turn glow (turn-glow.js); tick \"Keren's turn\" in the sandbox to see how the two share the outline. Sliders apply live; press Play to restart the look.",
    tune, beats: [{ name: "Hold the aura", note: "the loop on Keren (no animation plays)", run: async (C) => { apply(C); SB_SHOW(state); await wait(tv(C, "look")); } }] });
}
const LOOK = T("look", "Look time per play (ms)", 6000, 2000, 20000, 500);
const BLEND_OPTS = OL_BLEND.map((b) => b[0]);
// the v2 outline sliders (strength, width, breath; the blend colour select for Resonance / Rhapsody)
const olTune = (d, blend) => [T("ol", "Outline glow strength (0 = off)", d.ol, 0, 1, .05), T("olw", "Outline glow width (px)", d.olw, 1, 16, 1),
  T("olbr", "Outline breath (ms per half cycle)", d.olbr * 1000, 600, 6000, 100), ...(blend ? [TO("olcol", "Blend colour (red + blue mana)", BLEND_OPTS, 0)] : [])];
const olApply = (p, C) => { p.ol = tv(C, "ol"); p.olw = tv(C, "olw"); p.olbr = tv(C, "olbr") / 1000; if (C.cfg.olcol != null) p.olcol = tv(C, "olcol"); };
const sideApply = (k) => (C) => { const p = CUE_P[k]; p.n = tv(C, "n"); p.dmin = tv(C, "dmin") / 1000; p.dmax = Math.max(p.dmin + .1, tv(C, "dmax") / 1000); p.size = tv(C, "size");
  p.rise = tv(C, "rise") / 100; p.glow = tv(C, "glow"); p.breathe = tv(C, "breathe") / 1000; p.col = tv(C, "col"); olApply(p, C); };
const sideTune = (cols, k) => [T("n", "Motes", 7, 2, 16, 1), T("dmin", "Mote rise time, shortest (ms)", 2600, 800, 6000, 100), T("dmax", "Mote rise time, longest (ms)", 3800, 1000, 7000, 100),
  T("size", "Mote size (px at sprite height 250)", 7, 3, 14, 1), T("rise", "Mote rise (% of body height)", 45, 15, 90, 5),
  T("glow", "Underglow strength", .55, 0, 1, .05), T("breathe", "Underglow breath (ms per half cycle)", 2600, 600, 5000, 100), TO("col", "Colour", cols, 0), ...olTune(CUE_P[k], false), LOOK];
const resoApply = (C) => { const p = CUE_P.reso; p.n = tv(C, "n"); p.period = tv(C, "period") / 1000; p.size = tv(C, "size"); p.rx = tv(C, "rx") / 100; p.ry = tv(C, "ry");
  p.notes = tv(C, "notes"); p.noteEvery = tv(C, "every") / 1000; p.cell = tv(C, "cell"); olApply(p, C); };
const braidApply = (C) => { const p = CUE_P.braid; p.n = tv(C, "n"); p.period = tv(C, "period") / 1000; p.size = tv(C, "size"); p.r = tv(C, "r") / 100; p.glow = tv(C, "glow"); olApply(p, C); };
cueDef("cue_spell", "Next Spell · blue aura", "Loop · after a weapon attack", { next: "spell", reso: 1, rhap: false },
  "Soft blue aura: slow pixel motes rising off the lower body, a faint blue underglow at the feet and (v2) a subtle blue glow round the sprite. Tells the player to cast an Offensive Spell next (the switch grants +1 Resonance).",
  sideTune(["Sandbox blue", "Paler sky", "Deeper azure"], "spell"), sideApply("spell"),
  [{ id: "v2-outline", re: "Add a subtle blue glow border around user sprite too", text: "Added a subtle blue outline glow round Keren's sprite (strength .45, 6 px, breathing over 2.6 s; three sliders). In the game it is a PIXI glow filter on the token, like the turn glow." }]);
cueDef("cue_attack", "Next Attack · red aura", "Loop · after an Offensive Spell", { next: "attack", reso: 1, rhap: false },
  "The same language in red: attack next. Calmer than Berserk on purpose: 7 square pixel motes taking 2.6-3.8 s to rise, a slow 2.6 s breathing underglow, a subtle red outline glow (v2) and no body wash, against Berserk's 9 long streaks ripping up in 0.55-0.9 s, a 0.5 s throb and a red wash. Tick \"Berserk beside it\" in the sandbox to compare on the same body.",
  sideTune(["Sandbox red", "Paler coral", "Deeper crimson"], "attack"), sideApply("attack"),
  [{ id: "v2-outline", re: "Add a subtle red glow border around user sprite too", text: "Added a subtle red outline glow round Keren's sprite (strength .45, 6 px, breathing over 2.6 s; three sliders). Same PIXI filter in the game as Next Spell's, red." }]);
cueDef("cue_reso", "Resonance ready · gold + blend glow", "Loop · 2+ stacks, on top of red / blue", { next: "attack", reso: 2, rhap: false },
  "Gold and violet motes orbit the waist (the far half dims and shrinks, so it reads as passing behind) and now and then a pixel music note rises. It layers on top of the blue or red particles, but the OUTLINE turns to the red/blue blend (v2): Resonance ready means Rhapsody is available, so the blend wins over the red or blue outline. Shown here over Next Attack, so you see the blend beat the red.",
  [T("n", "Orbiting motes", 6, 2, 12, 1), T("period", "One orbit (ms)", 3200, 1200, 7000, 100), T("size", "Mote size (px at sprite height 250)", 7, 3, 14, 1),
    T("rx", "Orbit width (% of sprite width)", 42, 20, 70, 1), T("ry", "Orbit depth (px at 250)", 12, 2, 30, 1), T("notes", "Rising notes", 2, 0, 4, 1),
    T("every", "Each note's cycle (ms; it shows for the first 40%)", 4200, 1500, 9000, 100), T("cell", "Note pixel size (px at 250)", 3.5, 1.5, 6, .5), ...olTune(CUE_P.reso, true), LOOK],
  resoApply,
  [{ id: "v2-outline", re: "Add a glow of the combination of red and blue color around the sprite too (come up with a middle color between blue and red)", text: "Added an outline glow in the red/blue blend. Proposed colour: violet #b45cff (an even mix that reads as both manas, and is the Red Mage's own blend colour); the select also offers magenta #d94cc8 (leans red) and indigo-violet #8f6bff (leans blue). Precedence: this blend outline replaces the red / blue outline while Resonance is ready (Rhapsody is available)." }]);
cueDef("cue_braid", "Rhapsody Turn · braid + blend glow", "Loop · the held state after Rhapsody", { next: null, reso: 0, rhap: true },
  "Red and blue motes braid up the body in a double helix (half a turn apart; the far half of each turn dims), over a red / blue underglow and (v2) the red/blue blend outline glow. The held state after Spellblade Rhapsody, until the round ends. It replaces the other auras while it holds.",
  [T("n", "Motes per strand", 8, 3, 16, 1), T("period", "One climb (ms)", 2400, 1000, 6000, 100), T("size", "Mote size (px at 250)", 6, 3, 14, 1),
    T("r", "Helix radius (% of sprite width)", 30, 15, 50, 1), T("glow", "Underglow strength", .4, 0, 1, .05), ...olTune(CUE_P.braid, true), LOOK],
  braidApply,
  [{ id: "v2-outline", re: "Add a glow of the combination of red and blue color around the sprite too (come up with a middle color between blue and red)", text: "Added the same red/blue blend outline glow as Resonance ready (violet #b45cff by default, magenta / indigo-violet in the select), a little stronger (.55) and faster (2.2 s breath) because it is the active Rhapsody turn." }]);
// apply every cue's current sliders (sandbox plays use them too)
function cueApplyAll() { const cfg = (k) => ({ cfg: Object.fromEntries(SK[k].tune.map((t) => [t.k, t.v])) });
  sideApply("spell")(cfg("cue_spell")); sideApply("attack")(cfg("cue_attack")); resoApply(cfg("cue_reso")); braidApply(cfg("cue_braid")); }

// ═════════ Sandbox: the approved switch rule (class page round 1-4) as a mini turn loop
// start 1 Resonance, max Spellweave SL + 1; an attack after a spell (or a spell after an attack) = +1; Rhapsody costs 2,
// marks the turn (Attack + Offensive Spell, either order), grants nothing; Next marker = the other kind of the last action.
const SB = { R: 1, sl: 2, last: null, turn: 1, used: false, rhap: false, slots: null, log: [] };
const sbCap = () => SB.sl + 1;
function SB_SHOW(state) { cueSet(sfPick(state)); }
function sbState() { return { next: SB.last === "A" ? "spell" : SB.last === "S" ? "attack" : null, reso: SB.R, rhap: SB.rhap }; }
function sbPaint() { cueApplyAll(); SB_SHOW(sbState()); const el = $("sandbox"); if (!el) return; const c = sbCap(), canMain = !SB.used && !SB.rhap;
  const q = (id) => el.querySelector("#" + id);
  q("sb-atk").disabled = !(canMain || (SB.rhap && SB.slots.A)); q("sb-spl").disabled = !(canMain || (SB.rhap && SB.slots.S));
  q("sb-rh").disabled = !(SB.R >= 2 && !SB.used && !SB.rhap); q("sb-end").disabled = !SB.used;
  q("sb-pips").innerHTML = Array.from({ length: c }, (_, i) => `<i class="${i < SB.R ? (SB.R >= 2 ? "on ready" : "on") : ""}"></i>`).join("") + `<b>${SB.R} / ${c}</b>`;
  const cues = [...sfPick(sbState())].map((k) => ({ sfspell: "Next Spell (blue)", sfattack: "Next Attack (red)", sfreso: "Resonance ready (gold)", sfbraid: "Rhapsody Turn (braid)" })[k]);
  q("sb-now").textContent = `Round ${SB.turn} · ` + (cues.length ? "on Keren: " + cues.join(" + ") : "no aura yet (none before the first action)");
  q("sb-log").innerHTML = SB.log.slice(-6).reverse().map((l) => `<div>${l}</div>`).join(""); }
async function sbPlay(key) { pickSkill(key); await play(0); }
async function sbAct(kind) { const sw = SB.last && SB.last !== kind, label = kind === "A" ? "Attack" : "Offensive Spell"; let gain = false;
  if (sw && !SB.rhap && SB.R < sbCap()) { SB.R++; gain = true; SB.log.push(`T${SB.turn} · ${label}: switch, +1 Resonance`); }
  else if (sw && !SB.rhap) SB.log.push(`T${SB.turn} · ${label}: switch, stacks full`);
  else if (SB.rhap) SB.log.push(`T${SB.turn} · ${label} during Rhapsody: no Resonance`);
  else SB.log.push(`T${SB.turn} · ${label}` + (SB.last ? ": same as last, no switch" : ": sets the rhythm"));
  SB.last = kind; if (SB.rhap) { SB.slots[kind] = false; if (!SB.slots.A && !SB.slots.S) SB.used = true; } else SB.used = true;
  if (gain) { SB_PENDING = true; await sbPlay("resonance_gain"); } sbPaint(); }
let SB_PENDING = false;
async function sbRhap() { SB.R -= 2; SB.log.push(`T${SB.turn} · Spellblade Rhapsody: spend 2, attack and cast this turn`); SB_PENDING = true; await sbPlay("rhapsody"); }
function sbEnd() { SB.turn++; SB.used = false; SB.rhap = false; SB.slots = null; sbPaint(); }
function sbReset() { Object.assign(SB, { R: 1, last: null, turn: 1, used: false, rhap: false, slots: null, log: ["Conflict starts: Spellweave grants 1 Resonance."] }); sbPaint(); }
// after a move plays: the game's state change it stands for (an AE update in the game)
function afterMove(key) {
  if (CUE_REVIEW[key]) { SB_SHOW(CUE_REVIEW[key]); return; }
  if (key === "rhapsody") { SB.rhap = true; SB.slots = { A: true, S: true }; if (!SB_PENDING) SB.R = Math.max(0, SB.R); }
  if (key === "resonance_gain" && !SB_PENDING) SB.R = Math.min(sbCap(), SB.R + 1);
  SB_PENDING = false; sbPaint(); }
function mountSandbox() { const sec = document.createElement("section"); sec.className = "card sbx"; sec.id = "sandbox";
  sec.innerHTML = `<h3>Turn-loop sandbox · how the game switches the auras</h3>
    <div class="sbrow"><button class="sbb atk" id="sb-atk">⚔️ Attack</button><button class="sbb spl" id="sb-spl">📕 Offensive Spell</button>
      <button class="sbb rh" id="sb-rh">✦ Spellblade Rhapsody</button><button class="sbb end" id="sb-end">End turn</button><button class="sbb ghost" id="sb-reset">Reset</button>
      <label class="muted">Spellweave SL <select id="sb-sl">${[1, 2, 3, 4, 5].map((n) => `<option${n === SB.sl ? " selected" : ""}>${n}</option>`).join("")}</select></label></div>
    <div class="sbrow"><span class="lbl">Resonance</span><span class="pips" id="sb-pips"></span><span class="muted" id="sb-now"></span></div>
    <div class="sblog" id="sb-log"></div>
    <div class="checks" style="margin-top:6px"><label><input type="checkbox" id="sb-bz"> Berserk beside it (status-cues.js berserk, verbatim) to compare the reds</label>
      <label><input type="checkbox" id="sb-tg"> Keren's turn: the acting-token turn glow is on (turn-glow.js, party gold + floor pool)</label>
      <label class="muted">When both want the outline <select id="sb-rule"><option value="0" selected>Turn glow wins; the aura outline returns after her turn (recommended)</option><option value="1">Aura colour takes the outline; the gold floor pool stays</option></select></label></div>
    <p class="muted" style="margin:6px 0 0">A switch plays the +1 Resonance pulse; Rhapsody plays its activation, then the braid holds until End turn. Every aura (particles and outline) hides while an animation plays and comes back after it, as the game's cues do. Outline precedence: Rhapsody Turn / Resonance ready (blend) &gt; Next Attack (red) &gt; Next Spell (blue): one outline at a time.</p>`;
  $("sheet").after(sec);
  $("sb-atk").onclick = () => sbAct("A"); $("sb-spl").onclick = () => sbAct("S"); $("sb-rh").onclick = sbRhap; $("sb-end").onclick = sbEnd; $("sb-reset").onclick = sbReset;
  $("sb-sl").onchange = (e) => { SB.sl = +e.target.value; SB.R = Math.min(SB.R, sbCap()); sbPaint(); };
  $("sb-bz").onchange = (e) => { CUE.berserk = e.target.checked; cueRender(true); };
  $("sb-tg").onchange = (e) => { TGL.on = e.target.checked; };
  $("sb-rule").onchange = (e) => { TGL.rule = +e.target.value; };
  sbReset(); }
// a slider moved: a held cue re-renders live
function renderBalance() { if (CUE_REVIEW[CUR]) { cueApplyAll(); SB_SHOW(CUE_REVIEW[CUR]); } }
