/**
 * Who has a document open right now. Clients send a heartbeat every few seconds; an entry
 * that hasn't been refreshed within `ttlMs` is considered gone (closed tab, lost network).
 *
 * Kept in memory on purpose: presence is ephemeral, and the app runs as a single instance.
 * With several instances this would move to a shared store (Redis, or a Turso table).
 */
export interface PresenceEntry {
  id: number;
  name: string;
  editing: boolean;
}

export class PresenceTracker {
  private docs = new Map<number, Map<number, PresenceEntry & { seen: number }>>();

  constructor(private ttlMs = 20_000, private now: () => number = Date.now) {}

  touch(docId: number, user: { id: number; name: string }, editing: boolean) {
    let users = this.docs.get(docId);
    if (!users) this.docs.set(docId, (users = new Map()));
    users.set(user.id, { id: user.id, name: user.name, editing, seen: this.now() });
  }

  leave(docId: number, userId: number) {
    this.docs.get(docId)?.delete(userId);
  }

  list(docId: number): PresenceEntry[] {
    const users = this.docs.get(docId);
    if (!users) return [];
    const cutoff = this.now() - this.ttlMs;
    for (const [id, u] of users) if (u.seen < cutoff) users.delete(id);
    if (users.size === 0) this.docs.delete(docId);
    return [...users.values()]
      .map(({ id, name, editing }) => ({ id, name, editing }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  forgetDocument(docId: number) {
    this.docs.delete(docId);
  }
}
