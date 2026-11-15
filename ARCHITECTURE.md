# Architecture note

## Shape

One Node process. Express serves a JSON API under `/api` and the built React app for every other path. Storage is SQLite through the libSQL client. In development and tests that's a local file (or in-memory), so there's nothing to install. In production it's a hosted [Turso](https://turso.tech) database. The same client, schema and SQL run in both, and only the connection URL changes.

```
Browser (React + Tiptap) ──fetch /api──▶ Express ──▶ libSQL client ──▶ local SQLite file  (dev / tests)
                                                                  └──▶ Turso over HTTPS   (production)

Tables: users, sessions, documents, document_shares
```

## What I prioritized, and why

**1. Correct access control, enforced on the server.** Sharing is the feature most likely to be subtly wrong, so every document route goes through a single `access(docId, userId) → { doc, role }` function. Route handlers then check the role (`viewer` cannot write; only `owner` can delete or manage sharing). Users with no access get **404, not 403**, so document IDs don't reveal which documents exist. The UI hides controls by role, but that is for convenience only. The integration test walks the full owner → viewer → editor → revoked matrix over HTTP.

**2. Formatting that round-trips exactly.** Documents are stored as HTML from the editor. The server sanitizes every write *and* every import against an allowlist that matches exactly what the editor can represent (`p, h1–h3, strong, em, u, s, ul, ol, li, blockquote, code, pre, br, hr`). This does two jobs: it blocks stored XSS (content is shared between users, so this matters), and it means reopened content is never silently changed by the editor. I chose HTML over ProseMirror JSON because it is readable in the database, is the natural output of the importers (mammoth, marked), and is easy to export later.

**3. Not losing people's work.** This is what makes an editor feel trustworthy:
- Autosave with a short debounce, plus Ctrl/Cmd+S, plus a visible save state.
- Saves are **serialized** on the client. Only one request is in flight at a time, and each carries the version returned by the previous one, so fast typing can't cause out-of-order writes.
- **Optimistic concurrency.** `PATCH` requires `baseVersion`; a stale write gets `409` and the UI says so plainly instead of overwriting a collaborator's edits. (Real-time co-editing with CRDTs/OT was out of scope; this is the honest minimum for a document more than one person can edit.)
- A failed save keeps the pending edits and offers Retry; `beforeunload` warns about unsaved changes.

**4. Upload that is useful in the product.** Import makes a new editable document from `.txt`, `.md` or `.docx`. That covers the common "I already have this somewhere" case. Files are processed in memory (2 MB cap), never written to disk, and pass through the same sanitizer as editor content. Supported types are stated in the UI, enforced on both sides, and documented.

**5. Validation and errors that are useful to the person.** zod schemas on every input; one `HttpError` type and one error middleware so the client always gets `{ error: "human-readable message" }`; the client shows those messages inline (login, share dialog, import, title rename). Unexpected errors are logged and returned as a generic 500 without leaking internals.

## Deliberate simplifications

| Choice | Why it's fine here | What I'd do next |
|---|---|---|
| Seeded users, email+password, opaque session token in an httpOnly cookie | Shows a real auth boundary without building sign-up/reset flows | OAuth/SSO, session expiry and rotation, CSRF token (currently relies on `SameSite=Lax` + JSON-only API) |
| SQLite via libSQL; Turso in production | Free hosting with real persistence: Render's free plan has no disk, but Turso's free plan is a hosted SQLite. No dialect change between dev and prod. | Postgres if the data model grows relational features SQLite lacks |
| Conflict = reject + reload | Prevents data loss; simple to reason about | Real-time collaboration (Yjs + Tiptap Collaboration) |
| Share by email with existing users only | Demonstrates the owner/grantee model clearly | Invitations for unknown emails, link sharing, groups |
| `tsx` runs the TypeScript server in production | One less build step; startup cost is negligible | Precompile with `tsc` / esbuild |
| No rate limiting | Demo scope | Rate limit login and upload |

## Hosting decisions

- **Render free + Turso free** gives a public URL and durable data at no cost. The trade-off is Render's cold start (up to about a minute after 15 idle minutes).
- **Fail fast on missing storage.** In production the server refuses to start without a Turso URL or an explicit `DATABASE_PATH`. Otherwise a misconfigured deploy would "work" while writing to a temporary disk that is wiped on the next restart.
- **No reliance on `ON DELETE CASCADE`.** Turso's HTTP protocol doesn't guarantee a per-connection `PRAGMA foreign_keys = ON`, so deleting a document removes its shares explicitly in the same batch.
- **Seeded demo content** on an empty database, so a reviewer immediately sees owned vs shared documents and both access levels.

## Enhancements: design choices

**Roles as a ladder (viewer < commenter < editor < owner).** One `access(db, docId, userId, action)` check in `server/permissions.ts` maps each action (`read`, `comment`, `edit`, `manage`) to the minimum role it needs. Adding the commenter role was one entry in that table rather than new checks spread across routes. The client mirrors the table only to decide what to show; the server decides what's allowed.

**Schema migrations.** The commenter role meant changing a `CHECK` constraint on a live Turso database that already held data. SQLite can't alter constraints, so migration 2 rebuilds the table. Migrations are numbered, recorded in `schema_migrations`, and each runs as one transactional batch, so a failed upgrade leaves the old schema intact. A test builds a database with the *original* schema and data, migrates it twice, and checks nothing was lost.

**Presence by polling, not WebSockets.** Each open editor sends a heartbeat every 5 s (`POST /presence`), and the response says who is there, the latest version, the last editor, and the open-comment count. Polling was chosen because it is stateless and survives Render's free plan putting the server to sleep, network drops and redeploys, and it needs no reconnect logic. A 5 s delay is fine for "who's here" indicators. Presence is held in memory, which is correct for one instance. With several instances it would move to Redis or a Turso table, and the `PresenceTracker` interface wouldn't change.

**Live updates without real-time co-editing.** The heartbeat tells the client when someone else has saved. If you have nothing unsaved, the newer version is loaded into your editor automatically, without an undo step and keeping your cursor. If you *do* have unsaved edits, nothing is overwritten: the version check still catches a true simultaneous edit. This makes conflicts rare without the complexity of a CRDT (e.g. Yjs), which is the next step if simultaneous typing matters.

**Comments anchored by quoted text, not positions.** Document positions shift with every edit, and commenters can't edit the document to insert anchors. A comment stores the text it was made on, and a ProseMirror decoration plugin highlights where that text occurs (searching within one paragraph). The highlight follows the text as the document changes. If the text is edited away, the highlight disappears but the comment and its quote remain. The trade-off: a repeated phrase highlights its first occurrence.

**History without noise.** Autosave writes every second or so while typing, so one snapshot per save would make history useless. Consecutive saves by the same author within 5 minutes update the latest entry instead. Milestones (created, imported, restored) are never merged into. Restoring creates a new version through the same conflict-checked write path as normal edits, so it can't overwrite a concurrent change and can itself be undone.

**Export.** Markdown is generated on the server (Turndown with rules for strikethrough, underline and list formatting), so it's testable and consistent. PDF uses the browser's print engine with a print stylesheet. That gives selectable text and correct fonts without running a headless browser on a free-tier server. The trade-off is one extra click ("Save as PDF").

## Testing strategy

The highest-value automated tests are API integration tests (Supertest against the real Express app and an in-memory SQLite). They exercise the real SQL (through the same libSQL client used in production), validation, sanitization and permission logic with no mocks, and run in about 2 s. The browser flows (formatting, autosave, reload, import, sharing between two users, conflict banner, mobile layout) were checked with a Playwright script during development; see AI_WORKFLOW.md.
