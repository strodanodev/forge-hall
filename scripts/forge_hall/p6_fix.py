RUNES = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ"
CAM = (0, -10.5, 1.9)
O = bpy.data.objects

def kill(prefixes):
    for o in list(_col().all_objects):
        if o.name.startswith(prefixes):
            bpy.data.objects.remove(o, do_unlink=True)

# ---------------- material pass: darker, moodier, finer grain ----------------
m_brick("FH_FloorSlab", (0.2, 0.185, 0.17), (0.14, 0.13, 0.122), (0.05, 0.045, 0.04),
        bw=1.5, rh=0.95, plane="xy", mortar_size=0.02, rough=0.55, grime=0.55)
m_noise("FH_Rock", (0.07, 0.065, 0.06), (0.26, 0.23, 0.2), scale=1.4, bump_s=0.9)
m_noise("FH_RockDark", (0.04, 0.04, 0.045), (0.14, 0.13, 0.13), scale=1.2, bump_s=0.9)
m_marble("FH_Marble", base=(0.78, 0.74, 0.66), vein=(0.6, 0.56, 0.5))
m_marble("FH_MarbleWarm", base=(0.66, 0.56, 0.42), vein=(0.46, 0.38, 0.28))
for n, wscale in (("FH_Marble", 0.5), ("FH_MarbleWarm", 0.5)):
    wv = next(x for x in MT(n).node_tree.nodes if x.type == "TEX_WAVE")
    wv.inputs["Scale"].default_value = wscale
    wv.inputs["Distortion"].default_value = 8.0
m_wood("FH_NorseWood", (0.05, 0.026, 0.014), (0.1, 0.055, 0.028), bands="X", scale=22, distortion=2.5)
m_wood("FH_TableWood", (0.16, 0.08, 0.035), (0.24, 0.13, 0.06), bands="Y", scale=18, distortion=2.5)
m_wood("FH_BarrelWood", (0.12, 0.06, 0.028), (0.2, 0.105, 0.05), bands="X", scale=28, distortion=2.0)
m_basic("FH_Iron", (0.05, 0.05, 0.055), 0.6, 1.0)
m_basic("FH_Lightning", (0.2, 0.5, 1), 0.3, 0, (0.15, 0.45, 1.0), 9)
m_fire("FH_Fire", 5.5, 3.0)
m_fire("FH_Coals", 2.5, 8.0)
m_basic("FH_GoldGlow", (1.0, 0.68, 0.26), 0.3, 1.0, (1.0, 0.55, 0.15), 1.5)
m_basic("FH_Cloud", (0.85, 0.88, 0.95), 0.95, 0, (0.8, 0.86, 1.0), 0.25)

# ---------------- rocks: craggier, drop the corner blobs ----------------
kill(("Rock_ShelfTop_",))
for o in _col().all_objects:
    if o.name.startswith("Rock_") and "Displace" in o.modifiers:
        o.modifiers["Displace"].strength *= 1.6
for t in bpy.data.textures:
    if t.name.startswith("RockNoise_") and not t.name.endswith("3.0"):
        t.noise_scale *= 0.55
        t.noise_depth = 4

# ---------------- Norse side: open second arch, braces, weapons in a barrel ----------------
kill(("Norse_Planks", "Norse_Rafter", "Weapon"))
def norse_arch(name, y0, y1, h):
    w = y1 - y0
    pts = [(4.85, y0 + w / 2 + x, z) for x, z in arch_outline(w, h, z0=0.0, n=24)[1:]] + [(4.85, y0, 0.0)]
    tube(name, pts, 0.2, m=MT("FH_NorseWood"))
    r = w / 2
    for k in range(1, 12):
        a = math.pi * k / 12
        g = text(f"{name}_Rune{k}", RUNES[(k * 5) % len(RUNES)], "rune", 0.22, (0, 0, 0),
                 m=MT("FH_Bronze"), extrude=0.01)
        orient(g, (0, math.sin(a), -math.cos(a)), (-1, 0, 0),
               (4.62, y0 + r + r * math.cos(a), h + r * math.sin(a)))
norse_arch("Norse_Arch2", -4.17, -0.83, 2.0)
for y in (-4.4, -0.6, 1.9):
    for s in (-1, 1):
        if -4.6 < y + s * 0.9 < 2.2:
            tube(f"Norse_Brace_{y}_{s}", [(4.85, y + s * 0.2, 3.7), (4.85, y + s * 1.0, 4.52)], 0.09,
                 m=MT("FH_NorseWood"))
prim("cube", "Norse_Header2", (4.85, -1.3, 5.5), (0.4, 7.4, 0.4), m=MT("FH_NorseWood"), bevel=0.03)
bx, by = O["Barrel_B"].location.x, O["Barrel_B"].location.y
for i in range(4):
    a = R(40 + i * 75)
    top = (bx + 0.22 * math.cos(a), by + 0.22 * math.sin(a), 1.9 + rng.uniform(-0.15, 0.15))
    tube(f"Weapon{i}_Haft", [(bx, by, 0.5), top], 0.025, m=MT("FH_TableWood"))
    if i % 2 == 0:
        prism(f"Weapon{i}_Head", [(0, -0.06), (0.22, -0.18), (0.27, 0.0), (0.22, 0.18), (0, 0.06)],
              -0.01, 0.01, m=MT("FH_Steel"), loc=(top[0], top[1], top[2] - 0.2), rot=(90, 0, math.degrees(a)))
    else:
        prim("cube", f"Weapon{i}_Head", (top[0], top[1], top[2] - 0.06), (0.26, 0.12, 0.12),
             rot=(0, 0, math.degrees(a)), m=MT("FH_Iron"), bevel=0.01)

# ---------------- shelves: face the camera more, pull forward ----------------
O["Table"].location.x = -2.7
kill(("CrystalLight_",))
for sx, tag in ((-1, "L"), (1, "R")):
    e = O[f"Shelves_{tag}"]
    e.location = (sx * 4.75, -5.7, 0)
    e.rotation_euler.z = R(rot_toward(e.location, CAM) - sx * 18)
    bpy.context.view_layer.update()
    cols = {"L": ((1, .15, .1), (.2, .45, 1), (.2, .9, .35), (.6, .85, 1)),
            "R": ((1, .3, .6), (.2, .45, 1), (.2, .9, .35), (.65, .2, 1))}[tag]
    for i, x in enumerate((-0.7, -0.23, 0.23, 0.7)):
        light(f"CrystalLight_{tag}_{i}", "POINT", e.matrix_world @ Vector((x, -0.35, 3.2)), 20, cols[i], 0.05)
    b = O[f"RuneBoard_{sx}"]
    b.location = (sx * 4.55, -5.4, 4.05)
    b.rotation_euler.z = R(rot_toward(b.location, CAM) - sx * 18)
    O[f"Rock_Shelf_{sx}"].location = (sx * 6.0, -5.6, 2.4)

# ---------------- clouds: lower and puffier ----------------
for o in _col().all_objects:
    if o.name.startswith("Env_Cloud"):
        o.location.z -= 2.0
        o.scale.z = 1.9
O["Env_CityCloud"].location.z = -1.2

# ---------------- lighting balance + world: camera sees full sky, lighting gets less ----------------
O["Lt_Sun"].data.energy = 1.5
O["Lt_OlympusFill"].data.energy = 120
O["Lt_NorseFill"].data.energy = 160
O["Lt_ForgeCore"].data.energy = 2200
O["Lt_ForgeSpill"].data.energy = 1200
wn = bpy.context.scene.world.node_tree
bg = next(n for n in wn.nodes if n.type == "BACKGROUND")
lp = N(wn, "ShaderNodeLightPath")
mr = N(wn, "ShaderNodeMapRange")
mr.inputs["To Min"].default_value = 0.3
mr.inputs["To Max"].default_value = 1.0
L(wn, lp.outputs["Is Camera Ray"], mr.inputs["Value"])
L(wn, mr.outputs["Result"], bg.inputs["Strength"])

# ---------------- compositor bloom ----------------
sc = bpy.context.scene
ng = bpy.data.node_groups.get("FH_Comp") or bpy.data.node_groups.new("FH_Comp", "CompositorNodeTree")
for n in list(ng.nodes):
    ng.nodes.remove(n)
if not any(i.item_type == "SOCKET" and i.in_out == "OUTPUT" for i in ng.interface.items_tree):
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
rl = ng.nodes.new("CompositorNodeRLayers")
gl = ng.nodes.new("CompositorNodeGlare")
gl.inputs["Type"].default_value = "Bloom"
gl.inputs["Threshold"].default_value = 1.2
gl.inputs["Strength"].default_value = 0.6
gl.inputs["Size"].default_value = 0.6
go = ng.nodes.new("NodeGroupOutput")
ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
ng.links.new(gl.outputs["Image"], go.inputs[0])
sc.compositing_node_group = ng
sc.render.use_compositing = True
print("fix done:", len(_col().all_objects))
