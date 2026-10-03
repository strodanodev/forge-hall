// db/schema.sql and the statement splitter that scripts/migrate-db.mjs (and the
// dev server) use to feed it to Neon's one-statement-at-a-time HTTP driver.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { splitStatements } from '../_lib/sql.js';

const SCHEMA = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'schema.sql'),
  'utf8',
);

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    assert.deepEqual(splitStatements('select 1;\n\n  select 2 ;select 3'), ['select 1', 'select 2', 'select 3']);
  });

  it('returns nothing for empty or comment-only input', () => {
    assert.deepEqual(splitStatements(''), []);
    assert.deepEqual(splitStatements('  \n-- just a comment\n/* and a block */ \n'), []);
    assert.deepEqual(splitStatements(';;;'), []);
  });

  it('drops line and block comments, including ones with semicolons and quotes in them', () => {
    const sql = `-- header; it's got a quote
      select 1; -- trailing; comment
      /* block; comment
         over two lines */ select 2;`;
    assert.deepEqual(splitStatements(sql), ['select 1', 'select 2']);
  });

  it('keeps semicolons and comment markers inside string literals', () => {
    assert.deepEqual(splitStatements("insert into t values ('a;b', '--not a comment');select 2"), [
      "insert into t values ('a;b', '--not a comment')",
      'select 2',
    ]);
  });

  it("understands '' escapes inside string literals", () => {
    assert.deepEqual(splitStatements("select 'it''s; fine'; select 2"), ["select 'it''s; fine'", 'select 2']);
  });

  it('handles Windows line endings', () => {
    assert.deepEqual(splitStatements('select 1;\r\n-- c\r\nselect 2;\r\n'), ['select 1', 'select 2']);
  });
});

describe('db/schema.sql', () => {
  let pg;

  before(
    async () => {
      pg = new PGlite();
      await pg.waitReady;
    },
    { timeout: 180_000 },
  );

  after(async () => {
    await pg.close();
  });

  const statements = splitStatements(SCHEMA);

  it('is nothing but idempotent create statements', () => {
    assert.ok(statements.length >= 6);
    for (const statement of statements) {
      assert.match(statement, /^create (table|index) if not exists /i, statement);
    }
  });

  it('can be applied statement by statement, over and over (what npm run migrate does)', async () => {
    for (let round = 0; round < 3; round++) {
      for (const statement of statements) await pg.query(statement);
    }
    // ...and also as one script (what a DBA pasting it into a console would do)
    await pg.exec(SCHEMA);

    const { rows } = await pg.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    assert.deepEqual(rows.map((r) => r.table_name), ['auth_nonces', 'players', 'sessions']);
  });

  it('has the columns the API contract needs', async () => {
    const { rows } = await pg.query(
      `select table_name, column_name, is_nullable from information_schema.columns
        where table_schema = 'public' order by table_name, ordinal_position`,
    );
    const columns = Object.groupBy(rows, (r) => r.table_name);
    const names = (table) => columns[table].map((c) => c.column_name);
    assert.deepEqual(names('players'), ['address', 'display_name', 'created_at', 'last_login_at']);
    assert.deepEqual(names('auth_nonces'), ['nonce', 'address', 'expires_at', 'created_at']);
    assert.deepEqual(names('sessions'), ['token_hash', 'address', 'expires_at', 'created_at', 'user_agent']);
    assert.equal(columns.players.find((c) => c.column_name === 'display_name').is_nullable, 'YES');
    assert.equal(columns.sessions.find((c) => c.column_name === 'user_agent').is_nullable, 'YES');
  });

  it('enforces lowercase addresses, primary keys and the session -> player link', async () => {
    const good = `0x${'ab'.repeat(20)}`;
    await pg.query('insert into players (address) values ($1)', [good]);

    await assert.rejects(pg.query('insert into players (address) values ($1)', [good.toUpperCase().replace('0X', '0x')]));
    await assert.rejects(pg.query('insert into players (address) values ($1)', ['0x1234']));
    await assert.rejects(pg.query('insert into players (address) values ($1)', [good])); // duplicate key
    await assert.rejects(
      pg.query(`insert into auth_nonces (nonce, address, expires_at) values ('n1', 'nope', now())`),
    );
    await assert.rejects(
      pg.query(`insert into sessions (token_hash, address, expires_at) values ('h', $1, now())`, [`0x${'cd'.repeat(20)}`]),
    ); // unknown player

    await pg.query(`insert into sessions (token_hash, address, expires_at) values ('h', $1, now())`, [good]);
    await pg.query('delete from players where address = $1', [good]);
    const { rows } = await pg.query('select * from sessions');
    assert.equal(rows.length, 0, 'sessions go away with their player');
  });
});
