import { loadServicePort } from "@lumen/config";
import { createServiceApp, startService } from "@lumen/http";
import { createRedisClient } from "@lumen/redis-client";
import { createGatewayApp } from "./gateway.js";

const name = "gateway-api";
const redisUrl = process.env.REDIS_URL;
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET;
const internalIdentitySecret = process.env.INTERNAL_IDENTITY_SECRET;
if (!redisUrl || !accessTokenSecret || !internalIdentitySecret) {
  throw new Error("REDIS_URL, ACCESS_TOKEN_SECRET, and INTERNAL_IDENTITY_SECRET are required");
}

const redis = createRedisClient(redisUrl);
await redis.connect();
const app = createGatewayApp({
  redis,
  accessTokenSecret,
  internalIdentitySecret,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  maintenanceMode: process.env.MAINTENANCE_MODE === "true",
  services: {
    "auth-service": process.env.AUTH_SERVICE_URL ?? "http://127.0.0.1:4101",
    "learning-service": process.env.LEARNING_SERVICE_URL ?? "http://127.0.0.1:4102",
    "live-service": process.env.LIVE_SERVICE_URL ?? "http://127.0.0.1:4103",
    "ai-service": process.env.AI_SERVICE_URL ?? "http://127.0.0.1:4105"
  }
});
app.addHook("onClose", async () => redis.quit());
await startService(app, name, loadServicePort("GATEWAY_PORT", 4000));
