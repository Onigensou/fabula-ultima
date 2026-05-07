// ──────────────────────────────────────────────────────────
//  Skill Button (JRPG list) → ActionDataFetch (Foundry V12)
//  • Active (non-spell) skills
//  • MP/IP cost text (minimal, right-aligned; supports 10×T / 20%×T)
//  • NEW: Auto-disable (grey out) unaffordable skills
// ──────────────────────────────────────────────────────────
const ACTION_DATA_FETCH_NAME = "ActionDataFetch";
const SOUND_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
const SOUND_VOL = 0.6;
const SOUND_COOLDOWN_MS = 80;

(async () => {
  if (!canvas?.scene) return ui.notifications.error("No active scene.");

  // ---------- utils ----------
  const esc = (v) => String(v ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const S = v => (v ?? "").toString().trim();
  const stripHtml = (html) => {
    try { const d=document.createElement("div"); d.innerHTML=String(html??""); return d.textContent||d.innerText||""; }
    catch { return String(html ?? ""); }
  };

  // ----- cost pretty-print for the UI (produces safe HTML fragment)
  function extractCostBadges(item) {
    const raw = S(item?.system?.props?.cost ?? item?.system?.cost ?? "");
    if (!raw) return { mp: "", ip: "" };
    const tokens = raw.split(/[,/&+]+/).map(t => t.trim()).filter(Boolean);
    let mp = "", ip = "";
    for (const token of tokens) {
      const m = token.match(/^(\d+)\s*(%?)\s*(?:(?:x|\*)\s*T)?\s*([a-z]+)$/i);
      if (!m) continue;
      const num = m[1];
      const pct = m[2] ? "%" : "";
      const res = (m[3] || "").toUpperCase();
      const usesT = /(?:^|\s)(?:x|\*)\s*T(?:\s|$)/i.test(token);
      const tFrag = usesT ? `<span class="mul">×</span><span class="t">T</span>` : "";
      const html = `${num}${pct}${tFrag}&thinsp;${res}`;
      if (res === "MP" && !mp) mp = html;
      if (res === "IP" && !ip) ip = html;
    }
    return { mp, ip };
  }

  // ----- affordability check (mirrors ResourceGate)
  const RESOURCES = {
    mp: { cur: "current_mp", max: "max_mp", label: "MP" },
    ip: { cur: "current_ip", max: "max_ip", label: "IP" },
  };

  function parseTokenCost(token, T) {
    const m = String(token).trim().match(/^(\d+)\s*(%?)\s*(?:(?:x|\*)\s*T)?\s*([a-z]+)$/i);
    if (!m) return null;
    const base = Number(m[1] || 0);
    const isPct = !!m[2];
    const typeKey = (m[3] || "").toLowerCase();
    if (!RESOURCES[typeKey]) return null;
    const usesT = /(?:^|\s)(?:x|\*)\s*T(?:\s|$)/i.test(token);
    return { typeKey, base, isPct, usesT, T };
  }

  function parseCostList(raw, T) {
    return String(raw)
      .split(/[,/&+]+/)            // "5 MP + 1 IP", "10% MP, 1 IP"
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => parseTokenCost(t, T))
      .filter(Boolean);
  }

  function makeSpendPlan(item, actorProps, T) {
    const raw = S(item?.system?.props?.cost ?? item?.system?.cost ?? "");
    if (!raw) return { plan: [], ok: true, msg: "" };
    const tokens = parseCostList(raw, T);
    if (!tokens.length) return { plan: [], ok: true, msg: "" };

    const plan = tokens.map(c => {
      const defs = RESOURCES[c.typeKey];
      const cur  = Number(actorProps?.[defs.cur] ?? 0) || 0;
      const mx   = Number(actorProps?.[defs.max] ?? 0) || 0;
      const baseReq = c.isPct ? Math.ceil((mx * c.base) / 100) : c.base;
      const req = baseReq * (c.usesT ? c.T : 1);
      return { label: defs.label, cur, mx, req };
    });

    const lacking = plan.filter(x => x.cur < x.req);
    const ok  = lacking.length === 0;
    const msg = ok ? "" : lacking.map(x => `${x.label} ${x.req} needed (you have ${x.cur})`).join(", ");
    return { plan, ok, msg };
  }

  // ----- sounds + scroll
  let _lastPlay = 0;
  async function playMove() {
    const now = Date.now();
    if (now - _lastPlay < SOUND_COOLDOWN_MS) return;
    _lastPlay = now;
    try {
      if (globalThis.AudioHelper?.play) {
        await AudioHelper.play({ src: SOUND_URL, volume: SOUND_VOL, loop: false }, true);
      } else { const a=new Audio(SOUND_URL); a.volume=SOUND_VOL; a.play().catch(()=>{}); }
    } catch {}
  }
  function keepInView(container, el, pad = 8) {
    if (!container || !el) return;
    const c = container.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (e.top < c.top + pad) container.scrollTop -= (c.top + pad - e.top);
    else if (e.bottom > c.bottom - pad) container.scrollTop += (e.bottom - (c.bottom - pad));
  }

  // ---- Actor resolution (Player→linked char, GM→selected token; fallback to selected)
  function firstSelectableToken() { return canvas.tokens?.placeables?.find(t => t.actor?.isOwner) ?? null; }
  function selectedToken()        { return canvas.tokens.controlled[0] ?? null; }
  function resolveActorForUser() {
    if (game.user.isGM) {
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok };
    } else {
      const a = game.user.character ?? null;
      if (a) return { actor: a, token: canvas.tokens?.placeables?.find(t => t.actor?.id === a.id) ?? null };
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok };
    }
  }

  async function resolveItemByUuidOrActor(uuid, actor) {
    try {
      if (uuid) {
        const doc = await fromUuid(uuid);
        if (doc?.documentName === "Item") return doc;
        if (doc?.constructor?.name?.includes?.("Item")) return doc;
      }
    } catch {}
    const id = uuid?.split(".").pop();
    if (actor?.items?.size) { const f = actor.items.get(id); if (f) return f; }
    const g = game.items?.get(id); if (g) return g;
    return null;
  }

  function detectType(item) {
    const p = item?.system?.props ?? {};
    if (p.isSpell) return "Spell"; // excluded for this menu
    const base = S(p.skill_type);
    return ["Active","Passive","Other"].includes(base) ? base : "Active";
  }

  function getDesc(item) {
    const p = item?.system?.props ?? {};
    const cand = [p.skill_effect, p.effects, p.effect, p.description,
                  item?.system?.description?.value, item?.system?.description];
    const hit = cand.find(v => S(v).length);
    return stripHtml(hit ?? "");
  }

  // ---------- resolve actor/target ----------
  const { actor: useActor, token: pickedToken } = resolveActorForUser();
  if (!useActor) return ui.notifications.warn("No character found. (Players: link a Character; GM: select a token.)");
  const actorProps = useActor?.system?.props ?? {};

  // How many current targets? (used for costs like 10×T)
  const TARGETS_COUNT = (Array.from(game.user?.targets ?? []).length) || 1;

   // ---------- collect skills ----------
  const pluck = (obj) => (obj && typeof obj === "object")
    ? Object.values(obj).map(e => ({ name: e?.name, id: e?.id, uuid: e?.uuid }))
    : [];

  const pluckEquippedItemGrantedSkills = (actor) => {
    const allItems = actor?.items ? Array.from(actor.items) : [];

    const equippedItems = allItems.filter(it => {
      const p = it?.system?.props ?? {};
      return (p.isEquipped === true) || (it?.system?.isEquipped === true);
    });

    const grants = equippedItems.flatMap(it => {
      const p = it?.system?.props ?? {};
      const table = p.item_skill_active ?? it?.system?.item_skill_active ?? {};
      if (!table || typeof table !== "object") return [];

                  const itemTypeRaw = String(p.item_type ?? it?.system?.item_type ?? "")
        .trim()
        .toLowerCase();

      const itemGrantIcon = it?.img || it?.icon || "";

      return Object.values(table).map(entry => ({
        name: entry?.name ?? "",
        id: entry?.id ?? "",
        uuid: entry?.uuid ?? "",
        grantedBy: it?.name ?? "",
        grantedByType: itemTypeRaw,
        grantedByImg: itemGrantIcon
      }));
    });

    console.debug("[Skill Picker] Equipped items found:", equippedItems.map(it => it.name));
    console.debug(
      "[Skill Picker] Equipped item skill grants:",
      grants.map(g => ({ name: g.name, uuid: g.uuid, grantedBy: g.grantedBy }))
    );

    return grants;
  };

  const actorSkillCandidates = [
    ...pluck(actorProps.skill_active_list),
    ...pluck(actorProps.skill_passive_list),
    ...pluck(actorProps.skill_other_list),
  ];

  const equipmentGrantedCandidates = pluckEquippedItemGrantedSkills(useActor);

  const rawCandidates = [
    ...actorSkillCandidates,
    ...equipmentGrantedCandidates,
  ];

  const seen = new Set();
  const candidates = rawCandidates.filter(c => {
    const key = S(c?.uuid) || `${S(c?.id)}::${S(c?.name)}`;
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.debug("[Skill Picker] Candidate totals:", {
    actorListCount: actorSkillCandidates.length,
    equipmentGrantCount: equipmentGrantedCandidates.length,
    mergedCount: candidates.length
  });

  if (!candidates.length) return ui.notifications.warn("No skills found on this actor.");

  const resolved = (await Promise.all(candidates.map(async c => {
    const item = await resolveItemByUuidOrActor(c.uuid, useActor);
    if (!item) return null;
    const type = detectType(item);
    if (type !== "Active") return null;
    const afford = makeSpendPlan(item, actorProps, TARGETS_COUNT);
    return { ...c, item, afford };
  }))).filter(Boolean);

  if (!resolved.length) return ui.notifications.warn("No Active skills available.");
  // Guard against missing names (bad data rows) and sort safely.
const nameOf = (s) => (S(s?.name) || S(s?.item?.name) || "").trim();

// Drop entries that still have no name, and log for debugging once.
const before = resolved.length;
const filtered = resolved.filter(s => nameOf(s).length);
if (filtered.length !== before) {
  console.debug("[Skill Picker] Dropped skills with missing name:", before - filtered.length);
}

filtered.sort((a,b) => nameOf(a).localeCompare(nameOf(b)));
const finalList = filtered; // use this instead of 'resolved'

  // ---------- rows ----------
   const rows = finalList.map(s => {
    const img = s.item?.img || s.item?.icon || "icons/svg/explosion.svg";
    const title = esc(s.name);
    const uuid  = s.item?.uuid ?? s.uuid;
    const desc  = esc(getDesc(s.item) || "(No description)");
    const { mp, ip } = extractCostBadges(s.item);
    const rightCosts = (mp || ip)
      ? `<div class="jrpg-costs">
           ${mp ? `<span class="jrpg-cost">${mp}</span>` : ""}
           ${ip ? `<span class="jrpg-cost">${ip}</span>` : ""}
         </div>` : "";

    const disabled = !s.afford.ok;
    const blockMsg = s.afford.msg ? esc(s.afford.msg) : "Not enough resources.";

    const grantEmojiMap = {
      weapon: "⚔️",
      accessory: "🔮",
      armor: "🥋",
    };

        const grantEmoji = grantEmojiMap[String(s.grantedByType ?? "").toLowerCase()] ?? "";
    const grantTag = (s.grantedBy && grantEmoji)
      ? `<span class="jrpg-grant-tag"
               data-tagtip="${esc(s.grantedBy)}"
               data-tagimg="${esc(s.grantedByImg ?? "")}"
               aria-label="Granted by ${esc(s.grantedBy)}">${grantEmoji}</span>`
      : "";

    return `
      <div class="jrpg-row">
        <button type="button"
                class="jrpg-skill-btn ${disabled ? "is-disabled" : ""}"
                ${disabled ? "disabled aria-disabled='true' data-blockmsg='"+blockMsg+"'" : ""}
                data-uuid="${esc(uuid)}"
                data-desc="${desc}"
                aria-label="${title}"
                tabindex="0">
          <img class="jrpg-skill-icon" src="${esc(img)}" alt="" />
          <span class="jrpg-skill-label-wrap">
            <span class="jrpg-skill-label">${title}</span>
            ${grantTag}
          </span>
          ${rightCosts}
        </button>
      </div>
    `;
  }).join("");

  const content = `
    <style>
      .jrpg-wrap { max-height: 460px; overflow: auto; padding: 8px; }
      .jrpg-row { position: relative; }
      .jrpg-skill-btn {
        position: relative; display:flex; align-items:center; gap:8px;
        width:100%; margin:6px 0; padding:8px 12px;
        border:2px solid rgba(120,78,20,.9); outline:none; border-radius:9999px;
        box-shadow:0 2px 0 rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.25);
        background:linear-gradient(#f2d9a2,#e1c385);
        font-weight:600; font-size:14px; text-align:left; cursor:pointer;
        transition:filter .05s, transform .05s, box-shadow .05s;
      }
      .jrpg-skill-btn:hover { filter:brightness(1.05); transform:translateY(-1px); }
      .jrpg-skill-btn:active { transform:translateY(0); box-shadow:0 1px 0 rgba(0,0,0,.3), inset 0 0 0 1px rgba(255,255,255,.25); }
      .jrpg-skill-btn:focus, .jrpg-skill-btn.is-active {
        box-shadow:0 0 0 3px rgba(255,255,255,.6), 0 0 0 6px rgba(120,78,20,.55), 0 2px 0 rgba(0,0,0,.25);
      }
            .jrpg-skill-icon { width:24px; height:24px; image-rendering:pixelated; flex:0 0 24px; border-radius:4px; box-shadow:0 0 0 1px rgba(0,0,0,.15) inset; background:rgba(0,0,0,.05); }

      .jrpg-skill-label-wrap {
        display:flex;
        align-items:center;
        gap:6px;
        min-width:0;
        flex:1;
      }

      .jrpg-skill-label {
        min-width:0;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      .jrpg-grant-tag {
        flex:0 0 auto;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:22px;
        height:20px;
        padding:0 6px;
        border-radius:999px;
        background:rgba(255,255,255,.35);
        border:1px solid rgba(120,78,20,.35);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.15);
        font-size:12px;
        line-height:1;
        cursor:help;
      }

      /* disabled look */
      .jrpg-skill-btn.is-disabled,
      .jrpg-skill-btn:disabled {
        filter: grayscale(.35) brightness(.9);
        opacity: .55;
        cursor: not-allowed;
        transform: none !important;
        box-shadow: 0 1px 0 rgba(0,0,0,.15), inset 0 0 0 1px rgba(255,255,255,.2);
      }

      /* Minimal cost area (MP/IP) */
      .jrpg-costs { margin-left:auto; display:flex; align-items:center; gap:10px; }
      .jrpg-cost {
        font-weight: 550; font-style: italic; color: #3a2a14;
        text-shadow: none; letter-spacing: .4px; font-size: 13px;
      }
      .jrpg-cost .mul { font-size: 11px; opacity: .85; margin: 0 1px 0 4px; }
      .jrpg-cost .t   { font-size: 11px; opacity: .85; margin-left: 1px; font-variant-caps: small-caps; letter-spacing: .2px; }

      .jrpg-tip { position:fixed; z-index:999999; max-width:340px; padding:8px 10px; border:2px solid rgba(80,50,12,.95); border-radius:10px; background:#f7f1e3; color:#2b2b2b; box-shadow:0 6px 18px rgba(0,0,0,.35); font-size:13px; line-height:1.2; font-weight:600; pointer-events:none; }
      .jrpg-tip-row {
        display:flex;
        align-items:center;
        gap:8px;
      }

      .jrpg-tip-icon {
        width:20px;
        height:20px;
        flex:0 0 20px;
        border-radius:4px;
        image-rendering:pixelated;
        box-shadow:0 0 0 1px rgba(0,0,0,.15) inset;
        background:rgba(0,0,0,.05);
      }

      .jrpg-tip-label {
        white-space:nowrap;
      }
      </style>
    <div class="jrpg-wrap" tabindex="-1">
      ${rows}
    </div>
  `;

  // ---------- dialog & interactions ----------
  const chosenUuid = await new Promise(resolve => {
    const dlg = new Dialog({ title: "Choose Skill", content, buttons: {} }, { width: 420 });

        function createTip(content, anchorEl, { html = false } = {}) {
      const tip = document.createElement("div");
      tip.className = "jrpg-tip";

      if (html) tip.innerHTML = content;
      else tip.textContent = content;

      document.body.appendChild(tip);
      const r = anchorEl.getBoundingClientRect(), pad = 8;
      const top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, r.top + (r.height - tip.offsetHeight)/2));
      const left= Math.min(window.innerWidth - tip.offsetWidth - 8, r.right + pad);
      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      return tip;
    }

    const onRender = (app, html) => {
      if (app.id !== dlg.id) return;

      let liveTip=null, tipTimer=null;
      const $wrap = html.find(".jrpg-wrap");
      const wrapEl= $wrap.get(0);
      const $btns = html.find(".jrpg-skill-btn");

      // initial focus
      const first = $btns.get(0);
      if (first) { first.classList.add("is-active"); first.focus({preventScroll:true}); keepInView(wrapEl, first); }

      // hover
      html.on("mouseenter",".jrpg-skill-btn",ev=>{
        const btn=ev.currentTarget; $btns.removeClass("is-active"); btn.classList.add("is-active"); playMove();
        const text=btn?.dataset?.desc||"";
        if (!text && btn.classList.contains("is-disabled")) {
          // show reason we disabled
          const msg = btn.dataset.blockmsg || "Not enough resources.";
          liveTip=createTip(msg, btn);
          return;
        }
        if (!text) return;
        tipTimer=setTimeout(()=>{ liveTip=createTip(text,btn); },120);
      });
            html.on("mouseleave",".jrpg-skill-btn",()=>{
        if (tipTimer){clearTimeout(tipTimer); tipTimer=null;}
        if (liveTip){liveTip.remove(); liveTip=null;}
      });

            // hover on equipment grant tag
      html.on("mouseenter", ".jrpg-grant-tag", ev => {
        ev.stopPropagation();
        const tag = ev.currentTarget;

        if (tipTimer){ clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip){ liveTip.remove(); liveTip = null; }

        const itemName = tag?.dataset?.tagtip || "";
        const itemImg  = tag?.dataset?.tagimg || "";

        if (!itemName) return;

        const safeName = esc(itemName);
        const safeImg  = esc(itemImg);

        const tipHtml = itemImg
          ? `<div class="jrpg-tip-row">
               <img class="jrpg-tip-icon" src="${safeImg}" alt="" />
               <span class="jrpg-tip-label">${safeName}</span>
             </div>`
          : `<div class="jrpg-tip-row">
               <span class="jrpg-tip-label">${safeName}</span>
             </div>`;

        liveTip = createTip(tipHtml, tag, { html: true });
      });

      html.on("mouseleave", ".jrpg-grant-tag", ev => {
        ev.stopPropagation();
        if (liveTip){ liveTip.remove(); liveTip = null; }
      });

      // click
      html.on("click",".jrpg-skill-btn",ev=>{
        const el=ev.currentTarget;
        if (el.classList.contains("is-disabled")) {
          const msg = el.dataset.blockmsg || "Not enough resources.";
          ui.notifications?.warn(msg); return;
        }
        const uuid=el?.dataset?.uuid;
        if (tipTimer){clearTimeout(tipTimer); tipTimer=null;}
        if (liveTip){liveTip.remove(); liveTip=null;}
        resolve(uuid||null); dlg.close();
      });

      // keyboard
      $wrap.on("keydown",(ev)=>{
        const KEY=ev.key, btnEls=$btns.toArray(); if (!btnEls.length) return;
        const activeIx = btnEls.findIndex(b=>b.classList.contains("is-active")) ?? 0;
        let nextIx=activeIx;
        if (["ArrowDown","s","S"].includes(KEY)) { nextIx=Math.min(btnEls.length-1,activeIx+1); ev.preventDefault(); }
        else if (["ArrowUp","w","W"].includes(KEY)) { nextIx=Math.max(0,activeIx-1); ev.preventDefault(); }
        else if (KEY==="Home") { nextIx=0; ev.preventDefault(); }
        else if (KEY==="End") { nextIx=btnEls.length-1; ev.preventDefault(); }
        else if (KEY==="Enter" || KEY===" ") {
          ev.preventDefault();
          const btn=btnEls[Math.max(0,activeIx)];
          if (btn?.classList.contains("is-disabled")) { ui.notifications?.warn(btn.dataset.blockmsg || "Not enough resources."); return; }
          btn?.click(); return;
        }
        else if (KEY==="Escape") { ev.preventDefault(); resolve(null); dlg.close(); return; }
        else return;

        if (nextIx!==activeIx) {
          const btn = btnEls[nextIx];
          $btns.removeClass("is-active"); btn.classList.add("is-active"); btn.focus({preventScroll:true});
          keepInView(wrapEl, btn); playMove();
          if (tipTimer){clearTimeout(tipTimer); tipTimer=null;}
          if (liveTip){liveTip.remove(); liveTip=null;}
        }
      });

      Hooks.once("closeDialog",()=>{ if (liveTip) liveTip.remove(); });
    };

    Hooks.once("renderDialog", onRender);
    dlg.render(true);
  });

  if (!chosenUuid) return; // cancelled

  // ---------- handoff ----------
  const attacker_uuid = useActor?.uuid || pickedToken?.document?.uuid || null;
  const targets = Array.from(game.user?.targets ?? []).map(t=>t.document?.uuid).filter(Boolean);
  const payload = { attacker_uuid, targets, skillUuid: chosenUuid };

  const ADF = game.macros.getName(ACTION_DATA_FETCH_NAME);
  if (!ADF) return ui.notifications.error(`Macro "${ACTION_DATA_FETCH_NAME}" not found or no permission.`);
  await ADF.execute({ __AUTO: true, __PAYLOAD: payload });
})();
