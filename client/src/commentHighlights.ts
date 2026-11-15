import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Highlights the text each open comment refers to.
 *
 * Comments store the quoted text rather than document positions: positions shift with every
 * edit, and commenters can't edit the document to insert anchors. The highlight is found by
 * searching for the quote (within one paragraph), so it follows the text as the document changes
 * and disappears if the quoted text is edited away; the comment itself is never lost.
 */
export interface Highlight { id: number; quote: string }
interface State { items: Highlight[]; active: number | null; decos: DecorationSet }

export const commentHighlightKey = new PluginKey<State>("commentHighlights");

export function findQuote(doc: PMNode, quote: string): { from: number; to: number } | null {
  const q = quote.trim();
  if (!q) return null;
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    // Map each character of the block's text back to its document position.
    let text = "";
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i];
          positions.push(pos + 1 + offset + i);
        }
      } else {
        text += "\n"; // hard break
        positions.push(pos + 1 + offset);
      }
    });
    const idx = text.indexOf(q);
    if (idx >= 0) found = { from: positions[idx], to: positions[idx + q.length - 1] + 1 };
    return false;
  });
  return found;
}

function build(doc: PMNode, items: Highlight[], active: number | null) {
  const decos: Decoration[] = [];
  for (const item of items) {
    const range = findQuote(doc, item.quote);
    if (range) {
      decos.push(
        Decoration.inline(range.from, range.to, {
          class: item.id === active ? "comment-hl active" : "comment-hl",
          "data-comment-id": String(item.id),
        }),
      );
    }
  }
  return DecorationSet.create(doc, decos);
}

export const CommentHighlights = Extension.create<{ onClick: (id: number) => void }>({
  name: "commentHighlights",
  addOptions: () => ({ onClick: () => {} }),
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<State>({
        key: commentHighlightKey,
        state: {
          init: () => ({ items: [], active: null, decos: DecorationSet.empty }),
          apply(tr, prev, _old, newState) {
            const meta = tr.getMeta(commentHighlightKey) as Partial<State> | undefined;
            if (!meta && !tr.docChanged) return prev;
            const next = { ...prev, ...meta };
            return { ...next, decos: build(newState.doc, next.items, next.active) };
          },
        },
        props: {
          decorations: (state) => commentHighlightKey.getState(state)?.decos,
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest?.("[data-comment-id]");
            if (el) options.onClick(Number((el as HTMLElement).dataset.commentId));
            return false;
          },
        },
      }),
    ];
  },
});
