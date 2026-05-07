/**
 * [CheckRoller] InvokeButtons — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Purpose:
 * - Adds click handlers for "Invoke Trait" and "Invoke Bond" on CheckRoller cards
 * - Uses Action-System-style dialogs for selection (UI look replicated)
 * - Spends Fabula Point from: actor.system.props.fabula_point
 * - Updates payload flag + re-renders the card in-place
 *
 * Notes:
 * - Writes flags using module scope: "fabula-ultima-companion" (valid active scope)
 * - Reads flags from MANAGER.CONST.FLAG_SCOPE first, then falls back to module scope
 */

(() => {
  const TAG = "[ONI][CheckRoller:InvokeButtons]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

  const { CONST } = MANAGER;

  // ---------------------------------------------------------------------------
  // Flag scopes (read fallback + write safe)
  // ---------------------------------------------------------------------------
  const MODULE_SCOPE = "fabula-ultima-companion";
  const READ_SCOPES = Array.from(new Set([CONST.FLAG_SCOPE, MODULE_SCOPE].filter(Boolean)));
  const WRITE_SCOPE = game.modules?.has(CONST.FLAG_SCOPE) ? CONST.FLAG_SCOPE : MODULE_SCOPE;

  // ---------------------------------------------------------------------------
  // Helpers (mirrors CreateCard expectations)
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };

  const esc = (s) => {
    const str = safeStr(s, "");
    return str
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  };

  const fmtSigned = (n) => {
    const v = safeInt(n, 0);
    return v >= 0 ? `+${v}` : `${v}`;
  };

  const sumParts = (parts) => {
    if (!Array.isArray(parts)) return 0;
    return parts.reduce((a, p) => a + safeInt(p?.value, 0), 0);
  };

  const deepClone = (obj) => foundry.utils.deepClone(obj);

  // ---------------------------------------------------------------------------
  // Payload get/set (read fallback)
  // ---------------------------------------------------------------------------
  const getPayload = (message) => {
    for (const scope of READ_SCOPES) {
      try {
        const p = message?.getFlag(scope, CONST.FLAG_KEY_CARD);
        if (p) return p;
      } catch (_) {}
    }
    return null;
  };

  const setPayload = async (message, payload) => {
    // Always write to a valid active scope to avoid Foundry error
    await message.setFlag(WRITE_SCOPE, CONST.FLAG_KEY_CARD, payload);
  };

  const isCheckRollerMessage = (message) => {
    const p = getPayload(message);
    return Boolean(p && p.kind === "fu_check");
  };

  const getMessageFromClick = (ev) => {
    const $btn = $(ev.currentTarget);
    const $card = $btn.closest(".oni-cr-card");
    const midFromCard = $card.attr("data-oni-cr-msgid");
    const midFromLi = $btn.closest("li.chat-message").attr("data-message-id");
    const msgId = midFromCard || midFromLi || "";
    return game.messages.get(msgId) || null;
  };

  // ---------------------------------------------------------------------------
  // Fabula Point spend (user-provided key)
  // ---------------------------------------------------------------------------
  const getFabulaPoint = (actor) => {
    return safeInt(actor?.system?.props?.fabula_point, 0);
  };

  const canPayFabula = (actor) => {
    const fp = getFabulaPoint(actor);
    return { ok: fp >= 1, fp };
  };

  const payFabula = async (actor) => {
    const fp = getFabulaPoint(actor);
    if (fp < 1) return { ok: false, fp };
    await actor.update({ "system.props.fabula_point": fp - 1 });
    return { ok: true, fp: fp - 1 };
  };

  // ---------------------------------------------------------------------------
  // Crit/Fumble for CheckRoller (rule default)
  // - Crit: doubles >= 6
  // - Fumble: double 1
  // ---------------------------------------------------------------------------
  const computeCritFumble = (rA, rB) => {
    const isFumble = (rA === 1 && rB === 1);
    const isCrit = (!isFumble && rA === rB && rA >= 6);
    return { isCrit, isFumble };
  };

    const isInvokeLockedByFumble = (payload = {}) => {
    return !!(
      payload?.result?.isFumble === true ||
      payload?.meta?.invokeLockedByFumble === true
    );
  };

  const blockInvokeIfFumble = (payload = {}, label = "Invoke") => {
    if (!isInvokeLockedByFumble(payload)) return false;

    ui.notifications?.warn(`${label} cannot be used on a Fumble.`);
    return true;
  };

  // ---------------------------------------------------------------------------
  // Card builder (copied pattern from CreateCard so message.update is consistent)
  // ---------------------------------------------------------------------------
  const buildCardHtml = (payload) => {
    const meta = payload?.meta || {};
    const check = payload?.check || {};
    const res = payload?.result || {};

    const rollerName = esc(meta.userName || "Unknown");
    const actorName = esc(meta.actorName || "Unknown");
    const typeLabel = esc(check.type || "Attribute");

    const attrs = Array.isArray(check.attrs) ? check.attrs : [];
    const attrA = esc(attrs[0] || "?");
    const attrB = esc(attrs[1] || "?");

    const dieA = safeInt(check?.dice?.A, 0);
    const dieB = safeInt(check?.dice?.B, 0);

    const rollA = safeInt(res.rollA, 0);
    const rollB = safeInt(res.rollB, 0);
    const hr = safeInt(res.hr, Math.max(rollA, rollB));
    const base = safeInt(res.base, rollA + rollB);

    const parts = check?.modifier?.parts || [];
    const modPartsTotal = sumParts(parts);
    const modTotal = Number.isFinite(Number(res.modifierTotal))
      ? safeInt(res.modifierTotal, modPartsTotal)
      : modPartsTotal;

    const total = Number.isFinite(Number(res.total))
      ? safeInt(res.total, base + modTotal)
      : (base + modTotal);

    const isCrit = Boolean(res.isCrit);
    const isFumble = Boolean(res.isFumble);

    const hasDL = Number.isFinite(Number(check.dl));
    const dlVal = safeInt(check.dl, 0);
    const dlVisibility = safeStr(meta.dlVisibility, "hidden");
    const dlShown = (dlVisibility === "shown");
    const pass = (res.pass === true);
    const fail = (res.pass === false);

    let badgeHtml = "";
    if (isFumble) badgeHtml = `<span class="oni-cr-badge oni-cr-badge-fumble">FUMBLE</span>`;
    else if (isCrit) badgeHtml = `<span class="oni-cr-badge oni-cr-badge-crit">CRITICAL</span>`;

    let dlHtml = "";
    if (hasDL && dlShown) {
      const verdict = pass ? "PASS" : (fail ? "FAIL" : "—");
      const verdictClass = pass ? "oni-cr-verdict-pass" : (fail ? "oni-cr-verdict-fail" : "");
      dlHtml = `
        <div class="oni-cr-row">
          <div class="oni-cr-k">DL</div>
          <div class="oni-cr-v">${dlVal} <span class="oni-cr-verdict ${verdictClass}">${verdict}</span></div>
        </div>
      `;
    } else if (hasDL && !dlShown) {
      dlHtml = `
        <div class="oni-cr-row">
          <div class="oni-cr-k">DL</div>
          <div class="oni-cr-v"><span style="opacity:0.75;">(hidden)</span> <span style="opacity:0.6;">Recorded: ${dlVal}</span></div>
        </div>
      `;
    }

    const modLines = parts
      .filter(p => (safeStr(p?.label, "").trim().length || safeInt(p?.value, 0) !== 0))
      .map(p => {
        const label = esc(safeStr(p.label, "Modifier"));
        const val = safeInt(p.value, 0);
        return `<div class="oni-cr-modline"><span class="oni-cr-modlabel">${label}</span><span class="oni-cr-modval">${fmtSigned(val)}</span></div>`;
      })
      .join("");

    const modBlock = modLines
      ? `<div class="oni-cr-modblock">${modLines}</div>`
      : `<div class="oni-cr-modblock" style="opacity:0.65;">(no modifiers)</div>`;

    // invoke area (CardHydrate shows/hides + disables)
    // Fumble lock mirrors the main CreateCard renderer.
    const locked = isFumble;
    meta.invokeLockedByFumble = locked;

    const lockedAttrs = locked
      ? `data-oni-cr-invoke-locked="fumble" aria-disabled="true"`
      : `data-oni-cr-invoke-locked="0" aria-disabled="false"`;

    const overlay = locked
      ? `<span class="oni-cr-lock-overlay" aria-hidden="true"><i class="fa-solid fa-lock"></i></span>`
      : "";

    const invokeArea = `
      <div class="oni-cr-invoke" style="display:none;">
        <button type="button"
                class="oni-cr-btn ${locked ? "oni-cr-btn-locked" : ""}"
                data-oni-cr-trait
                ${lockedAttrs}
                title="${locked ? "Locked: Invoke Trait cannot be used on a Fumble." : "Invoke Trait"}">
          <span class="oni-cr-btn-label">🎭 Invoke Trait</span>
          ${overlay}
        </button>

        <button type="button"
                class="oni-cr-btn ${locked ? "oni-cr-btn-locked" : ""}"
                data-oni-cr-bond
                ${lockedAttrs}
                title="${locked ? "Locked: Invoke Bond cannot be used on a Fumble." : "Invoke Bond"}">
          <span class="oni-cr-btn-label">🤝 Invoke Bond</span>
          ${overlay}
        </button>
      </div>
    `;

    return `
      <div class="oni-cr-card">
        <div class="oni-cr-header">
          <div class="oni-cr-title">
            <span class="oni-cr-title-main">Check Roll</span>
            <span class="oni-cr-title-sub">(${typeLabel})</span>
          </div>
          ${badgeHtml}
        </div>

        <div class="oni-cr-meta">
          <div><b>Roller:</b> ${rollerName}</div>
          <div><b>Actor:</b> ${actorName}</div>
        </div>

        <div class="oni-cr-body">
          <div class="oni-cr-row">
            <div class="oni-cr-k">Formula</div>
            <div class="oni-cr-v">${attrA} + ${attrB}</div>
          </div>
          <div class="oni-cr-row">
            <div class="oni-cr-k">Dice</div>
            <div class="oni-cr-v">d${dieA} + d${dieB}</div>
          </div>
          <div class="oni-cr-row">
            <div class="oni-cr-k">Rolls</div>
            <div class="oni-cr-v">${rollA}, ${rollB} <span class="oni-cr-hr">(HR ${hr})</span></div>
          </div>
          <div class="oni-cr-row">
            <div class="oni-cr-k">Base</div>
            <div class="oni-cr-v">${base}</div>
          </div>
          <div class="oni-cr-row">
            <div class="oni-cr-k">Modifiers</div>
            <div class="oni-cr-v">${fmtSigned(modTotal)}</div>
          </div>
          <div class="oni-cr-row oni-cr-total">
            <div class="oni-cr-k">Total</div>
            <div class="oni-cr-v">${total}</div>
          </div>

          ${dlHtml}

          <div class="oni-cr-modtitle">Modifier Breakdown</div>
          ${modBlock}

          ${invokeArea}
        </div>
      </div>
    `;
  };

    // ---------------------------------------------------------------------------
  // Update card using the SAME renderer as CreateCard
  // - Manager.updateMessage -> CreateCard's updateMessage adapter -> buildCardHtml (new UI)
  // - Fallback: local buildCardHtml (older UI) if CreateCard isn't installed on this client
  // ---------------------------------------------------------------------------
  const updateCard = async (message, payload) => {
    if (typeof MANAGER.updateMessage === "function") {
      return await MANAGER.updateMessage(message, { payload });
    }
    return await message.update({ content: buildCardHtml(payload) });
  };


  // ---------------------------------------------------------------------------
  // Action-System-style "Invoke Trait — Reroll" dialog (UI copied)
  // ---------------------------------------------------------------------------
  const ATTR_ICONS = {
    DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
    MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
    INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
    WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png"
  };
  const FALLBACK_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/dice.png";
  const iconFor = (attr) => ATTR_ICONS[(attr || "").toUpperCase()] ?? FALLBACK_ICON;

const promptTraitReroll = async ({ attrA, attrB, dieA, dieB, rollA, rollB }) => {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const htmlA = `
      <div class="oni-trait-left">
        <img class="oni-trait-icon" src="${iconFor(attrA)}">
        <div class="oni-trait-die">d${dieA}</div>
      </div>
      <div class="oni-trait-spacer"></div>
      <div class="oni-trait-result">${rollA}</div>
    `;

    const htmlB = `
      <div class="oni-trait-left">
        <img class="oni-trait-icon" src="${iconFor(attrB)}">
        <div class="oni-trait-die">d${dieB}</div>
      </div>
      <div class="oni-trait-spacer"></div>
      <div class="oni-trait-result">${rollB}</div>
    `;

    new Dialog({
      title: "Invoke Trait — Reroll",
      content: `<form class="oni-trait-wrap">
<style>
  /* IMPORTANT: namespaced like Invoke Bond so it NEVER touches the chat card */
  .oni-trait-wrap{
    --parch-1:#f6ebd3;
    --parch-2:#efdfc3;
    --parch-3:#e8d3b1;
    --ink:#3b2a19;
    --shadow:rgba(0,0,0,.22);
    --accent:#e35151;
  }

  .oni-trait-title{font-weight:700;margin:.25rem 0 .35rem;color:var(--ink);}
  .oni-trait-grid{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
    gap:.6rem;
    margin:.2rem 0 .6rem;
  }

  .oni-trait-card{
    position:relative;
    display:flex;
    align-items:center;
    gap:.6rem;
    padding:.6rem .75rem;
    border-radius:12px;
    cursor:pointer;
    user-select:none;
    color:var(--ink);
    border:3px solid rgba(87,58,33,.95);
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%, rgba(255,255,255,.15) 22%, transparent 40%),
      linear-gradient(180deg, var(--parch-1) 0%, var(--parch-2) 55%, var(--parch-3) 100%);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.55),
      inset 0 0 0 2px rgba(255,255,255,.06),
      0 6px 14px var(--shadow);
    transition: filter .12s ease, box-shadow .12s ease, transform .12s ease;
  }

  .oni-trait-card:hover{ filter:brightness(1.02); transform:translateY(-1px); }
  .oni-trait-card.on{
    outline:3px solid var(--accent);
    box-shadow:
      0 0 0 2px rgba(227,81,81,.45),
      0 10px 22px rgba(0,0,0,.25);
  }

  .oni-trait-left{display:flex;align-items:center;gap:.55rem;}
  .oni-trait-icon{
    width:34px;height:34px;object-fit:contain;
    filter:drop-shadow(0 1px 0 rgba(255,255,255,.35));
    border:none !important; outline:none !important; box-shadow:none !important;
    background:transparent !important; border-radius:0 !important;
  }
  .oni-trait-die{font-weight:800;letter-spacing:.02em;}
  .oni-trait-result{
    font-size:1.4rem;
    font-weight:900;
    min-width:2ch;
    text-align:right;
  }
  .oni-trait-spacer{flex:1;}
  .oni-trait-hint{opacity:.8;font-size:.85rem;margin:.2rem 0 0;}
</style>

<div class="oni-trait-title">Choose which die to reroll</div>

<div class="oni-trait-grid">
  <div class="oni-trait-card" data-which="A" data-sel="0" role="button" tabindex="0">
    ${htmlA}
  </div>

  <div class="oni-trait-card" data-which="B" data-sel="0" role="button" tabindex="0">
    ${htmlB}
  </div>
</div>

<div class="oni-trait-hint">Click one or both to select. Click again to unselect.</div>
</form>`,

      buttons: {
        ok: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Reroll",
          callback: (html) => {
            const root = html[0];
            const btnA = root.querySelector('[data-which="A"]');
            const btnB = root.querySelector('[data-which="B"]');

            const selA = btnA?.dataset.sel === "1";
            const selB = btnB?.dataset.sel === "1";

            if (selA && selB) return finish("AB");
            if (selA) return finish("A");
            if (selB) return finish("B");
            return finish(null);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => finish(null)
        }
      },

      default: "cancel",

      close: () => finish(null),

      render: (html) => {
        const root = html[0];
        const btnA = root.querySelector('[data-which="A"]');
        const btnB = root.querySelector('[data-which="B"]');
        const okBtn = root.closest(".app")?.querySelector('.dialog-buttons button[data-button="ok"]');

        const refreshOk = () => {
          const anySel = (btnA?.dataset.sel === "1") || (btnB?.dataset.sel === "1");
          if (okBtn) okBtn.disabled = !anySel;
        };

        const toggle = (btn) => {
          btn.dataset.sel = (btn.dataset.sel === "1") ? "0" : "1";
          btn.classList.toggle("on", btn.dataset.sel === "1");
          refreshOk();
        };

        [btnA, btnB].forEach((b) => {
          b.addEventListener("click", (ev) => { ev.preventDefault(); toggle(b); });
          b.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
              (b === btnA ? btnB : btnA)?.focus();
            }
            if (ev.key === " " || ev.key === "Enter") {
              ev.preventDefault();
              toggle(b);
            }
          });
        });

        refreshOk();
      }
    }).render(true);
  });
};

  // ---------------------------------------------------------------------------
  // Action-System-style bond chooser (same bond extraction approach)
  // Returns: { name, bonus } or null
  // ---------------------------------------------------------------------------
  const collectBondsFromActor = (actor) => {
  const P = actor?.system?.props ?? {};
  const norm = (s) => String(s ?? "").trim().toLowerCase();

  // Same emotion polarity mapping your Action System uses
  const POS = new Set(["admiration", "loyalty", "affection"]);
  const NEG = new Set(["inferiority", "mistrust", "hatred"]);

  const bonds = [];
  for (let i = 1; i <= 6; i++) {
    const name = String(P[`bond_${i}`] ?? "").trim();
    if (!name) continue;

    const e1 = norm(P[`emotion_${i}_1`]);
    const e2 = norm(P[`emotion_${i}_2`]);
    const e3 = norm(P[`emotion_${i}_3`]);

    const emotions = [e1, e2, e3].filter(Boolean);

    let filledPos = 0;
    let filledNeg = 0;

    for (const e of emotions) {
      if (POS.has(e)) filledPos++;
      else if (NEG.has(e)) filledNeg++;
    }

    const filled = Math.min(3, emotions.length);
    const bonus = Math.min(3, Math.max(0, filled)); // +1 per filled emotion (max +3)

    bonds.push({
      idx: i,
      name,
      bonus,
      filled,
      filledPos,
      filledNeg,
      emotions
    });
  }

  return bonds;
};

  const promptBondChoice = async (actor) => {
    const list = collectBondsFromActor(actor);
    if (!list.length) {
      ui.notifications?.warn("No Bonds found on actor.");
      return null;
    }

    // Minimal UI clone of the Action System look: list rows + hearts + right bonus
    // (We keep it simple but visually matches: parchment list + +X on the right)
    const HEART_POS = "❤";
    const HEART_NEG = "💜";

    const rowHtml = (b) => {
      const pos = HEART_POS.repeat(b.filledPos);
      const neg = HEART_NEG.repeat(b.filledNeg);
      const hearts = `${pos}${neg}`;
      return `
        <div class="oni-bond-row" tabindex="0" data-bond-idx="${b.idx}" data-sel="0">
          <div class="oni-bond-name">${esc(b.name)}</div>
          <div class="oni-bond-hearts">${hearts}</div>
          <div class="oni-bond-bonus">+${safeInt(b.bonus, 0)}</div>
        </div>
      `;
    };

    return await new Promise((resolve) => new Dialog({
      title: "Invoke Bond — Choose a Bond",
      content: `<form>
        <style>
          .oni-bond-wrap{ --parch-1:#f6ebd3; --parch-2:#efdfc3; --parch-3:#e7d3b1; --ink:#3b2a19; --shadow:rgba(0,0,0,22); --accent:#e35151; }
          .oni-bond-legend{display:flex;gap:14px;align-items:center;margin:.15rem 0 .35rem;opacity:.9;}
          .oni-bond-legend span{display:inline-flex;gap:6px;align-items:center;}
          .oni-bond-list{display:flex;flex-direction:column;gap:.45rem;margin:.2rem 0 .6rem;}
          .oni-bond-row{
            display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;
            padding:.55rem .7rem;border-radius:12px;cursor:pointer;user-select:none;
            color:var(--ink);border:3px solid rgba(87,58,33,95);
            background:
              radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,45) 0%, rgba(255,255,255,15) 22%, transparent 40%),
              linear-gradient(180deg, var(--parch-1) 0%, var(--parch-2) 55%, var(--parch-3) 100%);
            box-shadow:
              inset 0 1px 0 rgba(255,255,255,55),
              inset 0 0 0 2px rgba(255,255,255,06),
              0 6px 14px var(--shadow);
            transition: filter .12s ease, box-shadow .12s ease, transform .12s ease;
          }
          .oni-bond-row:hover{ filter:brightness(1.02); transform:translateY(-1px); }
          .oni-bond-row.on{ outline:3px solid var(--accent); box-shadow: 0 0 0 2px rgba(227,81,81,.45), 0 10px 22px rgba(0,0,0,.25); }
          .oni-bond-name{font-weight:800;}
          .oni-bond-hearts{opacity:.95; letter-spacing:2px;}
          .oni-bond-bonus{font-weight:900;min-width:3ch;text-align:right;}
          .oni-bond-foot{opacity:.75;font-size:.82rem;display:flex;justify-content:space-between;}
        </style>

        <div class="oni-bond-wrap">
          <div class="oni-bond-legend">
            <span>${HEART_POS} <b>positive</b></span>
            <span>${HEART_NEG} <b>negative</b></span>
          </div>

          <div class="oni-bond-list">
            ${list.map(rowHtml).join("")}
          </div>

          <div class="oni-bond-foot">
            <span>Bond bonus is +1 per filled emotion (max +3).</span>
            <span>Loaded from actor</span>
          </div>
        </div>
      </form>`,
      buttons: {
        ok: {
          label: "Invoke",
          callback: (html) => {
            const root = html[0];
            const on = root.querySelector(".oni-bond-row.on");
            if (!on) return resolve(null);
            const idx = safeInt(on.dataset.bondIdx, 0);
            const bond = list.find(b => b.idx === idx) || null;
            return resolve(bond ? { name: bond.name, bonus: bond.bonus } : null);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null),
      render: (html) => {
        const root = html[0];
        const rows = Array.from(root.querySelectorAll(".oni-bond-row"));

        const setOne = (row) => {
          rows.forEach(r => r.classList.remove("on"));
          row.classList.add("on");
        };

        rows.forEach(r => {
          r.addEventListener("click", (ev) => { ev.preventDefault(); setOne(r); });
          r.addEventListener("keydown", (ev) => {
            if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); setOne(r); }
          });
        });
      }
    }).render(true));
  };

  // ---------------------------------------------------------------------------
  // Apply invoke: Trait
  // ---------------------------------------------------------------------------
    const applyInvokeTrait = async (message) => {
    const payload = getPayload(message);
    if (!payload) return;

    if (blockInvokeIfFumble(payload, "Invoke Trait")) return;

    payload.meta = payload.meta || {};
    payload.meta.invoked = payload.meta.invoked || { trait: false, bond: false };

    if (payload.meta.invoked.trait) {
      ui.notifications?.warn("Invoke Trait already used for this check.");
      return;
    }

    const actorUuid = safeStr(payload?.meta?.actorUuid, "");
    const actor = actorUuid ? await fromUuid(actorUuid) : null;
    if (!actor) return ui.notifications?.warn("Actor not found for this check.");

    const chk = canPayFabula(actor);
    if (!chk.ok) {
      ui.notifications?.warn("Not enough Fabula Points (need 1).");
      return;
    }

    const check = payload.check || {};
    const res = payload.result || {};
    const attrs = Array.isArray(check.attrs) ? check.attrs : ["?", "?"];

    const choice = await promptTraitReroll({
      attrA: attrs[0] || "?",
      attrB: attrs[1] || "?",
      dieA: safeInt(check?.dice?.A, 0),
      dieB: safeInt(check?.dice?.B, 0),
      rollA: safeInt(res.rollA, 0),
      rollB: safeInt(res.rollB, 0)
    });

    if (!choice) {
      ui.notifications?.info("Trait invoke cancelled.");
      return;
    }

    // Spend 1 FP only after confirm (same pattern as Action System)
    const spend = await payFabula(actor);
    if (!spend.ok) {
      ui.notifications?.error("Could not spend 1 Fabula Point.");
      return;
    }

    const dieA = safeInt(check?.dice?.A, 0);
    const dieB = safeInt(check?.dice?.B, 0);

    const oldA = safeInt(res.rollA, 0);
    const oldB = safeInt(res.rollB, 0);

    const newA = (choice === "A" || choice === "AB")
  ? (await (new Roll(`1d${dieA}`)).evaluate()).total
  : oldA;

const newB = (choice === "B" || choice === "AB")
  ? (await (new Roll(`1d${dieB}`)).evaluate()).total
  : oldB;

    const next = deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait: false, bond: false };
    next.meta.invoked.trait = true;

    next.result = next.result || {};
    next.result.rollA = newA;
    next.result.rollB = newB;
    next.result.hr = Math.max(newA, newB);
    next.result.base = newA + newB;

    // Mod totals are derived from check.modifier.parts; keep res.modifierTotal aligned
    const parts = next?.check?.modifier?.parts || [];
    const modTotal = sumParts(parts);
    next.result.modifierTotal = modTotal;
    next.result.total = next.result.base + modTotal;

    const cf = computeCritFumble(newA, newB);
    next.result.isCrit = cf.isCrit;
    next.result.isFumble = cf.isFumble;

    // (Optional) clear pass/fail if DL exists; you can recompute later
    // next.result.pass = null;

        await setPayload(message, next);
    await updateCard(message, next);

    console.log(`${TAG} Applied`, { msgId: message.id, which: "trait", newTotal: next.result.total, rolls: [newA, newB] });
  };

  // ---------------------------------------------------------------------------
  // Apply invoke: Bond
  // ---------------------------------------------------------------------------
  const applyInvokeBond = async (message) => {
    const payload = getPayload(message);
    if (!payload) return;

    if (blockInvokeIfFumble(payload, "Invoke Bond")) return;

    payload.meta = payload.meta || {};
    payload.meta.invoked = payload.meta.invoked || { trait: false, bond: false };

    if (payload.meta.invoked.bond) {
      ui.notifications?.warn("Invoke Bond already used for this check.");
      return;
    }

    const actorUuid = safeStr(payload?.meta?.actorUuid, "");
    const actor = actorUuid ? await fromUuid(actorUuid) : null;
    if (!actor) return ui.notifications?.warn("Actor not found for this check.");

    const chk = canPayFabula(actor);
    if (!chk.ok) {
      ui.notifications?.warn("Not enough Fabula Points (need 1).");
      return;
    }

    const pick = await promptBondChoice(actor);
    if (!pick) {
      ui.notifications?.info("Bond invoke cancelled.");
      return;
    }

    // Spend 1 FP only after confirm
    const spend = await payFabula(actor);
    if (!spend.ok) {
      ui.notifications?.error("Could not spend 1 Fabula Point.");
      return;
    }

    const bonus = safeInt(pick.bonus, 0);

    const next = deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait: false, bond: false };
    next.meta.invoked.bond = true;
    next.meta.invokedBond = { name: safeStr(pick.name, "Bond"), bonus };

    next.check = next.check || {};
    next.check.modifier = next.check.modifier || {};
    next.check.modifier.parts = Array.isArray(next.check.modifier.parts) ? next.check.modifier.parts : [];

    // Add a visible modifier line (so CreateCard can show breakdown)
    next.check.modifier.parts.push({ label: `Invoke Bond: ${safeStr(pick.name, "Bond")}`, value: bonus });

    next.result = next.result || {};
    const rollA = safeInt(next.result.rollA, 0);
    const rollB = safeInt(next.result.rollB, 0);
    next.result.base = safeInt(next.result.base, rollA + rollB);

    const modTotal = sumParts(next.check.modifier.parts);
    next.result.modifierTotal = modTotal;
    next.result.total = next.result.base + modTotal;

        await setPayload(message, next);
    await updateCard(message, next);

    console.log(`${TAG} Applied`, { msgId: message.id, which: "bond", bonus, newTotal: next.result.total });
  };

  // ---------------------------------------------------------------------------
  // Install click handlers (idempotent)
  // ---------------------------------------------------------------------------
  if (globalThis.ONI.__CheckRollerInvokeButtonsHookInstalled) {
    console.log(`${TAG} Hook already installed. (Re-run ignored)`);
    ui?.notifications?.info("Check Roller InvokeButtons already installed.");
    return;
  }

  const clickTrait = async (ev) => {
    try {
      ev.preventDefault();

      const btn = ev.currentTarget;
      if (btn?.dataset?.oniCrInvokeLocked === "fumble") {
        ui.notifications?.warn("Invoke Trait cannot be used on a Fumble.");
        return;
      }

      const msg = getMessageFromClick(ev);
      if (!msg || !isCheckRollerMessage(msg)) return;
      await applyInvokeTrait(msg);
    } catch (e) {
      console.warn(`${TAG} Trait invoke error`, e);
    }
  };

  const clickBond = async (ev) => {
    try {
      ev.preventDefault();

      const btn = ev.currentTarget;
      if (btn?.dataset?.oniCrInvokeLocked === "fumble") {
        ui.notifications?.warn("Invoke Bond cannot be used on a Fumble.");
        return;
      }

      const msg = getMessageFromClick(ev);
      if (!msg || !isCheckRollerMessage(msg)) return;
      await applyInvokeBond(msg);
    } catch (e) {
      console.warn(`${TAG} Bond invoke error`, e);
    }
  };

  // Delegated handlers (survives re-render)
  $(document).on("click.oni-cr-invoke", "[data-oni-cr-trait]", clickTrait);
  $(document).on("click.oni-cr-invoke", "[data-oni-cr-bond]", clickBond);

  globalThis.ONI.__CheckRollerInvokeButtonsHookInstalled = true;
  console.log(`${TAG} Installed (delegated click handlers).`, { READ_SCOPES, WRITE_SCOPE });
})();
