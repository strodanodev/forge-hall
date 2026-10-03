RUNES = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ"

# ================= floor =================
prim("cube", "Floor", (0, -2.5, -0.1), (12.4, 12, 0.2), m=MT("FH_FloorSlab"))
prim("cyl", "Forge_Dais", (0, 2.3, 0.06), m=MT("FH_BlockStone"), radius=2.4, depth=0.12, vertices=48, bevel=0.02)

def grate(name, loc, w, d, rotz=0):
    e = empty(name, loc, (0, 0, rotz))
    prim("cube", f"{name}_Pit", (0, 0, 0.004), (w, d, 0.01), m=MT("FH_Void"), parent=e)
    for i, (x, y, sx, sy) in enumerate(((0, d / 2, w, 0.09), (0, -d / 2, w, 0.09),
                                         (w / 2, 0, 0.09, d), (-w / 2, 0, 0.09, d))):
        prim("cube", f"{name}_Frame{i}", (x, y, 0.02), (sx, sy, 0.04), m=MT("FH_Iron"), parent=e)
    n = int((w - 0.1) / 0.13)
    s = prim("cube", f"{name}_Slats", (-(n - 1) * 0.065, 0, 0.018), (0.045, d - 0.05, 0.03),
             m=MT("FH_Iron"), parent=e)
    a = s.modifiers.new("Array", "ARRAY")
    a.count, a.relative_offset_displace = n, (0.13 / 0.045, 0, 0)
    return e

grate("Grate_Front", (0, -5.0, 0), 2.8, 1.3)
grate("Grate_Left", (-2.9, -3.0, 0), 2.0, 1.0)
grate("Grate_Right", (2.9, -3.0, 0), 2.0, 1.0)
grate("Grate_FrontRight", (3.1, -5.2, 0), 2.0, 1.1)

# floor medallion with rune ring
prim("cyl", "Medallion", (0, -2.3, 0.004), m=MT("FH_BlockStone"), radius=1.25, depth=0.012, vertices=64)
prim("torus", "Medallion_RimOut", (0, -2.3, 0.01), m=MT("FH_Bronze"), major_radius=1.22,
     minor_radius=0.025, major_segments=64, minor_segments=6)
prim("torus", "Medallion_RimIn", (0, -2.3, 0.01), m=MT("FH_Bronze"), major_radius=0.8,
     minor_radius=0.02, major_segments=64, minor_segments=6)
for i in range(20):
    a = 2 * math.pi * i / 20
    g = text(f"Medallion_Rune{i}", RUNES[i % len(RUNES)], "rune", 0.24,
             (0, 0, 0), m=MT("FH_Bronze"), extrude=0.004)
    orient(g, (math.cos(a + math.pi / 2), math.sin(a + math.pi / 2), 0), (0, 0, 1),
           (1.01 * math.cos(a), -2.3 + 1.01 * math.sin(a), 0.014))
text("Medallion_Sigil", "⚒", "sym", 0.9, (0, -2.3, 0.014), rot=(0, 0, 0), m=MT("FH_Bronze"), extrude=0.004)

# ================= hearth =================
HX, HY = 0.0, 2.4
body = prim("cyl", "Hearth_Body", (HX, HY, 1.7), m=MT("FH_HearthBrick"), radius=1.35, depth=2.6, vertices=48)
cut = prism("Hearth_MouthCut", arch_outline(1.35, 0.95, z0=0.55), 0.6, 2.9, loc=(HX, 0, 0))
cut.hide_render = True
cut.display_type = "WIRE"
bo = body.modifiers.new("Mouth", "BOOLEAN")
bo.operation, bo.object = "DIFFERENCE", cut
prim("cone", "Hearth_Dome", (HX, HY, 3.55), m=MT("FH_HearthBrick"), radius1=1.35, radius2=0.5,
     depth=1.1, vertices=48)
for i, (z, r) in enumerate(((0.45, 1.39), (3.0, 1.39), (3.55, 0.96), (4.08, 0.55))):
    prim("torus", f"Hearth_Band{i}", (HX, HY, z), m=MT("FH_Copper"), major_radius=r, minor_radius=0.05,
         major_segments=48, minor_segments=8)
# stone arch trim around the mouth
tube("Hearth_ArchTrim", [(x, 1.02, z) for x, z in arch_outline(1.55, 0.95, z0=0.45, n=24)[1:]]
     + [(-0.775, 1.02, 0.45)], 0.1, m=MT("FH_BlockStone"))
# fire inside
prim("cube", "Fire_Bed", (HX, 1.95, 0.72), (1.25, 1.0, 0.3), m=MT("FH_Coals"))
for i in range(9):
    x = -0.45 + 0.11 * i + rng.uniform(-0.03, 0.03)
    h = rng.uniform(0.55, 1.15)
    prim("cone", f"Fire_Flame{i}", (HX + x, 1.75 + rng.uniform(0, 0.4), 0.87 + h / 2), m=MT("FH_Fire"),
         radius1=rng.uniform(0.1, 0.17), radius2=0.0, depth=h, vertices=8, smooth=True)
prim("cube", "Fire_Back", (HX, 2.55, 1.3), (1.3, 0.05, 1.5), m=MT("FH_Fire"))
# emblem above the mouth
prim("cyl", "Hearth_Emblem", (HX, 1.02, 2.6), rot=(90, 0, 0), m=MT("FH_Gold"), radius=0.36, depth=0.08, vertices=48)
prim("torus", "Hearth_EmblemRim", (HX, 0.98, 2.6), rot=(90, 0, 0), m=MT("FH_Copper"), major_radius=0.37,
     minor_radius=0.035, major_segments=48, minor_segments=8)
text("Hearth_EmblemSigil", "⚒", "sym", 0.45, (HX, 0.965, 2.58), m=MT("FH_Iron"), extrude=0.015)

# ================= pipes =================
prim("cyl", "Chimney", (HX, HY, 8.0), m=MT("FH_Copper"), radius=0.45, depth=8.0, vertices=32, smooth=True)
for i, z in enumerate((4.25, 5.6, 7.4, 9.2, 11.0)):
    prim("torus", f"Chimney_Ring{i}", (HX, HY, z), m=MT("FH_Iron"), major_radius=0.47,
         minor_radius=0.06, major_segments=32, minor_segments=8)
prim("cyl", "Chimney_Emblem", (HX, HY - 0.47, 6.6), rot=(90, 0, 0), m=MT("FH_Gold"), radius=0.33, depth=0.06, vertices=32)
text("Chimney_EmblemSigil", "☀", "sym", 0.42, (HX, HY - 0.51, 6.6), m=MT("FH_Iron"), extrude=0.01)
for s in (-1, 1):
    tube(f"Pipe_Upper_{s}", [(s * 0.4, HY, 8.2), (s * 1.3, HY, 8.2), (s * 1.3, HY, 5.3)], 0.2,
         m=MT("FH_Copper"), elbow=0.5)
    tube(f"Pipe_Outer_{s}", [(s * 0.4, HY + 0.3, 7.0), (s * 2.2, HY + 0.3, 7.0), (s * 2.2, HY + 0.3, 5.3)], 0.17,
         m=MT("FH_Copper"), elbow=0.45)
    tube(f"Pipe_Lower_{s}", [(s * 1.95, HY - 0.2, 4.6), (s * 1.95, HY - 0.2, 3.0), (s * 1.3, HY - 0.2, 2.2)],
         0.16, m=MT("FH_Copper"), elbow=0.45)
    for j, (x, y, z) in enumerate(((s * 1.3, HY, 5.4), (s * 1.95, HY - 0.2, 4.4), (s * 2.2, HY + 0.3, 5.4))):
        prim("torus", f"Pipe_Flange_{s}_{j}", (x, y, z), m=MT("FH_Iron"), major_radius=0.22,
             minor_radius=0.05, major_segments=24, minor_segments=6)

# ================= lintel with emblems =================
prim("cube", "Lintel", (0, 1.6, 4.9), (9.8, 0.9, 0.8), m=MT("FH_MarbleWarm"), bevel=0.02)
prim("cube", "Lintel_Cornice", (0, 1.55, 5.38), (10.0, 1.05, 0.16), m=MT("FH_MarbleWarm"), bevel=0.02)
for i, z in enumerate((4.54, 5.26)):
    prim("cube", f"Lintel_GoldBand{i}", (0, 1.14, z), (9.8, 0.03, 0.06), m=MT("FH_Gold"))
for x, g in zip((-1.6, -0.8, 0.0, 0.8, 1.6), "⚡🔱☤🦉⚒"):
    text(f"Lintel_Emblem_{g}", g, "sym", 0.52, (x, 1.12, 4.9), m=MT("FH_GoldGlow"), extrude=0.03)
for x in (-3.3, -2.5, 2.5, 3.3):
    text(f"Lintel_Knot_{x}", "⌘", "sym", 0.5, (x, 1.12, 4.9), m=MT("FH_Gold"), extrude=0.02)

# ================= marble columns (Olympus) =================
def column(name, x, y, h=4.5, r=0.32):
    e = empty(name, (x, y, 0))
    prim("cube", f"{name}_Plinth", (0, 0, 0.14), (r * 2.8, r * 2.8, 0.28), m=MT("FH_Marble"), bevel=0.015, parent=e)
    for i, (z, rr) in enumerate(((0.33, r * 1.2), (0.46, r * 1.08))):
        prim("torus", f"{name}_Base{i}", (0, 0, z), m=MT("FH_Marble"), major_radius=rr,
             minor_radius=0.06, major_segments=32, minor_segments=8, parent=e)
    sh = prim("cyl", f"{name}_Shaft", (0, 0, 0.3 + (h - 0.85) / 2), m=MT("FH_Marble"), radius=r,
              depth=h - 0.85, vertices=24, parent=e)
    sh.modifiers.new("Bevel", "BEVEL").width = 0.012
    prim("torus", f"{name}_Neck", (0, 0, h - 0.56), m=MT("FH_Gold"), major_radius=r * 1.02,
         minor_radius=0.03, major_segments=32, minor_segments=6, parent=e)
    prim("cone", f"{name}_Capital", (0, 0, h - 0.36), m=MT("FH_Marble"), radius1=r * 1.02,
         radius2=r * 1.55, depth=0.36, vertices=24, parent=e)
    for k in range(8):  # acanthus scrolls, gilded
        a = 2 * math.pi * k / 8
        prim("ico", f"{name}_Leaf{k}", (math.cos(a) * r * 1.3, math.sin(a) * r * 1.3, h - 0.3),
             (0.6, 0.6, 1.1), m=MT("FH_Gold"), radius=0.09, subdivisions=2, parent=e, smooth=True)
    prim("cube", f"{name}_Abacus", (0, 0, h - 0.08), (r * 3.4, r * 3.4, 0.16), m=MT("FH_Marble"),
         bevel=0.015, parent=e)
    return e

for x in (-2.8, 2.8):
    column(f"Col_Center_{x}", x, 1.6)
for i, y in enumerate((-4.4, -1.4, 1.6)):
    column(f"Col_Left_{i}", -4.8, y)
prim("cube", "Architrave_Left", (-4.8, -1.7, 4.9), (0.95, 7.8, 0.8), m=MT("FH_MarbleWarm"), bevel=0.02)
prim("cube", "Architrave_LeftCornice", (-4.8, -1.7, 5.38), (1.1, 8.0, 0.16), m=MT("FH_MarbleWarm"), bevel=0.02)
for i, z in enumerate((4.54, 5.26)):
    prim("cube", f"Architrave_GoldBand{i}", (-4.31, -1.7, z), (0.03, 7.8, 0.06), m=MT("FH_Gold"))
text("Architrave_Meander", "⌘ ☤ ⌘ ⚡ ⌘ 🔱 ⌘", "sym", 0.38, (-4.29, -1.7, 4.9), rot=(90, 0, 90),
     m=MT("FH_Gold"), extrude=0.015, spacing=1.3)

# ================= rock mountain + lava =================
rock("Rock_BackCenter", (0, 4.6, 2.2), (4.2, 1.6, 3.2), MT("FH_Rock"), strength=0.8)
rock("Rock_BackL", (-2.3, 3.5, 1.4), (1.2, 1.1, 2.2), MT("FH_Rock"), strength=0.5)
rock("Rock_BackR", (2.3, 3.5, 1.4), (1.2, 1.1, 2.2), MT("FH_Rock"), strength=0.5)
rock("Rock_Peak", (0.3, 6.5, 6.2), (4.8, 2.8, 4.0), MT("FH_Rock"), strength=1.2, noise=1.4)
rock("Rock_PeakL", (-3.2, 7.5, 5.0), (2.6, 2.2, 3.0), MT("FH_Rock"), strength=0.9, noise=1.4)
rock("Rock_PeakR", (3.4, 7.2, 5.4), (2.8, 2.2, 3.4), MT("FH_Rock"), strength=0.9, noise=1.4)
for s in (-1, 1):
    for k in range(4):
        x0, z0 = s * rng.uniform(1.6, 2.3), rng.uniform(0.2, 1.2)
        pts = [(x0, 2.95 - 0.1 * k, z0)]
        for _ in range(5):
            x, y, z = pts[-1]
            pts.append((x + s * rng.uniform(0.0, 0.25), y + rng.uniform(-0.05, 0.05), z + rng.uniform(0.2, 0.45)))
        tube(f"Lava_{s}_{k}", pts, 0.022, m=MT("FH_LavaCrack"))

# ================= Norse wall (right) =================
NW = "FH_NorseWood"
for i, y in enumerate((-4.4, -0.6, 1.9)):
    prim("cube", f"Norse_Post{i}", (4.85, y, 2.3), (0.45, 0.45, 4.6), m=MT(NW), bevel=0.03)
    text(f"Norse_PostRunes{i}", "\n".join(RUNES[i * 5:i * 5 + 5]), "rune", 0.28, (4.61, y, 2.2),
         rot=(90, 0, -90), m=MT("FH_Bronze"), extrude=0.01)
prim("cube", "Norse_Header", (4.85, -1.3, 4.85), (0.5, 7.4, 0.7), m=MT(NW), bevel=0.03)
text("Norse_HeaderRunes", RUNES[:18], "rune", 0.34, (4.58, -1.3, 4.85), rot=(90, 0, -90),
     m=MT("FH_Bronze"), extrude=0.012, spacing=1.4)
prim("cube", "Norse_Planks", (4.95, -2.5, 2.3), (0.2, 3.4, 4.6), m=MT("FH_Planks"))
# carved arch opening
arch = [(4.85, y, z) for y, z in
        [(-0.6 + 1.25 + x, z) for x, z in arch_outline(2.5, 2.3, z0=0.0, n=24)[1:]]] + [(4.85, -0.6, 0.0)]
tube("Norse_Arch", arch, 0.2, m=MT(NW))
for k in range(1, 12):
    a = math.pi * k / 12
    y, z = 0.65 + 1.25 * math.cos(a), 2.3 + 1.25 * math.sin(a)
    g = text(f"Norse_ArchRune{k}", RUNES[(k * 3) % len(RUNES)], "rune", 0.22, (0, 0, 0),
             m=MT("FH_Bronze"), extrude=0.01)
    orient(g, (0, math.sin(a), -math.cos(a)), (-1, 0, 0), (4.62, y, z))
# roof rafters (top-right)
for i, y in enumerate((-4.4, -2.0, 0.4)):
    tube(f"Norse_Rafter{i}", [(5.2, y, 4.9), (2.6, y + 0.6, 7.6)], 0.16, m=MT(NW))
print("arch done:", len(_col().all_objects))
