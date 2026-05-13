// ============================================================================
// Dungeon Pathing — Tile Effect Engine
//
// Generic runtime for damage / healing / resource-drain / Active Effect tiles.
// Config is stored per-tile in:
//   flags.fabula-ultima-companion.dungeonPathing.effectConfig.*
//
// Activated by patching TileEventRegistry.dispatch — the engine runs AFTER the
// tile's native handler resolves (e.g. random_battle still fires first).
//
// GM clients apply resource changes and create chat cards directly.
// Player clients route the work to GM via game.socket (fire-and-forget).
// VFX and SFX always play locally on the triggering client.
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][TileEffectEngine]";
  const PATHING   = DP.PATHING_ROOT_KEY ?? "dungeonPathing";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const MSG_TYPE  = "DP_TILE_EFFECT_APPLY";

  // ── Resource type map ──────────────────────────────────────────────────────
  // prop / maxProp: keys inside system.props on the CSB actor.
  // sign:          +1 for gains, -1 for losses.
  // label:         shown in the chat card (HP / MP / IP / ZP).
  // gainVerb / lossVerb: used in the per-actor chat line.
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
  // Reads raw flag values and normalises types so callers never have to
  // worry about whether the saved value is boolean vs. the string "true".
  function readConfig(tileDoc) {
    const raw  = tileDoc?.flags?.[MODULE_ID]?.[PATHING]?.effectConfig ?? {};
    const bool = v => v === true || v === "true" || v === 1;
    return {
      enabled:           bool(raw.enabled),
      useResourceChange: bool(raw.useResourceChange),
      resourceType:      String(raw.resourceType      ?? "damage"),
      resourceValue:     Number(raw.resourceValue      ?? 0),
      useActiveEffect:   bool(raw.useActiveEffect),
      aeSource:          String(raw.aeSource           ?? "registry"),  // "registry" | "custom"
      activeEffectId:    String(raw.activeEffectId     ?? ""),
      customEffectJson:  String(raw.customEffectJson   ?? ""),
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
  // Reads member_id_1…4 from the party DB actor (same pattern used by
  // tile-event-random-battle).  IDs may be plain ("dafTLBUscCDNgq8H") or
  // full UUIDs ("Actor.gdJZ1L1kv5mjTTMr").
  async function resolvePartyMembers() {
    const api = window.FUCompanion?.api;
    let partyActor = null;

    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.db ?? null;
    }

    if (!partyActor) {
      console.warn(TAG, "Party actor not resolved — cannot read member IDs.");
      return [];
    }

    const props   = partyActor.system?.props ?? {};
    const members = [];

    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;

      let actor = null;
      try {
        if (/^Actor\./i.test(rawId)) {
          actor = await fromUuid(rawId);
        } else {
          actor = game.actors.get(rawId)
            ?? await fromUuid(`Actor.${rawId}`).catch(() => null);
        }
      } catch {}

      if (actor) members.push(actor);
    }

    return members;
  }

  // ── Target selection ───────────────────────────────────────────────────────
  function selectTargets(members, mode) {
    if (!members.length) return [];
    switch (String(mode)) {
      case "one": {
        const idx = Math.floor(Math.random() * members.length);
        return [members[idx]];
      }
      case "random": {
        // Random subset of at least 1, up to N members.
        const shuffled = [...members].sort(() => Math.random() - 0.5);
        const count    = Math.max(1, Math.ceil(Math.random() * members.length));
        return shuffled.slice(0, count);
      }
      default:
        return [...members];
    }
  }

  // ── Resource delta (one actor) ─────────────────────────────────────────────
  async function applyResourceDelta(actor, cfg) {
    const rt = RESOURCE_TYPES[cfg.resourceType];
    if (!rt || !(cfg.resourceValue > 0)) return null;

    const props   = actor.system?.props ?? {};
    const current = Number(props[rt.prop]    ?? 0);
    const max     = Number(props[rt.maxProp] ?? 0);
    const delta   = rt.sign * Number(cfg.resourceValue);
    const newVal  = Math.max(0, Math.min(max, current + delta));
    const actual  = newVal - current;

    await actor.update(
      { [`system.props.${rt.prop}`]: newVal },
      { render: false }
    );

    return { rt, previous: current, delta: actual, newValue: newVal, max };
  }

  // ── Active Effect application (one actor) ──────────────────────────────────
  async function applyActiveEffect(actor, cfg) {
    const aeApi = window.FUCompanion?.api?.activeEffectManager;
    if (!aeApi?.applyEffects) {
      console.warn(TAG, "ActiveEffectManager API not available.");
      return null;
    }

    let effectRef = null;
    if (cfg.aeSource === "custom" && cfg.customEffectJson) {
      try { effectRef = JSON.parse(cfg.customEffectJson); } catch {}
    } else if (cfg.activeEffectId) {
      effectRef = cfg.activeEffectId;
    }

    if (!effectRef) return null;

    try {
      const res  = await aeApi.applyEffects({ actors: [actor], effects: [effectRef] });
      const name = typeof effectRef === "object" ? (effectRef.name ?? "effect") : effectRef;
      return { ok: res?.ok ?? true, name };
    } catch (e) {
      console.error(TAG, `AE apply failed for ${actor.name}:`, e);
      return { ok: false, name: null };
    }
  }

  // ── Apply to a list of actors ──────────────────────────────────────────────
  async function applyToActors(actors, cfg) {
    const results = [];

    for (const actor of actors) {
      const row = { actorName: actor.name, resource: null, ae: null };

      if (cfg.useResourceChange) {
        row.resource = await applyResourceDelta(actor, cfg).catch(e => {
          console.error(TAG, `resource delta failed for ${actor.name}:`, e);
          return null;
        });
      }

      if (cfg.useActiveEffect) {
        row.ae = await applyActiveEffect(actor, cfg).catch(e => {
          console.error(TAG, `AE failed for ${actor.name}:`, e);
          return null;
        });
      }

      results.push(row);
    }

    return results;
  }

  // ── Chat card ──────────────────────────────────────────────────────────────
  async function createChatCard(results, cfg, tileLabel) {
    const lines = results.map(({ actorName, resource, ae }) => {
      const parts = [];

      if (resource) {
        const { rt, delta, newValue, max } = resource;
        if (delta === 0) {
          parts.push(`${rt.label} unchanged (already at limit)`);
        } else if (delta > 0) {
          parts.push(
            `${rt.gainVerb ?? "gains"} <b>${Math.abs(delta)} ${rt.label}</b>`
            + ` <span style="opacity:.7">(${newValue}/${max})</span>`
          );
        } else {
          parts.push(
            `${rt.lossVerb ?? "loses"} <b>${Math.abs(delta)} ${rt.label}</b>`
            + ` <span style="opacity:.7">(${newValue}/${max})</span>`
          );
        }
      }

      if (ae) {
        parts.push(
          ae.ok
            ? `is afflicted by <b>${ae.name ?? "an effect"}</b>`
            : `effect could not be applied`
        );
      }

      if (!parts.length) parts.push("is unaffected");

      return `<li style="margin-bottom:3px;"><b>${actorName}</b> ${parts.join("; ")}.</li>`;
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
      // Prefer Sequencer if available
      if (game.modules.get("sequencer")?.active) {
        try {
          new Sequence().effect().file(cfg.vfxFile).atLocation(tokenDoc).play();
          return;
        } catch {}
      }

      // PIXI sprite fallback — fades in, holds, fades out over 1.5 s
      const tokenObj = canvas.tokens.get(tokenDoc.id);
      if (!tokenObj) return;

      PIXI.Assets.load(cfg.vfxFile).then(texture => {
        const gSize  = canvas.grid.size ?? 100;
        const w      = Number(tokenDoc.width  ?? 1) * gSize;
        const h      = Number(tokenDoc.height ?? 1) * gSize;
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.x      = Number(tokenDoc.x) + w / 2;
        sprite.y      = Number(tokenDoc.y) + h / 2;
        sprite.width  = w;
        sprite.height = h;
        sprite.zIndex = 999998;
        sprite.alpha  = 0;
        canvas.stage.addChild(sprite);
        canvas.stage.sortChildren?.();

        const start    = performance.now();
        const DURATION = 1500;
        const tick     = () => {
          const t = (performance.now() - start) / DURATION;
          sprite.alpha =
            t < 0.15 ? t / 0.15
            : t > 0.8  ? Math.max(0, 1 - (t - 0.8) / 0.2)
            : 1;
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
      const tint  = cfg.vfxFlashTint  ?? "#ff0000";
      const alpha = Number(cfg.vfxFlashAlpha ?? 0.5);
      const el    = document.createElement("div");
      el.style.cssText = [
        "position:fixed", "inset:0", "z-index:99999", "pointer-events:none",
        `background:${tint}`, `opacity:${alpha}`,
        "transition:opacity 600ms ease-out",
      ].join(";");
      document.body.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = "0"; }));
      setTimeout(() => el.remove(), 700);
    }
  }

  // ── SFX ───────────────────────────────────────────────────────────────────
  function playSfx(cfg) {
    if (!cfg.sfxUrl) return;
    try {
      if (game.modules.get("sequencer")?.active) {
        new Sequence().sound(cfg.sfxUrl).play();
      } else {
        AudioHelper.play({ src: cfg.sfxUrl, volume: 0.8, autoplay: true });
      }
    } catch (e) { console.warn(TAG, "SFX error:", e); }
  }

  // ── GM socket listener ─────────────────────────────────────────────────────
  // Installed once.  Only the GM processes the message; everyone else ignores.
  const SOCKET_GUARD = "__ONI_DP_EFFECT_ENGINE_SOCKET__";

  function setupGmSocket() {
    if (window[SOCKET_GUARD]) return;
    window[SOCKET_GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (msg?.type !== MSG_TYPE) return;
      if (!game.user?.isGM)       return;

      const { actorUuids, cfg, tileLabel } = msg.payload ?? {};

      const actors = [];
      for (const uuid of (actorUuids ?? [])) {
        const a = await fromUuid(uuid).catch(() => null);
        if (a) actors.push(a);
      }

      if (!actors.length) { console.warn(TAG, "GM: no actors resolved from payload."); return; }

      const results = await applyToActors(actors, cfg);
      if (!cfg.silent) await createChatCard(results, cfg, tileLabel);
    });

    console.debug(TAG, "GM socket listener installed.");
  }

  // ── Main run() ─────────────────────────────────────────────────────────────
  async function run(cfg, tileDoc, tokenDoc, scene) {
    if (!cfg.enabled) return;

    // Nothing to do: no resource change, no AE, and no VFX/SFX.
    if (!cfg.useResourceChange && !cfg.useActiveEffect
        && cfg.vfxType === "none" && !cfg.sfxUrl) return;

    // VFX and SFX always play on the local client (immediate feedback).
    if (!cfg.silent) {
      playVfx(cfg, tokenDoc);
      playSfx(cfg);
    }

    // If there's nothing requiring actor access, we're done here.
    if (!cfg.useResourceChange && !cfg.useActiveEffect) return;

    const allMembers = await resolvePartyMembers();
    const targets    = selectTargets(allMembers, cfg.targetMode);

    if (!targets.length) {
      console.warn(TAG, "No party members resolved; skipping resource/AE application.");
      return;
    }

    const tileLabel = tileDoc?.name ?? "Tile Event";

    if (game.user?.isGM) {
      const results = await applyToActors(targets, cfg);
      if (!cfg.silent) await createChatCard(results, cfg, tileLabel);
    } else {
      // Route to GM — fire-and-forget; turn continues in parallel.
      game.socket.emit(SOCKET_CH, {
        type:    MSG_TYPE,
        payload: {
          actorUuids: targets.map(a => a.uuid).filter(Boolean),
          cfg,
          tileLabel,
        },
      });
    }
  }

  // ── Patch TileEventRegistry.dispatch ──────────────────────────────────────
  // Wraps the existing dispatch so the effect engine runs AFTER the tile's
  // own handler finishes.  The cleared / ok return value is preserved.
  function patchDispatch() {
    const reg = DP.TileEventRegistry;
    if (!reg?.dispatch) {
      console.warn(TAG, "TileEventRegistry.dispatch not found — cannot patch.");
      return;
    }

    const _orig = reg.dispatch.bind(reg);

    reg.dispatch = async function (typeKey, tileDoc, tokenDoc, scene) {
      const result = await _orig(typeKey, tileDoc, tokenDoc, scene);

      const cfg = readConfig(tileDoc);
      if (cfg.enabled) {
        await run(cfg, tileDoc, tokenDoc, scene)
          .catch(e => console.error(TAG, "post-dispatch run() error:", e));
      }

      return result;
    };

    console.debug(TAG, "TileEventRegistry.dispatch patched for effect engine.");
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.TileEffectEngine = {
    run,
    readConfig,
    resolvePartyMembers,
    selectTargets,
    RESOURCE_TYPES,
  };

  Hooks.once("ready", () => {
    setupGmSocket();
    patchDispatch();
    console.debug(TAG, "Tile Effect Engine ready.");
  });
})();
