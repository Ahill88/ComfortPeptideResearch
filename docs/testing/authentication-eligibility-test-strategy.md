# Authentication and Eligibility Test Strategy

## Purpose

Prevent a development-only commerce API from being treated as production-ready before customer identity, account recovery, MFA, and eligibility controls exist. This strategy applies to the API and any storefront or admin client that exposes account functions.

Research-use-only (RUO) acknowledgement is an order-scoped statement that a purchaser must affirm. Eligibility is a separately evaluated customer status. An acknowledgement must never create, renew, or substitute for eligibility.

## Current Readiness Gate

Run the repository test command from the root:

```sh
pnpm test
```

`tests/authentication-eligibility.test.ts` is deliberately a fail-closed production-readiness contract. It currently identifies missing application controls and must remain failing until the requirements below are implemented. It does not authenticate against a live application and is not evidence that production authentication is safe.

The gate requires evidence that:

- Non-production sessions have a visible in-product development constraint, such as a persistent banner naming the environment and a clearly restricted test identity. Development credentials, session cookies, and test accounts must not be accepted in production.
- Every account route is protected by a server-validated session guard. Client-side route hiding, a bearer token merely decoded by the client, or an email supplied in a request body is insufficient.
- Production startup fails closed unless email verification, password-reset tokens, and MFA enrollment/challenges are persisted and verified by the server.
- Customer eligibility has its own persisted status, evidence/audit metadata, evaluator, and expiry/review rules. It is not derived from `researchAcknowledgedAt` or any checkbox supplied with an order.

## Required Integration Coverage Before Production

Use a disposable PostgreSQL database, a test mail sink, and a clock controlled by the test. Exercise HTTP routes through the deployed API configuration, not service methods alone.

| Area | Required assertions |
| --- | --- |
| Session boundaries | Unauthenticated requests to every account endpoint return `401` or `403`; a valid session accesses only its own account; expired, revoked, malformed, and cross-environment sessions are rejected. |
| Development constraints | Non-production UI/API responses visibly identify the environment; test identities are constrained to non-production; copied development cookies or tokens fail in production. |
| Email verification | A verification token is single-use, time-limited, bound to its account, stored server-side or as a securely verifiable signed artifact, and changes the verified state only after server validation. Enumeration-safe responses apply. |
| Password reset | Reset requests are enumeration-safe and rate-limited; tokens are single-use, expire, are invalidated after password change, and revoke existing sessions as policy requires. Reset completion requires server-side token validation. |
| MFA | Enrollment requires an authenticated session and fresh authentication; secret/challenge material is not returned after setup; challenges are rate-limited and replay-resistant; recovery codes are single-use; disabling MFA requires fresh authentication. |
| Eligibility | An eligible customer can perform only approved actions; ineligible, expired, revoked, pending-review, and mismatched-account customers are denied. Eligibility decisions retain evaluator, evidence reference, timestamps, and reason without copying RUO acknowledgement data. |
| RUO acknowledgement | An order cannot proceed without the acknowledgement; changing or replaying an acknowledgement does not modify eligibility; an eligible customer still must provide the order-scoped acknowledgement. |

## Security Regression Tests

- Run authorization tests for every new account route. Maintain a route inventory and assert that no account controller method is left unguarded.
- Test CSRF protection for cookie-authenticated state-changing requests, secure/HTTP-only/same-site cookie attributes, session fixation resistance, and logout/session revocation.
- Verify logs and audit events omit passwords, reset tokens, MFA secrets, recovery codes, and full session tokens.
- Run dependency, rate-limit, and abuse-path tests in a staging environment before enabling production traffic.

## Exit Criteria

Production is blocked until the readiness gate passes and the required integration coverage passes against a production-like deployment. Security review must confirm session key management, token lifetime/revocation policy, MFA method and recovery policy, eligibility governance, audit retention, and incident response ownership.
