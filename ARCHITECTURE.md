# Architecture note

## Shape

One Node process. Express serves a JSON API under `/api` and the built React app for every other path. SQLite is the store. That's one thing to run locally, one container to deploy, and no separate database service to provision, which is right for this scope.

```
Browser (React + Tiptap) ──fetch /api──▶ Express ──▶ node:sqlite (users, sessions, documents, document_shares)
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
| SQLite via built-in `node:sqlite` | No native build, zero ops, transactional, easy to inspect | Postgres once there are multiple app instances |
| Conflict = reject + reload | Prevents data loss; simple to reason about | Real-time collaboration (Yjs + Tiptap Collaboration) |
| Share by email with existing users only | Demonstrates the owner/grantee model clearly | Invitations for unknown emails, link sharing, groups |
| `tsx` runs the TypeScript server in production | One less build step; startup cost is negligible | Precompile with `tsc` / esbuild |
| No rate limiting | Demo scope | Rate limit login and upload |

## Testing strategy

The highest-value automated tests are API integration tests (Supertest against the real Express app and an in-memory SQLite). They exercise the real SQL, validation, sanitization and permission logic with no mocks, and run in about 2 s. The browser flows (formatting, autosave, reload, import, sharing between two users, conflict banner, mobile layout) were checked with a Playwright script during development; see AI_WORKFLOW.md.
