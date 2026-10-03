// Local dev server: serves web/ as static files and routes /api/* to api/**/*.js,
// the way Vercel does in production.
//
//   npm run dev                    http://localhost:3000 with an in-memory database (nothing to set up)
//   PORT=4000 npm run dev          another port (PORT=0 picks a free one)
//   DATABASE_URL=... npm run dev   use a real Neon database instead (run `npm run migrate` first)
//
// Binds to 127.0.0.1 only. Handlers use the plain Node req/res API, so API code
// changes need a restart (modules are imported once).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pgliteRunner, query, setDb } from '../api/_lib/db.js';
import { sendJson } from '../api/_lib/http.js';
import { splitStatements } from '../api/_lib/sql.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const API_DIR = path.join(ROOT, 'api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.hdr': 'image/vnd.radiance',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ---------------------------------------------------------------------------
// /api/* -> api/<path>.js (or api/<path>/index.js)
// ---------------------------------------------------------------------------

// Segments must start with a letter or digit, so "_lib" (private helpers) is never routable,
// and no dots can appear, so "x.test" style file names cannot be reached.
const API_ROUTE = /^\/api\/((?:[A-Za-z0-9][\w-]*\/)*[A-Za-z0-9][\w-]*)\/?$/;

function findApiFile(route) {
  if (route.split('/')[0] === 'test') return null; // never serve the test folder
  for (const candidate of [`${route}.js`, `${route}/index.js`]) {
    const file = path.join(API_DIR, candidate);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

async function handleApi(req, res, pathname) {
  const match = API_ROUTE.exec(pathname);
  const file = match && findApiFile(match[1]);
  if (!file) return sendJson(res, 404, { error: 'not found' });
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') throw new Error(`${file} has no default export`);
  return mod.default(req, res);
}

// ---------------------------------------------------------------------------
// Static files from web/
// ---------------------------------------------------------------------------

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

async function statOrNull(file) {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    return res.end();
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }
  // No NUL, backslashes or ":" (Windows alternate data streams), and no dot segments:
  // that also covers "..", so a request can never climb out of web/.
  const segments = decoded.split('/').filter(Boolean);
  if (/[\0\\:]/.test(decoded) || segments.some((s) => s.startsWith('.'))) return notFound(res);

  let file = path.join(WEB_DIR, ...segments);
  let stat = await statOrNull(file);
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await statOrNull(file);
  }
  if (!stat?.isFile()) return notFound(res);

  // Single byte-range support (video/audio seeking, big .glb files).
  const size = stat.size;
  let status = 200;
  let start = 0;
  let end = size - 1;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2]) && size > 0) {
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2])); // "last N bytes"
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    status = 206;
  }

  res.statusCode = status;
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache'); // always re-check while developing
  if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  if (req.method === 'HEAD' || size === 0) return res.end();
  pipeline(fs.createReadStream(file, { start, end }), res, (err) => {
    if (err) res.destroy();
  });
}

// ---------------------------------------------------------------------------

async function onRequest(req, res) {
  try {
    const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else await handleStatic(req, res, pathname);
  } catch (err) {
    console.error('[dev-server]', err);
    if (res.headersSent) return res.end();
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal server error');
  }
}

// Import every handler up front: the first import of ethers/siwe is slow, and it is
// better to pay for it at startup than on the first click (it also surfaces syntax errors early).
async function preloadApi(dir = API_DIR) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await preloadApi(full);
    else if (entry.name.endsWith('.js')) await import(pathToFileURL(full).href);
  }
}

// In-memory Postgres (PGlite) with db/schema.sql applied. Gone when the server stops.
async function startMemoryDatabase() {
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    console.error('The in-memory database needs the dev dependencies. Run: npm install');
    process.exit(1);
  }
  const pg = new PGlite();
  await pg.waitReady;
  setDb(pgliteRunner(pg));
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  for (const statement of splitStatements(schema)) await query(statement);
  return pg;
}

async function main() {
  const port = process.env.PORT === undefined || process.env.PORT === '' ? 3000 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }

  let pg = null;
  let dbNote;
  if (process.env.DATABASE_URL) {
    dbNote = 'Neon (from DATABASE_URL; run `npm run migrate` once if you have not)';
  } else {
    pg = await startMemoryDatabase();
    dbNote = 'in-memory PGlite (sessions vanish on restart; set DATABASE_URL to use Neon)';
  }

  await preloadApi();

  const server = http.createServer(onRequest);
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: PORT=3001 npm run dev` : err);
    process.exit(1);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  console.log(`FORGE dev server listening on http://localhost:${server.address().port}`);
  console.log(`  static: web/   api: api/   db: ${dbNote}`);

  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await pg?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
