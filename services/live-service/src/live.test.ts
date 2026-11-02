import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashInvitationToken, verifyWebhookSignature } from "./routes.js";

describe("live service helpers", () => {
  it("derives a stable hash for invitation tokens", () => {
    const token = "live-invite-token-123";
    expect(hashInvitationToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("verifies provider webhook signatures using the shared secret", () => {
    const secret = "a".repeat(32);
    const payload = JSON.stringify({ event: "room_finished", room: "session-123" });
    const signature = createHmac("sha256", secret).update(payload).digest("base64");
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, "bad-signature", secret)).toBe(false);
  });
});
