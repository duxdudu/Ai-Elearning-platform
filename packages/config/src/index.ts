import { z } from "zod";

const sharedSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MONGODB_URI: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  INTERNAL_IDENTITY_SECRET: z.string().min(32).optional()
});

export type SharedConfig = z.infer<typeof sharedSchema>;

export function loadSharedConfig(env: NodeJS.ProcessEnv = process.env): SharedConfig {
  return sharedSchema.parse(env);
}

export function loadServicePort(name: string, defaultPort: number, env: NodeJS.ProcessEnv = process.env): number {
  const schema = z.coerce.number().int().min(1).max(65535);
  const value = env[name];
  return value === undefined ? defaultPort : schema.parse(value);
}
