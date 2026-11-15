import { useEffect, useState, type FormEvent } from "react";
import { api, type Share, type ShareRole } from "./api";

export function ShareDialog({
  docId, shares, onChange, onClose,
}: { docId: number; shares: Share[]; onChange: (s: Share[]) => void; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen on window, not the dialog: when a button is disabled mid-request, focus drops to
  // <body> and a dialog-level handler would never see Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<Share[]>) {
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

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.share(docId, email.trim(), role))) setEmail("");
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="modal-head">
          <h2 id="share-title">Share document</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form className="share-form" onSubmit={add}>
          <input
            type="email" placeholder="Email, e.g. bob@example.com" value={email} required autoFocus
            onChange={(e) => setEmail(e.target.value)} aria-label="Email to share with"
          />
          <select value={role} onChange={(e) => setRole(e.target.value as ShareRole)} aria-label="Access level">
            <RoleOptions />
          </select>
          <button className="btn primary" disabled={busy}>Share</button>
        </form>
        <p className="muted small">Demo users: alice@example.com, bob@example.com, carol@example.com</p>
        <details className="small role-help">
          <summary>What can each role do?</summary>
          <ul>
            <li><b>View only</b>: read, export, see comments and history</li>
            <li><b>Can comment</b>: also add and resolve comments</li>
            <li><b>Can edit</b>: also edit and restore earlier versions</li>
            <li><b>Owner</b> (you): also share and delete</li>
          </ul>
        </details>
        {error && <div className="error" role="alert">{error}</div>}
        <h3>People with access</h3>
        <ul className="share-list">
          <li><span>You</span><span className="badge owner">Owner</span></li>
          {shares.map((s) => (
            <li key={s.userId}>
              <span>{s.name} <span className="muted small">{s.email}</span></span>
              <select
                value={s.role} disabled={busy} aria-label={`Access for ${s.name}`}
                onChange={(e) => run(() => api.share(docId, s.email, e.target.value as ShareRole))}
              >
                <RoleOptions />
              </select>
              <button className="btn ghost small danger" disabled={busy} onClick={() => run(() => api.unshare(docId, s.userId))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RoleOptions() {
  return (
    <>
      <option value="editor">Can edit</option>
      <option value="commenter">Can comment</option>
      <option value="viewer">View only</option>
    </>
  );
}
