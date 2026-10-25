# Guarded newsletter confirmation

This Canvas deployment adds `POST /contacts/{id}/confirm` for the newsletter
backend. It requires the same full-access API authentication as other contact
writes. The mailbox backend, not a public caller, validates the single-use link
before submitting `request_id` and `confirmed_at`.

The contact must still be inactive and carry the matching
`canvas_newsletter_doi_request_id`, `canvas_newsletter_doi_requested_at` and
`canvas_newsletter_state=pending`. The request expires after 24 hours.
Confirmation checks every suppression, preserves every suppression row, and
records the confirmed address, time and `double_opt_in` method while activating.
It updates no names, original timestamps, topics or segment memberships.
Repeated confirmation of the same receipt is idempotent.

Pending contacts start with `unsubscribed=true`; this flag alone cannot express
a later withdrawal. Explicit `PATCH unsubscribed:true` of a pending DOI contact
and the hosted global unsubscribe path therefore cancel its pending request
and record `canvas_newsletter_doi_revoked_at`, even if it has never been active.
An old link cannot override that withdrawal. Contacts without a pending DOI
binding retain their existing behavior.

The generic `PATCH unsubscribed:false` behavior remains available to existing
clients. The newsletter backend deliberately does not use it, because it also
clears a retained unsubscribe suppression.

The implementation is based on the currently deployed revision
`09a829fed059ea0698c0487bbe598b2045665b8d`; deploying it does not require a
database migration or an unrelated upstream upgrade.

Tests cover all suppression origins, pending versus explicitly withdrawn,
existing consent and topic choices, expired/wrong requests, tenant/key scope,
idempotency and simultaneous confirmation/withdrawal. The API suite normally
uses PGlite and can also run against a fresh isolated local PostgreSQL database
named `newsletter_doi_test` using `DOI_POSTGRES_TEST_URL` and `DATABASE_URL`.
