/**
 * [ONI] Engine Canon Lint
 * ---------------------------------------------------------------------------
 * Scans the director engine source files for skill-name hardcoding and
 * class-specific boolean-flag reads — the patterns that violate the
 * "engine dispatches via reaction_config_table only" canon.
 *
 * Complements `reaction-config-lint.js`:
 *   - reaction-config-lint  → flags DATA carrying deprecated fields
 *   - engine-canon-lint     → flags CODE that reads / branches on skill
 *                              names or hardcoded class flags
 *
 * Patterns surfaced (each line snippet manually triaged):
 *
 *   ENGINE_HARDCODED_SKILL_NAME
 *     `*.name === "<SomeName>"` (or `!==`) where the name is alphabetic
 *     and 4+ chars. False-positive: legitimate generic-string matches
 *     like `"Slow"`, `"Wet"` (statuses). Reviewer skips those.
 *
 *   ENGINE_DEPRECATED_PASSIVE_FLAG_READ
 *     `props.<x>_passive` reads — engine should not gate on
 *     class-specific boolean props. Carrier behavior should be expressed
 *     via reaction_config_table rows the dispatcher consumes.
 *
 *   ENGINE_HARDCODED_UUID
 *     `Item.<22-char>` or `Actor.<22-char>` literals in source — hardcoded
 *     world UUIDs that don't survive a fresh world. Author lookups by
 *     `name` or `system.uniqueId` instead.
 *
 *   ENGINE_FILE_UNCLASSIFIED (info)
 *     A .js file lives in scripts/battle-director/ but appears in neither
 *     ENGINE_FILES (scanned) nor NON_ENGINE_FILES (excluded). Classify it.
 *     Gap 5 from canon hardening — prevents the lint silently stopping
 *     coverage when a new engine file is added but the array isn't updated.
 *
 * Usage:
 *   await FUCompanion.api.lint.runEngineCanonLint();
 *   // → { issues: [...], summary: { total, errors, warnings, byCode } }
 *
 * Auto-runs at GM ready (after a short delay so the boot finishes).
 * The lint fetches the .js source files via Foundry's HTTP server, so
 * it sees the EXACT shipped code, not a stale cached copy.
 *
 * Not in scope:
 *   - Behavioral / runtime correctness (this is static text grep, no AST).
 *   - Inferring whether a flagged hit is intentional. The reviewer's job;
 *     persistent intentional sites can be moved to ALLOWLIST below.
 */

(() => {
  const TAG = "[EngineCanonLint]";
  const MODULE_ID = "fabula-ultima-companion";

  // Engine source files to scan. Adding new files: keep this list narrow
  // to the director-native engine — legacy reaction-system / check-roller
  // are tracked separately.
  const ENGINE_FILES = [
    "scripts/battle-director/state-handlers.js",
    "scripts/battle-director/skill-effects.js",
    "scripts/battle-director/skill-formulas.js",
    "scripts/battle-director/skill-recipes.js",
    "scripts/battle-director/skill-targeting.js",
    "scripts/battle-director/skill-cost.js",
    "scripts/battle-director/skill-charges.js",
    "scripts/battle-director/skill-intent.js",
    "scripts/battle-director/passive-manager.js",
    "scripts/battle-director/equipment-swap.js",
    "scripts/battle-director/compose-action.js",
  ];

  // Files in the battle-director folder that are EXPLICITLY NOT engine
  // code — UI, registry, boot, harness, etc. Gap 5 from canon hardening:
  // auto-discover files in the folder and warn for any not in ENGINE_FILES
  // or this exclude list (i.e. an unclassified file that may need to be
  // added to ENGINE_FILES if it implements skill behavior).
  const ENGINE_FOLDER = "modules/fabula-ultima-companion/scripts/battle-director";
  const NON_ENGINE_FILES = new Set([
    "scripts/battle-director/_test-harness-director.js",
    "scripts/battle-director/action-card.js",
    "scripts/battle-director/attribute-pair-picker.js",
    "scripts/battle-director/director-boot.js",
    "scripts/battle-director/director-combat.js",
    "scripts/battle-director/director-init.js",
    "scripts/battle-director/director-triggers.js",
    "scripts/battle-director/director-vfx.js",
    "scripts/battle-director/director.js",
    "scripts/battle-director/intent-channel.js",
    "scripts/battle-director/intents.js",
    "scripts/battle-director/item-resource.js",
    "scripts/battle-director/legacy-suppressor.js",
    "scripts/battle-director/logger.js",
    "scripts/battle-director/item-picker.js",
    "scripts/battle-director/list-picker.js",
    "scripts/battle-director/persistence.js",
    "scripts/battle-director/registries.js",
    "scripts/battle-director/rewind-button.js",
    "scripts/battle-director/skill-picker.js",
    "scripts/battle-director/snapshot.js",
    "scripts/battle-director/states.js",
    "scripts/battle-director/target-picker.js",
    "scripts/battle-director/turn-picker.js",
    "scripts/battle-director/turn-ui.js",
    "scripts/battle-director/weapon-mode-picker.js",
  ]);

  // Known intentional violations. Each entry kills one issue. Use sparingly —
  // every entry is an admission that the canon doesn't yet cover the case.
  // Format: { file, code, lineHint } — lineHint is a substring of the
  // offending line; we match flexibly so adding/removing lines above the
  // hit doesn't break the allowlist.
  const ALLOWLIST = [
    // (none yet — Vismagus IS the canonical violation and should be
    //  refactored, not silenced)
  ];

  // Declared code-backed content (shared/code-backed-content.js) is the OTHER
  // allowlist, and the one that actually gets used. A hardcoded name is a canon
  // violation *unless it has been reviewed and declared* — declaring it is what
  // makes "this skill is implemented, in code, over here" discoverable at all.
  // Undeclared names still fire, so a new code-backed lookup can't slip in
  // unnoticed the way Quick Summoning did (found 2026-08-09, years after it
  // shipped, only because a party audit reported it as UNBUILT).
  // Read off the global: this lint is a classic script and cannot import.
  function declaredCodeBacked() {
    const reg = globalThis["oni.CodeBackedContent"];
    try { return new Set(reg?.codeBackedNames?.() ?? []); }
    catch { return new Set(); }
  }

  function isAllowed(file, code, line) {
    for (const entry of ALLOWLIST) {
      if (entry.file !== file) continue;
      if (entry.code !== code) continue;
      if (entry.lineHint && !line.includes(entry.lineHint)) continue;
      return true;
    }
    return false;
  }

  // ─── Pattern scanners ──────────────────────────────────────────────────

  // Strings that look like Foundry status names — common false positives we
  // skip when scanning for hardcoded skill name comparisons.
  const STATUS_LIKE = new Set([
    "Slow", "Dazed", "Shaken", "Weak", "Enraged", "Poisoned",
    "Wet", "Oil", "Petrify", "Hypothermia", "Turbulence", "Zombie",
    "Guard", "Crisis", "Defeated",
    "fire", "ice", "bolt", "earth", "air", "light", "dark", "poison", "physical",
  ]);

  // `<expr>.name === "<Capitalized name with 4+ chars>"` or `!==`.
  // Skips status-like strings.
  const RX_NAME_EQ = /\.name\s*(===|!==)\s*"([A-Z][A-Za-z]{3,}(?:\s+[A-Z][A-Za-z]+)*)"/g;
  // The LOWERCASED form the original regex missed entirely:
  //   String(it.name ?? "").trim().toLowerCase() === "quick summoning"
  // This is how most engine name checks are actually written, so the scanner was
  // blind to the majority of the pattern it exists to find — the ALLOWLIST sat
  // empty not because there were no violations but because none were detected.
  // Anchored on `name` so it can't drag in the many `skill_type`/`item_type`
  // comparisons written the same way (unanchored, this fired 71 false positives
  // against 0 real ones — a scanner nobody can trust is a scanner nobody reads).
  const RX_NAME_EQ_LOWER =
    /\bname\b[^=\n]{0,60}?toLowerCase\(\)\s*(===|!==)\s*"([a-z][a-z' -]{3,})"/g;
  function scanHardcodedSkillName(src, file) {
    const out = [];
    const declared = declaredCodeBacked();
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rx of [RX_NAME_EQ, RX_NAME_EQ_LOWER]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(line)) !== null) {
        const name = m[2];
        if (STATUS_LIKE.has(name)) continue;
        if (declared.has(name.toLowerCase())) continue;   // reviewed + declared
        // Skip strings that look like prop keys ("Strict-mode" etc.)
        if (/_/.test(name)) continue;
        if (isAllowed(file, "ENGINE_HARDCODED_SKILL_NAME", line)) continue;
        out.push({
          severity: "warning",
          code: "ENGINE_HARDCODED_SKILL_NAME",
          file, line: i + 1,
          snippet: line.trim().slice(0, 160),
          message:
            `Engine code references a skill by name ("${name}"). ` +
            `Behavior should dispatch via reaction_config_table — not a ` +
            `string check on the skill's name. If "${name}" needs special ` +
            `handling, model it as a reaction_config_table row with the ` +
            `appropriate trigger / effect_kind, or via a system flag on the ` +
            `actor / AE that the dispatcher reads.`,
        });
      }
      }
    }
    return out;
  }

  // `props.<X>_passive` or `system.props.<X>_passive` — class-specific
  // boolean flags read by the engine.
  const RX_PASSIVE_FLAG = /\bprops\??\.([a-z][a-z0-9_]*_passive)\b/g;
  function scanDeprecatedPassiveFlagRead(src, file) {
    const out = [];
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      RX_PASSIVE_FLAG.lastIndex = 0;
      let m;
      while ((m = RX_PASSIVE_FLAG.exec(line)) !== null) {
        const flagKey = m[1];
        // Allowlist generic flag names that aren't class-specific:
        if (flagKey === "is_passive") continue;        // CSB generic
        if (isAllowed(file, "ENGINE_DEPRECATED_PASSIVE_FLAG_READ", line)) continue;
        out.push({
          severity: "warning",
          code: "ENGINE_DEPRECATED_PASSIVE_FLAG_READ",
          file, line: i + 1,
          snippet: line.trim().slice(0, 160),
          message:
            `Engine reads class-specific boolean flag "props.${flagKey}". ` +
            `Replace with a reaction_config_table row that the dispatcher ` +
            `consumes generically. The engine should never know that ` +
            `"${flagKey}" exists.`,
        });
      }
    }
    return out;
  }

  // Foundry UUID literals in source: `Item.<16+chars>` / `Actor.<16+chars>` /
  // `Scene.<16+chars>`. False positive: doc-comment examples (we filter
  // when the line starts with `//` or is inside a `/* ... */` we don't
  // easily detect — accepted noise).
  const RX_UUID_LIT = /"(?:Item|Actor|Scene)\.[A-Za-z0-9]{14,}"/g;
  function scanHardcodedUuid(src, file) {
    const out = [];
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\/\//.test(line)) continue;            // line comment
      if (/^\s*\*/.test(line)) continue;              // block comment continuation
      RX_UUID_LIT.lastIndex = 0;
      let m;
      while ((m = RX_UUID_LIT.exec(line)) !== null) {
        const uuid = m[0];
        if (isAllowed(file, "ENGINE_HARDCODED_UUID", line)) continue;
        out.push({
          severity: "warning",
          code: "ENGINE_HARDCODED_UUID",
          file, line: i + 1,
          snippet: line.trim().slice(0, 160),
          message:
            `Hardcoded UUID literal ${uuid} in source. UUIDs don't survive a ` +
            `fresh world — look up by name (game.items.getName) or by ` +
            `system.uniqueId. If this UUID is a stable template id, surface ` +
            `it via a constants module so the dependency is explicit.`,
        });
      }
    }
    return out;
  }

  // ─── Driver ────────────────────────────────────────────────────────────

  async function fetchSrc(path) {
    const url = "/" + path.replace(/^\/+/, "");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
    return await res.text();
  }

  // Auto-discover files in the battle-director folder via FilePicker.
  // Warn for any .js file that's neither in ENGINE_FILES nor in
  // NON_ENGINE_FILES — author either missed adding it to ENGINE_FILES
  // (so the lint scans it) or missed classifying it as non-engine
  // (so this warning stops nagging).
  async function discoverUnlistedFiles() {
    const out = [];
    try {
      const picker = await FilePicker.browse("data", ENGINE_FOLDER);
      const allFiles = (picker?.files ?? [])
        .filter((p) => p.endsWith(".js"))
        .map((p) => p.replace(/^modules\/fabula-ultima-companion\//, ""));
      const known = new Set([...ENGINE_FILES, ...NON_ENGINE_FILES]);
      for (const f of allFiles) {
        if (!known.has(f)) {
          out.push({
            severity: "info",
            code: "ENGINE_FILE_UNCLASSIFIED",
            file: f, line: 0,
            snippet: "",
            message:
              `Battle-director file "${f}" is not in ENGINE_FILES nor ` +
              `NON_ENGINE_FILES. If it dispatches skill behavior, add to ` +
              `ENGINE_FILES so the lint scans it. If it's UI / boot / ` +
              `harness, add to NON_ENGINE_FILES to silence this warning.`,
          });
        }
      }
    } catch (e) {
      out.push({
        severity: "warning",
        code: "ENGINE_FILE_DISCOVERY_FAILED",
        file: ENGINE_FOLDER, line: 0,
        snippet: "",
        message: `FilePicker.browse failed: ${e?.message ?? e}`,
      });
    }
    return out;
  }

  async function runEngineCanonLint(opts = {}) {
    const allIssues = [];
    allIssues.push(...await discoverUnlistedFiles());
    for (const file of ENGINE_FILES) {
      let src;
      try {
        src = await fetchSrc(`modules/${MODULE_ID}/${file}`);
      } catch (e) {
        allIssues.push({
          severity: "error",
          code: "ENGINE_SOURCE_FETCH_FAILED",
          file, line: 0,
          message: `Could not fetch ${file}: ${e?.message ?? e}`,
        });
        continue;
      }
      allIssues.push(...scanHardcodedSkillName(src, file));
      allIssues.push(...scanDeprecatedPassiveFlagRead(src, file));
      allIssues.push(...scanHardcodedUuid(src, file));
    }
    const summary = {
      total: allIssues.length,
      errors:   allIssues.filter(i => i.severity === "error").length,
      warnings: allIssues.filter(i => i.severity === "warning").length,
      info:     allIssues.filter(i => i.severity === "info").length,
      byCode: {},
      byFile: {},
    };
    for (const i of allIssues) {
      summary.byCode[i.code] = (summary.byCode[i.code] || 0) + 1;
      summary.byFile[i.file] = (summary.byFile[i.file] || 0) + 1;
    }
    if (opts.console !== false) {
      console.log(`${TAG} ${summary.total} issue(s)`, summary);
      if (summary.total > 0) {
        const grouped = new Map();
        for (const i of allIssues) {
          if (!grouped.has(i.file)) grouped.set(i.file, []);
          grouped.get(i.file).push(i);
        }
        for (const [file, items] of grouped) {
          console.groupCollapsed(`${TAG} ${file} (${items.length})`);
          for (const i of items) {
            const fn = i.severity === "error"
              ? console.error
              : i.severity === "warning"
                ? console.warn
                : console.info;
            fn.call(
              console,
              `${TAG} [${i.code}] ${file}:${i.line} — ${i.message}`,
              `\n    ${i.snippet}`
            );
          }
          console.groupEnd();
        }
      }
    }
    return { issues: allIssues, summary };
  }

  // GM-only auto-run on ready (delayed so the boot finishes its noise first).
  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;
    setTimeout(async () => {
      try {
        const { summary } = await runEngineCanonLint({ console: true });
        if (summary.warnings > 0 || summary.errors > 0) {
          ui.notifications?.warn(
            `[Engine Canon] ${summary.errors} error / ${summary.warnings} warning — see console.`
          );
        }
      } catch (e) {
        console.error(`${TAG} auto-run failed:`, e);
      }
    }, 3000);
  });

  globalThis.FUCompanion        = globalThis.FUCompanion        || {};
  globalThis.FUCompanion.api    = globalThis.FUCompanion.api    || {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint || {};
  globalThis.FUCompanion.api.lint.runEngineCanonLint = runEngineCanonLint;

  console.debug(`${TAG} Installed. Call FUCompanion.api.lint.runEngineCanonLint() to scan.`);
})();
