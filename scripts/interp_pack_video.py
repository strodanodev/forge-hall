"""Motion-interpolate the 24 fps pack videos to 60 fps (24 fps on a 60 Hz display judders 3:2).

run:  uv run --with imageio-ffmpeg python scripts/interp_pack_video.py [name ...]
Writes web/assets/pack/<name>_60.mp4 next to each source; the originals stay untouched. Writes to a temp name and
renames on success, so an interrupted run never leaves a truncated file the viewer could pick up.

HOLD windows are source-frame ranges (24 fps) that change too fast for motion estimation: the flaps burst open in
~3 frames and minterpolate morphs them into ghosted smears. Those frames are repeated instead of interpolated
(found by frame-difference spikes; our climax flash plays over the physics one).
A hold can also DROP source frames: the generator rendered the physics burst with two cross-dissolve smear frames
(#150-151); dropping them holds #149 until #152's timestamp, so the pack pops open under the flash, timing unchanged.
"""
import os, subprocess, sys, time
import imageio_ffmpeg

PACK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "assets", "pack")
FF = imageio_ffmpeg.get_ffmpeg_exe()
MI = "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=8"
HOLD = {  # (first frame, end frame exclusive, source frames to drop)
    "pack_physics": [(149, 154, (150, 151))],        # 6.21-6.42 s: flaps burst open; 150-151 are smears
    "pack_fx": [(147, 156, ()), (171, 180, ())],     # 6.13-6.50 s burst flash, 7.13-7.50 s sparkle storm
}


def graph(holds, total=240):
    """filter_complex: interpolate the runs between holds, frame-repeat inside them, concat in order."""
    cuts, segs, prev = [], [], 0
    for a, b, drop in holds:
        if a > prev: cuts.append((prev, a, True, ()))
        cuts.append((a, b, False, drop))
        prev = b
    if prev < total: cuts.append((prev, total, True, ()))
    for i, (a, b, interp, drop) in enumerate(cuts):
        # select keeps the survivors' timestamps, so fps=60 repeats the frame before a gap until the next one is due
        sel = f",select='{'*'.join(f'not(eq(n,{d - a}))' for d in drop)}'" if drop else ""
        segs.append(f"[0:v]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS{sel},{MI if interp else 'fps=60'}[s{i}]")
    return ";".join(segs) + ";" + "".join(f"[s{i}]" for i in range(len(cuts))) + f"concat=n={len(cuts)}:v=1:a=0[v]"


for name in sys.argv[1:] or list(HOLD):
    src, dst = os.path.join(PACK, name + ".mp4"), os.path.join(PACK, name + "_60.mp4")
    tmp = dst + ".part.mp4"
    t = time.time()
    r = subprocess.run([FF, "-v", "error", "-y", "-i", src, "-filter_complex", graph(HOLD.get(name, [])),
                        "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "slow", "-crf", "20",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "copy", tmp], capture_output=True, text=True)
    if r.returncode:
        print(name, "FAILED", r.stderr[-800:], flush=True)
        continue
    os.replace(tmp, dst)
    print(name, "ok", round(time.time() - t), "s", os.path.getsize(dst), "bytes", flush=True)
print("DONE", flush=True)
