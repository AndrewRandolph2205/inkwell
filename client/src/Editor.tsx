import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { api, ApiError, type Doc, type Share, type User } from "./api";
import { formatDate, navigate } from "./router";
import { ShareDialog } from "./ShareDialog";

type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";
type Patch = { title?: string; content?: string };

const AUTOSAVE_MS = 800;

export function Editor({ id }: { id: number; user: User }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [showShare, setShowShare] = useState(false);

  // Save pipeline state lives in refs so the editor's callbacks always see current values.
  const version = useRef(0);
  const pending = useRef<Patch>({});
  const inFlight = useRef(false);
  const conflicted = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const lastSaved = useRef<string | null>(null);

  const hasPending = () => pending.current.title !== undefined || pending.current.content !== undefined;

  /** Send pending changes. Writes are serialized so each one carries the version returned by the last. */
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (inFlight.current || conflicted.current || !hasPending()) return;
    const patch = pending.current;
    pending.current = {};
    inFlight.current = true;
    setStatus("saving");
    try {
      const saved = await api.updateDoc(id, { ...patch, baseVersion: version.current });
      version.current = saved.version;
      if (patch.content !== undefined) lastSaved.current = patch.content;
      setDoc((d) => (d ? { ...d, title: saved.title, updatedAt: saved.updatedAt, version: saved.version } : d));
      setSaveError(null);
      setStatus(hasPending() ? "dirty" : "saved");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        conflicted.current = true;
        setStatus("conflict");
      } else {
        pending.current = { ...patch, ...pending.current }; // keep the edits so a retry can send them
        setSaveError((e as Error).message);
        setStatus("error");
      }
    } finally {
      inFlight.current = false;
    }
    if (!conflicted.current && hasPending()) timer.current = window.setTimeout(flush, AUTOSAVE_MS);
  }, [id]);

  const queue = useCallback((patch: Patch) => {
    if (conflicted.current) return;
    pending.current = { ...pending.current, ...patch };
    setStatus("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, AUTOSAVE_MS);
  }, [flush]);

  const queueRef = useRef(queue);
  queueRef.current = queue;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Placeholder.configure({ placeholder: "Start writing…" }),
    ],
    editable: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Selection-only or normalization transactions can fire updates; only save real changes.
      if (html !== lastSaved.current || pending.current.content !== undefined) queueRef.current({ content: html });
    },
  });

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    api.getDoc(id).then(
      (d) => {
        if (cancelled) return;
        version.current = d.version;
        setDoc(d);
        setTitle(d.title);
        setShares(d.shares ?? []);
      },
      (e) => !cancelled && setLoadError(e.message),
    );
    return () => { cancelled = true; };
  }, [id]);

  // Put content into the editor once both exist. emitUpdate=false so loading doesn't trigger a save.
  const loadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!editor || !doc || loadedFor.current === doc.id) return;
    loadedFor.current = doc.id;
    editor.commands.setContent(doc.content, false);
    // setEditable emits "update" by default, which would trigger a no-op save that bumps the
    // version and gives collaborators a false conflict. Pass emitUpdate=false.
    editor.setEditable(doc.role !== "viewer", false);
    lastSaved.current = editor.getHTML();
    if (doc.role !== "viewer" && !doc.content) editor.commands.focus();
  }, [editor, doc]);

  // Ctrl/Cmd+S saves now; warn before closing the tab with unsaved edits; flush when navigating away in-app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); flush(); }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasPending() || inFlight.current) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (!conflicted.current && hasPending()) void flush();
    };
  }, [flush]);

  function commitTitle() {
    const t = title.trim();
    if (!doc || t === doc.title) { setTitle(doc?.title ?? t); setTitleError(null); return; }
    if (!t) { setTitleError("Title can't be empty."); setTitle(doc.title); return; }
    if (t.length > 200) { setTitleError("Title is too long (max 200 characters)."); return; }
    setTitleError(null);
    setTitle(t);
    queue({ title: t });
    void flush();
  }

  if (loadError) {
    return (
      <div className="page">
        <div className="error" role="alert">{loadError}</div>
        <button className="btn" onClick={() => navigate("/")}>← Back to documents</button>
      </div>
    );
  }
  if (!doc) return <div className="page muted">Loading document…</div>;

  const readOnly = doc.role === "viewer";

  return (
    <div className="editor-page">
      <div className="doc-header">
        <button className="btn ghost" onClick={() => navigate("/")} aria-label="Back to documents">←</button>
        <div className="title-wrap">
          <input
            className="title-input" value={title} readOnly={readOnly} aria-label="Document title" maxLength={200}
            onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTitle(doc.title); setTitleError(null); } }}
          />
          <div className="doc-meta small">
            {doc.role === "owner" ? (
              <span className="badge owner">Owner</span>
            ) : (
              <>
                <span className={`badge ${doc.role}`}>{readOnly ? "View only" : "Can edit"}</span>
                <span className="muted">Owned by {doc.owner.name}</span>
              </>
            )}
            {!readOnly && <SaveIndicator status={status} error={saveError} onRetry={flush} />}
            <span className="muted">Last edited {formatDate(doc.updatedAt)}</span>
          </div>
          {titleError && <div className="error small" role="alert">{titleError}</div>}
        </div>
        {doc.role === "owner" && (
          <button className="btn primary" onClick={() => setShowShare(true)}>
            Share{shares.length ? ` · ${shares.length}` : ""}
          </button>
        )}
      </div>

      {status === "conflict" && (
        <div className="error banner" role="alert">
          Someone else saved this document after you opened it, so your latest changes were not saved.
          <button className="btn" onClick={() => window.location.reload()}>Reload latest version</button>
        </div>
      )}
      {readOnly && <div className="notice banner">You have view-only access. Ask {doc.owner.name} for edit access.</div>}

      {!readOnly && editor && <Toolbar editor={editor} />}
      <div className={`paper ${readOnly ? "readonly" : ""}`}>
        <EditorContent editor={editor} />
      </div>

      {showShare && (
        <ShareDialog docId={doc.id} shares={shares} onChange={setShares} onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}

function SaveIndicator({ status, error, onRetry }: { status: SaveStatus; error: string | null; onRetry: () => void }) {
  switch (status) {
    case "saved": return <span className="save ok">✓ Saved</span>;
    case "dirty": return <span className="save muted">Unsaved changes</span>;
    case "saving": return <span className="save muted">Saving…</span>;
    case "conflict": return <span className="save bad">Not saved (conflict)</span>;
    case "error":
      return (
        <span className="save bad">
          Save failed: {error} <button className="link" onClick={onRetry}>Retry</button>
        </span>
      );
  }
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
  const block = editor.isActive("heading", { level: 1 }) ? "h1"
    : editor.isActive("heading", { level: 2 }) ? "h2"
    : editor.isActive("heading", { level: 3 }) ? "h3" : "p";

  const btn = (label: string, title: string, active: boolean, run: () => void, cls = "") => (
    <button
      type="button" className={`tool ${active ? "active" : ""} ${cls}`} title={title} aria-label={title} aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} onClick={run}
    >
      {label}
    </button>
  );
  const chain = () => editor.chain().focus();

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <select
        aria-label="Text style" value={block}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "p") chain().setParagraph().run();
          else chain().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
        }}
      >
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="sep" />
      {btn("B", "Bold (Ctrl+B)", editor.isActive("bold"), () => chain().toggleBold().run(), "b")}
      {btn("I", "Italic (Ctrl+I)", editor.isActive("italic"), () => chain().toggleItalic().run(), "i")}
      {btn("U", "Underline (Ctrl+U)", editor.isActive("underline"), () => chain().toggleUnderline().run(), "u")}
      {btn("S", "Strikethrough", editor.isActive("strike"), () => chain().toggleStrike().run(), "s")}
      <span className="sep" />
      {btn("• List", "Bulleted list", editor.isActive("bulletList"), () => chain().toggleBulletList().run())}
      {btn("1. List", "Numbered list", editor.isActive("orderedList"), () => chain().toggleOrderedList().run())}
      {btn("❝", "Quote", editor.isActive("blockquote"), () => chain().toggleBlockquote().run())}
      <span className="sep" />
      {btn("↶", "Undo (Ctrl+Z)", false, () => chain().undo().run())}
      {btn("↷", "Redo (Ctrl+Shift+Z)", false, () => chain().redo().run())}
    </div>
  );
}
