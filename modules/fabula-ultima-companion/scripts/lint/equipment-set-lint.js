/**
 * [ONI] Equipment Set Membership Lint
 * ---------------------------------------------------------------------------
 * Equipment-set membership is a free-text `set_name` shared between the
 * wearable pieces (CSB `isSet` + `set_name`) and the Equipment Set doc that
 * defines the bonuses (matching `set_name` + a `set_bonus_table`). It's an
 * exact-string join, so a typo silently breaks grouping and grants no bonus —
 * the "Spirit of Vengeance" vs "Vengence" class of bug.
 *
 * (Membership stays a string deliberately: CSB's `container` model — the only
 * drag-to-link primitive — would hide a piece from inventory, since CustomActor
 * excludes container'd items from the top-level list. So we guard the string
 * instead of replacing it.)
 *
 * RULES (each finding is { severity, code, location, message }):
 *
 *   SET_PIECE_NO_NAME (warning)
 *     A piece has `isSet` ticked but an empty / sentinel `set_name`.
 *
 *   SET_PIECE_NO_DEF (warning)
 *     A piece's `set_name` matches no Equipment Set doc — typo or missing doc.
 *     Includes a Levenshtein near-miss suggestion ("did you mean …?").
 *
 *   SET_DEF_ORPHAN (info)
 *     An Equipment Set doc whose `set_name` matches no piece anywhere.
 *
 * Scope: every world Item + every actor-embedded Item (so monster gear authored
 * straight on the actor — e.g. Fjord — is covered too).
 *
 * Usage:
 *   await FUCompanion.api.lint.runEquipmentSetLint();
 *   // → { findings, summary: { total, warnings, info, byCode } }
 *
 * Auto-runs at GM ready (the startup audit). Shares the scan with the engine
 * (battle-director/set-bonus.js → auditEquipmentSetMembership) so there is one
 * source of truth.
 */

(() => {
  const TAG = "[EquipmentSetLint]";
  const SET_BONUS_URL = "/modules/fabula-ultima-companion/scripts/battle-director/set-bonus.js";

  async function runEquipmentSetLint() {
    let audit;
    try {
      ({ auditEquipmentSetMembership: audit } = await import(SET_BONUS_URL));
    } catch (e) {
      console.error(`${TAG} could not load the engine audit`, e);
      return { findings: [], summary: { total: 0, warnings: 0, info: 0, byCode: {} } };
    }
    const { findings, summary } = audit();

    console.info(`${TAG} ${summary.total} findings — ${JSON.stringify(summary.byCode)}`);
    for (const f of findings.filter((x) => x.severity === "warning")) {
      console.warn(`${TAG} [${f.code}] ${f.message}`);
    }
    for (const f of findings.filter((x) => x.severity === "info")) {
      console.info(`${TAG} [${f.code}] ${f.message}`);
    }
    return { findings, summary };
  }

  // ── Register ──────────────────────────────────────────────────────
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.lint = globalThis.FUCompanion.api.lint ?? {};
  globalThis.FUCompanion.api.lint.runEquipmentSetLint = runEquipmentSetLint;

  // Auto-run at GM ready (delayed so boot + auto-migrations settle first).
  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;
    setTimeout(() => {
      runEquipmentSetLint().catch((e) => console.error(`${TAG} auto-run threw`, e));
    }, 6500);
  });

  console.debug(`${TAG} Installed. Call FUCompanion.api.lint.runEquipmentSetLint() to scan.`);
})();
