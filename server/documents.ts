import { type DB, all, get, run } from "./db.js";

/** Edits by the same person within this window are folded into one history entry. */
export const HISTORY_MERGE_MINUTES = 5;
const HISTORY_LIMIT = 100;

/** Create a document and its first history entry atomically. */
export async function createDocument(db: DB, ownerId: number, title: string, content: string, note = "Created") {
  const [inserted] = await db.batch(
    [
      { sql: "INSERT INTO documents (owner_id, title, content) VALUES (?, ?, ?)", args: [ownerId, title, content] },
      {
        sql: `INSERT INTO document_versions (document_id, version, title, content, author_id, note)
              VALUES (last_insert_rowid(), 1, ?, ?, ?, ?)`,
        args: [title, content, ownerId, note],
      },
    ],
    "write",
  );
  return Number(inserted.lastInsertRowid);
}

/**
 * Record a saved edit in the history. Autosave fires every second or so while typing, so a
 * snapshot per save would be noise; instead consecutive saves by the same author within
 * HISTORY_MERGE_MINUTES update the latest entry. Entries with a note (Created, Restored…) are
 * never merged into, so those milestones stay visible.
 */
export async function recordEdit(
  db: DB,
  e: { docId: number; version: number; title: string; content: string; authorId: number },
) {
  const last = await get<{ id: number; mergeable: number }>(
    db,
    `SELECT id, (author_id = ? AND note IS NULL AND updated_at >= datetime('now', ?)) AS mergeable
     FROM document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1`,
    [e.authorId, `-${HISTORY_MERGE_MINUTES} minutes`, e.docId],
  );
  if (last?.mergeable) {
    await run(
      db,
      `UPDATE document_versions SET version = ?, title = ?, content = ?, updated_at = datetime('now') WHERE id = ?`,
      [e.version, e.title, e.content, last.id],
    );
  } else {
    await recordMilestone(db, { ...e, note: null });
  }
}

export async function recordMilestone(
  db: DB,
  e: { docId: number; version: number; title: string; content: string; authorId: number; note: string | null },
) {
  await run(
    db,
    `INSERT INTO document_versions (document_id, version, title, content, author_id, note) VALUES (?, ?, ?, ?, ?, ?)`,
    [e.docId, e.version, e.title, e.content, e.authorId, e.note],
  );
}

export function listVersions(db: DB, docId: number) {
  return all(
    db,
    `SELECT v.id, v.version, v.title, v.note, v.created_at AS createdAt, v.updated_at AS updatedAt,
            u.id AS authorId, u.name AS authorName
     FROM document_versions v JOIN users u ON u.id = v.author_id
     WHERE v.document_id = ? ORDER BY v.id DESC LIMIT ${HISTORY_LIMIT}`,
    [docId],
  );
}

export function getVersion(db: DB, docId: number, versionId: number) {
  return get<{ id: number; version: number; title: string; content: string; note: string | null; updatedAt: string; authorName: string }>(
    db,
    `SELECT v.id, v.version, v.title, v.content, v.note, v.updated_at AS updatedAt, u.name AS authorName
     FROM document_versions v JOIN users u ON u.id = v.author_id
     WHERE v.document_id = ? AND v.id = ?`,
    [docId, versionId],
  );
}

export async function lastEditor(db: DB, docId: number) {
  return (
    (await get<{ id: number; name: string }>(
      db,
      `SELECT u.id, u.name FROM document_versions v JOIN users u ON u.id = v.author_id
       WHERE v.document_id = ? ORDER BY v.id DESC LIMIT 1`,
      [docId],
    )) ?? null
  );
}

/** Delete a document and everything hanging off it (no reliance on FK cascades; see db.ts). */
export async function deleteDocument(db: DB, docId: number) {
  await db.batch(
    [
      { sql: "DELETE FROM comments WHERE document_id = ?", args: [docId] },
      { sql: "DELETE FROM document_versions WHERE document_id = ?", args: [docId] },
      { sql: "DELETE FROM document_shares WHERE document_id = ?", args: [docId] },
      { sql: "DELETE FROM documents WHERE id = ?", args: [docId] },
    ],
    "write",
  );
}
