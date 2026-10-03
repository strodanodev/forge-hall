O = bpy.data.objects

def kill(prefixes):
    for o in list(_col().all_objects):
        if o.name.startswith(prefixes):
            bpy.data.objects.remove(o, do_unlink=True)

# darker floor + hearth, calmer fire, saturated crystals
m_brick("FH_FloorSlab", (0.13, 0.12, 0.11), (0.085, 0.08, 0.075), (0.03, 0.028, 0.025),
        bw=1.5, rh=0.95, plane="xy", mortar_size=0.02, rough=0.5, grime=0.55)
m_brick("FH_HearthBrick", (0.12, 0.11, 0.1), (0.075, 0.07, 0.065), (0.03, 0.025, 0.02),
        bw=0.42, rh=0.2, plane="xz", mortar_size=0.03, rough=0.9)
m_fire("FH_Fire", 3.2, 3.0)
m_fire("FH_Coals", 1.8, 8.0)
for el, col in {"Red": (1.0, 0.05, 0.03), "Blue": (0.05, 0.25, 1.0), "Green": (0.05, 0.85, 0.2),
                "Purple": (0.5, 0.05, 1.0), "Pink": (1.0, 0.12, 0.45), "Ice": (0.35, 0.7, 1.0)}.items():
    m_basic(f"FH_Crystal_{el}", col, 0.15, 0, col, 1.4)

# bigger lintel emblems
for o in _col().all_objects:
    if o.name.startswith(("Lintel_Emblem_", "Lintel_Knot_")):
        o.scale = (1.5, 1.5, 1.5)

# cloud sea: displaced puffs, softer + bluer with distance
kill(("Env_Cloud",))
for k in range(70):
    x = rng.uniform(-110, -9)
    y = rng.uniform(-30, 110)
    s = rng.uniform(4, 11)
    rock(f"Env_Cloud{k}", (x, y, rng.uniform(-9, -5)), (s * 1.4, s, s * 0.6), MT("FH_Cloud"),
         detail=3, strength=s * 0.35, noise=2.5)
rock("Env_CityCloud", (-31, 38, -2.5), (11, 11, 2.2), MT("FH_Cloud"), detail=3, strength=2.0, noise=2.5)
m_basic("FH_Cloud", (0.8, 0.85, 0.95), 0.95, 0, (0.75, 0.83, 1.0), 0.45)

# lighting: let the forge dominate
O["Lt_Sun"].data.energy = 0.9
wn = bpy.context.scene.world.node_tree
next(n for n in wn.nodes if n.type == "MAP_RANGE" and n.inputs["To Max"].default_value == 1.0
     and n.inputs["To Min"].default_value == 0.3).inputs["To Min"].default_value = 0.2
print("fix2 done")
