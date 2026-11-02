import { Queue, type JobsOptions, type QueueOptions } from "bullmq";
import type { EventEnvelope } from "@lumen/types";

export function createQueue<T>(name: string, connection: QueueOptions["connection"]): Queue<T> {
  return new Queue<T>(name, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: false
    }
  });
}

export function eventJobOptions(event: EventEnvelope): JobsOptions {
  return { jobId: event.eventId, attempts: 5, backoff: { type: "exponential", delay: 1_000 } };
}
