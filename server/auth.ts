import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { type DB, get, run } from "./db.js";

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

export async function createSession(db: DB, userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await run(db, "INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, userId]);
  return token;
}

export function loadUser(db: DB) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === "string") {
      const row = await get<User>(
        db,
        "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        [token],
      );
      if (row) req.user = row;
    }
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}
