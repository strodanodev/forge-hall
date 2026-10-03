// The production database path: handlers -> api/_lib/db.js -> the real
// @neondatabase/serverless driver -> (HTTP call answered in-process by PGlite).
// No network, no credentials; it proves the SQL survives the driver's parameter
// encoding and result parsing exactly as it would against Neon.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { neonConfig } from '@neondatabase/serverless';
import { Wallet, getAddress } from 'ethers';
import { setDb } from '../_lib/db.js';
import { FAKE_NEON_URL, call, craftMessage, sessionCookieFrom, signIn, startApp } from './helpers.js';

let app;

before(
  async () => {
    app = await startApp({ viaNeon: true });
  },
  { timeout: 180_000 },
);

after(async () => {
  await app.close();
});

beforeEach(async () => {
  app.useDb();
  await app.reset();
  app.queries.length = 0;
});

describe('sign-in through the real Neon driver', () => {
  it('health reaches the database', async () => {
    const res = await call(app, '/api/health', { method: 'GET' });
    assert.deepEqual(res.json, { ok: true, db: true });
    assert.equal(app.queries.length, 1);
    assert.equal(app.queries[0].text, 'select 1 as ok');
    assert.equal(app.queries[0].connectionString, FAKE_NEON_URL);
  });

  it('nonce -> verify -> me -> logout -> me is 401', async () => {
    const wallet = Wallet.createRandom();
    const { verifyRes, cookie } = await signIn(app, wallet);
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.json.address, getAddress(wallet.address));
    assert.ok(!Number.isNaN(Date.parse(verifyRes.json.createdAt)));
    assert.ok(cookie);

    const me = await call(app, '/api/auth/me', { method: 'GET', cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, {
      address: getAddress(wallet.address),
      createdAt: verifyRes.json.createdAt,
      displayName: null,
    });

    assert.equal((await call(app, '/api/auth/logout', { json: {}, cookie })).status, 204);
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie })).status, 401);
  });

  it('every request to Neon is one parameterised statement carrying the connection string', async () => {
    const wallet = Wallet.createRandom();
    const evilAgent = "Mozilla'); drop table players; --";
    const { cookie, message, signature } = await signIn(app, wallet, { headers: { 'user-agent': evilAgent } });

    // the hostile user agent is stored as plain data...
    const stored = await app.pg.query('select user_agent from sessions');
    assert.deepEqual(stored.rows, [{ user_agent: evilAgent }]);

    await call(app, '/api/auth/me', { method: 'GET', cookie });
    await call(app, '/api/auth/logout', { json: {}, cookie });

    assert.ok(app.queries.length >= 6, `ran ${app.queries.length} statements`);
    const secrets = [
      wallet.address.toLowerCase(),
      getAddress(wallet.address),
      cookie.split('=')[1],
      message.match(/Nonce: (\w+)/)[1],
      signature,
      evilAgent,
    ];
    for (const { text, params, connectionString } of app.queries) {
      assert.equal(connectionString, FAKE_NEON_URL);
      assert.ok(Array.isArray(params));
      assert.ok(!text.includes("'"), `string literal in SQL: ${text}`);
      assert.ok(!text.includes(';'), `multiple statements in one request: ${text}`);
      for (const secret of secrets) assert.ok(!text.includes(secret), `request data in SQL text: ${text}`);
    }
    // ...and nothing was dropped
    const tables = await app.pg.query("select count(*)::int as n from information_schema.tables where table_name = 'players'");
    assert.equal(tables.rows[0].n, 1);
  });

  it('single use and address binding hold on the Neon path', async () => {
    const alice = Wallet.createRandom();
    const mallory = Wallet.createRandom();

    const aliceNonce = await call(app, '/api/auth/nonce', { json: { address: alice.address } });
    const stolen = craftMessage({ address: mallory.address, nonce: aliceNonce.json.nonce });
    const attack = await call(app, '/api/auth/verify', {
      json: { message: stolen, signature: await mallory.signMessage(stolen) },
    });
    assert.equal(attack.status, 401);

    const message = aliceNonce.json.message;
    const body = { message, signature: await alice.signMessage(message) };
    assert.equal((await call(app, '/api/auth/verify', { json: body })).status, 200);
    assert.equal((await call(app, '/api/auth/verify', { json: body })).status, 401); // replay
  });

  it('two concurrent replays: exactly one wins', async () => {
    const wallet = Wallet.createRandom();
    const { message } = (await call(app, '/api/auth/nonce', { json: { address: wallet.address } })).json;
    const body = { message, signature: await wallet.signMessage(message) };
    const results = await Promise.all(Array.from({ length: 4 }, () => call(app, '/api/auth/verify', { json: body })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401, 401]);
    assert.equal((await app.pg.query('select * from sessions')).rows.length, 1);
  });

  it('expiry is decided by the database clock on the Neon path too', async () => {
    const wallet = Wallet.createRandom();
    const first = await signIn(app, wallet);
    await app.pg.query("update sessions set expires_at = now() - interval '1 second'");
    assert.equal((await call(app, '/api/auth/me', { method: 'GET', cookie: first.cookie })).status, 401);

    const nonceRes = await call(app, '/api/auth/nonce', { json: { address: wallet.address } });
    await app.pg.query("update auth_nonces set expires_at = now() - interval '1 second'");
    const message = nonceRes.json.message;
    const res = await call(app, '/api/auth/verify', { json: { message, signature: await wallet.signMessage(message) } });
    assert.equal(res.status, 401);
  });

  it('a returning player keeps createdAt; the session cookie is fresh each time', async () => {
    const wallet = Wallet.createRandom();
    const a = await signIn(app, wallet);
    const b = await signIn(app, wallet);
    assert.equal(a.verifyRes.json.createdAt, b.verifyRes.json.createdAt);
    assert.notEqual(sessionCookieFrom(a.verifyRes), sessionCookieFrom(b.verifyRes));
  });
});

describe('when the database misbehaves', () => {
  it('a Neon error response (HTTP 400) becomes a generic 500, and health says db:false', async (t) => {
    t.mock.method(console, 'error', () => {});
    neonConfig.fetchFunction = async () =>
      new Response(JSON.stringify({ message: 'relation "auth_nonces" does not exist', code: '42P01', severity: 'ERROR' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    setDb(null);

    const nonce = await call(app, '/api/auth/nonce', { json: { address: Wallet.createRandom().address } });
    assert.equal(nonce.status, 500);
    assert.deepEqual(nonce.json, { error: 'server error' });
    assert.ok(!nonce.text.includes('auth_nonces'));

    const health = await call(app, '/api/health', { method: 'GET' });
    assert.deepEqual(health.json, { ok: true, db: false });
  });

  it('a network failure talking to Neon is a generic 500', async (t) => {
    t.mock.method(console, 'error', () => {});
    neonConfig.fetchFunction = async () => {
      throw new TypeError('fetch failed');
    };
    setDb(null);
    const res = await call(app, '/api/auth/nonce', { json: { address: Wallet.createRandom().address } });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'server error' });
  });

  it('a missing DATABASE_URL is a generic 500 and health db:false', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    delete process.env.DATABASE_URL;
    setDb(null);

    const nonce = await call(app, '/api/auth/nonce', { json: { address: Wallet.createRandom().address } });
    assert.equal(nonce.status, 500);
    assert.deepEqual(nonce.json, { error: 'server error' });
    assert.match(String(logged.mock.calls[0].arguments[1]), /DATABASE_URL is not set/);

    assert.deepEqual((await call(app, '/api/health', { method: 'GET' })).json, { ok: true, db: false });
  });

  it('a malformed DATABASE_URL never leaks its password into logs or responses', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    // neon() itself echoes the string in some of its errors (unparsable URL); ours must not.
    for (const url of ['hunter2-secret is not a url', 'postgresql://forge:hunter2-secret@/no-host']) {
      process.env.DATABASE_URL = url;
      setDb(null);
      const res = await call(app, '/api/auth/nonce', { json: { address: Wallet.createRandom().address } });
      assert.equal(res.status, 500, url);
      assert.ok(!res.text.includes('hunter2'));
    }
    const everythingLogged = logged.mock.calls
      .flatMap((c) => c.arguments)
      .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}\n${JSON.stringify(a)}` : String(a)))
      .join('\n');
    assert.ok(everythingLogged.includes('not a valid Neon connection string'), everythingLogged);
    assert.ok(!everythingLogged.includes('hunter2'), 'password leaked into the log');
  });
});
