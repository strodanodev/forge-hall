# World = user's dusk sky dome (upper hemisphere image) + faint aurora on the Norse (+X) side.
SKY = r"C:\Users\strodano\Documents\LitVM Games\blender\assets\sky\sky_dusk.jpg"
SUN_AZ = math.radians(135)   # sun glow back-left, over the Olympus colonnade
SUN_EL = math.radians(7)

sc = bpy.context.scene
w = sc.world
nt = w.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
out = N(nt, "ShaderNodeOutputWorld")
bg = N(nt, "ShaderNodeBackground")
L(nt, bg.outputs[0], out.inputs["Surface"])
sep = N(nt, "ShaderNodeSeparateXYZ")
L(nt, N(nt, "ShaderNodeTexCoord").outputs["Generated"], sep.inputs[0])

def math_node(op, a, b=None, clamp=False, c=None):
    m = N(nt, "ShaderNodeMath", operation=op, use_clamp=clamp)
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            L(nt, v, m.inputs[i])
    return m.outputs[0]

# dome mapping: u from azimuth (sun at image centre), v from elevation (horizon=0, zenith=1)
az = math_node("ARCTAN2", sep.outputs["Y"], sep.outputs["X"])
u = math_node("WRAP", math_node("SUBTRACT", 0.5, math_node("DIVIDE", math_node("SUBTRACT", az, SUN_AZ), 2 * math.pi)), 1.0, c=0.0)
el = math_node("ARCSINE", math_node("MINIMUM", math_node("MAXIMUM", sep.outputs["Z"], -1.0), 1.0))
v = math_node("DIVIDE", el, math.pi / 2, clamp=True)
uv = N(nt, "ShaderNodeCombineXYZ")
L(nt, u, uv.inputs[0])
L(nt, v, uv.inputs[1])
img = N(nt, "ShaderNodeTexImage", extension="EXTEND", interpolation="Cubic")
img.image = bpy.data.images.load(SKY, check_existing=True)
img.image.pack()
L(nt, uv.outputs[0], img.inputs["Vector"])
# below the horizon: fade to deep dusk blue (cloud sea / fjord sit there anyway)
below = N(nt, "ShaderNodeMapRange")
below.inputs["From Min"].default_value = -0.15
below.inputs["From Max"].default_value = 0.0
below.inputs["To Min"].default_value = 1.0
below.inputs["To Max"].default_value = 0.0
L(nt, sep.outputs["Z"], below.inputs["Value"])
sky = mix_rgb(nt, "MIX", below.outputs["Result"], img.outputs["Color"], (0.02, 0.035, 0.07))

# aurora curtains, only on the Norse side and only above the horizon
azs = math_node("MULTIPLY", az, 5.0)
cb = N(nt, "ShaderNodeCombineXYZ")
L(nt, azs, cb.inputs[0])
L(nt, math_node("MULTIPLY", sep.outputs["Z"], 0.7), cb.inputs[1])
nz = N(nt, "ShaderNodeTexNoise")
nz.inputs["Scale"].default_value = 1.6
nz.inputs["Detail"].default_value = 4.0
nz.inputs["Distortion"].default_value = 0.6
L(nt, cb.outputs[0], nz.inputs["Vector"])
au = ramp(nt, [(0.4, (0, 0, 0)), (0.62, (0.05, 1.0, 0.45)), (0.85, (0.1, 0.6, 1.0))])
L(nt, nz.outputs["Fac"], au.inputs["Fac"])
zb = ramp(nt, [(0.08, (0, 0, 0)), (0.3, (1, 1, 1)), (0.75, (0.1, 0.1, 0.1))])
L(nt, sep.outputs["Z"], zb.inputs["Fac"])
side = N(nt, "ShaderNodeMapRange")
side.inputs["From Min"].default_value = 0.05
side.inputs["From Max"].default_value = 0.45
side.inputs["To Max"].default_value = 0.55
L(nt, sep.outputs["X"], side.inputs["Value"])
mask = mix_rgb(nt, "MULTIPLY", 1.0, zb.outputs["Color"], (1, 1, 1))
aur = mix_rgb(nt, "MULTIPLY", 1.0, au.outputs["Color"], mask)
sky = mix_rgb(nt, "ADD", side.outputs["Result"], sky, aur)
L(nt, sky, bg.inputs["Color"])

# camera sees the sky at full strength; lighting gets a softer share
lp = N(nt, "ShaderNodeLightPath")
st = N(nt, "ShaderNodeMapRange")
st.inputs["To Min"].default_value = 0.45
st.inputs["To Max"].default_value = 1.0
L(nt, lp.outputs["Is Camera Ray"], st.inputs["Value"])
L(nt, st.outputs["Result"], bg.inputs["Strength"])

# low warm sun from the image's sun direction
sun = bpy.data.objects["Lt_Sun"]
sdir = Vector((math.cos(SUN_AZ) * math.cos(SUN_EL), math.sin(SUN_AZ) * math.cos(SUN_EL), math.sin(SUN_EL)))
sun.rotation_euler = (-sdir).to_track_quat("-Z", "Y").to_euler()
sun.data.color = (1.0, 0.62, 0.38)
sun.data.energy = 2.6
sun.data.angle = math.radians(1.5)
bpy.ops.wm.save_mainfile()
print("dusk sky ok")
