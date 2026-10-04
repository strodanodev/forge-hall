// GET /api/rapture/holder: real HTTP in, real fetch out to a fake Liteforge JSON-RPC on a local socket.
// No network: RAPTURE_RPC_URL points the handler at the fake, whose balances and failure mode each test sets.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { RAPTURE, RPC_ATTEMPTS, RPC_TIMEOUT_MS, RPC_URL } from '../_lib/rapture.js';
import holder from '../rapture/holder.js';
import { call } from './helpers.js';

const PATH = '/api/rapture/holder';
const BALANCE_OF_DATA = /^0x70a082310{24}([0-9a-f]{40})$/;

// mode: 'ok' | 'down' (HTTP 502) | 'rpc-error' | 'no-contract' (result "0x") | 'hang' (never answers)
function startFakeRpc() {
  const rpc = { balances: new Map(), calls: [], unexpected: [], mode: 'ok', failNext: 0 };
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    rpc.calls.push(body);
    const reply = (fields) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...fields }));
    };

    if (rpc.mode === 'hang') return;
    if (rpc.mode === 'down' || rpc.failNext > 0) {
      rpc.failNext = Math.max(0, rpc.failNext - 1);
      res.statusCode = 502;
      res.end('bad gateway');
      return;
    }
    if (rpc.mode === 'rpc-error') return reply({ error: { code: -32005, message: 'rate limit exceeded' } });
    if (rpc.mode === 'no-contract') return reply({ result: '0x' });

    // The only request the handler should ever make: balanceOf(wallet) on RaptureCards, at the latest block.
    const [tx, tag] = body.params ?? [];
    const match = BALANCE_OF_DATA.exec(tx?.data ?? '');
    if (body.method !== 'eth_call' || tx?.to !== RAPTURE.contract || tag !== 'latest' || !match) {
      rpc.unexpected.push(body);
      return reply({ error: { code: -32602, message: 'unexpected request' } });
    }
    const balance = rpc.balances.get(`0x${match[1]}`) ?? 0n;
    reply({ result: `0x${balance.toString(16).padStart(64, '0')}` });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ rpc, server, url: `http://127.0.0.1:${server.address().port}/` })),
  );
}

function startApp() {
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === PATH) return holder(req, res);
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const wallet = () => Wallet.createRandom().address; // EIP-55
const get = (app, address, opts = {}) =>
  call(app, address === undefined ? PATH : `${PATH}?address=${encodeURIComponent(address)}`, { method: 'GET', ...opts });

let fake;
let app;

before(async () => {
  fake = await startFakeRpc();
  app = await startApp();
  process.env.RAPTURE_RPC_URL = fake.url;
});

after(async () => {
  delete process.env.RAPTURE_RPC_URL;
  for (const { server } of [fake, app]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  Object.assign(fake.rpc, { balances: new Map(), calls: [], unexpected: [], mode: 'ok', failNext: 0 });
});

afterEach(() => {
  assert.deepEqual(fake.rpc.unexpected, [], 'the handler sent the RPC something other than balanceOf');
});

describe('GET /api/rapture/holder', () => {
  it('a holder: holder true, the balance, and the fields quest platforms read', async () => {
    const address = wallet();
    fake.rpc.balances.set(address.toLowerCase(), 3n);

    const res = await get(app, address.toLowerCase());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      address, // EIP-55, whatever case came in
      holder: true,
      balance: 3,
      collection: {
        name: 'Rapture Cards',
        symbol: 'RAPTURE',
        contract: '0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721',
        chainId: 4441,
        network: 'LitVM Liteforge',
      },
      data: { result: true },
      result: { isValid: true },
    });
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(fake.rpc.calls.length, 1);
  });

  it('one card is enough; none is not', async () => {
    const [one, none] = [wallet(), wallet()];
    fake.rpc.balances.set(one.toLowerCase(), 1n);
    const yes = await get(app, one);
    assert.equal(yes.json.holder, true);
    assert.equal(yes.json.balance, 1);

    const no = await get(app, none);
    assert.equal(no.status, 200);
    assert.equal(no.json.holder, false);
    assert.equal(no.json.balance, 0);
    assert.deepEqual(no.json.data, { result: false });
    assert.deepEqual(no.json.result, { isValid: false });
  });

  it('refuses anything but a wallet address with 400, without touching the chain', async () => {
    const good = wallet();
    for (const address of [undefined, '', 'hello', good.slice(0, -1), `${good}0`, good.slice(2), `0x${'g'.repeat(40)}`, `0x${'0'.repeat(40)}`]) {
      const res = await get(app, address);
      assert.equal(res.status, 400, String(address));
      assert.match(res.json.error, /0x followed by 40 hex digits/);
      assert.equal(res.headers['access-control-allow-origin'], '*', 'errors must be readable cross-origin too');
    }
    assert.equal(fake.rpc.calls.length, 0);
  });

  it('answers CORS preflights; other methods are 405', async () => {
    const pre = await call(app, PATH, {
      method: 'OPTIONS',
      headers: { origin: 'https://dashboard.galxe.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
    assert.equal(pre.headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.match(pre.headers['access-control-allow-headers'], /authorization/i);

    const posted = await call(app, PATH, { json: { address: wallet() } });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.allow, 'GET, OPTIONS');
    assert.equal(fake.rpc.calls.length, 0);
  });
});

describe('when the chain cannot be read', () => {
  let errors;
  beforeEach(() => {
    errors = mock.method(console, 'error', () => {});
  });
  afterEach(() => {
    errors.mock.restore();
  });

  // A failure must never look like "not a holder": that would fail a real holder.
  function assertUnavailable(res) {
    assert.equal(res.status, 503);
    assert.equal(res.headers['retry-after'], '5');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.deepEqual(res.json, { error: 'chain unavailable, try again shortly' });
    assert.equal(fake.rpc.calls.length, RPC_ATTEMPTS);
  }

  it('one failed attempt is retried', async () => {
    const address = wallet();
    fake.rpc.balances.set(address.toLowerCase(), 4n);
    fake.rpc.failNext = 1;
    const res = await get(app, address);
    assert.equal(res.status, 200);
    assert.equal(res.json.balance, 4);
    assert.equal(fake.rpc.calls.length, 2);
  });

  for (const mode of ['down', 'rpc-error', 'no-contract']) {
    it(`RPC ${mode}: 503, never holder false`, async () => {
      fake.rpc.mode = mode;
      assertUnavailable(await get(app, wallet()));
    });
  }

  it("an RPC that never answers is cut off inside Galxe's 5 s budget", async () => {
    fake.rpc.mode = 'hang';
    const started = Date.now();
    assertUnavailable(await get(app, wallet()));
    const took = Date.now() - started;
    assert.ok(took >= RPC_ATTEMPTS * RPC_TIMEOUT_MS - 100, `gave up too early (${took} ms)`);
    assert.ok(took < 5000, `took ${took} ms`);
  });
});

it('matches the collection the site uses (web/assets/rapture)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'assets', 'rapture');
  const shop = JSON.parse(fs.readFileSync(path.join(dir, 'packshop.json'), 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'cards.json'), 'utf8')).collection;
  assert.equal(RAPTURE.contract, shop.cards);
  assert.equal(RAPTURE.contract, snapshot.address);
  assert.equal(RAPTURE.chainId, shop.chainId);
  assert.equal(RPC_URL, shop.rpc);
});
