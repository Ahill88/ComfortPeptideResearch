# Admin authentication

Back-office sign-in for the admin UI and `/v1/admin/*` routes. Code: `apps/api/src/admin/auth/`, shared primitives in `credentials.ts` (used by both the API and the `create-admin` CLI). Session enforcement is `AdminSessionGuard` (`apps/api/src/admin/admin-session.guard.ts`).

## Roles

| Role | Can |
| --- | --- |
| `OWNER` | everything a `STAFF` can, plus list/create/deactivate admins and read the audit log (`@AdminRoles('OWNER')`) |
| `STAFF` | sign in, `me`, `logout`, `change-password`, and the order routes. `403` on every OWNER route |

There is no development bypass, no default account and no password-only login: MFA (TOTP) is mandatory for everyone.

## Create the first OWNER

Needs `ADMIN_MFA_ENCRYPTION_KEY` (>= 32 chars, `openssl rand -base64 32`) and `DATABASE_URL` in the environment (or in `.env` / the repo-root `.env`):

```sh
pnpm --filter @helix-field/api admin:create -- --email owner@example.com --name 'Ada Owner' --role OWNER
```

It works in any runtime (it is an operator tool), refuses an existing email, and prints **once**, to the terminal only: the generated password, the `otpauth://` URI and the base32 MFA seed. Nothing is written to a file or log. Run it on a terminal that is not recorded or captured. Keep the encryption key identical to the one the API runs with: with a different key the stored MFA seed cannot be decrypted and that admin can never sign in.

Further admins: an OWNER uses `POST /v1/admin/users` (response shape below).

## MFA enrollment

Scan the `otpauth://` URI (or type the base32 seed) into an authenticator app (SHA-1, 6 digits, 30 s). The seed is generated server-side (20 random bytes), shown once, and stored only encrypted (AES-256-GCM, `v1.iv.ciphertext.tag`, key derived from `ADMIN_MFA_ENCRYPTION_KEY`). Codes from the current 30 s step and one step either side are accepted, and **each time step can be used once** (`AdminUser.lastTotpStep`; a code that was already used, or is older than the newest accepted one, is refused).

If `ADMIN_MFA_ENCRYPTION_KEY` is unset or shorter than 32 characters, `POST /v1/admin/auth/login` and `POST /v1/admin/users` answer `503 {"message":"Admin sign-in is not configured."}`. The API still boots.

## Endpoints (all under the `/v1` prefix)

| Route | Body / notes | Success |
| --- | --- | --- |
| `POST /admin/auth/login` | `{email, password, totp}` (`totp` = 6 digits) | `200 {token, expiresAt, admin:{id,email,name,role}}` |
| `GET /admin/auth/me` | guarded | `{admin:{id,email,name,role}, session:{expiresAt, idleTimeoutSeconds:1800}}` |
| `POST /admin/auth/logout` | guarded; sets `revokedAt` | `204` |
| `POST /admin/auth/change-password` | guarded; `{currentPassword, newPassword}`; revokes the admin's OTHER sessions | `204` (wrong current password `403`, policy violation `400`) |
| `GET /admin/users` | OWNER | `{items:[{id,email,name,role,active,lastLoginAt,createdAt}]}` |
| `POST /admin/users` | OWNER; `{email, name, role:'OWNER'\|'STAFF'}` | `201 {admin:{id,email,name,role}, temporaryPassword, mfa:{otpauthUri, seedBase32}}` (shown once, `Cache-Control: no-store`; duplicate email `409`) |
| `POST /admin/users/:id/deactivate` | OWNER; revokes all the admin's sessions | `204` (self `400`, unknown `404`, last active OWNER `409`) |
| `GET /admin/audit?limit=50&cursor=&targetType=&targetId=` | OWNER; newest first, `limit` 1..200 | `{items:[{id,adminEmail\|null,action,targetType,targetId,detail,ip,createdAt}], nextCursor\|null}` |

Every sign-in failure (unknown email, wrong password, wrong or replayed code, inactive account, locked account, malformed body) is the same `401 {"message":"Invalid sign-in."}`. An unknown email still runs a full scrypt verification, so timing does not reveal which emails exist. The real reason is recorded in the audit log (`admin.login.failed`, `detail.reason`), visible to OWNERs only.

Rate limit: `POST /admin/auth/login` and `POST /admin/auth/change-password` count against the strict per-IP **auth** bucket (`config/rate-limit.ts`, default 20/min, `THROTTLE_AUTH_LIMIT`); exceeding it is `429` with `Retry-After`.

## Passwords, lockout, sessions

- Passwords: scrypt (`N=2^15, r=8, p=1`, 16-byte salt) stored as `scrypt$N$r$p$saltb64$hashb64`, verified in constant time; parameters live in the hash so they can be raised later. Length 12..256. The temporary password is 24 random characters.
- **The new admin must change the temporary password at first sign-in.** The schema has no forced-change flag, so this is a process step, not enforced by the API: tell the new admin to call `change-password` immediately (the UI should prompt for it).
- Lockout: 5 consecutive failed attempts on an active account lock it for 15 minutes (`failedLogins` / `lockedUntil`). While locked every attempt is still the generic 401, does not extend the lock, and even the correct password and code are refused. The counter is not cleared when the lock lapses, so the first failure afterwards locks again; a successful sign-in resets it. Failed `change-password` attempts (wrong current password) count toward the same lockout.
- Sessions: token = 32 random bytes (base64url), returned once; only its SHA-256 is stored. Idle timeout 30 minutes, absolute lifetime 8 hours, revoked on logout, on deactivation and (other sessions) on password change. Each sign-in creates a new session (IP from `req.ip`, which honours `TRUST_PROXY`; user agent truncated to 200 characters).
- Deactivation: an OWNER cannot deactivate themselves, and the last active OWNER can never be deactivated (enforced in a serializable transaction, so two owners cannot deactivate each other at the same moment).
- Audit actions: `admin.login`, `admin.login.failed`, `admin.logout`, `admin.password.change`, `admin.password.change.failed`, `admin.user.create`, `admin.user.deactivate`. Passwords, tokens and codes are never recorded.

## Not done

- No password reset by email and no way to re-enroll MFA from the UI: a lost authenticator or password means an OWNER deactivates the account and creates a new one with another email (for the only OWNER, an operator runs `admin:create` with a different email).
- No SSO / OIDC / SAML.
- No per-IP allowlist for the admin routes (put one at the proxy if needed).
- No forced password change on first sign-in (see above), no password history or breach-list check, no WebAuthn/hardware keys.
- Rate-limit counters are per API instance (in-memory store).

## Tests

`apps/api/src/admin/auth/__tests__/`: `credentials.test.ts` (scrypt, RFC 6238 vectors, window/replay, encryption), `admin-auth.unit.test.ts` (HTTP contract on an in-memory double), `admin-auth.integration.test.ts` (same scenarios on PostgreSQL plus concurrency and the CLI end to end; needs `TEST_DATABASE_URL` pointing at a scratch schema).
