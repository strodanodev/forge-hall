O = bpy.data.objects

# ---- materials: plain veined marble (Poly Haven marble_01 is tiled), browner matte wood ----
for name, base, vein in (("FH_Marble", (0.82, 0.77, 0.68), (0.62, 0.57, 0.5)),
                         ("FH_MarbleWarm", (0.74, 0.63, 0.47), (0.55, 0.45, 0.33))):
    m, nt, b, _ = new_mat(name)
    v = coords(nt)
    wv = N(nt, "ShaderNodeTexWave", wave_type="BANDS", bands_direction="DIAGONAL")
    wv.inputs["Scale"].default_value = 0.7
    wv.inputs["Distortion"].default_value = 11.0
    wv.inputs["Detail"].default_value = 8.0
    wv.inputs["Detail Roughness"].default_value = 0.7
    L(nt, v, wv.inputs["Vector"])
    r = ramp(nt, [(0.0, vein), (0.05, base), (1.0, base)])
    L(nt, wv.outputs["Fac"], r.inputs["Fac"])
    nz = N(nt, "ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 6.0
    L(nt, v, nz.inputs["Vector"])
    g = ramp(nt, [(0.3, (0.88, 0.88, 0.88)), (0.7, (1, 1, 1))])
    L(nt, nz.outputs["Fac"], g.inputs["Fac"])
    L(nt, mix_rgb(nt, "MULTIPLY", 1.0, r.outputs["Color"], g.outputs["Color"]), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.35
    m.diffuse_color = (*base, 1)
m_pbr("FH_NorseWood", "dark_wood", 1.5, tint=(0.5, 0.42, 0.38), rough_add=0.25, rot=(0, 90, 0))
m_pbr("FH_TableWood", "dark_wooden_planks", 2.0, tint=(1.05, 0.9, 0.75), rough_add=0.15)
m_pbr("FH_BarrelWood", "dark_wooden_planks", 1.2, tint=(0.9, 0.78, 0.65), rough_add=0.15, rot=(0, 90, 0))

# ---- enlarge the hearth assembly about its base centre ----
PIV = Vector((0.0, 2.4, 0.0))
S = Vector((1.3, 1.3, 1.1))
HEARTH = ("Hearth_", "Fire_", "Forge_Dais", "Pipe_Lower_", "Lava_", "Lt_ForgeCore", "Lt_ForgeSpill", "Lt_ForgeUp")
for o in (list(_col().all_objects) if not bpy.context.scene.get("hearth_scaled") else []):
    if o.name.startswith(HEARTH) and o.parent is None:
        o.location = PIV + (o.location - PIV) * S if False else Vector(
            [PIV[i] + (o.location[i] - PIV[i]) * S[i] for i in range(3)])
        if o.type != "LIGHT":
            rx = abs(o.rotation_euler.x - R(90)) < 1e-3   # discs/text standing up: local Y is world Z
            o.scale = (o.scale.x * S.x, o.scale.y * (S.z if rx else S.y), o.scale.z * (S.y if rx else S.z))
for s in (-1, 1):  # flanking pipes' flanges follow the lower pipes
    f = O.get(f"Pipe_Flange_{s}_1")
    if f:
        f.location = (s * 1.95 * 1.3, 2.4 + (-0.2) * 1.3, 4.4 * 1.1)
bpy.context.scene["hearth_scaled"] = True
# centre columns out to make room
for x in (-2.8, 2.8):
    O[f"Col_Center_{x}"].location.x = 3.2 if x > 0 else -3.2
# small props off the enlarged dais edge
O["Barrel_D"].location = (2.15, 0.35, 0)
O["Barrel_E"].location = (-2.35, 0.9, 0)
O["Anvil_Small"].location = (-1.95, 0.05, 0)
for o in _col().all_objects:
    if o.name.startswith("Spark") and o.type == "CURVE":
        o.location = (-0.2, -0.5, 0)
O["Spark_Light"].location = (-1.95, -0.05, 0.9)
print("framing ok")
