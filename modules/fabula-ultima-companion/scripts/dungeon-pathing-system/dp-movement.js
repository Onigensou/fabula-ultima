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

  // _PSEUDO_SCRIPT is broadcast to OTHER clients so they see the movement animation
  // via their pseudo-animation listener. The LOCAL client runs _startLocalAnimation()
  // instead — this bypasses the pseudo system's deepClone, debug-logging, and
  // floating-promise microtask chain that were delaying the wait1 setTimeout.
  const _PSEUDO_SCRIPT = `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("DungeonPathing pseudo movement requires casterToken.");
const fromX = Number(params.fromX), fromY = Number(params.fromY);
const toX   = Number(params.toX),   toY   = Number(params.toY);
const dur   = Math.max(1, Number(params.durationMs ?? 650));
const hold  = Math.max(0, Number(params.holdMs    ?? 40));
function ease(t){ return t < 0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }
function animate(obj, sx, sy, ex, ey, ms){
  return new Promise(res => {
    const s = performance.now();
    const tick = () => {
      const t = Math.min((performance.now()-s)/ms,1);
      obj.x = sx+(ex-sx)*ease(t); obj.y = sy+(ey-sy)*ease(t);
      if(t>=1){canvas.app.ticker.remove(tick);res();}
    };
    canvas.app.ticker.add(tick);
  });
}
async function clone(token){
  const base = token.mesh ?? token.icon;
  const tex  = base?.texture ?? await loadTexture(token.document.texture.src);
  const s    = new PIXI.Sprite(tex);
  s.anchor.set(0.5); s.x=fromX; s.y=fromY;
  if(base){
    s.width=base.width;s.height=base.height;s.rotation=base.rotation??0;s.alpha=base.alpha??1;
    if((base.scale?.x??1)<0) s.scale.x=-Math.abs(s.scale.x);
    if((base.scale?.y??1)<0) s.scale.y=-Math.abs(s.scale.y);
  }
  else{s.width=token.w;s.height=token.h;}
  s.zIndex=500000;
  const _prev=canvas.stage.sortableChildren;
  canvas.stage.sortableChildren=true; canvas.stage.addChild(s);
  s.__prevSortable=_prev;
  return s;
}
const base = casterToken.mesh ?? casterToken.icon;
const origVis = casterToken.visible, origMesh = base?.visible??true;
let sp=null;
try{
  sp=await clone(casterToken);
  if(base) base.visible=false; casterToken.visible=false;
  await animate(sp,fromX,fromY,toX,toY,dur);
  if(hold>0) await new Promise(r=>setTimeout(r,hold));
}finally{
  if(sp){
    canvas.stage.sortableChildren=sp.__prevSortable??false;
    try{canvas.stage.removeChild(sp);}catch(_){}sp.destroy();
  }
  if(base) base.visible=origMesh; casterToken.visible=origVis;
}`;

  // Local inline animation — same PIXI logic as _PSEUDO_SCRIPT but runs directly
  // on this client without going through the pseudo system. Eliminates:
  //   - foundry.utils.deepClone of the 1553-char scriptSource per call
  //   - console.log(full msg) in pseudo core/listener (DEBUG=true)
  //   - floating onSocketMessage promise chain (resolveTokenFromUuid awaits)
  //     that occupied microtasks and delayed the wait1 setTimeout callback.
  function _startLocalAnimation(token, fromC, toC, durationMs) {
    (async () => {
      const base = token.mesh ?? token.icon;
      const tex  = base?.texture ?? await loadTexture(token.document.texture.src);
      const s    = new PIXI.Sprite(tex);
      s.anchor.set(0.5);
      s.x = fromC.x; s.y = fromC.y;
      if (base) {
        s.width = base.width; s.height = base.height;
        s.rotation = base.rotation ?? 0; s.alpha = base.alpha ?? 1;
        if ((base.scale?.x ?? 1) < 0) s.scale.x = -Math.abs(s.scale.x);
        if ((base.scale?.y ?? 1) < 0) s.scale.y = -Math.abs(s.scale.y);
      } else {
        s.width = token.w; s.height = token.h;
      }
      s.zIndex = 500000;
      const prevSortable = canvas.stage.sortableChildren;
      canvas.stage.sortableChildren = true;
      canvas.stage.addChild(s);
      const origVis  = token.visible;
      const origMesh = base?.visible ?? true;
      try {
        if (base) base.visible = false;
        token.visible = false;
        await new Promise(res => {
          const start = performance.now();
          const ease  = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
          const tick  = () => {
            const t = Math.min((performance.now() - start) / durationMs, 1);
            s.x = fromC.x + (toC.x - fromC.x) * ease(t);
            s.y = fromC.y + (toC.y - fromC.y) * ease(t);
            if (t >= 1) { canvas.app.ticker.remove(tick); res(); }
          };
          canvas.app.ticker.add(tick);
        });
        await wait(50);
      } finally {
        canvas.stage.sortableChildren = prevSortable;
        try { canvas.stage.removeChild(s); } catch {}
        s.destroy();
        if (base) base.visible = origMesh;
        token.visible = origVis;
      }
    })().catch(e => console.warn("[DungeonPathing][Movement] inline animation error", e));
  }

  DP.Movement = {
    /**
     * Animate the token to destNode then update the real document.
     * TOKEN_OFFSET is applied so the character's feet rest on the tile graphic.
     */
    async moveToNode(token, destNode) {
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
      _startLocalAnimation(token, fromC, toCAdj, DP.MOVE_MS);

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
