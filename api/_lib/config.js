// Tunables and environment parsing for the sign-in API.
//
// Environment is read on every call (not at import time) so a deploy-time
// mistake surfaces as a clear error and tests can flip settings per case.

export const SESSION_COOKIE = 'forge_session';

// Login challenge lifetime. Also the SIWE message's Expiration Time.
export const NONCE_TTL_SECONDS = 10 * 60;

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// POST bodies are tiny ({address} or {message, signature}); refuse anything bigger.
export const MAX_BODY_BYTES = 8 * 1024;

// A SIWE message may claim to be issued slightly in the future (clock drift).
export const CLOCK_SKEW_SECONDS = 60;

export const SIWE_STATEMENT =
  'Sign in to the FORGE. This request will not trigger a blockchain transaction or cost any gas.';

// LitVM Liteforge testnet.
export const DEFAULT_CHAIN_ID = 4441;

export function getChainId() {
  const raw = (process.env.SIWE_CHAIN_ID ?? '').trim();
  if (raw === '') return DEFAULT_CHAIN_ID;
  const id = Number(raw);
  // Fail loudly: silently signing in on the wrong chain would be worse than an error.
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('SIWE_CHAIN_ID must be a positive integer');
  }
  return id;
}

// ALLOWED_HOSTS="forge.example.com,forge-git-main-me.vercel.app"
// Returns null when unset (any host is accepted), otherwise a lowercase array.
// Entries are compared with the browser's host exactly (include ":port" when it is not 80/443).
export function getAllowedHosts() {
  const raw = (process.env.ALLOWED_HOSTS ?? '').trim();
  if (raw === '') return null;
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
}
