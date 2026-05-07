// scripts/create-damage-card.js
// ──────────────────────────────────────────────────────────
//  Create Damage Card (module version, speakerless) · V12
//  Exposes:
//    game.modules.get('fabula-ultima-companion')?.api.createDamageCard(payload)
//    game.modules.get('fabula-ultima-companion')?.api.createGroupedDamageCard({ entries, ... })
//
//  Update: Adds grouped Damage Card rendering without removing the old single-card API.
//  - Single card behavior remains compatible.
//  - Grouped card creates ONE ChatMessage containing many damage/miss result blocks.
//  - Render hook now supports multiple .fu-shell / .fu-rollnum blocks per message.
// ──────────────────────────────────────────────────────────

(function initFUCreateDamageCard() {
  // Global namespace
  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.api = window.FUCompanion.api || {};

  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[FU CreateDamageCard]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);

  // ------------------------- helpers -------------------------
  const S = (v, d = "(None)") => {
    try {
      const s = (v ?? "").toString().trim();
      return s.length ? s : d;
    } catch {
      return d;
    }
  };

  const N = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  const esc = (v) => String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const escAttr = esc;

  const FALLBACK_IMG = "icons/svg/mystery-man.svg";
  const CARD_MARKER = "fu-damage-card";
  const GROUP_MARKER = "fu-damage-card-group";

  // Prefer the Actor's Profile/Portrait image for cards.
  // Falls back to token texture if the actor image isn't available.
  async function tokenImgFromUuid(uuid) {
    try {
      if (!uuid) return FALLBACK_IMG;

      const doc = await fromUuid(uuid);

      const tok =
        doc?.isToken ? doc :
        (doc?.token ?? null);

      const actor =
        doc?.actor ??
        tok?.actor ??
        (doc?.type === "Actor" ? doc : null) ??
        tok?.document?.actor ??
        null;

      if (actor?.img) return actor.img;
      if (actor?.prototypeToken?.texture?.src) return actor.prototypeToken.texture.src;

      return tok?.texture?.src ||
             tok?.document?.texture?.src ||
             tok?.img ||
             FALLBACK_IMG;
    } catch {
      return FALLBACK_IMG;
    }
  }

  async function guessAttackerByName(name) {
    const t = canvas?.tokens?.placeables?.find(t => (t.actor?.name || t.name) === name);
    return t?.document?.uuid ?? "";
  }

  function safeClone(value, fallback = null) {
    try {
      return foundry?.utils?.deepClone ? foundry.utils.deepClone(value) : JSON.parse(JSON.stringify(value));
    } catch {
      try {
        return structuredClone(value);
      } catch {
        return fallback;
      }
    }
  }

  function nowId(prefix = "DMG-GROUP") {
    const rnd = foundry?.utils?.randomID?.(8) ?? Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${rnd}`;
  }

  function normalizeEntries(input) {
    if (Array.isArray(input)) return input.filter(Boolean);
    if (Array.isArray(input?.entries)) return input.entries.filter(Boolean);
    if (Array.isArray(input?.payloads)) return input.payloads.filter(Boolean);
    if (Array.isArray(input?.cards)) return input.cards.filter(Boolean);
    return [];
  }

  // ------------------ DAMAGE CARD ROLL-UP HELPERS ------------------
  // Shared roll-up system for Damage Cards.
  // Important:
  // - CreateActionCard has its own roll-up system.
  // - Damage Card should not rely on el.__rolled because that belongs to the Action Card binder.
  // - Use __fuDamageRolled / data-fu-damage-rolled instead.
  const damageRollReduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const damageRollFmt = (n) => n.toLocaleString?.() ?? String(n);
  const damageRollEaseOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  let sharedDamageRollObserver = null;

  function isDamageRollNumber(el) {
    if (!el) return false;
    return !!el.closest?.(`[data-fu-card="${CARD_MARKER}"]`);
  }

  function animateDamageRollNumber(rollEl) {
    if (!rollEl || !isDamageRollNumber(rollEl)) return;

    // Damage-card-specific guard.
    // Do not use rollEl.__rolled here; CreateActionCard uses that flag.
    if (rollEl.__fuDamageRolled || rollEl.dataset.fuDamageRolled === "true") return;

    rollEl.__fuDamageRolled = true;
    rollEl.dataset.fuDamageRolled = "true";

    const final = Math.max(0, Number(rollEl.dataset.final || 0));

    if (!Number.isFinite(final) || final <= 0 || damageRollReduceMotion) {
      rollEl.textContent = damageRollFmt(final);
      return;
    }

    const dur = 800;
    const startVal = 1;
    const t0 = performance.now();

    let lastText = "";

    const frame = (now) => {
      // If Foundry rerenders/removes the chat element mid-animation, stop safely.
      if (!rollEl.isConnected) return;

      const p = Math.min(1, (now - t0) / dur);
      const curr = Math.max(
        startVal,
        Math.floor(startVal + (final - startVal) * damageRollEaseOutCubic(p))
      );

      const nextText = damageRollFmt(curr);

      // Avoid writing to the DOM if the visible number did not change this frame.
      if (nextText !== lastText) {
        rollEl.textContent = nextText;
        lastText = nextText;
      }

      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        const finalText = damageRollFmt(final);
        if (rollEl.textContent !== finalText) rollEl.textContent = finalText;
      }
    };

    requestAnimationFrame(frame);
  }

  function getSharedDamageRollObserver() {
    if (!("IntersectionObserver" in window)) return null;
    if (sharedDamageRollObserver) return sharedDamageRollObserver;

    sharedDamageRollObserver = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        animateDamageRollNumber(entry.target);
        obs.unobserve(entry.target);
      }
    }, {
      root: null,
      rootMargin: "0px",
      threshold: 0.1
    });

    return sharedDamageRollObserver;
  }

  function observeDamageRollNumber(rollEl) {
    if (!rollEl || !isDamageRollNumber(rollEl)) return;
    if (rollEl.__fuDamageRolled || rollEl.dataset.fuDamageRolled === "true") return;

    const observer = getSharedDamageRollObserver();

    if (observer) observer.observe(rollEl);
    else animateDamageRollNumber(rollEl);
  }

  // ------------------ PERSISTENT RENDER HOOK ------------------
  Hooks.on("renderChatMessage", (_msg, htmlJQ) => {
    const root = htmlJQ?.[0];
    if (!root) return;

    const marker = root.querySelector(`[data-fu-card="${CARD_MARKER}"]`);
    if (!marker) return;

    try {
      const header = root.querySelector(".message-header");
      if (header) header.remove();

      const content = root.querySelector(".message-content");
      if (content) {
        content.style.marginTop = "0";
        content.style.paddingTop = "0";
      }

      const shells = Array.from(root.querySelectorAll(".fu-shell"));

      for (const shell of shells) {
        if (shell.dataset.fuBound === "true") continue;
        shell.dataset.fuBound = "true";

        const details = shell.querySelector(".fu-details");
        if (!details) continue;

        const setOpen = (open) => {
          shell.dataset.open = open ? "true" : "false";
          if (open) {
            const full = details.scrollHeight;
            details.style.maxHeight = full + "px";
            details.style.paddingTop = ".35rem";
            details.style.paddingBottom = ".35rem";
          } else {
            details.style.maxHeight = "0px";
            details.style.paddingTop = "0";
            details.style.paddingBottom = "0";
          }
        };

        setOpen(false);

        shell.addEventListener("click", (ev) => {
          if (ev.target.closest("a, button")) return;
          setOpen(shell.dataset.open !== "true");
        });

        if ("ResizeObserver" in window) {
          const ro = new ResizeObserver(() => {
            if (shell.dataset.open === "true") {
              details.style.maxHeight = details.scrollHeight + "px";
            }
          });
          ro.observe(details);
        }
      }

      root.querySelectorAll(".fu-rollnum").forEach(observeDamageRollNumber);
    } catch (e) {
      warn("render hook error:", e);
    }
  });

  // --------------------- RENDER BUILDERS ---------------------
  async function buildDamageShellHTML(P_in, options = {}) {
    const P = P_in ?? {};
    const compact = !!options.compact;
    const index = Number(options.index ?? NaN);

    const attackerName = S(P.attackerName, "System");
    const attackerUuid = S(P.attackerUuid, "");
    const attackRange = S(P.attackRange, "(None)");
    const sourceType = S(P.sourceType, "(None)");
    const targetName = S(P.targetName, "Unknown Target");
    const targetUuid = S(P.targetUuid, "");

    const valueType = S(P.valueType, "hp").toLowerCase();
    const changeKey = S(P.changeKey, "hpReduction");
    const elementType = S(P.elementType, "elementless").toLowerCase();
    const weaponType = S(P.weaponType, "none_ef");

    const affinityCode = S(P.affinityCode, "NE");
    const effLabel = S(P.effectivenessLabel, "Neutral");

    const baseValue = N(P.baseValue, 0);
    const finalValue = N(P.finalValue, baseValue);

    let shownAmount = N(P.displayedAmount, Math.abs(finalValue || baseValue));
    if (!Number.isFinite(shownAmount) || shownAmount < 0) shownAmount = 0;

    const shieldBreak = !!P.shieldBreak;
    const affected = (typeof P.affected === "boolean") ? P.affected : true;
    const noEffectReason = P.noEffectReason ?? null;

    const modeMiss = String(P.mode || "").toLowerCase() === "miss" || (!!P.miss);
    const isMiss = modeMiss || (P.affected === false && String(P.noEffectReason || "").toLowerCase() === "miss");

    const targetImg = await tokenImgFromUuid(targetUuid);
    const attackerId = attackerUuid || await guessAttackerByName(attackerName);
    const attackerImg = await tokenImgFromUuid(attackerId);

    const COLOR = {
      physical: "#111111",
      fire: "#e25822",
      ice: "#5ab3d4",
      air: "#48c774",
      earth: "#8b5e3c",
      bolt: "#9b59b6",
      light: "#a38b50",
      dark: "#4b0082",
      poison: "#2e8b57",
      mp: "#2e7bd6",
      shield: "#888888",
      heal: "#2ecc71"
    };

    const GLOW = {
      physical: "rgba(0,0,0,.28)",
      fire: "rgba(226,88,34,.45)",
      ice: "rgba(90,179,212,.45)",
      air: "rgba(72,199,116,.45)",
      earth: "rgba(139,94,60,.45)",
      bolt: "rgba(155,89,182,.45)",
      light: "rgba(163,139,80,.45)",
      dark: "rgba(75,0,130,.45)",
      poison: "rgba(46,139,87,.45)",
      mp: "rgba(46,124,214,.45)",
      shield: "rgba(136,136,136,.40)",
      heal: "rgba(46,204,113,.48)"
    };

    const COLOR_MISS = "#777777";
    const GLOW_MISS = "rgba(0,0,0,.10)";

    const isRecovery = changeKey.endsWith("Recovery");

    const elemKey = (
      valueType === "hp"
        ? elementType
        : valueType === "mp"
          ? "mp"
          : "shield"
    ).toLowerCase();

    const elemNice = (
      valueType === "hp" && elementType !== "elementless"
        ? elementType.charAt(0).toUpperCase() + elementType.slice(1)
        : valueType === "mp"
          ? "Mind"
          : valueType === "shield"
            ? "Shield"
            : "Damage"
    );

    const colorKey = (
      valueType === "hp"
        ? isRecovery
          ? "heal"
          : COLOR[elemKey]
            ? elemKey
            : "physical"
        : valueType === "mp"
          ? "mp"
          : "shield"
    );

    const dmgColor = isMiss ? COLOR_MISS : COLOR[colorKey];
    const glowColor = isMiss ? GLOW_MISS : GLOW[colorKey];

    const wpnKey = (weaponType || "").split("_")[0];
    const wpnNice = wpnKey && wpnKey !== "none"
      ? (wpnKey[0].toUpperCase() + wpnKey.slice(1))
      : "(None)";

    const effTag = effLabel && effLabel !== "Neutral"
      ? `<span style="font-weight:800;">${esc(effLabel)}</span>`
      : "Neutral";

    const isImmune =
      /immune/i.test(effLabel) ||
      /^(im|imm|immune)$/i.test(affinityCode) ||
      (affected === false && /immune/i.test(String(noEffectReason || "")));

    const isSuper =
      !isImmune &&
      (/vuln|weak|super/i.test(effLabel) || /^(v|vu|wk|se)$/i.test(affinityCode));

    const isResisted =
      !isImmune &&
      (/resist|half/i.test(effLabel) || /^(re|rs|rh)$/i.test(affinityCode));

    const numberSize = compact ? 34 : 42;
    const missSize = compact ? 32 : 38;
    const immuneSize = compact ? 23 : 28;

    const numberHTML = isImmune
      ? `<span class="fu-immune" style="font-size:${immuneSize}px;font-weight:900;letter-spacing:.5px;color:#777;text-transform:uppercase;text-shadow:0 0 8px rgba(0,0,0,.06);">IMMUNE</span>`
      : isMiss
        ? `<span class="fu-miss-text" style="font-size:${missSize}px;font-weight:900;letter-spacing:.5px;color:${COLOR_MISS};text-shadow:0 0 18px ${GLOW_MISS},0 0 8px ${GLOW_MISS};text-transform:uppercase;line-height:1;">MISS</span>`
        : `<span class="fu-rollnum" data-final="${Math.max(0, Math.abs(shownAmount))}" style="font-size:${numberSize}px;font-weight:900;font-style:italic;line-height:1;color:${dmgColor};text-shadow:0 0 18px ${glowColor},0 0 8px ${glowColor};will-change:contents;">${Math.max(0, Math.abs(shownAmount))}</span>`;

    const typeHTML = isMiss ? "" : `
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;opacity:.9;color:#333;text-align:right;">
        ${isRecovery ? "HEAL" : esc(elemNice)}
      </div>
    `;

    const targetImgSize = compact ? 62 : 72;
    const targetImgLeft = compact ? -11 : -14;
    const rightMargin = compact ? 50 : 58;

    const compactRow = `
      <div class="fu-compact" style="position:relative;display:grid;grid-template-columns:1fr auto;align-items:center;gap:.6rem;min-height:${compact ? 50 : 56}px;">
        <img src="${escAttr(targetImg)}" alt=""
             style="position:absolute;left:${targetImgLeft}px;top:50%;transform:translateY(-55%);width:${targetImgSize}px;height:${targetImgSize}px;object-fit:contain;border:none;box-shadow:none;pointer-events:none;z-index:1;opacity:.98;">
        <div class="fu-right" style="margin-left:${rightMargin}px;display:flex;align-items:baseline;justify-content:flex-end;gap:.6rem;position:relative;z-index:2;">
          ${Number.isFinite(index) ? `<span style="font-size:11px;font-weight:900;color:#7a6a55;opacity:.78;margin-right:auto;">#${index + 1}</span>` : ``}
          ${shieldBreak ? `<span style="color:#ff3838;font-weight:900;">BREAK!</span>` : ``}
          ${numberHTML}
        </div>
        ${typeHTML}
      </div>
    `;

    const baseLine = `${Math.abs(baseValue)}`;

    const detailRows = `
      <div class="fu-actors" style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.4rem;margin-bottom:.35rem;">
        <div style="justify-self:end;"><img src="${escAttr(attackerImg)}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>
        <div style="justify-self:center;font-size:18px;opacity:.85;"><i class="fa-solid fa-swords"></i></div>
        <div style="justify-self:start;"><img src="${escAttr(targetImg)}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>
      </div>

      <div style="display:grid;grid-template-columns:160px 1fr;row-gap:.25rem;column-gap:.6rem;font-size:13px;">
        <div style="opacity:.8;">Attacker</div><div><b>${esc(attackerName)}</b></div>
        <div style="opacity:.8;">Target</div><div><b>${esc(targetName)}</b></div>
        <div style="opacity:.8;">Weapon Type</div><div>${esc(wpnNice)}</div>
        <div style="opacity:.8;">Base Damage</div><div>${esc(baseLine)}</div>
        <div style="opacity:.8;">Affinity</div><div>${effTag}</div>
        <div style="opacity:.8;">Range</div><div>${esc(attackRange)}</div>
        <div style="opacity:.8;">Source</div><div>${esc(sourceType)}</div>
      </div>
    `;

    let fxBadgeHTML = "";

    if (valueType === "hp" && !isRecovery && !isImmune && (isSuper || isResisted)) {
      const text = isSuper ? "Super Effective!" : "Resisted";

      const pill = isSuper
        ? { bg: "#f7ecd9", border: "#cfa057", color: "#8a4b22" }
        : { bg: "#eee", border: "#999", color: "#333" };

      fxBadgeHTML = `
        <div class="fu-fx-badge" aria-hidden="true" style="position:absolute;right:-6px;bottom:-10px;z-index:5;pointer-events:none;background:${pill.bg};color:${pill.color};border:1px solid ${pill.border};border-radius:999px;padding:.1rem .45rem;font-weight:800;font-size:11px;letter-spacing:.2px;box-shadow:0 2px 6px rgba(0,0,0,.14),0 1px 0 rgba(255,255,255,.6) inset;transform:translateZ(0);white-space:nowrap;">
          ${text}
        </div>
      `;
    }

    const srAlt = isImmune
      ? `${targetName}: Immune.`
      : isMiss
        ? `${targetName} dodged the attack!`
        : affected
          ? `${targetName}: ${Math.abs(shownAmount)} ${isRecovery ? "healing" : elemNice}.`
          : `No effect on ${targetName}${noEffectReason ? ` (${noEffectReason})` : ""}.`;

    const shellPadding = compact ? ".48rem .58rem" : ".55rem .65rem";
    const shellMargin = compact ? ".35rem 0 0 0" : "0";

    return `
      <div class="fu-shell" data-open="false"
           style="border:1px solid #cfa057;background:#faf3e4;border-radius:10px;padding:${shellPadding};position:relative;overflow:visible;cursor:pointer;margin:${shellMargin};">
        <span class="sr-only" style="position:absolute;left:-9999px;top:auto;">${esc(srAlt)}</span>
        ${compactRow}
        ${fxBadgeHTML}
        <div class="fu-details" style="max-height:0;overflow:hidden;transition:max-height .22s ease, padding .22s ease;padding:0 .25rem;">
          <div style="border-top:1px dashed #cfa057;opacity:.6;margin:.45rem 0;"></div>
          ${detailRows}
          <div style="height:.25rem;"></div>
        </div>
      </div>
    `;
  }

  async function buildSingleDamageCardHTML(P) {
    const shellHTML = await buildDamageShellHTML(P, { compact: false });

    return `
      <div class="fu-card" data-fu-card="${CARD_MARKER}" style="font-family: Signika, sans-serif; letter-spacing:.2px;">
        ${shellHTML}
      </div>
    `;
  }

async function buildGroupedDamageCardHTML({
  entries = [],
  batchId = null,
  title = "Damage Results",
  subtitle = "",
  rootActionContext = null,
  showHeader = null
} = {}) {
  const safeEntries = entries.filter(Boolean);
  const count = safeEntries.length;
  const firstEntry = safeEntries[0] ?? {};

  const firstNonBlank = (...values) => {
    for (const value of values) {
      const s = String(value ?? "").trim();
      if (s) return s;
    }
    return "";
  };

  const cleanTitle = (rawTitle) => {
    let out = String(rawTitle ?? "").trim();
    out = out.replace(/\s+results?\s*$/i, "").trim();
    return out || "Damage";
  };

  const normalizeMode = (raw) => {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "autopassive") return "autoPassive";
    if (s === "manualcard") return "manualCard";
    return s;
  };

  const getEntryContext = (entry = {}) => {
    return (
      entry?.actionContext ??
      entry?.rootActionContext ??
      entry?.meta?.actionContext ??
      {}
    );
  };

  const resolveEntrySource = (entry = {}, index = 0) => {
    const ctx = getEntryContext(entry);
    const meta = entry?.meta ?? {};
    const ctxMeta = ctx?.meta ?? {};
    const core = ctx?.core ?? {};
    const dataCore = ctx?.dataCore ?? {};

    const executionMode = normalizeMode(
      ctxMeta?.executionMode ??
      meta?.executionMode ??
      ctx?.executionMode ??
      ""
    );

    const sourceKind = firstNonBlank(
      ctxMeta?.damageSourceKind,
      meta?.damageSourceKind,
      executionMode === "autoPassive" ? "autoPassive" : "",
      "mainAction"
    );

    const isPassiveLike =
      sourceKind === "autoPassive" ||
      executionMode === "autoPassive" ||
      ctxMeta?.isPassiveExecution === true ||
      ctx?.autoPassive === true;

    const rawName = firstNonBlank(
      ctxMeta?.damageSourceName,
      meta?.damageSourceName,
      core?.skillName,
      dataCore?.skillName,
      ctx?.sourceItem?.name,
      ctx?.item?.name,
      entry?.skillName,
      title,
      "Damage"
    );

    const name = cleanTitle(rawName);

    const icon = firstNonBlank(
      ctxMeta?.damageSourceIcon,
      meta?.damageSourceIcon,
      ctx?.sourceItem?.img,
      ctx?.item?.img,
      core?.skillImg,
      dataCore?.skillImg,
      meta?.skillImg,
      entry?.skillImg,
      entry?.actionImg,
      entry?.sourceImg,
      ""
    );

    const actorName = firstNonBlank(
      ctxMeta?.attackerName,
      core?.attackerName,
      entry?.attackerName,
      rootActionContext?.meta?.attackerName,
      rootActionContext?.core?.attackerName,
      "System"
    );

    const sourceKey = firstNonBlank(
      ctxMeta?.damageSourceKey,
      meta?.damageSourceKey,
      ctxMeta?.passiveIdentity,
      ctxMeta?.passiveItemUuid,
      ctxMeta?.actionId,
      ctx?.actionId,
      `${sourceKind}:${name}`
    );

    const modeLabel = isPassiveLike ? "Auto Passive" : "Action";

    return {
      key: `${isPassiveLike ? "1" : "0"}::${sourceKey}`,
      order: isPassiveLike ? 1 : 0,
      firstIndex: index,
      name,
      icon,
      actorName,
      modeLabel,
      sourceKind,
      executionMode,
      isPassiveLike
    };
  };

  const buildSections = () => {
    const map = new Map();

    for (let i = 0; i < safeEntries.length; i++) {
      const entry = safeEntries[i];
      const source = resolveEntrySource(entry, i);

      if (!map.has(source.key)) {
        map.set(source.key, {
          ...source,
          entries: []
        });
      }

      map.get(source.key).entries.push(entry);
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.firstIndex - b.firstIndex;
    });
  };

  const sections = buildSections();

  // Show source section banners only when there is more than one source.
  // Example:
  //   Infectious Ray
  //   Agony
  // If only Infectious Ray exists, keep the compact card without extra banner.
  const showSourceSections = sections.length > 1;

  const renderSourceHeader = (section, sectionIndex) => {
    if (!showSourceSections) return "";

    const marginTop = sectionIndex === 0 ? "0" : ".42rem";

    return `
      <div class="fu-source-head"
           style="
             border:1px solid rgba(207,160,87,.82);
             background:linear-gradient(180deg,#f7ecd9,#ead7b7);
             border-radius:8px;
             padding:.30rem .42rem;
             margin:${marginTop} 0 .22rem 0;
             box-shadow:0 1px 0 rgba(255,255,255,.55) inset;
           ">
        <div style="display:flex;align-items:center;gap:.36rem;min-width:0;">
          ${
            section.icon
              ? `<img src="${escAttr(section.icon)}" alt=""
                      style="
                        width:20px;
                        height:20px;
                        object-fit:cover;
                        border-radius:5px;
                        box-shadow:0 0 0 1px rgba(0,0,0,.22);
                        flex:0 0 auto;
                      ">`
              : ``
          }

          <div style="min-width:0;line-height:1.08;">
            <div style="
              font-size:11px;
              font-weight:900;
              color:#493827;
              text-transform:uppercase;
              letter-spacing:.032em;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
            ">
              ${esc(section.name)}
            </div>

            <div style="
              font-size:9px;
              font-weight:700;
              color:#6f5b43;
              opacity:.86;
              margin-top:.08rem;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
            ">
              ${esc([section.modeLabel, section.actorName].filter(Boolean).join(" • "))}
            </div>
          </div>
        </div>
      </div>
    `;
  };

  const sectionHTML = [];

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];

    const shells = [];

    for (const entry of section.entries) {
      // index intentionally omitted to remove #1 / #2 style row labels.
      shells.push(await buildDamageShellHTML(entry, {
        compact: true,
        index: null
      }));
    }

    sectionHTML.push(`
      <section class="fu-damage-source-section"
               data-source-kind="${escAttr(section.sourceKind)}"
               data-source-name="${escAttr(section.name)}"
               style="display:flex;flex-direction:column;gap:.22rem;">
        ${renderSourceHeader(section, s)}
        ${shells.join("\n")}
      </section>
    `);
  }

  // Parent banner is now disabled by default.
  // Source banners are more useful and smaller.
  const shouldShowParentHeader = typeof showHeader === "boolean" ? showHeader : false;

  const parentHeader = shouldShowParentHeader ? `
    <div class="fu-group-head"
         style="
           border:1px solid #cfa057;
           background:linear-gradient(180deg,#f7ecd9,#ead7b7);
           border-radius:8px;
           padding:.30rem .42rem;
           margin-bottom:.28rem;
           box-shadow:0 1px 0 rgba(255,255,255,.55) inset;
         ">
      <div style="font-size:11px;font-weight:900;color:#493827;text-transform:uppercase;letter-spacing:.035em;">
        ${esc(cleanTitle(title))}
      </div>
      ${
        subtitle
          ? `<div style="font-size:9px;font-weight:700;color:#6f5b43;opacity:.86;margin-top:.08rem;">
               ${esc(subtitle)}
             </div>`
          : ``
      }
    </div>
  ` : "";

  return `
    <div class="fu-card fu-card-group"
         data-fu-card="${CARD_MARKER}"
         data-fu-card-kind="${GROUP_MARKER}"
         data-batch-id="${escAttr(batchId ?? "")}"
         style="font-family: Signika, sans-serif; letter-spacing:.2px;">
      ${parentHeader}
      <div class="fu-group-body" style="display:flex;flex-direction:column;gap:.24rem;">
        ${sectionHTML.join("\n")}
      </div>
    </div>
  `;
}

  async function postDamageChatMessage({
    content,
    flagPayload,
    grouped = false,
    batchId = null
  }) {
    const speaker = { alias: "" };

    const flags = {
      [MODULE_ID]: grouped
        ? {
            groupedDamageCard: {
              batchId: batchId ?? null,
              payload: flagPayload
            }
          }
        : {
            damageCard: {
              payload: flagPayload
            }
          }
    };

    return await ChatMessage.create({
      user: game.userId,
      speaker,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      content,
      flags
    });
  }

  // --------------------- CARD CREATION API ---------------------
  async function createDamageCard(P_in) {
    const P = P_in ?? {};
    const cardHTML = await buildSingleDamageCardHTML(P);

    return await postDamageChatMessage({
      content: cardHTML,
      flagPayload: P,
      grouped: false,
      batchId: P?.damageBatchId ?? P?.meta?.damageBatchId ?? null
    });
  }

  async function createGroupedDamageCard(input = {}) {
    const entries = normalizeEntries(input);
    const batchId = input?.batchId ?? input?.damageBatchId ?? input?.meta?.damageBatchId ?? nowId();
    const rootActionContext = input?.rootActionContext ?? input?.actionContext ?? input?.payload?.rootActionContext ?? null;
    const title = input?.title ?? input?.groupTitle ?? "Damage Results";
    const subtitle = input?.subtitle ?? "";

    if (!entries.length) {
      log("createGroupedDamageCard skipped: no entries", { batchId });
      return null;
    }

const groupPayload = {
  batchId,
  title,
  subtitle,
  showHeader: typeof input?.showHeader === "boolean" ? input.showHeader : null,
  rootActionContext: safeClone(rootActionContext, rootActionContext),
  entries: safeClone(entries, entries)
};

const html = await buildGroupedDamageCardHTML({
  entries,
  batchId,
  title,
  subtitle,
  rootActionContext,
  showHeader: typeof input?.showHeader === "boolean" ? input.showHeader : null
});

    return await postDamageChatMessage({
      content: html,
      flagPayload: groupPayload,
      grouped: true,
      batchId
    });
  }

  function exposeApi() {
    FUCompanion.createDamageCard = createDamageCard;
    FUCompanion.createGroupedDamageCard = createGroupedDamageCard;
    FUCompanion.buildDamageCardHTML = buildSingleDamageCardHTML;
    FUCompanion.buildGroupedDamageCardHTML = buildGroupedDamageCardHTML;

    FUCompanion.api = FUCompanion.api || {};
    FUCompanion.api.createDamageCard = createDamageCard;
    FUCompanion.api.createGroupedDamageCard = createGroupedDamageCard;
    FUCompanion.api.buildDamageCardHTML = buildSingleDamageCardHTML;
    FUCompanion.api.buildGroupedDamageCardHTML = buildGroupedDamageCardHTML;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.createDamageCard = createDamageCard;
        mod.api.createGroupedDamageCard = createGroupedDamageCard;
        mod.api.buildDamageCardHTML = buildSingleDamageCardHTML;
        mod.api.buildGroupedDamageCardHTML = buildGroupedDamageCardHTML;
      }
    } catch (e) {
      warn("Could not expose module API yet.", e);
    }
  }

  exposeApi();

  Hooks.once("ready", () => {
    exposeApi();
    log("API ready", {
      createDamageCard: true,
      createGroupedDamageCard: true
    });
  });
})();