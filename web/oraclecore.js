// FORGE — the Oracle's trial, pure logic (no DOM): which god the Oracle names, what each ring of the astrolabe holds,
// and when the heavens are aligned. oracle.js draws it; web/test/oracle.test.mjs tests it.
//
// The astrolabe has three rings of SLOTS glyphs: the seven classical planets + Neptune, the zodiac, Greek capitals. Each
// god has its planet, a sign that planet rules, and the initial of its Greek name. A ring is aligned when its god's glyph
// sits at the gate (the top). `turn` counts how many slots a ring has been turned clockwise; it stays a float while the
// player drags and snaps to whole slots on release.

/** Bump when the terms change: everyone who swore to an older covenant sees it (and the trial) again. */
export const COVENANT = "2026-10-05";
export const SLOTS = 8;

export const GODS = [
  { name: "Zeus", greek: "Ζεύς", planet: "♃", planetName: "Jupiter", sign: "♐", signName: "Sagittarius", letter: "Ζ" },
  { name: "Hermes", greek: "Ἑρμῆς", planet: "☿", planetName: "Mercury", sign: "♊", signName: "Gemini", letter: "Ε" },
  { name: "Aphrodite", greek: "Ἀφροδίτη", planet: "♀", planetName: "Venus", sign: "♎", signName: "Libra", letter: "Α" },
  { name: "Ares", greek: "Ἄρης", planet: "♂", planetName: "Mars", sign: "♈", signName: "Aries", letter: "Α" },
  { name: "Kronos", greek: "Κρόνος", planet: "♄", planetName: "Saturn", sign: "♑", signName: "Capricorn", letter: "Κ" },
  { name: "Helios", greek: "Ἥλιος", planet: "☉", planetName: "the Sun", sign: "♌", signName: "Leo", letter: "Η" },
  { name: "Selene", greek: "Σελήνη", planet: "☽", planetName: "the Moon", sign: "♋", signName: "Cancer", letter: "Σ" },
  { name: "Poseidon", greek: "Ποσειδῶν", planet: "♆", planetName: "Neptune", sign: "♓", signName: "Pisces", letter: "Π" },
];
export const PLANETS = ["☉", "☽", "☿", "♀", "♂", "♃", "♄", "♆"];
export const SIGNS = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
export const LETTERS = ["Α", "Β", "Γ", "Δ", "Ε", "Ζ", "Η", "Θ", "Κ", "Λ", "Μ", "Π", "Σ", "Φ", "Ψ", "Ω"];

export const mod = (a, n) => ((a % n) + n) % n;

/** Text presentation for the astrological glyphs (phones otherwise draw the zodiac as colour emoji). */
export const glyphText = (g) => (PLANETS.includes(g) || SIGNS.includes(g) ? g + "︎" : g);

function shuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A fresh trial: a god and three rings, none of them starting within one slot of aligned. */
export function makeTrial(rand = Math.random) {
  const god = GODS[Math.floor(rand() * GODS.length)];
  const withTarget = (pool, keep) =>
    shuffle([keep, ...shuffle(pool.filter((g) => g !== keep), rand).slice(0, SLOTS - 1)], rand);
  const rings = [
    { kind: "planets", label: "Ring of the planets", glyphs: shuffle([...PLANETS], rand), want: god.planet },
    { kind: "signs", label: "Ring of the zodiac", glyphs: withTarget(SIGNS, god.sign), want: god.sign },
    { kind: "letters", label: "Ring of the names", glyphs: withTarget(LETTERS, god.letter), want: god.letter },
  ].map(({ want, ...r }) => {
    const target = r.glyphs.indexOf(want);
    const solvedAt = mod(-target, SLOTS);
    return { ...r, target, turn: solvedAt + 2 + Math.floor(rand() * (SLOTS - 3)) }; // 2..SLOTS-2 slots away
  });
  return { god, rings };
}

/** Index of the glyph currently at the gate. */
export const atGate = (ring) => mod(-Math.round(ring.turn), SLOTS);
export const aligned = (ring) => atGate(ring) === ring.target;
export const solved = (trial) => trial.rings.every(aligned);

/** The whole-slot turn nearest `ring.turn` that brings glyph `j` to the gate (shortest way round). */
export function turnToGate(ring, j) {
  const want = mod(-j, SLOTS);
  const d = mod(want - ring.turn + SLOTS / 2, SLOTS) - SLOTS / 2;
  return Math.round(ring.turn + d);
}
