import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword } from "./auth.js";

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS document_shares (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id);
`;

/** Demo accounts. Passwords are intentionally public — this is a demo. */
export const SEED_USERS = [
  { email: "alice@example.com", name: "Alice Chen" },
  { email: "bob@example.com", name: "Bob Okafor" },
  { email: "carol@example.com", name: "Carol Díaz" },
];
export const SEED_PASSWORD = "password123";

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO users (email, name, password_hash) VALUES (?, ?, ?)",
  );
  for (const u of SEED_USERS) insert.run(u.email, u.name, hashPassword(SEED_PASSWORD));
  return db;
}
