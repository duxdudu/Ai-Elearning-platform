# Backend architecture and operating rules

## Request and event flow

The web app communicates only with `gateway-api`. The gateway authenticates external access tokens, validates requests, applies edge protections, and forwards a signed internal identity to private services. Services still enforce role, ownership, and resource authorization locally. They never inspect another service's collections.

Asynchronous work uses Redis/BullMQ with versioned event envelopes. Producers use a transactional outbox where event loss would break consistency; consumers are idempotent and retain a processed-event/job key. Every cross-service HTTP request has a deadline, bounded retry with backoff for retryable failures, and a circuit breaker. Retries are not performed for non-idempotent operations without an idempotency key.

## Performance and availability

- Services are stateless; persistent state belongs in MongoDB, Redis, or object storage.
- Paginated list APIs use opaque cursor pagination. Queries select only required fields, use lean reads, and avoid per-row lookups.
- MongoDB pools, Redis connections, HTTP concurrency, queue concurrency, and all timeouts are bounded by configuration.
- Graceful shutdown stops accepting work, drains in-flight requests/jobs up to a deadline, and closes clients.
- Read targets are p95 <300ms, login p95 <500ms, dashboard p95 <400ms. These are load-test objectives, not assumed guarantees.
- `/health` is liveness; `/ready` checks dependencies; `/metrics` is private and scraped by Prometheus.

## Data and events

The per-service collection and event ownership matrix is in the root README. Event envelopes include `eventId`, `type`, `version`, `occurredAt`, `producer`, and a typed payload. Consumers must tolerate duplicate and out-of-order delivery.

## Configuration and secrets

Configuration is validated at startup and comes only from environment variables (in production, injected from a secret manager). Never log credentials, tokens, OTPs, or sensitive payloads. Secrets in `.env.example` are placeholders only.

## Scaling and deployment

Scale HTTP services horizontally behind private service discovery; scale workers from queue depth and cap concurrency against provider and database limits. Use managed MongoDB Atlas, Redis, private networking, TLS, object storage, and a CDN for media. Load tests determine instance limits and autoscaling thresholds; do not infer 10,000-user capacity from local development.
