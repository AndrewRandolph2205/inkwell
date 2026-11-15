import { useState, type FormEvent } from "react";
import { api, type User } from "./api";

const DEMO = [
  { email: "alice@example.com", name: "Alice Chen" },
  { email: "bob@example.com", name: "Bob Okafor" },
  { email: "carol@example.com", name: "Carol Díaz" },
];
const DEMO_PASSWORD = "password123";

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent, override?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const creds = override ?? { email, password };
      const { user } = await api.login(creds.email, creds.password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1><span className="logo" aria-hidden>✎</span> Inkwell</h1>
        <p className="muted">Write, format and share documents.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <div className="demo">
          <div className="muted small">Demo accounts (password <code>{DEMO_PASSWORD}</code>) — open a second browser or private window as another user to try sharing:</div>
          <div className="demo-buttons">
            {DEMO.map((d) => (
              <button
                type="button" key={d.email} className="btn" disabled={busy}
                onClick={() => submit(undefined, { email: d.email, password: DEMO_PASSWORD })}
              >
                {d.name.split(" ")[0]}
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
}
