// Runs scripts/dev-server.mjs exactly as `npm run dev` does (no DATABASE_URL, so it
// falls back to in-memory PGlite) and drives the whole sign-in flow over real HTTP.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Wallet, getAddress } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let child;
let base; // http://127.0.0.1:<port>
let host; // 127.0.0.1:<port>
let log = '';

before(
  async () => {
    const env = { ...process.env, PORT: '0' }; // 0 = any free port
    delete env.DATABASE_URL;
    child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dev server did not start in time:\n${log}`)), 140_000);
      const onData = (chunk) => {
        log += chunk;
        const match = /listening on http:\/\/localhost:(\d+)/.exec(log);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => reject(new Error(`dev server exited early (code ${code}):\n${log}`)));
    });
    host = new URL(base).host;
  },
  { timeout: 150_000 },
);

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
});

// Raw request so the path is sent exactly as written (fetch would normalise "..").
function rawGet(rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: new URL(base).port, path: rawPath, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
  });
}

const post = (route, body, cookie, origin = base) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe('dev server: static files', () => {
  it('serves web/index.html at / with the right content type', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.match(await res.text(), /<!doctype html>/i);
  });

  it('sends the production headers from vercel.json, so a CSP problem shows up locally', async () => {
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const api = await fetch(`${base}/api/health`);
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.match(api.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });

  it('serves the same page at /index.html and 404s unknown files', async () => {
    assert.equal((await fetch(`${base}/index.html`)).status, 200);
    assert.equal((await fetch(`${base}/definitely-not-here.png`)).status, 404);
  });

  it('serves binary assets with a proper type and byte ranges', async (t) => {
    const glbName = fs.readdirSync(path.join(ROOT, 'web', 'assets')).find((name) => name.endsWith('.glb'));
    if (!glbName) return t.skip('no .glb in web/assets');

    const glb = await fetch(`${base}/assets/${glbName}`, { headers: { range: 'bytes=0-3' } });
    assert.equal(glb.status, 206);
    assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.match(glb.headers.get('content-range'), /^bytes 0-3\/\d+$/);
    assert.equal(Buffer.from(await glb.arrayBuffer()).toString('latin1'), 'glTF'); // GLB magic number

    const tail = await fetch(`${base}/index.html`, { headers: { range: 'bytes=-5' } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 5);

    const bad = await fetch(`${base}/index.html`, { headers: { range: 'bytes=999999999-' } });
    assert.equal(bad.status, 416);
  });

  it('cannot be tricked into leaving web/', async () => {
    for (const p of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/assets/../../package.json',
      '/..\\package.json',
      '/%5c..%5cpackage.json',
      '/.env',
      '/.git/config',
      '/index.html%00.png',
      '/index.html::$DATA',
    ]) {
      const res = await rawGet(p);
      assert.equal(res.status, 404, `${p} -> ${res.status}`);
      assert.ok(!res.body.toString().includes('forge-hall'), `${p} leaked package.json`);
    }
  });
});

describe('dev server: API routing', () => {
  it('routes /api/health with the in-memory database', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: true });
  });

  it('404s unknown API routes, private helpers and the test folder', async () => {
    for (const p of ['/api/nope', '/api/auth', '/api/_lib/db', '/api/_lib/http.js', '/api/test/auth.test', '/api/test/helpers', '/api/auth/nonce.js']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, p);
    }
  });

  it('runs the handlers: wrong method gives 405 with Allow', async () => {
    const res = await fetch(`${base}/api/auth/nonce`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

describe('dev server: full sign-in flow over real HTTP', () => {
  it('nonce -> personal_sign -> verify -> me -> logout -> me is 401', async () => {
    const wallet = Wallet.createRandom();

    const nonceRes = await post('/api/auth/nonce', { address: wallet.address });
    assert.equal(nonceRes.status, 200);
    const { nonce, message } = await nonceRes.json();
    assert.match(nonce, /^[A-Za-z0-9]{16,}$/);
    assert.ok(message.startsWith(`${host} wants you to sign in with your Ethereum account:\n${getAddress(wallet.address)}\n`));
    assert.ok(message.includes(`\nURI: ${base}\n`));
    assert.ok(message.includes('\nChain ID: 4441\n'));

    const signature = await wallet.signMessage(message);
    const verifyRes = await post('/api/auth/verify', { message, signature });
    assert.equal(verifyRes.status, 200);
    const verified = await verifyRes.json();
    assert.equal(verified.address, getAddress(wallet.address));
    assert.ok(!Number.isNaN(Date.parse(verified.createdAt)));

    // localhost / 127.0.0.1 get a cookie without Secure so plain-http dev works
    const setCookie = verifyRes.headers.getSetCookie();
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0], /^forge_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie[0], /; HttpOnly/);
    assert.match(setCookie[0], /; SameSite=Lax/);
    assert.match(setCookie[0], /; Path=\//);
    assert.doesNotMatch(setCookie[0], /Secure/i);
    const cookie = setCookie[0].split(';')[0];

    const meRes = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(meRes.status, 200);
    assert.deepEqual(await meRes.json(), {
      address: getAddress(wallet.address),
      createdAt: verified.createdAt,
      displayName: null,
    });

    const logoutRes = await post('/api/auth/logout', {}, cookie);
    assert.equal(logoutRes.status, 204);

    const goneRes = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(goneRes.status, 401);
    assert.deepEqual(await goneRes.json(), { error: 'not signed in' });
  });

  it('a replayed sign-in and a foreign Origin are refused', async () => {
    const wallet = Wallet.createRandom();
    const { message } = await (await post('/api/auth/nonce', { address: wallet.address })).json();
    const signature = await wallet.signMessage(message);

    const evil = await post('/api/auth/verify', { message, signature }, undefined, 'https://evil.example');
    assert.equal(evil.status, 403);

    assert.equal((await post('/api/auth/verify', { message, signature })).status, 200);
    assert.equal((await post('/api/auth/verify', { message, signature })).status, 401); // replay
  });
});
