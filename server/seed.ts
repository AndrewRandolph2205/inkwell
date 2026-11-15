import { type DB, all, get, run } from "./db.js";
import { createDocument } from "./documents.js";

/**
 * Give a brand-new database some content so a reviewer immediately sees owned vs shared
 * documents, every access level, and a comment. Runs only when there are no documents at all.
 */
export async function seedDemoDocuments(db: DB) {
  const existing = await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM documents");
  if (existing && existing.n > 0) return;
  const users = await all<{ id: number; email: string }>(db, "SELECT id, email FROM users");
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  const [alice, bob, carol] = [id("alice@example.com"), id("bob@example.com"), id("carol@example.com")];

  const welcome = await createDocument(
    db,
    alice,
    "Welcome to Inkwell",
    "<h1>Welcome to Inkwell</h1><p>This document is owned by <strong>Alice</strong> and shared with " +
      "<em>Bob (can edit)</em> and <em>Carol (can comment)</em>. Sign in as each of them to see the difference.</p>" +
      "<h2>Things to try</h2><ul><li><p>Format text with <strong>bold</strong>, <em>italic</em>, " +
      "<u>underline</u> and headings</p></li><li><p>Import a <code>.txt</code>, <code>.md</code> or " +
      "<code>.docx</code> file from the home page</p></li><li><p>Click <strong>Share</strong> to grant or revoke access</p></li>" +
      "<li><p>Select some text and add a comment</p></li><li><p>Open <strong>History</strong> to restore an earlier version</p></li></ul>" +
      "<ol><li><p>Edits save automatically</p></li><li><p>Open this document as two users to see who else is here</p></li></ol>",
  );
  const notes = await createDocument(
    db,
    bob,
    "Team meeting notes",
    "<h2>Weekly sync</h2><p>Owned by Bob, shared with Alice as <strong>view only</strong>.</p>" +
      "<ul><li><p>Ship the import feature</p></li><li><p>Review sharing permissions</p></li></ul>",
  );
  await createDocument(db, carol, "Carol's private draft", "<p>Not shared with anyone. Only Carol can see this.</p>");

  const shares: [number, number, string][] = [[welcome, bob, "editor"], [welcome, carol, "commenter"], [notes, alice, "viewer"]];
  for (const [docId, userId, role] of shares) {
    await run(db, "INSERT INTO document_shares (document_id, user_id, role) VALUES (?, ?, ?)", [docId, userId, role]);
  }
  await run(db, "INSERT INTO comments (document_id, author_id, body, quote) VALUES (?, ?, ?, ?)", [
    welcome, carol, "Carol can comment but not edit. Try resolving this comment as Alice or Bob.", "Things to try",
  ]);
}
