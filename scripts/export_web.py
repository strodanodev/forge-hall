"""Headless web export of the FORGE hall: bake lighting -> unlit atlases + emissive FX + live metals -> GLB.

run:  blender -b forge_hall.blend --python scripts/export_web.py -- [atlas_res] [bake_samples]
Never writes the source .blend; saves the baked copy as forge_hall_web.blend.

Most of the hall is baked (Cycles COMBINED through AgX) into unlit atlases BK_Floor/Center/Left/Right. Metals that
should catch the light as the camera moves (gold trim, the furnace badge, copper pipes, anvils: LIVE_MATS) go to
BK_Live instead: it gets the same baked fallback atlas plus PBR maps (live_base / live_orm / live_normal) and the hall
renders an HDR reflection probe (env_probe.hdr) for them, so main.js can light them with MeshStandardMaterial.
"""
import bpy, os, sys, time, math
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web", "assets")
BAKE_DIR = os.path.join(ROOT, "bake")
NAME = "forge_hall"
os.makedirs(WEB, exist_ok=True)
os.makedirs(BAKE_DIR, exist_ok=True)
argv = [a for a in sys.argv[sys.argv.index("--") + 1:] if not a.startswith("--")] if "--" in sys.argv else []
RES = int(argv[0]) if len(argv) > 0 else 2048
SAMPLES = int(argv[1]) if len(argv) > 1 else 384
LIVE_RES = min(1024, RES)  # BK_Live atlas + its PBR maps (metals carry little texture detail)
PROBE = (0.0, -1.4, 1.7)  # reflection probe: mid-hall, in front of the hearth, at anvil/badge height
T0 = time.time()
sc = bpy.context.scene
vl = bpy.context.view_layer
COL = bpy.data.collections["ForgeHall"]


def col_objs():
    return [o for o in bpy.data.objects if o and COL in o.users_collection]
FX_MATS = {"FH_Fire", "FH_Coals", "FH_LavaCrack", "FH_Lightning", "FH_Spark", "FH_Ember", "FH_TorchFire"}
FX_COLORS = {"FH_Fire": ((1.0, 0.42, 0.08), 6.0), "FH_Coals": ((1.0, 0.25, 0.03), 3.0),
             "FH_LavaCrack": ((1.0, 0.18, 0.02), 8.0), "FH_Lightning": ((0.35, 0.65, 1.0), 8.0),
             "FH_Spark": ((1.0, 0.6, 0.2), 8.0), "FH_Ember": ((1.0, 0.1, 0.04), 8.0),
             "FH_TorchFire": ((1.0, 0.45, 0.12), 6.0)}
# metals rendered live on the web (every material of the object must be one of these)
LIVE_MATS = {"FH_EmblemGold", "FH_EmblemSteel", "FH_Gold", "FH_Copper", "Material_0.001"}


def is_live(o):
    mats = [s.material.name for s in o.material_slots if s.material]
    return bool(mats) and all(m in LIVE_MATS for m in mats)


def log(*a):
    print(f"[web {time.time() - T0:6.1f}s]", *a, flush=True)


def select_only(objs, active=None):
    for o in vl.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    vl.objects.active = active or (objs[0] if objs else None)


# ---------------------------------------------------------------- cycles on GPU
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "CUDA"  # OptiX kernel fails to compile on this driver
prefs.refresh_devices()
for d in prefs.devices:
    d.use = d.type == "CUDA"
sc.render.engine = "CYCLES"
sc.cycles.device = "GPU"
sc.render.use_compositing = False

# ---------------------------------------------------------------- 1. sky panorama
cam_d = bpy.data.cameras.new("PanoCam")
cam_d.type = "PANO"
cam_d.panorama_type = "EQUIRECTANGULAR"
pano = bpy.data.objects.new("PanoCam", cam_d)
sc.collection.objects.link(pano)
pano.location = (0, -3.0, 2.0)
pano.rotation_euler = (math.radians(90), 0, math.radians(-90))  # looks +X -> image centre = +X
hidden = []
for o in col_objs():
    if not ((o.name.startswith("Env_") and not o.name.startswith("Env_Cliff")) or o.name == "Lt_Sun") and not o.hide_render:
        o.hide_render = True
        hidden.append(o)
game_cam = sc.camera
sc.camera = pano
sc.cycles.samples = 64
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 4096, 2048, 100
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = os.path.join(BAKE_DIR, "sky.png")
bpy.ops.render.render(write_still=True)
for o in hidden:
    o.hide_render = False
log("sky panorama done")

# ---------------------------------------------------------------- 1b. reflection probe for the live metals
# The whole lit hall seen from mid-hall, scene-linear HDR (no view transform), minus the live metals themselves.
hidden = [o for o in col_objs() if o.type in ("MESH", "CURVE", "FONT") and is_live(o) and not o.hide_render]
for o in hidden:
    o.hide_render = True
pano.location = PROBE
sc.cycles.samples = 128
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1024, 512
sc.render.image_settings.file_format = "HDR"
sc.render.filepath = os.path.join(WEB, "env_probe.hdr")
bpy.ops.render.render(write_still=True)
sc.render.image_settings.file_format = "PNG"
for o in hidden:
    o.hide_render = False
sc.camera = game_cam
bpy.data.objects.remove(pano)
log("reflection probe done")

# ---------------------------------------------------------------- 2. strip non-exportables
for o in col_objs():
    if o.name.startswith("Env_") or o.name == "RedSmoke":
        bpy.data.objects.remove(o, do_unlink=True)
markers = {"FXM_Smoke": (1.35 * 1.0, 0.25, 0.55), "FXM_ForgeMouth": (0.0, 0.6, 1.2),
           "FXM_Lightning": (-2.3, -1.4, 1.35), "FXM_Sparks": (-1.95, 0.05, 0.75)}
for n, loc in markers.items():
    e = bpy.data.objects.new(n, None)
    e.location = loc
    COL.objects.link(e)

# camera: freeze the track-to constraint into a plain transform
cam = bpy.data.objects["Cam_Hall"]
mw = cam.matrix_world.copy()
cam.constraints.clear()
cam.matrix_world = mw

# ---------------------------------------------------------------- 3. everything -> plain meshes
geo = [o for o in col_objs() if o.type in ("MESH", "CURVE", "FONT") and not o.hide_render]
for o in geo:  # coarser curves before meshing: lighting is baked, silhouettes are what count
    if o.type == "FONT":
        o.data.resolution_u = 3 if o.name.startswith("Lintel_") else 2  # the plaque lettering is read up close
    elif o.type == "CURVE":
        o.data.resolution_u = 2
        o.data.bevel_resolution = min(o.data.bevel_resolution, 2)
select_only(geo)
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.convert(target="MESH")
for o in col_objs():
    if o.name == "Hearth_MouthCut" or (o.type == "EMPTY" and not o.name.startswith("FXM_")):
        bpy.data.objects.remove(o, do_unlink=True)
geo = [o for o in col_objs() if o.type == "MESH"]
log("converted", len(geo), "meshes", sum(len(o.data.polygons) for o in geo), "faces")

# ---------------------------------------------------------------- 3b. geometry diet
FACE_CAP = 1200
for o in geo:
    n = len(o.data.polygons)
    # Meshy props are already remeshed; the badge's relief IS its detail (a decimate would eat the logo)
    if n > FACE_CAP and not o.name.startswith(("MXI_", "Emblem_")):
        d = o.modifiers.new("Diet", "DECIMATE")
        d.ratio = max(0.15, FACE_CAP / n)
        select_only([o])
        bpy.ops.object.modifier_apply(modifier=d.name)
# faces nobody can see: downward-facing at/below floor level (slab underside, prop bottoms)
import bmesh
culled = 0
for o in geo:
    mw = o.matrix_world
    nmat = mw.to_3x3().inverted_safe().transposed()
    bm = bmesh.new()
    bm.from_mesh(o.data)
    dead = [f for f in bm.faces
            if (nmat @ f.normal).normalized().z < -0.95 and (mw @ f.calc_center_median()).z < 0.03]
    if dead and len(dead) < len(bm.faces):
        culled += len(dead)
        bmesh.ops.delete(bm, geom=dead, context="FACES")
        bm.to_mesh(o.data)
    bm.free()
log("culled hidden floor-level faces:", culled)

# faces that face away from every camera the game allows (main.js orbit: ±0.45 rad azimuth,
# polar 0.36π..0.53π, distance 6..14 around a target 11 m ahead of Cam_Hall)
if "--keep-backfaces" not in sys.argv:
    fwd = (cam.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()
    tgt = cam.matrix_world.translation + fwd * 11.0
    base = math.atan2(-(cam.matrix_world.translation - tgt).x, -(cam.matrix_world.translation - tgt).y)
    views = [tgt + d * Vector((math.sin(p) * math.sin(base + a), -math.sin(p) * math.cos(base + a), math.cos(p)))
             for a in (-0.5, -0.25, 0.0, 0.25, 0.5) for p in (math.pi * 0.34, math.pi * 0.45, math.pi * 0.55)
             for d in (5.5, 14.5)]
    views.append(cam.matrix_world.translation.copy())
    V = np.array([tuple(v) for v in views], dtype=np.float64)
    culled = 0
    for o in geo:
        mw = o.matrix_world
        nmat = mw.to_3x3().inverted_safe().transposed()
        bm = bmesh.new()
        bm.from_mesh(o.data)
        faces = list(bm.faces)
        if not faces:
            bm.free()
            continue
        C = np.array([tuple(mw @ f.calc_center_median()) for f in faces])
        Nn = np.array([tuple((nmat @ f.normal).normalized()) for f in faces])
        # visible from any sample view (small tolerance keeps grazing faces)
        vis = (np.einsum("fk,vfk->vf", Nn, V[:, None, :] - C[None, :, :]) > -0.02).any(axis=0)
        dead = [f for f, keep in zip(faces, vis) if not keep]
        if dead and len(dead) < len(faces):
            culled += len(dead)
            bmesh.ops.delete(bm, geom=dead, context="FACES")
            bm.to_mesh(o.data)
        bm.free()
    log("culled back faces never seen by the game camera:", culled)
heavy = sorted(geo, key=lambda o: -len(o.data.polygons))[:12]
log("after diet", sum(len(o.data.polygons) for o in geo), "faces; heaviest:",
    [(o.name, len(o.data.polygons)) for o in heavy])

# ---------------------------------------------------------------- 4. classify
def mat_names(o):
    return {s.material.name for s in o.material_slots if s.material}

FLOORISH = ("Floor", "Grate_", "Medallion", "Forge_Dais")
groups = {"Floor": [], "Center": [], "Left": [], "Right": [], "Live": []}
GROUP_RES = {"Live": LIVE_RES}
fx = {}
for o in geo:
    mats = mat_names(o)
    fxm = next((m for m in mats if m in FX_MATS or m.startswith("FH_Crystal_")), None)
    if fxm:
        fx.setdefault(fxm, []).append(o)
        continue
    c = sum((o.matrix_world @ Vector(b) for b in o.bound_box), Vector()) / 8
    if is_live(o):
        groups["Live"].append(o)
    elif o.name.startswith(FLOORISH):
        groups["Floor"].append(o)
    elif c.x < -2.2 and c.y < 3.5:
        groups["Left"].append(o)
    elif c.x > 2.2 and c.y < 3.5:
        groups["Right"].append(o)
    else:
        groups["Center"].append(o)
log({k: len(v) for k, v in groups.items()}, "fx:", {k: len(v) for k, v in fx.items()})

# ---------------------------------------------------------------- 5. per-object charts -> shelf-packed atlas
# Each object gets its own 0-1 chart (Meshy props reuse their compact atlas), then every chart is
# placed in a square cell sized by the object's world surface area -> even texel density, little waste.


def uv_get(layer, n):
    a = np.empty(n * 2, dtype=np.float32)
    layer.data.foreach_get("uv", a)
    return a.reshape(-1, 2)


def chart(o):
    uvl = o.data.uv_layers
    src = next((l for l in uvl if l.name != "BakeUV"), None)
    bake = uvl.get("BakeUV") or uvl.new(name="BakeUV")
    n = len(o.data.loops)
    if o.name.startswith("MXI_") and src is not None:
        bake.data.foreach_set("uv", uv_get(src, n).ravel())
    else:
        uvl.active = bake
        select_only([o])
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.03, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        bake = o.data.uv_layers["BakeUV"]  # edit-mode round trip invalidates layer refs (bites UV-less meshes)
    uv = uv_get(bake, n)
    lo, hi = uv.min(0), uv.max(0)
    uv = (uv - lo) / max(float((hi - lo).max()), 1e-6)  # uniform fit into 0-1
    bake.data.foreach_set("uv", uv.ravel())


def world_area(o):
    return sum(p.area for p in o.data.polygons) * abs(o.matrix_world.determinant()) ** (2 / 3)


def skyline_pack(sizes):
    """Bottom-left skyline packing of squares into the unit square; None if they don't fit."""
    sky = [[0.0, 0.0, 1.0]]  # segments: x, y, width
    pos = [None] * len(sizes)
    for i in sorted(range(len(sizes)), key=lambda i: -sizes[i]):
        s, best = sizes[i], None
        for j, (x, _, _) in enumerate(sky):
            if x + s > 1.0 + 1e-9:
                break
            y, k, span = 0.0, j, 0.0
            while span < s - 1e-9:
                y = max(y, sky[k][1])
                span = sky[k][0] + sky[k][2] - x
                k += 1
            if y + s <= 1.0 + 1e-9 and (best is None or (y, x) < best[:2]):
                best = (y, x, j)
        if best is None:
            return None
        y, x, j = best
        pos[i] = (x, y)
        new, x1 = [x, y + s, s], x + s
        rest = []
        for seg in sky:
            sx, sy, sw = seg
            if sx + sw <= x + 1e-12 or sx >= x1 - 1e-12:
                rest.append(seg)
            elif sx < x:
                rest.append([sx, sy, x - sx])
                if sx + sw > x1:
                    rest.append([x1, sy, sx + sw - x1])
            elif sx + sw > x1:
                rest.append([x1, sy, sx + sw - x1])
        rest.append(new)
        rest.sort(key=lambda t: t[0])
        sky = []
        for seg in rest:  # merge neighbours at equal height
            if sky and abs(sky[-1][1] - seg[1]) < 1e-9:
                sky[-1][2] += seg[2]
            else:
                sky.append(seg)
    return pos


baked = {}
for g, objs in groups.items():
    objs = [o for o in objs if len(o.data.polygons)]
    if not objs:
        continue
    res = GROUP_RES.get(g, RES)
    PAD, MIN_CELL = 3.0 / res, 8.0 / res
    for o in objs:
        chart(o)
    weights = [math.sqrt(max(world_area(o), 1e-6)) * (1.25 if o.name.startswith("MXI_") else 1.0) for o in objs]
    lo, hi = 0.0, 1.0 / math.sqrt(sum(w * w for w in weights))  # hi = 100% fill, never fits
    pos = None
    for _ in range(18):  # largest scale that still packs
        k = (lo + hi) / 2
        trial = skyline_pack([max(w * k, MIN_CELL) for w in weights])
        if trial:
            lo, pos = k, trial
        else:
            hi = k
    sizes = [max(w * lo, MIN_CELL) for w in weights]
    for o, s, (x, y) in zip(objs, sizes, pos):
        bake = o.data.uv_layers["BakeUV"]
        uv = uv_get(bake, len(o.data.loops)) * (s - 2 * PAD) + np.array([x + PAD, y + PAD], dtype=np.float32)
        bake.data.foreach_set("uv", uv.ravel())
    select_only(objs)
    bpy.ops.object.join()
    ob = vl.objects.active
    ob.name = ob.data.name = f"BK_{g}"
    uvl = ob.data.uv_layers
    render_uv = next((l for l in uvl if l.name != "BakeUV"), None)
    if render_uv:
        render_uv.active_render = True
    uvl.active = uvl["BakeUV"]
    baked[g] = ob
    used = sum(s * s for s in sizes)
    log(f"BK_{g}: {len(ob.data.polygons)} faces, {len(objs)} charts, atlas fill {used:.0%}")

# ---------------------------------------------------------------- 6. bake lighting
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = False
sc.render.bake.margin = 6
sc.render.bake.use_clear = True


def bake_pass(ob, tag, btype, filt=None, samples=16, res=RES):
    """Bake one pass of `ob` into a float RGBA numpy array (rows bottom-up, alpha = coverage)."""
    img = bpy.data.images.new(f"{ob.name}_{tag}", res, res, alpha=True, float_buffer=True)
    img.generated_color = (0, 0, 0, 0)
    for s in ob.material_slots:
        nt = s.material.node_tree
        n = nt.nodes.new("ShaderNodeTexImage")
        n.name = "__bake__"
        n.image = img
        nt.nodes.active = n
    select_only([ob])
    sc.cycles.samples = samples
    kw = dict(type=btype)
    if filt:
        kw["pass_filter"] = filt
    bpy.ops.object.bake(**kw)
    for s in ob.material_slots:
        nt = s.material.node_tree
        nt.nodes.remove(nt.nodes["__bake__"])
    px = np.empty(res * res * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(res, res, 4)


for g, ob in baked.items():
    res = GROUP_RES.get(g, RES)
    sc.cycles.samples = SAMPLES
    img = bpy.data.images.new(f"BK_{g}_hdr", res, res, float_buffer=True)
    for s in ob.material_slots:
        nt = s.material.node_tree
        n = nt.nodes.new("ShaderNodeTexImage")
        n.name = "__bake__"
        n.image = img
        nt.nodes.active = n
    select_only([ob])
    bpy.ops.object.bake(type="COMBINED",
                        pass_filter={"DIRECT", "INDIRECT", "DIFFUSE", "GLOSSY", "EMIT"})
    for s in ob.material_slots:
        nt = s.material.node_tree
        nt.nodes.remove(nt.nodes["__bake__"])
    path = os.path.join(BAKE_DIR, f"BK_{g}.png")
    img.save_render(path, scene=sc)  # applies AgX Punchy -> display-referred, matches renders
    px = np.empty(res * res * 4, dtype=np.float32)  # keep the linear HDR for grade_cinematic.py
    img.pixels.foreach_get(px)
    np.savez(os.path.join(BAKE_DIR, f"BK_{g}_hdr.npz"), hdr=px.reshape(res, res, 4).astype(np.float16))
    log(f"baked {g} -> {path}")


# ---------------------------------------------------------------- 6b. PBR maps for the live metals
def emit_swap(mats, socket):
    """Route one Principled input straight into an Emission surface, so an EMIT bake records that channel.
    Returns an undo list for emit_restore()."""
    undo = []
    for m in mats:
        nt = m.node_tree
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output),
                   next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"))
        b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        prev = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].is_linked else None
        em = nt.nodes.new("ShaderNodeEmission")
        src = b.inputs[socket]
        if src.is_linked:
            nt.links.new(src.links[0].from_socket, em.inputs["Color"])
        else:
            v = src.default_value
            em.inputs["Color"].default_value = tuple(v) if hasattr(v, "__len__") else (v, v, v, 1.0)
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        undo.append((nt, out, prev, em))
    return undo


def emit_restore(undo):
    for nt, out, prev, em in undo:
        nt.nodes.remove(em)
        if prev is not None:
            nt.links.new(prev, out.inputs["Surface"])


def save_png(rgb, path, srgb):
    """Write an (h, w, 3) array in 0-1 as an 8-bit PNG; `srgb` encodes linear colour first."""
    h, w = rgb.shape[:2]
    rgb = np.clip(rgb, 0.0, 1.0)
    if srgb:
        rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    img = bpy.data.images.new("__save__", w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"  # bytes are written as given
    img.pixels.foreach_set(np.concatenate([rgb, np.ones((h, w, 1))], -1).astype(np.float32).ravel())
    img.filepath_raw, img.file_format = path, "PNG"
    img.save()
    bpy.data.images.remove(img)


if "Live" in baked:
    ob = baked["Live"]
    mats = list({s.material.name: s.material for s in ob.material_slots if s.material}.values())
    maps = {}
    for key, socket in (("base", "Base Color"), ("rough", "Roughness"), ("metal", "Metallic")):
        undo = emit_swap(mats, socket)
        maps[key] = bake_pass(ob, key, "EMIT", None, 16, LIVE_RES)
        emit_restore(undo)
    ao_dist = sc.world.light_settings.distance
    sc.world.light_settings.distance = 0.35  # contact occlusion, not the whole room
    maps["ao"] = bake_pass(ob, "ao", "AO", None, 128, LIVE_RES)
    sc.world.light_settings.distance = ao_dist
    sc.render.bake.normal_space = "TANGENT"
    maps["normal"] = bake_pass(ob, "normal", "NORMAL", None, 16, LIVE_RES)
    save_png(maps["base"][..., :3], os.path.join(BAKE_DIR, "live_base.png"), True)
    save_png(np.stack([maps["ao"][..., 0], maps["rough"][..., 0], maps["metal"][..., 0]], -1),
             os.path.join(BAKE_DIR, "live_orm.png"), False)  # glTF packing: R occlusion, G roughness, B metalness
    save_png(maps["normal"][..., :3], os.path.join(BAKE_DIR, "live_normal.png"), False)
    log("baked live PBR maps (base, orm, normal)")

# ---------------------------------------------------------------- 7. unlit materials on baked groups
def live_fallback(nt, tex, out):
    """BK_Live's material: black, non-metal, the baked atlas as emission. Looks like the unlit groups until
    livemetal.js swaps in PBR, and (unlike KHR_materials_unlit) keeps the NORMAL attribute through gltf-transform's
    prune, which the live lighting needs."""
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (0, 0, 0, 1)
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Specular IOR Level"].default_value = 0.0
    b.inputs["Emission Strength"].default_value = 1.0
    nt.links.new(tex.outputs[0], b.inputs["Emission Color"])
    nt.links.new(b.outputs[0], out.inputs[0])


for g, ob in baked.items():
    m = bpy.data.materials.new(f"M_{g}")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.join(BAKE_DIR, f"BK_{g}.png"))
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "BakeUV"
    nt.links.new(uvn.outputs[0], tex.inputs[0])
    if g == "Live":
        live_fallback(nt, tex, out)
    else:
        bgs = nt.nodes.new("ShaderNodeBackground")
        nt.links.new(tex.outputs[0], bgs.inputs[0])
        nt.links.new(bgs.outputs[0], out.inputs[0])
    ob.data.materials.clear()
    ob.data.materials.append(m)
    for l in [l for l in ob.data.uv_layers if l.name != "BakeUV"]:
        ob.data.uv_layers.remove(l)

# ---------------------------------------------------------------- 8. FX: one mesh per effect, flat emissive
fx_objs = []
for mname, objs in fx.items():
    select_only(objs)
    bpy.ops.object.join()
    ob = vl.objects.active
    short = mname.replace("FH_", "")
    ob.name = ob.data.name = f"FX_{short}"
    src = bpy.data.materials[mname]
    if mname in FX_COLORS:
        col, strength = FX_COLORS[mname]
    else:  # crystals keep their tint
        b = next(n for n in src.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        col, strength = tuple(b.inputs["Emission Color"].default_value)[:3], 3.0
    m = bpy.data.materials.new(f"FXM_{short}")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*col, 1)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs[0])
    ob.data.materials.clear()
    ob.data.materials.append(m)
    for l in list(ob.data.uv_layers):
        ob.data.uv_layers.remove(l)
    fx_objs.append(ob)

# ---------------------------------------------------------------- 9. export
exp = list(baked.values()) + fx_objs + [cam] + [bpy.data.objects[n] for n in markers]
select_only(exp)
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
kw = dict(filepath=os.path.join(WEB, f"{NAME}_raw.glb"), export_format="GLB", use_selection=True,
          export_image_format="WEBP", export_cameras=True, export_lights=False, export_apply=True,
          export_extras=True, export_yup=True, export_tangents=False)
if "export_image_quality" in props:
    kw["export_image_quality"] = 88
bpy.ops.export_scene.gltf(**kw)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, f"{NAME}_web.blend"))
tris = 0
for o in exp:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
log(f"EXPORTED {kw['filepath']}  tris={tris}  size={os.path.getsize(kw['filepath']) / 1e6:.2f} MB")
