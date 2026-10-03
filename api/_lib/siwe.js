// Sign-In with Ethereum (EIP-4361): build the message the wallet signs, and
// check a signed message that comes back.
//
// The server writes the message (browsers never need EIP-55 or keccak), and on
// the way back accepts only a message it could have written itself. Wallet
// signatures are EOA-only (recovered locally, no RPC / network call).

import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { SiweMessage } from 'siwe';
import { CLOCK_SKEW_SECONDS, NONCE_TTL_SECONDS, SIWE_STATEMENT } from './config.js';
import { HttpError } from './http.js';

// 128 random bits as 32 hex characters (SIWE wants alphanumeric, at least 8).
export function newNonce() {
  return randomBytes(16).toString('hex');
}

// `address` must already be EIP-55 checksummed. `info` comes from getRequestInfo().
export function buildSiweMessage({ address, info, chainId, nonce, now = new Date() }) {
  const expiresAt = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000);
  const message = new SiweMessage({
    domain: info.host,
    address,
    statement: SIWE_STATEMENT,
    uri: info.origin,
    version: '1',
    chainId,
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
  }).prepareMessage();
  return { message, expiresAt };
}

// Only the exact instant format we issue (toISOString), so date parsing is unambiguous.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return NaN;
  const ms = Date.parse(value);
  return new Date(ms).toISOString() === value ? ms : NaN;
}

const fail = (reason) => new HttpError(401, reason);

// Everything except the nonce lookup: parse, domain, chain, time window, signature.
// Returns { address (EIP-55), nonce }. Throws HttpError(401, <short generic reason>).
// The caller then consumes the nonce in the database (see api/auth/verify.js).
//
// (siwe's own SiweMessage#verify is not used: it keeps executing after a failed
// check and logs raw errors. These checks are explicit and easy to audit.)
export function checkSignedMessage({ message, signature, info, chainId, now = new Date() }) {
  let siwe;
  try {
    siwe = new SiweMessage(message);
    // The ABNF parser tolerates variants (leading zeros in Chain ID, odd date forms...).
    // Requiring the message to re-serialise to exactly itself rules them all out.
    if (siwe.prepareMessage() !== message) throw new Error('not canonical');
  } catch {
    throw fail('invalid message');
  }

  // Exact host, not "ends with" / "contains": a signature for evil.example.com must
  // be worthless here. That is the whole point of the domain field.
  if (siwe.scheme !== undefined) throw fail('invalid message');
  if (siwe.domain !== info.host) throw fail('wrong domain');
  let uriOrigin;
  try {
    uriOrigin = new URL(siwe.uri).origin;
  } catch {
    throw fail('invalid message');
  }
  if (uriOrigin !== info.origin) throw fail('invalid message');

  if (siwe.chainId !== chainId) throw fail('wrong chain');

  // We never issue Not Before; a message carrying one was not written by us.
  if (siwe.notBefore !== undefined) throw fail('invalid message');
  const issuedAt = parseInstant(siwe.issuedAt);
  const expiresAt = parseInstant(siwe.expirationTime);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt) || expiresAt <= issuedAt) throw fail('invalid message');
  if (expiresAt <= now.getTime()) throw fail('message expired');
  if (issuedAt > now.getTime() + CLOCK_SKEW_SECONDS * 1000) throw fail('invalid message');

  // Recover the signer from the EIP-191 personal_sign signature; it must be the
  // address named in the message (which the parser already proved is EIP-55).
  let signer;
  try {
    signer = verifyMessage(message, signature);
  } catch {
    throw fail('invalid signature');
  }
  if (signer !== siwe.address) throw fail('invalid signature');

  return { address: siwe.address, nonce: siwe.nonce };
}
