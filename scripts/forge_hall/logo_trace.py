"""Trace the LitVM caduceus logo (white art on transparent PNG) into polygons for Blender.

run:  uv run --with numpy --with pillow --with opencv-python-headless python scripts/forge_hall/logo_trace.py <logo.png>
writes assets/logo/litvm_caduceus.png (copy of the source) and assets/logo/litvm_caduceus.json:
  art     the logo strokes: outer outlines + holes (even-odd fill, as Blender fills 2D curves)
  plate   one smooth outline around the whole logo (dilated, holes filled): the backing plate
Coordinates are normalised so the logo's height is 1.0, centred on the image centre, +y up.
"""
import json, os, shutil, sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "assets", "logo")
SCALE = 2          # trace at 2x so thin strokes keep their shape after simplification
EPS = 0.9          # simplification tolerance in source pixels
MIN_AREA = 6.0     # drop specks smaller than this (source px^2)
PLATE_PAD = 26     # backing plate margin around the art (source px)


def contours(mask, eps, min_area):
    cs, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in cs:
        if abs(cv2.contourArea(c)) < min_area * SCALE * SCALE:
            continue
        p = cv2.approxPolyDP(c, eps * SCALE, True).reshape(-1, 2).astype(np.float64)
        if len(p) >= 3:
            out.append(p)
    return out


def main(src):
    os.makedirs(OUT, exist_ok=True)
    shutil.copyfile(src, os.path.join(OUT, "litvm_caduceus.png"))
    im = np.array(Image.open(src).convert("RGBA"))
    h, w = im.shape[:2]
    pad = PLATE_PAD + 24  # the art touches the image edges: give the plate room to grow past them
    im = np.pad(im, ((pad, pad), (pad, pad), (0, 0)))
    ph, pw = im.shape[:2]
    a = im[..., 3].astype(np.float32) / 255.0
    lum = im[..., :3].mean(-1) / 255.0
    cov = a * lum  # white art on transparent: coverage = alpha (x lightness, in case of grey fringes)
    big = cv2.resize(cov, (pw * SCALE, ph * SCALE), interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (0, 0), 0.6 * SCALE)
    art = (big > 0.5).astype(np.uint8) * 255

    # backing plate: dilate, close the gaps between feathers, fill every hole, smooth
    r = PLATE_PAD * SCALE
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    plate = cv2.dilate(art, k)
    plate = cv2.morphologyEx(plate, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61 * SCALE, 61 * SCALE)))
    cs, _ = cv2.findContours(plate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(plate)
    cv2.drawContours(filled, [max(cs, key=cv2.contourArea)], -1, 255, -1)
    filled = (cv2.GaussianBlur(filled.astype(np.float32), (0, 0), 9 * SCALE) > 127).astype(np.uint8) * 255

    art_c = contours(art, EPS, MIN_AREA)
    plate_c = contours(filled, 1.5, 1000)
    plate_c = [max(plate_c, key=lambda p: cv2.contourArea(p.astype(np.float32)))]

    def norm(p):  # pixels (y down) -> logo units (art height 1, y up, centred on the source image)
        q = p / SCALE
        return [[round((x - pw / 2) / h, 5), round((ph / 2 - y) / h, 5)] for x, y in q]

    data = {"source": os.path.basename(src), "size": [w, h],
            "art": [norm(p) for p in art_c], "plate": [norm(p) for p in plate_c]}
    with open(os.path.join(OUT, "litvm_caduceus.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))
    pts = sum(len(p) for p in art_c)
    print(f"art: {len(art_c)} loops, {pts} points; plate: {len(plate_c[0])} points")
    # preview
    prev = np.full((ph, pw, 3), 24, np.uint8)
    for p in plate_c:
        cv2.fillPoly(prev, [(p / SCALE).astype(np.int32)], (60, 52, 46))
    cv2.drawContours(prev, [(p / SCALE).astype(np.int32) for p in art_c], -1, (80, 200, 255), 1)
    Image.fromarray(prev).save(os.path.join(OUT, "trace_preview.png"))


if __name__ == "__main__":
    main(sys.argv[1])
