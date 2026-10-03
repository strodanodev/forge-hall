wn = bpy.context.scene.world.node_tree
lk = next(l for l in wn.links if l.from_node.type == "LIGHT_PATH")
lk.to_node.inputs["To Min"].default_value = 0.2
print("world min", lk.to_node.inputs["To Min"].default_value)
