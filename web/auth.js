// FORGE — client for the wallet sign-in API (sign a server-issued message, receive a session cookie).
//
//   POST /api/auth/nonce   { address }              -> { nonce, message }
//   POST /api/auth/verify  { message, signature }   -> { address, createdAt }  + session cookie (HttpOnly, set by the server)
//   GET  /api/auth/me                               -> { address, createdAt } | 401
//   POST /api/auth/logout                           -> 204
//
// The cookie never touches this code: fetch sends it (credentials: "same-origin"). The app can also be served without the
// backend (a plain static host); every call then fails with ApiUnavailable, which the UI uses to hide the sign-in button.

import { WalletError } from "./wallet.js";

/** The sign-in API is not there: network failure, 404/405/501/502/503/504 without an API error body, or a non-JSON
 *  answer (a static host's HTML fallback). Not a problem with the player's action. */
export class ApiUnavailable extends Error {
  constructor(message = "The sign-in service is not available here.", props = {}) {
    super(message, props.cause !== undefined ? { cause: props.cause } : undefined);
    this.name = "ApiUnavailable";
    this.status = props.status ?? null;
  }
}
/** The API answered and refused. .message is the server's own `error` text; .status the HTTP status. */
export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const NOT_THERE = new Set([404, 405, 501, 502, 503, 504]);

async function send(path, { method = "GET", body, base = "", fetch: f } = {}) {
  const doFetch = f ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new ApiUnavailable("fetch is not available in this environment.");
  let res;
  try {
    res = await doFetch(base + path, {
      method,
      credentials: "same-origin",
      headers: body === undefined && method === "GET" ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiUnavailable("The sign-in service could not be reached.", { cause: e });
  }
  let json = null;
  try {
    const text = await res.text();
    if (text) json = JSON.parse(text);
  } catch { /* an empty or non-JSON body is a legitimate answer (204, a static host's HTML); the callers judge it */ }
  return { status: res.status, ok: res.ok, json };
}

// non-2xx -> the server's own error text, unless it is not the API answering at all
function failure({ status, json }) {
  const text = typeof json?.error === "string" && json.error ? json.error : null;
  if (!text && NOT_THERE.has(status)) return new ApiUnavailable(`The sign-in service is not available here (HTTP ${status}).`, { status });
  return new AuthError(status, text ?? `Sign-in failed (HTTP ${status}).`);
}
async function postJson(path, body, opts) {
  const r = await send(path, { ...opts, method: "POST", body });
  if (!r.ok) throw failure(r);
  if (!r.json || typeof r.json !== "object") throw new ApiUnavailable("The sign-in service answered with something that is not JSON.", { status: r.status });
  return r.json;
}

/**
 * Sign in with the connected wallet: fetch a nonce message, have the wallet sign it (personal_sign), let the server
 * verify it and set the session cookie. Resolves { address, createdAt }. Throws WalletError (not_connected,
 * user_rejected, ...), AuthError (server refused) or ApiUnavailable. opts: { base, fetch } (path prefix, test hook).
 */
export async function signIn(wallet, opts = {}) {
  if (!wallet?.connected) throw new WalletError("not_connected", "Connect your wallet first.");
  const { message } = await postJson("/api/auth/nonce", { address: wallet.address }, opts);
  if (typeof message !== "string" || !message) throw new AuthError(502, "The sign-in service sent an unreadable challenge. Please try again.");
  const signature = await wallet.personalSign(message);
  const session = await postJson("/api/auth/verify", { message, signature }, opts);
  return { address: session.address, createdAt: session.createdAt };
}

/** The current session { address, createdAt }, or null when signed out (401). Throws ApiUnavailable when there is no API. */
export async function me(opts = {}) {
  const r = await send("/api/auth/me", opts);
  if (r.status === 401) return null;
  if (!r.ok) throw failure(r);
  if (!r.json || typeof r.json.address !== "string") throw new ApiUnavailable("The sign-in service answered with something that is not a session.", { status: r.status });
  return r.json;
}

/** End the session (the server clears the cookie). Resolves true; already being signed out (401) counts as done. */
export async function signOut(opts = {}) {
  const r = await send("/api/auth/logout", { ...opts, method: "POST" });
  if (!r.ok && r.status !== 401) throw failure(r);
  return true;
}
