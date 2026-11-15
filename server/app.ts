import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DB, all, get, run } from "./db.js";
import { SESSION_COOKIE, createSession, loadUser, requireUser } from "./auth.js";
import { verifyPassword } from "./passwords.js";
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

// Express 5 forwards rejected promises from async handlers to the error middleware.
export function createApp(db: DB, opts: { staticDir?: string; secureCookies?: boolean } = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(loadUser(db));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  /** Resolve the caller's role on a document, or throw 404 (we don't reveal existence to outsiders). */
  async function access(docId: number, userId: number): Promise<{ doc: DocRow; role: Role }> {
    const doc = await get<DocRow>(db, "SELECT * FROM documents WHERE id = ?", [docId]);
    if (!doc) throw new HttpError(404, "Document not found.");
    if (doc.owner_id === userId) return { doc, role: "owner" };
    const share = await get<{ role: Role }>(
      db, "SELECT role FROM document_shares WHERE document_id = ? AND user_id = ?", [docId, userId],
    );
    if (!share) throw new HttpError(404, "Document not found.");
    return { doc, role: share.role };
  }

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

  async function insertDoc(ownerId: number, title: string, content: string) {
    const r = await run(db, "INSERT INTO documents (owner_id, title, content) VALUES (?, ?, ?)", [ownerId, title, content]);
    return r.lastInsertRowid;
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
    const uid = req.user!.id;
    const [owned, shared] = await Promise.all([
      all(
        db,
        `SELECT d.id, d.title, d.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM document_shares s WHERE s.document_id = d.id) AS shareCount
         FROM documents d WHERE d.owner_id = ? ORDER BY d.updated_at DESC, d.id DESC`,
        [uid],
      ),
      all(
        db,
        `SELECT d.id, d.title, d.updated_at AS updatedAt, s.role, u.name AS ownerName, u.email AS ownerEmail
         FROM document_shares s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.owner_id
         WHERE s.user_id = ? ORDER BY d.updated_at DESC, d.id DESC`,
        [uid],
      ),
    ]);
    res.json({ owned, shared });
  });

  app.post("/api/documents", async (req, res) => {
    const { title } = parse(createSchema, req.body ?? {});
    const id = await insertDoc(req.user!.id, title ?? "Untitled document", "");
    const { doc, role } = await access(id, req.user!.id);
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
      const id = await insertDoc(req.user!.id, parsed.title, parsed.content);
      const { doc, role } = await access(id, req.user!.id);
      res.status(201).json(await serializeDoc(doc, role));
    },
  );

  app.get("/api/documents/:id", async (req, res) => {
    const { doc, role } = await access(parse(idSchema, req.params.id), req.user!.id);
    res.json(await serializeDoc(doc, role));
  });

  app.patch("/api/documents/:id", async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(updateSchema, req.body);
    const { doc, role } = await access(id, req.user!.id);
    if (role === "viewer") throw new HttpError(403, "You have view-only access to this document.");
    // Optimistic concurrency: reject writes based on a stale copy instead of silently overwriting.
    if (body.baseVersion !== doc.version) {
      throw new HttpError(409, CONFLICT_MESSAGE, { currentVersion: doc.version });
    }
    const title = body.title ?? doc.title;
    const content = body.content !== undefined ? sanitizeContent(body.content) : doc.content;
    // The version check is repeated in the UPDATE itself, so two racing writers can't both win.
    const r = await run(
      db,
      `UPDATE documents SET title = ?, content = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ?`,
      [title, content, id, doc.version],
    );
    if (r.changes === 0) throw new HttpError(409, CONFLICT_MESSAGE);
    const updated = await access(id, req.user!.id);
    res.json(await serializeDoc(updated.doc, updated.role));
  });

  app.delete("/api/documents/:id", async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { role } = await access(id, req.user!.id);
    if (role !== "owner") throw new HttpError(403, "Only the owner can delete this document.");
    await db.batch(
      [
        { sql: "DELETE FROM document_shares WHERE document_id = ?", args: [id] },
        { sql: "DELETE FROM documents WHERE id = ?", args: [id] },
      ],
      "write",
    );
    res.status(204).end();
  });

  // ---------- sharing (owner only) ----------
  async function requireOwner(req: Request) {
    const id = parse(idSchema, req.params.id);
    const { doc, role } = await access(id, req.user!.id);
    if (role !== "owner") throw new HttpError(403, "Only the owner can manage sharing.");
    return doc;
  }

  app.get("/api/documents/:id/shares", async (req, res) => {
    const doc = await requireOwner(req);
    res.json(await listShares(doc.id));
  });

  app.post("/api/documents/:id/shares", async (req, res) => {
    const doc = await requireOwner(req);
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
    const doc = await requireOwner(req);
    const userId = parse(idSchema, req.params.userId);
    await run(db, "DELETE FROM document_shares WHERE document_id = ? AND user_id = ?", [doc.id, userId]);
    res.json(await listShares(doc.id));
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
