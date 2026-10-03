RUNES = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ"
CAM = (0, -10.5, 1.9)
PROP_PREFIXES = ("Anvil_", "Lightning", "Axe_", "Spark", "RedSmoke", "Ember", "Smoke_Light", "Shelves_",
                 "CrystalLight", "Rock_Shelf", "RuneBoard", "Barrel_", "Bucket", "Weapon", "Table", "Swatch")
for o in list(_col().all_objects):
    if o.name.startswith(PROP_PREFIXES):
        bpy.data.objects.remove(o, do_unlink=True)
if "FH_Ingot_Gold" not in bpy.data.materials:
    m_basic("FH_Ingot_Gold", (1.0, 0.68, 0.26), 0.3, 1.0, (1.0, 0.6, 0.2), 0.3)

# ---------------- anvils ----------------
def anvil(name, loc, rotz=0, s=1.0):
    e = empty(name, loc, (0, 0, rotz))
    prim("cube", f"{name}_Block", (0, 0, 0.3 * s), (1.0 * s, 0.75 * s, 0.6 * s), m=MT("FH_BlockStone"),
         bevel=0.04 * s, parent=e)
    frustum(f"{name}_Foot", 0.66 * s, 0.44 * s, 0.4 * s, 0.26 * s, 0.16 * s, m=MT("FH_Iron"),
            loc=(0, 0, 0.6 * s), parent=e)
    prim("cube", f"{name}_Waist", (0, 0, 0.86 * s), (0.36 * s, 0.24 * s, 0.2 * s), m=MT("FH_Iron"), parent=e)
    frustum(f"{name}_Face", 0.62 * s, 0.3 * s, 0.9 * s, 0.34 * s, 0.2 * s, m=MT("FH_Iron"),
            loc=(0, 0, 0.96 * s), parent=e)
    prim("cone", f"{name}_Horn", (0.72 * s, 0, 1.08 * s), rot=(0, 90, 0), m=MT("FH_Iron"),
         radius1=0.14 * s, radius2=0.0, depth=0.42 * s, vertices=16, smooth=True, parent=e)
    return e

aL = anvil("Anvil_Zeus", (-2.3, -1.4, 0), rotz=12)
for b in range(6):  # lightning arcs
    p = Vector((rng.uniform(-0.35, 0.35), rng.uniform(-0.1, 0.1), 1.17))
    pts = [p.copy()]
    d = Vector((rng.uniform(-1, 1), rng.uniform(-0.6, 0.6), rng.uniform(0.3, 1.0))).normalized()
    for _ in range(7):
        p = p + d * rng.uniform(0.08, 0.16) + Vector([rng.uniform(-0.07, 0.07) for _ in range(3)])
        pts.append(p.copy())
    tube(f"Lightning{b}", pts, 0.009, m=MT("FH_Lightning"), parent=aL, res=2)
light("Lightning_Light", "POINT", (-2.3, -1.4, 1.6), 250, (0.4, 0.7, 1.0), 0.1)

aR = anvil("Anvil_Norse", (2.4, -1.2, 0), rotz=-18)
prim("cyl", "Axe_Handle", (0.05, 0.05, 1.2), rot=(0, 90, 12), m=MT("FH_TableWood"), radius=0.035,
     depth=1.25, vertices=12, smooth=True, parent=aR)
blade = prism("Axe_Blade", [(0, -0.07), (0.22, -0.2), (0.3, 0.0), (0.22, 0.22), (0, 0.08)], -0.012, 0.012,
              m=MT("FH_Steel"), loc=(-0.5, 0.0, 1.2), rot=(90, 0, 102), parent=aR)
prim("cube", "Axe_Bind", (-0.53, 0.07, 1.2), (0.1, 0.09, 0.09), rot=(0, 0, 12), m=MT("FH_Leather"), parent=aR)

aS = anvil("Anvil_Small", (-1.75, 0.55, 0), rotz=30, s=0.55)
for k in range(14):  # sparks
    p = Vector((-1.75 + rng.uniform(-0.1, 0.1), 0.55 + rng.uniform(-0.1, 0.1), 0.66))
    d = Vector((rng.uniform(-1, 1), rng.uniform(-1, 0.3), rng.uniform(0.4, 1.3))).normalized()
    tube(f"Spark{k}", [p + d * rng.uniform(0.1, 0.4), p + d * rng.uniform(0.45, 0.8)], 0.006,
         m=MT("FH_Spark"), res=1)
light("Spark_Light", "POINT", (-1.75, 0.45, 0.9), 60, (1.0, 0.55, 0.2), 0.05)

# red forge smoke + embers
sm = prim("cube", "RedSmoke", (1.35, 0.25, 0.55), (2.6, 1.8, 1.1), m=MT("FH_RedSmoke"))
for k in range(70):
    prim("ico", f"Ember{k}", (rng.uniform(0.4, 2.6), rng.uniform(-0.6, 1.0), rng.uniform(0.02, 0.9)),
         m=MT("FH_Ember"), radius=rng.uniform(0.008, 0.02), subdivisions=1)
light("Smoke_Light", "POINT", (1.4, 0.2, 0.4), 120, (1.0, 0.12, 0.05), 0.5)

# ---------------- shelves ----------------
def crystal_cluster(name, loc, key, parent, n=4, h=0.34):
    for k in range(n):
        hh = h * rng.uniform(0.55, 1.0)
        prim("ico", f"{name}_{k}", (loc[0] + rng.uniform(-0.08, 0.08), loc[1] + rng.uniform(-0.05, 0.05),
                                    loc[2] + hh * 0.45),
             (0.38, 0.38, 1.0), rot=(rng.uniform(-22, 22), rng.uniform(-22, 22), rng.uniform(0, 60)),
             m=MT(f"FH_Crystal_{key}"), radius=hh / 2, subdivisions=1, parent=parent)

def ingot_stack(name, loc, key, parent, n=3):
    for k in range(n):
        frustum(f"{name}_{k}", 0.3, 0.13, 0.24, 0.09, 0.07, m=MT(f"FH_Ingot_{key}"),
                loc=(loc[0] + (k % 2) * 0.04, loc[1], loc[2] + k * 0.07), rot=(0, 0, rng.uniform(-8, 8)),
                parent=parent)

def jar(name, loc, parent, h=0.28, r=0.09, key="FH_Bronze"):
    prim("cyl", name, loc=(loc[0], loc[1], loc[2] + h / 2), m=MT(key), radius=r, depth=h,
         vertices=16, smooth=True, parent=parent)
    prim("cyl", f"{name}_Lid", (loc[0], loc[1], loc[2] + h + 0.02), m=MT("FH_Iron"), radius=r * 0.8,
         depth=0.04, vertices=16, parent=parent)

def shelf_unit(name, loc, rotz, crystals, ingots, w=2.0, h=3.4, d=0.5):
    e = empty(name, loc, (0, 0, rotz))
    W = MT("FH_NorseWood")
    prim("cube", f"{name}_Back", (0, d / 2, h / 2), (w, 0.05, h), m=MT("FH_Planks"), parent=e)
    for sx in (-1, 1):
        prim("cube", f"{name}_Side{sx}", (sx * w / 2, 0, h / 2), (0.09, d, h), m=W, bevel=0.01, parent=e)
    zs = [0.35, 1.2, 2.05, 2.9]
    for i, z in enumerate(zs + [h]):
        prim("cube", f"{name}_Board{i}", (0, 0, z), (w, d, 0.06), m=W, bevel=0.01, parent=e)
    xs = [-0.7, -0.23, 0.23, 0.7]
    for i, key in enumerate(crystals):  # crystals on the top shelf
        crystal_cluster(f"{name}_Cr{i}", (xs[i], 0, zs[3] + 0.03), key, e)
        prim("cyl", f"{name}_CrBase{i}", (xs[i], 0, zs[3] + 0.045), m=MT("FH_Gold"), radius=0.1,
             depth=0.03, vertices=16, parent=e)
    for i, key in enumerate(ingots):
        ingot_stack(f"{name}_Ing{i}", (xs[i], -0.05, zs[2] + 0.03), key, e)
    for i, x in enumerate(xs):
        jar(f"{name}_Jar{i}", (x + rng.uniform(-0.05, 0.05), 0, zs[1] + 0.03), e,
            h=rng.uniform(0.2, 0.34), key=("FH_Bronze", "FH_Copper")[i % 2])
    for i in range(3):
        jar(f"{name}_Pot{i}", (-0.6 + i * 0.55, 0, zs[0] + 0.03), e, h=0.4, r=0.14, key="FH_BarrelWood")
    return e

for sx, crys, ings in ((-1, ("Red", "Blue", "Green", "Ice"), ("Gold", "Red", "Blue", "Green")),
                       (1, ("Pink", "Blue", "Green", "Purple"), ("Gold", "Purple", "Blue", "Red"))):
    pos = (sx * 4.95, -5.1, 0)
    rz = rot_toward(pos, CAM) - sx * 30
    shelf_unit(f"Shelves_{'L' if sx < 0 else 'R'}", pos, rz, crys, ings)
    for i, key in enumerate(crys):
        c = {"Red": (1, .15, .1), "Blue": (.2, .45, 1), "Green": (.2, .9, .35), "Ice": (.6, .85, 1),
             "Pink": (1, .3, .6), "Purple": (.65, .2, 1)}[key]
        light(f"CrystalLight_{sx}_{i}", "POINT",
              (pos[0] - sx * 0.5, pos[1] + 0.25 + (i - 1.5) * 0.35, 3.3), 18, c, 0.05)
    rock(f"Rock_Shelf_{sx}", (sx * 6.1, -5.0, 2.6), (1.1, 2.2, 3.4), MT("FH_Rock"), strength=0.7)
    rock(f"Rock_ShelfTop_{sx}", (sx * 5.3, -4.6, 5.3), (1.8, 2.0, 1.2), MT("FH_Rock"), strength=0.6)
    # rune signboard above
    bpos = (sx * 4.5, -4.7, 4.3)
    brz = rot_toward(bpos, CAM) - sx * 25
    be = empty(f"RuneBoard_{sx}", bpos, (0, 0, brz))
    prim("cube", f"RuneBoard_{sx}_Plank", (0, 0, 0), (2.3, 0.14, 0.62), m=MT("FH_NorseWood"), bevel=0.03, parent=be)
    text(f"RuneBoard_{sx}_Runes", RUNES[(0 if sx < 0 else 9):][:9], "rune", 0.4, (0, -0.075, 0),
         m=MT("FH_Bronze"), extrude=0.012, parent=be, spacing=1.2)

# ---------------- barrels / buckets / weapons ----------------
def barrel(name, loc, r=0.38, h=0.95, rotz=0):
    e = empty(name, loc, (0, 0, rotz))
    prim("cyl", f"{name}_Staves", (0, 0, h / 2), m=MT("FH_BarrelWood"), radius=r, depth=h, vertices=24,
         smooth=True, parent=e)
    prim("cyl", f"{name}_Lid", (0, 0, h + 0.005), m=MT("FH_NorseWood"), radius=r * 0.94, depth=0.02,
         vertices=24, parent=e)
    for i, z in enumerate((0.12, h / 2, h - 0.12)):
        prim("torus", f"{name}_Band{i}", (0, 0, z), m=MT("FH_Iron"), major_radius=r + 0.008,
             minor_radius=0.018, major_segments=32, minor_segments=6, parent=e)
    text(f"{name}_Rune", RUNES[rng.randrange(len(RUNES))], "rune", 0.22, (0, -r - 0.012, h * 0.3),
         m=MT("FH_Bronze"), extrude=0.005, parent=e)
    return e

barrel("Barrel_A", (3.35, -0.35, 0), rotz=-30)
barrel("Barrel_B", (4.2, -5.3, 0), r=0.42, h=1.0, rotz=-20)
barrel("Barrel_C", (3.35, -6.0, 0), r=0.42, h=1.0, rotz=-35)
barrel("Barrel_D", (1.55, 0.9, 0), r=0.26, h=0.6)
barrel("Barrel_E", (-1.1, 1.0, 0), r=0.24, h=0.55)

for i, (x, y) in enumerate(((-4.05, -3.2), (-3.5, -3.6))):
    prim("cone", f"Bucket{i}", (x, y, 0.24), m=MT("FH_BarrelWood"), radius1=0.22, radius2=0.28,
         depth=0.48, vertices=20, smooth=True)
    prim("torus", f"Bucket{i}_Band", (x, y, 0.4), m=MT("FH_Iron"), major_radius=0.27, minor_radius=0.015,
         major_segments=24, minor_segments=6)
    for k in range(3):
        a = R(rng.uniform(0, 360))
        top = (x + 0.25 * math.cos(a), y + 0.25 * math.sin(a), 1.2 + rng.uniform(-0.1, 0.2))
        tube(f"Bucket{i}_Tool{k}", [(x, y, 0.1), top], 0.022, m=MT("FH_TableWood"))
        prim("cube", f"Bucket{i}_ToolHead{k}", top, (0.18, 0.06, 0.07), rot=(0, 0, math.degrees(a)),
             m=MT("FH_Iron"))

for i, y in enumerate((-3.7, -3.3, -2.9, -2.5)):  # weapons leaning on the plank wall
    base, top = (4.25, y, 0.0), (4.75, y + rng.uniform(-0.1, 0.1), 1.75)
    tube(f"Weapon{i}_Haft", [base, top], 0.025, m=MT("FH_TableWood"))
    if i % 2 == 0:
        prism(f"Weapon{i}_Head", [(0, -0.06), (0.2, -0.16), (0.24, 0.0), (0.2, 0.16), (0, 0.06)],
              -0.01, 0.01, m=MT("FH_Steel"), loc=(top[0] - 0.03, top[1], top[2] - 0.2), rot=(90, 0, 180))
    else:
        prim("cube", f"Weapon{i}_Head", (top[0] - 0.02, top[1], top[2] - 0.08), (0.12, 0.26, 0.12),
             m=MT("FH_Iron"), bevel=0.01)

# ---------------- foreground table ----------------
T = empty("Table", (-3.0, -5.2, 0), (0, 0, 7))
prim("cube", "Table_Top", (0, 0, 0.85), (2.5, 1.15, 0.1), m=MT("FH_TableWood"), bevel=0.015, parent=T)
for i, (x, y) in enumerate(((-1.1, -0.45), (1.1, -0.45), (-1.1, 0.45), (1.1, 0.45))):
    prim("cube", f"Table_Leg{i}", (x, y, 0.4), (0.11, 0.11, 0.8), m=MT("FH_NorseWood"), parent=T)
prim("cube", "Table_Stretcher", (0, 0, 0.2), (2.2, 0.07, 0.07), m=MT("FH_NorseWood"), parent=T)
m_basic("FH_CardFace", (0.92, 0.88, 0.8), 0.5)
for i, (x, y, rz, key) in enumerate(((-1.0, -0.25, 12, "Blue"), (-0.72, -0.3, -6, "Purple"),
                                     (-0.9, 0.12, 25, "Red"))):
    ce = empty(f"TableCard{i}", (x, y, 0.905 + 0.004 * i), (0, 0, rz), parent=T)
    prim("cube", f"TableCard{i}_Frame", (0, 0, 0), (0.24, 0.34, 0.004), m=MT("FH_CardFace"), parent=ce)
    prim("cube", f"TableCard{i}_Art", (0, 0.03, 0.001), (0.2, 0.22, 0.004), m=MT(f"FH_Ingot_{key}"), parent=ce)
# map with ink lines
mm, nt, b, _ = new_mat("FH_Map")
wv = N(nt, "ShaderNodeTexWave", wave_type="RINGS")
wv.inputs["Scale"].default_value = 6.0
wv.inputs["Distortion"].default_value = 9.0
L(nt, coords(nt), wv.inputs["Vector"])
r = ramp(nt, [(0.0, (0.25, 0.16, 0.08)), (0.06, (0.78, 0.68, 0.48)), (1.0, (0.78, 0.68, 0.48))])
L(nt, wv.outputs["Fac"], r.inputs["Fac"])
L(nt, r.outputs["Color"], b.inputs["Base Color"])
b.inputs["Roughness"].default_value = 0.9
prim("cube", "Table_Map", (0.05, 0.05, 0.905), (0.95, 0.62, 0.004), rot=(0, 0, -4), m=mm, parent=T)
for s in (-1, 1):
    prim("cyl", f"Table_MapRoll{s}", (0.05 + s * 0.49, 0.05, 0.94), rot=(90, 0, -4), m=MT("FH_Paper"),
         radius=0.04, depth=0.66, vertices=16, smooth=True, parent=T)
prim("cyl", "Table_Scroll", (-0.25, 0.4, 0.95), rot=(0, 90, 20), m=MT("FH_Paper"), radius=0.05,
     depth=0.8, vertices=16, smooth=True, parent=T)
for s in (-1, 1):
    prim("cyl", f"Table_ScrollKnob{s}", (-0.25 + s * 0.44 * math.cos(R(20)), 0.4 + s * 0.44 * math.sin(R(20)), 0.95),
         rot=(0, 90, 20), m=MT("FH_NorseWood"), radius=0.035, depth=0.08, vertices=12, parent=T)
# colour swatch card
sw = empty("Swatch", (0.85, -0.25, 0.905), (0, 0, -10), parent=T)
prim("cube", "Swatch_Card", (0, 0, 0), (0.42, 0.3, 0.004), m=MT("FH_CardFace"), parent=sw)
for i in range(6):
    for j in range(4):
        h = (i / 6 + j * 0.04) % 1.0
        import colorsys
        c = colorsys.hsv_to_rgb(h, 0.8, 0.9 - j * 0.15)
        mt = bpy.data.materials.get(f"FH_Sw_{i}_{j}") or m_basic(f"FH_Sw_{i}_{j}", c, 0.5)
        prim("cube", f"Swatch_{i}_{j}", (-0.16 + i * 0.064, -0.09 + j * 0.06, 0.003), (0.05, 0.045, 0.002),
             m=mt, parent=sw)
print("props done:", len(_col().all_objects))
