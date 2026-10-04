// The Oracle's trial (oraclecore.js): the puzzle must always be solvable, never start solved, and read alignment right.
import test from "node:test";
import assert from "node:assert/strict";
import { GODS, SLOTS, PLANETS, SIGNS, makeTrial, aligned, solved, atGate, turnToGate, glyphText, mod } from "../oraclecore.js";

function seeded(seed) { // mulberry32: reproducible trials
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("every trial: three rings of SLOTS distinct glyphs, each holding its god's sigil", () => {
  for (let s = 1; s <= 500; s++) {
    const { god, rings } = makeTrial(seeded(s));
    assert.equal(rings.length, 3);
    const want = [god.planet, god.sign, god.letter];
    rings.forEach((r, i) => {
      assert.equal(r.glyphs.length, SLOTS);
      assert.equal(new Set(r.glyphs).size, SLOTS, "no glyph twice on a ring");
      assert.equal(r.glyphs[r.target], want[i]);
    });
  }
});

test("no ring starts aligned or one nudge from it", () => {
  for (let s = 1; s <= 500; s++) {
    for (const r of makeTrial(seeded(s)).rings) {
      assert.equal(aligned(r), false);
      assert.equal(aligned({ ...r, turn: r.turn + 1 }), false);
      assert.equal(aligned({ ...r, turn: r.turn - 1 }), false);
    }
  }
});

test("turnToGate brings any glyph to the gate the short way, and that solves the ring", () => {
  for (let s = 1; s <= 200; s++) {
    const trial = makeTrial(seeded(s));
    for (const r of trial.rings) {
      for (let j = 0; j < SLOTS; j++) {
        const t = turnToGate(r, j);
        assert.equal(atGate({ turn: t }), j);
        assert.ok(Math.abs(t - r.turn) <= SLOTS / 2 + 0.5, "never the long way round");
      }
      r.turn = turnToGate(r, r.target);
    }
    assert.equal(solved(trial), true);
  }
});

test("alignment rounds a dragged (fractional) turn to the nearest slot, in either direction, any number of laps", () => {
  const r = { glyphs: [], target: 3, turn: 0 };
  r.turn = mod(-3, SLOTS) + 0.4; assert.equal(aligned(r), true);
  r.turn = mod(-3, SLOTS) - 0.4 - 3 * SLOTS; assert.equal(aligned(r), true);
  r.turn = mod(-3, SLOTS) + 0.6; assert.equal(aligned(r), false);
});

test("gods are well formed; zodiac and planets render as text, Greek letters untouched", () => {
  for (const g of GODS) {
    assert.ok(PLANETS.includes(g.planet) && SIGNS.includes(g.sign), g.name);
    assert.match(g.letter, /^[Α-Ω]$/);
  }
  assert.equal(glyphText("♐"), "♐︎");
  assert.equal(glyphText("Ζ"), "Ζ");
});
