import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { SignJWT } from "jose";
import { AppError } from "@lumen/errors";

const hashConcurrency = 4;
const maxQueuedHashes = 8;
let activeHashes = 0;
const hashWaiters: Array<() => void> = [];

async function withHashCapacity<T>(work: () => Promise<T>): Promise<T> {
  if (activeHashes >= hashConcurrency && hashWaiters.length >= maxQueuedHashes) {
    throw new AppError("Password service is busy; try again shortly", 503, "HASH_QUEUE_FULL");
  }
  if (activeHashes >= hashConcurrency) {
    await new Promise<void>((resolve) => hashWaiters.push(resolve));
  }
  activeHashes += 1;
  try {
    return await work();
  } finally {
    activeHashes -= 1;
    hashWaiters.shift()?.();
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashOpaqueValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function otpMatches(candidate: string, expectedHash: string, secret: string): boolean {
  const candidateHash = Buffer.from(hashOpaqueValue(candidate, secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return candidateHash.length === expected.length && timingSafeEqual(candidateHash, expected);
}

export async function hashPassword(password: string): Promise<string> {
  return withHashCapacity(() => argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1
  }));
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return withHashCapacity(() => argon2.verify(passwordHash, password));
}

export function hashForAudit(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createAccessToken(
  userId: string,
  role: string,
  secret: string,
  tokenId: string
): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret));
}
