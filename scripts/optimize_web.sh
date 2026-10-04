#!/usr/bin/env bash
# Post-process the Blender export for the web: meshopt geometry + WebP textures, sky + live-metal PBR maps -> WebP.
# Keeps node names/hierarchy (BK_*, FX_*, FXM_*, camera) that main.js relies on.
#   bash scripts/optimize_web.sh [px]   -> forge_hall.glb (+ forge_hall_1k.glb phone variant: 1024 atlases,
#                                          ~1/4 the GPU texture memory), sky.webp, live_{base,orm,normal}.webp
# env_probe.hdr (the live metals' reflection probe) is written straight to web/assets by export_web.py.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=forge_hall
SIZE="${1:-2048}"
# the bake folder and the raw export are not in the repo (hundreds of MB): export_web.py writes them
[ -f bake/sky.png ] && [ -f "web/assets/${NAME}_raw.glb" ] || { echo "bake/ or web/assets/${NAME}_raw.glb is missing: run scripts/export_web.py first" >&2; exit 1; }
OPTS=(--compress meshopt --texture-compress webp --simplify false --flatten false --join false --instance false --palette false)
npx -y @gltf-transform/cli@4 optimize "web/assets/${NAME}_raw.glb" "web/assets/${NAME}.glb" --texture-size "$SIZE" "${OPTS[@]}"
npx -y @gltf-transform/cli@4 optimize "web/assets/${NAME}_raw.glb" "web/assets/${NAME}_1k.glb" --texture-size 1024 "${OPTS[@]}"
"${UV:-$(command -v uv || echo "$HOME/.local/bin/uv")}" run --quiet --with pillow python - <<'EOF'
from PIL import Image
Image.open("bake/sky.png").convert("RGB").save("web/assets/sky.webp", "WEBP", quality=82, method=6)
# colour lossy; data maps (occlusion/roughness/metalness, normals) near-lossless so shading stays smooth
for name, q in (("base", 90), ("orm", 95), ("normal", 95)):
    Image.open(f"bake/live_{name}.png").convert("RGB").save(f"web/assets/live_{name}.webp", "WEBP", quality=q, method=6)
EOF
ls -la web/assets
