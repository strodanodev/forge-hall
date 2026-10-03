// POST /api/auth/logout  ->  204, session row deleted, cookie cleared.
// Idempotent: signing out when already signed out is not an error.
// Like every POST it needs `content-type: application/json` (the body may be empty or {}).

import { endpoint, readJsonBody, sendNoContent } from '../_lib/http.js';
import { clearedSessionCookie, destroySession, readSessionToken } from '../_lib/session.js';

export default endpoint({ methods: ['POST'] }, async (req, res, info) => {
  await readJsonBody(req, { allowEmpty: true }); // ignored, but still size-capped and must be JSON if present

  const token = readSessionToken(req);
  if (token) await destroySession(token);

  res.setHeader('Set-Cookie', clearedSessionCookie(info));
  sendNoContent(res);
});
