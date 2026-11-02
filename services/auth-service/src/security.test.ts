import { describe, expect, it } from "vitest";
import {
  generateOtp, hashOpaqueValue, hashPassword, normalizeEmail, otpMatches, verifyPassword
} from "./security.js";

describe("authentication primitives", () => {
  it("normalizes email addresses consistently", () => {
    expect(normalizeEmail("  Learner@Example.COM ")).toBe("learner@example.com");
  });

  it("generates and verifies six-digit scoped one-time codes", () => {
    const code = generateOtp();
    const secret = "s".repeat(32);
    expect(code).toMatch(/^\d{6}$/);
    expect(otpMatches(`signup:learner@example.com:${code}`, hashOpaqueValue(`signup:learner@example.com:${code}`, secret), secret)).toBe(true);
    expect(otpMatches(`password-reset:learner@example.com:${code}`, hashOpaqueValue(`signup:learner@example.com:${code}`, secret), secret)).toBe(false);
  });

  it("hashes passwords with Argon2id and verifies them", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).toContain("$argon2id$");
    await expect(verifyPassword(encoded, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(encoded, "incorrect password")).resolves.toBe(false);
  });
});
