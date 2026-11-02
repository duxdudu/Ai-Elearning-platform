import Fastify, { type FastifyInstance } from "fastify";
import { Registry, collectDefaultMetrics } from "prom-client";
import { errorPayload } from "@lumen/errors";

export interface ServiceOptions {
  name: string;
  readiness?: () => Promise<Record<string, boolean>>;
}

export function createServiceApp(options: ServiceOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: options.name },
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token", "*.otp", "*.secret"],
        censor: "[REDACTED]"
      }
    },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
    disableRequestLogging: false
  });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: `${options.name.replaceAll("-", "_")}_` });

  app.get("/health", async () => ({ status: "ok", service: options.name }));
  app.get("/ready", async (_request, reply) => {
    const dependencies = await options.readiness?.() ?? {};
    const ready = Object.values(dependencies).every(Boolean);
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "not_ready",
      service: options.name,
      dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, up]) => [name, up ? "up" : "down"]))
    });
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const payload = errorPayload(error);
    return reply.code(payload.statusCode).send({
      error: { code: payload.code, message: payload.message, requestId: request.id }
    });
  });
  return app;
}

export async function startService(
  app: FastifyInstance,
  name: string,
  port: number,
  host = "0.0.0.0"
): Promise<void> {
  await app.listen({ port, host });
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "graceful shutdown started");
    const forceExit = setTimeout(() => {
      app.log.error("graceful shutdown deadline exceeded");
      process.exitCode = 1;
    }, 10_000);
    forceExit.unref();
    await app.close();
    clearTimeout(forceExit);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  app.log.info({ service: name, port }, "service listening");
}
