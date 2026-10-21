# Deployment (AWS-compatible, high level)

> **Nothing is deployed.** No AWS account, cluster, database, domain or pipeline exists for this project, and no
> infrastructure-as-code lives here yet. This document is a plan and a checklist, not a record of anything running.
>
> **Live payment flags must stay `false`.** Do not set `ENABLE_REAL_MOONPAY`, `ENABLE_SOLANA_MAINNET`,
> `ENABLE_LIVE_CRYPTO_PAYMENTS`, `ENABLE_DELEGATED_PAYMENTS` or `ENABLE_LIVE_FULFILLMENT` to `true` in any environment
> until the corresponding compliance/security review (see `docs/`) is complete and signed off. The API additionally
> refuses live-funds flags without an explicit acknowledgement variable; do not set that either.

## Known blockers before any production-like deployment

- **The API refuses to start with `NODE_ENV=production`.** Email verification, password reset and MFA are not
  implemented, and `apps/api/src/auth/auth-startup.check.ts` fails closed (`AUTH_BACKEND=configured` must not be faked).
  Production-like startup also requires a valid `SOLANA_USDC_TREASURY`, `WALLET_CHAIN_MODE=devnet` (the only non-sandbox
  mode), and `ADMIN_API_TOKEN` of at least 32 characters when set.
- Session validation for account endpoints is deny-all in production until a real server-issued session validator exists.
- Privy embedded wallets are a descriptor only; do not configure `PRIVY_APP_ID` and call it a Privy integration.
- `/health` (liveness) and `/health/ready` (Postgres readiness) exist; there is no OpenTelemetry (see `../monitoring/README.md`).
- The Docker images have never been built (see `../docker/README.md`).

Treat anything below as a staging/sandbox target at most (`WALLET_CHAIN_MODE=devnet`, flags false), and only once the
first item above is resolved or deliberately handled by the API owners.

## Target topology (ECS/Fargate or equivalent)

```
Route 53 -> CloudFront/WAF -> ALB ->  storefront (Fargate)   :3000
                                  ->  admin      (Fargate)   :3002   (restrict by SSO/VPN/IP allow-list)
                                  ->  api        (Fargate)   :3001
api -> RDS PostgreSQL 16 (private subnets)
api -> ElastiCache Redis 7 (private subnets, in-transit encryption)
api -> S3 (COA documents, private bucket)   [not implemented in the code yet]
```

Equivalents are fine (EKS, Cloud Run + Cloud SQL, Fly, etc.). Admin should not be public-internet reachable without a
second control in front of it.

## Steps

1. **Registry and images.** Create ECR repositories `helix-api`, `helix-storefront`, `helix-admin`. Build from the repo
   root with the Dockerfiles in `apps/*/Dockerfile`. For the storefront pass
   `--build-arg NEXT_PUBLIC_API_URL=https://<public-api-host>/v1` (inlined at build time; rebuild per environment).
   Tag with the git SHA, never `latest`.
2. **Network.** VPC with private subnets for tasks, RDS and Redis; public subnets only for the ALB. Security groups:
   ALB -> tasks only; api -> RDS 5432 and Redis 6379 only.
3. **Postgres.** RDS PostgreSQL 16, Multi-AZ for anything non-sandbox, encrypted at rest, automated backups, deletion
   protection. Create an application role with the least privileges Prisma needs (a separate role for migrations).
   Connection string becomes `DATABASE_URL`.
4. **Redis.** ElastiCache for Redis 7, encrypted in transit. The wallet prepared-transaction store uses Redis in
   production (`WALLET_PREPARED_STORE=redis`; `memory` is refused), and BullMQ uses it too. The code reads
   `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`.
5. **Secrets.** Store in AWS Secrets Manager and inject as ECS task-definition `secrets` (never plain `environment`,
   never in images, never in git):
   - `DATABASE_URL`
   - `ADMIN_API_TOKEN` (>= 32 random chars; shared by api and admin)
   - `MOONPAY_SECRET_KEY` and `MOONPAY_PUBLISHABLE_KEY` (only relevant if `ENABLE_REAL_MOONPAY` is ever turned on, which
     it must not be yet; leave unset)
   - `PRIVY_APP_SECRET` (leave unset; see blockers)
   Non-secret config (`STOREFRONT_ORIGIN`, `WALLET_CHAIN_MODE`, `SOLANA_RPC_URL`, feature flags = `false`) can be plain
   task environment. Give the task *execution* role `secretsmanager:GetSecretValue` on only those secrets.
6. **Documents (S3).** Private bucket with Block Public Access, SSE-KMS, versioning, and access via pre-signed URLs or a
   task role scoped to the bucket prefix, for certificate-of-analysis (COA) documents. The API has no S3 integration
   today; this is future work.
7. **Migrations.** Run exactly once per release, before shifting traffic, as a one-off ECS task using the API image
   with command `migrate` (`docker-entrypoint.sh migrate` -> `prisma migrate deploy`). Do **not** enable
   `RUN_MIGRATIONS=true` on the long-running service when there is more than one task. CI already checks migration
   drift (`prisma migrate diff --exit-code`).
8. **Services.** One ECS service per app, `desiredCount >= 2` for api/storefront once non-sandbox, rolling deploy with
   circuit breaker. Container health checks are already defined in the images; ALB target-group health check paths:
   storefront `/`, admin `/` (accept 3xx), api `/health` (liveness) or `/health/ready` (Postgres).
9. **Logging/metrics.** Ship stdout to CloudWatch Logs; see `../monitoring/README.md` for what exists and what does not.
10. **CI/CD.** `.github/workflows/ci.yml` builds, lints, tests and scans but does **not** deploy or push images. Adding
    deploy requires GitHub OIDC -> an IAM role (no long-lived AWS keys) and a protected `environment` with reviewers.

## Environment variables by service (names only; see `.env.example`)

| Service | Required | Notes |
| --- | --- | --- |
| api | `DATABASE_URL`, `REDIS_*`, `STOREFRONT_ORIGIN`, `ADMIN_API_TOKEN` (optional but if set >= 32 chars) | Flags all `false`. `RUN_MIGRATIONS` default `false`. |
| storefront | build arg `NEXT_PUBLIC_API_URL` | No secrets. |
| admin | `API_URL` (server-side, internal), `ADMIN_API_TOKEN` | `ADMIN_DEV_SESSION` must never be set. |

## Not covered

Terraform/CDK, DNS/TLS, WAF rules, backup/restore drills, disaster recovery, cost estimates, load testing, compliance
sign-off for selling research materials or handling crypto payments. None of it is done.
