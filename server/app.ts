import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.js";
import {
  SESSION_COOKIE, createSession, loadUser, requireUser, verifyPassword,
} from "./auth.js";
import {
  ImportError, MAX_UPLOAD_BYTES, SUPPORTED_IMPORT_TYPES, fileToDocument, sanitizeContent,
} from "./content.js";

type Role = "owner" | "editor" | "viewer";

interface DocRow {
  id: number;
  owner_id: number;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

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
const shareSchema = z.object({
  email: z.string().trim().email("Enter a valid email."),
  role: z.enum(["viewer", "editor"]),
});
const idSchema = z.coerce.number().int().positive();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Invalid request.");
  return r.data;
}

export function createApp(db: DB, opts: { staticDir?: string; secureCookies?: boolean } = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(loadUser(db));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  /** Resolve the caller's role on a document, or throw 404 (we don't reveal existence to outsiders). */
  function access(docId: number, userId: number): { doc: DocRow; role: Role } {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as DocRow | undefined;
    if (!doc) throw new HttpError(404, "Document not found.");
    if (doc.owner_id === userId) return { doc, role: "owner" };
    const share = db
      .prepare("SELECT role FROM document_shares WHERE document_id = ? AND user_id = ?")
      .get(docId, userId) as { role: Role } | undefined;
    if (!share) throw new HttpError(404, "Document not found.");
    return { doc, role: share.role };
  }

  function listShares(docId: number) {
    return db
      .prepare(
        `SELECT u.id AS userId, u.email, u.name, s.role FROM document_shares s
         JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.name`,
      )
      .all(docId);
  }

  function serializeDoc(doc: DocRow, role: Role) {
    const owner = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(doc.owner_id);
    return {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      version: doc.version,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      owner,
      role,
      shares: role === "owner" ? listShares(doc.id) : undefined,
    };
  }

  function insertDoc(ownerId: number, title: string, content: string) {
    const r = db
      .prepare("INSERT INTO documents (owner_id, title, content) VALUES (?, ?, ?)")
      .run(ownerId, title, content);
    return Number(r.lastInsertRowid);
  }

  // ---------- auth ----------
  app.post("/api/auth/login", (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | { id: number; email: string; name: string; password_hash: string }
      | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new HttpError(401, "Incorrect email or password.");
    }
    const token = createSession(db, row.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "lax", secure: !!opts.secureCookies, maxAge: 1000 * 60 * 60 * 24 * 7,
    });
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: req.user }));

  // ---------- documents ----------
  app.use("/api/documents", requireUser);

  app.get("/api/documents", (req, res) => {
    const uid = req.user!.id;
    const owned = db
      .prepare(
        `SELECT d.id, d.title, d.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM document_shares s WHERE s.document_id = d.id) AS shareCount
         FROM documents d WHERE d.owner_id = ? ORDER BY d.updated_at DESC, d.id DESC`,
      )
      .all(uid);
    const shared = db
      .prepare(
        `SELECT d.id, d.title, d.updated_at AS updatedAt, s.role, u.name AS ownerName, u.email AS ownerEmail
         FROM document_shares s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.owner_id
         WHERE s.user_id = ? ORDER BY d.updated_at DESC, d.id DESC`,
      )
      .all(uid);
    res.json({ owned, shared });
  });

  app.post("/api/documents", (req, res) => {
    const { title } = parse(createSchema, req.body ?? {});
    const id = insertDoc(req.user!.id, title ?? "Untitled document", "");
    const { doc, role } = access(id, req.user!.id);
    res.status(201).json(serializeDoc(doc, role));
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
      const id = insertDoc(req.user!.id, parsed.title, parsed.content);
      const { doc, role } = access(id, req.user!.id);
      res.status(201).json(serializeDoc(doc, role));
    },
  );

  app.get("/api/documents/:id", (req, res) => {
    const { doc, role } = access(parse(idSchema, req.params.id), req.user!.id);
    res.json(serializeDoc(doc, role));
  });

  app.patch("/api/documents/:id", (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(updateSchema, req.body);
    const { doc, role } = access(id, req.user!.id);
    if (role === "viewer") throw new HttpError(403, "You have view-only access to this document.");
    // Optimistic concurrency: reject writes based on a stale copy instead of silently overwriting.
    if (body.baseVersion !== doc.version) {
      throw new HttpError(409, "This document was changed elsewhere. Reload to get the latest version.", {
        currentVersion: doc.version,
      });
    }
    const title = body.title ?? doc.title;
    const content = body.content !== undefined ? sanitizeContent(body.content) : doc.content;
    const r = db
      .prepare(
        `UPDATE documents SET title = ?, content = ?, version = version + 1, updated_at = datetime('now')
         WHERE id = ? AND version = ?`,
      )
      .run(title, content, id, doc.version);
    if (r.changes === 0) throw new HttpError(409, "This document was changed elsewhere. Reload to get the latest version.");
    const updated = access(id, req.user!.id);
    res.json(serializeDoc(updated.doc, updated.role));
  });

  app.delete("/api/documents/:id", (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { role } = access(id, req.user!.id);
    if (role !== "owner") throw new HttpError(403, "Only the owner can delete this document.");
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    res.status(204).end();
  });

  // ---------- sharing (owner only) ----------
  function requireOwner(req: Request) {
    const id = parse(idSchema, req.params.id);
    const { doc, role } = access(id, req.user!.id);
    if (role !== "owner") throw new HttpError(403, "Only the owner can manage sharing.");
    return doc;
  }

  app.get("/api/documents/:id/shares", (req, res) => {
    const doc = requireOwner(req);
    res.json(listShares(doc.id));
  });

  app.post("/api/documents/:id/shares", (req, res) => {
    const doc = requireOwner(req);
    const { email, role } = parse(shareSchema, req.body);
    const target = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
    if (!target) throw new HttpError(404, `No user with email ${email}.`);
    if (target.id === doc.owner_id) throw new HttpError(400, "You already own this document.");
    db.prepare(
      `INSERT INTO document_shares (document_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`,
    ).run(doc.id, target.id, role);
    res.status(201).json(listShares(doc.id));
  });

  app.delete("/api/documents/:id/shares/:userId", (req, res) => {
    const doc = requireOwner(req);
    const userId = parse(idSchema, req.params.userId);
    db.prepare("DELETE FROM document_shares WHERE document_id = ? AND user_id = ?").run(doc.id, userId);
    res.json(listShares(doc.id));
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
