import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DB, all, get, run } from "./db.js";
import { SESSION_COOKIE, createSession, loadUser, requireUser } from "./auth.js";
import { verifyPassword } from "./passwords.js";
import { HttpError, idSchema, parse } from "./http.js";
import { SHARE_ROLES, access, type DocRow, type Role } from "./permissions.js";
import {
  createDocument, deleteDocument, getVersion, lastEditor, listVersions, recordEdit, recordMilestone,
} from "./documents.js";
import { PresenceTracker } from "./presence.js";
import { exportFilename, toMarkdown } from "./exporters.js";
import {
  ImportError, MAX_UPLOAD_BYTES, SUPPORTED_IMPORT_TYPES, fileToDocument, sanitizeContent,
} from "./content.js";

const CONFLICT_MESSAGE = "This document was changed elsewhere. Reload to get the latest version.";

const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email."),
  password: z.string().min(1, "Password is required."),
});
const titleSchema = z.string().trim().min(1, "Title cannot be empty.").max(200, "Title is too long (max 200).");
const createSchema = z.object({ title: titleSchema.optional() });
const updateSchema = z
  .object({
    title: titleSchema.optional(),
    content: z.string().max(1_000_000, "Document is too large.").optional(),
    baseVersion: z.number().int().positive(),
  })
  .refine((v) => v.title !== undefined || v.content !== undefined, "Nothing to update.");
const restoreSchema = z.object({ baseVersion: z.number().int().positive() });
const shareSchema = z.object({
  email: z.string().trim().email("Enter a valid email."),
  role: z.enum(SHARE_ROLES, { message: "Role must be viewer, commenter or editor." }),
});
const commentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty.").max(2000, "Comment is too long (max 2000)."),
  quote: z.string().trim().max(500, "Selected text is too long to quote (max 500).").optional(),
});
const commentUpdateSchema = z.object({ resolved: z.boolean() });
const presenceSchema = z.object({ editing: z.boolean().default(false) });

interface CommentRow {
  id: number;
  body: string;
  quote: string | null;
  resolved: number;
  createdAt: string;
  authorId: number;
  authorName: string;
}

export function createApp(
  db: DB,
  opts: { staticDir?: string; secureCookies?: boolean; presence?: PresenceTracker } = {},
) {
  const app = express();
  const presence = opts.presence ?? new PresenceTracker();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(loadUser(db));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  const uid = (req: Request) => req.user!.id;
  const docIdOf = (req: Request) => parse(idSchema, req.params.id);

  function listShares(docId: number) {
    return all(
      db,
      `SELECT u.id AS userId, u.email, u.name, s.role FROM document_shares s
       JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.name`,
      [docId],
    );
  }

  async function serializeDoc(doc: DocRow, role: Role) {
    const owner = await get(db, "SELECT id, email, name FROM users WHERE id = ?", [doc.owner_id]);
    return {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      version: doc.version,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      owner,
      role,
      shares: role === "owner" ? await listShares(doc.id) : undefined,
    };
  }

  async function listComments(docId: number) {
    const rows = await all<CommentRow>(
      db,
      `SELECT c.id, c.body, c.quote, c.resolved, c.created_at AS createdAt, u.id AS authorId, u.name AS authorName
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.document_id = ? ORDER BY c.id`,
      [docId],
    );
    return rows.map((c) => ({
      id: c.id, body: c.body, quote: c.quote, resolved: !!c.resolved, createdAt: c.createdAt,
      author: { id: c.authorId, name: c.authorName },
    }));
  }

  /** Conflict-checked write of title/content; returns the new version number. */
  async function writeDoc(doc: DocRow, baseVersion: number, title: string, content: string) {
    if (baseVersion !== doc.version) throw new HttpError(409, CONFLICT_MESSAGE, { currentVersion: doc.version });
    // The version check is repeated in the UPDATE itself, so two racing writers can't both win.
    const r = await run(
      db,
      `UPDATE documents SET title = ?, content = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ?`,
      [title, content, doc.id, doc.version],
    );
    if (r.changes === 0) throw new HttpError(409, CONFLICT_MESSAGE);
    return doc.version + 1;
  }

  // ---------- auth ----------
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const row = await get<{ id: number; email: string; name: string; password_hash: string }>(
      db, "SELECT * FROM users WHERE email = ?", [email],
    );
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new HttpError(401, "Incorrect email or password.");
    }
    const token = await createSession(db, row.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "lax", secure: !!opts.secureCookies, maxAge: 1000 * 60 * 60 * 24 * 7,
    });
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await run(db, "DELETE FROM sessions WHERE token = ?", [token]);
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: req.user }));

  // ---------- documents ----------
  app.use("/api/documents", requireUser);

  app.get("/api/documents", async (req, res) => {
    const [owned, shared] = await Promise.all([
      all(
        db,
        `SELECT d.id, d.title, d.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM document_shares s WHERE s.document_id = d.id) AS shareCount
         FROM documents d WHERE d.owner_id = ? ORDER BY d.updated_at DESC, d.id DESC`,
        [uid(req)],
      ),
      all(
        db,
        `SELECT d.id, d.title, d.updated_at AS updatedAt, s.role, u.name AS ownerName, u.email AS ownerEmail
         FROM document_shares s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.owner_id
         WHERE s.user_id = ? ORDER BY d.updated_at DESC, d.id DESC`,
        [uid(req)],
      ),
    ]);
    res.json({ owned, shared });
  });

  app.post("/api/documents", async (req, res) => {
    const { title } = parse(createSchema, req.body ?? {});
    const id = await createDocument(db, uid(req), title ?? "Untitled document", "");
    const { doc, role } = await access(db, id, uid(req));
    res.status(201).json(await serializeDoc(doc, role));
  });

  app.post(
    "/api/documents/import",
    (req, res, next) =>
      upload.single("file")(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return next(new HttpError(413, `File is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`));
        }
        next(err);
      }),
    async (req, res) => {
      if (!req.file) throw new HttpError(400, "Choose a file to upload.");
      let parsed;
      try {
        parsed = await fileToDocument(req.file.originalname, req.file.buffer);
      } catch (e) {
        if (e instanceof ImportError) throw new HttpError(400, e.message);
        throw e;
      }
      const id = await createDocument(db, uid(req), parsed.title, parsed.content, `Imported from ${req.file.originalname}`);
      const { doc, role } = await access(db, id, uid(req));
      res.status(201).json(await serializeDoc(doc, role));
    },
  );

  app.get("/api/documents/:id", async (req, res) => {
    const { doc, role } = await access(db, docIdOf(req), uid(req));
    res.json(await serializeDoc(doc, role));
  });

  app.patch("/api/documents/:id", async (req, res) => {
    const id = docIdOf(req);
    const body = parse(updateSchema, req.body);
    const { doc } = await access(db, id, uid(req), "edit");
    const title = body.title ?? doc.title;
    const content = body.content !== undefined ? sanitizeContent(body.content) : doc.content;
    const version = await writeDoc(doc, body.baseVersion, title, content);
    await recordEdit(db, { docId: id, version, title, content, authorId: uid(req) });
    const updated = await access(db, id, uid(req));
    res.json(await serializeDoc(updated.doc, updated.role));
  });

  app.delete("/api/documents/:id", async (req, res) => {
    const id = docIdOf(req);
    await access(db, id, uid(req), "manage", "Only the owner can delete this document.");
    await deleteDocument(db, id);
    presence.forgetDocument(id);
    res.status(204).end();
  });

  // ---------- sharing (owner only) ----------
  app.get("/api/documents/:id/shares", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req), "manage", "Only the owner can manage sharing.");
    res.json(await listShares(doc.id));
  });

  app.post("/api/documents/:id/shares", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req), "manage", "Only the owner can manage sharing.");
    const { email, role } = parse(shareSchema, req.body);
    const target = await get<{ id: number }>(db, "SELECT id FROM users WHERE email = ?", [email]);
    if (!target) throw new HttpError(404, `No user with email ${email}.`);
    if (target.id === doc.owner_id) throw new HttpError(400, "You already own this document.");
    await run(
      db,
      `INSERT INTO document_shares (document_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`,
      [doc.id, target.id, role],
    );
    res.status(201).json(await listShares(doc.id));
  });

  app.delete("/api/documents/:id/shares/:userId", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req), "manage", "Only the owner can manage sharing.");
    const userId = parse(idSchema, req.params.userId);
    await run(db, "DELETE FROM document_shares WHERE document_id = ? AND user_id = ?", [doc.id, userId]);
    presence.leave(doc.id, userId);
    res.json(await listShares(doc.id));
  });

  // ---------- version history ----------
  app.get("/api/documents/:id/versions", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req));
    res.json(await listVersions(db, doc.id));
  });

  app.get("/api/documents/:id/versions/:versionId", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req));
    const v = await getVersion(db, doc.id, parse(idSchema, req.params.versionId));
    if (!v) throw new HttpError(404, "Version not found.");
    res.json(v);
  });

  app.post("/api/documents/:id/versions/:versionId/restore", async (req, res) => {
    const id = docIdOf(req);
    const { baseVersion } = parse(restoreSchema, req.body);
    const { doc } = await access(db, id, uid(req), "edit");
    const v = await getVersion(db, id, parse(idSchema, req.params.versionId));
    if (!v) throw new HttpError(404, "Version not found.");
    const version = await writeDoc(doc, baseVersion, v.title, v.content);
    // A restore is itself a history entry, so it can be undone by restoring the entry before it.
    await recordMilestone(db, {
      docId: id, version, title: v.title, content: v.content, authorId: uid(req), note: "Restored an earlier version",
    });
    const updated = await access(db, id, uid(req));
    res.json(await serializeDoc(updated.doc, updated.role));
  });

  // ---------- comments ----------
  app.get("/api/documents/:id/comments", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req));
    res.json(await listComments(doc.id));
  });

  app.post("/api/documents/:id/comments", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req), "comment");
    const { body, quote } = parse(commentSchema, req.body);
    await run(db, "INSERT INTO comments (document_id, author_id, body, quote) VALUES (?, ?, ?, ?)", [
      doc.id, uid(req), body, quote || null,
    ]);
    res.status(201).json(await listComments(doc.id));
  });

  async function findComment(docId: number, commentId: number) {
    const c = await get<{ id: number; author_id: number }>(
      db, "SELECT id, author_id FROM comments WHERE id = ? AND document_id = ?", [commentId, docId],
    );
    if (!c) throw new HttpError(404, "Comment not found.");
    return c;
  }

  app.patch("/api/documents/:id/comments/:commentId", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req), "comment");
    const c = await findComment(doc.id, parse(idSchema, req.params.commentId));
    const { resolved } = parse(commentUpdateSchema, req.body);
    await run(db, "UPDATE comments SET resolved = ? WHERE id = ?", [resolved ? 1 : 0, c.id]);
    res.json(await listComments(doc.id));
  });

  app.delete("/api/documents/:id/comments/:commentId", async (req, res) => {
    const { doc, role } = await access(db, docIdOf(req), uid(req));
    const c = await findComment(doc.id, parse(idSchema, req.params.commentId));
    if (c.author_id !== uid(req) && role !== "owner") {
      throw new HttpError(403, "Only the comment's author or the document owner can delete it.");
    }
    await run(db, "DELETE FROM comments WHERE id = ?", [c.id]);
    res.json(await listComments(doc.id));
  });

  // ---------- export ----------
  app.get("/api/documents/:id/export.md", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req));
    const name = exportFilename(doc.title, "md");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.send(toMarkdown(doc.title, doc.content));
  });

  // ---------- presence (who else has this document open) ----------
  app.post("/api/documents/:id/presence", async (req, res) => {
    const { doc } = await access(db, docIdOf(req), uid(req));
    const { editing } = parse(presenceSchema, req.body ?? {});
    presence.touch(doc.id, req.user!, editing);
    const [editor, open] = await Promise.all([
      lastEditor(db, doc.id),
      get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments WHERE document_id = ? AND resolved = 0", [doc.id]),
    ]);
    res.json({
      users: presence.list(doc.id),
      version: doc.version,
      updatedAt: doc.updated_at,
      lastEditor: editor,
      openComments: open?.n ?? 0,
    });
  });

  app.delete("/api/documents/:id/presence", async (req, res) => {
    const id = docIdOf(req);
    presence.leave(id, uid(req));
    res.status(204).end();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) =>
    res.json({ supportedImportTypes: SUPPORTED_IMPORT_TYPES, maxUploadBytes: MAX_UPLOAD_BYTES }),
  );

  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

  // ---------- SPA ----------
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    // SPA fallback: any non-API GET serves the app shell so deep links like /d/12 survive a refresh.
    app.get("/{*path}", (_req, res) => res.sendFile(join(opts.staticDir!, "index.html")));
  }

  // ---------- errors ----------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "Malformed JSON." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on our side." });
  });

  return app;
}
