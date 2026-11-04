// ============================================================================
// Passive fallback — runtime (approved on mockup v4, 2026-11-04).
//
// Recording: firePreAcceptedCandidate (item- and AE-carried reactions) and the
// damage-reaction follow-up loop in applyDamageToTarget (Earthen Wire) set
// `ctx.__passiveRec`; skill-effects applyEffectRow appends every row that RAN
// with its result. When the chain is over they call playPassiveFallback, which
// turns the record into beats (passive-anim-rules.js) and broadcasts a short
// pseudo-animation to every client. Never awaited, never gates anything: the
// effects are already applied when it plays.
//
// Skipped: status ticks (BD flashes those), chains that play_animation or
// perform an action, effects nobody can see, and when the "default action
// animations" setting excludes the owner's side.
// ============================================================================

import { log, warn } from "./logger.js";
import { composePassiveBeats, mergeBeats, LINE_STYLE, PASSIVE_HIT_CLIP } from "./passive-anim-rules.js";
import { MV_CLIPS, clipUrl } from "./action-anim-rules.js";

const NS = "fabula-ultima-companion";
const SFX_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
const MERGE_MS = 150;            // repeat fires inside one action collapse into one beat set
const CLIP_SCALE = 0.55;         // a passive's hit reads smaller than an action's
const SFX_VOL = 0.35;

export function startPassiveRecording(ctx) {
  if (ctx) ctx.__passiveRec = { records: [] };
  return ctx;
}

// Never called — its body text is the inner script (see action-anim-script.js
// for the rules: no backticks, no "${").
/* eslint-disable no-undef */
async function PASSIVE_INNER() {
  const cfg = ctx.params.cfg || {};
  const sceneW = (canvas.dimensions && canvas.dimensions.sceneWidth) || 1682;
  const s = sceneW / 1682;
  const E = oni.EASE;
  const tok = function (u) { try { const d = fromUuidSync(u); return (d && d.object) || null; } catch (e) { return null; } };
  const owner = tok(cfg.ownerTokenUuid);
  canvas.stage.sortableChildren = true;
  const made = [];
  const keep = function (o) { made.push(o); return o; };
  const lineTex = (function () {
    const c = document.createElement("canvas"); c.width = 8; c.height = 128;
    const g = c.getContext("2d"); const gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.35, "rgba(255,255,255,1)");
    gr.addColorStop(0.6, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 8, 128);
    return PIXI.Texture.from(c);
  })();
  function sfx(path) { if (path) oni.sfx(cfg.sfxBase + path, { volume: cfg.vol }); }

  // Pokemon-style stat lines over a token.
  function lines(t, st) {
    const count = 10, ms = 720, w = t.w * 0.7;
    const top = t.y - t.h * 0.1, bottom = t.y + t.h - 6 * s;
    const runs = [];
    for (let i = 0; i < count; i++) {
      const sp = keep(new PIXI.Sprite(lineTex));
      const len = (60 + Math.random() * 70) * s;
      sp.anchor.set(0.5); sp.width = 5 * s; sp.height = len; sp.tint = st.color;
      sp.blendMode = PIXI.BLEND_MODES.ADD; sp.alpha = 0; sp.zIndex = 95600;
      sp.x = t.center.x - w / 2 + (w * (i + Math.random() * 0.6)) / count;
      canvas.stage.addChild(sp);
      const from = st.dir === "up" ? bottom : top, to = st.dir === "up" ? top : bottom;
      runs.push(wait(i * 45 + Math.random() * 40).then(function () {
        return oni.tween({ from: 0, to: 1, duration: ms * 0.75, ease: E.inOutQuad || E.outQuad, onUpdate: function (v) {
          sp.y = from + (to - from) * v;
          sp.alpha = v < 0.2 ? v / 0.2 : (v > 0.75 ? (1 - v) / 0.25 : 1);
        } });
      }).then(function () { try { sp.destroy(); } catch (e) {} }));
    }
    return Promise.all(runs);
  }
  async function hit(key, t) {
    const c = cfg.clips[key];
    if (!c || !t) return;
    const r = await oni.vfx(c.url, { x: t.center.x, y: t.center.y, size: c.w * cfg.clipScale * s, zIndex: 95600 });
    if (!r || !r.sprite) return;
    r.sprite.anchor.set(c.ax, c.ay); r.sprite.position.set(t.center.x, t.center.y);
    await r.ended;
  }
  function arc(from, to, ms) {
    const g = keep(new PIXI.Graphics());
    g.blendMode = PIXI.BLEND_MODES.ADD; g.zIndex = 95650; canvas.stage.addChild(g);
    const N = 9, pts = [];
    for (let i = 0; i <= N; i++) {
      const v = i / N, j = (i === 0 || i === N) ? 0 : (Math.random() - 0.5) * 46 * s;
      pts.push({ x: from.x + (to.x - from.x) * v, y: from.y + (to.y - from.y) * v + j });
    }
    const draw = function (v) {
      g.clear();
      g.lineStyle({ width: 9 * s, color: 0xc9a0ff, alpha: 0.35, cap: "round", join: "round" });
      const upto = Math.max(1, Math.round(v * N));
      g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i <= upto; i++) g.lineTo(pts[i].x, pts[i].y);
      g.lineStyle({ width: 4 * s, color: 0xfff6a8, alpha: 1, cap: "round", join: "round" });
      g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i <= upto; i++) g.lineTo(pts[i].x, pts[i].y);
    };
    return oni.tween({ from: 0, to: 1, duration: ms, ease: E.linear, onUpdate: draw })
      .then(function () { return wait(160); })
      .then(function () { return oni.tween({ from: 1, to: 0, duration: 200, ease: E.linear, onUpdate: function (v) { g.alpha = v; } }); })
      .then(function () { try { g.destroy(); } catch (e) {} });
  }

  const pending = [];
  try {
    for (let b = 0; b < (cfg.beats || []).length; b++) {
      const beat = cfg.beats[b];
      const targets = (beat.recipients || []).map(tok).filter(function (t) { return t && t.center; });
      if (!targets.length) continue;
      if (beat.k === "redirect" && owner) {
        await Promise.all(targets.map(function (t, i) {
          return wait(i * 90).then(function () { return arc(owner.center, t.center, 220); });
        }));
        pending.push(Promise.all(targets.map(function (t) { return hit(beat.clip, t); })));
      } else if (beat.k === "damage") {
        pending.push(Promise.all(targets.map(function (t, i) { return wait(i * 110).then(function () { return hit(beat.clip, t); }); })));
      } else {
        const st = cfg.styles[beat.k];
        if (!st) continue;
        sfx(st.sfx);
        pending.push(Promise.all(targets.map(function (t, i) { return wait(i * 110).then(function () { return lines(t, st); }); })));
      }
      if (b < cfg.beats.length - 1) await wait(150);
    }
    await Promise.all(pending);
  } catch (e) {
    console.warn("[ONI][PassiveAnim] inner threw", e);
  } finally {
    for (const o of made) { try { if (!o.destroyed) o.destroy(); } catch (e) {} }
  }
}
/* eslint-enable no-undef */

export function passiveInnerBody() {
  const src = PASSIVE_INNER.toString();
  return src.slice(src.indexOf("{") + 1, src.lastIndexOf("}")).trim();
}

// beats with token uuids → the inner script's cfg
export function buildPassiveCfg({ beats, ownerTokenUuid }) {
  const clips = {};
  const out = beats.map((b) => {
    const clip = (b.k === "damage" || b.k === "redirect") ? (PASSIVE_HIT_CLIP[b.element] ?? PASSIVE_HIT_CLIP.physical) : null;
    if (clip && MV_CLIPS[clip]) {
      const c = MV_CLIPS[clip];
      clips[clip] = { url: clipUrl(clip), w: c.w, h: c.h, ax: c.ax, ay: c.ay };
    }
    return { k: b.k, recipients: b.recipients, clip };
  });
  const styles = {};
  for (const [k, v] of Object.entries(LINE_STYLE)) styles[k] = { dir: v.dir, color: v.color, sfx: v.sfx };
  return { ownerTokenUuid, beats: out, clips, styles, sfxBase: SFX_BASE, vol: SFX_VOL, clipScale: CLIP_SCALE };
}

// ── runtime glue (Foundry) ─────────────────────────────────────────────

function tokenDocOfActorUuid(actorUuid) {
  if (!actorUuid) return null;
  const m = /^(Scene\.[^.]+\.Token\.[^.]+)\.Actor\./.exec(actorUuid);
  if (m) { try { return fromUuidSync(m[1]); } catch { /* fall through */ } }
  const t = canvas?.tokens?.placeables?.find((p) => p.actor?.uuid === actorUuid);
  return t?.document ?? null;
}
function aeTagFor(entry) {
  try {
    const actor = fromUuidSync(entry.actorUuid);
    const eff = entry.aeId ? actor?.effects?.get?.(entry.aeId) : null;
    const pick = (e) => {
      const raw = e?.system?.tags;
      const l = (Array.isArray(raw) ? raw : (raw && typeof raw.has === "function" ? Array.from(raw) : [])).map((x) => String(x).toLowerCase());
      if (l.includes("debuff")) return "debuff";
      if (l.includes("buff")) return "buff";
      const st = e?.statuses;
      return (st && (st.size ?? st.length ?? 0) > 0) ? "status" : null;
    };
    if (eff) return pick(eff);
    const name = entry.name;
    if (!name) return null;
    for (const it of game.items ?? []) {
      if (it.type !== "activeEffectContainer") continue;
      const e = (it.effects ?? []).find((x) => x.name === name);
      if (e) return pick(e);
    }
  } catch { /* untagged */ }
  return null;
}
function sideAllowed(disposition) {
  let mode = "everyone";
  try { mode = game.settings.get(NS, "defaultActionAnimations") ?? "everyone"; } catch {}
  if (mode === "off") return false;
  if (mode === "everyone") return true;
  return mode === "npc" ? disposition === -1 : disposition !== -1;
}

const _pending = new Map();   // ownerTokenUuid|carrier → { beats, timer }

function broadcast(ownerDoc, beats, label) {
  const ownerTokenUuid = ownerDoc?.uuid ?? null;
  const withTokens = beats.map((b) => ({
    ...b,
    recipients: b.recipients.map((a) => tokenDocOfActorUuid(a)?.uuid).filter(Boolean),
  })).filter((b) => b.recipients.length);
  if (!withTokens.length) return;
  const cfg = buildPassiveCfg({ beats: withTokens, ownerTokenUuid });
  log(`[PassiveAnim] ${label}: ${withTokens.map((b) => `${b.k}×${b.recipients.length}`).join(" + ")}`);
  try {
    game.ONI?.pseudo?.play?.({
      scriptId: "oni.passive-fallback",
      scriptSource: passiveInnerBody(),
      casterTokenUuid: ownerTokenUuid,
      targetTokenUuids: withTokens.flatMap((b) => b.recipients),
      params: { cfg },
      meta: { source: "passive-fallback:" + label },
    });
  } catch (e) { warn("[PassiveAnim] pseudo.play threw", e); }
}

// ctx: the chain context that recorded (ctx.__passiveRec). carrierName: for the
// merge key + log. redirect: damage here answers incoming damage (Earthen Wire).
export function playPassiveFallback({ ctx, carrierName = "passive", redirect = false } = {}) {
  try {
    const rec = ctx?.__passiveRec;
    if (!rec || !game.user?.isGM) return;
    const ownerActor = ctx.reactorActor ?? null;
    const ownerDoc = ctx.reactorToken?.document ?? ctx.reactorToken ?? (ownerActor ? tokenDocOfActorUuid(ownerActor.uuid) : null);
    const disp = Number(ownerDoc?.disposition ?? 1);
    if (!sideAllowed(disp)) return;
    const sameSide = (actorUuid) => Number(tokenDocOfActorUuid(actorUuid)?.disposition ?? 0) === disp;
    const { beats, skipped } = composePassiveBeats(rec.records, { ownerActorUuid: ownerActor?.uuid ?? null, sameSide, aeTagOf: aeTagFor, redirect });
    if (skipped) return;
    // a hit has to land with BD's number — no merge window for damage
    if (beats.some((b) => b.k === "damage" || b.k === "redirect")) { broadcast(ownerDoc, beats, carrierName); return; }
    const key = `${ownerDoc?.uuid ?? ownerActor?.uuid}|${carrierName}`;
    const p = _pending.get(key);
    if (p) { p.beats = mergeBeats(p.beats, beats); p.count++; return; }
    const entry = { beats, count: 1, timer: null };
    entry.timer = setTimeout(() => {
      _pending.delete(key);
      broadcast(ownerDoc, entry.beats, entry.count > 1 ? `${carrierName} ×${entry.count}` : carrierName);
    }, MERGE_MS);
    _pending.set(key, entry);
  } catch (e) { warn("[PassiveAnim] fallback failed", e); }
}
