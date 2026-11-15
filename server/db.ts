import { createClient, type Client, type InArgs } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashPassword } from "./passwords.js";

export type DB = Client;

/**
 * Same schema runs on a local SQLite file (dev/tests) and on Turso (production).
 * Note: we don't rely on ON DELETE CASCADE. Turso's HTTP protocol doesn't guarantee a
 * per-connection `PRAGMA foreign_keys = ON`, so deletes clean up child rows explicitly.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS document_shares (
  document_id INTEGER NOT NULL REFERENCES documents(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id);
`;

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

export async function openDb(config: DbConfig | string): Promise<DB> {
  const db = createClient(typeof config === "string" ? { url: config } : config);
  await db.executeMultiple(SCHEMA);
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

/**
 * Give a brand-new database some content so a reviewer immediately sees owned vs shared
 * documents and both access levels. Runs only when there are no documents at all.
 */
export async function seedDemoDocuments(db: DB) {
  const existing = await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM documents");
  if (existing && existing.n > 0) return;
  const users = await all<{ id: number; email: string }>(db, "SELECT id, email FROM users");
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  const [alice, bob, carol] = [id("alice@example.com"), id("bob@example.com"), id("carol@example.com")];

  const docs: { owner: number; title: string; content: string; shares: [number, "viewer" | "editor"][] }[] = [
    {
      owner: alice,
      title: "Welcome to Inkwell",
      content:
        "<h1>Welcome to Inkwell</h1><p>This document is owned by <strong>Alice</strong> and shared with " +
        "<em>Bob (can edit)</em> and <em>Carol (view only)</em>. Sign in as each of them to see the difference.</p>" +
        "<h2>Things to try</h2><ul><li><p>Format text with <strong>bold</strong>, <em>italic</em>, " +
        "<u>underline</u> and headings</p></li><li><p>Import a <code>.txt</code>, <code>.md</code> or " +
        "<code>.docx</code> file from the home page</p></li><li><p>Click <strong>Share</strong> to grant or revoke access</p></li></ul>" +
        "<ol><li><p>Edits save automatically</p></li><li><p>Refresh: everything is still here</p></li></ol>",
      shares: [[bob, "editor"], [carol, "viewer"]],
    },
    {
      owner: bob,
      title: "Team meeting notes",
      content:
        "<h2>Weekly sync</h2><p>Owned by Bob, shared with Alice as <strong>view only</strong>.</p>" +
        "<ul><li><p>Ship the import feature</p></li><li><p>Review sharing permissions</p></li></ul>",
      shares: [[alice, "viewer"]],
    },
    {
      owner: carol,
      title: "Carol's private draft",
      content: "<p>Not shared with anyone. Only Carol can see this.</p>",
      shares: [],
    },
  ];

  for (const d of docs) {
    const { lastInsertRowid: docId } = await run(
      db, "INSERT INTO documents (owner_id, title, content) VALUES (?, ?, ?)", [d.owner, d.title, d.content],
    );
    for (const [userId, role] of d.shares) {
      await run(db, "INSERT INTO document_shares (document_id, user_id, role) VALUES (?, ?, ?)", [docId, userId, role]);
    }
  }
}
