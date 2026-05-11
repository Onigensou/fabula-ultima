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

  // Static pseudo-script source — built once at module load, never changes.
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
    // Preserve horizontal/vertical flip set by token config or external scripts
    if((base.scale?.x??1)<0) s.scale.x=-Math.abs(s.scale.x);
    if((base.scale?.y??1)<0) s.scale.y=-Math.abs(s.scale.y);
  }
  else{s.width=token.w;s.height=token.h;}
  s.zIndex=500000;
  canvas.stage.sortableChildren=true; canvas.stage.addChild(s); canvas.stage.sortChildren();
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
  if(sp){try{canvas.stage.removeChild(sp);}catch(_){}sp.destroy();}
  if(base) base.visible=origMesh; casterToken.visible=origVis;
}`;

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

      const pseudoApi = game?.ONI?.pseudo?.play ?? null;

      if (typeof pseudoApi === "function") {
        pseudoApi({
          scriptId:         "dungeonPathing.move",
          scriptSource:     _PSEUDO_SCRIPT,
          casterTokenUuid:  token.document.uuid,
          targetTokenUuids: [],
          params: {
            fromX: fromC.x, fromY: fromC.y,
            toX:   toCAdj.x, toY: toCAdj.y,
            durationMs: DP.MOVE_MS,
            holdMs:     50
          },
          meta: { source: "DungeonPathing", toNodeId: destNode.nodeId }
        });

        await wait(DP.MOVE_MS - DP.REAL_UPDATE_BEFORE_END);
        await token.document.update({ x: realX, y: realY }, { animate: false, dungeonPathing: true });
        await wait(DP.REAL_UPDATE_BEFORE_END + DP.REBUILD_AFTER_MOVE_MS);
      } else {
        await token.document.update({ x: realX, y: realY }, { animate: true, dungeonPathing: true });
        await wait(DP.REBUILD_AFTER_MOVE_MS);
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
