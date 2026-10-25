import { type SQLWrapper, sql } from "drizzle-orm";

/** Pending is not an opt-out. Explicit withdrawal invalidates the open DOI request. */
export function hasPendingDoi(properties: Readonly<Record<string, string>>): boolean {
  return (
    properties.canvas_newsletter_state === "pending" &&
    Boolean(properties.canvas_newsletter_doi_request_id)
  );
}

/** Evaluated against the row being written, including a concurrent confirmation. */
export function revokePendingDoiProperties(properties: SQLWrapper, at = new Date()) {
  const marker = JSON.stringify({
    canvas_newsletter_state: "cancelled",
    canvas_newsletter_doi_revoked_at: at.toISOString(),
  });
  return sql`case when ${properties}->>'canvas_newsletter_state' = 'pending'
    and coalesce(${properties}->>'canvas_newsletter_doi_request_id', '') <> ''
    then ${properties} || ${marker}::jsonb else ${properties} end`;
}
