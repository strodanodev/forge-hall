"""p18a: the lintel plaque reads THE FORGE, with "by LitVM Games" beneath (replaces p17's FORGE OF THE GODS).

Dark slate plaque with a gold piping frame, the title in Cinzel Black as raised gold letters with rounded edges,
the byline in Cinzel Regular between two short gold rules. Idempotent: rebuilds every Lintel_Title* / Lintel_Plaque*.
"""
import bpy, bmesh
from mathutils import Matrix

COL = bpy.data.collections["ForgeHall"]
FACE_Y = 1.15          # lintel front face (faces -Y)
CZ = 4.89              # plaque centre height (gold bands at 4.61 and 5.17)
PW, PH, PD = 3.0, 0.5, 0.05
TITLE, BYLINE = "THE FORGE", "by LitVM Games"
FONTS = {"black": r"C:\Windows\Fonts\Cinzel-Black.ttf", "regular": r"C:\Windows\Fonts\Cinzel-Regular.ttf"}


def _font(key):
    p = FONTS[key].lower()
    return next((f for f in bpy.data.fonts if bpy.path.abspath(f.filepath).lower() == p), None) or bpy.data.fonts.load(FONTS[key])


def _text(name, body, font, size, spacing, z, extrude, bevel, mat):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body, cu.font, cu.size, cu.space_character = body, font, size, spacing
    cu.align_x, cu.align_y = "CENTER", "CENTER"
    cu.extrude, cu.bevel_depth, cu.bevel_resolution, cu.resolution_u = extrude, bevel, 2, 4
    t = bpy.data.objects.new(name, cu)
    t.location, t.rotation_euler = (0.0, FACE_Y - PD - extrude + 0.004, z), (1.5708, 0, 0)
    cu.materials.append(mat)
    COL.objects.link(t)
    return t


def _box(name, sx, sy, sz, loc, mat, bevel):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    me.transform(Matrix.Diagonal((sx, sy, sz, 1.0)))
    o = bpy.data.objects.new(name, me)
    o.location = loc
    me.materials.append(mat)
    COL.objects.link(o)
    if bevel:
        m = o.modifiers.new("Bevel", "BEVEL")
        m.width, m.segments, m.limit_method = bevel, 3, "ANGLE"
    return o


def _frame(name, w, h, inset, r, y, mat):
    """Round gold piping around the plaque face, with rounded corners."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions, cu.bevel_depth, cu.bevel_resolution, cu.fill_mode = "3D", r, 3, "FULL"
    x0, x1, z0, z1, k = -w / 2 + inset, w / 2 - inset, CZ - h / 2 + inset, CZ + h / 2 - inset, 0.05
    pts = [(x0 + k, z0), (x1 - k, z0), (x1, z0 + k), (x1, z1 - k), (x1 - k, z1), (x0 + k, z1), (x0, z1 - k), (x0, z0 + k)]
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for p, (x, z) in zip(sp.points, pts):
        p.co = (x, y, z, 1.0)
    sp.use_cyclic_u = True
    o = bpy.data.objects.new(name, cu)
    cu.materials.append(mat)
    COL.objects.link(o)
    return o


def apply():
    for o in [o for o in bpy.data.objects if o.name.startswith(("Lintel_Title", "Lintel_Plaque", "Lintel_Byline"))]:
        bpy.data.objects.remove(o, do_unlink=True)
    gold, glow, slate = (bpy.data.materials[n] for n in ("FH_Gold", "FH_GoldGlow", "FH_Plaque"))
    front = FACE_Y - PD
    _box("Lintel_Plaque", PW, PD, PH, (0.0, FACE_Y - PD / 2 + 0.002, CZ), slate, 0.012)
    _frame("Lintel_PlaqueFrame", PW, PH, 0.035, 0.009, front - 0.002, gold)
    _text("Lintel_Title", TITLE, _font("black"), 0.29, 1.12, CZ + 0.065, 0.022, 0.004, glow)
    _text("Lintel_Byline", BYLINE, _font("regular"), 0.1, 1.32, CZ - 0.15, 0.008, 0.0015, gold)
    # short rules either side of the byline
    for s in (-1, 1):
        _box(f"Lintel_PlaqueRule{'L' if s < 0 else 'R'}", 0.36, 0.012, 0.008, (s * 0.85, front - 0.006, CZ - 0.15), gold, 0)
    print("p18a title: THE FORGE / by LitVM Games")


if __name__ == "__main__":
    apply()
