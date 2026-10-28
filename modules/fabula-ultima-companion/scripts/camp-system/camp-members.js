// ============================================================================
// Camp System — Roster-driven member tokens
//
// Camp scenes no longer carry pre-placed party member tokens. The ACTIVE party
// (database member_id_1..4, the same roster the Rest applies to) is spawned
// into the camp scene and removed again on Set Out, so a bench swap, a guest
// or another party's run shows the right faces at camp.
//
// Where they stand comes from the scene's member SPOTS:
//   flags.<module>.campMemberSpots = [{ x, y, actorId, look, scaleRatio, mirror }]
//     x, y        token CENTRE (scene px)
//     actorId     the member this spot was authored for (gets `look` verbatim)
//     look        { texture, sort, flags } of the token that stood there
//     scaleRatio  |look scale| ÷ that actor's prototype scale — the room's size
//     mirror      -1 when the authored token was flipped (facing)
// A spot authored for someone else is filled with the member's own art at the
// room's scale and facing. Members beyond the spots line up by the arrival point.
//
// Spawned tokens carry flags.<module>.campMember = true; only those are ever
// removed. A member token someone placed by hand is respected and left alone.
//
// Primary GM only. ensure() is idempotent: it runs on camp entry (before the
// scene draws), and again whenever a camp scene is drawn — F5, a loaded save,
// a camp the GM opened by hand.
// Design: docs/inn-camp-set-out-design.md §7
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const MOD  = CAMP.MODULE_ID;
  const TAG  = "[CampSystem][Members]";

  const FLAG_MEMBER = "campMember";
  const FLAG_SPOTS  = "campMemberSpots";
  const FLAG_HOME   = "campHome";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;
  const isCampScene = (scene) => scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";

  // One reconcile at a time per scene: entry and canvasReady can both ask.
  const _inFlight = new Map();   // sceneId → Promise

  function _arrivalSpot(scene) {
    const a = scene?.flags?.[MOD]?.campArrival;
    if (Number.isFinite(a?.x) && Number.isFinite(a?.y)) return { x: a.x, y: a.y };
    const i = scene?.initial;
    if (Number.isFinite(i?.x) && Number.isFinite(i?.y)) return { x: i.x, y: i.y };
    return { x: Math.round((scene?.width ?? 0) / 2), y: Math.round((scene?.height ?? 0) / 2) };
  }

  function _tokenData(actor, scene, centre, spot) {
    const g = scene.grid?.size ?? 100;
    const d = actor.prototypeToken.toObject();
    const own = spot?.actorId === actor.id && spot.look;

    if (own) {
      d.texture = foundry.utils.deepClone(spot.look.texture);
      if (Number.isFinite(spot.look.sort)) d.sort = spot.look.sort;
      d.flags = foundry.utils.mergeObject(d.flags ?? {}, foundry.utils.deepClone(spot.look.flags ?? {}), { inplace: false });
    } else if (spot) {
      // Someone else's spot: this member's art at the room's scale and facing.
      const r = Number(spot.scaleRatio) || 1;
      d.texture.scaleX = Math.abs(d.texture.scaleX ?? 1) * r * (spot.mirror === -1 ? -1 : 1);
      d.texture.scaleY = Math.abs(d.texture.scaleY ?? 1) * r;
      if (Number.isFinite(spot.look?.sort)) d.sort = spot.look.sort;
      const lookFlags = foundry.utils.deepClone(spot.look?.flags ?? {});
      d.flags = foundry.utils.mergeObject(d.flags ?? {}, lookFlags, { inplace: false });
    }
    // Camp tokens never show resource bars, authored or not. Bar Brawl with no
    // bars of its own falls back to the CORE bar1/bar2 + displayBars, which
    // the camp UI hider does not reach — so clear both layers.
    d.flags ??= {};
    d.flags.barbrawl = { resourceBars: {} };
    d.displayBars = CONST.TOKEN_DISPLAY_MODES.NONE;
    d.bar1 = { attribute: null };
    d.bar2 = { attribute: null };
    const x = Math.round(centre.x - (d.width ?? 1) * g / 2);
    const y = Math.round(centre.y - (d.height ?? 1) * g / 2);
    // campHome: where (and which way facing) the member was placed, so
    // camp-walk.js can put a member who walked off back on their spot at bedtime.
    const modFlags = d.flags[MOD] ?? {};
    const home = { x, y, facing: modFlags.facing ?? null, facingDir: modFlags.facingDir ?? null };
    d.flags[MOD] = { ...modFlags, [FLAG_MEMBER]: true, [FLAG_HOME]: home };

    Object.assign(d, { actorId: actor.id, actorLink: true, hidden: false, x, y });
    return d;
  }

  async function _reconcile(scene) {
    const members = (await CAMP.RestAPI?.getPartyActors?.()) ?? [];
    const memberIds = new Set(members.map(a => a.id));

    // Spawned tokens of anyone no longer in the active party go.
    const stale = scene.tokens.filter(t => t.getFlag(MOD, FLAG_MEMBER) && !memberIds.has(t.actorId)).map(t => t.id);
    if (stale.length) await scene.deleteEmbeddedDocuments("Token", stale);

    // Members already standing here (spawned, or placed by hand) are left alone.
    const present = new Set(scene.tokens.map(t => t.actorId));
    const missing = members.filter(a => !present.has(a.id));
    if (!missing.length) return { spawned: 0, removed: stale.length };

    const spots = (scene.getFlag(MOD, FLAG_SPOTS) ?? []).filter(s => Number.isFinite(s?.x) && Number.isFinite(s?.y));
    // Spots already taken by a member standing there, by the spot's own member.
    const used = new Set(spots.map((s, i) => (present.has(s.actorId) && memberIds.has(s.actorId)) ? i : -1).filter(i => i >= 0));

    const pick = [];
    // 1 — a member's own authored spot
    for (const a of missing) {
      const i = spots.findIndex((s, j) => !used.has(j) && s.actorId === a.id);
      if (i >= 0) { used.add(i); pick.push([a, spots[i]]); }
    }
    // 2 — any free spot, in authored order
    for (const a of missing) {
      if (pick.some(([b]) => b === a)) continue;
      const i = spots.findIndex((s, j) => !used.has(j));
      if (i >= 0) { used.add(i); pick.push([a, spots[i]]); }
      else pick.push([a, null]);
    }

    // 3 — no spot left: a row beside the arrival point
    const g = scene.grid?.size ?? 100;
    const arrive = _arrivalSpot(scene);
    let overflow = 0;
    const data = pick.map(([a, spot]) => {
      const centre = spot ? { x: spot.x, y: spot.y } : { x: arrive.x + g * (++overflow), y: arrive.y };
      return _tokenData(a, scene, centre, spot);
    });
    await scene.createEmbeddedDocuments("Token", data);
    console.debug(TAG, `${scene.name}: spawned ${data.length} member(s), removed ${stale.length}.`);
    return { spawned: data.length, removed: stale.length };
  }

  CAMP.Members = {
    FLAG_MEMBER, FLAG_SPOTS, FLAG_HOME,

    /** Make the camp scene's member tokens match the active party. */
    ensure(scene) {
      if (!isPrimaryGM() || !scene || !isCampScene(scene)) return Promise.resolve(null);
      const prev = _inFlight.get(scene.id) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => _reconcile(scene))
        .catch(e => { console.error(TAG, "ensure failed:", e); return null; });
      _inFlight.set(scene.id, next);
      next.finally(() => { if (_inFlight.get(scene.id) === next) _inFlight.delete(scene.id); });
      return next;
    },

    /** Remove every spawned member token from a scene (after Set Out). */
    async clear(scene) {
      if (!isPrimaryGM() || !scene) return 0;
      await (_inFlight.get(scene.id) ?? Promise.resolve()).catch(() => {});
      const ids = scene.tokens.filter(t => t.getFlag(MOD, FLAG_MEMBER)).map(t => t.id);
      if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids);
      return ids.length;
    },

    /**
     * Authoring helper: turn the member tokens currently standing on a camp
     * scene into its member spots, then remove them. `actorIds` = whose tokens
     * count as members (default: the active party). Returns the spots written.
     */
    async captureSpots(scene, { actorIds = null } = {}) {
      if (!game.user?.isGM || !scene) return null;
      const ids = new Set(actorIds ?? (await CAMP.RestAPI.getPartyActors()).map(a => a.id));
      const g = scene.grid?.size ?? 100;
      const toks = scene.tokens.filter(t => ids.has(t.actorId));
      const spots = toks.map(t => {
        const proto = game.actors.get(t.actorId)?.prototypeToken;
        const pScale = Math.abs(proto?.texture?.scaleX ?? 1) || 1;
        const tScale = t.texture?.scaleX ?? 1;
        const flags = foundry.utils.deepClone(t.flags ?? {});
        delete flags[MOD]?.[FLAG_MEMBER];
        delete flags[MOD]?.[FLAG_HOME];
        return {
          x: Math.round(t.x + (t.width ?? 1) * g / 2),
          y: Math.round(t.y + (t.height ?? 1) * g / 2),
          actorId: t.actorId,
          look: { texture: t.toObject().texture, sort: t.sort ?? 0, flags },
          scaleRatio: Math.round((Math.abs(tScale) / pScale) * 1000) / 1000,
          mirror: tScale < 0 ? -1 : 1,
        };
      });
      await scene.update({ [`flags.${MOD}.${FLAG_SPOTS}`]: spots });
      if (toks.length) await scene.deleteEmbeddedDocuments("Token", toks.map(t => t.id));
      return spots;
    },
  };

  console.debug(TAG, "Camp members loaded.");
})();
