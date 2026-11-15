import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate, SEED_PASSWORD, type DB } from "./db.js";
import { createApp } from "./app.js";
import { PresenceTracker } from "./presence.js";
import { toMarkdown, exportFilename } from "./exporters.js";

let db: DB;
let app: ReturnType<typeof createApp>;
let clock: number;
let presence: PresenceTracker;

beforeEach(async () => {
  db = await openDb(":memory:");
  clock = 1_000_000;
  presence = new PresenceTracker(20_000, () => clock);
  app = createApp(db, { presence });
});

async function login(email: string) {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: SEED_PASSWORD }).expect(200);
  return agent;
}

/** Alice owns a doc shared with Bob (role) and Carol (role). */
async function setup(bobRole = "editor", carolRole = "commenter") {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  const { body: doc } = await alice.post("/api/documents").send({ title: "Plan" }).expect(201);
  await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "bob@example.com", role: bobRole }).expect(201);
  await alice.post(`/api/documents/${doc.id}/shares`).send({ email: "carol@example.com", role: carolRole }).expect(201);
  return { alice, bob, carol, doc };
}

describe("migrations", () => {
  it("upgrades a database created with the original schema without losing data", async () => {
    const old = await openDb(":memory:", { migrateUpTo: 1 });
    await old.batch(
      [
        "INSERT INTO documents (owner_id, title, content, version) VALUES (1, 'Old doc', '<p>hi</p>', 3)",
        "INSERT INTO document_shares (document_id, user_id, role) VALUES (1, 2, 'viewer')",
      ],
      "write",
    );
    // The old CHECK constraint rejects the new role…
    await expect(
      old.execute("INSERT INTO document_shares (document_id, user_id, role) VALUES (1, 3, 'commenter')"),
    ).rejects.toThrow(/CHECK/);

    await migrate(old);
    await migrate(old); // idempotent

    const shares = await old.execute("SELECT user_id, role FROM document_shares ORDER BY user_id");
    expect(shares.rows.map((r) => [r.user_id, r.role])).toEqual([[2, "viewer"]]);
    // …and the migrated table accepts it.
    await old.execute("INSERT INTO document_shares (document_id, user_id, role) VALUES (1, 3, 'commenter')");
    // Existing documents get a baseline history entry.
    const versions = await old.execute("SELECT version, note FROM document_versions WHERE document_id = 1");
    expect(versions.rows.map((r) => [r.version, r.note])).toEqual([[3, "Version history started"]]);
    const applied = await old.execute("SELECT version FROM schema_migrations ORDER BY version");
    expect(applied.rows.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe("commenter role", () => {
  it("can read and comment but not edit, restore or manage sharing", async () => {
    const { carol, doc } = await setup("viewer", "commenter");
    const { body } = await carol.get(`/api/documents/${doc.id}`).expect(200);
    expect(body.role).toBe("commenter");
    const edit = await carol.patch(`/api/documents/${doc.id}`).send({ content: "<p>x</p>", baseVersion: 1 }).expect(403);
    expect(edit.body.error).toMatch(/comment on this document but not edit/);
    await carol.post(`/api/documents/${doc.id}/comments`).send({ body: "Looks good" }).expect(201);
    await carol.post(`/api/documents/${doc.id}/shares`).send({ email: "bob@example.com", role: "editor" }).expect(403);
    const { body: versions } = await carol.get(`/api/documents/${doc.id}/versions`).expect(200);
    await carol.post(`/api/documents/${doc.id}/versions/${versions[0].id}/restore`).send({ baseVersion: 1 }).expect(403);
  });

  it("is listed with its role in 'Shared with me'", async () => {
    const { carol, doc } = await setup();
    const { body } = await carol.get("/api/documents").expect(200);
    expect(body.shared).toEqual([expect.objectContaining({ id: doc.id, role: "commenter" })]);
  });
});

describe("comments", () => {
  it("supports quoting, resolving and reopening, with permission checks", async () => {
    const { alice, bob, carol, doc } = await setup("viewer", "commenter");
    const url = `/api/documents/${doc.id}/comments`;

    // Viewers can read comments but not write them.
    await bob.post(url).send({ body: "hi" }).expect(403);
    await carol.post(url).send({ body: "   " }).expect(400);
    await carol.post(url).send({ body: "x", quote: "y".repeat(501) }).expect(400);

    const { body: afterAdd } = await carol.post(url).send({ body: "Tighten this", quote: "intro paragraph" }).expect(201);
    expect(afterAdd).toEqual([
      expect.objectContaining({ body: "Tighten this", quote: "intro paragraph", resolved: false, author: expect.objectContaining({ name: "Carol Díaz" }) }),
    ]);
    const cid = afterAdd[0].id;
    expect((await bob.get(url).expect(200)).body).toHaveLength(1);

    // Resolve (any commenter+), reopen.
    await bob.patch(`${url}/${cid}`).send({ resolved: true }).expect(403);
    expect((await alice.patch(`${url}/${cid}`).send({ resolved: true }).expect(200)).body[0].resolved).toBe(true);
    expect((await carol.patch(`${url}/${cid}`).send({ resolved: false }).expect(200)).body[0].resolved).toBe(false);
  });

  it("can be deleted only by its author or the document owner", async () => {
    const { alice, bob, carol, doc } = await setup("editor", "commenter");
    const url = `/api/documents/${doc.id}/comments`;
    const [c1] = (await carol.post(url).send({ body: "by carol" })).body;
    await bob.delete(`${url}/${c1.id}`).expect(403); // editor, but not author or owner
    await carol.delete(`${url}/${c1.id}`).expect(200);
    const [c2] = (await bob.post(url).send({ body: "by bob" })).body;
    await alice.delete(`${url}/${c2.id}`).expect(200); // owner
    await alice.delete(`${url}/99999`).expect(404);
  });

  it("are invisible to people without access", async () => {
    const { alice, doc } = await setup("editor", "commenter");
    await alice.post(`/api/documents/${doc.id}/comments`).send({ body: "private" }).expect(201);
    await alice.delete(`/api/documents/${doc.id}/shares/3`).expect(200); // remove Carol (seeded id 3)
    const carol = await login("carol@example.com");
    await carol.get(`/api/documents/${doc.id}/comments`).expect(404);
  });
});

describe("version history", () => {
  async function save(agent: request.Agent, id: number, content: string) {
    const { body: current } = await agent.get(`/api/documents/${id}`);
    return agent.patch(`/api/documents/${id}`).send({ content, baseVersion: current.version }).expect(200);
  }
  const ageHistory = () => db.execute("UPDATE document_versions SET updated_at = datetime('now', '-10 minutes')");

  it("groups bursts of autosaves by one person, and splits by author and by time", async () => {
    const { alice, bob, doc } = await setup();
    await save(alice, doc.id, "<p>a</p>");
    await save(alice, doc.id, "<p>ab</p>");
    await save(alice, doc.id, "<p>abc</p>");
    let { body: versions } = await alice.get(`/api/documents/${doc.id}/versions`).expect(200);
    // newest first: Alice's burst (one entry) + the "Created" milestone
    expect(versions.map((v: { authorName: string; note: string | null }) => [v.authorName, v.note])).toEqual([
      ["Alice Chen", null],
      ["Alice Chen", "Created"],
    ]);
    expect(versions[0].version).toBe(4);

    await save(bob, doc.id, "<p>abc bob</p>"); // different author → new entry
    await ageHistory();
    await save(bob, doc.id, "<p>later</p>"); // same author, but after the merge window → new entry
    versions = (await alice.get(`/api/documents/${doc.id}/versions`)).body;
    expect(versions.map((v: { authorName: string }) => v.authorName)).toEqual([
      "Bob Okafor", "Bob Okafor", "Alice Chen", "Alice Chen",
    ]);
  });

  it("previews and restores an earlier version, recording the restore as its own entry", async () => {
    const { alice, carol, doc } = await setup();
    await save(alice, doc.id, "<p>first draft</p>");
    await ageHistory();
    await save(alice, doc.id, "<p>second draft</p>");
    const { body: versions } = await alice.get(`/api/documents/${doc.id}/versions`);
    const firstDraft = versions.find((v: { version: number }) => v.version === 2);

    const { body: preview } = await carol.get(`/api/documents/${doc.id}/versions/${firstDraft.id}`).expect(200);
    expect(preview.content).toBe("<p>first draft</p>");

    // Stale baseVersion → conflict, nothing changes.
    await alice.post(`/api/documents/${doc.id}/versions/${firstDraft.id}/restore`).send({ baseVersion: 1 }).expect(409);
    const { body: restored } = await alice
      .post(`/api/documents/${doc.id}/versions/${firstDraft.id}/restore`)
      .send({ baseVersion: 3 })
      .expect(200);
    expect(restored).toMatchObject({ content: "<p>first draft</p>", version: 4 });
    const { body: after } = await alice.get(`/api/documents/${doc.id}/versions`);
    expect(after[0]).toMatchObject({ version: 4, note: "Restored an earlier version" });

    // A version id from a different document is not found.
    const { body: other } = await alice.post("/api/documents").send({ title: "Other" });
    await alice.get(`/api/documents/${other.id}/versions/${firstDraft.id}`).expect(404);
  });

  it("records imports as their own milestone", async () => {
    const alice = await login("alice@example.com");
    const { body: doc } = await alice
      .post("/api/documents/import")
      .attach("file", Buffer.from("# Hi"), "notes.md")
      .expect(201);
    const { body: versions } = await alice.get(`/api/documents/${doc.id}/versions`);
    expect(versions).toEqual([expect.objectContaining({ version: 1, note: "Imported from notes.md" })]);
  });
});

describe("markdown export", () => {
  it("converts formatting and downloads with a safe filename", async () => {
    const { alice, carol, doc } = await setup("editor", "viewer");
    const html =
      "<h2>Goals</h2><p><strong>Bold</strong>, <em>it</em>, <u>under</u> and <s>gone</s></p>" +
      "<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>first</p></li><li><p>second</p></li></ol>" +
      "<blockquote><p>quoted</p></blockquote>";
    await alice.patch(`/api/documents/${doc.id}`).send({ title: "Q3 plan / draft", content: html, baseVersion: 1 }).expect(200);

    const res = await carol.get(`/api/documents/${doc.id}/export.md`).expect(200); // viewers can export
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.headers["content-disposition"]).toContain('filename="Q3-plan-draft.md"');
    expect(res.text).toBe(
      "# Q3 plan / draft\n\n## Goals\n\n**Bold**, _it_, <u>under</u> and ~~gone~~\n\n" +
        "- one\n- two\n\n1. first\n2. second\n\n> quoted\n",
    );
    const bob = await login("bob@example.com");
    await request.agent(app).get(`/api/documents/${doc.id}/export.md`).expect(401);
    await bob.get(`/api/documents/${doc.id}/export.md`).expect(200);
  });

  it("does not repeat the title when the document already starts with it", () => {
    expect(toMarkdown("Notes", "<h1>Notes</h1><p>x</p>")).toBe("# Notes\n\nx\n");
    expect(exportFilename("???", "md")).toBe("document.md");
    expect(exportFilename("Café menu", "md")).toBe("Café-menu.md");
  });
});

describe("presence", () => {
  it("shows who else has the document open and whether they're editing, and expires stale entries", async () => {
    const { alice, bob, carol, doc } = await setup();
    const url = `/api/documents/${doc.id}/presence`;
    await alice.post(url).send({ editing: true }).expect(200);
    clock += 5_000;
    const { body } = await bob.post(url).send({ editing: false }).expect(200);
    expect(body.users).toEqual([
      { id: 1, name: "Alice Chen", editing: true },
      { id: 2, name: "Bob Okafor", editing: false },
    ]);
    expect(body).toMatchObject({ version: 1, lastEditor: { name: "Alice Chen" }, openComments: 0 });

    // Alice stops sending heartbeats; 20 s after her last one she disappears.
    clock += 16_000;
    expect((await bob.post(url).send({}).expect(200)).body.users.map((u: { name: string }) => u.name)).toEqual([
      "Bob Okafor",
    ]);

    // Explicit leave.
    await bob.delete(url).expect(204);
    expect((await carol.post(url).send({}).expect(200)).body.users.map((u: { name: string }) => u.name)).toEqual([
      "Carol Díaz",
    ]);
  });

  it("reports the latest version and open comment count so clients can refresh", async () => {
    const { alice, bob, carol, doc } = await setup();
    await bob.patch(`/api/documents/${doc.id}`).send({ content: "<p>bob</p>", baseVersion: 1 }).expect(200);
    await carol.post(`/api/documents/${doc.id}/comments`).send({ body: "hm" }).expect(201);
    const { body } = await alice.post(`/api/documents/${doc.id}/presence`).send({}).expect(200);
    expect(body).toMatchObject({ version: 2, lastEditor: { name: "Bob Okafor" }, openComments: 1 });
  });

  it("is not available to people without access", async () => {
    const alice = await login("alice@example.com");
    const { body: doc } = await alice.post("/api/documents").send({ title: "x" });
    const bob = await login("bob@example.com");
    await bob.post(`/api/documents/${doc.id}/presence`).send({}).expect(404);
  });
});
