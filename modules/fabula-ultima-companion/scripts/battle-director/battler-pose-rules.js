// Battler pose rules — the pure half of battler-pose.js (no Foundry, no PIXI),
// so the fallback and priority rules can be tested with plain node.
//
// A battle token shows one pose at a time:
//   ko      once, then holds its last frame   (KO marker on the actor)
//   hurt    once                              (a hit — the hurt reaction)
//   attack  once                              (an action's animation starts)
//   cast    once                              (a spell's animation starts)
//   guard   loop                              (Guard effect)
//   crisis  loop                              (Crisis marker)
//   idle    the token's own image (sprite_battle) — never swapped
//
// Each pose reads its art from the actor sheet (`sprite_<pose>`). A pose with
// no art falls back as listed in FALLBACK; reaching idle means "do what the
// game did before this system existed".

export const POSES = ["idle", "hurt", "ko", "crisis", "guard", "attack", "cast"];

// Poses that play once and then hand back to the lasting pose.
export const ONE_SHOT = new Set(["hurt", "attack", "cast"]);
// Poses that play once and then stay on their last frame.
export const HOLD = new Set(["ko"]);
// Poses that loop for as long as they are shown.
export const LOOPING = new Set(["crisis", "guard"]);

// Art fallback chain, tried left to right; "idle" = the token's own image.
export const FALLBACK = {
  hurt: ["hurt", "idle"],
  ko: ["ko", "idle"],
  crisis: ["crisis", "idle"],
  guard: ["guard", "idle"],
  attack: ["attack", "idle"],
  cast: ["cast", "attack", "idle"],
  idle: ["idle"],
};

export function propKey(pose) { return `sprite_${pose}`; }

// The art URL a pose should show for these actor props, or null for the
// token's own image. `failed` is a Set of URLs that could not be loaded; a
// failed URL counts as missing so the chain moves on.
export function poseSrc(props, pose, failed = null) {
  for (const p of FALLBACK[pose] ?? ["idle"]) {
    if (p === "idle") return null;
    const src = String(props?.[propKey(p)] ?? "").trim();
    if (src && !(failed && failed.has(src))) return src;
  }
  return null;
}

// Every distinct pose URL an actor declares, for preloading.
export function declaredPoseSrcs(props) {
  const out = new Set();
  for (const p of POSES) {
    if (p === "idle") continue;
    const src = String(props?.[propKey(p)] ?? "").trim();
    if (src) out.add(src);
  }
  return [...out];
}

// ── markers on the actor ────────────────────────────────────────────────
// Effects are plain objects here: { name, disabled, statuses, flags }.
// `statuses` may be a Set or an array.
const NS = "fabula-ultima-companion";

function hasStatus(e, id) {
  const s = e?.statuses;
  if (s instanceof Set) return s.has(id);
  if (Array.isArray(s)) return s.includes(id);
  return false;
}

export function isKoEffect(e) {
  return !!e && e.disabled !== true && e.flags?.[NS]?.bdDefeated === true;
}

// Same recognition as crisis-reactor.js's isCrisisAE.
export function isCrisisEffect(e) {
  if (!e || e.disabled === true) return false;
  if (e.flags?.[NS]?.bdCrisis === true) return true;
  if (e.flags?.[NS]?.autoCrisis === true) return true;
  return String(e.name ?? "").trim().toLowerCase() === "crisis";
}

// The Guard action applies its Common item's "Guard" effect (core status id
// "guard"); the director releases it at the start of the guarder's turn.
export function isGuardEffect(e) {
  if (!e || e.disabled === true) return false;
  if (hasStatus(e, "guard")) return true;
  if (e.flags?.core?.statusId === "guard") return true;
  return String(e.name ?? "").trim().toLowerCase() === "guard";
}

// The lasting pose for an actor's effects: KO beats Guard beats Crisis.
export function lastingPose(effects) {
  const list = Array.isArray(effects) ? effects : [...(effects ?? [])];
  if (list.some(isKoEffect)) return "ko";
  if (list.some(isGuardEffect)) return "guard";
  if (list.some(isCrisisEffect)) return "crisis";
  return "idle";
}

// What the token shows: KO always wins; otherwise a running one-shot plays
// over the lasting pose and hands back to it when done.
export function shownPose(lasting, oneShot) {
  if (lasting === "ko") return "ko";
  if (oneShot) return oneShot;
  return lasting ?? "idle";
}

// Which pose an action plays when its animation starts. Spells cast;
// attacks and every other skill attack; anything else (Guard, Study,
// Objective, Item, Equipment, Hinder) has no pose of its own.
export function actionPose(ar) {
  if (!ar) return null;
  const kind = String(ar.kind ?? "");
  if (String(ar.skillType ?? "").toLowerCase() === "spell" || kind === "Spell") return "cast";
  if (kind === "Attack" || kind === "Skill") return "attack";
  return null;
}

// Same as actionPose, from a skill item's `skill_type` (reaction-path plays,
// which have no action result).
export function skillPose(skillType) {
  return String(skillType ?? "").toLowerCase() === "spell" ? "cast" : "attack";
}

// ── sizing ──────────────────────────────────────────────────────────────
// Foundry fits a token image into the token box by `fit`. Pose art drawn on a
// different canvas from the idle art (an RO death that needs more room) must
// keep the idle art's PIXEL size, not be squeezed into the box, and stand on
// the same spot: bottom-centre to bottom-centre.

export function fitScale(fit, boxW, boxH, w, h) {
  const sx = boxW / w, sy = boxH / h;
  switch (fit) {
    case "fill": return [sx, sy];
    case "cover": { const s = Math.max(sx, sy); return [s, s]; }
    case "width": return [sx, sx];
    case "height": return [sy, sy];
    default: { const s = Math.min(sx, sy); return [s, s]; }   // "contain"
  }
}

// Scale multipliers to apply on top of Foundry's fit of the POSE texture so
// it renders at the IDLE texture's pixel size. [1, 1] when the sizes match.
export function poseScaleFix(fit, boxW, boxH, idle, pose) {
  if (!idle?.w || !idle?.h || !pose?.w || !pose?.h) return [1, 1];
  if (idle.w === pose.w && idle.h === pose.h) return [1, 1];
  const [ix, iy] = fitScale(fit, boxW, boxH, idle.w, idle.h);
  const [px, py] = fitScale(fit, boxW, boxH, pose.w, pose.h);
  return [ix / px, iy / py];
}

// Anchor for the pose texture so its bottom-centre lands where the idle
// texture's bottom-centre is, given the anchor the idle texture uses.
export function poseAnchor(idleAnchor, idle, pose) {
  if (!idle?.w || !idle?.h || !pose?.w || !pose?.h) return { x: idleAnchor.x, y: idleAnchor.y };
  return {
    x: 0.5 - (0.5 - idleAnchor.x) * idle.w / pose.w,
    y: 1 - (1 - idleAnchor.y) * idle.h / pose.h,
  };
}
