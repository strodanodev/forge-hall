# Rebuild FH_* materials from Poly Haven maps (box-projected, object space, real-world scale).
def ph_image(asset, key):
    for img in bpy.data.images:
        if img.name.startswith(asset) and img.get("polyhaven_map", "").lower() == key.lower():
            return img
    return bpy.data.images[f"{asset}_{key}"]

def m_pbr(name, asset, size, tint=(1, 1, 1), rough_add=0.0, nstr=1.0, rot=(0, 0, 0), blend=0.3):
    m, nt, b, _ = new_mat(name)
    tc = N(nt, "ShaderNodeTexCoord")
    mp = N(nt, "ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / size,) * 3
    mp.inputs["Rotation"].default_value = tuple(R(a) for a in rot)
    L(nt, tc.outputs["Object"], mp.inputs["Vector"])

    def tex(key):
        n = N(nt, "ShaderNodeTexImage", projection="BOX", projection_blend=blend)
        n.image = ph_image(asset, key)
        L(nt, mp.outputs["Vector"], n.inputs["Vector"])
        return n

    col = tex("Diffuse").outputs["Color"]
    if tuple(tint) != (1, 1, 1):
        col = mix_rgb(nt, "MULTIPLY", 1.0, col, tuple(tint))
    L(nt, col, b.inputs["Base Color"])
    rn = tex("Rough").outputs["Color"]
    if rough_add:
        add = N(nt, "ShaderNodeMath", operation="ADD", use_clamp=True)
        L(nt, rn, add.inputs[0])
        add.inputs[1].default_value = rough_add
        rn = add.outputs[0]
    L(nt, rn, b.inputs["Roughness"])
    nm = N(nt, "ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = nstr
    L(nt, tex("nor_gl").outputs["Color"], nm.inputs["Color"])
    L(nt, nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Specular IOR Level"].default_value = 0.35
    m.diffuse_color = (*[0.5 * t for t in tint], 1)
    return m

m_pbr("FH_FloorSlab", "rock_tile_floor", 2.6, tint=(0.75, 0.7, 0.64), nstr=1.2)
m_pbr("FH_BlockStone", "rock_face_03", 1.4, tint=(0.95, 0.9, 0.85))
m_pbr("FH_Marble", "marble_01", 1.5, tint=(1.0, 0.96, 0.9), nstr=0.5)
m_pbr("FH_MarbleWarm", "marble_01", 1.5, tint=(0.92, 0.8, 0.62), nstr=0.5)
m_pbr("FH_HearthBrick", "dark_brick_wall", 1.05, tint=(0.85, 0.8, 0.75), nstr=1.3)
m_pbr("FH_Rock", "rock_face_03", 3.5, tint=(0.72, 0.66, 0.6), nstr=1.5)
m_pbr("FH_RockDark", "rock_face_03", 3.0, tint=(0.35, 0.36, 0.4), nstr=1.5)
m_pbr("FH_NorseWood", "dark_wood", 1.5, tint=(0.75, 0.62, 0.52), rot=(0, 90, 0))
m_pbr("FH_Planks", "dark_wooden_planks", 2.0)
m_pbr("FH_BarrelWood", "dark_wooden_planks", 1.2, tint=(1.1, 0.95, 0.8), rot=(0, 90, 0))
m_pbr("FH_TableWood", "dark_wooden_planks", 2.0, tint=(1.5, 1.25, 1.0))

# drop the add-on's own (unused) materials so they don't clutter the file
for asset in ("rock_tile_floor", "marble_01", "dark_brick_wall", "rock_face_03", "dark_wood", "dark_wooden_planks"):
    mm = bpy.data.materials.get(asset)
    if mm and mm.users == 0:
        bpy.data.materials.remove(mm)
print("textured materials ok")
