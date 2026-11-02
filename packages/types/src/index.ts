export interface EventEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  producer: string;
  payload: TPayload;
}

export interface InternalIdentity {
  userId: string;
  role: string;
  issuedAt: number;
  expiresAt: number;
  tokenId?: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ServiceHealth {
  status: "ok" | "not_ready";
  service: string;
  dependencies?: Record<string, "up" | "down">;
}
