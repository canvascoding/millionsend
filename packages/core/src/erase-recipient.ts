import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type AnyColumn, and, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { purgedEmailBodyColumns } from "./email-retention.js";
import { extractAddrSpec, hashRecipient, normalizeAddress } from "./suppressions.js";

/** Replaces every erased copy of an address so readers see a deliberate gap, not a blank. */
export const ERASED_TOMBSTONE = "[erased]";

/** Escapes a literal for use inside a regular expression, PostgreSQL (ARE) or JavaScript. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface EraseRecipientResult {
  emails: number;
  events: number;
  deliveries: number;
  apiRequests: number;
  suppressions: number;
}

/**
 * Cross-table erasure of one recipient address within a team (GDPR/LGPD
 * erasure request). Suppressions keep their hash so do-not-contact keeps
 * working; every plaintext copy is tombstoned or deleted: recipient lists on
 * emails, provider event payloads, webhook payloads and responses, and API
 * request logs. The caller removes the contact row itself. Idempotent.
 */
export async function eraseRecipient(
  db: Db,
  teamId: string,
  address: string,
): Promise<EraseRecipientResult> {
  return db.transaction((tx) => eraseRecipientTransaction(tx as unknown as Db, teamId, address));
}

async function eraseRecipientTransaction(
  db: Db,
  teamId: string,
  address: string,
): Promise<EraseRecipientResult> {
  const addr = normalizeAddress(extractAddrSpec(address));
  const plain = escapeRegex(addr);
  // Whole JSON string values that mention the address collapse to the
  // tombstone (display names and diagnostics quoting it go too). The class
  // excludes quotes and backslashes, so the rewritten text always re-parses
  // as jsonb.
  const json = `"[^"\\\\]*${plain}[^"\\\\]*"`;
  const jsonTombstone = `"${ERASED_TOMBSTONE}"`;
  const scrubJson = (column: AnyColumn): SQL =>
    sql`regexp_replace(${column}::text, ${json}, ${jsonTombstone}, 'gi')::jsonb`;

  const e = schema.emails;
  const mentions = or(
    sql`${e.to}::text ~* ${json}`,
    sql`${e.cc}::text ~* ${json}`,
    sql`${e.bcc}::text ~* ${json}`,
    sql`${e.replyTo}::text ~* ${json}`,
  );
  const teamEmailsMentioning = db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.teamId, teamId), mentions));
  // Serialize with send claims and provider-event writes. Rows already
  // handed off cannot be recalled; a still-unclaimed queued row is canceled.
  await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.teamId, teamId), mentions))
    .orderBy(e.id)
    .for("update");

  // Events first: their scope is derived from the recipient lists that the
  // emails update below tombstones. An open or click carries the fetcher's
  // IP and user agent — personal data on their own — so those keys go too,
  // and such rows are selected even though they never mention the address.
  const ev = schema.emailEvents;
  const events = await db
    .update(ev)
    .set({
      // Provider payloads can contain the person's name in subjects or
      // diagnostics without repeating the address. Keep outcome metadata only.
      data: null,
    })
    .where(and(inArray(ev.emailId, teamEmailsMentioning), isNotNull(ev.data)))
    .returning({ id: ev.id });

  // Scoped by endpoint, not email: test deliveries have no email_id, and a
  // purged email leaves its id dangling (no foreign key).
  const d = schema.webhookDeliveries;
  const wh = schema.webhookEndpoints;
  const teamEndpoints = db.select({ id: wh.id }).from(wh).where(eq(wh.teamId, teamId));
  // Contact events carry the name beside the address; a name alone is still
  // personal data, so it leaves with the address.
  const contactPayload = sql`lower(${d.payload}->'data'->>'email') = ${addr}`;
  const withoutNames = sql`case when ${contactPayload} then ${d.payload} #- '{data,first_name}' #- '{data,last_name}' else ${d.payload} end`;
  // Engagement payloads name the recipient in `to`, so the address match
  // already selects them; the fetcher keys leave the same way as on events.
  const withoutFetcherPayload = sql`(${withoutNames}) #- '{data,open,ipAddress}' #- '{data,open,userAgent}' #- '{data,click,ipAddress}' #- '{data,click,userAgent}'`;
  const deliveries = await db
    .update(d)
    .set({
      payload: sql`regexp_replace(((${withoutFetcherPayload}) #- '{data,subject}' #- '{data,tags}' #- '{data,bounce,diagnostic_code}')::text, ${json}, ${jsonTombstone}, 'gi')::jsonb`,
      lastResponseBody: null,
    })
    .where(
      and(
        inArray(d.endpointId, teamEndpoints),
        or(
          inArray(d.emailId, teamEmailsMentioning),
          sql`${d.payload}::text ~* ${json}`,
          sql`${d.lastResponseBody} ~* ${plain}`,
        ),
      ),
    )
    .returning({ id: d.id });

  const emails = await db
    .update(e)
    .set({
      to: scrubJson(e.to),
      cc: scrubJson(e.cc),
      bcc: scrubJson(e.bcc),
      replyTo: scrubJson(e.replyTo),
      ...purgedEmailBodyColumns(new Date()),
      subject: ERASED_TOMBSTONE,
      headers: null,
      tags: null,
      latestStatus: sql`case when ${e.latestStatus} in ('queued','queued_quota') and ${e.sentAt} is null then 'canceled'::email_status else ${e.latestStatus} end`,
    })
    .where(and(eq(e.teamId, teamId), mentions))
    .returning({ id: e.id });

  const r = schema.apiRequests;
  const apiRequests = await db
    .delete(r)
    .where(
      and(
        eq(r.teamId, teamId),
        or(
          sql`${r.path} ~* ${plain}`,
          sql`${r.path} ~* ${escapeRegex(encodeURIComponent(addr))}`,
          sql`${r.requestBody}::text ~* ${plain}`,
          sql`${r.responseBody}::text ~* ${plain}`,
        ),
      ),
    )
    .returning({ id: r.id });

  // Rows hashed before normalization existed still carry the plaintext, so
  // the address itself is matched alongside the current hash.
  const s = schema.suppressions;
  const suppressions = await db
    .update(s)
    .set({ email: null })
    .where(
      and(
        eq(s.teamId, teamId),
        isNotNull(s.email),
        or(eq(s.emailHash, hashRecipient(addr)), sql`lower(${s.email}) = ${addr}`),
      ),
    )
    .returning({ id: s.id });

  return {
    emails: emails.length,
    events: events.length,
    deliveries: deliveries.length,
    apiRequests: apiRequests.length,
    suppressions: suppressions.length,
  };
}
