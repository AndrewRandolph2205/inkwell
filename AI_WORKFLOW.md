# AI-native workflow note

> Draft written from the build session's log. Edit it to add your own perspective before submitting.

## Tools used

- **Claude Code** (agentic coding in a cloud sandbox). Used for scaffolding, implementation, tests, browser verification and docs.
- **Playwright** (driven by the agent) to click through the real app in headless Chromium and take screenshots.

## Where AI materially sped things up

- **Scaffolding and wiring.** Express + Vite + Tiptap + SQLite + Vitest set up and working in minutes rather than an hour or more.
- **Breadth of edge cases in tests.** The permission-matrix test and the bad-upload cases (unsupported type, missing file, corrupt `.docx`, oversized file) were cheap to write, so they got written.
- **Format conversion.** Choosing and integrating `mammoth` (docx → HTML) and `marked`, then generating a real `.docx` fixture with python-docx so the Word path is tested against a real file rather than a mock.
- **End-to-end verification.** A scripted two-user browser session (Alice and Bob in separate contexts) exercised sharing and conflicts in a way that would be slow to repeat by hand.

## What was changed or rejected

- **A real bug found by the end-to-end run, not the unit tests.** The first editor version called Tiptap's `editor.setEditable(true)` after loading a document. That method emits an `update` event by default, so *simply opening* a document as an editor triggered a no-op save and bumped the version. A collaborator who opened the document a moment earlier would then get a false "someone else saved" conflict. The API tests passed, because the server was behaving correctly. The two-browser Playwright run caught it. Fix: `setEditable(…, false)`, plus a guard that skips saves when the HTML hasn't changed.
- **Framework version assumptions.** The generated server assumed Express 4 (`app.get("*")` catch-all, and a wrapper to forward async errors). `npm install` pulled Express 5, which rejects that path syntax at startup. The `*` route was rewritten to `/{*path}` and the async wrapper was removed, since Express 5 forwards promise rejections itself.
- **An over-broad automated refactor.** Removing that wrapper with a find/replace also stripped closing parentheses from unrelated lines. `tsc` caught it immediately and the four lines were fixed by hand. This is a reminder to typecheck after every mechanical edit.
- **Test config.** Vitest inherited Vite's `root: "client"` and found no tests. A separate `vitest.config.ts` fixed it.
- **A brittle test.** One draft test guessed a user ID from seed order; it was rewritten to look the ID up from the API response.
- **Switching to Turso for free hosting.** Moving the storage layer to the async libSQL client was mostly mechanical, but review caught three things:
  - The new production safety check (refuse to start without persistent storage) also broke local `npm start`, which runs in production mode. `npm start` now sets a local `DATABASE_PATH` explicitly.
  - A draft test for "deleting a document removes its shares" checked the API's *Shared with me* list. That list joins on `documents`, so it would pass even if orphaned share rows were left behind. The test now queries the shares table directly.
  - The code no longer relies on SQLite foreign-key cascades. Turso's HTTP protocol doesn't guarantee the per-connection pragma that enables them.
- **Scope decisions.** Real-time co-editing (Yjs), a router library and a UI component library were left out. Each would add weight without improving what's being evaluated here.

## How correctness, UX and reliability were verified

1. **Typecheck** (`tsc`, strict) across server and client after each change.
2. **11 API integration tests** against the real app and SQLite: permissions, sanitization, validation, conflicts, imports.
3. **Scripted browser walkthrough** (Playwright, two users): log in → create → rename → apply each kind of formatting → wait for "Saved" → **reload and check every tag survived** → share with an unknown email (error shown) and with Bob as a viewer → import `.docx` and an unsupported `.pdf` (rejected) → Bob sees *Shared with me / View only* and gets a read-only editor with no toolbar → upgrade Bob to editor → Bob saves → Alice's stale edit shows the conflict banner.
4. **Screenshots reviewed** at desktop and phone width (390 px) for layout, spacing and clarity of the status messages. This prompted tightening list spacing.
5. **Not verified in the sandbox:** a live connection to a real Turso database, because there were no Turso credentials and the libSQL server binary couldn't be downloaded. The tests and the browser run use the same client library in local-file mode. The first real Turso connection happens on deploy. Signing in confirms it, because `/api/health` doesn't touch the database.
6. **Restart test:** created a document over the API, restarted the server, confirmed the document and the login session were still there, and that deep links (`/d/1`) load after a refresh.
