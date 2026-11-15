# Inkwell

A small full-stack document editor: create and format documents in the browser, import `.txt` / `.md` / `.docx` files, and share documents with other users as **viewers** or **editors**.

**Stack:** React 18 + Tiptap (ProseMirror) · Node 22 + Express 5 · SQLite (built-in `node:sqlite`) · Vitest + Supertest

## Features

| Requirement | What's implemented |
|---|---|
| Documents | Create, rename (click the title), edit, delete (owner only). Autosave ~0.8 s after typing stops; **Ctrl/Cmd+S** saves immediately. A status shows *Unsaved changes / Saving… / ✓ Saved / Save failed (Retry)*. The browser warns before closing a tab with unsaved changes. |
| Rich text | Bold, italic, underline, strikethrough, Heading 1–3, bulleted & numbered lists, block quotes, undo/redo, plus standard keyboard shortcuts. |
| File upload | **Import file** turns an uploaded file into a new editable document. **Supported: `.txt`, `.md`, `.docx`, max 2 MB.** Other types are rejected with a clear message (checked in the browser *and* on the server). The document title comes from the file name; Word/Markdown headings, bold/italic and lists are kept. Images and tables in `.docx` are dropped (the editor doesn't support them). |
| Sharing | Every document has one **owner**. The owner can share by email as *View only* or *Can edit*, change the access level, or remove access. The home page separates **My documents** from **Shared with me** (with owner name and access badge). Viewers get a read-only editor with no toolbar; the server enforces every rule, not just the UI. |
| Persistence | SQLite file (`data/docs.db` by default). Content is stored as sanitized HTML, so formatting round-trips exactly. Documents, shares and login sessions survive refreshes and server restarts. |
| Concurrent edits | Each document has a version number. A save based on an outdated version is rejected (`409`) and the editor shows a "someone else saved this — reload" banner instead of silently overwriting the other person's work. |

## Demo accounts

Auth is a lightweight email + password login with seeded users (all use password **`password123`**). The login page has one-click buttons for each.

| User | Email |
|---|---|
| Alice Chen | alice@example.com |
| Bob Okafor | bob@example.com |
| Carol Díaz | carol@example.com |

**To try sharing:** sign in as Alice in one window and Bob in a private/incognito window (sessions are per-browser cookies). Alice creates a doc → **Share** → `bob@example.com`. Bob's home page now lists it under *Shared with me*.

## Run locally

Requires **Node.js 22.13+** (for the built-in `node:sqlite` module; no native build step).

```bash
npm install
npm run dev        # API on :3000 + Vite dev server on http://localhost:5173 (proxies /api)
```

Production-style run (one process serves the API and the built client):

```bash
npm run build
npm start          # http://localhost:3000
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/docs.db` | SQLite file (created on first start, with demo users seeded) |

To reset all data, stop the server and delete `data/docs.db`.

## Tests

```bash
npm test           # API integration tests (Vitest + Supertest, in-memory SQLite)
npm run typecheck  # tsc over server and client
```

The tests drive the real Express app over HTTP and cover: auth required / bad credentials; create → rename → edit → reopen with formatting preserved; HTML sanitization (scripts and event handlers stripped); stale-write rejection (409); input validation; **the full owner / editor / viewer permission matrix** (including that non-shared users get 404 and that revoking access works); sharing edge cases; and importing `.md`, `.txt` and a real `.docx` fixture, plus rejection of unsupported, missing, corrupt and oversized files.

## Deploy

The app is a single Docker container with one persistent volume for the SQLite file.

**Render (Blueprint):** push this repo to GitHub, then in Render choose *New → Blueprint* and select the repo. `render.yaml` builds the `Dockerfile`, mounts a 1 GB disk at `/data`, and health-checks `/api/health`. Persistent disks need a paid instance (*Starter*). On the free plan, remove the `disk` block and change `plan` to `free`: the app still works, but data resets whenever the instance restarts or redeploys.

**Any Docker host (Fly.io, Railway, a VM):**

```bash
docker build -t inkwell .
docker run -p 3000:3000 -v inkwell-data:/data inkwell
```

Mount a volume at `/data` so documents survive redeploys.

## Project layout

```
server/
  app.ts         Express app: routes, validation (zod), access control, error handling
  auth.ts        scrypt password hashing, cookie sessions
  content.ts     HTML sanitization + .txt/.md/.docx → HTML conversion
  db.ts          schema + demo-user seeding
  index.ts       entry point
  app.test.ts    API integration tests
  fixtures/      sample.docx used by the tests
client/src/
  Editor.tsx     Tiptap editor, toolbar, autosave pipeline, conflict handling
  DocList.tsx    home page: owned vs shared, create, import
  ShareDialog.tsx
  api.ts         typed fetch wrapper
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and [AI_WORKFLOW.md](AI_WORKFLOW.md) for how AI was used.
