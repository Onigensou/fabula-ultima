// Installs the party-stash rule (stash-effect-rules.js) on ActiveEffect's
// `isSuppressed` getter, the switch Foundry reserves for "this effect exists but
// does not apply". Same pattern as the Polymorph gear-suspend patch
// (polymorph-core.js): each patch wraps whatever getter is there, so the two
// compose in either load order. Installed at module load, before actors prepare.
import { stashSuppressesEffect } from "./stash-effect-rules.js";

(() => {
  // `ActiveEffect` is a global BINDING in Foundry's classic scripts, not a
  // globalThis property.
  // eslint-disable-next-line no-undef
  const proto = (typeof ActiveEffect !== "undefined" ? ActiveEffect : null)?.prototype;
  if (!proto || proto.__oniStashSuppress) return;
  let owner = proto, desc = null;
  while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, "isSuppressed"))) owner = Object.getPrototypeOf(owner);
  const base = desc?.get ?? null;
  Object.defineProperty(proto, "isSuppressed", {
    configurable: true,
    get() {
      try { if (stashSuppressesEffect(this)) return true; } catch { /* never break effect prep */ }
      return base ? base.call(this) : false;
    },
  });
  Object.defineProperty(proto, "__oniStashSuppress", { value: true });
})();
