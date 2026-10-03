O = bpy.data.objects
def bsdf(name):
    return next(n for n in MT(name).node_tree.nodes if n.type == "BSDF_PRINCIPLED")
for name, rough, spec in (("FH_FloorSlab", 0.82, 0.25), ("FH_HearthBrick", 0.92, 0.2), ("FH_BlockStone", 0.85, 0.3)):
    b = bsdf(name)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
b = bsdf("FH_Cloud")
b.inputs["Emission Strength"].default_value = 0.08
b.inputs["Base Color"].default_value = (0.9, 0.92, 0.97, 1)
O["Lt_ForgeUp"].data.energy = 80
O["Lt_Lintel"].data.energy = 120
print("ok")
