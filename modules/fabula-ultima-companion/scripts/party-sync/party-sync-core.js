// scripts/party-sync/party-sync-core.js
// Sync engine for the party sheet.
// Reads member/bench actor IDs from the DB actor, then copies stats + portrait
// (actor.img) back into the party sheet in one batch update.
// Exposed as FUCompanion.api.syncPartySheet() — called by the auto-hook and
// available for manual use in the console.

(() => {
  const PATH        = "system.props";
  const ACTIVE_SLOTS = 4;
  const BENCH_SLOTS  = 6;
  const HARD_MAX_ZP  = 6;

  const gp = (obj, key) => foundry.utils.getProperty(obj, key);

  function readStat(actor, keys, fallback = 0) {
    for (const k of keys) {
      const v = gp(actor, `${PATH}.${k}`);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return fallback;
  }

  async function resolveActor(ref) {
    const raw = (ref ?? "").toString().trim();
    if (!raw) return null;
    if (/^Actor\./i.test(raw)) return fromUuid(raw).catch(() => null);
    return game.actors?.get(raw) ?? fromUuid(`Actor.${raw}`).catch(() => null);
  }

  async function syncPartySheet() {
    if (!game.user.isGM) return;

    const resolved = await window.FUCompanion?.api?.getCurrentGameDb?.();
    const partyActor = resolved?.db;
    if (!partyActor) {
      console.warn("[PartySync] Could not resolve party actor via DB resolver.");
      return;
    }

    const upd = {};
    const write = (field, val) => { upd[`${PATH}.${field}`] = val; };

    async function copySlot(kind, slot) {
      const idKey = `${kind}_id_${slot}`;
      const ref   = gp(partyActor, `${PATH}.${idKey}`) ?? "";
      const actor = await resolveActor(ref);

      write(`${kind}_name_${slot}`, actor?.name ?? "");

      if (!actor) {
        write(`${kind}_level_${slot}`,     0);
        write(`${kind}_exp_${slot}`,       0);
        write(`${kind}_currenthp_${slot}`, 0);
        write(`${kind}_maxhp_${slot}`,     0);
        write(`${kind}_currentmp_${slot}`, 0);
        write(`${kind}_maxmp_${slot}`,     0);
        write(`${kind}_currentip_${slot}`, 0);
        write(`${kind}_maxip_${slot}`,     0);
        write(`${kind}_currentzp_${slot}`, 0);
        write(`${kind}_maxzp_${slot}`,     HARD_MAX_ZP);
        write(`${kind}_zenit_${slot}`,     0);
        if (kind === "member") write(`member_sprite_${slot}`, "");
        return 0;
      }

      write(`${kind}_level_${slot}`,     Number(readStat(actor, ["level"], 0))                                           || 0);
      write(`${kind}_exp_${slot}`,       Number(readStat(actor, ["experience", "exp"], 0))                               || 0);
      write(`${kind}_currenthp_${slot}`, Number(readStat(actor, ["current_hp",  "currenthp"],  0))                      || 0);
      write(`${kind}_maxhp_${slot}`,     Number(readStat(actor, ["max_hp",      "maxhp"],       0))                      || 0);
      write(`${kind}_currentmp_${slot}`, Number(readStat(actor, ["current_mp",  "currentmp"],   0))                      || 0);
      write(`${kind}_maxmp_${slot}`,     Number(readStat(actor, ["max_mp",      "maxmp"],        0))                      || 0);
      write(`${kind}_currentip_${slot}`, Number(readStat(actor, ["current_ip",  "currentip"],   0))                      || 0);
      write(`${kind}_maxip_${slot}`,     Number(readStat(actor, ["max_ip",      "maxip"],        0))                      || 0);
      write(`${kind}_currentzp_${slot}`, Number(readStat(actor, ["zero_power_value", "currentzp", "zp"], 0))             || 0);
      write(`${kind}_maxzp_${slot}`,     HARD_MAX_ZP);

      const z = Number(readStat(actor, ["zenit"], 0)) || 0;
      write(`${kind}_zenit_${slot}`, z);

      // Portrait sync: active member slots only; use the actor's portrait image
      if (kind === "member") write(`member_sprite_${slot}`, actor.img ?? "");

      return z;
    }

    let totalZenit = 0;
    for (let i = 1; i <= ACTIVE_SLOTS; i++) totalZenit += await copySlot("member", i);
    for (let i = 1; i <= BENCH_SLOTS;  i++) totalZenit += await copySlot("bench",  i);

    const partyCoffer = Number(gp(partyActor, `${PATH}.zenit`)) || 0;
    write("total_zenit", totalZenit + partyCoffer);

    await partyActor.update(upd);
    console.log(`[PartySync] Synced. Members+bench zenit: ${totalZenit}, party coffer: ${partyCoffer}`);
  }

  Hooks.once("ready", () => {
    window.FUCompanion       ??= { api: {} };
    window.FUCompanion.api   ??= {};
    window.FUCompanion.api.syncPartySheet = syncPartySheet;
    console.debug("[PartySync] syncPartySheet registered.");
  });
})();
