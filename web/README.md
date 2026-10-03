# FORGE Hall — web build

Baked, lightweight version of `forge_hall.blend` for three.js.

| File | What |
|---|---|
| `assets/forge_hall.glb` | Scene: 4 baked unlit groups (`BK_Floor/Center/Left/Right`), the live metals `BK_Live`, emissive FX meshes (`FX_*`), FX markers (`FXM_*`), game camera `Cam_Hall`. Meshopt geometry + WebP textures. |
| `assets/live_{base,orm,normal}.webp`, `assets/env_probe.hdr` | PBR maps for `BK_Live` (ORM = occlusion, roughness, metalness) and the HDR reflection probe they reflect. |
| `assets/sky.webp` | Equirect background (far environment rendered from the hall). |
| `main.js` | Reference runtime: loader, sky, FX animation, particles, bloom, perf HUD. |
| `livemetal.js` | Turns `BK_Live` into MeshStandardMaterial (maps + probe, AgX in its own shader). |

## Loading in the game

```js
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("forge_hall.glb");
```

- **Renderer:** `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`. The bake already carries Blender's AgX grade; tone mapping again would wash it out.
- **No scene lights are needed for the hall.** `BK_*` use `KHR_materials_unlit` (MeshBasicMaterial). `FX_*` are MeshStandardMaterial with emissive only.
- **Live metals** (`BK_Live`: gold trim and plaque frame, the furnace badge, copper pipes, anvils) also ship a baked unlit
  fallback; `livemetal.js` swaps in MeshStandardMaterial once `live_*.webp` + `env_probe.hdr` load (reflections of the lit
  hall that move with the camera, specular from the flickering hearth light). The rest of the hall is display-referred
  (AgX baked in), so this material runs the same AgX curve and exposure (-0.3) in its own fragment shader.
- **Naming contract** (`main.js` depends on it):
  - `FX_Fire`, `FX_Coals`, `FX_LavaCrack` → flicker (`FX_Fire` and `FX_Coals` are replaced by live fire, below)
  - `FX_TorchFire` → hidden, one live flame per torch (`TorchFires` in forgefire.js)
  - `FX_Crystal_<Color>` → pulse
  - `FX_Lightning`, `FX_Spark`, `FX_Ember` → strobe
  - `FXM_ForgeMouth`, `FXM_Smoke`, `FXM_Sparks`, `FXM_Lightning` → particle emitter positions
- Lighting is static (baked). Moving props or lights need re-baking; dynamic characters should get their own lights, or a light probe sampled from `sky.webp`.

## Rebuild

1. Author in `forge_hall.blend`.
2. Export and bake headless, on the GPU (CUDA):
   ```bash
   blender -b forge_hall.blend --python scripts/export_web.py -- 2048 384
   ```
   The arguments are atlas size and bake samples.
3. Optimize to meshopt + WebP:
   ```bash
   bash scripts/optimize_web.sh
   ```
4. Serve `web/` over HTTP. Any static server works.

**Re-grade without re-baking** (exposure, white balance, saturation, contrast): the export keeps each atlas's linear
HDR bake in `bake/BK_*_hdr.npz`. Edit `GRADE` in `scripts/grade_cinematic.py` (or `scripts/grade_cinematic.json`), then
```bash
uv run --with numpy --with pillow --with opencolorio python scripts/grade_cinematic.py
blender -b forge_hall_web.blend --python scripts/reexport_web.py
bash scripts/optimize_web.sh
```
It applies Blender's own AgX view + AgX Punchy look through OpenColorIO; `--check` confirms a neutral grade
matches Blender's PNGs (verified: 0.3/255 mean, 1/255 max).

**Phones**: `optimize_web.sh` also writes `*_1k.glb` (1024 atlases, ~1/4 the GPU texture memory); `main.js` loads it
on small touch screens.

**Reference polish** (`scripts/forge_hall/p17_polish.py`, applied once to `forge_hall.blend`, backup in
`forge_hall_pre_p17.blend`): plaque, rounded bevels, heavier gold trim, lower/farther mountains.

**Cinematic pass p18** (2026-10-02, applied to `forge_hall.blend`, backup in `forge_hall_pre_p18.blend`; each script is
re-runnable through the Blender MCP or `blender -b ... --python`):

| Script | What it does |
|---|---|
| `p18a_title.py` | Lintel plaque reads **THE FORGE** (Cinzel Black, raised gold, rounded edges) over **by LitVM Games** (Cinzel Regular between two gold rules), slate plaque with gold piping. Replaces p17's FORGE OF THE GODS. |
| `p18b_emblem.py` | The LitVM caduceus as an embossed badge on the furnace dome: traced from the logo PNG (`logo_trace.py` → `assets/logo/litvm_caduceus.json`), blackened hammered-steel plate cut to the winged silhouette, raised gold relief, gold piping, 22 rivets; wrapped onto a sphere fitted to the dome (exponential map, diced on a 5 cm grid so it follows the curve), and the Meshy hearth's old medallion pressed into the dome under a dark patch material. |
| `p18c_materials.py` | Sooty firebrick hearth with mortar seams glowing around the mouth, forged-steel anvils with polished faces and worn edges, blackened iron, tarnished copper, worn gold/bronze with dirt in the recesses, slate plaque, soot fanning across the floor from the hearth. |
| `p18d_lighting.py` | Night falling: sky lights the hall at 0.12 (was 0.45), visible sky 0.65, softer low sun, the forge as key (spill narrowed to 105°), cool Norse fill, AgX exposure -0.3; iron torch sconces on the two centre columns (collars, arm, cup, pitch-wrapped torch, flame + light); a narrow accent spot on the badge. |

The painted (toon) build was removed on 2026-10-02 (archived in `archive/toon/`, not served).

## Pack opening (`pack.js`)

**Open Pack** flies the camera to a close-up in front of the hearth, dims the hall, and plays a green-screen pack video
chroma-keyed onto a camera-facing plane. Real-time effects run off the video clock; at the hand-off frame a 3D card
stack replaces the video's card (same size, position and tilt), fans out and flips with rarity effects.

| Video time | Beat | Effects |
|---|---|---|
| 0–4.4 s | pack idles | energy motes spiral in, aura builds, slow camera push-in |
| 4.45 s | tear starts | sparks run along the torn edge |
| 6.15 s | **climax** | flash, shockwave ring, god rays, particle burst, camera shake, bloom kick, hall lit |
| 6.3–9.4 s | card rises | drifting dust, gold + cyan light trails orbiting the card |
| 9.45 s | **hand-off** | video fades under a matching 3D stack → squares up → fans out → flips (best card last) |

- **Videos** (`assets/pack/`): `pack_physics_60.mp4` (default: pack tear only; all effects are ours) and
  `pack_fx_60.mp4` (`?pack=fx`: Veo's own flash baked in; our effects run lighter). Both are motion-interpolated
  to 60 fps from the 24 fps originals (kept alongside) by `scripts/interp_pack_video.py`: 24 fps in a 60 Hz scene
  judders. Burst windows too fast to interpolate are frame-held instead (`HOLD`), and the physics clip's two
  generator smear frames (#150-151) are dropped, so the pack pops open at 6.25 s, where the climax now lands. Both H.264 720p, keyed on
  RGB (40, 168, 64). Timings live in `VIDEOS` at the top of `pack.js`. The plane shows only the centre
  76% of the frame (`CROP`), which is where the pack and its flaps sit.
- **Card back** `assets/pack/card_back.jpg` is the final card-back art (1024x1434). The video's card still shows the
  generator's older art, so the 3D stack replaces it on the hand-off frame under a sparkle + small pulse.
- **Card faces** are drawn at runtime from `POOL` (placeholder gods and titans, emoji art). Add
  `art: "./assets/cards/<name>.webp"` to an entry to use real art. Rarity weights: `WEIGHTS`. Five cards per
  pack, at least one rare, sorted so the best flips last.
- **Robustness**: the sequence follows the video while it plays, but an internal clock carries it on if the
  video stalls; Skip triggers the reveal directly; the plane stays hidden until a decoded frame is on screen
  (no black flashes on start, seek or replay).
- **Lighting**: cards (and later, characters) use `MeshStandardMaterial` lit by the rig in `main.js`
  (sky hemisphere + flickering hearth point light) plus the pack's key/flash lights; the baked hall is unlit.
- **Debug**: `?debug` exposes `window.forge` (`tick(dt, t)`, `loop(on)`, `pack` with `debugVT`) for
  frame-stepped testing when the tab is throttled.

## NPC host — AERIS (`npc.js`, `npc_script.js`)

A 2D portrait host with a typewriter dialogue box: DOM/CSS only (transform/opacity), so it costs the WebGL frame nothing.

- **Poses** `assets/npc/aeris_{idle,talking,happy,thinking}.webp` are chroma-keyed from the green-screen sheets
  (1016×1100, alpha, one shared crop so swaps never jump). `aeris_talking_closed.webp` is the talking pose with the
  idle pose's closed mouth feathered in: the talking emotion lip-flaps between the two while letters type.
- **Emotions**: idle (resting), talking (explaining), happy (celebrating), thinking (hints/suspense). Changing emotion
  cross-dissolves the pose and plays a small body reaction; non-talking poses nod once per word; idle breathing loops.
- **Modes**: `host` in the hall (large portrait, click / Space / Enter to advance, click AERIS for chatter) and
  `comms` during the pack (small portrait, lines auto-advance, never blocks the view). Phones hide the portrait in comms.
- **Beats** come from `pack.events` (`open tear burst skip reveal flip done inspect again leave idle`, card data in
  `detail`), so the pack code knows nothing about the NPC.
- **Script** (placeholder copy) is `npc_script.js`: lines are `[emotion, text]`; `{name} {title} {rarity} {side}` fill
  from the card; `*word*` renders gold (or the card's rarity colour). `?npc=0` disables her.

## Rapture ARC 1 collection (`rapture.js`, `showcase.js`, `cardpanel.js`)

The pack draws from the 50 minted **Rapture ARC 1** cards (Liteforge testnet, collection
`0xe5195bd181Fe72aC45edA3Da76c066A17f620018`). **Preview only**: nothing is minted, no wallet is read.

- **Snapshot**: current deployment (RaptureCards `0x138F…2721`, chain 4441) is regenerated with
  `node scripts/rapture_snapshot.mjs --deployment <rapture>/studio/out/deployment.liteforge.json --plates <rapture>/studio/out/assets`.
  A bare run also targets the current collection but takes paintings from the stale 22 GODS pack art, so pass
  `--plates`. `--local` snapshots the Studio's local
  chain (localhost links, never publish). The script enumerates the set on chain
  (`setId << 32 | n` until `tokenURI` reverts; read-only `eth_call`), decodes each token's inline character.json, and
  writes `assets/rapture/cards.json`. It downloads each web avatar (`animation_url`) and `SOUL.md` from IPFS (Filebase
  gateway) and refuses any bytes that don't match the token's sha256 / keccak256. Paintings are the Studio pack's
  768 px plate crops (default source: the 22 GODS import at `GODSgame/assets/cards/art/rapture`). Re-run after any
  redeploy; it is idempotent and skips avatars already on disk with the right hash. ~36 MB total, avatars ~0.7 MB
  each, loaded only when a card is inspected.
- **Tiers**: Kind is the only tier. Mortal = common, King = rare, Demigod = epic, God / Titan = legendary; odds
  50/28/15/7 per slot, one Demigod or better guaranteed, best card flips last.
- **Face** (`drawFace`): one slate bezel on every card (the Studio tints it per Frame; in a fan that read as
  inconsistent, so Frame is in the trait line only); faction sigils as the Studio draws them. Follows the Studio's own card face (the token `image`), minus stats so the art leads:
  full-bleed painting in a device bezel tinted by the Frame trait (Smoke / Obsidian / Pearl / Glass), Kind · Path pill
  (rim = pack tier) and faction sigil on top, small-caps name, italic epithet and an element-dot trait line over the
  art's foot, set line + serial at the bottom. The painting is the render's top square (the full-height render isn't
  pinned), cover-fitted and dissolved into the render's own void colour. Drawn on the Studio's 1000x1400 grid at 0.8x.
  Paintings load via fetch + createImageBitmap with a retry (img.decode() rejected under load and blanked cards).
- **Inspect** (tap a revealed card): the rest of the fan steps aside; the card, its own **3D avatar** on a turntable
  (idle clip, element pedestal, dark studio env map on the avatar only). Materials are re-finished for this
  renderer (`finish()` in showcase.js): emissive through an AgX-like shoulder `1.05·s/(1+s)` so glows keep their hue,
  god chrome/gold roughness floored at 0.34 so point lights don't spike into bloom squares, Titan shells made
  forged metal (metal 0.92, rough 0.38, near-black Lava lifted to gunmetal); glowing accents (cracks, cores, eyes,
  circuits) are matte pure emission at a target LUMINANCE (0.95 + 0.2·min(s,3), so lava pink blooms like earth green)
  through a small glow shader (`glow()`, world space normalised to body height) with three looks: `crack` (Titans:
  hotter where the crack faces the viewer, molten flow), `neon` (Mortal wireframes x1.7, King/God circuits, eyes: even
  line brightness + an energy band sweeping up), `glass` (Mortal bodies: faint fresnel rim in the element colour).
  Materials are finished once each (meshes share them), and
  the **panel**: traits, stats, SOUL lore (intro / Voice / Values / In a fight, normalised from free-form markdown),
  and on-chain provenance (Blockscout token link, IPFS design doc + card image, avatar hash check, TESTNET badge).
  AERIS reads the card by Kind. Phones get a bottom sheet and a camera-fitted layout.
- **Perf**: avatar bytes prefetch when a pack opens; parse, `compileAsync` and upload happen on inspect only, so
  shader programs stay flat through the pack sequence.

## Card Library (`library.js`, `holdings.js`, `librarymodel.js`, `collections.js`, `library.css`)

**Library** (top centre; top right on phones; or press **L**) opens a full-screen overlay with a wallet's collection: every
card of the set is a tile, owned ones as their painting and the rest as silhouettes (name hidden, and search cannot reveal
it), with set progress (`20 / 50`, per Kind), duplicates as `×N`, filters (Kind, element, Owned / Missing / New), search and
sort (set order, rarity, name, newest). Tap an owned card for the full card face, prev / next (← →), its copies (each token
is one edition) and the same inspect panel the pack uses. Escape closes the card, then the library. While it is open the
3D render loop is paused (nothing to draw behind it).

- **It only reads.** It never asks the wallet to sign or send. Connecting is the wallet button's job (`walletui.js`): the
  library's "Connect wallet" button clicks it, so no wallet installed / phones / refusals are handled in one place. The
  library uses the shop's wallet and RPC (`shop.wallet`, `shop.cfg.rpc`), nothing of its own.
- **Editions.** A pack mints NEW token ids from a template (see `packshop/README.md`), so a player's cards are ids the
  snapshot has never seen. `holdings.js` finds them and names each one: the snapshot's own 50 need no call; an edition is
  matched through its inline `tokenURI` JSON by design hash (the shop's `templates[].designHash`), design doc, image, then
  name, and the answer is cached (a token's design never changes). Unmatched tokens show under "Other tokens".
- **Where the tokens come from** (`holdings.js`). RaptureCards is ERC-721 and not enumerable, so three sources are combined
  and the chain has the last word: Blockscout's `tokens/<contract>/instances?holder_address_hash=` (fast but it lags a fresh
  deployment: it listed 35 of 50 tokens a wallet really held), ids this browser remembers (a pack open), and
  `balanceOf(wallet)` as the authoritative COUNT. If the others agree with it we are done after one call; more than it means
  stale rows, each checked with `ownerOf`; fewer means an `ownerOf` scan of the set's ids, newest first, stopping the moment
  the count is met (at most 1500 calls; a deep read runs at most every 5 minutes unless "Look again" is pressed). Measured on
  Liteforge with the minter wallet: 50 of 50 in ~1.3 s, 15 `ownerOf` calls.
- **NEW.** The first read of a wallet counts everything it holds as seen (no flood of NEW); what a pack mints in this browser is
  NEW until its card is opened, or the library has been open for 3 s and is closed. The button shows `+N NEW`.
- **Pack handoff.** `pack.events` `done` (live cards only: `owned`) remembers the minted ids, teaches the identify cache which
  card each came from, and re-reads at once and again after 8 s (the explorer lags).
- **Sets.** `collections.js` lists the sets; add an entry with its own snapshot for a future ARC. The in-game 22 GODS cards are
  these same ARC 1 tokens (the game reads them with `ownerOf`), so there is no separate set for them.
- **Try it without a wallet:** `?demo` (sample collection), or on a local host `?holder=0x...` (read-only view of any address).
  `?debug` exposes `window.forge.library`.
- **Wiring** (three small edits in `main.js`): the two imports, `mountLibrary(...)` after `mountWalletUI(...)`, and the
  pause/resume of the render loop. No edit to `index.html`: `library.js` injects `library.css` and its own elements.
- Tests: `web/test/holdings.test.mjs`, `web/test/library.test.mjs` (`node --test "web/test/*.test.mjs"`).

## Hosted preview (claude.ai artifact)

Private artifact: https://claude.ai/artifact/QeGET97GyjG2mUJe3Ln4Mi (share from the page's Share menu).
The host serves no `model/gltf-binary`, so every `.glb` path is published as base64 `text/plain`; `glbBytes()` in
fx.js takes either form (binary locally, base64 hosted). The page drops its own doctype/head/body (the host wraps it),
query strings don't reach it (`?debug`, `?npc=0`, `?pack=fx` are local-only), and the build
excludes `*_raw.glb`, `pack_fx.mp4` and `pack_physics_60.mp4` (~61 MB of the 64 MB cap, 123 files).

### Light layering rules (pack + cards)

Additive FX must sit clearly *behind* what they light, or tilts and neighbouring cards bring them in front:

- card glow sprite 30 cm behind its card (hover tilt swings an edge ~11 cm back; fan neighbours differ by 8 cm)
- flip ring 25 cm and legendary rays 45 cm behind the flipped card; flip sparks burst from behind its edges
- the keyed video plane (no depth write, for soft edges) has a depth-only twin (`keyDepthMaterial`), so motes and
  trails behind the pack are hidden by it
- the pack never alpha-fades: the forge fire behind it is HDR (~6x) and blazes through any see-through foil. It
  irises in (`reveal`) and the decoded-frame gate is on/off
- after the burst, a soft fade grows along the plane's bottom edge (`floorFade` 0.03 → 0.25), so the foil sliding out
  of the frame thins away instead of being cut off; the hand-off fades the remaining foil over 0.6 s
- foil sheen on epic/legendary cards is a hairline glint every ~7 s, not a band resting on the art

### Frame pacing (measured 2026-09-29, full sequence x2, 1280x720, GPU work included)

Median 6.7 ms, p99 12 ms, worst frame 31 ms, zero frames over 33 ms, zero shader compiles during the sequence.
What got it there: warm-up compiles every pack material for the composer's render target and pushes one frame
through the real pipeline at load; pooled card materials (disposing frees shader programs); scene lights never
added/removed mid-sequence; face textures uploaded when drawn; cards primed off-screen before the hand-off;
video decoder spun up at load (silent play + pause); allocation-free particles; bloom at half resolution; DPR <= 1.5.
- the forge fire is dimmed by the pack (`pack.fireDim`, applied in `main.js` to fire/coal/lava emissives and the hearth
  light): 55% during the sequence, 8% while a card + avatar is inspected (under the bloom threshold, so nothing glows
  through the translucent holograms); bloom eases to 60% while inspecting so avatar glow doesn't clip to white

## Hearth fire (`forgefire.js`)

The baked scene's flame cones (`FX_Fire`) only read as fire while bloom smeared them; dimmed for the pack/avatar views
they showed as flat static triangles. They are now hidden and replaced by live fire:

- **Flames:** three overlapping volumetric, ray-marched fire volumes (vendored `@wolffo/three-fire` 1.4.0, MIT, in
  `vendor/three-fire/`, texture `assets/fx/fire.png`), each with its own noise seed and speed. Desktop 14 steps /
  3 octaves, phones 10 / 2; measured cost ~1-2 ms per frame. The package also has a WebGPU (TSL) build for the
  Sandbox Studio port (`@wolffo/three-fire/tsl/vanilla`).
- **Coal bed:** `FX_Coals` gets an animated ember shader: dark crust with thin glowing seams that drift and pulse,
  glow on top, mostly crust on the sides (it was a flat box glowing at 3x white that read as a lit panel).
- **Dimming:** follows `pack.fireDim` but floors at a visible smoulder (45% flame / 30% embers), so the character
  preview shows low live fire instead of an empty mouth.
- `?fire=classic` restores the old cones for comparison.
- **Depth:** the library ships `depthTest: false`, which drew the flames over everything in front of the hearth
  (cards, pack, the stone arch). `forgefire.js` turns depth testing back on (no depth write, still translucent).

## Forge effects (`forgefx.js`)

The baked scene's effect stand-ins were static meshes that could only blink: glowing lightning rods on the Zeus
anvil (`FX_Lightning`), 70 ember beads frozen in mid-air by the right anvil (`FX_Ember`), spark shapes over the small
anvil (`FX_Spark`) and flat glowing lava strips (`FX_LavaCrack`). They are hidden and used as **anchors** (split into
their connected pieces); the scene's `FXM_*` markers do not survive glTF optimisation.

| Effect | What it does now |
|---|---|
| Lightning (Zeus anvil) | Procedural arcs (midpoint-displacement paths, camera-facing ribbons: white-hot core + blue glow) crackle along the 6 rod positions, each flickering on/off with fresh paths every ~50 ms. Every 2–4 s a forked bolt strikes the anvil from above: branches, flare, blue light pulse, spark burst. |
| Hammer sparks (small anvil) | Every 1.1–1.9 s a fan of spark **streaks** (lines along their velocity, gravity, cooling white → orange → red) bursts from the anvil's striking face (found by raycast), with a flash and a light pulse. |
| Ember cloud (right anvil) | Embers rise slowly through the old ember positions, sway, cool orange → deep red and die; hot ones pop out in little arcs. |
| Coal bed | A knot pops every 0.35–1.1 s, spitting spark streaks up into the flames. |
| Lava cracks | Animated molten shader: glow creeps down the cracks and surges. |
| Hearth | Rising embers now cool as they climb; red heat haze unchanged. |

Everything scales with the pack's forge level (`pack.fireDim`). Lights for non-baked objects (cards, avatars) are
always in the scene at intensity 0 when idle, so the light count never changes. Cost: ~0.1 ms CPU per frame for the
whole update, +3 draw calls. Debug: `window.forge.ambience()` (`nextStrike`, `nextHammer`, `nextCoalPop` fire events).

## Live pack shop: MetaMask, zkLTC, cards minted to the wallet

The hall can sell real packs. `packshop/` (repo root) holds the **PackShop** contract; the page talks to it through
these modules (plain ES modules, no bundler, no npm packages in the browser):

| File | What |
|---|---|
| `wallet.js` | EIP-6963 discovery (MetaMask first), connect, restore without a popup, add/switch to LitVM Liteforge (4441), send tx, `personal_sign`. Normalised errors (`user_rejected`, `wrong_chain`, `no_wallet`…). |
| `chain.js`, `abi.js` | Read-only JSON-RPC straight to the public RPC (CORS is open) and a tiny hand-rolled ABI codec. Selectors/topics are constants, checked against ethers in `web/test`. |
| `packshop.js` | `readShop`, `buyPack`, `waitUntilOpenable`, `openPack`, `refundExpired`, `findMyPacks`. Adds gas headroom (Nitro under-estimates), checks the balance first, decodes `PackBought` / `PackOpened`. |
| `auth.js` | Sign-in with the wallet (server issues an EIP-4361 message, the wallet signs, a session cookie comes back). Optional: hidden when `/api` is absent. |
| `shopflow.js` | The adapter `pack.js` drives: `buy()` → `waitOpenable()` → `open()` → minted cards (mapped to the snapshot's art/avatars/lore). Resumes a bought-but-unopened pack after a reload. |
| `walletui.js` | The pill at the top right: connect, network, balance, packs left today, sign in, refund an expired pack, disconnect. |

**Flow** (`PackOpening.startLive` in `pack.js`): connect → buy (0.001 zkLTC, signature 1) → the sealed pack idles in front of
the hearth while the chain settles (~12–24 s: two block numbers on Nitro) → break the seal (signature 2) → the five minted
cards fan out with the usual tear/burst. A refused second signature keeps the pack ("Open Sealed Pack"); closing the page
does too (`findMyPacks` finds it). **Free Preview** keeps the old client-side pull (no wallet, nothing minted; its odds are
the old tier weights, not the shop's 30/25/20/15/10 Kind odds).

**Config**: `assets/rapture/packshop.json` (written by `packshop/scripts/write-web-config.mjs` after a launch) names the
chain, the PackShop and the template→card map. Without it the hall is preview-only and the wallet button still works.
`?shop=off` forces preview; `?shop=local` reads `packshop.local.json` (dev chain, localhost hosts only).

**Local end to end**: `cd packshop && npm run node` (chain 31338 on :8547), `npm run local-setup`, serve `web/`
and open `/?shop=local`. See `packshop/README.md`. In a pane where `requestAnimationFrame` never fires, `?debug` exposes
`window.forge.tick` to step frames from a timer, and `window.forge.shop` for the shop state.

## Title screen (`title.js`, `titlecore.js`, `title.css`)

"LIT GAMES presents THE FORGE": a loading/title screen that covers the hall while `main.js` loads it underneath.

- **Sequence**: studio card (CSS, plays from the first paint) → a five-line told prologue → the title card (studio mark,
  3D emblem crest, wordmark, *Strike to enter*) → entering: a last strike, the emblem flares, the title fades and AERIS
  starts her intro. Returning players (`localStorage forge.title.seen`) skip straight to the title card; *Prologue* replays it.
- **Story beats** drive the emblem (`BEATS` in `titlecore.js`, `cue()` in `title.js`): I the mould lights up with glowing channels,
  II molten metal pours bottom-up, III the strike that scatters fifty souls (ten per Kind), IV the metal cools to chrome,
  V the forge is kindled. Lines are placeholder copy: edit `BEATS` freely.
- **Interaction**: click / tap / Space strikes (sparks, heat on the metal, a synthesized clang) and moves the story
  along; pointer tilts the emblem, drag spins it; Esc skips; M or the speaker button mutes (sound starts on the first
  gesture, remembered in `forge.title.sound`).
- **3D emblem**: built at runtime from the LitVM caduceus trace (`assets/title/caduceus.json`, a copy of
  `assets/logo/litvm_caduceus.json` from `scripts/forge_hall/logo_trace.py`, the same trace as the furnace badge).
  Even-odd loops → extruded chrome art, a hammered-iron plate inside a studded rim; the art's rounded relief and the
  plate's engraved channels are normal maps baked in one-off GPU passes from the rasterised trace. Pour/heat/sheen are
  shader injections on `MeshStandardMaterial` (`pouredMetal`, `mouldIron`); reflections come from a procedural studio
  sky (`chromeEnvironment`).
- **Logos**: `assets/title/litgames.webp`, `theforge.webp` and `theforge-900.webp` (phones via `srcset`, and the
  light-sweep mask) are keyed from the supplied JPGs by
  `python scripts/title_assets.py reference/title/litgames_black.jpg reference/title/theforge_green.jpg` (also re-copies
  the trace, rounded to 4 decimals).
- **Contract with `main.js`** (DOM events on `document`): `forge:progress` (0..1) and `forge:ready` in, `forge:enter`
  out. `body.title-cover` while the title hides the hall (main.js skips drawing it), `html[data-forge-title]` = on/off/done.
  AERIS waits for `forge:enter`. New load steps in `main.js` should report `loadProgress(x)`; keep `forge:ready` last.
- **Switches**: `?title=0` off; `?debug` turns it off (test harnesses see the hall as before) unless `?title=1`;
  `?title=story` forces the prologue.
- **Production behaviour**: the emblem builds in one synchronous ~0.5 s run under the studio card (the card holds until
  it is ready); every program is compiled up front, the hidden effects included, so the first strike does not hitch. A
  weak GPU (median frame > 28 ms) drops to 1x pixels without SMAA. A lost GPU context drops the 3D and keeps the story
  and the way in. While the title covers the hall, everything else in `<body>` is `inert` (keyboard and screen readers
  stay on the title), the hall is not drawn, and AERIS waits. Sound pauses with the tab. After entering, the title frees
  its WebGL context, listeners and audio.
- **Tests**: `web/test/title.test.mjs` (in `node --test web/test/`): the prologue's shape, story markup, tweens, even-odd
  nesting on the real trace, badge outlines that must not self-intersect (the old rim fold), rivet spacing, emblem
  placement on every screen shape, asset references and the event contract with `main.js`. Rendering is checked by hand
  in a browser (`?title=story`).
- **Gotchas found building it**: GLSL `smoothstep(a, b, x)` with a > b is undefined and ANGLE/D3D returns 1 past the
  edge (squares instead of soft dots, everything glowing): write falling edges as `1. - smoothstep(b, a, x)`. With only
  `scene.environment`, three r170 ignores per-material `envMapIntensity` (it uses `scene.environmentIntensity`), so the
  emblem materials carry their own `envMap`. UnrealBloom already halves internally; halving its size again turned thin
  chrome glints into square blocks.
