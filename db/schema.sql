-- FORGE: Sign-In with Ethereum schema (Postgres / Neon).
--
-- Idempotent: safe to run any number of times (`npm run migrate`).
-- Keep every statement plain: scripts/migrate-db.mjs splits this file on ";"
-- (Neon's HTTP driver runs one statement per request), so no $$ blocks, no
-- semicolons inside string literals.
--
-- Addresses are stored lowercase (0x + 40 hex). The API hands back the
-- EIP-55 checksummed form.

-- One row per wallet that has ever signed in.
create table if not exists players (
  address       text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  display_name  text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

-- Login challenges. Single use, short lived, bound to the address they were
-- issued for. Deleted (atomically) when consumed, purged when expired.
create table if not exists auth_nonces (
  nonce      text primary key,
  address    text not null check (address ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_nonces_expires_at_idx on auth_nonces (expires_at);

-- Browser sessions. Only the SHA-256 (hex) of the cookie token is stored, so a
-- database leak does not leak usable session cookies.
create table if not exists sessions (
  token_hash text primary key,
  address    text not null references players (address) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  user_agent text
);

create index if not exists sessions_address_idx on sessions (address);

create index if not exists sessions_expires_at_idx on sessions (expires_at);
