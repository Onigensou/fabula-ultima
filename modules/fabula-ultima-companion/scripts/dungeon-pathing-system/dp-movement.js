// ============================================================================
// Dungeon Pathing System — Movement Handler
// Pseudo-move animation + real token document update.
// Applies DP.TOKEN_OFFSET so the character's feet align with the tile graphic.
// ============================================================================
(() => {
  const DP   = globalThis.DungeonPathing ??= {};
  const N    = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function getGridSize() {
    return Number(canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100) || 100;
  }

  // ── One step's slide ────────────────────────────────────────────────────────
  // The real token is hidden and a copy of its sprite slides to the next tile;
  // moveToNode then puts the token there in one jump. Every client runs
  // playStep(): the mover calls it directly (no pseudo-system overhead — its
  // deepClone, debug logging and floating promise chain were delaying the
  // wait1 setTimeout), the others through the pseudo socket, whose script
  // below only calls it.
  //
  // A step is a walk: the copy wears the character's walk art for the step's
  // direction (sprite-facing-runtime.js picks it), or sways when the
  // character has no walk art, and moves on an even sine curve so the feet do
  // not skate. Only the copy walks: the token shows again in its own idle art,
  // facing the camera. A shove (Force Move, Gusty) is the plain copy of the standing
  // sprite on the old speed-up-and-brake curve.
  const _PSEUDO_SCRIPT = `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("DungeonPathing pseudo movement requires casterToken.");
const play = globalThis.DungeonPathing?.Movement?.playStep;
if (typeof play !== "function") return;
await play(
  casterToken,
  { x: Number(params.fromX), y: Number(params.fromY) },
  { x: Number(params.toX),   y: Number(params.toY) },
  Math.max(1, Number(params.durationMs ?? 650)),
  { shove: params.shove === true, holdMs: Math.max(0, Number(params.holdMs ?? 40)) }
);`;

  const easeWalk  = t => -(Math.cos(Math.PI * t) - 1) / 2;
  const easeShove = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;

  function facingApi() {
    return globalThis.__ONI_SPRITE_FACING_RUNTIME__ ?? null;
  }

  async function playStep(token, fromC, toC, durationMs, { shove = false, holdMs = 50 } = {}) {
    if (!token) return;

    const walk = shove ? null
      : (facingApi()?.dungeonStepBegin?.(token, toC.x - fromC.x, toC.y - fromC.y) ?? null);
    const art  = walk?.art ?? null;

    const base  = token.mesh ?? token.icon;
    const tex   = base?.texture ?? await loadTexture(token.document.texture.src);
    const frame = art ? (art.kind === "strip" ? art.frames[0] : art.texture) : null;
    const s     = new PIXI.Sprite(frame?.valid ? frame : tex);
    s.anchor.set(0.5);
    s.x = fromC.x; s.y = fromC.y;
    if (base) {
      // Walk art is drawn on the standing sprite's canvas, so it takes the
      // standing sprite's size on the map.
      s.width = Math.abs(base.width); s.height = Math.abs(base.height);
      s.rotation = base.rotation ?? 0; s.alpha = base.alpha ?? 1;
      const signX = walk ? walk.sign : ((base.scale?.x ?? 1) < 0 ? -1 : 1);
      if (signX < 0) s.scale.x = -Math.abs(s.scale.x);
      if ((base.scale?.y ?? 1) < 0) s.scale.y = -Math.abs(s.scale.y);
    } else {
      s.width = token.w; s.height = token.h;
    }
    s.zIndex = 500000;
    const prevSortable = canvas.stage.sortableChildren;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(s);

    const video = (frame?.valid && art.kind === "video") ? art.video : null;
    if (video) {
      try {
        video.currentTime = 0;
        const playing = video.play();
        if (playing?.catch) playing.catch(() => {});
      } catch (_) {}
    }

    const origVis  = token.visible;
    const origMesh = base?.visible ?? true;

    // Foundry shows the token again when its position update lands, which is
    // before the copy has finished: two sprites for a moment. So the token is
    // hidden again every frame, after Foundry's refresh and before the frame
    // is drawn, until the copy hands over.
    const hideTick = () => {
      const live = canvas.tokens?.get(token.id) ?? token;
      live.visible = false;
      if (live.mesh) live.mesh.visible = false;
    };
    canvas.app.ticker.add(hideTick, undefined, PIXI.UPDATE_PRIORITY.LOW + 1);

    try {
      if (base) base.visible = false;
      token.visible = false;

      const ease   = shove ? easeShove : easeWalk;
      const length = Math.hypot(toC.x - fromC.x, toC.y - fromC.y);
      const frames = (frame?.valid && art.kind === "strip") ? art.frames : null;
      const sway   = !shove && walk?.sway;
      const height = Math.abs(s.height);

      await new Promise(res => {
        const start = performance.now();
        const tick  = () => {
          const t = Math.min((performance.now() - start) / durationMs, 1);
          const e = ease(t);
          let x = fromC.x + (toC.x - fromC.x) * e;
          let y = fromC.y + (toC.y - fromC.y) * e;
          const walked = length * e;

          if (frames) {
            // Frames step with the distance walked, as on walk maps.
            const i = Math.floor(((walked % walk.cycle) / walk.cycle) * frames.length) % frames.length;
            if (s.texture !== frames[i]) s.texture = frames[i];
          } else if (sway) {
            // No walk art: lean from side to side about the feet, with a hop.
            const phase = (walked / walk.cycle) * Math.PI * 2;
            const lean  = Math.sin(phase) * walk.swayLean;
            s.skew.x = lean;
            x -= Math.sin(lean) * height * 0.5;
            y -= Math.abs(Math.sin(phase)) * height * walk.swayHop;
          }

          s.x = x; s.y = y;
          if (t >= 1) { canvas.app.ticker.remove(tick); res(); }
        };
        canvas.app.ticker.add(tick);
      });

      // Arrived: the copy stops walking and stands in the token's own idle
      // art, exactly as the token will look, so the hand-over cannot be seen.
      if (walk && base) {
        if (video) { try { video.pause(); } catch (_) {} }
        s.skew.x = 0;
        s.x = toC.x; s.y = toC.y;
        s.texture = base.texture;
        s.width = Math.abs(base.width); s.height = Math.abs(base.height);
        if (((base.scale?.x ?? 1) < 0) !== (s.scale.x < 0)) s.scale.x = -s.scale.x;
      }

      if (holdMs > 0) await wait(holdMs);

      // Hand over only once the token is drawn on the new tile. Its update
      // can reach another client after the copy has arrived.
      const startWait = performance.now();
      while (performance.now() - startWait < 1500) {
        const live = canvas.tokens?.get(token.id);
        if (!live) break;
        const cx = live.x + live.w / 2, cy = live.y + live.h / 2;
        if (Math.abs(cx - toC.x) < 2 && Math.abs(cy - toC.y) < 2) break;
        await wait(30);
      }
    } finally {
      if (video) { try { video.pause(); } catch (_) {} }
      canvas.app.ticker.remove(hideTick);
      canvas.stage.sortableChildren = prevSortable;
      try { canvas.stage.removeChild(s); } catch {}
      s.destroy();
      const live = canvas.tokens?.get(token.id) ?? token;
      if (live.mesh) live.mesh.visible = origMesh;
      live.visible = origVis;
    }
  }

  DP.Movement = {
    /**
     * Animate the token to destNode then update the real document.
     * TOKEN_OFFSET is applied so the character's feet rest on the tile graphic.
     * shove: pushed by a tile (Force Move, Gusty) rather than walked, so no
     * walk art and no turn.
     */
    async moveToNode(token, destNode, { shove = false } = {}) {
      if (!token?.document) return false;

      const gSize  = getGridSize();
      const tw     = N(token.w, N(token.document.width,  1) * gSize);
      const th     = N(token.h, N(token.document.height, 1) * gSize);

      const fromC  = token.center
        ? { x: N(token.center.x), y: N(token.center.y) }
        : { x: N(token.document.x) + tw / 2, y: N(token.document.y) + th / 2 };

      const toC    = { x: N(destNode.center.x), y: N(destNode.center.y) };

      // Apply offset — shifts where the token document ends up relative to tile center
      const offX   = N(DP.TOKEN_OFFSET?.x, 0);
      const offY   = N(DP.TOKEN_OFFSET?.y, 0);

      const realX  = Math.round(toC.x - tw / 2 + offX);
      const realY  = Math.round(toC.y - th / 2 + offY);

      // Pseudo-animation target centre (including offset)
      const toCAdj = { x: toC.x + offX, y: toC.y + offY };

      // ── Run animation locally (inline, no pseudo-system overhead) ─────────────
      // The pseudo system's emitToAllClients → runLocallyIfPossible path was
      // creating a floating async chain (deepClone + debug console.log +
      // resolveTokenFromUuid await) that held the microtask queue open and
      // delayed the wait1 setTimeout callback by 2-3 s every ~4 turns.
      playStep(token, fromC, toCAdj, DP.MOVE_MS, { shove })
        .catch(e => console.warn("[DungeonPathing][Movement] inline animation error", e));

      // ── Broadcast to other clients via pseudo socket ────────────────────────
      // Other clients receive _PSEUDO_SCRIPT and run it through their own
      // pseudo listener — they see the smooth animation too.
      // Pre-register runId so the socket echo back to THIS client is deduped.
      {
        const _rid    = foundry?.utils?.randomID ? foundry.utils.randomID(6) : Math.random().toString(36).slice(2, 8);
        const _runId  = `${Date.now()}-${_rid}`;
        (globalThis.__ONI_PSEUDO_SEEN_RUNIDS__ ??= new Set()).add(_runId);
        if (game?.socket) {
          game.socket.emit("module.fabula-ultima-companion", {
            type:             "oni.pseudo.play",
            runId:            _runId,
            scriptId:         "dungeonPathing.move",
            scriptSource:     _PSEUDO_SCRIPT,
            casterTokenUuid:  token.document.uuid,
            targetTokenUuids: [],
            params: {
              fromX: fromC.x, fromY: fromC.y,
              toX:   toCAdj.x, toY: toCAdj.y,
              durationMs: DP.MOVE_MS,
              holdMs:     50,
              shove,
            },
            meta: { source: "DungeonPathing", toNodeId: destNode.nodeId },
          });
        }
      }

      {
        const expW1 = DP.MOVE_MS - DP.REAL_UPDATE_BEFORE_END;
        const expW2 = DP.REAL_UPDATE_BEFORE_END + DP.REBUILD_AFTER_MOVE_MS;

        // Frame counter measures event-loop health during wait1.
        // Expected: ~expW1/16 frames (60 fps). Near-zero = main thread was blocked.
        let _fc = 0;
        const _fct = () => _fc++;
        canvas.app.ticker.add(_fct);

        const tW1 = performance.now();
        await wait(expW1);
        const dtW1 = performance.now() - tW1;

        canvas.app.ticker.remove(_fct);

        const tUpd = performance.now();
        await token.document.update({ x: realX, y: realY }, { animate: false, dungeonPathing: true });
        const dtUpd = performance.now() - tUpd;

        const tW2 = performance.now();
        await wait(expW2);
        const dtW2 = performance.now() - tW2;

        const slow    = v => v > 50 ? " ⚠" : "";
        const dtTotal = dtW1 + dtUpd + dtW2;
        if (window.__DP_PERF__) {
          console.info("[DungeonPathing][Perf]",
            `moveToNode | wait1 ${dtW1.toFixed(0)}ms (exp ${expW1})${slow(dtW1 - expW1)}` +
            ` | docUpdate ${dtUpd.toFixed(0)}ms${slow(dtUpd - 150)}` +
            ` | wait2 ${dtW2.toFixed(0)}ms (exp ${expW2})${slow(dtW2 - expW2)}`
          );
        }
        if (window.__DP_WALK_DBG__) {
          const postAnimWait = Math.max(0, dtTotal - DP.MOVE_MS);
          const expectedFrames = Math.round(expW1 / (1000 / 60));
          const frameHealth = _fc < 3 ? " 🚨 event-loop blocked" : (_fc < expectedFrames * 0.5 ? " ⚠ frames dropped" : "");
          console.info("[DP][Walk]",
            `move | anim ${DP.MOVE_MS}ms` +
            ` | wait1 ${dtW1.toFixed(0)}ms (exp ${expW1}, frames ${_fc}/${expectedFrames})${frameHealth}` +
            ` | docUpdate ${dtUpd.toFixed(0)}ms${slow(dtUpd - 100)}` +
            ` | wait2 ${dtW2.toFixed(0)}ms` +
            ` | TOTAL ${dtTotal.toFixed(0)}ms` +
            ` | post-anim wait ${postAnimWait.toFixed(0)}ms` +
            (postAnimWait > 250 ? " ⚠" : "")
          );
        }
      }

      return true;
    },

    /** One step's slide on this client (the other clients run it via the pseudo socket). */
    playStep,

    /** Revert to a previously saved position (top-left doc coords). */
    async revertToPosition(token, savedPos) {
      if (!token?.document) return;
      await token.document.update({ x: savedPos.x, y: savedPos.y }, { animate: false, dungeonPathing: true });
      await wait(DP.REBUILD_AFTER_MOVE_MS);
    },

    /** Save current token document position before moving (for revert). */
    savePosition(token) {
      return { x: Number(token.document.x), y: Number(token.document.y) };
    }
  };
})();
