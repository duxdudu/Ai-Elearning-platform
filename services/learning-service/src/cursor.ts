import { Types } from "mongoose";
import { AppError } from "@lumen/errors";

export interface CursorValue {
  createdAt: Date;
  id: Types.ObjectId;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: String(value.id) })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
    const createdAt = new Date(value.createdAt ?? "");
    if (!value.id || !Types.ObjectId.isValid(value.id) || Number.isNaN(createdAt.getTime())) throw new Error("Invalid cursor");
    return { createdAt, id: new Types.ObjectId(value.id) };
  } catch {
    throw new AppError("Invalid pagination cursor", 400, "INVALID_CURSOR");
  }
}
