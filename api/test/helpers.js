// Shared test support: a real HTTP server around the real handlers, backed by
// an in-memory PGlite that has db/schema.sql applied, plus a small request helper.
// Everything goes through real Node req/res objects and a real socket.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';
import { getAddress } from 'ethers';
import { SiweMessage } from 'siwe';
import { SIWE_STATEMENT } from '../_lib/config.js';
import { pgliteRunner, setDb } from '../_lib/db.js';
import { splitStatements } from '../_lib/sql.js';
import logout from '../auth/logout.js';
import me from '../auth/me.js';
import nonce from '../auth/nonce.js';
import verify from '../auth/verify.js';
import health from '../health.js';

// Tests must never reach a real database, whatever the developer's shell has exported.
// (The Neon-path tests set a fake URL and answer its HTTP calls in-process.)
delete process.env.DATABASE_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(HERE, '..', '..', 'db', 'schema.sql');

const ROUTES = {
  '/api/auth/nonce': nonce,
  '/api/auth/verify': verify,
  '/api/auth/me': me,
  '/api/auth/logout': logout,
  '/api/health': health,
};

// The host the requests below pretend to come from: a deployed site behind https.
export const HOST = 'forge.example.com';

// Postgres type OIDs Neon's HTTP endpoint would send as raw text (the driver parses them).
const RAW_TEXT_OIDS = [16, 17, 20, 21, 23, 25, 114, 700, 701, 1043, 1082, 1114, 1184, 2950, 3802];
const AS_TEXT = Object.fromEntries(RAW_TEXT_OIDS.map((oid) => [oid, (value) => value]));
export const FAKE_NEON_URL = 'postgresql://forge_user:not-a-real-password@ep-test-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

// A stand-in for Neon's HTTP SQL endpoint, backed by PGlite. Plugged into the real
// @neondatabase/serverless driver (neonConfig.fetchFunction), so the production
// code path (request encoding, parameter conversion, result parsing) really runs.
function fakeNeonFetch(pg, log) {
  return async (url, init) => {
    const { query, params } = JSON.parse(init.body);
    log.push({ text: query, params, connectionString: init.headers['Neon-Connection-String'] });
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    try {
      const result = await pg.query(query, params, { rowMode: 'array', parsers: AS_TEXT });
      return json(200, {
        command: 'SELECT',
        rowCount: result.rows.length,
        rows: result.rows,
        fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      });
    } catch (err) {
      return json(400, { message: err.message, code: err.code, severity: 'ERROR' });
    }
  };
}

// viaNeon: false -> handlers talk to PGlite directly (fast, the default).
// viaNeon: true  -> handlers use the real Neon driver, whose HTTP calls are answered by PGlite.
// Either way `app.queries` records every statement the handlers ran.
export async function startApp({ viaNeon = false } = {}) {
  const pg = new PGlite();
  await pg.waitReady;
  for (const statement of splitStatements(fs.readFileSync(SCHEMA_PATH, 'utf8'))) await pg.query(statement);

  const queries = [];
  const direct = pgliteRunner(pg);
  const runner = (text, params) => {
    queries.push({ text, params });
    return direct(text, params);
  };
  const useDb = () => {
    if (viaNeon) {
      process.env.DATABASE_URL = FAKE_NEON_URL;
      neonConfig.fetchFunction = fakeNeonFetch(pg, queries);
      setDb(null); // db.js builds its Neon runner lazily from DATABASE_URL
    } else {
      setDb(runner);
    }
  };
  useDb();

  const server = http.createServer((req, res) => {
    const handler = ROUTES[req.url.split('?')[0]];
    if (!handler) {
      res.statusCode = 404;
      res.end();
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    pg,
    queries,
    port: server.address().port,
    // Point the handlers back at the real test database (after a test swapped it out).
    useDb,
    // Empty every table between tests.
    reset: () => pg.exec('truncate sessions, auth_nonces, players cascade'),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pg.close();
      setDb(null);
      delete process.env.DATABASE_URL;
      neonConfig.fetchFunction = undefined;
    },
  };
}

// One HTTP request. Defaults imitate a browser calling the deployed site:
// Host, X-Forwarded-Proto, and for POST a JSON content-type plus a matching Origin.
// Pass `null` for a header to drop it. `json` is JSON-encoded; `raw` is sent as is;
// `chunks` are written separately with no Content-Length (chunked transfer).
export function call(app, urlPath, opts = {}) {
  const {
    method = 'POST',
    host = HOST,
    proto = 'https',
    json,
    raw,
    chunks,
    cookie,
    headers: extra = {},
  } = opts;

  const headers = { host, 'x-forwarded-proto': proto };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers.origin = `${proto}://${host}`;
  }
  if (cookie) headers.cookie = cookie;
  Object.assign(headers, extra);
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];

  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: urlPath, method, headers, agent: false });
    let gotResponse = false;
    req.on('response', (res) => {
      gotResponse = true;
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // not JSON
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: res.headers['set-cookie'] ?? [],
          text,
          json: parsed,
        });
      });
    });
    // A server that answers early (413) and closes may reset our unfinished upload; the response is what counts.
    req.on('error', (err) => {
      if (!gotResponse) reject(err);
    });

    if (chunks) {
      for (const part of chunks) req.write(part);
      req.end();
    } else if (raw !== undefined) {
      req.end(raw);
    } else if (json !== undefined) {
      req.end(JSON.stringify(json));
    } else {
      req.end();
    }
  });
}

// "forge_session=<token>" from a response's Set-Cookie, ready to send back as a Cookie header.
export function sessionCookieFrom(res) {
  const line = res.setCookie.find((c) => c.startsWith('forge_session='));
  return line ? line.split(';')[0] : null;
}

// Parse one Set-Cookie line into { name, value, flags: Set<lowercase>, attrs: {lowercase: value} }.
export function parseSetCookie(line) {
  const [pair, ...attributes] = line.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const flags = new Set();
  const attrs = {};
  for (const attribute of attributes) {
    const i = attribute.indexOf('=');
    if (i === -1) flags.add(attribute.toLowerCase());
    else attrs[attribute.slice(0, i).toLowerCase()] = attribute.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), flags, attrs };
}

// Full sign-in with a wallet, exactly what the browser does: nonce -> personal_sign -> verify.
export async function signIn(app, wallet, opts = {}) {
  const nonceRes = await call(app, '/api/auth/nonce', { ...opts, json: { address: wallet.address } });
  if (nonceRes.status !== 200) throw new Error(`nonce failed: ${nonceRes.status} ${nonceRes.text}`);
  const { message } = nonceRes.json;
  const signature = await wallet.signMessage(message);
  const verifyRes = await call(app, '/api/auth/verify', { ...opts, json: { message, signature } });
  return { nonceRes, verifyRes, message, signature, cookie: sessionCookieFrom(verifyRes) };
}

// Build a SIWE message by hand (the server would never write some of these).
export function craftMessage({
  address,
  host = HOST,
  nonce: nonceValue,
  chainId = 4441,
  issuedAt = new Date(),
  expirationTime = new Date(Date.now() + 10 * 60 * 1000),
  uri,
}) {
  return new SiweMessage({
    domain: host,
    address: getAddress(address),
    statement: SIWE_STATEMENT,
    uri: uri ?? `https://${host}`,
    version: '1',
    chainId,
    nonce: nonceValue,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
  }).prepareMessage();
}
