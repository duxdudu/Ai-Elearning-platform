import { createHmac, timingSafeEqual } from "node:crypto";
import type { InternalIdentity } from "@lumen/types";

export function signInternalIdentity(
  identity: Pick<InternalIdentity, "userId" | "role" | "tokenId">,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): string {
  if (secret.length < 32) throw new Error("Internal identity secret must be at least 32 characters");
  const payload = Buffer.from(JSON.stringify({
    ...identity,
    issuedAt: now,
    expiresAt: now + 60
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyInternalIdentity(
  value: string | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): InternalIdentity | null {
  if (!value || secret.length < 32) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<InternalIdentity>;
    if (
      typeof identity.userId !== "string" ||
      typeof identity.role !== "string" ||
      (identity.tokenId !== undefined && typeof identity.tokenId !== "string") ||
      typeof identity.issuedAt !== "number" ||
      typeof identity.expiresAt !== "number" ||
      identity.issuedAt > now + 5 ||
      identity.expiresAt <= now ||
      identity.expiresAt - identity.issuedAt > 60
    ) return null;
    return identity as InternalIdentity;
  } catch {
    return null;
  }
}
