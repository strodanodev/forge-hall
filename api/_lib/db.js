// Tiny database facade: query(text, params) -> rows[].
//
// Production: Neon's serverless HTTP driver on DATABASE_URL (one stateless
// HTTPS request per query, which is what you want inside serverless functions).
// Tests and `npm run dev`: swap in PGlite (in-memory Postgres) with setDb().
//
// Always pass user input through `params` ($1, $2, ...), never by string concatenation.

import { neon } from '@neondatabase/serverless';

let runner = null; // (text, params) => Promise<rows[]>

// Inject a different backend (or pass null to go back to Neon).
export function setDb(fn) {
  runner = fn;
}

// Wrap a PGlite instance (pg.query returns { rows }) as a runner.
export function pgliteRunner(pg) {
  return async (text, params = []) => (await pg.query(text, params)).rows;
}

function neonRunner() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  let sql;
  try {
    sql = neon(url);
  } catch {
    // neon() puts the whole connection string, password included, in its error message.
    // Say what is wrong without letting the secret reach logs or the terminal.
    throw new Error('DATABASE_URL is not a valid Neon connection string (postgresql://user:password@host/dbname)');
  }
  return (text, params = []) => sql.query(text, params);
}

export async function query(text, params = []) {
  // Created lazily and cached, so warm serverless invocations reuse it.
  runner ??= neonRunner();
  return runner(text, params);
}
