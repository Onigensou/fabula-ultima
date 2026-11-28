// ============================================================================
// Opportunity Effects — Charm accessories (user design 2026-11-28)
//
//   Misfortune  (Hex Coin)          Deals 1d100 non-elemental damage to one enemy.   battle only
//   Calamity    (Doomsayer's Bell)  Deals 1d50 non-elemental damage to all enemies.  battle only
//   Succor      (Mender's Ribbon)   One creature recovers 50 HP.
//   Calm        (Moonstone Pendant) One creature recovers 50 MP.
//   Sooth       (Saint's Rosary)    One creature recovers from all negative statuses.
//
// Each option is gated by `requiresFlag: "opp_<id>"` in opportunity-config.js;
// the accessory's equip-toggled AE sets that flag (Bunny Tail / Lucky pattern).
// The point (user): more picks for Hina's Zero Power "A Million Possibility".
//
// Flow: pre (picker's client) chooses the target; post (one GM) applies it.
// Damage and recovery go through FUCompanion.api.applyDamage.applyToActor:
//   - non-elemental = ignoreAffinity (no VU/RS/IM/AB) and NO attacker props, so
//     the roll lands as rolled; DR and Shield still apply. Never a crit.
//   - Calamity rolls ONCE and deals that amount to every enemy (FU multi-target).
// Out of battle the heals pick a PARTY MEMBER (dungeon mode = one party token).
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Charms]";
  const NS  = "fabula-ultima-companion";
  const SFX_CLEANSE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Up1.ogg";

  const utils  = () => window["oni.OppEffectUtils"] ?? {};
  const dmgApi = () => globalThis.FUCompanion?.api?.applyDamage ?? null;
  const bd     = () => globalThis.FUCompanion?.api?.experimental?.battleDirector ?? null;

  function playSound(url, vol = 0.7) {
    try { (foundry.audio.AudioHelper ?? AudioHelper).play({ src: url, volume: vol, autoplay: true }, true); }
    catch (_) {}
  }

  // Works on every client: the director instance lives on the GM, but battle
  // tokens carry `directorSpawned` from creation until battle end.
  function battleOnCanvas() {
    if (utils().isInBattle?.()) return true;
    return (canvas?.tokens?.placeables ?? []).some(t => !!t.document?.flags?.[NS]?.directorSpawned);
  }

  async function rollDie(formula) {
    const roll = new Roll(formula);
    await roll.evaluate();
    try { await game.dice3d?.showForRoll(roll, game.user, true); } catch (_) {}
    return Math.max(0, Number(roll.total) || 0);
  }

  // Token pick in battle, party pick outside. Returns a serializable ref or null.
  async function pickTarget(ctx, { title, skillTarget = "One Creature", includeSource = true, battleOnly = false }) {
    const { pickToken, pickPartyMember } = utils();
    if (!battleOnCanvas()) {
      if (battleOnly) { ui.notifications?.warn(`[Opportunity] ${title.split(" —")[0]} can only be used in battle.`); return null; }
      if (!pickPartyMember) return null;
      const actor = await pickPartyMember({ title, sourceActorUuid: ctx.actorUuid, includeSource });
      return actor ? { actorUuid: actor.uuid } : null;
    }
    if (!pickToken) return null;
    const token = await pickToken({ title, skillTarget, sourceActorUuid: ctx.actorUuid, includeSource });
    return token ? { tokenId: token.id, tokenUuid: token.document?.uuid ?? null } : null;
  }

  // → { actor, token } from a pickTarget ref (token actor for unlinked NPCs).
  async function resolveTarget(ref) {
    if (!ref) return { actor: null, token: null };
    if (ref.actorUuid) {
      const actor = await fromUuid(ref.actorUuid).catch(() => null);
      return { actor, token: actor?.getActiveTokens?.()?.[0] ?? null };
    }
    let tokenDoc = ref.tokenUuid ? await fromUuid(ref.tokenUuid).catch(() => null) : null;
    if (!tokenDoc && ref.tokenId) tokenDoc = canvas?.scene?.tokens?.get(ref.tokenId) ?? null;
    const token = tokenDoc?.object ?? null;
    return { actor: tokenDoc?.actor ?? null, token };
  }

  // Living combatants on the other side from the acting actor (GM side: post).
  function opposingCombatants(actorUuid) {
    const dc = bd()?.getActiveDirector?.()?.ctx?.dCombat;
    const all = dc?.combatants ?? [];
    const actorId = String(actorUuid ?? "").split(".").pop();
    const me = all.find(c => c.actorDoc?.uuid === actorUuid || c.actorDoc?.id === actorId || c.tokenDoc?.actor?.uuid === actorUuid);
    const enemySide = me?.side === "enemy" ? "party" : "enemy";
    return all.filter(c => c.side === enemySide && c.actorDoc && !c.isDefeatedLive?.());
  }

  async function applyAmount({ ctx, target, token, amount, isRecovery = false, valueType = "hp" }) {
    const api = dmgApi();
    if (!api?.applyToActor) { console.error(TAG, "applyDamage API missing"); return null; }
    return api.applyToActor({
      baseDamage:     amount,
      elementType:    "elementless",
      valueType,
      isRecovery,
      ignoreAffinity: true,
      targetActor:    target,
      targetToken:    token?.document ?? token ?? null,
      attackerName:   ctx.option?.label ?? "Opportunity",
      sourceType:     "Opportunity",
      feedback:       battleOnCanvas() ? "none" : "show",
    }).catch(e => { console.error(TAG, "applyToActor failed", e); return null; });
  }

  const line = (html) => `<div style="font-weight:900;">${html}</div>`;

  // ── Misfortune ────────────────────────────────────────────────────────────
  function registerAll() {
    const reg = window["oni.OppEffectRegistry"];
    if (!reg) { console.error(TAG, "registry missing"); return; }

    reg.register("misfortune", {
      pre: (ctx) => pickTarget(ctx, { title: "Misfortune — Choose Target", skillTarget: "One Enemy", includeSource: false, battleOnly: true }),
      async post(ctx, pre) {
        const { actor, token } = await resolveTarget(pre);
        if (!actor) { console.error(TAG, "[misfortune] target not found", pre); return; }
        const amount = await rollDie("1d100");
        await applyAmount({ ctx, target: actor, token, amount });
        return { resultSummary: line(`Rolled 1d100 = ${amount} &rarr; ${foundry.utils.escapeHTML?.(actor.name) ?? actor.name}`) };
      },
    });

    // ── Calamity ────────────────────────────────────────────────────────────
    reg.register("calamity", {
      async pre() {
        if (!battleOnCanvas()) { ui.notifications?.warn("[Opportunity] Calamity can only be used in battle."); return null; }
        return {};
      },
      async post(ctx) {
        const foes = opposingCombatants(ctx.actorUuid);
        if (!foes.length) { console.warn(TAG, "[calamity] no enemies found"); return { resultSummary: line("No enemies to hit.") }; }
        const amount = await rollDie("1d50");
        for (const c of foes) {
          await applyAmount({ ctx, target: c.tokenDoc?.actor ?? c.actorDoc, token: c.tokenDoc, amount });
        }
        return { resultSummary: line(`Rolled 1d50 = ${amount} &rarr; all enemies (${foes.length})`) };
      },
    });

    // ── Succor / Calm ───────────────────────────────────────────────────────
    for (const [id, label, valueType] of [["succor", "Succor", "hp"], ["calm", "Calm", "mp"]]) {
      reg.register(id, {
        pre: (ctx) => pickTarget(ctx, { title: `${label} — Choose Target` }),
        async post(ctx, pre) {
          const { actor, token } = await resolveTarget(pre);
          if (!actor) { console.error(TAG, `[${id}] target not found`, pre); return; }
          await applyAmount({ ctx, target: actor, token, amount: 50, isRecovery: true, valueType });
          return { resultSummary: line(`${actor.name} recovers 50 ${valueType.toUpperCase()}`) };
        },
      });
    }

    // ── Sooth ───────────────────────────────────────────────────────────────
    reg.register("sooth", {
      pre: (ctx) => pickTarget(ctx, { title: "Sooth — Choose Target" }),
      async post(ctx, pre) {
        const { actor } = await resolveTarget(pre);
        if (!actor) { console.error(TAG, "[sooth] target not found", pre); return; }
        // Same debuff rule as the Healing menu's Cleanse (skips set/permanent/uncleansable).
        const mod = await import(foundry.utils.getRoute(`modules/${NS}/scripts/healing-system/healing-cleanse.js`));
        const debuffs = mod.actorDebuffs(actor);
        if (debuffs.length) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", debuffs.map(e => e.id))
            .catch(e => console.error(TAG, "[sooth] delete failed", e));
          playSound(SFX_CLEANSE, 0.8);
        }
        const names = debuffs.map(e => e.name).join(", ");
        return { resultSummary: line(debuffs.length ? `${actor.name} recovers from ${names}` : `${actor.name} had no statuses`) };
      },
    });

    console.debug(TAG, "Charm opportunities registered (misfortune, calamity, succor, calm, sooth).");
  }

  Hooks.once("ready", registerAll);
})();
