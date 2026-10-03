// wallet.js against a mock EIP-1193 provider / mock EIP-6963 window: discovery, connect/restore/disconnect, chain
// switching, events, signing, sending, and the normalised errors.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LITEFORGE, WALLET_ERROR_CODES, WalletError, createWallet, discoverProviders, pickProvider, normalizeError, chainParams, parseChainId,
} from "../wallet.js";
import {
  ethers, ALICE, BOB, SHOP, createMockProvider, createMockWindow, walletInfo, memoryStorage, providerError, tick, flushMicrotasks, captureConsole,
} from "./helpers.mjs";

const A = ALICE.toLowerCase();
const HASH = "0x" + "12".repeat(32);
const kinds = () => { const seen = []; return { seen, fn: (s, kind) => seen.push([kind, s]) }; };
/** A wallet on the given provider with private storage. */
function make(provider = createMockProvider(), extra = {}) {
  const storage = extra.storage === undefined ? memoryStorage() : extra.storage;
  const wallet = createWallet({ provider, storage, ...extra });
  return { wallet, provider, storage };
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof WalletError && e.code === code, `expected WalletError ${code}`);

// ------------------------------------------------------------------ constants
test("LITEFORGE describes chain 4441 exactly as the wallet needs it", () => {
  assert.equal(LITEFORGE.chainId, 4441);
  assert.equal(LITEFORGE.chainIdHex, "0x1159");
  assert.equal(LITEFORGE.chainIdHex, ethers.toQuantity(4441));
  assert.equal(LITEFORGE.name, "LitVM Liteforge");
  assert.deepEqual({ ...LITEFORGE.nativeCurrency }, { name: "zkLTC", symbol: "zkLTC", decimals: 18 });
  assert.deepEqual([...LITEFORGE.rpcUrls], ["https://liteforge.rpc.caldera.xyz/http"]);
  assert.equal(LITEFORGE.explorer, "https://liteforge.explorer.caldera.xyz");
  assert.equal(LITEFORGE.faucet, "https://liteforge.hub.caldera.xyz");
  assert.ok(Object.isFrozen(LITEFORGE) && Object.isFrozen(LITEFORGE.rpcUrls) && Object.isFrozen(LITEFORGE.nativeCurrency));
  assert.deepEqual(chainParams(createWallet({ provider: createMockProvider() }).chain), {
    chainId: "0x1159", chainName: "LitVM Liteforge",
    nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
    rpcUrls: ["https://liteforge.rpc.caldera.xyz/http"], blockExplorerUrls: ["https://liteforge.explorer.caldera.xyz"],
  });
  assert.ok(WALLET_ERROR_CODES.includes("user_rejected") && WALLET_ERROR_CODES.includes("request_pending") && WALLET_ERROR_CODES.includes("wrong_chain")
    && WALLET_ERROR_CODES.includes("no_wallet") && WALLET_ERROR_CODES.includes("rpc") && WALLET_ERROR_CODES.includes("reverted"));
});

test("a custom chain is normalised (hex id, defaults) and a bad one refused", () => {
  const w = createWallet({ provider: createMockProvider(), chain: { chainId: 31337, rpcUrls: ["http://127.0.0.1:8545"] } });
  assert.equal(w.chain.chainIdHex, "0x7a69");
  assert.equal(w.chain.name, "Chain 31337");
  assert.deepEqual(chainParams(w.chain).rpcUrls, ["http://127.0.0.1:8545"]);
  assert.equal("blockExplorerUrls" in chainParams(w.chain), false);
  assert.throws(() => createWallet({ chain: {} }), TypeError);
  assert.throws(() => createWallet({ chain: { chainId: -5 } }), TypeError);
  assert.equal(parseChainId("0x1159"), 4441);
  assert.equal(parseChainId("4441"), 4441);
  assert.equal(parseChainId(4441), 4441);
  assert.equal(parseChainId(4441n), 4441);
  assert.equal(parseChainId("nope"), null);
  assert.equal(parseChainId(undefined), null);
});

// ------------------------------------------------------------------ discovery
test("EIP-6963 discovery: every announcing wallet is returned, MetaMask first, duplicates and junk dropped", async () => {
  const coinbase = { info: walletInfo("Coinbase Wallet", "com.coinbase.wallet"), provider: createMockProvider() };
  const metamask = { info: walletInfo("MetaMask", "io.metamask"), provider: createMockProvider() };
  const rabby = { info: walletInfo("Rabby", "io.rabby"), provider: createMockProvider() };
  const junk = { info: { name: "no uuid" }, provider: createMockProvider() };
  const noRequest = { info: walletInfo("Broken", "x.broken"), provider: {} };
  const win = createMockWindow([coinbase, metamask, rabby, { ...metamask }, junk, noRequest]);
  const list = await discoverProviders({ win, timeoutMs: 10 });
  assert.deepEqual(list.map((e) => e.info.rdns), ["io.metamask", "com.coinbase.wallet", "io.rabby"]);
  assert.deepEqual(Object.keys(list[0].info).sort(), ["icon", "name", "rdns", "uuid"]);
  assert.equal(list[0].provider, metamask.provider);
  assert.equal(list[0].info.name, "MetaMask");
  assert.match(list[0].info.icon, /^data:/);
});

test("discovery asks for announcements and stops listening afterwards", async () => {
  const win = createMockWindow([]);
  const added = [], removed = [], dispatched = [];
  const { addEventListener, removeEventListener, dispatchEvent } = win;
  win.addEventListener = (t, fn, o) => { added.push(t); return addEventListener.call(win, t, fn, o); };
  win.removeEventListener = (t, fn, o) => { removed.push(t); return removeEventListener.call(win, t, fn, o); };
  win.dispatchEvent = (ev) => { dispatched.push(ev.type); return dispatchEvent.call(win, ev); };
  await discoverProviders({ win, timeoutMs: 5 });
  assert.deepEqual(added, ["eip6963:announceProvider"]);
  assert.deepEqual(dispatched, ["eip6963:requestProvider"]);
  assert.deepEqual(removed, ["eip6963:announceProvider"]);
});

test("discovery falls back to window.ethereum (and its .providers), and to nothing", async () => {
  const mm = createMockProvider();
  const one = await discoverProviders({ win: createMockWindow([], mm), timeoutMs: 5 });
  assert.equal(one.length, 1);
  assert.equal(one[0].provider, mm);
  assert.equal(one[0].info.rdns, "io.metamask");
  assert.equal(one[0].info.name, "MetaMask");

  const other = { request: async () => null };
  const plain = await discoverProviders({ win: createMockWindow([], other), timeoutMs: 5 });
  assert.equal(plain[0].info.name, "Browser wallet");
  assert.equal(plain[0].info.rdns, "");

  const many = await discoverProviders({ win: createMockWindow([], { request: async () => null, providers: [other, mm] }), timeoutMs: 5 });
  assert.deepEqual(many.map((e) => e.provider), [mm, other], "MetaMask sorted first out of the legacy providers array");

  assert.deepEqual(await discoverProviders({ win: createMockWindow([]), timeoutMs: 5 }), []);
  assert.deepEqual(await discoverProviders({ win: undefined, timeoutMs: 5 }), [], "no window at all (Node, workers)");
  // EIP-6963 wins over the legacy slot when both exist
  const announced = { info: walletInfo("Rabby", "io.rabby"), provider: createMockProvider() };
  const both = await discoverProviders({ win: createMockWindow([announced], mm), timeoutMs: 5 });
  assert.deepEqual(both.map((e) => e.info.rdns), ["io.rabby"]);
});

test("pickProvider: last-used wallet, else MetaMask, else the first", () => {
  const list = [
    { info: walletInfo("Rabby", "io.rabby", "u1"), provider: {} },
    { info: walletInfo("MetaMask", "io.metamask", "u2"), provider: {} },
    { info: walletInfo("Coinbase", "com.coinbase.wallet", "u3"), provider: {} },
  ];
  assert.equal(pickProvider(list).info.uuid, "u2");
  assert.equal(pickProvider(list, { uuid: "u3" }).info.uuid, "u3");
  assert.equal(pickProvider(list, { rdns: "io.rabby" }).info.uuid, "u1");
  assert.equal(pickProvider(list, { uuid: "gone", rdns: "gone" }).info.uuid, "u2");
  assert.equal(pickProvider(list.filter((e) => e.info.rdns !== "io.metamask")).info.uuid, "u1");
  assert.equal(pickProvider([]), null);
});

test("createWallet discovers a wallet on its own and prefers MetaMask", async () => {
  const coinbase = { info: walletInfo("Coinbase Wallet", "com.coinbase.wallet"), provider: createMockProvider({ accounts: [BOB] }) };
  const metamask = { info: walletInfo("MetaMask", "io.metamask"), provider: createMockProvider() };
  const win = createMockWindow([coinbase, metamask]);
  const wallet = createWallet({ win, storage: memoryStorage(), discoverMs: 5 });
  assert.equal(wallet.info, null, "nothing chosen until discovery finishes");
  await wallet.ready;
  assert.equal(wallet.info.rdns, "io.metamask");
  assert.equal(await wallet.connect(), A);
  assert.equal(metamask.provider.methods("eth_requestAccounts").length, 1);
  assert.equal(coinbase.provider.calls.length, 0, "the other wallet was never touched");
});

test("a wallet installed after the first look is found on the next attempt", async () => {
  const wallets = [];
  const win = createMockWindow(wallets);
  const wallet = createWallet({ win, storage: memoryStorage(), discoverMs: 5 });
  await rejects(wallet.connect(), "no_wallet");
  wallets.push({ info: walletInfo("MetaMask", "io.metamask"), provider: createMockProvider() });
  assert.equal(await wallet.connect(), A);
});

test("connect() reaches the wallet without waiting on a timer, so it stays inside the click that asked", async () => {
  const { wallet, provider } = make();
  await wallet.ready;
  const p = wallet.connect();
  await flushMicrotasks();
  assert.equal(provider.methods("eth_requestAccounts").length, 1, "the popup request was issued by microtasks alone");
  await p;
});

// ------------------------------------------------------------------ no wallet, import safety
test("without any wallet the module still loads and every action fails with no_wallet", async () => {
  const wallet = createWallet({ storage: memoryStorage() });   // Node: no window, no provider
  assert.equal(wallet.connected, false);
  assert.equal(wallet.address, null);
  assert.equal(wallet.chainId, null);
  assert.equal(wallet.onCorrectChain, false);
  assert.equal(wallet.info, null);
  for (const action of [() => wallet.connect(), () => wallet.ensureChain(), () => wallet.request({ method: "eth_chainId" })]) {
    await assert.rejects(action(), (e) => e instanceof WalletError && e.code === "no_wallet" && /MetaMask/.test(e.message));
  }
  assert.equal(await wallet.restore(), null, "restore() is quiet when there is nothing to restore");
  assert.equal(await wallet.restore({ force: true }), null, "and when there is no wallet, even forced");
  await wallet.disconnect();
});

// ------------------------------------------------------------------ connect
test("connect(): lowercase address, chain state, subscribers, single flight", async () => {
  const { wallet, provider } = make(createMockProvider({ accounts: [ALICE], chainId: 4441 }));
  const sub = kinds();
  wallet.subscribe(sub.fn);
  const [a, b] = await Promise.all([wallet.connect(), wallet.connect()]);
  assert.equal(a, A);
  assert.equal(b, A);
  assert.equal(provider.methods("eth_requestAccounts").length, 1, "a double click sends one request");
  assert.equal(wallet.address, A);
  assert.equal(wallet.connected, true);
  assert.equal(wallet.chainId, 4441);
  assert.equal(wallet.onCorrectChain, true);
  assert.deepEqual(wallet.snapshot(), { address: A, chainId: 4441, connected: true, onCorrectChain: true });
  assert.equal(sub.seen.length, 1);
  assert.equal(sub.seen[0][0], "connect");
  assert.deepEqual(sub.seen[0][1], { address: A, chainId: 4441, connected: true, onCorrectChain: true });
  // asking again later (after the first finished) really asks again
  await wallet.connect();
  assert.equal(provider.methods("eth_requestAccounts").length, 2);
});

test("connect() on the wrong network is connected but not onCorrectChain", async () => {
  const { wallet } = make(createMockProvider({ chainId: 1 }));
  await wallet.connect();
  assert.equal(wallet.connected, true);
  assert.equal(wallet.chainId, 1);
  assert.equal(wallet.onCorrectChain, false);
});

test("connect() failures are normalised and leave the wallet disconnected", async () => {
  const provider = createMockProvider();
  const { wallet, storage } = make(provider);
  provider.once("eth_requestAccounts", providerError(4001, "User rejected the request."));
  await assert.rejects(wallet.connect(), (e) => e.code === "user_rejected" && e.rpcCode === 4001 && /cancelled/i.test(e.message) && e.detail === "User rejected the request.");
  provider.once("eth_requestAccounts", providerError(-32002, "Already processing eth_requestAccounts. Please wait."));
  await assert.rejects(wallet.connect(), (e) => e.code === "request_pending" && /MetaMask/.test(e.message) && e.rpcCode === -32002);
  provider.once("eth_requestAccounts", []);
  await rejects(wallet.connect(), "rpc");
  provider.once("eth_requestAccounts", ["not an address"]);
  await rejects(wallet.connect(), "rpc");
  assert.equal(wallet.connected, false);
  assert.equal(storage._map.size, 0, "nothing is remembered from a failed connect");
});

// ------------------------------------------------------------------ restore / disconnect / persistence
test("restore(): quiet reconnect for a returning player, no popup, no request when there is nothing to restore", async () => {
  const provider = createMockProvider();
  const storage = memoryStorage();
  await createWallet({ provider, storage }).connect();
  assert.equal(storage._map.size, 1);
  const saved = JSON.parse([...storage._map.values()][0]);
  assert.deepEqual(Object.keys(saved).sort(), ["rdns", "uuid"], "only which wallet is remembered, no account or balance");

  provider.calls.length = 0;
  const next = createWallet({ provider, storage });
  const sub = kinds();
  next.subscribe(sub.fn);
  assert.equal(await next.restore(), A);
  assert.equal(next.address, A);
  assert.equal(next.chainId, 4441);
  assert.deepEqual(provider.calls.map((c) => c.method), ["eth_accounts", "eth_chainId"], "no eth_requestAccounts: nothing pops up");
  assert.equal(sub.seen[0][0], "restore");

  // a browser that never connected: restore does not even talk to the wallet
  const fresh = createMockProvider({ permitted: true });
  assert.equal(await createWallet({ provider: fresh, storage: memoryStorage() }).restore(), null);
  assert.equal(fresh.calls.length, 0);
  // ... unless forced
  assert.equal(await createWallet({ provider: fresh, storage: memoryStorage() }).restore({ force: true }), A);
});

test("restore() returns null when the wallet no longer lists an account (locked or revoked) and keeps the memory for later", async () => {
  const provider = createMockProvider();
  const storage = memoryStorage();
  await createWallet({ provider, storage }).connect();
  provider.permitted = false;                 // MetaMask locked / site disconnected in the extension
  const w = createWallet({ provider, storage });
  const sub = kinds();
  w.subscribe(sub.fn);
  assert.equal(await w.restore(), null);
  assert.equal(w.connected, false);
  assert.equal(storage._map.size, 1, "the player still wants to be connected once it unlocks");
  // it unlocks: the wallet announces the account and the page follows, without a click
  provider.permitted = true;
  provider.emit("accountsChanged", [ALICE]);
  assert.equal(w.address, A);
  assert.equal(w.connected, true);
  assert.equal(sub.seen.at(-1)[0], "accountsChanged");

  // a browser that never connected does not adopt accounts it was never asked to use
  const stranger = createWallet({ provider: createMockProvider({ permitted: true }), storage: memoryStorage() });
  assert.equal(await stranger.restore({ force: true }), A, "forced: an existing permission is used");
  const p3 = createMockProvider();
  const w3 = createWallet({ provider: p3, storage: memoryStorage() });
  assert.equal(await w3.restore({ force: true }), null);
  p3.emit("accountsChanged", [ALICE]);
  assert.equal(w3.connected, false, "no memory of a connection: a forced restore that found nothing does not start following the wallet");
});

test("disconnect() forgets the session, revokes the permission, and later account events do not reconnect", async () => {
  const provider = createMockProvider();
  const storage = memoryStorage();
  const wallet = createWallet({ provider, storage });
  const sub = kinds();
  await wallet.connect();
  wallet.subscribe(sub.fn);
  await wallet.disconnect();
  assert.equal(wallet.connected, false);
  assert.equal(wallet.address, null);
  assert.equal(storage._map.size, 0);
  assert.deepEqual(provider.methods("wallet_revokePermissions")[0].params, [{ eth_accounts: {} }]);
  assert.equal(sub.seen.length, 1);
  assert.equal(sub.seen[0][0], "disconnect");
  assert.equal(sub.seen[0][1].connected, false);
  provider.emit("accountsChanged", [ALICE]);
  assert.equal(wallet.connected, false, "switching accounts in MetaMask must not silently reconnect a disconnected page");
  assert.equal(await createWallet({ provider, storage }).restore(), null, "and a reload does not restore it");
  await rejects(wallet.personalSign("x"), "not_connected");
  await wallet.disconnect();                   // idempotent
  assert.equal(sub.seen.length, 1, "no event when there was nothing to disconnect");
});

test("disconnect() still forgets locally when the wallet cannot revoke permissions", async () => {
  const provider = createMockProvider({ permitted: true });
  const storage = memoryStorage();
  const wallet = createWallet({ provider, storage });
  await wallet.connect();
  provider.once("wallet_revokePermissions", providerError(-32601, "The method wallet_revokePermissions does not exist"));
  const c = captureConsole();
  try { await wallet.disconnect(); } finally { c.restore(); }
  assert.equal(wallet.connected, false);
  assert.equal(storage._map.size, 0);
  assert.ok(c.logs.some(([m, msg]) => m === "debug" && /revokePermissions/.test(msg)), "the failure is logged, not swallowed silently");
  provider.permitted = true;                   // MetaMask still lists the site as connected...
  assert.equal(await createWallet({ provider, storage }).restore(), null, "...but the page does not restore it");
});

test("restore() reconnects to the wallet the player used last, not the default one", async () => {
  const coinbase = { info: walletInfo("Coinbase Wallet", "com.coinbase.wallet"), provider: createMockProvider({ accounts: [BOB] }) };
  const metamask = { info: walletInfo("MetaMask", "io.metamask"), provider: createMockProvider() };
  const storage = memoryStorage();
  await createWallet({ provider: coinbase.provider, info: coinbase.info, storage }).connect();
  const win = createMockWindow([metamask, coinbase]);
  const wallet = createWallet({ win, storage, discoverMs: 5 });
  assert.equal(await wallet.restore(), BOB.toLowerCase());
  assert.equal(wallet.info.rdns, "com.coinbase.wallet");
  assert.equal(metamask.provider.calls.length, 0);
});

test("a blocked, throwing or missing localStorage never breaks the wallet", async () => {
  const c = captureConsole();
  try {
    const hostile = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("SecurityError"); } };
    for (const storage of [hostile, null, {}]) {
      const provider = createMockProvider();
      const wallet = createWallet({ provider, storage });
      assert.equal(await wallet.connect(), A);
      assert.equal(await wallet.restore(), null, "nothing remembered, so nothing restored");
      await wallet.disconnect();
    }
    // default storage: Node 25 ships a localStorage stub whose methods are missing; the wallet must cope with whatever is there
    const wallet = createWallet({ provider: createMockProvider() });
    assert.equal(await wallet.connect(), A);
    await wallet.disconnect();
  } finally { c.restore(); }
});

// ------------------------------------------------------------------ ensureChain
test("ensureChain(): nothing to do when already on the chain", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  provider.calls.length = 0;
  assert.equal(await wallet.ensureChain(), true);
  assert.deepEqual(provider.calls.map((c) => c.method), ["eth_chainId"]);
});

test("ensureChain(): switches when the wallet already knows the chain", async () => {
  const { wallet, provider } = make(createMockProvider({ chainId: 1 }));
  await wallet.connect();
  const sub = kinds();
  wallet.subscribe(sub.fn);
  assert.equal(await wallet.ensureChain(), true);
  assert.deepEqual(provider.calls.slice(-3).map((c) => c.method), ["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
  assert.deepEqual(provider.methods("wallet_switchEthereumChain")[0].params, [{ chainId: "0x1159" }]);
  assert.equal(provider.methods("wallet_addEthereumChain").length, 0);
  assert.equal(wallet.chainId, 4441);
  assert.equal(wallet.onCorrectChain, true);
  assert.equal(sub.seen.filter(([k]) => k === "chainChanged").length, 1, "one notification, not one per source (event + re-read)");
});

test("ensureChain(): 4902 -> wallet_addEthereumChain -> switch again", async () => {
  const { wallet, provider } = make(createMockProvider({ chainId: 1, known: [1] }));
  await wallet.connect();
  provider.calls.length = 0;
  assert.equal(await wallet.ensureChain(), true);
  assert.deepEqual(provider.calls.map((c) => c.method), [
    "eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_chainId",
  ]);
  assert.deepEqual(provider.methods("wallet_addEthereumChain")[0].params, [{
    chainId: "0x1159",
    chainName: "LitVM Liteforge",
    nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
    rpcUrls: ["https://liteforge.rpc.caldera.xyz/http"],
    blockExplorerUrls: ["https://liteforge.explorer.caldera.xyz"],
  }]);
  assert.equal(wallet.chainId, 4441);
  assert.equal(wallet.onCorrectChain, true);
});

test("ensureChain(): a wallet that says 'Unrecognized chain ID' with the wrong code still gets the chain added", async () => {
  const { wallet, provider } = make(createMockProvider({ chainId: 1 }));
  await wallet.connect();
  provider.once("wallet_switchEthereumChain", providerError(-32603, 'Unrecognized chain ID "0x1159". Try adding the chain using wallet_addEthereumChain first.'));
  provider.once("wallet_switchEthereumChain", (params) => { provider.chainId = 4441; return null; });
  assert.equal(await wallet.ensureChain(), true);
  assert.equal(provider.methods("wallet_addEthereumChain").length, 1);
  assert.equal(provider.methods("wallet_switchEthereumChain").length, 2);
  // 4902 only buried in data.originalError, with an unhelpful message (MetaMask mobile / older builds)
  const p2 = createMockProvider({ chainId: 1 });
  const w2 = createWallet({ provider: p2, storage: memoryStorage() });
  await w2.connect();
  p2.once("wallet_switchEthereumChain", providerError(-32603, "Internal JSON-RPC error.", { originalError: { code: 4902 } }));
  assert.equal(await w2.ensureChain(), true);
  assert.deepEqual(p2.calls.slice(-5).map((c) => c.method), ["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_chainId"]);
});

test("ensureChain(): the player's refusals and a busy wallet are reported, and never trigger the add step by mistake", async () => {
  for (const [error, code] of [
    [providerError(4001, "User rejected the request."), "user_rejected"],
    [providerError(-32002, "Request of type 'wallet_switchEthereumChain' already pending for origin http://x. Please wait."), "request_pending"],
    [providerError(-32603, "Internal JSON-RPC error."), "rpc"],
  ]) {
    const { wallet, provider } = make(createMockProvider({ chainId: 1 }));
    await wallet.connect();
    provider.once("wallet_switchEthereumChain", error);
    await rejects(wallet.ensureChain(), code);
    assert.equal(provider.methods("wallet_addEthereumChain").length, 0, `no add after ${code}`);
    assert.equal(wallet.onCorrectChain, false);
  }
  // rejecting the add prompt
  const { wallet, provider } = make(createMockProvider({ chainId: 1, known: [1] }));
  await wallet.connect();
  provider.once("wallet_addEthereumChain", providerError(4001, "User rejected the request."));
  await rejects(wallet.ensureChain(), "user_rejected");
  assert.equal(provider.methods("wallet_switchEthereumChain").length, 1, "no second switch after a refused add");
});

test("ensureChain(): a wallet that claims success but stays on another chain is a wrong_chain error", async () => {
  const { wallet, provider } = make(createMockProvider({ chainId: 1 }));
  await wallet.connect();
  provider.once("wallet_switchEthereumChain", null);   // resolves without switching
  await assert.rejects(wallet.ensureChain(), (e) => e.code === "wrong_chain" && e.expected === 4441 && e.actual === 1 && /LitVM Liteforge/.test(e.message));
  assert.equal(wallet.onCorrectChain, false);
});

test("ensureChain(): overlapping calls share one switch request", async () => {
  const { wallet, provider } = make(createMockProvider({ chainId: 1 }));
  await wallet.connect();
  await Promise.all([wallet.ensureChain(), wallet.ensureChain(), wallet.ensureChain()]);
  assert.equal(provider.methods("wallet_switchEthereumChain").length, 1);
});

// ------------------------------------------------------------------ provider events
test("accountsChanged / chainChanged keep the state and the subscribers current", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  const sub = kinds();
  const off = wallet.subscribe(sub.fn);

  provider.emit("accountsChanged", [BOB]);
  assert.equal(wallet.address, BOB.toLowerCase(), "lowercased");
  assert.equal(sub.seen.at(-1)[0], "accountsChanged");
  provider.emit("accountsChanged", [BOB]);
  assert.equal(sub.seen.length, 1, "no duplicate notification for an unchanged account");

  provider.emit("chainChanged", "0x1");
  assert.equal(wallet.chainId, 1);
  assert.equal(wallet.onCorrectChain, false);
  assert.equal(sub.seen.at(-1)[0], "chainChanged");
  assert.equal(sub.seen.at(-1)[1].onCorrectChain, false);
  provider.emit("chainChanged", "0x1159");
  assert.equal(wallet.onCorrectChain, true);
  provider.emit("chainChanged", "0x1159");
  assert.equal(sub.seen.filter(([k]) => k === "chainChanged").length, 2);

  provider.emit("accountsChanged", []);        // locked / disconnected in the extension
  assert.equal(wallet.connected, false);
  assert.equal(wallet.address, null);
  provider.emit("accountsChanged", [ALICE]);   // unlocked again: the page follows
  assert.equal(wallet.address, A);

  off();
  const n = sub.seen.length;
  provider.emit("accountsChanged", [BOB]);
  assert.equal(sub.seen.length, n, "unsubscribed");
  assert.equal(wallet.address, BOB.toLowerCase(), "state still tracks");
  assert.throws(() => wallet.subscribe("nope"), TypeError);
});

test("events before the player has connected change nothing", async () => {
  const { wallet, provider } = make();
  await wallet.ready;
  const sub = kinds();
  wallet.subscribe(sub.fn);
  provider.emit("accountsChanged", [ALICE]);       // listeners are only attached once the wallet is used
  await wallet.request({ method: "eth_chainId" });   // now bound
  provider.emit("accountsChanged", [ALICE]);
  assert.equal(wallet.connected, false);
  assert.equal(sub.seen.filter(([k]) => k === "accountsChanged").length, 0);
});

test("the provider's disconnect and connect events: not connected while it is offline, re-synced when it is back", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  const sub = kinds();
  wallet.subscribe(sub.fn);
  provider.emit("disconnect", providerError(4900, "disconnected"));
  assert.equal(wallet.connected, false);
  assert.equal(wallet.chainId, null);
  assert.equal(wallet.onCorrectChain, false);
  assert.equal(sub.seen.at(-1)[0], "providerDisconnect");
  provider.emit("connect", { chainId: "0x1159" });
  await tick(5);
  assert.equal(wallet.connected, true, "the account was re-read (eth_accounts) after the provider came back");
  assert.equal(wallet.address, A);
  assert.equal(wallet.chainId, 4441);
  assert.ok(sub.seen.some(([k]) => k === "providerConnect"));
});

test("destroy() detaches every provider listener and silences subscribers", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  for (const evt of ["accountsChanged", "chainChanged", "disconnect", "connect"]) assert.equal(provider.listenerCount(evt), 1, evt);
  const sub = kinds();
  wallet.subscribe(sub.fn);
  wallet.destroy();
  for (const evt of ["accountsChanged", "chainChanged", "disconnect", "connect"]) assert.equal(provider.listenerCount(evt), 0, evt);
  provider.emit("chainChanged", "0x1");
  assert.equal(sub.seen.length, 0);
  // a second wallet on the same provider attaches its own listeners exactly once, however often it is used
  const w2 = createWallet({ provider, storage: memoryStorage() });
  await w2.connect();
  await w2.connect();
  await w2.ensureChain();
  assert.equal(provider.listenerCount("accountsChanged"), 1);
});

test("a throwing subscriber cannot break the others or the wallet", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  const c = captureConsole();
  try {
    const seen = [];
    wallet.subscribe(() => { throw new Error("UI bug"); });
    wallet.subscribe((s) => seen.push(s.chainId));
    provider.emit("chainChanged", "0x1");
    assert.deepEqual(seen, [1]);
    assert.ok(c.logs.some(([m, msg]) => m === "error" && /subscriber threw/.test(msg)), "logged, not silent");
  } finally { c.restore(); }
});

// ------------------------------------------------------------------ signing
test("personalSign(): hex-encoded UTF-8 message first, the account second (personal_sign order)", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  const message = "forge.example wants you to sign in.\nNonce: 9f8e7d\nIssued At: 2026-09-30T12:00:00Z\n✨ héllo 🔥";
  const sig = await wallet.personalSign(message);
  assert.equal(sig, "0x" + "ab".repeat(65));
  const call = provider.methods("personal_sign")[0];
  assert.deepEqual(call.params, [ethers.hexlify(ethers.toUtf8Bytes(message)), A]);
  assert.match(call.params[0], /^0x[0-9a-f]+$/);
  assert.equal(call.params[1], call.params[1].toLowerCase());
  // bytes go through as they are
  await wallet.personalSign(new Uint8Array([1, 2, 255]));
  assert.equal(provider.methods("personal_sign")[1].params[0], "0x0102ff");
  await assert.rejects(wallet.personalSign(42), TypeError);
  await assert.rejects(wallet.personalSign(undefined), TypeError);
});

test("personalSign(): a real signer verifies against the message text (the encoding is EIP-191 correct)", async () => {
  const signer = ethers.Wallet.createRandom();
  const provider = createMockProvider({ accounts: [signer.address] });
  provider.once("personal_sign", ([hex, from]) => {
    assert.equal(from, signer.address.toLowerCase());
    return signer.signMessage(ethers.getBytes(hex));
  });
  const wallet = createWallet({ provider, storage: memoryStorage() });
  await wallet.connect();
  const message = "Sign in to FORGE\nNonce: abc123\né✓";
  const sig = await wallet.personalSign(message);
  assert.equal(ethers.verifyMessage(message, sig), signer.address);
});

test("personalSign(): needs a connection, reports refusals, and rejects unreadable answers", async () => {
  const { wallet, provider } = make();
  await rejects(wallet.personalSign("x"), "not_connected");
  await wallet.connect();
  provider.once("personal_sign", providerError(4001, "User denied message signature."));
  await rejects(wallet.personalSign("x"), "user_rejected");
  provider.once("personal_sign", providerError(-32002, "Already processing personal_sign."));
  await rejects(wallet.personalSign("x"), "request_pending");
  for (const junk of [null, "", "0x", "not hex", 5]) {
    provider.once("personal_sign", junk);
    await rejects(wallet.personalSign("x"), "rpc");
  }
  assert.equal(await wallet.personalSign(""), "0x" + "ab".repeat(65), "an empty message is still a message");
  assert.equal(provider.methods("personal_sign").at(-1).params[0], "0x");
});

// ------------------------------------------------------------------ sending
test("sendTransaction(): from = the connected account, hex quantities, value only when non-zero", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  provider.once("eth_sendTransaction", HASH);
  const hash = await wallet.sendTransaction({ to: SHOP, data: "0xc37b9bcd", value: 10n ** 17n, gas: 187_500n });
  assert.equal(hash, HASH);
  assert.deepEqual(provider.methods("eth_sendTransaction")[0].params, [{ from: A, to: SHOP, data: "0xc37b9bcd", value: "0x16345785d8a0000", gas: "0x2dc6c" }]);
  provider.once("eth_sendTransaction", HASH);
  await wallet.sendTransaction({ to: SHOP, data: "0x50a88c7e" + "00".repeat(31) + "01", value: 0n });
  assert.deepEqual(provider.methods("eth_sendTransaction")[1].params, [{ from: A, to: SHOP, data: "0x50a88c7e" + "00".repeat(31) + "01" }]);
  provider.once("eth_sendTransaction", HASH);
  await wallet.sendTransaction({ to: SHOP });
  assert.equal(provider.methods("eth_sendTransaction")[2].params[0].data, "0x");
  assert.equal("gas" in provider.methods("eth_sendTransaction")[2].params[0], false, "no gas: the wallet decides");
  // decimal / hex string and number quantities
  provider.once("eth_sendTransaction", HASH);
  await wallet.sendTransaction({ to: SHOP, data: "0x", value: "1000", gas: 21000 });
  assert.equal(provider.methods("eth_sendTransaction")[3].params[0].value, "0x3e8");
});

test("sendTransaction(): validates arguments and needs a connection", async () => {
  const { wallet, provider } = make();
  await rejects(wallet.sendTransaction({ to: SHOP }), "not_connected");
  await wallet.connect();
  await assert.rejects(wallet.sendTransaction({ to: "0x1234" }), TypeError);
  await assert.rejects(wallet.sendTransaction({}), TypeError);
  await assert.rejects(wallet.sendTransaction({ to: SHOP, data: "nope" }), TypeError);
  await assert.rejects(wallet.sendTransaction({ to: SHOP, value: -1n }), /negative/);
  assert.equal(provider.methods("eth_sendTransaction").length, 0);
});

test("sendTransaction() re-checks the chain with the wallet itself and refuses a wrong-chain send", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  assert.equal(wallet.onCorrectChain, true);
  provider.chainId = 1;                          // the player switched networks and no event reached us (yet)
  await assert.rejects(wallet.sendTransaction({ to: SHOP, data: "0xc37b9bcd", value: 1n }), (e) =>
    e.code === "wrong_chain" && e.actual === 1 && e.expected === 4441);
  assert.equal(provider.methods("eth_sendTransaction").length, 0, "nothing was sent: it would have paid this address on another chain");
  assert.equal(wallet.chainId, 1, "and the stale state was corrected");
  assert.equal(wallet.onCorrectChain, false);
});

test("sendTransaction() errors: refusal, pending, insufficient funds, revert data, junk hash", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  const send = () => wallet.sendTransaction({ to: SHOP, data: "0xc37b9bcd", value: 1n });
  provider.once("eth_sendTransaction", providerError(4001, "MetaMask Tx Signature: User denied transaction signature."));
  await rejects(send(), "user_rejected");
  provider.once("eth_sendTransaction", providerError(-32002, "Already processing eth_sendTransaction."));
  await rejects(send(), "request_pending");
  provider.once("eth_sendTransaction", providerError(-32000, "insufficient funds for gas * price + value"));
  await assert.rejects(send(), (e) => e.code === "low_balance" && e.message.includes("https://liteforge.hub.caldera.xyz") && e.message.includes("zkLTC"));
  const revertData = "0x085de625";
  provider.once("eth_sendTransaction", providerError(-32603, "Internal JSON-RPC error.", { code: 3, message: "execution reverted", data: revertData }));
  await assert.rejects(send(), (e) => e.code === "reverted" && e.data === revertData && /would fail/.test(e.message));
  provider.once("eth_sendTransaction", providerError(-32603, "execution reverted"));
  await rejects(send(), "reverted");
  for (const junk of [null, "0x1234", "hash", 7]) {
    provider.once("eth_sendTransaction", junk);
    await rejects(send(), "rpc");
  }
});

// ------------------------------------------------------------------ balance / request
test("balance() reads the connected account's balance through the wallet, as a bigint", async () => {
  const { wallet, provider } = make();
  await rejects(wallet.balance(), "not_connected");
  await wallet.connect();
  provider.once("eth_getBalance", "0x16345785d8a0000");
  assert.equal(await wallet.balance(), 10n ** 17n);
  assert.deepEqual(provider.methods("eth_getBalance")[0].params, [A, "latest"]);
  provider.once("eth_getBalance", "0xzz");
  await assert.rejects(wallet.balance(), /not a hex quantity/);
});

test("request() passes calls through and normalises every failure", async () => {
  const { wallet, provider } = make();
  assert.equal(await wallet.request({ method: "eth_chainId" }), "0x1159");
  assert.deepEqual(provider.calls.at(-1), { method: "eth_chainId", params: undefined });
  await assert.rejects(wallet.request({ method: "eth_bogus" }), (e) => e instanceof WalletError && e.code === "rpc" && /eth_bogus/.test(e.message));
  provider.once("eth_chainId", providerError(4001, "User rejected the request."));
  await rejects(wallet.request({ method: "eth_chainId" }), "user_rejected");
  provider.once("eth_chainId", new Error("boom"));
  await assert.rejects(wallet.request({ method: "eth_chainId" }), (e) => e.code === "rpc" && /boom/.test(e.message) && e.cause instanceof Error);
});

// ------------------------------------------------------------------ error normalisation
test("normalizeError maps EIP-1193 / MetaMask / ethers failures to the WalletError codes", () => {
  const cases = [
    [providerError(4001, "User rejected the request."), "user_rejected"],
    [providerError(4001, ""), "user_rejected"],
    [{ code: "ACTION_REJECTED", message: "user rejected action" }, "user_rejected"],
    [new Error("MetaMask Tx Signature: User denied transaction signature."), "user_rejected"],
    [new Error("The user rejected the request."), "user_rejected"],
    [providerError(-32002, "Already processing eth_requestAccounts. Please wait."), "request_pending"],
    [new Error("Request of type 'wallet_switchEthereumChain' already pending for origin https://x."), "request_pending"],
    [providerError(4100, "The requested account has not been authorized by the user."), "not_connected"],
    [providerError(4902, "Unrecognized chain ID"), "wrong_chain"],
    [providerError(-32603, 'Unrecognized chain ID "0x1159". Try adding the chain using wallet_addEthereumChain first.'), "wrong_chain"],
    [providerError(4900, "The provider is disconnected from all chains."), "rpc"],
    [providerError(4901, "The provider is disconnected from the specified chain."), "rpc"],
    [providerError(4200, "The Provider does not support the requested method."), "rpc"],
    [providerError(-32601, "The method does not exist"), "rpc"],
    [providerError(-32000, "insufficient funds for transfer"), "low_balance"],
    [new Error("Insufficient funds"), "low_balance"],
    [providerError(3, "execution reverted", "0x085de625"), "reverted"],
    [providerError(-32603, "Internal JSON-RPC error.", { data: "0x085de625" }), "reverted"],
    [new Error("execution reverted: nope"), "reverted"],
    [new Error("something unexpected"), "rpc"],
    ["a bare string", "rpc"],
    [undefined, "rpc"],
    [null, "rpc"],
  ];
  for (const [input, code] of cases) {
    const e = normalizeError(input, "eth_test");
    assert.ok(e instanceof WalletError, String(input?.message ?? input));
    assert.equal(e.code, code, `${input?.message ?? input}`);
    assert.ok(WALLET_ERROR_CODES.includes(e.code));
    assert.ok(typeof e.message === "string" && e.message.length > 10 && e.message.length < 400, e.message);
    assert.ok(!/undefined|\[object|null/.test(e.message), `player-facing message must not leak internals: ${e.message}`);
    assert.equal(e.name, "WalletError");
  }
  const original = new WalletError("wrong_chain", "already normal");
  assert.equal(normalizeError(original), original, "already-normalised errors pass through untouched");
  // long provider text is shortened, whitespace collapsed
  const long = normalizeError(new Error("x".repeat(1000) + "\n\n  y"));
  assert.ok(long.message.length < 260);
  assert.ok(long.detail.length > 1000, "the raw text stays available in .detail");
  // a chain without a faucet gets no faucet hint
  assert.doesNotMatch(normalizeError(new Error("insufficient funds"), "", { name: "X", nativeCurrency: { symbol: "ABC" } }).message, /https?:/);
  assert.match(normalizeError(new Error("insufficient funds"), "", { name: "X", nativeCurrency: { symbol: "ABC" }, faucet: "https://f.test" }).message, /ABC.*https:\/\/f\.test/);
});

// ------------------------------------------------------------------ network fee (live bug, Liteforge 2026-10-02)
// A user's wallet bid maxFeePerGas 10000000 (the chain's 0.01 gwei floor) while the base fee had drifted to 10009000, and the
// node refused the raw transaction: "max fee per gas less than block base fee". Left to itself the wallet bids the floor.
test("sendTransaction(): optional EIP-1559 caps are passed as hex quantities (zero tip included), and only when given", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  provider.once("eth_sendTransaction", HASH);
  await wallet.sendTransaction({ to: SHOP, data: "0x", gas: 100_000n, maxFeePerGas: 20_772_000n, maxPriorityFeePerGas: 0n });
  assert.deepEqual(provider.methods("eth_sendTransaction")[0].params, [{ from: A, to: SHOP, data: "0x", gas: "0x186a0", maxFeePerGas: "0x13cf4a0", maxPriorityFeePerGas: "0x0" }]);
  provider.once("eth_sendTransaction", HASH);
  await wallet.sendTransaction({ to: SHOP, data: "0x" });
  const bare = provider.methods("eth_sendTransaction")[1].params[0];
  assert.equal("maxFeePerGas" in bare || "maxPriorityFeePerGas" in bare, false, "omitted: the wallet decides");
});

test("normalizeError(): the base-fee refusal becomes fee_too_low, in the wording real nodes and wallets use", async () => {
  assert.ok(WALLET_ERROR_CODES.includes("fee_too_low"));
  const live = "RPC 0x1159 Custom eth_sendRawTransaction: max fee per gas less than block base fee: address 0x729A7da21DF1252E724C67Be415f36f2E1a9f626, maxFeePerGas: 10000000 baseFee: 10009000";
  for (const text of [
    live,
    "max fee per gas less than block base fee: address 0x00, maxFeePerGas: 1 baseFee: 2",
    "err: max fee per gas less than block base fee",
    "max fee per gas (1) is lower than the block base fee (2)",
    "transaction underpriced",
    "gas price too low",
    "max fee per gas less than block base fee: address 0x00, maxFeePerGas: 1 baseFee: 2 (supplied gas 1)",
  ]) {
    const e = normalizeError(providerError(-32603, text), "eth_sendTransaction");
    assert.equal(e.code, "fee_too_low", text);
    assert.match(e.message, /Nothing was charged/);
    assert.match(e.message, /try again/i);
    assert.equal(e.detail, text, "the provider's own words stay on .detail");
  }
  // neighbours keep their own codes
  assert.equal(normalizeError(providerError(-32000, "insufficient funds for gas * price + value")).code, "low_balance");
  assert.equal(normalizeError(providerError(-32603, "execution reverted")).code, "reverted");
  assert.equal(normalizeError(providerError(4001, "User denied transaction signature.")).code, "user_rejected");
  assert.equal(normalizeError(providerError(-32603, "something else entirely")).code, "rpc");
});

test("sendTransaction(): a wallet that refuses on the base fee surfaces fee_too_low, not a raw RPC dump", async () => {
  const { wallet, provider } = make();
  await wallet.connect();
  provider.once("eth_sendTransaction", providerError(-32603, "RPC 0x1159 Custom eth_sendRawTransaction: max fee per gas less than block base fee: address 0x729A7da21DF1252E724C67Be415f36f2E1a9f626, maxFeePerGas: 10000000 baseFee: 10009000"));
  await assert.rejects(wallet.sendTransaction({ to: SHOP, data: "0x" }), (e) => e instanceof WalletError && e.code === "fee_too_low" && !/RPC 0x1159/.test(e.message));
});
