# Monitoring and observability expectations

This describes what the platform is *expected* to emit and, explicitly, what is **not instrumented today**. Nothing is
deployed, so no dashboards, alerts or collectors exist.

## What exists today (verified in the repo)

- **Structured logging in the API**: `nestjs-pino` is wired in `apps/api/src/app.module.ts` (`LoggerModule.forRoot`).
  In a production-like runtime it emits one JSON line per request to stdout; in `development`/`test` it uses
  `pino-pretty`. Credentials are redacted: `req.headers.authorization`, `cookie`, `x-admin-token` and
  `x-customer-email` are replaced with `[redacted]`.
- **Container health checks** (liveness only) in each Dockerfile, plus Postgres/Redis health checks in
  `docker-compose.yml`.
- **CI** logs/annotations for lint, build, test, migration drift, `pnpm audit` and gitleaks.

## What is NOT instrumented

Verified by searching `apps/api` (sources and `package.json`) for `opentelemetry`, `@opentelemetry`, `prom-client`,
`sentry` and `datadog`: **no matches**. (`pnpm-lock.yaml` lists `@opentelemetry/api` only as an optional peer
dependency of `next`; it is not installed or used by this code.) Therefore:

- No OpenTelemetry SDK, auto-instrumentation, tracing, or OTLP exporter in api, storefront or admin.
- No metrics endpoint (`/metrics`), no RED/USE metrics, no business metrics (orders, wallet reservations, reconcile lag).
- No error tracking (Sentry or similar) and no uptime/synthetic checks.
- No `/health` or `/ready` route in the API. The container probe only checks that the HTTP port answers.
- No request/trace correlation id on logs (no `genReqId`, no `x-request-id` propagation), and no log correlation between
  storefront -> api -> database.
- No logging configuration in the Next.js apps beyond Next's defaults.
- No log shipping, retention policy, dashboards or alert rules.

## Expectations when this is built out

Logging
- JSON to stdout only (no files); one event per line; ISO timestamps; level from `LOG_LEVEL`.
- Add a request id (accept `x-request-id`, generate otherwise, echo in the response) and include it in every log line.
- Never log secrets or personal data: keep the redact list current (add any new auth header or body field such as
  wallet signatures, payment payloads, shipping addresses, emails). Treat order/customer identifiers as sensitive.
- Audit-relevant events (admin actions, eligibility decisions, wallet reservations, reconciliation outcomes) must be
  logged with actor, action, target id and outcome, without secret values.

Tracing and metrics (OpenTelemetry)
- API: `@opentelemetry/sdk-node` with HTTP, Express/Nest, `pg`/Prisma and `ioredis` instrumentation, loaded via a
  `--require` bootstrap before `main.js`; OTLP exporter to an ADOT/OTel Collector sidecar; resource attributes
  `service.name` (`helix-api`, `helix-storefront`, `helix-admin`), `deployment.environment`, `service.version` (git SHA).
- Propagate W3C `traceparent` from storefront/admin server-side fetches to the API.
- Sampling: parent-based, low ratio by default; always sample errors.
- Metrics: request rate/error rate/latency per route, Prisma query latency, BullMQ queue depth and failures, reconciliation
  loop duration and last-success timestamp, Redis/Postgres connectivity.

Health
- `GET /health/live` (process up) and `GET /health/ready` (Postgres `SELECT 1` and Redis `PING`), unauthenticated,
  no sensitive detail. Point ALB target groups and container probes at them.

Alerts (minimum)
- 5xx rate, p95 latency, failing readiness, container restart loops, RDS CPU/storage/connections, Redis memory/evictions,
  reconciliation not succeeding within N intervals, any use of an admin endpoint outside expected hours.
- Any occurrence of a live-payment flag evaluating `true` (should be impossible today) should page.

Retention: set CloudWatch log retention explicitly; decide retention for audit events separately with compliance.
