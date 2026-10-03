// chain.js: the read-only JSON-RPC client (wire format, retry/backoff, timeouts, abort, receipt polling).
import test from "node:test";
import assert from "node:assert/strict";
import { createChain, RpcError, AbortError, isAbort, sleep } from "../chain.js";
import { jsonRpcFetch, hangingFetch, rpcError, revertRpcError, revertData, RPC, ALICE, SHOP, q, tick } from "./helpers.mjs";

const HASH = "0x" + "ab".repeat(32);
/** A client with test-sized timings and a recorded (instant) backoff. */
function client(fetch, opts = {}) {
  const sleeps = [];
  const chain = createChain(RPC, { fetch, timeoutMs: 200, backoffMs: 400, random: () => 0.5, sleep: async (ms, signal) => { sleeps.push(ms); if (signal?.aborted) throw new AbortError(); }, ...opts });
  return { chain, sleeps };
}

test("createChain validates its inputs", async () => {
  assert.throws(() => createChain("not a url"), RpcError);
  assert.throws(() => createChain(undefined), RpcError);
  const chain = createChain(RPC, { fetch: undefined });
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try { await assert.rejects(chain.blockNumber(), /fetch is not available/); } finally { globalThis.fetch = saved; }
});

test("request: JSON-RPC 2.0 POST, incrementing ids, content-type, result returned", async () => {
  const fetch = jsonRpcFetch((method) => (method === "eth_chainId" ? "0x1159" : "0x10"));
  const { chain } = client(fetch);
  assert.equal(await chain.request("eth_chainId"), "0x1159");
  assert.equal(await chain.request("eth_blockNumber", []), "0x10");
  assert.equal(fetch.calls.length, 2);
  const [a, b] = fetch.calls;
  assert.equal(a.url, RPC);
  assert.equal(a.init.method, "POST");
  assert.equal(a.init.headers["content-type"], "application/json");
  assert.deepEqual(a.body, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  assert.equal(b.body.id, 2);
  assert.ok(a.init.signal instanceof AbortSignal, "every request is abortable (that is how the timeout works)");
});

test("typed helpers build the right params and parse the results", async () => {
  const seen = [];
  const fetch = jsonRpcFetch((method, params) => {
    seen.push([method, params]);
    switch (method) {
      case "eth_chainId": return "0x1159";
      case "eth_blockNumber": return q(123_456);
      case "eth_gasPrice": return q(200_000_000);
      case "eth_getBalance": return q(10n ** 18n);
      case "eth_call": return "0x" + "00".repeat(31) + "02";
      case "eth_estimateGas": return q(7_400_000);
      case "eth_getLogs": return [{ data: "0x" }];
      case "eth_getTransactionReceipt": return null;
    }
  });
  const { chain } = client(fetch);
  assert.equal(await chain.chainId(), 4441);
  assert.equal(await chain.blockNumber(), 123_456);
  assert.equal(await chain.gasPrice(), 200_000_000n);
  assert.equal(await chain.getBalance(ALICE), 10n ** 18n);
  assert.equal(await chain.getBalance(ALICE, 255), 10n ** 18n);
  assert.equal(await chain.call({ to: SHOP, data: "0x9a243ebf" }), "0x" + "00".repeat(31) + "02");
  assert.equal(await chain.call({ to: SHOP, data: "0x", from: ALICE, value: 5n, blockTag: 99n }), "0x" + "00".repeat(31) + "02");
  assert.equal(await chain.estimateGas({ from: ALICE, to: SHOP, data: "0xc37b9bcd", value: 10n ** 17n }), 7_400_000n);
  assert.deepEqual(await chain.getLogs({ address: SHOP, topics: ["0xaa", null, "0xbb"], fromBlock: 1000, toBlock: "latest" }), [{ data: "0x" }]);
  assert.equal(await chain.getReceipt(HASH), null);

  const by = (name) => seen.filter(([m]) => m === name).map(([, p]) => p);
  assert.deepEqual(by("eth_getBalance"), [[ALICE, "latest"], [ALICE, "0xff"]]);
  assert.deepEqual(by("eth_call"), [
    [{ to: SHOP, data: "0x9a243ebf" }, "latest"],
    [{ to: SHOP, data: "0x", from: ALICE, value: "0x5" }, "0x63"],
  ]);
  assert.deepEqual(by("eth_estimateGas"), [[{ from: ALICE, to: SHOP, data: "0xc37b9bcd", value: "0x16345785d8a0000" }]]);
  assert.deepEqual(by("eth_getLogs"), [[{ fromBlock: "0x3e8", toBlock: "latest", address: SHOP, topics: ["0xaa", null, "0xbb"] }]]);
  assert.deepEqual(by("eth_getTransactionReceipt"), [[HASH]]);
});

test("helpers refuse malformed input and unexpected results instead of guessing", async () => {
  const { chain } = client(jsonRpcFetch((method) => (method === "eth_call" ? 5 : method === "eth_getLogs" ? "nope" : "not hex")));
  await assert.rejects(chain.getReceipt("0x1234"), /Not a transaction hash/);
  await assert.rejects(chain.call({ to: SHOP, data: "0x" }), /Unexpected eth_call result/);
  await assert.rejects(chain.getLogs({ address: SHOP, fromBlock: 1, toBlock: 2 }), /Unexpected eth_getLogs result/);
  await assert.rejects(chain.blockNumber(), /not a hex quantity/);
  await assert.rejects(chain.getBalance(ALICE, -1), /negative/);
});

test("transient failures are retried with exponential backoff and jitter, then the answer comes through", async () => {
  let n = 0;
  const fetch = async (url, init) => {
    n++;
    if (n <= 3) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7" }), { status: 200 });
  };
  const { chain, sleeps } = client(fetch);
  assert.equal(await chain.blockNumber(), 7);
  assert.equal(n, 4);
  assert.deepEqual(sleeps, [400, 800, 1600], "base * 2^attempt, jitter factor 1.0 with random()=0.5");
});

test("jitter stays within +-25% of the backoff and the delay is capped", async () => {
  for (const [r, factor] of [[0, 0.75], [1, 1.25]]) {
    const { chain, sleeps } = client(async () => { throw new TypeError("offline"); }, { random: () => r, retries: 2 });
    await assert.rejects(chain.blockNumber(), RpcError);
    assert.deepEqual(sleeps, [400 * factor, 800 * factor]);
  }
  const { chain, sleeps } = client(async () => { throw new TypeError("offline"); }, { retries: 6, backoffMs: 1000, maxBackoffMs: 3000 });
  await assert.rejects(chain.blockNumber(), RpcError);
  assert.deepEqual(sleeps, [1000, 2000, 3000, 3000, 3000, 3000]);
});

test("a network that never recovers fails after the configured attempts, with a transient RpcError", async () => {
  let calls = 0;
  const { chain } = client(async () => { calls++; throw new TypeError("Failed to fetch"); });
  await assert.rejects(chain.blockNumber(), (e) => e instanceof RpcError && e.transient === true && /Network error during eth_blockNumber/.test(e.message) && e.cause instanceof TypeError);
  assert.equal(calls, 4, "1 try + 3 retries");
  calls = 0;
  await assert.rejects(chain.request("eth_blockNumber", [], { retries: 0 }), RpcError);
  assert.equal(calls, 1, "per-call retries override");
});

test("HTTP 408/425/429/5xx are retried; other 4xx fail at once", async () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    let n = 0;
    const { chain } = client(async () => (++n === 1 ? new Response("busy", { status }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x1" }), { status: 200 })));
    assert.equal(await chain.blockNumber(), 1, `HTTP ${status}`);
    assert.equal(n, 2, `HTTP ${status}`);
  }
  for (const status of [400, 401, 403, 404, 413]) {
    let n = 0;
    const { chain } = client(async () => { n++; return new Response("no", { status }); });
    await assert.rejects(chain.blockNumber(), (e) => e instanceof RpcError && e.status === status && e.transient === false && e.message.includes(`HTTP ${status}`));
    assert.equal(n, 1, `HTTP ${status} is not retried`);
  }
});

test("JSON-RPC errors: reverts and bad params are final, rate limits are retried", async () => {
  // a revert: code 3, data kept, isRevert, never retried
  let n = 0;
  const fetch = jsonRpcFetch(() => { n++; throw revertRpcError("TooEarly"); });
  const { chain } = client(fetch);
  await assert.rejects(chain.call({ to: SHOP, data: "0x50a88c7e" }), (e) =>
    e instanceof RpcError && e.rpcCode === 3 && e.isRevert && e.transient === false && e.data === revertData("TooEarly") && e.method === "eth_call");
  assert.equal(n, 1);

  n = 0;
  const bad = client(jsonRpcFetch(() => { n++; throw rpcError(-32602, "invalid argument 0: hex string without 0x prefix"); }));
  await assert.rejects(bad.chain.blockNumber(), (e) => e.rpcCode === -32602 && !e.transient && !e.isRevert);
  assert.equal(n, 1);

  for (const message of ["rate limit exceeded", "Too Many Requests", "request timed out", "server busy, try again later", "temporarily unavailable"]) {
    n = 0;
    const limited = client(jsonRpcFetch(() => { if (++n === 1) throw rpcError(-32005, message); return "0x5"; }));
    assert.equal(await limited.chain.blockNumber(), 5, message);
    assert.equal(n, 2, message);
  }
  // a revert whose text happens to say "timeout" is still a revert
  n = 0;
  const tricky = client(jsonRpcFetch(() => { n++; throw rpcError(3, "execution reverted: timeout window closed", "0x08c379a0"); }));
  await assert.rejects(tricky.chain.blockNumber(), (e) => e.isRevert);
  assert.equal(n, 1);
});

test("garbage from the server: non-JSON and result-less bodies are transient", async () => {
  let n = 0;
  const html = client(async () => { n++; return new Response("<html>502 Bad Gateway</html>", { status: 200 }); });
  await assert.rejects(html.chain.blockNumber(), (e) => e instanceof RpcError && /not JSON/.test(e.message) && e.transient);
  assert.equal(n, 4);
  n = 0;
  const empty = client(async () => { n++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 }); });
  await assert.rejects(empty.chain.blockNumber(), /without a result/);
  assert.equal(n, 4);
});

test("a request that never answers times out, and the timeout is retried", async () => {
  const fetch = hangingFetch();
  const { chain } = client(fetch, { timeoutMs: 15, retries: 1 });
  const t0 = Date.now();
  await assert.rejects(chain.blockNumber(), (e) => e instanceof RpcError && e.timeout === true && e.transient === true && /did not answer eth_blockNumber within 15 ms/.test(e.message));
  assert.equal(fetch.calls.length, 2, "1 try + 1 retry");
  assert.ok(Date.now() - t0 < 1000);
  // per-call timeout override
  const f2 = hangingFetch();
  const c2 = client(f2, { timeoutMs: 5000 }).chain;
  await assert.rejects(c2.request("eth_blockNumber", [], { timeoutMs: 10, retries: 0 }), (e) => e.timeout);
});

test("a body that stalls after the headers also times out", async () => {
  const stalled = (url, init) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
  });
  const { chain } = client(stalled, { timeoutMs: 15, retries: 0 });
  await assert.rejects(chain.blockNumber(), (e) => e.timeout === true && /did not finish answering/.test(e.message));
});

test("the caller's AbortSignal cancels an in-flight request without retrying", async () => {
  const fetch = hangingFetch();
  const { chain } = client(fetch, { timeoutMs: 5000 });
  const ctl = new AbortController();
  const p = chain.request("eth_blockNumber", [], { signal: ctl.signal });
  await tick(5);
  ctl.abort();
  await assert.rejects(p, (e) => e instanceof AbortError && isAbort(e) && e.name === "AbortError");
  assert.equal(fetch.calls.length, 1);
  // already aborted: not even sent
  await assert.rejects(chain.request("eth_blockNumber", [], { signal: ctl.signal }), AbortError);
  assert.equal(fetch.calls.length, 1);
});

test("abort during the backoff pause ends the retry loop", async () => {
  const ctl = new AbortController();
  let calls = 0;
  const chain = createChain(RPC, {
    fetch: async () => { calls++; throw new TypeError("offline"); },
    backoffMs: 5000,   // real sleep(): a long pause that the abort must cut short
  });
  const p = chain.request("eth_blockNumber", [], { signal: ctl.signal });
  await tick(20);
  ctl.abort();
  const t0 = Date.now();
  await assert.rejects(p, AbortError);
  assert.ok(Date.now() - t0 < 500, "did not sit out the 5 s backoff");
  assert.equal(calls, 1);
});

test("sleep() resolves, and rejects with AbortError when aborted (clearing its timer)", async () => {
  const t0 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t0 >= 15);
  const ctl = new AbortController();
  const p = sleep(60_000, ctl.signal);
  ctl.abort();
  await assert.rejects(p, AbortError);
  await assert.rejects(sleep(10, ctl.signal), AbortError, "an already-aborted signal rejects immediately");
  await sleep(0);
});

test("waitForReceipt polls until the receipt exists", async () => {
  let polls = 0;
  const receipt = { status: "0x1", transactionHash: HASH, logs: [] };
  const { chain } = client(jsonRpcFetch(() => (++polls < 4 ? null : receipt)), { sleep });
  const t0 = Date.now();
  assert.deepEqual(await chain.waitForReceipt(HASH, { pollMs: 5, timeoutMs: 5000 }), receipt);
  assert.equal(polls, 4);
  assert.ok(Date.now() - t0 >= 10, "waited between polls");
});

test("waitForReceipt gives up at the deadline with a timeout RpcError that names the transaction", async () => {
  let polls = 0;
  const { chain } = client(jsonRpcFetch(() => { polls++; return null; }), { sleep });
  const t0 = Date.now();
  await assert.rejects(chain.waitForReceipt(HASH, { pollMs: 5, timeoutMs: 60 }), (e) =>
    e instanceof RpcError && e.timeout === true && e.txHash === HASH && e.message.includes(HASH));
  const took = Date.now() - t0;
  assert.ok(took >= 55 && took < 1000, `took ${took} ms`);
  assert.ok(polls >= 2, `polled ${polls} times`);   // Windows timers tick at ~15 ms: do not assume a poll every 5 ms
});

test("waitForReceipt outlives an RPC hiccup, and reports it if the deadline passes while things are broken", async () => {
  let n = 0;
  const { chain } = client(jsonRpcFetch(() => {
    n++;
    if (n === 2) throw rpcError(-32603, "internal error");        // a permanent-looking failure mid-wait
    return n < 4 ? null : { status: "0x1", logs: [] };
  }), { sleep, retries: 0 });
  assert.equal((await chain.waitForReceipt(HASH, { pollMs: 3, timeoutMs: 5000 })).status, "0x1");
  assert.equal(n, 4);

  const broken = client(jsonRpcFetch(() => { throw rpcError(-32603, "internal error"); }), { sleep, retries: 0 });
  await assert.rejects(broken.chain.waitForReceipt(HASH, { pollMs: 3, timeoutMs: 30 }), (e) => e.timeout && e.cause?.message === "internal error");
});

test("waitForReceipt can be aborted between polls and mid-request", async () => {
  const ctl = new AbortController();
  const { chain } = client(jsonRpcFetch(() => null), { sleep });
  const p = chain.waitForReceipt(HASH, { pollMs: 10, timeoutMs: 60_000, signal: ctl.signal });
  await tick(30);
  ctl.abort();
  await assert.rejects(p, AbortError);
  await assert.rejects(chain.waitForReceipt(HASH, { signal: ctl.signal }), AbortError, "already aborted");

  const ctl2 = new AbortController();
  const hang = createChain(RPC, { fetch: hangingFetch(), timeoutMs: 5000 });
  const p2 = hang.waitForReceipt(HASH, { pollMs: 10, signal: ctl2.signal });
  await tick(10);
  ctl2.abort();
  await assert.rejects(p2, AbortError);
});

test("waitForReceipt rejects a malformed hash immediately, not after the timeout", async () => {
  const fetch = jsonRpcFetch(() => null);
  const { chain } = client(fetch);
  const t0 = Date.now();
  await assert.rejects(chain.waitForReceipt("0x1234", { timeoutMs: 60_000 }), /Not a transaction hash/);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(fetch.calls.length, 0);
});
