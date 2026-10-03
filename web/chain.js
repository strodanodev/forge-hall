// FORGE — a tiny read-only JSON-RPC client for the public Liteforge RPC (plain fetch, no npm packages).
//
// WHY reads bypass the wallet: MetaMask forwards a read to whatever RPC URL it saved when the network was added (that
// can be slow, throttled or simply another node), it answers for whichever chain the wallet happens to be on (a
// player on Ethereum mainnet would silently read a different chain), and it cannot answer at all before the player
// connects. The public RPC allows CORS, so the page reads it directly and only *writes* (and signatures) go through
// the wallet. This client is also what estimates gas and waits for receipts, so a flaky wallet RPC cannot stall a flow.
//
// Failure model: transient trouble (network error, timeout, HTTP 408/425/429/5xx, "rate limit" style RPC errors) is
// retried with exponential backoff and jitter; everything else (reverts, bad params, 4xx) fails at once. Errors are
// RpcError with the JSON-RPC code/data attached, so a caller can decode revert data (see abi.js decodeRevert).

import { toQuantity, fromQuantity, isHex } from "./abi.js";

export class RpcError extends Error {
  /** props: rpcCode (JSON-RPC code), data (revert data etc.), status (HTTP), method, transient, timeout, txHash, cause */
  constructor(message, props = {}) {
    const { cause, ...rest } = props;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RpcError";
    this.rpcCode = null;
    this.data = null;
    this.status = null;
    this.method = null;
    this.transient = false;
    this.timeout = false;
    Object.assign(this, rest);
  }
  /** geth and Nitro report an eth_call / eth_estimateGas revert as code 3 ("execution reverted"), data = revert bytes. */
  get isRevert() { return this.rpcCode === 3 || /revert/i.test(this.message); }
}

/** Thrown when a caller-supplied AbortSignal fires. name === "AbortError" like the platform's own. */
export class AbortError extends Error {
  constructor(message = "Cancelled") { super(message); this.name = "AbortError"; this.aborted = true; }
}
export const isAbort = (e) => e?.name === "AbortError" || e?.aborted === true;

/** setTimeout as a promise that an AbortSignal can cut short (rejects with AbortError, and clears its timer). */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const onAbort = () => { clearTimeout(timer); reject(new AbortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const TRANSIENT_MESSAGE = /rate.?limit|too many requests|throttl|timeout|timed out|temporar|try again|overloaded|server busy/i;

// eth_getLogs and friends accept a number, a bigint, a hex string or a tag; normalise to what the wire wants.
const TAGS = new Set(["latest", "earliest", "pending", "safe", "finalized"]);
function blockTag(t) {
  if (t == null) return "latest";
  if (typeof t === "string" && (TAGS.has(t) || isHex(t))) return t;
  return toQuantity(t);
}
// tx fields -> wire format (quantities as hex); only what the caller gave.
function txParams({ from, to, data, value, gas } = {}) {
  const tx = {};
  if (from != null) tx.from = from;
  if (to != null) tx.to = to;
  if (data != null) tx.data = data;
  if (value != null) tx.value = toQuantity(value);
  if (gas != null) tx.gas = toQuantity(gas);
  return tx;
}

/**
 * createChain(rpcUrl, opts) -> read-only client.
 * opts: timeoutMs (per attempt, default 8000), retries (default 3, i.e. up to 4 attempts), backoffMs (default 400,
 * doubling, max 5000, +-25% jitter), fetch (default globalThis.fetch, resolved at call time so tests can swap it),
 * sleep / random (test hooks).
 */
export function createChain(rpc, opts = {}) {
  if (typeof rpc !== "string" || !/^https?:\/\//.test(rpc)) throw new RpcError("createChain needs an http(s) RPC url");
  const { timeoutMs: defaultTimeout = 8000, retries: defaultRetries = 3, backoffMs = 400, maxBackoffMs = 5000 } = opts;
  const pause = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;
  let nextId = 1;

  async function attempt(method, params, { timeoutMs, signal }) {
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new RpcError("fetch is not available in this environment", { method });
    if (signal?.aborted) throw new AbortError();
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let res;
      try {
        res = await f(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
          signal: ctl.signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new AbortError();
        if (timedOut) throw new RpcError(`The network did not answer ${method} within ${timeoutMs} ms`, { method, transient: true, timeout: true, cause: e });
        throw new RpcError(`Network error during ${method}: ${e?.message ?? e}`, { method, transient: true, cause: e });
      }
      if (!res.ok) {
        let text = "";
        try { text = (await res.text()).slice(0, 200); } catch { /* body unreadable: the status is enough */ }
        const s = res.status;
        throw new RpcError(`RPC HTTP ${s}${text ? `: ${text}` : ""}`, { method, status: s, transient: s === 408 || s === 425 || s === 429 || s >= 500 });
      }
      let body;
      try { body = await res.json(); } catch (e) {
        if (signal?.aborted) throw new AbortError();
        if (timedOut) throw new RpcError(`The network did not finish answering ${method} within ${timeoutMs} ms`, { method, transient: true, timeout: true, cause: e });
        throw new RpcError(`RPC answered ${method} with something that is not JSON`, { method, status: res.status, transient: true, cause: e });
      }
      if (body?.error) {
        const { code, message, data } = body.error;
        const text = typeof message === "string" ? message : "RPC error";
        throw new RpcError(text, { method, rpcCode: typeof code === "number" ? code : null, data: data ?? null, transient: code !== 3 && TRANSIENT_MESSAGE.test(text) });
      }
      if (!body || !("result" in body)) throw new RpcError(`RPC answered ${method} without a result`, { method, transient: true });
      return body.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Raw JSON-RPC with retries. o: { signal, timeoutMs, retries }. */
  async function request(method, params = [], o = {}) {
    const tries = 1 + (o.retries ?? defaultRetries);
    for (let i = 0; ; i++) {
      try {
        return await attempt(method, params, { timeoutMs: o.timeoutMs ?? defaultTimeout, signal: o.signal });
      } catch (e) {
        if (!(e instanceof RpcError) || !e.transient || i >= tries - 1) throw e;
        const base = Math.min(maxBackoffMs, backoffMs * 2 ** i);
        await pause(base * (0.75 + random() * 0.5), o.signal);
      }
    }
  }

  const hexResult = (r, method) => {
    if (typeof r !== "string" || !isHex(r)) throw new RpcError(`Unexpected ${method} result`, { method });
    return r;
  };

  async function waitForReceipt(hash, { timeoutMs = 120000, pollMs = 1500, signal } = {}) {
    if (!isHex(hash, 32)) throw new RpcError(`Not a transaction hash: ${String(hash)}`);   // fail now, not after the timeout
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      try {
        const r = await getReceipt(hash, { signal });
        if (r) return r;
        lastError = null;
      } catch (e) {
        // The transaction is already out; a hiccup while asking about it must not end the wait. Keep the last
        // error so a final timeout can say what was going wrong.
        if (isAbort(e)) throw e;
        lastError = e;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new RpcError(`Still no receipt for ${hash} after ${Math.round(timeoutMs / 1000)} s`, { method: "eth_getTransactionReceipt", timeout: true, txHash: hash, cause: lastError ?? undefined });
      }
      await pause(Math.min(pollMs, left), signal);
    }
  }
  async function getReceipt(hash, o = {}) {
    if (!isHex(hash, 32)) throw new RpcError(`Not a transaction hash: ${String(hash)}`);
    return (await request("eth_getTransactionReceipt", [hash], o)) ?? null;
  }

  return {
    rpc,
    request,
    async chainId(o) { return Number(fromQuantity(await request("eth_chainId", [], o))); },
    /** The L2 block number. Note this is NOT what the contract sees as block.number on a Nitro chain. */
    async blockNumber(o) { return Number(fromQuantity(await request("eth_blockNumber", [], o))); },
    async gasPrice(o) { return fromQuantity(await request("eth_gasPrice", [], o)); },
    /** The node's suggested tip (eth_maxPriorityFeePerGas). Nitro answers 0; a node without the method rejects. */
    async maxPriorityFeePerGas(o) { return fromQuantity(await request("eth_maxPriorityFeePerGas", [], o)); },
    async getBalance(address, tag = "latest", o) { return fromQuantity(await request("eth_getBalance", [address, blockTag(tag)], o)); },
    /** eth_call -> raw return data. Reverts reject with RpcError (rpcCode 3, .data = revert bytes). */
    async call({ blockTag: tag, ...tx }, o) { return hexResult(await request("eth_call", [txParams(tx), blockTag(tag)], o), "eth_call"); },
    async estimateGas(tx, o) { return fromQuantity(await request("eth_estimateGas", [txParams(tx)], o)); },
    /** filter: { address, topics, fromBlock, toBlock } (blocks: number | bigint | hex | tag). Raw logs. */
    async getLogs({ address, topics, fromBlock, toBlock }, o) {
      const f = { fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock) };
      if (address != null) f.address = address;
      if (topics != null) f.topics = topics;
      const logs = await request("eth_getLogs", [f], { timeoutMs: 15000, ...o });
      if (!Array.isArray(logs)) throw new RpcError("Unexpected eth_getLogs result", { method: "eth_getLogs" });
      return logs;
    },
    getReceipt,
    waitForReceipt,
  };
}
