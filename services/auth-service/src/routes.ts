import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Queue } from "bullmq";
import { z } from "zod";
import { AppError } from "@lumen/errors";
import { verifyInternalIdentity } from "@lumen/internal-identity";
import type { EventEnvelope, InternalIdentity } from "@lumen/types";
import { eventJobOptions } from "@lumen/queue-helpers";
import {
  AuditLogModel, OtpCodeModel, RefreshTokenModel, TrustedDeviceModel, UserModel
} from "./models.js";
import {
  createAccessToken, generateOtp, hashForAudit, hashOpaqueValue, hashPassword,
  normalizeEmail, opaqueToken, otpMatches, verifyPassword
} from "./security.js";

interface AuthDependencies {
  accessTokenSecret: string;
  otpHashSecret: string;
  internalIdentitySecret: string;
  turnstileSecret: string;
  queue: Queue<EventEnvelope>;
  redis: {
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
    set(key: string, value: string, expiryMode: "EX", ttlSeconds: number): Promise<unknown>;
  };
  turnstileVerifier?: (token: string, ip: string) => Promise<boolean>;
}

const signupSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  role: z.enum(["student", "instructor"]).default("student"),
  humanToken: z.string().min(1)
});
const verifyOtpSchema = z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/) });
const resendOtpSchema = z.object({ email: z.email() });
const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(128),
  humanToken: z.string().optional(),
  trustThisDevice: z.boolean().default(false)
});
const forgotSchema = z.object({ email: z.email(), humanToken: z.string().min(1) });
const resetSchema = z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(12).max(128) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) });

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError("Invalid request", 400, "VALIDATION_ERROR");
  return result.data;
}

function identityFromRequest(request: FastifyRequest, secret: string): InternalIdentity {
  const value = request.headers["x-lumen-identity"];
  const identity = verifyInternalIdentity(Array.isArray(value) ? value[0] : value, secret);
  if (!identity) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  return identity;
}

function cookieOptions(maxAge: number, path = "/api/auth-service"): {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge: number;
  domain?: string;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path,
    maxAge,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {})
  };
}

function writeCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  reply.setCookie("accessToken", accessToken, cookieOptions(15 * 60, "/"));
  reply.setCookie("refreshToken", refreshToken, cookieOptions(30 * 24 * 60 * 60));
}

function clearCookies(reply: FastifyReply): void {
  reply.clearCookie("accessToken", cookieOptions(0, "/"));
  reply.clearCookie("refreshToken", cookieOptions(0));
}

async function verifyTurnstile(dependencies: AuthDependencies, token: string, ip: string): Promise<void> {
  const valid = dependencies.turnstileVerifier
    ? await dependencies.turnstileVerifier(token, ip)
    : await (async () => {
      const body = new URLSearchParams({ secret: dependencies.turnstileSecret, response: token, remoteip: ip });
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(4_000)
      });
      if (!response.ok) throw new AppError("Human verification is unavailable", 503, "HUMAN_CHECK_UNAVAILABLE");
      const result = await response.json() as { success?: boolean };
      return result.success === true;
    })();
  if (!valid) throw new AppError("Human verification failed", 400, "HUMAN_CHECK_FAILED");
}

async function publishEvent<T extends Record<string, unknown>>(
  queue: Queue<EventEnvelope>,
  type: string,
  producer: string,
  payload: T
): Promise<void> {
  const event: EventEnvelope = {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    producer,
    payload
  };
  await queue.add(type, event, eventJobOptions(event));
}

async function issueTokens(
  userId: string,
  role: string,
  familyId: string,
  dependencies: AuthDependencies
): Promise<{ accessToken: string; refreshToken: string }> {
  const refreshToken = opaqueToken();
  const tokenHash = hashOpaqueValue(refreshToken, dependencies.otpHashSecret);
  const tokenId = randomUUID();
  const accessToken = await createAccessToken(userId, role, dependencies.accessTokenSecret, tokenId);
  await RefreshTokenModel.create({
    tokenHash,
    userId,
    familyId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000)
  });
  return { accessToken, refreshToken };
}

async function audit(
  request: FastifyRequest,
  userId: string | null,
  email: string,
  action: string,
  success: boolean
): Promise<void> {
  await AuditLogModel.create({
    userId,
    emailHash: hashForAudit(email),
    action,
    success,
    ipHash: hashForAudit(request.ip),
    userAgentHash: hashForAudit(
      Array.isArray(request.headers["user-agent"])
        ? request.headers["user-agent"].join(",")
        : request.headers["user-agent"] ?? "unknown"
    )
  });
}

async function createOtp(email: string, purpose: "signup" | "password-reset", dependencies: AuthDependencies): Promise<void> {
  const existing = await OtpCodeModel.findOne({ email, purpose }).lean();
  if (existing && Date.now() - existing.createdAt.getTime() < 60_000) return;
  const code = generateOtp();
  await OtpCodeModel.findOneAndUpdate(
    { email, purpose },
    {
      $set: {
        codeHash: hashOpaqueValue(`${purpose}:${email}:${code}`, dependencies.otpHashSecret),
        attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        createdAt: new Date()
      }
    },
    { upsert: true, new: true, runValidators: true }
  );
  await publishEvent(dependencies.queue, "otp.requested", "auth-service", { email, code, purpose });
}

export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthDependencies): void {
  void app.register(async (scope) => {
    await scope.register(cookie);

    scope.post("/api/auth-service/signup", async (request, reply) => {
      const input = parseBody(signupSchema, request.body);
      await verifyTurnstile(dependencies, input.humanToken, request.ip);
      const email = normalizeEmail(input.email);
      const user = await UserModel.findOne({ email }).select("+passwordHash").lean();
      if (!user) {
        try {
          const created = await UserModel.create({
            email,
            passwordHash: await hashPassword(input.password),
            role: input.role,
            instructorApproved: input.role !== "instructor"
          });
          await publishEvent(dependencies.queue, "user.created", "auth-service", {
            userId: created.id,
            email,
            role: input.role,
            instructorStatus: input.role === "instructor" ? "pending" : "approved"
          });
          await createOtp(email, "signup", dependencies);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error && error.code === 11000)) throw error;
        }
      }
      return reply.code(202).send({ message: "If the address can be registered, a verification code will be sent" });
    });

    scope.post("/api/auth-service/verify-otp", async (request, reply) => {
      const input = parseBody(verifyOtpSchema, request.body);
      const email = normalizeEmail(input.email);
      const record = await OtpCodeModel.findOne({ email, purpose: "signup" }).select("+codeHash").lean();
      if (!record || record.expiresAt <= new Date() || record.attempts >= 5) {
        throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
      }
      const candidateHash = hashOpaqueValue(`signup:${email}:${input.code}`, dependencies.otpHashSecret);
      const valid = otpMatches(`signup:${email}:${input.code}`, record.codeHash, dependencies.otpHashSecret) &&
        candidateHash === record.codeHash;
      if (!valid) {
        await OtpCodeModel.updateOne({ _id: record._id, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } });
        throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
      }
      await OtpCodeModel.deleteOne({ _id: record._id, codeHash: candidateHash, attempts: { $lt: 5 } });
      const user = await UserModel.findOneAndUpdate(
        { email, verifiedAt: null },
        { $set: { verifiedAt: new Date() } },
        { new: true }
      ).lean();
      if (!user) throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
      await publishEvent(dependencies.queue, "user.verified", "auth-service", { userId: String(user._id), email });
      return reply.send({ message: "Email verified" });
    });

    scope.post("/api/auth-service/resend-otp", async (request, reply) => {
      const input = parseBody(resendOtpSchema, request.body);
      const email = normalizeEmail(input.email);
      const user = await UserModel.findOne({ email, verifiedAt: null }).select("_id").lean();
      if (user) await createOtp(email, "signup", dependencies);
      return reply.code(202).send({ message: "If verification is pending, a new code will be sent" });
    });

    scope.post("/api/auth-service/login", async (request, reply) => {
      const input = parseBody(loginSchema, request.body);
      const email = normalizeEmail(input.email);
      const failureKey = `auth:login-fail:${hashForAudit(email)}`;
      const failures = Number(await dependencies.redis.get(failureKey) ?? 0);
      const user = await UserModel.findOne({ email }).select("+passwordHash").lean();
      const deviceCookie = request.cookies.trustedDevice;
      const trustedDevice = user && deviceCookie
        ? await TrustedDeviceModel.exists({
          userId: user._id,
          deviceHash: hashOpaqueValue(deviceCookie, dependencies.otpHashSecret),
          expiresAt: { $gt: new Date() }
        })
        : false;
      if (failures >= 3 && !trustedDevice) {
        if (!input.humanToken) throw new AppError("Human verification required", 400, "HUMAN_CHECK_REQUIRED");
        await verifyTurnstile(dependencies, input.humanToken, request.ip);
      }
      const locked = Boolean(user?.lockUntil && user.lockUntil > new Date());
      const valid = user ? await verifyPassword(user.passwordHash, input.password) : false;
      if (!user || !valid || locked || !user.verifiedAt) {
        const nextFailures = await dependencies.redis.incr(failureKey);
        if (nextFailures === 1) await dependencies.redis.expire(failureKey, 15 * 60);
        if (user) {
          const updated = await UserModel.findByIdAndUpdate(user._id, { $inc: { loginFailures: 1 } }, { new: true }).lean();
          if ((updated?.loginFailures ?? 0) >= 10) {
            await UserModel.updateOne({ _id: user._id }, { $set: { lockUntil: new Date(Date.now() + 15 * 60_000) } });
          }
        }
        await audit(request, user ? String(user._id) : null, email, "login", false);
        throw new AppError("Email or password is incorrect", 401, "INVALID_CREDENTIALS");
      }
      await UserModel.updateOne({ _id: user._id }, { $set: { loginFailures: 0, lockUntil: null } });
      await dependencies.redis.del(failureKey);
      const familyId = randomUUID();
      const tokens = await issueTokens(String(user._id), user.role, familyId, dependencies);
      writeCookies(reply, tokens.accessToken, tokens.refreshToken);
      if (input.trustThisDevice) {
        const device = opaqueToken();
        await TrustedDeviceModel.findOneAndUpdate(
          { userId: user._id, deviceHash: hashOpaqueValue(device, dependencies.otpHashSecret) },
          { $set: { expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000) } },
          { upsert: true }
        );
        reply.setCookie("trustedDevice", device, cookieOptions(30 * 24 * 60 * 60, "/"));
      }
      await audit(request, String(user._id), email, "login", true);
      await publishEvent(dependencies.queue, "user.login", "auth-service", { userId: String(user._id) });
      return reply.send({ user: { id: String(user._id), email, role: user.role } });
    });

    scope.post("/api/auth-service/refresh", async (request, reply) => {
      const rawToken = request.cookies.refreshToken;
      if (!rawToken) throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
      const tokenHash = hashOpaqueValue(rawToken, dependencies.otpHashSecret);
      const token = await RefreshTokenModel.findOne({ tokenHash }).select("+tokenHash").lean();
      if (!token) throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
      if (token.revokedAt || token.expiresAt <= new Date()) {
        await RefreshTokenModel.updateMany({ familyId: token.familyId }, { $set: { revokedAt: new Date() } });
        clearCookies(reply);
        throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
      }
      const claimed = await RefreshTokenModel.findOneAndUpdate(
        { _id: token._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { new: true }
      ).lean();
      if (!claimed) {
        await RefreshTokenModel.updateMany({ familyId: token.familyId }, { $set: { revokedAt: new Date() } });
        throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
      }
      const user = await UserModel.findById(token.userId).lean();
      if (!user || !user.verifiedAt) throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
      const tokens = await issueTokens(String(user._id), user.role, token.familyId, dependencies);
      await RefreshTokenModel.updateOne({ _id: token._id }, {
        $set: { replacedBy: hashOpaqueValue(tokens.refreshToken, dependencies.otpHashSecret) }
      });
      writeCookies(reply, tokens.accessToken, tokens.refreshToken);
      return reply.send({ user: { id: String(user._id), email: user.email, role: user.role } });
    });

    scope.post("/api/auth-service/logout", async (request, reply) => {
      const rawToken = request.cookies.refreshToken;
      if (rawToken) {
        const tokenHash = hashOpaqueValue(rawToken, dependencies.otpHashSecret);
        const token = await RefreshTokenModel.findOneAndUpdate(
          { tokenHash, revokedAt: null },
          { $set: { revokedAt: new Date() } },
          { new: true }
        ).lean();
        if (token) await RefreshTokenModel.updateMany({ familyId: token.familyId }, { $set: { revokedAt: new Date() } });
      }
      const internalHeader = request.headers["x-lumen-identity"];
      const identity = verifyInternalIdentity(
        Array.isArray(internalHeader) ? internalHeader[0] : internalHeader,
        dependencies.internalIdentitySecret
      );
      if (identity?.tokenId) await dependencies.redis.set(`auth:revoked:${identity.tokenId}`, "1", "EX", 15 * 60);
      clearCookies(reply);
      return reply.send({ message: "Signed out" });
    });

    scope.post("/api/auth-service/forgot-password", async (request, reply) => {
      const input = parseBody(forgotSchema, request.body);
      await verifyTurnstile(dependencies, input.humanToken, request.ip);
      const email = normalizeEmail(input.email);
      if (await UserModel.exists({ email, verifiedAt: { $ne: null } })) await createOtp(email, "password-reset", dependencies);
      return reply.code(202).send({ message: "If the account exists, reset instructions will be sent" });
    });

    scope.post("/api/auth-service/reset-password", async (request, reply) => {
      const input = parseBody(resetSchema, request.body);
      const email = normalizeEmail(input.email);
      const record = await OtpCodeModel.findOne({ email, purpose: "password-reset" }).select("+codeHash").lean();
      if (!record || record.expiresAt <= new Date() || record.attempts >= 5 ||
        !otpMatches(`password-reset:${email}:${input.code}`, record.codeHash, dependencies.otpHashSecret) ||
        record.codeHash !== hashOpaqueValue(`password-reset:${email}:${input.code}`, dependencies.otpHashSecret)) {
        if (record) await OtpCodeModel.updateOne({ _id: record._id, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } });
        throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
      }
      const consumed = await OtpCodeModel.findOneAndDelete({ _id: record._id, codeHash: record.codeHash, attempts: { $lt: 5 } });
      if (!consumed) throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
      const passwordHash = await hashPassword(input.newPassword);
      const user = await UserModel.findOneAndUpdate(
        { email },
        { $set: { passwordHash, passwordChangedAt: new Date(), loginFailures: 0, lockUntil: null } },
        { new: true }
      ).lean();
      if (!user) throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
      await RefreshTokenModel.updateMany({ userId: user._id }, { $set: { revokedAt: new Date() } });
      return reply.send({ message: "Password updated" });
    });

    scope.get("/api/auth-service/me", async (request) => {
      const identity = identityFromRequest(request, dependencies.internalIdentitySecret);
      const user = await UserModel.findById(identity.userId).select("_id email role instructorApproved verifiedAt createdAt").lean();
      if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");
      return { user: { id: String(user._id), email: user.email, role: user.role, instructorApproved: user.instructorApproved } };
    });

    scope.post("/api/auth-service/change-password", async (request, reply) => {
      const identity = identityFromRequest(request, dependencies.internalIdentitySecret);
      const input = parseBody(changePasswordSchema, request.body);
      const user = await UserModel.findById(identity.userId).select("+passwordHash").lean();
      if (!user || !await verifyPassword(user.passwordHash, input.currentPassword)) {
        throw new AppError("Current password is incorrect", 400, "INVALID_CREDENTIALS");
      }
      const passwordHash = await hashPassword(input.newPassword);
      await UserModel.updateOne({ _id: user._id }, { $set: { passwordHash, passwordChangedAt: new Date() } });
      await RefreshTokenModel.updateMany({ userId: user._id }, { $set: { revokedAt: new Date() } });
      if (identity.tokenId) await dependencies.redis.set(`auth:revoked:${identity.tokenId}`, "1", "EX", 15 * 60);
      clearCookies(reply);
      return reply.send({ message: "Password updated" });
    });
  });
}
