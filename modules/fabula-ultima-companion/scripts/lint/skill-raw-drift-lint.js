/**
 * [ONI] Skill RAW Drift Lint
 * ---------------------------------------------------------------------------
 * Compares the skills on playable class actors against the canonical FU
 * reference in `modules/fabula-ultima-companion/reference/skills.json`. These
 * are the copies the level-up window reads. Surfaces:
 *
 *   RAW_MAX_SL_DRIFT
 *     A skill's `system.props.max_level` != reference `max_sl`. A missing value
 *     counts as 1, because that is what the level-up window reads it as: this
 *     is how Spiritual Magic came to offer 1/1 instead of 1/10.
 *
 *   RAW_NAME_CASE_DRIFT
 *     A skill's name matches the reference case-insensitively but the
 *     casing differs (e.g. "see you later" vs "See You Later").
 *
 *   RAW_HEROIC_FLAG_DRIFT
 *     A skill's `system.props.isHeroic` != reference's heroic-table
 *     membership. A non-heroic skill flagged heroic, or vice versa.
 *
 *   RAW_REFERENCE_MISSING (info)
 *     A skill has a name that doesn't appear in any class's
 *     skills / spells / heroic in the reference. Either a homebrew
 *     skill (silence with `_homebrew: true`), a renamed copy that
 *     drifted from canon, or a reference-coverage gap.
 *
 * Scope: actors in Classes / Classic Classes and Classes / Custom Classes.
 * This used to walk a Battle Director item folder that no longer exists, so for
 * a long while it checked nothing and reported a clean result.
 *
 * Default severity: info — RAW deviations are sometimes intentional
 * homebrew. Authors override per-item with `system.props._homebrew: true`
 * on the class's copy to silence specific drift.
 *
 * Usage:
 *   await FUCompanion.api.lint.runSkillRawDriftLint();
 *   // → { findings, summary }
 *
 * Auto-runs at GM ready, alongside the other lints.
 */

(() => {
  const TAG = "[SkillRawDriftLint]";
  const MODULE_ID = "fabula-ultima-companion";
  const CLASS_ROOT_NAME = "Classes";
  const PLAYABLE_FOLDERS = ["Classic Classes", "Custom Classes"];

  // The class actors the level-up window can sell skills from. Same rule as
  // class-registry.js, which is an ES module this classic script cannot import.
  function playableClassActors() {
    return (game.actors?.contents ?? []).filter((a) => {
      const f = a.folder;
      return f && PLAYABLE_FOLDERS.includes(f.name) && f.folder?.name === CLASS_ROOT_NAME;
    });
  }

  // ── Reference lookup ──────────────────────────────────────────────

  let _reference = null;
  async function loadReference() {
    if (_reference) return _reference;
    const url = `modules/${MODULE_ID}/reference/skills.json?cb=${Date.now()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _reference = await res.json();
      return _reference;
    } catch (e) {
      console.error(`${TAG} failed to load reference:`, e);
      return null;
    }
  }

  // Find the reference entry for a (class, name) pair. Searches skills,
  // spells, heroic (class-bound), and universal_heroic. Name match is
  // case-insensitive; case-mismatch surfaces as a separate finding.
  function findReferenceEntry(reference, cls, name) {
    const wantedLower = name.trim().toLowerCase();
    // 1. Class-bound search.
    const classData = reference.classes?.[cls];
    if (classData) {
      const buckets = [
        { arr: classData.skills, type: 'base' },
        { arr: classData.spells, type: 'spell' },
        { arr: classData.heroic, type: 'heroic' },
      ];
      for (const b of buckets) {
        const hit = (b.arr ?? []).find(e => String(e.name).toLowerCase() === wantedLower);
        if (hit) return { entry: hit, type: b.type, class: cls };
      }
    }
    // 2. Universal heroic.
    const uh = (reference.universal_heroic ?? []).find(
      e => String(e.name).toLowerCase() === wantedLower
    );
    if (uh) return { entry: uh, type: 'universal-heroic', class: null };
    // 3. Cross-class search — handle multi-class heroic skills (Powerful
    //    Spell etc.) where the BD master might live in any of the
    //    requirement classes.
    if (reference.classes) {
      for (const [otherCls, data] of Object.entries(reference.classes)) {
        if (otherCls === cls) continue;
        const hit = (data.heroic ?? []).find(
          e => String(e.name).toLowerCase() === wantedLower
        );
        if (hit) return { entry: hit, type: 'heroic-multi', class: otherCls };
      }
    }
    return null;
  }

  // ── Lint pass ──────────────────────────────────────────────────────

  async function runSkillRawDriftLint() {
    const reference = await loadReference();
    if (!reference) return { findings: [], summary: { error: 'no_reference' } };

    const findings = [];

    const classSkills = playableClassActors().flatMap(
      (actor) => actor.items.contents.map((item) => ({ item, cls: actor.name }))
    );

    for (const { item, cls } of classSkills) {
      // Skip non-skill / non-spell items (defensive — a class actor should
      // only contain these but a stray equipment item shouldn't crash).
      const skillType = String(item.system?.props?.skill_type ?? '').toLowerCase();
      if (!['active', 'passive', 'spell', 'other'].includes(skillType) && !item.system?.props?.isHeroic) {
        continue;
      }
      // Author opt-out for homebrew.
      if (item.system?.props?._homebrew === true) continue;

      const ref = findReferenceEntry(reference, cls, item.name);
      if (!ref) {
        findings.push({
          severity: 'info',
          code: 'RAW_REFERENCE_MISSING',
          itemUuid: item.uuid,
          itemName: item.name,
          class: cls,
          message:
            `"${item.name}" (${cls}) has no reference entry. ` +
            `Homebrew? Set \`system.props._homebrew: true\` to silence.`,
        });
        continue;
      }

      // Name case drift.
      if (item.name !== ref.entry.name) {
        findings.push({
          severity: 'info',
          code: 'RAW_NAME_CASE_DRIFT',
          itemUuid: item.uuid,
          itemName: item.name,
          class: cls,
          expected: ref.entry.name,
          message:
            `"${item.name}" → reference name is "${ref.entry.name}" (case mismatch).`,
        });
      }

      // Max SL drift — only for entries that HAVE a max_sl in the reference.
      const refMaxSL = ref.entry.max_sl;
      if (refMaxSL != null) {
        const rawMax = Number(item.system?.props?.max_level);
        const liveMaxLevel = Number.isFinite(rawMax) ? Math.max(1, rawMax) : 1;
        if (liveMaxLevel !== refMaxSL) {
          findings.push({
            severity: 'warning',
            code: 'RAW_MAX_SL_DRIFT',
            itemUuid: item.uuid,
            itemName: item.name,
            class: cls,
            expected: refMaxSL,
            actual: liveMaxLevel,
            message:
              `"${item.name}" max_level=${liveMaxLevel}, RAW max_sl=${refMaxSL} ` +
              `(reference: ${ref.entry.source?.book ?? '?'}).`,
          });
        }
      }

      // Heroic flag drift.
      const isHeroicLive = item.system?.props?.isHeroic === true;
      const isHeroicRef = ref.type === 'heroic' || ref.type === 'heroic-multi'
                       || ref.type === 'universal-heroic';
      if (isHeroicLive !== isHeroicRef) {
        findings.push({
          severity: 'warning',
          code: 'RAW_HEROIC_FLAG_DRIFT',
          itemUuid: item.uuid,
          itemName: item.name,
          class: cls,
          expected: isHeroicRef,
          actual: isHeroicLive,
          message:
            `"${item.name}" isHeroic=${isHeroicLive}, reference type=${ref.type}.`,
        });
      }
    }

    // Summarise by code.
    const byCode = {};
    for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    const summary = {
      total: findings.length,
      warnings: findings.filter(f => f.severity === 'warning').length,
      info: findings.filter(f => f.severity === 'info').length,
      byCode,
    };

    console.info(`${TAG} ${summary.total} findings — ${JSON.stringify(byCode)}`);
    if (summary.total > 0) {
      // Print warnings first.
      for (const f of findings.filter(f => f.severity === 'warning')) {
        console.warn(`${TAG} [${f.code}] ${f.message}`);
      }
      // Custom classes are not in the reference, so these are mostly expected.
      for (const f of findings.filter(f => f.severity === 'info')) {
        console.debug(`${TAG} [${f.code}] ${f.message}`);
      }
    }
    return { findings, summary };
  }

  // ── Register ──────────────────────────────────────────────────────

  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint ?? {};
  globalThis.FUCompanion.api.lint.runSkillRawDriftLint = runSkillRawDriftLint;

  // Auto-run at GM ready (delayed so the boot finishes + auto-migrations
  // settle before the lint reads the world state).
  Hooks.once('ready', () => {
    if (!game.user?.isGM) return;
    setTimeout(() => {
      runSkillRawDriftLint().catch(e => console.error(`${TAG} auto-run threw`, e));
    }, 6000);
  });
})();
