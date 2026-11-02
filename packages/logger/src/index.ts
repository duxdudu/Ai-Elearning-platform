import pino, { type Logger } from "pino";

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { service },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token", "*.otp", "*.secret"],
      censor: "[REDACTED]"
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  });
}
