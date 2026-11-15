import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { navigate, usePath } from "./router";
import { Login } from "./Login";
import { DocList } from "./DocList";
import { Editor } from "./Editor";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const path = usePath();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (user === null) return <Login onLogin={setUser} />;

  const docMatch = path.match(/^\/d\/(\d+)$/);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          <span className="logo" aria-hidden>✎</span> Inkwell
        </a>
        <div className="user">
          <span className="avatar" aria-hidden>{user.name[0]}</span>
          <span className="user-name">{user.name}</span>
          <button
            className="btn ghost"
            onClick={async () => { await api.logout().catch(() => {}); setUser(null); navigate("/"); }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        {docMatch ? <Editor key={docMatch[1]} id={Number(docMatch[1])} user={user} /> : <DocList />}
      </main>
    </div>
  );
}
