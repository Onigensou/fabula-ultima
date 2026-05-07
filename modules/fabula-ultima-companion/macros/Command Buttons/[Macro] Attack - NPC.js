/**
 * Macro: Attack - NPC
 * Foundry V12 — Monster Attack picker → ActionDataFetch
 * - Pulls from actor.system.props.attack_list (preferred, matches ADF list model)
 * - Fallback: actor.items where item.system.props.skill_type === "Attack"
 * - Same handoff style as Spell/Skill: { attacker_uuid, targets, skillUuid }
 */

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
  const S = (v) => (v ?? "").toString().trim();
  const stripHtml = (html) => {
    try { const d=document.createElement("div"); d.innerHTML=String(html??""); return d.textContent||d.innerText||""; }
    catch { return String(html ?? ""); }
  };

  // Cursor sound (same vibe as Skill/Spell)
  let _lastMoveAt = 0;
  function playMove() {
    const now = Date.now();
    if (now - _lastMoveAt < SOUND_COOLDOWN_MS) return;
    _lastMoveAt = now;
    try { AudioHelper.play({src:SOUND_URL, volume:SOUND_VOL, autoplay:true, loop:false}, true); } catch {}
  }

  // ---------- attacker resolution (same methodology as ADF / Skill / Spell) ----------
  function selectedToken()        { return canvas.tokens?.controlled?.[0] ?? null; }
  function firstSelectableToken() { return canvas.tokens?.placeables?.find(t => t.actor?.isOwner) ?? null; }

  function resolveActorForUserV12() {
    if (game.user.isGM) {
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok, why: tok ? "GM selected/fallback token" : "GM: none" };
    } else {
      const a = game.user.character ?? null;
      if (a) {
        const tok = canvas.tokens?.placeables?.find(t => t.actor?.id === a.id) ?? null;
        return { actor: a, token: tok, why: "Player linked actor" };
      }
      const tok = selectedToken() ?? firstSelectableToken();
      return { actor: tok?.actor ?? null, token: tok, why: tok ? "Player fallback: selected owned token" : "Player: none" };
    }
  }

  const resolved = resolveActorForUserV12();
  const useActor = resolved?.actor ?? null;
  const pickedToken = resolved?.token ?? null;

  if (!useActor) {
    return ui.notifications.warn("Attack - NPC: Could not resolve attacker (no linked character / no valid token).");
  }

  const actorProps = useActor.system?.props ?? {};

  // ---------- cost pretty-print (same as Skill/Spell) ----------
  // Examples: "10 x T MP", "20% x T MP", "25 MP", "2 IP", "5 MP + 1 IP"
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

  // ---------- affordability (mirrors ResourceGate logic used in Skill/Spell buttons) ----------
  const RESOURCES = {
    mp: { cur: "current_mp", max: "max_mp", label: "MP" },
    ip: { cur: "current_ip", max: "max_ip", label: "IP" },
  };

  function getRes(key) {
    const def = RESOURCES[key];
    const cur = Number(actorProps?.[def.cur] ?? 0) || 0;
    const max = Number(actorProps?.[def.max] ?? 0) || 0;
    return { cur, max, label: def.label };
  }

  function parseCostRaw(raw, targetsCount) {
    const txt = S(raw);
    if (!txt) return [];
    const parts = txt.split(/[,/&+]+/).map(t => t.trim()).filter(Boolean);

    const out = [];
    for (const p of parts) {
      const m = p.match(/^(\d+)\s*(%?)\s*(?:(?:x|\*)\s*T)?\s*([a-z]+)$/i);
      if (!m) continue;
      const num = Number(m[1] || 0) || 0;
      const isPct = !!m[2];
      const res = (m[3] || "").toLowerCase();
      const usesT = /(?:^|\s)(?:x|\*)\s*T(?:\s|$)/i.test(p);

      out.push({ res, num, isPct, usesT, raw: p });
    }
    return out;
  }

  function makeSpendPlan(item, targetsCount) {
    const raw = S(item?.system?.props?.cost ?? item?.system?.cost ?? "");
    const costs = parseCostRaw(raw, targetsCount);
    if (!costs.length) return { ok: true, blockMsg: "", spend: [] };

    const spend = [];
    for (const c of costs) {
      if (!RESOURCES[c.res]) continue;
      const R = getRes(c.res);

      let amt = 0;
      if (c.isPct) {
        amt = Math.ceil((R.max * (c.num / 100)) * (c.usesT ? targetsCount : 1));
      } else {
        amt = Math.ceil((c.num) * (c.usesT ? targetsCount : 1));
      }
      spend.push({ res: c.res, label: R.label, amt, cur: R.cur });
    }

    const tooLow = spend.find(s => s.amt > s.cur);
    if (tooLow) {
      return {
        ok: false,
        blockMsg: `Not enough ${tooLow.label} (${tooLow.cur} / ${tooLow.amt}).`,
        spend
      };
    }
    return { ok: true, blockMsg: "", spend };
  }

  // ---------- build NPC attack candidates ----------
  const listToArray = (obj) =>
    (obj && typeof obj === "object")
      ? Object.values(obj).map(e => ({ name: e.name, id: e.id, uuid: e.uuid }))
      : [];

  const fromTable = listToArray(actorProps.attack_list);
  let candidates = [];

  // Preferred: the dynamic table (consistent with ADF’s props.attack_list model)
  if (fromTable.length) {
    for (const meta of fromTable) {
      let itemDoc = null;
      if (meta?.uuid) {
        try { itemDoc = await fromUuid(meta.uuid); } catch {}
      }
      // fallback by id/name if uuid missing
      if (!itemDoc && meta?.id && useActor.items?.get) {
        itemDoc = useActor.items.get(meta.id) ?? null;
      }
      if (!itemDoc && meta?.name && useActor.items?.getName) {
        itemDoc = useActor.items.getName(meta.name) ?? null;
      }

      candidates.push({
        uuid: itemDoc?.uuid ?? meta.uuid ?? null,
        name: itemDoc?.name ?? meta.name ?? "Unnamed Attack",
        img : itemDoc?.img ?? "",
        item: itemDoc
      });
    }
  }

  // Fallback: scan items directly by skill_type === "Attack"
  if (!candidates.length) {
    const items = Array.from(useActor.items ?? []);
    const attackItems = items.filter(i => {
      const st = S(i?.system?.props?.skill_type ?? i?.system?.skill_type ?? "");
      return st.toLowerCase() === "attack";
    });

    candidates = attackItems.map(it => ({
      uuid: it.uuid,
      name: it.name,
      img : it.img ?? "",
      item: it
    }));
  }

  candidates = candidates.filter(c => !!c.uuid);

  if (!candidates.length) {
    return ui.notifications.warn(`Attack - NPC: No Attack items found on "${useActor.name}".`);
  }

  // ---------- descriptions ----------
  function getDesc(c) {
    const it = c?.item ?? null;
    const p  = it?.system?.props ?? {};
    const html =
      p.description ??
      p.effect ??
      p.skill_effect ??
      it?.system?.description?.value ??
      it?.system?.description ??
      "";
    return stripHtml(html).trim();
  }

  // ---------- dialog UI ----------
  const targetsCount = Math.max(1, Array.from(game.user?.targets ?? []).length);

  const rowsHtml = candidates.map((c) => {
    const it = c.item;
    const cost = extractCostBadges(it);
    const plan = makeSpendPlan(it, targetsCount);
    const disabled = !plan.ok;

    const mpHtml = cost.mp ? `<div class="cost mp">${cost.mp}</div>` : "";
    const ipHtml = cost.ip ? `<div class="cost ip">${cost.ip}</div>` : "";
    const costWrap = (mpHtml || ipHtml) ? `<div class="cost-wrap">${mpHtml}${ipHtml}</div>` : `<div class="cost-wrap"></div>`;

    const desc = esc(getDesc(c));
    const blockMsg = esc(plan.blockMsg || "");

    return `
      <button type="button"
        class="jrpg-attack-btn ${disabled ? "is-disabled" : ""}"
        data-uuid="${esc(c.uuid)}"
        data-desc="${desc}"
        data-blockmsg="${blockMsg}">
        <div class="left">
          <img class="icon" src="${esc(c.img || "")}" onerror="this.style.visibility='hidden'"/>
          <div class="name">${esc(c.name)}</div>
        </div>
        ${costWrap}
      </button>
    `;
  }).join("");

  const content = `
  <style>
    .jrpg-attack-wrap { display:flex; gap:12px; min-height: 340px; }
    .jrpg-attack-list { flex: 1; }
    .jrpg-attack-scroll {
      max-height: 360px; overflow: auto; padding-right: 6px;
    }
    .jrpg-attack-btn {
      width:100%;
      display:flex; align-items:center; justify-content:space-between;
      border-radius: 18px;
      padding: 10px 12px;
      margin: 8px 0;
      border: 2px solid #b58d44;
      background: linear-gradient(180deg,#f7e5b5 0%, #f0d090 100%);
      box-shadow: 0 3px 0 rgba(0,0,0,.18) inset;
      cursor:pointer;
    }
    .jrpg-attack-btn.is-active { outline: 3px solid rgba(120,170,255,.65); }
    .jrpg-attack-btn.is-disabled {
      opacity: .45;
      filter: grayscale(0.9);
      cursor: not-allowed;
    }
    .jrpg-attack-btn .left { display:flex; align-items:center; gap:10px; }
    .jrpg-attack-btn .icon { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; }
    .jrpg-attack-btn .name { font-weight: 700; }
    .cost-wrap { display:flex; gap:10px; font-weight:700; opacity:.9; }
    .cost-wrap .cost { white-space:nowrap; font-style: italic; }
    .cost-wrap .mul { font-style: normal; opacity:.8; margin: 0 2px; }
    .cost-wrap .t { text-decoration: underline; font-style: normal; }
    .jrpg-attack-tip {
      position: fixed; z-index: 100000;
      max-width: 360px;
      background: rgba(20,18,16,.96);
      color: #f4efe5;
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.3;
      box-shadow: 0 10px 26px rgba(0,0,0,.35);
      pointer-events: none;
    }
    .jrpg-attack-title { font-weight: 800; margin-bottom: 6px; }
  </style>

  <div class="jrpg-attack-wrap">
    <div class="jrpg-attack-list">
      <div class="jrpg-attack-scroll" tabindex="0">
        ${rowsHtml}
      </div>
    </div>
  </div>
  `;

  function keepInView(scrollEl, btnEl) {
    if (!scrollEl || !btnEl) return;
    const r1 = scrollEl.getBoundingClientRect();
    const r2 = btnEl.getBoundingClientRect();
    if (r2.top < r1.top) scrollEl.scrollTop -= (r1.top - r2.top) + 8;
    else if (r2.bottom > r1.bottom) scrollEl.scrollTop += (r2.bottom - r1.bottom) + 8;
  }

  function createTip(text, anchorEl) {
    if (!text || !anchorEl) return null;
    const tip = document.createElement("div");
    tip.className = "jrpg-attack-tip";
    tip.innerHTML = `<div class="jrpg-attack-title">Info</div>${esc(text)}`;
    document.body.appendChild(tip);

    const r = anchorEl.getBoundingClientRect();
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, r.right + 10);
    const y = Math.max(12, r.top - 4);
    tip.style.left = `${x}px`;
    tip.style.top  = `${y}px`;
    return tip;
  }

  const chosenUuid = await new Promise((resolve) => {
    const dlg = new Dialog({
      title: "Choose Attack",
      content,
      buttons: {
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "cancel",
      close: () => resolve(null)
    }, { width: 460 });

    const onRender = (app, html) => {
      const $wrap = html.find(".jrpg-attack-scroll");
      const wrapEl = $wrap?.[0];
      const $btns = html.find(".jrpg-attack-btn");

      // initial focus
      const first = $btns?.[0];
      if (first) { first.classList.add("is-active"); first.focus({preventScroll:true}); }

      let tipTimer = null;
      let liveTip = null;

      // hover tip
      html.on("mouseenter", ".jrpg-attack-btn", (ev) => {
        const btn = ev.currentTarget;
        $btns.removeClass("is-active");
        btn.classList.add("is-active");
        playMove();

        const text = btn?.dataset?.desc || "";
        if (!text && btn.classList.contains("is-disabled")) {
          const msg = btn.dataset.blockmsg || "Not enough resources.";
          liveTip = createTip(msg, btn);
          return;
        }
        if (!text) return;
        tipTimer = setTimeout(() => { liveTip = createTip(text, btn); }, 120);
      });

      html.on("mouseleave", ".jrpg-attack-btn", () => {
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip) { liveTip.remove(); liveTip = null; }
      });

      // click
      html.on("click", ".jrpg-attack-btn", (ev) => {
        const el = ev.currentTarget;
        if (el.classList.contains("is-disabled")) {
          const msg = el.dataset.blockmsg || "Not enough resources.";
          ui.notifications?.warn(msg);
          return;
        }
        const uuid = el?.dataset?.uuid;
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip) { liveTip.remove(); liveTip = null; }
        resolve(uuid || null);
        dlg.close();
      });

      // keyboard + auto-scroll
      $wrap.on("keydown", (ev) => {
        const KEY = ev.key;
        const btnEls = $btns.toArray();
        if (!btnEls.length) return;

        const activeIx = btnEls.findIndex(b => b.classList.contains("is-active")) ?? 0;
        let nextIx = activeIx;

        if (["ArrowDown","s","S"].includes(KEY)) { nextIx = Math.min(btnEls.length-1, activeIx+1); ev.preventDefault(); }
        else if (["ArrowUp","w","W"].includes(KEY)) { nextIx = Math.max(0, activeIx-1); ev.preventDefault(); }
        else if (KEY === "Home") { nextIx = 0; ev.preventDefault(); }
        else if (KEY === "End") { nextIx = btnEls.length-1; ev.preventDefault(); }
        else if (KEY === "Enter" || KEY === " ") {
          ev.preventDefault();
          const btn = btnEls[Math.max(0, activeIx)];
          if (btn?.classList.contains("is-disabled")) {
            ui.notifications?.warn(btn.dataset.blockmsg || "Not enough resources.");
            return;
          }
          btn?.click();
          return;
        }
        else if (KEY === "Escape") { ev.preventDefault(); resolve(null); dlg.close(); return; }
        else return;

        if (nextIx !== activeIx) {
          const btn = btnEls[nextIx];
          $btns.removeClass("is-active");
          btn.classList.add("is-active");
          btn.focus({preventScroll:true});
          keepInView(wrapEl, btn);
          playMove();

          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip) { liveTip.remove(); liveTip = null; }
        }
      });

      Hooks.once("closeDialog", () => { if (liveTip) liveTip.remove(); });
    };

    Hooks.once("renderDialog", onRender);
    dlg.render(true);
  });

  if (!chosenUuid) return; // cancelled

  // ---------- handoff (same as Spell/Skill) ----------
  const attacker_uuid = useActor?.uuid || pickedToken?.document?.uuid || null;
  const targets = Array.from(game.user?.targets ?? []).map(t => t.document?.uuid).filter(Boolean);
  const payload = { attacker_uuid, targets, skillUuid: chosenUuid };

  const ADF = game.macros.getName(ACTION_DATA_FETCH_NAME);
  if (!ADF) return ui.notifications.error(`Macro "${ACTION_DATA_FETCH_NAME}" not found or no permission.`);
  await ADF.execute({ __AUTO: true, __PAYLOAD: payload });
})();
