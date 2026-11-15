import { join } from "node:path";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DATABASE_PATH ?? join(process.cwd(), "data", "docs.db");
const db = openDb(dbFile);
const app = createApp(db, {
  staticDir: join(process.cwd(), "dist"),
  secureCookies: process.env.NODE_ENV === "production",
});
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.listen(port, () => console.log(`Inkwell listening on http://localhost:${port} (db: ${dbFile})`));
