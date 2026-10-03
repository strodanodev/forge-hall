// GET /api/auth/me  ->  {"address","createdAt","displayName"}  or 401 {"error":"not signed in"}

import { HttpError, endpoint, sendJson } from '../_lib/http.js';
import { findSession, readSessionToken } from '../_lib/session.js';

export default endpoint({ methods: ['GET'] }, async (req, res) => {
  const token = readSessionToken(req);
  const player = token ? await findSession(token) : null;
  if (!player) throw new HttpError(401, 'not signed in');
  sendJson(res, 200, player);
});
