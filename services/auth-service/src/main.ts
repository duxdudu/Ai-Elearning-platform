import mongoose from "mongoose";
import { Queue } from "bullmq";
import { loadServicePort } from "@lumen/config";
import type { EventEnvelope } from "@lumen/types";
import { createServiceApp, startService } from "@lumen/http";
import { createRedisClient } from "@lumen/redis-client";
import { registerAuthRoutes } from "./routes.js";

const name = "auth-service";
const mongoUrl = process.env.MONGODB_URI;
const redisUrl = process.env.REDIS_URL;
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET;
const otpHashSecret = process.env.OTP_HASH_SECRET;
const internalIdentitySecret = process.env.INTERNAL_IDENTITY_SECRET;
const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
if (!mongoUrl || !redisUrl || !accessTokenSecret || !otpHashSecret || !internalIdentitySecret || !turnstileSecret) {
  throw new Error("Auth service requires MongoDB, Redis, token, OTP, identity, and Turnstile configuration");
}
await mongoose.connect(mongoUrl, { dbName: "lumen_auth", maxPoolSize: 40, minPoolSize: 2, serverSelectionTimeoutMS: 5_000 });
const redis = createRedisClient(redisUrl);
await redis.connect();
const queueConnection = redis.duplicate({ maxRetriesPerRequest: null });
const events = new Queue<EventEnvelope>("domain-events", { connection: queueConnection });
const app = createServiceApp({
  name,
  readiness: async () => ({
    mongodb: mongoose.connection.readyState === 1,
    redis: await redis.ping().then(() => true, () => false)
  })
});
registerAuthRoutes(app, {
  accessTokenSecret,
  otpHashSecret,
  internalIdentitySecret,
  turnstileSecret,
  queue: events,
  redis
});
app.addHook("onClose", async () => {
  await events.close();
  await queueConnection.quit();
  await redis.quit();
  await mongoose.disconnect();
});
await startService(app, name, loadServicePort("AUTH_SERVICE_PORT", 4101));
