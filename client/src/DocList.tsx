import { useEffect, useRef, useState } from "react";
import { api, MAX_UPLOAD_MB, SUPPORTED_IMPORT, type OwnedSummary, type SharedSummary } from "./api";
import { formatDate, navigate } from "./router";

export function DocList() {
  const [data, setData] = useState<{ owned: OwnedSummary[]; shared: SharedSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () => api.listDocs().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create() {
    setBusy("Creating…");
    setError(null);
    try {
      const doc = await api.createDoc();
      navigate(`/d/${doc.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setError(null);
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_IMPORT.includes(ext)) {
      setError(`"${file.name}" isn't supported. Upload a ${SUPPORTED_IMPORT.join(", ")} file.`);
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`"${file.name}" is larger than ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    setBusy(`Importing ${file.name}…`);
    try {
      const doc = await api.importFile(file);
      navigate(`/d/${doc.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function remove(doc: OwnedSummary) {
    if (!confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    try {
      await api.deleteDoc(doc.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <div className="actions">
        <button className="btn primary" onClick={create} disabled={!!busy}>+ New document</button>
        <button className="btn" onClick={() => fileInput.current?.click()} disabled={!!busy}>⇪ Import file</button>
        <input
          ref={fileInput} type="file" hidden accept={SUPPORTED_IMPORT.join(",")}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }}
        />
        <span className="muted small">
          Import creates a new editable document from a <b>.txt</b>, <b>.md</b> or <b>.docx</b> file (max {MAX_UPLOAD_MB} MB).
        </span>
      </div>
      {busy && <div className="notice">{busy}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      {!data ? (
        !error && <div className="muted">Loading documents…</div>
      ) : (
        <>
          <section>
            <h2>My documents</h2>
            {data.owned.length === 0 ? (
              <div className="empty">You don't own any documents yet. Create one or import a file.</div>
            ) : (
              <ul className="doc-list">
                {data.owned.map((d) => (
                  <li key={d.id}>
                    <a href={`/d/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/d/${d.id}`); }}>
                      <span className="doc-icon owned" aria-hidden>▤</span>
                      <span className="doc-title">{d.title}</span>
                    </a>
                    <span className="badge owner">Owner</span>
                    {d.shareCount > 0 && <span className="badge">Shared with {d.shareCount}</span>}
                    <span className="muted small date">Edited {formatDate(d.updatedAt)}</span>
                    <button className="btn ghost small danger" onClick={() => remove(d)} aria-label={`Delete ${d.title}`}>Delete</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>Shared with me</h2>
            {data.shared.length === 0 ? (
              <div className="empty">Nothing has been shared with you yet.</div>
            ) : (
              <ul className="doc-list">
                {data.shared.map((d) => (
                  <li key={d.id}>
                    <a href={`/d/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/d/${d.id}`); }}>
                      <span className="doc-icon shared" aria-hidden>⇄</span>
                      <span className="doc-title">{d.title}</span>
                    </a>
                    <span className={`badge ${d.role}`}>{d.role === "editor" ? "Can edit" : "View only"}</span>
                    <span className="muted small">from {d.ownerName}</span>
                    <span className="muted small date">Edited {formatDate(d.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
