import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { encryptEmailBody } from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { eraseRecipient } from "../src/erase-recipient.js";
import { hashRecipient } from "../src/suppressions.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let otherTeamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "erase-team");
  otherTeamId = await createTeam(db, "other-team");
});
afterAll(() => close());

it.each(["queued", "queued_quota", "sent"] as const)(
  "erases sealed content and unstructured metadata and prevents an unclaimed %s send",
  async (status) => {
    const address = `erase-${status}@example.com`;
    const id = await seedEmail(teamId, [address, "another@example.com"]);
    const foreign = await seedEmail(otherTeamId, [address]);
    const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
    const body = await encryptEmailBody(
      { html: `<p>Private name ${address}</p>`, text: address },
      keyring,
      { teamId, rowId: id },
    );
    await db
      .update(schema.emails)
      .set({
        subject: `Private name ${address}`,
        headers: { "X-Private": address },
        tags: { person: address },
        bodyCiphertext: body.ciphertext,
        bodyIv: body.iv,
        bodyWrappedDek: body.wrappedDek,
        bodyKeyVersion: body.keyVersion,
        attachments: "sealed attachment",
        media: "sealed review",
        latestStatus: status,
        sentAt: status === "sent" ? new Date() : null,
      })
      .where(eq(schema.emails.id, id));
    await eraseRecipient(db, teamId, address);
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row?.to).toEqual(["[erased]", "another@example.com"]);
    expect(row?.subject).toBe("[erased]");
    for (const field of [
      "headers",
      "tags",
      "bodyCiphertext",
      "bodyIv",
      "bodyWrappedDek",
      "bodyKeyVersion",
      "attachments",
      "media",
    ] as const)
      expect(row?.[field]).toBeNull();
    expect(row?.bodyPurgedAt).toBeInstanceOf(Date);
    expect(row?.latestStatus).toBe(status === "sent" ? "sent" : "canceled");
    const [untouched] = await db.select().from(schema.emails).where(eq(schema.emails.id, foreign));
    expect(untouched?.to).toEqual([address]);
    expect((await eraseRecipient(db, teamId, address)).emails).toBe(0);
  },
);

const ADDRESS = "bob@example.com";

async function seedEmail(team: string, to: string[], cc?: string[]): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId: team, from: "a@acme.dev", to, cc: cc ?? null, subject: "s" })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

it("tombstones every copy of the address for the team, keeps the suppression hash, and is idempotent", async () => {
  const emailId = await seedEmail(
    teamId,
    [`Bob <${ADDRESS}>`, "keep@example.com"],
    ["BOB@Example.com"],
  );
  const untouched = await seedEmail(teamId, ["keep@example.com"]);
  const foreign = await seedEmail(otherTeamId, [ADDRESS]);
  await db.insert(schema.emailEvents).values({
    emailId,
    type: "bounced",
    occurredAt: new Date(),
    data: {
      eventType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: ADDRESS, diagnosticCode: `550 <${ADDRESS}> no` }],
      },
    },
  });
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hooks.example.com",
      secretCiphertext: Buffer.from("c"),
      secretIv: Buffer.from("i"),
      secretWrappedDek: Buffer.from("d"),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("insert failed");
  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      emailId: null,
      messageId: "msg_1",
      eventType: "email.bounced",
      payload: { type: "email.bounced", data: { to: [ADDRESS], subject: "s" } },
      lastResponseBody: `stored ${ADDRESS} ok`,
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!delivery) throw new Error("insert failed");
  await db.insert(schema.suppressions).values([
    { teamId, email: ADDRESS, emailHash: hashRecipient(ADDRESS), reason: "hard_bounce" },
    {
      teamId,
      email: "keep@example.com",
      emailHash: hashRecipient("keep@example.com"),
      reason: "manual",
    },
  ]);
  await db.insert(schema.apiRequests).values([
    { teamId, method: "DELETE", path: `/contacts/${ADDRESS}`, statusCode: 200 },
    { teamId, method: "POST", path: "/emails", statusCode: 200, requestBody: { to: [ADDRESS] } },
    {
      teamId,
      method: "GET",
      path: "/emails",
      statusCode: 200,
      responseBody: { to: ["keep@example.com"] },
    },
  ]);

  const result = await eraseRecipient(db, teamId, ` ${ADDRESS.toUpperCase()} `);
  expect(result).toEqual({ emails: 1, events: 1, deliveries: 1, apiRequests: 2, suppressions: 1 });

  const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(email?.to).toEqual(["[erased]", "keep@example.com"]);
  expect(email?.cc).toEqual(["[erased]"]);
  expect(email?.bcc).toBeNull();
  const [event] = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(event?.data).toBeNull();
  const [d] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  expect(d?.payload).toEqual({ type: "email.bounced", data: { to: ["[erased]"] } });
  expect(d?.lastResponseBody).toBeNull();
  const suppressions = await db
    .select({ email: schema.suppressions.email, emailHash: schema.suppressions.emailHash })
    .from(schema.suppressions)
    .where(eq(schema.suppressions.teamId, teamId));
  expect(suppressions).toEqual(
    expect.arrayContaining([
      { email: null, emailHash: hashRecipient(ADDRESS) },
      { email: "keep@example.com", emailHash: hashRecipient("keep@example.com") },
    ]),
  );
  const requests = await db.select({ path: schema.apiRequests.path }).from(schema.apiRequests);
  expect(requests).toEqual([{ path: "/emails" }]);

  const [keep] = await db.select().from(schema.emails).where(eq(schema.emails.id, untouched));
  expect(keep?.to).toEqual(["keep@example.com"]);
  const [foreignRow] = await db.select().from(schema.emails).where(eq(schema.emails.id, foreign));
  expect(foreignRow?.to).toEqual([ADDRESS]);

  expect(await eraseRecipient(db, teamId, ADDRESS)).toEqual({
    emails: 0,
    events: 0,
    deliveries: 0,
    apiRequests: 0,
    suppressions: 0,
  });
});

it("drops the contact's name from contact event payloads along with the address", async () => {
  const address = "carla@example.com";
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://example.com/hooks/erase",
      secretCiphertext: Buffer.alloc(1),
      secretIv: Buffer.alloc(1),
      secretWrappedDek: Buffer.alloc(1),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("endpoint insert failed");
  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      messageId: "msg_erase_contact",
      eventType: "contact.created",
      payload: {
        type: "contact.created",
        data: { id: "c1", email: address, first_name: "Carla", last_name: "Souza", source: "api" },
      },
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!delivery) throw new Error("delivery insert failed");

  await eraseRecipient(db, teamId, address);

  const [after] = await db
    .select({ payload: schema.webhookDeliveries.payload })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  expect(after?.payload).toEqual({
    type: "contact.created",
    data: { id: "c1", email: "[erased]", source: "api" },
  });
});

it("drops the fetcher's address and user agent from open and click events and their payloads", async () => {
  const emailId = await seedEmail(teamId, [ADDRESS]);
  const at = "2026-09-05T12:00:00.000Z";
  await db.insert(schema.emailEvents).values([
    {
      emailId,
      type: "opened",
      occurredAt: new Date(),
      data: {
        open: { ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone)", timestamp: at },
      },
    },
    {
      emailId,
      type: "clicked",
      occurredAt: new Date(),
      data: {
        click: {
          link: "https://example.com/",
          ipAddress: "203.0.113.9",
          userAgent: "Mozilla/5.0 (iPhone)",
          timestamp: at,
        },
      },
    },
  ]);
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hooks.example.com",
      secretCiphertext: Buffer.from("c"),
      secretIv: Buffer.from("i"),
      secretWrappedDek: Buffer.from("d"),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("insert failed");
  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      emailId,
      messageId: "msg_open",
      eventType: "email.opened",
      payload: {
        type: "email.opened",
        data: {
          to: [ADDRESS],
          open: { ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone)", timestamp: at },
        },
      },
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!delivery) throw new Error("insert failed");

  const result = await eraseRecipient(db, teamId, ADDRESS);
  expect(result.events).toBe(2);

  const events = await db
    .select({ type: schema.emailEvents.type, data: schema.emailEvents.data })
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events.find((e) => e.type === "opened")?.data).toBeNull();
  expect(events.find((e) => e.type === "clicked")?.data).toBeNull();
  const [d] = await db
    .select({ payload: schema.webhookDeliveries.payload })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  expect(d?.payload).toEqual({
    type: "email.opened",
    data: { to: ["[erased]"], open: { timestamp: at } },
  });
});
