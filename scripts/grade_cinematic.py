"""Re-grade the cinematic bake without re-baking.

export_web.py keeps each atlas's linear HDR bake in bake/BK_*_hdr.npz. This applies a
small grade in scene-linear, then Blender's own AgX view + look through OpenColorIO (Blender's config),
so neutral settings reproduce the bake exactly and changes take seconds.

usage:
  uv run --with numpy --with pillow --with opencolorio python scripts/grade_cinematic.py [--check]
  then: blender -b forge_hall_web.blend --python scripts/reexport_web.py ; bash scripts/optimize_web.sh
--check compares a neutral grade against the PNGs Blender wrote and prints the error, writes nothing.
Tune GRADE below or drop overrides into scripts/grade_cinematic.json.
"""
import glob, json, os, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAKE = os.path.join(ROOT, "bake")
# Blender's own OCIO config (<blender>/<version>/datafiles/colormanagement/config.ocio): set OCIO to yours
OCIO_CONFIG = os.environ.get("OCIO", r"C:\Program Files\Blender Foundation\Blender 5.2\5.2\datafiles\colormanagement\config.ocio")
if not os.path.exists(OCIO_CONFIG):
    sys.exit(f"OCIO config not found at {OCIO_CONFIG}: set OCIO to Blender's datafiles/colormanagement/config.ocio")

GRADE = dict(
    exposure=0.0,              # stops
    white_balance=(1.0, 1.0, 1.0),
    saturation=1.0,
    contrast=1.0,              # power around 18% grey, in linear
    shadow_lift=0.0,           # adds to linear before the view transform (0.002-0.01 opens up blacks)
    view="AgX", look="AgX - Punchy",
)
TUNE = os.path.join(ROOT, "scripts", "grade_cinematic.json")
if os.path.exists(TUNE):
    GRADE.update(json.load(open(TUNE)))
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def processor(view, look):
    import PyOpenColorIO as OCIO
    cfg = OCIO.Config.CreateFromFile(OCIO_CONFIG)
    src = cfg.getColorSpace("scene_linear").getName()
    steps = []
    if look and look != "None":
        ps = cfg.getLook(look).getProcessSpace()
        steps += [OCIO.LookTransform(src=src, dst=ps, looks=look), ]
        src = ps
    steps.append(OCIO.DisplayViewTransform(src=src, display="sRGB", view=view))
    return cfg.getProcessor(OCIO.GroupTransform(steps)).getDefaultCPUProcessor()


def grade(lin, g):
    x = lin * (2.0 ** g["exposure"]) * np.array(g["white_balance"], dtype=np.float32)
    y = (x @ LUMA)[..., None]
    x = y + (x - y) * g["saturation"]
    x = 0.18 * np.power(np.maximum(x, 0) / 0.18, g["contrast"])
    return x + g["shadow_lift"]


def to_display(lin, proc):
    out = np.ascontiguousarray(lin, dtype=np.float32)
    proc.applyRGB(out)
    return np.clip(out, 0, 1)


def main():
    from PIL import Image
    check = "--check" in sys.argv
    g = dict(GRADE, exposure=0.0, white_balance=(1, 1, 1), saturation=1.0, contrast=1.0, shadow_lift=0.0) if check else GRADE
    proc = processor(g["view"], g["look"])
    for f in sorted(glob.glob(os.path.join(BAKE, "BK_*_hdr.npz"))):
        name = os.path.basename(f)[:-len("_hdr.npz")]
        hdr = np.load(f)["hdr"].astype(np.float32)[::-1]  # Blender rows are bottom-up
        rgb = to_display(grade(hdr[..., :3], g), proc)
        png = os.path.join(BAKE, name + ".png")
        if check:
            ref = np.asarray(Image.open(png).convert("RGB"), dtype=np.float32) / 255
            print(f"{name}: mean |diff| {np.abs(ref - rgb).mean() * 255:.2f}/255, max {np.abs(ref - rgb).max() * 255:.0f}/255")
            continue
        Image.fromarray((rgb * 255 + 0.5).astype(np.uint8)).save(png)
        print("graded", png)


if __name__ == "__main__":
    main()
