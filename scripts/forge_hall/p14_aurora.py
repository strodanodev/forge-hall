wn = bpy.context.scene.world.node_tree
wave = next(n for n in wn.nodes if n.type == "TEX_WAVE")
target = wave.outputs["Fac"].links[0].to_socket          # aurora colour ramp input
sep = next(n for n in wn.nodes if n.type == "SEPXYZ")
wn.nodes.remove(wave)
az = N(wn, "ShaderNodeMath", operation="ARCTAN2")
L(wn, sep.outputs["Y"], az.inputs[0])
L(wn, sep.outputs["X"], az.inputs[1])
azs = N(wn, "ShaderNodeMath", operation="MULTIPLY")
L(wn, az.outputs[0], azs.inputs[0])
azs.inputs[1].default_value = 5.0
zs = N(wn, "ShaderNodeMath", operation="MULTIPLY")
L(wn, sep.outputs["Z"], zs.inputs[0])
zs.inputs[1].default_value = 0.7
cb = N(wn, "ShaderNodeCombineXYZ")
L(wn, azs.outputs[0], cb.inputs[0])
L(wn, zs.outputs[0], cb.inputs[1])
nz = N(wn, "ShaderNodeTexNoise")
nz.inputs["Scale"].default_value = 1.6
nz.inputs["Detail"].default_value = 4.0
nz.inputs["Distortion"].default_value = 0.6
L(wn, cb.outputs[0], nz.inputs["Vector"])
L(wn, nz.outputs["Fac"], target)
bpy.ops.wm.save_mainfile()
print("aurora curtains ok")
