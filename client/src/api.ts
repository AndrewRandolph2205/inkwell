export interface User { id: number; email: string; name: string }
export type ShareRole = "viewer" | "commenter" | "editor";
export type Role = ShareRole | "owner";
export interface Share { userId: number; email: string; name: string; role: ShareRole }
export interface Doc {
  id: number; title: string; content: string; version: number;
  createdAt: string; updatedAt: string; owner: User; role: Role; shares?: Share[];
}
export interface OwnedSummary { id: number; title: string; updatedAt: string; shareCount: number }
export interface SharedSummary {
  id: number; title: string; updatedAt: string; role: ShareRole; ownerName: string; ownerEmail: string;
}
export interface Comment {
  id: number; body: string; quote: string | null; resolved: boolean; createdAt: string;
  author: { id: number; name: string };
}
export interface VersionSummary {
  id: number; version: number; title: string; note: string | null;
  createdAt: string; updatedAt: string; authorId: number; authorName: string;
}
export interface VersionDetail extends VersionSummary { content: string }
export interface PresenceInfo {
  users: { id: number; name: string; editing: boolean }[];
  version: number; updatedAt: string; lastEditor: { id: number; name: string } | null; openComments: number;
}

/** What each role may do; mirrors server/permissions.ts (the server is the authority). */
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
export const can = {
  comment: (r: Role) => RANK[r] >= RANK.commenter,
  edit: (r: Role) => RANK[r] >= RANK.editor,
  manage: (r: Role) => r === "owner",
};
export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner", editor: "Can edit", commenter: "Can comment", viewer: "View only",
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers: isForm ? init.headers : { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status}).`, body);
  return body as T;
}

const json = (method: string, data?: unknown): RequestInit => ({ method, body: JSON.stringify(data ?? {}) });

export const api = {
  me: () => call<{ user: User }>("/auth/me"),
  login: (email: string, password: string) => call<{ user: User }>("/auth/login", json("POST", { email, password })),
  logout: () => call<void>("/auth/logout", { method: "POST" }),
  listDocs: () => call<{ owned: OwnedSummary[]; shared: SharedSummary[] }>("/documents"),
  createDoc: (title?: string) => call<Doc>("/documents", json("POST", title ? { title } : {})),
  getDoc: (id: number) => call<Doc>(`/documents/${id}`),
  updateDoc: (id: number, patch: { title?: string; content?: string; baseVersion: number }) =>
    call<Doc>(`/documents/${id}`, json("PATCH", patch)),
  deleteDoc: (id: number) => call<void>(`/documents/${id}`, { method: "DELETE" }),
  importFile: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<Doc>("/documents/import", { method: "POST", body: form });
  },
  share: (id: number, email: string, role: ShareRole) =>
    call<Share[]>(`/documents/${id}/shares`, json("POST", { email, role })),
  unshare: (id: number, userId: number) => call<Share[]>(`/documents/${id}/shares/${userId}`, { method: "DELETE" }),
  listComments: (id: number) => call<Comment[]>(`/documents/${id}/comments`),
  addComment: (id: number, body: string, quote?: string) =>
    call<Comment[]>(`/documents/${id}/comments`, json("POST", { body, quote: quote || undefined })),
  setResolved: (id: number, commentId: number, resolved: boolean) =>
    call<Comment[]>(`/documents/${id}/comments/${commentId}`, json("PATCH", { resolved })),
  deleteComment: (id: number, commentId: number) =>
    call<Comment[]>(`/documents/${id}/comments/${commentId}`, { method: "DELETE" }),
  listVersions: (id: number) => call<VersionSummary[]>(`/documents/${id}/versions`),
  getVersion: (id: number, versionId: number) => call<VersionDetail>(`/documents/${id}/versions/${versionId}`),
  restoreVersion: (id: number, versionId: number, baseVersion: number) =>
    call<Doc>(`/documents/${id}/versions/${versionId}/restore`, json("POST", { baseVersion })),
  heartbeat: (id: number, editing: boolean) => call<PresenceInfo>(`/documents/${id}/presence`, json("POST", { editing })),
  /** keepalive lets this complete even when the page is being closed. */
  leave: (id: number) =>
    fetch(`/api/documents/${id}/presence`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {}),
  exportMarkdownUrl: (id: number) => `/api/documents/${id}/export.md`,
};

export const SUPPORTED_IMPORT = [".txt", ".md", ".docx"];
export const MAX_UPLOAD_MB = 2;
