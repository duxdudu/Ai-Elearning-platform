import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Queue } from "bullmq";
import { AccessToken } from "livekit-server-sdk";
import { z } from "zod";
import { AppError } from "@lumen/errors";
import { verifyInternalIdentity } from "@lumen/internal-identity";
import type { EventEnvelope } from "@lumen/types";
import { eventJobOptions } from "@lumen/queue-helpers";
import { InvitationModel, LiveSessionModel, ParticipantModel, RecordingModel } from "./models.js";

const createSessionSchema = z.object({
  title: z.string().trim().min(3).max(180),
  hostId: z.string().min(1),
  startAt: z.coerce.date(),
  waitingRoom: z.boolean().default(true),
  maxParticipants: z.number().int().min(2).max(5000).default(500),
  maxGuests: z.number().int().min(0).max(500).default(100),
  roomName: z.string().trim().min(3).max(80).optional()
});

const sessionStartSchema = z.object({
  roomName: z.string().trim().min(3).max(80).optional()
});

const invitationSchema = z.object({
  sessionId: z.string().min(1),
  email: z.string().email().optional(),
  maxUses: z.number().int().min(1).max(10).default(1),
  expiresInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(24 * 60)
});

const joinTokenSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).optional(),
  guestEmail: z.string().email().optional(),
  role: z.enum(["host", "instructor", "student", "guest"]).default("student"),
  canPublish: z.boolean().default(true),
  canSubscribe: z.boolean().default(true),
  waitingRoom: z.boolean().optional()
});

const participantActionSchema = z.object({
  action: z.enum(["promote", "remove"]),
  role: z.enum(["host", "instructor", "student", "guest"]).optional(),
  reason: z.string().max(200).optional()
});

const recordingSchema = z.object({
  mode: z.enum(["manual", "auto"]).default("manual")
});

interface LiveServiceDependencies {
  internalIdentitySecret: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitUrl: string;
  queue?: Queue<EventEnvelope>;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("Invalid request payload", 400, "VALIDATION_ERROR");
  }
  return parsed.data;
}

function toHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireInternalIdentity(request: FastifyRequest, secret: string): { userId: string; role: string } {
  const value = toHeaderValue(request.headers["x-lumen-identity"]);
  const identity = verifyInternalIdentity(value, secret);
  if (!identity) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }
  return { userId: identity.userId, role: identity.role };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyWebhookSignature(rawBody: string, incomingSignature: string | string[] | undefined, secret: string): boolean {
  if (!incomingSignature) return false;
  const signature = Array.isArray(incomingSignature) ? incomingSignature[0] : incomingSignature;
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const actual = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actual.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actual, expectedBuffer);
}

async function publishEvent<T extends Record<string, unknown>>(
  queue: Queue<EventEnvelope> | undefined,
  type: string,
  payload: T
): Promise<void> {
  if (!queue) return;
  const event: EventEnvelope<T> = {
    eventId: crypto.randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    producer: "live-service",
    payload
  };
  await queue.add(type, event, eventJobOptions(event));
}

function createRoomName(base?: string): string {
  return (base ?? `session-${Date.now()}`).replace(/\s+/g, "-").toLowerCase();
}

function sanitizeParticipantIdentity(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64) || "guest";
}

export function registerLiveRoutes(app: FastifyInstance, dependencies: LiveServiceDependencies): void {
  app.post("/api/live-service/sessions", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const input = parseBody(createSessionSchema, request.body);
    const roomName = createRoomName(input.roomName);
    const session = await LiveSessionModel.create({
      hostId: input.hostId,
      title: input.title,
      roomName,
      startAt: input.startAt,
      waitingRoom: input.waitingRoom,
      maxParticipants: input.maxParticipants,
      maxGuests: input.maxGuests,
      status: "scheduled"
    });
    await publishEvent(dependencies.queue, "live.session.scheduled", {
      sessionId: session.id,
      hostId: session.hostId,
      roomName: session.roomName,
      startAt: session.startAt.toISOString()
    });
    return reply.code(201).send({ sessionId: session.id, session });
  });

  app.get("/api/live-service/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await LiveSessionModel.findById(sessionId).lean();
    if (!session) {
      throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    }
    return reply.send(session);
  });

  app.post("/api/live-service/sessions/:sessionId/start", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const { sessionId } = request.params as { sessionId: string };
    const input = parseBody(sessionStartSchema, request.body);
    const session = await LiveSessionModel.findById(sessionId);
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    if (session.status === "ended") throw new AppError("Session has already ended", 409, "SESSION_ENDED");
    session.status = "live";
    session.roomName = createRoomName(input.roomName ?? session.roomName);
    session.startAt = session.startAt ?? new Date();
    await session.save();
    await publishEvent(dependencies.queue, "live.session.started", {
      sessionId: session.id,
      roomName: session.roomName,
      hostId: session.hostId
    });
    return reply.send({ ok: true, sessionId: session.id, roomName: session.roomName });
  });

  app.post("/api/live-service/sessions/:sessionId/end", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const { sessionId } = request.params as { sessionId: string };
    const session = await LiveSessionModel.findById(sessionId);
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    session.status = "ended";
    session.endedAt = new Date();
    await session.save();
    await publishEvent(dependencies.queue, "live.ended", {
      sessionId: session.id,
      roomName: session.roomName,
      recordingPath: session.recordingPath,
      endedAt: session.endedAt.toISOString()
    });
    return reply.send({ ok: true, sessionId: session.id, endedAt: session.endedAt });
  });

  app.post("/api/live-service/invitations", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const input = parseBody(invitationSchema, request.body);
    const session = await LiveSessionModel.findById(input.sessionId);
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    const token = randomBytes(32).toString("base64url");
    const invitation = await InvitationModel.create({
      sessionId: session._id,
      tokenHash: hashInvitationToken(token),
      emailHash: input.email ? createHash("sha256").update(input.email.trim().toLowerCase()).digest("hex") : "guest",
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000),
      maxUses: input.maxUses,
      uses: 0,
      createdBy: (request as FastifyRequest & { user?: { userId?: string } }).user?.userId ?? "system"
    });
    return reply.code(201).send({ invitationId: invitation.id, token, expiresAt: invitation.expiresAt, maxUses: invitation.maxUses });
  });

  app.get("/api/live-service/invitations/:token/resolve", async (request, reply) => {
    const { token } = request.params as { token: string };
    const invitation = await InvitationModel.findOne({ tokenHash: hashInvitationToken(token) }).lean();
    if (!invitation) throw new AppError("Invitation is invalid", 404, "INVITATION_NOT_FOUND");
    if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
      throw new AppError("Invitation has expired", 410, "INVITATION_EXPIRED");
    }
    if (invitation.uses >= invitation.maxUses) {
      throw new AppError("Invitation usage limit reached", 410, "INVITATION_LIMIT_REACHED");
    }
    const session = await LiveSessionModel.findById(invitation.sessionId).lean();
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    await InvitationModel.updateOne({ _id: invitation._id }, { $inc: { uses: 1 } });
    return reply.send({ valid: true, session });
  });

  app.post("/api/live-service/sessions/:sessionId/join-token", async (request, reply) => {
    const input = parseBody(joinTokenSchema, request.body);
    const session = await LiveSessionModel.findById(input.sessionId || (request.params as { sessionId?: string }).sessionId);
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    if (session.status === "ended") throw new AppError("Session has already ended", 409, "SESSION_ENDED");
    const identity = sanitizeParticipantIdentity(input.userId ?? input.guestEmail ?? `guest-${Date.now()}`);
    const participant = await ParticipantModel.findOneAndUpdate(
      { sessionId: session._id, identity },
      {
        $setOnInsert: {
          sessionId: session._id,
          identity,
          userId: input.userId ?? null,
          emailHash: input.guestEmail ? createHash("sha256").update(input.guestEmail.trim().toLowerCase()).digest("hex") : null,
          role: input.role,
          status: "active",
          joinedAt: new Date()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const roomName = session.roomName || createRoomName(session.title);
    const token = new AccessToken(dependencies.livekitApiKey, dependencies.livekitApiSecret, { identity, name: input.guestEmail ?? input.userId ?? identity });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: input.canPublish && input.role !== "guest",
      canSubscribe: input.canSubscribe,
      canPublishData: input.role !== "guest"
    });
    await publishEvent(dependencies.queue, "live.joined", {
      sessionId: session.id,
      participantId: participant.id,
      identity,
      userId: input.userId ?? null,
      role: input.role
    });
    return reply.send({ token: await token.toJwt(), participantId: participant.id, roomName, role: input.role });
  });

  app.get("/api/live-service/sessions/:sessionId/participants", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const participants = await ParticipantModel.find({ sessionId }).sort({ joinedAt: -1 }).lean();
    return reply.send({ participants });
  });

  app.patch("/api/live-service/sessions/:sessionId/participants/:participantId", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const { sessionId, participantId } = request.params as { sessionId: string; participantId: string };
    const input = parseBody(participantActionSchema, request.body);
    const participant = await ParticipantModel.findOne({ _id: participantId, sessionId });
    if (!participant) throw new AppError("Participant not found", 404, "PARTICIPANT_NOT_FOUND");
    if (input.action === "remove") {
      participant.status = "removed";
      participant.leftAt = new Date();
      await participant.save();
      return reply.send({ ok: true, participantId: participant.id, status: "removed" });
    }
    if (input.role) participant.role = input.role;
    await participant.save();
    return reply.send({ ok: true, participantId: participant.id, role: participant.role });
  });

  app.post("/api/live-service/sessions/:sessionId/recording/start", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const { sessionId } = request.params as { sessionId: string };
    const input = parseBody(recordingSchema, request.body);
    const session = await LiveSessionModel.findById(sessionId);
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    session.recordingStatus = "starting";
    await session.save();
    await RecordingModel.findOneAndUpdate(
      { sessionId: session._id },
      { $set: { status: "recording", egressId: `egress-${Date.now()}`, objectPath: `recordings/${session.roomName}/${Date.now()}` } },
      { upsert: true, new: true }
    );
    await publishEvent(dependencies.queue, "recording.started", {
      sessionId: session.id,
      mode: input.mode,
      roomName: session.roomName
    });
    return reply.send({ ok: true, recordingStatus: session.recordingStatus, sessionId: session.id });
  });

  app.post("/api/live-service/sessions/:sessionId/recording/stop", async (request, reply) => {
    requireInternalIdentity(request, dependencies.internalIdentitySecret);
    const { sessionId } = request.params as { sessionId: string };
    const session = await LiveSessionModel.findById(sessionId);
    if (!session) throw new AppError("Live session not found", 404, "SESSION_NOT_FOUND");
    session.recordingStatus = "stopping";
    await session.save();
    await publishEvent(dependencies.queue, "recording.stopping", {
      sessionId: session.id,
      roomName: session.roomName
    });
    return reply.send({ ok: true, recordingStatus: session.recordingStatus, sessionId: session.id });
  });

  app.post("/api/live-service/provider/webhooks", async (request, reply) => {
    const rawBody = typeof request.body === "string"
      ? request.body
      : JSON.stringify(request.body ?? {});
    const signature = toHeaderValue(request.headers["x-livekit-signature"] ?? request.headers["x-livekit-signature"]);
    if (!verifyWebhookSignature(rawBody, signature, dependencies.livekitApiSecret)) {
      throw new AppError("Invalid provider webhook signature", 401, "INVALID_WEBHOOK_SIGNATURE");
    }
    return reply.send({ accepted: true });
  });
}
