# Guarded newsletter confirmation

The authenticated newsletter backend stages mailbox requests with
`POST /contacts/confirmation-requests`. A contact stays inactive until the backend
has verified the mailbox token and submitted the matching, unexpired request to
`POST /contacts/{id}/confirm`. Native confirmation metadata is authoritative;
editable custom properties cannot manufacture confirmation.

By default, historical inactive contacts and all suppressions remain untouched.
An explicit fresh request with `allow_resubscribe:true` can stage an inactive
contact again. Only newsletter unsubscribe suppressions qualify: their exact IDs
are captured with the new request and remain in place until its confirmation.
The guarded confirmation transaction can then remove those exact unsubscribe
rows and activate the contact. Bounce, complaint, manual, erased or subsequently
changed suppressions are never cleared by this flow. No name, original creation
time, unrelated property, topic preference or segment membership is changed.

A later withdrawal cancels a pending request even when the contact has never
been active. Old, superseded, revoked and expired links cannot reactivate it.
Confirmation and suppression writers take a common address/contact lock order,
including when the contact does not exist yet. A new hard block takes precedence
over an older newsletter unsubscribe; re-adding the same block remains idempotent.
Suppression removal, confirmation and webhook outbox writes commit together;
worker wakeup happens after commit. An activation conflict rolls back removal.

The general `PATCH unsubscribed:false` operator action retains its prior behavior.
The storefront backend uses the guarded confirmation endpoint instead.
Its local evidence keeps each consent request and exact notice separately,
including the earlier withdrawal and the later fresh mailbox confirmation.

The fork includes upstream main plus these changes. Its nullable `confirmation`
JSONB column was introduced by migration `0063_lazy_scarecrow`; resubscription
adds metadata fields without another SQL migration. Tests exercise all block
origins, profile preservation, tenant/key scope, idempotency, renewal, expiry,
withdrawal, concurrent suppression writes and real PostgreSQL/SMTP delivery.
