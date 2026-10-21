# Customer accounts API (`/v1/auth`)

Implements section 2 of `docs/api/commerce-contract.md`. Code: `apps/api/src/auth/**`, identity resolver `apps/api/src/wallet/customer-identity.ts`.

## Session and cookie
- Login sets one cookie: `hf_session=<token>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax` plus `; Secure` in every runtime except exactly `NODE_ENV=development|test`.
  No `Domain` (host-only), no `Expires`. Logout and password reset clear it with `Max-Age=0; Expires=Thu, 01 Jan 1970 ...` and the same other attributes.
- Token: 32 random bytes, base64url (43 chars), shown only in the cookie. `CustomerSession.tokenHash` stores its SHA-256 hex. Idle limit 7 days (`lastSeenAt`, refreshed at most once a minute), absolute limit 30 days (`expiresAt`). Signing in again with a live cookie revokes that old session.
- Browsers must use `credentials: 'include'`. CORS now sends `Access-Control-Allow-Credentials: true` for the exact `STOREFRONT_ORIGIN` allow-list (never `*`).
- Every `/auth` response is `Cache-Control: no-store`. Error bodies are exactly `{message}` or `{code, message}`.

## CSRF
State-changing requests (anything but GET/HEAD/OPTIONS) need exactly one `Origin` header equal to an entry of `STOREFRONT_ORIGIN` (the CORS allow-list; an empty list refuses everything), else `403 {message:'Origin not allowed.'}`:
- every state-changing `/auth` route, with or without a cookie (`AuthRequestGuard`);
- every other request **identified by the session cookie** through the shared resolver. Requests identified by the dev/test `x-customer-email` header, and anonymous requests, are not subject to it.

## The shared identity resolver (wallet, checkout, orders, account)
`resolveRequestIdentity(req, env)` / `resolveRequestCustomer(req, lookup, env)` in `wallet/customer-identity.ts`:
1. development/test only: a present `x-customer-email` header decides (strict parse, unchanged). In every other runtime (`NODE_ENV` unset, empty, `staging`, `prod`, `Production`, `production`, `production `...) the header is never read.
2. any runtime: the customer of a valid `hf_session` cookie (`CustomerSessionMiddleware` attaches `req.customerSession`, discarding any client-supplied value). Unsafe methods then also need the Origin above.
3. otherwise 401.

`@CustomerEmail()` (wallet) and `SessionGuard` (account, eligibility) already use it. `readCustomerEmail` / `resolveHeaderCustomer` remain header-only for old callers. Callers that read `@Headers('x-customer-email')` themselves (the checkout controller today) do not see cookies until they switch to `resolveRequestCustomer(req, ...)`.
`/auth/*` itself accepts the cookie only (the dev header is not an `/auth` credential).

## Endpoints
| Route | Success | Failure |
|---|---|---|
| `POST /auth/register {email,password(12..256),name?}` | 202 `{message:'Check your email to verify your account.'}` (identical for new, existing and credentialed emails) | 400 validation `{message}`; 503 `Account email is not configured.` |
| `POST /auth/email-verification/confirm {token}` | 204 | 400 `Invalid or expired link.` |
| `POST /auth/login {email,password,totp?}` | 200 `{customer:{id,email,name,emailVerified:true,mfaEnabled}}` + cookie | 401 `{message:'Invalid sign-in.'}` for every failure; after a correct password only: 403 `{code:'EMAIL_NOT_VERIFIED',message:'Verify your email first.'}`, 401 `{code:'MFA_REQUIRED',message:'Enter your authentication code.'}` |
| `POST /auth/logout` | 204 always (idempotent), revokes, clears cookie | 403 on a bad Origin |
| `GET /auth/session` | 200 `{customer}` | 401 `{message:'Authentication required.'}` |
| `POST /auth/password-reset/request {email}` | 202 `{message:'If an account exists for that email, a reset link is on its way.'}` for every address | 400 bad email; 503 as register |
| `POST /auth/password-reset/confirm {token,newPassword}` | 204, revokes ALL sessions, clears lockout | 400 `Invalid or expired link.` (a weak password is a 400 policy message and does not consume the token) |
| `POST /auth/mfa/enroll` (session) | 201 `{otpauthUri, seedBase32}` (once) | 503 `MFA is not configured.`; 409 already enabled |
| `POST /auth/mfa/enroll/confirm {code}` | 204 | 400 `Invalid code.`; 409 |
| `POST /auth/mfa/disable {password,code}` | 204 | 403 `Invalid password or code.` (counts toward lockout); 409 not enabled |
| `GET/PATCH /auth/profile` (`{name}`) | 200 `{id,email,name,emailVerified,mfaEnabled}` | 400, 401 |
| `GET/POST /auth/addresses`, `PATCH/DELETE /auth/addresses/:id` | `{items:[Address]}` / 201 / 200 / 204 | 400, 404 `Address not found.` (also for another customer's), 409 over 20 |

Address = `{id,label|null,recipient,line1,line2|null,city,region,postalCode,country (ISO-2, upper-cased),isDefault}`. The first address is the default; `isDefault:true` on create/update moves the default; `isDefault:false` on the only default is ignored; deleting the default promotes the oldest remaining. Writes are serialised per customer with a row lock, so racing requests cannot exceed 20 or create two defaults.

## Registration without enumeration or takeover
- One response for every address. `register` always runs one scrypt hash (admin helpers, imported from `admin/auth/credentials.ts`), so timing does not depend on whether the address exists.
- Nothing is attached to a `Customer` row at registration. A missing row is created empty; an order-created row is left untouched (name included). The chosen password hash is parked in a `CustomerToken` row that can never validate as a token (created already used; its `tokenHash` column holds `pending:<verification-token-row-id>:<password hash>:<name>`). The schema has no payload column, and inventing a table was ruled out; this is the one deliberate stretch of an existing column.
- Confirming the verification token (single use, 24 h, SHA-256 only stored) attaches the hash, sets `emailVerifiedAt`, and deletes the parked rows. A newer registration or token request invalidates older unused tokens and replaces the parked credential. An address that already has a password gets no email (only a log event).
- Consequence: `passwordHash` non-null implies the mailbox was proven. The `403 EMAIL_NOT_VERIFIED` path exists for rows set up another way.
- Residual risk, inherent to emailed verification: if a victim clicks a verification link that someone else requested for the victim's address, the requester's password becomes active. The link says nothing the victim can mistake for a request of theirs beyond the email copy; it is not stronger than that.
- Password reset: only for a row with a password; an unknown address, an order-created row and a pending registration behave identically (202, no mail). Token 1 h, single use, a new request invalidates older ones. Reset timing differs from the unknown-address path by a few database round trips (no scrypt is involved); the strict `auth` rate limit is the mitigation.

## Login
Always exactly one scrypt verification (a random per-process dummy hash for unknown emails, credential-less rows and malformed bodies). Lockout: 5 consecutive failures lock the account for 15 minutes (`failedLogins`, `lockedUntil`, same as admin auth); a locked account answers like any failure even for the right password; success and password reset reset it. MFA: TOTP, AES-256-GCM seed in `Customer.mfaSeedEnc` (`CUSTOMER_MFA_ENCRYPTION_KEY`, >= 32 chars; different HKDF salt from the admin key), enrolment stays inactive until a code is confirmed, time steps are single use (`lastTotpStep`, atomic conditional update). With the key unset: enrolment 503, non-MFA sign-in works, MFA customers cannot sign in (401, logged).

## Email
`AuthService` injects `EMAIL_PORT` with `@Optional()` and enqueues `email_verification {link,name?}` (dedupeKey `email_verification:<token row id>`) and `password_reset {link}` (`password_reset:<token row id>`). Links: `${STOREFRONT_PUBLIC_URL}/verify-email?token=...` and `/reset-password?token=...`. Fallback `http://localhost:3000` only in development/test; in production-like runtimes an unset or invalid value answers 503 `Account email is not configured.` before anything is written. Without a bound port, or if enqueue throws, a warning is logged and the response is unchanged. The module providing `EMAIL_PORT` must be global or imported by `AuthModule`, otherwise the port is invisible here.

## Logging (no audit table)
No customer audit table exists and none was invented (`WalletAuditEvent` is customer-wallet scoped). Security events go to the Nest Logger as `security_event=<name> customer=<id|none> [reason=...]`: `register.requested`, `register.ignored_existing_credentials`, `email.verified`, `login.succeeded|failed|refused`, `account.locked`, `password_reset.requested|ignored|completed`, `mfa.enrol_started|enabled|disabled|disable_failed`. Never emails, names, passwords, tokens, codes or cookies (asserted by a test).

## Rate limits
`config/rate-limit.ts`: everything under `/auth` is in the strict `auth` bucket (20/min/IP, shared) except the signed-in, non-credential routes `session`, `profile`, `addresses`, `logout`, `mfa/enroll[/confirm]`, which use only the default bucket so page-load session checks cannot exhaust the sign-in budget. register, login, password-reset/*, email-verification/*, `mfa/disable` and any new `/auth` route are strict.

## Startup
`auth-startup.check.ts`: the old `AUTH_BACKEND` assertion is gone. A production-like runtime still refuses to start when the sandbox gates are open, when `STOREFRONT_PUBLIC_URL` is set but not a valid http(s) URL, or when `CUSTOMER_MFA_ENCRYPTION_KEY` is set but shorter than 32 characters. Unset values only log warnings (`authStartupWarnings`). This does not make the whole API bootable in production: other gates (treasury key, wallet env) are unchanged.

## Tests
`apps/api/src/auth/__tests__`: `customer-auth.unit.test.ts` (in-memory double) and `customer-auth.integration.test.ts` (PostgreSQL, scratch schema) run the same `scenarios.ts`; `wallet/__tests__/customer-identity.test.ts` holds the resolver matrix; config tests cover CORS credentials and the rate-limit buckets.
