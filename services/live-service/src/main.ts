import mongoose from "mongoose";
import { Queue } from "bullmq";
import { loadServicePort } from "@lumen/config";
import { createServiceApp, startService } from "@lumen/http";
import { createRedisClient } from "@lumen/redis-client";
import type { EventEnvelope } from "@lumen/types";
import { registerLiveRoutes } from "./routes.js";

const name = "live-service";
const mongoUrl = process.env.MONGODB_URI;
const redisUrl = process.env.REDIS_URL;
const internalIdentitySecret = process.env.INTERNAL_IDENTITY_SECRET;
const livekitUrl = process.env.LIVEKIT_URL;
const livekitApiKey = process.env.LIVEKIT_API_KEY;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET;

if (!mongoUrl || !redisUrl || !internalIdentitySecret || !livekitUrl || !livekitApiKey || !livekitApiSecret) {
  throw new Error("Live service requires MongoDB, Redis, internal identity, and LiveKit configuration");
}

await mongoose.connect(mongoUrl, {
  dbName: "lumen_live",
  maxPoolSize: 30,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5_000
});

const redis = createRedisClient(redisUrl);
await redis.connect();
const queueConnection = redis.duplicate({ maxRetriesPerRequest: null });
const events = new Queue<EventEnvelope>("domain-events", { connection: queueConnection });

const app = createServiceApp({
  name,
  readiness: async () => ({
    mongodb: mongoose.connection.readyState === 1,
    redis: await redis.ping().then(() => true, () => false),
    livekit: Boolean(livekitUrl && livekitApiKey && livekitApiSecret)
  })
});

registerLiveRoutes(app, {
  internalIdentitySecret,
  livekitApiKey,
  livekitApiSecret,
  livekitUrl,
  queue: events
});

app.addHook("onClose", async () => {
  await events.close();
  await queueConnection.quit();
  await redis.quit();
  await mongoose.disconnect();
});

await startService(app, name, loadServicePort("LIVE_SERVICE_PORT", 4103));
