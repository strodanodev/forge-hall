// FORGE — the Rapture ARC 1 collection as pack contents (PREVIEW: nothing is minted or read from a wallet).
// Data is the snapshot scripts/rapture_snapshot.mjs takes from the chain (web/assets/rapture/cards.json): every card's
// on-chain traits and stats, its Studio painting, and its avatar/soul checked against the token's own hashes.
import * as THREE from "three";

// Rapture has no rarity: Kind is the only tier. The pack's rarity ladder (odds, frame colour, flip FX) follows it.
export const KIND_TIER = { Mortal: "common", King: "rare", Demigod: "epic", God: "legendary", Titan: "legendary" };
import { RANK, RARITY } from "./tiers.js";
export { RANK, RARITY };
// Per-slot Kind odds, mirroring the PackShop's draw (packshop/README.md: a Kind by weight, uniform within it, duplicates
// allowed): a free preview must pull the way a bought pack does. A live shop's own weights (shop.info.weights, in this
// order) replace these defaults.
export const KIND_ORDER = ["Mortal", "King", "Demigod", "Titan", "God"];
export const KIND_ODDS = { Mortal: 30, King: 25, Demigod: 20, Titan: 15, God: 10 };
// neon = element (Art Direction); gold stays divinity-only, so it never colours an element
export const ELEMENT = { Water: "#22E4FF", Lava: "#FF2E88", Earth: "#3DFFA2", Metal: "#B9A7FF" };
export const PACK_SIZE = 5;
// GILDED: a look-dev mockup of a cosmetic finish (gold filigree corners, gold-leaf flecks, a moving shimmer) that does
// not exist on chain yet. It is never rolled in a pull, so the preview shows nothing a bought pack cannot have;
// ?gilded=all forces it for look-dev. The gold FRAME stays the legendary signal either way.
const GILDED = new URLSearchParams(globalThis.location?.search ?? "").get("gilded") === "all";

/** Load the snapshot and shape each card for the pack (rarity/title/side are what the sequence and NPC read). */
export async function loadCollection(url = "./assets/rapture/cards.json") {
  const snap = await (await fetch(url)).json();
  const base = BigInt(snap.collection.setId) << 32n;
  const range = {};
  for (const k of ["str", "agi", "res", "int"]) {
    const v = snap.cards.map((c) => c.stats[k]);
    range[k] = [Math.min(...v), Math.max(...v)];
  }
  const cards = snap.cards.map((c) => ({
    ...c,
    rarity: KIND_TIER[c.kind],
    title: c.epithet,
    side: c.kind,
    serial: Number(BigInt(c.tokenId) - base),           // position in the set (token id = setId << 32 | serial)
  }));
  return { ...snap.collection, cards, range };
}

/** Five cards drawn the way the shop draws them: a Kind by weight, then any card of that Kind, duplicates allowed. */
export function rollPack(collection, weights = null) {
  const odds = Array.isArray(weights) && weights.length === KIND_ORDER.length
    ? Object.fromEntries(KIND_ORDER.map((k, i) => [k, Number(weights[i]) || 0])) : KIND_ODDS;
  const pools = Object.fromEntries(KIND_ORDER.map((k) => [k, collection.cards.filter((c) => c.kind === k)]));
  const kinds = KIND_ORDER.filter((k) => odds[k] > 0 && pools[k].length);
  const total = kinds.reduce((n, k) => n + odds[k], 0);
  const pickKind = () => {
    let x = Math.random() * total;
    for (const k of kinds) if ((x -= odds[k]) < 0) return k;
    return kinds[kinds.length - 1];
  };
  const cards = Array.from({ length: PACK_SIZE }, () => { const p = pools[pickKind()]; return p[Math.floor(Math.random() * p.length)]; });
  // crescendo: best card flips last
  return cards.map((c) => ({ ...c, gilded: GILDED })).sort((a, b) => RANK[a.rarity] - RANK[b.rarity]);
}

// ------------------------------------------------------------------ card face
// Follows the Studio's own card face (the token `image`): full-bleed art in a device bezel, Kind · Path pill and
// faction sigil on top, name / epithet / traits over the art's foot, set line at the bottom. No stats: the art leads.
// Layout units are the Studio's 1000 x 1400 card; the canvas is drawn at SCALE of that.
const W = 1000, H = 1400, SCALE = 0.8;
const INNER = { x: 40, y: 40, w: 920, h: 1320, r: 44 };
// One bezel for every card: the Studio's default slate (top-left, body, bottom-right glint). The Studio tints it per
// Frame trait, but side by side in a fan that reads as inconsistent, so Frame lives in the trait line instead.
const BEZEL = ["#4b4955", "#2f303b", "#8e8c98"];
// Legendary cards (God, Titan) wear a gold bezel instead: a metallic ramp, so it reads as gold leaf, not flat yellow.
// Gold stays a tier signal: no other card gets it (a bonus cosmetic would need its own finish, not this frame).
const GOLD = [[0, "#fbe8a6"], [0.12, "#c9952f"], [0.38, "#8a5f17"], [0.55, "#d9a93f"], [0.8, "#7c5414"], [1, "#ffe7a0"]];
const SANS = `"Segoe UI", "Inter", system-ui, sans-serif`;

const images = new Map();
// fetch + createImageBitmap: img.decode() can reject under load (several paintings decoding while the pack video
// plays), and a cached failure left the card blank. One retry; failures are never cached.
function image(url) {
  if (!images.has(url)) {
    const load = () => fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status)))).then((b) => createImageBitmap(b));
    const p = load().catch(() => new Promise((r) => setTimeout(r, 300)).then(load)).catch(() => { images.delete(url); return null; });
    images.set(url, p);
  }
  return images.get(url);
}
/** Start decoding a pack's paintings early (at pack start), so faces draw without waiting on the network. */
export const preloadArt = (cards) => cards.forEach((c) => image(c.art));

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
// largest font size (down to min) at which text fits maxW
function fit(g, text, font, size, min, maxW) {
  for (let s = size; s >= min; s--) { g.font = font(s); if (g.measureText(text).width <= maxW) return s; }
  return min;
}
// the render's void colour: mean of its bottom rows, so the art can dissolve into it below the painting
function voidColour(img) {
  const c = document.createElement("canvas"); c.width = 16; c.height = 1;
  const g = c.getContext("2d");
  g.drawImage(img, 0, img.height - 10, img.width, 10, 0, 0, 16, 1);
  const d = g.getImageData(0, 0, 16, 1).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4, k = 0.8; // a touch darker than the edge, for the text to sit on
  return [r / n * k, gg / n * k, b / n * k].map(Math.round);
}
// faction sigils as the Studio draws them: Alliance = eight-point star in a ring, Horde = open triangle with an eye
function sigil(g, faction, x, y) {
  g.save();
  g.fillStyle = "rgba(12,13,18,.85)"; g.beginPath(); g.arc(x, y, 40, 0, Math.PI * 2); g.fill();
  g.translate(x, y); g.fillStyle = g.strokeStyle = "#f1f2f6"; g.lineWidth = 3; g.lineCap = "round";
  if (faction === "Horde") {
    g.beginPath();
    g.moveTo(0, -27); g.lineTo(0, -19);                     // apex stem
    g.moveTo(0, -19); g.lineTo(-19, 24);                     // legs run past the base
    g.moveTo(0, -19); g.lineTo(19, 24);
    g.moveTo(-16, 16); g.lineTo(16, 16);                     // base
    g.stroke();
    g.beginPath(); g.arc(0, 5, 5.5, 0, Math.PI * 2); g.fill();
  } else {
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8 - Math.PI / 2, rad = i % 2 ? 7.5 : 19;
      g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    g.closePath(); g.fill();
    g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

export async function drawFace(card) {
  const R = RARITY[card.rarity], el = ELEMENT[card.element] ?? "#ffd37a";
  const c = document.createElement("canvas"); c.width = Math.round(W * SCALE); c.height = Math.round(H * SCALE);
  const g = c.getContext("2d");
  g.scale(SCALE, SCALE);
  const img = await image(card.art);
  const base = img ? voidColour(img) : [8, 9, 14], baseCss = `rgb(${base})`;

  // bezel
  const gold = card.rarity === "legendary";
  const bz = g.createLinearGradient(0, 0, W, H);
  if (gold) {
    for (const [t, col] of GOLD) bz.addColorStop(t, col);
  } else {
    const [f0, f1, f2] = BEZEL;
    bz.addColorStop(0, f0); bz.addColorStop(0.18, f1); bz.addColorStop(0.82, f1); bz.addColorStop(1, f2);
  }
  g.fillStyle = bz; g.fillRect(0, 0, W, H);

  // art: the painting (the render's top square) cover-fits the upper card, anchored on the halo, then dissolves into
  // the render's own void colour behind the text
  const { x, y, w, h, r } = INNER;
  g.save(); rr(g, x, y, w, h, r); g.clip();
  g.fillStyle = baseCss; g.fillRect(x, y, w, h);
  const artH = 1180;
  if (img) {
    const s = artH / img.height, dw = img.width * s;
    g.drawImage(img, x + (w - dw) / 2, y, dw, artH);
  }
  let gr = g.createLinearGradient(0, y + artH - 330, 0, y + artH);
  gr.addColorStop(0, `rgba(${base},0)`); gr.addColorStop(0.6, `rgba(${base},.72)`); gr.addColorStop(1, `rgba(${base},1)`);
  g.fillStyle = gr; g.fillRect(x, y + artH - 330, w, 330);
  gr = g.createLinearGradient(0, y, 0, y + 170);                  // soft top wash for the pill and sigil
  gr.addColorStop(0, "rgba(0,0,0,.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.fillRect(x, y, w, 170);
  g.restore();
  g.strokeStyle = gold ? "rgba(255,226,150,.85)" : "rgba(255,255,255,.26)"; g.lineWidth = gold ? 4 : 2.5;
  rr(g, x, y, w, h, r); g.stroke();

  // Kind · Path pill (its rim carries the pack tier)
  const pill = `${card.kind.toUpperCase()}  ·  ${card.path.toUpperCase()}`;
  g.font = `600 30px ${SANS}`;
  const pw = g.measureText(pill).width + 52;
  g.fillStyle = "rgba(10,12,18,.72)"; rr(g, 72, 72, pw, 56, 28); g.fill();
  g.strokeStyle = hexA(R.css, 0.7); g.lineWidth = 2.5; g.stroke();
  g.fillStyle = "#f4f6fb"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(pill, 98, 101);
  sigil(g, card.faction, 888, 104);

  // name, epithet, traits
  g.shadowColor = "rgba(0,0,0,.55)"; g.shadowBlur = 18;
  g.fillStyle = "#f7f4ee"; g.textBaseline = "alphabetic";
  fit(g, card.name, (s) => `700 ${s}px "Cinzel", Georgia, serif`, 84, 50, 840);
  g.fillText(card.name, 80, 1122);
  g.fillStyle = "#c9ccd8";
  fit(g, card.epithet, (s) => `italic 400 ${s}px "Cinzel", Georgia, serif`, 38, 24, 840);
  g.fillText(card.epithet, 84, 1182);
  g.shadowBlur = 0;
  const traits = [card.element, card.alignment, card.kit ? `${card.kit} kit` : null, card.frame].filter(Boolean);
  g.font = `500 32px ${SANS}`;
  let tx = 124;
  g.save(); g.shadowColor = el; g.shadowBlur = 16; g.fillStyle = el;
  g.beginPath(); g.arc(94, 1244, 13, 0, Math.PI * 2); g.fill(); g.restore();
  g.fillStyle = "#eef0f6"; g.textBaseline = "middle";
  traits.forEach((t, i) => {
    if (i) { g.fillStyle = "#9da1ae"; g.fillText("·", tx + 10, 1245); tx += 38; g.fillStyle = "#eef0f6"; }
    g.fillText(t, tx, 1245); tx += g.measureText(t).width;
  });

  if (card.gilded) gild(g, card);

  // set line
  g.font = `600 22px ${SANS}`; g.fillStyle = "#7d8190";
  const inset = card.gilded ? 34 : 0;                 // clear the filigree in the bottom corners
  g.fillText("RAPTURE  ·  ARC 1  ·  STUDIO TEST", 80 + inset, 1318);
  g.textAlign = "right"; g.fillText(`#${String(card.serial + 1).padStart(3, "0")}`, 920 - inset, 1318);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ gilded finish
function goldStroke(g, x0, y0, x1, y1) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [t, col] of GOLD) gr.addColorStop(t, col);
  return gr;
}

/** Gold-leaf flecks over the art, filigree on all four corners and a GILDED tag under the Kind pill. */
function gild(g, card) {
  const { x, y, w, h, r } = INNER;
  // flecks: deterministic per card, denser toward the edges so the face stays clear
  let seed = Number(BigInt(card.tokenId) % 2147483647n) || 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.save(); rr(g, x, y, w, h, r); g.clip();
  for (let i = 0; i < 260; i++) {
    const fx = x + rnd() * w, fy = y + rnd() * h;
    const edge = Math.min(fx - x, x + w - fx, fy - y, y + h - fy) / 260;
    if (rnd() < Math.min(0.85, edge)) continue;
    const s = 1.5 + rnd() * 4.5;
    g.fillStyle = `rgba(${235 + rnd() * 20 | 0},${185 + rnd() * 40 | 0},${90 + rnd() * 50 | 0},${0.35 + rnd() * 0.5})`;
    g.save(); g.translate(fx, fy); g.rotate(rnd() * Math.PI);
    g.fillRect(-s / 2, -s / 4, s, s / 2);            // leaf flakes are torn slivers, not dots
    g.restore();
  }
  // a warm gold inner edge to the art
  g.lineWidth = 26; g.strokeStyle = "rgba(214,160,60,.28)"; rr(g, x, y, w, h, r); g.stroke();
  g.restore();
  // filigree: one ornament, mirrored into each corner
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    g.save();
    g.translate(sx > 0 ? x + 6 : x + w - 6, sy > 0 ? y + 6 : y + h - 6);
    g.scale(sx, sy);
    filigree(g);
    g.restore();
  }
  // tag
  g.font = `700 24px ${SANS}`;
  const label = "\u2726  GILDED";
  const tw = g.measureText(label).width + 40;
  g.fillStyle = goldStroke(g, 72, 142, 72 + tw, 184); rr(g, 72, 142, tw, 42, 21); g.fill();
  g.strokeStyle = "rgba(255,240,190,.9)"; g.lineWidth = 2; g.stroke();
  g.fillStyle = "#3b2606"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(label, 92, 164);
}

/** A corner ornament in local space (corner at the origin, arms along +x and +y). */
function filigree(g) {
  g.strokeStyle = goldStroke(g, 0, 0, 170, 170);
  g.fillStyle = goldStroke(g, 0, 0, 60, 60);
  g.lineCap = "round"; g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 6;
  // double rail along both edges
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(0, 150); g.lineTo(0, 24); g.quadraticCurveTo(0, 0, 24, 0); g.lineTo(150, 0); g.stroke();
  g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(14, 118); g.lineTo(14, 30); g.quadraticCurveTo(14, 14, 30, 14); g.lineTo(118, 14); g.stroke();
  // scrolls curling off each rail
  for (const flip of [false, true]) {
    g.save(); if (flip) { g.rotate(Math.PI / 2); g.scale(1, -1); }
    g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(150, 0); g.bezierCurveTo(172, 4, 176, 26, 158, 30); g.bezierCurveTo(146, 32, 142, 20, 152, 16); g.stroke();
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(52, 14); g.bezierCurveTo(64, 34, 92, 34, 96, 22); g.stroke();
    g.restore();
  }
  // a gem where the rails meet
  g.beginPath(); g.moveTo(34, 20); g.lineTo(48, 34); g.lineTo(34, 48); g.lineTo(20, 34); g.closePath(); g.fill();
  g.fillStyle = "rgba(255,248,215,.9)";
  g.beginPath(); g.arc(31, 31, 3.5, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
