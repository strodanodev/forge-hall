// FORGE — the hall's live effects: lightning arcs on Zeus's anvil, hammer-strike spark streaks, embers that pop,
// cool and die, molten lava cracks, coal-bed pops, the hearth's rising embers and heat haze.
//
// The baked scene shipped these as static meshes (FX_Lightning rods, FX_Ember beads, FX_Spark shapes, FX_LavaCrack
// strips) that could only blink or pulse. They are hidden here and used as ANCHORS: every live effect spawns where the
// artist put its static stand-in (the scene's FXM_* markers did not survive glTF optimisation).
import * as THREE from "three";
import { Particles, rand, sprite, textures } from "./fx.js";

// ------------------------------------------------------------------ anchors from baked meshes
/** Connected pieces of a joined mesh, as arrays of world-space vertices. */
function islands(mesh) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position, n = pos.count;
  const idx = mesh.geometry.index ? mesh.geometry.index.array : Array.from({ length: n }, (_, i) => i);
  const key = (i) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const keys = new Array(n);
  for (let i = 0; i < n; i++) { keys[i] = key(i); if (!parent.has(keys[i])) parent.set(keys[i], keys[i]); }
  for (let t = 0; t < idx.length; t += 3) {
    for (const j of [1, 2]) { const a = find(keys[idx[t]]), b = find(keys[idx[t + j]]); if (a !== b) parent.set(a, b); }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(keys[i]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  }
  return [...groups.values()];
}
const centre = (pts) => pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);

// ------------------------------------------------------------------ spark streaks
/**
 * Sparks as motion streaks: each is a line from its position back along its velocity, bright head to clear tail,
 * so fast sparks read as streaks and slow ones as points. Gravity + drag, colour cools over life. One draw call.
 */
export class Streaks {
  constructor(max, { gravity = 7, drag = 0.5, tail = 0.035, cool = [0.1, 0.55, 0.9] } = {}) {
    Object.assign(this, { max, gravity, drag, tail, cool });
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.base = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(1); this.life = new Float32Array(max).fill(1);
    this.pos = new Float32Array(max * 6); this.col = new Float32Array(max * 8);
    this.next = 0; this.live = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
      vertexShader: `attribute vec4 aColor; varying vec4 vC; void main(){ vC = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec4 vC; void main(){ if (!(vC.a > 0.002)) discard; gl_FragColor = vec4(max(vC.rgb, 0.0), min(vC.a, 1.0)); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
  }
  emit(x, y, z, vx, vy, vz, r, g, b, life) {
    const i = this.next; this.next = (i + 1) % this.max;
    if (this.age[i] >= this.life[i]) this.live++;
    const i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.base[i3] = r; this.base[i3 + 1] = g; this.base[i3 + 2] = b;
    this.age[i] = 0; this.life[i] = life;
  }
  update(dt) {
    if (this.live === 0) { this.lines.visible = false; return; }
    this.lines.visible = true;
    const { p, v, base, age, life, pos, col, cool, tail } = this, damp = Math.exp(-this.drag * dt), g = this.gravity * dt;
    for (let i = 0; i < this.max; i++) {
      const i6 = i * 6, i8 = i * 8;
      if (age[i] >= life[i]) { col[i8 + 3] = col[i8 + 7] = 0; continue; }
      age[i] += dt;
      if (age[i] >= life[i]) { col[i8 + 3] = col[i8 + 7] = 0; this.live--; continue; }
      const i3 = i * 3, k = age[i] / life[i];
      v[i3 + 1] -= g; v[i3] *= damp; v[i3 + 1] *= damp; v[i3 + 2] *= damp;
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
      pos[i6] = p[i3]; pos[i6 + 1] = p[i3 + 1]; pos[i6 + 2] = p[i3 + 2];
      pos[i6 + 3] = p[i3] - v[i3] * tail; pos[i6 + 4] = p[i3 + 1] - v[i3 + 1] * tail; pos[i6 + 5] = p[i3 + 2] - v[i3 + 2] * tail;
      const a = (1 - k) * Math.min(1, k * 30);
      for (let c = 0; c < 3; c++) { const val = base[i3 + c] * (1 - k * cool[c]); col[i8 + c] = val; col[i8 + 4 + c] = val; }
      col[i8 + 3] = a; col[i8 + 7] = 0; // head bright, tail clear
    }
    const at = this.lines.geometry.attributes;
    at.position.needsUpdate = true; at.aColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ lightning arcs
const SEGS = 16; // points per arc = SEGS + 1 (midpoint displacement needs a power of two)
const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _t = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Vector3();

/** Jagged path a -> b by midpoint displacement into `out` (SEGS + 1 preallocated vectors). */
function boltPath(out, a, b, rough) {
  out[0].copy(a); out[SEGS].copy(b);
  for (let step = SEGS / 2; step >= 1; step /= 2) {
    for (let i = step; i < SEGS; i += step * 2) {
      const p0 = out[i - step], p1 = out[i + step];
      _d.subVectors(p1, p0); const len = _d.length(); _d.multiplyScalar(1 / (len || 1));
      _r.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)); _r.addScaledVector(_d, -_r.dot(_d)).normalize();
      out[i].addVectors(p0, p1).multiplyScalar(0.5).addScaledVector(_r, len * rough * rand(-1, 1));
    }
  }
}

/**
 * Lightning as camera-facing ribbons: a white-hot core inside a blue glow, rebuilt every frame from paths that are
 * regenerated several times a second. One draw call for every arc.
 */
export class Arcs {
  constructor(count) {
    this.count = count;
    this.paths = Array.from({ length: count }, () => Array.from({ length: SEGS + 1 }, () => new THREE.Vector3()));
    this.width = new Float32Array(count); this.alpha = new Float32Array(count);
    const verts = count * (SEGS + 1) * 2;
    this.pos = new Float32Array(verts * 3); this.a = new Float32Array(verts);
    const side = new Float32Array(verts), along = new Float32Array(verts), index = [];
    for (let k = 0; k < count; k++) {
      for (let j = 0; j <= SEGS; j++) {
        const v = (k * (SEGS + 1) + j) * 2;
        side[v] = -1; side[v + 1] = 1; along[v] = along[v + 1] = j / SEGS;
        if (j < SEGS) index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.a, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geo.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { core: { value: new THREE.Color(0.85, 0.93, 1.0).multiplyScalar(3.2) }, glow: { value: new THREE.Color(0.3, 0.55, 1.0).multiplyScalar(1.6) } },
      vertexShader: `attribute float aSide, aAlpha, aAlong; varying float vS, vA;
        void main(){ vS = aSide; vA = aAlpha * smoothstep(0.0, 0.06, aAlong); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 core, glow; varying float vS, vA;
        void main(){ float d = abs(vS); float c = 1.0 - smoothstep(0.0, 0.2, d); float g = pow(1.0 - d, 2.2);
          vec3 col = (glow * g + core * c) * vA; if (!(vA > 0.002)) discard; gl_FragColor = vec4(col, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }
  set(k, a, b, rough, width, alpha) { boltPath(this.paths[k], a, b, rough); this.width[k] = width; this.alpha[k] = alpha; }
  /** Rebuild the ribbons facing `eye`. */
  update(eye) {
    const { pos, a } = this;
    for (let k = 0; k < this.count; k++) {
      const P = this.paths[k], w = this.width[k], al = this.alpha[k];
      for (let j = 0; j <= SEGS; j++) {
        const v = (k * (SEGS + 1) + j) * 2;
        a[v] = a[v + 1] = al;
        if (al <= 0) continue;
        _t.subVectors(P[Math.min(SEGS, j + 1)], P[Math.max(0, j - 1)]);
        _c.subVectors(eye, P[j]);
        _s.crossVectors(_t, _c).normalize().multiplyScalar(w * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, j / SEGS + 0.08))));
        pos[v * 3] = P[j].x - _s.x; pos[v * 3 + 1] = P[j].y - _s.y; pos[v * 3 + 2] = P[j].z - _s.z;
        pos[v * 3 + 3] = P[j].x + _s.x; pos[v * 3 + 4] = P[j].y + _s.y; pos[v * 3 + 5] = P[j].z + _s.z;
      }
    }
    const at = this.mesh.geometry.attributes;
    at.position.needsUpdate = true; at.aAlpha.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ molten lava
function lavaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, level: { value: 1 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float time, level; varying vec3 vW;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main(){
        // molten rock creeping down the cracks: noise scrolls downward, a slower layer makes the glow surge
        vec3 p = vec3(vW.x * 4.0, vW.y * 2.4 + time * 0.55, vW.z * 4.0);
        float flow = vnoise(p) * 0.65 + vnoise(p * 2.7 + vec3(0.0, time * 0.4, 0.0)) * 0.35;
        float surge = 0.75 + 0.25 * sin(time * 0.9 + vW.y * 3.0 + vW.x * 1.7);
        float heat = smoothstep(0.25, 0.85, flow) * surge;
        // never below a dull molten red: from the game camera only slivers of these cracks show, and they must read hot
        vec3 col = mix(vec3(0.9, 0.12, 0.02), mix(vec3(1.0, 0.36, 0.06), vec3(1.0, 0.75, 0.32), heat), heat) * (1.1 + 2.4 * heat);
        gl_FragColor = vec4(col * level, 1.0);
      }`,
  });
}

// ------------------------------------------------------------------ the hall
const HOT = [1.0, 0.72, 0.32], BLUE = [0.45, 0.7, 1.0];

export class ForgeAmbience {
  /**
   * @param {THREE.Scene} scene
   * @param {{mouth: THREE.Vector3, smoke: THREE.Vector3}} at  hearth mouth + heat-haze centre
   * @param {{lightning: THREE.Mesh[], spark: THREE.Mesh[], ember: THREE.Mesh[], flicker: THREE.Mesh[]}} fx
   *   baked FX_* meshes; the static stand-ins are hidden and become spawn anchors (lava cracks leave fx.flicker)
   */
  constructor(scene, at, fx) {
    const T = textures();
    this.at = at;
    this.t = 0;

    // --- anchors
    this.arcs = [];                    // lightning: root on the anvil top -> tip where the static rod pointed
    for (const m of fx.lightning) {
      for (const pts of islands(m)) {
        const root = pts.reduce((lo, p) => (p.y < lo.y ? p : lo));
        const tip = pts.reduce((far, p) => (p.distanceToSquared(root) > far.distanceToSquared(root) ? p : far));
        this.arcs.push({ root: root.clone(), tip: tip.clone(), on: 0, next: rand(0, 0.5), regen: 0 });
      }
      m.visible = false;
    }
    const roots = this.arcs.map((a) => a.root);
    this.anvilTop = roots.length ? centre(roots) : new THREE.Vector3(-2.3, 1.16, 1.4);
    const sparkPts = fx.spark.flatMap((m) => { m.visible = false; return islands(m).map(centre); });
    this.hammer = sparkPts.length ? centre(sparkPts) : new THREE.Vector3(-1.95, 0.9, 0.1);
    // the static spark shapes floated above the anvil: cast straight down onto the hall to find its striking face
    const hall = []; scene.traverse((o) => { if (o.isMesh && o.name.startsWith("BK_")) hall.push(o); });
    const hit = new THREE.Raycaster(this.hammer.clone().setY(this.hammer.y + 0.6), new THREE.Vector3(0, -1, 0))
      .intersectObjects(hall, false)[0];
    if (hit) this.hammer.y = hit.point.y + 0.02;
    this.emberSites = fx.ember.flatMap((m) => { m.visible = false; return islands(m).map(centre); });
    const coals = fx.flicker.find((o) => /FX_Coals$/.test(o.name));
    this.coalBox = coals ? new THREE.Box3().setFromObject(coals) : null;
    this.lava = fx.flicker.filter((o) => /LavaCrack/.test(o.name));
    fx.flicker = fx.flicker.filter((o) => !this.lava.includes(o)); // the lava shader animates them now
    this.lavaMat = lavaMaterial();
    for (const m of this.lava) m.material = this.lavaMat;

    // --- systems
    this.mouthEmbers = new Particles(260, T.dot, { drag: 0.25, gravity: -0.12, sway: 0.9, fadeIn: 0.15, cool: [0.25, 0.75, 1] });
    this.haze = new Particles(48, T.glow, { drag: 0.1, sway: 0.15, fadeIn: 0.3, renderOrder: 8 });
    this.floorEmbers = new Particles(260, T.dot, { drag: 0.35, sway: 0.45, fadeIn: 0.2, cool: [0.35, 0.9, 1] });
    this.pops = new Particles(160, T.dot, { gravity: 3.2, drag: 0.5, fadeIn: 0.05, cool: [0.2, 0.8, 1] });
    this.streaks = new Streaks(420, { tail: 0.05 });
    this.boltSparks = new Particles(160, T.dot, { gravity: 2.5, drag: 1.4, fadeIn: 0.02, cool: [0.6, 0.35, 0] });
    this.bolt = new Arcs(this.arcs.length + 5); // anchor arcs + strike trunk + 4 branches
    this.flare = sprite(T.glow, 0x9fd0ff, 0.9);  // flash at the strike point
    this.spark = sprite(T.glow, 0xffb060, 0.7);   // flash at the hammer point
    this.systems = [this.mouthEmbers, this.haze, this.floorEmbers, this.pops, this.boltSparks];
    for (const s of this.systems) scene.add(s.points);
    scene.add(this.streaks.lines, this.bolt.mesh, this.flare, this.spark);
    this.flare.position.copy(this.anvilTop); this.spark.position.copy(this.hammer);
    // lights for anything that is NOT baked (cards, avatars): always in the scene so the light count never changes
    this.boltLight = new THREE.PointLight(0x9fcfff, 0, 6, 1.6); this.boltLight.position.copy(this.anvilTop).y += 0.4;
    this.hammerLight = new THREE.PointLight(0xffa050, 0, 4, 1.8); this.hammerLight.position.copy(this.hammer).y += 0.25;
    scene.add(this.boltLight, this.hammerLight);

    this.acc = { mouth: 0, haze: 0, floor: 0, pops: 0 };
    this.nextHammer = 0.8; this.nextStrike = 1.5; this.strike = null; this.nextCoalPop = 0.5;
    this.trunkA = new THREE.Vector3(); this.trunkB = new THREE.Vector3(); this.tmp = new THREE.Vector3(); this.tmp2 = new THREE.Vector3();
    // pre-warm: the hall should open mid-effect, not with embers just starting to rise
    for (let i = 0; i < 120; i++) this.update(1 / 30, i / 30, 800, 1, null);
  }

  /**
   * @param {number} level  0-1 forge level (pack.fireDim): the pack turns the hall down so FX can't blaze through it
   * @param {THREE.Camera|null} camera  lightning ribbons face it
   */
  update(dt, t, uScale, level = 1, camera = null) {
    const { mouth, smoke } = this.at, lv = 0.35 + 0.65 * level;
    this.t = t;

    // --- hearth: embers drift up out of the mouth and cool as they rise; low red haze over the lava
    this.acc.mouth += dt * 30;
    for (; this.acc.mouth >= 1; this.acc.mouth--) {
      const h = rand(1.4, 2.8) * lv;
      this.mouthEmbers.emit(mouth.x + rand(-0.55, 0.55), mouth.y + rand(0.45, 0.9), mouth.z + rand(0.1, 0.45),
        rand(-0.18, 0.18), rand(0.45, 1.05), rand(-0.08, 0.3), h, 0.45 * h, 0.12 * h, rand(0.016, 0.036), rand(2.0, 3.6));
    }
    this.acc.haze += dt * 5;
    for (; this.acc.haze >= 1; this.acc.haze--) {
      const k = rand(0.1, 0.2) * lv;
      this.haze.emit(smoke.x + rand(-1.1, 1.1), smoke.y + rand(-0.2, 0.3), smoke.z + rand(-0.7, 0.7),
        rand(-0.05, 0.05), rand(0.08, 0.2), rand(-0.05, 0.05), k, 0.14 * k, 0.05 * k, rand(0.7, 1.2), rand(4, 6));
    }
    // coal bed: a knot pops every half-second or so, spitting a few sparks up into the flames
    if (this.coalBox && t >= this.nextCoalPop) {
      this.nextCoalPop = t + rand(0.35, 1.1);
      const b = this.coalBox, x = rand(b.min.x + 0.15, b.max.x - 0.15), z = rand(b.min.z + 0.1, b.max.z - 0.1);
      for (let i = 0, n = Math.round(rand(3, 8)); i < n; i++) {
        const h = rand(2, 3.5) * lv;
        this.streaks.emit(x, b.max.y, z, rand(-0.5, 0.5), rand(1.6, 3.2), rand(-0.3, 0.5), h, 0.7 * h, 0.3 * h, rand(0.4, 0.8));
      }
    }

    // --- the ember cloud around the right anvil (the old static beads hung frozen in mid-air here): embers float up
    // through it on the heat, sway, cool from orange to deep red and die; now and then a hot one pops out in an arc
    if (this.emberSites.length) {
      this.acc.floor += dt * 26;
      for (; this.acc.floor >= 1; this.acc.floor--) {
        const s = this.emberSites[(Math.random() * this.emberSites.length) | 0], h = rand(1.5, 3.0) * lv;
        this.floorEmbers.emit(s.x + rand(-0.06, 0.06), s.y, s.z + rand(-0.06, 0.06), rand(-0.05, 0.05), rand(0.1, 0.34), rand(-0.05, 0.05),
          h, 0.4 * h, 0.1 * h, rand(0.035, 0.065), rand(2.4, 4.4));
      }
      this.acc.pops += dt * 6;
      for (; this.acc.pops >= 1; this.acc.pops--) {
        const s = this.emberSites[(Math.random() * this.emberSites.length) | 0], h = rand(2.2, 3.6) * lv;
        this.pops.emit(s.x, s.y + 0.02, s.z, rand(-0.4, 0.4), rand(0.8, 1.7), rand(-0.4, 0.4), h, 0.6 * h, 0.18 * h, rand(0.018, 0.03), rand(0.7, 1.4));
      }
    }

    // --- hammer rhythm: every ~1.1-1.9 s a strike throws a fan of streaking sparks, a flash and a light pulse
    if (t >= this.nextHammer) {
      this.nextHammer = t + rand(1.1, 1.9);
      const p = this.hammer;
      for (let i = 0, n = Math.round(rand(34, 52)); i < n; i++) {
        const a = rand(0, Math.PI * 2), up = rand(0.25, 1), sp = rand(1.8, 4.6), h = rand(2.4, 4.5);
        this.streaks.emit(p.x + rand(-0.05, 0.05), p.y, p.z + rand(-0.05, 0.05),
          Math.cos(a) * sp * (1.1 - up * 0.6), up * sp, Math.sin(a) * sp * (1.1 - up * 0.6), h * HOT[0], h * HOT[1], h * HOT[2], rand(0.35, 0.95));
      }
      this.hammerFlash = 1;
    }
    this.hammerFlash = Math.max(0, (this.hammerFlash ?? 0) - dt * 8);
    this.spark.material.opacity = this.hammerFlash * 0.9;
    this.spark.scale.setScalar(0.45 + 0.5 * (1 - this.hammerFlash));
    this.hammerLight.intensity = 14 * this.hammerFlash;

    // --- lightning: the anvil crackles constantly (each arc flickers on/off with fresh paths), and every few seconds
    // a bolt comes down onto it with branches, a flash, a light pulse and a burst of blue sparks
    const arcs = this.arcs, B = this.bolt;
    for (let k = 0; k < arcs.length; k++) {
      const a = arcs[k];
      if (t >= a.next) {
        a.on = a.on ? 0 : 1;
        a.next = t + (a.on ? rand(0.05, 0.22) : rand(0.08, 0.7));
        a.regen = 0;
      }
      if (a.on && t >= a.regen) {
        a.regen = t + rand(0.03, 0.07);
        this.tmp.copy(a.tip).add(this.tmp2.set(rand(-0.12, 0.12), rand(-0.08, 0.14), rand(-0.12, 0.12)));
        B.set(k, a.root, this.tmp, rand(0.16, 0.3), rand(0.018, 0.03), rand(0.45, 1.0) * lv);
      } else if (!a.on) B.alpha[k] = 0;
    }
    const trunk = arcs.length;
    if (!this.strike && t >= this.nextStrike) {
      this.strike = { end: t + rand(0.22, 0.38), regen: 0 };
      this.nextStrike = this.strike.end + rand(2.0, 4.2);
      this.trunkA.copy(this.anvilTop).add(this.tmp.set(rand(-0.35, 0.35), rand(1.6, 2.1), rand(-0.3, 0.3)));
      this.trunkB.copy(this.anvilTop).add(this.tmp.set(rand(-0.12, 0.12), 0.02, rand(-0.1, 0.1)));
      for (let i = 0; i < 26; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(0.8, 2.6), h = rand(2.5, 4) * lv;
        this.boltSparks.emit(this.trunkB.x, this.trunkB.y, this.trunkB.z, Math.cos(a) * sp, rand(0.3, 1.8), Math.sin(a) * sp,
          h * BLUE[0], h * BLUE[1], h * BLUE[2], rand(0.012, 0.026), rand(0.25, 0.6));
      }
      this.flash = 1;
    }
    if (this.strike) {
      if (t >= this.strike.regen) { // the trunk re-forks a few times while it lasts: that's what makes lightning flicker
        this.strike.regen = t + rand(0.04, 0.08);
        const al = rand(0.7, 1.0) * lv;
        B.set(trunk, this.trunkA, this.trunkB, 0.2, rand(0.045, 0.06), al);
        for (let b = 1; b <= 4; b++) {
          const from = B.paths[trunk][(rand(3, 12)) | 0];
          this.tmp.copy(from).add(this.tmp2.set(rand(-0.6, 0.6), rand(-0.7, -0.2), rand(-0.5, 0.5)));
          B.set(trunk + b, from, this.tmp, 0.28, rand(0.02, 0.032), Math.random() < 0.75 ? al * 0.6 : 0);
        }
        for (const a of arcs) { a.on = 1; a.next = Math.max(a.next, t + 0.05); } // everything on the anvil lights up
      }
      if (t >= this.strike.end) { this.strike = null; for (let b = 0; b <= 4; b++) B.alpha[trunk + b] = 0; }
    }
    this.flash = Math.max(0, (this.flash ?? 0) - dt * 4.5);
    this.flare.material.opacity = this.flash * 0.85 * lv;
    this.flare.scale.setScalar(0.7 + 0.8 * (1 - this.flash));
    this.boltLight.intensity = (this.flash * 30 + (this.strike ? 10 : 0)) * lv;
    if (camera) B.update(camera.position);

    // --- lava creeps down the cracks
    this.lavaMat.uniforms.time.value = t;
    this.lavaMat.uniforms.level.value = 0.4 + 0.6 * level;

    for (const s of this.systems) s.update(dt, uScale, t);
    this.streaks.update(dt);
  }
}
