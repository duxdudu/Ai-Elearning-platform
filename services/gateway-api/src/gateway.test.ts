import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { createGatewayApp } from "./gateway.js";

class TestRedis {
  private readonly windows = new Map<string, number[]>();
  private readonly values = new Map<string, string>();

  async eval(_script: string, _numberOfKeys: number, key: string, now: number, windowMs: number, max: number): Promise<[number, number]> {
    const active = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
    if (active.length >= max) {
      this.windows.set(key, active);
      return [0, 0];
    }
    active.push(now);
    this.windows.set(key, active);
    return [1, max - active.length];
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async ping(): Promise<string> {
    return "PONG";
  }
}

function makeApp(fetcher: typeof fetch) {
  return createGatewayApp({
    redis: new TestRedis(),
    accessTokenSecret: "a".repeat(32),
    internalIdentitySecret: "b".repeat(32),
    allowedOrigins: ["https://learn.example"],
    services: { "auth-service": "http://auth.internal", "learning-service": "http://learning.internal" },
    fetcher
  });
}

async function accessToken(): Promise<string> {
  return new SignJWT({ role: "student" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .sign(new TextEncoder().encode("a".repeat(32)));
}

describe("gateway protections", () => {
  it("limits repeated login requests", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const app = makeApp(fetcher);
    try {
      const responses = [];
      for (let index = 0; index < 6; index += 1) {
        responses.push(await app.inject({ method: "POST", url: "/api/auth-service/login", payload: { email: "a@example.test" } }));
      }
      expect(responses.slice(0, 5).every((response) => response.statusCode === 200)).toBe(true);
      expect(responses[5]?.statusCode).toBe(429);
      expect(fetcher).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });

  it("returns 503 after a downstream circuit opens", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("upstream unavailable");
    });
    const app = makeApp(fetcher);
    const token = await accessToken();
    try {
      const responses = [];
      for (let index = 0; index < 6; index += 1) {
        responses.push(await app.inject({
          method: "GET",
          url: "/api/learning-service/dashboard",
          headers: { authorization: `Bearer ${token}` }
        }));
      }
      expect(responses.slice(0, 5).every((response) => response.statusCode === 503)).toBe(true);
      expect(responses[5]?.statusCode).toBe(503);
      expect(fetcher).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });

  it("rejects an absent access token before routing private requests", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unexpected"));
    const app = makeApp(fetcher);
    try {
      const response = await app.inject({ method: "GET", url: "/api/auth-service/me" });
      expect(response.statusCode).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
