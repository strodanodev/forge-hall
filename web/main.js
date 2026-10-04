// FORGE Hall — three.js runtime for the baked Blender scene.
// Baked surfaces are unlit (lighting lives in the textures); FX_* meshes glow and animate; the metals in BK_Live are
// lit live (livemetal.js) so they reflect the hall as the camera moves.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { PackOpening } from "./pack.js";
import { glbBytes, imageTextures, viewportScale } from "./fx.js";
import { ForgeAmbience } from "./forgefx.js";
import { ForgeNPC } from "./npc.js";
import { ForgeFire, TorchFires } from "./forgefire.js";
import { upgradeLiveMetals } from "./livemetal.js";
import { loadCollection } from "./rapture.js";
import { createShop } from "./shopflow.js";
import { mountWalletUI } from "./walletui.js";
import { mountLibrary } from "./library.js";
import { loadSets } from "./collections.js";

// phones / small touch screens get the 1024-atlas variant (~1/4 the texture memory)
const SMALL = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 900;
const SCENE_URL = `./assets/forge_hall${SMALL ? "_1k" : ""}.glb`;
const SKY_URL = "./assets/sky.webp";

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // 2x cost ~1.8x the fill for little visible gain under bloom
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // bake already carries the final grade (AgX); live metals apply their own
renderer.info.autoReset = false; // count every pass of the frame, not just the last
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
let camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);

// ---------------------------------------------------------------- sky
new THREE.TextureLoader().load(SKY_URL, (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  scene.background = t;
});

// ---------------------------------------------------------------- post
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.82);
// Bloom is a blur: run its whole mip chain at half resolution (1/4 the pixels), it looks the same.
const bloomSetSize = bloom.setSize.bind(bloom);
bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
bloom.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
composer.addPass(bloom);
composer.addPass(new OutputPass());
// The renderer's own `antialias` only covers drawing straight to the canvas; every frame here goes through the
// composer, so anti-alias at the end instead. Without it thin geometry (Mortal wireframes, card edges) crawls and
// sparkles as it turns, and bloom magnifies each sparkle into visible jitter. (MSAA composer targets were tried and
// dropped: their multisample buffers intermittently rendered the whole frame black in Chrome.)
composer.addPass(new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio()));

// ---------------------------------------------------------------- load
const fx = { flicker: [], pulse: [], lightning: [], spark: [], ember: [] };
let pack, ambience, npc;
let forgeFire = null, torchFires = null;
let controls;
let bytes = 0;

// the Rapture ARC 1 snapshot (pack contents) loads alongside the hall
const collectionReady = loadCollection();
// the live pack shop (wallet + PackShop contract) loads beside it; without a deployed shop it resolves a preview-only object
const shopReady = collectionReady.then((collection) => createShop({ collection }));
const loader = imageTextures(new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));
// the title screen (title.js) covers the hall while it loads: tell it how far along we are, and hold AERIS until the
// player has entered (html[data-forge-title] is "on" while it shows)
const loadProgress = (f) => document.dispatchEvent(new CustomEvent("forge:progress", { detail: f }));
const entered = new Promise((done) => {
  if (document.documentElement.dataset.forgeTitle === "on") document.addEventListener("forge:enter", done, { once: true });
  else done();
});
glbBytes(SCENE_URL, (f) => loadProgress(0.8 * f)).then((buf) => { bytes = buf.byteLength; return loader.parseAsync(buf, "./assets/"); }).then(async (gltf) => {
  loadProgress(0.88);
  scene.add(gltf.scene);
  const find = (n) => gltf.scene.getObjectByName(n);

  if (gltf.cameras.length) {
    const c = gltf.cameras[0];
    camera = new THREE.PerspectiveCamera(c.fov, innerWidth / innerHeight, 0.1, 500);
    c.getWorldPosition(camera.position);
    c.getWorldQuaternion(camera.quaternion);
    renderPass.camera = camera;
  }
  const target = camera.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(11));
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 6;
  controls.maxDistance = 14;
  controls.minPolarAngle = Math.PI * 0.36;
  controls.maxPolarAngle = Math.PI * 0.53;
  const az = controls.getAzimuthalAngle();
  controls.minAzimuthAngle = az - 0.45;
  controls.maxAzimuthAngle = az + 0.45;

  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = true;
    if (o.name.startsWith("FX_")) {
      const m = o.material;
      m.userData.base = m.emissiveIntensity ?? 1;
      if (/Fire|Coals|LavaCrack/.test(o.name)) fx.flicker.push(o);
      else if (/Crystal/.test(o.name)) fx.pulse.push(o);
      else if (/Lightning/.test(o.name)) fx.lightning.push(o);
      else if (/Spark/.test(o.name)) fx.spark.push(o);
      else fx.ember.push(o);
    }
  });
  // the metals in BK_Live switch to live PBR once their maps + reflection probe load; the baked look stays on failure
  const live = find("BK_Live");
  const liveReady = live ? upgradeLiveMetals(live, renderer).catch((e) => console.warn("[live metals] keeping the baked look", e)) : null;

  const at = (n, fallback) => (find(n)?.getWorldPosition(new THREE.Vector3())) ?? fallback;
  const mouth = at("FXM_ForgeMouth", new THREE.Vector3(0, 1.2, -0.6));
  const smoke = at("FXM_Smoke", new THREE.Vector3(1.35, 0.55, -0.25));
  // lightning, sparks, embers and lava anchor on the baked FX meshes themselves (the FXM_* markers don't survive
  // glTF optimisation); only the hearth mouth + haze centre come from here
  ambience = new ForgeAmbience(scene, { mouth, smoke }, fx);
  // Live volumetric fire in the hearth mouth replaces the baked flat flame cones (?fire=classic keeps the cones).
  if (new URLSearchParams(location.search).get("fire") !== "classic") {
    const cones = fx.flicker.filter((o) => /FX_Fire$/.test(o.name));
    if (cones.length) {
      const bounds = new THREE.Box3();
      for (const o of cones) { bounds.expandByObject(o); o.visible = false; }
      fx.flicker = fx.flicker.filter((o) => !cones.includes(o));
      const coals = fx.flicker.find((o) => /FX_Coals$/.test(o.name));
      if (coals) fx.flicker = fx.flicker.filter((o) => o !== coals); // the ember shader animates them now
      forgeFire = new ForgeFire(scene, bounds, { coals, ...(SMALL ? { iterations: 10, octaves: 2 } : {}) });
    }
    // the wall torches on the centre columns get small live flames too
    const torches = find("FX_TorchFire");
    if (torches) {
      fx.flicker = fx.flicker.filter((o) => o !== torches);
      torchFires = new TorchFires(scene, torches, SMALL ? { iterations: 8 } : {});
    }
  }

  // light rig for anything that is NOT baked (pack cards now, characters later): sky fill + hearth glow
  scene.add(new THREE.HemisphereLight(0xa9c2ff, 0x3a2318, 1.1));
  const hearthLight = new THREE.PointLight(0xff7a2a, 30, 14, 1.8);
  hearthLight.position.copy(mouth).add(new THREE.Vector3(0, 0.3, 0.8));
  scene.add(hearthLight);
  fx.hearthLight = hearthLight;

  await liveReady; // before the pack collects the hall's materials (it dims them via .color)
  loadProgress(0.92);
  const hallMaterials = [];
  gltf.scene.traverse((o) => { if (o.isMesh && o.name.startsWith("BK_") && !hallMaterials.includes(o.material)) hallMaterials.push(o.material); });
  const shop = await shopReady;
  pack = new PackOpening({
    collection: shop.adaptCollection(await collectionReady), shop, panelEl: document.getElementById("card-panel"),
    scene, getCamera: () => camera, controls, bloom, hallMaterials,
    anchor: mouth.clone().add(new THREE.Vector3(0, 0.35, 3.0)),  // floats over the medallion, in front of the hearth
    ui: document.getElementById("pack-ui"), flash: document.getElementById("flash"),
    vignette: document.getElementById("vignette"), canvas: renderer.domElement,
  });
  pack.warmup(renderer, composer); // compile + upload everything the sequence uses now, not mid-animation
  loadProgress(0.96);
  const openBtn = document.getElementById("open-pack");
  openBtn.disabled = false;
  document.body.classList.toggle("live-shop", shop.live);   // phone layout: two rows of buttons need more room
  // status line above the buttons (wallet prompts, waiting on the chain, errors) + the wallet button
  const status = document.getElementById("chain-status");
  let statusTimer = 0;
  const say = (text, tone = "info") => {
    clearTimeout(statusTimer);
    status.textContent = text || "";
    status.className = tone === "error" ? "error" : "";
    status.hidden = !text;
    if (text && tone !== "error") statusTimer = setTimeout(() => { status.hidden = true; }, 8000);
  };
  pack.events.addEventListener("status", (e) => say(e.detail.text, e.detail.tone));
  status.addEventListener("click", () => { if (status.classList.contains("error")) say(""); });
  mountWalletUI(document.getElementById("wallet"), shop, say);
  // the Card Library: a wallet's collection over the hall (library.js). It only reads; the wallet button above owns connecting.
  let library = null;
  try {
    library = mountLibrary({ sets: await loadSets({ primary: pack.collection, load: loadCollection }), shop, pack, say });
    library?.onToggle((open) => renderer.setAnimationLoop(open ? null : frame));   // nothing to draw behind the overlay
  } catch (e) { console.error("[library] could not start; the hall carries on without it", e); }
  const syncOpen = () => {
    if (pack.state !== "idle" && pack.state !== "sealed") return;
    const sub = shop.subLabel();
    openBtn.replaceChildren(shop.label(), ...(sub ? [Object.assign(document.createElement("small"), { className: "btn-sub", textContent: sub })] : []));
    openBtn.disabled = shop.live && !!shop.info?.paused && !shop.pending;
  };
  // after a live pull the next one is another purchase: say so on the button
  const againBtn = document.getElementById("again-pack");
  const syncAgain = () => { againBtn.textContent = pack.mode === "live" ? `Buy Another · ${shop.priceText()}` : "Open Another"; };
  shop.subscribe(() => { syncOpen(); syncAgain(); });
  pack.events.addEventListener("idle", syncOpen);
  pack.events.addEventListener("chainError", syncOpen);   // a refused second signature leaves the sealed pack waiting: "Open Sealed Pack"
  pack.events.addEventListener("done", syncAgain);
  syncOpen();
  // AERIS hosts the hall and narrates the pack; ?npc=0 turns her off
  if (new URLSearchParams(location.search).get("npc") !== "0") { npc = new ForgeNPC(document.getElementById("npc"), pack); entered.then(() => npc.enter()); }
  if (new URLSearchParams(location.search).has("debug")) window.forge = { library, shop, fire: () => forgeFire, ambience: () => ambience, pack, npc, THREE, camera: () => camera, tick, loop: (on) => renderer.setAnimationLoop(on ? frame : null) };

  const load = document.getElementById("load");
  load.style.opacity = 0;
  setTimeout(() => load.remove(), 700);
  document.documentElement.dataset.forgeReady = "1";
  document.dispatchEvent(new Event("forge:ready"));
  // title.js never started (failed to load): don't leave its static cover over a ready hall
  if (!window.forgeTitle && document.documentElement.dataset.forgeTitle !== "on") {
    document.getElementById("title")?.remove();
    document.body.classList.remove("title-cover");
  }
});

// ---------------------------------------------------------------- loop
// frame stats are a dev tool: shown on localhost or with ?debug, never on the deployed hall
const hud = document.getElementById("hud");
hud.hidden = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !new URLSearchParams(location.search).has("debug");
const clock = new THREE.Clock();
let frames = 0, acc = 0, fps = 0;

function noise(t, s) { return Math.sin(t * 7.1 + s) * 0.5 + Math.sin(t * 13.3 + s * 2.1) * 0.3 + Math.sin(t * 23.7 + s * 3.7) * 0.2; }

function tick(dt, t) {
  const fire = pack?.fireDim ?? 1; // the pack sequence turns the forge down so it can't blaze through pack/cards/avatar
  fx.flicker.forEach((o, i) => { o.material.emissiveIntensity = o.material.userData.base * (0.85 + 0.25 * noise(t, i)) * fire; });
  fx.pulse.forEach((o, i) => { o.material.emissiveIntensity = o.material.userData.base * (0.8 + 0.3 * Math.sin(t * 1.3 + i)); });
  ambience?.update(dt, t, viewportScale(camera, renderer), fire, camera);
  if (fx.hearthLight) fx.hearthLight.intensity = 30 * (0.85 + 0.2 * noise(t, 0.5)) * fire;
  forgeFire?.update(t, fire);
  torchFires?.update(t, fire);
  if (!pack?.active) controls?.update(); // the pack sequence owns the camera while it runs
  pack?.update(dt, t);
  renderer.info.reset();
  composer.render();
}

let hallDrawn = false;
const frame = () => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  // the title screen hides the hall: draw it once after it loads (uploads its textures), then not until it shows
  if (hallDrawn && document.body.classList.contains("title-cover")) return;
  if (pack) hallDrawn = true;
  tick(dt, t);

  if (hud.hidden) return;
  frames++; acc += dt;
  if (acc > 0.5) {
    fps = Math.round(frames / acc); frames = 0; acc = 0;
    const r = renderer.info.render;
    hud.textContent = `${fps} fps\ndraw calls ${r.calls}\ntriangles ${r.triangles.toLocaleString()}\nscene ${(bytes / 1e6).toFixed(2)} MB`;
  }
};
renderer.setAnimationLoop(frame);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
