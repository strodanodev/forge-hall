// Apply db/schema.sql to the database in DATABASE_URL (a Neon connection string).
//
//   npm run migrate
//
// Safe to re-run: the schema only uses "create ... if not exists".
// DATABASE_URL comes from the shell environment, or from .env.local / .env in
// the repo root (values already in the environment win). The password is never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../api/_lib/db.js';
import { splitStatements } from '../api/_lib/sql.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['.env.local', '.env']) {
  const file = path.join(ROOT, name);
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  console.error('Put your Neon connection string in .env (see .env.example) or export it, then run: npm run migrate');
  process.exit(1);
}

let target;
try {
  const u = new URL(url);
  target = `${u.host}${u.pathname}`;
} catch {
  console.error('DATABASE_URL is not a valid URL (expected postgresql://user:password@host/dbname).');
  process.exit(1);
}

const statements = splitStatements(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
console.log(`Applying db/schema.sql (${statements.length} statements) to ${target} ...`);

try {
  for (const statement of statements) await query(statement);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  console.error('This script talks to Neon over HTTPS; check that DATABASE_URL is the Neon connection string.');
  process.exit(1);
}
console.log('Done. Schema is up to date.');
