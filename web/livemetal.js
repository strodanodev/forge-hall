// FORGE — live metals. The furnace badge, the gold trim and plaque frame, the copper pipes and the anvils (BK_Live) are
// not baked flat like the rest of the hall: Blender bakes their PBR maps (live_base / live_orm / live_normal) and an HDR
// reflection probe of the lit hall (env_probe.hdr), and they render as MeshStandardMaterial, so highlights slide across
// them as the camera moves and the hearth light flickers.
// The baked hall is display-referred (Blender's AgX view is in its atlases, drawn with NoToneMapping), so these materials
// run the same AgX curve in their own shader, after the same exposure, to sit in the same range as their surroundings.
import * as THREE from "three";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

const EXPOSURE = Math.pow(2, -0.3); // Blender view exposure -0.3 (scripts/forge_hall/p18d_lighting.py)

// AgX (three.js's port of Blender's AgX base) + a little of the "Punchy" look's saturation.
const AGX = /* glsl */ `
uniform float uForgeExposure;
vec3 forgeAgX(vec3 color) {
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
                          vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
                          vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
                           vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
                           vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = inset * (toRec2020 * (color * uForgeExposure));
  color = clamp((log2(max(color, vec3(1e-10))) - minEv) / (maxEv - minEv), 0.0, 1.0);
  vec3 x2 = color * color, x4 = x2 * x2;
  color = 15.5 * x4 * x2 - 40.14 * x4 * color + 31.96 * x4 - 6.868 * x2 * color + 0.4298 * x2 + 0.1191 * color - 0.00232;
  color = outset * color;
  color = mix(vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), color, 1.15);
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(fromRec2020 * color, 0.0, 1.0);
}
`;

// The probe is one point of view, so on its own it under-lights whatever faces away from mid-hall (the badge tilts up
// at a night sky). Blender's own baked lighting of these metals (the fallback atlas) carries the scene's real lights:
// it sets the base look, and the live PBR adds the view-dependent sheen on top. Both terms dim with material.color,
// which the pack sequence uses to turn the hall down.
const MIX = { baked: 0.72, live: 0.6 };

function withAgX(mat, baked) {
  const uniforms = {
    uForgeExposure: { value: EXPOSURE }, uBaked: { value: baked },
    uBakedMix: { value: MIX.baked }, uLiveMix: { value: MIX.live },
  };
  mat.userData.forge = uniforms; // ?debug tuning: forge live material .userData.forge.uBakedMix.value = ...
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = AGX + "uniform sampler2D uBaked;\nuniform float uBakedMix, uLiveMix;\n" +
      shader.fragmentShader.replace("#include <tonemapping_fragment>",
        "gl_FragColor.rgb = texture2D(uBaked, vMapUv).rgb * diffuse * uBakedMix + forgeAgX(gl_FragColor.rgb) * uLiveMix;");
  };
  mat.customProgramCacheKey = () => "forge-live-agx";
  return mat;
}

/**
 * Swap BK_Live's baked material for the live PBR one once its maps and probe have loaded. On any failure the baked
 * fallback stays (it is a complete, if static, version of the same metals).
 * @param {THREE.Mesh} mesh  BK_Live
 * @param {THREE.WebGLRenderer} renderer
 * @returns {Promise<THREE.MeshStandardMaterial>}
 */
export async function upgradeLiveMetals(mesh, renderer, base = "./assets/") {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = (name, srgb) => new THREE.TextureLoader().loadAsync(base + name).then((t) => {
    t.flipY = false; // the mesh carries glTF UVs (v flipped at export), same as the GLB's own textures
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    return t;
  });
  const [map, orm, normalMap, hdr] = await Promise.all([
    tex("live_base.webp", true), tex("live_orm.webp", false), tex("live_normal.webp", false),
    new RGBELoader().loadAsync(base + "env_probe.hdr"),
  ]);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(hdr).texture;
  pmrem.dispose();
  hdr.dispose();
  const old = mesh.material;
  const baked = old.emissiveMap; // the GLB's fallback: Blender's lit bake of these metals, display-referred
  if (!baked) throw new Error("BK_Live has no baked atlas");
  const mat = withAgX(new THREE.MeshStandardMaterial({
    name: "M_Live", map, envMap,
    aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, // ORM: R occlusion, G rough, B metal
    normalMap, normalScale: new THREE.Vector2(1, -1), // Blender bakes OpenGL tangent space; glTF UVs flip v
  }), baked);
  mesh.material = mat;
  old.dispose();
  return mat;
}
