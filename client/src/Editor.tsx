import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import {
  api, ApiError, can, ROLE_LABEL, type Comment, type Doc, type PresenceInfo, type Share, type User,
} from "./api";
import { formatDate, navigate } from "./router";
import { ShareDialog } from "./ShareDialog";
import { Toolbar } from "./Toolbar";
import { CommentsPanel } from "./CommentsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { PresenceBar } from "./Presence";
import { CommentHighlights, commentHighlightKey, findQuote } from "./commentHighlights";

type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";
type Patch = { title?: string; content?: string };
type Panel = "comments" | "history" | null;

const AUTOSAVE_MS = 800;
const PRESENCE_MS = 5000;
/** You count as "editing" (rather than just viewing) for this long after your last keystroke. */
const EDITING_WINDOW_MS = 15000;

export function Editor({ id, user }: { id: number; user: User }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [showShare, setShowShare] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeComment, setActiveComment] = useState<number | null>(null);
  const [quote, setQuote] = useState("");
  const [presence, setPresence] = useState<PresenceInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  // Save pipeline state lives in refs so the editor's callbacks always see current values.
  const version = useRef(0);
  const pending = useRef<Patch>({});
  const inFlight = useRef(false);
  const conflicted = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const lastSaved = useRef<string | null>(null);
  const lastTyped = useRef(0);
  const panelRef = useRef<Panel>(null);
  panelRef.current = panel;
  const openCount = useRef(0);
  openCount.current = comments.filter((c) => !c.resolved).length;

  const hasPending = () => pending.current.title !== undefined || pending.current.content !== undefined;

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }

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

  /** Save everything now and wait for it (used before export). */
  const settle = useCallback(async () => {
    for (let i = 0; i < 50 && (hasPending() || inFlight.current); i++) {
      if (!inFlight.current) await flush();
      else await new Promise((r) => setTimeout(r, 100));
    }
  }, [flush]);

  const queue = useCallback((patch: Patch) => {
    if (conflicted.current) return;
    pending.current = { ...pending.current, ...patch };
    setStatus("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, AUTOSAVE_MS);
  }, [flush]);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const onHighlightClick = useRef((_id: number) => {});
  onHighlightClick.current = (commentId: number) => {
    setPanel("comments");
    setActiveComment(commentId);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Placeholder.configure({ placeholder: "Start writing…" }),
      CommentHighlights.configure({ onClick: (cid) => onHighlightClick.current(cid) }),
    ],
    editable: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Selection-only or normalization transactions can fire updates; only save real changes.
      if (html !== lastSaved.current || pending.current.content !== undefined) {
        lastTyped.current = Date.now();
        queueRef.current({ content: html });
      }
    },
  });

  /** Replace the editor's content with a server copy without creating an undo step or a save. */
  const applyServerDoc = useCallback((latest: Doc) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    editor.chain().setMeta("addToHistory", false).setContent(latest.content, false).run();
    if (editor.isFocused) {
      const size = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
    }
    version.current = latest.version;
    lastSaved.current = editor.getHTML();
    setDoc((d) => (d ? { ...d, title: latest.title, updatedAt: latest.updatedAt, version: latest.version } : d));
    if (document.activeElement?.getAttribute("aria-label") !== "Document title") setTitle(latest.title);
  }, [editor]);

  // Load the document and its comments.
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
    api.listComments(id).then((c) => !cancelled && setComments(c), () => {});
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
    editor.setEditable(can.edit(doc.role), false);
    lastSaved.current = editor.getHTML();
    if (can.edit(doc.role) && !doc.content) editor.commands.focus();
  }, [editor, doc]);

  // Keep comment highlights in sync with the open comments.
  useEffect(() => {
    if (!editor) return;
    const items = comments.filter((c) => !c.resolved && c.quote).map((c) => ({ id: c.id, quote: c.quote! }));
    editor.view.dispatch(editor.state.tr.setMeta(commentHighlightKey, { items, active: activeComment }));
  }, [editor, comments, activeComment]);

  // Remember the text selected in the document, so "Comment" can quote it.
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const root = document.querySelector(".paper .ProseMirror");
      if (!sel || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
      if (sel.isCollapsed) return setQuote("");
      if (sel.focusNode && root.contains(sel.focusNode)) setQuote(sel.toString().trim().slice(0, 500));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // Presence heartbeat. Also the channel for live updates: if someone else saved and we have
  // nothing unsaved, pull their version in; and refresh comments when they change.
  const docLoaded = doc !== null;
  useEffect(() => {
    if (!docLoaded || !editor) return;
    let stopped = false;

    async function pullRemote(info: PresenceInfo) {
      if (info.version <= version.current || hasPending() || inFlight.current || conflicted.current) return;
      const latest = await api.getDoc(id);
      // Re-check: the user may have typed while we were fetching.
      if (stopped || hasPending() || inFlight.current || latest.version <= version.current) return;
      applyServerDoc(latest);
      const who = info.lastEditor && info.lastEditor.id !== user.id ? info.lastEditor.name.split(" ")[0] : "someone";
      showToast(`Updated with ${who}'s latest changes`);
    }

    async function tick() {
      try {
        const info = await api.heartbeat(id, Date.now() - lastTyped.current < EDITING_WINDOW_MS);
        if (stopped) return;
        setPresence(info);
        await pullRemote(info);
        if (panelRef.current === "comments" || info.openComments !== openCount.current) {
          const c = await api.listComments(id);
          if (!stopped) setComments(c);
        }
      } catch (e) {
        if (!stopped && e instanceof ApiError && e.status === 404) {
          setLoadError("You no longer have access to this document.");
        } // other errors are transient; the next tick retries
      }
    }

    void tick();
    const interval = window.setInterval(tick, PRESENCE_MS);
    const onPageHide = () => api.leave(id);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener("pagehide", onPageHide);
      api.leave(id);
    };
  }, [id, docLoaded, editor, applyServerDoc, user.id]);

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

  function focusComment(commentId: number) {
    setActiveComment(commentId);
    const c = comments.find((x) => x.id === commentId);
    if (!editor || !c?.quote || c.resolved) return;
    const range = findQuote(editor.state.doc, c.quote);
    if (!range) return;
    const { node } = editor.view.domAtPos(range.from);
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function exportMarkdown() {
    setExportOpen(false);
    await settle();
    const a = document.createElement("a");
    a.href = api.exportMarkdownUrl(id);
    a.download = "";
    a.click();
  }

  async function exportPdf() {
    setExportOpen(false);
    await settle();
    window.print();
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

  const editable = can.edit(doc.role);
  const openComments = comments.filter((c) => !c.resolved).length;
  const lastEditor = presence?.lastEditor;

  return (
    <div className={`editor-page ${panel ? "with-panel" : ""}`}>
      <div className="editor-main">
        <div className="doc-header">
          <button className="btn ghost back" onClick={() => navigate("/")} aria-label="Back to documents">←</button>
          <div className="title-wrap">
            <input
              className="title-input" value={title} readOnly={!editable} aria-label="Document title" maxLength={200}
              onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTitle(doc.title); setTitleError(null); } }}
            />
            <div className="doc-meta small">
              <span className={`badge ${doc.role}`}>{ROLE_LABEL[doc.role]}</span>
              {doc.role !== "owner" && <span className="muted">Owned by {doc.owner.name}</span>}
              {editable && <SaveIndicator status={status} error={saveError} onRetry={flush} />}
              <span className="muted">
                Last edited {formatDate(doc.updatedAt)}
                {lastEditor && ` by ${lastEditor.id === user.id ? "you" : lastEditor.name}`}
              </span>
            </div>
            {titleError && <div className="error small" role="alert">{titleError}</div>}
          </div>
          <div className="doc-actions">
            <button
              className={`btn ${panel === "comments" ? "active" : ""}`} aria-pressed={panel === "comments"}
              onClick={() => setPanel(panel === "comments" ? null : "comments")}
            >
              💬 Comments{openComments ? ` · ${openComments}` : ""}
            </button>
            <button
              className={`btn ${panel === "history" ? "active" : ""}`} aria-pressed={panel === "history"}
              onClick={() => setPanel(panel === "history" ? null : "history")}
            >
              ⟲ History
            </button>
            <div className="menu-wrap">
              <button className="btn" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}>
                Export ▾
              </button>
              {exportOpen && (
                <div className="menu" role="menu" onMouseLeave={() => setExportOpen(false)}>
                  <button role="menuitem" onClick={exportMarkdown}>Markdown (.md)</button>
                  <button role="menuitem" onClick={exportPdf}>PDF (print dialog)…</button>
                </div>
              )}
            </div>
            {doc.role === "owner" && (
              <button className="btn primary" onClick={() => setShowShare(true)}>
                Share{shares.length ? ` · ${shares.length}` : ""}
              </button>
            )}
            <PresenceBar info={presence} selfId={user.id} />
          </div>
        </div>

        {status === "conflict" && (
          <div className="error banner" role="alert">
            Someone else saved this document after you opened it, so your latest changes were not saved.
            <button className="btn" onClick={() => window.location.reload()}>Reload latest version</button>
          </div>
        )}
        {doc.role === "viewer" && (
          <div className="notice banner">You have view-only access. Ask {doc.owner.name} for more access.</div>
        )}
        {doc.role === "commenter" && (
          <div className="notice banner">You can comment but not edit. Select text, then open Comments to add one.</div>
        )}

        {editable && editor && <Toolbar editor={editor} />}
        <h1 className="print-only">{doc.title}</h1>
        <div className={`paper ${editable ? "" : "readonly"}`}>
          <EditorContent editor={editor} />
        </div>
      </div>

      {panel === "comments" && (
        <CommentsPanel
          docId={doc.id} role={doc.role} userId={user.id} comments={comments} onChange={setComments}
          quote={quote} onClearQuote={() => setQuote("")} active={activeComment} onActivate={focusComment}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "history" && (
        <HistoryPanel
          docId={doc.id} role={doc.role} docVersion={doc.version}
          canRestoreNow={status === "saved"}
          onRestored={(d) => { applyServerDoc(d); showToast("Version restored. You can undo this from History."); }}
          onClose={() => setPanel(null)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
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
