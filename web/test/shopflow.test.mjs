// shopflow.js: the adapter the pack sequence drives (buy -> wait -> open -> minted cards, resume, refund, dead packs).
// Real wallet.js + packshop.js + chain.js + abi.js against a mock wallet and the fake Liteforge/PackShop chain.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ethers, ALICE, BOB, ETH, cfgFor, createFakeChain, createMockProvider, createMockWindow, memoryStorage, tick,
} from "./helpers.mjs";

const TIERS = ["common", "rare", "epic", "legendary"];
const SET = 1n << 32n;
// 12 snapshot cards (the fake chain has 12 templates); template i was minted from card i
const cards = Array.from({ length: 12 }, (_, i) => ({
  tokenId: String(SET + BigInt(i)), name: `Card ${i}`, rarity: TIERS[i % 4], serial: i, kind: ["Mortal", "King", "Demigod", "God"][i % 4],
}));
const templates = cards.map((c, i) => ({ id: i, sourceTokenId: c.tokenId, designHash: ethers.id(`design-${i}`), kind: i % 5 }));
const collection = () => ({ chainId: 4441, address: BOB, explorer: "https://explorer.test.invalid", snapshotAt: "2026-09-30T00:00:00Z", cards });

// The RPC client is cached per URL inside packshop.js, so ONE router function (installed as the global fetch for the
// duration of each test) serves whichever fake chain the current test booted. Globals are put back after every test, so
// this suite can share a process with the others (web/test/index.js).
const current = { chain: null, configFetches: [], configStatus: 200, config: null };
const router = async (url, init) => {
  if (String(url).includes("packshop")) {
    current.configFetches.push(String(url));
    return new Response(JSON.stringify(current.config), { status: current.configStatus });
  }
  return current.chain.fetch(url, init);
};
const GLOBALS = ["fetch", "window", "localStorage", "location"];
let saved = null;
afterEach(() => {
  if (!saved) return;                                    // a test of another suite: nothing of ours to undo
  for (const k of GLOBALS) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; }
  saved = null;
});

const { createShop } = await import("../shopflow.js");

async function boot({ search = "", host = "localhost", config, status = 200, chain = createFakeChain(), account = ALICE, wallets = true } = {}) {
  chain.setBalance(account, 10n * ETH);
  const provider = createMockProvider({ chain, accounts: [account] });
  saved ??= Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  globalThis.fetch = router;
  globalThis.window = createMockWindow([], wallets ? provider : undefined);
  globalThis.localStorage = memoryStorage();
  globalThis.location = { search, hostname: host };
  Object.assign(current, { chain, configFetches: [], configStatus: status, config: config ?? cfgFor({ templates }) });
  const shop = await createShop({ collection: collection() });
  await tick(30);                                       // the background refresh
  return { chain, provider, shop };
}
const connected = async (opts) => {
  const ctx = await boot(opts);
  await ctx.shop.wallet.connect();
  await ctx.shop.refresh();
  return ctx;
};

test("no config file: the hall stays in preview, the wallet layer still exists", async () => {
  const { shop } = await boot({ status: 404 });
  assert.equal(shop.live, false);
  assert.equal(shop.cfg, null);
  assert.equal(shop.label(), "Open Pack");
  assert.equal(shop.subLabel(), "");
  assert.equal(typeof shop.wallet.connect, "function", "connect and sign-in do not need a deployed shop");
  await assert.rejects(shop.buy(), /not open yet/);
  const c = collection();
  assert.equal(shop.adaptCollection(c), c);
});

test("?shop=off never even asks for the config", async () => {
  const { shop } = await boot({ search: "?shop=off" });
  assert.equal(shop.live, false);
  assert.deepEqual(current.configFetches, []);
});

test("?shop=local reads the dev-chain config on localhost hosts only", async () => {
  await boot({ search: "?shop=local", host: "localhost" });
  assert.deepEqual(current.configFetches, ["./assets/rapture/packshop.local.json"]);
  await boot({ search: "?shop=local", host: "127.0.0.1" });
  assert.deepEqual(current.configFetches, ["./assets/rapture/packshop.local.json"]);
  await boot({ search: "?shop=local", host: "forge.example.com" });
  assert.deepEqual(current.configFetches, ["./assets/rapture/packshop.json"], "a public host can never be pointed at a dev chain");
});

test("a shop whose templates the snapshot does not know is not live (it could mint cards the page cannot show)", async () => {
  const bad = cfgFor({ templates: [...templates.slice(0, 11), { id: 11, sourceTokenId: "999", designHash: ethers.id("x"), kind: 0 }] });
  const { shop } = await boot({ config: bad });
  assert.equal(shop.live, false);
  assert.match(String(shop.configError), /templates/);
});

test("the button label follows the wallet and the shop", async () => {
  const { shop, chain } = await boot();
  assert.equal(shop.info.price, ETH / 10n);
  assert.equal(shop.priceText(), "0.1 zkLTC");
  assert.equal(shop.label(), "Connect & Open");
  assert.equal(shop.subLabel(), "0.1 zkLTC");
  await shop.wallet.connect();
  await shop.refresh();
  assert.equal(shop.label(), "Open Pack");
  assert.equal(shop.subLabel(), "0.1 zkLTC");
  chain.st.cfg.paused = true;
  await shop.refresh();
  assert.equal(shop.label(), "Shop Paused");
  assert.equal(shop.subLabel(), "");
});

test("buy -> wait -> open: minted cards carry their own token ids, best card last", async () => {
  const { shop, chain } = await connected();
  const stages = [];
  const pending = await shop.buy({ onStage: (t) => stages.push(t) });
  assert.equal(pending.packId, "1");
  assert.equal(shop.pending.packId, "1");
  assert.equal(shop.label(), "Open Sealed Pack");
  assert.equal(shop.subLabel(), "", "the sealed pack is already paid for");
  assert.match(stages.join(" | "), /Confirm the purchase.*sealed/s);

  chain.mineL1(3);                                       // two block numbers later the pack is openable
  const ticks = [];
  await shop.waitOpenable({ onStage: (t) => ticks.push(t) });
  assert.match(ticks[0], /Sealed on chain\. Waiting for the reveal block/);

  const opened = await shop.open({ onStage: () => {} });
  assert.equal(opened.length, 5);
  const ranks = opened.map((c) => TIERS.indexOf(c.rarity));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "crescendo: the rarest card flips last");
  const templateIds = Array.from({ length: 5 }, (_, i) => Number((1n * 7n + BigInt(i) * 3n) % 12n));   // the fake's draw for pack 1
  for (const c of opened) {
    assert.equal(c.owned, true);
    assert.ok(c.txHash?.startsWith("0x"));
    assert.ok(BigInt(c.tokenId) >= (7n << 32n), "the MINTED token id, not the template's source token");
    assert.equal(c.serial, Number(BigInt(c.tokenId) & 0xffffffffn));
    const src = cards.find((k) => k.name === c.name);
    assert.ok(templateIds.some((t) => cards[t].name === c.name), `${c.name} is one of the drawn templates`);
    assert.equal(c.serialSource, src.serial + 1, "the panel says which design this is an edition of");
  }
  assert.equal(new Set(opened.map((c) => c.tokenId)).size, 5, "five distinct tokens");

  shop.spent();
  assert.equal(shop.pending, null);
  assert.equal(shop.label(), "Open Pack");
  assert.equal(shop.subLabel(), "0.1 zkLTC");
});

test("a minted template the page does not know is an error, not a blank card", async () => {
  // The page was configured with 11 of the shop's 12 templates. The fake draws (packId*7 + i*3) % 12, so pack 2 contains
  // template 11 (the shop was restocked after this page's config was written).
  const { shop, chain } = await connected({ config: cfgFor({ templates: templates.slice(0, 11) }) });
  assert.ok(shop.live);
  await shop.buy();                                      // pack 1
  await shop.buy();                                      // pack 2: the pending one
  assert.equal(shop.pending.packId, "2");
  chain.mineL1(3);
  await shop.waitOpenable({});
  await assert.rejects(shop.open({}), (e) => /template 11/.test(e.message) && /Reload the page/.test(e.message));
});

test("resume: a bought-but-unopened pack is found again after a reload, and needs no second purchase", async () => {
  const first = await connected();
  await first.shop.buy();
  const chain = first.chain;
  assert.equal(chain.st.txs.length, 1, "one purchase so far");

  const again = await connected({ chain });              // a fresh page load against the same chain
  assert.equal(again.shop.pending?.packId, "1");
  assert.equal(again.shop.label(), "Open Sealed Pack");
  assert.equal(chain.methods("eth_getLogs").length, 0, "one recentPacks call, no log scan");
  chain.mineL1(3);
  await again.shop.waitOpenable({});
  const opened = await again.shop.open({});
  assert.equal(opened.length, 5);
  assert.equal(chain.st.txs.length, 2, "buy + open only: resuming never buys again");
});

test("a dead pack is dropped and its price can be refunded", async () => {
  const { shop, chain } = await connected();
  await shop.buy();
  chain.mineL1(300);                                     // past the blockhash window
  await shop.refresh();
  assert.equal(shop.pending, null, "an expired pack is no longer 'waiting to be opened'");
  assert.equal(shop.expired.length, 1);
  assert.equal(shop.label(), "Open Pack");
  assert.equal(shop.subLabel(), "0.1 zkLTC");
  const r = await shop.refundOne({});
  assert.equal(r.amount, ETH / 10n);
  assert.equal(shop.expired.length, 0);
  assert.equal(await shop.refundOne({}), null, "nothing left to refund");
});

test("abandon() forgets the pending pack", async () => {
  const { shop } = await connected();
  await shop.buy();
  shop.abandon();
  assert.equal(shop.pending, null);
});

test("a lagging RPC node cannot resurrect a pack that was just opened", async () => {
  const { shop, chain } = await connected();
  await shop.buy();
  chain.mineL1(3);
  await shop.waitOpenable({});
  await shop.open({});
  shop.spent();
  chain.st.packs.get(1n).state = "sealed";               // a stale node still says the pack is openable
  await shop.refresh();
  assert.equal(shop.pending, null);
});

test("on the local dev chain the collection is described by the shop, not by Liteforge", async () => {
  const chain = createFakeChain({ chainId: 31338 });
  const config = cfgFor({ network: "local", chainId: 31338, rpc: "http://127.0.0.1:8547", explorer: null, faucet: null, cards: BOB, templates });
  const { shop } = await boot({ chain, config, host: "localhost", search: "?shop=local" });
  assert.ok(shop.live);
  const c = shop.adaptCollection(collection());
  assert.equal(c.local, true);
  assert.equal(c.chainId, 31338);
  assert.equal(c.explorer, null, "no Liteforge explorer links for local tokens");
  assert.equal(c.address, BOB);
});

test("no wallet extension: buying explains what to do instead of failing silently", async () => {
  const { shop } = await boot({ wallets: false });
  await assert.rejects(shop.buy(), (e) => e.code === "no_wallet" && /wallet/i.test(e.message));
});

test("refresh() calls overlap safely: one read at a time, one more queued, the newest state wins", async () => {
  const { shop, chain } = await connected();
  const configReads = () => chain.methods("eth_call").filter((c) => c.params[0].data.startsWith("0x79502c55")).length;   // config()
  const n0 = configReads();
  const a = shop.refresh(), b = shop.refresh(), c = shop.refresh();
  assert.equal(b, a, "a refresh asked for during a read waits on that read");
  assert.equal(c, a);
  await Promise.all([a, b, c]);
  assert.equal(configReads() - n0, 2, "the running read, then exactly one more for the calls made meanwhile");
  assert.equal(shop.info?.packSize, 5);
});
