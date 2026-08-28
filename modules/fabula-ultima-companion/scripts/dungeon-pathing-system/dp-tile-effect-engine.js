// ============================================================================
// Dungeon Pathing — Tile Effect Engine
//
// Generic runtime for damage / healing / resource-drain / Active Effect tiles.
// Config per tile at: flags.fabula-ultima-companion.dungeonPathing.effectConfig.*
//
// VFX/SFX sync: triggered client plays locally; GM also broadcasts MSG_VFX so
// all OTHER clients play in sync (covering both the player-trigger and
// GM-trigger cases).
//
// GM routing: resource updates and AE application require actor ownership.
// Player clients send MSG_APPLY to GM (fire-and-forget).  GM applies and then
// emits MSG_VFX so the triggering player also sees the VFX.
//
// Multiple Active Effects: stored as JSON array in activeEffectsJson flag.
//   [ { source: "registry"|"custom", id?: string, json?: string, label: string } ]
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEffectEngine]";
  const PATHING   = DP.PATHING_ROOT_KEY ?? "dungeonPathing";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const MSG_APPLY = "DP_TILE_EFFECT_APPLY";
  const MSG_VFX   = "DP_TILE_EFFECT_VFX";

  // ── Resource type map ──────────────────────────────────────────────────────
  const RESOURCE_TYPES = Object.freeze({
    damage:   { prop: "current_hp",       maxProp: "max_hp",   sign: -1, label: "HP", gainVerb: null,       lossVerb: "takes"   },
    healing:  { prop: "current_hp",       maxProp: "max_hp",   sign: +1, label: "HP", gainVerb: "heals",    lossVerb: null      },
    mp_drain: { prop: "current_mp",       maxProp: "max_mp",   sign: -1, label: "MP", gainVerb: null,       lossVerb: "burns"   },
    mp_gain:  { prop: "current_mp",       maxProp: "max_mp",   sign: +1, label: "MP", gainVerb: "gains",    lossVerb: null      },
    ip_drain: { prop: "current_ip",       maxProp: "max_ip",   sign: -1, label: "IP", gainVerb: null,       lossVerb: "spends"  },
    ip_gain:  { prop: "current_ip",       maxProp: "max_ip",   sign: +1, label: "IP", gainVerb: "gains",    lossVerb: null      },
    zp_drain: { prop: "zero_power_value", maxProp: "max_zero", sign: -1, label: "ZP", gainVerb: null,       lossVerb: "loses"   },
    zp_gain:  { prop: "zero_power_value", maxProp: "max_zero", sign: +1, label: "ZP", gainVerb: "gains",    lossVerb: null      },
  });

  // ── Config reader ──────────────────────────────────────────────────────────
  function readConfig(tileDoc) {
    const raw  = tileDoc?.flags?.[MODULE_ID]?.[PATHING]?.effectConfig ?? {};
    const bool = v => v === true || v === "true" || v === 1;

    // Parse multi-AE array; fall back to migrating old single-AE fields.
    let activeEffects = [];
    if (raw.activeEffectsJson) {
      try { activeEffects = JSON.parse(raw.activeEffectsJson); } catch {}
    }
    if (!activeEffects.length && raw.activeEffectId) {
      activeEffects.push({ source: "registry", id: raw.activeEffectId, label: raw.activeEffectId });
    }
    if (!activeEffects.length && raw.customEffectJson) {
      try {
        const d = JSON.parse(raw.customEffectJson);
        activeEffects.push({ source: "custom", json: raw.customEffectJson, label: d.name ?? "Custom" });
      } catch {}
    }

    let removeEffects = [];
    if (raw.removeEffectsJson) {
      try { removeEffects = JSON.parse(raw.removeEffectsJson); } catch {}
    }

    return {
      enabled:           bool(raw.enabled),
      useResourceChange: bool(raw.useResourceChange),
      resourceType:      String(raw.resourceType      ?? "damage"),
      resourceValue:     Number(raw.resourceValue      ?? 0),
      elementType:       String(raw.elementType        ?? "elementless"),
      weaponType:        String(raw.weaponType         ?? "none_ef"),
      ignoreReduction:   bool(raw.ignoreReduction),
      useActiveEffect:   bool(raw.useActiveEffect),
      activeEffects,
      useRemoveEffect:   bool(raw.useRemoveEffect),
      removeEffects,
      targetMode:        String(raw.targetMode         ?? "all"),
      silent:            bool(raw.silent),
      vfxType:           String(raw.vfxType            ?? "none"),
      vfxFile:           String(raw.vfxFile            ?? ""),
      vfxFlashTint:      String(raw.vfxFlashTint       ?? "#ff0000"),
      vfxFlashAlpha:     Number(raw.vfxFlashAlpha      ?? 0.5),
      sfxUrl:            String(raw.sfxUrl             ?? ""),
    };
  }

  // ── Party member resolution ────────────────────────────────────────────────
  async function resolvePartyMembers() {
    const api = window.FUCompanion?.api;
    let partyActor = null;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.db ?? null;
    }
    if (!partyActor) { console.warn(TAG, "Party actor not resolved."); return []; }

    const props   = partyActor.system?.props ?? {};
    const members = [];
    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;
      let actor = null;
      try {
        actor = /^Actor\./i.test(rawId)
          ? await fromUuid(rawId)
          : (game.actors.get(rawId) ?? await fromUuid(`Actor.${rawId}`).catch(() => null));
      } catch {}
      if (actor) members.push(actor);
    }
    return members;
  }

  // ── Target selection ───────────────────────────────────────────────────────
  function selectTargets(members, mode) {
    if (!members.length) return [];
    switch (String(mode)) {
      case "one": return [members[Math.floor(Math.random() * members.length)]];
      case "random": {
        const n       = Math.max(1, Math.ceil(Math.random() * members.length));
        const shuffled = [...members].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, n);
      }
      default: return [...members];
    }
  }

  // ── Resource delta (one actor) ─────────────────────────────────────────────
  // HP and MP types route through FUCompanion.api.applyDamage (verbosity: silent —
  // tile system handles its own VFX/chat).  IP/ZP use the legacy direct-update path
  // since the API does not model those resources.
  async function applyResourceDelta(actor, cfg) {
    const rt = RESOURCE_TYPES[cfg.resourceType];
    if (!rt || !(cfg.resourceValue > 0)) return null;

    const dmgApi = globalThis.FUCompanion?.api?.applyDamage?.applyToActor;

    // ── HP damage / healing via new API ──────────────────────────────────────
    if (dmgApi && (cfg.resourceType === "damage" || cfg.resourceType === "healing")) {
      const result = await dmgApi({
        baseDamage:   cfg.resourceValue,
        elementType:  cfg.elementType,
        weaponType:   cfg.weaponType,
        valueType:    "hp",
        isRecovery:   cfg.resourceType === "healing",
        ignoreDR:     cfg.ignoreReduction,
        targetActor:  actor,
        attackerName: "Tile",
        sourceType:   "Tile",
        verbosity:    "silent",
      });
      const max = Number(actor.system?.props?.[rt.maxProp] ?? 0);
      return { rt, previous: result.hp.from, delta: result.hp.to - result.hp.from, newValue: result.hp.to, max };
    }

    // ── MP drain / gain via new API ───────────────────────────────────────────
    if (dmgApi && (cfg.resourceType === "mp_drain" || cfg.resourceType === "mp_gain")) {
      const result = await dmgApi({
        baseDamage:   cfg.resourceValue,
        valueType:    "mp",
        isRecovery:   cfg.resourceType === "mp_gain",
        targetActor:  actor,
        attackerName: "Tile",
        sourceType:   "Tile",
        verbosity:    "silent",
      });
      const max = Number(actor.system?.props?.[rt.maxProp] ?? 0);
      return { rt, previous: result.mp.from, delta: result.mp.to - result.mp.from, newValue: result.mp.to, max };
    }

    // ── Legacy path: IP / ZP (and fallback if API unavailable) ───────────────
    const props   = actor.system?.props ?? {};
    const current = Number(props[rt.prop]    ?? 0);
    const max     = Number(props[rt.maxProp] ?? 0);
    const newVal  = Math.max(0, Math.min(max, current + rt.sign * Number(cfg.resourceValue)));
    const actual  = newVal - current;
    await actor.update({ [`system.props.${rt.prop}`]: newVal }, { render: false });
    return { rt, previous: current, delta: actual, newValue: newVal, max };
  }

  // ── Effect ref builder ─────────────────────────────────────────────────────
  // Pre-stamps dungeonTurnsRemaining into each AE's flags so the HUD counter
  // shows the correct value immediately on application — no extra setFlag
  // roundtrip needed.  AEM merges overrides.flags into the AE data before
  // createEmbeddedDocuments, so the stamp arrives in the initial DB write.
  //
  // Default duration mirrors dp-ae-lifecycle.js DEFAULT_DURATION = 3.
  // Each entry may carry its own `turns` (set per AE row in the tile config);
  // custom AEs may also declare duration.rounds. Precedence:
  //   entry.turns  →  duration.rounds (custom only)  →  DUNGEON_DEFAULT_DURATION
  //
  // Before this, registry-sourced effects were HARD-pinned to 3 turns with no
  // way to say otherwise — which is wrong for any tile whose debuff is meant to
  // outlast (or undercut) the default, e.g. Vertigo's 5-step Blind.
  const DUNGEON_DEFAULT_DURATION = 3;

  function entryTurns(entry) {
    const n = Number(entry?.turns);
    return (Number.isFinite(n) && n > 0) ? Math.floor(n) : null;
  }

  function buildEffectRefs(entries) {
    const refs = [];
    for (const entry of entries) {
      const turns = entryTurns(entry);
      if (entry.source === "registry" && entry.id) {
        refs.push({
          registryId: entry.id,
          overrides: {
            flags: { [MODULE_ID]: { dungeonTurnsRemaining: turns ?? DUNGEON_DEFAULT_DURATION } },
          },
        });
      } else if (entry.source === "custom" && entry.json) {
        try {
          const data = JSON.parse(entry.json);
          data.flags ??= {};
          data.flags[MODULE_ID] ??= {};
          if (turns != null) {
            data.flags[MODULE_ID].dungeonTurnsRemaining = turns;
          } else if (data.flags[MODULE_ID].dungeonTurnsRemaining == null) {
            const explicit = Number(data.duration?.rounds);
            data.flags[MODULE_ID].dungeonTurnsRemaining =
              (Number.isFinite(explicit) && explicit > 0) ? explicit : DUNGEON_DEFAULT_DURATION;
          }
          refs.push(data);
        } catch {}
      }
    }
    return refs;
  }

  // ── Apply to a list of actors ──────────────────────────────────────────────
  // AE operations are batched: one applyEffects / removeEffects call for ALL
  // actors instead of N separate calls. This cuts AEM event emissions (and
  // associated socket traffic) from N×2 down to 2, preventing socket floods
  // when all 4 party members are targeted simultaneously.
  //
  // Resource changes remain per-actor because each is an independent HP/MP/IP
  // operation on a different actor; there is no batch API for those.
  async function applyToActors(actors, cfg) {
    const rowMap = new Map(actors.map(a => [
      a.uuid, { actorName: a.name, resource: null, ae: [], aeRemoved: [] }
    ]));

    if (cfg.useResourceChange) {
      // Each actor.update triggers a full CSB prepareData recompute (~300-600ms,
      // synchronous, scales with item count — it re-prepares the actor AND every
      // embedded item). On a targetMode:"all" tile that is 4 back-to-back blocking
      // recomputes; under real multiplayer load the resulting memory spike was the
      // likely OOM/host-reboot trigger (see project_scorched_tile_lag_rootcause).
      // Yield a macrotask BETWEEN members so the browser can paint and GC can run
      // between recomputes, smoothing the freeze and lowering peak memory. This is
      // tile-path-only; the shared applyToActor (used by combat reactions / Battle
      // Director's own engine does NOT touch it) is left untouched.
      for (let i = 0; i < actors.length; i++) {
        const actor = actors[i];
        const row   = rowMap.get(actor.uuid);
        row.resource = await applyResourceDelta(actor, cfg).catch(e => {
          console.error(TAG, `resource delta failed for ${actor.name}:`, e); return null;
        });
        if (i < actors.length - 1) await new Promise(r => setTimeout(r, 0));
      }
    }

    const aeApi = window.FUCompanion?.api?.activeEffectManager;

    if (cfg.useActiveEffect && cfg.activeEffects?.length) {
      const effectRefs = buildEffectRefs(cfg.activeEffects);
      if (effectRefs.length) {
        if (!aeApi?.applyEffects) {
          console.warn(TAG, "AEM applyEffects not available.");
        } else {
          try {
            const report = await aeApi.applyEffects({
              actorUuids: actors.map(a => a.uuid).filter(Boolean),
              effects: effectRefs,
              silent: true,
            });
            for (const r of report?.results ?? []) {
              const row = rowMap.get(r.actor?.uuid);
              if (row) row.ae.push({ label: r.effect?.name ?? "Effect", ok: r.ok === true });
            }
          } catch (e) {
            console.error(TAG, "AE batch apply failed:", e);
            for (const row of rowMap.values())
              row.ae = cfg.activeEffects.map(e => ({ label: e.label ?? "Effect", ok: false }));
          }
        }
      }
    }

    if (cfg.useRemoveEffect && cfg.removeEffects?.length) {
      const effectRefs = buildEffectRefs(cfg.removeEffects);
      if (effectRefs.length) {
        if (!aeApi?.removeEffects) {
          console.warn(TAG, "AEM removeEffects not available.");
        } else {
          try {
            const report = await aeApi.removeEffects({
              actorUuids: actors.map(a => a.uuid).filter(Boolean),
              effects: effectRefs,
              silent: true,
            });
            for (const r of report?.results ?? []) {
              const row = rowMap.get(r.actor?.uuid);
              if (row) {
                const ok = r.ok === true && r.status !== "failed";
                row.aeRemoved = cfg.removeEffects.map(e => ({ label: e.label ?? "Effect", ok }));
              }
            }
          } catch (e) {
            console.error(TAG, "AE batch remove failed:", e);
            for (const row of rowMap.values())
              row.aeRemoved = cfg.removeEffects.map(e => ({ label: e.label ?? "Effect", ok: false }));
          }
        }
      }
    }

    return actors.map(a => rowMap.get(a.uuid));
  }

  // ── Chat card ──────────────────────────────────────────────────────────────
  async function createChatCard(results, cfg, tileLabel) {
    const lines = results.map(({ actorName, resource, ae, aeRemoved }) => {
      const parts = [];
      if (resource) {
        const { rt, delta, newValue, max } = resource;
        if (delta === 0) {
          parts.push(`${rt.label} unchanged (already at limit)`);
        } else if (delta > 0) {
          parts.push(`${rt.gainVerb ?? "gains"} <b>${Math.abs(delta)} ${rt.label}</b> <span style="opacity:.65">(${newValue}/${max})</span>`);
        } else {
          parts.push(`${rt.lossVerb ?? "loses"} <b>${Math.abs(delta)} ${rt.label}</b> <span style="opacity:.65">(${newValue}/${max})</span>`);
        }
      }
      for (const { label, ok } of ae) {
        parts.push(ok ? `afflicted by <b>${label}</b>` : `could not apply <b>${label}</b>`);
      }
      for (const { label, ok } of (aeRemoved ?? [])) {
        parts.push(ok ? `lost <b>${label}</b>` : `could not remove <b>${label}</b>`);
      }
      if (!parts.length) parts.push("is unaffected");
      return `<li style="margin-bottom:3px"><b>${actorName}</b> ${parts.join("; ")}.</li>`;
    });

    const header = tileLabel
      ? `<div style="font-weight:bold;font-size:1.05rem;border-bottom:1px solid rgba(255,255,255,0.2);margin-bottom:6px;padding-bottom:4px;">${tileLabel}</div>`
      : "";

    await ChatMessage.create({
      speaker: { alias: "Tile Event" },
      content: `<div style="padding:6px 10px;">${header}<ul style="margin:0;padding-left:16px;">${lines.join("")}</ul></div>`,
    }).catch(e => console.warn(TAG, "ChatMessage.create failed:", e));
  }

  // ── VFX ───────────────────────────────────────────────────────────────────
  function playVfx(cfg, tokenDoc) {
    if (cfg.vfxType === "file" && cfg.vfxFile) {
      if (game.modules.get("sequencer")?.active) {
        try { new Sequence().effect().file(cfg.vfxFile).atLocation(tokenDoc).play(); return; }
        catch {}
      }
      const tokenObj = canvas.tokens.get(tokenDoc?.id);
      if (!tokenObj) return;
      PIXI.Assets.load(cfg.vfxFile).then(texture => {
        const gSize  = canvas.grid.size ?? 100;
        const w      = Number(tokenDoc?.width  ?? 1) * gSize;
        const h      = Number(tokenDoc?.height ?? 1) * gSize;
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.x      = Number(tokenDoc.x) + w / 2;
        sprite.y      = Number(tokenDoc.y) + h / 2;
        sprite.width  = w; sprite.height = h;
        sprite.zIndex = 999998; sprite.alpha = 0;
        canvas.stage.addChild(sprite);
        canvas.stage.sortChildren?.();
        const start = performance.now(), DUR = 1500;
        const tick  = () => {
          const t = (performance.now() - start) / DUR;
          sprite.alpha = t < 0.15 ? t / 0.15 : t > 0.8 ? Math.max(0, 1 - (t - 0.8) / 0.2) : 1;
          if (t >= 1) {
            canvas.app.ticker.remove(tick);
            canvas.stage.removeChild(sprite);
            sprite.destroy({ texture: false });
          }
        };
        canvas.app.ticker.add(tick);
      }).catch(() => {});
    }

    if (cfg.vfxType === "screenflash") {
      const el = document.createElement("div");
      el.style.cssText = `position:fixed;inset:0;z-index:99999;pointer-events:none;`
        + `background:${cfg.vfxFlashTint ?? "#ff0000"};opacity:${Number(cfg.vfxFlashAlpha ?? 0.5)};`
        + `transition:opacity 600ms ease-out;`;
      document.body.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = "0"; }));
      setTimeout(() => el.remove(), 700);
    }
  }

  // ── SFX ───────────────────────────────────────────────────────────────────
  function playSfx(cfg) {
    if (!cfg.sfxUrl) return;
    try {
      if (game.modules.get("sequencer")?.active) new Sequence().sound(cfg.sfxUrl).play();
      else AudioHelper.play({ src: cfg.sfxUrl, volume: 0.8, autoplay: true });
    } catch (e) { console.warn(TAG, "SFX error:", e); }
  }

  // ── Broadcast VFX/SFX to all other clients ────────────────────────────────
  // Only send VFX-relevant fields — not the full cfg (which embeds AE JSON blobs).
  function broadcastVfx(cfg, tokenDoc, sceneId) {
    if (cfg.silent) return;
    if (cfg.vfxType === "none" && !cfg.sfxUrl) return;
    const vfx = {
      silent:       cfg.silent,
      vfxType:      cfg.vfxType,
      vfxFile:      cfg.vfxFile,
      vfxFlashTint: cfg.vfxFlashTint,
      vfxFlashAlpha: cfg.vfxFlashAlpha,
      sfxUrl:       cfg.sfxUrl,
    };
    game.socket.emit(SOCKET_CH, {
      type: MSG_VFX,
      payload: { vfx, tokenId: tokenDoc?.id ?? null, sceneId: sceneId ?? null },
    });
  }

  // ── Socket handler (all clients) ───────────────────────────────────────────
  const SOCKET_GUARD = "__ONI_DP_EFFECT_ENGINE_SOCKET__";

  function setupSocket() {
    if (window[SOCKET_GUARD]) return;
    window[SOCKET_GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      // ── GM: apply resource/AE changes, create chat card, re-broadcast VFX ──
      if (msg?.type === MSG_APPLY && game.user?.isGM) {
        // Multi-GM dedupe: both GMs receive this. Gate to the primary GM so the
        // resource/AE mutation + chat card don't apply twice. (VFX below still
        // plays on every client.)
        if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;
        try {
          const { actorUuids, cfg, tileLabel, tokenId, sceneId } = msg.payload ?? {};
          const actors = [];
          for (const uuid of (actorUuids ?? [])) {
            const a = await fromUuid(uuid).catch(() => null);
            if (a) actors.push(a);
          }
          if (!actors.length) { console.warn(TAG, "GM: no actors resolved."); return; }

          const results = await applyToActors(actors, cfg);
          if (!cfg.silent) await createChatCard(results, cfg, tileLabel);

          // Broadcast VFX so the triggering player (and any spectators) all see it.
          // The player who emitted MSG_APPLY already played VFX locally, but other
          // clients haven't — this covers everyone else.
          broadcastVfx(cfg, { id: tokenId }, sceneId);
        } catch (e) {
          console.error(TAG, "MSG_APPLY handler failed:", e);
        }
        return;
      }

      // ── All clients: play VFX/SFX ──────────────────────────────────────────
      if (msg?.type === MSG_VFX) {
        const { vfx, tokenId, sceneId } = msg.payload ?? {};
        if (sceneId && canvas.scene?.id !== sceneId) return;
        const tokenDoc = canvas.tokens.get(tokenId)?.document ?? { id: tokenId };
        if (!vfx?.silent) { playVfx(vfx, tokenDoc); playSfx(vfx); }
      }
    });

    console.debug(TAG, "Socket listeners installed.");
  }

  // ── Main run() ─────────────────────────────────────────────────────────────
  async function run(cfg, tileDoc, tokenDoc, scene) {
    if (!cfg.enabled) return;
    if (!cfg.useResourceChange && !cfg.useActiveEffect && !cfg.useRemoveEffect
        && cfg.vfxType === "none" && !cfg.sfxUrl) return;

    const allMembers = await resolvePartyMembers();
    const targets    = selectTargets(allMembers, cfg.targetMode);
    const tileLabel  = tileDoc?.name ?? "Tile Event";
    const sceneId    = scene?.id ?? canvas.scene?.id ?? null;

    // VFX/SFX plays locally on the triggering client immediately.
    if (!cfg.silent) { playVfx(cfg, tokenDoc); playSfx(cfg); }

    if (!cfg.useResourceChange && !cfg.useActiveEffect && !cfg.useRemoveEffect) return;

    if (!targets.length) {
      console.warn(TAG, "No party members resolved; skipping resource/AE application.");
      return;
    }

    if (game.user?.isGM) {
      const results = await applyToActors(targets, cfg);
      if (!cfg.silent) {
        await createChatCard(results, cfg, tileLabel);
        // Broadcast VFX so non-triggering clients also see it.
        broadcastVfx(cfg, tokenDoc, sceneId);
      }
    } else {
      // Player → fire-and-forget to GM.  GM will broadcast VFX back to all
      // OTHER clients after applying (triggering player already played above).
      game.socket.emit(SOCKET_CH, {
        type: MSG_APPLY,
        payload: {
          actorUuids: targets.map(a => a.uuid).filter(Boolean),
          cfg,
          tileLabel,
          tokenId: tokenDoc?.id ?? null,
          sceneId,
        },
      });
    }
  }

  // ── Patch TileEventRegistry.dispatch ──────────────────────────────────────
  function patchDispatch() {
    const reg = DP.TileEventRegistry;
    if (!reg?.dispatch) { console.warn(TAG, "TileEventRegistry.dispatch not found."); return; }
    const _orig = reg.dispatch.bind(reg);
    reg.dispatch = async function (typeKey, tileDoc, tokenDoc, scene) {
      const result = await _orig(typeKey, tileDoc, tokenDoc, scene);
      const cfg    = readConfig(tileDoc);
      if (cfg.enabled) {
        await run(cfg, tileDoc, tokenDoc, scene)
          .catch(e => console.error(TAG, "post-dispatch run() error:", e));
      }
      return result;
    };
    console.debug(TAG, "TileEventRegistry.dispatch patched.");
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.TileEffectEngine = { run, readConfig, resolvePartyMembers, selectTargets, RESOURCE_TYPES };

  Hooks.once("ready", () => {
    setupSocket();
    patchDispatch();
    console.debug(TAG, "Tile Effect Engine ready.");
  });
})();
