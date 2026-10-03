// FORGE — the hearth's live fire: volumetric, ray-marched flames (vendored @wolffo/three-fire) replacing the baked
// scene's flat emissive flame cones. Those cones only read as fire while bloom smears them; dimmed (the pack turns the
// forge down so it can't blaze through cards and avatars) they showed as static triangles. A volumetric flame keeps
// its shape and motion at any brightness.
import * as THREE from "three";
import { FireMesh } from "./vendor/three-fire/vanilla.esm.js";

// Three overlapping flames fill the hearth mouth: a tall one in the middle, two lower ones either side, each with its
// own noise seed so they never move in lockstep. x/h/w in metres, fractions of the mouth where noted.
const FLAMES = [
  { x: -0.32, h: 1.1, w: 0.62, seed: 11.3, speed: 0.32 },
  { x: 0.0, h: 1.5, w: 0.72, seed: 3.7, speed: 0.36 },
  { x: 0.33, h: 1.15, w: 0.62, seed: 27.9, speed: 0.3 },
];
const BASE = new THREE.Color(1.0, 0.72, 0.42); // warm tint; the texture supplies the orange-to-yellow ramp

export class ForgeFire {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Box3} mouth  world bounds of the old flame meshes (the hearth mouth above the coal bed)
   * @param {{ iterations?: number, octaves?: number, intensity?: number, coals?: THREE.Mesh }} [o]
   *   iterations/octaves: ray-march steps and noise layers (quality vs cost; measured ~1-2 ms/frame at 14/3 on desktop)
   */
  constructor(scene, mouth, { iterations = 14, octaves = 3, intensity = 2.2, coals = null } = {}) {
    this.intensity = intensity;
    const tex = new THREE.TextureLoader().load("./assets/fx/fire.png");
    tex.colorSpace = THREE.SRGBColorSpace; // decoded to linear on sampling; OutputPass re-encodes
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex = tex;

    const c = mouth.getCenter(new THREE.Vector3()), size = mouth.getSize(new THREE.Vector3());
    const baseY = mouth.min.y - 0.04; // sink the roots into the coal bed
    this.flames = FLAMES.map((f) => {
      const fire = new FireMesh({ fireTex: tex, color: BASE.clone(), iterations, octaves, magnitude: 1.35 });
      fire.scale.set(f.w * (size.x / 1.45), f.h, size.z * 0.9);
      fire.position.set(c.x + f.x * (size.x / 1.45), baseY + f.h / 2, c.z);
      fire.material.uniforms.seed.value = f.seed;
      fire.material.uniforms.noiseScale.value.w = f.speed;
      // additive: overlapping flames add up and the bright core crosses the bloom threshold like real fire
      fire.material.blending = THREE.AdditiveBlending;
      // the library ships depthTest: false, which draws the flames over everything in front of the hearth (cards,
      // the pack, the arch). Test depth so whatever stands in front hides them; still no depth write (translucent).
      fire.material.depthTest = true;
      fire.renderOrder = 4;
      fire.frustumCulled = false; // the box is small and its bounds never change; skip the per-frame test
      scene.add(fire);
      return fire;
    });
    // The coal bed was a plain box glowing at 3x white: its flat top read as a lit panel and drowned the flames.
    // Live embers instead: dark crust, glowing cracks that drift and pulse.
    if (coals) {
      this.coals = coals;
      this.coalMat = emberMaterial();
      coals.material = this.coalMat;
    }
  }

  /**
   * @param {number} t      seconds
   * @param {number} level  0-1 forge level (pack.fireDim). The volume keeps its form when dim, so it floors at a
   *                        low smoulder instead of vanishing.
   */
  update(t, level = 1) {
    const k = this.intensity * (0.45 + 0.55 * level); // floor: a visible smoulder, never an empty mouth
    for (const f of this.flames) {
      f.update(t);
      f.material.uniforms.color.value.copy(BASE).multiplyScalar(k);
    }
    if (this.coalMat) {
      this.coalMat.uniforms.time.value = t;
      this.coalMat.uniforms.level.value = 0.3 + 0.7 * level;
    }
  }
}

function emberMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, level: { value: 1 } },
    vertexShader: `varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float time, level; varying vec3 vW;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main(){
        vec3 p = vW * 12.0;
        float n = vnoise(p + vec3(0.0, time * 0.15, 0.0)) * 0.6 + vnoise(p * 2.1 - vec3(time * 0.1)) * 0.4;
        // coal glows in thin seams between dark lumps: a ridge where the noise crosses its midline, not round blobs
        float seam = smoothstep(0.86, 0.985, 1.0 - abs(n - 0.5) * 2.0);
        float lump = smoothstep(0.72, 0.9, vnoise(p * 0.6 + 7.3)) * 0.35;   // a few lumps still hot through
        float heat = max(seam, lump);
        // glow lives on top of the bed; its sides are mostly crust (face normal from screen-space derivatives)
        vec3 nrm = normalize(cross(dFdx(vW), dFdy(vW)));
        heat *= mix(0.3, 1.0, smoothstep(0.4, 0.85, abs(nrm.y)));
        float pulse = 0.7 + 0.3 * sin(time * 1.4 + n * 13.0);             // embers breathe, out of phase
        vec3 crust = vec3(0.05, 0.016, 0.008);
        vec3 hot = mix(vec3(0.85, 0.18, 0.03), vec3(1.0, 0.55, 0.15), heat) * 1.4;
        gl_FragColor = vec4(mix(crust, hot * pulse, heat) * level, 1.0);
      }`,
  });
}

// The two wall torches on the centre columns: one small volumetric flame per torch, standing on the torch head where
// the baked FX_TorchFire cones were (one cluster of cone vertices per torch).
export class TorchFires {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Mesh} cones  FX_TorchFire (hidden here; its vertex clusters place the flames)
   */
  constructor(scene, cones, { iterations = 10, octaves = 2, intensity = 1.8 } = {}) {
    this.intensity = intensity;
    const tex = new THREE.TextureLoader().load("./assets/fx/fire.png");
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    cones.visible = false;
    cones.updateWorldMatrix(true, false);
    const pos = cones.geometry.attributes.position, v = new THREE.Vector3(), boxes = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(cones.matrixWorld);
      const hit = boxes.find((b) => b.distanceToPoint(v) < 0.3);
      if (hit) hit.expandByPoint(v); else boxes.push(new THREE.Box3(v.clone(), v.clone()));
    }
    this.flames = boxes.map((b, i) => {
      const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
      const w = Math.max(s.x, s.z) * 1.6, h = s.y * 1.35;
      const fire = new FireMesh({ fireTex: tex, color: BASE.clone(), iterations, octaves, magnitude: 1.3 });
      fire.scale.set(w, h, w);
      fire.position.set(c.x, b.min.y - 0.03 + h / 2, c.z);
      fire.material.uniforms.seed.value = 5.1 + i * 17.3;
      fire.material.uniforms.noiseScale.value.w = 0.45;
      fire.material.blending = THREE.AdditiveBlending;
      fire.material.depthTest = true; // see ForgeFire: the library ships depthTest false
      fire.renderOrder = 4;
      fire.frustumCulled = false;
      scene.add(fire);
      return fire;
    });
  }

  update(t, level = 1) {
    const k = this.intensity * (0.6 + 0.4 * level); // torches dim less than the forge when the pack turns it down
    for (const f of this.flames) {
      f.update(t);
      f.material.uniforms.color.value.copy(BASE).multiplyScalar(k);
    }
  }
}
