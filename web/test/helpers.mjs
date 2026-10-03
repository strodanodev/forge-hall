// Shared test fixtures: ethers (the independent oracle), the compiled PackShop ABI, a mock EIP-1193 wallet, a mock
// EIP-6963 window, and a fake Liteforge/PackShop chain that speaks JSON-RPC over a fake fetch. Not a test file.
import { readFileSync } from "node:fs";
import * as ethers from "../../packshop/node_modules/ethers/lib.esm/index.js";

export { ethers };

// ------------------------------------------------------------------ ABI (the compiled contracts are the source of truth)
const ARTIFACTS = new URL("../../packshop/artifacts/contracts/", import.meta.url);
export function loadAbi(rel) {
  try { return JSON.parse(readFileSync(new URL(rel, ARTIFACTS), "utf8")).abi; }
  catch (e) {
    throw new Error(`Cannot read the compiled ABI ${rel}. Run \`cd packshop && npx hardhat compile\` first. (${e.message})`);
  }
}
export const shopIface = new ethers.Interface(loadAbi("PackShop.sol/PackShop.json"));
export const otherIfaces = [
  "vendor/rapture/StudioMinter.sol/StudioMinter.json",
  "vendor/rapture/CardDesign.sol/CardDesign.json",
  "vendor/rapture/RaptureCards.sol/RaptureCards.json",
].map((p) => new ethers.Interface(loadAbi(p)));

// ------------------------------------------------------------------ constants
export const q = (n) => "0x" + BigInt(n).toString(16);                       // JSON-RPC quantity
const addr = (h) => ethers.getAddress(h);
export const SHOP = addr("0x5fbdb2315678afecb367f032d93f642f64180aa3");      // checksummed on purpose: mixed case must work
export const ALICE = addr("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
export const BOB = addr("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
export const RPC = "https://rpc.test.invalid/http";
export const ETH = 10n ** 18n;
/** A config as loadShopConfig() returns it (the shape packshop/scripts/write-web-config.mjs writes, normalised). */
export const cfgFor = (extra = {}) => ({
  network: "liteforge", chainId: 4441, rpc: RPC, explorer: "https://explorer.test.invalid", faucet: "https://liteforge.hub.caldera.xyz",
  currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 }, packShop: SHOP, cards: BOB, templates: [], ...extra,
});

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Let every already-queued promise continuation run (microtasks only: no timer fires). */
export const flushMicrotasks = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
/** Record (and silence) console output for the duration of a test: const c = captureConsole(); try {...} finally { c.restore(); } */
export function captureConsole(methods = ["debug", "warn", "error"]) {
  const logs = [];
  const orig = {};
  for (const m of methods) { orig[m] = console[m]; console[m] = (...a) => logs.push([m, ...a]); }
  return { logs, restore() { for (const m of methods) console[m] = orig[m]; } };
}

// ------------------------------------------------------------------ errors in the two wire formats
/** What an EIP-1193 provider throws. */
export const providerError = (code, message, data) => Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
/** What a JSON-RPC node answers (converted to `{error}` by jsonRpcFetch). */
export const rpcError = (code, message, data) => Object.assign(new Error(message), { rpcError: { code, message, ...(data !== undefined ? { data } : {}) } });
export function revertData(name, args = []) {
  for (const i of [shopIface, ...otherIfaces]) {
    const f = i.getError(name);
    if (f) return i.encodeErrorResult(name, args);
  }
  throw new Error(`unknown error ${name}`);
}
export const revertRpcError = (name, args) => rpcError(3, "execution reverted", revertData(name, args));

// ------------------------------------------------------------------ fake fetch
/** A fetch that answers JSON-RPC via handler(method, params, body). handler may return a result, throw rpcError(...), or
 *  return a Response to take over the HTTP layer. Records every call in fetch.calls. */
export function jsonRpcFetch(handler) {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    f.calls.push({ url, init, body });
    const out = await handler(body.method, body.params, body, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: out }), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = [];
  const wrapped = async (url, init) => {
    try { return await f(url, init); }
    catch (e) {
      if (e?.rpcError) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: e.rpcError }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw e;
    }
  };
  wrapped.calls = f.calls;
  return wrapped;
}
/** A fetch that never answers until its AbortSignal fires (then rejects like the real one). */
export function hangingFetch() {
  const f = (url, init) => new Promise((_, reject) => {
    f.calls.push({ url, init });
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  f.calls = [];
  return f;
}

// ------------------------------------------------------------------ mock wallet (EIP-1193)
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), _map: m };
}

/**
 * A MetaMask-shaped provider. Knows chains `known` (unknown ones answer 4902 to a switch). `chain` (a fake chain) receives
 * eth_sendTransaction and answers eth_getBalance. p.once(method, behaviour) queues a one-shot: an Error is thrown,
 * a function is called with the params, anything else is returned.
 */
export function createMockProvider({ accounts = [ALICE], chainId = 4441, known = [1, 4441], chain = null, permitted = false } = {}) {
  const listeners = new Map();
  const queue = new Map();
  const p = {
    isMetaMask: true,
    calls: [],
    accounts,
    chainId,
    known: new Set(known),
    permitted,
    on(evt, fn) { (listeners.get(evt) ?? listeners.set(evt, new Set()).get(evt)).add(fn); return p; },
    removeListener(evt, fn) { listeners.get(evt)?.delete(fn); return p; },
    emit(evt, ...args) { for (const fn of [...(listeners.get(evt) ?? [])]) fn(...args); },
    listenerCount(evt) { return listeners.get(evt)?.size ?? 0; },
    once(method, behaviour) { (queue.get(method) ?? queue.set(method, []).get(method)).push(behaviour); },
    methods(name) { return p.calls.filter((c) => c.method === name); },
    async request({ method, params }) {
      p.calls.push({ method, params });
      const b = queue.get(method)?.shift();
      if (b !== undefined) {
        if (b instanceof Error) throw b;
        return typeof b === "function" ? b(params) : b;
      }
      switch (method) {
        case "eth_accounts": return p.permitted ? [...p.accounts] : [];
        case "eth_requestAccounts": p.permitted = true; return [...p.accounts];
        case "eth_chainId": return q(p.chainId);
        case "wallet_switchEthereumChain": {
          const id = parseInt(params[0].chainId, 16);
          if (!p.known.has(id)) throw providerError(4902, `Unrecognized chain ID "${params[0].chainId}". Try adding the chain using wallet_addEthereumChain first.`);
          p.chainId = id;
          p.emit("chainChanged", q(id));
          return null;
        }
        case "wallet_addEthereumChain": p.known.add(parseInt(params[0].chainId, 16)); return null;
        case "wallet_revokePermissions": p.permitted = false; return null;
        case "personal_sign": return "0x" + "ab".repeat(65);
        case "eth_getBalance": if (chain) return q(chain.balanceOf(params[0])); break;
        case "eth_sendTransaction": if (chain) return chain.sendTransaction(params[0]); break;
      }
      throw providerError(-32601, `The method ${method} does not exist / is not available`);
    },
  };
  return p;
}

/** A window-like EventTarget whose installed wallets answer eip6963:requestProvider, as real ones do. */
export function createMockWindow(wallets = [], ethereum) {
  const win = new EventTarget();
  win.addEventListener("eip6963:requestProvider", () => {
    for (const w of wallets) {
      win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: w.info, provider: w.provider }) }));
    }
  });
  if (ethereum) win.ethereum = ethereum;
  return win;
}
export const walletInfo = (name, rdns, uuid = `uuid-${rdns}`) => ({ uuid, name, icon: `data:image/svg+xml;base64,${name}`, rdns });

// ------------------------------------------------------------------ fake chain: PackShop semantics over JSON-RPC
/**
 * The fake keeps just enough PackShop state (packs, phases, daily limits) to drive the client end to end, encoding every
 * answer and log with ethers (so the client's decoders are checked against an independent encoder). Knobs on `st`:
 *   st.cfg {price, packSize, dailyLimit, paused, ready, weights, templateCount}   st.l1Block (what block.number returns)
 *   st.l2Block (RPC block number)   st.balances   st.gasPrice   st.estimate(tx) -> bigint   st.receiptDelay (null polls)
 *   st.failNext = { name } | { outOfGas: true }   st.hooks[method] = (params) => result | undefined (override or throw)
 */
export function createFakeChain({ chainId = 4441 } = {}) {
  const st = {
    chainId,
    l1Block: 5_000_000,
    l2Block: 100_000,
    gasPrice: 200_000_000n,
    balances: new Map(),
    cfg: { price: ETH / 10n, packSize: 5, dailyLimit: 3, paused: false, ready: true, weights: [50, 28, 15, 5, 2], templateCount: 12 },
    packs: new Map(),
    packsOf: new Map(),          // address -> every pack id it bought, oldest first (the contract's per-buyer index)
    bought: new Map(),           // address -> packs bought "today"
    nextPackId: 1n,
    tokenCounter: 0n,
    logs: [],
    receipts: new Map(),
    polls: new Map(),
    receiptDelay: 0,
    txs: [],                     // every eth_sendTransaction the fake accepted
    calls: [],                   // every JSON-RPC request, in order
    logQueries: [],
    hooks: {},
    estimate: (tx, result) => result.gas,
    failNext: null,
    simOverride: null,
  };
  const lc = (a) => String(a).toLowerCase();
  st.balances.set(lc(ALICE), 10n * ETH);

  const leftFor = (from) => (st.cfg.dailyLimit === 0 ? Infinity : Math.max(0, st.cfg.dailyLimit - (st.bought.get(from) ?? 0)));
  function phaseOf(id) {
    const p = st.packs.get(id);
    if (!p) return 0;
    if (p.state === "opened") return 4;
    if (p.state === "refunded") return 5;
    const reveal = p.commitBlock + 1n;
    const now = BigInt(st.l1Block);
    if (now <= reveal) return 1;
    return now - reveal > 255n ? 3 : 2;
  }
  const event = (name, args) => ({ address: lc(SHOP), ...shopIface.encodeEventLog(shopIface.getEvent(name), args) });

  /** Execute (commit) or dry-run one PackShop call. -> { revert } | { logs, gas } */
  function run(tx, commit) {
    const from = lc(tx.from);
    const value = BigInt(tx.value ?? 0);
    const d = shopIface.parseTransaction({ data: tx.data, value });
    if (!d) throw new Error(`fake chain: cannot parse calldata ${tx.data}`);
    switch (d.name) {
      case "buyPack": {
        if (st.cfg.paused) return { revert: "EnforcedPause" };
        if (!st.cfg.ready) return { revert: "NotStocked" };
        if (value !== st.cfg.price) return { revert: "WrongPayment" };
        if (leftFor(from) <= 0) return { revert: "DailyLimitReached" };
        const id = st.nextPackId;
        if (commit) {
          st.nextPackId += 1n;
          st.packs.set(id, { buyer: from, commitBlock: BigInt(st.l1Block), state: "sealed", paid: value });
          st.packsOf.set(from, [...(st.packsOf.get(from) ?? []), id]);
          st.bought.set(from, (st.bought.get(from) ?? 0) + 1);
        }
        return { logs: [event("PackBought", [id, from, value, BigInt(st.l1Block)])], gas: 180_000n };
      }
      case "openPack": {
        const id = d.args[0];
        const p = st.packs.get(id);
        if (!p || p.state !== "sealed") return { revert: "NotSealed" };
        const phase = phaseOf(id);
        if (phase === 1) return { revert: "TooEarly" };
        if (phase === 3) return { revert: "Expired" };
        const n = st.cfg.packSize;
        const tokenIds = Array.from({ length: n }, (_, i) => (7n << 32n) + st.tokenCounter + BigInt(i));
        const templateIds = Array.from({ length: n }, (_, i) => Number((id * 7n + BigInt(i) * 3n) % 12n));
        if (commit) { p.state = "opened"; st.tokenCounter += BigInt(n); }
        return { logs: [event("PackOpened", [id, p.buyer, tokenIds, templateIds])], gas: 7_400_000n };
      }
      case "refundExpired": {
        const id = d.args[0];
        const p = st.packs.get(id);
        if (!p || p.state !== "sealed") return { revert: "NotSealed" };
        if (phaseOf(id) !== 3) return { revert: "NotExpired" };
        if (commit) p.state = "refunded";
        return { logs: [event("PackRefunded", [id, p.buyer, p.paid])], gas: 90_000n };
      }
      default: throw new Error(`fake chain: unsupported call ${d.name}`);
    }
  }
  const simulate = (tx) => {
    if (st.simOverride && tx.data === st.simOverride.data) throw revertRpcError(st.simOverride.name);
    const r = run(tx, false);
    if (r.revert) throw revertRpcError(r.revert);
    return r;
  };

  function ethCall(tx) {
    if (lc(tx.to) !== lc(SHOP)) return "0x";                       // no contract there
    const sel = String(tx.data).slice(0, 10);
    const f = shopIface.getFunction(sel);
    if (!f) throw new Error(`fake chain: unknown selector ${sel}`);
    switch (f.name) {
      case "config": {
        const c = st.cfg;
        return shopIface.encodeFunctionResult("config", [c.price, c.packSize, c.dailyLimit, c.paused, c.ready, c.weights, c.templateCount]);
      }
      case "phaseOf": return shopIface.encodeFunctionResult("phaseOf", [phaseOf(shopIface.decodeFunctionData("phaseOf", tx.data)[0])]);
      case "packOf": {
        const id = shopIface.decodeFunctionData("packOf", tx.data)[0];
        const p = st.packs.get(id);
        return shopIface.encodeFunctionResult("packOf", [p ? p.buyer : ethers.ZeroAddress, p ? p.commitBlock : 0n, phaseOf(id), p ? p.paid : 0n]);
      }
      case "packsLeftToday": {
        const who = lc(shopIface.decodeFunctionData("packsLeftToday", tx.data)[0]);
        const left = leftFor(who);
        return shopIface.encodeFunctionResult("packsLeftToday", [left === Infinity ? ethers.MaxUint256 : BigInt(left)]);
      }
      case "packCountOf": {
        const who = lc(shopIface.decodeFunctionData("packCountOf", tx.data)[0]);
        return shopIface.encodeFunctionResult("packCountOf", [BigInt((st.packsOf.get(who) ?? []).length)]);
      }
      case "recentPacks": {                                    // same semantics as the contract: n capped at 16, oldest first
        const [who, n0] = shopIface.decodeFunctionData("recentPacks", tx.data);
        const all = st.packsOf.get(lc(who)) ?? [];
        const n = Math.min(Number(n0 < 16n ? n0 : 16n), all.length);
        const ids = all.slice(all.length - n);
        return shopIface.encodeFunctionResult("recentPacks", [ids, ids.map(phaseOf), ids.map((id) => st.packs.get(id).commitBlock)]);
      }
      case "buyPack": case "openPack": case "refundExpired": {
        simulate(tx);
        return "0x";
      }
      default: throw new Error(`fake chain: unsupported eth_call ${f.name}`);
    }
  }

  function getLogs(filter) {
    const from = parseInt(filter.fromBlock, 16);
    const to = parseInt(filter.toBlock, 16);
    st.logQueries.push({ from, to, filter });
    if (to - from + 1 > 20000) throw rpcError(-32602, "query exceeds max block range 20000");
    return st.logs.filter((l) => {
      if (filter.address && lc(filter.address) !== lc(l.address)) return false;
      if (l.blockNumberNum < from || l.blockNumberNum > to) return false;
      return (filter.topics ?? []).every((t, i) => t == null || lc(t) === lc(l.topics[i]));
    }).map(({ blockNumberNum, ...l }) => l);
  }

  /** eth_sendTransaction as the wallet would submit it. Returns the tx hash; the receipt is served by eth_getTransactionReceipt. */
  function sendTransaction(tx) {
    st.txs.push(tx);
    const hash = ethers.id(`tx-${st.txs.length}-${tx.data}`);
    const fail = st.failNext;
    st.failNext = null;
    st.l2Block += 1;
    let receipt;
    if (fail) {
      if (fail.name) st.simOverride = { data: tx.data, name: fail.name };
      const limit = BigInt(tx.gas ?? 0);
      receipt = { status: "0x0", gasUsed: q(fail.outOfGas ? limit : 60_000n), logs: [] };
    } else {
      const r = run(tx, true);
      if (r.revert) throw new Error(`fake chain: ${r.revert} on send; use failNext to model a reverted receipt`);
      const value = BigInt(tx.value ?? 0);
      st.balances.set(lc(tx.from), (st.balances.get(lc(tx.from)) ?? 0n) - value);
      const logs = r.logs.map((l, i) => ({ ...l, blockNumber: q(st.l2Block), transactionHash: hash, logIndex: q(i) }));
      logs.forEach((l) => st.logs.push({ ...l, blockNumberNum: st.l2Block }));
      receipt = { status: "0x1", gasUsed: q(r.gas), logs };
    }
    st.receipts.set(hash, { transactionHash: hash, blockNumber: q(st.l2Block), from: lc(tx.from), to: lc(tx.to), ...receipt });
    return hash;
  }

  function rpc(method, params) {
    st.calls.push({ method, params });
    const h = st.hooks[method];
    if (h) { const r = h(params, st); if (r !== undefined) return r; }
    switch (method) {
      case "eth_chainId": return q(st.chainId);
      case "eth_blockNumber": return q(st.l2Block);
      case "eth_gasPrice": return q(st.gasPrice);
      case "eth_getBalance": return q(st.balances.get(lc(params[0])) ?? 0n);
      case "eth_call": return ethCall(params[0]);
      case "eth_estimateGas": {
        const r = simulate(params[0]);
        return q(st.estimate(params[0], r));
      }
      case "eth_getLogs": return getLogs(params[0]);
      case "eth_getTransactionReceipt": {
        const hash = params[0];
        const n = (st.polls.get(hash) ?? 0) + 1;
        st.polls.set(hash, n);
        if (n <= st.receiptDelay) return null;
        return st.receipts.get(hash) ?? null;
      }
      default: throw rpcError(-32601, `The method ${method} does not exist`);
    }
  }

  const fetch = jsonRpcFetch((method, params) => rpc(method, params));
  return {
    st,
    fetch,
    rpc,
    sendTransaction,
    phaseOf,
    balanceOf: (a) => st.balances.get(lc(a)) ?? 0n,
    setBalance: (a, v) => st.balances.set(lc(a), BigInt(v)),
    /** Advance the contract-visible block.number (the parent chain's), which is what moves a pack Waiting -> Openable -> Expired. */
    mineL1(n = 1) { st.l1Block += n; st.l2Block += n * 48; },
    methods: (name) => st.calls.filter((c) => c.method === name),
  };
}
