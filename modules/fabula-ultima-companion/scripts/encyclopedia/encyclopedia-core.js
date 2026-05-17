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

  /**
   * Card-style wrapper around a titled section. Used by every Identity / Stats
   * / Details subsection so the page reads as a stack of distinct cards rather
   * than a flat run of h3 + content.
   */
  function renderSection(title, innerHtml) {
    return `
<section style="margin:10px 0;padding:12px 14px;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.1);border-radius:8px;">
  <h3 style="margin:0 0 8px;border:0;padding-bottom:6px;border-bottom:1px solid rgba(0,0,0,.1);font-size:15px;">${ESC(title)}</h3>
  <div>${innerHtml}</div>
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
  function renderHeader(actor, p, showMeta) {
    // Portrait and name are visible to players the moment the token is on the
    // battlemap, so we always show them here regardless of Study tier. The
    // meta line (Rank / Level / Species / Attribute / Sub-Type) is the actual
    // Identity-tier reveal and stays hidden until best ≥ 7.
    let metaHtml;
    if (showMeta) {
      const parts = [p.npc_rank, p.level ? `Lv ${p.level}` : null, p.species, p.attribute]
        .filter(Boolean).map(ESC).join(" · ");
      const subtype = p.subtype_list ? ` · <em>${ESC(p.subtype_list)}</em>` : "";
      metaHtml = `${parts || "—"}${subtype}`;
    } else {
      metaHtml = `<span style="opacity:.6;font-style:italic;">Rank · Level · Species · Attribute unknown</span>`;
    }
    return `
<div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:10px;">
  <img src="${ESC(actor.img || PORTRAIT_FALLBACK)}" alt="" style="width:104px;height:104px;object-fit:contain;border:0;border-radius:8px;background:rgba(0,0,0,.05);">
  <div style="flex:1;min-width:0;">
    <h2 style="margin:0 0 4px;border:0;">${ESC(actor.name ?? "Unknown")}</h2>
    <div style="font-size:13px;">${metaHtml}</div>
  </div>
</div>`;
  }

  function renderTierSection(tierLabel, threshold, showTier, innerHtml) {
    if (showTier) return innerHtml;
    return `
<section style="margin:8px 0;padding:14px 16px;background:rgba(0,0,0,.05);border:1px dashed rgba(0,0,0,.2);border-radius:8px;text-align:center;">
  <div style="font-size:13px;opacity:.8;">🔒 <strong>${ESC(tierLabel)}</strong> &mdash; requires a Study Check of <strong>${threshold}</strong> or higher.</div>
</section>`;
  }

  function renderCoreStatsBlock(p) {
    const cell = (label, val) => `<td style="padding:6px 8px;border:1px solid rgba(0,0,0,.15);width:25%;"><strong>${ESC(label)}</strong> ${ESC(val ?? "—")}</td>`;
    const table = `
<table style="width:100%;border-collapse:collapse;">
  <tr>
    ${cell("Max HP", p.max_hp)}
    ${cell("Max MP", p.max_mp)}
    ${cell("DEF", p.defense)}
    ${cell("MDEF", p.magic_defense)}
  </tr>
</table>`;
    return renderSection("Vital Statistics", table);
  }

  function renderDescription(p) {
    const html = sanitizeRichHtml(p.study_text ?? "");
    return renderSection("Description", html || `<p style="margin:0;"><em>No description.</em></p>`);
  }

  function renderTraits(p) {
    const html = sanitizeRichHtml(p.traits ?? "");
    return renderSection("Traits", html || `<p style="margin:0;"><em>None recorded.</em></p>`);
  }

  function renderAttributesBlock(p) {
    const cell = (label, v) => `<td style="padding:6px 8px;border:1px solid rgba(0,0,0,.15);width:25%;text-align:center;"><strong>${ESC(label)}</strong><br><span style="font-size:18px;font-weight:700;">${v != null ? `d${ESC(v)}` : "—"}</span></td>`;
    const table = `
<table style="width:100%;border-collapse:collapse;">
  <tr>
    ${cell("MIG", p.mig_base)}
    ${cell("DEX", p.dex_base)}
    ${cell("INS", p.ins_base)}
    ${cell("WLP", p.wlp_base)}
  </tr>
</table>`;
    return renderSection("Attributes", table);
  }

  function renderAffinities(p) {
    const rows = [];
    for (let i = 1; i <= 9; i++) {
      const code = p[`affinity_${i}`];
      const known = ["RS", "VU", "AB", "IM"].includes(code);
      const right = known ? ESC(AFFINITY_SYM[code] ?? code) : NEUTRAL_LABEL;
      rows.push(`<li style="${known ? "" : "opacity:.55;"}padding:2px 0;"><strong>${ESC(AFFINITY_NAME[i])}</strong> · ${right}</li>`);
    }
    return renderSection("Type Affinities", `<ul style="margin:0;padding-left:18px;columns:2;">${rows.join("")}</ul>`);
  }

  function renderWeaponEff(p) {
    const rows = [];
    for (const wt of WEAPON_TYPES) {
      const v = p[`${wt}_ef`];
      const n = Number(v);
      const known = Number.isFinite(n) && n !== 100;
      const label = wt[0].toUpperCase() + wt.slice(1);
      const right = known
        ? `<span style="${n > 100 ? "color:#1f7a3a;" : "color:#b02a2a;"}font-weight:700;">${ESC(n)}%</span>`
        : NEUTRAL_LABEL;
      rows.push(`<li style="${known ? "" : "opacity:.55;"}padding:2px 0;"><strong>${ESC(label)}</strong> · ${right}</li>`);
    }
    return renderSection("Weapon Efficiency", `<ul style="margin:0;padding-left:18px;columns:2;">${rows.join("")}</ul>`);
  }

  function renderConditionAffinities(p) {
    const rows = [];
    for (const c of CONDITIONS) {
      const code = p[`condition_${c}`];
      if (!["RS", "VU", "AB", "IM"].includes(code)) continue;
      const label = c[0].toUpperCase() + c.slice(1);
      rows.push(`<li style="padding:2px 0;">${ESC(AFFINITY_SYM[code] ?? code)} · <strong>${ESC(label)}</strong></li>`);
    }
    const body = rows.length
      ? `<ul style="margin:0;padding-left:18px;columns:2;">${rows.join("")}</ul>`
      : `<p style="margin:0;"><em>Neutral to every condition.</em></p>`;
    return renderSection("Condition Affinities", body);
  }

  function renderAttackEntry(actor, entry) {
    const name = ESC(entry?.name ?? "Unknown");
    const item = resolveEmbeddedItem(actor, entry);
    const img = item?.img || ATTACK_ICON;
    const atr1 = entry?.attribute_die1 ? ESC(entry.attribute_die1) : null;
    const atr2 = entry?.attribute_die2 ? ESC(entry.attribute_die2) : null;
    const formula = atr1 && atr2 ? `${atr1} + ${atr2}` : null;
    const target  = entry?.active_target ? ESC(entry.active_target) : null;
    const meta = [formula, target].filter(Boolean).map(m => `<span style="opacity:.75;">${m}</span>`).join(" · ");
    const desc = sanitizeRichHtml(entry?.attack_description ?? "");
    return `
<li style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;">
  <img src="${ESC(img)}" alt="" style="width:28px;height:28px;object-fit:contain;border:0;flex:0 0 auto;margin-top:2px;">
  <div style="flex:1;min-width:0;">
    <div><strong>${name}</strong>${meta ? ` &middot; ${meta}` : ""}</div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div>
</li>`;
  }

  function renderAbilityEntry(actor, entry) {
    const name = ESC(entry?.name ?? "Unknown");
    const item = resolveEmbeddedItem(actor, entry);
    const img = item?.img || ABILITY_ICON;
    const cost     = entry?.active_cost ? ESC(entry.active_cost) : null;
    const duration = entry?.active_duration ? ESC(entry.active_duration) : null;
    const target   = entry?.active_target ? ESC(entry.active_target) : null;
    const meta = [cost, duration, target].filter(Boolean).filter(s => s !== "-").map(m => `<span style="opacity:.75;">${m}</span>`).join(" · ");
    const desc = sanitizeRichHtml(entry?.active_description ?? "");
    return `
<li style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;">
  <img src="${ESC(img)}" alt="" style="width:28px;height:28px;object-fit:contain;border:0;flex:0 0 auto;margin-top:2px;">
  <div style="flex:1;min-width:0;">
    <div><strong>${name}</strong>${meta ? ` &middot; ${meta}` : ""}</div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div>
</li>`;
  }

  function renderAttacks(actor, p) {
    const list = objectToList(p.attack_list).map(e => renderAttackEntry(actor, e));
    const body = list.length
      ? `<ul style="margin:0;padding:0;list-style:none;">${list.join("")}</ul>`
      : `<p style="margin:0;"><em>None.</em></p>`;
    return renderSection("Basic Attacks", body);
  }

  function renderActiveSkills(actor, p) {
    const list = objectToList(p.skill_active_list).map(e => renderAbilityEntry(actor, e));
    const body = list.length
      ? `<ul style="margin:0;padding:0;list-style:none;">${list.join("")}</ul>`
      : `<p style="margin:0;"><em>None.</em></p>`;
    return renderSection("Special Abilities", body);
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
<li style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;">
  <img src="${ESC(img)}" alt="" style="width:24px;height:24px;object-fit:contain;border:0;flex:0 0 auto;margin-top:2px;">
  <div style="flex:1;min-width:0;">
    <div>${labelHtml}</div>
    ${desc ? `<div style="margin-top:2px;opacity:.9;">${desc}</div>` : ""}
  </div>
</li>`;
    }));

    const body = rows.length
      ? `<ul style="margin:0;padding:0;list-style:none;">${rows.join("")}</ul>`
      : `<p style="margin:0;"><em>Nothing of value.</em></p>`;
    return renderSection("Stealable Items", body);
  }

  function renderUnstudied() {
    return `
<div style="margin:10px 0;padding:18px 20px;background:rgba(0,0,0,.05);border:1px dashed rgba(0,0,0,.25);border-radius:10px;text-align:center;">
  <div style="font-size:32px;line-height:1;margin-bottom:8px;opacity:.7;">🔒</div>
  <div style="font-weight:700;margin-bottom:6px;">Unstudied Monster</div>
  <p style="margin:6px 0;opacity:.85;font-size:13px;">Your party hasn't successfully studied this creature yet. Use the <strong>Study</strong> action during combat to begin filling in this entry.</p>
  <ul style="display:inline-block;text-align:left;margin:8px auto;font-size:12px;opacity:.85;">
    <li>Study result <strong>${TIER_IDENTITY}+</strong> &mdash; Identity (Rank, Species, HP/MP, DEF/MDEF, Traits, Stealables)</li>
    <li>Study result <strong>${TIER_STATS}+</strong> &mdash; Attributes (MIG / DEX / INS / WLP)</li>
    <li>Study result <strong>${TIER_DETAILS}+</strong> &mdash; Detailed profile (Affinities, Weapon Efficiency, Conditions, Attacks, Abilities)</li>
  </ul>
</div>`;
  }

  function renderFooter(bestResult, bestResultBy, tierLabel, lastUpdated) {
    const by = bestResultBy ? ` &middot; best by <em>${ESC(bestResultBy)}</em>` : "";
    const updated = lastUpdated ? ` &middot; updated ${new Date(lastUpdated).toLocaleString()}` : "";
    return `
<hr style="margin-top:14px;">
<p style="opacity:.65;font-size:11px;margin:6px 0 0;">
  Best Study Check: <strong>${ESC(bestResult || "—")}</strong> &middot; Tier: <strong>${ESC(tierLabel)}</strong>${by}${updated}
</p>`;
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
      return `<p><em>Actor data not available for ${ESC(actorUuid)}.</em></p>` +
             renderFooter(best, bestBy, tierLabel, lastUpdated);
    }

    const p = actor.system?.props ?? {};

    // Special-case unstudied: portrait + name are public (token is on the
    // battlemap), but the meta line + every section beyond it stays gated
    // behind the Unstudied placard.
    if (!showIdentity) {
      return [renderHeader(actor, p, false), renderUnstudied(), renderFooter(best, bestBy, tierLabel, lastUpdated)].join("\n");
    }

    const identityBlock = [
      renderCoreStatsBlock(p),
      renderDescription(p),
      renderTraits(p),
      await renderStealables(actor, p)
    ].join("\n");

    const statsBlock = renderAttributesBlock(p);

    const detailsBlock = [
      renderAffinities(p),
      renderWeaponEff(p),
      renderConditionAffinities(p),
      renderAttacks(actor, p),
      renderActiveSkills(actor, p)
    ].join("\n");

    return [
      renderHeader(actor, p, true),
      identityBlock,
      renderTierSection(`Statistics (Stats tier)`, TIER_STATS, showStats, statsBlock),
      renderTierSection(`Detailed Profile (Details tier)`, TIER_DETAILS, showDetails, detailsBlock),
      renderFooter(best, bestBy, tierLabel, lastUpdated)
    ].join("\n");
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
    const newBest = Math.max(previousBest, totalN);
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

    try { Hooks.callAll("oni:encyclopedia:updated", { actorUuid, previousBest, newBest, changed }); }
    catch (e) { console.warn(TAG, "oni:encyclopedia:updated hook listener threw.", e); }

    return { previousBest, newBest, changed };
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
      _internals: {
        findEntry, createEntry, getCachedUuid, setCachedUuid,
        findStudySkill, createStudySkill, getCachedStudySkillUuid, setCachedStudySkillUuid,
        STUDY_SKILL_SPEC, STUDY_SKILL_NAME,
        ENTRY_NAME, SETTING_KEY, STUDY_SETTING_KEY,
        TIER_IDENTITY, TIER_STATS, TIER_DETAILS
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

  function registerHookListener() {
    // Idempotent: if we re-bootstrap via evalGM during a session, the previous
    // listener has already been removed by our `if (existing API) return` guard
    // at the top of the IIFE. But that guard short-circuits before this point
    // runs, so we never double-register from a single session anyway.
    Hooks.on("oni:action:resolved", handleActionResolved);
    console.info(`${TAG} oni:action:resolved listener registered.`);
  }

  if (typeof game !== "undefined" && game?.ready) {
    registerSetting();
    mountApi();
    registerHookListener();
    ensureArtifactsAtReady();
  } else {
    Hooks.once("init", () => { registerSetting(); mountApi(); });
    Hooks.once("ready", () => { registerHookListener(); ensureArtifactsAtReady(); });
  }
})();
