// Split a SQL script into single statements.
//
// Neon's HTTP driver (and PGlite's parameterised query()) run exactly one
// statement per call, so scripts/migrate-db.mjs and the dev server feed
// db/schema.sql through this. It understands "--" comments, "/* */" comments
// and '...' string literals (with '' escapes). It does NOT understand
// dollar-quoted bodies ($$ ... $$), so keep the schema file free of them.

export function splitStatements(script) {
  const statements = [];
  let current = '';
  let i = 0;

  const flush = () => {
    const stmt = current.trim();
    if (stmt) statements.push(stmt);
    current = '';
  };

  while (i < script.length) {
    const ch = script[i];
    const next = script[i + 1];

    if (ch === '-' && next === '-') {
      // Line comment: skip to end of line (the newline itself is kept as whitespace).
      while (i < script.length && script[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      i = end === -1 ? script.length : end + 2;
      current += ' ';
    } else if (ch === "'") {
      // String literal: copy verbatim up to the closing quote ('' is an escaped quote).
      current += ch;
      i++;
      while (i < script.length) {
        current += script[i];
        if (script[i] === "'") {
          if (script[i + 1] === "'") {
            current += script[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === ';') {
      flush();
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  flush();
  return statements;
}
