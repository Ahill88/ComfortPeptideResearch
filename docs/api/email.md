# Email service (outbox, worker, providers)

Contract: `docs/api/commerce-contract.md` section 1. Code: `apps/api/src/email/**`. Port: `EMAIL_PORT` (`EmailPort.enqueue`), bound to
`EmailService` by the `@Global()` `EmailModule`, so any module injects it without importing the module:

```ts
constructor(@Inject(EMAIL_PORT) private readonly email: EmailPort) {}
await this.email.enqueue({ to, template: 'password_reset', data: { link }, dedupeKey: `password_reset:${tokenId}` });
```

## What enqueue does

`enqueue({ to, template, data, dedupeKey? })` validates, inserts ONE `EmailOutbox` row (`PENDING`) and returns. It never contacts a provider,
so a provider outage cannot reach the caller.

- Idempotent on `dedupeKey` (unique column). A duplicate insert (Postgres `P2002`, also under parallel calls) is success and the first row
  wins. Without a `dedupeKey` every call makes a row.
- Invalid input throws `EmailValidationError` (a caller bug; its message names the field, never the address or a value). Callers that must
  answer identically for every input (register, password reset) must validate the address and name before enqueueing.
- A database failure other than the duplicate is NOT swallowed (the message was not recorded).
- Validation: address is ASCII RFC-ish `local@domain.tld`, at most 254 chars, no whitespace/CR/LF/controls/quotes/angle brackets/commas (no
  trimming is attempted); template must be one of the four; data keys are exact per template (unknown keys are refused, not stored); every
  header-ish or single-line value (`name`, `carrier`, `trackingNumber`, `orderId`, `dedupeKey`) rejects CR/LF and other controls.
- Links (`link`, `trackingUrl`) must be http(s) URLs without credentials, at most 2048 chars, without quotes, angle brackets, backslashes or
  whitespace. `javascript:`, `data:`, relative and protocol-relative values are refused. Origin pinning to `STOREFRONT_PUBLIC_URL` is NOT
  enforced here (the brief allows any http(s) URL): callers must build links from the env value, never from a request header. The helper
  `buildStorefrontLink('verify-email' | 'reset-password', token)` returns `<STOREFRONT_PUBLIC_URL>/verify-email?token=...` (token
  URL-encoded) or `null` when the env is unset.

### Templates and data keys

| template | data | subject |
|---|---|---|
| `email_verification` | `{ link, name? }` | Confirm your email address |
| `password_reset` | `{ link }` | Reset your password |
| `order_confirmation` | `{ orderId, totalCents (int >= 0, Int32), currency (3 upper-case letters) }` | Order confirmation `<orderId>` |
| `order_shipped` | `{ orderId, carrier, trackingNumber, trackingUrl \| null }` | Order `<orderId>` has shipped |

`orderId` must match `[A-Za-z0-9_-]{1,64}` (it appears in the subject). Templates are pure functions in `email.templates.ts` returning
`{ subject, text, html }`: plain semantic HTML, no images, no tracking pixels, no scripts, no remote resources; every interpolated value
is HTML-escaped; links are shown as an anchor AND as visible text; money is formatted from integer cents with integer arithmetic; the
footer states the research-use-only, not-for-human-or-veterinary-use notice; no product, purity, efficacy or guarantee claims. Verification
and reset links are described as "single-use and time-limited" (no number is promised in the copy).

## Worker

`EmailWorker` polls every `EMAIL_WORKER_INTERVAL_MS` (default 5000; `0` disables; otherwise 100 to 3600000). A pass sends up to 25 rows
sequentially (120 s budget) and never overlaps itself.

- **Claiming (multi-instance safe, no schema change).** A claim is a compare-and-set
  `UPDATE ... WHERE id AND status AND attempts AND nextAttemptAt` that sets `SENDING`, `attempts + 1` and the lease expiry in
  `nextAttemptAt` (now + 5 min). Of two instances racing for a row exactly one update matches. Completion is a second compare-and-set on
  the same fingerprint, so an instance that lost its lease cannot overwrite the new owner's result (it logs that it was too late).
- **Stale rows.** A `SENDING` row whose lease expired (worker crashed or hung) is claimable again; the reclaim counts as an attempt. A
  stale row that already used attempt 8 is marked `FAILED` instead of being sent a ninth time.
- **Backoff** after failed attempt 1, 2, 3, 4, 5+: 30 s, 2 m, 10 m, 1 h, 6 h (6 h repeats). Maximum 8 attempts, then `FAILED` with
  `lastError`. A provider `Retry-After` can lengthen (never shorten) the delay (capped at 6 h).
- **Permanent failures.** A stored row that no longer validates is `FAILED` without calling the provider.
- **Redaction.** `lastError` and every log line pass through `redactText`: the configured key, `Bearer` values, `re_...` keys, `token=`-style
  parameters, URL query strings, email addresses, long token-shaped strings and control characters are removed, length is capped at 300.
  The row's own recipient, link and link parameters are also removed. Log lines never contain the recipient address or the subject.
- **Credential links are scrubbed after sending.** When an `email_verification` or `password_reset` row becomes `SENT`, its `data` is
  replaced with `{ "removedAfterSend": true }` so one-time links do not sit in the table for the 90-day retention window. `FAILED` rows keep
  their data so an owner can retry.
- **Retention.** The sweep (at most hourly) deletes `SENT` rows whose `sentAt` is older than 90 days. Nothing else is deleted.
- With a single instance the same code is simply uncontended. The timer is `unref`'d and cleared on shutdown.

## Providers (`EMAIL_PROVIDER`)

| value | when | behaviour |
|---|---|---|
| `console` | default when `NODE_ENV` is exactly `development` or `test` | logs ONE line per message: `template`, recipient domain, outbox id. In development/test it also writes the full rendered message to `${EMAIL_DEV_OUTBOX_DIR:-/tmp/helix-dev-mail}/<id>.txt` (dir 0700, files 0600, newest 200 kept) so a developer can open links. Files are NEVER written in any other runtime, even if `console` is chosen explicitly. |
| `none` | default in every other runtime (production, unset, unknown `NODE_ENV`) | `enqueue` still stores rows; the worker logs one loud warning ("NO EMAIL WILL BE SENT"), claims nothing and leaves rows `PENDING`. |
| `resend` | explicit | Resend REST API, see below. Requires `EMAIL_API_KEY` and `EMAIL_FROM`. |

Startup validation (`loadEmailConfig`, run when the module is built) stops the API with a clear `EmailConfigError` for: unknown
`EMAIL_PROVIDER`; `resend` without `EMAIL_API_KEY` or `EMAIL_FROM`; an `EMAIL_FROM` that is not `a@example.com` or `Name <a@example.com>`;
a bad `EMAIL_WORKER_INTERVAL_MS`; a non-http(s) `STOREFRONT_PUBLIC_URL`. Messages name variables, never values.
An explicit `EMAIL_PROVIDER=console` in a production-like runtime is accepted (it only logs the redacted line and marks rows `SENT`, so it
delivers nothing); do not use it to go live.

To add a provider implement `EmailProvider { name; send(OutboundEmail): Promise<SendResult> }` (`email.provider.ts`) and extend
`createEmailProvider`. Return `{ ok: false, retryable, error }` rather than throwing; a throw is treated as retryable.

### Resend: what was verified against the docs

Fetched on 2026-10-21 from https://resend.com/docs/api-reference/emails/send-email and https://resend.com/docs/api-reference/errors:

- Endpoint: `POST https://api.resend.com/emails` (from the page's cURL example).
- Auth: `Authorization: Bearer <key>`; `Content-Type: application/json`.
- Body: required `from` (`Name <a@b.co>` allowed), `to` (string or array, max 50), `subject`; optional `html`, `text`. We send
  `{ from, to: [to], subject, text, html }`.
- Idempotency: header `Idempotency-Key`, unique per API request, expires after 24 hours, max 256 chars. We send
  `helix-email-<outbox id>`, identical on every retry of a row (the retry schedule's total span, about 19 h before attempt 8, stays inside the
  24 h window). Re-using a key with a different body returns 409 `invalid_idempotent_request`; our rendering is deterministic.
- Success: HTTP 200 `{ "id": "<uuid>" }`, stored as `providerMessageId`.
- Errors used for classification: 400/401/403/404/422 (`validation_error`, `missing_api_key`, `restricted_api_key`,
  invalid key, unverified domain, `missing_required_field`, ...), 409 (`concurrent_idempotent_requests`, `invalid_idempotent_request`, `resource_locked`),
  429 (`rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded`), 500 `application_error`, 503 `service_unavailable`.

Classification: 2xx sent. **429, 5xx, network error, timeout: retry.** **Every other 4xx: `FAILED` permanently** with the provider message
redacted. Two deliberate deviations from "all 4xx permanent", because Resend documents them as transient: 408 and 409
`concurrent_idempotent_requests` / `resource_locked` are retried. Timeout is 10 s (abort), redirects are never followed (the
`Authorization` header must not leave the host).

**Not verified: no real Resend call was made** (no key is available). The request shape, headers and error handling are asserted
against a fake `fetch` only. Domain verification, sender reputation and real delivery are untested.

## Admin visibility (OWNER, `AdminSessionGuard`, `Cache-Control: no-store`)

- `GET /v1/admin/email/outbox?status=&limit=50&cursor=` (status one of PENDING, SENDING, SENT, FAILED; limit 1 to 100) returns
  `{ items: [{ id, toDomain, template, status, attempts, lastError | null, createdAt, sentAt | null }], nextCursor }`, newest first, keyset
  cursor on `(createdAt, id)`. The full address, data, links and bodies are never returned. A malformed cursor, status or limit is 400.
- `POST /v1/admin/email/outbox/:id/retry` moves a `FAILED` row to `PENDING`, resets `attempts`, clears `lastError` and makes it due now
  (conditional update). Not `FAILED`: 409. Unknown id: 404. Audit event `email.retry` (`targetType: email_outbox`, detail `{ template }`).
- No token: 401. `STAFF`: 403 on both routes.

## Environment

| variable | meaning |
|---|---|
| `EMAIL_PROVIDER` | `console` \| `resend` \| `none`; blank = default per runtime (above) |
| `EMAIL_API_KEY` | Resend key (required for `resend`); never logged, never in an error; keep blank in `.env.example` |
| `EMAIL_FROM` | sender, `a@example.com` or `Name <a@example.com>`, on a Resend-verified domain |
| `EMAIL_WORKER_INTERVAL_MS` | 0 disables the worker; 100 to 3600000; default 5000 |
| `EMAIL_DEV_OUTBOX_DIR` | development/test only; default `/tmp/helix-dev-mail` |
| `STOREFRONT_PUBLIC_URL` | http(s) origin callers use to build links |

## Tests

`apps/api/src/email/__tests__`: unit suites use a fake provider, injected clock and an in-memory outbox double; `email.integration.test.ts`
needs `TEST_DATABASE_URL` (own schema) and covers 10-way parallel enqueue idempotency, two worker instances on separate connection pools
claiming each row once, backoff on Postgres, stale-lease reclaim, lease-loss compare-and-set, retention and the admin endpoints with the real
guard. Run: `TEST_DATABASE_URL=<your schema> node tests/run-all.mjs email`.
