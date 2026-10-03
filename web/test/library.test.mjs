// librarymodel.js + collections.js: ownership rows, set progress, filters, sorting and the set registry.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, filterRows, progress, serialLabel, sortRows, KINDS } from "../librarymodel.js";
import { LIBRARY_SETS, loadSets } from "../collections.js";
import { createHoldings } from "../holdings.js";

const SET = 1n << 32n;
const tid = (n) => String(SET + BigInt(n));
const ELS = ["Water", "Lava", "Earth", "Metal"];
// 10 cards: 2 per Kind, in set order Mortal, Mortal, King, King, Demigod, Demigod, God, God, Titan, Titan
const cards = Array.from({ length: 10 }, (_, i) => ({
  tokenId: tid(i), slug: `c${i}`, name: `Z${String.fromCharCode(106 - i)}${i}`, epithet: `The ${["Bold", "Wise"][i % 2]}`,
  kind: KINDS[Math.floor(i / 2)], path: ["Rising", "Ascended", "Fallen"][i % 3], element: ELS[i % 4], faction: i % 2 ? "Horde" : "Alliance",
  alignment: "Good", kit: i % 3 ? "Riki" : "Hephaestus", frame: "Smoke",
}));
const tok = (id, c) => ({ tokenId: tid(id), card: c === null ? null : cards[c] });

test("buildRows: one row per card, editions grouped newest first, unknown tokens set aside", () => {
  const { rows, unknown, tokens } = buildRows(cards, [tok(11, 3), tok(50, 3), tok(3, 0), tok(60, null)], new Set([tid(50)]));
  assert.equal(rows.length, 10);
  assert.equal(tokens, 4);
  assert.deepEqual(unknown, [tid(60)]);
  const r3 = rows[3];
  assert.deepEqual(r3.tokens, [tid(50), tid(11)], "newest first");
  assert.equal(r3.count, 2);
  assert.equal(r3.owned, true);
  assert.equal(r3.isNew, true, "one of its editions is unseen");
  assert.equal(rows[0].isNew, false);
  assert.equal(rows[1].owned, false);
  assert.equal(rows[1].count, 0);
  assert.equal(rows[3].newest, BigInt(tid(50)));
  assert.equal(rows[1].newest, -1n);
});

test("buildRows with nothing owned leaves every card locked", () => {
  const { rows, unknown } = buildRows(cards, []);
  assert.ok(rows.every((r) => !r.owned && r.count === 0 && !r.isNew));
  assert.deepEqual(unknown, []);
});

test("progress counts distinct cards, not editions, and per Kind", () => {
  const { rows } = buildRows(cards, [tok(11, 3), tok(50, 3), tok(3, 0), tok(4, 9)]);
  const p = progress(rows);
  assert.equal(p.owned, 3, "cards 0, 3 and 9");
  assert.equal(p.total, 10);
  assert.equal(p.tokens, 4, "the duplicate edition counts as a token");
  assert.deepEqual(p.byKind.Mortal, { owned: 1, total: 2 });
  assert.deepEqual(p.byKind.King, { owned: 1, total: 2 });
  assert.deepEqual(p.byKind.Titan, { owned: 1, total: 2 });
  assert.deepEqual(p.byKind.God, { owned: 0, total: 2 });
});

test("filterRows by kind, element and ownership", () => {
  const { rows } = buildRows(cards, [tok(1, 0), tok(2, 1), tok(3, 4), tok(4, 5), tok(5, 9)]);
  assert.deepEqual(filterRows(rows, { kind: "Demigod" }).map((r) => r.index), [4, 5]);
  assert.deepEqual(filterRows(rows, { element: "Earth" }).map((r) => r.index), [2, 6]);
  assert.deepEqual(filterRows(rows, { status: "owned" }).map((r) => r.index), [0, 1, 4, 5, 9]);
  assert.deepEqual(filterRows(rows, { status: "missing", kind: "King" }).map((r) => r.index), [2, 3]);
  assert.equal(filterRows(rows, { kind: "all", element: "all", status: "all", q: "" }).length, 10);
});

test("filterRows 'new' shows only cards with an unseen edition", () => {
  const { rows } = buildRows(cards, [tok(1, 0), tok(2, 1)], new Set([tid(2)]));
  assert.deepEqual(filterRows(rows, { status: "new" }).map((r) => r.index), [1]);
});

test("search matches every word against an owned card's details", () => {
  const { rows } = buildRows(cards, [tok(1, 0), tok(2, 1), tok(3, 2)]);
  assert.deepEqual(filterRows(rows, { q: "zj0" }).map((r) => r.index), [0]);
  assert.deepEqual(filterRows(rows, { q: "  WISE  " }).map((r) => r.index), [1], "case and spacing are ignored");
  assert.deepEqual(filterRows(rows, { q: "bold king" }).map((r) => r.index), [2], "all words must match (card 2 is a King)");
  assert.deepEqual(filterRows(rows, { q: "nothing-like-this" }), []);
});

test("search cannot reveal a locked card's name, but can find it by kind, path or element", () => {
  const { rows } = buildRows(cards, [tok(1, 0)]);
  assert.deepEqual(filterRows(rows, { q: "zi1" }).map((r) => r.index), [], "card 1 is locked: its name stays hidden");
  assert.deepEqual(filterRows(rows, { q: "titan" }).map((r) => r.index), [8, 9]);
  assert.ok(filterRows(rows, { q: "lava" }).some((r) => !r.owned), "a locked card is findable by element");
  assert.deepEqual(filterRows(rows, { q: "wise" }).map((r) => r.owned), [], "epithets of locked cards are hidden too");
});

test("sortRows: set order restores the original order", () => {
  const { rows } = buildRows(cards, [tok(1, 5), tok(2, 1)]);
  const shuffled = [rows[7], rows[2], rows[9], rows[0]];
  assert.deepEqual(sortRows(shuffled, "set").map((r) => r.index), [0, 2, 7, 9]);
  assert.deepEqual(sortRows(rows).map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("sortRows: rarity puts owned cards first, highest Kind first, locked after", () => {
  const { rows } = buildRows(cards, [tok(1, 0), tok(2, 5), tok(3, 8), tok(4, 3)]);
  assert.deepEqual(sortRows(rows, "rarity").map((r) => r.index).slice(0, 4), [8, 5, 3, 0]);   // Titan, Demigod, King, Mortal
  assert.ok(sortRows(rows, "rarity").slice(4).every((r) => !r.owned));
});

test("sortRows: name is alphabetical among owned cards", () => {
  const { rows } = buildRows(cards, [tok(1, 0), tok(2, 1), tok(3, 2)]);   // Zj0, Zi1, Zh2
  assert.deepEqual(sortRows(rows, "name").map((r) => r.index).slice(0, 3), [2, 1, 0]);
});

test("sortRows: newest orders by the highest token id owned", () => {
  const { rows } = buildRows(cards, [tok(10, 0), tok(30, 1), tok(20, 2), tok(5, 2)]);
  assert.deepEqual(sortRows(rows, "newest").map((r) => r.index).slice(0, 3), [1, 2, 0]);
});

test("sortRows never mutates its input", () => {
  const { rows } = buildRows(cards, [tok(1, 3)]);
  const copy = [...rows];
  sortRows(rows, "rarity");
  assert.deepEqual(rows, copy);
});

test("serialLabel pads to three digits and is 1-based", () => {
  assert.equal(serialLabel(0), "#001");
  assert.equal(serialLabel(50), "#051");
  assert.equal(serialLabel(1233), "#1234");
});

// ------------------------------------------------------------------ set registry
test("LIBRARY_SETS starts with ARC 1 as the primary set", () => {
  assert.equal(LIBRARY_SETS[0].id, "rapture-arc1");
  assert.equal(LIBRARY_SETS[0].primary, true);
  assert.ok(Object.isFrozen(LIBRARY_SETS));
});

test("loadSets uses the primary collection as given and loads the rest by snapshot url", async () => {
  const primary = { cards: [1] }, other = { cards: [1, 2] };
  const asked = [];
  const sets = [
    { id: "a", title: "A", snapshot: "./a.json", primary: true },
    { id: "b", title: "B", snapshot: "./b.json" },
  ];
  const out = await loadSets({ primary, load: async (u) => { asked.push(u); return other; }, sets });
  assert.deepEqual(out.map((s) => [s.id, s.collection]), [["a", primary], ["b", other]]);
  assert.deepEqual(asked, ["./b.json"], "the primary is never fetched again");
});

test("loadSets skips a set that fails or is empty without losing the others", async () => {
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a);
  try {
    const sets = [
      { id: "a", title: "A", snapshot: "./a.json", primary: true },
      { id: "broken", title: "X", snapshot: "./x.json" },
      { id: "empty", title: "E", snapshot: "./e.json" },
      { id: "ok", title: "O", snapshot: "./o.json" },
    ];
    const out = await loadSets({
      primary: { cards: [1] }, sets,
      load: async (u) => { if (u.includes("x")) throw new Error("404"); return u.includes("e.json") ? { cards: [] } : { cards: [1] }; },
    });
    assert.deepEqual(out.map((s) => s.id), ["a", "ok"]);
    assert.equal(logged.length, 1);
  } finally { console.warn = warn; }
});

test("holdings.learn() lets the library skip the tokenURI call for a token a pack just minted", async () => {
  const stored = new Map();
  const storage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) };
  let uriCalls = 0;
  const chain = { call: async () => { uriCalls++; throw new Error("should not be called"); } };
  const h = createHoldings({ collection: { chainId: 4441, address: "0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721", setId: 1, cards }, chain, storage, fetch: async () => { throw new Error("no"); } });
  h.learn(tid(77), cards[4].tokenId);
  h.learn(tid(78), "999");                                   // not a card of this set: ignored
  const m = await h.identify([tid(77), tid(78)]);
  assert.equal(m.get(tid(77)), cards[4]);
  assert.equal(uriCalls, 1, "only the unknown token needed a call");
});
