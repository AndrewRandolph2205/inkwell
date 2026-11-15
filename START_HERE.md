# Inkwell: start here

Everything a reviewer needs, on one page.

| | |
|---|---|
| **Google Drive (all materials)** | https://drive.google.com/drive/folders/1NyEaMd7k0CO3qaYAr34wgFmNk9Qdb-EO?usp=share_link |
| **Live product** | https://inkwell-8o3b.onrender.com |
| **Walkthrough video** | https://www.loom.com/share/da198bc45d3c4b2bafa70a7f33ccdd90 |
| **Source code** | https://github.com/AndrewRandolph2205/inkwell |
| **Test accounts** | `alice@example.com`, `bob@example.com`, `carol@example.com` · password `password123` |

---

## 1. All materials

The Google Drive link above contains everything:

| File | What it is |
|---|---|
| `START_HERE.md` | This page |
| `README.md` | Features, setup, tests, deployment, screenshots |
| `ARCHITECTURE.md` | Architecture note: what I prioritized and why |
| `AI_WORKFLOW.md` | AI workflow note: tools, where AI helped, what I changed, how I verified it |
| `SUBMISSION.md` | Exactly what's included, with the full file list |
| `VIDEO_URL.txt` | Walkthrough video link |
| `docs/screenshots/`, `docs/demo.gif` | 7 screenshots and a 14-second demo of two users editing one document |
| `server/`, `client/` and config files | Source code |

## 2. Live deployment

**https://inkwell-8o3b.onrender.com**: nothing to install. Click a demo account on the login page to sign in.

- It runs on Render's free plan. **The first visit after about 15 idle minutes can take up to a minute to load.** After that it's fast.
- Data is stored in a hosted database (Turso), so documents survive refreshes, restarts and redeploys.

## 3. Test accounts and reviewing sharing

All three accounts use the password **`password123`**. The login page also has one-click buttons for each.

| User | Email | Password |
|---|---|---|
| Alice Chen | `alice@example.com` | `password123` |
| Bob Okafor | `bob@example.com` | `password123` |
| Carol Díaz | `carol@example.com` | `password123` |

These documents are already set up:

| Document | Owner | Shared with |
|---|---|---|
| Welcome to Inkwell | Alice | Bob (Can edit), Carol (View only) |
| Team meeting notes | Bob | Alice (View only) |
| Carol's private draft | Carol | No one |

Reviewers share these accounts, so you may see documents other people created. Please leave the three documents above in place for the next reviewer.

### What each role can do

| Role | Read & export | Comment | Edit & restore versions | Share & delete |
|---|:-:|:-:|:-:|:-:|
| View only | ✓ | | | |
| Can comment | ✓ | ✓ | | |
| Can edit | ✓ | ✓ | ✓ | |
| Owner | ✓ | ✓ | ✓ | ✓ |

The server enforces every rule, not just the UI.

### Walkthrough (about 5 minutes)

**Each user needs their own browser session.** Use a normal window for Alice, a private/incognito window for Bob, and a different browser (or browser profile) for Carol. Two tabs in the same window share one login.

1. **Alice (window 1):** sign in. The home page separates *My documents* from *Shared with me*.
2. **Alice:** click **+ New document**, give it a title and type a few lines. Click **Share** and add `bob@example.com` as **Can edit** and `carol@example.com` as **Can comment**.
3. **Bob (window 2):** sign in. The document is under *Shared with me*, marked "Can edit". Open it and type. In Alice's window, Bob's avatar appears with "Bob is editing", and his text shows up within about 5 seconds, without reloading.
4. **Carol (window 3):** sign in and open the document. She has no toolbar and can't type. Select some text, open **Comments** and add a comment; the text is highlighted. In Alice's window the Comments count updates; click the highlight, then **Resolve**.
5. **Change access:** as Alice, open **Share** and set Bob to **View only**. When Bob reloads, his editor is read-only. Then **Remove** Carol: within a few seconds her window says she no longer has access.
6. **No access at all:** as Bob, open *Carol's private draft* by its address (sign in as Carol to copy it). Bob gets "Document not found". The app doesn't reveal that the document exists.
7. **Also try:** **History** (preview and restore an earlier version), **Export** (Markdown, or PDF through the print dialog), and **Import file** on the home page (`.txt`, `.md` or `.docx`; `server/fixtures/sample.docx` works).

## 4. Run it locally

**You need:** Node.js 20.6 or newer (22 recommended) and npm. Nothing else: no database to install, no accounts, no environment variables. A local SQLite file is created on first start, with the same demo accounts and documents as above.

```bash
git clone https://github.com/AndrewRandolph2205/inkwell.git
```

```bash
cd inkwell
```

```bash
npm install
```

```bash
npm run dev
```

Open **http://localhost:5173** and sign in with a demo account. To use the copy from Google Drive instead of cloning, download the folder, open a terminal in it, and start from `npm install`.

| To… | Run |
|---|---|
| Run the automated tests (29) | `npm test` |
| Type-check | `npm run typecheck` |
| Run a production build on http://localhost:3000 | `npm run build`, then `npm start` |
| Start over with fresh demo data | Stop the server, delete `data/docs.db`, start again |

**If something goes wrong:**
- `npm run dev` needs ports **3000** (API) and **5173** (web page) to be free.
- `npm start` can use another port: `PORT=3001 npm start`.
- An error mentioning the Node version or `--import` means Node is older than 20.6. Upgrade Node.

## 5. More detail

- [`README.md`](README.md): full feature list, screenshots and deployment guide (Render + Turso)
- [`ARCHITECTURE.md`](ARCHITECTURE.md): design decisions and trade-offs
- [`AI_WORKFLOW.md`](AI_WORKFLOW.md): how AI was used and checked
- [`SUBMISSION.md`](SUBMISSION.md): every file in the submission
