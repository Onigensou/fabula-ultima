// ============================================================================
// creature-rig/rig-model.js — build + pose + render one 3D creature rig with three.js (r128 global THREE)
//
// The rig data (assets/creature-rigs/<id>/rig.json, written by tools/nidhogg-motion-test/export_rig.py) is
// the motion test's: one relief mesh per painted part, each with its own texture cut from the same painting,
// per-vertex rig weights (rj jaw, rs skull, rt tail, rb breath, wn/wf near/far wing) and pivots in SPRITE
// pixels (x right, y down, origin top-left of the w x h painting).
//
// RENDER CONTRACT: an ORTHOGRAPHIC camera framing exactly the painting's w x h. At yaw 0 and the rest pose the
// output is the painting pixel for pixel (depth does not shift anything under an orthographic camera), so the
// rig can stand in for the flat token image without moving any anchor. yaw turns the model about its
// vertical centre line (degrees, + = the camera swings to the creature's left).
// ============================================================================

const D2R = Math.PI / 180;

function b64u8(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

function rot2(v, c, a) { const x = v[0] - c[0], y = v[1] - c[1], co = Math.cos(a), si = Math.sin(a); v[0] = c[0] + x * co - y * si; v[1] = c[1] + x * si + y * co; }
function rot3(v, A, u, th) {
  const px = v[0] - A[0], py = v[1] - A[1], pz = v[2] - A[2], c = Math.cos(th), s = Math.sin(th), d = u[0] * px + u[1] * py + u[2] * pz;
  const x = A[0] + px * c + (u[1] * pz - u[2] * py) * s + u[0] * d * (1 - c);
  const y = A[1] + py * c + (u[2] * px - u[0] * pz) * s + u[1] * d * (1 - c);
  const z = A[2] + pz * c + (u[0] * py - u[1] * px) * s + u[2] * d * (1 - c); v[0] = x; v[1] = y; v[2] = z;
}

/** Load an image as an HTMLImageElement (decoded). */
async function loadImage(url) {
  const img = new Image(); img.decoding = "async"; img.crossOrigin = "anonymous"; img.src = url;
  await img.decode(); return img;
}

export class RigModel {
  /**
   * @param {object} THREE  the three.js namespace (r128)
   * @param {object} data   parsed rig.json
   * @param {(name:string)=>string} urlOf  texture file name -> URL
   */
  constructor(THREE, data, urlOf) {
    this.THREE = THREE; this.data = data; this.urlOf = urlOf;
    this.W = data.w; this.H = data.h;
    this.scene = new THREE.Scene();
    this.group = new THREE.Group(); this.scene.add(this.group);
    const W = this.W, H = this.H;
    this.camera = new THREE.OrthographicCamera(-W / 2, W / 2, H, 0, -5000, 5000);
    this.camera.position.set(0, 0, 1000); this.camera.lookAt(0, 0, 0);
    this.layers = [];
    this.textures = [];
    this.lastPose = null;
    const P2 = (p) => [p[0] - W / 2, H - p[1]];
    const r = data.rig || {};
    this.JAW = r.jaw ? P2(r.jaw) : null; this.NECK = r.neck ? P2(r.neck) : null; this.TAILR = r.tailRoot ? P2(r.tailRoot) : null;
    const hinge = (key) => {
      const h = data.hinges?.[key]; if (!h) return null;
      const A = [h.a[0] - W / 2, H - h.a[1], h.a[2]], B = [h.b[0] - W / 2, H - h.b[1], h.b[2]];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = Math.hypot(...u) || 1; return { A, u: u.map((x) => x / L) };
    };
    this.HN = hinge("wing_near"); this.HF = hinge("wing_far");
  }

  /** Decode geometry and load every texture. Resolves when the rig can render its first true frame. */
  async build() {
    const THREE = this.THREE, W = this.W, H = this.H;
    const jobs = this.data.layers.map(async (Ly) => {
      const img = await loadImage(this.urlOf(this.data.textures?.[Ly.n] ?? `${Ly.n}.png`));
      const tex = new THREE.Texture(img); tex.needsUpdate = true; tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
      if (Ly.uv) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; }
      this.textures.push(tex);
      const xy = new Uint16Array(b64u8(Ly.xy).buffer), zq = new Uint16Array(b64u8(Ly.z).buffer), f = new Uint32Array(b64u8(Ly.f).buffer);
      const n = Ly.nv, base = new Float32Array(n * 3), pp = new Float32Array(n * 3), uu = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const x = xy[2 * k] / 8, y = xy[2 * k + 1] / 8;
        base[3 * k] = x - W / 2; base[3 * k + 1] = H - y; base[3 * k + 2] = Ly.zmin + (zq[k] / 65535) * (Ly.zmax - Ly.zmin);
        uu[2 * k] = x / W; uu[2 * k + 1] = 1 - y / H;
      }
      if (Ly.uv) { const uv16 = new Uint16Array(b64u8(Ly.uv).buffer); for (let k = 0; k < 2 * n; k++) uu[k] = uv16[k] / 65535; }
      pp.set(base);
      const W8 = (k) => (Ly[k] ? b64u8(Ly[k]) : new Uint8Array(n));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pp, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uu, 2));
      g.setIndex(new THREE.BufferAttribute(f, 1));
      // two passes, as in the motion test: solid (alpha-tested, writes depth) + soft (blended edges and the
      // see-through wing membrane, no depth write, drawn in part order)
      const solidM = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.98, side: THREE.DoubleSide });
      const softM = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.03, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const solid = new THREE.Mesh(g, solidM), soft = new THREE.Mesh(g, softM);
      solid.frustumCulled = false; soft.frustumCulled = false;
      soft.renderOrder = 10 + Ly.order;
      this.group.add(solid, soft);
      return { Ly, n, base, pp, g, mats: [solidM, softM], solid, soft, wn: W8("wn"), wf: W8("wf"), rj: W8("rj"), rs: W8("rs"), rt: W8("rt"), rb: W8("rb"), tail: Ly.n === "tail" };
    });
    this.layers = await Promise.all(jobs);
    return this;
  }

  /** Deform every layer to the pose channels (see rig-motions.js). */
  pose(p) {
    const aj = (p.jaw || 0) * D2R, as = -(p.lift || 0) * D2R, by = (p.breath || 0) * 4, tw = (p.tail || 0) * D2R;
    const wn = -(p.wings || 0) * D2R, wfA = -(p.wings || 0) * 0.8 * D2R, ph = p.tailPhase || 0;
    const v = [0, 0, 0], HN = this.HN, HF = this.HF, JAW = this.JAW, NECK = this.NECK, TAILR = this.TAILR;
    for (const L of this.layers) {
      const { n, base, pp, rj, rs, rt, rb, wn: WN, wf: WF } = L;
      for (let k = 0; k < n; k++) {
        v[0] = base[3 * k]; v[1] = base[3 * k + 1]; v[2] = base[3 * k + 2];
        const a = WN[k] / 255, b = WF[k] / 255;
        if (a > 0.004 && HN) rot3(v, HN.A, HN.u, wn * a);
        if (b > 0.004 && HF) rot3(v, HF.A, HF.u, wfA * b);
        const j = rj[k] / 255; if (j > 0.004 && JAW) rot2(v, JAW, aj * j);
        const s = rs[k] / 255; if (s > 0.004 && NECK) rot2(v, NECK, as * s);
        if (L.tail && TAILR) { const tt = rt[k] / 255; if (tt > 0.004) rot2(v, TAILR, tw * tt * (0.6 + 0.4 * Math.sin(ph * 1.6 - tt * 2.4))); }
        v[1] += (by * rb[k]) / 255;
        pp[3 * k] = v[0]; pp[3 * k + 1] = v[1]; pp[3 * k + 2] = v[2];
      }
      L.g.attributes.position.needsUpdate = true;
    }
    this.lastPose = p;
  }

  /** Turn the model about its vertical centre line (degrees). */
  setYaw(deg) { this.group.rotation.y = (deg || 0) * D2R; }

  /** Render into `renderer` (whose canvas the caller sized to any w x h with the painting's aspect). */
  render(renderer) { renderer.render(this.scene, this.camera); }

  dispose() {
    for (const L of this.layers) { L.g.dispose(); for (const m of L.mats) m.dispose(); }
    for (const t of this.textures) t.dispose();
    this.layers = []; this.textures = [];
  }
}

/** Fetch + parse a rig and build it. `base` is the rig folder URL (with a trailing slash). */
export async function loadRigModel(THREE, base) {
  const res = await fetch(`${base}rig.json`);
  if (!res.ok) throw new Error(`creature-rig: ${base}rig.json -> HTTP ${res.status}`);
  const data = await res.json();
  const m = new RigModel(THREE, data, (name) => `${base}${name}?v=${data.hash || "0"}`);
  return m.build();
}
