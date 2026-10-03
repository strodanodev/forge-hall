import bmesh
from mathutils import Matrix
O = bpy.data.objects

def kill(pred):
    for o in list(_col().all_objects):
        if pred(o.name):
            bpy.data.objects.remove(o, do_unlink=True)

# ---- axe: drop the stray knife (loose parts left of the haft), re-centre ----
ax = O["MX_axe"]
if "knife_removed" not in ax:
    bm = bmesh.new()
    bm.from_mesh(ax.data)
    bm.verts.ensure_lookup_table()
    seen, parts = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        stack, comp = [v], []
        seen.add(v)
        while stack:
            x = stack.pop()
            comp.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        parts.append(comp)
    doomed = [v for comp in parts if sum(v.co.x for v in comp) / len(comp) < -0.2 for v in comp]
    print("axe parts:", len(parts), "removing verts:", len(doomed))
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(ax.data)
    bm.free()
    bb = [Vector(c) for c in ax.bound_box]
    cx = (min(v.x for v in bb) + max(v.x for v in bb)) / 2
    cy = (min(v.y for v in bb) + max(v.y for v in bb)) / 2
    ax.data.transform(Matrix.Translation((-cx, -cy, -min(v.z for v in bb))))
    ax["knife_removed"] = True

def inst(src, name, loc, height, rot=(0, 0, 0), xy=1.0, parent=None, mat=None, stretch_z=False):
    s = O[f"MX_{src}"]
    k = height / s.dimensions.z
    o = bpy.data.objects.new(name, s.data)
    _col().objects.link(o)
    o.location = loc
    o.rotation_euler = tuple(R(a) for a in rot)
    if stretch_z:  # xy is an absolute scale, z fits the height
        o.scale = (xy, xy, k)
    else:
        o.scale = (k * xy, k * xy, k)
    if parent:
        o.parent = parent
    if mat:
        o.material_slots[0].link = "OBJECT"
        o.material_slots[0].material = MT(mat)
    return o

kill(lambda n: n.startswith("MXI_"))  # idempotent re-runs

# ---- hearth ----
kill(lambda n: n.startswith(("Hearth_Body", "Hearth_Dome", "Hearth_Band", "Hearth_ArchTrim", "Hearth_Emblem",
                             "Hearth_MouthCut")))
inst("hearth", "MXI_Hearth", (0, 2.4, 0.12), 3.7, xy=1.9, stretch_z=True)
ch = O["Chimney"]
ch.scale.z = (12.0 - 3.3) / 8.0
ch.location.z = (12.0 + 3.3) / 2

# ---- anvils (+ axe on the Norse one) ----
for n, h in (("Anvil_Zeus", 1.2), ("Anvil_Norse", 1.2), ("Anvil_Small", 0.66)):
    kill(lambda x, n=n: x.startswith(tuple(f"{n}_{p}" for p in ("Block", "Foot", "Waist", "Face", "Horn"))))
    inst("anvil", f"MXI_{n}", (0, 0, 0), h, parent=O[n])
kill(lambda n: n.startswith("Axe_"))
inst("axe", "MXI_AxeOnAnvil", (0.05, 0.05, 1.19), 1.0, rot=(90, 0, 90), parent=O["Anvil_Norse"])

# ---- barrels ----
for n, h in (("Barrel_A", 0.95), ("Barrel_B", 1.0), ("Barrel_C", 1.0), ("Barrel_D", 0.6), ("Barrel_E", 0.55)):
    kill(lambda x, n=n: x.startswith(tuple(f"{n}_{p}" for p in ("Staves", "Lid", "Band", "Rune"))))
    inst("barrel", f"MXI_{n}", (0, 0, 0), h, parent=O[n])

# ---- weapons: three axes standing in barrel B ----
kill(lambda n: n.startswith("Weapon"))
bx, by = O["Barrel_B"].location.x, O["Barrel_B"].location.y
for i, (dx, dy, tx, tz) in enumerate(((-0.12, 0.05, -12, 20), (0.1, -0.08, 10, 150), (0.02, 0.12, 6, 260))):
    inst("axe", f"MXI_BarrelAxe{i}", (bx + dx, by + dy, 0.35), 1.45, rot=(tx, 0, tz))

# ---- crystals (recoloured per element) ----
kill(lambda n: n.startswith(("Shelves_L_Cr", "Shelves_R_Cr")) and "Base" not in n)
xs = (-0.7, -0.23, 0.23, 0.7)
for tag, cols in (("L", ("Red", "Blue", "Green", "Ice")), ("R", ("Pink", "Blue", "Green", "Purple"))):
    for i, c in enumerate(cols):
        inst("crystals", f"MXI_Crystal_{tag}{i}", (xs[i], 0, 2.94), 0.4, rot=(0, 0, 25 * i),
             parent=O[f"Shelves_{tag}"], mat=f"FH_Crystal_{c}")

# ---- columns ----
for n in ("Col_Center_-2.8", "Col_Center_2.8", "Col_Left_0", "Col_Left_1", "Col_Left_2"):
    kill(lambda x, n=n: x.startswith(n + "_"))
    inst("column", f"MXI_{n}", (0, 0, 0), 4.5, xy=0.72, parent=O[n])

# ---- tools on the floor by the Norse anvil ----
inst("tools", "MXI_Tools", (1.55, -2.05, 0.0), 0.5, rot=(0, 0, 35))

cnt = sum(1 for o in _col().all_objects if o.name.startswith("MXI_"))
print("instances:", cnt, "objects:", len(_col().all_objects))
