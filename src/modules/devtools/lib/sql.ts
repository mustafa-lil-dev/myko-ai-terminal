import { SAFE_IDENT, shq } from "./shq";

export type DbKind = "sqlite" | "postgres" | "mysql";

/** Removes comments and string/identifier literals so keyword checks can't be fooled. */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === q && sql[i + 1] === q) i += 2;
        else if (sql[i] === q) break;
        else i++;
      }
      i++;
      out += " ? ";
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0] ?? "$$";
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += " ? ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const MUTATING =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|rename|grant|revoke|attach|detach|vacuum|reindex|merge|call|copy|load|import|lock|set|reset|analyze|comment|do|exec|execute|into)\b/i;

export type SqlClass = {
  readOnly: boolean;
  statements: number;
  reason: string | null;
};

/**
 * Conservative: only plain SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / read-only
 * PRAGMA with no mutating keyword anywhere count as read-only. Everything else
 * needs explicit approval before it runs.
 */
export function classifySql(sql: string): SqlClass {
  const clean = stripSqlLiterals(sql).trim();
  const stmts = clean
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stmts.length === 0)
    return { readOnly: false, statements: 0, reason: "empty query" };
  for (const s of stmts) {
    const first = s.match(/^[A-Za-z]+/)?.[0]?.toLowerCase() ?? "";
    if (
      ![
        "select",
        "with",
        "explain",
        "show",
        "describe",
        "desc",
        "pragma",
        "values",
        "table",
      ].includes(first)
    )
      return {
        readOnly: false,
        statements: stmts.length,
        reason: `${first.toUpperCase() || "statement"} modifies data or schema`,
      };
    if (first === "explain" && /\banalyze\b/i.test(s))
      return {
        readOnly: false,
        statements: stmts.length,
        reason: "EXPLAIN ANALYZE executes the statement",
      };
    if (first === "pragma" && s.includes("="))
      return {
        readOnly: false,
        statements: stmts.length,
        reason: "PRAGMA assignment",
      };
    const body =
      first === "explain" ? s.replace(/^explain\s+(query\s+plan\s+)?/i, "") : s;
    const m = body.match(MUTATING);
    if (
      m &&
      first !== "pragma" &&
      first !== "show" &&
      first !== "describe" &&
      first !== "desc"
    )
      return {
        readOnly: false,
        statements: stmts.length,
        reason: `contains ${m[1].toUpperCase()}`,
      };
  }
  return { readOnly: true, statements: stmts.length, reason: null };
}

export type DbConn = { kind: DbKind; target: string };

/**
 * Builds the CLI invocation. Postgres/MySQL rely on the user's own client
 * config (~/.pgpass, ~/.my.cnf, PG* env): Myko never takes or stores passwords.
 * Read mode is enforced at the engine level too, not just by classifySql.
 */
export function buildQueryCommand(
  conn: DbConn,
  sql: string,
  allowWrite: boolean,
): string {
  const q = shq(sql);
  switch (conn.kind) {
    case "sqlite":
      return `sqlite3 -json ${allowWrite ? "" : "-readonly "}${shq(conn.target)} ${q}`;
    case "postgres":
      return `${allowWrite ? "" : "PGOPTIONS='-c default_transaction_read_only=on' "}psql ${shq(conn.target)} -X --csv -v ON_ERROR_STOP=1 -c ${q}`;
    case "mysql":
      return `mysql ${conn.target} --batch --raw -e ${shq(`${allowWrite ? "" : "SET SESSION TRANSACTION READ ONLY; "}${sql}`)}`;
  }
}

export function validateMysqlTarget(t: string): boolean {
  // flags such as `-h host -u user dbname`; no shell metacharacters
  return /^[A-Za-z0-9_@%:=.\- ]*$/.test(t);
}

export function listTablesSql(kind: DbKind): string {
  if (kind === "sqlite")
    return "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
  if (kind === "postgres")
    return "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1";
  return "SHOW TABLES";
}

export function describeSql(kind: DbKind, table: string): string {
  if (!SAFE_IDENT.test(table)) throw new Error("invalid table name");
  if (kind === "sqlite") return `PRAGMA table_info(${table})`;
  if (kind === "postgres") {
    const [s, t] = table.includes(".") ? table.split(".") : ["public", table];
    return `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='${s}' AND table_name='${t}' ORDER BY ordinal_position`;
  }
  return `DESCRIBE ${table}`;
}

export function previewRowsSql(table: string): string {
  if (!SAFE_IDENT.test(table)) throw new Error("invalid table name");
  return `SELECT * FROM ${table} LIMIT 100`;
}

export type Table = { columns: string[]; rows: string[][] };

function parseDelimited(text: string, delim: string): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && delim === ",") q = true;
    else if (c === delim) {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const [columns = [], ...rest] = rows;
  return { columns, rows: rest };
}

export function parseResult(kind: DbKind, stdout: string): Table {
  const text = stdout.trim();
  if (!text) return { columns: [], rows: [] };
  if (kind === "sqlite") {
    try {
      const data = JSON.parse(text) as Array<Record<string, unknown>>;
      const columns = data.length ? Object.keys(data[0]) : [];
      return {
        columns,
        rows: data.map((r) =>
          columns.map((c) => (r[c] === null ? "NULL" : String(r[c]))),
        ),
      };
    } catch {
      return { columns: ["output"], rows: [[text]] };
    }
  }
  return parseDelimited(text, kind === "postgres" ? "," : "\t");
}
