// The title screen's pure parts (titlecore.js) and its wiring into the page. Rendering itself is checked in a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  BEATS, CUES, markup, Tweens, emblemLayout, loopArea, pointInLoop, nestLoops, relaxLoop, offsetLoop,
  badgeOutlines, spaceAlong, selfIntersects,
} from "../titlecore.js";

const WEB = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, WEB), "utf8");
const trace = JSON.parse(read("assets/title/caduceus.json"));
const square = (cx, cy, r, ccw = true) => {
  const l = [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
  return ccw ? l : l.reverse();
};
const perimeter = (l) => l.reduce((s, p, i) => s + Math.hypot(l[(i + 1) % l.length][0] - p[0], l[(i + 1) % l.length][1] - p[1]), 0);

test("the prologue: five numbered lines, every emblem cue exactly once, emphasis marks balanced", () => {
  assert.deepEqual(BEATS.map((b) => b.n), ["I", "II", "III", "IV", "V"]);
  assert.deepEqual(BEATS.map((b) => b.cue).sort(), [...CUES].sort());
  for (const b of BEATS) assert.equal((b.text.match(/\*/g) ?? []).length % 2, 0, b.text);
});

test("a story line types out one span per character, escapes markup and sets *words* in gold", () => {
  const html = markup("Strike *<the> anvil* & go");
  assert.equal((html.match(/class="c"/g) ?? []).length, "Strike <the> anvil & go".length);
  assert.equal((html.match(/class="em"/g) ?? []).length, 1);
  assert.match(html, /&lt;/);
  assert.match(html, /&amp;/);
  assert.doesNotMatch(html, /<the>/);
  assert.equal((markup(BEATS[1].text).match(/class="em"/g) ?? []).length, 4);
});

test("tweens land exactly on the target, and a new tween on the same value replaces the running one", () => {
  const tw = new Tweens(), o = { a: 0, b: 5 };
  tw.to(o, "a", 10, 1, "inOut");
  tw.update(0.5);
  assert.ok(o.a > 0 && o.a < 10);
  tw.to(o, "a", -2, 0.5, "linear");
  tw.update(10);
  assert.equal(o.a, -2);
  assert.equal(tw.list.length, 0);
  tw.to(o, "b", 7, 0);
  assert.equal(o.b, 7);
});

test("loop basics: signed area follows the winding, points inside and outside", () => {
  assert.equal(loopArea(square(0, 0, 1)), 4);
  assert.equal(loopArea(square(0, 0, 1, false)), -4);
  assert.ok(pointInLoop(0.2, -0.3, square(0, 0, 1)));
  assert.ok(!pointInLoop(1.5, 0, square(0, 0, 1)));
});

test("even-odd nesting: a ring with an island inside its hole, plus a separate outline, in either winding", () => {
  for (const ccw of [true, false]) {
    const { depth, parent } = nestLoops([square(0, 0, 3, ccw), square(0, 0, 2, !ccw), square(0, 0, 1, ccw), square(10, 0, 1, ccw)]);
    assert.deepEqual([...depth], [0, 1, 2, 0]);
    assert.deepEqual([...parent], [-1, 0, 1, -1]);
  }
});

test("the caduceus trace nests into outlines with holes, each hole inside a larger outline", () => {
  const { depth, parent } = nestLoops(trace.art);
  const holes = [...depth.keys()].filter((i) => depth[i] % 2 === 1);
  assert.ok(trace.art.length > 100 && holes.length > 20, `${trace.art.length} loops, ${holes.length} holes`);
  for (const i of holes) {
    const p = parent[i];
    assert.ok(p >= 0 && depth[p] % 2 === 0, `hole ${i} has an outline around it`);
    assert.ok(Math.abs(loopArea(trace.art[p])) > Math.abs(loopArea(trace.art[i])));
  }
});

test("offsets grow (+) or shrink (-) an outline whichever way it winds", () => {
  for (const ccw of [true, false]) {
    const a = Math.abs(loopArea(square(0, 0, 1, ccw)));
    assert.ok(Math.abs(loopArea(offsetLoop(square(0, 0, 1, ccw), 0.1))) > a);
    assert.ok(Math.abs(loopArea(offsetLoop(square(0, 0, 1, ccw), -0.1))) < a);
  }
});

test("relaxing resamples to an even spacing and keeps the outline's length", () => {
  const sq = square(0, 0, 1), even = relaxLoop(sq, 0.05, 0);
  assert.equal(even.length, 160);
  for (let i = 0; i < even.length; i++) {
    const a = even[i], b = even[(i + 1) % even.length];
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.05) < 1e-9);
  }
  const relaxed = relaxLoop(trace.plate[0], 0.008, 24);
  assert.ok(Math.abs(perimeter(relaxed) / perimeter(trace.plate[0]) - 1) < 0.05);
});

test("the badge rim does not fold over the outline's sharp inner corners (it filled a wedge of the rim once)", () => {
  const b = badgeOutlines(trace.plate[0]);
  for (const [name, loop] of Object.entries(b)) assert.ok(!selfIntersects(loop), `${name} crosses itself`);
  // the band really is a band: inner inside outer inside the plate
  assert.ok(Math.abs(loopArea(b.rimInner)) < Math.abs(loopArea(b.rimOuter)));
  assert.ok(Math.abs(loopArea(b.rimOuter)) < Math.abs(loopArea(b.plate)));
  // and the check would have caught the old, unrelaxed offsets
  assert.ok(selfIntersects(offsetLoop(offsetLoop(trace.plate[0], 0.05), -0.034)));
});

test("rivets are spaced evenly all the way round", () => {
  const studs = spaceAlong(square(0, 0, 1), 0.5);
  assert.equal(studs.length, 16);
  for (let i = 0; i < studs.length; i++) {
    const a = studs[i], b = studs[(i + 1) % studs.length];
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.5) < 1e-9);
  }
  assert.ok(spaceAlong(badgeOutlines(trace.plate[0]).rivets, 0.07).length > 40);
});

test("the emblem stays on screen and clear of the studio mark, wide and tall screens, story and title", () => {
  const size = { w: 1.23, h: 1.2 };
  for (const aspect of [21 / 9, 16 / 9, 4 / 3, 1, 9 / 16, 9 / 19.5]) {
    for (const mode of ["story", "title"]) {
      const { y, s, H, W } = emblemLayout(aspect, mode, size, 28, 4.2);
      const top = 0.5 - (y + (s * size.h) / 2) / H, bottom = 0.5 - (y - (s * size.h) / 2) / H;
      assert.ok(s * size.w <= 0.94 * W + 1e-9, `${aspect} ${mode}: fits the width`);
      assert.ok(top >= 0.1 && bottom <= 0.8, `${aspect} ${mode}: spans ${top.toFixed(2)}..${bottom.toFixed(2)}`);
    }
  }
});

test("the page loads title.js before main.js, and every title asset it names exists", () => {
  const html = read("index.html");
  const t = html.indexOf('src="./title.js"'), m = html.indexOf('src="./main.js"');
  assert.ok(t > 0 && m > t, "title.js must evaluate first: main.js reads html[data-forge-title] that it sets");
  const refs = new Set([html, read("title.css"), read("title.js")].flatMap((s) => s.match(/assets\/title\/[\w.-]+/g) ?? []));
  assert.ok(refs.size >= 4);
  for (const r of refs) assert.ok(existsSync(new URL(r, WEB)), r);
});

test("title.js and main.js speak the same events", () => {
  const title = read("title.js"), main = read("main.js");
  for (const ev of ["forge:progress", "forge:ready", "forge:enter"]) {
    assert.ok(title.includes(`"${ev}"`), `title.js uses ${ev}`);
    assert.ok(main.includes(`"${ev}"`), `main.js uses ${ev}`);
  }
  assert.ok(title.includes('"title-cover"') && main.includes('"title-cover"'));
  assert.match(main, /entered\.then\(\(\) => npc\.enter\(\)\)/, "AERIS waits for the player to enter");
});
