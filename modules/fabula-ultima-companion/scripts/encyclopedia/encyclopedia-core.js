/**
 * Monster Encyclopedia — encyclopedia-core
 *
 * One world JournalEntry ("Monster Encyclopedia"); one page per studied NPC,
 * keyed by actor prototype UUID. Page body is tier-masked HTML rendered from
 * live actor.system.props each time recordResult lands a new best.
 *
 * Reveal tiers (party-wide best Study Check result):
 *   ≥ 7  — Identity:  Type, Sub-Type, Attribute, Rank, Level, HP/MP, DEF/MDEF,
 *                     Traits, study_text, Stealable Items.
 *   ≥ 8  — Stats:     MIG / DEX / INS / WLP base dice.
 *   ≥ 13 — Details:   Type Affinities, Weapon Efficiency, Condition Affinities,
 *                     basic Attacks, Special Abilities.
 *   <  7 — Unstudied: locked placeholder + reveal-tier guide.
 *
 * Public API at FUCompanion.api.encyclopedia:
 *
 *   getEntry()                          → JournalEntry (auto-creates if GM)
 *   getPageForActor(actorUuid)          → Page | null
 *   upsertPage(actorUuid)               → Page (creates placeholder if missing)
 *   recordResult({ actorUuid, total,    → { previousBest, newBest, changed }
 *                  studierActorId,
 *                  isCrit, isFumble })
 *   renderPage(actorUuid)               → Promise<string> (HTML body)
 *   getStudySkill()                     → Item (the world Study skill, auto-
 *                                         created on first GM boot)
 *   getStudySkillUuid()                 → string | null (same, just the UUID)
 *
 * Boot-time (GM only, fires from the `ready` hook):
 *   1. Ensure the "Monster Encyclopedia" world JournalEntry exists; create
 *      with Observer permission if missing. UUID cached in a world setting.
 *   2. Ensure the world Study skill exists; if missing, invoke the
 *      `CreateSkillFromSpec` macro with an inline canonical spec. UUID
 *      cached in a world setting. The Study macro + this script's hook
 *      listener both resolve the skill via getStudySkillUuid() so no caller
 *      ever hardcodes a world-specific Item UUID.
 *
 * Page flag (flags."fabula-ultima-companion".encyclopedia):
 *   { actorUuid, bestResult, bestResultBy, lastUpdated, isPlaceholder }
 *
 * Hook on successful recordResult:
 *   "oni:encyclopedia:updated"  { actorUuid, previousBest, newBest, changed }
 *
 * Permissioning: writes (upsertPage / recordResult, plus boot-time creation
 * of the entry and Study skill) require GM. Non-GM calls log a warning and
 * return null. The `oni:action:resolved` listener routes player Confirm
 * writes through gm-executor so they still land.
 */
(() => {
  const TAG = "[ONI][Encyclopedia]";
  const MODULE_ID = "fabula-ultima-companion";
  const SETTING_KEY = "encyclopediaJournalUuid";
  const STUDY_SETTING_KEY = "studySkillUuid";
  const ENTRY_NAME = "Monster Encyclopedia";
  const STUDY_SKILL_NAME = "Study";
  const FLAG_NAMESPACE = MODULE_ID;
  const FLAG_KEY = "encyclopedia";

  const TIER_IDENTITY = 7;
  const TIER_STATS    = 8;
  const TIER_DETAILS  = 13;

  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const ANIM_STYLE_ID  = "oni-encyclopedia-anim-styles";
  const ANIM_CLASS     = "oni-enc-unlocking";
  const ANIM_DURATION_MS = 1000; // keep in sync with the CSS keyframe

  /**
   * Canonical spec for the world Study skill. Used by ensureStudySkill at
   * boot to auto-provision the skill in any world that doesn't already have
   * one. The skill props match the original CreateSkillFromSpec payload from
   * phase 1 — `damage_bonus: ""` puts the action on the check-only path,
   * `ignore_hr: true` skips the HR add since Open Checks don't use it.
   */
  const STUDY_SKILL_SPEC = {
    name: STUDY_SKILL_NAME,
    img: "icons/sundries/books/book-eye-purple.webp",
    props: {
      skill_type: "Active",
      isCheck: true,
      isOffensiveSpell: false,
      rolled_atr1: "INS",
      rolled_atr2: "INS",
      damage_bonus: "",
      type_damage: "",
      skill_target: "One creature",
      skill_range: "Sight",
      cost: "",
      check_bonus: "0",
      ignore_hr: true,
      description: "<p>Focus your attention on a creature to learn about its profile. Make an Open Check (INS+INS, or INS+WLP for inquiry-based studies). Result thresholds reveal progressively more about the target. Each successful study updates the party-wide Monster Encyclopedia with the highest result achieved so far.</p>"
    }
  };

  const ATTACK_ICON   = "icons/svg/sword.svg";
  const ABILITY_ICON  = "icons/svg/aura.svg";
  const STEAL_ICON    = "icons/svg/item-bag.svg";
  const PORTRAIT_FALLBACK = "icons/svg/mystery-man.svg";
  const SPELL_ICON    = "icons/svg/fire.svg";

  // ───────────────────── Page style injection ─────────────────────
  const PAGE_STYLE_ID = "oni-enc-card-styles";

  function ensurePageStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PAGE_STYLE_ID;
    style.textContent = `
.oni-enc-root { font-family: Signika, sans-serif; font-size: 14px; color: #2b241a; }
.oni-enc-card { background: linear-gradient(160deg, #f5f3f0 0%, #ece9e5 100%); border: 2px solid #c2bab0; border-radius: 14px; padding: 16px; box-shadow: 0 3px 14px rgba(0,0,0,.14); box-sizing: border-box; }
.oni-enc-header { display:flex; gap:12px; align-items:flex-start; margin-bottom:12px; }
.oni-enc-portrait { width:92px; height:92px; object-fit:contain; border:none !important; outline:none !important; box-shadow:none !important; background:transparent !important; display:block; flex:0 0 auto; }
.oni-enc-title { font-size:24px; font-weight:900; line-height:1.15; }
.oni-enc-sub { margin-top:4px; opacity:.8; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.oni-enc-traits-sub { margin-top:4px; font-size:12px; opacity:.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-style:italic; }
.oni-enc-desc-inline { flex:0 0 auto; max-width:340px; max-height:100px; overflow-y:auto; font-size:12px; line-height:1.5; border:1px solid rgba(0,0,0,.12); border-radius:8px; padding:8px 10px; background:rgba(255,255,255,.28); }
.oni-enc-stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px 12px; margin-top:6px; }
.oni-enc-stat-row { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid rgba(0,0,0,.14); border-radius:8px; overflow:hidden; margin-top:6px; }
.oni-enc-stat-cell { padding:8px 6px; text-align:center; border-right:1px solid rgba(0,0,0,.12); background:rgba(255,255,255,.22); }
.oni-enc-stat-cell:last-child { border-right:none; }
.oni-enc-box { margin:10px 0; border:1px solid rgba(0,0,0,.12); background:rgba(255,255,255,.26); border-radius:10px; padding:10px 12px; box-sizing:border-box; }
.oni-enc-box-title { font-weight:900; font-size:14px; opacity:.75; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid rgba(0,0,0,.12); padding-bottom:6px; margin-bottom:8px; }
.oni-enc-badge-wrap { display:flex; flex-wrap:wrap; gap:6px; }
.oni-enc-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:999px; border:1px solid rgba(0,0,0,.14); background:rgba(255,255,255,.42); font-weight:700; font-size:13px; white-space:nowrap; }
.oni-enc-2col { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 16px; }
.oni-enc-2col-row { display:flex; align-items:center; gap:6px; min-width:0; cursor:default; }
.oni-enc-2col-label { font-weight:700; min-width:0; flex:0 0 auto; }
.oni-enc-2col-pct { flex:1; }
.oni-enc-eff-pos { color:#1f7a3a; font-weight:700; }
.oni-enc-eff-neg { color:#b02a2a; font-weight:700; }
.oni-enc-ability-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
.oni-enc-ability-item { display:flex; align-items:flex-start; gap:7px; padding:5px 8px; border:1px solid rgba(0,0,0,.1); border-radius:7px; background:rgba(255,255,255,.36); }
.oni-enc-ability-item p { margin: 3px 0; }
.oni-enc-ability-item ul { padding-left: 18px; margin: 3px 0; }
.oni-enc-ability-item li { margin: 2px 0; }
.oni-enc-ability-icon { width:24px; height:24px; object-fit:contain; border:none !important; outline:none !important; box-shadow:none !important; background:transparent !important; flex:0 0 auto; margin-top:2px; }
.oni-enc-atr-icon { width:26px; height:26px; object-fit:contain; border:none !important; outline:none !important; box-shadow:none !important; background:transparent !important; display:block; margin:0 auto 3px; cursor:default; }
.oni-enc-muted { opacity:.65; font-style:italic; }
.oni-enc-footer { margin-top:10px; padding-top:8px; border-top:1px solid rgba(0,0,0,.12); opacity:.65; font-size:11px; }
    `.trim();
    document.head.appendChild(style);
  }

  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};

  if (globalThis.FUCompanion.api.encyclopedia) {
    console.debug(`${TAG} Already installed.`);
    return;
  }

  // ───────────────────── Settings / Entry resolution ─────────────────────
  function registerSetting() {
    try {
      game.settings.register(MODULE_ID, SETTING_KEY, {
        name: "Monster Encyclopedia Journal UUID",
        hint: "Cached UUID of the world Journal Entry used by the Monster Encyclopedia.",
        scope: "world",
        config: false,
        type: String,
        default: ""
      });
    } catch (e) { /* already registered — fine */ }

    try {
      game.settings.register(MODULE_ID, STUDY_SETTING_KEY, {
        name: "Study Skill UUID",
        hint: "Cached UUID of the world Study skill (auto-created on first boot if missing).",
        scope: "world",
        config: false,
        type: String,
        default: ""
      });
    } catch (e) { /* already registered — fine */ }
  }

  function getCachedUuid() {
    try { return String(game.settings.get(MODULE_ID, SETTING_KEY) ?? ""); }
    catch { return ""; }
  }

  async function setCachedUuid(uuid) {
    try { await game.settings.set(MODULE_ID, SETTING_KEY, String(uuid ?? "")); }
    catch (e) { console.warn(TAG, "Failed to cache journal UUID:", e); }
  }

  function getCachedStudySkillUuid() {
    try { return String(game.settings.get(MODULE_ID, STUDY_SETTING_KEY) ?? ""); }
    catch { return ""; }
  }

  async function setCachedStudySkillUuid(uuid) {
    try { await game.settings.set(MODULE_ID, STUDY_SETTING_KEY, String(uuid ?? "")); }
    catch (e) { console.warn(TAG, "Failed to cache Study skill UUID:", e); }
  }

  async function findEntry() {
    const cached = getCachedUuid();
    if (cached) {
      try {
        const doc = await fromUuid(cached);
        if (doc?.documentName === "JournalEntry") return doc;
      } catch { /* fall through */ }
    }
    const byName = game.journal?.getName?.(ENTRY_NAME);
    if (byName) {
      if (byName.uuid !== cached) await setCachedUuid(byName.uuid);
      return byName;
    }
    return null;
  }

  async function createEntry() {
    if (!game.user?.isGM) { console.warn(`${TAG} createEntry refused: GM only.`); return null; }
    const entry = await JournalEntry.create({
      name: ENTRY_NAME,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: []
    });
    await setCachedUuid(entry.uuid);
    console.info(`${TAG} Created "${ENTRY_NAME}" entry at ${entry.uuid}`);
    return entry;
  }

  async function getEntry() {
    let entry = await findEntry();
    if (entry) return entry;
    if (game.user?.isGM) entry = await createEntry();
    return entry;
  }

  // ───────────────────── Study skill resolution ─────────────────────
  /**
   * Try to find the world Study skill. Resolution order:
   *   1. Cached UUID from the world setting (fastest, survives renames).
   *   2. World Item with name === STUDY_SKILL_NAME and the expected
   *      check-only-Active shape (so we don't false-match a player-authored
   *      "Study" item that happens to share the name).
   * Returns the Item document or null. Does NOT create.
   */
  async function findStudySkill() {
    const cached = getCachedStudySkillUuid();
    if (cached) {
      try {
        const doc = await fromUuid(cached);
        if (doc?.documentName === "Item") return doc;
      } catch { /* fall through */ }
    }

    const byName = game.items?.find?.(i => {
      if (!i || i.name !== STUDY_SKILL_NAME) return false;
      const p = i.system?.props ?? {};
      // Must look like the Study skill — Active, isCheck, no damage.
      return p.skill_type === "Active"
        && !!p.isCheck
        && (p.damage_bonus === "" || p.damage_bonus == null);
    });
    if (byName) {
      if (byName.uuid !== cached) await setCachedStudySkillUuid(byName.uuid);
      return byName;
    }

    return null;
  }

  async function createStudySkill() {
    if (!game.user?.isGM) {
      console.warn(`${TAG} createStudySkill refused: GM only.`);
      return null;
    }
    const createMacro = game.macros?.getName?.("CreateSkillFromSpec");
    if (!createMacro) {
      console.error(`${TAG} CreateSkillFromSpec macro not found. Cannot auto-create the Study skill.`);
      return null;
    }
    let result = null;
    try {
      result = await createMacro.execute({ __AUTO: true, __PAYLOAD: { spec: STUDY_SKILL_SPEC } });
    } catch (e) {
      console.error(`${TAG} createStudySkill: CreateSkillFromSpec threw:`, e);
      return null;
    }
    if (!result?.ok || !result?.uuid) {
      console.error(`${TAG} createStudySkill: CreateSkillFromSpec failed.`, result);
      return null;
    }
    await setCachedStudySkillUuid(result.uuid);
    console.info(`${TAG} Created Study skill at ${result.uuid}.`);
    let doc = null;
    try { doc = await fromUuid(result.uuid); } catch { /* tolerate */ }
    return doc;
  }

  /**
   * Resolve the world Study skill, creating it (GM only) if missing. This is
   * the public lookup the macro + hook listener both use — never bake a
   * world-specific UUID into a caller again. Returns the Item document or
   * null if non-GM and not yet provisioned.
   */
  async function getStudySkill() {
    let doc = await findStudySkill();
    if (doc) return doc;
    if (game.user?.isGM) doc = await createStudySkill();
    return doc;
  }

  async function getStudySkillUuid() {
    const doc = await getStudySkill();
    return doc?.uuid ?? null;
  }

  // ───────────────────── Page helpers ─────────────────────
  function getFlag(page, key) {
    return foundry.utils.getProperty(page, `flags.${FLAG_NAMESPACE}.${FLAG_KEY}.${key}`);
  }

  function getPageForActor(actorUuid) {
    if (!actorUuid) return null;
    const cached = getCachedUuid();
    const entry = cached ? game.journal?.get?.(cached.split(".").pop()) : null;
    const resolvedEntry = entry ?? game.journal?.getName?.(ENTRY_NAME) ?? null;
    if (!resolvedEntry) return null;
    for (const page of resolvedEntry.pages) {
      if (getFlag(page, "actorUuid") === actorUuid) return page;
    }
    return null;
  }

  function pageNameForActor(actor) {
    return actor?.name || "Unknown Monster";
  }

  // ───────────────────── Render — escape + sanitize ─────────────────────
  const ESC = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  /**
   * Preserve structural HTML + content-links from CSB-stored descriptions
   * but strip the inline `style="..."` cruft that fights journal-page CSS.
   * Also strips a few accessibility attributes that get inserted by tooltips
   * and serialize back into the saved HTML.
   */
  function sanitizeRichHtml(raw) {
    return String(raw ?? "")
      .replace(/\s+style="[^"]*"/gi, "")
      .replace(/\s+aria-describedby="[^"]*"/gi, "")
      .replace(/\s+role="[^"]*"/gi, "")
      .trim();
  }

  // Used when we *do* want plaintext — fallback for fields that may contain
  // raw HTML but only need to be quoted briefly (currently unused; kept for
  // future minimal-form contexts).
  const HTML_TO_PLAIN = (h) => String(h ?? "")
    .replace(/<\/(p|div|li|br|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function renderSection(title, innerHtml, tier = null) {
    const tierAttr = tier ? ` data-enc-tier="${ESC(tier)}"` : "";
    return `
<section${tierAttr}>
  <div class="oni-enc-box">
    <div class="oni-enc-box-title">${ESC(title)}</div>
    <div>${innerHtml}</div>
  </div>
</section>`;
  }

  // ───────────────────── Constants ─────────────────────
  const AFFINITY_NAME = { 1: "Physical", 2: "Air", 3: "Bolt", 4: "Dark", 5: "Earth", 6: "Fire", 7: "Ice", 8: "Light", 9: "Poison" };
  const AFFINITY_SYM  = { RS: "🛡 Resist", VU: "💥 Vulnerable", AB: "♻ Absorb", IM: "🚫 Immune" };
  const NEUTRAL_LABEL = `<span style="opacity:.55;">— Neutral —</span>`;
  const WEAPON_TYPES  = ["arcane", "bow", "brawling", "dagger", "firearm", "flail", "heavy", "spear", "sword", "thrown"];
  const CONDITIONS    = [
    "slow","dazed","weak","shaken","poisoned","enraged","silence","stagger",
    "frightened","paralyzed","confused","panic","grappled","envenomed","burn",
    "blind","zombie","wither","bleed","obscure","fatigue","charm","berserk",
    "despair","doom","bane","curse","wet","oil","petrify","hypothermia",
    "turbulence","delayed","isolate","suppress","disarmed","anomaly"
  ];

  function objectToList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (typeof raw === "object") return Object.values(raw).filter(Boolean);
    return [];
  }

  function isEmptyLootEntry(entry) {
    const n = String(entry?.name ?? "").trim().toLowerCase();
    return n === "(empty)" || n === "empty";
  }

  /**
   * Resolve an entry from `attack_list` / `skill_active_list` to the embedded
   * Item document. The entry's `.id` field is the literal CSB template string
   * "${item.id}" until expanded, so we ignore it and use the uuid suffix.
   */
  function resolveEmbeddedItem(actor, entry) {
    if (!actor || !entry) return null;
    const uuid = String(entry.uuid ?? "").trim();
    if (uuid) {
      const id = uuid.split(".").pop();
      if (id) {
        const item = actor.items.get(id);
        if (item) return item;
      }
    }
    return null;
  }

  /**
   * Stealable entries point at the actor's embedded copy of the loot item.
   * Redirect to the world-item master so clicking the link opens the real
   * item sheet instead of dead-ending on an embedded copy.
   */
  async function resolveStealItemOpenUuid(entry) {
    const rawUuid = String(entry?.uuid ?? entry?.item_uuid ?? "").trim();
    if (!rawUuid) return "";
    try {
      const doc = await fromUuid(rawUuid);
      if (!doc) return rawUuid;
      if (doc.documentName !== "Item") return rawUuid;

      const parentIsActor = doc.parent?.documentName === "Actor";
      if (!parentIsActor) return doc.uuid ?? rawUuid;

      const compendiumSource = String(doc?._stats?.compendiumSource ?? "").trim();
      if (compendiumSource.startsWith("Item.")) return compendiumSource;

      const uniqueId = String(doc?.system?.uniqueId ?? doc?.uniqueId ?? "").trim();
      if (uniqueId) {
        const exact = game.items?.get(uniqueId);
        if (exact?.uuid) return exact.uuid;
        const byUniqueId = game.items?.find(i =>
          String(i?.system?.uniqueId ?? i?.uniqueId ?? "").trim() === uniqueId
        );
        if (byUniqueId?.uuid) return byUniqueId.uuid;
        return `Item.${uniqueId}`;
      }

      const nameLower = String(doc?.name ?? entry?.name ?? "").trim().toLowerCase();
      if (nameLower) {
        const byName = game.items?.find(i =>
          String(i?.name ?? "").trim().toLowerCase() === nameLower
        );
        if (byName?.uuid) return byName.uuid;
      }
      return rawUuid;
    } catch { return rawUuid; }
  }

  // ───────────────────── Render — primitives ─────────────────────
  function renderHeader(actor, p, showMeta, descHtml = null, traitsText = null) {
    let metaHtml, traitsHtml;
    if (showMeta) {
      const lvPart  = p.level ? `Lv ${ESC(p.level)} · ` : "";
      const type    = ESC(p.species      || "—");
      const subtype = ESC(p.subtype_list || "—");
      const attr    = ESC(p.attribute    || "—");
      metaHtml  = `${lvPart}Type: ${type} · Sub-Type: ${subtype} · Attribute: ${attr}`;
      traitsHtml = traitsText ? `<div class="oni-enc-traits-sub">${ESC(traitsText)}</div>` : "";
    } else {
      metaHtml  = `<span class="oni-enc-muted">Level · Species · Attribute unknown</span>`;
      traitsHtml = "";
    }
    const descBlock = descHtml
      ? `\n  <div class="oni-enc-desc-inline">${descHtml}</div>`
      : "";
    return `
<div class="oni-enc-header">
  <img class="oni-enc-portrait" src="${ESC(actor.img || PORTRAIT_FALLBACK)}" alt="">
  <div style="flex:1;min-width:0;">
    <div class="oni-enc-title">${ESC(actor.name ?? "Unknown")}</div>
    <div class="oni-enc-sub">${metaHtml}</div>
    ${traitsHtml}
  </div>${descBlock}
</div>`;
  }

  function renderTierSection(tierLabel, threshold, showTier, innerHtml) {
    if (showTier) return innerHtml;
    return renderLockedPlaceholder(tierLabel, threshold);
  }

  function renderLockedPlaceholder(label, threshold) {
    return `<div class="oni-enc-box" style="text-align:center;padding:18px 12px;background:rgba(0,0,0,.04);border-style:dashed;">
  <div style="font-size:26px;line-height:1;opacity:.35;margin-bottom:6px;">🔒</div>
  <div style="font-weight:900;font-size:14px;margin-bottom:4px;">${ESC(label)}</div>
  <div style="font-size:12px;opacity:.75;">Requires a Study Check of <strong>${threshold}+</strong> to reveal.</div>
</div>`;
  }

  function renderCoreStatsBlock(p) {
    return renderSection("Vital Statistics", `
<div class="oni-enc-stat-grid">
  <div><b>Max HP:</b> ${ESC(p.max_hp ?? "—")}</div>
  <div><b>DEF:</b> ${ESC(p.defense ?? "—")}</div>
  <div><b>Max MP:</b> ${ESC(p.max_mp ?? "—")}</div>
  <div><b>MDEF:</b> ${ESC(p.magic_defense ?? "—")}</div>
</div>`, "identity");
  }

  function renderDescription(p) {
    const html = sanitizeRichHtml(p.study_text ?? "");
    return renderSection("Description", html || `<p style="margin:0;"><em>No description.</em></p>`, "identity");
  }

  function renderTraits(p) {
    const html = sanitizeRichHtml(p.traits ?? "");
    return renderSection("Traits", html || `<p style="margin:0;"><em>None recorded.</em></p>`, "identity");
  }

  function renderAttributesBlock(p) {
    const stat = (label, v) => `
<div class="oni-enc-stat-cell">
  <img class="oni-enc-atr-icon" src="${ATR_ICONS[label]}" title="${label}" alt="${label}">
  <div style="font-size:16px;font-weight:900;">${v != null ? ESC(String(v)) : "—"}</div>
</div>`;
    return renderSection("Attributes", `<div class="oni-enc-stat-row">${stat("MIG", p.mig_base)}${stat("DEX", p.dex_base)}${stat("INS", p.ins_base)}${stat("WLP", p.wlp_base)}</div>`, "stats");
  }

  const AFF_SYM = { RS: "🛡", VU: "💥", AB: "♻", IM: "🚫" };
  const WEP_ICONS = { arcane:"fa-book", bow:"fa-bow-arrow", brawling:"fa-hand-fist", dagger:"fa-dagger", firearm:"fa-gun", flail:"fa-mace", heavy:"fa-hammer-war", spear:"fa-location-arrow", sword:"fa-sword", thrown:"fa-bomb" };
  const ATR_ICONS = {
    MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
    DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
    INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
    WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
  };

  function renderAffinities(p) {
    const badges = [];
    for (let i = 1; i <= 9; i++) {
      const code = p[`affinity_${i}`];
      if (!["RS","VU","AB","IM"].includes(code)) continue;
      badges.push(`<span class="oni-enc-badge">${AFF_SYM[code]} ${ESC(AFFINITY_NAME[i])}</span>`);
    }
    const body = badges.length
      ? `<div class="oni-enc-badge-wrap">${badges.join("")}</div>`
      : `<p style="margin:0;" class="oni-enc-muted">No special affinities.</p>`;
    return renderSection("Type Affinities", body, "details");
  }

  function renderWeaponEff(p) {
    const rows = [];
    for (const wt of WEAPON_TYPES) {
      const raw = Number(p[`${wt}_ef`]);
      const val = Number.isFinite(raw) ? raw : 100;
      const label = wt[0].toUpperCase() + wt.slice(1);
      const isNeutral = val === 100;
      const cls = !isNeutral ? (val > 100 ? "oni-enc-eff-pos" : "oni-enc-eff-neg") : "";
      const rowStyle = isNeutral ? ` style="opacity:.42;"` : "";
      rows.push(`
<div class="oni-enc-2col-row"${rowStyle} title="${ESC(label)}">
  <span class="oni-enc-2col-label"><i class="fa-solid ${WEP_ICONS[wt]}"></i></span>
  <span class="oni-enc-2col-pct${cls ? ` ${cls}` : ""}">${ESC(val)}%</span>
</div>`);
    }
    return renderSection("Weapon Efficiency", `<div class="oni-enc-2col">${rows.join("")}</div>`, "details");
  }

  function renderConditionBadges(p) {
    const badges = [];
    for (const c of CONDITIONS) {
      const code = p[`condition_${c}`];
      if (!["RS","VU","AB","IM"].includes(code)) continue;
      const label = c[0].toUpperCase() + c.slice(1);
      badges.push(`<span class="oni-enc-badge">${AFF_SYM[code]} ${ESC(label)}</span>`);
    }
    const body = badges.length
      ? `<div class="oni-enc-badge-wrap">${badges.join("")}</div>`
      : `<p style="margin:0;" class="oni-enc-muted">No condition affinities.</p>`;
    return renderSection("Condition Affinities", body, "details");
  }

  const ACTION_LI = `style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;"`;
  const ACTION_ICON = `style="width:28px;height:28px;object-fit:contain;border:0;flex:0 0 auto;margin-top:2px;"`;
  const ACTION_UL  = `style="margin:0;padding:0;list-style:none;"`;

  function renderAttackEntry(actor, entry, fmt = "new") {
    const name = ESC(fmt === "new" ? (entry?.name ?? "Unknown") : (entry?.basic_name ?? entry?.name ?? "Unknown"));
    const item = fmt === "new" ? resolveEmbeddedItem(actor, entry) : null;
    const img = item?.img || ATTACK_ICON;
    const atr1 = entry?.attribute_die1 ?? entry?.attrib_1 ?? null;
    const atr2 = entry?.attribute_die2 ?? entry?.attrib_2 ?? null;
    const formula = atr1 && atr2 ? ESC(`${atr1} + ${atr2}`) : null;
    const desc = sanitizeRichHtml(entry?.attack_description ?? entry?.detail ?? "");
    return `<li ${ACTION_LI}><img ${ACTION_ICON} src="${ESC(img)}" alt="">
  <div style="flex:1;min-width:0;">
    <div><strong>${name}</strong>${formula ? ` &middot; <span style="opacity:.75;">${formula}</span>` : ""}</div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div></li>`;
  }

  function renderAbilityEntry(actor, entry, fmt = "new") {
    const name = ESC(fmt === "new" ? (entry?.name ?? "Unknown") : (entry?.special_name ?? entry?.name ?? "Unknown"));
    const item = fmt === "new" ? resolveEmbeddedItem(actor, entry) : null;
    const img = item?.img || ABILITY_ICON;
    const cost = entry?.active_cost ?? null;
    const meta = cost && cost !== "-" ? ESC(cost) : null;
    const desc = sanitizeRichHtml(entry?.active_description ?? entry?.details ?? entry?.detail ?? "");
    return `<li ${ACTION_LI}><img ${ACTION_ICON} src="${ESC(img)}" alt="">
  <div style="flex:1;min-width:0;">
    <div><strong>${name}</strong>${meta ? ` &middot; <span style="opacity:.75;">${meta}</span>` : ""}</div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div></li>`;
  }

  function renderPassiveEntry(actor, entry, fmt = "new") {
    const name = ESC(fmt === "new" ? (entry?.name ?? "Unknown") : (entry?.other_name ?? entry?.name ?? "Unknown"));
    const item = fmt === "new" ? resolveEmbeddedItem(actor, entry) : null;
    const img = item?.img || ABILITY_ICON;
    const desc = sanitizeRichHtml(entry?.passive_description ?? entry?.details ?? entry?.detail ?? "");
    return `<li ${ACTION_LI}><img ${ACTION_ICON} src="${ESC(img)}" alt="">
  <div style="flex:1;min-width:0;">
    <div><strong>${name}</strong></div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div></li>`;
  }

  function renderSpellEntry(actor, entry, fmt = "new") {
    const name = ESC(fmt === "new" ? (entry?.name ?? "Unknown") : (entry?.spell_name ?? entry?.name ?? "Unknown"));
    const item = fmt === "new" ? resolveEmbeddedItem(actor, entry) : null;
    const img = item?.img || SPELL_ICON;
    const cost = entry?.cost ?? null;
    const meta = cost && cost !== "-" ? ESC(cost) : null;
    const desc = sanitizeRichHtml(entry?.spell_description ?? entry?.details ?? entry?.detail ?? "");
    return `<li ${ACTION_LI}><img ${ACTION_ICON} src="${ESC(img)}" alt="">
  <div style="flex:1;min-width:0;">
    <div><strong>${name}</strong>${meta ? ` &middot; <span style="opacity:.75;">${meta}</span>` : ""}</div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div></li>`;
  }

  function renderActionHeader() {
    return `<div style="margin:20px 0 -2px;">
  <div style="font-size:17px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;border-bottom:2px solid rgba(0,0,0,.18);padding-bottom:8px;opacity:.75;">Actions</div>
</div>`;
  }

  function renderActionSection(title, innerHtml) {
    return `<section data-enc-tier="details" style="margin:10px 0;padding:12px 14px;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.1);border-radius:8px;">
  <h3 style="margin:0 0 8px;border:0;padding-bottom:6px;border-bottom:1px solid rgba(0,0,0,.1);font-size:15px;">${ESC(title)}</h3>
  <div>${innerHtml}</div>
</section>`;
  }

  function renderAttacks(actor, p) {
    const newList = objectToList(p.attack_list).filter(e => !e?.$deleted);
    if (newList.length)
      return renderActionSection("Basic Attacks", `<ul ${ACTION_UL}>${newList.map(e => renderAttackEntry(actor, e, "new")).join("")}</ul>`);
    const oldList = objectToList(p.basic_attacks).filter(e => !e?.$deleted);
    if (!oldList.length) return null;
    return renderActionSection("Basic Attacks", `<ul ${ACTION_UL}>${oldList.map(e => renderAttackEntry(actor, e, "old")).join("")}</ul>`);
  }

  function renderActiveSkills(actor, p) {
    const newList = objectToList(p.skill_active_list).filter(e => !e?.$deleted);
    if (newList.length)
      return renderActionSection("Skills", `<ul ${ACTION_UL}>${newList.map(e => renderAbilityEntry(actor, e, "new")).join("")}</ul>`);
    const oldList = objectToList(p.special_list).filter(e => !e?.$deleted);
    if (!oldList.length) return null;
    return renderActionSection("Skills", `<ul ${ACTION_UL}>${oldList.map(e => renderAbilityEntry(actor, e, "old")).join("")}</ul>`);
  }

  function renderPassiveSkills(actor, p) {
    const newList = objectToList(p.skill_passive_list).filter(e => !e?.$deleted);
    if (newList.length)
      return renderActionSection("Passive", `<ul ${ACTION_UL}>${newList.map(e => renderPassiveEntry(actor, e, "new")).join("")}</ul>`);
    const oldList = objectToList(p.other_list).filter(e => !e?.$deleted);
    if (!oldList.length) return null;
    return renderActionSection("Passive", `<ul ${ACTION_UL}>${oldList.map(e => renderPassiveEntry(actor, e, "old")).join("")}</ul>`);
  }

  function renderSpells(actor, p) {
    const newList = objectToList(p.normal_spell_list).filter(e => !e?.$deleted);
    if (newList.length)
      return renderActionSection("Spells", `<ul ${ACTION_UL}>${newList.map(e => renderSpellEntry(actor, e, "new")).join("")}</ul>`);
    const oldList = objectToList(p.spell_list).filter(e => !e?.$deleted);
    if (!oldList.length) return null;
    return renderActionSection("Spells", `<ul ${ACTION_UL}>${oldList.map(e => renderSpellEntry(actor, e, "old")).join("")}</ul>`);
  }

  async function renderStealables(actor, p) {
    const raw = p.stealable_loot ?? p.stealable_equipment ?? {};
    const entries = objectToList(raw).filter(e => !isEmptyLootEntry(e));

    const rows = await Promise.all(entries.map(async (e) => {
      const name = String(e?.name ?? "?");
      const openUuid = await resolveStealItemOpenUuid(e);
      const labelHtml = openUuid ? `@UUID[${openUuid}]{${name}}` : `<strong>${ESC(name)}</strong>`;

      // Embedded copy's img (best available) → fallback to default.
      const embeddedId = String(e?.uuid ?? "").split(".").pop();
      const embedded = embeddedId ? actor.items.get(embeddedId) : null;
      const img = embedded?.img || STEAL_ICON;

      const desc = sanitizeRichHtml(e?.loot_description ?? e?.description ?? "");

      return `
<li class="oni-enc-ability-item">
  <img class="oni-enc-ability-icon" src="${ESC(img)}" alt="">
  <div style="flex:1;min-width:0;">
    <div>${labelHtml}</div>
    ${desc ? `<div style="margin-top:3px;font-size:12px;opacity:.82;">${desc}</div>` : ""}
  </div>
</li>`;
    }));

    const body = rows.length
      ? `<ul class="oni-enc-ability-list">${rows.join("")}</ul>`
      : `<p style="margin:0;" class="oni-enc-muted">Nothing of value.</p>`;
    return renderSection("Stealable Items", body, "identity");
  }

  function renderUnstudied() {
    return `
<div class="oni-enc-box" style="text-align:center;padding:18px 20px;">
  <div style="font-size:32px;line-height:1;margin-bottom:8px;opacity:.7;">🔒</div>
  <div style="font-weight:900;margin-bottom:6px;">Unstudied Monster</div>
  <p style="margin:6px 0;opacity:.85;font-size:13px;">Your party hasn't successfully studied this creature yet. Use the <strong>Study</strong> action during combat to begin filling in this entry.</p>
  <ul style="display:inline-block;text-align:left;margin:8px auto;font-size:12px;opacity:.85;">
    <li>Study result <strong>${TIER_IDENTITY}+</strong> &mdash; Identity (Rank, Species, HP/MP, DEF/MDEF, Traits, Stealables)</li>
    <li>Study result <strong>${TIER_STATS}+</strong> &mdash; Attributes (MIG / DEX / INS / WLP)</li>
    <li>Study result <strong>${TIER_DETAILS}+</strong> &mdash; Full profile (Affinities, Attacks, Abilities, Spells, Passives)</li>
  </ul>
</div>`;
  }

  function renderFooter(bestResult, bestResultBy, tierLabel, lastUpdated) {
    const by = bestResultBy ? ` · best by <em>${ESC(bestResultBy)}</em>` : "";
    const updated = lastUpdated ? ` · updated ${new Date(lastUpdated).toLocaleString()}` : "";
    return `<div class="oni-enc-footer">Best Study Check: <strong>${ESC(bestResult || "—")}</strong> · Tier: <strong>${ESC(tierLabel)}</strong>${by}${updated}</div>`;
  }

  // ───────────────────── renderPage ─────────────────────
  /**
   * Render the page HTML body. Reads tier state from `overrides` first, then
   * falls back to the page's saved flag. Callers updating the page must pass
   * the new values explicitly — page.update() is async and renderPage runs
   * BEFORE the flag write, so reading the flag here would see the old tier
   * and produce content one update behind.
   */
  async function renderPage(actorUuid, overrides = {}) {
    ensurePageStyles();

    const page = getPageForActor(actorUuid);
    const best        = overrides.bestResult   ?? (page ? (Number(getFlag(page, "bestResult")) || 0) : 0);
    const bestBy      = overrides.bestResultBy ?? (page ? (getFlag(page, "bestResultBy") ?? null) : null);
    const lastUpdated = overrides.lastUpdated  ?? (page ? (Number(getFlag(page, "lastUpdated")) || 0) : 0);

    const showIdentity = best >= TIER_IDENTITY;
    const showStats    = best >= TIER_STATS;
    const showDetails  = best >= TIER_DETAILS;
    const tierLabel    =
      showDetails  ? `Details (≥${TIER_DETAILS})` :
      showStats    ? `Stats (≥${TIER_STATS})`    :
      showIdentity ? `Identity (≥${TIER_IDENTITY})` :
                     "Unstudied";

    let actor = null;
    try { actor = await fromUuid(actorUuid); } catch { /* tolerate */ }
    if (!actor) {
      return `<div class="oni-enc-root"><p><em>Actor data not available for ${ESC(actorUuid)}.</em></p>` +
             renderFooter(best, bestBy, tierLabel, lastUpdated) + `</div>`;
    }

    const p = actor.system?.props ?? {};

    // Description rendered inline in the header; traits as plain text below sub-line
    const descHtml     = showIdentity ? (sanitizeRichHtml(p.study_text ?? "") || null) : null;
    const traitsText   = showIdentity
      ? (String(p.traits ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null)
      : null;

    // Unstudied — full guide message, no tier placeholders needed
    if (!showIdentity) {
      return `<div class="oni-enc-root"><div class="oni-enc-card">${
        [renderHeader(actor, p, false), renderUnstudied(), renderFooter(best, bestBy, tierLabel, lastUpdated)].join("\n")
      }</div></div>`;
    }

    // Fixed section layout. Locked tiers show an inline placeholder at their
    // natural position rather than being pushed to the bottom.
    const bodyParts = [
      renderHeader(actor, p, true, descHtml, traitsText),

      // ── Identity: core stats ────────────────────────────────────────
      renderCoreStatsBlock(p),

      // ── Stats tier ─────────────────────────────────────────────────
      showStats
        ? renderAttributesBlock(p)
        : renderLockedPlaceholder("Statistics", TIER_STATS),

      // ── Details tier: affinity block ───────────────────────────────
      ...(showDetails ? [
        renderAffinities(p),
        renderWeaponEff(p),
        renderConditionBadges(p),
      ] : [renderLockedPlaceholder("Detailed Profile", TIER_DETAILS)]),

      // ── Identity: stealables (always visible once identity unlocked) ─
      await renderStealables(actor, p),

      // ── Details tier: action block (auto-hide empty sections) ─────
      ...(showDetails ? (() => {
        const sections = [
          renderAttacks(actor, p),
          renderActiveSkills(actor, p),
          renderSpells(actor, p),
          renderPassiveSkills(actor, p),
        ].filter(Boolean);
        return sections.length ? [renderActionHeader(), ...sections] : [];
      })() : []),

      renderFooter(best, bestBy, tierLabel, lastUpdated),
    ].join("\n");

    return `<div class="oni-enc-root"><div class="oni-enc-card">${bodyParts}</div></div>`;
  }

  // ───────────────────── upsertPage / recordResult ─────────────────────
  async function upsertPage(actorUuid) {
    if (!game.user?.isGM) { console.warn(`${TAG} upsertPage refused: GM only (phase 2).`); return null; }
    if (!actorUuid) { console.warn(`${TAG} upsertPage: actorUuid required.`); return null; }

    const existing = getPageForActor(actorUuid);
    if (existing) return existing;

    const entry = await getEntry();
    if (!entry) { console.error(`${TAG} upsertPage: no encyclopedia entry resolvable.`); return null; }

    let actor = null;
    try { actor = await fromUuid(actorUuid); } catch { /* tolerate */ }

    const initialFlag = {
      actorUuid,
      bestResult: 0,
      bestResultBy: null,
      lastUpdated: Date.now(),
      isPlaceholder: true
    };

    const initialContent = await renderPage(actorUuid);
    const created = await entry.createEmbeddedDocuments("JournalEntryPage", [{
      name: pageNameForActor(actor),
      type: "text",
      text: { content: initialContent, format: 1 /* HTML */ },
      flags: { [FLAG_NAMESPACE]: { [FLAG_KEY]: initialFlag } }
    }]);

    return created?.[0] ?? null;
  }

  async function recordResult({ actorUuid, total, studierActorId = null, isCrit = false, isFumble = false } = {}) {
    if (!game.user?.isGM) { console.warn(`${TAG} recordResult refused: GM only. Use the oni:action:resolved listener path which auto-routes through GMExecutor.`); return null; }
    if (!actorUuid)       { console.warn(`${TAG} recordResult: actorUuid required.`); return null; }

    if (isFumble) {
      const cur = getPageForActor(actorUuid);
      const prev = cur ? Number(getFlag(cur, "bestResult")) || 0 : 0;
      return { previousBest: prev, newBest: prev, changed: false };
    }

    const page = await upsertPage(actorUuid);
    if (!page) return null;

    const previousBest = Number(getFlag(page, "bestResult")) || 0;
    const totalN = Number(total) || 0;
    // Critical Success on a Study Check reveals everything regardless of the
    // raw total — promote the effective value to the Details threshold so
    // the highest tier unlocks. A low-roll crit (e.g. 6+6=12) would otherwise
    // fall just short of Details despite being thematically a "you got lucky
    // and learned a lot" moment.
    const effectiveTotal = isCrit ? Math.max(totalN, TIER_DETAILS) : totalN;
    const newBest = Math.max(previousBest, effectiveTotal);
    const changed = newBest > previousBest;

    const flagUpdate = {
      [FLAG_NAMESPACE]: {
        [FLAG_KEY]: {
          actorUuid,
          bestResult: newBest,
          bestResultBy: changed ? (studierActorId ?? null) : (getFlag(page, "bestResultBy") ?? null),
          lastUpdated: Date.now(),
          isPlaceholder: newBest <= 0
        }
      }
    };

    const updates = { flags: flagUpdate };
    if (changed) {
      // Render with the NEW best so the new tier's content materializes on
      // this same update. Reading the page's flag here would still see the
      // pre-update value and render the old tier.
      const newBestBy = studierActorId ?? getFlag(page, "bestResultBy") ?? null;
      updates["text.content"] = await renderPage(actorUuid, {
        bestResult: newBest,
        bestResultBy: newBestBy,
        lastUpdated: Date.now()
      });
    }

    await page.update(updates);

    // Keep the encyclopedia in (rank, name) order. Cheap when nothing moved —
    // sortPages only writes pages whose sort key would actually change.
    try { await sortPages(); }
    catch (e) { console.warn(`${TAG} sortPages after recordResult failed:`, e); }

    // Trigger the unlock animation locally + broadcast to other clients when
    // this study crossed at least one tier threshold for the first time.
    if (changed) {
      const tiers = crossedTiersFor(previousBest, newBest);
      if (tiers.length) {
        try { queueUnlock(actorUuid, tiers); }
        catch (e) { console.warn(`${TAG} queueUnlock failed:`, e); }
      }
    }

    try { Hooks.callAll("oni:encyclopedia:updated", { actorUuid, previousBest, newBest, changed }); }
    catch (e) { console.warn(TAG, "oni:encyclopedia:updated hook listener threw.", e); }

    return { previousBest, newBest, changed };
  }

  // ───────────────────── Unlock animation ─────────────────────
  /**
   * When a Study Check crosses a tier threshold (7 / 8 / 13), the newly-
   * revealed sections animate in with a slide-down + fade + golden glow.
   * Strictly visual; no game state. Runs locally on each client (sender
   * triggers locally + broadcasts to others via the module socket).
   *
   * The flow:
   *   1. recordResult computes which tiers were just crossed for this study.
   *   2. queueUnlock writes { actorUuid → { tiers, timestamp } } into a
   *      module-local Map and tries to flush immediately.
   *   3. queueUnlock also broadcasts to other clients via SOCKET_CHANNEL.
   *   4. flushPendingUnlocks walks the Map; for each entry, looks up the
   *      currently-rendered journal sheet for that page and applies the
   *      animation class to <section data-enc-tier="X"> elements where X is
   *      one of the just-crossed tiers. Cleared from the Map on success.
   *   5. A renderJournalSheet hook re-runs the flush so the animation lands
   *      whenever the sheet (re-)renders — handles auto-open after Confirm,
   *      doc-update re-render, and manual re-opens of an entry that has a
   *      pending unlock.
   *   6. Entries older than 30s are evicted from the Map even if never
   *      consumed (e.g., the sheet was never opened).
   */
  const pendingUnlocks = new Map();
  const PENDING_UNLOCK_TTL_MS = 30000;

  /** Compute which tier thresholds the (prev → next) study just crossed. */
  function crossedTiersFor(previousBest, newBest) {
    const tiers = [];
    const prev = Number(previousBest) || 0;
    const next = Number(newBest) || 0;
    if (prev < TIER_IDENTITY && next >= TIER_IDENTITY) tiers.push("identity");
    if (prev < TIER_STATS    && next >= TIER_STATS)    tiers.push("stats");
    if (prev < TIER_DETAILS  && next >= TIER_DETAILS)  tiers.push("details");
    return tiers;
  }

  /** Inject the @keyframes + animation class once per client. */
  function ensureAnimStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById(ANIM_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = ANIM_STYLE_ID;
    style.textContent = `
      @keyframes oni-enc-unlock-reveal {
        0%   { opacity: 0; transform: translateY(-10px); box-shadow: 0 0 0 0 rgba(255, 198, 76, 0); }
        25%  { opacity: 0.6; box-shadow: 0 0 14px 4px rgba(255, 198, 76, 0.55); }
        70%  { opacity: 1; transform: translateY(0); box-shadow: 0 0 18px 4px rgba(255, 198, 76, 0.35); }
        100% { opacity: 1; transform: translateY(0); box-shadow: 0 0 0 0 rgba(255, 198, 76, 0); }
      }
      section[data-enc-tier].${ANIM_CLASS} {
        animation: oni-enc-unlock-reveal ${ANIM_DURATION_MS}ms ease-out;
        will-change: transform, opacity, box-shadow;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Add the unlock to the local queue, broadcast to other clients, and try
   * to flush immediately so the animation plays without waiting for the
   * next render if the sheet is already on screen.
   */
  function queueUnlock(actorUuid, tiers, { broadcast = true } = {}) {
    if (!actorUuid || !Array.isArray(tiers) || !tiers.length) return;
    pendingUnlocks.set(actorUuid, { tiers: [...tiers], timestamp: Date.now() });

    if (broadcast) {
      try {
        // game.socket.emit fires only to OTHER clients (sender is excluded
        // by Foundry). We trigger locally below via flushPendingUnlocks.
        game.socket?.emit?.(SOCKET_CHANNEL, {
          type: "encyclopedia:unlock",
          actorUuid,
          tiers
        });
      } catch (e) {
        console.warn(`${TAG} socket emit failed:`, e);
      }
    }

    // Defer slightly so any in-flight page re-render from page.update has
    // a chance to land in the DOM before we look for the new sections.
    setTimeout(flushPendingUnlocks, 100);
  }

  function flushPendingUnlocks() {
    if (!pendingUnlocks.size) return;
    const now = Date.now();
    for (const [actorUuid, info] of pendingUnlocks) {
      if (now - info.timestamp > PENDING_UNLOCK_TTL_MS) {
        pendingUnlocks.delete(actorUuid);
        continue;
      }
      const page = getPageForActor(actorUuid);
      if (!page) continue;
      const sheetApp = page.parent?.sheet;
      if (!sheetApp?.rendered) continue;

      const rootEl = (sheetApp.element?.[0] ?? sheetApp.element);
      if (!rootEl?.querySelector) continue;

      // Find the rendered page container. The journal sheet places the
      // page-id on TWO elements: the sidebar TOC `<li>` and the page-body
      // `<article>`. We want the article (which holds the rendered HTML);
      // matching the LI gives an empty scope and the animation no-ops.
      const pageScope =
        rootEl.querySelector(`article[data-page-id="${page.id}"]`)
        ?? rootEl.querySelector(`.journal-entry-page[data-page-id="${page.id}"]`)
        ?? rootEl;

      // Collect every section we plan to animate, across all crossed tiers,
      // so we can find the topmost one in document order and scroll the
      // sheet to it before the animation plays. Otherwise unlocks below the
      // current scroll position would animate offscreen.
      const targets = [];
      for (const tier of info.tiers) {
        pageScope.querySelectorAll(`section[data-enc-tier="${tier}"]`).forEach(el => targets.push(el));
      }
      if (!targets.length) continue;

      // Sort by document position; first in DOM = topmost on screen.
      targets.sort((a, b) =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
      );

      try {
        targets[0].scrollIntoView({ behavior: "smooth", block: "start" });
      } catch { /* tolerate browsers without smooth-scroll */ }

      // Wait ~350ms for the smooth scroll to land, then animate. If we
      // animated immediately the slide-down keyframe would race the scroll
      // and the section would appear mid-air below its final spot.
      const playAnim = () => {
        for (const el of targets) {
          el.classList.remove(ANIM_CLASS);
          // eslint-disable-next-line no-unused-expressions
          void el.offsetWidth; // force reflow so the class re-trigger plays
          el.classList.add(ANIM_CLASS);
          setTimeout(() => el.classList.remove(ANIM_CLASS), ANIM_DURATION_MS + 50);
        }
      };
      setTimeout(playAnim, 350);

      pendingUnlocks.delete(actorUuid);
    }
  }

  function registerSocketListener() {
    try {
      game.socket?.on?.(SOCKET_CHANNEL, (payload) => {
        if (payload?.type !== "encyclopedia:unlock") return;
        // Receivers don't re-broadcast — that would loop.
        queueUnlock(payload.actorUuid, payload.tiers, { broadcast: false });
      });
    } catch (e) {
      console.warn(`${TAG} socket listener registration failed:`, e);
    }
  }

  // ───────────────────── Boot ─────────────────────
  function mountApi() {
    globalThis.FUCompanion.api.encyclopedia = {
      getEntry,
      getPageForActor,
      upsertPage,
      recordResult,
      renderPage,
      // Study skill resolver — exposed so [Macro] Study.js and any future
      // caller can find the world's Study skill UUID without hardcoding it.
      getStudySkill,
      getStudySkillUuid,
      // Open helpers — used by the action-resolved auto-open and by the
      // initiative-bar info-badge click handler.
      openEncyclopediaForActor,
      openEncyclopediaForToken,
      resolveActorPrototypeUuid,
      // Re-sort pages by (rank, name). Called automatically after writes;
      // exposed for manual triggering / debugging.
      sortPages,
      _internals: {
        findEntry, createEntry, getCachedUuid, setCachedUuid,
        findStudySkill, createStudySkill, getCachedStudySkillUuid, setCachedStudySkillUuid,
        STUDY_SKILL_SPEC, STUDY_SKILL_NAME,
        ENTRY_NAME, SETTING_KEY, STUDY_SETTING_KEY,
        TIER_IDENTITY, TIER_STATS, TIER_DETAILS,
        handleCombatStart,
        // Unlock animation infra — exposed for diagnostics / manual testing.
        queueUnlock, flushPendingUnlocks, crossedTiersFor, pendingUnlocks,
        SOCKET_CHANNEL, ANIM_CLASS
      }
    };
    console.info(`${TAG} API mounted at FUCompanion.api.encyclopedia.`);
  }

  async function ensureArtifactsAtReady() {
    if (!game.user?.isGM) return;
    try {
      const entry = await getEntry();
      if (entry) console.info(`${TAG} Entry ready: ${entry.uuid}`);
    } catch (e) { console.error(`${TAG} Boot ensureEntry failed:`, e); }
    try {
      const skill = await getStudySkill();
      if (skill) console.info(`${TAG} Study skill ready: ${skill.uuid}`);
    } catch (e) { console.error(`${TAG} Boot ensureStudySkill failed:`, e); }

    // Backfill placeholders if the world booted with an active combat. The
    // combatStart hook only fires when combat is begun fresh, so without this
    // a mid-combat boot would leave enemy combatants without their pages.
    try {
      const active = game.combat;
      if (active?.started) await handleCombatStart(active);
    } catch (e) { console.error(`${TAG} Boot combat backfill failed:`, e); }

    // Normalize sort on existing pages (handles legacy pages written before
    // sortPages existed, or any drift from manual reordering).
    try { await sortPages(); }
    catch (e) { console.warn(`${TAG} Boot sortPages failed:`, e); }
  }

  /**
   * Resolve a token's UUID to the world Actor PROTOTYPE UUID.
   * - Linked tokens → token.actor.uuid is already the world-actor UUID.
   * - Unlinked NPC tokens → token.actor is a token-scoped clone whose UUID
   *   looks like "Scene.X.Token.Y.Actor.Z". The prototype world actor's id
   *   lives at TokenDocument#_source.actorId, so we rebuild "Actor.<id>".
   * Returns null for non-token targets or actors that have no prototype id.
   */
  async function resolveActorPrototypeUuid(tokenUuid) {
    if (!tokenUuid) return null;
    let tokenDoc = null;
    try { tokenDoc = await fromUuid(tokenUuid); } catch { return null; }
    if (!tokenDoc) return null;

    // If we were passed an actor UUID directly, return it.
    if (tokenDoc.documentName === "Actor" && tokenDoc.uuid?.startsWith?.("Actor.")) {
      return tokenDoc.uuid;
    }

    if (tokenDoc.documentName !== "Token") return null;
    const actorOnToken = tokenDoc.actor ?? null;
    const actorUuidOnToken = String(actorOnToken?.uuid ?? "");
    if (actorUuidOnToken.startsWith("Actor.")) return actorUuidOnToken;

    const protoId = tokenDoc._source?.actorId ?? tokenDoc.actorId ?? null;
    return protoId ? `Actor.${protoId}` : null;
  }

  /**
   * Play the study VFX + SFX on the canvas token, then wait for it to finish.
   * Silently no-ops if Sequencer isn't loaded or the token isn't on canvas.
   */
  async function playStudyVfxAndWait(targetTokenUuid) {
    const VFX_MS = 4000;
    const tokenId = String(targetTokenUuid ?? "").split(".Token.").pop();
    const canvasTok = tokenId ? canvas?.tokens?.get?.(tokenId) : null;
    if (!canvasTok || typeof Sequence === "undefined") return;
    try {
      new Sequence()
        .effect()
          .file("modules/JB2A_DnD5e/Library/Generic/Marker/SciFi/MarkerScifiComplete001_001_GreenYellow_600x600.webm")
          .atLocation(canvasTok)
          .duration(VFX_MS)
          .opacity(0.7)
          .scale(0.5)
        .play();
      new Sequence()
        .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Computer.ogg")
        .play();
      await new Promise(r => setTimeout(r, VFX_MS + 200));
    } catch (e) {
      console.warn(TAG, "study VFX failed:", e);
    }
  }

  /**
   * `oni:action:resolved` listener. Filters Study fires by skillUuid, walks
   * the targets to the world-actor prototype, then either records the result
   * directly (GM client) or routes through GMExecutor (player client).
   *
   * Fires on the CLICKER's client only — Foundry hooks are local. GM routing
   * is the only path that lets a player Confirm update the encyclopedia.
   */
  async function handleActionResolved(eventData) {
    try {
      const payload = eventData?.payload;
      if (!payload) return;

      // The post-execute cardPayload nests skillUuid + attackerUuid inside
      // `meta` (set by ADF's buildForwardMeta) rather than at the top level.
      // We fall back to top-level keys so simpler synthetic callers — and
      // the autoPassive branch, where shape differs — still work.
      const skillUuid = payload.meta?.skillUuid ?? payload.skillUuid ?? null;
      if (!skillUuid) return;

      // Resolve Study skill UUID at fire time (auto-creates on first boot
      // if missing). Cached after the first call, so this is cheap on the
      // hot path.
      const studyUuid = await getStudySkillUuid();
      if (!studyUuid || skillUuid !== studyUuid) return;
      if (payload.executionMode === "autoPassive") return; // never auto-write from passives

      const accuracy = payload.accuracy ?? null;
      if (!accuracy) return; // Study without a roll shouldn't reach the encyclopedia

      const targetTokens = Array.isArray(payload.originalTargetUUIDs) && payload.originalTargetUUIDs.length
        ? payload.originalTargetUUIDs
        : (Array.isArray(payload.targets) ? payload.targets : []);
      if (!targetTokens.length) return;

      const targetActorUuid = await resolveActorPrototypeUuid(targetTokens[0]);
      if (!targetActorUuid) {
        console.warn(`${TAG} could not resolve target actor prototype UUID for ${targetTokens[0]}.`);
        return;
      }

      // Studier name for the "best by" credit line. The attacker is stored as
      // a token UUID in meta.attackerUuid; resolve to the actor document for
      // the display name. Falls back to core.attackerName if resolution fails.
      let studierName = payload.core?.attackerName ?? null;
      try {
        const attackerUuid = payload.meta?.attackerUuid ?? payload.attackerActorUuid ?? null;
        if (attackerUuid) {
          const attackerDoc = await fromUuid(attackerUuid);
          if (attackerDoc) {
            studierName = attackerDoc.documentName === "Token"
              ? (attackerDoc.actor?.name ?? attackerDoc.name ?? studierName)
              : (attackerDoc.name ?? studierName);
          }
        }
      } catch { /* tolerate, keep core.attackerName */ }

      const event = {
        actorUuid: targetActorUuid,
        total: Number(accuracy.total ?? 0) || 0,
        isCrit: !!accuracy.isCrit,
        isFumble: !!accuracy.isFumble,
        studierActorId: studierName
      };

      // GM path: write locally. Player path: ship the call through GMExecutor.
      if (game.user?.isGM) {
        await recordResult(event);
        await playStudyVfxAndWait(targetTokens[0]);
        await openEncyclopediaForActor(targetActorUuid);
        return;
      }

      const gmExec = globalThis.FUCompanion?.api?.GMExecutor;
      if (!gmExec?.executeSnippet) {
        console.warn(`${TAG} GMExecutor unavailable; encyclopedia update skipped.`);
        return;
      }
      await gmExec.executeSnippet({
        mode: "encyclopedia.recordResult",
        scriptText: `return await globalThis.FUCompanion?.api?.encyclopedia?.recordResult?.(args.event);`,
        args: { event }
      });
      // GM has written the page; give the doc broadcast a moment to land on
      // this client before we try to focus the page in the sheet.
      await new Promise(r => setTimeout(r, 200));
      await playStudyVfxAndWait(targetTokens[0]);
      await openEncyclopediaForActor(targetActorUuid);
    } catch (e) {
      console.error(`${TAG} handleActionResolved failed:`, e);
    }
  }

  /**
   * Open the Monster Encyclopedia journal on the local client and focus the
   * page for the given actor. Quiet on failure — this is a UX nicety, not a
   * critical write path. Runs only on the client where the listener fired,
   * so other players aren't interrupted by someone else's Study.
   */
  async function openEncyclopediaForActor(actorUuid) {
    try {
      const entry = await getEntry();
      if (!entry?.sheet) return;
      const page = getPageForActor(actorUuid);
      entry.sheet.render(true, page ? { pageId: page.id } : undefined);
    } catch (e) {
      console.warn(`${TAG} Auto-open encyclopedia failed:`, e);
    }
  }

  /**
   * Open the encyclopedia page for the given token. Resolves the actor
   * prototype UUID for unlinked NPC tokens. Used by the initiative-bar
   * info badge click handler in fabula-initiative-ui.
   */
  async function openEncyclopediaForToken(tokenUuid) {
    const actorUuid = await resolveActorPrototypeUuid(tokenUuid);
    if (!actorUuid) {
      console.warn(`${TAG} openEncyclopediaForToken: could not resolve actor prototype UUID for ${tokenUuid}.`);
      return;
    }
    return openEncyclopediaForActor(actorUuid);
  }

  /**
   * Primary sort key for NPC ranks. Accepts both full names (`"soldier"`)
   * and 3-letter abbreviations (`"sol"`) since both shapes are present in
   * authored monster data. Unknown / empty ranks sort last so unranked
   * homebrew pages don't shuffle into the middle of the list.
   */
  function rankSortKey(rawRank) {
    const head = String(rawRank ?? "").trim().toLowerCase().slice(0, 3);
    switch (head) {
      case "sol": return 1; // soldier
      case "eli": return 2; // elite
      case "cha": return 3; // champion
      case "vil": return 4; // villain
      default:    return 99;
    }
  }

  /**
   * Resort every page in the encyclopedia entry by (rank, level, name).
   * Idempotent — only writes pages whose sort field would change. GM-only.
   *
   * Sort source:
   *   1. actor.system.props.npc_rank — primary, normalized via rankSortKey
   *   2. actor.system.props.level    — secondary, numeric ascending. Unknown
   *      / non-numeric levels sort to the end of their rank group (999).
   *   3. actor.name                  — final tiebreaker, alphabetical, for
   *      stable ordering when rank + level both tie.
   *
   * Pages whose actor is unresolvable sort to the end with rank=99.
   */
  async function sortPages() {
    if (!game.user?.isGM) return;
    const entry = await getEntry();
    if (!entry) return;
    const pages = entry.pages?.contents ?? Array.from(entry.pages?.values?.() ?? []);
    if (!pages.length) return;

    const enriched = await Promise.all(pages.map(async (p) => {
      const actorUuid = getFlag(p, "actorUuid");
      let rank = null;
      let levelRaw = null;
      let displayName = p.name ?? "";
      if (actorUuid) {
        try {
          const actor = await fromUuid(actorUuid);
          if (actor) {
            rank = actor.system?.props?.npc_rank ?? null;
            levelRaw = actor.system?.props?.level ?? null;
            displayName = actor.name ?? displayName;
          }
        } catch { /* tolerate dead UUID */ }
      }
      const lvlNum = Number(levelRaw);
      return {
        id: p.id,
        currentSort: p.sort ?? 0,
        rankKey: rankSortKey(rank),
        levelKey: Number.isFinite(lvlNum) ? lvlNum : 999,
        name: displayName
      };
    }));

    enriched.sort((a, b) => {
      if (a.rankKey !== b.rankKey) return a.rankKey - b.rankKey;
      if (a.levelKey !== b.levelKey) return a.levelKey - b.levelKey;
      return a.name.localeCompare(b.name);
    });

    const updates = [];
    let nextSort = 100000;
    for (const e of enriched) {
      if (e.currentSort !== nextSort) {
        updates.push({ _id: e.id, sort: nextSort });
      }
      nextSort += 100000;
    }

    if (updates.length) {
      await entry.updateEmbeddedDocuments("JournalEntryPage", updates);
    }
  }

  /**
   * combatStart hook handler — auto-spawn placeholder pages for every
   * enemy combatant so the Pokédex feels populated from round 1 of every
   * fight. GM-only; players' clients no-op (placeholders need a GM write).
   *
   * Idempotent: upsertPage returns the existing page if there is one,
   * so re-entries of the same combat don't duplicate.
   */
  async function handleCombatStart(combat) {
    if (!game.user?.isGM) return;
    if (!combat) return;
    const combatants = combat.combatants?.contents ?? [];
    const enemies = combatants.filter(c => {
      const disp = c?.token?.disposition ?? c?.token?.document?.disposition ?? null;
      return disp === -1;
    });
    if (!enemies.length) return;

    const results = [];
    for (const c of enemies) {
      try {
        const tokenUuid = c.token?.uuid ?? null;
        if (!tokenUuid) continue;
        const actorUuid = await resolveActorPrototypeUuid(tokenUuid);
        if (!actorUuid) continue;
        // Skip duplicates from multiple instances of the same prototype.
        if (results.some(r => r.actorUuid === actorUuid)) continue;
        const page = await upsertPage(actorUuid);
        if (page) results.push({ actorUuid, name: c.name });
      } catch (e) {
        console.warn(`${TAG} handleCombatStart: upsert failed for ${c.name}:`, e);
      }
    }

    if (results.length) {
      console.info(`${TAG} combatStart: ensured ${results.length} placeholder page(s) for enemies.`, results.map(r => r.name));
      try { await sortPages(); }
      catch (e) { console.warn(`${TAG} sortPages after combatStart failed:`, e); }
    }
  }

  function registerHookListener() {
    // Idempotent: if we re-bootstrap via evalGM during a session, the previous
    // listener has already been removed by our `if (existing API) return` guard
    // at the top of the IIFE. But that guard short-circuits before this point
    // runs, so we never double-register from a single session anyway.
    Hooks.on("oni:action:resolved", handleActionResolved);
    Hooks.on("combatStart", handleCombatStart);
    // Flush pending unlocks whenever the encyclopedia sheet (re-)renders.
    // Covers the auto-open-after-Confirm path: the sheet may not be on screen
    // when recordResult fires, so we keep the unlock pending and replay it
    // here once the sheet is mounted.
    Hooks.on("renderJournalSheet", () => flushPendingUnlocks());
    console.info(`${TAG} oni:action:resolved + combatStart + renderJournalSheet listeners registered.`);
  }

  if (typeof game !== "undefined" && game?.ready) {
    registerSetting();
    mountApi();
    ensureAnimStyles();
    registerSocketListener();
    registerHookListener();
    ensureArtifactsAtReady();
  } else {
    Hooks.once("init", () => { registerSetting(); mountApi(); });
    Hooks.once("ready", () => {
      ensureAnimStyles();
      registerSocketListener();
      registerHookListener();
      ensureArtifactsAtReady();
    });
  }
})();
