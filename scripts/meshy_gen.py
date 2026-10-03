"""Generate low-poly hero props with Meshy text-to-3D (preview -> refine) and download GLBs.

Key is read from the MESHY_API_KEY user environment variable (never stored in this repo).
usage: python meshy_gen.py            # generate everything in ASSETS not yet downloaded
"""
import json, os, sys, time, urllib.request, winreg
from concurrent.futures import ThreadPoolExecutor

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "meshy")
API = "https://api.meshy.ai/openapi/v2/text-to-3d"
STYLE = ("Stylized-realistic fantasy game prop, clean readable silhouette, painterly PBR textures, "
         "single standalone object, no ground plane, no background.")

ASSETS = {
    "hearth": (8000, "Dome-shaped blacksmith forge furnace built from dark stone bricks, arched front fire "
                     "opening, three copper metal bands around the dome, round bronze emblem above the opening.",
               "dark soot-stained stone bricks, polished copper bands, bronze emblem, glowing orange embers inside the opening"),
    "anvil": (3000, "Heavy iron blacksmith anvil with a pointed horn, mounted on a rough rectangular granite block base.",
              "dark forged iron with worn shiny top face, grey granite block"),
    "barrel": (2000, "Viking wooden barrel with three iron hoops and a band of carved Norse runes.",
               "dark oak staves, black iron hoops, carved runes"),
    "crystals": (1500, "Cluster of six tall hexagonal magic crystals growing from a small rock base.",
                 "pale white translucent crystal, grey stone base"),
    "axe": (1500, "Norse bearded battle axe, wooden haft wrapped in leather, steel blade engraved with runes.",
            "steel blade with engraved runes, dark wood haft, brown leather wrap"),
    "column": (4000, "Tall Greek Corinthian column, fluted marble shaft, ornate acanthus capital with gilded details, "
                     "square plinth base.", "cream white marble with subtle veins, gold leaf on the capital"),
    "tools": (1200, "Blacksmith hammer and long iron tongs lying crossed together.",
              "dark iron heads, worn wooden hammer handle"),
}


def key():
    k = os.environ.get("MESHY_API_KEY")
    if not k:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as h:
            k = winreg.QueryValueEx(h, "MESHY_API_KEY")[0]
    return k


def call(method, url, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {key()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def wait(task_id, name, stage):
    while True:
        t = call("GET", f"{API}/{task_id}")
        if t["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
            print(f"[{name}] {stage} {t['status']} credits={t.get('consumed_credits')}", flush=True)
            if t["status"] != "SUCCEEDED":
                raise RuntimeError(f"{name} {stage}: {t.get('task_error')}")
            return t
        time.sleep(10)


def make(name):
    dst = os.path.join(OUT, f"{name}.glb")
    if os.path.exists(dst):
        return f"{name}: exists"
    polys, prompt, tex = ASSETS[name]
    pre = call("POST", API, {"mode": "preview", "prompt": f"{prompt} {STYLE}", "ai_model": "latest",
                             "topology": "triangle", "should_remesh": True, "target_polycount": polys,
                             "target_formats": ["glb"]})["result"]
    print(f"[{name}] preview task {pre}", flush=True)
    wait(pre, name, "preview")
    ref = call("POST", API, {"mode": "refine", "preview_task_id": pre, "enable_pbr": True,
                             "texture_prompt": tex, "texture_resolution": "2k", "target_formats": ["glb"]})["result"]
    print(f"[{name}] refine task {ref}", flush=True)
    t = wait(ref, name, "refine")
    urllib.request.urlretrieve(t["model_urls"]["glb"], dst)
    urllib.request.urlretrieve(t["thumbnail_url"], os.path.join(OUT, f"{name}_thumb.png"))
    return f"{name}: {os.path.getsize(dst) / 1e6:.1f} MB"


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    names = sys.argv[1:] or list(ASSETS)
    with ThreadPoolExecutor(len(names)) as ex:
        for fut in [ex.submit(make, n) for n in names]:
            try:
                print(fut.result(), flush=True)
            except Exception as e:
                print("ERROR", e, flush=True)
    print("balance:", call("GET", "https://api.meshy.ai/openapi/v1/balance")["balance"])
