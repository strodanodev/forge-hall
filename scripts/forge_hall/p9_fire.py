O = bpy.data.objects
for name, strength in (("FH_Fire", 6.0), ("FH_Coals", 3.0)):
    nt = MT(name).node_tree
    r = next(n for n in nt.nodes if n.type == "VALTORGB").color_ramp.elements
    for e, c in zip(r, ((0.45, 0.015, 0.0), (1.0, 0.22, 0.0), (1.0, 0.62, 0.12))):
        e.color = (*c, 1)
    next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED").inputs["Emission Strength"].default_value = strength
O["Lt_ForgeCore"].data.energy = 700
O["Lt_ForgeCore"].location = (0, 1.25, 1.1)
O["Lt_ForgeSpill"].data.energy = 1500
print("ok")
