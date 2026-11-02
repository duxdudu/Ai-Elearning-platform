import { createHash } from "node:crypto";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import etag from "@fastify/etag";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import type { FastifyRequest } from "fastify";
import { jwtVerify, type JWTPayload } from "jose";
import { createServiceApp } from "@lumen/http";
import { signInternalIdentity } from "@lumen/internal-identity";

interface RedisStore {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", ttlSeconds: number): Promise<unknown>;
  ping(): Promise<string>;
}

interface GatewayIdentity {
  userId: string;
  role: string;
}

interface GatewayDependencies {
  redis: RedisStore;
  accessTokenSecret: string;
  internalIdentitySecret: string;
  allowedOrigins: string[];
  services: Record<string, string>;
  fetcher?: typeof fetch;
  maintenanceMode?: boolean;
}

interface RouteLimit {
  max: number;
  windowMs: number;
}

const slidingWindowScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  return {0, redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1}
`;

const publicAuthPaths = new Set([
  "/signup", "/verify-otp", "/resend-otp", "/login", "/refresh",
  "/forgot-password", "/reset-password"
]);

const sensitiveRouteLimits: Array<{ pattern: RegExp; limit: RouteLimit; name: string }> = [
  { pattern: /^\/api\/auth(?:-service)?\/(?:login|signup|verify-otp|resend-otp|forgot-password|reset-password)/, limit: { max: 5, windowMs: 10 * 60_000 }, name: "auth" },
  { pattern: /\/(?:guest\/join|join-token)(?:\/|$)/, limit: { max: 8, windowMs: 60_000 }, name: "guest" },
  { pattern: /\/ask(?:\/|$)/, limit: { max: 12, windowMs: 60_000 }, name: "ai" }
];

class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(private readonly threshold = 5, private readonly resetMs = 10_000) {}

  get isOpen(): boolean {
    return this.failures >= this.threshold && Date.now() - this.openedAt < this.resetMs;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }
}

function requestToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("accessToken="));
  return cookie ? decodeURIComponent(cookie.slice("accessToken=".length)) : undefined;
}

function isPublicRequest(request: FastifyRequest, service: string, path: string): boolean {
  if (service === "auth-service" && publicAuthPaths.has(path)) return true;
  return service === "learning-service" &&
    request.method === "GET" &&
    (path === "/courses" || /^\/courses\/[^/]+$/.test(path));
}

function resolveRouteLimit(request: FastifyRequest): { limit: RouteLimit; route: string } {
  const sensitive = sensitiveRouteLimits.find(({ pattern }) => pattern.test(request.url));
  return sensitive
    ? { limit: sensitive.limit, route: sensitive.name }
    : { limit: { max: 120, windowMs: 60_000 }, route: request.url.split("?")[0] ?? "/" };
}

async function consumeRateLimit(
  redis: RedisStore,
  key: string,
  limit: RouteLimit
): Promise<boolean> {
  const now = Date.now();
  const result = await redis.eval(
    slidingWindowScript, 1, key, now, limit.windowMs, limit.max, `${now}:${crypto.randomUUID()}`
  ) as [number | string, number | string];
  return Number(result[0]) === 1;
}

function cacheKey(url: string): string {
  return `gateway:public:${createHash("sha256").update(url).digest("hex")}`;
}

export function createGatewayApp(dependencies: GatewayDependencies) {
  if (dependencies.internalIdentitySecret.length < 32 || dependencies.accessTokenSecret.length < 32) {
    throw new Error("Gateway signing secrets must be at least 32 characters");
  }
  const app = createServiceApp({
    name: "gateway-api",
    readiness: async () => ({ redis: await dependencies.redis.ping().then(() => true, () => false) })
  });
  const fetcher = dependencies.fetcher ?? fetch;
  const breakers = new Map(Object.keys(dependencies.services).map((service) => [service, new CircuitBreaker()]));

  void app.register(websocket, { options: { maxPayload: 1_048_576, perMessageDeflate: false } });
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    }
  });
  void app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      callback(null, origin === undefined || dependencies.allowedOrigins.includes(origin));
    }
  });
  void app.register(compress);
  void app.register(etag);

  app.addHook("onRequest", async (request, reply) => {
    if (dependencies.maintenanceMode && !["/health", "/ready", "/metrics"].includes(request.url)) {
      return reply.code(503).send({ error: { code: "MAINTENANCE", message: "Service temporarily unavailable" } });
    }
    if (["/health", "/ready", "/metrics"].includes(request.url)) return;
    if (request.url.startsWith("/ws/")) {
      const origin = request.headers.origin;
      if (origin && !dependencies.allowedOrigins.includes(origin)) {
        return reply.code(403).send({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" } });
      }
      return;
    }

    const route = resolveRouteLimit(request);
    const ipLimit = route.route === "auth" || route.route === "guest" || route.route === "ai"
      ? route.limit
      : { max: 600, windowMs: 60_000 };
    const keys = [
      [`gateway:limit:ip:${request.ip}`, ipLimit],
      [`gateway:limit:route:${route.route}:${request.ip}`, route.limit]
    ] as const;
    for (const [key, limit] of keys) {
      if (!await consumeRateLimit(dependencies.redis, key, limit)) {
        return reply.code(429).header("retry-after", String(Math.ceil(limit.windowMs / 1000))).send({
          error: { code: "RATE_LIMITED", message: "Too many requests", requestId: request.id }
        });
      }
    }
  });

  app.get("/ws/:service/*", { websocket: true }, (client, request) => {
    const { service, "*": pathParam } = request.params as { service: string; "*": string };
    const baseUrl = dependencies.services[service];
    const token = requestToken(request);
    if (!baseUrl || !token) {
      client.close(1008, "Authentication required");
      return;
    }
    void jwtVerify(token, new TextEncoder().encode(dependencies.accessTokenSecret), { algorithms: ["HS256"] })
      .then(async ({ payload }) => {
        const userId = (payload as JWTPayload & { userId?: string }).userId ?? payload.sub;
        const role = (payload as JWTPayload & { role?: string }).role;
        if (!userId || !role) {
          client.close(1008, "Invalid access token");
          return;
        }
        if (typeof payload.jti === "string" && await dependencies.redis.get(`auth:revoked:${payload.jti}`)) {
          client.close(1008, "Invalid access token");
          return;
        }
        const target = new URL(`/${pathParam ?? ""}${request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : ""}`, baseUrl);
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        const headers: Record<string, string> = {
          "x-request-id": request.id,
          "x-lumen-identity": signInternalIdentity({
            userId,
            role,
            ...(typeof payload.jti === "string" ? { tokenId: payload.jti } : {})
          }, dependencies.internalIdentitySecret)
        };
        const upstream = new WebSocket(target, { headers, perMessageDeflate: false, maxPayload: 1_048_576 });
        upstream.once("open", () => {
          client.on("message", (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
          });
          upstream.on("message", (data, isBinary) => {
            if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
          });
          client.once("close", (code, reason) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
          });
          upstream.once("close", (code, reason) => {
            if (client.readyState === WebSocket.OPEN) client.close(code, reason);
          });
        });
        upstream.once("error", (error) => {
          request.log.warn({ err: error, service }, "websocket downstream connection failed");
          if (client.readyState === WebSocket.OPEN) client.close(1013, "Service unavailable");
          upstream.terminate();
        });
        client.once("error", () => upstream.terminate());
      })
      .catch((error: unknown) => {
        request.log.warn({ err: error }, "websocket authentication failed");
        if (client.readyState === WebSocket.OPEN) client.close(1008, "Invalid access token");
      });
  });

  app.all("/api/:service/*", async (request, reply) => {
    const { service, "*": pathParam } = request.params as { service: string; "*": string };
    const baseUrl = dependencies.services[service];
    if (!baseUrl) {
      return reply.code(404).send({ error: { code: "SERVICE_NOT_FOUND", message: "Service not found", requestId: request.id } });
    }
    const path = `/${pathParam ?? ""}`;
    let identity: GatewayIdentity | undefined;
    if (!isPublicRequest(request, service, path)) {
      const token = requestToken(request);
      if (!token) {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required", requestId: request.id } });
      }
      try {
        const verified = await jwtVerify(token, new TextEncoder().encode(dependencies.accessTokenSecret), { algorithms: ["HS256"] });
        const claims = verified.payload as JWTPayload & { userId?: string; role?: string; sub?: string };
        if (typeof (claims.userId ?? claims.sub) !== "string" || typeof claims.role !== "string") throw new Error("Required claims missing");
        identity = {
          userId: claims.userId ?? claims.sub!,
          role: claims.role,
          ...(typeof claims.jti === "string" ? { tokenId: claims.jti } : {})
        };
        if (typeof claims.jti === "string" && await dependencies.redis.get(`auth:revoked:${claims.jti}`)) {
          return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or expired access token", requestId: request.id } });
        }
      } catch {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or expired access token", requestId: request.id } });
      }
    }
    const limit = resolveRouteLimit(request).limit;
    if (identity && !await consumeRateLimit(dependencies.redis, `gateway:limit:user:${identity.userId}`, { max: 300, windowMs: 60_000 })) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests", requestId: request.id } });
    }
    if (identity && resolveRouteLimit(request).route !== request.url.split("?")[0]) {
      if (!await consumeRateLimit(dependencies.redis, `gateway:limit:user-route:${identity.userId}:${resolveRouteLimit(request).route}`, limit)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests", requestId: request.id } });
      }
    }

    const targetUrl = new URL(`${path}${request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : ""}`, baseUrl);
    const isPublicGet = request.method === "GET" && isPublicRequest(request, service, path);
    const key = cacheKey(targetUrl.toString());
    if (isPublicGet) {
      const cached = await dependencies.redis.get(key);
      if (cached) {
        const { status, headers, body } = JSON.parse(cached) as { status: number; headers: Record<string, string>; body: string };
        reply.headers(headers).header("etag", `"${createHash("sha256").update(body).digest("base64url")}"`);
        if (request.headers["if-none-match"] === reply.getHeader("etag")) return reply.code(304).send();
        return reply.code(status).send(body);
      }
    }

    const breaker = breakers.get(service)!;
    if (breaker.isOpen) {
      return reply.code(503).send({ error: { code: "DOWNSTREAM_UNAVAILABLE", message: "Service temporarily unavailable", requestId: request.id } });
    }
    const headers = new Headers();
    for (const header of ["accept", "content-type", "if-none-match", "if-modified-since"]) {
      const value = request.headers[header];
      if (typeof value === "string") headers.set(header, value);
    }
    headers.set("x-request-id", request.id);
    if (identity) headers.set("x-lumen-identity", signInternalIdentity(identity, dependencies.internalIdentitySecret));
    let response: Response;
    try {
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : JSON.stringify(request.body);
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(5_000),
        redirect: "manual"
      };
      if (body !== undefined) init.body = body;
      response = await fetcher(targetUrl, {
        ...init
      });
    } catch (error) {
      breaker.recordFailure();
      request.log.warn({ err: error, service }, "downstream request failed");
      return reply.code(503).send({ error: { code: "DOWNSTREAM_UNAVAILABLE", message: "Service temporarily unavailable", requestId: request.id } });
    }
    if (response.status >= 500) breaker.recordFailure();
    else breaker.recordSuccess();
    const responseHeaders: Record<string, string> = {};
    for (const name of ["content-type", "cache-control", "last-modified", "set-cookie", "location"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    reply.code(response.status).headers(responseHeaders);

    if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
      reply.hijack();
      const streamHeaders = Object.fromEntries(response.headers.entries());
      delete streamHeaders["content-encoding"];
      delete streamHeaders["content-length"];
      reply.raw.writeHead(response.status, streamHeaders);
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value;
        if (!reply.raw.write(chunk)) await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
      }
      reply.raw.end();
      return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (isPublicGet && response.status === 200) {
      await dependencies.redis.set(key, JSON.stringify({
        status: response.status,
        headers: responseHeaders,
        body: body.toString("utf8")
      }), "EX", 30);
    }
    const responseEtag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    reply.header("etag", responseEtag);
    if (request.headers["if-none-match"] === responseEtag) return reply.code(304).send();
    return reply.send(body);
  });

  return app;
}
