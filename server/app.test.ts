import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, seedDemoDocuments, dbConfigFromEnv, SEED_PASSWORD, type DB } from "./db.js";
import { createApp } from "./app.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let db: DB;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = await openDb(":memory:");
  app = createApp(db);
});

async function login(email: string) {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: SEED_PASSWORD }).expect(200);
  return agent;
}

describe("auth", () => {
  it("rejects unauthenticated access and bad credentials", async () => {
    await request(app).get("/api/documents").expect(401);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "alice@example.com", password: "nope" })
      .expect(401);
    expect(res.body.error).toMatch(/incorrect/i);
    await request(app).post("/api/auth/login").send({ email: "not-an-email", password: "x" }).expect(400);
  });
});

describe("documents", () => {
  it("creates, renames, edits and reopens a document with formatting preserved", async () => {
    const alice = await login("alice@example.com");
    const created = await alice.post("/api/documents").send({}).expect(201);
    expect(created.body).toMatchObject({ title: "Untitled document", role: "owner", version: 1 });

    const html = "<h1>Plan</h1><p><strong>Bold</strong> <em>it</em> <u>u</u></p><ul><li><p>one</p></li></ul><ol><li><p>two</p></li></ol>";
    const updated = await alice
      .patch(`/api/documents/${created.body.id}`)
      .send({ title: "Q3 plan", content: html, baseVersion: 1 })
      .expect(200);
    expect(updated.body.version).toBe(2);

    const reopened = await alice.get(`/api/documents/${created.body.id}`).expect(200);
    expect(reopened.body.title).toBe("Q3 plan");
    expect(reopened.body.content).toBe(html);
  });

  it("sanitizes stored HTML", async () => {
    const alice = await login("alice@example.com");
    const { body } = await alice.post("/api/documents").send({ title: "x" });
    const res = await alice
      .patch(`/api/documents/${body.id}`)
      .send({ content: '<p onclick="steal()">hi<script>alert(1)</script><img src=x onerror=y></p>', baseVersion: 1 })
      .expect(200);
    expect(res.body.content).toBe("<p>hi</p>");
  });

  it("rejects stale writes with 409 instead of overwriting", async () => {
    const alice = await login("alice@example.com");
    const { body } = await alice.post("/api/documents").send({ title: "x" });
    await alice.patch(`/api/documents/${body.id}`).send({ content: "<p>A</p>", baseVersion: 1 }).expect(200);
    const stale = await alice
      .patch(`/api/documents/${body.id}`)
      .send({ content: "<p>B</p>", baseVersion: 1 })
      .expect(409);
    expect(stale.body.currentVersion).toBe(2);
  });

  it("validates input", async () => {
    const alice = await login("alice@example.com");
    await alice.post("/api/documents").send({ title: "   " }).expect(400);
    const { body } = await alice.post("/api/documents").send({ title: "x" });
    await alice.patch(`/api/documents/${body.id}`).send({ baseVersion: 1 }).expect(400);
    await alice.get("/api/documents/abc").expect(400);
  });
});

describe("sharing", () => {
  it("enforces owner / editor / viewer permissions end to end", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    const carol = await login("carol@example.com");
    const { body: doc } = await alice.post("/api/documents").send({ title: "Secret" });

    // Not shared yet: invisible to others (404, not 403, so existence isn't leaked).
    await bob.get(`/api/documents/${doc.id}`).expect(404);

    // Share as viewer: Bob can read, cannot write or manage sharing.
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "bob@example.com", role: "viewer" }).expect(201);
    const asViewer = await bob.get(`/api/documents/${doc.id}`).expect(200);
    expect(asViewer.body.role).toBe("viewer");
    expect(asViewer.body.shares).toBeUndefined();
    await bob.patch(`/api/documents/${doc.id}`).send({ content: "<p>hack</p>", baseVersion: 1 }).expect(403);
    await bob.post(`/api/documents/${doc.id}/shares`).send({ email: "carol@example.com", role: "editor" }).expect(403);
    await bob.delete(`/api/documents/${doc.id}`).expect(403);

    // Lists distinguish owned vs shared.
    const bobList = await bob.get("/api/documents").expect(200);
    expect(bobList.body.owned).toHaveLength(0);
    expect(bobList.body.shared).toEqual([
      expect.objectContaining({ id: doc.id, role: "viewer", ownerName: "Alice Chen" }),
    ]);
    const aliceList = await alice.get("/api/documents").expect(200);
    expect(aliceList.body.owned[0]).toMatchObject({ id: doc.id, shareCount: 1 });

    // Upgrade to editor: Bob can now write.
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "bob@example.com", role: "editor" }).expect(201);
    await bob.patch(`/api/documents/${doc.id}`).send({ content: "<p>edit</p>", baseVersion: 1 }).expect(200);

    // Carol still has nothing; revoking Bob removes access.
    await carol.get(`/api/documents/${doc.id}`).expect(404);
    const { body: ownerView } = await alice.get(`/api/documents/${doc.id}`).expect(200);
    const bobId = ownerView.shares.find((s: { email: string }) => s.email === "bob@example.com").userId;
    await alice.delete(`/api/documents/${doc.id}/shares/${bobId}`).expect(200);
    await bob.get(`/api/documents/${doc.id}`).expect(404);
  });

  it("rejects sharing with unknown users or yourself", async () => {
    const alice = await login("alice@example.com");
    const { body: doc } = await alice.post("/api/documents").send({ title: "x" });
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "nobody@example.com", role: "viewer" }).expect(404);
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "alice@example.com", role: "viewer" }).expect(400);
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "bob@example.com", role: "admin" }).expect(400);
  });
});

describe("file import", () => {
  it("turns a markdown file into an editable document", async () => {
    const alice = await login("alice@example.com");
    const md = "# Notes\n\nSome **bold** and _italic_.\n\n- a\n- b\n\n<script>alert(1)</script>";
    const res = await alice
      .post("/api/documents/import")
      .attach("file", Buffer.from(md), "meeting-notes.md")
      .expect(201);
    expect(res.body.title).toBe("meeting-notes");
    expect(res.body.content).toContain("<h1>Notes</h1>");
    expect(res.body.content).toContain("<strong>bold</strong>");
    expect(res.body.content).toContain("<em>italic</em>");
    expect(res.body.content).toContain("<ul>");
    expect(res.body.content).not.toContain("script");
  });

  it("turns a Word .docx file into a document, keeping headings, emphasis and lists", async () => {
    const alice = await login("alice@example.com");
    const res = await alice
      .post("/api/documents/import")
      .attach("file", readFileSync(join(__dirname, "fixtures", "sample.docx")), "Project Brief.docx")
      .expect(201);
    expect(res.body.title).toBe("Project Brief");
    expect(res.body.content).toContain("<h1>Project Brief</h1>");
    expect(res.body.content).toContain("<strong>bold</strong>");
    expect(res.body.content).toContain("<em>italic</em>");
    expect(res.body.content).toMatch(/<ul><li>First bullet<\/li><li>Second bullet<\/li><\/ul>/);
    expect(res.body.content).toContain("<ol><li>Step one</li></ol>");
  });

  it("turns plain text into escaped paragraphs", async () => {
    const alice = await login("alice@example.com");
    const res = await alice
      .post("/api/documents/import")
      .attach("file", Buffer.from("Line <1>\nline 2\n\nSecond para"), "a.txt")
      .expect(201);
    expect(res.body.content).toBe("<p>Line &lt;1&gt;<br />line 2</p><p>Second para</p>");
  });

  it("rejects unsupported, missing or corrupt files with a clear message", async () => {
    const alice = await login("alice@example.com");
    const pdf = await alice.post("/api/documents/import").attach("file", Buffer.from("%PDF"), "x.pdf").expect(400);
    expect(pdf.body.error).toMatch(/Supported: \.txt, \.md, \.docx/);
    await alice.post("/api/documents/import").expect(400);
    await alice.post("/api/documents/import").attach("file", Buffer.from("not a zip"), "x.docx").expect(400);
    await alice
      .post("/api/documents/import")
      .attach("file", Buffer.alloc(3 * 1024 * 1024, 97), "big.txt")
      .expect(413);
  });
});

describe("demo seed data", () => {
  it("seeds owned and shared documents once, so a fresh deploy demonstrates sharing", async () => {
    await seedDemoDocuments(db);
    await seedDemoDocuments(db); // idempotent: second run is a no-op
    const bob = await login("bob@example.com");
    const { body } = await bob.get("/api/documents").expect(200);
    expect(body.owned.map((d: { title: string }) => d.title)).toEqual(["Team meeting notes"]);
    expect(body.shared).toEqual([expect.objectContaining({ title: "Welcome to Inkwell", role: "editor", ownerName: "Alice Chen" })]);
    const carol = await login("carol@example.com");
    const carolDocs = (await carol.get("/api/documents")).body;
    expect(carolDocs.shared).toEqual([expect.objectContaining({ title: "Welcome to Inkwell", role: "viewer" })]);
  });

  it("deleting a document also removes its shares", async () => {
    await seedDemoDocuments(db);
    const alice = await login("alice@example.com");
    const welcome = (await alice.get("/api/documents")).body.owned[0];
    await alice.delete(`/api/documents/${welcome.id}`).expect(204);
    const left = await db.execute({ sql: "SELECT COUNT(*) AS n FROM document_shares WHERE document_id = ?", args: [welcome.id] });
    expect(left.rows[0].n).toBe(0);
    const bob = await login("bob@example.com");
    expect((await bob.get("/api/documents")).body.shared).toEqual([]);
  });
});

describe("database config", () => {
  it("uses Turso when TURSO_DATABASE_URL is set", () => {
    expect(dbConfigFromEnv({ TURSO_DATABASE_URL: "libsql://x.turso.io", TURSO_AUTH_TOKEN: "t" })).toEqual({
      url: "libsql://x.turso.io", authToken: "t",
    });
  });

  it("refuses to start in production without a persistent database", () => {
    expect(() => dbConfigFromEnv({ NODE_ENV: "production" })).toThrow(/TURSO_DATABASE_URL/);
  });
});
