import { useEffect, useState, type FormEvent } from "react";
import { api, can, type Comment, type Role } from "./api";
import { formatDate } from "./router";
import { Avatar } from "./Presence";

interface Props {
  docId: number;
  role: Role;
  userId: number;
  comments: Comment[];
  onChange: (c: Comment[]) => void;
  quote: string;
  onClearQuote: () => void;
  active: number | null;
  onActivate: (id: number) => void;
  onClose: () => void;
}

export function CommentsPanel({
  docId, role, userId, comments, onChange, quote, onClearQuote, active, onActivate, onClose,
}: Props) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  // Clicking a highlight in the document scrolls its comment into view.
  useEffect(() => {
    if (active == null) return;
    if (resolved.some((c) => c.id === active)) setShowResolved(true);
    document.getElementById(`comment-${active}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<Comment[]>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!body.trim()) return;
    if (await run(() => api.addComment(docId, body.trim(), quote))) {
      setBody("");
      onClearQuote();
    }
  }

  const card = (c: Comment) => (
    <li
      key={c.id} id={`comment-${c.id}`}
      className={`comment ${c.id === active ? "active" : ""} ${c.resolved ? "resolved" : ""}`}
      onClick={() => onActivate(c.id)}
    >
      <div className="comment-head">
        <Avatar id={c.author.id} name={c.author.name} small />
        <strong>{c.author.name}</strong>
        <span className="muted small">{formatDate(c.createdAt)}</span>
      </div>
      {c.quote && <blockquote className="comment-quote">“{c.quote}”</blockquote>}
      <p className="comment-body">{c.body}</p>
      <div className="comment-actions" onClick={(e) => e.stopPropagation()}>
        {can.comment(role) && (
          <button className="link" disabled={busy} onClick={() => run(() => api.setResolved(docId, c.id, !c.resolved))}>
            {c.resolved ? "Reopen" : "Resolve"}
          </button>
        )}
        {(c.author.id === userId || role === "owner") && (
          <button className="link danger" disabled={busy} onClick={() => run(() => api.deleteComment(docId, c.id))}>
            Delete
          </button>
        )}
      </div>
    </li>
  );

  return (
    <aside className="side-panel" aria-label="Comments">
      <div className="panel-head">
        <h2>Comments</h2>
        <button className="btn ghost" onClick={onClose} aria-label="Close comments">✕</button>
      </div>

      {can.comment(role) ? (
        <form className="comment-form" onSubmit={submit}>
          {quote ? (
            <div className="quote-chip">
              <span>On “{quote.length > 120 ? quote.slice(0, 120) + "…" : quote}”</span>
              <button type="button" className="link" onClick={onClearQuote} aria-label="Remove quoted text">✕</button>
            </div>
          ) : (
            <p className="muted small">Tip: select text in the document to comment on it.</p>
          )}
          <textarea
            value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000}
            placeholder="Add a comment…" aria-label="New comment"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          <button className="btn primary" disabled={busy || !body.trim()}>Comment</button>
        </form>
      ) : (
        <p className="notice small">You have view-only access. Ask the owner for comment access to join the discussion.</p>
      )}
      {error && <div className="error small" role="alert">{error}</div>}

      {open.length === 0 ? (
        <p className="muted small empty-note">No open comments.</p>
      ) : (
        <ul className="comment-list">{open.map(card)}</ul>
      )}
      {resolved.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide" : "Show"} resolved ({resolved.length})
          </button>
          {showResolved && <ul className="comment-list">{resolved.map(card)}</ul>}
        </>
      )}
    </aside>
  );
}
