import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor pagination", () => {
  it("encodes and decodes stable creation-time and id positions", () => {
    const input = { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: new Types.ObjectId() };
    expect(decodeCursor(encodeCursor(input))).toEqual(input);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("invalid")).toThrow();
  });
});
