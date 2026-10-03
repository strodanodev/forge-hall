// FORGE — pack opening.
// A green-screen pack video is chroma-keyed onto a camera-facing plane in the hall, real-time VFX run off the
// video clock (charge → tear sparks → climax burst → orbit trails), and at the hand-off frame a 3D card stack
// takes the video card's exact place, then fans out and flips with rarity effects.
import * as THREE from "three";
import { Particles, rand, sprite, textures, viewportScale } from "./fx.js";
import { ELEMENT, PACK_SIZE, RANK, RARITY, drawFace, preloadArt, rollPack } from "./rapture.js";
import { AvatarShowcase } from "./showcase.js";
import { CardPanel } from "./cardpanel.js";

// ------------------------------------------------------------------ tuning
const VIDEOS = {
  // 60 fps, motion-interpolated from the 24 fps originals (scripts/interp_pack_video.py): 24 fps in a 60 Hz scene
  // judders 3:2. The originals (pack_*.mp4) stay alongside as sources.
  // physics only: the pack tears, the card rises; every effect is ours (default). The burst is a hard pop at 6.25 s
  // (the generator's two smear frames are dropped), so the climax lands on it.
  physics: { url: "./assets/pack/pack_physics_60.mp4", tear: 4.45, burst: 6.24, swap: 9.45, bakedFx: false },
  // same shot with Veo's own flash/sparkle baked in; our effects run lighter on top
  fx: { url: "./assets/pack/pack_fx_60.mp4", tear: 4.45, burst: 6.2, swap: 9.45, bakedFx: true },
};
const KEY_SRGB = [40 / 255, 168 / 255, 64 / 255];
const CROP = [0.12, 0.88];               // horizontal slice of the 16:9 frame that holds the pack and its flaps
const VIDEO_ASPECT = 1280 / 720;
const PLANE_H = 1.3;                     // metres: the video frame's height in the hall
const PLANE_W = PLANE_H * VIDEO_ASPECT * (CROP[1] - CROP[0]);
const CARD = { w: 0.62, h: 0.868, t: 0.006, r: 0.014 }; // r matches the card-back art's own corner radius
// where the card sits in the video at the hand-off (measured from the clip at 9.5 s)
const CARD_IN_VIDEO = { u: 0.493, v: 0.431, rotY: 0.2, rotZ: -0.037 };
const TRAILS = [[0, 0.56, 0.89, 1.0], [Math.PI, 1.0, 0.78, 0.38]]; // orbit-trail phase + colour (cyan, gold)
const FWD = new THREE.Vector3(), SHAKE = new THREE.Vector3();
// ShopError codes (packshop.js) for a sealed pack that can never be opened: expired, opened elsewhere, refunded, unknown
const DEAD_PACK = new Set(["pack_expired", "pack_opened", "pack_refunded", "pack_none"]);

// ------------------------------------------------------------------ small utilities
const ease = {
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
  back: (k) => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ chroma key
// Depth-only twin of the keyed plane: writes depth where the pack/card is solid, so particles and trails that pass
// BEHIND the pack are hidden by it instead of drawing over it (the colour plane itself must not write depth, or its
// soft keyed edges would punch holes). Same geometry + uniforms, drawn in the opaque pass before everything else.
function keyDepthMaterial(colorMat) {
  const fragmentShader = colorMat.fragmentShader.replace(
    "gl_FragColor = vec4(toLinear(clamp(c, 0.0, 1.0)), clamp(a * opacity * ready, 0.0, 1.0));",
    "if (a * opacity * ready < 0.6) discard; gl_FragColor = vec4(0.0);");
  // a missed replace would write depth over the whole frame rectangle and hide everything behind it
  if (fragmentShader === colorMat.fragmentShader) throw new Error("keyDepthMaterial: output line not found");
  return new THREE.ShaderMaterial({ uniforms: colorMat.uniforms, vertexShader: colorMat.vertexShader, fragmentShader,
    colorWrite: false, depthWrite: true });
}

function keyMaterial(tex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex }, key: { value: new THREE.Vector3(...KEY_SRGB) }, crop: { value: new THREE.Vector2(...CROP) },
      similarity: { value: 0.1 }, smoothness: { value: 0.08 }, spill: { value: 0.85 }, opacity: { value: 0 },
      ready: { value: 0 },  // 0 until the browser has presented a decoded frame: never show an empty (black) texture
      reveal: { value: 1 }, // iris-in from the centre (0 -> 1.05); the pack is either there or not, never see-through
      floorFade: { value: 0.03 }, // height (0-1 of the frame) of the soft fade along the bottom edge
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 key; uniform vec2 crop; uniform float similarity, smoothness, spill, opacity, ready, reveal, floorFade;
      varying vec2 vUv;
      vec2 cbcr(vec3 c){ return vec2(-0.1687*c.r-0.3313*c.g+0.5*c.b, 0.5*c.r-0.4187*c.g-0.0813*c.b); }
      vec3 toLinear(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
      void main(){
        vec2 uv = vec2(mix(crop.x, crop.y, vUv.x), vUv.y);
        vec3 c = texture2D(map, uv).rgb;                       // raw sRGB video
        float d = distance(cbcr(c), cbcr(key));
        float a = smoothstep(similarity, similarity + smoothness, d);
        // de-spill: pull green down toward the other channels where the key bled in
        float s = pow(1.0 - smoothstep(similarity, similarity + 0.25, d), 1.5) * spill;
        c.g = mix(c.g, min(c.g, max(c.r, c.b)), s);
        a *= smoothstep(0.0, 0.04, vUv.x) * smoothstep(0.0, 0.04, 1.0 - vUv.x);
        // Once the card rises, the torn foil slides down past the bottom of the video frame; without this it is
        // sliced off by the plane's straight edge. Eased (squared) so the foil thins out rather than hitting a gradient.
        float fl = smoothstep(0.0, floorFade, vUv.y);
        a *= fl * fl;
        // Materialize with a noisy iris, not a fade: a half-transparent pack lets the forge fire behind it (HDR ~6x)
        // blaze straight through the foil. Only the thin iris rim is ever partial.
        float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        float iris = length((vUv - 0.5) * vec2(1.3, 1.0)) + (n - 0.5) * 0.05;
        a *= 1.0 - smoothstep(reveal - 0.05, reveal, iris);
        gl_FragColor = vec4(toLinear(clamp(c, 0.0, 1.0)), clamp(a * opacity * ready, 0.0, 1.0));
      }`,
    transparent: true, depthWrite: false,
  });
}

// ------------------------------------------------------------------ cards
function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function faceGeometry() {
  const g = new THREE.ShapeGeometry(roundedRect(CARD.w, CARD.h, CARD.r), 6);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / CARD.w + 0.5, p.getY(i) / CARD.h + 0.5);
  return g;
}

// ------------------------------------------------------------------ audio (synthesized, no assets)
class Sfx {
  constructor() { this.ctx = null; }
  get ac() { return (this.ctx ??= new (window.AudioContext || window.webkitAudioContext)()); }
  whoosh(dur = 0.35, gain = 0.25) {
    const ac = this.ac, n = ac.createBufferSource(), buf = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, ac.currentTime); f.frequency.exponentialRampToValueAtTime(3200, ac.currentTime + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(0, ac.currentTime);
    g.gain.linearRampToValueAtTime(gain, ac.currentTime + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    n.connect(f).connect(g).connect(ac.destination); n.start();
  }
  chime(freqs, gain = 0.12, dur = 1.2) {
    const ac = this.ac;
    freqs.forEach((fq, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t0 = ac.currentTime + i * 0.06;
      o.type = "triangle"; o.frequency.value = fq;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur);
    });
  }
}
const CHIMES = {
  common: [523.25, 659.25], rare: [587.33, 739.99, 880], epic: [659.25, 830.61, 987.77, 1318.5],
  legendary: [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98],
};

// ------------------------------------------------------------------ the sequence
export class PackOpening {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {() => THREE.PerspectiveCamera} o.getCamera
   * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} o.controls
   * @param {THREE.Vector3} o.anchor  world point the pack floats at
   * @param {THREE.Material[]} o.hallMaterials  baked unlit materials (dimmed / flashed via .color)
   * @param {object} o.bloom  UnrealBloomPass
   * @param {HTMLElement} o.ui  container with #open-pack #skip-pack #again-pack #back-pack
   * @param {HTMLElement} o.flash  full-screen flash overlay
   * @param {HTMLElement} o.vignette  full-screen vignette overlay
   * @param {HTMLCanvasElement} o.canvas
   */
  constructor(o) {
    Object.assign(this, o);
    this.cfg = VIDEOS[new URLSearchParams(location.search).get("pack") === "fx" ? "fx" : "physics"];
    this.state = "idle";
    // sequence clock and one-shot flags: read every frame, so they exist before the first playFromStart (a sealed pack
    // is held on screen before any video has played, and NaN in the fade uniform would draw it fully transparent)
    this.vtClock = 0; this.fired = {}; this.primed = 0;
    // Story beats for anything that narrates the sequence (the NPC host): open, tear, burst, skip, reveal, flip,
    // done, inspect, again, leave, idle. detail carries the card data where there is one.
    this.events = new EventTarget();
    this.tweens = [];
    this.sfx = new Sfx();
    this.hallBase = this.hallMaterials.map((m) => m.color.clone());
    this.bloomBase = this.bloom.strength;
    this.hall = 1; this.hallFlash = 0;
    // Forge fire level, 0-1, applied by main.js to the fire/coal/lava emissives and the hearth light. The fire is HDR
    // (~6x white) and sits right behind the pack, the cards and the inspected avatar's glass body; at full strength
    // it blazes through anything translucent and blows out chrome. Eases toward fireTarget().
    this.fireDim = 1; this.shake = 0; this.bloomKick = 0;

    // video
    const v = (this.video = document.createElement("video"));
    Object.assign(v, { src: this.cfg.url, playsInline: true, preload: "auto", muted: false, crossOrigin: "anonymous" });
    v.setAttribute("playsinline", "");
    this.vtex = new THREE.VideoTexture(v);
    // Hide the plane until a real frame is on screen; seeks (Skip, Open Another) re-arm the gate.
    this.frameReady = false;
    const arm = () => {
      this.frameReady = false;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { this.frameReady = true; });
      else v.addEventListener("playing", () => { this.frameReady = true; }, { once: true });
    };
    v.addEventListener("seeking", arm);
    v.addEventListener("play", arm);
    // A paused video (the sealed pack held at frame 0 while the chain settles) may never get a frame callback after a
    // seek; its decoded data is there once it has seeked, so that is enough.
    v.addEventListener("seeked", () => {
      if (v.requestVideoFrameCallback && !v.paused) return;
      this.frameReady = v.readyState >= 2;
      if (this.frameReady) this.vtex.needsUpdate = true; // three only re-uploads on a frame callback, which a paused seek may never get
    });
    v.addEventListener("ended", () => { if (this.state === "video") this.reveal(); });
    this.vtex.colorSpace = THREE.NoColorSpace; // keyed in sRGB, linearised in the shader
    this.vtex.minFilter = THREE.LinearFilter;

    // rig: faces the close-up camera; everything pack-related lives in its local space (+z = toward camera)
    this.rig = new THREE.Group();
    this.rig.position.copy(this.anchor);
    this.rig.visible = false;
    this.scene.add(this.rig);
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), keyMaterial(this.vtex));
    this.plane.renderOrder = 5;
    this.plane.add(new THREE.Mesh(this.plane.geometry, keyDepthMaterial(this.plane.material)));
    this.rig.add(this.plane);

    const T = (this.T = textures());
    // aura + rays sit behind the pack: draw them before the keyed plane so the foil covers them, not hazed by them
    this.aura = sprite(T.glow, 0x8fc8ff, 2.6); this.aura.position.z = -0.05; this.aura.renderOrder = 3; this.rig.add(this.aura);
    this.rays = sprite(T.rays, 0xa9d6ff, 4.5); this.rays.position.z = -0.1; this.rays.renderOrder = 3; this.rig.add(this.rays);
    this.ring = sprite(T.ring, 0xbfe0ff, 0.5); this.ring.position.z = 0.1; this.rig.add(this.ring);
    this.motes = new Particles(700, T.dot, { drag: 0.6 });
    this.sparks = new Particles(500, T.dot, { gravity: 3.2, drag: 0.4 });
    this.burst = new Particles(900, T.dot, { drag: 1.6, gravity: 0.35 });
    this.trails = new Particles(900, T.dot, { drag: 0 });
    this.systems = [this.motes, this.sparks, this.burst, this.trails];
    for (const p of this.systems) this.rig.add(p.points);

    this.rings = Array.from({ length: 4 }, () => { const r = sprite(T.ring, 0xffffff, 0.4); r.visible = false; this.rig.add(r); return r; });

    // Key + flash light for the cards. They live in the scene permanently (intensity 0 when idle): toggling a
    // light's presence changes the light count, which recompiles every lit material mid-animation.
    this.keyLight = new THREE.PointLight(0xfff0dc, 0, 8, 1.6);
    this.flashLight = new THREE.PointLight(0x9fd4ff, 0, 10, 1.4);
    this.scene.add(this.keyLight, this.flashLight);

    const loadTex = (url) => {
      const t = new THREE.TextureLoader().load(url, () => this.renderer?.initTexture(t));
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return t;
    };
    this.cardBack = loadTex("./assets/pack/card_back.jpg");
    this.backMat = new THREE.MeshStandardMaterial({ map: this.cardBack, roughness: 0.5, metalness: 0.1, emissive: 0xffffff, emissiveMap: this.cardBack, emissiveIntensity: 0.35 });
    // placeholder so face materials are born with map/emissiveMap: swapping in the real texture then costs no recompile
    this.blank = new THREE.DataTexture(new Uint8Array([20, 17, 14, 255]), 1, 1);
    this.blank.colorSpace = THREE.SRGBColorSpace; this.blank.needsUpdate = true;
    // Pooled per-slot materials. Disposing a material frees its shader program when it is the last user, so the next
    // pack would recompile mid-reveal; these live for the page and only their textures change.
    this.faceMats = Array.from({ length: PACK_SIZE }, () => new THREE.MeshStandardMaterial({
      map: this.blank, emissiveMap: this.blank, roughness: 0.55, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.3 }));
    this.sheenMats = Array.from({ length: PACK_SIZE }, () => sheenMaterial(0xffffff));
    this.glowMats = Array.from({ length: PACK_SIZE }, () => new THREE.SpriteMaterial({
      map: T.glow, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.faceGeo = faceGeometry();
    this.edgeGeo = new THREE.ExtrudeGeometry(roundedRect(CARD.w, CARD.h, CARD.r), { depth: CARD.t, bevelEnabled: false, curveSegments: 6 });
    this.edgeGeo.translate(0, 0, -CARD.t / 2);
    this.edgeMats = [new THREE.MeshBasicMaterial({ visible: false }), new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 0.6 })];
    this.cards = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(9, 9);
    this.hovered = null; this.inspected = null;

    this.panel = new CardPanel(this.panelEl, this.collection, () => this.inspect(null));
    this.bindUI();
    this.fontsReady = document.fonts?.load?.('900 30px "Cinzel"').catch(() => {}) ?? Promise.resolve();
  }

  // -------------------------------------------------------------- UI
  bindUI() {
    const $ = (id) => this.ui.querySelector(id);
    this.btn = { open: $("#open-pack"), preview: $("#preview-pack"), skip: $("#skip-pack"), again: $("#again-pack"), back: $("#back-pack") };
    this.btn.open.onclick = () => this.onOpenClick();
    if (this.btn.preview) this.btn.preview.onclick = () => this.startPreview();
    this.btn.skip.onclick = () => this.skip();
    this.btn.again.onclick = () => this.again();
    this.btn.back.onclick = () => this.exit();
    this.mode = "preview"; // "live" once a real pack is bought: Open Another then buys another
    this.showButtons(...this.idleButtons());
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    this.canvas.addEventListener("click", () => this.onClick());
    addEventListener("keydown", (e) => { if (e.key === "Escape" && this.inspected) this.inspect(null); });
  }
  showButtons(...names) {
    for (const [k, b] of Object.entries(this.btn)) if (b) b.hidden = !names.includes(k);
  }
  /** Buttons of the resting hall: Open Pack, plus the free preview beside it when a live shop is configured. */
  idleButtons() { return this.shop?.live ? ["open", "preview"] : ["open"]; }
  /** The opening owns the camera and the forge dimming; waiting on the wallet (before the pack appears) does not. */
  get active() { return this.state !== "idle" && this.state !== "wallet"; }
  get busy() { return this.state !== "idle"; }
  emit(type, detail = {}) { this.events.dispatchEvent(new CustomEvent(type, { detail })); }

  // -------------------------------------------------------------- tweens
  tween(dur, update, easeFn = ease.inOut, delay = 0) {
    return new Promise((done) => this.tweens.push({ t: -delay, dur, update, easeFn, done }));
  }
  wait(s) { return this.tween(s, () => {}); }

  // -------------------------------------------------------------- camera
  /** Compile every pack material and upload its textures up front, so the sequence never hitches on first use. */
  warmup(renderer, composer) {
    this.renderer = renderer;
    // Spin the video decoder up now (a silent play + pause): its first frames otherwise cost ~40 ms right as the pack
    // appears. Only touches the video if the player hasn't started a pack in the meantime.
    const v = this.video;
    v.muted = true;
    v.play().then(() => { if (this.state === "idle") { v.pause(); v.currentTime = 0; } }).catch(() => {})
      .finally(() => { v.muted = false; });
    this.showcase = new AvatarShowcase({ parent: this.rig, scene: this.scene, renderer, getCamera: this.getCamera, glowMap: this.T.glow });
    const cam = this.getCamera();
    const tmp = rollPackCards(this, [this.collection.cards[0]]);
    tmp.forEach((c) => { c.outer.visible = true; });
    this.rig.visible = true;
    for (const p of this.systems) p.points.visible = true;
    for (const r of this.rings) r.visible = true;
    // Programs are keyed on the output target too: compile for the composer's linear buffer (what every frame really
    // renders into), then push one real frame through the whole pipeline while the loading screen still covers it.
    renderer.setRenderTarget(composer.readBuffer);
    renderer.compile(this.scene, cam);
    renderer.setRenderTarget(null);
    this.plane.material.uniforms.opacity.value = 1; this.plane.material.uniforms.ready.value = 1;
    composer.render();
    this.plane.material.uniforms.opacity.value = 0; this.plane.material.uniforms.ready.value = 0;
    for (const t of [this.cardBack, this.blank, this.T.dot, this.T.glow, this.T.ring, this.T.rays]) renderer.initTexture(t);
    for (const c of tmp) this.rig.remove(c.outer);
    for (const r of this.rings) r.visible = false;
    for (const p of this.systems) p.points.visible = false;
    this.rig.visible = false;
  }

  closeUpPose(boxW, boxH, fovDeg, zOffset = 0, margin = 1.4) {
    const cam = this.getCamera(), vfov = THREE.MathUtils.degToRad(fovDeg), tan = Math.tan(vfov / 2);
    const dist = Math.max(boxH / 2 / tan, boxW / 2 / (tan * cam.aspect)) * margin + zOffset;
    const pos = this.anchor.clone().add(new THREE.Vector3(0, 0.12, dist).applyQuaternion(this.rigQuat));
    const look = this.anchor.clone().add(new THREE.Vector3(0, 0.05, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0)));
    return { pos, q, fov: fovDeg };
  }
  flyTo(pose, dur) {
    const cam = this.getCamera(), p0 = cam.position.clone(), q0 = cam.quaternion.clone(), f0 = cam.fov;
    return this.tween(dur, (k) => {
      cam.position.lerpVectors(p0, pose.pos, k);
      cam.quaternion.slerpQuaternions(q0, pose.q, k);
      cam.fov = f0 + (pose.fov - f0) * k;
      cam.updateProjectionMatrix();
    });
  }

  // -------------------------------------------------------------- flow
  onOpenClick() {
    if (this.state === "sealed") return this.liveOpen();     // a bought pack is waiting: retry breaking its seal
    return this.shop?.live ? this.startLive(false) : this.startPreview();
  }

  /** Free client-side pull (no wallet, nothing minted): what the hall did before the shop existed. */
  startPreview() {
    if (this.busy) return;
    this.status("");
    this.mode = "preview";
    this.stage(false);
    this.deal(this.newPack());
  }

  /** Camera, rig and lights for an opening: everything up to the cards. */
  stage(again) {
    this.state = "intro";
    this.showButtons();
    this.emit("open", { again });
    const cam = this.getCamera();
    this.saved = { pos: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, target: this.controls.target.clone() };
    this.controls.enabled = false;
    // rig faces the hall camera's forward axis, so the pack squares up to where the player was looking
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0; fwd.normalize();
    this.rigQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd.clone().negate());
    this.rig.quaternion.copy(this.rigQuat);
    this.rig.updateMatrixWorld();
    this.keyLight.position.copy(this.rig.localToWorld(new THREE.Vector3(0.4, 0.9, 2.2)));
    this.flashLight.position.copy(this.rig.localToWorld(new THREE.Vector3(0, 0.1, 0.4)));
    this.resetPack();
    this.rig.visible = true;
    this.flyTo(this.closeUpPose(PLANE_W * 0.72, PLANE_H, 38), 1.9);
    this.tween(1.2, (k) => { this.hall = 1 - 0.5 * k; this.vignette.style.opacity = String(0.85 * k); });
    this.materialize(0.25);
    this.sfx.whoosh(1.0, 0.18);
  }

  /** Put the pulled cards on the table and run the video: the pack tears, the cards rise, the fan reveals them. */
  deal(picks) {
    this.cards = rollPackCards(this, picks);
    this.playFromStart();
  }

  // Rewind and play. The sequence never waits on play()'s promise: a rejected or interrupted play (autoplay policy,
  // a seek mid-start) must not strand the state machine. Sound is tried first; muted is the fallback.
  playFromStart() {
    this.fired = {};
    this.primed = 0;
    this.vtClock = 0;
    this.plane.position.y = 0;
    this.video.currentTime = 0;
    this.video.play().catch(() => { this.video.muted = true; return this.video.play(); }).catch(() => {});
    this.state = "video";
    this.showButtons("skip");
  }

  skip() {
    if (this.state !== "video") return;
    this.emit("skip");
    if (this.video.currentTime < this.cfg.burst) this.fire("burst", () => this.climax());
    this.video.currentTime = this.cfg.swap; // show the hand-off frame underneath while the 3D stack takes over
    this.vtClock = this.cfg.swap;
    this.reveal();
  }

  async again() {
    if (this.state !== "done") return;
    this.inspect(null);
    this.showButtons();
    if (this.mode === "live") return this.startLive(true);
    this.emit("open", { again: true });
    await this.restage();
    this.deal(this.newPack());
  }

  /** Clear the table for another pack: cards shrink away, a fresh pack irises in at the close-up. */
  async restage() {
    await this.tween(0.45, (k) => { for (const c of this.cards) c.outer.scale.setScalar(1 - k); }, ease.inOut);
    this.clearCards();
    this.resetPack();
    this.flyTo(this.closeUpPose(PLANE_W * 0.72, PLANE_H, 38), 1.2);
    this.materialize(0);
  }

  async exit({ quiet = false } = {}) {
    if (this.state !== "done" && this.state !== "sealed") return;
    this.inspect(null);
    this.state = "outro";
    this.showButtons();
    if (!quiet) this.emit("leave");
    this.tween(0.5, (k) => { for (const c of this.cards) c.outer.scale.setScalar(1 - k); });
    this.tween(1.2, (k) => { this.hall = 0.5 + 0.5 * k; this.vignette.style.opacity = String(0.85 * (1 - k)); });
    // land exactly where the orbit controls will hold the camera (looking at their target), so there is no snap
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(this.saved.pos, this.saved.target, new THREE.Vector3(0, 1, 0)));
    await this.flyTo({ pos: this.saved.pos, q, fov: this.saved.fov }, 1.7);
    this.clearCards();
    this.rig.visible = false;
    this.keyLight.intensity = 0; this.flashLight.intensity = 0;
    this.controls.target.copy(this.saved.target);
    this.controls.enabled = true;
    this.state = "idle";
    this.showButtons(...this.idleButtons());
    this.emit("idle");
  }

  /** Pack appears: opaque at once, irised in from its centre with a burst of motes to sell it. */
  materialize(delay) {
    const u = this.plane.material.uniforms;
    u.opacity.value = 1; u.reveal.value = 0;
    this.tween(0.65, (k) => { u.reveal.value = 1.05 * k; }, ease.out, delay).then(() => { u.reveal.value = 1.05; });
    this.wait(delay).then(() => {
      for (let i = 0; i < 60; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(0.4, 1.4), h = rand(0.8, 1.8);
        this.motes.emit(0, 0.05, 0.02, Math.cos(a) * sp, Math.sin(a) * sp, rand(-0.2, 0.3), 0.56 * h, 0.85 * h, h, rand(0.01, 0.025), rand(0.5, 1.1));
      }
    });
  }

  resetPack() {
    this.plane.visible = true;
    this.plane.material.uniforms.opacity.value = 0;
    this.plane.material.uniforms.reveal.value = 0;
    for (const s of [this.aura, this.rays, this.ring]) s.material.opacity = 0;
    this.rays.position.set(0, 0, -0.1);
    this.rays.material.color.setHex(0xa9d6ff);
    this.flashLight.color.setHex(0x9fd4ff);
    for (const p of this.systems) p.clear();
    this.keyLight.intensity = 0; this.flashLight.intensity = 0;
    for (const r of this.rings) r.visible = false;
  }

  newPack() { return this.prepare(rollPack(this.collection)); }

  /** Warm everything a pull needs (paintings, avatar bytes) before the cards appear. */
  prepare(picks) {
    preloadArt(picks);
    this.showcase.forget();
    this.showcase.prefetch(picks);
    return picks;
  }

  fire(name, fn) { if (!this.fired[name]) { this.fired[name] = true; fn(); } }

  // -------------------------------------------------------------- live: buy, wait for the chain, break the seal
  // `shop` (web/shopflow.js) does the wallet and chain work; this drives the story around it:
  //   wallet   (hall, camera untouched)  the purchase is being signed and confirmed
  //   chain    (pack on screen, idling)  sealed on chain; waiting for the reveal block, then the second signature
  //   sealed   (pack on screen)          the second signature was refused or failed; the pack is safe, retry
  // A pack that is bought but not yet opened survives closing the page: shop.resume() finds it on the next visit.
  status(text, tone = "info") { this.emit("status", { text, tone }); }

  async startLive(again) {
    if (this.busy && !(again && this.state === "done")) return;
    const back = again ? "done" : "idle";
    this.status("");
    this.mode = "live";
    if (!this.shop.pending) {
      this.state = "wallet";
      this.showButtons();
      this.emit("wallet", { stage: "buy" });
      try { await this.shop.buy({ onStage: (text) => this.status(text) }); }
      catch (e) { return this.liveFailed(e, back); }
    }
    // the pack is bought (or was already waiting): stage the scene and hold it sealed until the chain is ready
    if (again) { this.state = "intro"; this.emit("open", { again: true }); await this.restage(); } else this.stage(false);
    this.video.pause();
    this.video.currentTime = 0;
    return this.liveOpen();
  }

  async liveOpen() {
    this.state = "chain";
    this.showButtons();
    this.emit("sealing");
    let cards;
    try {
      await this.shop.waitOpenable({ onStage: (text) => this.status(text) });
      this.emit("signing");
      cards = await this.shop.open({ onStage: (text) => this.status(text) });
    } catch (e) {
      if (DEAD_PACK.has(e?.code)) {
        // no retry can work: say why, forget the pack (an expired one is refundable from the wallet menu) and leave the table
        this.shop.abandon?.();
        this.state = "sealed";
        this.liveFailed(e, "sealed");
        return this.exit({ quiet: true });
      }
      this.state = "sealed";
      this.showButtons("open", "back");
      return this.liveFailed(e, "sealed");
    }
    this.status("");
    this.deal(this.prepare(cards));
  }

  liveFailed(e, back) {
    const message = e?.message || String(e);
    if (back !== "sealed") {
      this.state = back;
      this.showButtons(...(back === "done" ? ["again", "back"] : this.idleButtons()));
    }
    this.status(message, "error");
    this.emit("chainError", { message, code: e?.code });
  }

  // -------------------------------------------------------------- climax
  climax() {
    this.emit("burst");
    const lite = this.cfg.bakedFx;
    if (!lite) {
      this.flash.style.transition = "none"; this.flash.style.background = "";
      this.flash.style.opacity = "0.6";
      requestAnimationFrame(() => { this.flash.style.transition = "opacity .7s ease-out"; this.flash.style.opacity = "0"; });
    }
    this.shake = 0.45; this.bloomKick = lite ? 0.4 : 0.8; this.hallFlash = 0.4;
    this.flashLight.intensity = 60;
    const cols = [[1, 1, 1], [0.75, 0.9, 1], [0.56, 0.82, 1], [1, 0.89, 0.63]];
    for (let i = 0; i < (lite ? 220 : 450); i++) {
      const x = rand(-1, 1), y = rand(-0.8, 1), z = rand(-0.3, 1);
      const l = Math.hypot(x, y, z) || 1, sp = rand(1.5, 6.5) / l, h = rand(0.6, 1.6), c = cols[i % 4];
      this.burst.emit(0, 0.1, 0.05, x * sp, y * sp, z * sp, c[0] * h, c[1] * h, c[2] * h, rand(0.012, 0.045), rand(0.5, 1.5));
    }
    this.sfx.whoosh(0.6, 0.35);
    this.sfx.chime([392, 587.33, 783.99, 1174.66], 0.08, 2.2);
    this.tween(0.9, (k) => { this.ring.scale.setScalar(0.3 + 5.5 * ease.out(k)); this.ring.material.opacity = 1 - k; }, (k) => k);
    this.tween(1.6, (k) => {  // short god-ray bloom behind the pack, gone before the card rises
      this.rays.material.opacity = (k < 0.1 ? k / 0.1 : Math.pow(1 - (k - 0.1) / 0.9, 2)) * 0.45;
      this.rays.scale.setScalar(2.2 + 1.4 * ease.out(k));
    }, (k) => k);
  }

  // -------------------------------------------------------------- video → cards hand-off
  async reveal() {
    this.state = "reveal";
    this.primed = -1;
    this.showButtons();
    this.emit("reveal");
    const U = (CARD_IN_VIDEO.u - CROP[0]) / (CROP[1] - CROP[0]);
    const at = new THREE.Vector3((U - 0.5) * PLANE_W, (0.5 - CARD_IN_VIDEO.v) * PLANE_H, 0.01);
    this.cards.forEach((c, i) => {
      c.outer.visible = true;
      c.outer.position.copy(at).add(new THREE.Vector3(0, 0, -i * (CARD.t + 0.002)));
      c.outer.rotation.set(0, CARD_IN_VIDEO.rotY, CARD_IN_VIDEO.rotZ);
      c.outer.scale.setScalar(1);
      c.inner.rotation.set(0, Math.PI, 0); // back to camera, even if a skip landed mid-priming
    });
    this.keyLight.intensity = 6;
    // the moment the video card becomes a real one: a glint of sparkle and a small pulse, on the
    // very frame the 3D card (new art) replaces the video's card (old art), so the swap reads as a transformation
    const top = this.cards[0].outer.position;
    for (let i = 0; i < 70; i++) {
      const h = rand(1.2, 2.6);
      this.burst.emit(top.x + rand(-CARD.w / 2, CARD.w / 2), top.y + rand(-CARD.h / 2, CARD.h / 2), top.z + 0.03,
        rand(-0.2, 0.2), rand(-0.1, 0.35), rand(0.05, 0.3), 0.8 * h, 0.9 * h, 1.0 * h, rand(0.008, 0.02), rand(0.4, 0.9));
    }
    this.sfx.chime([1318.5, 1760], 0.05, 0.9);
    this.tween(0.35, (k) => { const sc = 1 + 0.05 * Math.sin(k * Math.PI); for (const c of this.cards) c.outer.scale.setScalar(sc); }, (k) => k);
    await this.tween(0.6, (k) => { this.plane.material.uniforms.opacity.value = 1 - k; }, ease.inOut);
    this.plane.visible = false;
    this.video.pause();

    // square the stack up, then fan out
    const from = this.cards.map((c, i) => ({ p: c.outer.position.clone(), r: c.outer.rotation.clone(), to: new THREE.Vector3(0, 0.02, 0.15 - i * 0.008) }));
    await this.tween(0.8, (k) => {
      this.cards.forEach((c, i) => {
        c.outer.position.lerpVectors(from[i].p, from[i].to, k);
        c.outer.rotation.set(0, from[i].r.y * (1 - k), from[i].r.z * (1 - k));
      });
    });
    const layout = this.layout();
    this.flyTo(this.closeUpPose(layout.w, layout.h, 40, 0.1, 1.18), 1.0);
    this.sfx.whoosh(0.5, 0.2);
    const start = this.cards.map((c) => c.outer.position.clone());
    await this.tween(0.95, (k) => {
      this.cards.forEach((c, i) => {
        const kk = clamp01(k * 1.4 - i * 0.08);
        const e = ease.back(kk);
        c.outer.position.lerpVectors(start[i], layout.pos[i], e);
        c.outer.rotation.z = layout.rotZ[i] * e;
      });
    }, (k) => k);
    this.cards.forEach((c, i) => c.home = { pos: layout.pos[i].clone(), rotZ: layout.rotZ[i] });

    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i], last = i === this.cards.length - 1, big = RANK[c.data.rarity] >= 3;
      if (last && big) { await this.wait(0.45); this.shake = 0.15; }
      await this.flip(c);
      await this.wait(last ? 0 : 0.28);
    }
    this.state = "done";
    this.shop?.spent?.();
    this.showButtons("again", "back");
    this.emit("done", { cards: this.cards.map((c) => c.data), best: this.cards[this.cards.length - 1].data });
    this.video.currentTime = 0; // decode frame 0 now, so "Open Another" starts without a seek stall
  }

  layout() {
    const n = this.cards.length, cam = this.getCamera(), portrait = cam.aspect < 1.0;
    const pos = [], rotZ = [];
    if (!portrait) {
      const gap = CARD.w + 0.1;
      for (let i = 0; i < n; i++) {
        const o = i - (n - 1) / 2;
        pos.push(new THREE.Vector3(o * gap, -0.03 * o * o, 0.2 - 0.04 * Math.abs(o)));
        rotZ.push(-o * 0.05);
      }
      return { pos, rotZ, w: n * gap + 0.1, h: CARD.h + 0.35 };
    }
    const rows = [Math.ceil(n / 2), Math.floor(n / 2)], gap = CARD.w + 0.08;
    let k = 0;
    rows.forEach((m, r) => {
      for (let j = 0; j < m; j++, k++) {
        pos.push(new THREE.Vector3((j - (m - 1) / 2) * gap, (0.5 - r) * (CARD.h + 0.1), 0.2));
        rotZ.push(0);
      }
    });
    return { pos, rotZ, w: rows[0] * gap + 0.1, h: 2 * CARD.h + 0.35 };
  }

  async flip(c) {
    const R = RARITY[c.data.rarity];
    let fired = false;
    this.sfx.whoosh(0.3, 0.12);
    await this.tween(0.55, (k) => {
      c.inner.rotation.y = Math.PI * (1 - ease.inOut(k));
      c.outer.position.z = c.home.pos.z + Math.sin(k * Math.PI) * 0.35;
      c.outer.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.12);
      if (!fired && k > 0.5) { fired = true; this.rarityFx(c, R); }
    }, (k) => k);
    c.revealed = true;
    this.emit("flip", { card: c.data, last: c === this.cards[this.cards.length - 1] });
  }

  rarityFx(c, R) {
    const p = c.outer.position.clone(), col = new THREE.Color(R.glow);
    const n = Math.round(120 * R.fx);
    for (let i = 0; i < n; i++) {
      const x = rand(-1, 1), y = rand(-1, 1), z = rand(-0.5, 0.15), l = Math.hypot(x, y, z) || 1;
      const sp = (rand(0.6, 2.4) * R.fx) / l, h = rand(1.2, 3);
      // from just behind the card: what flies outward shows around its silhouette, nothing sprays over the art
      this.burst.emit(p.x, p.y, p.z - 0.06, x * sp, y * sp, z * sp, col.r * h, col.g * h, col.b * h, rand(0.015, 0.045), rand(0.5, 1.4));
    }
    c.glow.material.opacity = 0.9;
    const ring = this.rings.find((r) => !r.visible) ?? this.rings[0];
    ring.visible = true;
    ring.material.color.setHex(R.glow);
    ring.position.copy(p).setZ(p.z - 0.25); // halo behind the card, not a wash across the whole fan
    this.tween(0.7, (k) => { ring.scale.setScalar(0.4 + 2.2 * R.fx * ease.out(k)); ring.material.opacity = 1 - k; }, (k) => k)
      .then(() => { ring.visible = false; });
    this.sfx.chime(CHIMES[c.data.rarity], 0.1);
    if (RANK[c.data.rarity] >= 3) {
      this.bloomKick = 0.9; this.hallFlash = 0.45; this.shake = 0.3;
      this.flashLight.color.setHex(R.glow); this.flashLight.intensity = 45;
      this.rays.material.color.setHex(R.glow);
      this.rays.position.copy(p).setZ(p.z - 0.45);
      this.tween(1.8, (k) => { this.rays.material.opacity = Math.pow(1 - k, 2) * 0.5; this.rays.scale.setScalar(1.8 + 1.4 * ease.out(k)); }, (k) => k);
      this.flash.style.transition = "none"; this.flash.style.background = "radial-gradient(circle, rgba(255,214,120,.8), rgba(255,160,40,.25))";
      this.flash.style.opacity = "0.7";
      requestAnimationFrame(() => { this.flash.style.transition = "opacity .9s ease-out"; this.flash.style.opacity = "0"; });
    }
  }

  // -------------------------------------------------------------- inspect
  onClick() {
    if (this.state !== "done") return;
    if (this.inspected) return this.inspect(null);
    if (this.hovered?.revealed) this.inspect(this.hovered);
  }
  inspect(c) {
    const prev = this.inspected;
    if (c !== prev) this.emit("inspect", { card: c?.data ?? null });
    this.inspected = c;
    if (prev) {
      const p0 = prev.outer.position.clone(), s0 = prev.outer.scale.x;
      prev.returning = true;
      this.tween(0.4, (k) => { prev.outer.position.lerpVectors(p0, prev.home.pos, k); prev.outer.scale.setScalar(s0 + (1 - s0) * k); prev.outer.rotation.z = prev.home.rotZ * k; })
        .then(() => { prev.returning = false; });
    }
    // the rest of the fan steps aside while one card (and its avatar) has the stage
    if (!!c !== !!prev) { const a0 = this.away ?? 0, a1 = c ? 1 : 0; this.tween(c ? 0.35 : 0.45, (k) => { this.away = a0 + (a1 - a0) * k; }); }
    if (c) {
      const L = this.inspectLayout(), p0 = c.outer.position.clone(), s0 = c.outer.scale.x;
      this.tween(0.45, (k) => { c.outer.position.lerpVectors(p0, L.card, k); c.outer.scale.setScalar(s0 + (L.scale - s0) * k); c.outer.rotation.z = c.home.rotZ * (1 - k); });
      this.sfx.whoosh(0.25, 0.1);
      this.panel.show(c.data);
      this.showcase.show({ ...c.data, elementColor: ELEMENT[c.data.element] }, L.avatar, L.avatarH);
    } else {
      this.panel.hide();
      this.showcase?.hide();
    }
  }

  // Inspect staging in rig space: the card and its avatar share the view left of the panel (landscape), or the
  // top half above the panel's sheet (portrait).
  inspectLayout() {
    const cam = this.getCamera();
    if (cam.aspect >= 1.0) return { card: new THREE.Vector3(-0.95, 0.2, 0.95), scale: 1.25, avatar: new THREE.Vector3(0.08, -0.62, 0.6), avatarH: 1.3 };
    // Portrait: the panel is a bottom sheet over the lower ~57% of the screen, so fit card (left) and avatar (right)
    // into the strip above it, measured from the camera at each one's depth.
    const eye = this.rig.worldToLocal(cam.position.clone()), tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const view = (z) => { const h = (eye.z - z) * tan; return { w: h * cam.aspect, h, y: (f) => eye.y + h * f }; };
    const A = view(0.95), B = view(0.55), y0 = A.y(0.2), y1 = A.y(0.88);
    const scale = Math.min((A.w * 0.8) / CARD.w, (y1 - y0) / CARD.h);
    const feet = B.y(0.24);
    return {
      card: new THREE.Vector3(-A.w * 0.5, (y0 + y1) / 2, 0.95), scale,
      avatar: new THREE.Vector3(B.w * 0.5, feet, 0.55), avatarH: 0.8 * (B.y(0.84) - feet), // bulky bodies reach toward the lens
    };
  }

  clearCards() {
    for (const c of this.cards) {
      this.rig.remove(c.outer);
      if (c.faceMat.map !== this.blank) c.faceMat.map.dispose();
      c.faceMat.map = c.faceMat.emissiveMap = this.blank;
    }
    this.cards = [];
    this.hits = null;
  }

  // -------------------------------------------------------------- per frame
  update(dt, t) {
    const cam = this.getCamera();
    this.showcase?.update(dt, t);
    if (this.shakeOffset) { cam.position.sub(this.shakeOffset); this.shakeOffset = null; } // undo last frame's shake first
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += dt;
      if (tw.t < 0) continue;
      const k = clamp01(tw.t / tw.dur);
      tw.update(tw.easeFn(k));
      if (k >= 1) { this.tweens.splice(i, 1); tw.done(); }
    }
    if (!this.active) return;

    // inspect: fire under the bloom threshold (8% of ~6x) so nothing glows through the translucent holograms, and
    // bloom eased to 60% so the avatars' own glow reads as light, not a white-clipped core
    const fireTarget = this.state === "idle" || this.state === "outro" ? 1 : this.inspected ? 0.08 : 0.55;
    this.fireDim += (fireTarget - this.fireDim) * Math.min(1, dt * 3);
    this.bloomScale = (this.bloomScale ?? 1) + ((this.inspected ? 0.6 : 1) - (this.bloomScale ?? 1)) * Math.min(1, dt * 3);
    // hall dim / flash via the baked materials' colour multiplier
    this.hallFlash = Math.max(0, this.hallFlash - dt * 1.6);
    const m = this.hall + this.hallFlash * 0.9;
    this.hallMaterials.forEach((mat, i) => mat.color.copy(this.hallBase[i]).multiplyScalar(m));
    this.bloomKick = Math.max(0, this.bloomKick - dt * 1.4);
    this.bloom.strength = this.bloomBase * this.bloomScale + this.bloomKick;
    this.flashLight.intensity *= Math.exp(-dt * 3.5);

    // Sequence time. Follows the video while it plays; if the video stalls (slow network, decoder hiccup, a seek that
    // never lands) an internal clock carries the effects and the reveal on regardless. debugVT: frame-stepped tests.
    if (this.state === "video") this.vtClock = Math.max(this.vtClock + dt, this.video.currentTime);
    const vt = this.debugVT ?? Math.max(this.video.currentTime, this.vtClock - 0.6), cfg = this.cfg;
    const ready = this.plane.material.uniforms.ready;
    ready.value = this.frameReady ? 1 : 0; // no ramp: a half-ready pack is a see-through pack
    this.plane.material.uniforms.floorFade.value = 0.03 + 0.22 * smooth(cfg.burst + 0.1, cfg.burst + 1.4, vt);
    const vpScale = viewportScale(cam, this.renderer);

    if (this.state === "chain" || this.state === "sealed") {
      // the pack idles while the chain settles: a slow pulse, a few motes spiralling in, a gentle bob
      const k = 0.5 + 0.5 * Math.sin(t * 2.2);
      this.aura.material.opacity = 0.16 + 0.12 * k;
      this.aura.scale.setScalar(2.2 + 0.12 * k);
      this.rays.material.rotation += dt * 0.1;
      this.plane.position.y = Math.sin(t * 1.5) * 0.012;
      this.moteAcc = (this.moteAcc ?? 0) + 18 * dt;
      for (; this.moteAcc >= 1; this.moteAcc--) {
        const a = rand(0, Math.PI * 2), r = rand(1.2, 1.8), y = rand(-0.6, 0.7), px = Math.cos(a) * r, pz = Math.sin(a) * r * 0.5;
        const pull = -rand(0.7, 1.1), h = rand(0.8, 1.6);
        this.motes.emit(px, y, pz, px * pull - Math.sin(a) * 0.5, y * pull, pz * pull + Math.cos(a) * 0.5, 0.56 * h, 0.85 * h, h, rand(0.012, 0.028), r / 1.1);
      }
    }
    if (this.state === "video" || this.state === "intro") {
      const charge = smooth(0.5, cfg.burst, vt);
      this.aura.material.opacity = vt < cfg.burst ? 0.12 + 0.55 * charge * (0.85 + 0.15 * Math.sin(t * 9)) : Math.max(0, this.aura.material.opacity - dt * 0.25);
      this.aura.scale.setScalar(2.2 + 0.8 * charge);
      this.rays.material.rotation += dt * 0.15;
      // charge motes spiral in
      if (vt > 0.6 && vt < cfg.burst) {
        const rate = 30 + 170 * charge * charge;
        this.moteAcc = (this.moteAcc ?? 0) + rate * dt;
        for (; this.moteAcc >= 1; this.moteAcc--) {
          const a = rand(0, Math.PI * 2), r = rand(1.3, 2.1), y = rand(-0.7, 0.8), px = Math.cos(a) * r, pz = Math.sin(a) * r * 0.5;
          const pull = -rand(0.9, 1.4), h = rand(0.8, 2);
          this.motes.emit(px, y, pz, px * pull - Math.sin(a) * 0.6, y * pull, pz * pull + Math.cos(a) * 0.6,
            0.56 * h, 0.85 * h, 1.0 * h, rand(0.012, 0.03), r / 1.4);
        }
      }
      // tear sparks travel along the top edge
      if (vt > cfg.tear && vt < cfg.burst) {
        const k = (vt - cfg.tear) / (cfg.burst - cfg.tear);
        this.sparkAcc = (this.sparkAcc ?? 0) + 90 * dt;
        for (; this.sparkAcc >= 1; this.sparkAcc--) {
          const hot = Math.random() < 0.33, h = rand(1.5, 3);
          this.sparks.emit(0.22 - 0.4 * k, PLANE_H * 0.42, 0.05, rand(-0.9, 1.2), rand(0.4, 1.8), rand(0, 0.8),
            h, (hot ? 1 : 0.76) * h, (hot ? 1 : 0.48) * h, rand(0.008, 0.02), rand(0.3, 0.8));
        }
      }
      if (vt >= cfg.tear) this.fire("tear", () => this.emit("tear"));
      if (vt >= cfg.burst) this.fire("burst", () => this.climax());
      // after the burst: drifting dust + two light trails orbiting the rising card
      if (vt > cfg.burst + 0.3 && vt < cfg.swap + 0.3) {
        const cy = (0.5 - CARD_IN_VIDEO.v) * PLANE_H;
        this.dustAcc = (this.dustAcc ?? 0) + 25 * dt;
        for (; this.dustAcc >= 1; this.dustAcc--) {
          const h = rand(0.8, 2);
          this.motes.emit(rand(-1.1, 1.1), rand(-0.7, 0.8), rand(-0.3, 0.4), 0, rand(0.05, 0.2), 0, h, 0.9 * h, 0.69 * h, rand(0.01, 0.025), rand(1.2, 2.4));
        }
        const on = 2.5 * smooth(cfg.burst + 0.8, cfg.burst + 1.6, vt);
        for (const [ph, r, g, b] of TRAILS) {
          for (let s = 0; s < 6; s++) {  // sub-steps along the path this frame covered: a continuous ribbon at any fps
            const a = (t - (s * dt) / 6) * 3.1 + ph;
            this.trails.emit(Math.cos(a) * 0.62, cy + Math.sin(a) * 0.18 + Math.sin(a * 0.5) * 0.1, Math.sin(a) * 0.35, 0, 0, 0,
              r * on, g * on, b * on, 0.035, 0.45);
          }
        }
      }
      if (this.state === "video" && !this.primed && vt > 1.0 && this.cards.every((c) => c.faceReady)) {
        this.primed = 2;
        for (const c of this.cards) { c.outer.visible = true; c.outer.scale.setScalar(1e-4); c.inner.rotation.y = 0; }
      } else if (this.primed > 0 && --this.primed === 0) {
        this.primed = -1;
        for (const c of this.cards) { c.outer.visible = false; c.outer.scale.setScalar(1); c.inner.rotation.y = Math.PI; }
      }
      if (this.state === "video" && vt >= cfg.swap) this.reveal();
      // slow push-in while charging
      if (this.state === "video" && vt < cfg.burst) cam.position.addScaledVector(FWD.set(0, 0, -1).applyQuaternion(cam.quaternion), dt * 0.035);
    }

    // cards: idle bob, hover tilt, rarity glow pulse
    if (this.cards.length && (this.state === "reveal" || this.state === "done")) {
      this.raycaster.setFromCamera(this.pointer, cam);
      this.hits ??= this.cards.map((c) => c.hit);
      const hit = this.raycaster.intersectObjects(this.hits, false)[0];
      this.hovered = hit ? this.cards.find((c) => c.hit === hit.object) : null;
      this.canvas.style.cursor = this.state === "done" && (this.inspected || this.hovered?.revealed) ? "pointer" : "";
      for (const c of this.cards) {
        c.glow.material.opacity = c.revealed ? 0.35 + 0.2 * Math.sin(t * 2.4 + c.i) : c.glow.material.opacity * 0.95;
        if (this.state === "done" && c !== this.inspected && !c.returning) {
          const hov = c === this.hovered && !this.inspected ? 1 : 0;
          c.hover += (hov - c.hover) * Math.min(1, dt * 10);
          c.outer.scale.setScalar(Math.max(1e-4, (1 + 0.08 * c.hover) * (1 - (this.away ?? 0))));
          c.inner.rotation.x = -this.pointer.y * 0.25 * c.hover;
          c.inner.rotation.y = this.pointer.x * 0.35 * c.hover;
          c.outer.position.y = c.home.pos.y + Math.sin(t * 1.3 + c.i) * 0.012;
        }
        // a quick pass every ~7 s (staggered per card), off the art the rest of the time
        if (c.sheen) c.sheen.material.uniforms.phase.value = ((t * 0.8 + c.i * 1.3) % 6.0) - 0.3;
      }
      this.keyLight.intensity = 6 * (0.95 + 0.05 * Math.sin(t * 7));
    }

    // camera shake: a tiny offset added now and removed at the top of the next frame
    this.shake = Math.max(0, this.shake - dt);
    this.shakeOffset = this.shake > 0 ? SHAKE.set(rand(-1, 1), rand(-1, 1), 0).multiplyScalar(0.05 * this.shake).applyQuaternion(cam.quaternion) : null;
    if (this.shakeOffset) cam.position.add(this.shakeOffset);

    for (const p of this.systems) p.update(dt, vpScale, t);
  }
}

function sheenMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { phase: { value: 0 }, color: { value: new THREE.Color(color) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float phase; uniform vec3 color; varying vec2 vUv;
      // a thin foil glint, mostly white with a hint of the rarity colour: it sits on top of the art, so it stays faint
      // (additive + bloom above ~0.8 turned the old 0.9-peak band into a wash of colour across the whole card)
      // one hairline glint (~3% of the card wide) — a wide band read as a light wash over the art
      void main(){ float x = vUv.x*0.7 + vUv.y*0.5 - phase; float a = exp(-x*x*1100.0)*0.14;
        gl_FragColor = vec4(mix(color, vec3(1.0), 0.6), a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

function rollPackCards(self, picks) {
  return picks.map((data, i) => {
    const outer = new THREE.Group(), inner = new THREE.Group();
    outer.add(inner);
    const faceMat = self.faceMats[i];
    const card = { data, faceReady: false };
    self.fontsReady.then(() => drawFace(data, self.collection)).then((tex) => {
      self.renderer?.initTexture(tex); // upload now (during the intro), not on the frame the card first shows
      faceMat.map = tex; faceMat.emissiveMap = tex; card.faceReady = true;
    });
    const front = new THREE.Mesh(self.faceGeo, faceMat);
    front.position.z = CARD.t / 2 + 0.0004;
    const back = new THREE.Mesh(self.faceGeo, self.backMat);
    back.rotation.y = Math.PI;
    back.position.z = -CARD.t / 2 - 0.0004;
    const edge = new THREE.Mesh(self.edgeGeo, self.edgeMats);
    inner.add(front, back, edge);
    let sheen = null;
    if (RANK[data.rarity] >= 2) {
      const sm = self.sheenMats[i];
      sm.uniforms.color.value.setHex(RARITY[data.rarity].glow);
      sheen = new THREE.Mesh(self.faceGeo, sm);
      sheen.position.z = CARD.t / 2 + 0.0012;
      sheen.renderOrder = 11;
      inner.add(sheen);
    }
    inner.rotation.y = Math.PI; // back toward the camera until flipped
    const glow = new THREE.Sprite(self.glowMats[i]);
    glow.material.color.setHex(RARITY[data.rarity].glow); glow.material.opacity = 0;
    glow.renderOrder = 9;
    // 30 cm behind the card: hover tilt swings a card edge ~11 cm back and fan neighbours sit up to 8 cm deeper, so a
    // glow any closer ends up in front of its own (or the next) card. The card's depth hides it; only the halo shows.
    glow.scale.set(1.4, 1.8, 1);
    glow.position.z = -0.3;
    outer.add(glow);
    outer.visible = false;
    self.rig.add(outer);
    return Object.assign(card, { outer, inner, faceMat, glow, sheen, hit: front, i, hover: 0, revealed: false, home: null });
  });
}
