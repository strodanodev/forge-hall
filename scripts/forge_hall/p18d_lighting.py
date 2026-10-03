"""p18d: dramatic lighting + torch sconces.

Night is falling: the sky lights the hall far less, the low sun only rims the back of the set, and the forge becomes
the key light. Two iron torch sconces on the centre columns frame the hearth with warm pools, a narrow accent catches
the gold badge, and a warm uplight reads the lintel plaque. Torch flames use FH_TorchFire (exported as FX_TorchFire,
which the web runtime replaces with live fire). Idempotent: rebuilds Torch_* / Lt_Torch* / Lt_Emblem*.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

COL = bpy.data.collections["ForgeHall"]
COLUMNS = ((-3.2, 1.6), (3.2, 1.6))
SHAFT_R = 0.284   # outer radius of the fluted shaft (ray-measured max 0.282)
AIM = Vector((0.0, -2.2))        # sconces turn toward the front of the hall
COLLAR_Z = 2.32

LIGHTS = {  # name: energy, colour  (None keeps the colour)
    "Lt_ForgeSpill": (2300.0, (1.0, 0.42, 0.1)),
    "Lt_ForgeCore": (700.0, None),
    "Lt_ForgeUp": (60.0, None),
    "Lt_Lintel": (170.0, (1.0, 0.68, 0.38)),
    "Lt_OlympusFill": (28.0, (1.0, 0.86, 0.72)),
    "Lt_NorseFill": (55.0, (0.42, 0.58, 1.0)),
    "Lt_Aurora": (380.0, None),
    "Lt_Sun": (1.9, (1.0, 0.5, 0.26)),
    "Smoke_Light": (90.0, None),
}
WORLD_LIGHTING = 0.12  # sky strength for everything but camera rays (was 0.45)
WORLD_CAMERA = 0.65    # the visible sky itself, deeper into dusk (was 1.0)
SPREAD = {"Lt_ForgeSpill": 105, "Lt_Lintel": 70}   # degrees: pools of light instead of a wash (was 180)
EXPOSURE = -0.3        # AgX exposure; the web bake is saved through the same view transform


def _obj(name, me, mat=None):
    o = bpy.data.objects.new(name, me)
    if mat and hasattr(me, "materials"):
        me.materials.append(mat)
    COL.objects.link(o)
    return o


def _mesh(name, build):
    bm = bmesh.new()
    build(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    return me


def _tube(name, pts, r, mat):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions, cu.bevel_depth, cu.bevel_resolution, cu.fill_mode = "3D", r, 2, "FULL"
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    cu.use_fill_caps = True
    return _obj(name, cu, mat)


def fire_material():
    """Soft flame for Blender stills: white-hot core, orange body, edges fading out (the web swaps in live fire)."""
    m = bpy.data.materials.get("FH_TorchFire") or bpy.data.materials.new("FH_TorchFire")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.45
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sz = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sz.inputs["Vector"])
    core = nt.nodes.new("ShaderNodeMath"); core.operation = "MULTIPLY"
    inv = nt.nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1.0
    nt.links.new(lw.outputs["Facing"], inv.inputs[1])
    up = nt.nodes.new("ShaderNodeMath"); up.operation = "SUBTRACT"; up.inputs[0].default_value = 1.0
    nt.links.new(sz.outputs["Z"], up.inputs[1])
    nt.links.new(inv.outputs[0], core.inputs[0])
    nt.links.new(up.outputs[0], core.inputs[1])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = 0.0, (0.9, 0.12, 0.01, 1)
    el[1].position, el[1].color = 0.75, (1.0, 0.85, 0.5, 1)
    e = el.new(0.4); e.color = (1.0, 0.42, 0.06, 1)
    nt.links.new(core.outputs[0], ramp.inputs["Fac"])
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 9.0
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    alpha = nt.nodes.new("ShaderNodeMapRange")
    alpha.inputs["From Min"].default_value, alpha.inputs["From Max"].default_value = 0.05, 0.5
    nt.links.new(core.outputs[0], alpha.inputs["Value"])
    nt.links.new(alpha.outputs["Result"], mix.inputs["Fac"])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    m.diffuse_color = (1.0, 0.45, 0.1, 1)
    return m


def wrap_material():
    m = bpy.data.materials.get("FH_TorchWrap") or bpy.data.materials.new("FH_TorchWrap")
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (0.03, 0.02, 0.014, 1)
    b.inputs["Roughness"].default_value = 0.95
    b.inputs["Emission Color"].default_value = (1.0, 0.3, 0.05, 1)
    b.inputs["Emission Strength"].default_value = 1.2
    return m


def sconce(i, cx, cy):
    iron, wood, fire, wrap = (bpy.data.materials["FH_Iron"], bpy.data.materials["FH_TableWood"],
                              fire_material(), wrap_material())
    out = (AIM - Vector((cx, cy))).normalized()
    yaw = math.atan2(out.x, -out.y)  # local -Y (front) -> out
    M = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(yaw, 4, "Z")
    tag = "L" if cx < 0 else "R"
    objs = []

    def P(x, y, z):  # local: -y = away from the column
        return M @ Vector((x, y, z))

    r = SHAFT_R
    # collar band + lower band, hugging the shaft
    for k, z in enumerate((COLLAR_Z, COLLAR_Z - 0.34)):
        me = _mesh(f"Torch_{tag}_Collar{k}", lambda bm: bmesh.ops.create_cone(
            bm, cap_ends=False, segments=40, radius1=r, radius2=r, depth=0.055))
        o = _obj(f"Torch_{tag}_Collar{k}", me, iron)
        o.matrix_world = M @ Matrix.Translation((0, 0, z))
        sol = o.modifiers.new("Solid", "SOLIDIFY")
        sol.thickness, sol.offset = 0.014, 1.0
        bev = o.modifiers.new("Bevel", "BEVEL")
        bev.width, bev.segments = 0.004, 2
        objs.append(o)
    # arm: straight out of the collar, sweeping up into the cup; a brace from the lower band meets it
    cup = P(0, -(r + 0.36), COLLAR_Z + 0.12)
    objs.append(_tube(f"Torch_{tag}_Arm", [P(0, -(r + 0.005), COLLAR_Z), P(0, -(r + 0.19), COLLAR_Z + 0.005),
                                           cup - Vector((0, 0, 0.035))], 0.017, iron))
    objs.append(_tube(f"Torch_{tag}_Brace", [P(0, -(r + 0.005), COLLAR_Z - 0.34), P(0, -(r + 0.1), COLLAR_Z - 0.22),
                                             P(0, -(r + 0.18), COLLAR_Z - 0.01)], 0.011, iron))
    # cup: flared iron ring with six prongs
    me = _mesh(f"Torch_{tag}_Cup", lambda bm: bmesh.ops.create_cone(
        bm, cap_ends=True, segments=24, radius1=0.06, radius2=0.092, depth=0.09))
    o = _obj(f"Torch_{tag}_Cup", me, iron)
    o.matrix_world = Matrix.Translation(cup)
    objs.append(o)
    for k in range(6):
        a = k / 6 * math.tau
        base = cup + Vector((math.cos(a) * 0.088, math.sin(a) * 0.088, 0.04))
        tip = cup + Vector((math.cos(a) * 0.11, math.sin(a) * 0.11, 0.21))
        objs.append(_tube(f"Torch_{tag}_Prong{k}", [base, (base + tip) / 2 + Vector((0, 0, 0.01)), tip], 0.005, iron))
    # torch: wooden handle + pitch-soaked wrap
    me = _mesh(f"Torch_{tag}_Handle", lambda bm: bmesh.ops.create_cone(
        bm, cap_ends=True, segments=12, radius1=0.028, radius2=0.038, depth=0.5))
    o = _obj(f"Torch_{tag}_Handle", me, wood)
    o.matrix_world = Matrix.Translation(cup + Vector((0, 0, 0.15)))
    objs.append(o)
    me = _mesh(f"Torch_{tag}_Wrap", lambda bm: bmesh.ops.create_cone(
        bm, cap_ends=True, segments=12, radius1=0.054, radius2=0.046, depth=0.15))
    o = _obj(f"Torch_{tag}_Wrap", me, wrap)
    head = cup + Vector((0, 0, 0.44))
    o.matrix_world = Matrix.Translation(head)
    objs.append(o)
    # flame: nested tapering cones (live fire replaces them on the web)
    for k in range(2):
        me = _mesh(f"Torch_{tag}_Flame{k}", lambda bm: bmesh.ops.create_cone(
            bm, cap_ends=True, segments=16, radius1=0.075 - k * 0.027, radius2=0.005, depth=0.42 - k * 0.14))
        o = _obj(f"Torch_{tag}_Flame{k}", me, fire)
        o.matrix_world = Matrix.Translation(head + Vector((0, 0, 0.26 - k * 0.07)))
        objs.append(o)
    # light at the flame
    ld = bpy.data.lights.new(f"Lt_Torch{tag}", "POINT")
    ld.energy, ld.color, ld.shadow_soft_size = 150.0, (1.0, 0.48, 0.16), 0.08
    lo = bpy.data.objects.new(f"Lt_Torch{tag}", ld)
    lo.location = head + Vector((0, 0, 0.22))
    COL.objects.link(lo)
    return objs


def emblem_accent():
    """A narrow warm spot from low in front of the hearth: the badge's gold relief catches it."""
    ld = bpy.data.lights.new("Lt_EmblemKey", "SPOT")
    ld.energy, ld.color, ld.spot_size, ld.spot_blend, ld.shadow_soft_size = 160.0, (1.0, 0.72, 0.42), math.radians(16), 0.6, 0.15
    lo = bpy.data.objects.new("Lt_EmblemKey", ld)
    lo.location = (0.35, -2.6, 0.9)
    tgt = Vector((0.0, 1.15, 2.97))
    lo.rotation_euler = (tgt - lo.location).to_track_quat("-Z", "Y").to_euler()
    COL.objects.link(lo)


def world():
    w = bpy.context.scene.world
    mr = next(n for n in w.node_tree.nodes if n.type == "MAP_RANGE" and n.inputs["Value"].is_linked
              and n.inputs["Value"].links[0].from_node.type == "LIGHT_PATH")
    mr.inputs["To Min"].default_value = WORLD_LIGHTING
    mr.inputs["To Max"].default_value = WORLD_CAMERA


def apply():
    for o in [o for o in bpy.data.objects if o.name.startswith(("Torch_", "Lt_Torch", "Lt_EmblemKey"))]:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            for coll in (bpy.data.meshes, bpy.data.curves, bpy.data.lights):
                if data.name in coll and coll[data.name] == data:
                    coll.remove(data)
                    break
    for name, (energy, colour) in LIGHTS.items():
        lt = bpy.data.objects[name].data
        lt.energy = energy
        if colour:
            lt.color = colour
    for name, deg in SPREAD.items():
        bpy.data.objects[name].data.spread = math.radians(deg)
    bpy.context.scene.view_settings.exposure = EXPOSURE
    world()
    for i, (cx, cy) in enumerate(COLUMNS):
        sconce(i, cx, cy)
    emblem_accent()
    print("p18d lighting + sconces applied")


if __name__ == "__main__":
    apply()
