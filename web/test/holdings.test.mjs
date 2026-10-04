// holdings.js: which tokens a wallet holds and which card each one is. A fake chain (the four ERC-721 reads) and a fake
// explorer stand in for Liteforge, so the whole source-combining logic runs with no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHoldings, cardIndex, decodeAbiString, demoTokens, parseTokenUri, serialOf, slugOf } from "../holdings.js";

const NFT = "0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721";
const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const SET = 1n << 32n;
const tid = (n) => String(SET + BigInt(n));

// 6 snapshot cards = the originals, token ids SET+0..5
const cards = Array.from({ length: 6 }, (_, i) => ({
  tokenId: tid(i), slug: `card-${i}`, name: `Card ${i}`, kind: "Mortal", rarity: "common",
  metadata: `ipfs://root/doc${i}.json`, image: `ipfs://root/img${i}.webp`,
}));
const collection = (extra = {}) => ({ chainId: 4441, address: NFT, setId: 1, explorer: "https://explorer.test.invalid", rpc: "https://rpc.test.invalid", cards, ...extra });

function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

// ------------------------------------------------------------------ fakes
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const abiString = (s) => {
  const b = Buffer.from(s, "utf8"), pad = (32 - (b.length % 32)) % 32;
  return "0x" + word(32) + word(b.length) + b.toString("hex") + "00".repeat(pad);
};
const dataUri = (json) => `data:application/json;base64,${Buffer.from(JSON.stringify(json)).toString("base64")}`;
const revert = () => Object.assign(new Error("execution reverted"), { name: "RpcError", rpcCode: 3, isRevert: true });

/** owners: Map(tokenId -> address). Counts every call so a test can prove what was NOT asked. */
function fakeChain(owners, { supply = owners.size, uris = new Map(), failOwnerOf = new Set(), failBalance = false } = {}) {
  const calls = { ownerOf: 0, balanceOf: 0, totalSupply: 0, tokenURI: 0, ids: [] };
  return {
    calls,
    owners,
    async call({ to, data }) {
      assert.equal(to.toLowerCase(), NFT.toLowerCase());
      const sel = data.slice(0, 10), arg = data.slice(10);
      if (sel === "0x6352211e") {
        calls.ownerOf++;
        const id = BigInt("0x" + arg).toString();
        calls.ids.push(id);
        if (failOwnerOf.has(id)) throw Object.assign(new Error("network"), { name: "RpcError", isRevert: false });
        const o = owners.get(id);
        if (!o) throw revert();
        return "0x" + word(BigInt(o));
      }
      if (sel === "0x70a08231") {
        calls.balanceOf++;
        if (failBalance) throw Object.assign(new Error("boom"), { name: "RpcError", isRevert: false });
        const who = "0x" + arg.slice(24);
        return "0x" + word([...owners.values()].filter((o) => o.toLowerCase() === who.toLowerCase()).length);
      }
      if (sel === "0x18160ddd") { calls.totalSupply++; return "0x" + word(supply); }
      if (sel === "0xc87b56dd") {
        calls.tokenURI++;
        const id = BigInt("0x" + arg).toString();
        if (!uris.has(id)) throw revert();
        return abiString(dataUri(uris.get(id)));
      }
      throw new Error(`unexpected selector ${sel}`);
    },
  };
}

/** fetch for the explorer: rows for the holder, optionally paged, optionally partial (lagging index). */
function fakeExplorer(rowsFor, { pageSize = 50, fail = false } = {}) {
  const requests = [];
  const f = async (url) => {
    requests.push(String(url));
    if (fail) throw new Error("explorer down");
    const u = new URL(url);
    const holder = u.searchParams.get("holder_address_hash").toLowerCase();
    const all = rowsFor(holder);
    const start = Number(u.searchParams.get("start") ?? 0);
    const items = all.slice(start, start + pageSize).map((id) => ({ id, owner: { hash: holder } }));
    const next = start + pageSize < all.length ? { start: start + pageSize } : null;
    return new Response(JSON.stringify({ items, next_page_params: next }), { status: 200 });
  };
  f.requests = requests;
  return f;
}

const ownersOf = (entries) => new Map(entries);
const mk = (owners, opts = {}, hopts = {}) => {
  const chain = fakeChain(owners, opts);
  const explorer = hopts.explorer ?? fakeExplorer(() => []);
  const h = createHoldings({ collection: hopts.collection ?? collection(), chain, fetch: explorer, storage: hopts.storage ?? memoryStorage(), templates: hopts.templates ?? [] });
  return { h, chain, explorer };
};

// ------------------------------------------------------------------ helpers
test("slugOf follows the snapshot script's rule", () => {
  assert.equal(slugOf("Vaelmyra"), "vaelmyra");
  assert.equal(slugOf("Thé Ørder of Ash!"), "the-rder-of-ash");
  assert.equal(slugOf("  --Odd  Name--  "), "odd-name");
  assert.equal(slugOf(undefined), "");
});

test("serialOf reads the set-local serial out of a token id", () => {
  assert.equal(serialOf(String(SET + 7n)), 7);
  assert.equal(serialOf(String((3n << 32n) + 1234n)), 1234);
});

test("decodeAbiString reads a string return and refuses hostile data", () => {
  assert.equal(decodeAbiString(abiString("héllo ✓")), "héllo ✓");
  assert.equal(decodeAbiString(abiString("")), "");
  assert.throws(() => decodeAbiString("0x" + word(32)), /truncated/);                                 // no length word
  assert.throws(() => decodeAbiString("0x" + word(9999) + word(0)), /offset/);                          // offset past the end
  assert.throws(() => decodeAbiString("0x" + word(32) + word(500) + "00".repeat(32)), /length/);       // length past the end
  assert.throws(() => decodeAbiString("0x" + word(32) + word(2n ** 40n)), /length/);                    // absurd length
  assert.throws(() => decodeAbiString("nope"), /hex/);
});

test("parseTokenUri handles base64 and plain data URIs and ignores pointers", () => {
  assert.deepEqual(parseTokenUri(dataUri({ name: "A ✓" })), { name: "A ✓" });
  assert.deepEqual(parseTokenUri("data:application/json;utf8,%7B%22name%22%3A%22B%22%7D"), { name: "B" });
  assert.equal(parseTokenUri("ipfs://root/x.json"), null);
  assert.equal(parseTokenUri("https://example.invalid/x.json"), null);
  assert.throws(() => parseTokenUri("data:application/json;base64,@@@"), Error);
});

test("cardIndex matches an edition by design hash, then design doc, then image, then name", () => {
  const idx = cardIndex(cards, [{ sourceTokenId: cards[2].tokenId, designHash: "0xAbC" }]);
  assert.equal(idx.match({ rapture: { design: { hash: "0xabc" } }, name: "Card 5" }), cards[2], "design hash wins over everything");
  assert.equal(idx.match({ external_url: "ipfs://root/doc4.json", name: "Card 1" }), cards[4]);
  assert.equal(idx.match({ image: "ipfs://root/img3.webp" }), cards[3]);
  assert.equal(idx.match({ name: "Card 1" }), cards[1]);
  assert.equal(idx.match({ name: "Somebody Else" }), null);
  assert.equal(idx.match(null), null);
  assert.equal(idx.byToken.get(cards[0].tokenId), cards[0]);
});

test("demoTokens is deterministic, partial and has duplicates", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ tokenId: tid(i) }));
  const a = demoTokens(many), b = demoTokens(many);
  assert.deepEqual(a, b);
  const unique = new Set(a.map((t) => t.cardTokenId));
  assert.ok(unique.size > 10 && unique.size < 35, `owns ${unique.size} of 50`);
  assert.ok(a.length > unique.size, "some card is owned twice");
  assert.equal(new Set(a.map((t) => t.tokenId)).size, a.length, "token ids are unique");
});

// ------------------------------------------------------------------ read: combining sources
test("a settled wallet costs one balanceOf and no ownerOf scan", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), ALICE], [tid(2), BOB]]);
  const { h, chain, explorer } = mk(owners, {}, { explorer: fakeExplorer((w) => (w === ALICE ? [tid(0), tid(1)] : [])) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(0), tid(1)]);
  assert.equal(r.balance, 2);
  assert.equal(r.complete, true);
  assert.equal(r.partial, false);
  assert.equal(r.explorer, "ok");
  assert.equal(chain.calls.ownerOf, 0, "nothing to verify");
  assert.equal(chain.calls.totalSupply, 0, "no scan");
  assert.equal(chain.calls.balanceOf, 1);
});

test("the explorer is asked for the collection's instances filtered by holder, and follows every page", async () => {
  const ids = Array.from({ length: 7 }, (_, i) => tid(i));
  const owners = ownersOf(ids.map((id) => [id, ALICE]));
  const explorer = fakeExplorer(() => ids, { pageSize: 3 });
  const { h } = mk(owners, {}, { explorer });
  const r = await h.read(ALICE);
  assert.equal(r.tokens.length, 7);
  assert.equal(explorer.requests.length, 3, "7 items at 3 per page = 3 requests");
  assert.match(explorer.requests[0], new RegExp(`/api/v2/tokens/${NFT}/instances\\?holder_address_hash=${ALICE}$`));
  assert.match(explorer.requests[1], /&start=3$/);
});

test("a lagging explorer index is completed by an ownerOf scan that stops once the balance is met", async () => {
  // Alice holds 6 of 40 tokens; the explorer knows only 2 of them. The other 4 are the newest ids.
  const owners = ownersOf(Array.from({ length: 40 }, (_, i) => [tid(i), i >= 36 || i === 1 || i === 2 ? ALICE : BOB]));
  const { h, chain } = mk(owners, {}, { explorer: fakeExplorer(() => [tid(1), tid(2)]) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(1), tid(2), tid(36), tid(37), tid(38), tid(39)]);
  assert.equal(r.complete, true);
  assert.ok(chain.calls.ownerOf <= 8 + 4, `newest-first scan finds the 4 new tokens quickly (asked ${chain.calls.ownerOf})`);
  assert.equal(chain.calls.ids[0], tid(39), "scan starts at the newest id");
});

test("stale explorer rows (already sent away) are dropped when the balance is smaller", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), BOB], [tid(2), ALICE]]);
  const { h } = mk(owners, {}, { explorer: fakeExplorer(() => [tid(0), tid(1), tid(2)]) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(0), tid(2)]);
  assert.equal(r.balance, 2);
  assert.equal(r.complete, true);
});

test("with the explorer down the chain alone still finds everything", async () => {
  const owners = ownersOf(Array.from({ length: 12 }, (_, i) => [tid(i), i % 3 === 0 ? ALICE : BOB]));
  const { h } = mk(owners, {}, { explorer: fakeExplorer(() => [], { fail: true }) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(0), tid(3), tid(6), tid(9)]);
  assert.equal(r.explorer, "failed");
  assert.equal(r.complete, true);
});

test("a chain without an explorer (local dev) works from remembered ids and the scan", async () => {
  const owners = ownersOf([[tid(0), BOB], [tid(1), ALICE], [tid(2), ALICE]]);
  const { h } = mk(owners, {}, { collection: collection({ explorer: null }) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(1), tid(2)]);
  assert.equal(r.explorer, "none");
});

test("with no balance available, the explorer's answer is used and is not called complete", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), ALICE]]);
  const { h } = mk(owners, { failBalance: true }, { explorer: fakeExplorer(() => [tid(0), tid(1)]) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(0), tid(1)]);
  assert.equal(r.balance, null);
  assert.equal(r.complete, false);
});

test("remembered ids the explorer never listed are verified, kept when owned and dropped when not", async () => {
  const owners = ownersOf([[tid(4), ALICE], [tid(5), BOB]]);
  const storage = memoryStorage();
  const { h, chain } = mk(owners, {}, { storage, explorer: fakeExplorer(() => []) });
  h.remember(ALICE, [tid(4), tid(5)]);
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(4)], "tid(5) belongs to Bob now");
  assert.ok(chain.calls.ownerOf >= 2);
});

test("remember() makes pack-minted ids NEW until they are marked seen", async () => {
  const { h } = mk(ownersOf([[tid(7), ALICE], [tid(8), ALICE], [tid(9), ALICE]]), {}, { explorer: fakeExplorer(() => [tid(7), tid(8), tid(9)]) });
  h.remember(ALICE, [tid(8), tid(9)]);
  const r = await h.read(ALICE);
  assert.deepEqual(h.unseen(ALICE, r.tokens), [tid(8), tid(9)], "the first read baselines what was already theirs, not what a pack minted here");
  h.markSeen(ALICE, r.tokens);
  assert.deepEqual(h.unseen(ALICE, r.tokens), []);
  h.remember(ALICE, [tid(9)]);
  assert.deepEqual(h.unseen(ALICE, r.tokens), [], "already seen: not NEW again");
});

test("marking ONE token seen keeps the rest of the first-read baseline seen (they must not all turn NEW)", async () => {
  const owned = [tid(0), tid(1), tid(2), tid(3), tid(4)];
  const { h } = mk(ownersOf(owned.map((id) => [id, ALICE])), {}, { explorer: fakeExplorer(() => owned) });
  const r = await h.read(ALICE);
  assert.deepEqual(h.unseen(ALICE, r.tokens), []);
  h.markSeen(ALICE, [tid(0)], r.tokens);
  assert.deepEqual(h.unseen(ALICE, r.tokens), [], "the other four were never new");
  // a pack mints one more; looking at just that one clears it without disturbing the rest
  h.remember(ALICE, [tid(9)]);
  const more = [...owned, tid(9)];
  assert.deepEqual(h.unseen(ALICE, more), [tid(9)]);
  h.markSeen(ALICE, [tid(9)], more);
  assert.deepEqual(h.unseen(ALICE, more), []);
});

test("a first-ever read of a wallet marks nothing NEW", async () => {
  const { h } = mk(ownersOf([[tid(0), ALICE], [tid(1), ALICE]]), {}, { explorer: fakeExplorer(() => [tid(0), tid(1)]) });
  const r = await h.read(ALICE);
  assert.deepEqual(h.unseen(ALICE, r.tokens), []);
});

test("the scan is capped and says so when the set is bigger than it will search", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), BOB]]);
  const { h, chain } = mk(owners, { supply: 100000 }, { explorer: fakeExplorer(() => []) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [], "tid(0) is far below the newest 1500 ids");
  assert.equal(r.complete, false);
  assert.equal(r.partial, true);
  assert.ok(chain.calls.ownerOf <= 1500 + 8);
});

test("deep = false never scans (background polls stay cheap)", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), ALICE]]);
  const { h, chain } = mk(owners, {}, { explorer: fakeExplorer(() => [tid(0)]) });
  const r = await h.read(ALICE, { deep: false });
  assert.deepEqual(r.tokens, [tid(0)]);
  assert.equal(r.complete, false);
  assert.equal(chain.calls.totalSupply, 0);
});

test("an ownerOf that fails transiently makes the answer partial instead of throwing", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), ALICE], [tid(2), ALICE]]);
  const { h } = mk(owners, { failOwnerOf: new Set([tid(0)]) }, { explorer: fakeExplorer(() => [tid(1), tid(2)]) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(1), tid(2)]);
  assert.equal(r.partial, true);
  assert.equal(r.complete, false);
});

test("a remembered token whose ownerOf fails transiently is kept for the next read, not forgotten", async () => {
  const owners = ownersOf([[tid(0), ALICE], [tid(1), ALICE], [tid(2), ALICE]]);
  const { h } = mk(owners, { failOwnerOf: new Set([tid(2)]) }, { explorer: fakeExplorer(() => [tid(0), tid(1)]) });
  h.remember(ALICE, [tid(2)]);                        // a pack minted it here; the explorer has not indexed it yet
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(0), tid(1)]);
  assert.equal(r.partial, true);
  assert.deepEqual([...h.remembered(ALICE)].sort(), [tid(0), tid(1), tid(2)], "still remembered: the chain never said it was gone");
});

test("an aborted read rejects with AbortError", async () => {
  const { h } = mk(ownersOf([[tid(0), ALICE]]), {}, { explorer: fakeExplorer(() => [tid(0)]) });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(h.read(ALICE, { signal: ctl.signal }), (e) => e.name === "AbortError");
});

test("read() rejects a malformed address", async () => {
  const { h } = mk(ownersOf([]));
  await assert.rejects(h.read("0x123"), TypeError);
});

test("a wallet with nothing is a clean empty, complete result", async () => {
  const { h } = mk(ownersOf([[tid(0), BOB]]), {}, { explorer: fakeExplorer(() => []) });
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, []);
  assert.equal(r.balance, 0);
  assert.equal(r.complete, true);
});

test("read() is case-insensitive about the wallet address", async () => {
  const { h } = mk(ownersOf([[tid(0), ALICE]]), {}, { explorer: fakeExplorer(() => [tid(0)]) });
  const r = await h.read(ALICE.toUpperCase().replace("0X", "0x"));
  assert.deepEqual(r.tokens, [tid(0)]);
});

// ------------------------------------------------------------------ identify
test("the snapshot's own tokens are identified without any RPC call", async () => {
  const { h, chain } = mk(ownersOf([]));
  const m = await h.identify([tid(0), tid(3)]);
  assert.equal(m.get(tid(0)), cards[0]);
  assert.equal(m.get(tid(3)), cards[3]);
  assert.equal(chain.calls.tokenURI, 0);
});

test("an edition is identified through its tokenURI and the answer is cached for good", async () => {
  const edition = tid(60);
  const uris = new Map([[edition, { name: "Whatever", external_url: cards[4].metadata, image: cards[4].image }]]);
  const storage = memoryStorage();
  const one = mk(ownersOf([]), { uris }, { storage });
  const m = await one.h.identify([edition]);
  assert.equal(m.get(edition), cards[4]);
  assert.equal(one.chain.calls.tokenURI, 1);

  // a fresh page load: the cache answers, no RPC
  const two = mk(ownersOf([]), { uris }, { storage });
  const again = await two.h.identify([edition]);
  assert.equal(again.get(edition), cards[4]);
  assert.equal(two.chain.calls.tokenURI, 0);
});

test("an edition is matched by the shop's design hash when the shop is live", async () => {
  const edition = tid(61);
  const uris = new Map([[edition, { name: "Renamed", rapture: { design: { hash: "0xDEADBEEF" } } }]]);
  const { h } = mk(ownersOf([]), { uris }, { templates: [{ sourceTokenId: cards[5].tokenId, designHash: "0xdeadbeef" }] });
  assert.equal((await h.identify([edition])).get(edition), cards[5]);
});

test("a token nobody can name stays null, is not cached, and does not break the others", async () => {
  const good = tid(62), stranger = tid(63), broken = tid(64);
  const uris = new Map([
    [good, { name: "Card 2" }],
    [stranger, { name: "Not In The Snapshot" }],
  ]);                                                   // `broken` reverts (no URI)
  const storage = memoryStorage();
  const { h } = mk(ownersOf([]), { uris }, { storage });
  const m = await h.identify([good, stranger, broken]);
  assert.equal(m.get(good), cards[2]);
  assert.equal(m.get(stranger), null);
  assert.equal(m.get(broken), null);
  const cached = JSON.parse([...storage._m.entries()].find(([k]) => k.includes("ident"))[1]);
  assert.deepEqual(cached, { [good]: cards[2].tokenId }, "only the positive match is cached");
});

test("a tokenURI that is a pointer, not inline JSON, is simply unidentified", async () => {
  const id = tid(65);
  const chain = fakeChain(ownersOf([]));
  const orig = chain.call;
  chain.call = async (tx) => (tx.data.startsWith("0xc87b56dd") ? abiString("ipfs://root/x.json") : orig(tx));
  const h = createHoldings({ collection: collection(), chain, fetch: fakeExplorer(() => []), storage: memoryStorage() });
  assert.equal((await h.identify([id])).get(id), null);
});

// ------------------------------------------------------------------ robustness
test("a blocked or throwing storage never breaks a read", async () => {
  const hostile = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const chain = fakeChain(ownersOf([[tid(0), ALICE]]));
  const h = createHoldings({ collection: collection(), chain, fetch: fakeExplorer(() => [tid(0)]), storage: hostile });
  h.remember(ALICE, [tid(0)]);
  const r = await h.read(ALICE);
  assert.deepEqual(r.tokens, [tid(0)]);
  assert.deepEqual(h.unseen(ALICE, r.tokens), [tid(0)], "the page keeps its own copy, so the pack it just opened is still NEW");
  h.markSeen(ALICE, r.tokens);
  assert.deepEqual(h.unseen(ALICE, r.tokens), []);
});

test("state is kept per wallet and per collection", async () => {
  const storage = memoryStorage();
  const a = createHoldings({ collection: collection(), chain: fakeChain(ownersOf([])), fetch: fakeExplorer(() => []), storage });
  const b = createHoldings({ collection: collection({ address: BOB }), chain: fakeChain(ownersOf([])), fetch: fakeExplorer(() => []), storage });
  a.remember(ALICE, [tid(1)]);
  assert.deepEqual(a.remembered(ALICE), [tid(1)]);
  assert.deepEqual(a.remembered(BOB), [], "another wallet");
  assert.deepEqual(b.remembered(ALICE), [], "another collection");
});

test("createHoldings refuses a collection with no contract address", () => {
  assert.throws(() => createHoldings({ collection: { cards: [] } }), TypeError);
});
