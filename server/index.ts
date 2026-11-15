import { join } from "node:path";
import { dbConfigFromEnv, openDb } from "./db.js";
import { seedDemoDocuments } from "./seed.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const config = dbConfigFromEnv();
const db = await openDb(config);
await seedDemoDocuments(db);

const app = createApp(db, {
  staticDir: join(process.cwd(), "dist"),
  secureCookies: process.env.NODE_ENV === "production",
});
// Render (and most hosts) terminate TLS at a proxy; trust it so secure cookies are set.
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

const where = config.url.startsWith("file:") ? config.url : new URL(config.url).host + " (Turso)";
app.listen(port, () => console.log(`Inkwell listening on http://localhost:${port} (db: ${where})`));
