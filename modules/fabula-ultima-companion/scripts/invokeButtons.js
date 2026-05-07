// scripts/invokeButtons.js — Foundry VTT v12
// Invoke Trait + Invoke Bond (merged)
// - [data-fu-trait]: reroll up to two accuracy dice ONCE per action
// - [data-fu-bond] : add a flat +1..+3 to accuracy.total ONCE per action
// Requires your CreateActionCard macro to persist payload on the message flag:
//   await posted.setFlag("fabula-ultima-companion", "actionCard", { payload: PAYLOAD });

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const CARD_FLAG = "actionCard";

  console.log("[fu-invokeButtons] script file loaded");

  // ---------- helpers (shared) ----------
  const esc = (v) => {
    const s = String(v ?? "");
    if (window.TextEditor?.escapeHTML) return TextEditor.escapeHTML(s);
    return s.replace(/[&<>"']/g, (m) => (
      m === "&" ? "&amp;" :
      m === "<" ? "&lt;"  :
      m === ">" ? "&gt;"  :
      m === '"' ? "&quot;":
                  "&#39;"
    ));
  };

  async function getPayload(chatMsg) {
    try {
      // getFlag is sync in V12; awaiting is harmless and keeps a uniform signature
      const f = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
      return f?.payload ?? f ?? null; // support {payload:{...}} and legacy {...}
    } catch (e) {
      console.warn("[fu-invokeButtons] getPayload failed:", e);
      return null;
    }
  }

  async function rebuildCard(nextPayload, oldMsg) {
    const cardMacro = game.macros.getName("CreateActionCard");
    if (!cardMacro) return ui.notifications.error('Macro "CreateActionCard" not found.');

    // Your CreateActionCard reads globals (__AUTO/__PAYLOAD)
    try {
      window.__AUTO = true;
      window.__PAYLOAD = nextPayload;
      await cardMacro.execute(); // no args: it uses the globals
    } finally {
      try { delete window.__AUTO; } catch {}
      try { delete window.__PAYLOAD; } catch {}
    }

    try { await oldMsg.delete(); } catch {}
  }

  async function getActorFromUuid(uuid) {
    if (!uuid) return null;
    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;
      if (doc?.actor) return doc.actor;                 // TokenDocument or embedded context
      if (doc?.type === "Actor") return doc;            // Actor doc
      return doc?.document?.actor ?? null;              // Fallback from embedded docs
    } catch {
      return null;
    }
  }

  function ensureOwner(actor, payload, what = "this action") {
  const initUid = payload?.meta?.ownerUserId || null;     // user who built the card
  const allow =
    game.user?.isGM ||
    actor?.isOwner === true ||
    (initUid && game.user?.id === initUid);

  if (!allow) ui.notifications?.warn(`Only the attacker’s owner (or GM) can ${what}.`);
  return allow;
}

function isInvokeLockedByFumble(payload = {}) {
  return !!(
    payload?.accuracy?.isFumble === true ||
    payload?.advPayload?.isFumble === true ||
    payload?.meta?.isFumble === true ||
    payload?.meta?.invokeLockedByFumble === true
  );
}

function blockInvokeIfFumble(payload = {}, label = "Invoke") {
  if (!isInvokeLockedByFumble(payload)) return false;

  ui.notifications?.warn(`${label} cannot be used on a Fumble.`);
  return true;
}

  function lock(btn) {
    if (!btn) return true;
    if (btn.dataset.fuLock === "1") return true;
    btn.dataset.fuLock = "1";
    return false;
  }
  function unlock(btn) {
    if (btn) btn.dataset.fuLock = "0";
  }

  // ---------- Fabula / Ultima helpers ----------
function isVillainOrBoss(actor) {
  const P = actor?.system?.props ?? {};
  return !!(P.isVillain || P.isBoss); // sheet checkboxes on villain/boss sheets
}

function resourceKeyAndLabel(actor) {
  const useUltima = isVillainOrBoss(actor);
  return {
    key: useUltima ? "ultima_point" : "fabula_point",
    label: useUltima ? "Ultima Point" : "Fabula Point"
  };
}

function currentPoints(actor, key) {
  const P = actor?.system?.props ?? {};
  const n = Number(P?.[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function canPayInvoke(actor) {
  const { key, label } = resourceKeyAndLabel(actor);
  const cur = currentPoints(actor, key);
  return { ok: cur >= 1, key, label, cur };
}

async function payInvoke(actor) {
  const { key, label } = resourceKeyAndLabel(actor);
  const cur = currentPoints(actor, key);
  if (cur < 1) return { ok: false, key, label, cur };
  try {
    await actor.update({ [`system.props.${key}`]: cur - 1 });
    return { ok: true, key, label, cur: cur - 1 };
  } catch (e) {
    console.warn("[fu-invokeButtons] payInvoke failed:", e);
    return { ok: false, key, label, cur };
  }
}

  // Actor → die size for attribute label (e.g., "DEX"→d?)
  function dieSizeFor(actor, attr) {
    const k = String(attr || "").toLowerCase();
    const P = actor?.system?.props ?? {};
    const cur  = Number(P[`${k}_current`]);
    const base = Number(P[`${k}_base`]);
    const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
    return [4, 6, 8, 10, 12, 20].includes(n) ? n : 6;
  }

  // Extract bonds in expected shape: { index, name, bonus, filled }
  function collectBonds(actor) {
    const P = actor?.system?.props ?? {};
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      const name = String(P[`bond_${i}`] ?? "").trim();
      if (!name) continue;
      const e1 = !!P[`emotion_${i}_1`];
      const e2 = !!P[`emotion_${i}_2`];
      const e3 = !!P[`emotion_${i}_3`];
      const filled = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
      const bonus = Math.min(3, Math.max(0, filled));
      bonds.push({ index: i, name, bonus, filled });
    }
    return bonds;
  }

  // Fancy HM-style bond chooser (name | hearts | +N)
async function chooseBondDialog(bondCandidates, attacker) {
  // 1) Normalize the candidates (from payload snapshot) into our minimal shape
  const viable = (Array.isArray(bondCandidates) ? bondCandidates : [])
    .filter(b => (Number(b?.bonus || 0) > 0));

  if (!viable.length) return null;

  // 2) Read emotions from the ACTOR for heart colors (Adm/Loy/Aff vs Inf/Mis/Hat)
  const P = attacker?.system?.props ?? {};
  const norm = s => String(s ?? "").trim().toLowerCase();
  const SLOTS = [
    { pos:"admiration", neg:"inferiority", labelPos:"Admiration", labelNeg:"Inferiority" },
    { pos:"loyalty",    neg:"mistrust",    labelPos:"Loyalty",    labelNeg:"Mistrust"    },
    { pos:"affection",  neg:"hatred",      labelPos:"Affection",  labelNeg:"Hatred"      }
  ];

  function emotionsForIndex(i){
    const v1 = norm(P[`emotion_${i}_1`]);
    const v2 = norm(P[`emotion_${i}_2`]);
    const v3 = norm(P[`emotion_${i}_3`]);
    return {
      admiration : v1 === "admiration",
      inferiority: v1 === "inferiority",
      loyalty    : v2 === "loyalty",
      mistrust   : v2 === "mistrust",
      affection  : v3 === "affection",
      hatred     : v3 === "hatred"
    };
  }

  function filledHearts(emotions){
    const items = [];
    for (const s of SLOTS) {
      if (emotions[s.pos]) items.push({state:"pos", title:s.labelPos});
      else if (emotions[s.neg]) items.push({state:"neg", title:s.labelNeg});
    }
    items.sort((a,b)=> (a.state==="pos") ? -1 : (b.state==="pos") ? 1 : 0);
    return items;
  }

  function svgHeart({state="pos", title=""}={}) {
    const fill = state==="pos" ? "#E85A70" : "#7B62C0";
    const t = String(title).replace(/"/g,'&quot;');
    return `
      <span class="hm-heart-wrap" title="${t}" data-tooltip="${t}">
        <svg class="hm-heart" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="${t}">
          <title>${t}</title>
          <path d="M8 13.8s-4.8-3.3-6-5.3C1 5.7 2.1 3.4 4.1 3.2c1.2-.1 2.2.4 2.9 1.2.6-.8 1.6-1.3 2.9-1.2 2 .2 3 2.3 2.1 4.2-1.1 2-6 6.4-6 6.4z"
                fill="${fill}" stroke="#5A4637" stroke-width="1.1"/>
        </svg>
      </span>`;
  }

  // 3) Render rows using your compact layout (name | hearts | +N)
  function row(bond, idx, selectedIdx){
    const emo = emotionsForIndex(Number(bond.index));
    const hearts = filledHearts(emo).map(svgHeart).join("");
    const sel = (idx === selectedIdx) ? " selected" : "";
    const title = `+${bond.bonus} from ${bond.name}`;
    return `
      <div class="hm-row${sel}" data-idx="${idx}" data-index="${bond.index}" title="${title}">
        <div class="hm-name">${esc(bond.name)}</div>
        <div class="hm-bar">${hearts}</div>
        <div class="hm-badge">+${bond.bonus}</div>
      </div>`;
  }

  // 4) Inline CSS from the demo (trimmed to essentials)
  function css(){
    return `<style>
      .hm{ --ink:#2b1f17; --edge:#b79a6a; --sel:#FFBB55;
           --heart:16px; --nameFS:13px; --barW:156px; --namePad:10px; --barNudge:8px;
           --muted:#6b5b4a; }
      .hm-wrap{ padding:.4rem .25rem .2rem; }
      .hm-list{ display:grid; gap:.35rem; max-height:420px; overflow:auto; }
      .hm-row{
        display:grid; grid-template-columns: 1fr auto auto; align-items:center;
        gap:.55rem; padding:.45rem .6rem; border:2px solid var(--edge); border-radius:12px;
        background:linear-gradient(180deg,#fff5e1,#f2e2c4); box-shadow: 0 8px 16px rgba(0,0,0,.08);
        cursor:pointer; user-select:none;
      }
      .hm-row:hover{ filter:brightness(1.03) saturate(1.02); }
      .hm-row.selected{ border-color: var(--sel);
        box-shadow: 0 0 0 3px rgba(255,187,85,.25), 0 8px 16px rgba(0,0,0,.18); }
      .hm-name{
        justify-self:start; font-weight:800; letter-spacing:.2px; font-size: var(--nameFS);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right: var(--namePad);
      }
      .hm-bar{ grid-column: 2 / 3; justify-self:center; display:flex; gap:.18rem; width:var(--barW);
               transform: translateX(var(--barNudge)); }
      .hm-heart{ width: var(--heart); height: var(--heart); }
      .hm-badge{
        justify-self:end; color:#111; font-size:18px; font-weight:400; font-style:italic; letter-spacing:.2px;
        background:transparent; padding:0; border-radius:0; box-shadow:none; text-shadow:0 1px 0 rgba(255,255,255,.7);
      }
      .hm-foot{ display:flex; justify-content:space-between; align-items:center; margin-top:.35rem; font-size:12px; color:var(--muted); }
      .dialog .dialog-buttons button{ min-width:110px; }
    </style>`;
  }

  // 5) Dialog shell + interactions (keyboard + click)
  let selectedIdx = viable.length ? 0 : -1;
  const legend = `
    <div class="hm-legend" style="display:flex; gap:.75rem; align-items:center; margin:0 .25rem .35rem;">
      <span class="hm-leg">${svgHeart({state:"pos", title:"positive"})} positive</span>
      <span class="hm-leg">${svgHeart({state:"neg", title:"negative"})} negative</span>
    </div>`;

  const content = `
    <form class="hm">
      ${css()}
      <div class="hm-wrap">
        ${legend}
        <div class="hm-list" data-list></div>
        <div class="hm-foot">
          <div>Bond bonus is +1 per filled emotion (max +3).</div>
          <div>Loaded from actor</div>
        </div>
      </div>
    </form>`;

  function applyAutoFit(root){
    const names = [...root.querySelectorAll(".hm-name")];
    let fs = 13, heart = 16;
    const overflows = () => names.some(n => n.scrollWidth > n.clientWidth);
    for (let i=0; i<3 && overflows(); i++){
      fs = Math.max(11, fs - 1);
      heart = Math.max(14, heart - 1);
      root.style.setProperty("--nameFS", `${fs}px`);
      root.style.setProperty("--heart", `${heart}px`);
    }
  }

  return await new Promise(resolve => new Dialog({
    title: "Invoke Bond — Choose a Bond",
    content,
    buttons: {
      ok: { label: "Invoke", callback: (html) => {
        const el = html[0].querySelector(".hm-row.selected");
        if (!el) return resolve(null);
        const idx = Number(el.dataset.idx);
        resolve(viable[idx]?.index ?? null); // return the bond.index
      }},
      cancel: { label: "Cancel", callback: () => resolve(null) }
    },
    default: "ok",
    close: () => resolve(null),
    render: (html) => {
      const root = html[0];
      const list = root.querySelector("[data-list]");
      const okBtn = root.closest(".app")?.querySelector('.dialog-buttons button[data-button="ok"]');

      function refresh(){
        list.innerHTML = viable.map((b,i)=>row(b,i,selectedIdx)).join("");
        if (okBtn) okBtn.disabled = (selectedIdx < 0);

        for (const el of list.querySelectorAll(".hm-row")){
          el.addEventListener("click", () => { selectedIdx = Number(el.dataset.idx); refresh(); });
          el.addEventListener("keydown", (ev)=>{
            if (ev.key==="ArrowUp"||ev.key==="ArrowDown"){
              ev.preventDefault();
              const d = ev.key==="ArrowUp" ? -1 : 1;
              selectedIdx = Math.max(0, Math.min(viable.length-1, selectedIdx + d));
              refresh();
              list.querySelector(`.hm-row[data-idx="${selectedIdx}"]`)?.focus();
            }
            if (ev.key===" "||ev.key==="Enter"){ ev.preventDefault(); el.click(); }
          });
          el.setAttribute("tabindex","0");
        }
        applyAutoFit(root);
      }
      refresh();
      const ro = new ResizeObserver(()=>applyAutoFit(root));
      ro.observe(root.closest(".window-app"));
    }
  }).render(true));
}

  // ---------- actions ----------
   async function handleInvokeTrait(btn, chatMsg) {
    const payload = await getPayload(chatMsg);
    if (!payload) return ui.notifications?.error("Invoke Trait: Missing payload on the card.");

    if (blockInvokeIfFumble(payload, "Invoke Trait")) return;

    const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
    if (invoked.trait) return ui.notifications?.warn("Trait already invoked for this action.");

    const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, payload, "Invoke Trait")) return;

    // 1) Pre-check resources (block immediately if none)
{
  const chk = canPayInvoke(attacker);
  if (!chk.ok) {
    ui.notifications?.warn(`Not enough ${chk.label}s (need 1).`);
    return;
  }
}

    const A = payload.accuracy;
    if (!A) return ui.notifications?.warn("No Accuracy check to reroll.");

    // Dialog to choose which die(s) to reroll — now with two toggle buttons
const dieInfo = `
  <p><b>Current:</b><br>
  ${A.A1} → d${A.dA} = ${A.rA.total}<br>
  ${A.A2} → d${A.dB} = ${A.rB.total}</p>
  <p>Choose which die to reroll (once per action):</p>
`;

// Sepia card UI with icons + keyboard nav (visual-only)
const ATTR_ICONS = {
  DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
  MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
  INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png"
};
const FALLBACK_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/dice.png";
const iconFor = (attr) => ATTR_ICONS[(attr || "").toUpperCase()] ?? FALLBACK_ICON;

const choice = await new Promise((resolve) => new Dialog({
  title: "Invoke Trait — Reroll",
  content: `<form>
    <style>
      .fu-root{ --parch-1:#f6ebd3; --parch-2:#efdfc3; --parch-3:#e7d3b1; --ink:#3b2a19; --shadow:rgba(0,0,0,.22); --accent:#e35151; }
      .fu-title{font-weight:700;margin:.25rem 0 .35rem;color:var(--ink);}
      .fu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.6rem;margin:.2rem 0 .6rem;}
      .fu-card{
        position:relative; display:flex; align-items:center; gap:.6rem;
        padding:.6rem .75rem; border-radius:12px; cursor:pointer; user-select:none;
        color:var(--ink); border:3px solid rgba(87,58,33,.95);
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%, rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, var(--parch-1) 0%, var(--parch-2) 55%, var(--parch-3) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,.55),
          inset 0 0 0 2px rgba(255,255,255,.06),
          0 6px 14px var(--shadow);
        transition: filter .12s ease, box-shadow .12s ease, border-color .12s ease, transform .06s ease;
      }
      .fu-card:hover{ filter:brightness(1.04) saturate(1.03); }
      .fu-card:active{ transform:translateY(1px); }
      .fu-card.on{
        border-color: var(--accent);
        outline: 2px solid rgba(227,81,81,.35); outline-offset: 0;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,.7),
          inset 0 0 0 2px rgba(255,255,255,.12),
          0 6px 14px var(--shadow),
          0 0 14px rgba(227,81,81,.55),
          0 0 28px rgba(227,81,81,.35);
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.65) 0%, rgba(255,255,255,.28) 22%, transparent 40%),
          linear-gradient(180deg, #fff3dc 0%, #f3e2bd 55%, #e8cea0 100%);
      }
      .fu-icon{width:40px;height:40px;object-fit:contain;border:none;background:transparent;border-radius:8px;}
      .fu-left{display:flex;align-items:center;gap:.5rem;min-width:0;}
      .fu-die{font-weight:800;white-space:nowrap;}
      .fu-spacer{flex:1 1 auto;}
      .fu-result{font-weight:900;font-size:22px;letter-spacing:.3px;}
      .fu-hint{font-size:12px;opacity:.75;margin:.25rem 0 0;color:var(--ink);}
      .fu-card[data-tip]::after{
        content: attr(data-tip); position:absolute; left:50%; bottom:100%; transform:translate(-50%,-6px);
        background:rgba(20,20,20,.92); color:#fff; padding:.3rem .5rem; border-radius:6px;
        font-size:12px; white-space:nowrap; box-shadow:0 2px 6px rgba(0,0,0,.35);
        opacity:0; pointer-events:none; transition:opacity .12s ease; z-index:1000;
      }
      .fu-card[data-tip]::before{
        content:""; position:absolute; left:50%; bottom:100%; transform:translate(-50%,2px);
        border:6px solid transparent; border-top-color:rgba(20,20,20,.92); opacity:0; transition:opacity .12s ease;
      }
      .fu-card[data-tip]:hover::after, .fu-card[data-tip]:hover::before{ opacity:1; }
    </style>

    <div class="fu-root">
      <div class="fu-title">Choose which die to reroll</div>
      <div class="fu-grid">
        <button type="button" class="fu-card" data-which="A" data-sel="0" data-tip="${A.A1}" title="${A.A1}">
          <div class="fu-left">
            <img class="fu-icon" src="${iconFor(A.A1)}" alt="">
            <div class="fu-die">d${A.dA}</div>
          </div>
          <div class="fu-spacer"></div>
          <div class="fu-result">${A.rA.total}</div>
        </button>

        <button type="button" class="fu-card" data-which="B" data-sel="0" data-tip="${A.A2}" title="${A.A2}">
          <div class="fu-left">
            <img class="fu-icon" src="${iconFor(A.A2)}" alt="">
            <div class="fu-die">d${A.dB}</div>
          </div>
          <div class="fu-spacer"></div>
          <div class="fu-result">${A.rB.total}</div>
        </button>
      </div>
      <p class="fu-hint">Click one or both to select. Click again to unselect.</p>
    </div>
  </form>`,
  buttons: {
    ok: {
      label: "Reroll",
      callback: (html) => {
        const root = html[0];
        const aOn = root.querySelector('[data-which="A"]')?.dataset.sel === "1";
        const bOn = root.querySelector('[data-which="B"]')?.dataset.sel === "1";
        return resolve(aOn && bOn ? "AB" : aOn ? "A" : bOn ? "B" : null);
      }
    },
    cancel: { label: "Cancel", callback: () => resolve(null) }
  },
  default: "ok",
  close: () => resolve(null),
  render: (html) => {
    const root  = html[0];
    const btnA  = root.querySelector('[data-which="A"]');
    const btnB  = root.querySelector('[data-which="B"]');
    const okBtn = root.closest('.app')?.querySelector('.dialog-buttons button[data-button="ok"]');

    const toggle = (btn) => {
      btn.dataset.sel = btn.dataset.sel === "1" ? "0" : "1";
      btn.classList.toggle("on", btn.dataset.sel === "1");
      if (okBtn) okBtn.disabled = (btnA.dataset.sel !== "1" && btnB.dataset.sel !== "1");
    };

    [btnA, btnB].forEach((b) => {
      b.setAttribute("tabindex", "0");
      b.addEventListener("click", (ev) => { ev.preventDefault(); toggle(b); });
      b.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { (b === btnA ? btnB : btnA).focus(); }
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(b); }
      });
    });

    if (okBtn) okBtn.disabled = true;
  }
}).render(true));

    if (!choice) {
      ui.notifications.info("Trait invoke cancelled.");
      return "CANCELLED";
    }

    // Spend 1 point now that the player confirmed the reroll
{
  const spend = await payInvoke(attacker);
  if (!spend.ok) {
    ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
    return;
  }
}

    // Reroll
    const dA = dieSizeFor(attacker, A.A1);
    const dB = dieSizeFor(attacker, A.A2);
    const rA = (choice === "A" || choice === "AB")
      ? (await (new Roll(`1d${dA}`)).evaluate()).total
      : Number(A.rA.total);
    const rB = (choice === "B" || choice === "AB")
      ? (await (new Roll(`1d${dB}`)).evaluate()).total
      : Number(A.rB.total);

    const bonus = Number(A.checkBonus || 0);
    const total = rA + rB + bonus;
    const hr    = Math.max(rA, rB);

    // Crit/Fumble (keep your props)
    const critRange = Number(attacker?.system?.props?.critical_dice_range ?? 0);
    const minCrit   = Number(attacker?.system?.props?.minimum_critical_dice ?? 999);
    const isCrit    = (Math.abs(rA - rB) <= critRange) && (rA >= minCrit || rB >= minCrit);
    const fumbleTH  = Number(attacker?.system?.props?.fumble_threshold ?? -1);
    const isFumble  = (fumbleTH >= 0) ? (rA <= fumbleTH && rB <= fumbleTH) : false;

    // Build next payload
    const next = foundry.utils.deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
    next.meta.invoked.trait = true;

    next.accuracy = {
      dA, dB,
      rA: { total: rA, result: rA },
      rB: { total: rB, result: rB },
      total, hr,
      isCrit, isBunny: (isCrit && rA !== rB), isFumble,
      A1: A.A1, A2: A.A2,
      checkBonus: bonus,
      hrUsed: next.meta?.ignoreHR ? null : hr
    };

    // Recompute preview damage (base-without-HR + new HR)
    const elem   = String(next?.meta?.elementType || "physical").toLowerCase();
    const healRx = /^(heal|healing|recovery|restore|restoration)$/i;
    const declaresHealing = healRx.test(elem);
    const ignoreHR = !!next?.meta?.ignoreHR;

    const prevCombined = Number(next?.meta?.baseValueStrForCard ?? 0);
    const prevHr       = Number(next?.meta?.hrBonus ?? 0);
    const baseNoHR     = declaresHealing ? prevCombined : Math.max(0, prevCombined - (ignoreHR ? 0 : prevHr));

    const newHrBonus   = (!declaresHealing && !ignoreHR) ? hr : 0;
    const newCombined  = declaresHealing ? baseNoHR : (baseNoHR + newHrBonus);

    next.meta.declaresHealing     = declaresHealing;
    next.meta.hasDamageSection    = (newCombined > 0);
    next.meta.hrBonus             = newHrBonus;
    next.meta.baseValueStrForCard = String(newCombined);

    if (next.advPayload) {
      next.advPayload.hr        = ignoreHR ? null : hr;
      next.advPayload.isCrit    = !!isCrit;
      next.advPayload.isFumble  = !!isFumble;
      next.advPayload.baseValue = declaresHealing ? `+${baseNoHR}` : String(newCombined);
    }

    await rebuildCard(next, chatMsg);
  }

    async function handleInvokeBond(btn, chatMsg) {
  const payload = await getPayload(chatMsg);
  if (!payload) return ui.notifications?.error("Invoke Bond: Missing payload on the card.");

  if (blockInvokeIfFumble(payload, "Invoke Bond")) return;

  const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
  if (invoked.bond) return ui.notifications?.warn("Bond already invoked for this action.");

  const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;

  // Use the attacker from the payload UUID (not selected token)
  const attacker = await getActorFromUuid(atkUuid);
  if (!ensureOwner(attacker, payload, "Invoke Bond")) return;

  // 1) Pre-check resources (block immediately if none)
  {
    const chk = canPayInvoke(attacker);
    if (!chk.ok) {
      ui.notifications?.warn(`Not enough ${chk.label}s (need 1).`);
      return;
    }
  }

  const A = payload.accuracy;
  if (!A) return ui.notifications?.warn("No Accuracy check to modify.");

  // Prefer bonds from payload.meta (snapshot made by ActionDataFetch)
  const bondSnap = payload?.meta?.bonds || { list:[], viable:[] };
  const viable = Array.isArray(bondSnap.viable) ? bondSnap.viable
               : Array.isArray(bondSnap.list)   ? bondSnap.list.filter(b => (b?.bonus||0) > 0)
               : [];

  if (!viable.length) return ui.notifications?.warn("No eligible Bonds on this action.");

  // If multiple, ask with HM-style dialog (hearts colored from actor.emotion_X_Y)
  let chosen = viable[0];
  if (viable.length > 1) {
    const pick = await chooseBondDialog(viable, attacker); // <— NEW UI
    if (pick == null) { ui.notifications.info("Bond invoke cancelled."); return "CANCELLED"; }
    chosen = viable.find(b => Number(b.index) === Number(pick)) ?? chosen;
  }

  // Spend 1 point (Fabula for PCs / Ultima for Villains/Boss)
  {
    const spend = await payInvoke(attacker);
    if (!spend.ok) {
      ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
      return;
    }
  }

  const addBonus = Number(chosen.bonus || 0);
  if (!(addBonus > 0)) return ui.notifications?.warn("Chosen Bond gives no bonus.");

  // Build the next payload (mark invoked + adjust accuracy totals)
  const next = foundry.utils.deepClone(payload);
  next.meta = next.meta || {};
  next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
  next.meta.invoked.bond = true;
  next.meta.bondInfo = { index: chosen.index, name: chosen.name, bonus: addBonus };

  const oldBonus = Number(A.checkBonus || 0);
  const newBonus = oldBonus + addBonus;
  const rA = Number(A.rA?.total ?? 0);
  const rB = Number(A.rB?.total ?? 0);
  const newTotal = rA + rB + newBonus;

  next.accuracy = {
    ...A,
    rA: { total: rA, result: A.rA?.result ?? rA },
    rB: { total: rB, result: A.rB?.result ?? rB },
    checkBonus: newBonus,
    total: newTotal
  };

  await rebuildCard(next, chatMsg);
}

  // ---------- binder (single listener handles both buttons) ----------
  function bindInvokeButtons() {
    const root = document.querySelector("#chat-log") || document.body;
    if (!root || root.__fuInvokeButtonsBound) return;
    root.__fuInvokeButtonsBound = true;

    root.addEventListener("click", async (ev) => {
      // NOTE: keep selectors EXACTLY as used in your chat card HTML
      const btnTrait = ev.target.closest?.("[data-fu-trait]");
      const btnBond  = btnTrait ? null : ev.target.closest?.("[data-fu-bond]"); // avoid double hits

if (!btnTrait && !btnBond) return;

const btn = btnTrait || btnBond;

// Visual-lock guard.
// New fumble cards still render Invoke buttons, but they are marked as locked.
// This catches the click immediately and gives the player a clear reason.
if (btn?.dataset?.fuInvokeLocked === "fumble") {
  ui.notifications?.warn(
    btnTrait
      ? "Invoke Trait cannot be used on a Fumble."
      : "Invoke Bond cannot be used on a Fumble."
  );
  return;
}

if (lock(btn)) return;

      try {
        // Locate message (both buttons share same lookup)
        const msgEl   = btn.closest?.(".message");
        const msgId   = msgEl?.dataset?.messageId;
        const chatMsg = msgId ? game.messages.get(msgId) : null;
        if (!chatMsg) return;

        if (btnTrait) await handleInvokeTrait(btnTrait, chatMsg);
        else          await handleInvokeBond(btnBond,  chatMsg);
      } catch (err) {
        console.error(err);
        ui.notifications?.error("Invoke failed (see console).");
      } finally {
        unlock(btn);
      }
    }, { capture: false });

    console.log("[fu-invokeButtons] ready — installed chat listener");
  }

  // Bind even if loaded after 'ready'
  if (window.game?.ready) bindInvokeButtons();
  else Hooks.once("ready", bindInvokeButtons);
})();
