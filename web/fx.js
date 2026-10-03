// FORGE — shared real-time FX: soft particle systems (allocation-free), textures, sprites. The hall's live effects
// are in forgefx.js.
import * as THREE from "three";

export const rand = (a, b) => a + Math.random() * (b - a);

function canvasTex(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const radial = (stops) => (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [p, a] of stops) r.addColorStop(p, `rgba(255,255,255,${a})`);
  g.fillStyle = r; g.fillRect(0, 0, s, s);
};
let cache = null;
/** Shared textures, built once. */
export function textures() {
  if (cache) return cache;
  cache = {
    dot: canvasTex(64, radial([[0, 1], [0.25, 0.8], [1, 0]])),
    glow: canvasTex(256, radial([[0, 0.95], [0.2, 0.45], [0.5, 0.12], [1, 0]])),
    ring: canvasTex(256, (g, s) => {
      const r = g.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
      r.addColorStop(0, "rgba(255,255,255,0)"); r.addColorStop(0.72, "rgba(255,255,255,.9)");
      r.addColorStop(0.82, "rgba(255,255,255,.35)"); r.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = r; g.fillRect(0, 0, s, s);
    }),
    rays: canvasTex(512, (g, s) => {
      g.translate(s / 2, s / 2);
      for (let i = 0; i < 28; i++) {
        g.rotate((Math.PI * 2) / 28 + rand(-0.05, 0.05));
        const len = s * rand(0.3, 0.5), w = rand(0.02, 0.06);
        const lg = g.createLinearGradient(0, 0, len, 0);
        lg.addColorStop(0, "rgba(255,255,255,.9)"); lg.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = lg;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(len, -len * w); g.lineTo(len, len * w); g.closePath(); g.fill();
      }
    }),
  };
  return cache;
}

export function sprite(map, color, scale, opacity = 0) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map, color: new THREE.Color(color), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  s.scale.setScalar(scale);
  s.renderOrder = 9;
  return s;
}

/** Pixels-per-metre-at-1m for the point-size shader: call once per frame. */
export function viewportScale(camera, renderer) {
  return (renderer.domElement.height) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

/**
 * Additive point particles with per-particle colour, size and a soft fade in/out, in one draw call.
 * Allocation-free: emit() takes scalars and writes into a ring buffer. Idle systems skip their update,
 * upload and draw entirely.
 */
export class Particles {
  /** cool: per-channel colour loss over life, e.g. [0.2, 0.8, 1] = embers cooling from orange to deep red */
  constructor(max, map, { gravity = 0, drag = 0, sway = 0, fadeIn = 0.1, renderOrder = 10, cool = null } = {}) {
    Object.assign(this, { max, gravity, drag, sway, fadeIn, cool });
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4); this.base = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.age = new Float32Array(max).fill(1); this.life = new Float32Array(max).fill(1);
    this.next = 0; this.live = 0; this.sizeDirty = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, uScale: { value: 800 } },
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.);
          gl_PointSize = aColor.a > 0.0 ? aSize*uScale/max(-mv.z,.1) : 0.0; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vC;
        void main(){ float a=texture2D(map,gl_PointCoord).a*vC.a; if(!(a>.003)) discard; gl_FragColor=vec4(max(vC.rgb,0.),min(a,1.)); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.visible = false;
  }
  emit(x, y, z, vx, vy, vz, r, g, b, size, life) {
    const i = this.next; this.next = (i + 1) % this.max;
    if (this.age[i] >= this.life[i]) this.live++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.base[i3] = r; this.base[i3 + 1] = g; this.base[i3 + 2] = b;
    this.size[i] = size; this.age[i] = 0; this.life[i] = life;
    this.sizeDirty = true;
  }
  update(dt, uScale, t = 0) {
    if (this.live === 0) { this.points.visible = false; return; }
    this.points.visible = true;
    this.mat.uniforms.uScale.value = uScale;
    const damp = Math.exp(-this.drag * dt), grav = this.gravity * dt, sway = this.sway * dt, fi = this.fadeIn;
    const { pos, vel, col, base, age, life } = this;
    for (let i = 0; i < this.max; i++) {
      const i4 = i * 4;
      if (age[i] >= life[i]) { col[i4 + 3] = 0; continue; }
      age[i] += dt;
      if (age[i] >= life[i]) { col[i4 + 3] = 0; this.live--; continue; }
      const k = age[i] / life[i], i3 = i * 3;
      vel[i3 + 1] -= grav;
      if (sway) { vel[i3] += Math.sin(t * 1.7 + i * 0.37) * sway; vel[i3 + 2] += Math.cos(t * 1.3 + i * 0.61) * sway; }
      vel[i3] *= damp; vel[i3 + 1] *= damp; vel[i3 + 2] *= damp;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const inv = 1 - k, c = this.cool;
      if (c) { col[i4] = base[i3] * (1 - k * c[0]); col[i4 + 1] = base[i3 + 1] * (1 - k * c[1]); col[i4 + 2] = base[i3 + 2] * (1 - k * c[2]); }
      else { col[i4] = base[i3]; col[i4 + 1] = base[i3 + 1]; col[i4 + 2] = base[i3 + 2]; }
      col[i4 + 3] = Math.min(1, k / fi) * inv * Math.sqrt(inv); // soft in, eased out: nothing pops
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true; a.aColor.needsUpdate = true;
    if (this.sizeDirty) { a.aSize.needsUpdate = true; this.sizeDirty = false; }
  }
  clear() { this.age.fill(1); this.col.fill(0); this.live = 0; this.points.visible = false; }
}

/**
 * GLB bytes from a URL that serves either the binary file (local dev) or the same bytes as base64 text: claude.ai
 * artifacts don't serve model/gltf-binary, so the hosted build publishes every .glb path as text/plain base64.
 */
export async function glbBytes(url, onProgress) {
  const res = await fetch(url);
  const buf = onProgress ? await readWithProgress(res, onProgress) : await res.arrayBuffer();
  const h = new Uint8Array(buf, 0, 4);
  if (h[0] === 0x67 && h[1] === 0x6c && h[2] === 0x54 && h[3] === 0x46) return buf; // "glTF" magic: binary as-is
  const bin = atob(new TextDecoder().decode(buf).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A fetch body read in chunks, reporting the fraction received (0..1) when the server sends a length. */
async function readWithProgress(res, onProgress) {
  const total = +res.headers.get("content-length") || 0;
  if (!total || !res.body?.getReader) return res.arrayBuffer();
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress(Math.min(got / total, 1)); // a compressed transfer can deliver more bytes than content-length
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

/**
 * Decode a GLB's embedded textures through <img> instead of fetch(). GLTFLoader's default ImageBitmapLoader
 * fetch()es each texture's blob: URL, and hosted artifacts' CSP refuses fetch of blob: (the hall rendered untextured
 * white there); an <img> may load blob:. TextureLoader is three's own path for Safari, so the textures are identical.
 */
export function imageTextures(loader) {
  return loader.register((parser) => {
    parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
    parser.textureLoader.setCrossOrigin(parser.options.crossOrigin);
    return { name: "forge_image_textures" };
  });
}
