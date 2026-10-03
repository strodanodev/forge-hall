import os
from mathutils import Vector
MESHY = r"C:\Users\strodano\Documents\LitVM Games\blender\assets\meshy"
src = bpy.data.collections.get("MeshySrc") or bpy.data.collections.new("MeshySrc")
if src.name not in bpy.context.scene.collection.children:
    bpy.context.scene.collection.children.link(src)
vl = bpy.context.view_layer
vl.active_layer_collection = vl.layer_collection.children["MeshySrc"]

def select_only(objs):
    for o in vl.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0]

for name in ("hearth", "anvil", "barrel", "crystals", "axe", "column", "tools"):
    if f"MX_{name}" in bpy.data.objects:
        continue
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(MESHY, f"{name}.glb"))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    select_only(meshes)
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = vl.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in new:
        if o is not ob:
            bpy.data.objects.remove(o, do_unlink=True)
    bb = [Vector(c) for c in ob.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    off = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    ob.data.transform(__import__("mathutils").Matrix.Translation(-off))
    ob.location = (0, 0, 0)
    ob.name = ob.data.name = f"MX_{name}"
    ob.hide_render = True
    ob.hide_set(True)
for name in ("hearth", "anvil", "barrel", "crystals", "axe", "column", "tools"):
    ob = bpy.data.objects[f"MX_{name}"]
    ob.data.calc_loop_triangles()
    d = ob.dimensions
    print(f"{name:9s} tris={len(ob.data.loop_triangles):6d} dims=({d.x:.2f},{d.y:.2f},{d.z:.2f}) mats={[m.name for m in ob.data.materials]}")
