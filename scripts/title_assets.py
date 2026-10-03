"""Title-screen logos for web/title.js: key the chrome wordmarks off their backgrounds into transparent WebPs.

run:  python scripts/title_assets.py <litgames_on_black.jpg> <theforge_on_green.jpg> [caduceus.json]
writes web/assets/title/litgames.webp, theforge.webp (cropped to the art) and copies the traced caduceus
(assets/logo/litvm_caduceus.json, made by scripts/forge_hall/logo_trace.py) to web/assets/title/caduceus.json.

LIT GAMES is chrome on black: any alpha >= max(r,g,b) reproduces the original exactly over black, so alpha is that
floor raised to 1 inside the letters (dark reflections in the chrome stay solid over a bright background).
THE FORGE is chrome on a green screen: alpha from how green a pixel is relative to the screen colour, colour
un-mixed from the screen (removes the green fringe on anti-aliased edges).
"""
import json, os, shutil, sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "assets", "title")


def crop(rgba, pad):
    a = rgba[..., 3]
    ys, xs = np.nonzero(a > 6 / 255)
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad + 1, a.shape[0])
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad + 1, a.shape[1])
    return rgba[y0:y1, x0:x1]


def save(rgba, name, width):
    im = Image.fromarray(np.clip(rgba * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    path = os.path.join(OUT, name)
    im.save(path, "WEBP", quality=90, alpha_quality=100, method=6)
    print(f"{name}: {im.width}x{im.height}, {os.path.getsize(path) / 1024:.0f} KB")


def on_black(src):
    c = np.asarray(Image.open(src).convert("RGB")).astype(np.float32) / 255
    floor = c.max(-1)
    # the letters' region: anything visibly lit, gaps closed, then feathered so the edge stays anti-aliased
    m = Image.fromarray(((floor > 0.07) * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(7)).filter(ImageFilter.GaussianBlur(1.2))
    solid = np.asarray(m).astype(np.float32) / 255
    a = np.maximum(floor, np.clip((solid - 0.5) * 2, 0, 1))
    rgb = np.where(a[..., None] > 1e-4, c / np.maximum(a[..., None], 1e-4), 0)
    return crop(np.dstack([np.clip(rgb, 0, 1), a]), 12)


def on_green(src):
    c = np.asarray(Image.open(src).convert("RGB")).astype(np.float32) / 255
    g = c[..., 1] - np.maximum(c[..., 0], c[..., 2])  # greenness
    h, w = g.shape
    border = np.concatenate([c[:20].reshape(-1, 3), c[-20:].reshape(-1, 3), c[:, :20].reshape(-1, 3), c[:, -20:].reshape(-1, 3)])
    screen = np.median(border, 0)
    gs = screen[1] - max(screen[0], screen[2])
    a = np.clip(1 - (g - 0.04) / (gs * 0.82 - 0.04), 0, 1)
    a = np.where(a > 0.985, 1, a)
    am = np.maximum(a[..., None], 1e-4)
    rgb = (c - (1 - a[..., None]) * screen) / am  # un-mix the screen out of edge pixels
    rgb[..., 1] = np.minimum(rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2]) + 0.03)  # despill what is left
    rgb = np.where(a[..., None] > 1e-3, np.clip(rgb, 0, 1), 0)
    print(f"screen colour {np.round(screen * 255)}")
    return crop(np.dstack([rgb, a]), 10)


def main(lit, forge, trace=os.path.join(ROOT, "assets", "logo", "litvm_caduceus.json")):
    os.makedirs(OUT, exist_ok=True)
    save(on_black(lit), "litgames.webp", 900)
    wordmark = on_green(forge)
    save(wordmark, "theforge.webp", 1800)
    save(wordmark, "theforge-900.webp", 900)  # phones (index.html srcset) and the light-sweep mask (title.css)
    with open(trace) as f:
        data = json.load(f)
    # 4 decimals = 0.1 source pixel: plenty for the extrusion, a fifth smaller to download
    q = lambda loops: [[[round(x, 4), round(y, 4)] for x, y in loop] for loop in loops]
    data = {**data, "art": q(data["art"]), "plate": q(data["plate"])}
    with open(os.path.join(OUT, "caduceus.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"caduceus.json: {len(data['art'])} loops, {os.path.getsize(os.path.join(OUT, 'caduceus.json')) / 1024:.0f} KB")


if __name__ == "__main__":
    main(*sys.argv[1:])
