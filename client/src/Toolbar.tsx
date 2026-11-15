import type { Editor as TiptapEditor } from "@tiptap/react";

export function Toolbar({ editor }: { editor: TiptapEditor }) {
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
