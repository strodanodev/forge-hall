// GET /api/health  ->  {"ok":true,"db":true|false}
// "ok" means this function ran; "db" reports whether `select 1` reached the database.
// Nothing about the database (host, error text) is ever exposed here.

import { query } from './_lib/db.js';
import { endpoint, sendJson } from './_lib/http.js';

const DB_TIMEOUT_MS = 3000;

async function dbReachable() {
  let timer;
  try {
    await Promise.race([
      query('select 1 as ok'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default endpoint({ methods: ['GET', 'HEAD'] }, async (req, res) => {
  sendJson(res, 200, { ok: true, db: await dbReachable() });
});
