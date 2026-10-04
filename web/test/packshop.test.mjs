// packshop.js end to end: real wallet.js + real chain.js + real abi.js against a mock EIP-1193 wallet and a fake
// Liteforge/PackShop chain. Every log and result the fake produces is encoded by ethers, so the client's decoders are
// checked against an independent encoder.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE, PHASE_NAMES, ShopError, chainFromConfig, loadShopConfig, rpcFor, readShop, packsLeftToday, phaseOf, buyPack,
  waitUntilOpenable, openPack, refundExpired, findMyPacks, formatZkltc,
} from "../packshop.js";
import { createWallet, WalletError, LITEFORGE, chainParams } from "../wallet.js";
import { createChain } from "../chain.js";
import { AbiError, TOPICS } from "../abi.js";
import {
  ethers, ALICE, BOB, SHOP, RPC, ETH, q, cfgFor, createFakeChain, createMockProvider, memoryStorage, providerError, rpcError, revertRpcError,
  jsonRpcFetch, hangingFetch, tick, captureConsole, shopIface,
} from "./helpers.mjs";

const A = ALICE.toLowerCase();
const PRICE = ETH / 10n;
const FEES = (600_000n + 12_000_000n) * 200_000_000n * 2n;     // what buyPack reserves for gas at 0.2 gwei
const FAST = { pollMs: 2, timeoutMs: 2000 };

/** Wallet + fake chain + config, all wired together. */
async function setup({ account = ALICE, connect = true, providerOpts = {}, clientOpts = {}, cfgExtra = {} } = {}) {
  const chain = createFakeChain();
  chain.setBalance(account, 10n * ETH);
  const provider = createMockProvider({ chain, accounts: [account], ...providerOpts });
  const cfg = cfgFor({ client: createChain(RPC, { fetch: chain.fetch, backoffMs: 1, retries: 1, timeoutMs: 1000, ...clientOpts }), ...cfgExtra });
  const wallet = createWallet({ provider, storage: memoryStorage(), chain: chainFromConfig(cfg) });
  if (connect) await wallet.connect();
  return { chain, provider, cfg, wallet };
}
async function buy(ctx, opts = {}) {
  const stages = [];
  const r = await buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s), ...FAST, ...opts });
  return { ...r, stages };
}
// assert.rejects wants a validator that returns exactly `true`, hence Boolean()
const shopErr = (code, extra = () => true) => (e) => e instanceof ShopError && e instanceof WalletError && e.code === code && Boolean(extra(e));
const walletErr = (code, extra = () => true) => (e) => e instanceof WalletError && e.code === code && Boolean(extra(e));
const noTxSent = (ctx) => {
  assert.equal(ctx.provider.methods("eth_sendTransaction").length, 0, "the wallet was never asked to send anything");
  assert.equal(ctx.chain.st.txs.length, 0);
};
const gasBump = (est) => est + (est * 25n + 99n) / 100n;

// ------------------------------------------------------------------ config
test("loadShopConfig: a missing file (404) is null, not an error", async () => {
  const calls = [];
  const f = async (url, init) => { calls.push([url, init]); return new Response("Not Found", { status: 404 }); };
  assert.equal(await loadShopConfig(undefined, { fetch: f }), null);
  assert.deepEqual(calls[0], ["./assets/rapture/packshop.json", { cache: "no-cache" }], "default path, revalidated so a redeploy is picked up");
  assert.equal(await loadShopConfig("/other.json", { fetch: f }), null);
  assert.equal(calls[1][0], "/other.json");
});

const serve = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("loadShopConfig: reads what write-web-config.mjs writes, unchanged", async () => {
  const body = {
    network: "liteforge", chainId: 4441, rpc: "https://r.example/http", explorer: "https://x.example", faucet: "https://f.example",
    currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 }, packShop: SHOP, cards: BOB,
    templates: [{ id: 0, sourceTokenId: "4294967296", designHash: "0xab", kind: 4 }], writtenAt: "2026-09-30T03:19:00.000Z",
  };
  assert.deepEqual(await loadShopConfig("x", { fetch: serve(body) }), body, "every field, including the ones this client does not use");
});

test("loadShopConfig: a local dev chain's nulls stay null (no Liteforge explorer or faucet leaks in)", async () => {
  const local = {
    network: "local", chainId: 31338, rpc: "http://127.0.0.1:8547", explorer: null, faucet: null,
    currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 }, packShop: SHOP, cards: BOB, templates: [],
  };
  const cfg = await loadShopConfig("x", { fetch: serve(local) });
  assert.equal(cfg.explorer, null);
  assert.equal(cfg.faucet, null);
  assert.equal(cfg.rpc, "http://127.0.0.1:8547");
  assert.equal(cfg.chainId, 31338);
  // a non-Liteforge chain that leaves them out gets nothing either, and must name its rpc
  const bare = await loadShopConfig("x", { fetch: serve({ packShop: SHOP, chainId: 31338, rpc: "http://127.0.0.1:8547" }) });
  assert.equal(bare.explorer, null);
  assert.equal(bare.faucet, null);
  await assert.rejects(loadShopConfig("x", { fetch: serve({ packShop: SHOP, chainId: 31338 }) }), shopErr("not_configured", (e) => /no rpc url/.test(e.message)));
  await assert.rejects(loadShopConfig("x", { fetch: serve({ packShop: SHOP, chainId: 31338, rpc: null }) }), shopErr("not_configured"));
});

test("loadShopConfig: a sparse Liteforge config gets Liteforge's public endpoints", async () => {
  const sparse = await loadShopConfig("x", { fetch: serve({ packShop: SHOP, chainId: "4441" }) });
  assert.equal(sparse.chainId, 4441, "a string chain id is normalised");
  assert.equal(sparse.rpc, LITEFORGE.rpcUrls[0]);
  assert.equal(sparse.explorer, LITEFORGE.explorer);
  assert.equal(sparse.faucet, LITEFORGE.faucet);
  assert.deepEqual(sparse.templates, []);
  const noChain = await loadShopConfig("x", { fetch: serve({ packShop: SHOP }) });
  assert.equal(noChain.chainId, 4441);
  const explicitNone = await loadShopConfig("x", { fetch: serve({ packShop: SHOP, explorer: null, faucet: null }) });
  assert.equal(explicitNone.explorer, null, "an explicit null beats the default");
});

test("loadShopConfig: anything else wrong with it is a not_configured error", async () => {
  const bad = [
    [async () => new Response(JSON.stringify({}), { status: 200 }), /packShop/],
    [async () => new Response(JSON.stringify({ packShop: "0x1234" }), { status: 200 }), /packShop/],
    [async () => new Response(JSON.stringify(null), { status: 200 }), /packShop/],
    [async () => new Response(JSON.stringify({ packShop: SHOP, chainId: "banana" }), { status: 200 }), /chainId/],
    [async () => new Response("<html>SPA fallback</html>", { status: 200 }), /not valid JSON/],
    [async () => new Response("boom", { status: 500 }), /HTTP 500/],
    [async () => new Response("no", { status: 403 }), /HTTP 403/],
    [async () => { throw new TypeError("Failed to fetch"); }, /could not be loaded/],
  ];
  for (const [f, message] of bad) {
    await assert.rejects(loadShopConfig("x", { fetch: f }), shopErr("not_configured", (e) => message.test(e.message)), String(message));
  }
});

test("chainFromConfig gives the wallet the config's chain, so wallet and shop cannot disagree", () => {
  const c = chainFromConfig({ chainId: 4441, rpc: "https://r.example", explorer: "https://x.example", faucet: "https://f.example" });
  assert.equal(c.chainId, 4441);
  assert.equal(c.name, "LitVM Liteforge");
  assert.deepEqual(c.rpcUrls, ["https://r.example"]);
  assert.equal(c.explorer, "https://x.example");
  assert.equal(c.faucet, "https://f.example");
  assert.deepEqual({ ...c.nativeCurrency }, { name: "zkLTC", symbol: "zkLTC", decimals: 18 });

  // the local dev chain: its own name and currency, no explorer, no faucet (nothing borrowed from Liteforge)
  const local = chainFromConfig({
    network: "local", chainId: 31338, rpc: "http://127.0.0.1:8547", explorer: null, faucet: null, currency: { name: "Test", symbol: "TST", decimals: 18 },
  });
  assert.equal(local.name, "local (chain 31338)");
  assert.deepEqual(local.nativeCurrency, { name: "Test", symbol: "TST", decimals: 18 });
  assert.equal("explorer" in local, false);
  assert.equal("faucet" in local, false);
  const w = createWallet({ provider: createMockProvider(), chain: local });
  assert.equal(w.chain.chainIdHex, "0x7a6a");
  assert.equal("blockExplorerUrls" in chainParams(w.chain), false);
  assert.deepEqual(chainParams(w.chain).rpcUrls, ["http://127.0.0.1:8547"]);
  assert.equal(chainFromConfig({ chainId: 7, rpc: "http://x" }).name, "Chain 7");
  assert.equal(chainFromConfig({ chainId: 7, rpc: "http://x", chainName: "Custom" }).name, "Custom");
});

test("rpcFor: refuses an unusable config, caches one client per RPC url, honours cfg.client", () => {
  for (const bad of [undefined, null, {}, { packShop: "0x12", rpc: RPC }, { packShop: SHOP }, { packShop: SHOP, rpc: 5 }]) {
    assert.throws(() => rpcFor(bad), shopErr("not_configured"), JSON.stringify(bad));
  }
  const a = rpcFor({ packShop: SHOP, rpc: "https://one.example/rpc" });
  assert.equal(rpcFor({ packShop: BOB, rpc: "https://one.example/rpc" }), a, "same url, same client");
  assert.notEqual(rpcFor({ packShop: SHOP, rpc: "https://two.example/rpc" }), a);
  const mine = createChain(RPC);
  assert.equal(rpcFor({ packShop: SHOP, rpc: RPC, client: mine }), mine);
});


// ------------------------------------------------------------------ reads
test("readShop decodes config(): bigint price, numbers, weights, flags; packsLeft with an address", async () => {
  const { chain, cfg } = await setup();
  chain.st.cfg = { price: 123456789012345678n, packSize: 5, dailyLimit: 3, paused: false, ready: true, weights: [50, 28, 15, 5, 2], templateCount: 12 };
  const shop = await readShop(cfg);
  assert.deepEqual(shop, { price: 123456789012345678n, packSize: 5, dailyLimit: 3, paused: false, ready: true, weights: [50, 28, 15, 5, 2], templateCount: 12 });
  assert.equal(typeof shop.price, "bigint");
  const withAddr = await readShop(cfg, ALICE);
  assert.equal(withAddr.packsLeft, 3);
  chain.st.cfg.paused = true;
  chain.st.cfg.ready = false;
  assert.deepEqual([(await readShop(cfg)).paused, (await readShop(cfg)).ready], [true, false]);
  // the call went to the shop, with the right selector, on the public RPC (never the wallet)
  const call = chain.methods("eth_call")[0].params[0];
  assert.equal(call.to, SHOP);
  assert.equal(call.data, "0x79502c55");
});

test("packsLeftToday: counts down, is 0 at the limit, and Infinity when the shop has no limit", async () => {
  const { chain, cfg } = await setup();
  assert.equal(await packsLeftToday(cfg, ALICE), 3);
  chain.st.bought.set(A, 2);
  assert.equal(await packsLeftToday(cfg, ALICE), 1);
  assert.equal(await packsLeftToday(cfg, ALICE.toLowerCase()), 1, "any address casing");
  chain.st.bought.set(A, 3);
  assert.equal(await packsLeftToday(cfg, ALICE), 0);
  assert.equal(await packsLeftToday(cfg, BOB), 3, "per wallet");
  chain.st.cfg.dailyLimit = 0;
  assert.equal(await packsLeftToday(cfg, ALICE), Infinity, "uint256.max means unlimited");
  await assert.rejects(packsLeftToday(cfg, "0x1234"), AbiError);
});

test("reads say plainly when the contract is missing, the network is down, or the answer is garbage", async () => {
  const { chain, cfg } = await setup();
  await assert.rejects(readShop({ ...cfg, packShop: BOB }), shopErr("not_configured", (e) => /not found on this network/.test(e.message) && e.packShop === BOB));
  chain.st.hooks.eth_call = () => "0x1234";
  await assert.rejects(readShop(cfg), shopErr("bad_response", (e) => e.cause instanceof AbiError));
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(32 * 4);      // valid words but config() needs eleven
  await assert.rejects(readShop(cfg), shopErr("bad_response"));
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(32 * 3) + "00".repeat(31) + "02" + "00".repeat(32 * 7);   // paused = 2: not a bool
  await assert.rejects(readShop(cfg), shopErr("bad_response"));
  delete chain.st.hooks.eth_call;
  const down = { ...cfg, client: createChain(RPC, { fetch: async () => { throw new TypeError("Failed to fetch"); }, backoffMs: 1, retries: 1 }) };
  await assert.rejects(readShop(down), shopErr("rpc", (e) => /Could not reach the LitVM Liteforge network/.test(e.message) && e.cause));
  await assert.rejects(phaseOf(down, 1), shopErr("rpc"));
});

test("phaseOf follows a pack through its life (Nitro: the contract's own block numbers decide)", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  assert.equal(await phaseOf(cfg, 1), PHASE.None);
  const { packId } = await buy(ctx);
  assert.equal(await phaseOf(cfg, packId), PHASE.Waiting);
  chain.mineL1(1);
  assert.equal(await phaseOf(cfg, packId), PHASE.Waiting, "commit + 1 is not enough: the reveal block must be strictly older");
  chain.mineL1(1);
  assert.equal(await phaseOf(cfg, packId), PHASE.Openable);
  chain.mineL1(254);                                   // block.number is now reveal + 255: the last openable one
  assert.equal(await phaseOf(cfg, packId), PHASE.Openable, "the last openable block number");
  chain.mineL1(1);
  assert.equal(await phaseOf(cfg, packId), PHASE.Expired);
  assert.deepEqual(PHASE_NAMES, ["None", "Waiting", "Openable", "Expired", "Opened", "Refunded"]);
  assert.deepEqual({ ...PHASE }, { None: 0, Waiting: 1, Openable: 2, Expired: 3, Opened: 4, Refunded: 5 });
  chain.st.hooks.eth_call = () => "0x" + "00".repeat(31) + "09";
  await assert.rejects(phaseOf(cfg, packId), shopErr("bad_response", (e) => /unknown pack state \(9\)/.test(e.message)));
});

// ------------------------------------------------------------------ buyPack
test("buyPack: end to end, exact transaction, stages in order, decoded PackBought", async () => {
  const ctx = await setup();
  const { chain, provider, cfg, wallet } = ctx;
  chain.st.receiptDelay = 3;
  const order = [];
  provider.once("eth_sendTransaction", (params) => { order.push("wallet"); return chain.sendTransaction(params[0]); });
  const stages = [];
  const result = await buyPack(wallet, cfg, { onStage: (s) => { order.push(s); stages.push(s); }, ...FAST });

  assert.deepEqual(Object.keys(result).sort(), ["commitBlock", "packId", "txHash"]);
  assert.equal(result.packId, "1");
  assert.equal(typeof result.packId, "string");
  assert.equal(result.commitBlock, 5_000_000);
  assert.equal(typeof result.commitBlock, "number");
  assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.deepEqual(order, ["signing", "wallet", "pending", "confirmed"], "signing is announced right before the wallet prompt, pending right after it");
  JSON.stringify(result);                                                    // survives JSON: no bigint anywhere

  const [tx] = chain.st.txs;
  assert.equal(tx.from, A);
  assert.equal(tx.to, SHOP);
  assert.equal(tx.data, "0xc37b9bcd");
  assert.equal(tx.data, shopIface.encodeFunctionData("buyPack"));
  assert.equal(tx.value, q(PRICE), "exactly the price");
  assert.equal(tx.gas, q(gasBump(180_000n)), "eth_estimateGas + 25%, passed explicitly");
  assert.equal(BigInt(tx.gas) * 100n / 180_000n, 125n);
  assert.equal(chain.methods("eth_getTransactionReceipt").length, 4, "polled until the receipt existed");
  assert.equal(chain.st.packs.get(1n).buyer, A);
  assert.equal(chain.balanceOf(ALICE), 10n * ETH - PRICE);
  // gas was estimated with the same call the wallet sent, from the buyer, against the public RPC
  assert.deepEqual(chain.methods("eth_estimateGas")[0].params, [{ from: A, to: SHOP, data: "0xc37b9bcd", value: q(PRICE) }]);
});

test("buyPack picks its own PackBought out of a busy receipt (other buyers, other contracts)", async () => {
  const ctx = await setup();
  const { chain } = ctx;
  const foreign = (address, buyer, id) => ({
    address, ...shopIface.encodeEventLog(shopIface.getEvent("PackBought"), [id, buyer, PRICE, 1234n]),
    blockNumber: q(1), transactionHash: "0x", logIndex: "0x0",
  });
  chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => {
    const r = st.receipts.get(hash);
    if (!r) return undefined;
    return { ...r, logs: [foreign(SHOP.toLowerCase(), BOB, 77n), foreign(BOB.toLowerCase(), ALICE, 88n), ...r.logs] };
  };
  const { packId } = await buy(ctx);
  assert.equal(packId, "1", "not the other buyer's 77, not the other contract's 88");
});

test("buyPack fails loudly when the receipt has no PackBought", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => (st.receipts.has(hash) ? { ...st.receipts.get(hash), logs: [] } : undefined);
  await assert.rejects(buy(ctx), shopErr("bad_response", (e) => /PackBought event is missing/.test(e.message) && /^0x[0-9a-f]{64}$/.test(e.txHash)));
  // a log with the right topic but broken data is reported with its cause, not skipped silently
  const ctx2 = await setup();
  ctx2.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => {
    const r = st.receipts.get(hash);
    return r ? { ...r, logs: r.logs.map((l) => ({ ...l, data: "0x1234" })) } : undefined;
  };
  await assert.rejects(buy(ctx2), shopErr("bad_response", (e) => e.cause instanceof AbiError));
});

test("buyPack switches the network first (known chain, and a chain the wallet has never seen)", async () => {
  const known = await setup({ providerOpts: { chainId: 1 } });
  assert.equal(known.wallet.onCorrectChain, false);
  const r1 = await buy(known);
  assert.equal(r1.packId, "1");
  assert.deepEqual(known.provider.methods("wallet_switchEthereumChain").map((c) => c.params), [[{ chainId: "0x1159" }]]);
  assert.equal(known.wallet.onCorrectChain, true);

  const unknown = await setup({ providerOpts: { chainId: 1, known: [1] } });
  const r2 = await buy(unknown);
  assert.equal(r2.packId, "1");
  assert.equal(unknown.provider.methods("wallet_addEthereumChain").length, 1);
  assert.deepEqual(unknown.provider.methods("wallet_addEthereumChain")[0].params[0].rpcUrls, [RPC]);
  assert.equal(unknown.provider.chainId, 4441);

  const refuses = await setup({ providerOpts: { chainId: 1 } });
  refuses.provider.once("wallet_switchEthereumChain", providerError(4001, "User rejected the request."));
  await assert.rejects(buy(refuses), walletErr("user_rejected"));
  noTxSent(refuses);
  assert.deepEqual(refuses.chain.methods("eth_call"), [], "no shop reads before the network is right");
});

test("buyPack never sends when the wallet drifts to another network between the checks and the send", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_estimateGas = () => { ctx.provider.chainId = 1; return undefined; };   // the player flips networks mid-flow
  await assert.rejects(buy(ctx), walletErr("wrong_chain", (e) => e.actual === 1 && /Switch/.test(e.message)));
  noTxSent(ctx);
  assert.equal(ctx.wallet.onCorrectChain, false);
});

test("buyPack pre-flight: not connected, no config, wrong chain in the wallet setup", async () => {
  const idle = await setup({ connect: false });
  await assert.rejects(buyPack(idle.wallet, idle.cfg), (e) => e instanceof WalletError && e.code === "not_connected");
  assert.equal(idle.chain.st.calls.length, 0);
  const ctx = await setup();
  await assert.rejects(buyPack(ctx.wallet, null), shopErr("not_configured"));
  await assert.rejects(buyPack(ctx.wallet, { ...ctx.cfg, packShop: undefined }), shopErr("not_configured"));
  await assert.rejects(buyPack(ctx.wallet, { ...ctx.cfg, chainId: 1 }), shopErr("not_configured", (e) => /chain 4441 but the shop lives on chain 1/.test(e.message)));
  await assert.rejects(buyPack(undefined, ctx.cfg), (e) => e.code === "not_connected");
  noTxSent(ctx);
});

test("buyPack pre-flight: a paused, empty or sold-out-for-today shop is explained before any prompt", async () => {
  for (const [patch, reason, message] of [
    [{ paused: true }, "EnforcedPause", /paused/i],
    [{ ready: false }, "NotStocked", /restocked/i],
  ]) {
    const ctx = await setup();
    Object.assign(ctx.chain.st.cfg, patch);
    await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === reason && message.test(e.message)), reason);
    noTxSent(ctx);
    assert.deepEqual(ctx.provider.methods("eth_sendTransaction"), []);
  }
  const ctx = await setup();
  ctx.chain.st.bought.set(A, 3);
  const stages = [];
  await assert.rejects(buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s) }), shopErr("unavailable", (e) => e.reason === "DailyLimitReached" && /midnight UTC/.test(e.message)));
  assert.deepEqual(stages, [], "no stage fired: the player never saw a wallet prompt");
  noTxSent(ctx);
  // 3 packs a day, really: the 4th purchase is refused
  const day = await setup();
  for (let i = 1; i <= 3; i++) assert.equal((await buy(day)).packId, String(i));
  await assert.rejects(buy(day), shopErr("unavailable", (e) => e.reason === "DailyLimitReached"));
  assert.equal(day.chain.st.txs.length, 3);
});

test("buyPack low balance: a friendly error with the faucet, the exact shortfall, and nothing sent", async () => {
  const ctx = await setup();
  ctx.chain.setBalance(ALICE, PRICE);                 // covers the pack, not the gas
  const stages = [];
  let err;
  try { await buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s) }); } catch (e) { err = e; }
  assert.ok(err instanceof ShopError && err instanceof WalletError);
  assert.equal(err.code, "low_balance");
  assert.match(err.message, /https:\/\/liteforge\.hub\.caldera\.xyz/);
  assert.match(err.message, /Not enough zkLTC/);
  assert.match(err.message, /costs 0\.1 and network fees need about 0\.0051/);
  assert.match(err.message, /your wallet has 0\.1\./);
  assert.equal(err.have, PRICE);
  assert.equal(err.need, PRICE + FEES);
  assert.equal(err.price, PRICE);
  assert.equal(err.fees, FEES);
  assert.equal(err.faucet, "https://liteforge.hub.caldera.xyz");
  assert.deepEqual(stages, []);
  noTxSent(ctx);
  ctx.chain.setBalance(ALICE, 0n);
  await assert.rejects(buy(ctx), shopErr("low_balance", (e) => /your wallet has 0\. Get free test zkLTC/.test(e.message)));
});

test("buyPack low balance on a chain with no faucet (a local dev chain) offers no faucet, and never another network's", async () => {
  const ctx = await setup({ cfgExtra: { faucet: null, explorer: null } });
  ctx.chain.setBalance(ALICE, PRICE);
  await assert.rejects(buy(ctx), shopErr("low_balance", (e) => e.faucet === null && !/https?:/.test(e.message) && /Not enough zkLTC/.test(e.message)));
  noTxSent(ctx);
});

test("buyPack low balance: the boundary is price + reserved gas, to the wei", async () => {
  const ctx = await setup();
  ctx.chain.setBalance(ALICE, PRICE + FEES - 1n);
  await assert.rejects(buy(ctx), shopErr("low_balance"));
  noTxSent(ctx);
  ctx.chain.setBalance(ALICE, PRICE + FEES);
  assert.equal((await buy(ctx)).packId, "1");
  // the reserve follows the network's gas price: at 10 gwei the same wallet is short
  const pricey = await setup();
  pricey.chain.st.gasPrice = 10_000_000_000n;
  pricey.chain.setBalance(ALICE, PRICE + FEES);
  await assert.rejects(buy(pricey), shopErr("low_balance", (e) => e.fees === 12_600_000n * 10_000_000_000n * 2n));
});

test("buyPack falls back to a 1 gwei reserve (and says so) when eth_gasPrice itself fails", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_gasPrice = () => { throw rpcError(-32601, "no such method"); };
  ctx.chain.setBalance(ALICE, PRICE);
  const c = captureConsole();
  try {
    await assert.rejects(buy(ctx), shopErr("low_balance", (e) => e.fees === 12_600_000n * 1_000_000_000n * 2n));
  } finally { c.restore(); }
  assert.ok(c.logs.some(([m, msg]) => m === "warn" && /eth_gasPrice failed/.test(msg)));
});

test("buyPack: every gas estimate is bumped by 25%, rounded up, and passed as the gas limit", async () => {
  for (const est of [1n, 2n, 3n, 21_000n, 180_000n, 8_000_000n, 9_999_999n]) {
    const ctx = await setup();
    ctx.chain.st.estimate = () => est;
    await buy(ctx);
    const gas = BigInt(ctx.chain.st.txs[0].gas);
    assert.equal(gas, est + (est + 3n) / 4n, `estimate ${est}`);
    assert.ok(gas * 4n >= est * 5n, "at least +25%");
    assert.ok(gas * 4n < est * 5n + 4n, "and never more than one unit over");
  }
});

test("buyPack: the player refusing, or a pending prompt, leaves everything retryable", async () => {
  const ctx = await setup();
  const stages = [];
  ctx.provider.once("eth_sendTransaction", providerError(4001, "MetaMask Tx Signature: User denied transaction signature."));
  await assert.rejects(buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s), ...FAST }), (e) => e instanceof WalletError && e.code === "user_rejected" && /cancelled/i.test(e.message));
  assert.deepEqual(stages, ["signing"], "signing was announced, pending never was");
  ctx.provider.once("eth_sendTransaction", providerError(-32002, "Already processing eth_sendTransaction."));
  await assert.rejects(buy(ctx), walletErr("request_pending"));
  ctx.provider.once("eth_sendTransaction", providerError(-32000, "insufficient funds for gas * price + value"));
  await assert.rejects(buy(ctx), (e) => e.code === "low_balance" && /liteforge\.hub\.caldera\.xyz/.test(e.message));
  assert.equal((await buy(ctx)).packId, "1", "the lock was released and the retry just works");
  assert.equal(ctx.chain.st.txs.length, 1);
});

test("buyPack: a double click cannot put two prompts in front of the player", async () => {
  const ctx = await setup();
  let release;
  ctx.provider.once("eth_sendTransaction", (params) => new Promise((resolve) => { release = () => resolve(ctx.chain.sendTransaction(params[0])); }));
  const first = buy(ctx);
  while (!release) await tick(1);
  await assert.rejects(buy(ctx), shopErr("busy", (e) => /already in progress/.test(e.message)));
  await assert.rejects(openPack(ctx.wallet, ctx.cfg, 1), shopErr("busy"), "one transaction at a time per wallet, of any kind");
  release();
  assert.equal((await first).packId, "1");
  assert.equal(ctx.chain.st.txs.length, 1);
  assert.equal((await buy(ctx)).packId, "2", "free again afterwards");
});

test("buyPack: a reverted receipt is explained by replaying the transaction (custom error name)", async () => {
  const ctx = await setup();
  ctx.chain.st.failNext = { name: "DailyLimitReached" };
  await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === "DailyLimitReached" && /^0x[0-9a-f]{64}$/.test(e.txHash) && e.selector === "0xf402e5b1"));
  const sims = ctx.chain.methods("eth_call").filter((c) => c.params[0].data === "0xc37b9bcd");
  assert.equal(sims.length, 1, "the replay used one eth_call");
  assert.equal(sims[0].params[0].from, A);
  assert.equal(sims[0].params[0].value, q(PRICE), "with the same value");
  assert.equal(sims[0].params[1], q(BigInt(ctx.chain.st.l2Block) - 1n), "at the block before the failed one");
  assert.equal(ctx.chain.st.txs.length, 1);
});

test("a failed transaction falls back to the latest state when historic state is pruned, then to out-of-gas, then to 'unknown'", async () => {
  // historic eth_call unavailable -> latest
  const pruned = await setup();
  pruned.chain.st.failNext = { name: "WrongPayment" };
  pruned.chain.st.hooks.eth_call = ([tx, tag], st) => { if (tag !== "latest" && tx.data === "0xc37b9bcd") throw rpcError(-32000, "missing trie node abc (path )"); };
  await assert.rejects(buy(pruned), shopErr("unavailable", (e) => e.reason === "WrongPayment"));
  assert.deepEqual(pruned.chain.methods("eth_call").filter((c) => c.params[0].data === "0xc37b9bcd").map((c) => c.params[1] === "latest"), [false, true]);

  // reverted with all gas used and nothing to replay: out of gas
  const oog = await setup();
  oog.chain.st.failNext = { outOfGas: true };
  await assert.rejects(buy(oog), shopErr("reverted", (e) => e.reason === "OutOfGas" && /ran out of gas/.test(e.message) && e.txHash));

  // reverted for a reason nobody can read
  const mystery = await setup();
  mystery.chain.st.failNext = {};
  await assert.rejects(buy(mystery), shopErr("reverted", (e) => e.reason === null && /reason the shop could not read/.test(e.message) && e.txHash));
});

test("buyPack: a revert at the estimate stage (state moved since the checks) is explained before any prompt", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_estimateGas = () => { throw revertRpcError("WrongPayment"); };
  const stages = [];
  await assert.rejects(buyPack(ctx.wallet, ctx.cfg, { onStage: (s) => stages.push(s) }), shopErr("unavailable", (e) => e.reason === "WrongPayment" && /price just changed/.test(e.message)));
  assert.deepEqual(stages, []);
  noTxSent(ctx);
  ctx.chain.st.hooks.eth_estimateGas = () => { throw revertRpcError("NotMinter"); };
  await assert.rejects(buy(ctx), shopErr("unavailable", (e) => e.reason === "NotMinter" && /cannot mint cards right now/.test(e.message) && /Nothing was charged/.test(e.message) && /tell the team/.test(e.message)));
  ctx.chain.st.hooks.eth_estimateGas = () => { throw rpcError(-32000, "execution reverted"); };   // no data at all
  await assert.rejects(buy(ctx), shopErr("reverted", (e) => e.reason === null));
  ctx.chain.st.hooks.eth_estimateGas = () => { throw rpcError(3, "execution reverted: sold out", "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["sold out"]).slice(2)); };
  await assert.rejects(buy(ctx), shopErr("reverted", (e) => e.reason === "Error" && /sold out/.test(e.message)));
  noTxSent(ctx);
});

test("buyPack: waiting for the receipt can time out or be abandoned, and the transaction hash survives both", async () => {
  const slow = await setup();
  slow.chain.st.receiptDelay = 1e9;
  const stages = [];
  await assert.rejects(
    buyPack(slow.wallet, slow.cfg, { onStage: (s) => stages.push(s), pollMs: 2, timeoutMs: 40 }),
    shopErr("timeout", (e) => /^0x[0-9a-f]{64}$/.test(e.txHash) && /may still go through/.test(e.message) && e.cause?.timeout),
  );
  assert.deepEqual(stages, ["signing", "pending"]);
  assert.equal(slow.chain.st.txs.length, 1);

  const gone = await setup();
  gone.chain.st.receiptDelay = 1e9;
  const ctl = new AbortController();
  const p = buy(gone, { signal: ctl.signal, timeoutMs: 60_000 });
  while (gone.chain.methods("eth_getTransactionReceipt").length < 2) await tick(1);
  ctl.abort();
  await assert.rejects(p, shopErr("aborted", (e) => /^0x[0-9a-f]{64}$/.test(e.txHash) && /already sent/.test(e.message)));
});

test("onStage / onTick callbacks that throw cannot derail a purchase", async () => {
  const ctx = await setup();
  const c = captureConsole();
  try {
    const r = await buyPack(ctx.wallet, ctx.cfg, { onStage() { throw new Error("UI bug"); }, ...FAST });
    assert.equal(r.packId, "1");
    ctx.chain.mineL1(2);
    await waitUntilOpenable(ctx.cfg, r.packId, { onTick() { throw new Error("UI bug"); }, pollMs: 2 });
    const opened = await openPack(ctx.wallet, ctx.cfg, r.packId, { onStage() { throw new Error("UI bug"); }, ...FAST });
    assert.equal(opened.tokenIds.length, 5);
  } finally { c.restore(); }
  assert.ok(c.logs.filter(([m, msg]) => m === "error" && /callback threw/.test(msg)).length >= 5, "every throw was logged, none swallowed");
});

// ------------------------------------------------------------------ waitUntilOpenable
test("waitUntilOpenable resolves the moment the pack becomes Openable, ticking on every poll", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  const { packId } = await buy(ctx);
  let polls = 0;
  chain.st.hooks.eth_call = ([tx]) => { if (tx.data.startsWith("0x9a243ebf") && ++polls === 3) chain.mineL1(2); };   // the chain moves on during poll 3
  const ticks = [];
  const t0 = Date.now();
  const done = await waitUntilOpenable(cfg, packId, { pollMs: 10, onTick: (t) => ticks.push(t) });
  assert.equal(done.phase, PHASE.Openable);
  assert.equal(done.phaseName, "Openable");
  assert.ok(done.waitedMs >= 12 && done.waitedMs <= Date.now() - t0);
  assert.deepEqual(ticks.map((t) => t.phase), [1, 1, 2]);
  assert.deepEqual(ticks.map((t) => t.phaseName), ["Waiting", "Waiting", "Openable"]);
  assert.deepEqual(ticks.map((t) => t.attempt), [0, 1, 2]);
  assert.ok(ticks.every((t) => t.error === null && typeof t.elapsedMs === "number"));
  assert.ok(ticks[2].elapsedMs >= 12, "polls are pollMs apart");
  JSON.stringify(done);
});

test("waitUntilOpenable returns at once for a pack that is already Openable", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.chain.mineL1(5);
  const ticks = [];
  const r = await waitUntilOpenable(ctx.cfg, packId, { pollMs: 5000, onTick: (t) => ticks.push(t) });
  assert.equal(r.phase, PHASE.Openable);
  assert.equal(ticks.length, 1);
});

test("waitUntilOpenable rejects with a typed error when the pack can never open", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  // Expired
  const expired = await buy(ctx);
  chain.mineL1(300);
  await assert.rejects(waitUntilOpenable(cfg, expired.packId, { pollMs: 2 }), shopErr("pack_expired", (e) => e.phase === 3 && e.phaseName === "Expired" && /refund/.test(e.message)));
  // Refunded
  await refundExpired(wallet, cfg, expired.packId, FAST);
  await assert.rejects(waitUntilOpenable(cfg, expired.packId, { pollMs: 2 }), shopErr("pack_refunded", (e) => e.phase === 5 && /refunded/.test(e.message)));
  // Opened
  const second = await buy(ctx);
  chain.mineL1(2);
  await openPack(wallet, cfg, second.packId, FAST);
  await assert.rejects(waitUntilOpenable(cfg, second.packId, { pollMs: 2 }), shopErr("pack_opened", (e) => e.phase === 4 && /already been opened/.test(e.message)));
  // None: there is no such pack (after the grace for a lagging node)
  const ticks = [];
  await assert.rejects(waitUntilOpenable(cfg, 999, { pollMs: 2, noneGrace: 2, onTick: (t) => ticks.push(t.phase) }), shopErr("pack_none", (e) => e.phase === 0 && /does not exist/.test(e.message)));
  assert.deepEqual(ticks, [0, 0, 0], "two polls of grace, the third answer is final");
});

test("waitUntilOpenable gives a lagging RPC node time to see a brand-new pack", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.chain.mineL1(2);
  let n = 0;
  ctx.chain.st.hooks.eth_call = ([tx]) => { if (tx.data.startsWith("0x9a243ebf") && ++n <= 2) return "0x" + "00".repeat(32); };   // the node behind the load balancer says None twice
  const phases = [];
  const r = await waitUntilOpenable(ctx.cfg, packId, { pollMs: 2, onTick: (t) => phases.push(t.phase) });
  assert.equal(r.phase, PHASE.Openable);
  assert.deepEqual(phases, [0, 0, 2]);
});

test("waitUntilOpenable can be cancelled: between polls, mid-request, and up front", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  const ctl = new AbortController();
  const ticks = [];
  const p = waitUntilOpenable(ctx.cfg, packId, { pollMs: 30, signal: ctl.signal, onTick: (t) => ticks.push(t) });
  while (!ticks.length) await tick(1);
  ctl.abort();
  await assert.rejects(p, shopErr("aborted"));
  const after = ticks.length;
  await tick(60);
  assert.equal(ticks.length, after, "no polling continues after the abort");
  await assert.rejects(waitUntilOpenable(ctx.cfg, packId, { signal: ctl.signal }), shopErr("aborted"), "already aborted");

  const hung = { ...ctx.cfg, client: createChain(RPC, { fetch: hangingFetch(), timeoutMs: 60_000 }) };
  const ctl2 = new AbortController();
  const p2 = waitUntilOpenable(hung, packId, { pollMs: 5, signal: ctl2.signal });
  await tick(10);
  ctl2.abort();
  await assert.rejects(p2, shopErr("aborted"));
});

test("waitUntilOpenable rides out a few network failures, and reports them in the ticks", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.chain.mineL1(2);
  let down = 2;
  const flaky = { ...ctx.cfg, client: createChain(RPC, { fetch: async (u, i) => (down-- > 0 ? new Response("bad gateway", { status: 502 }) : ctx.chain.fetch(u, i)), retries: 0, backoffMs: 1 }) };
  const ticks = [];
  const r = await waitUntilOpenable(flaky, packId, { pollMs: 2, onTick: (t) => ticks.push(t) });
  assert.equal(r.phase, PHASE.Openable);
  assert.deepEqual(ticks.map((t) => t.phase), [null, null, 2]);
  assert.deepEqual(ticks.map((t) => t.phaseName), [null, null, "Openable"]);
  assert.ok(ticks[0].error instanceof ShopError && ticks[0].error.code === "rpc", "the failure is visible to the UI");

  // ... but not forever
  const dead = { ...ctx.cfg, client: createChain(RPC, { fetch: async () => new Response("down", { status: 503 }), retries: 0, backoffMs: 1 }) };
  let seen = 0;
  await assert.rejects(waitUntilOpenable(dead, packId, { pollMs: 1, maxFailures: 3, onTick: () => seen++ }), shopErr("rpc"));
  assert.equal(seen, 2, "two tolerated, the third failure is thrown");
});

test("waitUntilOpenable rejects bad input at once and does not loop on non-network errors", async () => {
  const ctx = await setup();
  await assert.rejects(waitUntilOpenable(ctx.cfg, "abc"), AbiError);
  await assert.rejects(waitUntilOpenable(ctx.cfg, -1), AbiError);
  await assert.rejects(waitUntilOpenable(null, 1), shopErr("not_configured"));
  ctx.chain.st.hooks.eth_call = () => "0x";
  const t0 = Date.now();
  await assert.rejects(waitUntilOpenable(ctx.cfg, 1, { pollMs: 1000 }), shopErr("not_configured"), "a missing contract is final");
  assert.ok(Date.now() - t0 < 500);
  ctx.chain.st.hooks.eth_call = () => "0x" + "00".repeat(31) + "09";
  await assert.rejects(waitUntilOpenable(ctx.cfg, 1, { pollMs: 1000 }), shopErr("bad_response"), "an unreadable answer is final too");
});

// ------------------------------------------------------------------ openPack
test("openPack: end to end - waits for Openable, sends openPack(id) with headroom, decodes the five cards", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const bought = await buy(ctx);
  await waitUntilOpenable(cfg, bought.packId, { pollMs: 5, onTick: () => chain.mineL1(1) });    // one parent-chain block per tick, like ~12 s

  const stages = [];
  chain.st.receiptDelay = 2;
  const opened = await openPack(wallet, cfg, bought.packId, { onStage: (s) => stages.push(s), ...FAST });
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.deepEqual(Object.keys(opened).sort(), ["templateIds", "tokenIds", "txHash"]);
  const base = 7n << 32n;
  assert.deepEqual(opened.tokenIds, [0n, 1n, 2n, 3n, 4n].map((i) => String(base + i)));
  assert.ok(opened.tokenIds.every((t) => typeof t === "string" && /^\d+$/.test(t)));
  assert.deepEqual(opened.templateIds, [0, 1, 2, 3, 4].map((i) => (1 * 7 + i * 3) % 12));
  assert.ok(opened.templateIds.every((t) => Number.isInteger(t)));
  assert.match(opened.txHash, /^0x[0-9a-f]{64}$/);
  JSON.stringify(opened);

  const tx = chain.st.txs.at(-1);
  assert.equal(tx.to, SHOP);
  assert.equal(tx.from, A);
  assert.equal(tx.data, shopIface.encodeFunctionData("openPack", [1n]));
  assert.equal(tx.value, undefined, "opening is free");
  assert.equal(tx.gas, q(9_250_000n), "7.4M estimated -> 9.25M limit");
  assert.equal(chain.st.packs.get(1n).state, "opened");
  assert.equal(await phaseOf(cfg, bought.packId), PHASE.Opened);
});

test("openPack passes eth_estimateGas + 25% for a range of estimates (five-card mints are 5-10M gas)", async () => {
  for (const est of [5_000_000n, 7_400_000n, 10_000_000n, 10_000_001n]) {
    const ctx = await setup();
    const { packId } = await buy(ctx);
    ctx.chain.mineL1(2);
    ctx.chain.st.estimate = () => est;
    await openPack(ctx.wallet, ctx.cfg, packId, FAST);
    const gas = BigInt(ctx.chain.st.txs.at(-1).gas);
    assert.equal(gas, gasBump(est));
    assert.ok(gas >= (est * 125n) / 100n, `at least +25% for ${est}`);
  }
});

test("openPack accepts the pack id as a string, number or bigint, and keeps huge token ids exact", async () => {
  for (const idOf of [(id) => id, (id) => Number(id), (id) => BigInt(id)]) {
    const ctx = await setup();
    const { packId } = await buy(ctx);
    ctx.chain.mineL1(2);
    ctx.chain.st.tokenCounter = 2n ** 200n;
    const opened = await openPack(ctx.wallet, ctx.cfg, idOf(packId), FAST);
    assert.equal(opened.tokenIds[0], String((7n << 32n) + 2n ** 200n), "beyond 2^53: decimal strings never lose a digit");
    assert.equal(opened.tokenIds[4], String((7n << 32n) + 2n ** 200n + 4n));
  }
  const ctx = await setup();
  for (const bad of ["abc", -1, 1.5, null, undefined, {}, "0x"]) {
    await assert.rejects(openPack(ctx.wallet, ctx.cfg, bad, FAST), AbiError, String(bad));
  }
  noTxSent(ctx);
});

test("openPack: anyone may open a pack, the cards belong to the buyer", async () => {
  const alice = await setup();
  const { packId } = await buy(alice);
  alice.chain.mineL1(2);
  // BOB, on the same chain, opens ALICE's pack
  const provider = createMockProvider({ chain: alice.chain, accounts: [BOB] });
  alice.chain.setBalance(BOB, 10n * ETH);
  const bob = createWallet({ provider, storage: memoryStorage(), chain: chainFromConfig(alice.cfg) });
  await bob.connect();
  const opened = await openPack(bob, alice.cfg, packId, FAST);
  assert.equal(opened.tokenIds.length, 5);
  const log = alice.chain.st.logs.find((l) => l.topics[0] === TOPICS.PackOpened);
  assert.equal(ethers.getAddress("0x" + log.topics[2].slice(26)), ALICE, "PackOpened names the buyer");
  assert.equal(alice.chain.st.txs.at(-1).from, BOB.toLowerCase());
});

test("openPack: a pack that is not openable is explained without troubling the wallet", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const stages = [];
  const attempt = (id) => openPack(wallet, cfg, id, { onStage: (s) => stages.push(s), ...FAST });
  const p1 = await buy(ctx);
  await assert.rejects(attempt(p1.packId), shopErr("pack_waiting", (e) => e.phase === 1 && /not ready yet/.test(e.message)));
  await assert.rejects(attempt(999), shopErr("pack_none", (e) => /does not exist/.test(e.message)));
  chain.mineL1(300);
  await assert.rejects(attempt(p1.packId), shopErr("pack_expired", (e) => /refund/.test(e.message)));
  await refundExpired(wallet, cfg, p1.packId, FAST);
  await assert.rejects(attempt(p1.packId), shopErr("pack_refunded"));
  const p2 = await buy(ctx);
  chain.mineL1(2);
  await attempt(p2.packId);
  await assert.rejects(attempt(p2.packId), shopErr("pack_opened", (e) => /cards are in your wallet/.test(e.message)));
  assert.equal(chain.st.txs.length, 4, "buy, refund, buy, open: none of the refused attempts sent a transaction");
  assert.deepEqual(stages, ["signing", "pending", "confirmed"], "only the one real open ever reached the wallet");
});

test("openPack: reverts are named - at the estimate (TooEarly), and after the send (replayed)", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const { packId } = await buy(ctx);
  chain.mineL1(2);
  // the node's clock disagrees with the phase check we just made: TooEarly at the estimate
  chain.st.hooks.eth_estimateGas = () => { throw revertRpcError("TooEarly"); };
  const stages = [];
  await assert.rejects(openPack(wallet, cfg, packId, { onStage: (s) => stages.push(s) }), shopErr("reverted", (e) => e.reason === "TooEarly" && /not ready to open yet/.test(e.message)));
  assert.deepEqual(stages, []);
  delete chain.st.hooks.eth_estimateGas;
  assert.equal(chain.st.txs.length, 1, "only the buy so far");

  // the pack is opened by someone else between the estimate and the send: the receipt says failed, the replay says NotSealed
  chain.st.failNext = { name: "NotSealed" };
  await assert.rejects(openPack(wallet, cfg, packId, FAST), shopErr("reverted", (e) => e.reason === "NotSealed" && /already been opened or refunded/.test(e.message) && /^0x[0-9a-f]{64}$/.test(e.txHash)));
  // Expired at the estimate
  chain.st.hooks.eth_estimateGas = () => { throw revertRpcError("Expired"); };
  await assert.rejects(openPack(wallet, cfg, packId, FAST), shopErr("reverted", (e) => e.reason === "Expired" && /Claim the refund/.test(e.message)));
});

test("openPack: the receipt must carry this pack's PackOpened", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.chain.mineL1(2);
  ctx.chain.st.hooks.eth_getTransactionReceipt = ([hash], st) => {
    const r = st.receipts.get(hash);
    if (!r) return undefined;
    // a PackOpened for another pack only
    const wrong = { ...r.logs[0], ...shopIface.encodeEventLog(shopIface.getEvent("PackOpened"), [55n, ALICE, [1n], [1]]) };
    return { ...r, logs: r.logs.map(() => wrong) };
  };
  await assert.rejects(openPack(ctx.wallet, ctx.cfg, packId, FAST), shopErr("bad_response", (e) => /PackOpened event is missing/.test(e.message)));
});

// ------------------------------------------------------------------ refundExpired
test("refundExpired: claims the price of a pack that was never opened", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const { packId } = await buy(ctx);
  chain.mineL1(300);
  const stages = [];
  const r = await refundExpired(wallet, cfg, packId, { onStage: (s) => stages.push(s), ...FAST });
  assert.deepEqual(stages, ["signing", "pending", "confirmed"]);
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(r.amount, PRICE);
  assert.equal(typeof r.amount, "bigint");
  assert.equal(chain.st.txs.at(-1).data, shopIface.encodeFunctionData("refundExpired", [1n]));
  assert.equal(chain.st.txs.at(-1).gas, q(gasBump(90_000n)));
  assert.equal(await phaseOf(cfg, packId), PHASE.Refunded);
});

test("refundExpired: refuses politely unless the pack is Expired", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  const p = await buy(ctx);
  await assert.rejects(refundExpired(wallet, cfg, p.packId, FAST), shopErr("pack_waiting", (e) => /still waiting to be opened/.test(e.message)));
  chain.mineL1(2);
  await assert.rejects(refundExpired(wallet, cfg, p.packId, FAST), shopErr("pack_openable", (e) => /can still be opened/.test(e.message)));
  await openPack(wallet, cfg, p.packId, FAST);
  await assert.rejects(refundExpired(wallet, cfg, p.packId, FAST), shopErr("pack_opened", (e) => /nothing to refund/.test(e.message)));
  await assert.rejects(refundExpired(wallet, cfg, 404, FAST), shopErr("pack_none"));
  assert.equal(chain.st.txs.length, 2, "buy + open only");
  const late = await buy(ctx);
  chain.mineL1(300);
  chain.st.failNext = { name: "TransferFailed" };
  await assert.rejects(refundExpired(wallet, cfg, late.packId, FAST), shopErr("reverted", (e) => e.reason === "TransferFailed" && /refund could not be sent/.test(e.message)));
});

// ------------------------------------------------------------------ findMyPacks (one eth_call to the contract's per-buyer index)
test("findMyPacks: this buyer's packs after a reload, oldest first, with their current phase", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.setBalance(BOB, 10n * ETH);
  const bobProvider = createMockProvider({ chain, accounts: [BOB] });
  const bob = createWallet({ provider: bobProvider, storage: memoryStorage(), chain: chainFromConfig(cfg) });
  await bob.connect();

  const a1 = await buy(ctx);                                  // ALICE #1: will expire
  chain.mineL1(300);
  const b1 = await buyPack(bob, cfg, FAST);                    // BOB #2
  const a2 = await buy(ctx);                                  // ALICE #3: will be opened
  chain.mineL1(2);
  await openPack(wallet, cfg, a2.packId, FAST);
  const a3 = await buy(ctx);                                  // ALICE #4: still waiting
  assert.deepEqual([a1.packId, b1.packId, a2.packId, a3.packId], ["1", "2", "3", "4"]);

  const mine = await findMyPacks(cfg, ALICE);
  assert.deepEqual(mine, [
    { packId: "1", phase: PHASE.Expired, phaseName: "Expired", commitBlock: 5_000_000 },
    { packId: "3", phase: PHASE.Opened, phaseName: "Opened", commitBlock: 5_000_300 },
    { packId: "4", phase: PHASE.Waiting, phaseName: "Waiting", commitBlock: 5_000_302 },
  ]);
  assert.ok(mine.every((p) => typeof p.packId === "string" && typeof p.commitBlock === "number"));
  assert.deepEqual(mine.map((p) => Object.keys(p)), Array(3).fill(["packId", "phase", "phaseName", "commitBlock"]), "the shape callers already use");
  JSON.stringify(mine);
  assert.deepEqual((await findMyPacks(cfg, BOB)).map((p) => p.packId), ["2"]);
  assert.deepEqual(await findMyPacks(cfg, "0x" + "11".repeat(20)), []);
  assert.deepEqual((await findMyPacks(cfg, ALICE.toLowerCase())).map((p) => p.packId), ["1", "3", "4"], "any address casing");
  // and the resume decision the UI makes
  const resumable = mine.filter((p) => p.phase === PHASE.Waiting || p.phase === PHASE.Openable);
  assert.deepEqual(resumable.map((p) => p.packId), ["4"]);
  // commitBlock is the contract's own (parent-chain) number, unrelated to the RPC's L2 block number
  assert.ok(mine.every((p) => p.commitBlock >= 5_000_000) && chain.st.l2Block < 5_000_000);
});

test("findMyPacks is ONE eth_call to recentPacks(address, 16): no log scan, no block numbers, no per-pack lookups, no wallet", async () => {
  const ctx = await setup();
  for (let i = 0; i < 3; i++) await buy(ctx);
  ctx.chain.st.calls.length = 0;
  ctx.provider.calls.length = 0;
  const packs = await findMyPacks(ctx.cfg, ALICE);
  assert.equal(packs.length, 3);
  assert.equal(ctx.chain.st.calls.length, 1, "exactly one JSON-RPC request, however many packs");
  const [call] = ctx.chain.st.calls;
  assert.equal(call.method, "eth_call");
  assert.deepEqual(call.params, [{ to: SHOP, data: shopIface.encodeFunctionData("recentPacks", [ALICE, 16]) }, "latest"]);
  assert.equal(call.params[0].data.slice(0, 10), "0xd3ee9e8d");
  assert.equal(call.params[0].data.slice(-64), "0".repeat(62) + "10", "n = 16, the contract's cap");
  for (const m of ["eth_getLogs", "eth_blockNumber", "eth_getBlockByNumber"]) assert.equal(ctx.chain.methods(m).length, 0, m);
  assert.equal(ctx.provider.calls.length, 0, "reads never touch the wallet");
});

test("findMyPacks reports every phase the contract has", async () => {
  const ctx = await setup();
  const { chain, cfg, wallet } = ctx;
  chain.st.cfg.dailyLimit = 0;
  const p1 = await buy(ctx);                     // -> Refunded
  chain.mineL1(300);
  await refundExpired(wallet, cfg, p1.packId, FAST);
  await buy(ctx);                                // -> Expired (never refunded)
  chain.mineL1(300);
  const p3 = await buy(ctx);                     // -> Opened
  chain.mineL1(2);
  await openPack(wallet, cfg, p3.packId, FAST);
  await buy(ctx);                                // -> Openable
  chain.mineL1(2);
  await buy(ctx);                                // -> Waiting
  const packs = await findMyPacks(cfg, ALICE);
  assert.deepEqual(packs.map((p) => [p.packId, p.phase, p.phaseName]), [
    ["1", 5, "Refunded"], ["2", 3, "Expired"], ["3", 4, "Opened"], ["4", 2, "Openable"], ["5", 1, "Waiting"],
  ]);
  assert.deepEqual(packs.map((p) => p.phase), [PHASE.Refunded, PHASE.Expired, PHASE.Opened, PHASE.Openable, PHASE.Waiting]);
  // what a page resumes / offers
  assert.deepEqual(packs.filter((p) => p.phase === PHASE.Expired).map((p) => p.packId), ["2"], "a refund to offer");
  assert.deepEqual(packs.filter((p) => p.phase === PHASE.Waiting || p.phase === PHASE.Openable).map((p) => p.packId), ["4", "5"], "packs to resume");
});

test("findMyPacks: none, exactly 16, and more than 16 (the newest 16, oldest first)", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  chain.st.cfg.dailyLimit = 0;
  assert.deepEqual(await findMyPacks(cfg, ALICE), [], "a buyer with no packs");
  for (let i = 0; i < 16; i++) await buy(ctx);
  let packs = await findMyPacks(cfg, ALICE);
  assert.deepEqual(packs.map((p) => p.packId), Array.from({ length: 16 }, (_, i) => String(i + 1)));
  for (let i = 0; i < 4; i++) await buy(ctx);
  packs = await findMyPacks(cfg, ALICE);
  assert.equal(packs.length, 16);
  assert.deepEqual(packs.map((p) => p.packId), Array.from({ length: 16 }, (_, i) => String(i + 5)), "the newest 16 (5..20), oldest first");
});

test("findMyPacks: every failure is reported, never a partial answer", async () => {
  const ctx = await setup();
  await buy(ctx);
  const { chain, cfg } = ctx;
  const answer = (hex) => { chain.st.hooks.eth_call = ([tx]) => (tx.data.startsWith("0xd3ee9e8d") ? hex : undefined); };
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");

  answer("0x1234");                                                             // not whole words
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response", (e) => e.cause instanceof AbiError));
  answer("0x" + w(0x60) + w(0x80) + w(0xa0) + w(2) + w(0) + w(0));            // ids 2, phases 0, commitBlocks 0
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response", (e) => /differ in length/.test(e.cause?.message)));
  answer(shopIface.encodeFunctionResult("recentPacks", [[1n], [9], [5n]]));     // a phase this client does not know
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response", (e) => /unknown pack state \(9\)/.test(e.message)));
  answer(shopIface.encodeFunctionResult("recentPacks", [[1n, 2n], [1, 6], [5n, 6n]]));   // one good entry does not rescue a bad one
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("bad_response"));

  delete chain.st.hooks.eth_call;
  await assert.rejects(findMyPacks({ ...cfg, packShop: BOB }, ALICE), shopErr("not_configured", (e) => /not found on this network/.test(e.message)));

  // a deployment from before the pack index: the view reverts with no reason (geth / Nitro style, then Hardhat's wording)
  for (const boom of [rpcError(3, "execution reverted"), rpcError(-32603, "Transaction reverted: function selector was not recognized and there is no fallback function")]) {
    chain.st.hooks.eth_call = ([tx]) => { if (tx.data.startsWith("0xd3ee9e8d")) throw boom; };
    await assert.rejects(findMyPacks(cfg, ALICE), shopErr("not_configured", (e) => /before pack lookup existed/.test(e.message) && /newer deployment/.test(e.message) && e.cause && e.packShop === SHOP));
  }
  // ... but a revert that names a reason is that reason, not "old deployment"
  chain.st.hooks.eth_call = ([tx]) => { if (tx.data.startsWith("0xd3ee9e8d")) throw revertRpcError("TooEarly"); };
  await assert.rejects(findMyPacks(cfg, ALICE), shopErr("reverted", (e) => e.reason === "TooEarly"));
  delete chain.st.hooks.eth_call;

  const down = { ...cfg, client: createChain(RPC, { fetch: async () => { throw new TypeError("Failed to fetch"); }, backoffMs: 1, retries: 1 }) };
  await assert.rejects(findMyPacks(down, ALICE), shopErr("rpc", (e) => /Could not reach the LitVM Liteforge network/.test(e.message)));
});

test("findMyPacks validates its input and passes call options (the abort signal) through", async () => {
  const ctx = await setup();
  const { chain, cfg } = ctx;
  chain.st.calls.length = 0;
  for (const bad of ["nope", "0x1234", undefined, null, 5]) {
    await assert.rejects(findMyPacks(cfg, bad), TypeError, String(bad));
  }
  await assert.rejects(findMyPacks(null, ALICE), shopErr("not_configured"));
  await assert.rejects(findMyPacks({ ...cfg, packShop: undefined }, ALICE), shopErr("not_configured"));
  assert.equal(chain.st.calls.length, 0, "nothing was sent for bad input");
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(findMyPacks(cfg, ALICE, { signal: ctl.signal }), shopErr("aborted"));
  assert.equal(chain.st.calls.length, 0, "an aborted call never leaves");
});

// ------------------------------------------------------------------ formatZkltc
test("formatZkltc: display rules for wei amounts", () => {
  const table = [
    [0n, undefined, undefined, "0"],
    [10n ** 18n, undefined, undefined, "1"],
    [10n ** 17n, undefined, undefined, "0.1"],
    [ETH * 12345n / 10n, undefined, undefined, "1234.5"],
    [123456789012345678n, undefined, undefined, "0.1235"],
    [123456789012345678n, 4, "floor", "0.1234"],
    [123456789012345678n, 4, "ceil", "0.1235"],
    [123450000000000000n, 4, "ceil", "0.1235"],
    [123450000000000000n, 4, "nearest", "0.1235"],
    [123449999999999999n, 4, "nearest", "0.1234"],
    [5n * 10n ** 13n, 4, "nearest", "0.0001"],
    [49_999_999_999_999n, 4, "nearest", "<0.0001"],
    [49_999_999_999_999n, 4, "floor", "<0.0001"],
    [49_999_999_999_999n, 4, "ceil", "0.0001"],
    [1n, undefined, undefined, "<0.0001"],
    [1n, 18, undefined, "0.000000000000000001"],
    [10n ** 18n, 0, undefined, "1"],
    [5n * 10n ** 17n, 0, "nearest", "1"],
    [5n * 10n ** 17n, 0, "floor", "<1"],
    [12345678901234567890123n, 4, undefined, "12345.6789"],
    [999999999999999999n, 4, "nearest", "1"],
    [999999999999999999n, 4, "floor", "0.9999"],
    [-(10n ** 17n), undefined, undefined, "-0.1"],
    [-1n, undefined, undefined, "-<0.0001"],
    [1_000_000_000_000_000, undefined, undefined, "0.001"],
    ["100000000000000000", undefined, undefined, "0.1"],
    ["0x16345785d8a0000", undefined, undefined, "0.1"],
    [10n ** 17n, 99, undefined, "0.1"],
    [10n ** 18n, -3, undefined, "1"],
    [10n ** 17n, -3, undefined, "<1"],
    [123456789012345678n, 2, "ceil", "0.13"],
  ];
  for (const [wei, digits, mode, expected] of table) {
    assert.equal(formatZkltc(wei, digits, mode), expected, `${String(wei)} digits=${digits} mode=${mode}`);
  }
  assert.throws(() => formatZkltc(1.5), AbiError);
  assert.throws(() => formatZkltc("banana"), AbiError);
  assert.throws(() => formatZkltc(undefined), AbiError);
});

test("formatZkltc: floor never overstates, ceil never understates, nearest is within half a unit (property check)", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 400; i++) {
    const wei = BigInt(Math.floor(rnd() * 1e15)) * BigInt(Math.floor(rnd() * 1e4) + 1) + BigInt(Math.floor(rnd() * 1e6));
    const digits = Math.floor(rnd() * 7);
    const parse = (s) => (s.startsWith("<") ? null : ethers.parseUnits(s, 18));
    const lo = parse(formatZkltc(wei, digits, "floor")), hi = parse(formatZkltc(wei, digits, "ceil")), mid = parse(formatZkltc(wei, digits, "nearest"));
    const unit = 10n ** BigInt(18 - digits);
    if (lo !== null) assert.ok(lo <= wei && wei - lo < unit, `floor ${wei} ${digits}`);
    if (hi !== null) assert.ok(hi >= wei && hi - wei < unit, `ceil ${wei} ${digits}`);
    if (mid !== null) assert.ok((mid > wei ? mid - wei : wei - mid) * 2n <= unit, `nearest ${wei} ${digits}`);
  }
});

// ------------------------------------------------------------------ network fee caps (live bug, Liteforge 2026-10-02)
// A real wallet bid maxFeePerGas 10000000 (the chain's floor) against a base fee of 10009000 and the second signature of a
// pack failed. The client now passes explicit caps (2x the gas price) instead of leaving the fee to the wallet.
test("buyPack and openPack pass explicit EIP-1559 caps: 2x the gas price and the node's tip", async () => {
  const ctx = await setup();
  ctx.chain.st.gasPrice = 10_386_000n;                              // Liteforge's gas price when this broke
  ctx.chain.st.hooks.eth_maxPriorityFeePerGas = () => q(0);
  const { packId } = await buy(ctx);
  const buyTx = ctx.chain.st.txs[0];
  assert.equal(buyTx.maxFeePerGas, q(2n * 10_386_000n));
  assert.equal(buyTx.maxPriorityFeePerGas, "0x0");
  ctx.chain.mineL1(3);
  await openPack(ctx.wallet, ctx.cfg, packId, FAST);
  const openTx = ctx.chain.st.txs[1];
  assert.equal(openTx.maxFeePerGas, q(2n * 10_386_000n));
  assert.equal(openTx.maxPriorityFeePerGas, "0x0");
});

test("a node without eth_maxPriorityFeePerGas still gets a cap and a zero tip", async () => {
  const ctx = await setup();                                         // the fake answers -32601 for the method by default
  await buy(ctx);
  const t = ctx.chain.st.txs[0];
  assert.equal(t.maxPriorityFeePerGas, "0x0");
  assert.equal(t.maxFeePerGas, q(2n * ctx.chain.st.gasPrice));
});

test("the tip never exceeds the cap", async () => {
  const ctx = await setup();
  ctx.chain.st.gasPrice = 1_000n;
  ctx.chain.st.hooks.eth_maxPriorityFeePerGas = () => q(5_000_000_000n);
  await buy(ctx);
  const t = ctx.chain.st.txs[0];
  assert.equal(t.maxFeePerGas, q(2_000n));
  assert.equal(t.maxPriorityFeePerGas, t.maxFeePerGas);
});

test("when the node cannot say what gas costs, no fee fields are sent and the wallet decides", async () => {
  const ctx = await setup();
  ctx.chain.st.hooks.eth_gasPrice = () => { throw rpcError(-32601, "no such method"); };
  const c = captureConsole();
  try { await buy(ctx); } finally { c.restore(); }
  const t = ctx.chain.st.txs[0];
  assert.equal("maxFeePerGas" in t, false);
  assert.equal("maxPriorityFeePerGas" in t, false);
});

test("regression: a wallet that bids the chain's floor fee no longer breaks the purchase or the second signature", async () => {
  const ctx = await setup();
  const FLOOR = 10_000_000n, BASE_FEE = 10_009_000n;                 // exactly the numbers from the failure
  ctx.chain.st.gasPrice = 10_386_000n;
  // a wallet that honours a dApp-supplied cap but otherwise bids exactly the floor, on a chain whose base fee drifted above it
  const wallet = (params) => {
    const tx = params[0];
    const bid = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : FLOOR;
    if (bid < BASE_FEE) {
      throw providerError(-32603, `RPC 0x1159 Custom eth_sendRawTransaction: max fee per gas less than block base fee: address ${A}, maxFeePerGas: ${bid} baseFee: ${BASE_FEE}`);
    }
    return ctx.chain.sendTransaction(tx);
  };
  // the same wallet refuses a plain send with no caps (what the old client did) ...
  ctx.provider.once("eth_sendTransaction", wallet);
  await assert.rejects(ctx.wallet.sendTransaction({ to: SHOP, data: "0xc37b9bcd", value: PRICE }), walletErr("fee_too_low", (e) => /Nothing was charged/.test(e.message)));
  assert.equal(ctx.chain.st.txs.length, 0);
  // ... but the shop's own purchase and open go through
  ctx.provider.once("eth_sendTransaction", wallet);
  const { packId } = await buy(ctx);
  ctx.chain.mineL1(3);
  ctx.provider.once("eth_sendTransaction", wallet);
  const opened = await openPack(ctx.wallet, ctx.cfg, packId, FAST);
  assert.equal(opened.tokenIds.length, 5);
});

test("a wallet that ignores our caps and refuses on the base fee leaves the pack sealed, with a clear message", async () => {
  const ctx = await setup();
  const { packId } = await buy(ctx);
  ctx.chain.mineL1(3);
  ctx.provider.once("eth_sendTransaction", providerError(-32603, "RPC 0x1159 Custom eth_sendRawTransaction: max fee per gas less than block base fee: address 0x729A7da21DF1252E724C67Be415f36f2E1a9f626, maxFeePerGas: 10000000 baseFee: 10009000"));
  await assert.rejects(openPack(ctx.wallet, ctx.cfg, packId, FAST), walletErr("fee_too_low", (e) => /Nothing was charged/.test(e.message)));
  assert.equal(await phaseOf(ctx.cfg, packId), PHASE.Openable, "the pack is untouched and can be opened on the next try");
  const opened = await openPack(ctx.wallet, ctx.cfg, packId, FAST);      // the retry works
  assert.equal(opened.tokenIds.length, 5);
});
