# ===================== shared helpers for the FORGE hall build =====================
import bpy, bmesh, math, random
from mathutils import Vector, Matrix

R = math.radians
rng = random.Random(7)
COLNAME = "ForgeHall"
FONTS = {"sym": r"C:\Windows\Fonts\seguisym.ttf",
         "rune": r"C:\Windows\Fonts\seguihis.ttf",
         "title": r"C:\Windows\Fonts\Cinzel-Bold.ttf"}


def _col():
    return bpy.data.collections[COLNAME]


if COLNAME in bpy.data.collections:
    _vl = bpy.context.view_layer
    _vl.active_layer_collection = _vl.layer_collection.children[COLNAME]


def font(key):
    p = FONTS[key].lower()
    for f in bpy.data.fonts:
        if bpy.path.abspath(f.filepath).lower() == p:
            return f
    return bpy.data.fonts.load(FONTS[key])


# ------------------------------- node utilities -------------------------------
def new_mat(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    return m, nt, b, out


def N(nt, kind, **props):
    n = nt.nodes.new(kind)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def L(nt, a, b):
    nt.links.new(a, b)


def sock(n, ident, out=False):
    for s in (n.outputs if out else n.inputs):
        if s.identifier == ident:
            return s
    raise KeyError(ident)


def ramp(nt, stops):
    r = N(nt, "ShaderNodeValToRGB")
    els = r.color_ramp.elements
    els[0].position, els[0].color = stops[0][0], (*stops[0][1], 1)
    els[1].position, els[1].color = stops[-1][0], (*stops[-1][1], 1)
    for p, c in stops[1:-1]:
        e = els.new(p)
        e.color = (*c, 1)
    return r


def coords(nt, plane="xyz", scale=1.0, space="Object"):
    tc = N(nt, "ShaderNodeTexCoord")
    v = tc.outputs[space]
    if plane != "xyz":
        sep = N(nt, "ShaderNodeSeparateXYZ")
        L(nt, v, sep.inputs[0])
        comb = N(nt, "ShaderNodeCombineXYZ")
        for i, ch in enumerate(plane):
            L(nt, sep.outputs["xyz".index(ch)], comb.inputs[i])
        v = comb.outputs[0]
    if scale != 1.0:
        mul = N(nt, "ShaderNodeVectorMath", operation="SCALE")
        L(nt, v, mul.inputs[0])
        mul.inputs["Scale"].default_value = scale
        v = mul.outputs[0]
    return v


def bump(nt, b, height, strength=0.3, dist=0.02, invert=False):
    bp = N(nt, "ShaderNodeBump")
    bp.invert = invert
    bp.inputs["Strength"].default_value = strength
    bp.inputs["Distance"].default_value = dist
    L(nt, height, bp.inputs["Height"])
    L(nt, bp.outputs["Normal"], b.inputs["Normal"])


def mix_rgb(nt, blend, fac, a, b):
    mx = N(nt, "ShaderNodeMix", data_type="RGBA", blend_type=blend)
    if isinstance(fac, float):
        sock(mx, "Factor_Float").default_value = fac
    else:
        L(nt, fac, sock(mx, "Factor_Float"))
    for ident, v in (("A_Color", a), ("B_Color", b)):
        if isinstance(v, tuple):
            sock(mx, ident).default_value = (*v, 1)
        else:
            L(nt, v, sock(mx, ident))
    return sock(mx, "Result_Color", out=True)


# --------------------------------- materials ----------------------------------
def m_basic(name, color, rough=0.6, metal=0.0, emit=None, strength=0.0):
    m, nt, b, _ = new_mat(name)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    m.diffuse_color = (*(emit or color), 1)
    return m


def m_noise(name, c1, c2, scale=2.0, rough=0.85, bump_s=0.4, metal=0.0, detail=8.0):
    m, nt, b, _ = new_mat(name)
    nz = N(nt, "ShaderNodeTexNoise")
    nz.inputs["Detail"].default_value = detail
    L(nt, coords(nt, scale=scale), nz.inputs["Vector"])
    r = ramp(nt, [(0.3, c1), (0.72, c2)])
    L(nt, nz.outputs["Fac"], r.inputs["Fac"])
    L(nt, r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    bump(nt, b, nz.outputs["Fac"], bump_s, 0.05)
    m.diffuse_color = (*c1, 1)
    return m


def m_brick(name, c1, c2, mortar, bw, rh, plane="xy", mortar_size=0.015, rough=0.85,
            bump_s=0.6, grime=0.35):
    m, nt, b, _ = new_mat(name)
    v = coords(nt, plane)
    br = N(nt, "ShaderNodeTexBrick")
    L(nt, v, br.inputs["Vector"])
    br.inputs["Color1"].default_value = (*c1, 1)
    br.inputs["Color2"].default_value = (*c2, 1)
    br.inputs["Mortar"].default_value = (*mortar, 1)
    br.inputs["Scale"].default_value = 1.0
    br.inputs["Mortar Size"].default_value = mortar_size
    br.inputs["Brick Width"].default_value = bw
    br.inputs["Row Height"].default_value = rh
    nz = N(nt, "ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 3.0
    nz.inputs["Detail"].default_value = 10.0
    L(nt, v, nz.inputs["Vector"])
    g = ramp(nt, [(0.35, (0.55, 0.55, 0.55)), (0.7, (1, 1, 1))])
    L(nt, nz.outputs["Fac"], g.inputs["Fac"])
    col = mix_rgb(nt, "MULTIPLY", grime, br.outputs["Color"], g.outputs["Color"])
    L(nt, col, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    bump(nt, b, br.outputs["Fac"], bump_s, 0.03, invert=True)
    m.diffuse_color = (*c1, 1)
    return m


def m_wood(name, c1, c2, bands="Z", scale=3.0, rough=0.7, distortion=7.0):
    m, nt, b, _ = new_mat(name)
    wv = N(nt, "ShaderNodeTexWave", wave_type="BANDS", bands_direction=bands)
    wv.inputs["Scale"].default_value = scale
    wv.inputs["Distortion"].default_value = distortion
    wv.inputs["Detail"].default_value = 3.0
    L(nt, coords(nt), wv.inputs["Vector"])
    r = ramp(nt, [(0.2, c1), (0.8, c2)])
    L(nt, wv.outputs["Fac"], r.inputs["Fac"])
    L(nt, r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    bump(nt, b, wv.outputs["Fac"], 0.25, 0.01)
    m.diffuse_color = (*c1, 1)
    return m


def m_marble(name, base=(0.88, 0.85, 0.79), vein=(0.55, 0.52, 0.48)):
    m, nt, b, _ = new_mat(name)
    wv = N(nt, "ShaderNodeTexWave", wave_type="BANDS", bands_direction="DIAGONAL")
    wv.inputs["Scale"].default_value = 1.5
    wv.inputs["Distortion"].default_value = 14.0
    wv.inputs["Detail"].default_value = 6.0
    L(nt, coords(nt), wv.inputs["Vector"])
    r = ramp(nt, [(0.0, vein), (0.12, base), (1.0, base)])
    L(nt, wv.outputs["Fac"], r.inputs["Fac"])
    L(nt, r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.3
    m.diffuse_color = (*base, 1)
    return m


def m_fire(name, strength=12.0, scale=3.0):
    m, nt, b, _ = new_mat(name)
    nz = N(nt, "ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = 8.0
    nz.inputs["Distortion"].default_value = 2.0
    L(nt, coords(nt), nz.inputs["Vector"])
    r = ramp(nt, [(0.3, (0.6, 0.05, 0.0)), (0.5, (1.0, 0.35, 0.02)), (0.7, (1.0, 0.8, 0.3))])
    L(nt, nz.outputs["Fac"], r.inputs["Fac"])
    b.inputs["Base Color"].default_value = (0, 0, 0, 1)
    L(nt, r.outputs["Color"], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = strength
    m.diffuse_color = (1, 0.4, 0.05, 1)
    return m


def m_volume(name, color, density=0.6, emit=0.4, scale=2.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = N(nt, "ShaderNodeOutputMaterial")
    vol = N(nt, "ShaderNodeVolumePrincipled")
    nz = N(nt, "ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = 6.0
    L(nt, coords(nt, space="Generated"), nz.inputs["Vector"])
    # soft falloff to the box edges using a spherical gradient
    gr = N(nt, "ShaderNodeTexGradient", gradient_type="SPHERICAL")
    tc = N(nt, "ShaderNodeTexCoord")
    L(nt, tc.outputs["Object"], gr.inputs["Vector"])
    mr = N(nt, "ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.45
    mr.inputs["From Max"].default_value = 0.75
    mr.inputs["To Max"].default_value = density
    L(nt, nz.outputs["Fac"], mr.inputs["Value"])
    mul = N(nt, "ShaderNodeMath", operation="MULTIPLY")
    L(nt, mr.outputs["Result"], mul.inputs[0])
    L(nt, gr.outputs["Fac"], mul.inputs[1])
    L(nt, mul.outputs[0], vol.inputs["Density"])
    vol.inputs["Color"].default_value = (*color, 1)
    vol.inputs["Emission Color"].default_value = (*color, 1)
    vol.inputs["Emission Strength"].default_value = emit
    L(nt, vol.outputs[0], out.inputs["Volume"])
    return m


# ------------------------------ geometry helpers ------------------------------
ADD = {
    "cube":  lambda **k: bpy.ops.mesh.primitive_cube_add(size=1, **k),
    "cyl":   bpy.ops.mesh.primitive_cylinder_add,
    "cone":  bpy.ops.mesh.primitive_cone_add,
    "ico":   bpy.ops.mesh.primitive_ico_sphere_add,
    "uv":    bpy.ops.mesh.primitive_uv_sphere_add,
    "torus": bpy.ops.mesh.primitive_torus_add,
    "plane": lambda **k: bpy.ops.mesh.primitive_plane_add(size=1, **k),
}


def shade_smooth(o):
    try:
        o.data.shade_smooth()
    except AttributeError:
        for p in o.data.polygons:
            p.use_smooth = True


def prim(kind, name, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0), m=None, bevel=0.0,
         seg=2, smooth=False, parent=None, **kw):
    ADD[kind](location=loc, rotation=tuple(R(a) for a in rot), **kw)
    o = bpy.context.active_object
    o.name = name
    if tuple(scale) != (1, 1, 1):
        o.data.transform(Matrix.Diagonal((*scale, 1.0)))
    if bevel:
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width, mod.segments, mod.limit_method = bevel, seg, "ANGLE"
    if smooth:
        shade_smooth(o)
    if m:
        o.data.materials.append(m)
    if parent:
        o.parent = parent
    return o


def _link(o, loc, rot, parent, m=None):
    _col().objects.link(o)
    o.location = loc
    o.rotation_euler = tuple(R(a) for a in rot)
    if parent:
        o.parent = parent
    if m:
        o.data.materials.append(m)
    return o


def empty(name, loc=(0, 0, 0), rot=(0, 0, 0), parent=None):
    return _link(bpy.data.objects.new(name, None), loc, rot, parent)


def text(name, body, fkey, size, loc, rot=(90, 0, 0), m=None, extrude=0.01, parent=None,
         align="CENTER", spacing=1.0):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.font = font(fkey)
    cu.size = size
    cu.extrude = extrude
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.space_character = spacing
    return _link(bpy.data.objects.new(name, cu), loc, rot, parent, m)


def elbow_pts(pts, rad, n=6):
    """Polyline with rounded corners (pipe elbows)."""
    pts = [Vector(p) for p in pts]
    out = [pts[0]]
    for a, p, b in zip(pts, pts[1:], pts[2:]):
        da, db = (p - a).normalized(), (b - p).normalized()
        r = min(rad, (p - a).length / 2, (b - p).length / 2)
        p0, p2 = p - da * r, p + db * r
        for i in range(n + 1):
            t = i / n
            out.append((1 - t) ** 2 * p0 + 2 * (1 - t) * t * p + t * t * p2)
    out.append(pts[-1])
    return out


def tube(name, pts, r, m=None, parent=None, cyclic=False, elbow=0.0, caps=True, res=4):
    if elbow:
        pts = elbow_pts(pts, elbow)
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = res
    cu.use_fill_caps = caps
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for pt, p in zip(sp.points, pts):
        pt.co = (*p, 1)
    sp.use_cyclic_u = cyclic
    sp.use_smooth = True
    return _link(bpy.data.objects.new(name, cu), (0, 0, 0), (0, 0, 0), parent, m)


def prism(name, outline, y0, y1, m=None, loc=(0, 0, 0), rot=(0, 0, 0), parent=None):
    """Extrude an XZ outline along Y."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    f = [bm.verts.new((x, y0, z)) for x, z in outline]
    k = [bm.verts.new((x, y1, z)) for x, z in outline]
    bm.faces.new(f)
    bm.faces.new(list(reversed(k)))
    for i in range(len(outline)):
        j = (i + 1) % len(outline)
        bm.faces.new((f[i], f[j], k[j], k[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    return _link(bpy.data.objects.new(name, me), loc, rot, parent, m)


def frustum(name, lb, wb, lt, wt, h, m=None, loc=(0, 0, 0), rot=(0, 0, 0), parent=None):
    """Box whose top is smaller than its bottom (ingots, anvil feet)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [bm.verts.new((sx * l / 2, sy * w / 2, z))
          for z, l, w in ((0, lb, wb), (h, lt, wt))
          for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    bm.faces.new(vs[3::-1])
    bm.faces.new(vs[4:])
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((vs[i], vs[j], vs[4 + j], vs[4 + i]))
    bm.to_mesh(me)
    bm.free()
    return _link(bpy.data.objects.new(name, me), loc, rot, parent, m)


def arch_outline(w, h, z0=0.0, n=20):
    r = w / 2
    pts = [(-r, z0), (r, z0), (r, z0 + h)]
    pts += [(r * math.cos(math.pi * i / n), z0 + h + r * math.sin(math.pi * i / n)) for i in range(1, n)]
    pts += [(-r, z0 + h)]
    return pts


def rock(name, loc, scale, m, detail=4, strength=0.5, noise=0.9, rot=(0, 0, 0)):
    tname = f"RockNoise_{noise}"
    tex = bpy.data.textures.get(tname) or bpy.data.textures.new(tname, "CLOUDS")
    tex.noise_scale = noise
    tex.noise_depth = 3
    o = prim("ico", name, loc, scale, rot, m=m, radius=1.0, subdivisions=detail)
    d = o.modifiers.new("Displace", "DISPLACE")
    d.texture, d.strength, d.mid_level = tex, strength, 0.5
    d.texture_coords = "GLOBAL"
    shade_smooth(o)
    return o


def orient(o, xaxis, zaxis, loc):
    x = Vector(xaxis).normalized()
    z = Vector(zaxis).normalized()
    y = z.cross(x)
    mt = Matrix((x, y, z)).transposed().to_4x4()
    mt.translation = Vector(loc)
    o.matrix_world = mt


def light(name, kind, loc, power, color, size=0.1, rot=(0, 0, 0), spot=None, aim=None):
    d = bpy.data.lights.new(name, kind)
    d.energy, d.color = power, color
    if kind in ("POINT", "SPOT"):
        d.shadow_soft_size = size
    elif kind == "AREA":
        d.size = size
    elif kind == "SUN":
        d.angle = R(size)
    if spot:
        d.spot_size, d.spot_blend = R(spot), 0.5
    o = _link(bpy.data.objects.new(name, d), loc, rot, None)
    if aim is not None:
        o.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o


def rot_toward(frm, to):
    """Z rotation (deg) so a unit's local -Y front faces the point `to`."""
    d = Vector(to) - Vector(frm)
    return math.degrees(math.atan2(d.x, -d.y))


def MT(name):
    return bpy.data.materials[name]
