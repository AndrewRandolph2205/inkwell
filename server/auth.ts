import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { DB } from "./db.js";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

export interface User {
  id: number;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const SESSION_COOKIE = "sid";

export function createSession(db: DB, userId: number): string {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}

export function loadUser(db: DB) {
  const stmt = db.prepare(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
  );
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === "string") {
      const row = stmt.get(token) as User | undefined;
      if (row) req.user = { id: row.id, email: row.email, name: row.name };
    }
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}
