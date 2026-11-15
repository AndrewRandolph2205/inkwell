import { createClient, type Client, type InArgs } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashPassword } from "./passwords.js";

export type DB = Client;

/**
 * Schema changes are applied as numbered migrations, recorded in `schema_migrations`, so an
 * existing database (e.g. the live Turso one) is upgraded in place on startup. Each migration
 * runs as one batch, which libSQL executes as a transaction: it applies fully or not at all.
 *
 * We don't rely on ON DELETE CASCADE: Turso's HTTP protocol doesn't guarantee a per-connection
 * `PRAGMA foreign_keys = ON`, so deletes clean up child rows explicitly (see documents.ts).
 */
export const MIGRATIONS: { version: number; name: string; statements: string[] }[] = [
  {
    version: 1,
    name: "initial schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS document_shares (
        document_id INTEGER NOT NULL REFERENCES documents(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (document_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id)`,
      `CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id)`,
    ],
  },
  {
    version: 2,
    name: "commenter role, version history, comments",
    statements: [
      // SQLite can't alter a CHECK constraint, so rebuild document_shares with the new role.
      `CREATE TABLE document_shares_v2 (
        document_id INTEGER NOT NULL REFERENCES documents(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (document_id, user_id)
      )`,
      `INSERT INTO document_shares_v2 (document_id, user_id, role, created_at)
         SELECT document_id, user_id, role, created_at FROM document_shares`,
      `DROP TABLE document_shares`,
      `ALTER TABLE document_shares_v2 RENAME TO document_shares`,
      `CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id)`,
      `CREATE TABLE document_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES users(id),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX idx_versions_doc ON document_versions(document_id, id)`,
      // Give existing documents a baseline so their history isn't empty.
      `INSERT INTO document_versions (document_id, version, title, content, author_id, note, created_at, updated_at)
         SELECT id, version, title, content, owner_id, 'Version history started', updated_at, updated_at FROM documents`,
      `CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        author_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        quote TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX idx_comments_doc ON comments(document_id)`,
    ],
  },
];

export async function migrate(db: DB, upTo = MIGRATIONS.length) {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const applied = new Set(
    (await db.execute("SELECT version FROM schema_migrations")).rows.map((r) => Number(r.version)),
  );
  for (const m of MIGRATIONS.slice(0, upTo)) {
    if (applied.has(m.version)) continue;
    await db.batch(
      [
        ...m.statements,
        { sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)", args: [m.version, m.name] },
      ],
      "write",
    );
  }
}

/** Demo accounts. Passwords are intentionally public; this is a demo. */
export const SEED_USERS = [
  { email: "alice@example.com", name: "Alice Chen" },
  { email: "bob@example.com", name: "Bob Okafor" },
  { email: "carol@example.com", name: "Carol Díaz" },
];
export const SEED_PASSWORD = "password123";

export interface DbConfig {
  url: string;
  authToken?: string;
}

/**
 * TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) → hosted Turso database.
 * Otherwise a local SQLite file at DATABASE_PATH (default ./data/docs.db).
 */
export function dbConfigFromEnv(env = process.env): DbConfig {
  if (env.TURSO_DATABASE_URL) {
    return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN };
  }
  if (env.NODE_ENV === "production" && !env.DATABASE_PATH) {
    // Fail loudly rather than silently writing to a disk that a free host wipes on restart.
    throw new Error(
      "No database configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or DATABASE_PATH for a persistent local file.",
    );
  }
  const file = env.DATABASE_PATH ?? join(process.cwd(), "data", "docs.db");
  mkdirSync(dirname(file), { recursive: true });
  return { url: `file:${file}` };
}

export async function openDb(config: DbConfig | string, opts: { migrateUpTo?: number } = {}): Promise<DB> {
  const db = createClient(typeof config === "string" ? { url: config } : config);
  await migrate(db, opts.migrateUpTo);
  await db.batch(
    SEED_USERS.map((u) => ({
      sql: "INSERT OR IGNORE INTO users (email, name, password_hash) VALUES (?, ?, ?)",
      args: [u.email, u.name, hashPassword(SEED_PASSWORD)],
    })),
    "write",
  );
  return db;
}

// ---- small query helpers: plain objects out, numbers not bigints ----

export async function all<T>(db: DB, sql: string, args: InArgs = []): Promise<T[]> {
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c) => [c, row[c]])) as T);
}

export async function get<T>(db: DB, sql: string, args: InArgs = []): Promise<T | undefined> {
  return (await all<T>(db, sql, args))[0];
}

export async function run(db: DB, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
}
