"""p18b: the LitVM caduceus as an embossed metal badge on the hearth dome (replaces the Meshy medallion).

Needs assets/logo/litvm_caduceus.json (scripts/forge_hall/logo_trace.py). Builds, flat in a local frame:
  Emblem_Plate   blackened hammered steel, cut to the logo's silhouette (a winged badge)
  Emblem_Rim     round gold piping just inside the plate edge
  Emblem_Art     the logo itself, raised gold relief with rounded edges
  Emblem_Rivets  small domed rivets around the rim
then wraps everything onto a sphere fitted to the dome around the badge (exponential map, so the art keeps its
proportions and its relief stays normal to the dome), and presses the old Meshy medallion + brick relief under the
footprint back below the plate. Idempotent: rebuilds the Emblem_* objects; the hearth vertices are only ever pushed in.
run via MCP (exec) or: blender -b forge_hall.blend --python scripts/forge_hall/p18b_emblem.py -- --save
"""
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) if "__file__" in globals() \
    else r"C:\Users\strodano\Documents\LitVM Games\blender"
LOGO = os.path.join(ROOT, "assets", "logo", "litvm_caduceus.json")
COL = bpy.data.collections["ForgeHall"]
HEARTH = "MXI_Hearth"

SCALE = 0.96        # metres per logo unit (art height): plate ~1.05 m wide
CENTRE_Z = 2.99     # badge centre height on the dome front
STANDOFF = 0.022    # plate back above the fitted dome sphere
PLATE_T = 0.026     # plate thickness
ART_T = 0.011       # relief height above the plate face
RIM_INSET = 0.016   # gold piping inset from the plate edge
RIM_R = 0.0085


# ------------------------------------------------------------------ materials
def _mat(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    return m, nt, b


def gold_material():
    """Polished, slightly worn gold: smoother on raised faces, darker and rougher down in the recesses."""
    m, nt, b = _mat("FH_EmblemGold")
    n = nt.nodes.new
    b.inputs["Metallic"].default_value = 1.0
    tc = n("ShaderNodeTexCoord")
    noise = n("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 38.0; noise.inputs["Detail"].default_value = 6.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ao = n("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = 0.025; ao.samples = 8
    # colour: bright gold -> deep antique gold in cavities
    mix = n("ShaderNodeMix"); mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (0.32, 0.17, 0.05, 1)
    mix.inputs["B"].default_value = (1.0, 0.70, 0.30, 1)
    cav = n("ShaderNodeMapRange"); cav.inputs["From Min"].default_value = 0.35; cav.inputs["From Max"].default_value = 0.95
    nt.links.new(ao.outputs["AO"], cav.inputs["Value"])
    nt.links.new(cav.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], b.inputs["Base Color"])
    # roughness: 0.16-0.3 on the faces, 0.45 in the cavities
    rr = n("ShaderNodeMapRange"); rr.inputs["To Min"].default_value = 0.14; rr.inputs["To Max"].default_value = 0.32
    nt.links.new(noise.outputs["Fac"], rr.inputs["Value"])
    rmix = n("ShaderNodeMix"); rmix.data_type = "FLOAT"
    rmix.inputs["B"].default_value = 0.5
    inv = n("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1.0
    nt.links.new(cav.outputs["Result"], inv.inputs[1])
    nt.links.new(inv.outputs[0], rmix.inputs["Factor"])
    nt.links.new(rr.outputs["Result"], rmix.inputs["A"])
    nt.links.new(rmix.outputs["Result"], b.inputs["Roughness"])
    # fine brushed scratches
    sc = n("ShaderNodeTexNoise"); sc.inputs["Scale"].default_value = 900.0; sc.inputs["Detail"].default_value = 2.0
    nt.links.new(tc.outputs["Object"], sc.inputs["Vector"])
    bump = n("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.08; bump.inputs["Distance"].default_value = 0.0004
    nt.links.new(sc.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    m.diffuse_color = (1.0, 0.7, 0.3, 1)
    m["live_pbr"] = {"color": [1.0, 0.70, 0.30], "metalness": 1.0, "roughness": 0.24}
    return m


def steel_material():
    """Blackened, hand-hammered steel: dark, satin, hammer dimples catching the fire."""
    m, nt, b = _mat("FH_EmblemSteel")
    n = nt.nodes.new
    b.inputs["Metallic"].default_value = 1.0
    tc = n("ShaderNodeTexCoord")
    vor = n("ShaderNodeTexVoronoi"); vor.feature = "SMOOTH_F1"; vor.inputs["Scale"].default_value = 70.0
    nt.links.new(tc.outputs["Object"], vor.inputs["Vector"])
    bump = n("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.25; bump.inputs["Distance"].default_value = 0.002
    nt.links.new(vor.outputs["Distance"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    noise = n("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 12.0; noise.inputs["Detail"].default_value = 8.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = n("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = 0.35, (0.022, 0.02, 0.019, 1)
    ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = 0.7, (0.065, 0.056, 0.05, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    rr = n("ShaderNodeMapRange"); rr.inputs["To Min"].default_value = 0.3; rr.inputs["To Max"].default_value = 0.5
    nt.links.new(noise.outputs["Fac"], rr.inputs["Value"])
    nt.links.new(rr.outputs["Result"], b.inputs["Roughness"])
    m.diffuse_color = (0.06, 0.055, 0.05, 1)
    m["live_pbr"] = {"color": [0.07, 0.065, 0.06], "metalness": 1.0, "roughness": 0.5}
    return m


# ------------------------------------------------------------------ flat geometry (local frame: x right, y up, z out)
def _curve(name, loops, extrude, bevel, bevel_res=1, offset=0.0):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions, cu.fill_mode = "2D", "BOTH"
    cu.extrude, cu.bevel_depth, cu.bevel_resolution = extrude, bevel, bevel_res
    cu.offset = offset
    for loop in loops:
        sp = cu.splines.new("POLY")
        sp.points.add(len(loop) - 1)
        for p, (x, y) in zip(sp.points, loop):
            p.co = (x, y, 0.0, 1.0)
        sp.use_cyclic_u = True
    ob = bpy.data.objects.new(name, cu)
    COL.objects.link(ob)
    return ob


def _to_mesh(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    name, loc = ob.name, ob.location.copy()
    cu = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    new = bpy.data.objects.new(name, me)
    new.location = loc
    me.name = name
    COL.objects.link(new)
    return new


def _offset_polygon(poly, d):
    """Inset a closed polygon by d (positive = inward), miter-free: average of the two edge normals."""
    P = np.asarray(poly)
    area = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    sgn = 1.0 if area > 0 else -1.0  # CCW: inward normal of edge (dx, dy) is (-dy, dx)
    nxt, prv = np.roll(P, -1, 0), np.roll(P, 1, 0)
    def nrm(e):
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        return sgn * np.c_[-e[:, 1], e[:, 0]]
    n = nrm(nxt - P) + nrm(P - prv)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    return P + d * n


def _smooth(poly, it=2):
    P = np.asarray(poly, float)
    for _ in range(it):
        P = 0.25 * np.roll(P, 1, 0) + 0.5 * P + 0.25 * np.roll(P, -1, 0)
    return P


def build_flat():
    D = json.load(open(LOGO))
    plate = _smooth(np.array(D["plate"][0]) * SCALE, 3)
    art = [np.array(a) * SCALE for a in D["art"]]
    # plate: extrude is half-thickness; z from 0 (back) to PLATE_T (face)
    po = _curve("Emblem_Plate", [plate], PLATE_T / 2 - 0.004, 0.004, 2)
    po.location.z = PLATE_T / 2
    # relief: sits on the plate face (sinks 1 mm into it so no seam shows)
    ao = _curve("Emblem_Art", art, ART_T / 2 - 0.0012, 0.0012, 1)
    ao.location.z = PLATE_T + ART_T / 2 - 0.001
    # gold piping inset from the plate edge (round tube)
    rim_path = _offset_polygon(plate, RIM_INSET)
    cu = bpy.data.curves.new("Emblem_Rim", "CURVE")
    cu.dimensions, cu.bevel_depth, cu.bevel_resolution, cu.fill_mode = "3D", RIM_R, 3, "FULL"
    sp = cu.splines.new("POLY")
    sp.points.add(len(rim_path) - 1)
    for p, (x, y) in zip(sp.points, rim_path):
        p.co = (x, y, PLATE_T + 0.002, 1.0)
    sp.use_cyclic_u = True
    ro = bpy.data.objects.new("Emblem_Rim", cu)
    COL.objects.link(ro)
    objs = [_to_mesh(po), _to_mesh(ao), _to_mesh(ro)]
    # rivets: evenly spaced along the piping path, just inside it
    path = _offset_polygon(plate, RIM_INSET + 0.022)
    seg = np.linalg.norm(np.roll(path, -1, 0) - path, axis=1)
    s = np.r_[0, np.cumsum(seg)]
    n_riv = 22
    bm = bmesh.new()
    for k in range(n_riv):
        t = (k + 0.5) / n_riv * s[-1]
        i = int(np.searchsorted(s, t)) - 1
        f = (t - s[i]) / max(seg[i % len(seg)], 1e-9)
        p = path[i % len(path)] * (1 - f) + path[(i + 1) % len(path)] * f
        geom = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=5, radius=0.0085)
        for v in geom["verts"]:
            v.co.z = max(v.co.z, 0.0) * 0.55 + PLATE_T
            v.co.x += p[0]
            v.co.y += p[1]
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new("Emblem_Rivets")
    bm.to_mesh(me)
    bm.free()
    rv = bpy.data.objects.new("Emblem_Rivets", me)
    COL.objects.link(rv)
    objs.append(rv)
    return objs, plate


# ------------------------------------------------------------------ dome fit + wrap
def fit_sphere():
    sc = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    P = []
    for z in np.linspace(2.3, 3.6, 27):
        for x in np.linspace(-0.85, 0.85, 35):
            if abs(x) < 0.42 and 2.5 < z < 3.42:
                continue
            hit, loc, nor, _, ob, _ = sc.ray_cast(dg, Vector((x, -6, z)), Vector((0, 1, 0)))
            if hit and ob.name == HEARTH and nor.y < -0.2:
                P.append(tuple(loc))
    P = np.array(P)
    for _ in range(2):  # fit, drop outliers, refit
        A = np.c_[2 * P, np.ones(len(P))]
        sol = np.linalg.lstsq(A, (P ** 2).sum(1), rcond=None)[0]
        c = sol[:3]
        r = math.sqrt(sol[3] + c @ c)
        res = np.linalg.norm(P - c, axis=1) - r
        P = P[np.abs(res) < 2.5 * res.std()]
    return c, r


def frame(c, r):
    y = c[1] - math.sqrt(r * r - (CENTRE_Z - c[2]) ** 2)
    n0 = Vector((0.0, y - c[1], CENTRE_Z - c[2])).normalized()
    eu = Vector((1.0, 0.0, 0.0))
    ev = n0.cross(eu).normalized() * -1.0  # up along the surface
    if ev.z < 0:
        ev = -ev
    return n0, eu, ev


def _dice(me, step=0.05):
    """Cut every face on a grid so long flat triangles follow the dome once wrapped (a 0.9 m chord would sag 7 cm)."""
    bm = bmesh.new()
    bm.from_mesh(me)
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    for axis, lo, hi in ((0, min(xs), max(xs)), (1, min(ys), max(ys))):
        k = math.ceil(lo / step)
        while k * step < hi:
            co, no = Vector((0, 0, 0)), Vector((0, 0, 0))
            co[axis], no[axis] = k * step, 1.0
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no)
            k += 1
    bm.to_mesh(me)
    bm.free()


def wrap(objs, c, r, n0, eu, ev):
    C = Vector(c)
    R0 = r + STANDOFF
    for ob in objs:
        me = ob.data
        if ob.name != "Emblem_Rivets":
            _dice(me)
        loc = ob.location.copy()
        for v in me.vertices:
            u, w_, h = v.co.x + loc.x, v.co.y + loc.y, v.co.z + loc.z
            rho = math.hypot(u, w_)
            th = rho / R0
            d = n0 * math.cos(th) + ((eu * u + ev * w_) / rho) * math.sin(th) if rho > 1e-9 else n0.copy()
            v.co = C + d * (R0 + h)
        ob.location = (0, 0, 0)
        me.update()
        me.shade_smooth()


def _inside(poly, pts):
    """Even-odd point-in-polygon for many points (numpy)."""
    x, y = pts[:, 0], pts[:, 1]
    P = np.asarray(poly)
    xi, yi = P[:, 0], P[:, 1]
    xj, yj = np.roll(xi, 1), np.roll(yi, 1)
    inside = np.zeros(len(pts), bool)
    for a, b, c_, d in zip(xi, yi, xj, yj):
        cond = ((b > y) != (d > y)) & (x < (c_ - a) * (y - b) / ((d - b) + 1e-12) + a)
        inside ^= cond
    return inside


def press(plate, c, r, n0, eu, ev):
    h = bpy.data.objects[HEARTH]
    mw, mwi = h.matrix_world, h.matrix_world.inverted()
    C = np.array(c)
    R0 = r + STANDOFF
    V = np.array([tuple(mw @ v.co) for v in h.data.vertices])
    D = V - C
    dist = np.linalg.norm(D, axis=1)
    dirs = D / dist[:, None]
    # inverse exponential map: angle from n0 and direction in the tangent plane
    n0a, eua, eva = np.array(n0), np.array(eu), np.array(ev)
    cos_t = np.clip(dirs @ n0a, -1, 1)
    th = np.arccos(cos_t)
    tang = dirs - cos_t[:, None] * n0a
    tl = np.linalg.norm(tang, axis=1) + 1e-12
    u = (tang @ eua) / tl * th * R0
    v = (tang @ eva) / tl * th * R0
    foot = _offset_polygon(plate, -0.004)  # a hair wider than the plate
    near = (cos_t > 0.8)
    inside = np.zeros(len(V), bool)
    inside[near] = _inside(foot, np.c_[u[near], v[near]])
    limit = R0 - 0.006
    hit = inside & (dist > limit)
    newd = np.where(hit, limit, dist)
    W = C + dirs * newd[:, None]
    for i in np.nonzero(hit)[0]:
        h.data.vertices[i].co = mwi @ Vector(W[i])
    h.data.update()
    return int(hit.sum())


def bury_medallion(c, r):
    """The Meshy hearth's own medallion pokes out around the badge: find it by its gold texels, press it into the
    dome and give those faces a dark brick patch material so no gold shows around the plate."""
    h = bpy.data.objects[HEARTH]
    me, mw = h.data, h.matrix_world
    mwi = mw.inverted()
    img = next(n.image for n in me.materials[0].node_tree.nodes  # p18c tags it "feeds" once it rewires the material
               if n.type == "TEX_IMAGE" and (n.get("feeds") == "Base Color" or (
                   n.outputs[0].links and n.outputs[0].links[0].to_socket.name == "Base Color")))
    W, H = img.size
    px = np.empty(W * H * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    uvl = next(l for l in me.uv_layers if l.name != "BakeUV")
    uv = np.empty(len(me.loops) * 2, np.float32)
    uvl.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    col = px[np.clip((uv[:, 1] % 1) * H, 0, H - 1).astype(int), np.clip((uv[:, 0] % 1) * W, 0, W - 1).astype(int), :3]
    gold = (col[:, 0] > 0.25) & (col[:, 0] > col[:, 1] * 1.15) & (col[:, 1] > col[:, 2] * 1.3)
    V = np.array([tuple(mw @ v.co) for v in me.vertices])
    zone = (np.abs(V[:, 0]) < 0.55) & (V[:, 2] > 2.4) & (V[:, 2] < 3.55) & (V[:, 1] < 1.8)
    patch = bpy.data.materials.get("FH_HearthPatch")
    if patch is None:
        patch = bpy.data.materials.new("FH_HearthPatch")
        patch.use_nodes = True
        b = next(n for n in patch.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        b.inputs["Base Color"].default_value = (0.035, 0.03, 0.028, 1)
        b.inputs["Roughness"].default_value = 0.85
    if patch.name not in me.materials:
        me.materials.append(patch)
    slot = list(me.materials).index(patch)
    C = np.array(c)
    gold_v = np.zeros(len(V), bool)
    np.logical_or.at(gold_v, np.array([l.vertex_index for l in me.loops]), gold)
    faces = 0
    for poly in me.polygons:
        if any(zone[v] and gold_v[v] for v in poly.vertices):
            poly.material_index = slot
            faces += 1
    # each medallion vertex sinks to the local dome height: median radius of its nearest plain-brick neighbours
    P = V - C
    dist = np.linalg.norm(P, axis=1)
    dirs = P / dist[:, None]
    med = np.nonzero(gold_v & zone)[0]
    plain = np.nonzero(~gold_v & (np.abs(V[:, 0]) < 0.9) & (V[:, 2] > 2.2) & (V[:, 2] < 3.8) & (V[:, 1] < 2.0))[0]
    moved = 0
    for vi in med:
        near = plain[np.argsort(-(dirs[plain] @ dirs[vi]))[:16]]
        target = float(np.median(dist[near])) - 0.012
        if dist[vi] > target:
            me.vertices[vi].co = mwi @ Vector(C + dirs[vi] * target)
            moved += 1
    me.update()
    return faces, moved


def apply():
    for o in [o for o in bpy.data.objects if o.name.startswith("Emblem_")]:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data and data.users == 0:
            (bpy.data.meshes if isinstance(data, bpy.types.Mesh) else bpy.data.curves).remove(data)
    gold, steel = gold_material(), steel_material()
    objs, plate = build_flat()
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(steel if o.name == "Emblem_Plate" else gold)
    c, r = fit_sphere()
    n0, eu, ev = frame(c, r)
    wrap(objs, c, r, n0, eu, ev)
    pressed = press(plate, c, r, n0, eu, ev)
    buried = bury_medallion(c, r)
    bpy.context.scene["emblem_frame"] = {"c": list(map(float, c)), "r": float(r), "n0": list(n0), "ev": list(ev)}
    tris = 0
    for o in objs:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    print(f"emblem: sphere c={np.round(c, 3)} r={r:.3f}; pressed {pressed} hearth verts; buried medallion faces/verts {buried}; {tris} tris")
    return objs


if __name__ == "__main__":
    apply()
    if "--save" in sys.argv:
        bpy.ops.wm.save_mainfile()
