"""Re-export a baked web GLB after re-grading its atlases (no re-bake).

run:  blender -b forge_hall_web.blend      --python scripts/reexport_web.py   (after grade_cinematic.py)
Reloads the BK_*.png atlases into the baked unlit materials and writes web/assets/<name>_raw.glb.
BK_Live keeps a lit (emissive) fallback material so its normals survive optimisation (see export_web.live_fallback).
"""
import bpy, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = os.path.basename(bpy.data.filepath).replace("_web.blend", "")
for img in bpy.data.images:
    if img.filepath and os.path.basename(bpy.path.abspath(img.filepath)).startswith("BK_"):
        img.reload()
        print("reloaded", img.name)

exp = [o for o in bpy.data.objects if o.name.startswith(("BK_", "FX_", "FXM_")) or o.name == "Cam_Hall"]
for o in bpy.context.view_layer.objects:
    o.select_set(o in exp)
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
kw = dict(filepath=os.path.join(ROOT, "web", "assets", f"{NAME}_raw.glb"), export_format="GLB",
          use_selection=True, export_image_format="WEBP", export_cameras=True, export_lights=False,
          export_apply=True, export_extras=True, export_yup=True, export_tangents=False)
if "export_image_quality" in props:
    kw["export_image_quality"] = 88
bpy.ops.export_scene.gltf(**kw)
print("EXPORTED", kw["filepath"], f"{os.path.getsize(kw['filepath']) / 1e6:.2f} MB")
