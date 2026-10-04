// End-to-end tests of the sign-in API: real handlers, real HTTP, real ethers
// wallets signing the server-issued message, in-memory Postgres (PGlite).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Wallet, getAddress } from 'ethers';
import { SIWE_STATEMENT } from '../_lib/config.js';
import { setDb } from '../_lib/db.js';
import { HOST, call, craftMessage, parseSetCookie, sessionCookieFrom, signIn, startApp } from './helpers.js';

let app;

before(
  async () => {
    app = await startApp();
  },
  { timeout: 180_000 },
);

after(async () => {
  await app.close();
});

beforeEach(async () => {
  app.useDb();
  await app.reset();
  delete process.env.ALLOWED_HOSTS;
  delete process.env.SIWE_CHAIN_ID;
});

const rows = async (sql, params = []) => (await app.pg.query(sql, params)).rows;

// A nonce issued by the real endpoint for `wallet`, for tests that then craft their own message.
async function issueNonce(wallet, opts = {}) {
  const res = await call(app, '/api/auth/nonce', { ...opts, json: { address: wallet.address } });
  assert.equal(res.status, 200);
  return res.json.nonce;
}

async function verifyWith(wallet, message, opts = {}) {
  const signature = await wallet.signMessage(message);
  return call(app, '/api/auth/verify', { ...opts, json: { message, signature } });
}

// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('nonce -> personal_sign -> verify -> me -> logout -> me is 401', async () => {
    const wallet = Wallet.createRandom();
    const checksummed = getAddress(wallet.address);

    // 1. nonce (browsers hand over the lowercase address MetaMask gives them)
    const nonceRes = await call(app, '/api/auth/nonce', { json: { address: wallet.address.toLowerCase() } });
    assert.equal(nonceRes.status, 200);
    assert.match(nonceRes.json.nonce, /^[A-Za-z0-9]{16,}$/);

    const lines = nonceRes.json.message.split('\n');
    assert.equal(lines[0], `${HOST} wants you to sign in with your Ethereum account:`);
    assert.equal(lines[1], checksummed);
    assert.equal(lines[2], '');
    assert.equal(lines[3], SIWE_STATEMENT);
    assert.equal(lines[3], 'Sign in to the FORGE. This request will not trigger a blockchain transaction or cost any gas.');
    assert.equal(lines[4], '');
    assert.equal(lines[5], `URI: https://${HOST}`);
    assert.equal(lines[6], 'Version: 1');
    assert.equal(lines[7], 'Chain ID: 4441');
    assert.equal(lines[8], `Nonce: ${nonceRes.json.nonce}`);
    const issuedAt = Date.parse(lines[9].replace('Issued At: ', ''));
    const expiresAt = Date.parse(lines[10].replace('Expiration Time: ', ''));
    assert.ok(Math.abs(Date.now() - issuedAt) < 10_000);
    assert.equal(expiresAt - issuedAt, 10 * 60 * 1000);
    assert.equal(lines.length, 11);

    const [stored] = await rows('select nonce, address, expires_at, created_at from auth_nonces');
    assert.equal(stored.nonce, nonceRes.json.nonce);
    assert.equal(stored.address, checksummed.toLowerCase()); // stored lowercase
    assert.equal(new Date(stored.expires_at).getTime(), expiresAt);

    // 2. sign exactly like MetaMask personal_sign and verify
    const signature = await wallet.signMessage(nonceRes.json.message);
    const verifyRes = await call(app, '/api/auth/verify', { json: { message: nonceRes.json.message, signature } });
    assert.equal(verifyRes.status, 200);
    assert.deepEqual(Object.keys(verifyRes.json).sort(), ['address', 'createdAt']);
    assert.equal(verifyRes.json.address, checksummed);
    assert.equal(new Date(verifyRes.json.createdAt).toISOString(), verifyRes.json.createdAt);
    const cookie = sessionCookieFrom(verifyRes);
    assert.ok(cookie, 'a session cookie is set');

    // the nonce is spent, the player exists
    assert.equal((await rows('select * from auth_nonces')).length, 0);
    const players = await rows('select address, display_name from players');
    assert.deepEqual(players, [{ address: checksummed.toLowerCase(), display_name: null }]);

    // 3. me
    const meRes = await call(app, '/api/auth/me', { method: 'GET', cookie });
    assert.equal(meRes.status, 200);
    assert.deepEqual(meRes.json, {
      address: checksummed,
      createdAt: verifyRes.json.createdAt,
      displayName: null,
    });

    // 4. logout
    const logoutRes = await call(app, '/api/auth/logout', { json: {}, cookie });
    assert.equal(logoutRes.status, 204);
    assert.equal(logoutRes.text, '');
    const cleared = parseSetCookie(logoutRes.setCookie[0]);
    assert.equal(cleared.name, 'forge_session');
    assert.equal(cleared.value, '');
    assert.equal(cleared.attrs['max-age'], '0');
    assert.equal((await rows('select * from sessions')).length, 0);

    // 5. the old cookie is dead
    const afterLogout = await call(app, '/api/auth/me', { method: 'GET', cookie });
    assert.equal(afterLogout.status, 401);
    assert.deepEqual(afterLogout.json, { error: 'not signed in' });
  });

  it('me without any cookie is 401', async () => {
    const res = await call(app, '/api/auth/me', { method: 'GET' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'not signed in' });
  });

  it('a returning player keeps createdAt and displayName, and gets a fresh session', async () => {
    const wallet = Wallet.createRandom();
    const first = await signIn(app, wallet);
    await app.pg.query("update players set display_name = 'Smith'");
    const second = await signIn(app, wallet);

    assert.equal(second.verifyRes.status, 200);
    assert.equal(second.verifyRes.json.createdAt, first.verifyRes.json.createdAt);
    assert.notEqual(second.cookie, first.cookie);

    const me = await call(app, '/api/auth/me', { method: 'GET', cookie: second.cookie });
    assert.equal(me.json.displayName, 'Smith');
    assert.equal((await rows('select * from players')).length, 1);
  });

  it('accepts a checksummed or lowercase address and always signs the checksummed one', async () => {
    const wallet = Wallet.createRandom();
    for (const address of [getAddress(wallet.address), wallet.address.toLowerCase()]) {
      const res = await call(app, '/api/auth/nonce', { json: { address } });
      assert.equal(res.status, 200);
      assert.equal(res.json.message.split('\n')[1], getAddress(wallet.address));
    }
  });

  it('issues a different nonce every time, and several can be pending for one address', async () => {
    const wallet = Wallet.createRandom();
    const a = await issueNonce(wallet);
    const b = await issueNonce(wallet);
    assert.notEqual(a, b);
    assert.equal((await rows('select * from auth_nonces')).length, 2);
  });

  it('stores only the SHA-256 of the session token, never the token', async () => {
    const wallet = Wallet.createRandom();
    const { cookie } = await signIn(app, wallet);
    const token = cookie.split('=')[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url

    const sessions = await rows('select * from sessions');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].token_hash, createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(sessions).includes(token));
    assert.equal(sessions[0].address, getAddress(wallet.address).toLowerCase());
    const days = (new Date(sessions[0].expires_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 6.99 && days <= 7.001, `session lasts 7 days (got ${days})`);
  });

  it('records the user agent (truncated) on the session', async () => {
    const wallet = Wallet.createRandom();
    await signIn(app, wallet, { headers: { 'user-agent': 'x'.repeat(1000) } });
    const [row] = await rows('select user_agent from sessions');
    assert.equal(row.user_agent.length, 256);
  });
});

// ---------------------------------------------------------------------------

describe('nonce handling', () => {
  it('a nonce is single use: replaying the same signed message fails', async () => {
    const wallet = Wallet.createRandom();
    const first = await signIn(app, wallet);
    assert.equal(first.verifyRes.status, 200);

    const replay = await call(app, '/api/auth/verify', { json: { message: first.message, signature: first.signature } });
    assert.equal(replay.status, 401);
    assert.deepEqual(replay.json, { error: 'nonce expired or already used' });
    assert.deepEqual(replay.setCookie, []);
    assert.equal((await rows('select * from sessions')).length, 1, 'the replay created no session');
  });

  it('two concurrent replays of one signed message: exactly one wins', async () => {
    const wallet = Wallet.createRandom();
    const nonceRes = await call(app, '/api/auth/nonce', { json: { address: wallet.address } });
    const { message } = nonceRes.json;
    const signature = await wallet.signMessage(message);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(app, '/api/auth/verify', { json: { message, signature } })),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 401, 401, 401, 401]);
    assert.equal((await rows('select * from sessions')).length, 1);
  });

  it('a nonce is bound to the address it was issued for', async () => {
    const alice = Wallet.createRandom();
    const mallory = Wallet.createRandom();

    // Alice asks for a login challenge...
    const aliceNonce = await call(app, '/api/auth/nonce', { json: { address: alice.address } });
    // ...Mallory reuses Alice's nonce in a perfectly valid message of her own, signed with her own key.
    const stolen = craftMessage({ address: mallory.address, nonce: aliceNonce.json.nonce });
    const attack = await verifyWith(mallory, stolen);
    assert.equal(attack.status, 401);
    assert.deepEqual(attack.json, { error: 'nonce expired or already used' });
    assert.deepEqual(attack.setCookie, []);

    // The failed attempt did not burn Alice's nonce: her login still works.
    const aliceSig = await alice.signMessage(aliceNonce.json.message);
    const ok = await call(app, '/api/auth/verify', { json: { message: aliceNonce.json.message, signature: aliceSig } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.address, getAddress(alice.address));
  });

  it('an expired nonce is refused', async () => {
    const wallet = Wallet.createRandom();
    const nonceRes = await call(app, '/api/auth/nonce', { json: { address: wallet.address } });
    await app.pg.query("update auth_nonces set expires_at = now() - interval '1 second'");
    const res = await verifyWith(wallet, nonceRes.json.message);
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'nonce expired or already used' });
    assert.equal((await rows('select * from sessions')).length, 0);
  });

  it('a nonce the server never issued is refused', async () => {
    const wallet = Wallet.createRandom();
    const message = craftMessage({ address: wallet.address, nonce: 'abcdef0123456789abcdef0123456789' });
    const res = await verifyWith(wallet, message);
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'nonce expired or already used' });
  });

  it('issuing a nonce purges expired ones (and only those)', async () => {
    const wallet = Wallet.createRandom();
    const old = await issueNonce(wallet);
    const fresh = await issueNonce(wallet);
    await app.pg.query("update auth_nonces set expires_at = now() - interval '1 minute' where nonce = $1", [old]);
    assert.equal((await rows('select * from auth_nonces')).length, 2);

    const newest = await issueNonce(wallet);
    const left = (await rows('select nonce from auth_nonces')).map((r) => r.nonce).sort();
    assert.deepEqual(left, [fresh, newest].sort());
  });
});

// ---------------------------------------------------------------------------

describe('signature and message checks', () => {
  it('a signature from a different key is refused (and does not burn the nonce)', async () => {
    const alice = Wallet.createRandom();
    const mallory = Wallet.createRandom();
    const nonceRes = await call(app, '/api/auth/nonce', { json: { address: alice.address } });

    const forged = await verifyWith(mallory, nonceRes.json.message); // Alice's message, Mallory's key
    assert.equal(forged.status, 401);
    assert.deepEqual(forged.json, { error: 'invalid signature' });
    assert.deepEqual(forged.setCookie, []);

    assert.equal((await rows('select * from auth_nonces')).length, 1, 'nonce still pending');
    const ok = await verifyWith(alice, nonceRes.json.message);
    assert.equal(ok.status, 200);
  });

  it('a re-signed message with another statement, a Request ID or Resources is refused', async () => {
    const wallet = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    const variants = [
      message.replace('FORGE', 'F0RGE'), // another statement, validly signed
      `${message}\nRequest ID: abc`, // a Request ID: the server never writes one
      `${message}\nResources:\n- https://evil.example/claim`, // Resources: never ours either
    ];
    for (const text of variants) {
      const signature = await wallet.signMessage(text);
      const res = await call(app, '/api/auth/verify', { json: { message: text, signature } });
      assert.equal(res.status, 401, `re-signed variant accepted:\n${text}`);
      assert.deepEqual(res.setCookie, []);
    }
    assert.equal((await rows('select * from sessions')).length, 0);
  });

  it('a tampered message is refused', async () => {
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    const signature = await wallet.signMessage(message);

    const tampered = [
      message.replace('FORGE', 'F0RGE'), // statement
      message.replace(getAddress(wallet.address), getAddress(other.address)), // address
      message.replace('Chain ID: 4441', 'Chain ID: 4442'), // chain
      message.replace(/Expiration Time: .*/, 'Expiration Time: 2999-01-01T00:00:00.000Z'), // stretch the expiry
      `${message}\n`, // trailing newline
      message.replace(/\n/g, '\r\n'), // windows line endings
      message.replace('Version: 1', 'Version: 2'),
    ];
    for (const text of tampered) {
      const res = await call(app, '/api/auth/verify', { json: { message: text, signature } });
      assert.equal(res.status, 401, `tampered message accepted:\n${text}`);
      assert.deepEqual(Object.keys(res.json), ['error']);
      assert.deepEqual(res.setCookie, []);
    }
    assert.equal((await rows('select * from sessions')).length, 0);

    // The untouched original still works: none of that burned the nonce.
    const ok = await call(app, '/api/auth/verify', { json: { message, signature } });
    assert.equal(ok.status, 200);
  });

  it('garbage messages get a short generic reason, never parser internals', async () => {
    const wallet = Wallet.createRandom();
    const signature = await wallet.signMessage('hello');
    for (const message of ['hello', 'a\nb\nc', '0x1234', 'x'.repeat(2000)]) {
      const res = await call(app, '/api/auth/verify', { json: { message, signature } });
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'invalid message' });
    }
  });

  it('a mangled but well-formed signature is refused', async () => {
    const wallet = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    const signature = await wallet.signMessage(message);
    const badRecoveryId = `${signature.slice(0, -2)}11`; // v = 0x11
    for (const sig of [badRecoveryId, `0x${'00'.repeat(65)}`, `0x${'ff'.repeat(65)}`]) {
      const res = await call(app, '/api/auth/verify', { json: { message, signature: sig } });
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'invalid signature' });
    }
  });

  it('a message for another domain is refused (exact host match)', async () => {
    const wallet = Wallet.createRandom();
    const nonce = await issueNonce(wallet);
    for (const host of ['evil.example.com', `${HOST}.evil.io`, `evil-${HOST}`, 'example.com', `${HOST}:8443`]) {
      const message = craftMessage({ address: wallet.address, host, nonce });
      const res = await verifyWith(wallet, message);
      assert.equal(res.status, 401, `domain ${host} accepted`);
      assert.deepEqual(res.json, { error: 'wrong domain' });
    }
    // The nonce survived all of that.
    assert.equal((await rows('select * from auth_nonces')).length, 1);
  });

  it('a message signed for one host cannot be replayed against another host', async () => {
    const wallet = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    // The request arrives on a different host than the message names.
    const res = await verifyWith(wallet, message, { host: 'evil.example.com' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'wrong domain' });
  });

  it('the URI in the message must be this site', async () => {
    const wallet = Wallet.createRandom();
    const nonce = await issueNonce(wallet);
    for (const uri of ['https://evil.example.com', `http://${HOST}`, `https://${HOST}:444`]) {
      const res = await verifyWith(wallet, craftMessage({ address: wallet.address, nonce, uri }));
      assert.equal(res.status, 401, `uri ${uri} accepted`);
      assert.deepEqual(res.json, { error: 'invalid message' });
    }
  });

  it('a message with a wrong chain id is refused', async () => {
    const wallet = Wallet.createRandom();
    const nonce = await issueNonce(wallet);
    for (const chainId of [1, 4442, 8453]) {
      const res = await verifyWith(wallet, craftMessage({ address: wallet.address, nonce, chainId }));
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'wrong chain' });
    }
    // A leading-zero chain id parses to 4441 but is not the canonical text we issue.
    const canonical = craftMessage({ address: wallet.address, nonce });
    const padded = canonical.replace('Chain ID: 4441', 'Chain ID: 04441');
    const res = await verifyWith(wallet, padded);
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'invalid message' });
  });

  it('SIWE_CHAIN_ID selects the chain (default 4441)', async () => {
    const wallet = Wallet.createRandom();
    process.env.SIWE_CHAIN_ID = '1';
    const first = await signIn(app, wallet);
    assert.match(first.message, /\nChain ID: 1\n/);
    assert.equal(first.verifyRes.status, 200);

    // A message minted for the default chain no longer fits.
    const nonce = await issueNonce(wallet);
    const res = await verifyWith(wallet, craftMessage({ address: wallet.address, nonce, chainId: 4441 }));
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'wrong chain' });
  });

  it('a broken SIWE_CHAIN_ID fails loudly instead of signing for the wrong chain', async (t) => {
    t.mock.method(console, 'error', () => {});
    process.env.SIWE_CHAIN_ID = 'not-a-number';
    const res = await call(app, '/api/auth/nonce', { json: { address: Wallet.createRandom().address } });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'server error' });
  });

  it('an expired message is refused', async () => {
    const wallet = Wallet.createRandom();
    const nonce = await issueNonce(wallet);
    const message = craftMessage({
      address: wallet.address,
      nonce,
      issuedAt: new Date(Date.now() - 20 * 60_000),
      expirationTime: new Date(Date.now() - 10 * 60_000),
    });
    const res = await verifyWith(wallet, message);
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'message expired' });
  });

  it('a message issued in the future is refused beyond 60 s, tolerated within it', async () => {
    const wallet = Wallet.createRandom();
    const nonce = await issueNonce(wallet);

    const tooEarly = craftMessage({
      address: wallet.address,
      nonce,
      issuedAt: new Date(Date.now() + 5 * 60_000),
      expirationTime: new Date(Date.now() + 15 * 60_000),
    });
    const refused = await verifyWith(wallet, tooEarly);
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.json, { error: 'invalid message' });

    const slightlyAhead = craftMessage({
      address: wallet.address,
      nonce,
      issuedAt: new Date(Date.now() + 30_000),
      expirationTime: new Date(Date.now() + 10 * 60_000),
    });
    const accepted = await verifyWith(wallet, slightlyAhead);
    assert.equal(accepted.status, 200);
  });

  it('messages the server would never write are refused (scheme, not-before, expiry before issue)', async () => {
    const wallet = Wallet.createRandom();
    const nonce = await issueNonce(wallet);
    const base = craftMessage({ address: wallet.address, nonce });
    const variants = [
      `https://${base}`, // scheme prefix: "https://forge.example.com wants you..."
      base.replace(/(Expiration Time: .*)/, '$1\nNot Before: 2020-01-01T00:00:00.000Z'),
      base.replace(/Issued At: .*/, 'Issued At: 2999-01-01T00:00:00.000Z'), // issued after it expires
      base.replace(/Issued At: (.*)Z/, 'Issued At: $1+00:00'), // other date spellings
      base.replace(/Expiration Time: (.*)\.\d{3}Z/, 'Expiration Time: $1Z'), // no milliseconds
    ];
    for (const text of variants) {
      const res = await verifyWith(wallet, text);
      assert.equal(res.status, 401, `accepted:\n${text}`);
    }
    assert.equal((await rows('select * from sessions')).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('request host and ALLOWED_HOSTS', () => {
  it('builds the message for x-forwarded-host first, then host', async () => {
    const wallet = Wallet.createRandom();
    const viaProxy = await call(app, '/api/auth/nonce', {
      host: '127.0.0.1:1234',
      json: { address: wallet.address },
      headers: { 'x-forwarded-host': 'Forge.Example.com', origin: 'https://forge.example.com' },
    });
    assert.equal(viaProxy.status, 200);
    assert.match(viaProxy.json.message, /^forge\.example\.com wants you to sign in/);
    assert.match(viaProxy.json.message, /\nURI: https:\/\/forge\.example\.com\n/);

    // a chain of proxies appends to the header: the first entry is the public host
    const chained = await call(app, '/api/auth/nonce', {
      json: { address: wallet.address },
      headers: { 'x-forwarded-host': `${HOST}, internal.svc.local` },
    });
    assert.equal(chained.status, 200);
    assert.match(chained.json.message, new RegExp(`^${HOST.replaceAll('.', '\\.')} wants you to sign in`));

    const plain = await call(app, '/api/auth/nonce', { host: 'other.example.org', json: { address: wallet.address } });
    assert.match(plain.json.message, /^other\.example\.org wants you to sign in/);
  });

  it('uses http:// only for localhost, and only when the proxy did not say https', async () => {
    const wallet = Wallet.createRandom();
    const local = await call(app, '/api/auth/nonce', {
      host: 'localhost:3000',
      proto: 'http',
      headers: { 'x-forwarded-proto': null },
      json: { address: wallet.address },
    });
    assert.equal(local.status, 200);
    assert.match(local.json.message, /^localhost:3000 wants you to sign in/);
    assert.match(local.json.message, /\nURI: http:\/\/localhost:3000\n/);

    // A public host with no forwarded proto is assumed to be https (never http).
    const pub = await call(app, '/api/auth/nonce', {
      json: { address: wallet.address },
      headers: { 'x-forwarded-proto': null, origin: `https://${HOST}` },
    });
    assert.equal(pub.status, 200);
    assert.match(pub.json.message, new RegExp(`\\nURI: https://${HOST.replaceAll('.', '\\.')}\\n`));
  });

  it('rejects malformed host headers (they end up inside the signed message)', async () => {
    const wallet = Wallet.createRandom();
    const badHosts = ['bad host', 'evil.com/path', 'a@b.com', 'exa mple.com', 'evil.com:99999999', 'evil.com:', '-', 'a..b', '[zz]'];
    for (const bad of badHosts) {
      // as X-Forwarded-Host...
      const forwarded = await call(app, '/api/auth/nonce', {
        json: { address: wallet.address },
        headers: { 'x-forwarded-host': bad },
      });
      assert.equal(forwarded.status, 400, `x-forwarded-host ${JSON.stringify(bad)} accepted`);
      assert.deepEqual(forwarded.json, { error: 'invalid host' });

      // ...and as the plain Host header
      const plain = await call(app, '/api/auth/nonce', { json: { address: wallet.address }, headers: { host: bad } });
      assert.equal(plain.status, 400, `host ${JSON.stringify(bad)} accepted`);
    }
    assert.equal((await rows('select * from auth_nonces')).length, 0);
  });

  it('ALLOWED_HOSTS limits which hosts may start or finish a sign-in', async () => {
    process.env.ALLOWED_HOSTS = ` ${HOST} , https://other.example.com/ `;
    const wallet = Wallet.createRandom();

    const ok1 = await call(app, '/api/auth/nonce', { json: { address: wallet.address } });
    assert.equal(ok1.status, 200);
    const ok2 = await call(app, '/api/auth/nonce', { host: 'other.example.com', json: { address: wallet.address } });
    assert.equal(ok2.status, 200);

    const denied = await call(app, '/api/auth/nonce', { host: 'evil.example.com', json: { address: wallet.address } });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.json, { error: 'host not allowed' });
    assert.equal((await rows('select * from auth_nonces')).length, 2, 'no nonce for the denied host');

    // Verify on a disallowed host is refused too, even with a nicely signed message.
    const message = craftMessage({ address: wallet.address, host: 'evil.example.com', nonce: ok1.json.nonce });
    const res = await verifyWith(wallet, message, { host: 'evil.example.com' });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'host not allowed' });
  });

  it('accepts any host when ALLOWED_HOSTS is unset, off Vercel (npm run dev needs no configuration)', async () => {
    const wallet = Wallet.createRandom();
    const res = await call(app, '/api/auth/nonce', { host: 'anything.example.net', json: { address: wallet.address } });
    assert.equal(res.status, 200);
  });

  it('on Vercel (any environment) sign-in is off until ALLOWED_HOSTS is set, with a clear error', async () => {
    const wallet = Wallet.createRandom();
    const saved = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const res = await call(app, '/api/auth/nonce', { json: { address: wallet.address } });
      assert.equal(res.status, 503);
      assert.match(res.json.error, /ALLOWED_HOSTS/);
      process.env.ALLOWED_HOSTS = HOST;
      assert.equal((await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).status, 200, 'set: sign-in works on the listed host');
    } finally {
      if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
      delete process.env.ALLOWED_HOSTS;
    }
  });
});

// ---------------------------------------------------------------------------

describe('CSRF guards on POST', () => {
  const POSTS = ['/api/auth/nonce', '/api/auth/verify', '/api/auth/logout'];
  const validBody = () => ({ address: Wallet.createRandom().address });

  it('a foreign Origin is refused with 403 on every POST endpoint', async () => {
    for (const path of POSTS) {
      for (const origin of [
        'https://evil.example.com',
        'null',
        `http://${HOST}`, // wrong scheme
        `https://${HOST}:8443`, // wrong port
        `https://sub.${HOST}`,
        '',
      ]) {
        const res = await call(app, path, { json: validBody(), headers: { origin } });
        assert.equal(res.status, 403, `${path} accepted Origin ${JSON.stringify(origin)}`);
        assert.deepEqual(res.json, { error: 'cross-origin request refused' });
        assert.deepEqual(res.setCookie, []);
      }
    }
    assert.equal((await rows('select * from auth_nonces')).length, 0, 'nothing was written');
  });

  it('a missing Origin is fine (curl, server-to-server), a matching one too', async () => {
    const wallet = Wallet.createRandom();
    const noOrigin = await call(app, '/api/auth/nonce', { json: { address: wallet.address }, headers: { origin: null } });
    assert.equal(noOrigin.status, 200);
    const sameOrigin = await call(app, '/api/auth/nonce', { json: { address: wallet.address } });
    assert.equal(sameOrigin.status, 200);
  });

  it('a foreign Origin cannot log a victim out', async () => {
    const wallet = Wallet.createRandom();
    const { cookie } = await signIn(app, wallet);
    const res = await call(app, '/api/auth/logout', { json: {}, cookie, headers: { origin: 'https://evil.example.com' } });
    assert.equal(res.status, 403);
    const me = await call(app, '/api/auth/me', { method: 'GET', cookie });
    assert.equal(me.status, 200, 'still signed in');
  });

  it('the content-type must be application/json (415 otherwise)', async () => {
    for (const path of POSTS) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', null]) {
        const res = await call(app, path, { raw: JSON.stringify(validBody()), headers: { 'content-type': type } });
        assert.equal(res.status, 415, `${path} accepted content-type ${type}`);
        assert.deepEqual(res.json, { error: 'content-type must be application/json' });
      }
    }
    assert.equal((await rows('select * from auth_nonces')).length, 0);
  });

  it('accepts application/json with parameters and any letter case', async () => {
    for (const type of ['application/json; charset=utf-8', 'APPLICATION/JSON', 'application/json;charset=UTF-8']) {
      const res = await call(app, '/api/auth/nonce', { json: validBody(), headers: { 'content-type': type } });
      assert.equal(res.status, 200, type);
    }
  });

  it('sends no CORS headers at all and refuses preflights', async () => {
    const preflight = await call(app, '/api/auth/nonce', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 405);
    const normal = await call(app, '/api/auth/nonce', { json: validBody() });
    for (const res of [preflight, normal]) {
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
    }
  });
});

// ---------------------------------------------------------------------------

describe('request bodies', () => {
  it('rejects a body over 8 KB with 413 (declared length)', async () => {
    const res = await call(app, '/api/auth/nonce', { raw: JSON.stringify({ address: 'a'.repeat(9000) }) });
    assert.equal(res.status, 413);
    assert.deepEqual(res.json, { error: 'request body too large' });
    assert.equal(res.headers.connection, 'close');
  });

  it('rejects a body over 8 KB with 413 (chunked, no content-length)', async () => {
    for (const path of ['/api/auth/nonce', '/api/auth/verify', '/api/auth/logout']) {
      const res = await call(app, path, { chunks: ['{"address":"', 'a'.repeat(9000), '"}'] });
      assert.equal(res.status, 413, path);
      assert.deepEqual(res.json, { error: 'request body too large' });
    }
  });

  it('accepts a body just under the limit', async () => {
    const wallet = Wallet.createRandom();
    const body = JSON.stringify({ address: wallet.address, pad: 'x'.repeat(8000) });
    assert.ok(body.length < 8192);
    const res = await call(app, '/api/auth/nonce', { raw: body });
    assert.equal(res.status, 200);
  });

  it('rejects malformed JSON, empty bodies and non-objects with 400', async () => {
    const cases = [
      ['{not json', 'invalid JSON'],
      ['', 'request body is empty'],
      ['   ', 'request body is empty'],
      ['null', 'body must be a JSON object'],
      ['[]', 'body must be a JSON object'],
      ['"0xabc"', 'body must be a JSON object'],
      ['42', 'body must be a JSON object'],
    ];
    for (const [raw, error] of cases) {
      for (const path of ['/api/auth/nonce', '/api/auth/verify']) {
        const res = await call(app, path, { raw });
        assert.equal(res.status, 400, `${path} ${JSON.stringify(raw)}`);
        assert.deepEqual(res.json, { error });
      }
    }
  });

  it('nonce: rejects missing, non-string and malformed addresses with 400', async () => {
    const good = '0x574d84E84f92e365d96a08786dfF90Ab77c12e85';
    assert.equal(getAddress(good), good);
    const badChecksum = good.replace('E84', 'e84'); // mixed case, wrong checksum

    const badShape = [
      {},
      { address: null },
      { address: 123 },
      { address: true },
      { address: [good] },
      { address: { toString: good } },
      { address: '' },
      { address: '0x' },
      { address: good.slice(0, -1) },
      { address: `${good}0` },
      { address: good.replace('0x', '') },
      { address: `0X${good.slice(2)}` },
      { address: `${good}\n` },
      { address: ` ${good}` },
      { address: `0x${'g'.repeat(40)}` },
      { address: 'XE7338O073OYJ4DRV4C5E1FD9CZZIC1I1' }, // ICAP
      { addr: good },
    ];
    for (const json of badShape) {
      const res = await call(app, '/api/auth/nonce', { json });
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.deepEqual(res.json, { error: 'address must be a 0x-prefixed 20-byte hex string' });
    }

    const res = await call(app, '/api/auth/nonce', { json: { address: badChecksum } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'address has an invalid checksum' });

    // all-lowercase and all-uppercase hex are legitimate (no checksum to check)
    for (const address of [good.toLowerCase(), `0x${good.slice(2).toUpperCase()}`]) {
      const ok = await call(app, '/api/auth/nonce', { json: { address } });
      assert.equal(ok.status, 200, address);
    }
    assert.equal((await rows('select * from auth_nonces')).length, 2);
  });

  it('verify: rejects missing, non-string and malformed fields with 400', async () => {
    const wallet = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    const signature = await wallet.signMessage(message);

    const cases = [
      [{}, 'message must be a non-empty string'],
      [{ signature }, 'message must be a non-empty string'],
      [{ message: 5, signature }, 'message must be a non-empty string'],
      [{ message: null, signature }, 'message must be a non-empty string'],
      [{ message: [message], signature }, 'message must be a non-empty string'],
      [{ message: '', signature }, 'message must be a non-empty string'],
      [{ message: 'x'.repeat(2049), signature }, 'message must be a non-empty string'],
      [{ message }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: 5 }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: null }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: '0x1234' }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: signature.slice(2) }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: `${signature}00` }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: `0x${'z'.repeat(130)}` }, 'signature must be a 0x-prefixed 65-byte hex string'],
      [{ message, signature: { r: 1 } }, 'signature must be a 0x-prefixed 65-byte hex string'],
    ];
    for (const [json, error] of cases) {
      const res = await call(app, '/api/auth/verify', { json });
      assert.equal(res.status, 400, JSON.stringify(json).slice(0, 80));
      assert.deepEqual(res.json, { error });
    }
    // none of that consumed the pending nonce
    const ok = await call(app, '/api/auth/verify', { json: { message, signature } });
    assert.equal(ok.status, 200);
  });

  it('ignores unknown extra fields, including prototype-pollution attempts', async () => {
    const wallet = Wallet.createRandom();
    const raw = `{"address":"${wallet.address}","extra":[1,2,3],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`;
    const res = await call(app, '/api/auth/nonce', { raw });
    assert.equal(res.status, 200);
    assert.equal({}.polluted, undefined);
  });
});

// ---------------------------------------------------------------------------

describe('methods', () => {
  it('answers 405 with an Allow header for anything else', async () => {
    const cases = [
      ['/api/auth/nonce', 'GET', 'POST'],
      ['/api/auth/nonce', 'PUT', 'POST'],
      ['/api/auth/nonce', 'DELETE', 'POST'],
      ['/api/auth/verify', 'GET', 'POST'],
      ['/api/auth/verify', 'PATCH', 'POST'],
      ['/api/auth/logout', 'GET', 'POST'],
      ['/api/auth/logout', 'DELETE', 'POST'],
      ['/api/auth/me', 'POST', 'GET'],
      ['/api/auth/me', 'DELETE', 'GET'],
      ['/api/auth/me', 'HEAD', 'GET'],
      ['/api/health', 'POST', 'GET, HEAD'],
      ['/api/health', 'PUT', 'GET, HEAD'],
    ];
    for (const [path, method, allow] of cases) {
      const res = await call(app, path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, allow, `${method} ${path}`);
      if (method !== 'HEAD') assert.deepEqual(res.json, { error: 'method not allowed' });
    }
  });
});

// ---------------------------------------------------------------------------

describe('session cookie', () => {
  async function loginCookieLine(host, opts = {}) {
    const { verifyRes } = await signIn(app, Wallet.createRandom(), { host, ...opts });
    assert.equal(verifyRes.status, 200, `sign-in on ${host}`);
    const line = verifyRes.setCookie.find((c) => c.startsWith('forge_session='));
    assert.ok(line, 'Set-Cookie present');
    return parseSetCookie(line);
  }

  it('is HttpOnly, SameSite=Lax, Path=/, Secure and lasts 7 days on a real host', async () => {
    const cookie = await loginCookieLine(HOST);
    assert.equal(cookie.name, 'forge_session');
    assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(cookie.flags.has('httponly'));
    assert.ok(cookie.flags.has('secure'));
    assert.equal(cookie.attrs.samesite, 'Lax');
    assert.equal(cookie.attrs.path, '/');
    assert.equal(cookie.attrs['max-age'], String(7 * 24 * 60 * 60));
    assert.equal(cookie.attrs.domain, undefined, 'host-only cookie: no Domain attribute');
    const expires = Date.parse(cookie.attrs.expires);
    assert.ok(Math.abs(expires - (Date.now() + 7 * 86_400_000)) < 60_000);
  });

  it('is Secure on every non-local host, including look-alikes of localhost', async () => {
    for (const host of ['forge.example.com', 'my-app.vercel.app', 'localhost.evil.com', '127.0.0.1.nip.io', '192.168.1.20:3000', 'notlocalhost']) {
      const cookie = await loginCookieLine(host);
      assert.ok(cookie.flags.has('secure'), `Secure missing on ${host}`);
      assert.ok(cookie.flags.has('httponly'));
    }
  });

  it('drops Secure only on localhost / 127.0.0.1 / [::1] (plain-http dev)', async () => {
    for (const host of ['localhost:3000', 'localhost', '127.0.0.1:3000', '127.0.0.1', '[::1]:3000']) {
      const cookie = await loginCookieLine(host, { proto: 'http', headers: { 'x-forwarded-proto': null } });
      assert.ok(!cookie.flags.has('secure'), `Secure present on ${host}`);
      assert.ok(cookie.flags.has('httponly'), `HttpOnly missing on ${host}`);
      assert.equal(cookie.attrs.samesite, 'Lax');
      assert.equal(cookie.attrs.path, '/');
    }
  });

  it('logout clears it with the same flags', async () => {
    for (const [host, secure] of [[HOST, true], ['localhost:3000', false]]) {
      const opts = secure ? {} : { proto: 'http', headers: { 'x-forwarded-proto': null } };
      const { cookie } = await signIn(app, Wallet.createRandom(), { host, ...opts });
      const res = await call(app, '/api/auth/logout', { host, json: {}, cookie, ...opts });
      assert.equal(res.status, 204);
      const cleared = parseSetCookie(res.setCookie[0]);
      assert.equal(cleared.value, '');
      assert.equal(cleared.attrs['max-age'], '0');
      assert.equal(cleared.attrs.path, '/');
      assert.ok(cleared.flags.has('httponly'));
      assert.equal(cleared.flags.has('secure'), secure);
    }
  });

  it('is not set when sign-in fails', async () => {
    const wallet = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    const res = await verifyWith(Wallet.createRandom(), message); // signed by the wrong key
    assert.equal(res.status, 401);
    assert.deepEqual(res.setCookie, []);
  });
});

// ---------------------------------------------------------------------------

describe('sessions', () => {
  it('an expired session is refused, and the next sign-in purges it', async () => {
    const wallet = Wallet.createRandom();
    const { cookie } = await signIn(app, wallet);
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie })).status, 200);

    await app.pg.query("update sessions set expires_at = now() - interval '1 second'");
    const res = await call(app, '/api/auth/me', { method: 'GET', cookie });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'not signed in' });
    assert.equal((await rows('select * from sessions')).length, 1, 'still stored, just unusable');

    // Someone else signs in: expired rows are swept in that same statement.
    await signIn(app, Wallet.createRandom());
    const left = await rows('select address from sessions');
    assert.equal(left.length, 1);
    assert.notEqual(left[0].address, getAddress(wallet.address).toLowerCase());
  });

  it('signing in again rotates the session: the old cookie stops working', async () => {
    const wallet = Wallet.createRandom();
    const first = await signIn(app, wallet);

    // second sign-in from the same browser (it presents the old cookie)
    const second = await signIn(app, wallet, { cookie: first.cookie });
    assert.equal(second.verifyRes.status, 200);
    assert.notEqual(second.cookie, first.cookie);

    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie: first.cookie })).status, 401);
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie: second.cookie })).status, 200);
    assert.equal((await rows('select * from sessions')).length, 1);
  });

  it('signing in from another browser keeps the first session alive', async () => {
    const wallet = Wallet.createRandom();
    const laptop = await signIn(app, wallet);
    const phone = await signIn(app, wallet); // no cookie sent: a different browser
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie: laptop.cookie })).status, 200);
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie: phone.cookie })).status, 200);
    assert.equal((await rows('select * from sessions')).length, 2);
  });

  it('one player cannot use another player\'s session', async () => {
    const alice = await signIn(app, Wallet.createRandom());
    const bob = await signIn(app, Wallet.createRandom());
    const a = await call(app, '/api/auth/me', { method: 'GET', cookie: alice.cookie });
    const b = await call(app, '/api/auth/me', { method: 'GET', cookie: bob.cookie });
    assert.notEqual(a.json.address, b.json.address);
    assert.equal(a.json.address, alice.verifyRes.json.address);
    assert.equal(b.json.address, bob.verifyRes.json.address);
  });

  it('me ignores malformed, unknown and injection-looking cookies', async () => {
    const wallet = Wallet.createRandom();
    const { cookie } = await signIn(app, wallet);
    const token = cookie.split('=')[1];

    for (const value of [
      'forge_session=',
      'forge_session=abc',
      `forge_session=${'A'.repeat(43)}`, // well-formed but unknown
      `forge_session=${'A'.repeat(500)}`,
      "forge_session=' or 1=1 --",
      `forge_session=${token}x`,
      `forge_session=${token.slice(1)}`,
      'other=1',
      'forge_session',
    ]) {
      const res = await call(app, '/api/auth/me', { method: 'GET', headers: { cookie: value } });
      assert.equal(res.status, 401, value);
      assert.deepEqual(res.json, { error: 'not signed in' });
    }
  });

  it('me finds the session among other cookies', async () => {
    const { cookie } = await signIn(app, Wallet.createRandom());
    const res = await call(app, '/api/auth/me', {
      method: 'GET',
      headers: { cookie: `theme=dark; ${cookie}; _ga=GA1.2.3` },
    });
    assert.equal(res.status, 200);
  });

  it('logout is idempotent and only ends the session it was given', async () => {
    const wallet = Wallet.createRandom();
    const a = await signIn(app, wallet);
    const b = await signIn(app, wallet);

    assert.equal((await call(app, '/api/auth/logout', { json: {}, cookie: a.cookie })).status, 204);
    assert.equal((await call(app, '/api/auth/logout', { json: {}, cookie: a.cookie })).status, 204); // again
    assert.equal((await call(app, '/api/auth/logout', { json: {} })).status, 204); // never signed in
    assert.equal((await call(app, '/api/auth/logout', { raw: '' })).status, 204); // no body at all
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie: b.cookie })).status, 200);
  });

  it('logout rejects a malformed JSON body', async () => {
    const res = await call(app, '/api/auth/logout', { raw: '{oops' });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------

describe('health', () => {
  it('reports ok and db:true', async () => {
    const res = await call(app, '/api/health', { method: 'GET' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, db: true });
  });

  it('answers HEAD without a body', async () => {
    const res = await call(app, '/api/health', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.text, '');
  });

  it('reports db:false (still 200) when the database is down, without leaking why', async () => {
    setDb(async () => {
      throw new Error('connect ECONNREFUSED postgres://user:hunter2@db.internal:5432');
    });
    const res = await call(app, '/api/health', { method: 'GET' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, db: false });
    assert.ok(!res.text.includes('hunter2'));
  });
});

// ---------------------------------------------------------------------------

describe('SQL hygiene', () => {
  it('request data never ends up in SQL text: every statement is parameterised', async () => {
    const wallet = Wallet.createRandom();
    const injection = "x'); drop table players; --";
    app.queries.length = 0;

    const { cookie, message, signature } = await signIn(app, wallet, { headers: { 'user-agent': injection } });
    await call(app, '/api/auth/me', { method: 'GET', cookie });
    await call(app, '/api/auth/me', { method: 'GET', headers: { cookie: `forge_session=${injection}` } });
    await call(app, '/api/auth/nonce', { json: { address: injection } });
    await call(app, '/api/auth/verify', { json: { message: injection, signature } });
    await call(app, '/api/auth/logout', { json: {}, cookie });

    assert.ok(app.queries.length >= 6, `ran ${app.queries.length} statements`);
    const dynamic = [
      wallet.address.toLowerCase(),
      getAddress(wallet.address),
      cookie.split('=')[1],
      message.match(/Nonce: (\w+)/)[1],
      signature,
      injection,
    ];
    for (const { text, params } of app.queries) {
      assert.ok(Array.isArray(params));
      assert.ok(!text.includes("'"), `string literal in SQL: ${text}`);
      assert.ok(!text.includes(';'), `multiple statements: ${text}`);
      for (const value of dynamic) assert.ok(!text.includes(value), `request data in SQL text: ${text}`);
    }
    assert.equal((await rows("select 1 from information_schema.tables where table_name = 'players'")).length, 1);
  });

  it('hostile header values are stored as plain data', async () => {
    const injection = "Mozilla/5.0'); delete from players; --";
    const wallet = Wallet.createRandom();
    await signIn(app, wallet, { headers: { 'user-agent': injection } });
    assert.deepEqual(await rows('select user_agent from sessions'), [{ user_agent: injection }]);
    assert.equal((await rows('select * from players')).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('failures never leak internals', () => {
  it('a database error becomes a generic 500', async (t) => {
    t.mock.method(console, 'error', () => {});
    setDb(async () => {
      throw new Error('relation "auth_nonces" does not exist; password=hunter2');
    });

    const res = await call(app, '/api/auth/nonce', { json: { address: Wallet.createRandom().address } });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'server error' });
    assert.ok(!res.text.includes('hunter2') && !res.text.includes('auth_nonces'));
  });

  it('every response carries no-store and nosniff', async () => {
    const wallet = Wallet.createRandom();
    const { cookie } = await signIn(app, wallet);
    const responses = [
      await call(app, '/api/auth/nonce', { json: { address: wallet.address } }), // 200
      await call(app, '/api/auth/me', { method: 'GET', cookie }), // 200
      await call(app, '/api/auth/me', { method: 'GET' }), // 401
      await call(app, '/api/auth/verify', { json: { message: 'x', signature: `0x${'00'.repeat(65)}` } }), // 401
      await call(app, '/api/auth/nonce', { method: 'GET' }), // 405
      await call(app, '/api/auth/nonce', { raw: '{}', headers: { 'content-type': 'text/plain' } }), // 415
      await call(app, '/api/auth/nonce', { json: {}, headers: { origin: 'https://evil.example.com' } }), // 403
      await call(app, '/api/auth/nonce', { json: {} }), // 400
      await call(app, '/api/auth/nonce', { raw: 'x'.repeat(9000) }), // 413
      await call(app, '/api/auth/logout', { json: {}, cookie }), // 204
      await call(app, '/api/health', { method: 'GET' }), // 200
    ];
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 401, 401, 405, 415, 403, 400, 413, 204, 200]);
    for (const res of responses) {
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
    for (const res of responses.filter((r) => r.status !== 204)) {
      assert.match(res.headers['content-type'], /^application\/json/);
    }
  });
});
