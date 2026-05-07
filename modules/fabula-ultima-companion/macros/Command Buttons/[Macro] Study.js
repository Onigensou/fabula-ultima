/*********************************************************
 *  Study Macro – Foundry V12 compatible
 *  UI: NEW_StudyCard_UI wired into real Study logic
 *  Updates:
 *   - Stealable Items show real item icons (fromUuid -> embedded -> fallback)
 *   - Description displayed as plain text (HTML stripped)
 *********************************************************/
(async () => {

  // =========================
  // DEBUG TOGGLE
  // =========================
  const DEBUG = false;
  const TAG = "[ONI][Study]";
  const dbg  = (...args) => { if (DEBUG) console.log(TAG, ...args); };
  const dbgw = (...args) => { if (DEBUG) console.warn(TAG, ...args); };
  const dbge = (...args) => { if (DEBUG) console.error(TAG, ...args); };

  /* ───────────────────── CONSTANT MAPS ───────────────────── */
  const affinityMap  = { 1:"Physical",2:"Air",3:"Bolt",4:"Dark",5:"Earth",6:"Fire",7:"Ice",8:"Light",9:"Poison" };
const conditionList = [
  { key: "condition_slow",        label: "Slow" },
  { key: "condition_dazed",       label: "Dazed" },
  { key: "condition_weak",        label: "Weak" },
  { key: "condition_shaken",      label: "Shaken" },
  { key: "condition_poisoned",    label: "Poisoned" },
  { key: "condition_enraged",     label: "Enraged" },
  { key: "condition_silence",     label: "Silence" },
  { key: "condition_stagger",     label: "Stagger" },
  { key: "condition_frightened",  label: "Frightened" },
  { key: "condition_paralyze",    label: "Paralyze" },
  { key: "condition_confused",    label: "Confused" },
  { key: "condition_panic",       label: "Panic" },
  { key: "condition_grappled",    label: "Grappled" },
  { key: "condition_envenomed",   label: "Envenomed" },
  { key: "condition_burn",        label: "Burn" },
  { key: "condition_blind",       label: "Blind" },
  { key: "condition_zombie",      label: "Zombie" },
  { key: "condition_wither",      label: "Wither" },
  { key: "condition_bleed",       label: "Bleed" },
  { key: "condition_obscure",     label: "Obscure" },
  { key: "condition_fatigue",     label: "Fatigue" },
  { key: "condition_charm",       label: "Charm" },
  { key: "condition_berserk",     label: "Berserk" },
  { key: "condition_despair",     label: "Despair" },
  { key: "condition_doom",        label: "Doom" },
  { key: "condition_bane",        label: "Bane" },
  { key: "condition_curse",       label: "Curse" },
  { key: "condition_wet",         label: "Wet" },
  { key: "condition_oil",         label: "Oil" },
  { key: "condition_petrify",     label: "Petrify" },
  { key: "condition_hypothermia", label: "Hypothermia" },
  { key: "condition_turbulence",  label: "Turbulence" },
  { key: "condition_delayed",     label: "Delayed" },
  { key: "condition_isolate",     label: "Isolate" },
  { key: "condition_suppress",    label: "Suppress" },
  { key: "condition_disarmed",    label: "Disarmed" },
  { key: "condition_anomaly",     label: "Anomaly" }
];
  const symbolMap   = { RS:"🛡️", VU:"💥", AB:"♻️", IM:"🚫" };
  const weaponTypes = ["arcane","bow","brawling","dagger","firearm","flail","heavy","spear","sword","thrown"];
  const weaponIcons = {
    arcane:"fa-book", bow:"fa-bow-arrow", brawling:"fa-hand-fist", dagger:"fa-dagger", firearm:"fa-gun",
    flail:"fa-mace", heavy:"fa-hammer-war", spear:"fa-location-arrow", sword:"fa-sword", thrown:"fa-bomb"
  };

  /* ───────────────────── NEW UI: CSS INJECT ───────────────────── */
  const STYLE_ID = "oni-study-card-style-v1";

  const ensureStudyCardStylesInstalled = () => {
    if (document.getElementById(STYLE_ID)) return;

    const css = `
.oni-studyCardRoot{
  --fs: 14px;
  --titleFs: 18px;
  --pad: 12px;
  --rad: 14px;
  --shadow: 0.18;
  --portrait: 92px;
  --portraitRad: 0px;
  --unkOpacity: 0.7;
  --unkBlur: 0px;

  --accent: #b28b2e;
  --bg: #f3ead6;
  --bg2: #ead9b5;
  --text: #2b241a;
  --border: rgba(80,60,30,0.45);

  font-family: Signika, sans-serif;
  font-size: var(--fs);
  color: var(--text);
}

.oni-studyCardRoot .oni-card{
  background: linear-gradient(180deg, rgba(255,255,255,0.25), rgba(255,255,255,0.06));
  border: 1px solid var(--border);
  border-radius: var(--rad);
  padding: var(--pad);
  box-shadow: 0 8px 24px rgba(0,0,0,var(--shadow));
  box-sizing: border-box;
}

.oni-studyCardRoot .oni-card-header{
  display:flex;
  gap: 12px;
  align-items:center;
  margin-bottom: 10px;
}

.oni-studyCardRoot .oni-portrait{
  width: var(--portrait);
  height: var(--portrait);
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
  background: transparent !important;
  border-radius: var(--portraitRad);
  object-fit: contain;
  display:block;
}
.oni-studyCardRoot .oni-portrait-video{ pointer-events:none; }

.oni-studyCardRoot .oni-title{
  font-size: var(--titleFs);
  font-weight: 900;
  line-height: 1.15;
}
.oni-studyCardRoot .oni-sub{
  margin-top: 2px;
  opacity: .8;
  font-size: calc(var(--fs) - 1px);
}

.oni-studyCardRoot .oni-grid{
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  margin-top: 6px;
}
.oni-studyCardRoot .oni-stats{
  display:grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed rgba(0,0,0,0.15);
}

.oni-studyCardRoot .oni-muted{ color: rgba(43,36,26,0.7); }
.oni-studyCardRoot .oni-unknown{
  opacity: var(--unkOpacity);
  filter: blur(var(--unkBlur));
  display:inline-block;
  padding:0 2px;
}

.oni-studyCardRoot .oni-box{
  margin-top: 10px;
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(255,255,255,0.10);
  border-radius: 12px;
  padding: 10px;
  overflow: hidden;
  box-sizing: border-box;
}
.oni-studyCardRoot .oni-boxTitle{ font-weight: 900; margin-bottom: 6px; }

.oni-studyCardRoot .oni-inlineGrid2{
  display:grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 18px;
}

.oni-studyCardRoot .oni-inlineRow{
  display:flex;
  align-items:center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.oni-studyCardRoot .oni-inlineRowOneCol{
  justify-content: flex-start;
}

.oni-studyCardRoot .oni-inlineName{
  flex: 0 1 120px;
  min-width: 0;
  font-weight: 800;
  display:inline-flex;
  align-items:center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.oni-studyCardRoot .oni-eff{ margin-left: 4px; white-space: nowrap; }
.oni-studyCardRoot .oni-effPos{ color: #1f7a3a; }
.oni-studyCardRoot .oni-effNeg{ color: #b02a2a; }

.oni-studyCardRoot .oni-badgeWrap{
  display:flex;
  flex-wrap:wrap;
  gap: 8px;
}
.oni-studyCardRoot .oni-badge{
  display:inline-flex;
  align-items:center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(255,255,255,0.14);
  font-weight: 800;
  white-space: nowrap;
}

/* Stealable items */
.oni-studyCardRoot .oni-stealBlock{ margin-top: 10px; }
.oni-studyCardRoot .oni-stealHeader{ font-weight: 900; margin-bottom: 6px; opacity: .95; }

.oni-studyCardRoot .oni-itemPillWrap{
  display:flex;
  flex-direction:column;
  gap: 8px;
}
.oni-studyCardRoot .oni-itemPill{
  display:flex;
  align-items:center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 10px;
  background: rgba(255,255,255,0.10);
  border: 1px solid rgba(0,0,0,0.10);
  overflow:hidden;
}
.oni-studyCardRoot .oni-itemicon{
  width: 18px; height: 18px;
  object-fit: contain;
  border:none !important; outline:none !important; box-shadow:none !important;
  background: transparent !important;
  flex: 0 0 auto;
}
.oni-studyCardRoot .oni-itemName{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.oni-studyCardRoot .oni-footer{
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(0,0,0,0.10);
  display:flex;
  gap: 8px;
  align-items:center;
}
.oni-studyCardRoot .oni-pill{
  margin-left:auto;
  border: 1px solid var(--accent);
  background: rgba(178,139,46,0.15);
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 900;
  font-size: calc(var(--fs) - 2px);
}
    `.trim();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  };

  /* ───────────────────── HELPERS ───────────────────── */
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const computeReveal = (studyRoll) => {
    const r = clamp(Number(studyRoll || 0), 0, 99);
    return { r, showIdentity: r >= 7, showStats: r >= 8, showDetails: r >= 13 };
  };

  const capWord = (s) => {
    const t = String(s || "");
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  };

  const isWebm = (url) => String(url || "").toLowerCase().split("?")[0].endsWith(".webm");

  const normaliseList = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") return Object.values(raw);
    return [];
  };

  // HTML -> Plain text (strip <p>, <ul>, etc.)
  const toPlainText = (html) => {
    const div = document.createElement("div");
    div.innerHTML = String(html ?? "");
    return (div.textContent ?? "").trim();
  };

    const renderPlainText = (html) => {
    return esc(toPlainText(html)).replaceAll("\n", "<br>");
  };

  const EMPTY_STEAL_ITEM_UUID = "Item.SUYqRKHBGXUhiOL1";
  const EMPTY_STEAL_ITEM_NAME = "(Empty)";

  const normalizeStealName = (s) =>
    String(s ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();

  const isEmptyStealPlaceholder = (entry) => {
    const uuid = String(entry?.uuid ?? entry?.item_uuid ?? "").trim();
    if (uuid === EMPTY_STEAL_ITEM_UUID) return true;

    const name = normalizeStealName(entry?.name ?? entry?.item_name ?? "");
    if (name === normalizeStealName(EMPTY_STEAL_ITEM_NAME)) return true;

    return false;
  };

  // Stealable items from monster
    const readStealListFromActor = (actor) => {
    const p = actor?.system?.props ?? {};
    const raw = p.stealable_loot ?? p.stealable_equipment ?? {};
    const list = normaliseList(raw);

    return list
      .map((it) => ({
        name: it?.name ?? it?.item_name ?? "",
        uuid: it?.uuid ?? it?.item_uuid ?? "",
        img: "" // will be filled later
      }))
      .filter((it) => !!it.name)
      .filter((it) => !isEmptyStealPlaceholder(it));
  };

  // Resolve icon for steal items: UUID -> embedded by name -> fallback
  const resolveStealItemIcon = async (actor, entry) => {
    if (entry?.uuid) {
      try {
        const doc = await fromUuid(entry.uuid);
        if (doc?.img) return doc.img;
      } catch (e) { /* ignore */ }
    }

    const n = String(entry?.name ?? "").trim().toLowerCase();
    if (n) {
      const embedded = actor?.items?.find(i => String(i.name ?? "").trim().toLowerCase() === n);
      if (embedded?.img) return embedded.img;
    }

    return "icons/svg/item-bag.svg";
  };

  // Resolve which UUID should be opened when player clicks the stealable item.
// Goal:
// - If the loot row points to an embedded Actor.Item, redirect to the matching world Item.
// - If it already points to a world Item, keep it.
// - Fallback safely to the original UUID.
const resolveStealItemOpenUuid = async (actor, entry) => {
  const rawUuid = String(entry?.uuid ?? entry?.item_uuid ?? "").trim();
  if (!rawUuid) return "";

  try {
    const doc = await fromUuid(rawUuid);
    if (!doc) return rawUuid;

    // Not an item? just keep original
    if (doc.documentName !== "Item") return rawUuid;

    // World item already → good
    const parentIsActor = doc.parent?.documentName === "Actor";
    if (!parentIsActor) return doc.uuid ?? rawUuid;

    // Embedded actor item → redirect to source/base world item if possible
    const compendiumSource = String(doc?._stats?.compendiumSource ?? "").trim();
    if (compendiumSource.startsWith("Item.")) {
      return compendiumSource;
    }

    // Your data also keeps the base item id in system.uniqueId
    const uniqueId = String(doc?.system?.uniqueId ?? doc?.uniqueId ?? "").trim();
    if (uniqueId) {
      const exactWorldItem = game.items?.get(uniqueId);
      if (exactWorldItem?.uuid) return exactWorldItem.uuid;

      const matchByUniqueId = game.items?.find(i =>
        String(i?.system?.uniqueId ?? i?.uniqueId ?? "").trim() === uniqueId
      );
      if (matchByUniqueId?.uuid) return matchByUniqueId.uuid;

      // Best-effort fallback if world item exists by id
      return `Item.${uniqueId}`;
    }

    // Last fallback: name match
    const itemName = String(doc?.name ?? entry?.name ?? "").trim().toLowerCase();
    if (itemName) {
      const worldByName = game.items?.find(i =>
        String(i?.name ?? "").trim().toLowerCase() === itemName
      );
      if (worldByName?.uuid) return worldByName.uuid;
    }

    return rawUuid;
  } catch {
    return rawUuid;
  }
};

  // v12-safe token portrait resolver
  const getTokenPortraitSrc = (token) => {
    return token?.document?.texture?.src
      ?? token?.document?._source?.texture?.src
      ?? token?.actor?.img
      ?? token?.actor?.prototypeToken?.texture?.src
      ?? "icons/svg/mystery-man.svg";
  };

  const sectionBox = (title, innerHtml) => `
    <div class="oni-box">
      <div class="oni-boxTitle">${esc(title)}</div>
      <div class="oni-boxBody">${innerHtml}</div>
    </div>
  `;

  const renderPortrait = (spriteUrl) => {
    const url = spriteUrl || "icons/svg/mystery-man.svg";
    if (isWebm(url)) {
      return `<video class="oni-portrait oni-portrait-video" src="${esc(url)}" autoplay loop muted playsinline preload="auto"></video>`;
    }
    return `<img class="oni-portrait" src="${esc(url)}" alt="portrait">`;
  };

  const renderTypeAffinity = (affinities) => {
    const rows = [];
    for (let i = 1; i <= 9; i++) {
      const code = affinities?.[i];
      if (!["RS","VU","AB","IM"].includes(code)) continue;

      rows.push(`
        <div class="oni-inlineRow">
          <span class="oni-inlineName">${esc(affinityMap[i])}</span>
          <span class="oni-inlineVal">${esc(symbolMap[code] ?? code)}</span>
        </div>
      `);
    }
    return rows.length ? `<div class="oni-inlineGrid2">${rows.join("")}</div>` : `<div class="oni-muted">None</div>`;
  };

  const renderWeaponEff = (weaponEff) => {
    const rows = [];
    for (const wt of weaponTypes) {
      const effRaw = weaponEff?.[wt];
      if (effRaw == null || effRaw === "") continue;

      const eff = Number(effRaw);
      const effClass = eff > 100 ? "oni-effPos" : eff < 100 ? "oni-effNeg" : "oni-effNeu";
      const weaponLabel = capWord(wt);

      rows.push(`
        <div class="oni-inlineRow oni-inlineRowOneCol">
          <span class="oni-inlineName">
            <i
              class="fa-solid ${weaponIcons[wt]} oni-wepIcon"
              title="${esc(weaponLabel)}"
              data-tooltip="${esc(weaponLabel)}"
              data-tooltip-direction="UP"
            ></i>
            <span class="oni-eff ${effClass}"><b>${esc(eff)}%</b></span>
          </span>
        </div>
      `);
    }
    return rows.length ? `<div class="oni-inlineGrid2">${rows.join("")}</div>` : `<div class="oni-muted">None</div>`;
  };

  const renderConditionBadges = (conditionCodesByKey) => {
  const list = [];

  for (const cond of conditionList) {
    const code = conditionCodesByKey?.[cond.key];
    if (!["RS", "VU", "AB", "IM"].includes(code)) continue;

    const sym = symbolMap[code] ?? code;
    list.push(`<span class="oni-badge">${esc(sym)} ${esc(cond.label)}</span>`);
  }

  return list.length
    ? `<div class="oni-badgeWrap">${list.join("")}</div>`
    : `<div class="oni-muted">None</div>`;
};

  const renderStealList = (steal) => {
    if (!steal?.length) return `<div class="oni-muted">None</div>`;

    const FALLBACK_ICON = "icons/svg/item-bag.svg";

    const rows = steal.map((it) => {
      const iconSrc = it.img || FALLBACK_ICON;

     const linkUuid = String(it.openUuid ?? it.uuid ?? "").trim();

     const nameHtml = linkUuid
       ? `<a class="content-link" data-uuid="${esc(linkUuid)}" data-doc-uuid="${esc(linkUuid)}" draggable="true"><strong>${esc(it.name)}</strong></a>`
       : `<strong>${esc(it.name)}</strong>`;

      return `
        <div class="oni-itemPill">
          <img class="oni-itemicon" src="${esc(iconSrc)}" alt="item">
          <div class="oni-itemName">${nameHtml}</div>
        </div>
      `;
    }).join("");

    return `<div class="oni-itemPillWrap">${rows}</div>`;
  };

  // ✅ async now (so we can resolve item icons)
  const renderStudyCardHTML = async (targetTok, studyRoll, isReminder) => {
    ensureStudyCardStylesInstalled();

    const p = targetTok.actor?.system?.props ?? {};
    const { showIdentity, showStats, showDetails } = computeReveal(studyRoll);

    const v = (ok, value) => {
      const has = !(value == null || String(value) === "");
      return (ok && has) ? esc(value) : `<span class="oni-unknown">???</span>`;
    };

    const hpLine = isReminder
      ? `Max HP: ${v(showIdentity, p.max_hp)}`
      : `HP: ${v(showIdentity, `${p.current_hp}/${p.max_hp}`)}`;

    const mpLine = isReminder
      ? `Max MP: ${v(showIdentity, p.max_mp)}`
      : `MP: ${v(showIdentity, `${p.current_mp}/${p.max_mp}`)}`;

    const defVal  = (p.defense ?? p.current_def);
    const mdefVal = (p.magic_defense ?? p.current_mdef);

    const statsHTML = `
      <div class="oni-grid">
        <div>${hpLine}</div>
        <div>${mpLine}</div>
        <div><b>DEF:</b> ${v(showIdentity, defVal)}</div>
        <div><b>MDEF:</b> ${v(showIdentity, mdefVal)}</div>
      </div>

      <div class="oni-stats">
        <div><b>MIG:</b> ${v(showStats, p.mig_base)}</div>
        <div><b>DEX:</b> ${v(showStats, p.dex_base)}</div>
        <div><b>INS:</b> ${v(showStats, p.ins_base)}</div>
        <div><b>WLP:</b> ${v(showStats, p.wlp_base)}</div>
      </div>
    `;

    const affinities = {};
    for (let i = 1; i <= 9; i++) affinities[i] = p[`affinity_${i}`];

    const weaponEff = {};
    for (const wt of weaponTypes) weaponEff[wt] = p[`${wt}_ef`];

const conditionCodes = {};
for (const cond of conditionList) {
  conditionCodes[cond.key] = p[cond.key];
}

    const typeBox = showDetails
      ? sectionBox("Type Affinity", renderTypeAffinity(affinities))
      : sectionBox("Type Affinity", `<span class="oni-unknown">???</span>`);

    const wepBox = showDetails
      ? sectionBox("Weapon Efficiency", renderWeaponEff(weaponEff))
      : sectionBox("Weapon Efficiency", `<span class="oni-unknown">???</span>`);

    const condBox = showDetails
      ? sectionBox("Condition Immunities", renderConditionBadges(conditionCodes))
      : sectionBox("Condition Immunities", `<span class="oni-unknown">???</span>`);

    // ✅ Description: show as plain text (strip HTML tags)
    const descBox = showIdentity
      ? sectionBox("Description", renderPlainText(p.study_text ?? ""))
      : sectionBox("Description", `<span class="oni-unknown">???</span>`);

    // ✅ Stealable items ALWAYS visible + real item icons
    const stealItems = readStealListFromActor(targetTok.actor);
    await Promise.all(stealItems.map(async (it) => {
    it.img = await resolveStealItemIcon(targetTok.actor, it);
    it.openUuid = await resolveStealItemOpenUuid(targetTok.actor, it);
    }));

    const stealBlock = `
      <div class="oni-stealHeader">Stealable Items</div>
      ${renderStealList(stealItems)}
    `;

    const spriteUrl = getTokenPortraitSrc(targetTok);

    return `
      <div class="oni-studyCardRoot">
        <div class="oni-card">
          <div class="oni-card-header">
            ${renderPortrait(spriteUrl)}
            <div class="oni-card-title">
              <div class="oni-title">${esc(targetTok.actor?.name ?? targetTok.name ?? "Unknown")}</div>
              <div class="oni-sub">
                Type: ${v(showIdentity, p.species)}
                • Sub-Type: ${v(showIdentity, p.subtype_list)}
                • Attribute: ${v(showIdentity, p.attribute)}
              </div>
            </div>
          </div>

          ${statsHTML}
          ${typeBox}
          ${wepBox}
          ${condBox}
          ${descBox}

          <div class="oni-stealBlock">${stealBlock}</div>

          <div class="oni-footer">
            <span class="oni-muted">Study Roll:</span> <b>${esc(studyRoll)}</b>
            ${isReminder ? `<span class="oni-pill">Reminder</span>` : ``}
          </div>
        </div>
      </div>
    `;
  };

  // ───────────────────────────────────────────────────────────
  // Foundry target sync helper
  // ───────────────────────────────────────────────────────────
  const syncFoundryTargets = async (targetIds = []) => {
    const ids = Array.isArray(targetIds) ? targetIds.filter(Boolean) : [];

    if (game.user?.updateTokenTargets) {
      try { await game.user.updateTokenTargets(ids); return; }
      catch (e) { dbgw("updateTokenTargets failed, fallback", e); }
    }

    try {
      if (canvas?.tokens?.releaseAllTargets) canvas.tokens.releaseAllTargets();
      for (const id of ids) {
        const tok = canvas.tokens.get(id);
        if (tok?.setTarget) tok.setTarget(true, { releaseOthers: false });
      }
    } catch (e) {
      dbge("Fallback target set failed", e);
    }
  };

  /* ───────────────────── TOKEN GATHERING ───────────────────── */
  const enemyTokens = canvas.tokens.placeables.filter(t => t.document?.disposition === -1);
  if (!enemyTokens.length) return ui.notifications.warn("No enemies available to study.");

  const friendlyTokens = canvas.tokens.placeables.filter(t => t.document?.disposition !== -1);
  if (game.user.isGM && !friendlyTokens.length)
    return ui.notifications.warn("GM: there are no friendly/neutral tokens on the scene to act from.");

  const enemyIdSet = new Set(enemyTokens.map(t => t.id));
  const rawTargets = Array.from(game.user?.targets ?? []);
  const preSelectedTargetId = rawTargets
    .map(t => t?.id ?? t?.document?.id)
    .find(id => enemyIdSet.has(id)) || null;

  const targetListRows = Math.min(10, Math.max(4, enemyTokens.length));

  /* ───────────────────── BUILD THE DIALOG ───────────────────── */
  let dlgHTML = "";

  if (game.user.isGM) {
    dlgHTML += `<p><b>Acting character (GM only):</b><br>
      <select id="actingToken">
        ${friendlyTokens.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select></p>`;
  }

  dlgHTML += `
<p><b>Select a target to study:</b></p>
<select id="target" size="${targetListRows}" style="width:100%; font-size:14px; padding:6px;">
  ${enemyTokens.map(t => `<option value="${t.id}" ${preSelectedTargetId === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
</select>
<p style="opacity:.75;margin-top:6px;">Tip: changing the selection will also change your in-game target.</p>
`;

  dlgHTML += `
<p><b>Select study method:</b></p>
<input type="radio" name="stat" value="ins" checked> INS + INS<br>
<input type="radio" name="stat" value="wlp"> INS + WLP<br>
<p>Modifier: <input type="number" id="modifier" value="0" style="width:4em;"></p>
<p><label><input type="checkbox" id="reminder"> Reminder</label></p>`;

  const cursorMoveSound = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  new Sequence().sound(cursorMoveSound).play();

  const forceListboxSizing = (el, rows) => {
    if (!el) return;

    el.multiple = false;
    el.size = rows;

    const pxPerRow = 26;
    const desired = Math.max(4, rows) * pxPerRow;

    el.style.setProperty("height", `${desired}px`, "important");
    el.style.setProperty("min-height", `${desired}px`, "important");
    el.style.setProperty("overflow-y", "auto", "important");
    el.style.setProperty("appearance", "auto", "important");
  };

  /* ───────────────────── MAIN DIALOG ───────────────────── */
  new Dialog({
    title: "Study Target",
    content: dlgHTML,

    render: (html) => {
      const el = html[0]?.querySelector?.("#target");
      if (!el) return;

      forceListboxSizing(el, targetListRows);

      if (preSelectedTargetId) syncFoundryTargets([preSelectedTargetId]);

      el.addEventListener("change", async () => {
        el.focus();
        const v = String(el.value || "");
        AudioHelper.play({ src: cursorMoveSound, volume: 0.5, autoplay: true });
        if (v) await syncFoundryTargets([v]);
      });
    },

    buttons: {
      study: {
        label: "Study",
        callback: async (html) => {

          /* ---------- Resolve ACTING token ---------- */
          let actorToken;
          if (game.user.isGM) {
            const actingId = html.find("#actingToken").val();
            if (!actingId) return ui.notifications.warn("GM: no acting character selected.");
            actorToken = canvas.tokens.get(actingId);
            if (!actorToken) return ui.notifications.warn("Selected acting token not found.");
          } else {
            const assignedActor = game.user.character;
            if (!assignedActor) return ui.notifications.warn("You don’t have a character assigned in User Configuration.");
            actorToken = canvas.tokens.placeables.find(t => t.actor?.id === assignedActor.id);
            if (!actorToken) return ui.notifications.warn("Your character does not have an active token on this scene.");
          }

          /* ---------- Read dialog choices ---------- */
          const targetId    = html.find("#target").val();
          const statChoice  = html.find("input[name='stat']:checked").val();
          const modifier    = parseInt(html.find("#modifier").val()) || 0;
          const useReminder = html.find("#reminder").is(":checked");

          if (!targetId) return ui.notifications.warn("No target selected.");
          const targetTok = canvas.tokens.get(targetId);
          if (!targetTok) return ui.notifications.warn("Selected target not found.");

          await syncFoundryTargets([targetId]);

          /* ---------- OUTPUT MESSAGE BUILDER ---------- */
          const outputStudyResult = async (studyRoll, r1=null, r2=null, isReminder=false) => {

            if (!isReminder) {
              let headline = `<b>${targetTok.actor.name}</b> has been studied!<br>`;
              headline    += `🎲 Rolls: (${r1}, ${r2})<br>`;
              headline    += `📖 Study Check: <b>${studyRoll}</b>`;
              if (r1 === r2) {
                if (r1 >= 6)       headline += `<br><span style="color:green;font-weight:bold;">CRITICAL SUCCESS! Gains an Opportunity!</span>`;
                else if (r1 === 1) headline += `<br><span style="color:red;font-weight:bold;">FUMBLE! The attempt failed!</span>`;
              }
              new Sequence()
                .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Cursor_Confirm.mp3")
                .play();
              ChatMessage.create({
                user: game.user.id,
                speaker: ChatMessage.getSpeaker({actor: actorToken.actor}),
                content: headline
              });
            }

            // ✅ async render (for steal icons)
            const cardHTML = await renderStudyCardHTML(targetTok, studyRoll, isReminder);

            ChatMessage.create({
              user: game.user.id,
              speaker: ChatMessage.getSpeaker({actor: actorToken.actor}),
              content: cardHTML
            });
          };

          if (useReminder) {
            new Sequence()
              .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Book1.ogg")
              .play();
            outputStudyResult(99, null, null, true);
            return;
          }

          new Sequence().effect()
            .file("modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm")
            .atLocation(targetTok)
            .duration(4000)
            .opacity(0.7)
            .scale(0.5)
            .play();

          new Sequence()
            .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg")
            .play();

          setTimeout(() => {
            const insCurrent = actorToken.actor.system.props.ins_current;
            const wlpCurrent = actorToken.actor.system.props.wlp_current;
            const statPool   = (statChoice === "ins") ? insCurrent : (insCurrent + wlpCurrent);

            const r1    = Math.ceil(Math.random() * statPool);
            const r2    = Math.ceil(Math.random() * statPool);
            const total = Math.max(r1 + r2 + modifier, 7);

            outputStudyResult(total, r1, r2);
          }, 4000);
        }
      },
      cancel: { label: "Cancel" }
    }
  }).render(true);

})();
