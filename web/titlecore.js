// FORGE — the title screen's pure parts (no three.js, no DOM): the told prologue, tweens, emblem placement and the 2D
// outline work behind the 3D emblem. title.js renders with them; web/test/title.test.mjs tests them under Node.

// One line per strike. *word* is set in gold. `cue` drives the emblem (TitleScreen.cue in title.js).
export const BEATS = [
  { n: "I", text: "Before the chain, there was only *fire*.", cue: "mold" },
  { n: "II", text: "*Mortals*, *Kings*, *Demigods*, *Gods*: every soul was cast in the same flame.", cue: "pour" },
  { n: "III", text: "Then the *Titans* broke the anvil, and fifty souls scattered into the dark.", cue: "shatter" },
  { n: "IV", text: "*Alliance* and *Horde* hunt them still. They call it the *Rapture*.", cue: "cool" },
  { n: "V", text: "One forge still burns, on *LitVM*. Its keeper is waiting.", cue: "kindle" },
];
export const CUES = ["mold", "pour", "shatter", "cool", "kindle"];

/** A story line as per-character spans (typed out one by one); *word* becomes a gold emphasis span. */
export function markup(text) {
  const esc = (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c;
  return text.split(/(\*[^*]+\*)/).filter(Boolean).map((part) => {
    const em = part.length > 2 && part.startsWith("*") && part.endsWith("*");
    const chars = [...(em ? part.slice(1, -1) : part)].map((c) => `<span class="c">${esc(c)}</span>`).join("");
    return em ? `<span class="em">${chars}</span>` : chars;
  }).join("");
}

// ------------------------------------------------------------------ tweens
export const EASE = { linear: (k) => k, out: (k) => 1 - (1 - k) ** 3, in: (k) => k ** 3, inOut: (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2) };
export const lerp = (a, b, k) => a + (b - a) * k;

/** Numeric property tweens; a new tween on the same property replaces the running one. */
export class Tweens {
  constructor() { this.list = []; }
  to(obj, key, value, dur, ease = "out") {
    this.list = this.list.filter((t) => !(t.obj === obj && t.key === key));
    if (dur <= 0) obj[key] = value;
    else this.list.push({ obj, key, from: obj[key], to: value, dur, t: 0, ease: EASE[ease] });
  }
  update(dt) {
    if (!this.list.length) return;
    this.list = this.list.filter((tw) => {
      tw.t = Math.min(tw.t + dt, tw.dur);
      tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.ease(tw.t / tw.dur);
      return tw.t < tw.dur;
    });
  }
}

// ------------------------------------------------------------------ emblem placement
// [centre from the top, max height, max width] as fractions of the view, per screen shape and mode. The title card's
// wordmark (title.css: --logo-top / --logo-w) covers the emblem's lower half; the studio mark sits above it.
const PLACE = {
  story: { wide: [0.405, 0.6, 0.9], tall: [0.42, 0.56, 0.94] },
  title: { wide: [0.45, 0.6, 0.9], tall: [0.37, 0.48, 0.94] },
};

/**
 * Where the emblem goes, in world units at its plane: centre height `y` and uniform scale `s`, for a camera `dist`
 * away with a vertical `fov` (degrees). size = the emblem's own width/height (logo units).
 */
export function emblemLayout(aspect, mode, size, fov, dist) {
  const H = 2 * dist * Math.tan((fov * Math.PI) / 360), W = H * aspect;
  const [cy, hf, wf] = PLACE[mode][aspect < 1 ? "tall" : "wide"];
  return { y: H * (0.5 - cy), s: Math.min((hf * H) / size.h, (wf * W) / size.w), H, W };
}

// ------------------------------------------------------------------ 2D outlines (the vector trace is lists of [x, y])
/** Signed area: positive when the loop runs counter-clockwise (y up). */
export function loopArea(loop) {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += (loop[j][0] - loop[i][0]) * (loop[j][1] + loop[i][1]);
  return a / 2;
}

export function pointInLoop(px, py, loop) {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Even-odd nesting of non-crossing loops (how Blender and the canvas fill the trace): depth = how many loops surround
 * a loop, parent = the innermost of them (-1 at the top). Even depth = an outline, odd = a hole in its parent.
 */
export function nestLoops(loops) {
  const n = loops.length;
  const box = loops.map((l) => l.reduce((b, [x, y]) => [Math.min(b[0], x), Math.max(b[1], x), Math.min(b[2], y), Math.max(b[3], y)], [Infinity, -Infinity, Infinity, -Infinity]));
  const area = loops.map((l) => Math.abs(loopArea(l)));
  const depth = new Int32Array(n), parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const [a, b] = loops[i];
    const px = (a[0] + b[0]) / 2, py = (a[1] + b[1]) / 2; // on loop i itself, so inside exactly the loops around it
    for (let j = 0; j < n; j++) {
      const q = box[j];
      if (j === i || px < q[0] || px > q[1] || py < q[2] || py > q[3] || !pointInLoop(px, py, loops[j])) continue;
      depth[i]++;
      if (parent[i] < 0 || area[j] < area[parent[i]]) parent[i] = j;
    }
  }
  return { depth, parent };
}

/** Resample a closed outline to an even spacing, then relax it: rounds the sharp inner corners an offset would fold. */
export function relaxLoop(loop, step, passes) {
  const n = loop.length, out = [];
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = carry; d < l; d += step) out.push([a[0] + ((b[0] - a[0]) * d) / l, a[1] + ((b[1] - a[1]) * d) / l]);
    carry = (carry - l) % step;
    if (carry < 0) carry += step;
  }
  let pts = out;
  for (let k = 0; k < passes; k++) {
    pts = pts.map((p, i) => {
      const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length];
      return [p[0] * 0.5 + (a[0] + c[0]) * 0.25, p[1] * 0.5 + (a[1] + c[1]) * 0.25];
    });
  }
  return pts;
}

/** Offset a smooth closed outline along its vertex normals: d > 0 grows it, whichever way it winds. */
export function offsetLoop(loop, d) {
  const n = loop.length, s = loopArea(loop) > 0 ? 1 : -1;
  return loop.map((p, i) => {
    const a = loop[(i - 1 + n) % n], b = loop[(i + 1) % n];
    const nx = (b[1] - a[1]) * s, ny = -(b[0] - a[0]) * s, l = Math.hypot(nx, ny) || 1;
    return [p[0] + (nx / l) * d, p[1] + (ny / l) * d];
  });
}

/**
 * The badge around the art, grown from the trace's own badge outline (logo units): the plate edge, the raised rim band
 * (outer and inner edge) and the line its rivets sit on. The outline is relaxed before every inward offset: its sharp
 * inner corners (where the wings meet the body) otherwise fold the rim's inner edge over itself.
 */
export function badgeOutlines(traceOutline) {
  const plate = relaxLoop(offsetLoop(relaxLoop(traceOutline, 0.008, 24), 0.05), 0.008, 12);
  return {
    plate,
    rimOuter: offsetLoop(plate, -0.008),
    rimInner: relaxLoop(offsetLoop(plate, -0.034), 0.008, 8),
    rivets: offsetLoop(plate, -0.021),
  };
}

/** Points every `spacing` (adjusted to close evenly) along a closed outline. */
export function spaceAlong(loop, spacing) {
  const seg = [];
  let len = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push([a, b, l]);
    len += l;
  }
  const count = Math.max(1, Math.round(len / spacing)), out = [];
  for (let k = 0, si = 0, acc = 0; k < count; k++) {
    const at = (k * len) / count;
    while (si < seg.length - 1 && acc + seg[si][2] < at) acc += seg[si++][2];
    const [a, b, l] = seg[si], f = l ? (at - acc) / l : 0;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}
