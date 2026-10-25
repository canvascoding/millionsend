import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CONTACT_PROPERTY_MAX_KEYS,
  type ContactEventContext,
  contactSnapshotColumns,
  emitContactEvents,
  recordContactActivity,
  suppressionHashesFor,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { coerceContactProperties, type Env, errorBody, loadContactPropertyTypes } from "../app.js";
import { errorSchema } from "../schemas.js";

/** The caller verifies possession of a single-use mailbox token before calling. */
export function registerContactConfirmationRoutes(
  app: OpenAPIHono<Env>,
  db: Db,
  events: ContactEventContext,
) {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  app.openapi(
    createRoute({
      method: "post",
      path: "/contacts/{id}/confirm",
      description:
        "Confirm a matching pending double-opt-in request without removing any suppression. Historical consent is never inferred.",
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  request_id: z.uuid(),
                  confirmed_at: z.iso.datetime({ offset: true }),
                })
                .strict(),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ id: z.uuid(), status: z.literal("confirmed") }),
            },
          },
          description: "Confirmed or already confirmed by this request",
        },
        404: jsonErr("Contact not found"),
        409: jsonErr("Request changed, revoked, expired or suppressed"),
        422: jsonErr("Invalid confirmation evidence"),
      },
    }),
    async (c) => {
      const auth = c.get("auth"),
        id = c.req.valid("param").id,
        input = c.req.valid("json");
      const at = new Date(input.confirmed_at),
        now = new Date(),
        t = schema.contacts,
        s = schema.suppressions;
      const types = await loadContactPropertyTypes(db, auth.teamId);
      const result = await db.transaction(async (tx) => {
        const [contact] = await tx
          .select()
          .from(t)
          .where(and(eq(t.id, id), eq(t.teamId, auth.teamId)))
          .for("update");
        if (!contact) return { kind: "missing" } as const;
        const p = contact.properties,
          requestedAt = new Date(p.canvas_newsletter_doi_requested_at ?? "");
        if (
          !Number.isFinite(requestedAt.getTime()) ||
          p.canvas_newsletter_doi_request_id !== input.request_id
        )
          return { kind: "conflict" } as const;
        const hashes = suppressionHashesFor(contact.email);
        const [block] = await tx
          .select({ id: s.id })
          .from(s)
          .where(and(eq(s.teamId, auth.teamId), inArray(s.emailHash, hashes)))
          .limit(1);
        if (block) return { kind: "conflict" } as const;
        if (
          !contact.unsubscribed &&
          p.canvas_newsletter_state === "confirmed" &&
          p.canvas_newsletter_confirmed_email === contact.email &&
          p.canvas_newsletter_confirmed_at === at.toISOString()
        )
          return { kind: "confirmed", changed: false, contact } as const;
        const revokedAt = new Date(p.canvas_newsletter_doi_revoked_at ?? "");
        if (
          !contact.unsubscribed ||
          p.canvas_newsletter_state !== "pending" ||
          (Number.isFinite(revokedAt.getTime()) && revokedAt >= requestedAt) ||
          now.getTime() >= requestedAt.getTime() + 24 * 60 * 60 * 1000
        )
          return { kind: "conflict" } as const;
        if (
          at < requestedAt ||
          at > now ||
          at.getTime() >= requestedAt.getTime() + 24 * 60 * 60 * 1000
        )
          return { kind: "invalid" } as const;
        const proof = {
          canvas_newsletter_state: "confirmed",
          canvas_newsletter_confirmation_method: "double_opt_in",
          canvas_newsletter_confirmed_email: contact.email,
          canvas_newsletter_confirmed_at: at.toISOString(),
        };
        if (!coerceContactProperties(proof, types).ok) return { kind: "invalid" } as const;
        if (new Set([...Object.keys(p), ...Object.keys(proof)]).size > CONTACT_PROPERTY_MAX_KEYS)
          return { kind: "invalid" } as const;
        // Re-check every suppression at the write. Never clear a suppression.
        const [updated] = await tx
          .update(t)
          .set({
            unsubscribed: false,
            unsubscribedAt: null,
            updatedAt: now,
            properties: sql`${t.properties} || ${JSON.stringify(proof)}::jsonb`,
          })
          .where(
            and(
              eq(t.id, id),
              eq(t.teamId, auth.teamId),
              eq(t.unsubscribed, true),
              sql`${t.properties}->>'canvas_newsletter_state' = 'pending'`,
              sql`${t.properties}->>'canvas_newsletter_doi_request_id' = ${input.request_id}`,
              sql`not exists (select 1 from ${s} where ${s.teamId}=${auth.teamId} and ${inArray(s.emailHash, hashes)})`,
            ),
          )
          .returning(contactSnapshotColumns);
        return updated
          ? ({ kind: "confirmed", changed: true, contact: updated } as const)
          : ({ kind: "conflict" } as const);
      });
      if (result.kind === "missing")
        return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      if (result.kind === "conflict")
        return c.json(
          errorBody(409, "validation_error", "Confirmation request is no longer eligible"),
          409,
        );
      if (result.kind === "invalid")
        return c.json(errorBody(422, "validation_error", "Invalid confirmation evidence"), 422);
      if (result.changed) {
        await recordContactActivity(
          db,
          { teamId: auth.teamId, contactId: id, type: "resubscribed" },
          events,
        );
        await emitContactEvents(db, {
          teamId: auth.teamId,
          events: [{ type: "contact.updated", contact: result.contact }],
          ctx: events,
        });
      }
      return c.json({ id, status: "confirmed" as const }, 200);
    },
  );
}
