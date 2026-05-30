/**
 * [ONI] Skill RAW Drift Lint
 * ---------------------------------------------------------------------------
 * Compares Battle Director master items against the canonical FU reference
 * in `modules/fabula-ultima-companion/reference/skills.json`. Surfaces:
 *
 *   RAW_MAX_SL_DRIFT
 *     BD master's `system.props.max_level` != reference `max_sl`.
 *     The bug class that surfaced today: Cheap Shot / Soul Steal authored
 *     at max 3 instead of RAW max 5; Dodge at max 5 instead of 3.
 *
 *   RAW_NAME_CASE_DRIFT
 *     BD master's name matches reference case-insensitively but the
 *     casing differs (e.g. "see you later" vs "See You Later").
 *
 *   RAW_HEROIC_FLAG_DRIFT
 *     BD master's `system.props.isHeroic` != reference's heroic-table
 *     membership. A non-heroic skill flagged heroic, or vice versa.
 *
 *   RAW_REFERENCE_MISSING (info)
 *     BD master has a name that doesn't appear in any class's
 *     skills / spells / heroic in the reference. Either a homebrew
 *     skill (silence with `_homebrew: true`), a renamed copy that
 *     drifted from canon, or a reference-coverage gap.
 *
 * Scope: BD-tree masters only (Battle Director / <Class> / ...). Legacy
 * items in `💥 Skill / Class Skill / ...` are untouched.
 *
 * Default severity: info — RAW deviations are sometimes intentional
 * homebrew. Authors override per-item with `system.props._homebrew: true`
 * on the BD master to silence specific drift.
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
  const BD_ROOT_NAME = "Battle Director";

  function isInBDTree(item) {
    let f = item?.folder;
    while (f) {
      if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
      f = f.folder;
    }
    return false;
  }

  // Walk a BD-tree item's folder ancestry to find its <Class> folder
  // (the one directly under Battle Director).
  function getClassFromFolder(item) {
    let f = item?.folder;
    let candidate = null;
    while (f) {
      if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) {
        return candidate;
      }
      candidate = f.name;
      f = f.folder;
    }
    return null;
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

    for (const item of game.items?.contents ?? []) {
      if (!isInBDTree(item)) continue;
      // Skip non-skill / non-spell items (defensive — the BD tree should
      // only contain these but a stray equipment item shouldn't crash).
      const skillType = String(item.system?.props?.skill_type ?? '').toLowerCase();
      if (!['active', 'passive', 'spell'].includes(skillType) && !item.system?.props?.isHeroic) {
        continue;
      }
      // Author opt-out for homebrew.
      if (item.system?.props?._homebrew === true) continue;

      const cls = getClassFromFolder(item);
      if (!cls) continue;

      const ref = findReferenceEntry(reference, cls, item.name);
      if (!ref) {
        findings.push({
          severity: 'info',
          code: 'RAW_REFERENCE_MISSING',
          itemUuid: item.uuid,
          itemName: item.name,
          class: cls,
          message:
            `BD master "${item.name}" (${cls}) has no reference entry. ` +
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
        const liveMaxLevel = Number(item.system?.props?.max_level);
        if (Number.isFinite(liveMaxLevel) && liveMaxLevel !== refMaxSL) {
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
      for (const f of findings.filter(f => f.severity === 'info')) {
        console.info(`${TAG} [${f.code}] ${f.message}`);
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
