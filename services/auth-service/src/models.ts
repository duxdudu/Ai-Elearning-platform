import { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["student", "instructor", "admin"], default: "student", required: true },
  instructorApproved: { type: Boolean, default: false, required: true },
  verifiedAt: { type: Date, default: null },
  loginFailures: { type: Number, default: 0, required: true },
  lockUntil: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null }
}, { timestamps: true, collection: "users" });
userSchema.index({ email: 1 }, { unique: true });

const otpSchema = new Schema({
  email: { type: String, required: true, lowercase: true },
  purpose: { type: String, enum: ["signup", "password-reset"], required: true },
  codeHash: { type: String, required: true, select: false },
  attempts: { type: Number, default: 0, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now, required: true }
}, { versionKey: false, collection: "otp_codes" });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ email: 1, purpose: 1 }, { unique: true });

const refreshTokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true, select: false },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  familyId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  replacedBy: { type: String, default: null }
}, { timestamps: true, collection: "refresh_tokens" });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ familyId: 1, revokedAt: 1 });

const trustedDeviceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  deviceHash: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true, collection: "trusted_devices" });
trustedDeviceSchema.index({ userId: 1, deviceHash: 1 }, { unique: true });
trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const auditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, default: null, index: true },
  emailHash: { type: String, required: true },
  action: { type: String, required: true },
  success: { type: Boolean, required: true },
  ipHash: { type: String, required: true },
  userAgentHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, required: true }
}, { versionKey: false, collection: "audit_logs" });
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
auditLogSchema.index({ userId: 1, createdAt: -1 });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
export const OtpCodeModel = model("OtpCode", otpSchema);
export const RefreshTokenModel = model("RefreshToken", refreshTokenSchema);
export const TrustedDeviceModel = model("TrustedDevice", trustedDeviceSchema);
export const AuditLogModel = model("AuditLog", auditLogSchema);
