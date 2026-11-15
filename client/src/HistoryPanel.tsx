import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, can, type Doc, type Role, type VersionDetail, type VersionSummary } from "./api";
import { formatDate } from "./router";

interface Props {
  docId: number;
  role: Role;
  docVersion: number;
  /** False while local edits are unsaved; restoring then would discard them. */
  canRestoreNow: boolean;
  onRestored: (doc: Doc) => void;
  onClose: () => void;
}

export function HistoryPanel({ docId, role, docVersion, canRestoreNow, onRestored, onClose }: Props) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<VersionDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  // Refresh when the document changes, debounced so autosave bursts cause a single fetch.
  useEffect(() => {
    const t = window.setTimeout(
      () => api.listVersions(docId).then(setVersions, (e) => setError(e.message)),
      versions ? 1500 : 0,
    );
    return () => window.clearTimeout(t);
  }, [docId, docVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(v: VersionSummary) {
    setError(null);
    try {
      setPreview(await api.getVersion(docId, v.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function restore() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await api.restoreVersion(docId, preview.id, docVersion);
      onRestored(doc);
      setPreview(null);
      setVersions(await api.listVersions(docId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isCurrent = (id: number) => versions?.[0]?.id === id;
  const describe = (v: { note: string | null }) => v.note ?? "Edited";

  return (
    <aside className="side-panel" aria-label="Version history">
      <div className="panel-head">
        <h2>Version history</h2>
        <button className="btn ghost" onClick={onClose} aria-label="Close history">✕</button>
      </div>
      <p className="muted small">
        Saves are grouped: a burst of edits by one person within 5 minutes is one entry.
      </p>
      {error && <div className="error small" role="alert">{error}</div>}
      {!versions ? (
        <p className="muted small">Loading…</p>
      ) : (
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.id}>
              <button className="version" onClick={() => open(v)}>
                <span className="version-time">
                  {formatDate(v.updatedAt)}
                  {isCurrent(v.id) && <span className="badge owner">Current</span>}
                </span>
                <span className="muted small">{describe(v)} · {v.authorName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Portal to <body>: the panel is position: sticky, which makes it its own stacking context,
          so a modal rendered inside it would sit underneath the sticky toolbar. */}
      {preview && createPortal(
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="card modal preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <div className="modal-head">
              <div>
                <h2 id="preview-title">{preview.title}</h2>
                <div className="muted small">
                  {describe(preview)} by {preview.authorName} · {formatDate(preview.updatedAt)}
                </div>
              </div>
              <button className="btn ghost" onClick={() => setPreview(null)} aria-label="Close preview" autoFocus>✕</button>
            </div>
            {/* Stored content is sanitized server-side on every write, so rendering it is safe. */}
            <div className="preview-body doc-content" dangerouslySetInnerHTML={{ __html: preview.content || "<p><em>(empty)</em></p>" }} />
            <div className="modal-foot">
              {isCurrent(preview.id) ? (
                <span className="muted small">This is the current version.</span>
              ) : can.edit(role) ? (
                <>
                  {!canRestoreNow && <span className="muted small">Wait for your changes to save first.</span>}
                  <button className="btn primary" disabled={busy || !canRestoreNow} onClick={restore}>
                    {busy ? "Restoring…" : "Restore this version"}
                  </button>
                </>
              ) : (
                <span className="muted small">Only editors can restore versions.</span>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
