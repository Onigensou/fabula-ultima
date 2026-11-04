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
  // Reflect fallback (user pick, 2026-11-04: MIRROR): a glass pane snaps up
  // beside the owner, facing whoever takes the hit, a shine sweeps across it.
  // Returns where the hit leaves the pane.
  function mirror(t, toward) {
    const side = Math.sign(toward.x - t.center.x) || 1;
    const px = t.center.x + side * 95 * s, cy = t.center.y, h = Math.max(200 * s, t.h * 1.1), w = 70 * s;
    const poly = [px - w / 2, cy - h / 2, px + w / 2, cy - h / 2 - 18 * s * side, px + w / 2, cy + h / 2 - 18 * s * side, px - w / 2, cy + h / 2];
    const pane = keep(new PIXI.Graphics());
    pane.lineStyle({ width: 3 * s, color: 0xeaf8ff, alpha: 1 });
    pane.beginFill(0xc8ebff, 0.35); pane.drawPolygon(poly); pane.endFill();
    // grows up from its base and swells a little as it fades (mockup mirrorFx)
    const base = { x: px, y: cy + h / 2 };
    pane.pivot.set(base.x, base.y); pane.position.set(base.x, base.y); pane.scale.set(1, 0);
    pane.zIndex = 95650; pane.alpha = 0; canvas.stage.addChild(pane);
    const mask = keep(new PIXI.Graphics()); mask.beginFill(0xffffff); mask.drawPolygon(poly); mask.endFill(); canvas.stage.addChild(mask);
    const shine = keep(new PIXI.Graphics());
    shine.beginFill(0xffffff, 0.85); shine.drawRect(-11 * s, -h, 22 * s, h * 2); shine.endFill();
    shine.rotation = 0.3; shine.zIndex = 95660; shine.position.set(px - w, cy); shine.mask = mask; canvas.stage.addChild(shine);
    const done = oni.tween({ from: 0, to: 1, duration: 130, ease: E.outQuad, onUpdate: function (v) { pane.alpha = v; pane.scale.set(1, v); } })
      .then(function () { return oni.tween({ from: 0, to: 1, duration: 260, ease: E.linear, onUpdate: function (v) { shine.position.set(px - w + v * w * 2, cy); } }); })
      .then(function () { return oni.tween({ from: 1, to: 0, duration: 380, ease: E.outQuad, onUpdate: function (v) { pane.alpha = v; shine.alpha = v; pane.scale.set(1 + 0.08 * (1 - v), 1 + 0.08 * (1 - v)); } }); })
      .then(function () { for (const o of [pane, mask, shine]) { try { o.destroy(); } catch (e) {} } });
    return { from: { x: px, y: cy }, done: done };
  }
  // The hit ricochets off the pane in a straight line.
  function ricochet(from, to, ms) {
    const g = keep(new PIXI.Graphics());
    g.blendMode = PIXI.BLEND_MODES.ADD; g.zIndex = 95650; canvas.stage.addChild(g);
    return oni.tween({ from: 0, to: 1, duration: ms, ease: E.linear, onUpdate: function (v) {
      g.clear();
      g.lineStyle({ width: 10 * s, color: 0x7fd8ff, alpha: 0.35, cap: "round" });
      g.moveTo(from.x, from.y); g.lineTo(from.x + (to.x - from.x) * v, from.y + (to.y - from.y) * v);
      g.lineStyle({ width: 5 * s, color: 0xe9fbff, alpha: 1, cap: "round" });
      g.moveTo(from.x, from.y); g.lineTo(from.x + (to.x - from.x) * v, from.y + (to.y - from.y) * v);
    } }).then(function () { return oni.tween({ from: 1, to: 0, duration: 160, ease: E.linear, onUpdate: function (v) { g.alpha = v; } }); })
      .then(function () { try { g.destroy(); } catch (e) {} });
  }

  const pending = [];
  try {
    for (let b = 0; b < (cfg.beats || []).length; b++) {
      const beat = cfg.beats[b];
      const targets = (beat.recipients || []).map(tok).filter(function (t) { return t && t.center; });
      if (!targets.length) continue;
      if (beat.k === "redirect" && owner) {
        sfx(cfg.reflectSfx);
        const m = mirror(owner, targets[0].center);
        pending.push(m.done);
        await wait(260);
        await Promise.all(targets.map(function (t, i) {
          return wait(i * 90).then(function () { return ricochet(m.from, t.center, 170); });
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
  // the reflect cue (mockup: Reflection, 0.55 × the 0.7 tuning); only the
  // mirror beat plays it — the hit itself still sounds through BD's number
  const reflectSfx = out.some((b) => b.k === "redirect") ? "Soundboard/Reflection.ogg" : null;
  return { ownerTokenUuid, beats: out, clips, styles, sfxBase: SFX_BASE, vol: SFX_VOL, clipScale: CLIP_SCALE, reflectSfx };
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
