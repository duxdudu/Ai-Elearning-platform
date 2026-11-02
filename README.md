# Lumen Learn backend

A TypeScript/npm-workspaces monorepo for independently deployable backend services. Node.js 20+, Fastify, MongoDB Atlas/Mongoose, Redis, BullMQ, and Docker are the target runtime. The gateway is the sole public API entry point; internal service ports must not be exposed at the edge.

## Services

| Service | Default port | Owned collections | Publishes | Consumes |
| --- | ---: | --- | --- | --- |
| `gateway-api` | 4000 | none | none | none |
| `auth-service` | 4101 | users, otp_codes, refresh_tokens, trusted_devices, audit_logs | user.created, user.verified, user.login, otp.requested | none |
| `learning-service` | 4102 | courses, lessons, enrollments, lesson_progress, assignments, submissions, grades, certificates, reviews, direct_messages, dashboard_summaries | enrollment.created, lesson.completed, submission.created, grade.published, certificate.issued, review.created | user.created, user.verified, live.ended, recording.ready |
| `live-service` | 4103 | live_sessions, invitations, participants, recordings_meta | live.ended, live.joined, recording.ready | user.verified |
| `media-worker` | worker | recording_jobs, recording_steps | recording.ready | live.ended, recording.ready |
| `ai-service` | 4105 | knowledge_documents, chunks, ai_conversations, ai_usage | ai.question.asked, ai.escalation.created | document.index.requested, recording.ready |
| `notification-service` | worker | notifications, delivery_records, suppressed_recipients | none | otp.requested, user.created, invitation.created, live.reminder, recording.ready, assignment.due, grade.published, instructor.approved |
| `analytics-service` | 4107 | raw_events, course_rollups, instructor_rollups, student_rollups | none | domain events from all services |

Collection ownership is enforced by convention: a service may only access its own database/collections. Cross-service state is obtained over service APIs or through versioned events. Deployable service entrypoints, ports and environment are documented in each service package.

## Local development

1. Copy `.env.example` to `.env` and set strong secrets.
2. Start local MongoDB and Redis.
3. Run `npm install`.
4. Run `npm test` to build the workspaces and execute tests.
5. Start a service with `npm run dev --workspace=@lumen/<workspace-name>`.

All services expose liveness and readiness endpoints. They use environment-only configuration, request-correlated structured logs, and close connections on SIGTERM/SIGINT. Readiness must fail when required dependencies are unavailable. Production deployments should route public traffic only to the gateway and place service workloads on private networking.

See `docs/architecture.md` for cross-service rules and scaling decisions. Individual backend stages are implemented in B0-B11 order; features are not considered complete until their tests and deployment checks pass.
