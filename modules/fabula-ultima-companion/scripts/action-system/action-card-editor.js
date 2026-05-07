// scripts/ActionCardEditor.js — Foundry VTT v12
// GM-only pencil button on FU Action Cards that opens an editor dialog.
// - Reads the full payload from the chat message flag (fabula-ultima-companion.actionCard.payload)
// - Lets GM edit the same fields the card displays (title/subtitle/accuracy/damage/effect/targets)
// - Rebuilds the card by calling your CreateActionCard macro (headless: __AUTO / __PAYLOAD)
// - Preserves the message's original target UUIDs unless GM changes them

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const FLAG_KEY  = "actionCard";
  const CREATE_CARD_MACRO_NAME = "CreateActionCard";

  const TAG = "[ONI][ActionCardEditor]";
  const DEBUG = false;
  const dbg = (...a) => { if (DEBUG) console.log(TAG, ...a); };

  // ---------------------------
  // Small helpers
  // ---------------------------
  const esc = (s) => {
    const str = String(s ?? "");
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const deepClone = (obj) => {
    try { return foundry.utils.deepClone(obj); }
    catch { return JSON.parse(JSON.stringify(obj ?? {})); }
  };

  const toNum = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  function getMessageIdFromEvent(ev) {
    const msgEl = ev.target.closest?.(".chat-message, .message");
    return msgEl?.dataset?.messageId || msgEl?.dataset?.messageid || null;
  }

  function extractAttrFromContent(html, attrName) {
    if (!html) return null;
    const re = new RegExp(`${attrName}="([^"]*)"`, "i");
    const m = String(html).match(re);
    return m?.[1] ?? null;
  }

  function extractOriginalTargets(chatMsg, flaggedPayload) {
    // 1) preferred: payload.originalTargetUUIDs
    const p = flaggedPayload ?? {};
    if (Array.isArray(p.originalTargetUUIDs) && p.originalTargetUUIDs.length) return p.originalTargetUUIDs;
    if (Array.isArray(p.meta?.originalTargetUUIDs) && p.meta.originalTargetUUIDs.length) return p.meta.originalTargetUUIDs;

    // 2) fallback: data-original-targets attribute (encoded JSON)
    try {
      const raw = extractAttrFromContent(chatMsg?.content, "data-original-targets");
      if (!raw) return [];
      const decoded = decodeURIComponent(raw);
      const arr = JSON.parse(decoded);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function normalizeElementType(s) {
    const v = String(s ?? "").trim();
    return v ? v.toLowerCase() : "physical";
  }

  function normalizeTargetList(text) {
    const lines = String(text ?? "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    // de-dupe
    return Array.from(new Set(lines));
  }

  // ---------------------------
  // Target picker (scene tokens)
  // ---------------------------
  function safeHpPropsFromToken(token) {
    const props = token?.actor?.system?.props;
    if (!props) return null;
    const max = props?.max_hp;
    if (max === null || typeof max === "undefined") return null;
    const cur = props?.current_hp;
    return { cur, max };
  }

  function buildViableTargetLists(originalTargets = []) {
    const sel = new Set(Array.isArray(originalTargets) ? originalTargets.filter(Boolean) : []);

    const buckets = {
      hostile: [],
      neutral: [],
      friendly: [],
      other: []
    };

    const tokens = canvas?.tokens?.placeables ?? [];
    for (const t of tokens) {
      const hp = safeHpPropsFromToken(t);
      if (!hp) continue; // must have max_hp per your rule

      const disp = Number(t?.document?.disposition ?? 0);
      const uuid = t?.document?.uuid;
      if (!uuid) continue;

      const entry = {
        uuid,
        tokenId: t?.id,
        name: t?.name ?? "(Unnamed)",
        disp,
        cur: hp.cur,
        max: hp.max,
        selected: sel.has(uuid)
      };

      if (disp === -1) buckets.hostile.push(entry);
      else if (disp === 0) buckets.neutral.push(entry);
      else if (disp === 1) buckets.friendly.push(entry);
      else buckets.other.push(entry);
    }

    const byName = (a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
    buckets.hostile.sort(byName);
    buckets.neutral.sort(byName);
    buckets.friendly.sort(byName);
    buckets.other.sort(byName);

    // row sizing hint (like Study macro)
    const total = buckets.hostile.length + buckets.neutral.length + buckets.friendly.length + buckets.other.length;
    const rows = Math.min(10, Math.max(4, total));

    return { buckets, rows };
  }

  function buildTargetSelectOptions(entries = []) {
    return entries.map(e => {
      const cur = (typeof e.cur === "number") ? e.cur : (Number.isFinite(Number(e.cur)) ? Number(e.cur) : null);
      const max = (typeof e.max === "number") ? e.max : (Number.isFinite(Number(e.max)) ? Number(e.max) : null);
      const hpTxt = (cur !== null && max !== null) ? ` (HP ${cur}/${max})` : "";
      return `<option value="${esc(e.uuid)}" ${e.selected ? "selected" : ""}>${esc(e.name)}${hpTxt}</option>`;
    }).join("");
  }

    function getSelectedTargetsFromPickers(root) {
    if (!root) return [];

    const picked = [];
    const pickNames = ["targetsHostile", "targetsNeutral", "targetsFriendly", "targetsOther"];

    for (const nm of pickNames) {
      const sel = root.querySelector(`select[name="${nm}"]`);
      if (!sel) continue;

      for (const opt of Array.from(sel.selectedOptions ?? [])) {
        const v = String(opt?.value ?? "").trim();
        if (v) picked.push(v);
      }
    }

    return Array.from(new Set(picked));
  }

  function setSelectedTargetsOnPickers(root, targets = []) {
    if (!root) return;

    const wanted = new Set(
      (Array.isArray(targets) ? targets : [])
        .filter(Boolean)
        .map(v => String(v).trim())
    );

    root.querySelectorAll?.("select.fu-ace-target option")?.forEach?.((opt) => {
      const v = String(opt?.value ?? "").trim();
      opt.selected = !!v && wanted.has(v);
    });
  }

  function setTargetsTextarea(root, targets = []) {
    if (!root) return;
    const ta = root.querySelector('textarea[name="targetsText"]');
    if (!ta) return;
    ta.value = (Array.isArray(targets) ? targets : []).join("\n");
  }

  // ---------------------------
  // Dialog builder
  // ---------------------------
  function buildDialogHTML(payload, originalTargets, targetData) {
    const core = payload?.core ?? {};
    const meta = payload?.meta ?? {};
    const acc  = payload?.accuracy ?? null;
    const adv  = payload?.advPayload ?? {};

    const title = core.skillName ?? core.displayTitle ?? meta.skillName ?? "(Action)";
    const listType = meta.listType ?? core.listType ?? "";
    const attackRange = meta.attackRange ?? "";
    const elementType = meta.elementType ?? adv.elementType ?? "physical";

    // Damage preview number shown on card (best-effort)
    const dmgShown = (() => {
      const raw = meta.baseValueStrForCard ?? core.baseValueStrForCard ?? "";
      const n = Number(String(raw).replace(/[^0-9.+-]/g, ""));
      if (Number.isFinite(n) && n !== 0) return n;
      const base = adv.baseValue;
      const nb = Number(String(base).replace(/[^0-9.+-]/g, ""));
      return Number.isFinite(nb) ? Math.abs(nb) : 0;
    })();

    const declaresHealing = !!meta.declaresHealing;
    const ignoreHR = !!meta.ignoreHR;
    const costRaw = meta.costRaw ?? "";

    const targetsText = (originalTargets ?? []).join("\n");

    const hasAcc = !!acc;
    const A1 = acc?.A1 ?? "";
    const A2 = acc?.A2 ?? "";
    const dA = toNum(acc?.dA, 0);
    const dB = toNum(acc?.dB, 0);
    const rA = toNum(acc?.rA?.total ?? acc?.rA, 0);
    const rB = toNum(acc?.rB?.total ?? acc?.rB, 0);
    const checkBonus = toNum(acc?.checkBonus, 0);
    const hr = toNum(acc?.hr, 0);
    const isCrit = !!acc?.isCrit;
    const isFumble = !!acc?.isFumble;

    const effectHTML = core.rawEffectHTML ?? core.effectHTML ?? meta.rawEffectHTML ?? "";

    const rows = Number(targetData?.rows ?? 6);
    const buckets = targetData?.buckets ?? { hostile: [], neutral: [], friendly: [], other: [] };

    const hostileOptions  = buildTargetSelectOptions(buckets.hostile);
    const neutralOptions  = buildTargetSelectOptions(buckets.neutral);
    const friendlyOptions = buildTargetSelectOptions(buckets.friendly);
    const otherOptions    = buildTargetSelectOptions(buckets.other);

    const hasAnyViable =
      (buckets.hostile.length + buckets.neutral.length + buckets.friendly.length + buckets.other.length) > 0;

    return `
    <form class="fu-ace" style="font-family: Signika, sans-serif;">

      <fieldset style="border:1px solid #cfa057; border-radius:10px; padding:.6rem; margin:0 0 .6rem 0; background:#f7ecd9;">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>Header</b></legend>

        <div style="display:grid; grid-template-columns:140px 1fr; gap:.35rem .6rem; align-items:center;">
          <label><b>Action Name</b></label>
          <input type="text" name="skillName" value="${esc(title)}" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>List Type</b></label>
          <input type="text" name="listType" value="${esc(listType)}" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Attack Range</b></label>
          <input type="text" name="attackRange" value="${esc(attackRange)}" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Element Type</b></label>
          <input type="text" name="elementType" value="${esc(elementType)}" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Cost</b></label>
          <input type="text" name="costRaw" value="${esc(costRaw)}" placeholder="-" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Healing?</b></label>
          <label style="display:flex; gap:.5rem; align-items:center;">
            <input type="checkbox" name="declaresHealing" ${declaresHealing ? "checked" : ""} />
            <span style="opacity:.85;">Treat preview as healing</span>
          </label>

          <label><b>Ignore HR?</b></label>
          <label style="display:flex; gap:.5rem; align-items:center;">
            <input type="checkbox" name="ignoreHR" ${ignoreHR ? "checked" : ""} />
            <span style="opacity:.85;">Do not add HR bonus</span>
          </label>
        </div>
      </fieldset>

      <fieldset style="border:1px solid #cfa057; border-radius:10px; padding:.6rem; margin:0 0 .6rem 0; background:#f7ecd9;">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>Targets</b></legend>

        <div style="opacity:.85; font-size:12px; margin-bottom:.35rem;">
          Pick targets from the current scene (GM-friendly). This is what “Apply” will use.
        </div>

        ${hasAnyViable ? `
          <div class="fu-ace-target-grid" style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:.5rem;">

            <div>
              <div style="font-weight:800; color:tomato; margin:0 0 .2rem 0;">Hostile</div>
              <select class="fu-ace-target" name="targetsHostile" multiple size="${rows}"
                      style="width:100%; font-size:14px; padding:6px; border-radius:8px; border:1px solid #cfa057;">
                ${hostileOptions || ""}
              </select>
            </div>

            <div>
              <div style="font-weight:800; color:khaki; margin:0 0 .2rem 0;">Neutral</div>
              <select class="fu-ace-target" name="targetsNeutral" multiple size="${rows}"
                      style="width:100%; font-size:14px; padding:6px; border-radius:8px; border:1px solid #cfa057;">
                ${neutralOptions || ""}
              </select>
            </div>

            <div>
              <div style="font-weight:800; color:dodgerblue; margin:0 0 .2rem 0;">Friendly</div>
              <select class="fu-ace-target" name="targetsFriendly" multiple size="${rows}"
                      style="width:100%; font-size:14px; padding:6px; border-radius:8px; border:1px solid #cfa057;">
                ${friendlyOptions || ""}
              </select>
            </div>

          </div>

          ${otherOptions ? `
            <div style="margin-top:.5rem;">
              <div style="font-weight:800; opacity:.8; margin:0 0 .2rem 0;">Other Disposition</div>
              <select class="fu-ace-target" name="targetsOther" multiple size="${Math.min(6, rows)}"
                      style="width:100%; font-size:14px; padding:6px; border-radius:8px; border:1px solid #cfa057;">
                ${otherOptions}
              </select>
            </div>
          ` : ""}

          <div style="opacity:.75; font-size:12px; margin-top:.35rem;">
            Tip: hold <b>Ctrl</b> / <b>Cmd</b> to select multiple targets.
          </div>
        ` : `
          <div style="opacity:.8; font-size:12px; margin:.25rem 0 .35rem 0;">
            No viable tokens found (needs <code>token.actor.system.props.max_hp</code> on the current scene).
            Use the Advanced UUID list below.
          </div>
        `}

        <details style="margin-top:.5rem;">
          <summary style="cursor:pointer; font-weight:800;">Advanced: UUID list override</summary>
          <div style="opacity:.8; font-size:12px; margin:.35rem 0;">
            One UUID per line. This field live-syncs with the pickers above, but you can still type here manually for advanced overrides.
          </div>
          <textarea name="targetsText" rows="4" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057; resize:vertical;">${esc(targetsText)}</textarea>
        </details>
      </fieldset>

      <fieldset style="border:1px solid #cfa057; border-radius:10px; padding:.6rem; margin:0 0 .6rem 0; background:#f7ecd9;">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>Damage Preview</b></legend>
        <div style="display:grid; grid-template-columns:140px 1fr; gap:.35rem .6rem; align-items:center;">
          <label><b>Amount</b></label>
          <input type="number" name="amount" value="${esc(dmgShown)}" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Value Type</b></label>
          <input type="text" name="valueType" value="${esc(adv.valueType ?? meta.valueType ?? "hp")}" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />
        </div>
      </fieldset>

      <fieldset style="border:1px solid #cfa057; border-radius:10px; padding:.6rem; margin:0 0 .6rem 0; background:#f7ecd9; ${hasAcc ? "" : "opacity:.5;"}">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>Accuracy Check</b> ${hasAcc ? "" : "(not used)"}</legend>

        <div style="display:grid; grid-template-columns:140px 1fr; gap:.35rem .6rem; align-items:center;">
          <label><b>A1</b></label>
          <input type="text" name="A1" value="${esc(A1)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>A2</b></label>
          <input type="text" name="A2" value="${esc(A2)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>dA</b></label>
          <input type="number" name="dA" value="${esc(dA)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>dB</b></label>
          <input type="number" name="dB" value="${esc(dB)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Roll A</b></label>
          <input type="number" name="rA" value="${esc(rA)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Roll B</b></label>
          <input type="number" name="rB" value="${esc(rB)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Bonus</b></label>
          <input type="number" name="checkBonus" value="${esc(checkBonus)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>HR</b></label>
          <input type="number" name="hr" value="${esc(hr)}" ${hasAcc ? "" : "disabled"} style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057;" />

          <label><b>Critical?</b></label>
          <label style="display:flex; gap:.5rem; align-items:center;">
            <input type="checkbox" name="isCrit" ${isCrit ? "checked" : ""} ${hasAcc ? "" : "disabled"} />
            <span style="opacity:.85;">Shows Crit banner</span>
          </label>

          <label><b>Fumble?</b></label>
          <label style="display:flex; gap:.5rem; align-items:center;">
            <input type="checkbox" name="isFumble" ${isFumble ? "checked" : ""} ${hasAcc ? "" : "disabled"} />
            <span style="opacity:.85;">Shows Fumble banner</span>
          </label>

          <label><b>Total</b></label>
          <input type="text" value="${esc(rA + rB + checkBonus)}" disabled style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057; background:#fff8ea;" />
        </div>
      </fieldset>

      <fieldset style="border:1px solid #cfa057; border-radius:10px; padding:.6rem; margin:0; background:#f7ecd9;">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>Effect</b></legend>
        <div style="opacity:.8; font-size:12px; margin-bottom:.35rem;">HTML allowed (this is what the card renders).</div>
        <textarea name="effectHTML" rows="6" style="width:100%; padding:.35rem; border-radius:8px; border:1px solid #cfa057; resize:vertical;">${esc(effectHTML)}</textarea>
      </fieldset>

    </form>
    `;
  }

  function readFormData(html) {
    const root = html?.[0];
    const form = root?.querySelector?.("form.fu-ace");
    if (!form) return null;

    const fd = new FormData(form);

    // Targets:
    // - If Advanced textarea has any text → use it.
    // - Else use selected UUIDs from the pickers.
    const targetsText = String(fd.get("targetsText") ?? "").trim();
    let targets = [];

    if (targetsText) {
      targets = normalizeTargetList(targetsText);
    } else {
      const picked = [];
      const pickNames = ["targetsHostile", "targetsNeutral", "targetsFriendly", "targetsOther"];
      for (const nm of pickNames) {
        const sel = form.querySelector(`select[name="${nm}"]`);
        if (!sel) continue;
        for (const opt of Array.from(sel.selectedOptions ?? [])) {
          const v = String(opt?.value ?? "").trim();
          if (v) picked.push(v);
        }
      }
      targets = Array.from(new Set(picked));
    }

    return {
      skillName: String(fd.get("skillName") ?? "").trim(),
      listType: String(fd.get("listType") ?? "").trim(),
      attackRange: String(fd.get("attackRange") ?? "").trim(),
      elementType: normalizeElementType(fd.get("elementType")),
      costRaw: String(fd.get("costRaw") ?? "").trim(),
      declaresHealing: !!fd.get("declaresHealing"),
      ignoreHR: !!fd.get("ignoreHR"),

      targets,

      amount: toNum(fd.get("amount"), 0),
      valueType: String(fd.get("valueType") ?? "hp").trim() || "hp",

      // accuracy
      A1: String(fd.get("A1") ?? "").trim(),
      A2: String(fd.get("A2") ?? "").trim(),
      dA: toNum(fd.get("dA"), 0),
      dB: toNum(fd.get("dB"), 0),
      rA: toNum(fd.get("rA"), 0),
      rB: toNum(fd.get("rB"), 0),
      checkBonus: toNum(fd.get("checkBonus"), 0),
      hr: toNum(fd.get("hr"), 0),
      isCrit: !!fd.get("isCrit"),
      isFumble: !!fd.get("isFumble"),

      effectHTML: String(fd.get("effectHTML") ?? "")
    };
  }

  // ---------------------------
  // Apply edits → rebuild card
  // ---------------------------
  function applyEditsToPayload(payload, originalTargets, edits) {
    const next = deepClone(payload ?? {});
    next.core = next.core ?? {};
    next.meta = next.meta ?? {};
    next.advPayload = next.advPayload ?? {};

    // --- header ---
    if (edits.skillName) next.core.skillName = edits.skillName;
    if (edits.listType) next.meta.listType = edits.listType;
    if (edits.attackRange) next.meta.attackRange = edits.attackRange;

    next.meta.elementType = edits.elementType;
    next.advPayload.elementType = edits.elementType;

    next.meta.costRaw = edits.costRaw || next.meta.costRaw || "-";
    next.meta.declaresHealing = !!edits.declaresHealing;
    next.meta.ignoreHR = !!edits.ignoreHR;

    // --- targets ---
    const newTargets = (edits.targets?.length ? edits.targets : (originalTargets ?? [])).filter(Boolean);
    next.originalTargetUUIDs = Array.from(newTargets);
    next.meta.originalTargetUUIDs = Array.from(newTargets);

    // --- damage ---
    const amt = Math.max(0, toNum(edits.amount, 0));
    next.meta.baseValueStrForCard = String(amt);
    next.meta.hasDamageSection = true;

    next.advPayload.valueType = edits.valueType || next.advPayload.valueType || "hp";

    // Keep resolution payload aligned with what the card shows.
    // Convention used elsewhere in your system: healing often has a leading '+'
    if (next.meta.declaresHealing) {
      next.advPayload.baseValue = `+${amt}`;
    } else {
      next.advPayload.baseValue = String(amt);
    }

    // --- effect ---
    next.core.rawEffectHTML = edits.effectHTML;

    // --- accuracy (only if this card already had accuracy) ---
    if (next.accuracy) {
      const a = next.accuracy;

      a.A1 = edits.A1 || a.A1;
      a.A2 = edits.A2 || a.A2;

      a.dA = toNum(edits.dA, a.dA ?? 0);
      a.dB = toNum(edits.dB, a.dB ?? 0);

      // Ensure rA/rB are objects like your pipeline expects
      if (!a.rA || typeof a.rA !== "object") a.rA = { result: 0, total: 0 };
      if (!a.rB || typeof a.rB !== "object") a.rB = { result: 0, total: 0 };

      a.rA.total = toNum(edits.rA, a.rA.total ?? 0);
      a.rB.total = toNum(edits.rB, a.rB.total ?? 0);

      // result is mostly cosmetic in your card; keep it in sync
      a.rA.result = a.rA.total;
      a.rB.result = a.rB.total;

      a.checkBonus = toNum(edits.checkBonus, a.checkBonus ?? 0);
      a.hr = toNum(edits.hr, a.hr ?? 0);

      a.total = a.rA.total + a.rB.total + Number(a.checkBonus || 0);
      a.isCrit = !!edits.isCrit;
      a.isFumble = !!edits.isFumble;

      // If Crit, ensure Apply can treat it as auto-hit (your card already supports this hint)
      next.advPayload.autoHit = !!a.isCrit;
    }

    return next;
  }

  async function rebuildCardFromPayload(nextPayload, oldMsg) {
    // Find CreateActionCard macro
    const macro = game.macros?.getName?.(CREATE_CARD_MACRO_NAME);
    if (!macro) {
      ui.notifications?.error(`${TAG} Missing macro: ${CREATE_CARD_MACRO_NAME}`);
      return;
    }

    dbg("Rebuild: nextPayload", nextPayload);

    // IMPORTANT: Your CreateActionCard macro reads globals (__AUTO/__PAYLOAD)
    // (Oni convention: payload is injected as global __PAYLOAD, not via arguments)
    let createdOk = false;
    try {
      globalThis.__AUTO = true;
      globalThis.__PAYLOAD = nextPayload;
      await macro.execute();
      createdOk = true;
    } finally {
      try { delete globalThis.__AUTO; } catch {}
      try { delete globalThis.__PAYLOAD; } catch {}
    }

    // Delete old message (keep chat clean) — only if we successfully created the new one
    if (createdOk) {
      try {
        await oldMsg.delete();
      } catch (e) {
        console.warn(TAG, "Could not delete old Action Card:", e);
      }
    }
  }

  // ---------------------------
  // Main click handler
  // ---------------------------
  async function onEditClick(ev) {
    const btn = ev.target.closest?.("[data-fu-edit]");
    if (!btn) return;

    ev.preventDefault();
    ev.stopPropagation();

    if (!game.user?.isGM) {
      ui.notifications?.warn("GM only.");
      return;
    }

    const msgId = getMessageIdFromEvent(ev);
    if (!msgId) {
      ui.notifications?.warn("Could not resolve chat message.");
      return;
    }

    const chatMsg = game.messages?.get?.(msgId);
    if (!chatMsg) {
      ui.notifications?.warn("Chat message not found.");
      return;
    }

    const flagged = await chatMsg.getFlag(MODULE_NS, FLAG_KEY);
    const payload = flagged?.payload;
    if (!payload) {
      ui.notifications?.warn("This message does not contain an Action Card payload.");
      return;
    }

    const originalTargets = extractOriginalTargets(chatMsg, payload);
    const targetData = buildViableTargetLists(originalTargets);

    const dlgContent = buildDialogHTML(payload, originalTargets, targetData);

    // Helper: force listbox sizing (beats Foundry's select height rules)
    const forceListboxSizing = (el, rows) => {
      if (!el) return;

      el.multiple = true;
      el.size = rows;

      const pxPerRow = 26;
      const desired = Math.max(4, rows) * pxPerRow;

      el.style.setProperty("height", `${desired}px`, "important");
      el.style.setProperty("min-height", `${desired}px`, "important");
      el.style.setProperty("overflow-y", "auto", "important");
      el.style.setProperty("appearance", "auto", "important");
    };

    new Dialog({
      title: "Action Card Editor (GM)",
      content: dlgContent,
      buttons: {
        save: {
          icon: '<i class="fa-solid fa-check"></i>',
          label: "Save & Re-render",
          callback: async (html) => {
            const edits = readFormData(html);
            if (!edits) return;

            const nextPayload = applyEditsToPayload(payload, originalTargets, edits);
            await rebuildCardFromPayload(nextPayload, chatMsg);
          }
        },
        cancel: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: "Cancel"
        }
      },
      default: "save",
      render: (html) => {
        // Minor cosmetics
        html.closest?.(".app")?.style?.setProperty?.("min-width", "640px");

        // Force listboxes to behave (same approach as Study macro)
        const root = html?.[0];
        if (!root) return;

        const rows = Number(targetData?.rows ?? 6);
        root.querySelectorAll?.("select.fu-ace-target")?.forEach?.(sel => {
          const localRows = Number(sel.getAttribute("size") || rows);
          forceListboxSizing(sel, localRows);
        });

        const textarea = root.querySelector('textarea[name="targetsText"]');
        const selects = Array.from(root.querySelectorAll?.("select.fu-ace-target") ?? []);

        // On open:
        // 1) keep current target highlight in picker
        // 2) normalize textarea to match the current picker selection
        const initiallySelected = getSelectedTargetsFromPickers(root);
        setSelectedTargetsOnPickers(root, initiallySelected);
        setTargetsTextarea(root, initiallySelected);

        // Picker -> textarea live sync
        const syncTextareaFromPickers = () => {
          const picked = getSelectedTargetsFromPickers(root);
          setTargetsTextarea(root, picked);
        };

        // Textarea -> picker live sync
        const syncPickersFromTextarea = () => {
          if (!textarea) return;
          const typed = normalizeTargetList(textarea.value);
          setSelectedTargetsOnPickers(root, typed);
        };

        for (const sel of selects) {
          sel.addEventListener("change", syncTextareaFromPickers);
        }

        if (textarea) {
          textarea.addEventListener("input", syncPickersFromTextarea);
        }
      }
    }, {
      width: 680,
      height: "auto",
      resizable: true
    }).render(true);
  }

  // ---------------------------
  // Install (idempotent)
  // ---------------------------
  function installOnce() {
    if (window.__fuActionCardEditorBound) return;
    window.__fuActionCardEditorBound = true;

    dbg("Installed");

    // Delegated click: works for main chat and popouts
    document.addEventListener("click", (ev) => {
      const inChat = ev.target.closest?.("#chat-log, .chat-popout, .app.chat-popout");
      if (!inChat) return;
      onEditClick(ev);
    });
  }

  Hooks.once("ready", installOnce);
})();
