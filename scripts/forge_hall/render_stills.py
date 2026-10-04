"""Cinematic stills of forge_hall.blend (Cycles, GPU): the game camera plus close-ups of the badge and the title.

run:  blender -b forge_hall.blend --python scripts/forge_hall/render_stills.py -- [samples] [width]
writes renders/forge_<shot>.png. Never saves the .blend.
"""
import bpy, math, os, sys
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SAMPLES = int(argv[0]) if argv else 256
WIDTH = int(argv[1]) if len(argv) > 1 else 1920

sc = bpy.context.scene
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "CUDA"  # OptiX kernels fail to compile on this driver
prefs.refresh_devices()
for d in prefs.devices:
    d.use = d.type == "CUDA"
sc.render.engine = "CYCLES"
sc.cycles.device = "GPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.render.use_compositing = True
sc.render.image_settings.file_format = "PNG"
os.makedirs(os.path.join(ROOT, "renders"), exist_ok=True)

cd = bpy.data.cameras.new("StillCam")
still = bpy.data.objects.new("StillCam", cd)
sc.collection.objects.link(still)
SHOTS = {  # name: (camera location, look-at, lens mm, aspect) ; None = the game camera
    "hall": (None, None, None, 16 / 9),
    "badge": ((0.45, -2.3, 1.95), (0.0, 1.15, 2.95), 42, 1.0),
    "title": ((0.0, -4.4, 3.65), (0.0, 1.1, 4.86), 50, 21 / 9),
}
for name, (loc, tgt, lens, aspect) in SHOTS.items():
    if loc is None:
        sc.camera = bpy.data.objects["Cam_Hall"]
    else:
        still.location = loc
        still.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        cd.lens = lens
        sc.camera = still
    sc.render.resolution_x, sc.render.resolution_y = WIDTH, int(round(WIDTH / aspect))
    sc.render.filepath = os.path.join(ROOT, "renders", f"forge_{name}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", sc.render.filepath, flush=True)
