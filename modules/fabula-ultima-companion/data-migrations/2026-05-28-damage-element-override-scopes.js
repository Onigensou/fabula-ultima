/**
 * Migration: 2026-05-28-damage-element-override-scopes
 * ---------------------------------------------------------------------------
 * Splits the single `override_damage_type` actor-prop into three explicit
 * scopes so AEs can target Attack / Spell / All damage independently
 * (Spiritist Soul Weapon → attack scope; future class traits → spell or
 * all scope).
 *
 *   1. Adds three new hidden prop keys to every actor template that
 *      already declared the legacy `override_damage_type`:
 *        - override_attack_damage_type
 *        - override_spell_damage_type
 *        - override_all_damage_type
 *      Defaults to "None" (matching the legacy column's default). The
 *      engine's resolveDamageElementOverride treats "" / "None" as
 *      no-override so the defaults pass through cleanly.
 *
 *   2. Rekeys the Soul Weapon AE's `changes` row from
 *        { key: "override_damage_type", ... }
 *      to
 *        { key: "override_attack_damage_type", ... }
 *      on the world Item master AND on any actor-borne synced copies of
 *      the Soul Weapon skill OR live actor AEs named "Soul Weapon" (the
 *      latter catches AEs already applied to creatures mid-scene).
 *
 * The legacy `override_damage_type` column stays in the template + the
 * engine's resolveDamageElementOverride keeps reading it as the
 * back-compat alias for the attack scope. Forks / older AEs that still
 * write to it remain functional.
 *
 * IDEMPOTENT — each step is gated on observable state.
 */

export const key = "2026-05-28-damage-element-override-scopes";
export const description =
  "Actor template: add override_attack/spell/all_damage_type hidden props. " +
  "Soul Weapon AE: rekey changes row from override_damage_type to override_attack_damage_type.";

const NEW_KEYS = [
  "override_attack_damage_type",
  "override_spell_damage_type",
  "override_all_damage_type",
];
const SOUL_WEAPON_NAME = "Soul Weapon";
const LEGACY_KEY = "override_damage_type";
const NEW_ATTACK_KEY = "override_attack_damage_type";

// Recursive search — same shape as the bonus_hp migration's helper.
function nodeExists(root, want, seen = new WeakSet()) {
  if (!root || typeof root !== "object" || seen.has(root)) return false;
  seen.add(root);
  if (root.key === want || root.name === want) return true;
  if (Array.isArray(root)) {
    for (const v of root) if (nodeExists(v, want, seen)) return true;
    return false;
  }
  for (const k of Object.keys(root)) {
    if (["_id", "permission", "flags", "ownership"].includes(k)) continue;
    if (nodeExists(root[k], want, seen)) return true;
  }
  return false;
}

async function patchTemplateActor(actor, log) {
  if (actor.type !== "_template") return { skipped: "not template" };
  // Only patch templates that already had the legacy override_damage_type
  // node — leaves Shopkeeper / utility templates alone.
  if (!nodeExists(actor, LEGACY_KEY)) {
    return { skipped: `no ${LEGACY_KEY} present` };
  }
  const hidden = Array.isArray(actor.system?.hidden) ? [...actor.system.hidden] : [];
  const existingNames = new Set(hidden.map((h) => h?.name));
  const toAdd = NEW_KEYS.filter((k) => !existingNames.has(k));
  if (!toAdd.length) return { skipped: "all keys already present" };
  for (const k of toAdd) hidden.push({ name: k, value: "None" });
  await actor.update({ "system.hidden": hidden });
  log(`Actor template "${actor.name}": added hidden keys [${toAdd.join(", ")}]`);
  return { added: toAdd };
}

async function rekeySoulWeaponAE(ae, contextLabel, log) {
  const changes = ae.changes ?? [];
  const needsRekey = changes.some((c) => c.key === LEGACY_KEY);
  if (!needsRekey) return false;
  const newChanges = changes.map((c) =>
    c.key === LEGACY_KEY ? { ...c, key: NEW_ATTACK_KEY } : c
  );
  await ae.update({ changes: newChanges });
  log(`Soul Weapon AE rekeyed (${contextLabel}): ${LEGACY_KEY} → ${NEW_ATTACK_KEY}`);
  return true;
}

export async function migrate(game, log) {
  // Step 1: template columns
  let templatesPatched = 0;
  for (const actor of (game.actors?.contents ?? [])) {
    try {
      const r = await patchTemplateActor(actor, log);
      if (r?.added) templatesPatched++;
    } catch (e) {
      console.warn(`patchTemplateActor threw on ${actor?.name}`, e);
    }
  }

  // Step 2: rekey Soul Weapon AEs everywhere we can find them.
  let aesRekeyed = 0;
  // 2a. World Item masters named "Soul Weapon" (covers fresh-worlds case
  // where the canonical master may have a different id than this world).
  for (const it of (game.items?.contents ?? [])) {
    if (it.name !== SOUL_WEAPON_NAME) continue;
    for (const ae of (it.effects?.contents ?? [])) {
      if (ae.name !== SOUL_WEAPON_NAME) continue;
      try {
        if (await rekeySoulWeaponAE(ae, `world-master:${it.id}`, log)) aesRekeyed++;
      } catch (e) { console.warn(`rekey master AE threw`, e); }
    }
  }
  // 2b. Actor-borne synced item copies + live actor-AEs.
  for (const actor of (game.actors?.contents ?? [])) {
    // Synced item copies (the Soul Weapon skill item on a PC's roster).
    for (const ai of (actor.items?.contents ?? [])) {
      if (ai.name !== SOUL_WEAPON_NAME) continue;
      for (const ae of (ai.effects?.contents ?? [])) {
        if (ae.name !== SOUL_WEAPON_NAME) continue;
        try {
          if (await rekeySoulWeaponAE(ae, `actor-item:${actor.name}`, log)) aesRekeyed++;
        } catch (e) { console.warn(`rekey actor-item AE threw`, e); }
      }
    }
    // Live actor-level AEs (applied to creatures during play).
    for (const ae of (actor.effects?.contents ?? [])) {
      if (ae.name !== SOUL_WEAPON_NAME) continue;
      try {
        if (await rekeySoulWeaponAE(ae, `actor-AE:${actor.name}`, log)) aesRekeyed++;
      } catch (e) { console.warn(`rekey actor AE threw`, e); }
    }
  }

  log(`damage-element-override-scopes: templates patched=${templatesPatched}, AEs rekeyed=${aesRekeyed}`);
  return {
    applied: true,
    summary: `templates patched=${templatesPatched}, AEs rekeyed=${aesRekeyed}`,
  };
}
