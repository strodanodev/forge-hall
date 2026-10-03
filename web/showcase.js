// FORGE — a card's own 3D avatar on a slow turntable beside the inspected card.
// The avatar is the token's animation_url GLB (meshopt web encoding), bundled by the snapshot and sha256-checked
// against the token there. Bytes are prefetched when a pack opens; parsing, shader compile and GPU upload happen on
// inspect (compileAsync), never during the reveal animation.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { glbBytes, imageTextures } from "./fx.js";

const SPIN = 0.55;                                   // rad/s

// The avatars' materials are authored for Cycles + AgX: emissive strengths of 1-14 and near-mirror chrome (roughness
// 0.13). This renderer has no tone mapping and blooms anything over ~0.8, so taken raw the glows clip to white and
// the hall's point lights leave pin-point highlights that bloom into white squares. Re-finish for this stage.

// Emission with depth and life (uniform emission reads as flat paint). Three looks share one program family:
//   crack  Titan cracks/cores: hottest where the surface faces the viewer (looking into a gap), a molten flow
//   neon   thin lines (Mortal wireframes, King/God circuits and seams, eyes): even brightness along the line (a
//          facing falloff would darken most of a thin tube) and an energy band sweeping up the body (no flicker:
//          on thin lines it read as jitter)
//   glass  the Mortals' glass body: a holographic fresnel rim in the element colour, more opaque at the silhouette
// pow() bases are clamped: a dot of two unit vectors can exceed 1 by float error (more often under MSAA, which
// evaluates at sample points near edges), and pow of a negative base is NaN.
// Patterns run in world space measured from the feet and divided by the displayed height (0..1 up the body): the
// rigs' own units differ ~100x (Titans) and are quantized.
const GLOW_GLSL = {
  crack: `float gF = abs(dot(normal, normalize(vViewPosition)));
    float gFlow = 0.5 + 0.5 * sin(uGlowTime * 1.6 + gP.y * 14.0 + 1.6 * sin(gP.x * 10.0 - uGlowTime * 0.7));
    totalEmissiveRadiance *= mix(0.3, 1.15, pow(clamp(gF, 0.0, 1.0), 1.4)) * (0.75 + 0.35 * gFlow);`,
  neon: `float gScan = fract(gP.y * 0.6 - uGlowTime * 0.28);
    float gBand = smoothstep(0.0, 0.16, gScan) * (1.0 - smoothstep(0.16, 0.5, gScan));
    totalEmissiveRadiance *= 0.85 + 0.55 * gBand;`,
  glass: `float gRim = pow(clamp(1.0 - abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.2);
    float gScan = fract(gP.y * 0.6 - uGlowTime * 0.28);
    float gBand = smoothstep(0.0, 0.06, gScan) * (1.0 - smoothstep(0.06, 0.4, gScan));
    totalEmissiveRadiance *= gRim * (0.8 + 0.6 * gBand);
    diffuseColor.a = mix(diffuseColor.a, 0.35, gRim);`,
};
function glow(m, ctx, look) {
  m.customProgramCacheKey = () => `rapture-glow-${look}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlowTime = ctx.time;
    sh.uniforms.uGlowScale = ctx.scale;
    sh.uniforms.uGlowBase = ctx.base;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlowPos;")
      .replace("#include <skinning_vertex>", "#include <skinning_vertex>\nvGlowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlowPos;\nuniform float uGlowTime, uGlowScale, uGlowBase;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        vec3 gP = vec3(vGlowPos.x, vGlowPos.y - uGlowBase, vGlowPos.z) * uGlowScale; // y: 0..1 up the body
        ${GLOW_GLSL[look]}
        // one NaN/Inf pixel and UnrealBloom's blur turns the whole screen black: never emit one
        if (any(isnan(totalEmissiveRadiance)) || any(isinf(totalEmissiveRadiance))) totalEmissiveRadiance = vec3(0.0);
        if (isnan(diffuseColor.a)) diffuseColor.a = 0.0;`);
  };
}
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** @param ctx {{env, time: {value}, scale: {value}, base: {value}, accent: THREE.Color}} */
function finish(m, ctx) {
  // meshes share materials (a Mortal's two glass bodies, head + body wires): re-finishing one would read its new
  // emission as authored and re-classify / re-scale it
  if (m.userData.finished) return;
  m.userData.finished = true;
  m.envMap = ctx.env;
  const s = m.emissiveIntensity, lit = m.emissive.r + m.emissive.g + m.emissive.b > 0;
  if (lit && m.metalness < 0.5 && !/gold/.test(m.name)) {
    // Glowing accents are light, not paint: authored as a black glossy base plus emission, they caught specular and
    // read as coloured plastic. Matte, no reflections, and bright enough to bloom. Intensity targets a LUMINANCE
    // (bloom threshold 0.82): lava pink (luma 0.23) needs ~4x what earth green (luma 0.73) does to glow as much.
    // Weak authored glows (Sealed) stay a little dimmer; Mortal wireframes (thin, and all a Mortal is) get more.
    const faint = /faint/.test(m.name), crack = /crack/.test(m.name);
    const target = (0.95 + 0.2 * Math.min(s, 3)) * (faint ? 1.35 : 1); // thin lines: bright enough to bloom, not to sparkle
    m.emissiveIntensity = Math.min(10, target / Math.max(luma(m.emissive), 0.05));
    m.color.setRGB(0, 0, 0);
    m.roughness = 1;
    m.metalness = 0;
    m.envMapIntensity = 0;
    glow(m, ctx, crack ? "crack" : "neon");
    return;
  }
  if (/glass/.test(m.name) && m.transparent) {
    // hologram body: faint glass with the element colour glowing at its silhouette
    m.emissive.copy(ctx.accent);
    m.emissiveIntensity = Math.min(3, 0.6 / Math.max(luma(ctx.accent), 0.05)); // a hint: the wires lead
    m.envMapIntensity = 0.5;
    m.depthWrite = false;
    glow(m, ctx, "glass");
    return;
  }
  if (lit) m.emissiveIntensity = 1.05 * s / (1 + s);  // gold + gold core: keep the hue, just over bloom
  if (/titan_chrome/.test(m.name)) {
    // Titan shells (rough 0.5, 35-70% metal) read as plastic under the hall's flat fill: make them forged metal
    // reflecting the studio panels. A near-black shell (Lava, 0.07) is lifted to gunmetal first: fully metallic at
    // 0.07 it would only mirror the void (why the Studio authored Lava at 0.35 metal).
    const mx = Math.max(m.color.r, m.color.g, m.color.b);
    if (mx < 0.22) m.color.multiplyScalar(0.22 / Math.max(mx, 1e-3));
    m.metalness = 0.92;
    m.roughness = 0.38;
    m.envMapIntensity = 1.5;
  } else if (m.metalness > 0.5) {
    // god/demigod chrome, statue and gold: broaden highlights so point lights spread instead of spiking
    m.roughness = Math.max(m.roughness, 0.34);
    m.envMapIntensity = 0.85;
  } else {
    m.envMapIntensity = 0.7;
  }
}
const ease = { out: (k) => 1 - Math.pow(1 - k, 3), back: (k) => 1 + 2.6 * Math.pow(k - 1, 3) + 1.6 * Math.pow(k - 1, 2) };

export class AvatarShowcase {
  /** @param {{parent: THREE.Object3D, scene: THREE.Scene, renderer: THREE.WebGLRenderer, getCamera: () => THREE.Camera, glowMap: THREE.Texture}} o */
  constructor(o) {
    Object.assign(this, o);
    this.loader = imageTextures(new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));
    this.bytes = new Map();                          // url -> Promise<ArrayBuffer>
    this.group = new THREE.Group();
    this.group.visible = false;
    this.parent.add(this.group);
    this.spin = new THREE.Group();
    this.group.add(this.spin);

    // pedestal: element-coloured ring + soft pool of light, additive (no lit material, no recompiles)
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.3, 64),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.pool = new THREE.Mesh(new THREE.CircleGeometry(0.62, 48),
      new THREE.MeshBasicMaterial({ map: this.glowMap, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    for (const m of [this.ring, this.pool]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 2; this.group.add(m); }
    this.pool.position.y = -0.002;
    // a soft dark halo behind the figure: separates chrome from the forge fire behind it
    this.backdrop = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowMap, color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
    this.backdrop.renderOrder = 1;
    this.group.add(this.backdrop);

    // Chrome and glass need something to reflect; the hall is baked and has no environment. This one belongs to the
    // avatars' materials only (scene.environment would relight, and recompile, everything else).
    const pmrem = new THREE.PMREMGenerator(this.renderer), studio = studioScene();
    this.env = sharedEnv = pmrem.fromScene(studio, 0.03).texture;
    pmrem.dispose();
    studio.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });

    this.token = 0; this.avatar = null; this.mixer = null; this.tweens = [];
    this.uGlowTime = { value: 0 };                  // shared by every avatar's glow shader
  }

  prefetch(cards) {
    for (const c of cards) {
      const url = c.avatar?.url;
      if (url && !this.bytes.has(url)) this.bytes.set(url, glbBytes(url).catch(() => null));
    }
  }

  /** Show `card`'s avatar standing at `pos` (rig space), `height` metres tall. Resolves when it is on screen. */
  async show(card, pos, height) {
    const token = ++this.token;
    this.clear();
    const col = new THREE.Color(card.elementColor ?? "#ffd37a");
    this.ring.material.color.copy(col); this.pool.material.color.copy(col);
    this.group.position.copy(pos);
    this.group.visible = true;
    this.backdrop.position.set(0, height * 0.55, -0.45);
    this.backdrop.scale.set(height * 1.5, height * 1.9, 1);
    this.tween(0.5, (k) => { this.ring.material.opacity = 0.9 * k; this.pool.material.opacity = 0.55 * k; this.backdrop.material.opacity = 0.75 * k; });
    if (!card.avatar?.url) return;

    this.prefetch([card]);
    const buf = await this.bytes.get(card.avatar.url);
    if (!buf || token !== this.token) return;
    const gltf = await this.loader.parseAsync(buf.slice(0), card.avatar.url.replace(/[^/]+$/, ""));
    if (token !== this.token) { dispose(gltf.scene); return; }

    const root = gltf.scene;
    // per-avatar glow context: element colour for the glass rim; feet height + scale for the patterns
    const ctx = { env: this.env, time: this.uGlowTime, scale: { value: 1 / height }, base: { value: 0 }, accent: col };
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;                       // skinned + quantized bounds are unreliable
      for (const m of [o.material].flat()) if (m.isMeshStandardMaterial) finish(m, ctx);
    });
    // idle pose first, then measure: bind poses are not what the card shows
    const clip = gltf.animations.find((a) => /idle/i.test(a.name)) ?? gltf.animations[0];
    const mixer = clip ? new THREE.AnimationMixer(root) : null;
    if (clip) { mixer.clipAction(clip).play(); mixer.update(0); }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true), size = box.getSize(new THREE.Vector3());
    const s = height / (size.y || 1);
    root.scale.setScalar(s);
    root.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);

    this.spin.add(root);
    this.group.updateMatrixWorld(true);
    ctx.base.value = this.group.getWorldPosition(new THREE.Vector3()).y; // feet sit at the group origin
    this.spin.scale.setScalar(1e-4);
    await this.renderer.compileAsync(this.group, this.getCamera(), this.scene).catch(() => {});
    if (token !== this.token) { this.spin.remove(root); dispose(root); return; }
    this.avatar = root; this.mixer = mixer;
    this.spin.rotation.y = -0.6;
    this.tween(0.6, (k) => this.spin.scale.setScalar(Math.max(1e-4, ease.back(k))));
    this.flash = 1;
  }

  hide() {
    ++this.token;
    if (!this.group.visible) return;
    const s0 = this.spin.scale.x, r0 = this.ring.material.opacity, p0 = this.pool.material.opacity, b0 = this.backdrop.material.opacity;
    const token = this.token;
    this.tween(0.3, (k) => {
      this.spin.scale.setScalar(Math.max(1e-4, s0 * (1 - k)));
      this.ring.material.opacity = r0 * (1 - k); this.pool.material.opacity = p0 * (1 - k); this.backdrop.material.opacity = b0 * (1 - k);
    }).then(() => { if (token === this.token) { this.clear(); this.group.visible = false; } });
  }

  clear() {
    if (this.avatar) { this.spin.remove(this.avatar); dispose(this.avatar); }
    this.avatar = null; this.mixer = null;
  }

  forget() { this.bytes.clear(); }                  // a new pack: drop the last pack's prefetched bytes

  update(dt, t) {
    this.uGlowTime.value = t;
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i]; tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur); tw.fn(k);
      if (k >= 1) { this.tweens.splice(i, 1); tw.done(); }
    }
    if (!this.group.visible) return;
    this.mixer?.update(dt);
    this.spin.rotation.y += dt * SPIN;
    this.flash = Math.max(0, (this.flash ?? 0) - dt * 1.8);
    this.ring.scale.setScalar(1 + 0.04 * Math.sin(t * 2.2) + 0.35 * ease.out(this.flash));
  }

  tween(dur, fn) { return new Promise((done) => this.tweens.push({ t: 0, dur, fn, done })); }
}

// The card renders' stage (rapture/art STAGE): near-black void, warm key front-left, cool rim behind, faint top.
function studioScene() {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ color: 0x07070b, side: THREE.BackSide })));
  const panel = (w, h, hex, k, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m);
  };
  panel(3, 5, 0xffd6a8, 1.6, -5, 2.5, 5);            // key
  panel(2, 7, 0xa8d8ff, 1.2, 5.5, 2, -4.5);          // rim
  panel(7, 2, 0xffffff, 0.25, 0, 8, 0);              // top
  return s;
}

// frees an avatar's GPU resources; the shared environment map is not the avatar's to free
let sharedEnv = null;
function dispose(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [o.material].flat()) {
      for (const v of Object.values(m)) if (v?.isTexture && v !== sharedEnv) v.dispose();
      m.dispose();
    }
  });
}
