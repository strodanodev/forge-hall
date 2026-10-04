"""p18c: cinematic material pass (Cycles; everything here bakes into the web atlases or the live-PBR maps).

- MXI_Hearth: sooty firebrick from the Meshy albedo, ash-grey mortar, gold bands kept, mortar seams glowing with heat
  around the mouth (emission), soot climbing the dome
- anvils: dark forged steel, polished working faces, bright worn edges
- FH_Iron blackened iron with edge wear, FH_Copper tarnished copper, FH_Gold / FH_Bronze worn with dirt in the recesses,
  FH_Plaque dark slate
- floor + dais: soot fanning out from the hearth mouth
Rebuilds the node trees from their image textures, so it can be re-run.
"""
import bpy

MOUTH = (0.0, 0.75, 1.15)   # world-space centre of the hearth mouth


class G:
    """Tiny node-graph helper."""

    def __init__(self, mat):
        self.m, self.nt = mat, mat.node_tree
        self.x = -1400

    def n(self, kind, **kw):
        node = self.nt.nodes.new(kind)
        for k, v in kw.items():
            if k in ("operation", "blend_type", "data_type", "feature", "interpolation_type", "clamp_factor", "label",
                     "name", "noise_dimensions", "falloff", "samples", "only_local", "inside"):
                setattr(node, k, v)
            else:
                node.inputs[k].default_value = v
        self.x += 40
        node.location = (self.x, 0)
        return node

    def l(self, a, b):
        self.nt.links.new(a, b)

    def math(self, op, a, b=None, clamp=False):
        node = self.n("ShaderNodeMath", operation=op)
        node.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                node.inputs[i].default_value = v
            else:
                self.l(v, node.inputs[i])
        return node.outputs[0]

    def smooth(self, v, lo, hi):
        mr = self.n("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
        mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = lo, hi
        self.l(v, mr.inputs["Value"])
        return mr.outputs["Result"]

    def mix(self, fac, a, b, kind="RGBA", blend="MIX"):
        mx = self.n("ShaderNodeMix", data_type=kind, blend_type=blend)
        for sock, v in (("Factor", fac), ("A", a), ("B", b)):
            s = mx.inputs[sock] if kind == "RGBA" or sock == "Factor" else \
                next(i for i in mx.inputs if i.name == sock and i.type == "VALUE")
            if kind == "RGBA" and sock in ("A", "B"):
                s = next(i for i in mx.inputs if i.name == sock and i.type == "RGBA")
            if isinstance(v, (int, float)):
                s.default_value = v
            elif isinstance(v, tuple):
                s.default_value = (*v, 1.0) if len(v) == 3 else v
            else:
                self.l(v, s)
        out = next(o for o in mx.outputs if o.type == ("RGBA" if kind == "RGBA" else "VALUE"))
        return out

    def ramp(self, v, stops):
        r = self.n("ShaderNodeValToRGB")
        el = r.color_ramp.elements
        while len(el) < len(stops):
            el.new(0.5)
        for e, (p, c) in zip(el, stops):
            e.position, e.color = p, (*c, 1.0)
        self.l(v, r.inputs["Fac"])
        return r.outputs["Color"]

    def noise(self, scale, detail=6.0, coord="Object", rough=0.55):
        tc = self.n("ShaderNodeTexCoord")
        nz = self.n("ShaderNodeTexNoise", Scale=scale, Detail=detail, Roughness=rough)
        self.l(tc.outputs[coord], nz.inputs["Vector"])
        return nz.outputs["Fac"]


def bsdf(m):
    return next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def strip(m, keep=("TEX_IMAGE", "NORMAL_MAP", "OUTPUT_MATERIAL", "BSDF_PRINCIPLED")):
    """Drop every node except textures/normal map/BSDF/output; reset BSDF inputs that were linked."""
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in keep:
            nt.nodes.remove(n)
    b = bsdf(m)
    for i in b.inputs:
        for lk in list(i.links):
            if lk.from_node.type != "NORMAL_MAP":
                nt.links.remove(lk)
    return nt


def tex(m, socket):
    """The Meshy image node that originally fed `socket` (tagged on first run so re-runs still find it)."""
    for n in m.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.get("feeds") == socket:
            return n
    for n in m.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.outputs[0].links and n.outputs[0].links[0].to_socket.name == socket:
            n["feeds"] = socket
            return n
    return None


# ------------------------------------------------------------------ hearth
def hearth():
    m = bpy.data.materials["Material_0"]
    tex(m, "Base Color"); tex(m, "Color")  # tag before strip removes the separate node
    strip(m)
    g, b = G(m), bsdf(m)
    col, orm = tex(m, "Base Color"), tex(m, "Color")
    sep = g.n("ShaderNodeSeparateColor")
    g.l(orm.outputs["Color"], sep.inputs["Color"])
    lum = g.n("ShaderNodeRGBToBW")
    g.l(col.outputs["Color"], lum.inputs["Color"])
    gold = g.smooth(sep.outputs["Blue"], 0.35, 0.65)               # Meshy metallic = the gold bands
    mortar = g.smooth(lum.outputs["Val"], 0.055, 0.1)                # mortar: the light grey between bricks (linear lum)
    # firebrick: red-brown, varied per brick by a coarse noise, near-black where soot settles
    var = g.noise(2.2, 3.0)
    brick = g.ramp(var, [(0.3, (0.035, 0.018, 0.012)), (0.7, (0.08, 0.036, 0.022))])
    ash = (0.11, 0.095, 0.085)
    base = g.mix(mortar, brick, ash)
    pos = g.n("ShaderNodeNewGeometry").outputs["Position"]
    sxyz = g.n("ShaderNodeSeparateXYZ")
    g.l(pos, sxyz.inputs["Vector"])
    soot = g.math("MULTIPLY", g.smooth(sxyz.outputs["Z"], 1.2, 3.4), 0.85)
    soot = g.math("ADD", soot, g.math("MULTIPLY", g.noise(3.5, 8.0), 0.25), clamp=True)
    base = g.mix(soot, base, (0.012, 0.01, 0.009))
    base = g.mix(gold, base, col.outputs["Color"])
    g.l(base, b.inputs["Base Color"])
    g.l(g.math("MULTIPLY", gold, 1.0), b.inputs["Metallic"])
    rough = g.mix(gold, 0.88, 0.32, kind="FLOAT")
    g.l(rough, b.inputs["Roughness"])
    # heat: mortar seams glow around the mouth, hottest at the arch
    mouth = g.n("ShaderNodeVectorMath", operation="DISTANCE")
    mouth.inputs[1].default_value = MOUTH
    g.l(pos, mouth.inputs[0])
    heat = g.math("SUBTRACT", 1.0, g.smooth(mouth.outputs["Value"], 0.7, 1.45))
    flick = g.smooth(g.noise(6.0, 4.0), 0.35, 0.7)
    rim = g.math("POWER", heat, 4.0)                                    # the arch stones themselves, right at the mouth
    seam = g.math("ADD", g.math("MULTIPLY", heat, mortar), g.math("MULTIPLY", rim, 0.25))
    glow = g.math("MULTIPLY", seam, g.math("ADD", 0.45, flick))
    glow = g.math("MULTIPLY", glow, g.math("SUBTRACT", 1.0, gold))
    b.inputs["Emission Color"].default_value = (1.0, 0.28, 0.05, 1)
    g.l(g.math("MULTIPLY", glow, 4.0), b.inputs["Emission Strength"])


# ------------------------------------------------------------------ anvils
def anvils():
    m = bpy.data.materials["Material_0.001"]
    tex(m, "Base Color")
    strip(m)
    g, b = G(m), bsdf(m)
    col = tex(m, "Base Color")
    lum = g.n("ShaderNodeRGBToBW")
    g.l(col.outputs["Color"], lum.inputs["Color"])
    steel = g.ramp(lum.outputs["Val"], [(0.15, (0.035, 0.034, 0.036)), (0.6, (0.13, 0.125, 0.13))])
    geo = g.n("ShaderNodeNewGeometry")
    nz = g.n("ShaderNodeSeparateXYZ")
    g.l(geo.outputs["Normal"], nz.inputs["Vector"])
    # Meshy's metallic channel (ORM blue) separates the iron anvil (~0.5) from its granite base block (0)
    orm = next(n for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.get("feeds") != "Base Color"
               and not any(lk.to_node.type == "NORMAL_MAP" for lk in n.outputs[0].links))
    sep = g.n("ShaderNodeSeparateColor")
    g.l(orm.outputs["Color"], sep.inputs["Color"])
    metal = g.smooth(sep.outputs["Blue"], 0.3, 0.45)
    face = g.math("MULTIPLY", g.smooth(nz.outputs["Z"], 0.86, 0.97), metal)  # the polished working face
    edge = g.smooth(geo.outputs["Pointiness"], 0.52, 0.6)              # worn bright edges
    base = g.mix(edge, steel, (0.32, 0.31, 0.3))
    base = g.mix(face, base, (0.6, 0.6, 0.62))
    granite = g.mix(0.6, col.outputs["Color"], (0.0, 0.0, 0.0))         # the block it stands on, darkened by soot
    g.l(g.mix(metal, granite, base), b.inputs["Base Color"])
    g.l(metal, b.inputs["Metallic"])
    scratch = g.math("MULTIPLY", g.noise(140.0, 2.0), 0.12)
    r_body = g.math("ADD", 0.42, g.math("MULTIPLY", g.noise(6.0, 8.0), 0.22))
    r_face = g.math("ADD", 0.12, scratch)
    g.l(g.mix(metal, 0.82, g.mix(face, r_body, r_face, kind="FLOAT"), kind="FLOAT"), b.inputs["Roughness"])


# ------------------------------------------------------------------ flat FH_* metals
def iron():
    m = bpy.data.materials["FH_Iron"]
    strip(m)
    g, b = G(m), bsdf(m)
    edge = g.smooth(g.n("ShaderNodeNewGeometry").outputs["Pointiness"], 0.57, 0.68)
    base = g.ramp(g.noise(9.0, 8.0), [(0.3, (0.025, 0.023, 0.022)), (0.75, (0.06, 0.053, 0.048))])
    g.l(g.mix(g.math("MULTIPLY", edge, 0.7), base, (0.22, 0.21, 0.2)), b.inputs["Base Color"])
    b.inputs["Metallic"].default_value = 1.0
    g.l(g.math("ADD", 0.4, g.math("MULTIPLY", g.noise(14.0, 6.0), 0.3)), b.inputs["Roughness"])


def copper():
    m = bpy.data.materials["FH_Copper"]
    strip(m)
    g, b = G(m), bsdf(m)
    tarn = g.smooth(g.noise(2.5, 8.0), 0.4, 0.75)
    base = g.mix(g.math("MULTIPLY", tarn, 0.75), (0.95, 0.6, 0.45), (0.42, 0.19, 0.1))
    # dark grime where pipes meet flanges/rings, picked out by AO
    ao = g.n("ShaderNodeAmbientOcclusion", Distance=0.12)
    dirt = g.math("SUBTRACT", 1.0, g.smooth(ao.outputs["AO"], 0.3, 0.9))
    base = g.mix(g.math("MULTIPLY", dirt, 0.8), base, (0.1, 0.05, 0.03))
    g.l(base, b.inputs["Base Color"])
    b.inputs["Metallic"].default_value = 1.0
    g.l(g.math("ADD", 0.2, g.math("MULTIPLY", tarn, 0.25)), b.inputs["Roughness"])


def worn_metal(name, col, dark, r0, r1):
    m = bpy.data.materials[name]
    strip(m)
    g, b = G(m), bsdf(m)
    ao = g.n("ShaderNodeAmbientOcclusion", Distance=0.06)
    cav = g.smooth(ao.outputs["AO"], 0.35, 0.95)
    g.l(g.mix(cav, dark, col), b.inputs["Base Color"])
    b.inputs["Metallic"].default_value = 1.0
    r = g.math("ADD", r0, g.math("MULTIPLY", g.noise(18.0, 6.0), r1 - r0))
    g.l(g.mix(cav, 0.55, r, kind="FLOAT"), b.inputs["Roughness"])


def plaque():
    m = bpy.data.materials["FH_Plaque"]
    strip(m)
    g, b = G(m), bsdf(m)
    grain = g.noise(45.0, 10.0, rough=0.65)
    g.l(g.ramp(grain, [(0.3, (0.018, 0.017, 0.02)), (0.7, (0.05, 0.047, 0.052))]), b.inputs["Base Color"])
    g.l(g.math("ADD", 0.45, g.math("MULTIPLY", grain, 0.3)), b.inputs["Roughness"])
    bump = g.n("ShaderNodeBump", Strength=0.15, Distance=0.002)
    g.l(grain, bump.inputs["Height"])
    g.l(bump.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Metallic"].default_value = 0.0


# ------------------------------------------------------------------ soot on the floor and dais
def soot(name):
    m = bpy.data.materials[name]
    nt = m.node_tree
    b = bsdf(m)
    if "p18_soot" in nt.nodes:  # re-run: take the original colour from the old soot mix, then drop its nodes
        old = nt.nodes["p18_soot"]
        src = next(i for i in old.inputs if i.name == "A" and i.type == "RGBA").links[0].from_socket
        for n in [n for n in nt.nodes if n.get("p18")]:
            nt.nodes.remove(n)
    else:
        src = b.inputs["Base Color"].links[0].from_socket
    pre = set(nt.nodes)
    g = G(m)
    pos = g.n("ShaderNodeNewGeometry").outputs["Position"]
    d = g.n("ShaderNodeVectorMath", operation="DISTANCE")
    d.inputs[1].default_value = (MOUTH[0], MOUTH[1] - 0.3, 0.0)
    g.l(pos, d.inputs[0])
    fall = g.math("SUBTRACT", 1.0, g.smooth(d.outputs["Value"], 0.8, 3.4))
    brk = g.smooth(g.noise(1.6, 8.0), 0.3, 0.7)
    amt = g.math("MULTIPLY", fall, g.math("ADD", 0.55, g.math("MULTIPLY", brk, 0.45)), clamp=True)
    amt = g.math("MULTIPLY", amt, 0.72)
    mx = g.n("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY", name="p18_soot")
    g.l(amt, mx.inputs["Factor"])
    g.l(src, next(i for i in mx.inputs if i.name == "A" and i.type == "RGBA"))
    next(i for i in mx.inputs if i.name == "B" and i.type == "RGBA").default_value = (0.09, 0.075, 0.065, 1)
    g.l(next(o for o in mx.outputs if o.type == "RGBA"), b.inputs["Base Color"])
    for n in set(nt.nodes) - pre:  # tag what this pass added, so a re-run can remove it
        n["p18"] = True


def apply():
    hearth()
    anvils()
    iron()
    copper()
    worn_metal("FH_Gold", (1.0, 0.7, 0.3), (0.28, 0.16, 0.06), 0.18, 0.34)
    worn_metal("FH_Bronze", (0.62, 0.4, 0.2), (0.12, 0.07, 0.035), 0.3, 0.5)
    plaque()
    for n in ("FH_FloorSlab", "FH_BlockStone"):
        soot(n)
    print("p18c materials applied")


if __name__ == "__main__":
    apply()
