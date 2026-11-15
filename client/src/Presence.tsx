import type { PresenceInfo } from "./api";

const COLORS = ["#2f5bea", "#1b7f4b", "#b4530a", "#8e3fd1", "#c62828", "#0b7a8a"];

export function Avatar({ id, name, small, ring }: { id: number; name: string; small?: boolean; ring?: boolean }) {
  return (
    <span
      className={`avatar ${small ? "small" : ""} ${ring ? "ring" : ""}`}
      style={{ background: COLORS[id % COLORS.length], color: "#fff" }}
      aria-hidden
    >
      {name[0]}
    </span>
  );
}

/** Avatars for the other people who have this document open, with a short summary. */
export function PresenceBar({ info, selfId }: { info: PresenceInfo | null; selfId: number }) {
  const others = info?.users.filter((u) => u.id !== selfId) ?? [];
  if (others.length === 0) return null;
  const editing = others.filter((u) => u.editing);
  const summary = editing.length
    ? `${editing.map((u) => u.name.split(" ")[0]).join(", ")} ${editing.length === 1 ? "is" : "are"} editing`
    : `${others.length} other${others.length === 1 ? "" : "s"} viewing`;
  return (
    <div className="presence" aria-live="polite">
      <div className="presence-avatars">
        {others.map((u) => (
          <span key={u.id} className="presence-user" title={`${u.name}: ${u.editing ? "editing" : "viewing"}`}>
            <Avatar id={u.id} name={u.name} ring={u.editing} />
            {u.editing && <span className="typing-dot" />}
          </span>
        ))}
      </div>
      <span className="muted small presence-text">{summary}</span>
    </div>
  );
}
