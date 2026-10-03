// POST /api/auth/verify  {"message","signature"}  ->  {"address","createdAt"} + Set-Cookie
//
// Step 2 of sign-in: check the wallet's signature over the message from
// /api/auth/nonce, consume the nonce, and start a session.
// Every failure is a 401 with a short generic reason.

import { getChainId } from '../_lib/config.js';
import { query } from '../_lib/db.js';
import { HttpError, assertHostAllowed, endpoint, readJsonBody, sendJson } from '../_lib/http.js';
import { createSession, publicPlayer, readSessionToken, sessionCookie } from '../_lib/session.js';
import { checkSignedMessage } from '../_lib/siwe.js';

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/; // 65 bytes: r, s, v
const MAX_MESSAGE_CHARS = 2048; // real messages are ~350

export default endpoint({ methods: ['POST'] }, async (req, res, info) => {
  assertHostAllowed(info);

  const { message, signature } = await readJsonBody(req);
  if (typeof message !== 'string' || message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, 'message must be a non-empty string');
  }
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
    throw new HttpError(400, 'signature must be a 0x-prefixed 65-byte hex string');
  }

  // Signature, domain, chain and time window first...
  const { address, nonce } = checkSignedMessage({ message, signature, info, chainId: getChainId() });
  const owner = address.toLowerCase();

  // ...and only then burn the nonce, so a junk request can never use up someone
  // else's pending login. Single-use: one atomic DELETE ... RETURNING, so of two
  // concurrent replays of the same signed message exactly one gets the row.
  // It must exist, be unexpired, and have been issued to this same address.
  const consumed = await query(
    'delete from auth_nonces where nonce = $1 and address = $2 and expires_at > now() returning nonce',
    [nonce, owner],
  );
  if (consumed.length !== 1) throw new HttpError(401, 'nonce expired or already used');

  const [row] = await query(
    `insert into players (address) values ($1)
     on conflict (address) do update set last_login_at = now()
     returning address, display_name, created_at`,
    [owner],
  );
  const player = publicPlayer(row);

  const { token } = await createSession({
    address: owner,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 256) || null,
    replacing: readSessionToken(req), // sign-in rotates the session: no fixation, no leftovers
  });

  res.setHeader('Set-Cookie', sessionCookie(token, info));
  sendJson(res, 200, { address: player.address, createdAt: player.createdAt });
});
