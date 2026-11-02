import mongoose from "mongoose";
import { Queue, Worker } from "bullmq";
import { loadServicePort } from "@lumen/config";
import type { EventEnvelope } from "@lumen/types";
import { createServiceApp, startService } from "@lumen/http";
import { createRedisClient } from "@lumen/redis-client";
import { registerLearningRoutes, processProgressWrite } from "./routes.js";

const name = "learning-service";
const mongoUrl = process.env.MONGODB_URI;
const redisUrl = process.env.REDIS_URL;
const internalIdentitySecret = process.env.INTERNAL_IDENTITY_SECRET;
if (!mongoUrl || !redisUrl || !internalIdentitySecret) {
  throw new Error("Learning service requires MongoDB, Redis, and internal identity configuration");
}
await mongoose.connect(mongoUrl, { dbName: "lumen_learning", maxPoolSize: 60, minPoolSize: 2, serverSelectionTimeoutMS: 5_000 });
const redis = createRedisClient(redisUrl);
await redis.connect();
const eventsConnection = redis.duplicate({ maxRetriesPerRequest: null });
const progressConnection = redis.duplicate({ maxRetriesPerRequest: null });
const events = new Queue<EventEnvelope>("domain-events", { connection: eventsConnection });
const progressQueue = new Queue("progress-writes", { connection: progressConnection });
const workerConnection = redis.duplicate({ maxRetriesPerRequest: null });
const worker = new Worker("progress-writes", async (job) => {
  await processProgressWrite(job.data, events, redis);
}, { connection: workerConnection, concurrency: 100 });
const app = createServiceApp({
  name,
  readiness: async () => ({
    mongodb: mongoose.connection.readyState === 1,
    redis: await redis.ping().then(() => true, () => false)
  })
});
registerLearningRoutes(app, { internalIdentitySecret, events, progressQueue, redis });
app.addHook("onClose", async () => {
  await worker.close();
  await progressQueue.close();
  await events.close();
  await Promise.all([eventsConnection.quit(), progressConnection.quit(), workerConnection.quit(), redis.quit()]);
  await mongoose.disconnect();
});
await startService(app, name, loadServicePort("LEARNING_SERVICE_PORT", 4102));
