import { useEffect, useState } from "react";

/** Tiny pushState router: two routes don't justify a dependency. */
export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function formatDate(sqlite: string) {
  // SQLite datetime('now') is UTC without a zone marker.
  const d = new Date(sqlite.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
