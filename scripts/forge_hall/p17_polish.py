"""Reference polish, style-neutral (applies to the cinematic master and the toon copy alike).

- "FORGE OF THE GODS" title on a dark stone plaque on the lintel (replaces the 5 lintel emblems)
- rounded bevels on every box, sized to its thickness
- heavier gold trim and thicker cornices
- distant mountains lower and farther, so the Norse arches open onto sky and aurora

run:  blender -b forge_hall.blend --python scripts/forge_hall/p17_polish.py -- --save
or import and call apply(). Idempotent: guarded by scene["p17_polish"].
"""
import bpy, sys
from mathutils import Matrix

FLAG = "p17_polish"
TITLE_FONT = r"C:\Windows\Fonts\Cinzel-Bold.ttf"


def _plaque_material():
    m = bpy.data.materials.get("FH_Plaque")
    if m:
        return m
    m = bpy.data.materials.new("FH_Plaque")
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (0.045, 0.042, 0.05, 1)  # dark slate
    b.inputs["Roughness"].default_value = 0.7
    m.diffuse_color = (0.045, 0.042, 0.05, 1)
    return m


def _bevel(o, width, seg=2):
    m = next((m for m in o.modifiers if m.type == "BEVEL"), None) or o.modifiers.new("Bevel", "BEVEL")
    m.width, m.segments, m.limit_method = width, seg, "ANGLE"
    o.modifiers.move(o.modifiers.find(m.name), 0)  # round the authored box before anything else


def apply():
    sc = bpy.context.scene
    if sc.get(FLAG):
        print("p17 polish already applied")
        return False
    col = bpy.data.collections["ForgeHall"]

    # ---- title plaque
    ref = bpy.data.objects["Lintel_Emblem_☤"]
    rot, y, extrude = ref.rotation_euler.copy(), ref.location.y, ref.data.extrude
    for o in [o for o in bpy.data.objects if o.name.startswith("Lintel_Emblem_")
              or o.name in ("Lintel_Knot_-2.5", "Lintel_Knot_2.5")]:
        bpy.data.objects.remove(o, do_unlink=True)
    fnt = next((f for f in bpy.data.fonts if bpy.path.abspath(f.filepath).lower() == TITLE_FONT.lower()), None) \
        or bpy.data.fonts.load(TITLE_FONT)
    cu = bpy.data.curves.new("Lintel_Title", "FONT")
    cu.body, cu.font, cu.size, cu.space_character = "FORGE OF THE GODS", fnt, 0.34, 1.08
    cu.align_x, cu.align_y = "CENTER", "CENTER"
    cu.extrude, cu.resolution_u = max(extrude, 0.012), 3
    t = bpy.data.objects.new("Lintel_Title", cu)
    t.location, t.rotation_euler = (0.0, y, 4.9), rot
    t.data.materials.append(bpy.data.materials["FH_GoldGlow"])
    col.objects.link(t)
    me = bpy.data.meshes.new("Lintel_Plaque")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    me.transform(Matrix.Diagonal((4.75, 0.05, 0.46, 1.0)))
    pl = bpy.data.objects.new("Lintel_Plaque", me)
    pl.location = (0.0, y + 0.028, 4.9)
    me.materials.append(_plaque_material())
    col.objects.link(pl)

    # ---- rounded bevels on every box
    for o in [o for o in bpy.data.objects if col in o.users_collection and o.type == "MESH"]:
        if o.name.startswith(("Env_", "MXI_", "TableCard", "Table_Map")) or len(o.data.polygons) != 6:
            continue
        thin = min(o.dimensions)
        if thin >= 0.04:
            _bevel(o, min(max(thin * 0.22, 0.012), 0.055))
    _bevel(pl, 0.02)

    # ---- heavier gold trim (lintel faces -Y, architrave faces +X), thicker cornices
    for name, fat in (("Lintel_GoldBand", (1, 2.2, 1.7)), ("Architrave_GoldBand", (2.2, 1, 1.7))):
        for i in (0, 1):
            o = bpy.data.objects[f"{name}{i}"]
            o.data.transform(Matrix.Diagonal((*fat, 1.0)))
            o.location.z += 0.02 if i == 0 else -0.04  # keep the upper band clear of the thicker cornice
            _bevel(o, 0.012)
    for name in ("Lintel_Cornice", "Architrave_LeftCornice"):
        o = bpy.data.objects[name]
        o.data.transform(Matrix.Diagonal((1.0, 1.0, 1.5, 1.0)))
        o.location.z += 0.02

    # ---- open the Norse-side view
    for o in [o for o in bpy.data.objects if o.name.startswith("Env_Mountain")]:
        o.location.x *= 1.35
        o.location.y *= 1.35
        o.scale.z *= 0.5

    sc[FLAG] = True
    print("p17 polish applied")
    return True


if __name__ == "__main__":
    apply()
    if "--save" in sys.argv:
        bpy.ops.wm.save_mainfile()
        print("SAVED", bpy.data.filepath)
