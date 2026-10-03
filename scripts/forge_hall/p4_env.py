for o in list(_col().all_objects):
    if o.name.startswith(("Env_", "Lt_", "Cam")):
        bpy.data.objects.remove(o, do_unlink=True)

# ================= world: day (−X) → aurora night (+X) =================
sc = bpy.context.scene
w = bpy.data.worlds.get("FH_World") or bpy.data.worlds.new("FH_World")
sc.world = w
try:
    w.use_nodes = True
except Exception:
    pass
nt = w.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
out = N(nt, "ShaderNodeOutputWorld")
bg = N(nt, "ShaderNodeBackground")
L(nt, bg.outputs[0], out.inputs["Surface"])
tc = N(nt, "ShaderNodeTexCoord")
d = tc.outputs["Generated"]
sep = N(nt, "ShaderNodeSeparateXYZ")
L(nt, d, sep.inputs[0])
# day sky
day_grad = ramp(nt, [(0.0, (0.95, 0.9, 0.85)), (0.12, (0.62, 0.78, 1.0)), (0.55, (0.16, 0.4, 0.95))])
L(nt, sep.outputs["Z"], day_grad.inputs["Fac"])
cl = N(nt, "ShaderNodeTexNoise")
cl.inputs["Scale"].default_value = 2.2
cl.inputs["Detail"].default_value = 8.0
cl.inputs["Roughness"].default_value = 0.6
cstretch = N(nt, "ShaderNodeVectorMath", operation="MULTIPLY")
cstretch.inputs[1].default_value = (1.0, 1.0, 3.0)
L(nt, d, cstretch.inputs[0])
L(nt, cstretch.outputs[0], cl.inputs["Vector"])
cmask = ramp(nt, [(0.5, (0, 0, 0)), (0.68, (1, 1, 1))])
L(nt, cl.outputs["Fac"], cmask.inputs["Fac"])
day = mix_rgb(nt, "MIX", cmask.outputs["Color"], day_grad.outputs["Color"], (1.0, 0.98, 0.95))
# night sky
night_grad = ramp(nt, [(0.0, (0.03, 0.08, 0.14)), (0.3, (0.01, 0.025, 0.06)), (0.8, (0.003, 0.006, 0.02))])
L(nt, sep.outputs["Z"], night_grad.inputs["Fac"])
vo = N(nt, "ShaderNodeTexVoronoi")
vo.inputs["Scale"].default_value = 260.0
L(nt, d, vo.inputs["Vector"])
st = N(nt, "ShaderNodeMapRange")
st.inputs["From Min"].default_value = 0.0
st.inputs["From Max"].default_value = 0.05
st.inputs["To Min"].default_value = 4.0
st.inputs["To Max"].default_value = 0.0
L(nt, vo.outputs["Distance"], st.inputs["Value"])
night = mix_rgb(nt, "ADD", st.outputs["Result"], night_grad.outputs["Color"], (1.0, 1.0, 1.0))
au = N(nt, "ShaderNodeTexWave", wave_type="BANDS", bands_direction="X")
au.inputs["Scale"].default_value = 1.6
au.inputs["Distortion"].default_value = 6.0
au.inputs["Detail"].default_value = 3.0
L(nt, d, au.inputs["Vector"])
au_col = ramp(nt, [(0.35, (0, 0, 0)), (0.6, (0.05, 1.0, 0.45)), (0.85, (0.1, 0.6, 1.0))])
L(nt, au.outputs["Fac"], au_col.inputs["Fac"])
zband = ramp(nt, [(0.05, (0, 0, 0)), (0.25, (1, 1, 1)), (0.7, (0.2, 0.2, 0.2))])
L(nt, sep.outputs["Z"], zband.inputs["Fac"])
au_masked = mix_rgb(nt, "MULTIPLY", 1.0, au_col.outputs["Color"], zband.outputs["Color"])
night = mix_rgb(nt, "ADD", 0.8, night, au_masked)
# blend by direction x
side = N(nt, "ShaderNodeMapRange")
side.inputs["From Min"].default_value = -0.1
side.inputs["From Max"].default_value = 0.25
L(nt, sep.outputs["X"], side.inputs["Value"])
sky = mix_rgb(nt, "MIX", side.outputs["Result"], day, night)
L(nt, sky, bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0

# ================= Olympus: cloud sea + floating city (left) =================
for k in range(55):
    x = rng.uniform(-90, -9)
    y = rng.uniform(-25, 90)
    s = rng.uniform(3, 9)
    prim("ico", f"Env_Cloud{k}", (x, y, rng.uniform(-3.5, -1.0)), (s * 1.3, s, s * 0.35),
         m=MT("FH_Cloud"), radius=1, subdivisions=3, smooth=True)
city = [(-30, 34, 0, "tower"), (-27, 38, 0, "dome"), (-33, 40, 0, "temple"), (-24, 44, 0, "tower"),
        (-36, 30, 0, "dome"), (-29, 46, 0, "temple"), (-38, 42, 0, "tower")]
prim("ico", "Env_CityCloud", (-31, 38, -0.8), (10, 10, 1.4), m=MT("FH_Cloud"), radius=1, subdivisions=3, smooth=True)
for i, (x, y, z, kind) in enumerate(city):
    if kind == "tower":
        h = rng.uniform(7, 11)
        prim("cyl", f"Env_City{i}", (x, y, h / 2), m=MT("FH_CityMarble"), radius=0.9, depth=h, vertices=16)
        prim("uv", f"Env_City{i}_Dome", (x, y, h), (1, 1, 1.4), m=MT("FH_Gold"), radius=0.95, segments=16, ring_count=8)
    elif kind == "dome":
        prim("cube", f"Env_City{i}", (x, y, 1.8), (4, 4, 3.6), m=MT("FH_CityMarble"))
        prim("uv", f"Env_City{i}_Dome", (x, y, 3.6), (1, 1, 0.9), m=MT("FH_CityMarble"), radius=1.9,
             segments=24, ring_count=12)
    else:
        prim("cube", f"Env_City{i}", (x, y, 1.2), (6, 3.5, 2.4), m=MT("FH_CityMarble"))
        prim("cone", f"Env_City{i}_Roof", (x, y, 2.9), (1.8, 1, 0.5), m=MT("FH_CityMarble"),
             radius1=1.8, radius2=0, depth=1.0, vertices=4, rot=(0, 0, 45))

# ================= Norse: fjord + mountains (right) =================
prim("plane", "Env_Water", (90, 60, -9), (200, 260, 1), m=MT("FH_Water"))
for k, (x, y, h, r) in enumerate(((22, 18, 16, 9), (34, 30, 24, 14), (20, 45, 20, 12), (50, 20, 18, 12),
                                   (45, 60, 30, 18), (16, 70, 22, 12), (70, 45, 26, 16))):
    o = rock(f"Env_Mountain{k}", (x, y, -9 + h / 2), (r, r, h / 2 + 2), MT("FH_Mountain"),
             detail=4, strength=2.5, noise=3.0)
rock("Env_CliffR", (8.0, -1.0, -5.0), (2.5, 7.0, 5.0), MT("FH_RockDark"), strength=0.8)
rock("Env_CliffBack", (6.0, 5.5, -2.0), (4.0, 3.0, 3.0), MT("FH_RockDark"), strength=0.8)

# ================= lighting =================
light("Lt_Sun", "SUN", (0, 0, 20), 2.6, (1.0, 0.94, 0.84), size=2.0, aim=(0.9, 0.35, -0.55))
light("Lt_ForgeCore", "POINT", (0, 1.7, 1.2), 1800, (1.0, 0.42, 0.1), 0.5)
light("Lt_ForgeSpill", "AREA", (0, 0.7, 1.3), 900, (1.0, 0.45, 0.12), 1.4, aim=(0, -3, 0))
light("Lt_ForgeUp", "POINT", (0, 0.6, 3.2), 250, (1.0, 0.5, 0.2), 0.3)
light("Lt_Aurora", "AREA", (4.3, 0.6, 3.5), 350, (0.3, 1.0, 0.75), 3.0, aim=(0, -1, 1))
light("Lt_NorseFill", "AREA", (3.5, -7.5, 4.0), 300, (0.5, 0.65, 1.0), 4.0, aim=(3.5, -3, 1))
light("Lt_OlympusFill", "AREA", (-3.5, -7.5, 4.0), 250, (1.0, 0.92, 0.8), 4.0, aim=(-3.5, -3, 1))
light("Lt_Lintel", "AREA", (0, -1.5, 3.4), 200, (1.0, 0.75, 0.45), 3.0, aim=(0, 1.6, 4.9))

# ================= camera =================
tgt = empty("Cam_Target", (0, 0, 2.6))
cd = bpy.data.cameras.new("Cam_Hall")
cd.lens = 20
cd.clip_end = 500
cam = bpy.data.objects.new("Cam_Hall", cd)
cam.location = (0, -10.5, 1.9)
_col().objects.link(cam)
tr = cam.constraints.new("TRACK_TO")
tr.target = tgt
sc.camera = cam
print("env done:", len(_col().all_objects))
