# ---------- reset scene ----------
for cname in ("Workshop", COLNAME):
    c = bpy.data.collections.get(cname)
    if c:
        for o in list(c.all_objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(c)
for o in list(bpy.context.scene.collection.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.curves, bpy.data.lights, bpy.data.cameras, bpy.data.materials):
    for d in list(coll):
        if d.users == 0:
            coll.remove(d)
c = bpy.data.collections.new(COLNAME)
bpy.context.scene.collection.children.link(c)
_vl = bpy.context.view_layer
_vl.active_layer_collection = _vl.layer_collection.children[COLNAME]

# ---------- materials ----------
m_brick("FH_FloorSlab", (0.42, 0.39, 0.35), (0.33, 0.31, 0.29), (0.12, 0.11, 0.1),
        bw=1.5, rh=0.95, plane="xy", mortar_size=0.02, rough=0.75, grime=0.45)
m_brick("FH_HearthBrick", (0.2, 0.19, 0.18), (0.13, 0.12, 0.12), (0.05, 0.045, 0.04),
        bw=0.42, rh=0.2, plane="xz", mortar_size=0.03, rough=0.9)
m_brick("FH_Planks", (0.14, 0.075, 0.035), (0.1, 0.05, 0.025), (0.03, 0.015, 0.01),
        bw=3.0, rh=0.28, plane="zy", mortar_size=0.02, rough=0.8, grime=0.5)
m_noise("FH_Rock", (0.16, 0.15, 0.14), (0.42, 0.39, 0.35), scale=0.9, bump_s=0.7)
m_noise("FH_RockDark", (0.07, 0.07, 0.08), (0.2, 0.2, 0.22), scale=0.8, bump_s=0.7)
m_noise("FH_Mountain", (0.03, 0.045, 0.07), (0.12, 0.15, 0.2), scale=0.08, bump_s=0.5)
m_noise("FH_BlockStone", (0.25, 0.24, 0.23), (0.4, 0.38, 0.36), scale=3.0, bump_s=0.5)
m_marble("FH_Marble")
m_marble("FH_MarbleWarm", base=(0.82, 0.74, 0.6), vein=(0.5, 0.42, 0.32))
m_wood("FH_NorseWood", (0.07, 0.035, 0.018), (0.17, 0.09, 0.045), bands="X", scale=4)
m_wood("FH_TableWood", (0.22, 0.11, 0.05), (0.4, 0.23, 0.11), bands="Y", scale=3)
m_wood("FH_BarrelWood", (0.18, 0.09, 0.04), (0.33, 0.18, 0.08), bands="X", scale=6)
m_basic("FH_Gold", (1.0, 0.68, 0.26), 0.25, 1.0)
m_basic("FH_GoldGlow", (1.0, 0.68, 0.26), 0.3, 1.0, (1.0, 0.6, 0.2), 0.8)
m_basic("FH_Copper", (0.85, 0.42, 0.22), 0.32, 1.0)
m_basic("FH_Bronze", (0.55, 0.36, 0.18), 0.4, 1.0)
m_basic("FH_Iron", (0.07, 0.07, 0.075), 0.4, 1.0)
m_basic("FH_Steel", (0.5, 0.52, 0.55), 0.25, 1.0)
m_basic("FH_Void", (0.005, 0.005, 0.005), 1.0)
m_basic("FH_Paper", (0.78, 0.68, 0.48), 0.9)
m_basic("FH_Cloud", (0.9, 0.92, 0.97), 0.95, 0, (0.9, 0.93, 1.0), 0.35)
m_basic("FH_CityMarble", (0.95, 0.93, 0.9), 0.5, 0, (1.0, 0.97, 0.9), 0.25)
m_basic("FH_Water", (0.01, 0.03, 0.06), 0.04)
m_basic("FH_LavaCrack", (1, 0.2, 0.02), 0.5, 0, (1.0, 0.18, 0.02), 14)
m_basic("FH_Lightning", (0.5, 0.8, 1), 0.3, 0, (0.45, 0.75, 1.0), 40)
m_basic("FH_Spark", (1, 0.6, 0.2), 0.3, 0, (1.0, 0.55, 0.15), 30)
m_basic("FH_Ember", (1, 0.1, 0.05), 0.3, 0, (1.0, 0.08, 0.04), 20)
m_basic("FH_Leather", (0.12, 0.06, 0.03), 0.7)
m_fire("FH_Fire", 14, 3.0)
m_fire("FH_Coals", 5, 8.0)
m_volume("FH_RedSmoke", (0.9, 0.08, 0.05), density=1.4, emit=0.8, scale=2.5)
for el, col in {"Red": (1.0, 0.1, 0.08), "Blue": (0.15, 0.4, 1.0), "Green": (0.15, 0.9, 0.3),
                "Purple": (0.6, 0.15, 1.0), "Pink": (1.0, 0.25, 0.55), "Ice": (0.6, 0.85, 1.0)}.items():
    m_basic(f"FH_Crystal_{el}", col, 0.15, 0, col, 3.0)
    m_basic(f"FH_Ingot_{el}", col, 0.3, 0.6, col, 0.4)
print("materials:", len([m for m in bpy.data.materials if m.name.startswith("FH_")]))
