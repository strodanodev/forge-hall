// HTTP plumbing shared by every endpoint: request host/origin, CSRF guards,
// body reading, JSON responses, and one wrapper (endpoint) that turns thrown
// errors into clean JSON responses.
//
// Only the plain Node req/res API is used (no Vercel-only helpers such as
// req.body / res.json), so the same handlers run on Vercel, in scripts/dev-server.mjs
// and under the tests.

import { MAX_BODY_BYTES, getAllowedHosts } from './config.js';

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// ---------------------------------------------------------------------------
// Request host / origin
// ---------------------------------------------------------------------------

// Dot-separated labels of letters, digits, "-" and "_" (not starting or ending with "-"),
// or a bracketed IPv6 literal, then an optional :port.
// Deliberately strict: this string ends up inside the SIWE message that gets signed.
const LABEL = '[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?';
const HOST_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?$`);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function firstValue(header) {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' ? value.split(',')[0].trim() : '';
}

// Where the request says it was sent: x-forwarded-host (set by Vercel / proxies), then Host.
export function getRequestInfo(req) {
  const host = (firstValue(req.headers['x-forwarded-host']) || firstValue(req.headers.host)).toLowerCase();
  if (!HOST_RE.test(host)) throw new HttpError(400, 'invalid host');

  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  const isLocal = LOCAL_HOSTNAMES.has(hostname);

  let proto = firstValue(req.headers['x-forwarded-proto']).toLowerCase();
  if (proto !== 'http' && proto !== 'https') {
    // No usable proxy header: real sites are https-only, plain http is for localhost.
    proto = isLocal && !req.socket?.encrypted ? 'http' : 'https';
  }
  return { host, hostname, proto, origin: `${proto}://${host}`, isLocal };
}

// SIWE binds a signature to a domain, and the domain checked is the one the
// request claims (x-forwarded-host / host). If ALLOWED_HOSTS is set, only those
// hosts may start or finish a sign-in: that pins the domain to something the
// operator chose, whatever headers a client or an odd proxy passes along.
let warnedNoAllowList = false;

export function assertHostAllowed(info) {
  const allowed = getAllowedHosts();
  if (allowed === null) {
    if (!warnedNoAllowList && process.env.VERCEL_ENV === 'production') {
      warnedNoAllowList = true;
      console.warn('[api] ALLOWED_HOSTS is not set: sign-in accepts any host. Set it to your production domain(s).');
    }
    return;
  }
  if (!allowed.includes(info.host)) throw new HttpError(403, 'host not allowed');
}

// ---------------------------------------------------------------------------
// CSRF guards for POST
// ---------------------------------------------------------------------------

// Browsers can send a cross-site <form> POST only as urlencoded / multipart / text/plain.
// Demanding application/json therefore forces a CORS preflight, which we never
// approve (no CORS headers anywhere), so other sites cannot drive these endpoints.
function assertJsonContentType(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json');
}

// Belt and braces: browsers always attach Origin to cross-origin POSTs.
// Requests without Origin (curl, server to server) are fine, they cannot carry a victim's cookie.
function assertSameOrigin(req, info) {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== info.origin) throw new HttpError(403, 'cross-origin request refused');
}

// ---------------------------------------------------------------------------
// Body + cookies
// ---------------------------------------------------------------------------

export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES, allowEmpty = false } = {}) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'request body too large');

  // Vercel only parses req.body when it is accessed, so the raw stream is still ours.
  // destroyOnReturn:false: bailing out of the loop must not destroy the socket,
  // otherwise the client would see a reset instead of our 413.
  const source = typeof req.iterator === 'function' ? req.iterator({ destroyOnReturn: false }) : req;
  const chunks = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'request body too large');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    if (allowEmpty) return {};
    throw new HttpError(400, 'request body is empty');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return data;
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function setCommonHeaders(res) {
  // Auth responses are per-user: never cache them anywhere.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  setCommonHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

export function sendNoContent(res) {
  res.statusCode = 204;
  setCommonHeaders(res);
  res.end();
}

function sendError(res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    // After an oversize body we stop reading, so do not reuse the connection.
    if (err.status === 413) res.setHeader('Connection', 'close');
    sendJson(res, err.status, { error: err.message });
    return;
  }
  // Anything unexpected (database down, bug): log it, tell the client nothing.
  console.error('[api] unhandled error:', err);
  sendJson(res, 500, { error: 'server error' });
}

// ---------------------------------------------------------------------------
// CORS, for public read-only endpoints only
// ---------------------------------------------------------------------------

// endpoint({ cors: true }) opens an endpoint to every origin: partners' sites and quest platforms
// (Galxe's dashboard, for one) call it from their own pages. That is safe only because such an
// endpoint reads no cookie and answers nothing private; the wildcard origin also means browsers
// never send credentials with it. The cookie endpoints never set these headers.
function setCorsOrigin(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function sendPreflight(res, allow) {
  res.setHeader('Access-Control-Allow-Methods', allow.join(', '));
  // Listed, not "*": a wildcard does not cover Authorization, which some platforms always send.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  sendNoContent(res);
}

// endpoint({ methods, cors }, fn) -> handler(req, res) for `export default`.
// - 405 (+ Allow) for other methods
// - POST: JSON content-type (415) and same-origin (403) checks, then fn(req, res, info)
//   where info = { host, hostname, proto, origin, isLocal }
// - cors: true -> any origin may read it and OPTIONS preflights are answered.
//   Only for public endpoints that read no cookie. POSTs stay same-origin either way.
// - HttpError -> JSON error response, anything else -> generic 500
export function endpoint({ methods, cors = false }, fn) {
  const allow = cors ? [...methods, 'OPTIONS'] : methods;
  return async function handler(req, res) {
    try {
      if (cors) {
        setCorsOrigin(res); // first, so error responses are readable cross-origin too
        if (req.method === 'OPTIONS') {
          sendPreflight(res, allow);
          return;
        }
      }
      if (!methods.includes(req.method)) {
        throw new HttpError(405, 'method not allowed', { Allow: allow.join(', ') });
      }
      let info;
      if (req.method === 'POST') {
        info = getRequestInfo(req);
        assertJsonContentType(req);
        assertSameOrigin(req, info);
      }
      await fn(req, res, info);
    } catch (err) {
      sendError(res, err);
    }
  };
}
