PIV = Vector((0.0, 2.4, 0.0))
S = Vector((1.3, 1.3, 1.1))
HEARTH = ("Hearth_", "Fire_", "Forge_Dais", "Pipe_Lower_", "Lava_", "Lt_ForgeCore", "Lt_ForgeSpill", "Lt_ForgeUp")
n = 0
for o in list(_col().all_objects):
    if o.name.startswith(HEARTH) and o.parent is None:
        o.location = Vector([PIV[i] + (o.location[i] - PIV[i]) / S[i] for i in range(3)])
        if o.type != "LIGHT":
            rx = abs(o.rotation_euler.x - R(90)) < 1e-3
            o.scale = (o.scale.x / S.x, o.scale.y / (S.z if rx else S.y), o.scale.z / (S.y if rx else S.z))
        n += 1
bpy.context.scene["hearth_scaled"] = True
bpy.ops.wm.save_mainfile()
print("reverted", n)
