// FORGE — title / loading screen: "LIT GAMES presents THE FORGE".
//
// It covers the hall while main.js loads it. A short told prologue (five lines, struck forward by the player) plays over
// a live 3D emblem: the LitVM caduceus, extruded from the same vector trace as the furnace badge in the hall
// (scripts/forge_hall/logo_trace.py, copied to assets/title/caduceus.json by scripts/title_assets.py). The emblem is
// poured as molten metal, struck (click / tap / Space), broken into fifty souls and cooled to chrome; then the wordmark
// lands and one more strike enters the forge.
//
// Contract with main.js, all DOM events on `document`: in "forge:progress" (detail 0..1) and "forge:ready"; out
// "forge:enter". body.title-cover is set while the title hides the hall (main.js skips drawing it then).
// html[data-forge-title] = on | off | done. ?title=0 turns the title off, ?debug turns it off unless ?title is given,
// ?title=story replays the prologue for a returning player (who otherwise gets the short version).
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { Particles, textures, sprite, rand, viewportScale } from "./fx.js";
import { BEATS, EASE, lerp, Tweens, markup, emblemLayout, nestLoops, badgeOutlines, spaceAlong } from "./titlecore.js";
import { oracleNeeded, openOracle } from "./oracle.js";

const Q = new URLSearchParams(location.search);
const SEEN = "forge.title.seen", SOUND = "forge.title.sound";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: remember nothing */ } },
};
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TOUCH = matchMedia("(pointer: coarse)").matches;
const SMALL = TOUCH && Math.min(screen.width, screen.height) < 900;

// the fifty souls, ten of each Kind (Mortal, King, Demigod, God, Titan)
const KIND_RGB = [[0.62, 0.86, 1.0], [1.0, 0.74, 0.26], [0.78, 0.56, 1.0], [1.0, 0.95, 0.8], [1.0, 0.36, 0.2]];

const FOV = 28, CAM_Z = 4.2;
const BOX = 1.24;                       // square the emblem's textures cover, in logo units (the art is 1 tall), centred
const ART_D = 0.026, RIM_D = 0.012;     // relief heights over the plate
const FILL_EMPTY = -0.02, FILL_FULL = 1.1;

// ------------------------------------------------------------------ emblem geometry (from the vector trace)
const V2 = (l) => l.map(([x, y]) => new THREE.Vector2(x, y));

/** The trace's loops as three.js shapes: even nesting depth = an outline, odd = a hole in its parent. */
function shapesFromLoops(loops) {
  const { depth, parent } = nestLoops(loops), shapes = new Map();
  loops.forEach((l, i) => { if (depth[i] % 2 === 0) shapes.set(i, new THREE.Shape(V2(l))); });
  loops.forEach((l, i) => { if (depth[i] % 2 === 1) shapes.get(parent[i])?.holes.push(new THREE.Path(V2(l))); });
  return [...shapes.values()];
}


/** Extrude, then map uv straight from x/y onto the emblem's texture square (the caps' normal maps read it). */
function extrude(shapes, opts) {
  const g = new THREE.ExtrudeGeometry(shapes, { curveSegments: 1, ...opts }), p = g.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / BOX + 0.5; uv[i * 2 + 1] = p.getY(i) / BOX + 0.5; }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

// ------------------------------------------------------------------ emblem textures (rasterised from the same trace)
// The trace is rasterised by the browser's canvas, then blurred and turned into normal maps by a few one-off GPU passes:
// the same work as JS loops over every pixel took seconds while the hall's GLB was parsing on the same thread.
function rasterCanvas(loops, N) {
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#000"; g.fillRect(0, 0, N, N);
  g.fillStyle = "#fff"; g.beginPath();
  const px = (x) => (x / BOX + 0.5) * N, py = (y) => (0.5 - y / BOX) * N;
  for (const l of loops) { g.moveTo(px(l[0][0]), py(l[0][1])); for (let k = 1; k < l.length; k++) g.lineTo(px(l[k][0]), py(l[k][1])); g.closePath(); }
  g.fill("evenodd");
  return c;
}

/** Hammered-iron dents for the backing plate, drawn as soft radial dabs around mid grey. */
function dentCanvas(N) {
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  g.fillStyle = "#808080"; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * N, y = Math.random() * N, r = N * rand(0.008, 0.03), dark = Math.random() < 0.75;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, dark ? "rgba(0,0,0,.30)" : "rgba(255,255,255,.22)"); gr.addColorStop(1, "rgba(128,128,128,0)");
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  return c;
}

const QUAD_VS = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }";
// 13-tap gaussian through linear filtering (sigma ~1.73 steps): `dir` is one step in uv
const BLUR_FS = /* glsl */ `uniform sampler2D map; uniform vec2 dir; varying vec2 vUv;
  float t(float k) { return texture2D(map, vUv + dir * k).r + texture2D(map, vUv - dir * k).r; }
  void main() { float s = texture2D(map, vUv).r * .19648255 + t(1.41176471) * .29690696 + t(3.29411765) * .0944704 + t(5.17647059) * .01038136;
    gl_FragColor = vec4(vec3(s), 1.); }`;
// height -> tangent-space normal. art: h = blurred mask (a rounded "pillow"); plate: dents - engraved channels
const NORMAL_FS = /* glsl */ `uniform sampler2D height; uniform sampler2D dents; uniform float texel; uniform float k; uniform float plate; varying vec2 vUv;
  float h(vec2 o) { vec2 uv = vUv + o * texel; float m = texture2D(height, uv).r; return plate > .5 ? (texture2D(dents, uv).r - .5) * .5 - m * .9 : m; }
  void main() { vec3 n = normalize(vec3(-(h(vec2(1., 0.)) - h(vec2(-1., 0.))) * k, -(h(vec2(0., 1.)) - h(vec2(0., -1.))) * k, 1.));
    gl_FragColor = vec4(n * .5 + .5, 1.); }`;

class MapBaker {
  constructor(renderer) {
    this.r = renderer;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: BLUR_FS, uniforms: { map: { value: null }, dir: { value: new THREE.Vector2() } } });
    this.normalMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: NORMAL_FS,
      uniforms: { height: { value: null }, dents: { value: null }, texel: { value: 0 }, k: { value: 1 }, plate: { value: 0 } } });
  }
  target(N, final) {
    return new THREE.WebGLRenderTarget(N, N, {
      type: final ? THREE.UnsignedByteType : THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter,
      minFilter: final ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, generateMipmaps: !!final,
      anisotropy: final ? Math.min(8, this.r.capabilities.getMaxAnisotropy()) : 1,
    });
  }
  draw(material, rt) {
    this.quad.material = material;
    const prev = this.r.getRenderTarget();
    this.r.setRenderTarget(rt);
    this.r.render(this.scene, this.cam);
    this.r.setRenderTarget(prev);
    return rt;
  }
  /** gaussian blur of a texture's red channel, sigma in uv units; final = keep it as a mipmapped 8-bit map */
  blur(tex, N, sigma, final = false) {
    const step = sigma / 1.73, u = this.blurMat.uniforms;
    u.map.value = tex; u.dir.value.set(step, 0);
    const h = this.draw(this.blurMat, this.target(N, false));
    u.map.value = h.texture; u.dir.value.set(0, step);
    const v = this.draw(this.blurMat, this.target(N, final));
    h.dispose();
    return v;
  }
  /** normal map from a height texture; amp = relief height in logo units for a full 0..1 step */
  normals(height, N, amp, dents = null) {
    const u = this.normalMat.uniforms;
    u.height.value = height; u.dents.value = dents; u.plate.value = dents ? 1 : 0;
    u.texel.value = 1 / N; u.k.value = amp / (2 * (1 / N) * BOX);
    return this.draw(this.normalMat, this.target(N, true));
  }
  dispose() { this.quad.geometry.dispose(); this.blurMat.dispose(); this.normalMat.dispose(); }
}

function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

// ------------------------------------------------------------------ materials: molten pour, strike heat, sheen
// (GLSL smoothstep with edge0 > edge1 is undefined: ANGLE on D3D returns 1 past edge1, so falling edges are 1 - smoothstep)
const HEAT_PARS = /* glsl */ `
uniform float uFill; uniform float uCool; uniform float uHeat; uniform float uTime; uniform float uSweep; uniform vec4 uStrike;
varying vec2 vLogo;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(tHash(i), tHash(i + vec2(1., 0.)), f.x), mix(tHash(i + vec2(0., 1.)), tHash(i + vec2(1.)), f.x), f.y); }
vec3 tGlow(float h) { vec3 c = mix(vec3(.5, .03, 0.), vec3(1., .3, .04), smoothstep(0., .45, h));
  c = mix(c, vec3(1., .7, .3), smoothstep(.45, .85, h)); return mix(c, vec3(1., .96, .86), smoothstep(.85, 1.3, h)); }
`;
const LOGO_VARYING = (s) => s
  .replace("#include <common>", `#include <common>\nvarying vec2 vLogo;`)
  .replace("#include <begin_vertex>", `#include <begin_vertex>\nvLogo = position.xy / ${BOX.toFixed(4)} + .5;`);

/** Chrome that is poured bottom-up (fragments above the molten front are not there yet) and glows while hot. */
function pouredMetal(params, U) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = LOGO_VARYING(sh.vertexShader);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${HEAT_PARS}`)
      .replace("#include <clipping_planes_fragment>", /* glsl */ `#include <clipping_planes_fragment>
        float tFront = uFill + (tNoise(vec2(vLogo.x * 18., uTime * .9)) - .5) * .05;
        if (vLogo.y > tFront) discard;
        float tBehind = tFront - vLogo.y;
        float tHeat = exp(-tBehind * 6.) * (1. - uCool) + (1. - smoothstep(0., .045, tBehind)) * (1. - step(1.05, uFill)) * .7;
        vec2 tD = vLogo - uStrike.xy;
        tHeat = max(tHeat, uStrike.w * exp(-dot(tD, tD) * 70.));
        tHeat = max(tHeat, uHeat);
        tHeat *= .84 + .16 * tNoise(vLogo * 60. + uTime * 1.5);`)
      .replace("#include <color_fragment>", `#include <color_fragment>\ndiffuseColor.rgb *= 1. - .75 * clamp(tHeat, 0., 1.);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, .6, clamp(tHeat * 1.4, 0., 1.));`)
      .replace("#include <emissivemap_fragment>", /* glsl */ `#include <emissivemap_fragment>
        float tH = clamp(tHeat, 0., 1.4);
        totalEmissiveRadiance += tGlow(tH) * tH * tH * 4.;
        float tS = 1. - smoothstep(0., .06, abs((vLogo.x + vLogo.y) * .7 - uSweep));
        totalEmissiveRadiance += vec3(1., .96, .9) * tS * 1.1 * (1. - clamp(tH, 0., 1.));`);
  };
  m.customProgramCacheKey = () => "title-poured";
  return m;
}

/** The backing plate is the mould: its engraved channels glow until the metal covers them. */
function mouldIron(params, U) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = LOGO_VARYING(sh.vertexShader);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${HEAT_PARS}`)
      .replace("#include <emissivemap_fragment>", /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance *= mix(.1, 1., smoothstep(uFill - .02, uFill + .04, vLogo.y)) * (.75 + .25 * tNoise(vLogo * 40. + uTime));
        vec2 tD = vLogo - uStrike.xy;
        totalEmissiveRadiance += vec3(1., .35, .08) * uStrike.w * exp(-dot(tD, tD) * 45.) * .8;`);
  };
  m.customProgramCacheKey = () => "title-mould";
  return m;
}

/** Procedural studio sky for the chrome: cool sky, a bright horizon line just below eye level, softboxes, forge fire. */
function chromeEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }",
    fragmentShader: /* glsl */ `varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir); float y = d.y, h = -.22, az = atan(d.x, d.z);
        vec3 col = y > h ? mix(vec3(.5, .6, .76), vec3(.06, .08, .15), smoothstep(h, .85, y))
                         : mix(vec3(.16, .12, .1), vec3(.015, .012, .012), 1. - smoothstep(-.7, h, y));
        col += vec3(1.35, 1.35, 1.42) * exp(-abs(y - h) * 30.);
        col += vec3(1.7) * (1. - smoothstep(.05, .09, abs(az - .55))) * smoothstep(-.05, .1, y) * (1. - smoothstep(.5, .75, y));
        col += vec3(.9, 1., 1.25) * (1. - smoothstep(.04, .07, abs(az + 1.25))) * smoothstep(.1, .25, y) * (1. - smoothstep(.55, .7, y));
        col += vec3(2.6, .9, .22) * pow(max(dot(d, normalize(vec3(0., -.75, .65))), 0.), 5.);
        gl_FragColor = vec4(col, 1.);
      }`,
  })));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.0);
  pm.dispose();
  scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return rt;
}

// ------------------------------------------------------------------ the fifty souls
class Souls {
  constructor(n = 50) {
    this.n = n; this.state = "hidden"; this.converge = false; this.alpha = 0;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    const col = new Float32Array(n * 3), size = new Float32Array(n), seed = new Float32Array(n);
    this.home = [];
    for (let i = 0; i < n; i++) {
      col.set(KIND_RGB[i % 5], i * 3);
      size[i] = rand(0.035, 0.062); seed[i] = Math.random() * 100;
      this.home.push({ a: (i / n) * Math.PI * 2 + rand(-0.25, 0.25), r: rand(0.6, 1.08), z: rand(-0.55, 0.45),
                       w: rand(0.05, 0.12) * (Math.random() < 0.5 ? -1 : 1), bob: rand(0, 6.28) });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uTime: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: /* glsl */ `attribute vec3 aColor; attribute float aSize; attribute float aSeed;
        uniform float uScale; uniform float uTime; uniform float uAlpha; varying vec3 vC; varying float vA;
        void main() { vC = aColor; float tw = .7 + .3 * sin(uTime * (1.3 + fract(aSeed) * 2.) + aSeed); vA = uAlpha * tw;
          vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = aSize * tw * uScale / max(-mv.z, .1); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `varying vec3 vC; varying float vA;
        void main() { float d = length(gl_PointCoord - .5); float a = 1. - smoothstep(0., .5, d), core = 1. - smoothstep(0., .16, d);
          gl_FragColor = vec4(vC * (a * a * .9 + core * 2.4) * vA, 1.); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
    this.points.visible = false;
  }
  /** origins: world positions on the emblem; they fly out from there. */
  burst(origins, center, s) {
    this.state = "out"; this.converge = false;
    for (let i = 0; i < this.n; i++) {
      const o = origins[i % origins.length], i3 = i * 3;
      this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
      const dx = o.x - center.x + rand(-0.1, 0.1), dy = o.y - center.y + rand(-0.1, 0.1), l = Math.hypot(dx, dy) || 1, sp = rand(1.6, 3.4) * s;
      this.vel[i3] = (dx / l) * sp; this.vel[i3 + 1] = (dy / l) * sp; this.vel[i3 + 2] = rand(0.2, 1.4) * s;
    }
  }
  update(dt, t, center, s, scale) {
    if (this.state === "hidden") { this.points.visible = false; return; }
    this.points.visible = this.alpha > 0.001;
    this.mat.uniforms.uAlpha.value = this.alpha; this.mat.uniforms.uTime.value = t; this.mat.uniforms.uScale.value = scale;
    const k = this.converge ? 30 : 2.4, c = this.converge ? 8 : 1.5, p = this.pos, v = this.vel;
    for (let i = 0; i < this.n; i++) {
      const h = this.home[i], i3 = i * 3;
      h.a += h.w * dt;
      const tx = this.converge ? center.x : center.x + Math.cos(h.a) * h.r * s * 1.15;
      const ty = this.converge ? center.y : center.y + Math.sin(h.a) * h.r * s * 0.88 + Math.sin(t * 0.7 + h.bob) * 0.03 * s;
      const tz = this.converge ? 0.1 * s : h.z * s;
      v[i3] += ((tx - p[i3]) * k - v[i3] * c) * dt; v[i3 + 1] += ((ty - p[i3 + 1]) * k - v[i3 + 1] * c) * dt; v[i3 + 2] += ((tz - p[i3 + 2]) * k - v[i3 + 2] * c) * dt;
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ sound (synthesised: no assets, starts on the first gesture)
class Sound {
  constructor() { this.on = store.get(SOUND) !== "0"; this.ac = null; this.out = null; this.nextPop = 0; }
  wake() {
    if (!this.on || this.closed) return;
    try {
      if (!this.ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ac = new AC();
        const comp = this.ac.createDynamicsCompressor();
        this.out = this.ac.createGain(); this.out.gain.value = 0.9;
        this.out.connect(comp).connect(this.ac.destination);
        this.bed();
      }
      if (this.ac.state === "suspended") this.ac.resume();
    } catch { this.ac = null; }
  }
  get live() { return this.on && !this.closed && this.ac?.state === "running"; }
  noise(sec) {
    const ac = this.ac, b = ac.createBuffer(1, Math.ceil(ac.sampleRate * sec), ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ac.createBufferSource(); s.buffer = b;
    return s;
  }
  /** the forge's low roar: brown noise, low-passed, looping */
  bed() {
    const ac = this.ac, len = ac.sampleRate * 4, b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = ac.createBufferSource(); src.buffer = b; src.loop = true;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 380;
    const g = ac.createGain(); g.gain.value = 0; g.gain.setTargetAtTime(0.18, ac.currentTime, 1.5);
    src.connect(lp).connect(g).connect(this.out); src.start();
  }
  band(dur, f0, f1, q, gain, at = 0) {
    if (!this.live) return;
    const ac = this.ac, t = ac.currentTime + at, n = this.noise(dur), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = "bandpass"; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(this.out); n.start(t); n.stop(t + dur + 0.02);
  }
  tone(type, f0, f1, dur, gain, at = 0) {
    if (!this.live) return;
    const ac = this.ac, t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  }
  /** hammer on hot metal: inharmonic bar partials, a bright hit and a low thump */
  clang(power = 1) {
    if (!this.live) return;
    const f0 = rand(330, 440), v = Math.min(1.5, power) * 0.14;
    for (const [r, dec, a] of [[1, 1.7, 1], [2.76, 1, 0.55], [5.4, 0.55, 0.34], [8.93, 0.3, 0.22], [13.34, 0.17, 0.14]]) this.tone("sine", f0 * r * rand(0.996, 1.004), f0 * r, dec * (0.8 + power * 0.2), v * a);
    this.band(0.06, 3200, 2400, 0.9, v * 2.4);
    this.tone("sine", 150, 46, 0.24, v * 2.6);
  }
  boom() { if (!this.live) return; this.tone("sine", 70, 34, 1.4, 0.5); this.band(0.9, 900, 120, 0.6, 0.22); this.clang(0.7); }
  sizzle(dur) { if (this.live) this.band(dur, 2600, 1800, 0.7, 0.07); }
  chime() { if (!this.live) return; [1046.5, 1318.5, 1568, 2093, 2637].forEach((f, i) => this.tone("triangle", f, f, 1.6, 0.05, i * 0.07)); }
  whoosh() { if (this.live) this.band(1.1, 260, 3400, 1.1, 0.3); }
  /** a coal pop now and then, called every frame */
  crackle(t, amount) {
    if (!this.live || t < this.nextPop) return;
    this.nextPop = t + rand(0.08, 0.7) / (0.5 + amount);
    this.band(rand(0.008, 0.03), rand(1800, 5200), rand(1500, 4000), 2, rand(0.02, 0.07) * (0.4 + amount));
  }
  toggle() {
    this.on = !this.on;
    store.set(SOUND, this.on ? "1" : "0");
    if (this.ac) this.out.gain.setTargetAtTime(this.on ? 0.9 : 0, this.ac.currentTime, 0.05);
    if (this.on) this.wake();
  }
  pause(hidden) {
    if (!this.ac || this.closed) return;
    (hidden ? this.ac.suspend() : this.on ? this.ac.resume() : Promise.resolve()).catch(() => {});
  }
  close(sec) {
    if (!this.ac || this.closed) return;
    this.closed = true;
    this.out.gain.setTargetAtTime(0, this.ac.currentTime, sec / 4);
    setTimeout(() => this.ac.close().catch(() => {}), sec * 1000 + 300);
  }
}

const SPEAKER = (on) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none"/>${on
    ? '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'
    : '<path d="m16 9 6 6"/><path d="m22 9-6 6"/>'}</svg>`;

// ------------------------------------------------------------------ the screen
class TitleScreen {
  constructor(root) {
    this.root = root;
    this.$ = (s) => root.querySelector(s);
    this.seen = store.get(SEEN) === "1" && Q.get("title") !== "story";
    this.phase = "presents";
    this.ready = document.documentElement.dataset.forgeReady === "1";
    this.progress = this.ready ? 1 : 0; this.shownProgress = 0;
    this.time = 0; this.last = performance.now(); this.timers = [];
    this.tw = new Tweens();
    this.E = { light: 0, mold: 0, fill: FILL_EMPTY, cool: 0, heat: 0, layout: this.seen ? 1 : 0, cam: 1, dim: 1, kindle: 0, sweep: -1 };
    this.ptr = { x: 0, y: 0 }; this.spin = 0; this.shake = 0;
    this.beat = -1; this.typing = false; this.hold = 0;
    this.passed = !oracleNeeded(); // the Oracle (terms + trial) opens once the title card lands, until it is passed
    this.sound = new Sound();
    this.abort = new AbortController();

    this.initGL();
    this.emblem = this.buildEmblem().catch((e) => { console.error("[title] emblem could not be built; the title carries on without it", e); return null; });
    this.bindInput();
    this.$(".t-hint").textContent = TOUCH ? "Tap to strike" : "Click to strike";
    this.setSoundIcon();

    const on = (type, fn) => document.addEventListener(type, fn, { signal: this.abort.signal });
    on("forge:progress", (e) => { this.progress = Math.max(this.progress, Math.min(1, +e.detail || 0)); });
    on("forge:ready", () => this.onReady());
    if (this.ready) this.onReady();

    // the studio card animates in CSS from the first paint; hand over once it has had its moment
    this.presentsEnd = Math.max(0.3, ((this.seen ? 1900 : 3500) - performance.now()) / 1000);
    this.after(this.presentsEnd, () => this.endPresents());
    // a lost GPU context (a phone reclaiming memory): drop the 3D, the story and the way in still work
    this.renderer.domElement.addEventListener("webglcontextlost", () => { this.glLost = true; root.classList.remove("gl-on"); }, { signal: this.abort.signal });
    // the forge roar pauses with the tab
    document.addEventListener("visibilitychange", () => this.sound.pause(document.hidden), { signal: this.abort.signal });
    this.shadeHall();
    requestAnimationFrame(() => root.classList.add("gl-on"));
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Keyboard focus and screen readers stay on the title while it covers the hall (main.js keeps adding to <body>). */
  shadeHall() {
    this.shaded = new Set();
    const shade = (el) => {
      if (el.nodeType !== 1 || el === this.root || el.tagName === "SCRIPT" || el.inert) return;
      el.inert = true;
      this.shaded.add(el);
    };
    [...document.body.children].forEach(shade);
    this.shadeWatch = new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach(shade)));
    this.shadeWatch.observe(document.body, { childList: true });
  }
  unshadeHall() {
    this.shadeWatch?.disconnect();
    for (const el of this.shaded ?? []) el.inert = false;
    this.shaded?.clear();
  }

  // -------------------------------------------------------------- setup
  initGL() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(devicePixelRatio, SMALL ? 1.25 : 1.5));
    r.setSize(innerWidth, innerHeight, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    r.domElement.className = "t-gl";
    this.root.prepend(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050407);
    this.camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.05, 60);
    this.camera.position.set(0, 0, CAM_Z);
    this.envRT = chromeEnvironment(r);

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // full-resolution chain on purpose: at half resolution thin chrome highlights alias into square blocks.
    // Threshold 1: only heat, sparks, souls and the hottest glints glow; the chrome itself stays crisp.
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 1.0));
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass(innerWidth * r.getPixelRatio(), innerHeight * r.getPixelRatio());
    this.composer.addPass(this.smaa);
    this.composer.setSize(innerWidth, innerHeight);

    // forge light from below the frame, a cool key from above-left for the bevels
    this.hearth = new THREE.PointLight(0xff6a22, 0, 0, 2);
    this.hearth.position.set(0, -1.7, 1.5);
    this.key = new THREE.DirectionalLight(0xc4d6ff, 0);
    this.key.position.set(-2, 3, 2.5);
    this.scene.add(this.hearth, this.key);

    const tex = textures();
    this.glowBelow = sprite(tex.glow, 0xff5a14, 1, 0); this.glowBelow.renderOrder = 0;
    this.glowBack = sprite(tex.glow, 0x3d5ba8, 1, 0); this.glowBack.renderOrder = 0;
    this.scene.add(this.glowBelow, this.glowBack);
    this.embers = new Particles(REDUCED ? 90 : 260, tex.dot, { gravity: -0.12, drag: 0.25, sway: 0.35, cool: [0.1, 0.6, 1], fadeIn: 0.25 });
    this.sparks = new Particles(REDUCED ? 180 : 600, tex.dot, { gravity: 2.6, drag: 0.9, cool: [0.12, 0.75, 1] });
    this.scene.add(this.embers.points, this.sparks.points);
    this.flashes = Array.from({ length: 4 }, () => sprite(tex.glow, 0xffd2a0, 0.1));
    this.rings = Array.from({ length: 4 }, () => sprite(tex.ring, 0xffa050, 0.1));
    for (const s of [...this.flashes, ...this.rings]) { s.userData.t = 9; s.visible = false; this.scene.add(s); }
    this.fxIndex = 0;
    this.souls = new Souls(50);
    this.scene.add(this.souls.points);
    this.ray = new THREE.Raycaster();

    this.U = { uFill: { value: FILL_EMPTY }, uCool: { value: 0 }, uHeat: { value: 0 }, uTime: { value: 0 }, uSweep: { value: -1 }, uStrike: { value: new THREE.Vector4(0.5, 0.5, 0, 0) } };
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);
    addEventListener("resize", () => this.resize(), { signal: this.abort.signal });
  }

  async buildEmblem() {
    const res = await fetch("./assets/title/caduceus.json");
    if (!res.ok) throw new Error(`caduceus.json: HTTP ${res.status}`);
    const data = await res.json();
    // One synchronous run (~0.5 s on a slow laptop GPU, under the studio card). Yielding between steps let the hall's own
    // loading (GLB parse, shader warm-up) go first and left the stage empty for seconds.
    const N = SMALL ? 1024 : 2048, NP = N / 2, t0 = performance.now();

    // textures: the art's rounded "pillow" relief, the plate's engraved channels + hammered dents, the mould glow
    const bake = new MapBaker(this.renderer);
    const artTex = canvasTexture(rasterCanvas(data.art, N));
    const pillow = bake.blur(artTex, N, 0.002);
    const artNormal = bake.normals(pillow.texture, N, 0.0094);
    const plateCanvas = rasterCanvas(data.art, NP), plateTex = canvasTexture(plateCanvas), dentTex = canvasTexture(dentCanvas(NP));
    const channels = bake.blur(plateTex, NP, 0.0039);
    const plateNormal = bake.normals(channels.texture, NP, 0.0145, dentTex);
    const mould = bake.blur(plateTex, NP, 0.0055, true);
    for (const x of [pillow, channels]) x.dispose();
    for (const x of [artTex, plateTex, dentTex]) x.dispose();
    bake.dispose();
    this.targets = [artNormal, plateNormal, mould];
    // a CPU copy of the art mask: where souls fly out from and where the molten front spits sparks
    const d = plateCanvas.getContext("2d").getImageData(0, 0, NP, NP).data, m = new Uint8Array(NP * NP);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4];
    this.mask = { m, N: NP };

    // geometry: art relief on a plate inside a raised rim, the plate outline grown from the trace's own badge outline
    const badge = badgeOutlines(data.plate[0]);
    const artGeo = extrude(shapesFromLoops(data.art), { depth: ART_D, bevelEnabled: false });
    const rimShape = new THREE.Shape(V2(badge.rimOuter));
    rimShape.holes.push(new THREE.Path(V2(badge.rimInner)));
    const rimGeo = extrude([rimShape], { depth: RIM_D, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 3 });
    rimGeo.translate(0, 0, 0.006);
    const PB = 0.022, PD = 0.05;
    const plateGeo = extrude([new THREE.Shape(V2(badge.plate))], { depth: PD, bevelEnabled: true, bevelThickness: PB, bevelSize: PB, bevelSegments: 5 });
    plateGeo.translate(0, 0, -(PD + PB));

    const U = this.U;
    // envMap set per material: with only scene.environment, three uses scene.environmentIntensity and ignores the
    // per-material envMapIntensity the light-up needs
    const envMap = this.envRT.texture;
    const chrome = { color: 0xeceef2, metalness: 1, roughness: 0.2, envMap };
    this.mats = {
      artCap: pouredMetal({ ...chrome, normalMap: artNormal.texture, normalScale: new THREE.Vector2(1, 1) }, U),
      artSide: pouredMetal({ ...chrome, roughness: 0.24 }, U),
      rim: pouredMetal({ ...chrome, color: 0xb9bdc6, roughness: 0.3 }, U),
      plateCap: mouldIron({ envMap, color: 0x2a2520, metalness: 0.78, roughness: 0.42, normalMap: plateNormal.texture, normalScale: new THREE.Vector2(0.9, 0.9),
                            emissive: 0xff5a14, emissiveMap: mould.texture, emissiveIntensity: 0 }, U),
      plateSide: new THREE.MeshStandardMaterial({ envMap, color: 0x3a342e, metalness: 0.92, roughness: 0.3 }),
    };
    const art = new THREE.Mesh(artGeo, [this.mats.artCap, this.mats.artSide]);
    const rim = new THREE.Mesh(rimGeo, this.mats.rim);
    const plate = new THREE.Mesh(plateGeo, [this.mats.plateCap, this.mats.plateSide]);
    // rivets along the rim
    const studs = spaceAlong(badge.rivets, 0.07), mtx = new THREE.Matrix4();
    const rivets = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0085, 12, 8), this.mats.artSide, studs.length);
    studs.forEach(([x, y], k) => rivets.setMatrixAt(k, mtx.makeTranslation(x, y, RIM_D + 0.008)));
    this.parts = [art, rim, plate, rivets];
    this.group.add(...this.parts);
    this.hit = [plate, art];
    const bb = new THREE.Box3().setFromObject(plate);
    this.size = { w: bb.max.x - bb.min.x, h: bb.max.y - bb.min.y };
    // compile every program now, the hidden effects too (sparks, souls, strike flashes): not on the first strike
    const hidden = [this.embers.points, this.sparks.points, this.souls.points, ...this.flashes, ...this.rings].filter((o) => !o.visible);
    for (const o of hidden) o.visible = true;
    this.group.visible = true;
    this.renderer.compile(this.scene, this.camera);
    for (const o of hidden) o.visible = false;
    this.buildMs = Math.round(performance.now() - t0);
    return this.group;
  }

  bindInput() {
    const opt = { signal: this.abort.signal };
    const r = this.root;
    const track = (e) => { this.ptr.x = (e.clientX / innerWidth) * 2 - 1; this.ptr.y = -((e.clientY / innerHeight) * 2 - 1); };
    r.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, .oracle")) return; // the Oracle's rings and links are not strikes
      track(e);
      this.down = { x: e.clientX, lx: e.clientX, drag: false };
    }, opt);
    addEventListener("pointermove", (e) => {
      track(e);
      const d = this.down;
      if (!d) return;
      if (!d.drag && Math.abs(e.clientX - d.x) > 12) d.drag = true;
      if (d.drag) { this.spin += (e.clientX - d.lx) * 0.006; d.lx = e.clientX; }
    }, opt);
    addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (d && !d.drag && !e.target.closest?.("button")) this.act(e.clientX, e.clientY);
    }, opt);
    addEventListener("pointercancel", () => { this.down = null; }, opt);
    addEventListener("keydown", (e) => {
      if (e.repeat || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === " " || e.key === "Enter") {
        if (e.target.tagName === "BUTTON") return;
        e.preventDefault();
        this.act(innerWidth / 2 + rand(-60, 60), innerHeight * 0.42 + rand(-50, 50));
      } else if (e.key === "Escape") this.skip();
      else if (e.key === "m" || e.key === "M") this.toggleSound();
    }, opt);
    this.$(".t-skip").addEventListener("click", () => { this.sound.wake(); this.skip(); }, opt);
    this.$(".t-replay").addEventListener("click", () => { this.sound.wake(); this.replay(); }, opt);
    this.$(".t-sound").addEventListener("click", () => this.toggleSound(), opt);
  }

  toggleSound() { this.sound.toggle(); this.setSoundIcon(); }
  setSoundIcon() {
    const b = this.$(".t-sound");
    b.innerHTML = SPEAKER(this.sound.on);
    b.setAttribute("aria-label", this.sound.on ? "Sound on" : "Sound off");
    b.setAttribute("aria-pressed", String(this.sound.on));
  }

  after(sec, fn) { this.timers.push({ at: this.time + sec, fn }); }

  // -------------------------------------------------------------- flow
  /** a click, tap, Space or Enter: always a hammer strike; it also moves the story along */
  act(x, y) {
    this.sound.wake();
    if (this.phase === "entering" || this.phase === "done" || this.oracleOpen) return;
    if (this.phase === "title" && this.ready) return this.enter();
    this.strike(x, y, 1);
    this.root.classList.remove("hint");
    if (this.phase === "presents") this.endPresents();
    else if (this.phase === "story") {
      if (this.typing) this.finishLine();
      else if (this.hold > 0.5) this.nextBeat();
    } else if (this.phase === "title") {
      const l = this.$(".t-load");
      l.classList.remove("nudge"); void l.offsetWidth; l.classList.add("nudge");
    }
  }

  async endPresents() {
    if (this.phase !== "presents" || this.ending) return;
    this.ending = true;
    await this.emblem; // a slow device keeps the studio card up until there is an emblem to show, not an empty stage
    if (this.phase !== "presents") return;
    this.root.classList.add("presents-out");
    if (this.seen) this.toTitle({ quick: true });
    else this.startStory();
  }

  startStory() {
    this.phase = "story";
    this.root.dataset.phase = "story";
    this.beat = -1;
    this.nextBeat();
    this.after(2.2, () => { if (this.phase === "story" && !this.struck) this.root.classList.add("hint"); });
  }

  nextBeat() {
    if (this.phase !== "story") return;
    this.beat++;
    if (this.beat >= BEATS.length) return this.toTitle();
    const b = BEATS[this.beat];
    this.$(".t-num").textContent = b.n;
    const line = this.$(".t-line");
    line.innerHTML = markup(b.text);
    this.chars = [...line.querySelectorAll(".c")];
    this.typed = 0; this.typeAcc = 0; this.typing = true; this.hold = 0;
    if (REDUCED) this.finishLine();
    this.cue(b.cue);
  }

  finishLine() {
    for (const c of this.chars ?? []) c.classList.add("on");
    this.typed = this.chars?.length ?? 0;
    this.typing = false; this.hold = 0;
  }

  cue(name) {
    const E = this.E, tw = this.tw, s = this.sound;
    if (name === "mold") {
      tw.to(E, "light", 1, 2.6); tw.to(E, "mold", 1, 2.2);
      s.band(1.4, 160, 900, 0.8, 0.12);
    } else if (name === "pour") {
      tw.to(E, "mold", 1, 0.3); tw.to(E, "light", 1, 0.5);
      tw.to(E, "fill", FILL_FULL, REDUCED ? 1.2 : 3.6, "inOut");
      s.sizzle(3.6);
    } else if (name === "shatter") {
      this.after(0.45, () => {
        if (this.phase !== "story") return;
        this.strike(innerWidth / 2, innerHeight * 0.43, 1.7, { flash: true });
        this.releaseSouls();
        E.heat = 1; tw.to(E, "heat", 0, 1.8);
      });
    } else if (name === "cool") {
      if (E.fill < FILL_FULL) tw.to(E, "fill", FILL_FULL, 0.8);
      tw.to(E, "cool", 1, 2.8); tw.to(E, "mold", 0, 2.8);
      this.after(1.4, () => this.sweep());
    } else if (name === "kindle") {
      tw.to(E, "kindle", 1, 2.4);
      s.band(2.2, 120, 600, 0.7, 0.14);
    }
  }

  releaseSouls() {
    if (this.souls.state !== "hidden" || !this.parts) return;
    const origins = [], v = new THREE.Vector3();
    const { m, N } = this.mask;
    for (let tries = 0; origins.length < 50 && tries < 5000; tries++) {
      const x = Math.random(), y = Math.random();
      if (m[Math.floor((1 - y) * N) * N + Math.floor(x * N)] < 128) continue;
      origins.push(this.group.localToWorld(v.set((x - 0.5) * BOX, (y - 0.5) * BOX, ART_D)).clone());
    }
    if (!origins.length) origins.push(this.group.position.clone());
    this.souls.burst(origins, this.group.position, this.group.scale.x);
    this.tw.to(this.souls, "alpha", 1, 0.4);
    this.sound.chime();
  }

  sweep() { this.E.sweep = -0.3; this.tw.to(this.E, "sweep", 1.7, 1.3, "inOut"); }

  skip() {
    if (this.phase === "presents") { this.ending = true; this.root.classList.add("presents-out"); this.emblem.then(() => this.toTitle()); }
    else if (this.phase === "story") this.toTitle();
  }

  toTitle({ quick = false } = {}) {
    if (this.phase === "title" || this.phase === "entering" || this.phase === "done") return;
    this.phase = "title";
    this.root.dataset.phase = "title";
    this.root.classList.remove("hint");
    const E = this.E, tw = this.tw;
    // finish the emblem whatever was skipped
    tw.to(E, "light", 1, 1); tw.to(E, "mold", 0, quick ? 1.6 : 0.8); tw.to(E, "kindle", 1, 2);
    if (E.fill < FILL_FULL) tw.to(E, "fill", FILL_FULL, quick ? 1.6 : 0.9, "inOut");
    tw.to(E, "cool", 1, quick ? 2.6 : 1.4);
    if (quick) this.sound.sizzle(1.6);
    if (this.souls.state === "hidden") this.after(quick ? 1.1 : 0.3, () => this.releaseSouls());
    tw.to(E, "layout", 1, quick ? 0.01 : 1.6, "inOut");
    tw.to(E, "dim", 0.85, 2);
    const land = quick ? 1.3 : 0.9;
    this.after(land - 0.35, () => { this.root.classList.add("show-logo", "show-head"); });
    this.after(land, () => {
      this.shake = Math.max(this.shake, REDUCED ? 0 : 0.012);
      this.sound.boom();
      this.burstSparks(this.group.position.clone().add(new THREE.Vector3(0, -this.group.scale.x * 0.35, 0.2)), 1.2);
    });
    this.after(land + 0.5, () => this.sweep());
    this.after(land + 0.6, () => this.syncPrompt());
    this.after(land + 1.4, () => this.gate());
    this.after(28, () => { if (this.phase === "title" && !this.ready) { this.ready = true; this.$(".t-prompt span").textContent = "Enter the forge"; this.syncPrompt(); } });
  }

  syncPrompt() { this.root.classList.toggle("can-enter", this.phase === "title" && this.ready && this.passed); }

  /** The Oracle (oracle.js): the covenant (terms of use) and the Trial of the Heavens, once per covenant, over the title
   *  card. Passing it is the way in: it enters the forge straight away if the hall has loaded. */
  gate() {
    if (this.passed || this.oracleOpen || this.phase !== "title") return;
    this.oracleOpen = true;
    this.root.classList.add("oracle-on");
    openOracle(this.root, { chime: () => this.sound.chime(), boom: () => this.sound.boom() }).then(() => {
      this.oracleOpen = false;
      this.passed = true;
      this.root.classList.remove("oracle-on");
      if (this.ready) this.enter(); else this.syncPrompt();
    });
  }

  onReady() {
    this.ready = true; this.progress = 1;
    this.$(".t-load span").textContent = "The forge is lit";
    this.root.classList.add("loaded");
    if (this.phase === "title") this.syncPrompt();
  }

  replay() {
    if (this.phase !== "title") return;
    this.phase = "rewind";
    this.root.dataset.phase = "rewind";
    this.timers = [];
    this.root.classList.remove("show-logo", "show-head", "can-enter");
    const E = this.E, tw = this.tw;
    tw.to(E, "layout", 0, 1.2, "inOut"); tw.to(E, "dim", 1, 1); tw.to(E, "kindle", 0, 1);
    tw.to(E, "light", 0, 1.1); tw.to(E, "fill", FILL_EMPTY, 1.1, "in"); tw.to(E, "cool", 0, 1.1);
    tw.to(this.souls, "alpha", 0, 0.6);
    this.after(1.25, () => { this.souls.state = "hidden"; this.startStory(); });
  }

  enter() {
    if (this.phase !== "title") return;
    if (!this.passed) return this.gate();
    this.phase = "entering";
    this.root.dataset.phase = "entering";
    store.set(SEEN, "1");
    const E = this.E, tw = this.tw;
    this.strike(innerWidth / 2, innerHeight * 0.42, 1.8, { flash: true });
    this.sound.whoosh();
    this.sound.close(2.4);
    this.souls.converge = true;
    tw.to(E, "heat", 1.2, 0.5, "in");
    if (!REDUCED) tw.to(E, "cam", 0.3, 1.3, "in");
    document.body.classList.remove("title-cover"); // the hall draws again under the fading title
    this.unshadeHall();
    this.after(1.3, () => this.finish());
  }

  finish() {
    this.phase = "done";
    this.renderer.setAnimationLoop(null);
    this.abort.abort();
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) m.dispose();
    });
    for (const t of this.targets ?? []) t.dispose();
    this.envRT.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.root.remove();
    document.documentElement.dataset.forgeTitle = "done";
    if (window.forgeTitle === this) delete window.forgeTitle;
    document.dispatchEvent(new Event("forge:enter"));
  }

  // -------------------------------------------------------------- strikes
  strike(x, y, power, { flash = false } = {}) {
    this.struck = true;
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
    this.ray.setFromCamera(ndc, this.camera);
    let p = this.hit && this.group.visible ? this.ray.intersectObjects(this.hit, false)[0]?.point : null;
    if (!p) {
      // missed the emblem: land on its plane, pulled in to its edge
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.group.position);
      p = this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.group.position.clone();
      const d = p.clone().sub(this.group.position), max = 0.48 * this.group.scale.x;
      if (d.length() > max) p.copy(this.group.position).add(d.setLength(max));
    }
    const local = this.group.worldToLocal(p.clone());
    this.U.uStrike.value.set(local.x / BOX + 0.5, local.y / BOX + 0.5, 0, Math.min(1.2, 0.75 * power));
    this.burstSparks(p, power);
    const s = this.group.scale.x;
    const f = this.flashes[this.fxIndex % 4], r = this.rings[this.fxIndex % 4];
    this.fxIndex++;
    Object.assign(f.userData, { t: 0, dur: 0.28, s0: 0.25 * s * power, s1: 0.5 * s * power, o: 0.9 });
    Object.assign(r.userData, { t: 0, dur: 0.55, s0: 0.05 * s, s1: 0.7 * s * power, o: 0.8 });
    f.position.copy(p); r.position.copy(p);
    this.shake = Math.max(this.shake, REDUCED ? 0 : 0.008 * power);
    this.sound.clang(power);
    if (flash) {
      const el = this.$(".t-flash");
      el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
    }
  }

  burstSparks(p, power) {
    const s = this.group.scale.x || 1, n = Math.round((REDUCED ? 24 : 70) * power);
    const nz = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(rand(-1, 1)), sp = rand(0.6, 2.4) * s, out = rand(0.3, 1.6) * s;
      const vx = Math.sin(ph) * Math.cos(th) * sp + nz.x * out, vy = Math.sin(ph) * Math.sin(th) * sp + nz.y * out + 0.6 * s, vz = Math.cos(ph) * sp * 0.5 + nz.z * out;
      const k = rand(0.7, 1.25);
      this.sparks.emit(p.x, p.y, p.z + 0.02, vx, vy, vz, 2.4 * k, 1.25 * k, 0.45 * k, rand(0.01, 0.024) * s, rand(0.45, 1.25));
    }
  }

  // -------------------------------------------------------------- per frame
  layout(mode) {
    return emblemLayout(this.camera.aspect, mode ? "title" : "story", this.size ?? { w: 1.2, h: 1.16 }, FOV, CAM_Z);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.composer.setSize(innerWidth, innerHeight);
  }

  frame() {
    if (this.phase === "done") return; // context already released
    const now = performance.now(), raw = (now - this.last) / 1000, dt = Math.min(raw, 0.05);
    this.last = now;
    // weak GPU: if the emblem's first frames run under ~35 fps (median, so a load stall doesn't count), drop to 1x pixels
    if (!this.tuned && this.group.visible && raw > 0) {
      (this.samples ??= []).push(raw);
      if (this.samples.length >= 60) {
        this.tuned = true;
        const med = this.samples.sort((a, b) => a - b)[30];
        if (med > 0.028 && this.renderer.getPixelRatio() > 1) {
          this.renderer.setPixelRatio(1); this.composer.setPixelRatio(1); this.smaa.enabled = false; this.resize();
        }
      }
    }
    const t = (this.time += dt), E = this.E;
    if (this.timers.length) {
      const due = this.timers.filter((x) => x.at <= t);
      if (due.length) { this.timers = this.timers.filter((x) => x.at > t); for (const x of due) x.fn(); }
    }
    this.tw.update(dt);

    // story: type the line, hold it, move on
    if (this.phase === "story") {
      if (this.typing) {
        this.typeAcc += dt * 40;
        while (this.typed < Math.min(this.typeAcc, this.chars.length)) this.chars[this.typed++].classList.add("on");
        if (this.typed >= this.chars.length) { this.typing = false; this.hold = 0; }
      } else if ((this.hold += dt) > 2.6 + this.chars.length * 0.014) this.nextBeat();
    }
    // loading line
    this.shownProgress += (this.progress - this.shownProgress) * (1 - Math.exp(-dt * 4));
    const pct = Math.floor(this.shownProgress * 100);
    if (pct !== this.pct) {
      this.pct = pct;
      this.$(".t-load").style.setProperty("--p", (pct / 100).toFixed(2));
      if (!this.ready) this.$(".t-load span").textContent = `Heating the forge · ${pct}%`;
    }

    // emblem placement + motion
    const L0 = this.layout(0), L1 = this.layout(1), k = E.layout;
    const s = lerp(L0.s, L1.s, k), g = this.group;
    g.position.set(0, lerp(L0.y, L1.y, k), 0);
    g.scale.setScalar(s);
    if (!this.down?.drag) this.spin *= Math.exp(-dt * 1.8);
    const rx = -this.ptr.y * 0.18 + Math.sin(t * 0.27) * 0.03, ry = this.ptr.x * 0.3 + Math.sin(t * 0.35) * 0.07 + this.spin;
    const follow = 1 - Math.exp(-dt * 4);
    g.rotation.x += (rx - g.rotation.x) * follow;
    g.rotation.y += (ry - g.rotation.y) * follow;

    // camera: dolly (enter), shake (strikes), a slow drift
    this.shake *= Math.exp(-dt * 9);
    const cam = this.camera;
    const cy = lerp(g.position.y, 0, E.cam);
    cam.position.set(Math.sin(t * 0.21) * 0.03 + rand(-1, 1) * this.shake, cy + Math.sin(t * 0.17) * 0.02 + rand(-1, 1) * this.shake, lerp(g.position.z + 0.4, CAM_Z, E.cam));
    cam.lookAt(0, cy, 0);

    // light: the forge flickers below; everything rises with `light`
    const fl = 0.86 + 0.14 * (Math.sin(t * 7.1) * 0.5 + Math.sin(t * 13.3 + 1.3) * 0.3 + Math.sin(t * 23.7 + 2.1) * 0.2);
    const lit = E.light * E.dim;
    this.hearth.intensity = (3 + 2.5 * E.kindle) * fl * E.light;
    this.key.intensity = 1.1 * lit;
    const envY = t * 0.05 + this.ptr.x * 0.35; // reflections slide as the pointer moves
    for (const m of Object.values(this.mats ?? {})) { m.envMapIntensity = lit * (m === this.mats.plateCap ? 0.8 : 1); m.envMapRotation.y = envY; }
    if (this.mats) this.mats.plateCap.emissiveIntensity = E.mold * (1.6 + 0.6 * fl);
    const U = this.U;
    U.uFill.value = E.fill; U.uCool.value = E.cool; U.uHeat.value = E.heat; U.uTime.value = t; U.uSweep.value = E.sweep;
    U.uStrike.value.w *= Math.exp(-dt * 2.2);

    const { H, W } = L0;
    this.glowBelow.position.set(0, -H * 0.62, -1.2);
    this.glowBelow.scale.set(W * 1.5, H * 1.15, 1);
    this.glowBelow.material.opacity = (0.16 + 0.14 * E.light + 0.16 * E.kindle) * fl;
    this.glowBack.position.set(0, g.position.y, -1.4);
    this.glowBack.scale.setScalar(s * 3.4);
    this.glowBack.material.opacity = 0.16 * E.light;

    // embers rise from the forge below the frame; more while it pours and when it is kindled
    const rate = (6 + 10 * E.light + 26 * E.kindle + (E.fill > 0 && E.fill < 1.05 ? 20 : 0)) * (REDUCED ? 0.4 : 1);
    this.emberAcc = (this.emberAcc ?? 0) + rate * dt;
    for (; this.emberAcc >= 1; this.emberAcc--) {
      const kk = rand(0.6, 1.2);
      this.embers.emit(rand(-W * 0.55, W * 0.55), -H * 0.55 - rand(0, 0.2), rand(-1.2, 0.6), rand(-0.05, 0.05), rand(0.18, 0.5), 0,
        1.8 * kk, 0.7 * kk, 0.22 * kk, rand(0.008, 0.02), rand(3, 6.5));
    }
    // sparks spit from the molten front while it rises
    if (this.mask && E.fill > 0.02 && E.fill < 1.02 && !REDUCED) {
      const { m, N } = this.mask, v = new THREE.Vector3();
      for (let i = 0; i < 6; i++) {
        const x = Math.random(), y = E.fill - 0.01;
        if (m[Math.floor((1 - y) * N) * N + Math.floor(x * N)] < 128 || Math.random() < 0.55) continue;
        g.localToWorld(v.set((x - 0.5) * BOX, (y - 0.5) * BOX, ART_D));
        const kk = rand(0.8, 1.2);
        this.sparks.emit(v.x, v.y, v.z, rand(-0.3, 0.3) * s, rand(0.3, 1.1) * s, rand(0.2, 0.7) * s, 2.6 * kk, 1.3 * kk, 0.5 * kk, rand(0.008, 0.016) * s, rand(0.3, 0.7));
      }
    }
    for (const sp of [...this.flashes, ...this.rings]) {
      const u = sp.userData;
      if (u.t >= u.dur) { sp.visible = false; continue; }
      u.t += dt;
      const kk = Math.min(1, u.t / u.dur);
      sp.visible = true;
      sp.scale.setScalar(lerp(u.s0, u.s1, EASE.out(kk)));
      sp.material.opacity = u.o * (1 - kk) ** 2;
    }
    const vs = viewportScale(cam, this.renderer);
    this.embers.update(dt, vs, t);
    this.sparks.update(dt, vs, t);
    this.souls.update(dt, t, g.position, s, vs);
    this.sound.crackle(t, E.light * 0.5 + E.kindle);

    if (!this.glLost) this.composer.render();
  }
}

// ------------------------------------------------------------------ boot
const root = document.getElementById("title");
const ON = !!root && Q.get("title") !== "0" && (!Q.has("debug") || Q.has("title"));

function bail(e) {
  if (e) console.error("[title] could not start; going straight to the hall", e);
  root?.remove();
  document.body.classList.remove("title-cover");
  document.documentElement.dataset.forgeTitle = "off";
  document.dispatchEvent(new Event("forge:enter"));
}

if (!ON) { root?.remove(); document.documentElement.dataset.forgeTitle = "off"; }
else {
  document.documentElement.dataset.forgeTitle = "on";
  document.body.classList.add("title-cover");
  try { window.forgeTitle = new TitleScreen(root); }
  catch (e) { bail(e); }
}
