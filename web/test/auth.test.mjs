// auth.js against a mock fetch (the /api/auth/* contract) and a mock wallet.
import test from "node:test";
import assert from "node:assert/strict";
import { signIn, me, signOut, ApiUnavailable, AuthError } from "../auth.js";
import { createWallet, WalletError } from "../wallet.js";
import { ethers, ALICE, createMockProvider, memoryStorage, providerError } from "./helpers.mjs";

const A = ALICE.toLowerCase();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status, body = "<html><body>Not Found</body></html>") => new Response(body, { status, headers: { "content-type": "text/html" } });

/** A fetch answering by "METHOD /path"; records calls. A route may be a Response, a function, or an Error to throw. */
function api(routes) {
  const f = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    f.calls.push({ url, init, key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = routes[key];
    if (r === undefined) return html(404);
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(f.calls.at(-1)) : r.clone();
  };
  f.calls = [];
  return f;
}
async function connected(provider = createMockProvider()) {
  const wallet = createWallet({ provider, storage: memoryStorage() });
  await wallet.connect();
  return { wallet, provider };
}
const MESSAGE = "forge.example wants you to sign in with your Ethereum account:\n" + ALICE + "\n\nNonce: 8c1f3e\nIssued At: 2026-09-30T12:00:00.000Z\n";

test("signIn: nonce -> personal_sign -> verify, with the exact contract", async () => {
  const { wallet, provider } = await connected();
  const order = [];
  provider.once("personal_sign", (params) => { order.push("sign"); return "0x" + "cd".repeat(65); });
  const f = api({
    "POST /api/auth/nonce": (c) => { order.push("nonce"); return json(200, { nonce: "8c1f3e", message: MESSAGE }); },
    "POST /api/auth/verify": (c) => { order.push("verify"); return json(200, { address: A, createdAt: "2026-09-30T12:00:01Z" }); },
  });
  const session = await signIn(wallet, { fetch: f });
  assert.deepEqual(session, { address: A, createdAt: "2026-09-30T12:00:01Z" });
  assert.deepEqual(order, ["nonce", "sign", "verify"]);
  const [nonce, verify] = f.calls;
  assert.deepEqual(nonce.body, { address: A }, "lowercase address, nothing else");
  assert.deepEqual(verify.body, { message: MESSAGE, signature: "0x" + "cd".repeat(65) }, "the message is signed and sent back verbatim");
  for (const c of f.calls) {
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.credentials, "same-origin", "the session cookie rides along");
    assert.equal(c.init.headers["content-type"], "application/json");
    assert.equal(c.init.headers.accept, "application/json");
  }
  assert.deepEqual(provider.methods("personal_sign")[0].params, [ethers.hexlify(ethers.toUtf8Bytes(MESSAGE)), A]);
});

test("signIn produces a signature the server side can verify with EIP-191", async () => {
  const signer = ethers.Wallet.createRandom();
  const provider = createMockProvider({ accounts: [signer.address] });
  provider.once("personal_sign", ([hex]) => signer.signMessage(ethers.getBytes(hex)));
  const { wallet } = await connected(provider);
  const message = `Sign in to FORGE\nAddress: ${signer.address}\nNonce: 42\nStatement: café ✓\n`;
  let recovered;
  const f = api({
    "POST /api/auth/nonce": json(200, { nonce: "42", message }),
    "POST /api/auth/verify": (c) => {
      assert.equal(c.body.message, message);
      recovered = ethers.verifyMessage(c.body.message, c.body.signature);
      return json(200, { address: recovered.toLowerCase(), createdAt: "now" });
    },
  });
  const session = await signIn(wallet, { fetch: f });
  assert.equal(recovered, signer.address);
  assert.equal(session.address, signer.address.toLowerCase());
});

test("signIn needs a connected wallet and does not touch the network otherwise", async () => {
  const wallet = createWallet({ provider: createMockProvider(), storage: memoryStorage() });
  const f = api({});
  await assert.rejects(signIn(wallet, { fetch: f }), (e) => e instanceof WalletError && e.code === "not_connected");
  await assert.rejects(signIn(undefined, { fetch: f }), (e) => e.code === "not_connected");
  assert.equal(f.calls.length, 0);
});

test("signIn: the player declining the signature stops the flow before verify", async () => {
  const { wallet, provider } = await connected();
  provider.once("personal_sign", providerError(4001, "User denied message signature."));
  const f = api({ "POST /api/auth/nonce": json(200, { nonce: "n", message: MESSAGE }), "POST /api/auth/verify": json(200, { address: A, createdAt: "x" }) });
  await assert.rejects(signIn(wallet, { fetch: f }), (e) => e instanceof WalletError && e.code === "user_rejected");
  assert.deepEqual(f.calls.map((c) => c.key), ["POST /api/auth/nonce"]);
  provider.once("personal_sign", providerError(-32002, "Already processing personal_sign."));
  await assert.rejects(signIn(wallet, { fetch: f }), (e) => e.code === "request_pending");
});

test("signIn: the server's own error text reaches the caller as AuthError", async () => {
  const { wallet, provider } = await connected();
  const f1 = api({ "POST /api/auth/nonce": json(400, { error: "Invalid address" }) });
  await assert.rejects(signIn(wallet, { fetch: f1 }), (e) => e instanceof AuthError && e.status === 400 && e.message === "Invalid address" && e.name === "AuthError");
  assert.equal(provider.methods("personal_sign").length, 0, "nothing was signed for a refused nonce");

  const f2 = api({ "POST /api/auth/nonce": json(429, { error: "Too many sign-in attempts. Try again in a minute." }) });
  await assert.rejects(signIn(wallet, { fetch: f2 }), (e) => e.status === 429 && /Too many/.test(e.message));

  const f3 = api({
    "POST /api/auth/nonce": json(200, { nonce: "n", message: MESSAGE }),
    "POST /api/auth/verify": json(401, { error: "Signature does not match the address" }),
  });
  await assert.rejects(signIn(wallet, { fetch: f3 }), (e) => e instanceof AuthError && e.status === 401 && e.message === "Signature does not match the address");

  const f4 = api({ "POST /api/auth/nonce": json(500, {}) });
  await assert.rejects(signIn(wallet, { fetch: f4 }), (e) => e instanceof AuthError && e.status === 500 && /HTTP 500/.test(e.message));
  const f5 = api({ "POST /api/auth/nonce": html(500, "Internal Server Error") });
  await assert.rejects(signIn(wallet, { fetch: f5 }), (e) => e instanceof AuthError && e.status === 500);
});

test("signIn: an unreadable challenge or session is reported, not signed or trusted", async () => {
  const { wallet, provider } = await connected();
  for (const bad of [{ nonce: "n" }, { nonce: "n", message: "" }, { nonce: "n", message: 5 }]) {
    const f = api({ "POST /api/auth/nonce": json(200, bad) });
    await assert.rejects(signIn(wallet, { fetch: f }), (e) => e instanceof AuthError && /unreadable challenge/.test(e.message), JSON.stringify(bad));
  }
  assert.equal(provider.methods("personal_sign").length, 0);
  const f = api({ "POST /api/auth/nonce": json(200, { nonce: "n", message: MESSAGE }), "POST /api/auth/verify": html(200, "ok") });
  await assert.rejects(signIn(wallet, { fetch: f }), ApiUnavailable);
});

test("signIn / me / signOut without a backend fail with ApiUnavailable (so the UI can hide the button)", async () => {
  const { wallet } = await connected();
  const offline = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(signIn(wallet, { fetch: offline }), (e) => e instanceof ApiUnavailable && e.cause instanceof TypeError && e.name === "ApiUnavailable");
  await assert.rejects(me({ fetch: offline }), ApiUnavailable);
  await assert.rejects(signOut({ fetch: offline }), ApiUnavailable);
  for (const status of [404, 405, 501, 502, 503, 504]) {
    const f = async () => html(status);
    await assert.rejects(me({ fetch: f }), (e) => e instanceof ApiUnavailable && e.status === status, `me ${status}`);
    await assert.rejects(signIn(wallet, { fetch: f }), (e) => e instanceof ApiUnavailable, `signIn ${status}`);
    await assert.rejects(signOut({ fetch: f }), (e) => e instanceof ApiUnavailable, `signOut ${status}`);
  }
  // ... but when the API itself answers with an error body it is the API talking, whatever the status
  await assert.rejects(me({ fetch: async () => json(404, { error: "no such session" }) }), (e) => e instanceof AuthError && e.status === 404 && e.message === "no such session");
  await assert.rejects(me({ fetch: async () => json(503, { error: "database is down" }) }), (e) => e instanceof AuthError && e.message === "database is down");
});

test("me(): the session, or null when signed out (401)", async () => {
  const f = api({ "GET /api/auth/me": json(200, { address: A, createdAt: "2026-09-30T12:00:01Z" }) });
  assert.deepEqual(await me({ fetch: f }), { address: A, createdAt: "2026-09-30T12:00:01Z" });
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal(f.calls[0].init.headers["content-type"], undefined, "a GET carries no body type");

  assert.equal(await me({ fetch: api({ "GET /api/auth/me": json(401, { error: "Not signed in" }) }) }), null);
  assert.equal(await me({ fetch: api({ "GET /api/auth/me": new Response(null, { status: 401 }) }) }), null);

  await assert.rejects(me({ fetch: api({ "GET /api/auth/me": json(500, { error: "db down" }) }) }), (e) => e instanceof AuthError && e.status === 500 && e.message === "db down");
  await assert.rejects(me({ fetch: api({ "GET /api/auth/me": html(200, "<html>SPA fallback</html>") }) }), ApiUnavailable, "a static host answering 200 with its index page");
  await assert.rejects(me({ fetch: api({ "GET /api/auth/me": json(200, { nothing: true }) }) }), ApiUnavailable);
  await assert.rejects(me({ fetch: api({ "GET /api/auth/me": json(200, [1, 2]) }) }), ApiUnavailable);
});

test("signOut(): 204 is done, already signed out is done, failures are reported", async () => {
  const f = api({ "POST /api/auth/logout": new Response(null, { status: 204 }) });
  assert.equal(await signOut({ fetch: f }), true);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json", "every POST carries the JSON content type the API requires, logout too");
  assert.equal(await signOut({ fetch: api({ "POST /api/auth/logout": json(200, { ok: true }) }) }), true);
  assert.equal(await signOut({ fetch: api({ "POST /api/auth/logout": json(401, { error: "Not signed in" }) }) }), true);
  await assert.rejects(signOut({ fetch: api({ "POST /api/auth/logout": json(500, { error: "boom" }) }) }), (e) => e instanceof AuthError && e.message === "boom");
});

test("base prefixes every path; the global fetch is the default", async () => {
  const f = api({ "GET /forge/api/auth/me": json(200, { address: A }), "POST /forge/api/auth/logout": new Response(null, { status: 204 }) });
  assert.equal((await me({ fetch: f, base: "/forge" })).address, A);
  assert.equal(await signOut({ fetch: f, base: "/forge" }), true);

  const saved = globalThis.fetch;
  const g = api({ "GET /api/auth/me": json(200, { address: A }) });
  globalThis.fetch = g;
  try {
    assert.equal((await me()).address, A);
    assert.equal(g.calls.length, 1);
    globalThis.fetch = undefined;
    await assert.rejects(me(), ApiUnavailable);
  } finally { globalThis.fetch = saved; }
});
