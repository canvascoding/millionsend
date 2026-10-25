import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db,
  close: () => Promise<void>,
  app: ReturnType<typeof createApi>,
  teamId: string,
  token: string;
async function call(method: string, path: string, body?: unknown, auth = token) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  if (process.env.DOI_POSTGRES_TEST_URL) {
    const url = new URL(process.env.DOI_POSTGRES_TEST_URL);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.pathname !== "/newsletter_doi_test"
    )
      throw new Error("Real PostgreSQL DOI tests require the isolated local fixture database");
    process.env.DATABASE_URL = url.toString();
    db = getDb();
    close = () => db.$client.end();
    const directory = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
    for (const file of readdirSync(directory)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(directory + file, "utf8").split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await db.$client.unsafe(statement);
  } else ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "doi");
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "doi",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());
async function pending() {
  const request_id = randomUUID(),
    email = `doi-${request_id}@example.com`,
    requestedAt = new Date(Date.now() - 1000).toISOString();
  const response = await call("POST", "/contacts", {
    email,
    unsubscribed: true,
    first_name: "Keep",
    properties: {
      original: "historical",
      canvas_newsletter_state: "pending",
      canvas_newsletter_doi_request_id: request_id,
      canvas_newsletter_doi_requested_at: requestedAt,
    },
  });
  expect(response.status).toBe(200);
  const { id } = (await response.json()) as { id: string };
  return { id, email, request_id };
}
const read = async (id: string) =>
  (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0];
const confirm = (p: { id: string; request_id: string }, at = new Date().toISOString()) =>
  call("POST", `/contacts/${p.id}/confirm`, { request_id: p.request_id, confirmed_at: at });

it("confirms only the matching pending request and preserves names, creation time, properties and topic choices", async () => {
  const p = await pending(),
    before = await read(p.id),
    at = new Date().toISOString();
  expect(before?.unsubscribed).toBe(true); // It has never been active.
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Kept choice", defaultSubscribed: true })
    .returning();
  if (!topic) throw new Error("Topic fixture missing");
  const [choice] = await db
    .insert(schema.contactTopicSubscriptions)
    .values({ contactId: p.id, topicId: topic.id, subscribed: false })
    .returning();
  expect((await confirm(p, at)).status).toBe(200);
  const after = await read(p.id);
  expect(after).toMatchObject({
    unsubscribed: false,
    firstName: before?.firstName,
    createdAt: before?.createdAt,
  });
  expect(after?.properties).toMatchObject({
    ...before?.properties,
    canvas_newsletter_state: "confirmed",
    canvas_newsletter_confirmed_email: p.email,
    canvas_newsletter_confirmed_at: at,
    canvas_newsletter_confirmation_method: "double_opt_in",
  });
  expect((await confirm(p, at)).status).toBe(200);
  const activities = await db
    .select()
    .from(schema.contactActivities)
    .where(
      and(
        eq(schema.contactActivities.contactId, p.id),
        eq(schema.contactActivities.type, "resubscribed"),
      ),
    );
  expect(activities).toHaveLength(1);
  expect(
    await db
      .select()
      .from(schema.contactTopicSubscriptions)
      .where(eq(schema.contactTopicSubscriptions.contactId, p.id)),
  ).toEqual([choice]);
});
it("explicitly unsubscribing a never-active pending contact invalidates its old confirmation", async () => {
  const p = await pending();
  expect((await read(p.id))?.unsubscribed).toBe(true);
  expect((await call("PATCH", `/contacts/${p.id}`, { unsubscribed: true })).status).toBe(200);
  const withdrawn = await read(p.id);
  expect(withdrawn?.properties.canvas_newsletter_state).toBe("cancelled");
  expect(withdrawn?.properties.canvas_newsletter_doi_revoked_at).toBeTruthy();
  expect((await confirm(p)).status).toBe(409);
  expect((await read(p.id))?.unsubscribed).toBe(true);
});
for (const reason of ["one_click_unsubscribe", "hard_bounce", "complaint", "manual"] as const)
  it(`never removes a ${reason} suppression`, async () => {
    const p = await pending();
    const [block] = await db
      .insert(schema.suppressions)
      .values({ teamId, email: p.email, emailHash: hashRecipient(p.email), reason })
      .returning();
    expect((await confirm(p)).status).toBe(409);
    if (!block) throw new Error("Suppression fixture missing");
    expect(
      await db.select().from(schema.suppressions).where(eq(schema.suppressions.id, block.id)),
    ).toEqual([block]);
    expect((await read(p.id))?.unsubscribed).toBe(true);
  });
it("rejects wrong request, missing pending state, expired requests, future or predating timestamps and foreign-team access", async () => {
  const p = await pending();
  expect((await confirm({ ...p, request_id: randomUUID() })).status).toBe(409);
  expect((await confirm(p, new Date(Date.now() + 60000).toISOString())).status).toBe(422);
  expect((await confirm(p, new Date(Date.now() - 60000).toISOString())).status).toBe(422);
  const other = await createTeam(db, "doi-other");
  const [foreign] = await db
    .insert(schema.contacts)
    .values({ teamId: other, email: p.email, unsubscribed: true })
    .returning();
  if (!foreign) throw new Error("Foreign fixture missing");
  expect((await confirm({ ...p, id: foreign.id })).status).toBe(404);
  const row = await read(p.id);
  if (!row) throw new Error("Pending fixture missing");
  await db
    .update(schema.contacts)
    .set({
      properties: {
        ...row.properties,
        canvas_newsletter_doi_requested_at: new Date(Date.now() - 25 * 3600000).toISOString(),
      },
    })
    .where(eq(schema.contacts.id, p.id));
  expect((await confirm(p)).status).toBe(409);
  expect((await read(p.id))?.unsubscribed).toBe(true);
});
it("an already active historical contact is not stamped with invented DOI evidence", async () => {
  const p = await pending();
  await db
    .update(schema.contacts)
    .set({ unsubscribed: false, properties: { original: "kept" } })
    .where(eq(schema.contacts.id, p.id));
  const before = await read(p.id);
  expect((await confirm(p)).status).toBe(409);
  expect(await read(p.id)).toEqual(before);
});
it("two concurrent confirmations produce a single activation event", async () => {
  const p = await pending(),
    at = new Date().toISOString();
  const result = await Promise.all([confirm(p, at), confirm(p, at)]);
  expect(result.map((x) => x.status)).toEqual([200, 200]);
  const rows = await db
    .select()
    .from(schema.contactActivities)
    .where(
      and(
        eq(schema.contactActivities.contactId, p.id),
        eq(schema.contactActivities.type, "resubscribed"),
      ),
    );
  expect(rows).toHaveLength(1);
});
it("concurrent withdrawal and confirmation finish unsubscribed and the old token cannot reactivate", async () => {
  const p = await pending();
  await Promise.all([confirm(p), call("PATCH", `/contacts/${p.id}`, { unsubscribed: true })]);
  expect((await read(p.id))?.unsubscribed).toBe(true);
  expect((await confirm(p)).status).toBe(409);
});
it("requires a full-access authenticated key", async () => {
  const p = await pending();
  expect(
    (
      await call(
        "POST",
        `/contacts/${p.id}/confirm`,
        { request_id: p.request_id, confirmed_at: new Date().toISOString() },
        "invalid",
      )
    ).status,
  ).toBe(401);
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "sending-only",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    permission: "sending_access",
  });
  expect(
    (
      await call(
        "POST",
        `/contacts/${p.id}/confirm`,
        { request_id: p.request_id, confirmed_at: new Date().toISOString() },
        key.token,
      )
    ).status,
  ).toBe(403);
});
