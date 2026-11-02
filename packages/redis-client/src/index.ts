import { Redis } from "ioredis";

export function createRedisClient(url: string, options: { maxRetriesPerRequest?: number } = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 2,
    enableReadyCheck: true,
    lazyConnect: true
  });
}
