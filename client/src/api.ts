export interface User { id: number; email: string; name: string }
export type Role = "owner" | "editor" | "viewer";
export interface Share { userId: number; email: string; name: string; role: "viewer" | "editor" }
export interface Doc {
  id: number; title: string; content: string; version: number;
  createdAt: string; updatedAt: string; owner: User; role: Role; shares?: Share[];
}
export interface OwnedSummary { id: number; title: string; updatedAt: string; shareCount: number }
export interface SharedSummary {
  id: number; title: string; updatedAt: string; role: "viewer" | "editor"; ownerName: string; ownerEmail: string;
}

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
  share: (id: number, email: string, role: "viewer" | "editor") =>
    call<Share[]>(`/documents/${id}/shares`, json("POST", { email, role })),
  unshare: (id: number, userId: number) => call<Share[]>(`/documents/${id}/shares/${userId}`, { method: "DELETE" }),
};

export const SUPPORTED_IMPORT = [".txt", ".md", ".docx"];
export const MAX_UPLOAD_MB = 2;
