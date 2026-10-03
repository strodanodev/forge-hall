ee = bpy.context.scene.eevee
items = [e.identifier for e in ee.bl_rna.properties["shadow_pool_size"].enum_items]
ee.shadow_pool_size = "1024" if "1024" in items else items[-1]
off = []
for o in bpy.data.objects:
    if o.type == "LIGHT" and o.name.startswith(("CrystalLight_", "Candle", "Spark_Light", "Lightning_Light", "Smoke_Light", "Lt_ForgeUp")):
        o.data.use_shadow = False
        off.append(o.name)
bpy.ops.wm.save_mainfile()
print("pool", ee.shadow_pool_size, "of", items, "| shadows off on", len(off), "accent lights")
