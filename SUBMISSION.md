# Submission: Inkwell

A small collaborative document editor: rich-text editing, file import, sharing with roles, persistence, comments, presence, version history and export.

| | |
|---|---|
| **Live product** | https://inkwell-8o3b.onrender.com |
| **Walkthrough video** | https://www.loom.com/share/da198bc45d3c4b2bafa70a7f33ccdd90 (also in [`VIDEO_URL.txt`](VIDEO_URL.txt)) |
| **Source repository** | https://github.com/AndrewRandolph2205/inkwell |
| **Demo accounts** | `alice@example.com`, `bob@example.com`, `carol@example.com`; password `password123` (or use the one-click buttons on the login page) |

The live app runs on Render's free plan, so the first visit after about 15 idle minutes can take up to a minute to load. Data is stored in Turso and is not affected.

## Required items

| Requirement | Where it is |
|---|---|
| The source code | `server/` (API), `client/` (web app), plus `package.json`, `package-lock.json`, config files, `Dockerfile` and `render.yaml`. See the full list below. |
| `README.md` with local setup and run instructions | [`README.md`](README.md): *Run locally*, *Tests*, *Deploy* |
| Short architecture note | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| AI workflow note | [`AI_WORKFLOW.md`](AI_WORKFLOW.md) |
| `SUBMISSION.md` listing what is included | This file |
| Live product URL | https://inkwell-8o3b.onrender.com (also at the top of `README.md` and in `VIDEO_URL.txt`) |
| Text file with the walkthrough video URL | [`VIDEO_URL.txt`](VIDEO_URL.txt) |
| Screenshots / demo GIF | [`docs/screenshots/`](docs/screenshots/) (7 screenshots) and [`docs/demo.gif`](docs/demo.gif). Sharing needs one browser session per user (e.g. a normal and a private window); the GIF shows two users side by side. |

## Testing it in 3 minutes

1. Open the live URL and click **Alice**. *My documents* and *Shared with me* are listed separately.
2. Open **Welcome to Inkwell**. It's shared with Bob (can edit) and Carol (view only on the live site; the role can be changed in **Share**).
3. Make a document: **+ New document**, rename it, format it, refresh. Or use **Import file** with a `.txt`, `.md` or `.docx` file.
4. In a private window, sign in as **Bob** and open a document Alice shared with him. Alice sees Bob's avatar, and his edits appear in her editor within a few seconds.
5. Try **Comments** (select text first), **History** (preview and restore), and **Export** (Markdown or PDF).

## Running it locally

```bash
npm install
npm run dev
```

Opens on http://localhost:5173 with a local SQLite file and demo data. `npm test` runs the 29 API tests. Details are in `README.md`.

## Not included

- `node_modules/`, `dist/` and `data/`: created by `npm install`, `npm run build` and the first run.
- Secrets: none are needed locally. The production database credentials are set as environment variables in Render, not stored in the code.

## Full file list

Everything in the folder, as tracked in git:

```text
.dockerignore
.gitignore
AI_WORKFLOW.md  # AI workflow note
ARCHITECTURE.md  # architecture note
Dockerfile  # production container image
README.md  # setup, run, test and deploy instructions; features; screenshots
SUBMISSION.md  # this file
VIDEO_URL.txt  # walkthrough video URL (and live URL)
client/index.html
client/src/App.tsx
client/src/CommentsPanel.tsx
client/src/DocList.tsx
client/src/Editor.tsx
client/src/HistoryPanel.tsx
client/src/Login.tsx
client/src/Presence.tsx
client/src/ShareDialog.tsx
client/src/Toolbar.tsx
client/src/api.ts
client/src/commentHighlights.ts
client/src/main.tsx
client/src/router.ts
client/src/styles.css
client/src/vite-env.d.ts
docs/demo.gif  # 14-second demo: two users editing one document
docs/screenshots/01-login.png
docs/screenshots/02-home.png
docs/screenshots/03-editor-presence.png
docs/screenshots/04-sharing-roles.png
docs/screenshots/05-commenter-comments.png
docs/screenshots/06-history-restore.png
docs/screenshots/07-phone.png
package-lock.json  # exact dependency versions
package.json  # scripts and dependencies
render.yaml  # Render deployment blueprint
server/app.test.ts
server/app.ts
server/auth.ts
server/content.ts
server/db.ts
server/documents.ts
server/exporters.ts
server/features.test.ts
server/fixtures/sample.docx  # Word file used by the import test (also handy for trying Import)
server/http.ts
server/index.ts
server/passwords.ts
server/permissions.ts
server/presence.ts
server/seed.ts
tsconfig.json
vite.config.ts
vitest.config.ts
```

53 files.
