import os, time
OUT = r"C:\Users\strodano\Documents\LitVM Games\blender"
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 1600, 900
sc.render.resolution_percentage = RES_PCT if "RES_PCT" in dir() else 100
ee = sc.eevee
for attr, v in (("taa_render_samples", 64), ("use_raytracing", True), ("use_shadows", True),
                ("volumetric_tile_size", "4"), ("volumetric_end", 40.0), ("use_volumetric_shadows", True)):
    try:
        setattr(ee, attr, v)
    except (AttributeError, TypeError):
        pass
try:
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Punchy"
except TypeError:
    pass
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = os.path.join(OUT, "renders", RENDER_NAME if "RENDER_NAME" in dir() else "forge_hall.png")
t = time.time()
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "forge_hall.blend"))
print(f"render {time.time() - t:.1f}s -> {sc.render.filepath}")
