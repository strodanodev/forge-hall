// Cookie sessions.
//
// The browser holds a random 256-bit token; the database holds only its
// SHA-256. A leaked database (backup, SQL injection elsewhere, a curious admin)
// therefore contains nothing that can be replayed as a session cookie. The
// token is uniformly random, so a plain fast hash is enough (no salt or slow
// KDF needed, unlike passwords).

import { createHash, randomBytes } from 'node:crypto';
import { checksumAddress } from './address.js';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from './config.js';
import { query } from './db.js';
import { readCookie } from './http.js';

// 32 random bytes as unpadded base64url is exactly 43 characters.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// The session token from the request's cookie, or null if absent or malformed.
export function readSessionToken(req) {
  const token = readCookie(req, SESSION_COOKIE);
  return token !== null && TOKEN_RE.test(token) ? token : null;
}

// Create a session for `address` (lowercase). `replacing` is the caller's old
// token, if any: it is revoked so a login never leaves the previous session
// alive. Expired sessions are purged in the same statement.
export async function createSession({ address, userAgent = null, replacing = null }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await query(
    `with purge as (
       delete from sessions where expires_at <= now() or token_hash = $5
     )
     insert into sessions (token_hash, address, expires_at, user_agent)
     values ($1, $2, $3::timestamptz, $4)`,
    [hashToken(token), address, expiresAt.toISOString(), userAgent, replacing ? hashToken(replacing) : ''],
  );
  return { token, expiresAt };
}

// Public shape of a player row, as returned by the API.
export function publicPlayer(row) {
  return {
    address: checksumAddress(row.address),
    createdAt: new Date(row.created_at).toISOString(),
    displayName: row.display_name ?? null,
  };
}

// The signed-in player for a token, or null (unknown, expired, revoked).
export async function findSession(token) {
  const rows = await query(
    `select p.address, p.created_at, p.display_name
       from sessions s
       join players p on p.address = s.address
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows.length === 1 ? publicPlayer(rows[0]) : null;
}

export async function destroySession(token) {
  await query('delete from sessions where token_hash = $1', [hashToken(token)]);
}

// HttpOnly: page scripts (and any XSS) cannot read the token.
// SameSite=Lax: the browser does not attach it to cross-site POSTs.
// Secure: only over https, except on localhost where dev runs over plain http.
function serialize(value, { maxAge, secure }) {
  const expires = maxAge === 0 ? new Date(0) : new Date(Date.now() + maxAge * 1000);
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionCookie(token, info) {
  return serialize(token, { maxAge: SESSION_TTL_SECONDS, secure: !info.isLocal });
}

export function clearedSessionCookie(info) {
  return serialize('', { maxAge: 0, secure: !info.isLocal });
}
