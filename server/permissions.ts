import { type DB, get } from "./db.js";
import { HttpError } from "./http.js";

/**
 * Roles form a ladder: each one can do everything the one below it can.
 *   viewer    → read, export, see history and comments
 *   commenter → + add / resolve comments
 *   editor    → + edit content and title, restore versions
 *   owner     → + delete the document, manage sharing
 */
export const SHARE_ROLES = ["viewer", "commenter", "editor"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];
export type Role = ShareRole | "owner";
export type Action = "read" | "comment" | "edit" | "manage";

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const REQUIRED: Record<Action, Role> = { read: "viewer", comment: "commenter", edit: "editor", manage: "owner" };

export function can(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[REQUIRED[action]];
}

function deniedMessage(role: Role, action: Action): string {
  if (action === "edit") {
    return role === "commenter"
      ? "You can comment on this document but not edit it."
      : "You have view-only access to this document.";
  }
  if (action === "comment") return "You have view-only access, so you can't comment.";
  return "Only the owner can do that.";
}

export interface DocRow {
  id: number;
  owner_id: number;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the caller's role on a document and check it allows `action`.
 * No access at all → 404 (don't reveal that the document exists); insufficient role → 403.
 */
export async function access(
  db: DB,
  docId: number,
  userId: number,
  action: Action = "read",
  message?: string,
): Promise<{ doc: DocRow; role: Role }> {
  const doc = await get<DocRow>(db, "SELECT * FROM documents WHERE id = ?", [docId]);
  if (!doc) throw new HttpError(404, "Document not found.");
  let role: Role;
  if (doc.owner_id === userId) {
    role = "owner";
  } else {
    const share = await get<{ role: ShareRole }>(
      db, "SELECT role FROM document_shares WHERE document_id = ? AND user_id = ?", [docId, userId],
    );
    if (!share) throw new HttpError(404, "Document not found.");
    role = share.role;
  }
  if (!can(role, action)) throw new HttpError(403, message ?? deniedMessage(role, action));
  return { doc, role };
}
