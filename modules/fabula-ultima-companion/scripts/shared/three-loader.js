// ============================================================================
// shared/three-loader.js — three.js r128, loaded lazily once as the global THREE
//
// Shared by the 3D stage camera (battle-director/battle-stage-3d-camera.js) and the creature rig host
// (creature-rig/rig-host.js), so the vendor file is fetched and evaluated once per page.
// ============================================================================

export const THREE_SRC = "modules/fabula-ultima-companion/assets/vendor/three-r128.min.js";

let threeLoading = null;
export function loadThree() {
  if (globalThis.THREE?.WebGLRenderer) return Promise.resolve(globalThis.THREE);
  if (threeLoading) return threeLoading;
  threeLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = foundry.utils.getRoute(THREE_SRC);
    s.onload = () => (globalThis.THREE ? resolve(globalThis.THREE) : reject(new Error("three.js loaded without THREE")));
    s.onerror = () => reject(new Error(`three.js failed to load (${THREE_SRC})`));
    document.head.appendChild(s);
  });
  threeLoading.catch(() => { threeLoading = null; });
  return threeLoading;
}
