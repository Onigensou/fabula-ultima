// ===== Mockup-only demo panel: trigger the new pieces without a second player =====
(() => {
  const DEMO = { timed: true, whoosh: 'whoosh', appear: 'inv_appear', oppReady: false };
  const _timed = timed;
  timed = () => !!(S && (S.ctrl === 'gm' || DEMO.timed));          // the 30 s round timer, as in a PvP duel
  // challenge-panel sounds go through the page's own sound player
  const invSound = (k) => sfx(k === 'appear' ? DEMO.appear : k === 'accept' ? 'inv_accept' : k === 'cursor' ? 'cursor' : 'inv_decline', 1, 0);
  const _sfx = sfx;
  sfx = function (k, ...a) { if (k === 'whoosh' && DEMO.whoosh !== 'whoosh') k = DEMO.whoosh; return _sfx(k, ...a); };

  const css = document.createElement('style');
  css.textContent = `
  #demo{position:fixed;left:12px;bottom:12px;z-index:10000;width:min(300px,calc(100vw - 24px));font-family:"Signika",system-ui,sans-serif;color:#3a1e06;
    background:linear-gradient(180deg,#f8f0d4,#ede0b0);border:2px solid #c9a44a;border-radius:10px;box-shadow:0 0 0 2px #7a4e20,0 10px 24px #000b;font-size:13px}
  #demo summary{cursor:pointer;list-style:none;padding:8px 12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px;background:linear-gradient(180deg,#7a4e20,#4f2f10);color:#f8e3a8;border-radius:8px}
  #demo[open] summary{border-radius:8px 8px 0 0}
  #demo summary::-webkit-details-marker{display:none}
  #demo .db{padding:8px 12px 12px;display:flex;flex-direction:column;gap:8px;max-height:min(70vh,560px);overflow:auto}
  #demo h4{margin:4px 0 0;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:#8a6a3a}
  #demo .r{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  #demo button{font-family:inherit;font-size:13px;padding:5px 9px;border-radius:6px;border:1px solid #3a1e06;background:linear-gradient(180deg,#7a5230,#5c3818);color:#f8f0d4;cursor:pointer}
  #demo button.on{box-shadow:0 0 0 2px #f4c95d}
  #demo select{color:#3a1e06;font-family:inherit;font-size:12.5px;border:1px solid #b8865a;background:#fffaf0;border-radius:5px;padding:2px 4px}
  #demo .msg{font-size:12px;color:#7f6140;min-height:16px}
  #demo .rdy .who{background:#fffaf0}`;
  document.head.appendChild(css);

  const el = document.createElement('details'); el.id = 'demo'; el.open = window.innerWidth > 900;
  el.innerHTML = `<summary>Demo · new in this build</summary><div class="db">
    <h4>Challenge panel (map)</h4>
    <div class="r"><button type="button" id="d-inv">Blanche challenges you</button></div>
    <div class="r">Pop-up sound <select id="d-app"><option value="inv_appear">Bell3</option><option value="alt_item3">Item3</option><option value="alt_chest1">Chest1</option><option value="alt_decision2">Decision2</option></select></div>
    <div class="msg" id="d-invmsg"></div>
    <h4>Team select (PvP)</h4>
    <div class="rdy"><div class="who"><b>You</b><span id="d-me"></span></div><div class="who"><b>Blanche</b><span id="d-opp"></span></div></div>
    <div class="r"><button type="button" id="d-ready">Blanche readies</button></div>
    <h4>During a duel</h4>
    <div class="r"><button type="button" id="d-timed">30 s round timer: on</button><button type="button" id="d-low">Jump to 10 s left</button></div>
    <div class="r"><button type="button" id="d-ko">KO banner</button><button type="button" id="d-ban">Other banner</button></div>
    <div class="r">Banner sound <select id="d-wh"><option value="whoosh">Evasion2</option><option value="alt_wind3">Wind3</option><option value="alt_wind4">Wind4</option><option value="alt_wind7">Wind7</option></select></div>
    <h4>Status effects</h4>
    <div class="r"><button type="button" id="d-fx">Set up effects</button><button type="button" id="d-fx1">+1 Static / step</button></div>
    <h4>Result screen</h4>
    <div class="r"><button type="button" id="d-win">Win now</button><button type="button" id="d-lose">Lose now</button></div>
    <div class="r"><button type="button" id="d-rem">PvP: Blanche wants a rematch</button></div>
    <div class="msg" id="d-msg">Start a duel first (pick a team, then Start).</div>
  </div>`;
  document.body.appendChild(el);
  const $d = (id) => document.getElementById(id);
  const msg = (t) => { $d('d-msg').textContent = t; };
  const chip = (ok, pop) => ok ? `<span class="chip ok ${pop ? 'rpop' : ''}">✓ Ready</span>` : `<span class="chip wait"><i></i>Choosing…</span>`;
  const chips = (pop) => { $d('d-me').innerHTML = chip(false); $d('d-opp').innerHTML = chip(DEMO.oppReady, pop); };
  chips(false);

  // Status effects: rebuild the board with Skizzik / Roo / Sylph vs Wolf / Pyrefly / Walrog and switch the effects on
  const mk = (cid, i) => ({ cid, i, hp: CARDS[cid].hp, ko: false, activeRounds: 0 });
  $d('d-fx').onclick = () => {
    if (!live() || S.phase === 'anim') return msg('Start a duel and wait for your pick, then press this.');
    if (S.phase === 'opening' || S.phase === 'replace') return msg('Pick your opening monster first, then press this.');
    S.p[0].roster = ['skizzik', 'roo', 'sylph'].map(mk); S.p[1].roster = ['wolf', 'pyrefly', 'walrog'].map(mk);
    S.p[0].active = 0; S.p[1].active = 0; S.p[0].pending = false; S.p[1].pending = false;
    S.p[0].roster[0].static = 1; S.p[0].roster[1].walk = 1;
    S.p[0].twFrom = S.round; S.p[0].twUntil = S.round + CFG.TAILWIND - 1;          // Tailwind up: Sylph SPD shows green
    S.p[1].roster[0].howl = true; S.p[1].roster[0].charm = S.round + 1;           // Wolf: Howl (+1) and Charmed (−2) → ATK red
    S.p[1].roster[1].burn = { 0: 1 };                                             // their Pyrefly has Burned your Skizzik
    S._built = null; render();
    msg('Hover a badge or a coloured number. +1 Static / step shows a stack being gained.');
  };
  $d('d-fx1').onclick = () => {
    if (!S || !S.p[0].roster.some((m) => m.cid === 'skizzik')) return msg('Press Set up effects first.');
    for (const m of S.p[0].roster) { if (m.cid === 'skizzik') m.static = Math.min(2, (m.static || 0) + 1); if (m.cid === 'roo') m.walk = Math.min(CFG.ROO_STEPS, (m.walk || 0) + 1); }
    updateField();
  };

  $d('d-inv').onclick = () => {
    sndInit();
    showInvitePanel({ fromName: 'Blanche', toName: 'Hina', bestOf: 1, img: ART.succubus || '', ms: 20000, sound: invSound,
      onAnswer: (a) => { $d('d-invmsg').textContent = a === 'timeout' ? 'Ran out of time: the panel closed itself and Blanche is told you didn’t answer.'
        : a === 'block' ? 'Blocked: no more challenges from Blanche until the party rests.' : a === 'accept' ? 'Accepted: both duel windows open.' : 'Declined: Blanche is told.'; } });
  };
  $d('d-app').onchange = (e) => { DEMO.appear = e.target.value; sndInit(); sfx(DEMO.appear, 1, 0); };
  $d('d-wh').onchange = (e) => { DEMO.whoosh = e.target.value; sndInit(); sfx('whoosh', 1, 0); };
  $d('d-ready').onclick = () => { DEMO.oppReady = !DEMO.oppReady; $d('d-ready').textContent = DEMO.oppReady ? 'Blanche un-readies' : 'Blanche readies'; chips(true); if (DEMO.oppReady) { sndInit(); sfx('decide', 0.7, 0); } };
  const live = () => S && S.phase !== 'ended';
  const tb = $d('d-timed');
  tb.classList.add('on');
  tb.onclick = () => { DEMO.timed = !DEMO.timed; tb.textContent = `30 s round timer: ${DEMO.timed ? 'on' : 'off'}`; tb.classList.toggle('on', DEMO.timed);
    if (!S) return; if (!DEMO.timed) { clearInterval(TICK); S.deadline = null; drawFuse(); }
    else if (live() && S.phase !== 'anim' && !S.deadline) { S.deadline = Date.now() + CFG.TIMER * 1000; clearInterval(TICK); TICK = setInterval(tickTimer, 250); drawFuse(); } };
  $d('d-low').onclick = () => { if (!live() || S.phase === 'anim') return msg('Wait for a decision (your turn to pick).');
    S.deadline = Date.now() + 10400; LOW_KEY = null; clearInterval(TICK); TICK = setInterval(tickTimer, 250); drawFuse(); msg('Fuse: orange under 10 s, red + pulsing under 5 s, shaking under 3 s.'); };
  $d('d-ko').onclick = () => { if (!S) return msg('Start a duel first.'); const m = S.p[1].roster[S.p[1].active] || S.p[1].roster[0];
    announce(`${seatName(1)}'s ${N(m.cid)} is down!`, { tone: 'good', sub: `${seatName(1)} is choosing a replacement` }); };
  let bi = 0;
  $d('d-ban').onclick = () => { if (!S) return msg('Start a duel first.');
    const list = [['Final round!', { tone: 'warn', sub: 'Round 20 of 20' }], ['Hina is down!', { tone: 'bad', sub: 'Drag a monster up to replace it' }], ["Time's almost up!", { tone: 'warn' }]];
    const [t, o] = list[bi++ % list.length]; announce(t, o); };
  $d('d-win').onclick = () => { if (!live() || S.phase === 'anim') return msg('Needs a duel in progress (not mid-animation).'); surrender(1); };
  $d('d-lose').onclick = () => { if (!live() || S.phase === 'anim') return msg('Needs a duel in progress (not mid-animation).'); surrender(0); };
  const _eb = endButtons;
  $d('d-rem').onclick = () => {
    if (!S || S.phase !== 'ended') return msg('Finish a duel first (Win now / Lose now).');
    endButtons = () => ({ note: 'Blanche wants a rematch!', hot: true, btns: [
      { id: 'ob-again', label: 'Rematch', go: true, glow: true, act: () => { endButtons = _eb; closeEndOverlay(); newMatch(); } },
      { id: 'ob-leave', label: 'Leave', cancel: true, act: () => { endButtons = _eb; closeEndOverlay(); S = null; SERIES = null; render(); } }] });
    if (!document.querySelector('.ovl.keep')) finishBanner(); else fillEndButtons();
    sfx('decide', 0.7, 0);
  };
})();
